import type { Ctx } from "../core/context.js";
import { markTask } from "../lease/marks.js";
import { readReceipt, writeReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import { SIZES, type Size, type Task } from "../core/types.js";
import { citationNeed, citeText } from "../pull/pull.js";
import { receiptOf, taskEvidence } from "../run/evidence.js";
import { removePackNow, shareEvidence, stageShares } from "../run/share.js";
import { dateRange } from "../synth/synthesize.js";
import { approveProposals, CHECKED, heldText, holdProposal, markKept, readProposals, takeProposal, type Proposal } from "../synth/proposals.js";
import { recheckProposal } from "../synth/recheck.js";
import { readResolved } from "../tracker/relay.js";
import { COMMITMENT, getTodo, keepTodo, linkTodo, loadTodos, removeTodo, sendTodoToLinear, type Todo } from "./todo.js";

/**
 * Where a piece of the PM's work lives (TODO-5). Private: a to-do only on this Mac. To-do: the same to-do tracked in
 * the team's Linear project as the PM's own commitment, which no agent takes. Product: a task for the team, of a kind
 * of work agents can take, in Linear or proposed and waiting for the PM's approval.
 */
export const PLACES = ["private", "todo", "product"] as const;
export type Place = (typeof PLACES)[number];
export const PLACE_NAME: Record<Place, string> = { private: "a private to-do", todo: "a to-do in Linear", product: "a product task" };

export interface Moved {
  from: Place;
  to: Place;
  text: string;
  /** The PM's to-do it is now, if it is one. */
  todo: string | null;
  /** The Linear issue it is now, if it is one. */
  identifier: string | null;
  message: string;
}

/** Linear identifiers (PMX-12) and the relay's placeholders for issues it hasn't created yet (PENDING-1A2B3C). */
const ISSUE = /^[A-Za-z][A-Za-z0-9]*-[A-Za-z0-9]+$/;
const PROPOSAL = /^p[0-9a-f]{6}$/i;
/** Only work nobody has started moves: an agent's claim, a draft or a decision stays with the team. */
const MOVABLE = new Set(["inbox", "ready", null]);
const OFF = "Sending your own to-dos to Linear is off, so they stay on this Mac. Turn it on in Settings, under What Linear gets, or with `pmx todo --linear on`.";

/** R16: the meetings a moved to-do carries into its task: its run's receipt and the IDs its sources have there. */
interface Carried {
  receipt: string | null;
  /** The sources the team's agents may quote now (RUN-3), by the receipt's IDs. */
  ids: string[];
  /** Each carried source's kind and day, for the readable sources line (PRIV-6). */
  seen: { kind: "meeting" | "thread"; at: string }[];
  /** How many of the to-do's meetings stay with the PM's to-dos: the team's privacy rules keep them from agents. */
  kept: number;
  /** Why it carries none, in a PM's words, when it came from meetings but none could go. */
  none: string | null;
}

const NONE: Carried = { receipt: null, ids: [], seen: [], kept: 0, none: null };

/**
 * The description of a to-do moved to the team (TODO-5). Only PMX's own words and the to-do's due date; R16: with the
 * meetings it came from as a readable sources line (their kind and dates, never a title, person or word) and the
 * `pmx:source` lines an agent's evidence comes from, under the to-do run's receipt. D2: a to-do from a run whose
 * meetings none can go names that receipt all the same, so taking the task back keeps it (`sourcesOf`) and moving it
 * to the team again checks its words against those meetings' people.
 */
const productDescription = (handle: string, due: string | null, c: Carried = NONE) => {
  const head = `A task ${handle} moved here from their own to-dos${due ? `, due ${due}` : ""}.`;
  const note = "PMX sent only these words: no meeting title, transcript, attendees or quotes.";
  if (!c.receipt) return [head, "", note].join("\n");
  if (!c.ids.length) return [head, "", `**Sources:** none agents can quote. Where it came from stays on the PM's Mac: \`pmx explain ${c.receipt}\` there shows it.`, "", note].join("\n");
  const part = (kind: "meeting" | "thread") => {
    const days = c.seen.filter((x) => x.kind === kind).map((x) => x.at);
    if (!days.length) return null;
    const what = kind === "meeting" ? (days.length === 1 ? "a meeting" : `${days.length} meetings`) : days.length === 1 ? "a thread in an approved channel" : `${days.length} threads in approved channels`;
    const when = dateRange(days);
    return `${what}${when ? ` (${when})` : ""}`;
  };
  const line = [part("meeting"), part("thread")].filter(Boolean).join("; ");
  return [head, "", `**Sources:** ${line}. They stay on the PM's Mac: \`pmx explain ${c.receipt}\` there shows them.`, "", note, "", ...c.ids.map((id) => `pmx:source ${id}`)].join("\n");
};

const normText = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * R6 (TODO-5): the due date PMX wrote at the top of a task a to-do became ("A task ana moved here from their own to-dos,
 * due 2026-11-30.") or of a commitment ("A commitment ana made, due 2026-11-30, sent to Linear…"), so a to-do taken
 * back keeps it.
 */
const dueIn = (description: string | undefined): string | null => description?.match(/^A (?:task|commitment) [^\n]*?, due (\d{4}-\d{2}-\d{2})\b/m)?.[1] ?? null;

/**
 * R16 (TODO-5, RUN-3): the meetings a to-do came from, as its run's receipt records them, that the team's agents may
 * quote now. A to-do keeps their IDs (`sources`); one from before that is found in its run's `todo.added`. Each is read
 * again through the team's privacy rules, as an agent's evidence is: a 1:1, an internal meeting or anything else those
 * rules keep from team work stays with the PM's to-dos, and only a source that passes is carried.
 */
async function todoSources(ctx: Ctx, t: Todo): Promise<Carried> {
  if (!t.receiptId) return NONE;
  const r = await readReceipt(t.receiptId);
  if (!r) return { ...NONE, none: "the run that found it is no longer on this Mac" };
  const added = r.todo?.added.find((a) => normText(a.text) === normText(t.text));
  const wanted = t.sources?.length ? t.sources : added ? [added.source, ...(added.also ?? [])] : [];
  const ids = [...new Set(wanted)].filter((id) => r.sources.some((s) => s.decision === "used" && s.id === id));
  // D2: none to carry, and still its run's: the receipt goes with the task, so a move back keeps it.
  if (!ids.length) return { ...NONE, receipt: r.id };
  const e = await taskEvidence(ctx, { title: t.text, description: `\`pmx explain ${r.id}\``, sources: ids }).catch(() => ({ sources: [], missing: ids.map((id) => ({ id, why: "PMX couldn't read it" })) }));
  const seen = e.sources.map((s) => ({ kind: s.kind, at: s.at }));
  const ok = e.sources.map((s) => s.id);
  const kept = ids.length - ok.length;
  return { receipt: r.id, ids: ok, seen, kept, none: ok.length ? null : `your team's privacy rules keep ${ids.length === 1 ? "the meeting it came from" : `the ${ids.length} meetings it came from`} away from agents, or ${ids.length === 1 ? "its file is" : "their files are"} no longer in your folders` };
}

/** "its title names a person" in a to-do's words: "its words name a person". */
const PLURAL: Record<string, string> = { carries: "carry", quotes: "quote", has: "have", is: "are", names: "name", repeats: "repeat" };
const inWords = (held: string) => held.replace(/^its title (carries|quotes|has|is|names|repeats)\b/, (_m, v: string) => `its words ${PLURAL[v]}`);

/**
 * F14, R3 (PRIV-6): a to-do's words become a team task's title in Linear only through the tracker guard approval uses
 * (`recheckProposal`), with what its meetings name: everyone in every meeting and thread its to-do run read (participants
 * and speakers, as `peopleIn` reads them), their titles and passages for the quote rule, the CRM and do-not-read lists,
 * the approved series, the released strategy, contact details and fundraising. A typed to-do, or one whose run is gone,
 * is checked against everything that needs no meeting. A title that fails sends nothing and keeps the to-do, with the
 * reason; a sentence of the description PMX built that fails is left out.
 */
async function guardMove(ctx: Ctx, t: Todo, c: Carried, description: string, o: { titleOnly?: boolean; again?: string } = {}): Promise<{ description: string; leftOut: string | null }> {
  const p: Proposal = {
    id: `todo-${t.id}`, at: ctx.now().toISOString(), receipt: c.receipt ?? t.receiptId ?? "", title: t.text.slice(0, 200), description,
    category: "", size: "S", sources: c.ids, from: [], checked: CHECKED,
  };
  const r = await recheckProposal(ctx, p, { titleOnly: o.titleOnly });
  // R6: says how to reword it, keeping its meetings and due date; one in Linear as the PM's own comes back first.
  const reword = `reword it with \`pmx todo edit ${t.id} "<new words>"\`, which keeps its meetings and due date`;
  if (r.held) throw new Error(`PMX didn't send it: ${inWords(r.held)}. ${t.linear ? `Move it back first (\`pmx move ${t.id} private\`), ${reword},` : `${reword.charAt(0).toUpperCase()}${reword.slice(1)},`} and ${o.again ?? "move it again"}.`);
  return { description: r.description, leftOut: r.leftOut };
}

/**
 * SIG-7, R7 (founder decision 2026-11-26): a to-do sent to Linear as the PM's own commitment is checked like every
 * other Linear text first: its words, as the title they become, through `guardMove`'s check (the cue rule on the words
 * themselves; everyone its to-do run's meetings and threads name, their titles and the quote rule on their passages;
 * the CRM and do-not-read lists; fundraising and confidential contacts; contact details). The description is PMX's own
 * words. A to-do that fails stays private, nothing is queued, and the answer says why in one line, with the command that
 * rewords it. Every path that sends one uses this: `pmx todo linear <id>`, the page's Send to Linear, `pmx move <id>
 * todo`. `again`: how the answer ends, "send it again" or "move it again".
 */
export async function sendCommitment(ctx: Ctx, tracker: Services["tracker"], id: string, o: { again?: string } = {}): Promise<{ identifier: string; text: string; already: boolean }> {
  if (ctx.team.tracker.kind !== "none" && ctx.personal.todosToLinear) {
    const t = (await loadTodos()).items.find((x) => x.id === id);
    if (t && !t.linear) await guardMove(ctx, t, NONE, "", { titleOnly: true, again: o.again ?? "send it again" });
  }
  // Its own checks first: the setting, the tracker, the to-do.
  return sendTodoToLinear(ctx, tracker, id);
}

/**
 * R16: records in the to-do's run that it became a team task with these sources, so that receipt is kept as long as a
 * synthesis run behind a task (RUN-3), and a to-do from a waiting task says where it went (FLOW-1).
 */
async function noteMoved(ctx: Ctx, todoId: string, c: Carried, identifier: string): Promise<void> {
  if (!c.receipt) return;
  const r = await readReceipt(c.receipt);
  if (!r) return;
  if (r.todo) r.todo.moved = [...(r.todo.moved ?? []).filter((m) => m.identifier !== identifier), { identifier, sources: c.ids, at: ctx.now().toISOString() }];
  for (const x of r.synth?.tasks ?? []) if (x.posted && "todo" in x.posted && x.posted.todo === todoId) x.posted = { identifier };
  await writeReceipt(r, ctx.now());
}
/** The description PMX writes for a commitment (SIG-7): replaced when it becomes a product task, so agents get no "don't pick this up". */
const isCommitmentText = (d: string) => /^A commitment .* made/.test(d) && d.includes("Agents don't pick up commitments.");

/**
 * Moves one piece of work between private, to-do and product, in any direction (TODO-5). `ref` is a to-do ID, a
 * proposal ID or a Linear identifier. Moving to product needs a kind of work (`kind`), unless it's a proposal, which
 * has one: approving it is the move. Words leave this Mac only when the PM turned on sending their to-dos (SIG-7);
 * taking work back from Linear cancels the issue there, with a comment saying why, and never deletes it.
 */
export async function moveWork(ctx: Ctx, svc: () => Promise<Services>, ref: string, to: Place, o: { kind?: string; size?: string } = {}): Promise<Moved> {
  if (!(PLACES as readonly string[]).includes(to)) throw new Error(`Move it to private, todo or product, not "${to}".`);
  ref = ref.trim();
  if (!ref) throw new Error("Say what to move: a to-do ID from `pmx todo`, a waiting task's ID from `pmx proposals`, or a Linear identifier like PMX-12.");
  const now = ctx.now();
  const handle = ctx.personal.handle;
  const tracker = async () => {
    if (ctx.team.tracker.kind === "none") throw new Error("Your team has no task tracker, so there's no Linear to move it to or from.");
    return (await svc()).tracker;
  };
  const kind = (): { kind: string; size: Size } => {
    const kinds = Object.keys(ctx.team.categories);
    if (!kinds.length) throw new Error("Your team hasn't set up any kinds of work yet, so there's no product task to make.");
    const k = o.kind?.trim().toLowerCase();
    if (!k || !kinds.includes(k)) throw new Error(`${k ? `"${o.kind}" isn't one of your team's kinds of work. ` : "Pick a kind of work for the task: "}${kinds.join(", ")} (--kind).`);
    const size = (o.size?.trim().toUpperCase() || "S") as Size;
    if (!SIZES.includes(size)) throw new Error(`A size is ${SIZES.join(", ")}, not "${o.size}".`);
    return { kind: k, size };
  };
  const same = (from: Place, text: string) => new Error(`"${text}" is already ${PLACE_NAME[from]}.`);
  /** A to-do's Linear link, as Linear knows it now: a placeholder becomes the identifier Claude reported. */
  const real = async (id: string) => (id.startsWith("PENDING-") ? (await readResolved())[id]?.identifier ?? id : id);
  const issueFor = async (id: string): Promise<Task | null> => {
    const want = id.toUpperCase();
    return (await (await tracker()).list()).find((t) => t.identifier.toUpperCase() === want || t.id === id) ?? null;
  };
  const movable = (t: Task) => {
    if (!MOVABLE.has(t.status) || t.agent) throw new Error(`${t.identifier} is ${t.status === "done" ? "done" : t.status === "blocked" ? "blocked" : "already being worked on"} in Linear, so it stays where it is.`);
  };
  /**
   * Takes an issue back out of Linear: a comment for the team, then canceled. R16b: one only queued for Linear (the
   * Claude relay hasn't created it yet) leaves the queue instead, so nothing of it reaches Linear. Says which: "queued".
   */
  const withdraw = async (t: Task, why: string): Promise<"queued" | "canceled"> => {
    const tr = await tracker();
    if (tr.unqueue && (await tr.unqueue(t.id))) return "queued";
    await tr.comment(t.id, why);
    await tr.rewrite(t.id, { cancel: true });
    // PULL-14: a Mac whose copy of Linear still shows it Ready doesn't draft it.
    await markTask(ctx, tr, t.identifier, "dropped");
    // RUN-5: dropped, so its shared quotes leave the team repo now, as the clean-up would remove them.
    await removePackNow(ctx, tr, t.identifier, "dropped");
    return "canceled";
  };
  /** What became of the issue, in a sentence: canceled in Linear, or never sent. */
  const gone = (t: Task, how: "queued" | "canceled") => (how === "queued" ? `${t.identifier} hadn't reached Linear yet, so nothing of it goes there.` : `${t.identifier} is canceled in Linear.`);
  /**
   * R16c (TODO-5): a team task taken back as a to-do keeps its sources (its `pmx:source` IDs, under the receipt its
   * description names, when this Mac has that receipt), so moving it to the team again brings them back. D2: and that
   * receipt, sources or not, so the move's check reads its meetings' people (`guardMove`).
   */
  const sourcesOf = async (t: Task): Promise<{ receiptId?: string; sources?: string[]; due?: string }> => {
    const id = receiptOf(t);
    const r = id ? await readReceipt(id) : null;
    const ids = r ? t.sources.filter((x) => r.sources.some((s) => s.decision === "used" && s.id === x)) : [];
    // R6: and its due date, as the task's description gives it.
    const due = dueIn(t.description);
    return { ...(r ? { receiptId: r.id, ...(ids.length ? { sources: ids } : {}) } : {}), ...(due ? { due } : {}) };
  };
  /** A Linear task becomes the PM's commitment: agents stop seeing it as theirs. */
  const toCommitment = async (t: Task) => {
    const tr = await tracker();
    await tr.setCategory(t.id, COMMITMENT);
    if (t.status === "ready") await tr.setStatus(t.id, "inbox");
    await tr.comment(t.id, `${handle} took this as their own to-do. Agents don't pick it up.`);
  };
  /** A commitment becomes a task for the team, of a kind agents take. R16: with the meetings its to-do came from. */
  const toProduct = async (t: Task, k: { kind: string; size: Size }, due: string | null, description = productDescription(handle, due)) => {
    const tr = await tracker();
    await tr.setCategory(t.id, k.kind);
    if (t.size !== k.size) await tr.setSize(t.id, k.size);
    if (isCommitmentText(t.description ?? "")) await tr.rewrite(t.id, { description });
    await tr.comment(t.id, `${handle} made this a ${k.kind} task for the team.`);
  };
  const moved = (from: Place, text: string, todo: string | null, identifier: string | null, message: string): Moved => ({ from, to, text, todo, identifier, message });

  // A proposal: a product task waiting for the PM's approval. To-do IDs are hex, so never start with "p".
  if (PROPOSAL.test(ref)) {
    if (!(await readProposals()).some((p) => p.id === ref.toLowerCase())) throw new Error(`Task ${ref} isn't waiting any more. \`pmx proposals\` lists the ones that are.`);
    if (to === "product") {
      const r = await approveProposals(ctx, await svc(), [ref]);
      const p = r.posted[0];
      if (!p) throw new Error(r.duplicates[0] ? `Not sent: ${r.duplicates[0]}.` : r.held[0] ? `Not sent: ${heldText(r.held[0])}.` : "That task is no longer waiting.");
      return moved("product", p.title, null, p.identifier, [p.filled ? `Approved: "${p.title}" went to ${p.identifier}.` : `Approved: "${p.title}" is ${p.identifier}, a product task for the team.`, ...r.checked.map((c) => `${c}.`), ...r.notShared].join(" "));
    }
    if (to === "todo" && !ctx.personal.todosToLinear) throw new Error(OFF);
    if (to === "todo") {
      await tracker();
      // R3: its title goes to Linear as the to-do's words, so it's checked again like an approval's first.
      const waiting = (await readProposals()).find((x) => x.id === ref.toLowerCase());
      const c = waiting ? await recheckProposal(ctx, waiting, { titleOnly: true }) : null;
      if (waiting && c?.held) {
        await holdProposal(waiting.id, c.held, now);
        throw new Error(`Not sent: ${heldText({ id: waiting.id, title: waiting.title, why: c.held })}.`);
      }
    }
    const p = await takeProposal(ref);
    if (!p) throw new Error("That task is no longer waiting.");
    const f = p.from[0];
    // R16: the to-do keeps the task's source IDs, so moving it to the team again carries them.
    const t = await keepTodo({ text: p.title, why: f?.why ?? "", source: f ? { title: f.title, at: f.at.slice(0, 10), keys: [] } : undefined, receiptId: p.receipt, sources: p.sources }, now);
    await markKept(p, t.id, now);
    if (to === "private") return moved("product", t.text, t.id, null, `Kept as your private to-do: ${t.text}. Nothing reaches Linear.`);
    const s = await sendTodoToLinear(ctx, await tracker(), t.id);
    return moved("product", t.text, t.id, s.identifier, `Now your to-do, in Linear as ${s.identifier}: ${t.text}. Agents don't pick it up.`);
  }

  // A Linear identifier: a task on the team's list, or a commitment.
  if (ISSUE.test(ref)) {
    const t = await issueFor(await real(ref.toUpperCase()));
    if (!t) throw new Error(`${ref.toUpperCase()} isn't a task in your team's PMX project${ctx.team.tracker.kind === "linear" ? " as Linear was last synced" : ""}.`);
    let linked: Todo | null = null;
    for (const x of (await loadTodos()).items) if (!linked && x.status === "open" && x.linear && (await real(x.linear)) === t.identifier) linked = x;
    if (t.category === COMMITMENT) {
      // A commitment sent from this Mac moves as its to-do; one made elsewhere still moves.
      if (linked) return moveTodo(linked);
      if (to === "todo") throw same("todo", t.title);
      movable(t);
      if (to === "private") {
        const how = await withdraw(t, `${handle} took this back to their private to-dos.`);
        const k = await keepTodo({ text: t.title, due: dueIn(t.description) }, now);
        return moved("todo", k.text, k.id, null, `Back to your private to-dos: ${k.text}. ${gone(t, how)}`);
      }
      const k = kind();
      await toProduct(t, k, null);
      return moved("todo", t.title, null, t.identifier, `${t.identifier} is now a ${k.kind} task for the team: ${t.title}.`);
    }
    if (to === "product") throw same("product", t.title);
    movable(t);
    if (to === "todo") {
      await toCommitment(t);
      const k = await keepTodo({ text: t.title, source: { title: `Moved from ${t.identifier}`, at: now.toISOString().slice(0, 10), keys: [] }, linear: t.identifier, ...(await sourcesOf(t)) }, now);
      return moved("product", k.text, k.id, t.identifier, `Now your to-do, still in Linear as ${t.identifier}: ${k.text}. Agents don't pick it up.`);
    }
    const kept = await sourcesOf(t);
    const how = await withdraw(t, `${handle} took this off the team's list to keep as a private to-do.`);
    const k = await keepTodo({ text: t.title, source: { title: `Moved from ${t.identifier}`, at: now.toISOString().slice(0, 10), keys: [] }, ...kept }, now);
    return moved("product", k.text, k.id, null, `Now your private to-do: ${k.text}. ${gone(t, how)}${kept.sources ? ` It keeps ${kept.sources.length === 1 ? "its source" : `its ${kept.sources.length} sources`}, so moving it to the team again brings ${kept.sources.length === 1 ? "it" : "them"} back.` : ""}`);
  }

  // A to-do: private, or in Linear as the PM's commitment.
  return moveTodo(await getTodo(ref));

  async function moveTodo(t: Todo): Promise<Moved> {
    if (t.status !== "open") throw new Error(`"${t.text}" is done. Only open to-dos move.`);
    const from: Place = t.linear ? "todo" : "private";
    if (from === to) throw same(from, t.text);
    if (from === "private") {
      // R15 (SIG-7): the setting is about sending a to-do to Linear as the PM's own; moving it to the team is a product
      // task the PM chose to make, like approving one, so it isn't gated on that setting.
      if (to === "todo") {
        if (!ctx.personal.todosToLinear) throw new Error(OFF);
        // R7 (SIG-7): its words are checked first, like a move to the team.
        const s = await sendCommitment(ctx, await tracker(), t.id, { again: "move it again" });
        return moved(from, t.text, t.id, s.identifier, `Sent to Linear as ${s.identifier}: ${t.text}. Agents don't pick it up.`);
      }
      const k = kind();
      const tr = await tracker();
      // R16: the meetings it came from go with it, so an agent can draft it.
      const c = await todoSources(ctx, t);
      // F14: nothing reaches Linear before its words pass the guard; a title that fails keeps the to-do.
      const g = await guardMove(ctx, t, c, productDescription(handle, t.due, c));
      const made = await tr.createInbox({ title: t.text.slice(0, 200), description: g.description, category: k.kind, size: k.size, sources: c.ids });
      await removeTodo(t.id);
      const shared = await carried(t.id, c, made.identifier, t.text, g.description);
      return moved(from, t.text, null, made.identifier, [`"${t.text}" is now ${made.identifier}, a ${k.kind} task for the team${c.ids.length ? `, with ${c.ids.length === 1 ? "the meeting" : `the ${c.ids.length} meetings`} it came from as its sources` : ""}.`, ...(g.leftOut ? [`PMX left ${g.leftOut} out of it.`] : []), ...keptText(c), await draftable(k.kind, made.identifier, c), ...shared].filter(Boolean).join(" "));
    }
    // In Linear as a commitment.
    const id = await real(t.linear!);
    const issue = await issueFor(id);
    if (to === "private") {
      let how: "queued" | "canceled" = "canceled";
      if (issue) {
        movable(issue);
        how = await withdraw(issue, `${handle} took this back to their private to-dos.`);
      }
      await linkTodo(t.id, null);
      return moved(from, t.text, t.id, null, `Back to your private to-dos: ${t.text}.${issue ? ` ${gone(issue, how)}` : ""}`);
    }
    if (!issue) throw new Error(`${id} isn't in your team's PMX project any more, so there's no task to change. Move it to private first, then to product.`);
    movable(issue);
    const k = kind();
    // R16: PMX's commitment text is replaced, and with it come the meetings the to-do came from.
    const c = isCommitmentText(issue.description ?? "") && !issue.sources.length ? await todoSources(ctx, t) : NONE;
    // F14: a task for the team, which agents draft, is held to the guard, though its words are in Linear as a to-do.
    const g = await guardMove(ctx, t, c, productDescription(handle, t.due, c));
    await toProduct(issue, k, t.due, g.description);
    await removeTodo(t.id);
    const shared = c.receipt ? await carried(t.id, c, issue.identifier, issue.title, g.description) : [];
    const now = c.ids.length ? c : { ...c, ids: issue.sources };
    return moved(from, t.text, null, issue.identifier, [`${issue.identifier} is now a ${k.kind} task for the team: ${t.text}.`, ...keptText(c), await draftable(k.kind, issue.identifier, now), ...shared].filter(Boolean).join(" "));
  }

  /**
   * R16: a moved to-do's sources reach its task's run receipt and, through an evidence pack, any Mac's agent (RUN-5).
   * D2: a to-do with none still notes the move in its run, which keeps that receipt as long as the task needs it.
   */
  async function carried(todoId: string, c: Carried, identifier: string, title: string, description: string): Promise<string[]> {
    await noteMoved(ctx, todoId, c, identifier);
    if (!c.ids.length) return [];
    if (ctx.team.tracker.kind === "none") return [];
    await stageShares(ctx, [{ identifier, title, description, sources: c.ids, follows: null }]);
    return (await shareEvidence(ctx, { say: "answer" }).catch((e: any) => ({ shared: [], notices: [`PMX couldn't share the quotes of ${identifier} with your team: ${e?.message ?? e}.`] }))).notices;
  }

  /** R16: the to-do's meetings the team's rules keep from agents, said once. */
  function keptText(c: Carried): string[] {
    return c.kept && c.ids.length ? [`${c.kept === 1 ? "One of its meetings stays" : `${c.kept} of its meetings stay`} with your to-dos: your team's privacy rules keep ${c.kept === 1 ? "it" : "them"} from agents.`] : [];
  }

  /**
   * R16 (RUN-3): a warning when agents can't draft the task: its kind's drafts must cite sources and it has none they
   * can quote. Says what to do: a kind that needs none, or letting a meeting bring it its sources.
   */
  async function draftable(category: string, identifier: string, c: Pick<Carried, "ids" | "none">): Promise<string> {
    if (c.ids.length) return "";
    const need = await citationNeed(ctx, category).catch(() => ({ min: 0, web: false }));
    if (!need.min || need.web) return "";
    const others = Object.keys(ctx.team.categories).filter((x) => x !== category);
    const free: string[] = [];
    for (const x of others) {
      const n = await citationNeed(ctx, x).catch(() => ({ min: 1, web: false }));
      if (!n.min || n.web) free.push(x);
    }
    const why = c.none ? `it names no sources agents can quote, since ${c.none}` : "it names no sources";
    const kinds = free.length ? `move it back (\`pmx move ${identifier} private\`) and make it ${free.length === 1 ? `a ${free[0]}` : `one of ${free.join(", ")}`}, which can be drafted without them, or ` : "";
    return `Agents can't draft ${identifier} yet: ${why}, and ${citeText(category, need.min)}. To have it drafted, ${kinds}wait for a meeting that raises it: synthesis then suggests it with sources, and approving that gives ${identifier} its sources.`;
  }
}
