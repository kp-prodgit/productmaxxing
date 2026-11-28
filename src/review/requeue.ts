import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { Ctx } from "../core/context.js";
import { notify } from "../core/notify.js";
import { skillInventory } from "../core/skills.js";
import { loadState, updateState } from "../core/state.js";
import { REQUEUE_ASKED } from "../core/upgrade.js";
import { trackerGuard } from "../core/tracker-text.js";
import { privateNames } from "../run/run.js";
import { dropProposals, readProposals, requeueProposals, type Proposal } from "../synth/proposals.js";
import { keepTodo } from "../todo/todo.js";
import { cut, deadlineIn, followUpItems, norm, type FollowUpItem } from "./draft-reader.js";
import { askTodo, followUpKind, inWords, recordRequeued, type Made, type Requeued } from "./followups.js";

/**
 * D2-8 (FOLLOW-1, UPGRADE-1): the follow-ups an older PMX left waiting for approval, read again by today's rules.
 *
 * Before 0.38.0, accepting a draft made a suggested task of every open or blocking question, so many tasks waiting in
 * Needs you are one message to a colleague ("Who signs the contract at Globex …?"). Once, at the first background run
 * after the update, each waiting follow-up from an accepted draft (`follows`, not synthesis's own follow-up to finished
 * work) that a PMX before 0.38.0 staged (it has no `checked`, which 0.38.0 added) is read again from its draft in the
 * team repo, by the reader accepting uses now:
 *
 * - a question one person can answer becomes the PM's "Ask <role>: …" to-do, due when the draft says, and leaves Needs you;
 * - a call marked PM decides becomes a decision to-do, and leaves too; one worded as something to do ("Check the scope …")
 *   becomes a to-do as written, and the notice counts it apart, as a thing to do;
 * - work stays waiting, with today's title (the whole question) and the kind of work the question asks for;
 * - an item that is no question, no call and nothing someone can do ("Written plan owed.") is no follow-up at all: it is
 *   dropped, and the ledger on this Mac says why, wherever the run behind its task was. A short action ("Send the
 *   plan.") stays as it is.
 *
 * A follow-up whose draft can't be read any more, or whose item the draft no longer has, stays as it is. Each change is
 * recorded with its draft in the follow-ups ledger, and the to-do says where it came from. A follow-up that became a
 * to-do is recorded there by its fixed ID, the item of the draft it was read from, exactly as accepting records it
 * (src/review/follow-up-id.ts): so accepting that draft again finds it by that ID and makes none twice, however PMX
 * words it by then.
 */

/** Staged by a PMX before 0.38.0: a follow-up to an accepted draft that no tracker-rules version checked. */
export const olderFollowUp = (p: Proposal) => !!p.follows && p.follows.where !== "done" && p.checked === undefined;

export interface RequeueResult {
  /** Now to-dos: questions to ask, calls that are the PM's, and things to do as written ("Check the scope …"). */
  asks: Requeued[];
  decisions: Requeued[];
  actions: Requeued[];
  /** Still work, with today's title or kind. */
  retitled: Requeued[];
  /** No follow-up by today's rules, and nothing someone can do: dropped. */
  dropped: Requeued[];
  /** Read again and left as they were: still work under the same title, or no longer in the draft. */
  unchanged: number;
  /** Their draft can't be read any more: left as they were. */
  unreadable: number;
}

/** The draft's text in the team repo, or null: a path that leaves the repo is never read. */
async function draftText(repo: string, path: string): Promise<string | null> {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) return null;
  return readFile(join(repo, path), "utf8").catch(() => null);
}

/**
 * The item of the draft a follow-up was made from: its title (cut, maybe) or its description's first line is in it. An
 * item that is no follow-up at all (`junk`) only when nothing else is, and only when the title is how it starts, as an
 * older PMX titled it.
 */
function itemOf(p: Proposal, items: FollowUpItem[]): FollowUpItem | null {
  const title = norm(p.title.replace(/…$/, ""));
  const first = norm(p.description.split(/\n\n/)[0] ?? "");
  return items.find((i) => {
    const text = norm(i.text);
    return !i.junk && ((title.length >= 8 && text.includes(title)) || (first.length >= 8 && text.includes(first.slice(0, 120)))
      || (!!i.question && norm(i.question.question) === title));
  }) ?? items.find((i) => i.junk && title.length >= 8 && norm(i.text).startsWith(title)) ?? null;
}

/**
 * Why the requeue dropped a follow-up (D2-8), in the ledger on this Mac, and in its run's receipt too when this Mac has
 * one that lists it.
 */
