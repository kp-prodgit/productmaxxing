import type { Status } from "../core/types.js";

/**
 * Linear's own workflow follows PMX's status (TASK-7), and PMX follows a person's move in it (TASK-8). The
 * `pmx-status` label stays PMX's own record; the workflow state is what Linear's board, views, cycles and project
 * progress read, so a teammate who never opens PMX sees Ready work in Todo, drafting in In Progress and accepted work
 * in Done.
 */

/** Linear's workflow state types. */
export const STATE_TYPES = ["triage", "backlog", "unstarted", "started", "completed", "canceled"] as const;
export type StateType = (typeof STATE_TYPES)[number];

/** Where PMX puts an issue in the team's workflow: a state type, or `review` (a started state named for review). */
export type StateTarget = "backlog" | "unstarted" | "started" | "review" | "completed" | "canceled";

/**
 * The state each PMX status moves an issue to (TASK-7). A task in the backlog (Later) goes to the team's backlog
 * state, Ready to its first unstarted state (Todo), a claimed or running task to its first started state (In
 * Progress), a draft in review to a started state whose name says review when the team has one, and an accepted task
 * to its first completed state, so Linear sets the completed date. Blocked has no Linear type: the issue stays where
 * it is and only the label says Blocked. A dropped task goes to canceled through `rewrite` (TIDY-1).
 */
export const STATE_FOR: Record<Status, StateTarget | null> = {
  inbox: "backlog", ready: "unstarted", claimed: "started", running: "started", review: "review", done: "completed", blocked: null,
};

export const typeOf = (t: StateTarget): StateType => (t === "review" ? "started" : t);

/** A state type, or null for anything else (an older snapshot, a missing label). */
export const stateType = (v: unknown): StateType | null => ((STATE_TYPES as readonly unknown[]).includes(v) ? (v as StateType) : null);

export interface WorkflowState {
  id?: string;
  name: string;
  type: string;
  position?: number;
}

const byPosition = <S extends WorkflowState>(xs: S[]) => [...xs].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
const isReview = (s: { name?: string | null }) => /review/i.test(s.name ?? "");

/** The team's state for a target: the first of that type by position; for review, a started state named for review first. */
export function pickState<S extends WorkflowState>(states: S[], target: StateTarget): S | null {
  const ofType = byPosition(states.filter((s) => s.type === typeOf(target)));
  if (target === "review") return ofType.find(isReview) ?? ofType[0] ?? null;
  return ofType[0] ?? null;
}

/**
 * Whether an issue already sits where a target would put it, so PMX leaves it there: a state of the same type, or for
 * review, the review state (any started state when the team has none, or when PMX doesn't know the team's states).
 */
export function inTarget(current: { type?: string | null; name?: string | null } | null | undefined, target: StateTarget, states?: WorkflowState[]): boolean {
  if (!current?.type || current.type !== typeOf(target)) return false;
  if (target !== "review") return true;
  const review = states ? pickState(states, "review") : null;
  return review ? isReview(review) ? isReview(current) : true : true;
}

/** Whether a state agrees with what PMX's label says (TASK-8). Blocked agrees with any state still open. */
export function agrees(label: Status, type: StateType): boolean {
  switch (label) {
    case "inbox": return type === "backlog" || type === "triage";
    case "ready": return type === "unstarted";
    case "claimed": case "running": case "review": return type === "started";
    case "done": return type === "completed";
    case "blocked": return type !== "completed" && type !== "canceled";
  }
}

/** What PMX does about an issue's Linear state, given its own label and the state it last recorded (TASK-8). */
export type Follow =
  /** They agree, or PMX can't tell (an older snapshot without states, or no PMX label): the label decides. */
  | { kind: "none" }
  /** A person moved it in Linear and PMX follows: its status becomes `to`, and PMX rewrites its label to match. */
  | { kind: "follow"; to: Status }
  /** The label decides: PMX moves Linear's state to match it (when they disagree) and records where it is. */
  | { kind: "align" }
  /** A person moved it somewhere PMX doesn't follow. PMX keeps its own status, no agent takes it, and it's logged. */
  | { kind: "leave"; why: string }
  /** Canceled in Linear: PMX drops it from the queue. */
  | { kind: "drop" };

/**
 * TASK-8, which side wins when PMX's label and Linear's state disagree. Whenever PMX sets an issue's state it records
 * the state's type on the issue itself (the `pmx-state` label, in the same save), so PMX can tell who changed what:
 *
 *  - The state is still the one PMX recorded, but the label says otherwise: only the label moved. That's an older
 *    PMX Mac or an older team board, which move only the label, so the label wins and PMX moves the state to match.
 *  - The state isn't the one PMX recorded: a person moved it in Linear, after PMX's last write, and the person's later
 *    move wins where PMX can follow it:
 *      - a backlog task (inbox) moved to an unstarted state (Todo): Ready for agents, which is how a teammate makes a
 *        task Ready from Linear's own board;
 *      - a Ready task moved back to backlog (or triage): back in the backlog, so agents don't take it;
 *      - closed (completed) without PMX's review: left alone, never counted as accepted, never drafted; a draft in
 *        review stays in review;
 *      - anything else (started by hand, an in-flight task moved back, a done task reopened): left alone; PMX keeps its
 *        status and no agent starts on it, until PMX's next write of its own;
 *      - a move to a state that agrees with the label: nothing to follow, PMX just records where it is.
 *  - Canceled, whatever the label and the record: dropped. PMX never takes it again.
 *  - No state recorded (an issue from before TASK-7, or one an older Mac created): nothing says who put it there, and
 *    Linear's default state for a new issue could be Todo, so the label decides: PMX moves the state to match it once
 *    and records it. One a person already closed it leaves alone.
 *
 * PMX's own writes move label, state and record together, so they never read as a person's move, and nothing depends
 * on every Mac or the team board running this version.
 */
export function followState(label: Status | null, type: string | null | undefined, recorded: string | null | undefined): Follow {
  const t = stateType(type);
  if (!label || !t) return { kind: "none" };
  if (t === "canceled") return { kind: "drop" };
  const closed = { kind: "leave", why: "closed in Linear without PMX's review, so PMX doesn't count it accepted and no agent takes it" } as const;
  const rec = stateType(recorded);
  if (!rec) return t === "completed" && label !== "done" ? closed : { kind: "align" };
  if (t === rec) return agrees(label, t) ? { kind: "none" } : { kind: "align" };
  if (agrees(label, t)) return { kind: "align" };
  if (label === "inbox" && t === "unstarted") return { kind: "follow", to: "ready" };
  if (label === "ready" && (t === "backlog" || t === "triage")) return { kind: "follow", to: "inbox" };
  if (t === "completed") return closed;
  if (label === "inbox" || label === "ready") return { kind: "leave", why: "started by hand in Linear, so no agent takes it" };
  if (label === "done") return { kind: "leave", why: "reopened in Linear after it was accepted; PMX keeps it done" };
  return { kind: "leave", why: "moved in Linear while an agent has it; the run and its review go on" };
}

/** The one short comment PMX leaves when it follows a person's move (TASK-8). */
export function followComment(to: Status, stateName: string): string {
  const where = stateName ? ` to ${stateName}` : "";
  return to === "ready"
    ? `PMX followed the move${where} in Linear: this task is Ready for agents now.`
    : `PMX followed the move${where} in Linear: this task is back in the backlog, and agents don't take it.`;
}
