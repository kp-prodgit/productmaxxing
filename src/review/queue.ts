import type { Ctx } from "../core/context.js";
import { outputHost, type OutputHost } from "../core/host.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { Services } from "../core/services.js";
import type { Task } from "../core/types.js";
import { draftDecided, lookAt, markStore, markTask, type StoredMark } from "../lease/marks.js";
import type { RunRecord } from "../run/record.js";
import { removePackNow } from "../run/share.js";
import { followUpsOnAccept, followUpText, type FollowUpResult } from "./followups.js";

export interface ReviewItem {
  task: Task;
  prId: string;
  prUrl: string;
  files: { path: string; content: string }[];
  record: RunRecord | null;
  /** Source ID → the approved quote from the task, for citation hovercards. */
  citations: Record<string, string>;
}

export type Verdict = "accepted" | "rejected" | "redo";

export function prIdFromUrl(url: string): string {
  if (url.startsWith("branch:")) return url.slice(7);
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Can't read a PR number from ${url}`);
  return m[1]!;
}

export function citationsOf(t: Task): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of t.description.matchAll(/^- \[([A-Z]\d+)\] (.+)$/gm)) out[m[1]!] = m[2]!;
  return out;
}

/** A draft this Mac's copy of Linear shows waiting, though the team repo says it was decided (R13), and why. */
export interface DecidedDraft {
  /** The task's tracker id, as items are keyed, and its identifier, like PMX-12. */
  id: string;
  identifier: string;
  text: string;
}

/**
 * Drafts waiting for review. By default your own agent's; `all` for the whole team. `decided` (R13): drafts this Mac's
 * copy of Linear still shows in review, though the task's mark in the team repo says a Mac accepted, rejected or
 * dropped it since; they aren't items, so nothing decides them twice, until this Mac's next Linear sync catches up.
 */
export async function loadQueue(ctx: Ctx, svc: Services, o: { all?: boolean } = {}): Promise<{ items: ReviewItem[]; host: OutputHost; decided: DecidedDraft[] }> {
  const host = await outputHost(ctx.repo, ctx.keychain, ctx.exec, ctx.fetch);
  const inReview = (await svc.tracker.list({ status: ["review"] })).filter((t) => o.all || t.agent === ctx.agent);
  // A team repo out of reach leaves the queue as this Mac's copy of Linear has it.
  const marks = inReview.length ? await markStore(ctx.repo).list().catch(() => new Map<string, StoredMark>()) : new Map<string, StoredMark>();
  const look = await lookAt(ctx, svc.tracker);
  const items: ReviewItem[] = [];
  const decided: DecidedDraft[] = [];
  for (const t of inReview) {
    const gone = draftDecided(t.identifier, marks.get(t.identifier), look);
    if (gone) { decided.push({ id: t.id, identifier: t.identifier, text: gone }); continue; }
    const task = await svc.tracker.get(t.id);
    if (!task.prUrl) continue;
    const prId = prIdFromUrl(task.prUrl);
    if (!(await host.isOpen(prId))) continue;
    const files = await host.files(prId);
    const rec = files.find((f) => f.path === `.pmx/runs/${task.identifier}.json`);
    items.push({
      task, prId, prUrl: task.prUrl,
      files: files.filter((f) => !f.path.startsWith(".pmx/")),
      record: rec ? (JSON.parse(rec.content) as RunRecord) : null,
      citations: citationsOf(task),
    });
  }
  return { items, host, decided };
}

/** What a decision did: the sentence every surface shows, and for an accept, the follow-ups it made (FOLLOW-1). */
export interface Decided {
  message: string;
  followUps: FollowUpResult | null;
}

/**
 * Records a human decision (REV-1, REV-2). Accept merges the PR, marks the task done and removes its shared quotes
 * from the team repo (RUN-5). Reject closes the PR and blocks the task with the reason. Redo closes the PR, adds the
 * note to the task and puts it back to ready, so the next pull drafts it again with the note. Every surface decides
 * through here: `pmx review` (in a terminal or with --accept, --redo, --reject), the review page, and PMX's page (in
 * the browser or in the Claude app, through PMX's server).
 */
export async function decide(
  ctx: Ctx, svc: Services, host: OutputHost, item: ReviewItem, verdict: Verdict, o: { note?: string; reviewMinutes?: number | null } = {},
): Promise<string> {
  return (await recordDecision(ctx, svc, host, item, verdict, o)).message;
}

