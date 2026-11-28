import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { APP_SKILL, appSkillInstalled, installAppSkill, refreshAppSkills, SETUP_SKILL, skillInstalledByPmx } from "../claude/skill.js";
import { installMcp, mcpInstalled } from "../mcp/server.js";
import { claudeAbsolutePath } from "./claude-bin.js";
import { loadPersonalConfig, savePersonalConfig } from "./config.js";
import type { Exec } from "./exec.js";
import { jobEnv, plist, stableNode, type Launchd } from "./launchd.js";
import { paths, pmxHome } from "./paths.js";
import { loadState, updateState } from "./state.js";
import { isDevInstall } from "./update.js";
import { NAME_SWAP } from "../run/packs.js";
import { compareVersions, currentVersion } from "./version.js";

/**
 * UPGRADE-1: what an update needs on this Mac, done once per version, based on the version the Mac came from.
 *
 * `lastVersion` is the pmx that last ran any command here; when the running pmx differs, this Mac was upgraded (or,
 * rarely, downgraded) and `from` is where it came from. Each automatic step runs once: "every upgrade" steps once per
 * version (refreshing what an older pmx installed), one-off steps once per Mac when it came from before their
 * `since`. Steps that only a person or Claude can do are the checklist's (src/setup/checklist.ts), never here.
 */
export interface UpgradeRecord {
  lastVersion: string | null;
  /** The version this Mac came from at the last upgrade; null when it's unknown (a pmx from before 0.35.0, or none). */
  from: string | null;
  /** When the running version was first seen. */
  at: string | null;
  /** Each step done, keyed by its ID (one-off) or `<id>@<version>` (every upgrade): when, and what it did. */
  applied: Record<string, { at: string; did: string }>;
}

export interface UpgradeDeps {
  exec: Exec;
  launchd: Launchd;
  /** The pmx entry script that's running now. */
  cliPath: string;
  /** False in the background job, which never reloads its own job while it runs: it asks for that once it has ended. */
  interactive: boolean;
  /** The process a reload of the background job waits for. This one, unless a test says. */
  pid?: number;
  now?: () => Date;
  /** Tests stand in for "this pmx runs from a source checkout". */
  devInstall?: () => Promise<boolean>;
}

export interface AutoStep {
  id: string;
  /** null: every upgrade. A version: once, on a Mac that came from before it (or from an unknown version). */
  since: string | null;
  title: string;
  /** Only a command someone runs may do it: a background run leaves it waiting. No step of PMX's own needs this now. */
  interactiveOnly?: boolean;
  /** What it did, or null when there was nothing to do. Must check real state first, so running it twice is safe. */
  run(d: UpgradeDeps): Promise<string | null>;
}

const exists = (f: string) => stat(f).then(() => true, () => false);
const dev = (d: UpgradeDeps) => (d.devInstall ?? (() => isDevInstall()))();
const realCli = (p: string) => { try { return realpathSync(p); } catch { return p; } };

/** A step that isn't done yet and needs nobody: PMX finishes it by itself, and says when (UPGRADE-1). */
export class StepWaits extends Error {}

const JOB_REFRESHED = "refreshed the background job with this pmx, Node and Claude Code";
/** What the background-job step says while a reload waits for the run in progress to end. */
export const JOB_RELOADS = "the background job is running right now: it reloads itself with this pmx, Node and Claude Code when that run ends";
/** After this many reloads asked for and none seen, the checklist stops saying PMX will do it and names the command. */
export const JOB_RELOAD_TRIES = 3;

const TASK_HOURS_STEP = "task-hours-always";
/** The one line a Mac that worked on weekdays by default gets when 0.41.0 moves it to around the clock. */
export const TASK_HOURS_MOVED = "PMX's Linear sync and meeting collection now work around the clock, where they worked on weekdays only (to go back: pmx schedule --hours weekdays)";
/** What the same step says on a Mac whose PM chose working hours: nothing moved. */
export const TASK_HOURS_KEPT = "kept the working hours you chose for the Linear sync and meeting collection (weekdays; PMX's default is now around the clock: pmx schedule --hours always)";

