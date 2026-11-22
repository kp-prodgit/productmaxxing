import type { RunLogEntry } from "../core/runlog.js";
import type { RunLogStore } from "../core/runlog-store.js";

/** Failed runs in a row before a task moves to Blocked (PULL-11). */
export const FAILS_TO_BLOCK = 2;

type RunEntry = Extract<RunLogEntry, { type: "run" }>;
/** A PM's Try again or Drop on a task that stopped after failed runs (PULL-12): either one ends its streak. */
const resets = (e: RunLogEntry): e is Extract<RunLogEntry, { type: "release" | "drop" }> => (e.type === "release" && e.reason === "retry") || e.type === "drop";

/**
 * How many runs of each task failed in a row, by any agent, from the team's run log (PULL-11). A draft resets it, and
 * so does a PM's Try again or Drop (PULL-12); a run that never started (`refused`, a machine problem) doesn't count
 * either way. Keyed by Linear identifier.
 */
export function failStreaks(entries: RunLogEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  const runs = entries.filter((e) => e.type === "run" || resets(e)).sort((a, b) => a.ts.localeCompare(b.ts));
  for (const e of runs) {
    if (resets(e)) out.delete(e.taskId);
    else if (e.type !== "run") continue;
    else if (e.outcome === "ok") out.delete(e.taskId);
    else if (e.outcome === "failed" || e.outcome === "capped") out.set(e.taskId, (out.get(e.taskId) ?? 0) + 1);
  }
  return out;
}

/**
 * Why a task's last run ended without a draft, in a PM's words, from what the run log keeps (PULL-12). The log holds
 * outcomes and timings only, never the error text, so this is the kind of failure; the task's comments in Linear have
 * the details.
 */
export function failureReason(e: Pick<RunEntry, "outcome" | "durationMs" | "skillVersion">): string {
  if (e.outcome === "capped") return "The last run hit the spending cap for one run.";
  if (e.skillVersion === "-") return "Its kind of work has no skill PMX can run.";
  if (!e.durationMs) return "The last run stopped before an agent started: its kind of work isn't set up to run.";
  return "The agent's last draft didn't pass its checks.";
}

export interface StoppedTask {
  identifier: string;
  title: string;
  url: string | null;
  category: string | null;
  /** Failed runs in a row. */
  runs: number;
  reason: string | null;
  /** When the last of those runs ended. */
  at: string | null;
}

/**
 * Tasks PMX stopped after failed runs (PULL-12): Blocked, with at least FAILS_TO_BLOCK failed runs in a row in the run
 * log. That's exactly when PULL-11 blocks a task, so a task a person moved to Blocked (a rejected draft, or by hand)
 * isn't one: its run log shows a draft since, or fewer failures. Try again and Drop end the streak, so a task leaves
 * this list as soon as the PM acts, whatever the tracker shows until it syncs.
 */
export function stoppedTasks(tasks: { identifier: string; title: string; url?: string | null; status: string | null; category?: string | null; meeting?: boolean }[], entries: RunLogEntry[]): StoppedTask[] {
  const streaks = failStreaks(entries);
  const last = new Map<string, RunEntry>();
  for (const e of entries) if (e.type === "run" && (e.outcome === "failed" || e.outcome === "capped") && (!last.has(e.taskId) || last.get(e.taskId)!.ts < e.ts)) last.set(e.taskId, e);
  return tasks.filter((t) => !t.meeting && t.status === "blocked" && (streaks.get(t.identifier) ?? 0) >= FAILS_TO_BLOCK).map((t) => {
    const l = last.get(t.identifier);
    return { identifier: t.identifier, title: t.title, url: t.url || null, category: t.category ?? null, runs: streaks.get(t.identifier)!, reason: l ? failureReason(l) : null, at: l?.ts ?? null };
  }).sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/** The failed-run streak of one task, counting a run already recorded. */
export async function failStreak(log: RunLogStore, identifier: string): Promise<number> {
  return failStreaks(await log.entries()).get(identifier) ?? 0;
}

/** Runs in a row without a draft, across two or more tasks, that pause a category (REV-3, with ee/). */
export const FAILS_TO_PAUSE = 3;

/**
 * Categories whose latest runs all ended without a draft: at least FAILS_TO_PAUSE in a row, across two or more tasks,
 * since the category was last unpaused. One task failing is that task's problem, and it moves to Blocked; several
 * tasks failing in a row points at the category's skill. Review verdicts can't show this: those runs never reach review.
 */
export function failingCategories(entries: RunLogEntry[]): Map<string, { runs: number; tasks: number }> {
  const unpausedAt = new Map<string, number>();
  for (const e of entries) if (e.type === "unpause") unpausedAt.set(e.category, Math.max(unpausedAt.get(e.category) ?? 0, Date.parse(e.ts)));
  const streaks = new Map<string, { runs: number; tasks: Set<string> }>();
  const runs = entries.filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run").sort((a, b) => a.ts.localeCompare(b.ts));
  for (const e of runs) {
    if (Date.parse(e.ts) < (unpausedAt.get(e.category) ?? 0)) continue;
    if (e.outcome === "ok") streaks.delete(e.category);
    else if (e.outcome === "failed" || e.outcome === "capped") {
      const s = streaks.get(e.category) ?? { runs: 0, tasks: new Set<string>() };
      s.runs++;
      s.tasks.add(e.taskId);
      streaks.set(e.category, s);
    }
  }
  const out = new Map<string, { runs: number; tasks: number }>();
  for (const [cat, s] of streaks) if (s.runs >= FAILS_TO_PAUSE && s.tasks.size >= 2) out.set(cat, { runs: s.runs, tasks: s.tasks.size });
  return out;
}