export const NOT_A_FOLLOW_UP = "PMX: no question, call or task by today's rules";

export async function requeueFollowUps(ctx: Ctx): Promise<RequeueResult> {
  const out: RequeueResult = { asks: [], decisions: [], actions: [], retitled: [], dropped: [], unchanged: 0, unreadable: 0 };
  const older = (await readProposals()).filter(olderFollowUp);
  if (!older.length) return out;
  const now = ctx.now();
  const kinds = Object.keys(ctx.team.categories);
  const stages = Object.fromEntries((await skillInventory(ctx.personal.repoPath, ctx.team.categories).catch(() => [])).filter((s) => s.category).map((s) => [s.category!, s.check?.stage ?? null]));
  // A role, never a person: one the CRM or do-not-read lists name is left out, as when accepting.
  const guard = trackerGuard({ names: await privateNames(ctx).catch(() => [] as string[]) });
  const texts = new Map<string, string | null>();

  const take: string[] = [];
  const retitle: { id: string; title: string; category: string }[] = [];
  const drop: string[] = [];
  /** What each one becomes, decided before anything changes. */
  const plans = new Map<string, { p: Proposal; as: "ask" | "decision" | "action"; text: string; due: string | null; why: string; ids: string[] } | { p: Proposal; as: "work"; title: string; category: string }>();
  for (const p of older) {
    const f = p.follows!;
    const path = f.path;
    if (!texts.has(path)) texts.set(path, await draftText(ctx.personal.repoPath, path));
    const md = texts.get(path);
    if (!md) { out.unreadable++; continue; }
    // Read as on the day it was staged, so a date without a year means what it meant then.
    const at = Number.isNaN(Date.parse(p.at)) ? now : new Date(p.at);
    const item = itemOf(p, followUpItems(md, f.identifier, at));
    const q = item?.question ?? null;
    const d = item?.decision ?? null;
    if (item?.junk) {
      drop.push(p.id);
      continue;
    }
    if (d) {
      plans.set(p.id, { p, as: d.action ? "action" : "decision", text: d.text, due: d.due, why: d.why, ids: d.ids });
      take.push(p.id);
    } else if (q?.ask) {
      const { text, why } = askTodo(q, f.identifier, (s) => !guard.problem(s));
      plans.set(p.id, { p, as: "ask", text, due: deadlineIn([q.question, ...q.rest].join(" "), at), why, ids: q.ids });
      take.push(p.id);
    } else if (q) {
      // Still work: the whole question as its title, and the kind of work it asks for. The task's own kind is the
      // folder its draft is in (outputs/<kind>/…).
      const own = path.match(/^outputs\/([^/]+)\//)?.[1] ?? null;
      const title = cut(q.title.replace(/\s+/g, " "), 120);
      const category = followUpKind(`${q.question} ${q.rest.join(" ")}`, own && kinds.includes(own) ? own : null, kinds, stages, { needs: q.needs, question: `${q.title} ${q.question}` }) ?? p.category;
      if (title === p.title && category === p.category) { out.unchanged++; continue; }
      plans.set(p.id, { p, as: "work", title, category });
      retitle.push({ id: p.id, title, category });
    } else out.unchanged++;
  }
  if (!take.length && !retitle.length && !drop.length) return out;

  // Off the list first, so one approved or dropped meanwhile never becomes a to-do as well.
  const { taken, retitled } = await requeueProposals({ take, retitle });
  const byDraft = new Map<string, { identifier: string; path: string; changes: Requeued[]; made: Made[] }>();
  /** `made`: the follow-up it became a to-do of, under each item of the draft it was read from (its fixed IDs). */
  const record = (p: Proposal, r: Requeued, made: Made[] = []) => {
    const k = `${p.follows!.identifier} ${p.follows!.path}`;
    const e = byDraft.get(k) ?? { identifier: p.follows!.identifier, path: p.follows!.path, changes: [], made: [] };
    e.changes.push(r);
    e.made.push(...made);
    byDraft.set(k, e);
  };
  for (const p of taken) {
    const plan = plans.get(p.id);
    if (!plan || plan.as === "work") continue;
    const f = p.follows!;
    const t = await keepTodo({
      text: plan.text, due: plan.due, why: plan.why,
      // Where it came from, as for the follow-ups accepting makes now; the run and sources it had as a task stay with it.
      source: { title: `From ${f.identifier}'s accepted draft, ${f.path}`, at: p.at.slice(0, 10), keys: [] },
      receiptId: p.receipt, sources: p.sources,
    }, now);
    const r: Requeued = { at: now.toISOString(), proposal: p.id, was: p.title, as: plan.as, now: t.text, todo: t.id };
    (plan.as === "ask" ? out.asks : plan.as === "action" ? out.actions : out.decisions).push(r);
    record(p, r, plan.ids.map((id) => ({ id, as: plan.as, todo: t.id, at: r.at })));
  }
  for (const id of retitled) {
    const plan = plans.get(id);
    if (!plan || plan.as !== "work") continue;
    const r: Requeued = { at: now.toISOString(), proposal: id, was: plan.p.title, as: "work", now: plan.title, category: plan.category };
    out.retitled.push(r);
    record(plan.p, r);
  }
  out.unchanged += retitle.length - retitled.length;
  // No follow-up at all: dropped like one the PM drops. One approved meanwhile is gone already. Why is in the ledger,
  // which this Mac always has: the receipt `dropProposals` marks may be on the Mac of the PM who suggested the original
  // task, and never lists a follow-up an accept made, so it can't be the only record.
  const { dropped } = drop.length ? await dropProposals(drop, now, NOT_A_FOLLOW_UP) : { dropped: [] as Proposal[] };
  for (const p of dropped) {
    const r: Requeued = { at: now.toISOString(), proposal: p.id, was: p.title, as: "dropped", now: "", why: NOT_A_FOLLOW_UP };
    out.dropped.push(r);
    record(p, r);
  }
  for (const e of byDraft.values()) await recordRequeued(e.identifier, e.path, e.changes, e.made, now).catch(() => {});
  return out;
}

const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/**
 * What the PM is told, once: "PMX turned 12 waiting follow-ups into to-dos (12 questions one person can answer)." Each
 * kind counted, even when there is only one, and each word agrees with its count: "PMX turned 1 waiting follow-up into
 * a to-do (1 question one person can answer)." With more than one kind, each counted apart, a call worded as something
 * to do as a thing to do: "(2 questions one person can answer, 2 calls that are yours and 1 thing to do)". Null when
 * nothing changed.
 */
export function requeueText(r: RequeueResult): string | null {
  const kinds = ([[r.asks.length, "question one person can answer", "questions one person can answer"], [r.decisions.length, "call that is yours", "calls that are yours"], [r.actions.length, "thing to do", "things to do"]] as const).filter(([k]) => k);
  const todos = r.asks.length + r.decisions.length + r.actions.length;
  // End-to-end test 2026-11-27: one kind is counted too, as with several ("(questions one person can answer)" said no
  // number, and a plural for one).
  const what = inWords(kinds.map(([k, one, many]) => n(k, one, many)));
  const k = r.retitled.length;
  const x = r.dropped.length;
  return [
    todos ? `PMX turned ${n(todos, "waiting follow-up")} into ${todos === 1 ? "a to-do" : "to-dos"} (${what}).` : "",
    !k ? "" : todos ? `${k === 1 ? "One that needs work still waits" : `${k} that need work still wait`} for your approval, with a clearer title.`
      : `PMX gave ${n(k, "waiting follow-up")} a clearer title; ${k === 1 ? "it still waits" : "they still wait"} for your approval.`,
    // D2-8: what it dropped, by its old title, so the PM can find it in the draft.
    !x ? "" : `${todos || k ? "It" : "PMX"} dropped ${x === 1 ? `"${cut(r.dropped[0]!.was, 60)}", which is` : `${x} that are`} no question, call or task.`,
  ].filter(Boolean).join(" ") || null;
}

/**
 * The background run's step for D2-8: once an update asked for it (UPGRADE-1), reads the older waiting follow-ups again,
 * tells the PM once, and records what it did. Returns that, or null.
 */
export async function requeueStep(ctx: Ctx): Promise<string | null> {
  const st = await loadState();
  if (!st.followUpRequeue?.due) return null;
  const r = await requeueFollowUps(ctx);
  const text = requeueText(r);
  const at = ctx.now().toISOString();
  const did = text ?? "no waiting follow-up from an older PMX needed a change";
  await updateState((s) => {
    s.followUpRequeue = { due: false, at, did };
    // The update's own record says what its step came to (UPGRADE-1), so `pmx checklist` shows it.
    for (const [k, a] of Object.entries(s.upgrade?.applied ?? {})) if (/^follow-ups-requeue(?:@|$)/.test(k) && a.did === REQUEUE_ASKED) s.upgrade!.applied[k] = { at, did };
  });
  if (text) await notify("ProductMaxxing", text).catch(() => {});
  return text;
}
