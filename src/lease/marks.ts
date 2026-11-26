import type { Ctx } from "../core/context.js";
import type { Git } from "../core/git.js";
import { TASK_STATE_REFS } from "../core/paths.js";
import type { RunLogEntry } from "../core/runlog.js";
import { readOutbox } from "../tracker/relay.js";
import type { Tracker } from "../tracker/types.js";

/**
 * Task marks (PULL-14). A claim (src/lease/git-ref.ts) lasts only while an agent runs, and each Mac reads Linear from
 * its own copy, refreshed by its own hourly Claude sync. So a task one Mac drafted could still look Ready on a Mac whose
 * copy is older, and be drafted again. A mark records a task's last PMX step in the team repo, where every Mac reads it
 * at once: a draft waiting for review, accepted (done), rejected, dropped, or back to Ready (a redo or Try again).
 *
 * One mark per task, at `refs/pmx/task-state/<identifier>`, the way PMX keeps claims and evidence packs: a commit with
 * an empty tree and the mark as its message, never on a branch and never reviewed. A new mark builds on the one there,
 * so a push is a fast-forward and never needs force; a refused push fetches and builds again. Without a remote the refs
 * are local (a team of one).
 *
 * A mark counts only while this Mac's copy of Linear can't show the step yet: until the tracker had it (`landed`: at
 * once with a Linear key, or once the writing Mac's next Claude sync applied it) and this Mac's copy was read after
 * that. Then the copy decides, so a person's later move in Linear is followed. Any Mac removes a mark after 7 days.
 */
export type MarkState = "review" | "done" | "blocked" | "dropped" | "ready";
const STATES = new Set<string>(["review", "done", "blocked", "dropped", "ready"]);

export interface TaskMark {
  v: 1;
  /** The task's tracker identifier, like PMX-12. */
  task: string;
  state: MarkState;
  /** When the step happened (ISO, the writing Mac's clock). */
  at: string;
  /** The agent that took the step, like ana@m1. */
  by: string;
  machine: string | null;
  /** When the tracker had the step for every Mac's sync to read: at once with a Linear key, else after the writer's sync. */
  landed: string | null;
  /** RUN-5: when the task's evidence pack was removed. No Mac writes it again (backfill), and any Mac removes one that's back. */
  packRemovedAt?: string;
}

export interface StoredMark extends TaskMark {
  /** The mark's commit. */
  token: string;
}

export interface MarkStore {
  /** Every task's mark, fetched from the team repo now. */
  list(): Promise<Map<string, StoredMark>>;
  /** One task's mark, fetched from the team repo now. */
  read(identifier: string): Promise<StoredMark | null>;
  /** Writes the mark `f` makes from the current one (null: no change). Returns the mark there afterwards. */
  update(identifier: string, f: (cur: TaskMark | null) => TaskMark | null): Promise<TaskMark | null>;
  /** Removes a mark, only while it is still `token`. */
  remove(identifier: string, token: string): Promise<boolean>;
}

const MIRROR = "refs/pmx/remote-task-state";
const ZERO = "0000000000000000000000000000000000000000";
const TASK = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const IDENT = ["-c", "user.name=pmx", "-c", "user.email=pmx@localhost"];
/** A mark is kept this long: past a weekend and a holiday of hourly syncs, every Mac's copy of Linear has caught up. */
export const MARK_KEEP_MS = 7 * 86400000;
/** Clocks on two Macs can differ: a copy of Linear counts as read after a step only with this much to spare. */
export const MARK_SKEW_MS = 10 * 60000;

const firstLine = (s: string) => s.trim().split("\n").map((l) => l.replace(/^(fatal|error|remote):\s*/i, "").trim()).find(Boolean)?.slice(0, 200) ?? "git failed";
const iso = (s: unknown) => typeof s === "string" && Number.isFinite(Date.parse(s));