export const AUTO_STEPS: AutoStep[] = [
  {
    id: "app-skills",
    since: null,
    title: "PMX's commands in the Claude app match this version",
    async run() {
      const updated: string[] = await refreshAppSkills();
      // /pmx-setup is new in 0.35.0: a Mac that already has PMX's other commands gets it too.
      if ((await skillInstalledByPmx(APP_SKILL)) && !(await appSkillInstalled(SETUP_SKILL)) && (await installAppSkill(SETUP_SKILL)) === "installed") updated.push(`${SETUP_SKILL} (new)`);
      return updated.length ? `updated ${updated.map((s) => `/${s}`).join(", ")}` : null;
    },
  },
  {
    id: "mcp-entry",
    since: null,
    title: "The Claude app starts this version's PMX server",
    async run(d) {
      if (!(await mcpInstalled()) || (await dev(d))) return null;
      const r = await installMcp(await stableNode(process.execPath), realCli(d.cliPath));
      if (r.error) throw new Error(r.error);
      return r.changed ? "pointed the Claude app's PMX server at this pmx" : null;
    },
  },
  {
    id: "background-job",
    since: null,
    title: "The background job runs this version with today's Node and Claude Code",
    async run(d) {
      const have = await d.launchd.installed();
      if (!have || (await dev(d))) return null;
      // A job that belongs to another PMX home (a second install on this Mac) is left alone.
      const home = have.match(/<key>PMX_HOME<\/key>\s*<string>([^<]*)<\/string>/)?.[1] ?? null;
      if (home !== pmxHome()) return null;
      const env = jobEnv(have);
      const claude = (await claudeAbsolutePath(d.exec)) ?? (env.PMX_CLAUDE && (await exists(env.PMX_CLAUDE)) ? env.PMX_CLAUDE : null);
      const want = plist({ node: await stableNode(process.execPath), cli: realCli(d.cliPath), pmxHome: pmxHome(), claude });
      const asked = (await loadState()).jobReload ?? null;
      if (want === have) {
        // The usual update: pmx, Node and Claude Code are where they were, so the job needs nothing, from any run.
        if (!asked) return null;
        // A reload an earlier run asked for has happened since.
        await updateState((st) => { st.jobReload = null; });
        return `${JOB_REFRESHED} (it reloaded itself after a background run)`;
      }
      // Reloading stops a pass that's running, which could leave a task half done, and a pass that reloaded its own job
      // would be stopped before it could load it again. So a background run, or a command run while one is going, asks
      // for the reload once the run has ended (src/core/launchd.ts, RELOAD_SCRIPT), and nothing changes until then.
      const busy = !d.interactive || !!(await d.launchd.running?.());
      if (!busy) {
        await d.launchd.install(want);
        if (asked) await updateState((st) => { st.jobReload = null; });
        return JOB_REFRESHED;
      }
      if (!d.launchd.reloadAfter) throw new StepWaits("the background job is running right now");
      await d.launchd.reloadAfter(want, d.pid ?? process.pid);
      const at = (d.now ?? (() => new Date()))().toISOString();
      await updateState((st) => { st.jobReload = { at, tries: (st.jobReload?.tries ?? 0) + 1 }; });
      throw new StepWaits(JOB_RELOADS);
    },
  },
  {
    // RUN-5: tasks approved before evidence packs have none, so other Macs' agents skip them. The background run writes
    // them (src/run/share.ts, backfillEvidence), at most 20 a run; this makes its first look due at once, not in a day.
    id: "evidence-backfill",
    since: "0.37.0",
    title: "This Mac's open tasks share their quotes with your team",
    async run() {
      if ((await loadState()).evidenceBackfill?.due) return null;
      await updateState((st) => { st.evidenceBackfill = { at: st.evidenceBackfill?.at ?? null, due: true }; });
      return "the next background run shares the quotes of this Mac's open tasks that have none yet with your team";
    },
  },
  {
    // R5: packs shared before PMX's name swap as it is now (NAME_SWAP) still name people. The backfill writes this Mac's
    // again (src/run/share.ts, backfillEvidence); this makes its next look due at once, not in a day. R5e: keyed to the
    // swap, and checked against the one this Mac last asked for, so every bump of NAME_SWAP rewrites them at the next
    // background run, even within one version; an update that doesn't bump it does nothing.
    id: `evidence-names-${NAME_SWAP}`,
    since: null,
    title: "The quotes this Mac shared name no one",
    async run() {
      if (((await loadState()).evidenceNameSwap ?? 0) >= NAME_SWAP) return null;
      await updateState((st) => { st.evidenceBackfill = { at: st.evidenceBackfill?.at ?? null, due: true }; st.evidenceNameSwap = NAME_SWAP; });
      return "the next background run writes the quotes this Mac shared with your team again, with people's names swapped for placeholders";
    },
  },
  {
    // D2-8 (FOLLOW-1): before 0.38.0, accepting a draft made a waiting task of every question, so many waiting in Needs
    // you are one message to a colleague. The background run reads each again by today's rules (src/review/requeue.ts):
    // a question to ask or a call becomes a to-do, and work keeps waiting with today's title. Keyed to this Mac's state,
    // so it runs once whichever version brings it, and never again after.
    id: "follow-ups-requeue",
    since: null,
    title: "Waiting follow-ups an older PMX suggested follow today's rules",
    async run() {
      if ((await loadState()).followUpRequeue) return null;
      await updateState((st) => { st.followUpRequeue = { due: true, at: null }; });
      return REQUEUE_ASKED;
    },
  },
  {
    // CLAUDE-6 (0.41.0, founder 2026-11-27): PMX's Claude tasks work around the clock by default. Until now a Mac whose PM
    // never chose its hours had none saved and worked on weekdays only: it moves to around the clock, once, and is told
    // how to go back. A PM who chose weekdays (`pmx schedule --hours weekdays`, the page's Schedule buttons) has that
    // saved, and keeps it: the step says so, and its title claims neither, because the checklist's Updates section shows
    // it on both Macs. Only a Mac that came from before 0.41.0 ever had the old default: `pmx checklist --fix` runs every
    // step, and must tell a new install nothing.
    id: TASK_HOURS_STEP,
    since: "0.41.0",
    title: "When the Linear sync and meeting collection work",
    async run() {
      const personal = await loadPersonalConfig().catch(() => null);
      if (!personal || personal.taskHours === "always") return null;
      const rec = await upgradeRecord();
      if (!before(rec.lastVersion !== currentVersion() ? rec.lastVersion : rec.from, "0.41.0")) return null;
      if (personal.taskHours === "weekdays") return TASK_HOURS_KEPT;
      personal.taskHours = "always";
      await savePersonalConfig(personal);
      return TASK_HOURS_MOVED;
    },
  },
];

