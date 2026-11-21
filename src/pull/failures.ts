import type { RunLogEntry } from "../core/runlog.js";
import type { RunLogStore } from "../core/runlog-store.js";

/**
 * How many runs of each task failed in a row, by any agent, from the team's run log (PULL-11). A draft resets it;
 * a run that never started (`refused`, a machine problem) doesn't count either way. Keyed by Linear identifier.
 */
export function failStreaks(entries: RunLogEntry[]): Map<string, number> {
  const out = new Map<string, number>();
  const runs = entries.filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run").sort((a, b) => a.ts.localeCompare(b.ts));
  for (const e of runs) {
    if (e.outcome === "ok") out.delete(e.taskId);
    else if (e.outcome === "failed" || e.outcome === "capped") out.set(e.taskId, (out.get(e.taskId) ?? 0) + 1);
  }
  return out;
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
