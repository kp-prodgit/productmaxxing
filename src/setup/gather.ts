import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { appliedSchedule, LINEAR_SYNC_TASK } from "../claude/tasks.js";
import { appSkillCurrent, appSkillInstalled, claudePresent, SETUP_SKILL, skillInstalledByPmx } from "../claude/skill.js";
import type { DoctorCheck } from "../commands/doctor.js";
import type { PersonalConfig, TeamConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import type { Exec } from "../core/exec.js";
import { Git } from "../core/git.js";
import type { Keychain } from "../core/keychain.js";
import { RunLogStore } from "../core/runlog-store.js";
import { packageRoot } from "../core/skills.js";
import { loadState } from "../core/state.js";
import { currentVersion } from "../core/version.js";
import { linearAccess } from "../linear/access.js";
import { readProposals } from "../synth/proposals.js";
import { COMMITMENT } from "../todo/todo.js";
import { relayTracker } from "../tracker/relay.js";
import { buildChecklist, recordChecklist, type Checklist, type Step } from "./checklist.js";

export interface GatherDeps {
  personal: PersonalConfig | null;
  team: TeamConfig | null;
  checks: DoctorCheck[];
  exec: Exec;
  keychain: Keychain;
  now: Date;
  /** For the run log; without one (no team repo yet) the checklist has no last run. */
  ctx?: Ctx | null;
  /** Team features' steps (ee/: the brain). */
  extra?: () => Promise<Step[]>;
  /** PMX Engine's checklist summary. Only commands may reach Engine (src/engine/bridge.ts), so they pass it in. */
  engine?: () => Promise<{ version: string; where: string; next: string | null } | null>;
}

/** The first week after install is practice (PULL-9): until when, or null once runs are real. */
export function practiceUntil(p: Pick<PersonalConfig, "installedAt"> | null, now: Date): string | null {
  if (!p) return null;
  const end = Date.parse(p.installedAt) + 7 * 86400000;
  return now.getTime() < end ? new Date(end).toISOString() : null;
}

/** Whether team memory says more than the template it started as. */
async function memoryFilled(repo: string): Promise<boolean | null> {
  const have = await readFile(join(repo, "memory", "product.md"), "utf8").catch(() => null);
  if (have === null) return false;
  const template = await readFile(join(packageRoot(), "templates", "pmx-repo", "memory", "product.md"), "utf8").catch(() => null);
  return template === null ? null : have.trim() !== template.trim() && have.replace(/^#.*$|<!--[\s\S]*?-->|\s/gm, "").length > 40;
}

/** Works the checklist out from this Mac, records it in ~/.pmx/checklist.json, and returns it. */
export async function gatherChecklist(d: GatherDeps): Promise<Checklist> {
  const { personal, team } = d;
  const state = await loadState();
  const access = team ? await linearAccess(team, d.keychain).catch(() => "none" as const) : "none";
  const relay = team?.tracker.kind === "linear" && access === "relay";
  const tasks = relay ? await relayTracker(team!).list().then((ts) => {
    const work = ts.filter((t) => t.category !== COMMITMENT);
    return { pool: work.filter((t) => t.status === "inbox").length, ready: work.filter((t) => t.status === "ready").length, blocked: work.filter((t) => t.status === "blocked").length };
  }, () => null) : null;
  const runs = d.ctx ? await new RunLogStore(d.ctx).entries().catch(() => []) : [];
  const last = [...runs].reverse().find((e): e is Extract<typeof e, { type: "run" }> => e.type === "run" && e.agent === d.ctx!.agent);
  const claude = await claudePresent();
  const setupSkill = !claude ? "missing" : (await appSkillCurrent(SETUP_SKILL)) ? "current" : !(await appSkillInstalled(SETUP_SKILL)) ? "missing" : (await skillInstalledByPmx(SETUP_SKILL)) ? "outdated" : "yours";
  const extra = d.extra ? await d.extra().catch(() => []) : [];
  const cl = buildChecklist({
    now: d.now, version: currentVersion(), personal, team, checks: d.checks, state, claude,
    hasRemote: personal ? await new Git(personal.repoPath, d.exec).hasRemote().catch(() => null) : null,
    memoryFilled: personal ? await memoryFilled(personal.repoPath) : null,
    proposals: personal ? await readProposals().then((ps) => ps.length, () => null) : null,
    tasks, practiceUntil: practiceUntil(personal, d.now),
    lastRun: last ? { taskId: last.taskId, outcome: last.outcome, ts: last.ts } : null,
    setupSkill, linearCron: relay ? (await appliedSchedule(LINEAR_SYNC_TASK).catch(() => null))?.cron ?? null : null,
    engine: d.engine ? await d.engine().catch(() => null) : null, extra,
  });
  // A Mac's first checklist dates what was already done from what PMX recorded when it happened.
  const firstCollect = state.collectReports[0]?.at;
  return recordChecklist(cl, {
    "setup.config": personal?.installedAt, "job.installed": personal?.installedAt, "config.team": personal?.installedAt,
    "claude.page": personal?.flow?.publishedAt, "claude.board": personal?.board?.publishedAt, "work.meetings": firstCollect,
  });
}