/** What the follow-ups step says it asked for, until the background run has done it and says what it did instead. */
export const REQUEUE_ASKED = "the next background run reads again the follow-ups an older PMX left waiting for your approval, and turns questions one person can answer into to-dos";

const keyOf = (s: AutoStep, version: string) => (s.since === null ? `${s.id}@${version}` : s.id);
const before = (v: string | null, since: string) => v === null || (compareVersions(v, since) ?? -1) < 0;
/** Whether a step applies to a Mac that came from `from` to `to`. */
export const applies = (s: AutoStep, from: string | null, to: string) => (s.since === null ? from !== to : before(from, s.since));

/** The record as it stands, seeded on a Mac whose pmx predates it from what NEW-1 remembers. */
export async function upgradeRecord(): Promise<UpgradeRecord> {
  const st = await loadState();
  return st.upgrade ?? { lastVersion: st.whatsNew?.since ?? st.whatsNew?.seen ?? null, from: null, at: null, applied: {} };
}

export interface UpgradeResult {
  from: string | null;
  to: string;
  /** Steps done in this call. */
  did: { id: string; title: string; did: string }[];
  /** Steps that apply but aren't done: ones that failed, and ones PMX finishes by itself later (`self`). */
  waiting: { id: string; title: string; why: string; self?: boolean }[];
}

/**
 * Runs before every command (but `mcp` and `uninstall`). Cheap when nothing changed: one read of state.json.
 */
export async function upgradeOnStart(d: UpgradeDeps, steps: AutoStep[] = AUTO_STEPS): Promise<UpgradeResult> {
  const now = (d.now ?? (() => new Date()))().toISOString();
  const to = currentVersion();
  const rec = await upgradeRecord();
  // A Mac that never ran pmx (no settings, no record) isn't upgrading: it starts at this version.
  if (rec.lastVersion === null && rec.at === null && !(await exists(paths.config()))) {
    await updateState((st) => { st.upgrade = { lastVersion: to, from: to, at: now, applied: {} }; });
    return { from: to, to, did: [], waiting: [] };
  }
  if (rec.lastVersion !== to) {
    // Keep the older starting point while a one-off step from that upgrade still waits, so it isn't skipped. A record
    // seeded from what NEW-1 remembers (never saved, so `at` is null) has no earlier upgrade.
    const unfinished = rec.at !== null && rec.lastVersion !== null && steps.some((s) => s.since !== null && applies(s, rec.from, rec.lastVersion!) && !rec.applied[s.id]);
    if (!unfinished) rec.from = rec.lastVersion;
    rec.lastVersion = to;
    rec.at = now;
  }
  const out: UpgradeResult = { from: rec.from, to, did: [], waiting: [] };
  for (const s of steps) {
    if (rec.at === null || !applies(s, rec.from, to) || rec.applied[keyOf(s, to)]) continue;
    if (s.interactiveOnly && !d.interactive) {
      out.waiting.push({ id: s.id, title: s.title, why: "waits for the next pmx command you run" });
      continue;
    }
    try {
      const did = (await s.run(d)) ?? "nothing to do";
      rec.applied[keyOf(s, to)] = { at: now, did };
      out.did.push({ id: s.id, title: s.title, did });
    } catch (e: any) {
      out.waiting.push({ id: s.id, title: s.title, why: e?.message ?? String(e), ...(e instanceof StepWaits ? { self: true } : {}) });
    }
  }
  // Keep the record small: steps for older versions only matter for the checklist's history of this upgrade. Only the
  // per-version keys (`id@version`) go. A one-off step's key is what stops it running twice, and a Mac moving between
  // test builds (0.41.0-next.1, next.2, …) stays before 0.41.0 for as many updates as there are builds.
  const keys = Object.keys(rec.applied).filter((k) => k.includes("@"));
  for (const k of keys.slice(0, Math.max(0, keys.length - 40))) delete rec.applied[k];
  await updateState((st) => { st.upgrade = rec; });
  return out;
}

/** A fresh `pmx init`: this Mac starts at this version, so no step for an older one applies. */
export async function markFreshInstall(now = new Date(), steps: AutoStep[] = AUTO_STEPS): Promise<void> {
  const v = currentVersion(), at = now.toISOString();
  const applied = Object.fromEntries(steps.map((s) => [keyOf(s, v), { at, did: "not needed: installed fresh" }]));
  await updateState((st) => { st.upgrade = { lastVersion: v, from: v, at, applied }; });
}
