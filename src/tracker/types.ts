import type { Size, Status, Task } from "../core/types.js";
import { followState, STATE_FOR, typeOf, type StateType } from "./states.js";

export interface NewTask {
  title: string;
  description: string;
  category: string;
  size: Size;
  sources: string[];
  /** A roadmap theme the PM approved, as a label in the pmx-theme group (EQ-38). */
  theme?: string;
  /**
   * APPROVE-3: created straight in Ready instead of the pool. Only the PM's own Start now on a proposal sets it, for
   * exactly the text they approved; synthesis never does (SIG-4, SEC-1).
   */
  ready?: boolean;
}

/** A team meeting lodged in the tracker's meeting ledger (MEET-2). Not a task: pull, the brain and the board skip it. */
export interface MeetingEntry {
  id: string;
  identifier: string;
  url: string;
  title: string;
  /** The meeting identity hashes (`pmx:meeting` lines). */
  keys: string[];
  status: "running" | "done" | "blocked";
  /** Tasks the meeting produced (`pmx:task` lines). */
  tasks: string[];
  agent: string | null;
}

/**
 * What PMX lodges for a processed meeting (MEET-2, PRIV-6): its identity hashes, its date and who processed it. Never
 * its title, attendees or source, because the tracker is shared and a meeting's title can be private on its own.
 */
export interface NewMeeting {
  keys: string[];
  at: string;
  agent: string;
}

/**
 * The tracker as the engine sees it (one adapter per tracker, CANVAS-2).
 * Every write is limited to the PMX project, enforced inside the adapter (SEC-4).
 */
export interface Tracker {
  readonly kind: string;
  /**
   * When what `list` returns was read from the tracker, for a tracker that reads a copy (the Claude relay's snapshot).
   * Absent: it reads the tracker itself, so now. RUN-5 removes a dropped task's evidence pack only once this is newer.
   */
  syncedAt?(): Promise<string | null>;
  list(o?: { status?: Status[] }): Promise<Task[]>;
  get(id: string): Promise<Task>;
  /**
   * Synthesis can only create tasks in `inbox` (SIG-4, SEC-1). A task is created in `ready` only when the PM approved
   * it with Start now (`ready`, APPROVE-3).
   */
  createInbox(t: NewTask): Promise<Task>;
  /**
   * Sets PMX's status label and, in the same save, moves the issue to the matching workflow state (TASK-7), marking it
   * as one PMX keeps in step. Blocked leaves the state where it is.
   */
  setStatus(id: string, status: Status): Promise<void>;
  /**
   * The agent that took the task (pmx-agent label). With a handle, the issue is also assigned to the tracker user this
   * Mac acts as (TASK-9): through the relay, the PM's own Linear connector ("me"); with a key, the key's own user.
   * Clearing it unassigns, but only when that user is still the assignee: a person's own assignment stays.
   */
  setAgent(id: string, agent: string | null): Promise<void>;
  /**
   * TASK-8: follows a person's move in the tracker. Only while the label still says `from` and the state is still of
   * type `type`, it rewrites the label to `to`, records `type` as the state PMX knows, and adds `comment`; otherwise
   * nothing (another Mac followed it first).
   */
  follow(id: string, f: { from: Status; to: Status; type: string; comment: string }): Promise<void>;
  /**
   * TASK-8: the label decides. Only while the state type and the recorded one are still as PMX read them (`seen`), it
   * moves the state to the one for `status` and records it. No comment. False when there was nothing it could do.
   */
  align(id: string, status: Status, seen: { type: string; recorded: string | null }): Promise<boolean>;
  setSize(id: string, size: Size): Promise<void>;
  /** The kind of work (pmx-category label). Only a PM moving work between their to-dos and the team's tasks calls it. */
  setCategory(id: string, category: string): Promise<void>;
  /** 1 urgent … 4 low, 0 none (Linear's scale). */
  setPriority(id: string, priority: number): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  /** A reviewer's redo note, appended to the description as a `pmx:note` line (REV-2). */
  addNote(id: string, note: string): Promise<void>;
  /** The meeting ledger (MEET-2). `list()` never returns these. */
  listMeetings(): Promise<MeetingEntry[]>;
  lodgeMeeting(m: NewMeeting): Promise<MeetingEntry>;
  /** Marks a lodged meeting done (completed in the tracker) or blocked, with the tasks it produced. */
  finishMeeting(id: string, o: { status: "done" | "blocked"; tasks: string[]; note: string }): Promise<void>;
  /**
   * Replaces an issue's title or description, and with `cancel` moves it to canceled (TIDY-1). Only `pmx linear tidy`,
   * `pmx linear withdraw`, `pmx move` and dropping a task that stopped after failed runs (PULL-12) call it, to take
   * back or reword what PMX wrote. Never deletes.
   */
  rewrite(id: string, o: { title?: string; description?: string; cancel?: boolean }): Promise<void>;
}