/** `decide`, with what an accept made (FOLLOW-1) for a surface that says more than the sentence. */
export async function recordDecision(
  ctx: Ctx, svc: Services, host: OutputHost, item: ReviewItem, verdict: Verdict, o: { note?: string; reviewMinutes?: number | null } = {},
): Promise<Decided> {
  const { task } = item;
  const who = ctx.personal.handle;
  let followUps: FollowUpResult | null = null;
  let followError: string | null = null;
  let unpushed: string | null = null;
  if ((verdict === "rejected" || verdict === "redo") && !o.note?.trim()) throw new Error(`A ${verdict === "redo" ? "redo" : "reject"} needs a note.`);
  if (verdict === "accepted") {
    // R24, D2-2: on a team repo that isn't on GitHub, the accept goes to origin on top of its newer work; when it can't,
    // the answer says so once, and Linear doesn't point teammates at a team repo that hasn't got it.
    unpushed = (await host.accept(item.prId))?.unpushed ?? null;
    await svc.tracker.comment(task.id, `Accepted by ${who}.${unpushed ? ` The accepted draft is on ${who}'s Mac until it's pushed to the team repo.` : ""}`);
    await svc.tracker.setStatus(task.id, "done");
    // FOLLOW-1: the draft's calls and open work, made after the accept, which nothing here undoes.
    try { followUps = await followUpsOnAccept(ctx, svc, item); }
    // Its first sentence, without a command in backticks: every surface shows this, the pages included.
    catch (e: any) { followError = String(e?.message ?? e).split(/(?<=[.!?])\s/)[0]!.replace(/\s*`[^`]*`/g, "").replace(/[.\s]+$/, "") || "it failed"; }
  } else if (verdict === "rejected") {
    await host.reject(item.prId, `Rejected by ${who}: ${o.note}`);
    await svc.tracker.comment(task.id, `Rejected by ${who}: ${o.note}`);
    await svc.tracker.setAgent(task.id, null);
    await svc.tracker.setStatus(task.id, "blocked");
  } else {
    await host.reject(item.prId, `Redo requested by ${who}: ${o.note}`);
    await svc.tracker.addNote(task.id, o.note!);
    await svc.tracker.comment(task.id, `Redo requested by ${who}: ${o.note}`);
    await svc.tracker.setAgent(task.id, null);
    await svc.tracker.setStatus(task.id, "ready");
  }
  // PULL-14: every Mac knows at once, whatever its copy of Linear says: done or rejected isn't drafted again, and a redo
  // lets any Mac's agent take it again.
  await markTask(ctx, svc.tracker, task.identifier, verdict === "accepted" ? "done" : verdict === "rejected" ? "blocked" : "ready");
  // RUN-5: an accepted task's shared quotes leave the team repo now, after its follow-ups read the pack, with the
  // clean-up's tombstone in that mark. One the team repo doesn't take now goes at the next clean-up; the accept stands.
  // A reject or a redo keeps them: the task may be drafted again.
  if (verdict === "accepted") await removePackNow(ctx, svc.tracker, task.identifier, "done");
  await new RunLogStore(ctx).record({
    type: "verdict", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task.identifier,
    category: task.category ?? "unknown", size: task.size ?? "?", verdict, reviewMinutes: o.reviewMinutes ?? null, editSize: null,
  });
  const more = followError ? `PMX couldn't make its follow-ups: ${followError}.` : followUpText(followUps);
  return { message: [`${task.identifier} ${verdict}.`, more, unpushed].filter(Boolean).join(" "), followUps };
}

export interface CategoryStats {
  accepted: number;
  rejected: number;
  redo: number;
  total: number;
  rate: number;
}

/** Accept rate per category over a window (REV-3, MET-1). Redo counts against acceptance. */
export function acceptStats(entries: RunLogEntry[], now: Date, windowDays: number): Record<string, CategoryStats> {
  const since = now.getTime() - windowDays * 86400000;
  const unpausedAt = new Map<string, number>();
  for (const e of entries) if (e.type === "unpause") unpausedAt.set(e.category, Math.max(unpausedAt.get(e.category) ?? 0, Date.parse(e.ts)));
  const out: Record<string, CategoryStats> = {};
  for (const e of entries) {
    if (e.type !== "verdict") continue;
    const t = Date.parse(e.ts);
    // An unpause resets the window for that category, so it gets a fresh chance.
    if (t < since || t < (unpausedAt.get(e.category) ?? 0)) continue;
    const s = (out[e.category] ??= { accepted: 0, rejected: 0, redo: 0, total: 0, rate: 0 });
    s[e.verdict]++;
    s.total++;
  }
  for (const s of Object.values(out)) s.rate = s.total ? s.accepted / s.total : 0;
  return out;
}

export function formatStats(stats: Record<string, CategoryStats>): string {
  const rows = Object.entries(stats).sort(([a], [b]) => a.localeCompare(b));
  if (!rows.length) return "No review decisions yet.";
  return rows.map(([c, s]) => `${c.padEnd(22)} ${(s.rate * 100).toFixed(0).padStart(3)}% accepted  (${s.accepted} accepted, ${s.redo} redo, ${s.rejected} rejected)`).join("\n");
}
