import type { PipelineData } from "./pipeline.js";
import { engineMine } from "./strategy.js";

/**
 * BOARD-10: what waits for the PM, counted the way PMX's page counts its "Needs you" cards, in the page's order: what
 * unblocks the most comes first. `pmx status` and the page's data both use it, so the Terminal and the page agree.
 *
 * - drafts to review (an agent stops taking work once its own drafts reach the review cap: `paused`);
 * - tasks PMX stopped after failed runs (PULL-12);
 * - proposed tasks to approve;
 * - the weekly digest, when one waits;
 * - fixes: health problems, plus the setup checklist's next required step when it isn't done (one card);
 * - team settings changes still open;
 * - BOARD-11: on a Mac with PMX Engine, Engine's moves that are the head of product's own, last. Only this Mac's
 *   pages carry Engine (`engine`), so the count Claude reads at the shared level never includes it.
 */
export interface NeedsYou {
  drafts: number;
  /** This PM's agent takes no new work until one of its drafts is reviewed (PULL-4's review-queue cap). */
  paused: boolean;
  reviewCap: number;
  stopped: number;
  proposals: number;
  digest: number;
  fixes: number;
  /** 1 when the checklist's next required step isn't done. */
  setup: number;
  team: number;
  /** BOARD-11: PMX Engine's moves that are yours, where Engine is on this Mac. 0 everywhere else. */
  engine: number;
  total: number;
}

type NeedsData = Pick<PipelineData, "drafts" | "needs" | "health" | "pendingTeam" | "rules"> & Partial<Pick<PipelineData, "stopped" | "digest" | "setup" | "engine">>;

export function needsYou(d: NeedsData): NeedsYou {
  const drafts = d.drafts.length;
  const reviewCap = d.rules.reviewCap;
  // Drafts carry `mine` from 0.36.0; before that every draft counted, as the page's Today note did.
  const mine = d.drafts.filter((x) => x.mine !== false).length;
  const stopped = (d.stopped ?? []).length;
  // `needs.proposals` is the count on both levels; the shared level leaves the proposals themselves out.
  const proposals = d.needs.proposals;
  const digest = d.digest?.waiting.length ?? 0;
  const fixes = (d.health.items ?? d.health.problems ?? []).length;
  const setup = d.setup?.next && d.setup.next.required !== false ? 1 : 0;
  const team = d.pendingTeam.length;
  const engine = engineMine(d.engine).length;
  return { drafts, paused: reviewCap > 0 && mine >= reviewCap, reviewCap, stopped, proposals, digest, fixes, setup, team, engine, total: drafts + stopped + proposals + digest + fixes + setup + team + engine };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Needs you: 3 drafts to review, 25 tasks to approve, …", or "Needs you: nothing". */
export function needsLine(n: NeedsYou): string {
  const parts = [
    n.drafts ? `${plural(n.drafts, "draft")} to review${n.paused ? " (your agent is paused until you review one)" : ""}` : "",
    n.stopped ? `${plural(n.stopped, "task")} stopped after failed runs` : "",
    n.proposals ? `${plural(n.proposals, "task")} to approve` : "",
    n.digest ? (n.digest === 1 ? "the weekly digest" : `${n.digest} weekly digests`) : "",
    n.fixes ? `${plural(n.fixes, "thing")} to fix` : "",
    n.setup ? "the next setup step" : "",
    n.team ? `${plural(n.team, "team settings change")} waiting` : "",
    n.engine ? `${plural(n.engine, "step")} in PMX Engine` : "",
  ].filter(Boolean);
  return `Needs you: ${parts.length ? parts.join(", ") : "nothing"}`;
}