/** An opaque title: the meeting's first identity hash, which only the PM's own Mac can match to a meeting. */
export const meetingTitle = (m: Pick<NewMeeting, "keys">) => `Processed meeting ${m.keys[0]?.slice(0, 9) ?? "m?"}`;

export const meetingDescription = (m: NewMeeting) =>
  [`PMX processed a meeting on ${m.at} and marks it here so no teammate processes it twice (MEET-2). Not a task, and it holds no meeting details.`, ``, `Processed by: ${m.agent}`, ``, ...m.keys.map((k) => `pmx:meeting ${k}`)].join("\n");

/** An in-memory tracker for tests, demos and teams that haven't connected Linear yet. */
/**
 * A task's status as PMX should see it, from its label and its workflow state (TASK-8): the shared rules in
 * states.ts, so the memory tracker, the Linear API and the Claude relay agree.
 */
export function withWorkflow<T extends Pick<Task, "status">>(t: T, w: { type: string; name: string; recorded: string | null } | null | undefined): T & { workflow?: Task["workflow"] } {
  if (!w?.type) return t;
  const f = followState(t.status, w.type, w.recorded);
  const workflow = { type: w.type, name: w.name, recorded: w.recorded, label: t.status, ...(f.kind === "leave" ? { held: f.why } : f.kind === "drop" ? { held: "canceled in Linear" } : {}), ...(f.kind === "align" ? { align: true } : {}) };
  return { ...t, ...(f.kind === "follow" ? { status: f.to } : {}), workflow };
}

/** The workflow state names a memory tracker uses for each type, like a new Linear team's. */
const STATE_NAMES: Record<StateType, string> = { triage: "Triage", backlog: "Backlog", unstarted: "Todo", started: "In Progress", completed: "Done", canceled: "Canceled" };

/**
 * An in-memory tracker for tests, demos and teams that haven't connected Linear yet. A task created here, or seeded
 * with a `workflow`, also has a workflow state that follows its status like Linear's (TASK-7), with the type PMX
 * recorded; `workflow` holds both, so a test can move the state as a person would, or the label as an older Mac would. `assignees` is who each task is assigned to ("me": the Mac's own user).
 */
