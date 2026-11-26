import type { Ctx } from "../core/context.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { Task } from "../core/types.js";

/**
 * R6 (INPUT-2): how long a finished task still counts as the team's recent work. Synthesis shows Claude these tasks and
 * checks its suggestions' titles against them, and approval refuses one of their titles, so a need heard again after
 * the work was done isn't suggested as new work. 30 days: synthesis reads at most 14 days of meetings, so a call about
 * work finished within the month before is most likely the same need heard again, or a follow-up to it; past a month a
 * need is more often a new round of work, and an old title shouldn't stand in its way. A task whose draft was accepted
 * that morning counts at once.
 */
export const DONE_DAYS = 30;

/** A task the team finished recently (R6). */
export interface DoneTask {
  identifier: string;
  title: string;
  /** What Linear says it was about, so a later need can be told apart from it (what's new since). */
  description: string;
  url: string;
  /** The day it was done (YYYY-MM-DD), as `doneWithin` dates it. */
  at: string;
}

const DAY = 86400000;

/**
 * The tasks done in the last `days` days, newest first (R6). A task is done when its draft was accepted (the latest
 * verdict for it in the team's run log, from any Mac, also while this Mac's copy of Linear still shows it in review) or
 * when Linear shows it done. It was done when its draft was accepted; a task closed in Linear without a verdict, which
 * PMX can't date, counts from the day it was created: it can't have been done before then, so one created in the window
 * was done in it, and an older one is left out.
 */
export function doneWithin(tasks: Task[], runs: RunLogEntry[], now: Date, days = DONE_DAYS): DoneTask[] {
  const verdicts = new Map<string, { ts: string; accepted: boolean }>();
  for (const e of runs) {
    if (e.type !== "verdict") continue;
    const cur = verdicts.get(e.taskId);
    if (!cur || e.ts > cur.ts) verdicts.set(e.taskId, { ts: e.ts, accepted: e.verdict === "accepted" });
  }
  const since = now.getTime() - days * DAY;
  const out: DoneTask[] = [];
  for (const t of tasks) {
    const v = verdicts.get(t.identifier);
    const accepted = !!v?.accepted && (t.status === "done" || t.status === "review");
    if (!accepted && t.status !== "done") continue;
    const at = accepted ? v!.ts : t.createdAt;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms) || ms < since) continue;
    out.push({ identifier: t.identifier, title: t.title, description: t.description ?? "", url: t.url ?? "", at: new Date(ms).toISOString().slice(0, 10) });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at) || a.identifier.localeCompare(b.identifier));
}

/**
 * The team's recently done tasks from its tracker list (R6). Reads the team's run log only when a task is done or in
 * review, so a team with nothing finished reads nothing more.
 */
export async function recentlyDone(ctx: Pick<Ctx, "repo" | "exec" | "now">, tasks: Task[]): Promise<DoneTask[]> {
  if (!tasks.some((t) => t.status === "done" || t.status === "review")) return [];
  const log = new RunLogStore(ctx);
  const runs = (await log.exists().catch(() => false)) ? await log.entries().catch(() => [] as RunLogEntry[]) : [];
  return doneWithin(tasks, runs, ctx.now());
}

/** A done task's day as a PM reads it: "Nov 26". */
export function doneDay(at: string): string {
  const [, m, d] = at.slice(0, 10).split("-").map(Number);
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return m && d ? `${months[m - 1]} ${d}` : at;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The same title, word for word once case and punctuation are set aside: what approval refuses (R6). */
export const sameWords = (a: string, b: string) => norm(a) === norm(b) && norm(a).length > 0;