/** A mark as data: anyone with the team repo can write these refs, so what comes back is checked. */
function parse(text: string, identifier: string): TaskMark | null {
  try {
    const m = JSON.parse(text);
    if (!m || m.v !== 1 || m.task !== identifier || !STATES.has(m.state) || !iso(m.at) || typeof m.by !== "string" || !m.by || m.by.length > 80) return null;
    return {
      v: 1, task: identifier, state: m.state, at: m.at, by: m.by, machine: typeof m.machine === "string" ? m.machine.slice(0, 80) : null,
      landed: iso(m.landed) ? m.landed : null, ...(iso(m.packRemovedAt) ? { packRemovedAt: m.packRemovedAt } : {}),
    };
  } catch {
    return null;
  }
}

const serialize = (m: TaskMark) => JSON.stringify({
  v: 1, task: m.task, state: m.state, at: m.at, by: m.by, machine: m.machine, landed: m.landed, ...(m.packRemovedAt ? { packRemovedAt: m.packRemovedAt } : {}),
});

export function markStore(git: Git): MarkStore {
  let remoteP: Promise<boolean> | null = null;
  const remote = () => (remoteP ??= git.hasRemote());
  const at = (base: string, id: string) => `${base}/${id}`;

  /** The commit at `ref` and its mark (null when it isn't one PMX can read), or null when there's no ref. */
  async function tip(ref: string): Promise<{ token: string; mark: TaskMark | null } | null> {
    const r = await git.raw(["for-each-ref", "--format=%(objectname)%09%(contents:subject)", ref]);
    const line = r.code === 0 ? r.stdout.trim().split("\n")[0] : "";
    if (!line) return null;
    const [token, ...rest] = line.split("\t");
    return { token: token!, mark: parse(rest.join("\t"), ref.slice(ref.lastIndexOf("/") + 1)) };
  }

  /** Where one task's mark is read from, fetched now: a mirror of the remote's, else the local ref. */
  async function fetchOne(id: string): Promise<string> {
    if (!(await remote())) return at(TASK_STATE_REFS, id);
    const f = await git.raw(["fetch", "--quiet", "origin", `+${at(TASK_STATE_REFS, id)}:${at(MIRROR, id)}`]);
    if (f.code !== 0) {
      if (!/couldn't find remote ref|no such ref|not our ref/i.test(f.stderr)) throw new Error(`it couldn't reach your team's repo (${firstLine(f.stderr)})`);
      await git.raw(["update-ref", "-d", at(MIRROR, id)]);
    }
    return at(MIRROR, id);
  }

  return {
    async list() {
      let base = TASK_STATE_REFS;
      if (await remote()) {
        const f = await git.raw(["fetch", "--quiet", "--prune", "origin", `+${TASK_STATE_REFS}/*:${MIRROR}/*`]);
        if (f.code !== 0) throw new Error(`it couldn't reach your team's repo (${firstLine(f.stderr)})`);
        base = MIRROR;
      }
      const out = new Map<string, StoredMark>();
      const lines = (await git.ok(["for-each-ref", "--format=%(refname:lstrip=3)%09%(objectname)%09%(contents:subject)", base])).split("\n").filter(Boolean);
      for (const l of lines) {
        const [id, token, ...rest] = l.split("\t");
        if (!id || !TASK.test(id)) continue;
        const m = parse(rest.join("\t"), id);
        if (m) out.set(id, { ...m, token: token! });
      }
      return out;
    },
    async read(identifier) {
      if (!TASK.test(identifier)) return null;
      const t = await tip(await fetchOne(identifier));
      return t?.mark ? { ...t.mark, token: t.token } : null;
    },
    async update(identifier, f) {
      if (!TASK.test(identifier)) return null;
      const tree = await git.ok(["mktree"], { input: "" });
      for (let attempt = 0; ; attempt++) {
        const cur = await tip(await fetchOne(identifier));
        const next = f(cur?.mark ?? null);
        if (!next) return cur?.mark ?? null;
        const sha = await git.ok([...IDENT, "commit-tree", tree, ...(cur ? ["-p", cur.token] : []), "-m", serialize({ ...next, task: identifier })]);
        if (await remote()) {
          const push = await git.raw(["push", "--quiet", "--porcelain", "origin", `${sha}:${at(TASK_STATE_REFS, identifier)}`]);
          if (push.code === 0) { await git.raw(["update-ref", at(MIRROR, identifier), sha]); return next; }
          if (!/rejected|non-fast-forward|fetch first|stale info|already exists/i.test(`${push.stdout}\n${push.stderr}`) || attempt >= 4) throw new Error(`your team's repo didn't take it (${firstLine(push.stderr || push.stdout)})`);
          continue;
        }
        if ((await git.raw(["update-ref", at(TASK_STATE_REFS, identifier), sha, cur?.token ?? ZERO])).code === 0) return next;
        if (attempt >= 4) throw new Error("its record in the team repo kept changing");
      }
    },
    async remove(identifier, token) {
      if (!TASK.test(identifier)) return false;
      const ref = at(TASK_STATE_REFS, identifier);
      if (await remote()) {
        const r = await git.raw(["push", "--quiet", `--force-with-lease=${ref}:${token}`, "origin", `:${ref}`]);
        await git.raw(["update-ref", "-d", at(MIRROR, identifier)]);
        return r.code === 0;
      }
      return (await git.raw(["update-ref", "-d", ref, token])).code === 0;
    },
  };
}

/** What this Mac knows about its copy of Linear: when it was read (`asOf`; null when it reads the tracker itself) and now. */
export interface Look {
  asOf: number | null;
  now: Date;
  agent: string;
}

/** A copy of Linear read this long after a step can show it; one that reads the tracker itself always can. */
const shows = (look: Look, at: number) => look.asOf === null || look.asOf > at + MARK_SKEW_MS;

const DID: Record<Exclude<MarkState, "ready">, string> = { review: "drafted it", done: "marked it done", blocked: "rejected its draft", dropped: "dropped it" };

/** "another Mac (ana@m1) drafted it at 06:58; waiting for review", in this Mac's time. */
export function takenText(state: Exclude<MarkState, "ready">, by: string, at: string, look: Pick<Look, "agent" | "now">): string {
  const d = new Date(at);
  const hm = d.toTimeString().slice(0, 5);
  const when = d.toDateString() === look.now.toDateString() ? `at ${hm}` : `on ${d.toDateString().slice(4, 10)} at ${hm}`;
  return `${by === look.agent ? "this Mac" : `another Mac (${by})`} ${DID[state]} ${when}${state === "review" ? "; waiting for review" : ""}`;
}

export const expired = (m: Pick<TaskMark, "at">, now: Date) => !(now.getTime() - Date.parse(m.at) <= MARK_KEEP_MS);

/** Why a mark keeps this Mac from drafting a task its copy of Linear shows as Ready, or null when the copy decides. */
export function markBlocks(m: TaskMark, look: Look): string | null {
  if (m.state === "ready" || expired(m, look.now)) return null;
  if (m.landed && shows(look, Date.parse(m.landed))) return null;
  return takenText(m.state, m.by, m.at, look);
}

/** A task's last step in the team's run log: a draft, a verdict, a release or a drop. */
function lastStep(runs: readonly RunLogEntry[], identifier: string): { state: MarkState; ts: string; agent: string } | null {
  let last: { state: MarkState; ts: string; agent: string } | null = null;
  for (const e of runs) {
    if (!("taskId" in e) || e.taskId !== identifier) continue;
    const state: MarkState | null = e.type === "run" ? (e.outcome === "ok" ? "review" : "ready")
      : e.type === "verdict" ? (e.verdict === "accepted" ? "done" : e.verdict === "rejected" ? "blocked" : "ready")
      : e.type === "release" ? "ready" : e.type === "drop" ? "dropped" : null;
    if (state && (!last || e.ts >= last.ts)) last = { state, ts: e.ts, agent: e.agent };
  }
  return last;
}

/**
 * PULL-14: why this Mac mustn't draft a task its copy of Linear shows as Ready, or null. The task's mark decides while
 * it's kept; without one (a teammate's Mac on an older PMX), the team's run log: a draft, accept, reject or drop newer
 * than this Mac's copy. A Mac that reads the tracker itself sees every step there already, so only a mark applies.
 */
export function taskTaken(identifier: string, mark: TaskMark | null | undefined, runs: readonly RunLogEntry[], look: Look): string | null {
  if (mark && !expired(mark, look.now)) return markBlocks(mark, look);
  if (look.asOf === null) return null;
  const s = lastStep(runs, identifier);
  if (!s || s.state === "ready" || expired({ at: s.ts }, look.now) || shows(look, Date.parse(s.ts))) return null;
  return takenText(s.state, s.agent, s.ts, look);
}

/** What this Mac's tracker says about its own copy: when it was read, or null when it reads the tracker itself. */
export async function lookAt(ctx: Pick<Ctx, "now" | "agent">, tracker: Pick<Tracker, "syncedAt">): Promise<Look> {
  const synced = tracker.syncedAt ? await tracker.syncedAt().catch(() => null) : null;
  // A copy that can't say when it was read is as old as can be.
  return { asOf: tracker.syncedAt ? (synced ? Date.parse(synced) : 0) : null, now: ctx.now(), agent: ctx.agent };
}

const SAID: Record<MarkState, string> = {
  review: "has a draft waiting for review", done: "is done", blocked: "was rejected", dropped: "was dropped", ready: "is back in Ready",
};

/**
 * Records a task's new PMX step in the team repo (PULL-14), keeping its evidence pack's tombstone. With a tracker PMX
 * reads itself the step has landed; through the Claude relay it lands at this Mac's next sync. A failure is said, never
 * thrown: the tracker has the step, and only a Mac behind on its Linear sync could miss it.
 */
export async function markTask(ctx: Pick<Ctx, "repo" | "agent" | "personal" | "now" | "out">, tracker: Pick<Tracker, "syncedAt">, identifier: string, state: MarkState): Promise<boolean> {
  if (!TASK.test(identifier)) return false;
  const at = ctx.now().toISOString();
  try {
    await markStore(ctx.repo).update(identifier, (cur) => ({
      v: 1, task: identifier, state, at, by: ctx.agent, machine: ctx.personal.machineId, landed: tracker.syncedAt ? null : at,
      ...(cur?.packRemovedAt ? { packRemovedAt: cur.packRemovedAt } : {}),
    }));
    return true;
  } catch (e: any) {
    ctx.out.warn(`PMX couldn't note in your team's repo that ${identifier} ${SAID[state]}: ${String(e?.message ?? e)}. A teammate's Mac that hasn't synced Linear since may not know yet.`);
    return false;
  }
}

/**
 * Keeps the marks current (PULL-14), from the background run and after each Claude sync: this Mac's own steps that its
 * sync has now applied in Linear are marked landed (none of its changes for the task wait in its outbox, and its copy
 * was read after the step), and any mark older than 7 days is removed. Returns how many it changed.
 */
export async function tendMarks(ctx: Pick<Ctx, "repo" | "personal" | "now">, tracker: Pick<Tracker, "kind" | "syncedAt">): Promise<number> {
  const store = markStore(ctx.repo);
  const marks = await store.list();
  if (!marks.size) return 0;
  const now = ctx.now();
  const synced = tracker.syncedAt ? await tracker.syncedAt().catch(() => null) : null;
  const waiting = tracker.kind === "claude-relay" ? new Set((await readOutbox()).ops.map((o) => ("target" in o ? o.target : null))) : new Set<string | null>();
  let n = 0;
  for (const m of marks.values()) {
    if (expired(m, now)) { if (await store.remove(m.task, m.token)) n++; continue; }
    if (m.landed || m.state === "ready" || m.machine !== ctx.personal.machineId) continue;
    const landed = !tracker.syncedAt ? m.at : synced && Date.parse(synced) > Date.parse(m.at) && !waiting.has(m.task) ? synced : null;
    if (!landed) continue;
    await store.update(m.task, (cur) => (cur && cur.at === m.at && cur.state === m.state && !cur.landed ? { ...cur, landed } : null));
    n++;
  }
  return n;
}