export function memoryTracker(seed: Task[] = []): Tracker & { tasks: Map<string, Task>; comments: Map<string, string[]>; meetings: Map<string, MeetingEntry>; workflow: Map<string, { type: string; name: string; recorded: string | null }>; assignees: Map<string, string | null> } {
  const tasks = new Map(seed.map((t) => { const { workflow: _w, ...rest } = t; return [t.id, { ...rest } as Task]; }));
  const workflow = new Map(seed.filter((t) => t.workflow).map((t) => [t.id, { type: t.workflow!.type, name: t.workflow!.name, recorded: t.workflow!.recorded }]));
  const assignees = new Map<string, string | null>();
  const meetings = new Map<string, MeetingEntry>();
  const comments = new Map<string, string[]>();
  let n = seed.length;
  const must = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new Error(`No task ${id} in the PMX project.`);
    return t;
  };
  const view = (t: Task): Task => withWorkflow({ ...t }, workflow.get(t.id));
  const moveTo = (id: string, status: Status) => {
    const target = STATE_FOR[status];
    const w = workflow.get(id);
    if (!w || !target) return;
    const type = typeOf(target);
    const name = target === "review" ? "In Review" : STATE_NAMES[type];
    if (w.type !== type || (target === "review" && w.name !== name)) Object.assign(w, { type, name });
    w.recorded = w.type;
  };
  return {
    kind: "memory",
    tasks,
    comments,
    meetings,
    workflow,
    assignees,
    async list(o) {
      return [...tasks.values()].map(view).filter((t) => t.workflow?.type !== "canceled").filter((t) => !o?.status || (t.status !== null && o.status.includes(t.status)));
    },
    async get(id) {
      const t = view(must(id));
      return { ...t, prUrl: [...(comments.get(id) ?? [])].reverse().map((c) => c.match(/^pmx:pr (\S+)/m)?.[1]).find(Boolean) ?? t.prUrl };
    },
    async createInbox(t) {
      const id = `task-${++n}`;
      const task: Task = {
        id, identifier: `PMX-${n}`, title: t.title, description: t.description, url: `memory://${id}`,
        category: t.category, size: t.size, status: t.ready ? "ready" : "inbox", priority: 0, agent: null, sources: t.sources, prUrl: null,
        createdAt: new Date().toISOString(), ...(t.theme ? { theme: t.theme } : {}),
      };
      tasks.set(id, task);
      workflow.set(id, { type: "backlog", name: STATE_NAMES.backlog, recorded: "backlog" });
      moveTo(id, task.status!);
      return view(task);
    },
    async setStatus(id, status) { must(id).status = status; moveTo(id, status); },
    async setAgent(id, agent) {
      must(id).agent = agent;
      if (agent) assignees.set(id, "me");
      else if (assignees.get(id) === "me") assignees.set(id, null);
    },
    async follow(id, f) {
      const t = must(id);
      const w = workflow.get(id);
      if (t.status !== f.from || w?.type !== f.type) return;
      t.status = f.to;
      w.recorded = w.type;
      comments.set(id, [...(comments.get(id) ?? []), f.comment]);
    },
    async align(id, status, seen) {
      const w = workflow.get(id);
      if (!w || w.type !== seen.type || w.recorded !== seen.recorded) return false;
      moveTo(id, status);
      w.recorded = w.type;
      return true;
    },
    async setSize(id, size) { must(id).size = size; },
    async setCategory(id, category) { must(id).category = category; },
    async setPriority(id, priority) { must(id).priority = priority; },
    async comment(id, body) {
      must(id);
      comments.set(id, [...(comments.get(id) ?? []), body]);
    },
    async addNote(id, note) {
      const t = must(id);
      t.description = `${t.description}\npmx:note ${note.replace(/\s+/g, " ").trim()}`;
    },
    async listMeetings() {
      return [...meetings.values()].map((m) => ({ ...m, keys: [...m.keys], tasks: [...m.tasks] }));
    },
    async lodgeMeeting(m) {
      const id = `meeting-${++n}`;
      const e: MeetingEntry = { id, identifier: `PMX-${n}`, url: `memory://${id}`, title: meetingTitle(m), keys: [...m.keys], status: "running", tasks: [], agent: m.agent };
      meetings.set(id, e);
      return { ...e };
    },
    async rewrite(id, o) {
      const t = tasks.get(id);
      const m = meetings.get(id);
      if (!t && !m) throw new Error(`No task ${id} in the PMX project.`);
      if (o.cancel) { tasks.delete(id); meetings.delete(id); return; }
      if (t) Object.assign(t, o.title ? { title: o.title } : {}, o.description !== undefined ? { description: o.description } : {});
      if (m && o.title) m.title = o.title;
    },
    async finishMeeting(id, o) {
      const e = meetings.get(id);
      if (!e) throw new Error(`No meeting ${id} in the PMX project.`);
      e.status = o.status;
      e.tasks = [...new Set([...e.tasks, ...o.tasks])];
      comments.set(id, [...(comments.get(id) ?? []), o.note]);
    },
  };
}
