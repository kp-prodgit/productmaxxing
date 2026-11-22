import type { Ctx } from "../core/context.js";
import type { Services } from "../core/services.js";
import { SIZES, type Size, type Task } from "../core/types.js";
import { approveProposals, markKept, readProposals, takeProposal } from "../synth/proposals.js";
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

const productDescription = (handle: string, due: string | null) =>
  [`A task ${handle} moved here from their own to-dos${due ? `, due ${due}` : ""}.`, "", "PMX sent only these words: no meeting title, transcript, attendees or quotes."].join("\n");
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
  /** Takes an issue back out of Linear: a comment for the team, then canceled. */
  const withdraw = async (t: Task, why: string) => {
    const tr = await tracker();
    await tr.comment(t.id, why);
    await tr.rewrite(t.id, { cancel: true });
  };
  /** A Linear task becomes the PM's commitment: agents stop seeing it as theirs. */
  const toCommitment = async (t: Task) => {
    const tr = await tracker();
    await tr.setCategory(t.id, COMMITMENT);
    if (t.status === "ready") await tr.setStatus(t.id, "inbox");
    await tr.comment(t.id, `${handle} took this as their own to-do. Agents don't pick it up.`);
  };
  /** A commitment becomes a task for the team, of a kind agents take. */
  const toProduct = async (t: Task, k: { kind: string; size: Size }, due: string | null) => {
    const tr = await tracker();
    await tr.setCategory(t.id, k.kind);
    if (t.size !== k.size) await tr.setSize(t.id, k.size);
    if (isCommitmentText(t.description ?? "")) await tr.rewrite(t.id, { description: productDescription(handle, due) });
    await tr.comment(t.id, `${handle} made this a ${k.kind} task for the team.`);
  };
  const moved = (from: Place, text: string, todo: string | null, identifier: string | null, message: string): Moved => ({ from, to, text, todo, identifier, message });

  // A proposal: a product task waiting for the PM's approval. To-do IDs are hex, so never start with "p".
  if (PROPOSAL.test(ref)) {
    if (!(await readProposals()).some((p) => p.id === ref.toLowerCase())) throw new Error(`Task ${ref} isn't waiting any more. \`pmx proposals\` lists the ones that are.`);
    if (to === "product") {
      const r = await approveProposals(ctx, await svc(), [ref]);
      const p = r.posted[0];
      if (!p) throw new Error(r.duplicates[0] ? `Not sent: ${r.duplicates[0]}.` : "That task is no longer waiting.");
      return moved("product", p.title, null, p.identifier, `Approved: "${p.title}" is ${p.identifier}, a product task for the team.`);
    }
    if (to === "todo" && !ctx.personal.todosToLinear) throw new Error(OFF);
    if (to === "todo") await tracker();
    const p = await takeProposal(ref);
    if (!p) throw new Error("That task is no longer waiting.");
    const f = p.from[0];
    const t = await keepTodo({ text: p.title, why: f?.why ?? "", source: f ? { title: f.title, at: f.at.slice(0, 10), keys: [] } : undefined, receiptId: p.receipt }, now);
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
        await withdraw(t, `${handle} took this back to their private to-dos.`);
        const k = await keepTodo({ text: t.title }, now);
        return moved("todo", k.text, k.id, null, `Back to your private to-dos: ${k.text}. ${t.identifier} is canceled in Linear.`);
      }
      const k = kind();
      await toProduct(t, k, null);
      return moved("todo", t.title, null, t.identifier, `${t.identifier} is now a ${k.kind} task for the team: ${t.title}.`);
    }
    if (to === "product") throw same("product", t.title);
    movable(t);
    if (to === "todo") {
      await toCommitment(t);
      const k = await keepTodo({ text: t.title, source: { title: `Moved from ${t.identifier}`, at: now.toISOString().slice(0, 10), keys: [] }, linear: t.identifier }, now);
      return moved("product", k.text, k.id, t.identifier, `Now your to-do, still in Linear as ${t.identifier}: ${k.text}. Agents don't pick it up.`);
    }
    await withdraw(t, `${handle} took this off the team's list to keep as a private to-do.`);
    const k = await keepTodo({ text: t.title, source: { title: `Moved from ${t.identifier}`, at: now.toISOString().slice(0, 10), keys: [] } }, now);
    return moved("product", k.text, k.id, null, `Now your private to-do: ${k.text}. ${t.identifier} is canceled in Linear.`);
  }

  // A to-do: private, or in Linear as the PM's commitment.
  return moveTodo(await getTodo(ref));

  async function moveTodo(t: Todo): Promise<Moved> {
    if (t.status !== "open") throw new Error(`"${t.text}" is done. Only open to-dos move.`);
    const from: Place = t.linear ? "todo" : "private";
    if (from === to) throw same(from, t.text);
    if (from === "private") {
      if (!ctx.personal.todosToLinear) throw new Error(OFF);
      if (to === "todo") {
        const s = await sendTodoToLinear(ctx, await tracker(), t.id);
        return moved(from, t.text, t.id, s.identifier, `Sent to Linear as ${s.identifier}: ${t.text}. Agents don't pick it up.`);
      }
      const k = kind();
      const made = await (await tracker()).createInbox({ title: t.text.slice(0, 200), description: productDescription(handle, t.due), category: k.kind, size: k.size, sources: [] });
      await removeTodo(t.id);
      return moved(from, t.text, null, made.identifier, `"${t.text}" is now ${made.identifier}, a ${k.kind} task for the team.`);
    }
    // In Linear as a commitment.
    const id = await real(t.linear!);
    const issue = await issueFor(id);
    if (to === "private") {
      if (issue) {
        movable(issue);
        await withdraw(issue, `${handle} took this back to their private to-dos.`);
      }
      await linkTodo(t.id, null);
      return moved(from, t.text, t.id, null, `Back to your private to-dos: ${t.text}.${issue ? ` ${issue.identifier} is canceled in Linear.` : ""}`);
    }
    if (!issue) throw new Error(`${id} isn't in your team's PMX project any more, so there's no task to change. Move it to private first, then to product.`);
    movable(issue);
    const k = kind();
    await toProduct(issue, k, t.due);
    await removeTodo(t.id);
    return moved(from, t.text, null, issue.identifier, `${issue.identifier} is now a ${k.kind} task for the team: ${t.text}.`);
  }
}
