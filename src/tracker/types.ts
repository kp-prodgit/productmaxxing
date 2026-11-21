import type { Size, Status, Task } from "../core/types.js";

export interface NewTask {
  title: string;
  description: string;
  category: string;
  size: Size;
  sources: string[];
  /** A roadmap theme the PM approved, as a label in the pmx-theme group (EQ-38). */
  theme?: string;
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
  list(o?: { status?: Status[] }): Promise<Task[]>;
  get(id: string): Promise<Task>;
  /** Synthesis can only create tasks in `inbox` (SIG-4, SEC-1). */
  createInbox(t: NewTask): Promise<Task>;
  setStatus(id: string, status: Status): Promise<void>;
  setAgent(id: string, agent: string | null): Promise<void>;
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
   * `pmx linear withdraw` and `pmx move` call it, to take back or reword what PMX wrote. Never deletes.
   */
  rewrite(id: string, o: { title?: string; description?: string; cancel?: boolean }): Promise<void>;
}

/** An opaque title: the meeting's first identity hash, which only the PM's own Mac can match to a meeting. */
export const meetingTitle = (m: Pick<NewMeeting, "keys">) => `Processed meeting ${m.keys[0]?.slice(0, 9) ?? "m?"}`;

export const meetingDescription = (m: NewMeeting) =>
  [`PMX processed a meeting on ${m.at} and marks it here so no teammate processes it twice (MEET-2). Not a task, and it holds no meeting details.`, ``, `Processed by: ${m.agent}`, ``, ...m.keys.map((k) => `pmx:meeting ${k}`)].join("\n");

/** An in-memory tracker for tests, demos and teams that haven't connected Linear yet. */
export function memoryTracker(seed: Task[] = []): Tracker & { tasks: Map<string, Task>; comments: Map<string, string[]>; meetings: Map<string, MeetingEntry> } {
  const tasks = new Map(seed.map((t) => [t.id, { ...t }]));
  const meetings = new Map<string, MeetingEntry>();
  const comments = new Map<string, string[]>();
  let n = seed.length;
  const must = (id: string) => {
    const t = tasks.get(id);
    if (!t) throw new Error(`No task ${id} in the PMX project.`);
    return t;
  };
  return {
    kind: "memory",
    tasks,
    comments,
    meetings,
    async list(o) {
      return [...tasks.values()].filter((t) => !o?.status || (t.status !== null && o.status.includes(t.status))).map((t) => ({ ...t }));
    },
    async get(id) {
      const t = must(id);
      return { ...t, prUrl: [...(comments.get(id) ?? [])].reverse().map((c) => c.match(/^pmx:pr (\S+)/m)?.[1]).find(Boolean) ?? t.prUrl };
    },
    async createInbox(t) {
      const id = `task-${++n}`;
      const task: Task = {
        id, identifier: `PMX-${n}`, title: t.title, description: t.description, url: `memory://${id}`,
        category: t.category, size: t.size, status: "inbox", priority: 0, agent: null, sources: t.sources, prUrl: null,
        createdAt: new Date().toISOString(), ...(t.theme ? { theme: t.theme } : {}),
      };
      tasks.set(id, task);
      return { ...task };
    },
    async setStatus(id, status) { must(id).status = status; },
    async setAgent(id, agent) { must(id).agent = agent; },
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
      if (!t && !m) throw new Error(`No issue ${id} in the PMX project.`);
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
