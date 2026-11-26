import type { TeamConfig } from "../core/config.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { Size } from "../core/types.js";

/**
 * What a run is expected to cost (PULL-13), learned from the team's run log. `pmx pull` (and the brain) use it to decide
 * whether a task fits what's left of today's cap. A fixed table ran about 15 times over today's models (an M brief at
 * $1.50 that cost $0.08 to $0.10), so the cap stopped the queue after a handful of tasks.
 *
 * - With at least `min` successful runs of this kind of work at this size, the estimate is the median cost of the last
 *   `window` of them, rounded up to the cent: never below the median.
 * - With fewer, it's the team's size table (`sizes` in pmx.config.json), or the median of the few runs there were when
 *   that is higher, so a kind of work that costs more than the table never looks cheaper than it is.
 *
 * The estimate only decides what to start. What a run really costs is what counts against the cap: the ledger records
 * every run's actual cost, whatever was expected.
 */
export const ESTIMATE_RUNS = { window: 10, min: 3 } as const;

export interface CostEstimate {
  usd: number;
  /** "runs": learned from this kind of work's recent runs at this size; "table": the team's size table. */
  basis: "runs" | "table";
  /** How many successful runs it looked at (at most `window`). */
  runs: number;
  /** The size table's figure, for comparison. */
  tableUsd: number;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
/** Up to the next cent, never down. */
const cents = (x: number): number => Math.ceil(Math.round(x * 1e6) / 1e4) / 100;

export function estimateCost(log: readonly RunLogEntry[] | null | undefined, team: Pick<TeamConfig, "sizes">, category: string, size: Size): CostEstimate {
  const tableUsd = team.sizes[size].costUsd;
  const runs = (log ?? [])
    .filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run" && e.outcome === "ok" && e.category === category && e.size === size && typeof e.costUsd === "number" && e.costUsd > 0)
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, ESTIMATE_RUNS.window);
  const m = runs.length ? median(runs.map((r) => r.costUsd!)) : null;
  if (m !== null && runs.length >= ESTIMATE_RUNS.min) return { usd: cents(m), basis: "runs", runs: runs.length, tableUsd };
  return { usd: m !== null && m > tableUsd ? cents(m) : tableUsd, basis: "table", runs: runs.length, tableUsd };
}

/** "about $0.10, from the last 8 runs", or "about $0.10, from your team's size table". */
export function estimateText(e: CostEstimate): string {
  const usd = `about $${e.usd.toFixed(2)}`;
  if (e.basis === "runs") return `${usd}, from the last ${e.runs} runs`;
  if (e.usd > e.tableUsd) return `${usd}, from ${e.runs === 1 ? "its one run" : `its ${e.runs} runs`} so far (more than your team's size table)`;
  return `${usd}, from your team's size table${e.runs ? ` (${e.runs === 1 ? "1 run" : `${e.runs} runs`} so far; PMX learns from ${ESTIMATE_RUNS.min})` : ""}`;
}
