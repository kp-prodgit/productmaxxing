import { budget } from "../budget/provider.js";
import type { Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { Services } from "../core/services.js";
import { loadState } from "../core/state.js";
import type { Task } from "../core/types.js";
import { leaseTtlSeconds } from "../lease/types.js";
import { lookAt, markBlocks, markStore, taskTaken } from "../lease/marks.js";
import { runTask, type RunOutcome } from "../run/run.js";
import { explain, selectTasks, type Selection } from "./select.js";
import { failStreaks } from "./failures.js";
import { inlineSources, sourcesHere } from "../run/evidence.js";
import { packSources } from "../run/packs.js";
import { storeFor } from "../run/share.js";
import { loadSkill, verifySkill } from "../core/skills.js";
import { webOn } from "../core/config.js";
import { skillMeta } from "../core/skillcheck.js";

export interface PullResult {
  dryRun: boolean;
  selection: Selection | null;
  text: string;
  ran: RunOutcome | null;
}

/** `--dry-run` is the default for the first week after install (PULL-9). */
export function isDryRunDefault(ctx: Ctx): boolean {
  return ctx.now().getTime() - new Date(ctx.personal.installedAt).getTime() < 7 * 86400000;
}

/**
 * What a kind of work's drafts must cite (RUN-3, RUN-6): its skill's minimum number of citations, and whether its runs
 * search the web, whose `[web: <url>, <date>]` citations count toward that minimum too. A web run gets the web only for
 * a team or bundled skill, or an org skill the team pinned, as `runTask` decides.
 */
export async function citationNeed(ctx: Pick<Ctx, "team" | "personal">, category: string): Promise<{ min: number; web: boolean }> {
  const name = ctx.team.categories[category]?.skill;
  const skill = name ? await loadSkill(ctx.personal.repoPath, name).catch(() => null) : null;
  let min = 0;
  try { min = skill ? skillMeta(skill.text).minCitations ?? 0 : 0; } catch {}
  const web = !!skill && webOn(ctx.team, category) && (skill.source !== "org" || verifySkill(ctx.team.skills, name!, skill).allowlisted);
  return { min, web };
}

/** "a competitive-analysis draft must cite its sources 2 times" (RUN-3). */
export const citeText = (category: string, min: number) => `a ${category} draft must cite its sources ${min === 1 ? "once" : `${min} times`}`;

/**
 * Ready tasks this Mac can't draft (RUN-3): a kind of work that must cite sources, and none of the task's sources
 * quotable here. Their quotes are on the Mac that proposed them, which runs them; nobody spends a run to fail. A task
 * whose quotes the team has in the repo (RUN-5, an evidence pack) runs on any Mac. R16 (RUN-6): so does one of a kind
 * whose runs search the web, since its draft's web citations count toward the minimum.
 */
export async function citationGaps(ctx: Ctx, tasks: Task[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const store = storeFor(ctx);
  const packed = async (t: Task) => packSources(await store.read(t.identifier).catch(() => null), t.sources).length > 0;
  const needs = new Map<string, Promise<{ min: number; web: boolean }>>();
  const needFor = (category: string) => {
    if (!needs.has(category)) needs.set(category, citationNeed(ctx, category));
    return needs.get(category)!;
  };
  for (const t of tasks) {
    if (t.status !== "ready" || !t.category || !ctx.team.categories[t.category]) continue;
    const { min, web } = await needFor(t.category);
    if (!min || web) continue;
    const here = await sourcesHere(t);
    // The skill counts citations, not sources: one source cited twice is enough for a minimum of 2.
    if (inlineSources(t).length || here.ids.length) continue;
    if (!here.receipt && t.sources.length && (await packed(t))) continue;
    const need = citeText(t.category, min);
    out.set(t.id, !t.sources.length ? `it names no sources, and ${need}`
      : !here.receipt ? `its sources are quoted only on the Mac that suggested it, and ${need}`
      : `none of its sources are in its synthesis run on this Mac, and ${need}`);
  }
  return out;
}

export async function plan(ctx: Ctx, svc: Services): Promise<Selection> {
  const [tasks, leases, paused, state] = await Promise.all([svc.tracker.list(), svc.lease.list(), svc.paused(), loadState()]);
  const log = new RunLogStore(ctx);
  const runs = (await log.exists().catch(() => false)) ? await log.entries().catch(() => []) : [];
  const now = ctx.now();
  const live = new Set(leases.filter((l) => l.holder !== ctx.agent && new Date(l.expiresAt) > now).map((l) => l.taskId));
  // PULL-14: a step another Mac took that this Mac's copy of Linear can't show yet. A team repo out of reach leaves the
  // run log; the claim reads the task's mark again before any run.
  const marks = await markStore(ctx.repo).list().catch(() => new Map());
  const look = await lookAt(ctx, svc.tracker);
  const taken = new Map<string, string>();
  for (const t of tasks) {
    if (t.status !== "ready") continue;
    const why = taskTaken(t.identifier, marks.get(t.identifier), runs, look);
    if (why) taken.set(t.id, why);
  }
  return selectTasks({
    tasks,
    agent: ctx.agent,
    personal: ctx.personal,
    team: ctx.team,
    budget: budget(ctx.personal, ctx.team, state, now),
    now,
    inReview: tasks.filter((t) => t.status === "review" && t.agent === ctx.agent).length,
    pausedCategories: paused,
    leasedTaskIds: live,
    failStreaks: failStreaks(runs),
    unrunnable: await citationGaps(ctx, tasks),
    runs,
    taken,
  });
}

/**
 * Claims a task: lease first (atomic), then mark it in the tracker. After winning, the task is read again: in the
 * tracker, and its mark in the team repo (PULL-14), since a run that just ended elsewhere released its lease only after
 * marking its draft, which this Mac's copy of Linear may not show yet.
 */
export async function claim(ctx: Ctx, svc: Services, task: Task) {
  const ttl = leaseTtlSeconds(ctx.team.sizes[task.size ?? "M"].minutes);
  const got = await svc.lease.acquire(task.id, ctx.agent, ttl);
  if (!got.ok) return got;
  // Re-check after winning: someone may have moved it out of ready since we listed.
  const fresh = await svc.tracker.get(task.id);
  if (fresh.status !== "ready" || fresh.workflow?.held) {
    await svc.lease.release(task.id, ctx.agent);
    return { ok: false as const, holder: "tracker", expiresAt: "" , reason: fresh.workflow?.held ?? `status is now ${fresh.status}` };
  }
  const mark = await markStore(ctx.repo).read(fresh.identifier).catch(() => null);
  const taken = mark ? markBlocks(mark, await lookAt(ctx, svc.tracker)) : null;
  if (taken) {
    await svc.lease.release(task.id, ctx.agent);
    return { ok: false as const, holder: "team repo", expiresAt: "", reason: taken };
  }
  await svc.tracker.setAgent(task.id, ctx.agent);
  await svc.tracker.setStatus(task.id, "claimed");
  return got;
}

/**
 * `pmx pull` (PULL-1). Checks the kill switch, then the policy, then tries candidates in order
 * until one lease is won, and runs it. One task per pull.
 */
export async function pull(ctx: Ctx, svc: Services, o: { dryRun: boolean }): Promise<PullResult> {
  const ks = await killSwitchOn(ctx.repo);
  if (ks.on) return { dryRun: o.dryRun, selection: null, text: `Kill switch is on (${ks.reason}). Nothing pulled.`, ran: null };
  const sel = await plan(ctx, svc);
  const text = explain(sel, o.dryRun);
  if (o.dryRun || !sel.candidates.length) return { dryRun: o.dryRun, selection: sel, text, ran: null };

  for (const task of sel.candidates) {
    const got = await claim(ctx, svc, task);
    if (!got.ok) {
      ctx.out.info("reason" in got && got.reason ? `${task.identifier}: ${got.reason}; trying the next one.` : `${task.identifier} was claimed by ${got.holder} first; trying the next one.`);
      continue;
    }
    const ran = await runTask(ctx, svc, { ...task, agent: ctx.agent, status: "claimed" }, got.lease);
    return { dryRun: false, selection: sel, text: `${text}\n\n${ran.message}`, ran };
  }
  return { dryRun: false, selection: sel, text: `${text}\n\nEvery candidate was claimed by someone else.`, ran: null };
}

/**
 * Releases leases older than their TTL on tasks that aren't running (PULL-7), and puts the task back
 * to ready. Any machine may do this.
 */
export async function releaseStale(ctx: Ctx, svc: Services): Promise<string[]> {
  const now = ctx.now();
  const out: string[] = [];
  const log = new RunLogStore(ctx);
  for (const l of await svc.lease.list()) {
    if (new Date(l.expiresAt) > now) continue;
    const task = await svc.tracker.get(l.taskId).catch(() => null);
    if (task?.status === "running") continue;
    if (!(await svc.lease.forceRelease(l.taskId, l.token))) continue;
    if (task && (task.status === "claimed" || task.status === null)) {
      await svc.tracker.setAgent(task.id, null);
      await svc.tracker.setStatus(task.id, "ready");
    }
    await log.record({ type: "release", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task?.identifier ?? l.taskId, reason: "stale" });
    out.push(`released stale claim on ${task?.identifier ?? l.taskId} (held by ${l.holder} since ${l.acquiredAt})`);
  }
  return out;
}
