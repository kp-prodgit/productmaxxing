// LINEAR-2 (0.41.0, Founder 2026-11-27): the direct path's own records. With a personal API key PMX reads and writes
// Linear itself, on every background run. This file holds what that needs on disk: PMX's copy of the project (the same
// file the Claude app's sync writes, so PMX's page reads one place whichever way this Mac reaches Linear), when it was
// last read, and what Linear last refused. Nothing here ever holds the key: that lives in the keychain only (SEC-10).
import { join } from "node:path";
import { linearRef, type TeamConfig } from "../core/config.js";
import { privateDir, readJson, writeJson } from "../core/fsutil.js";
import { notify } from "../core/notify.js";
import { paths } from "../core/paths.js";
import { LINEAR_KEY_REJECTED, LinearError, linearSlowDown, mergeIssues, type IssueCopy, type LinearFailure, type LinearWatch } from "../tracker/linear.js";

const dir = () => join(paths.home(), "linear");
const files = { record: () => join(dir(), "direct.json"), snapshot: () => join(dir(), "snapshot.json") };

/** How long after a rejected key PMX asks Linear again: once per background run, never once per step. */
const KEY_RETRY_MS = 25 * 60000;

export interface DirectProblem {
  kind: LinearFailure;
  /** When this problem began: later answers of the same kind keep it. */
  at: string;
  /** PMX asks Linear nothing before this. Absent for a refusal of one change (forbidden). */
  until?: string | null;
  /** What Linear said, for a refusal of one change. Never a key. */
  detail?: string | null;
  /** Said to the PM once already (a notification, and for a rate limit the run log's line). */
  told?: boolean;
}

/** What PMX remembers about reading Linear itself, beside its copy of the project. */
export interface DirectRecord {
  v: 1;
  /** The project the copy is of, read by PMX itself. Null until its first read. */
  projectId: string | null;
  /** When PMX last read the whole project, and when its last read of any kind started. */
  fullAt: string | null;
  through: string | null;
  /** The last answer Linear gave that wasn't a refusal. */
  okAt: string | null;
  problem: DirectProblem | null;
  /** The Claude app's leftover Linear sync task was said to be safe to remove, once. */
  leftoverTold?: string | null;
}

const EMPTY: DirectRecord = { v: 1, projectId: null, fullAt: null, through: null, okAt: null, problem: null };

export async function readDirect(): Promise<DirectRecord> {
  const r = await readJson<DirectRecord>(files.record()).catch(() => null);
  return r && r.v === 1 ? { ...EMPTY, ...r } : { ...EMPTY };
}

export async function saveDirect(r: DirectRecord): Promise<void> {
  await privateDir(dir());
  await writeJson(files.record(), r, 0o600);
}

export async function updateDirect(fn: (r: DirectRecord) => void): Promise<DirectRecord> {
  const r = await readDirect();
  fn(r);
  await saveDirect(r);
  return r;
}

/**
 * PMX's copy of the project on this Mac, kept by its own reads (LINEAR-2). It is the file the Claude app's sync writes
 * too, in the same shape, so the page, the checklist and the flow view read one place. A copy PMX didn't read itself
 * (the Claude app's export, another project's) is never built on: the first direct read replaces it whole.
 */
export function projectCopy(team: TeamConfig): IssueCopy {
  if (team.tracker.kind !== "linear") throw new Error("PMX's copy of Linear needs a Linear tracker in pmx.config.json.");
  const projectId = team.tracker.projectId;
  const read = async () => {
    const snap = await readJson<any>(files.snapshot()).catch(() => null);
    return snap && snap.v === 1 && Array.isArray(snap.issues) && linearRef("project", String(snap.projectId)) === projectId ? snap : null;
  };
  return {
    async load() {
      const r = await readDirect();
      const snap = await read();
      if (!snap || r.projectId !== projectId || !r.fullAt || !r.through) return null;
      return { issues: snap.issues, fullAt: r.fullAt, through: r.through };
    },
    async save(c) {
      await privateDir(dir());
      await writeJson(files.snapshot(), { v: 1, syncedAt: c.through, projectId, issues: c.issues }, 0o600);
      await updateDirect((r) => { r.projectId = projectId; r.fullAt = c.fullAt; r.through = c.through; r.okAt = c.through; });
    },
    async patch(nodes) {
      const r = await readDirect();
      const snap = await read();
      // Only a copy PMX reads itself: one the Claude app exported is that sync's to keep.
      if (!snap || r.projectId !== projectId) return;
      await writeJson(files.snapshot(), { ...snap, issues: mergeIssues(snap.issues, nodes) }, 0o600);
    },
  };
}

/** A problem as PMX says it, wherever it's read: what happened and what to do. */
export function problemWords(p: DirectProblem): string {
  if (p.kind === "key-rejected") return LINEAR_KEY_REJECTED;
  if (p.kind === "rate-limited") return linearSlowDown(new Date(p.until ?? p.at));
  return `This Mac's Linear key can read your team's project but Linear refused a change PMX made with it${p.detail ? ` (${p.detail})` : ""}. PMX needs a key with Read and Write on your team: create one in Linear (Settings → Account → Security & access) and paste it with pmx linear key.`;
}

/**
 * Remembers what Linear refused, so the rest of a run doesn't ask again (LINEAR-2): after a rate-limit answer nothing is
 * asked until the time Linear gave; after a rejected key, nothing for the rest of that background run, and the next run
 * asks once. Any answer that isn't a refusal clears it.
 */
export function linearWatch(now: () => Date): LinearWatch {
  /** Known clean in this process: no file read per request while nothing is wrong. */
  let clean = false;
  return {
    async before() {
      if (clean) return;
      const p = (await readDirect()).problem;
      if (!p) { clean = true; return; }
      const until = Date.parse(p.until ?? "");
      if (p.kind !== "forbidden" && !Number.isNaN(until) && until > now().getTime()) throw new LinearError(problemWords(p), p.kind, new Date(until));
    },
    async failed(e) {
      clean = false;
      await updateDirect((r) => {
        const same = r.problem?.kind === e.failure ? r.problem : null;
        const until = e.failure === "rate-limited" ? (e.retryAt ?? new Date(now().getTime() + 15 * 60000)).toISOString() : e.failure === "key-rejected" ? new Date(now().getTime() + KEY_RETRY_MS).toISOString() : null;
        r.problem = { kind: e.failure, at: same?.at ?? now().toISOString(), until, told: same?.told ?? false, ...(e.failure === "forbidden" ? { detail: e.detail } : {}) };
      });
    },
    async ok({ mutation }) {
      if (clean) return;
      const r = await readDirect();
      // A refused change is cleared by a change Linear takes, not by a read: a read-only key reads fine.
      if (!r.problem || (r.problem.kind === "forbidden" && !mutation)) { clean = !r.problem; return; }
      r.problem = null;
      r.okAt = now().toISOString();
      await saveDirect(r);
      clean = true;
    },
  };
}

/**
 * What the background run says about a Linear refusal, and to whom (LINEAR-2). A key Linear no longer accepts is said
 * in every run's log, plainly, and as one notification; a rate limit is said once, in the log, and then waited out
 * quietly. Null when there is nothing to say (again).
 */
export async function sayLinearProblem(o: { notify?: (title: string, message: string) => Promise<void> } = {}): Promise<string | null> {
  const r = await readDirect();
  const p = r.problem;
  if (!p) return null;
  const first = !p.told;
  if (first) {
    await updateDirect((x) => { if (x.problem) x.problem.told = true; });
    if (p.kind !== "rate-limited") await (o.notify ?? notify)("ProductMaxxing", p.kind === "key-rejected" ? "Linear no longer accepts this Mac's API key, so nothing reaches Linear. Paste a new one: pmx linear key. Or go back to the Claude app's sync: pmx linear key --remove." : "This Mac's Linear key can't make changes in your team's project. PMX needs one with Read and Write: pmx linear key.").catch(() => {});
  }
  if (p.kind === "rate-limited") return first ? problemWords(p) : null;
  return `✘ ${problemWords(p)}`;
}

const ago = (ms: number) => {
  const m = Math.max(0, Math.round(ms / 60000));
  return m < 1 ? "under a minute ago" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)} days ago`;
};

/** A read older than this is said as old. Never a fault by itself: a Mac that slept reads again at its next background run. */
const OLD_MS = 3 * 3600000;

/**
 * For `pmx doctor`, `pmx status`, the checklist and the page: how the direct path is doing, from what PMX recorded.
 * It never asks Linear anything. `waiting`: changes queued for the Claude app's sync from before the key, still to apply.
 */
export async function directHealth(team: TeamConfig, now = new Date(), o: { waiting?: number } = {}): Promise<{ ok: boolean; detail: string; problem: DirectProblem | null }> {
  const r = await readDirect();
  const waiting = o.waiting ? `; ${o.waiting} change(s) queued before the key go to Linear with the next background run` : "";
  if (r.problem && r.problem.kind !== "rate-limited") return { ok: false, detail: `Linear with your API key: ${problemWords(r.problem)}`, problem: r.problem };
  const mine = team.tracker.kind === "linear" && r.projectId === team.tracker.projectId && !!r.through;
  if (!mine) return { ok: true, detail: `Linear with your API key: not read yet on this Mac; the next background run reads your team's project${waiting}`, problem: r.problem };
  const age = now.getTime() - Date.parse(r.through!);
  const slow = r.problem?.kind === "rate-limited" ? `; ${problemWords(r.problem)}` : "";
  // An old copy is the background job's story (asleep, off, or failing), which its own checks tell; here it's a fact.
  if (age > OLD_MS) return { ok: true, detail: `Linear with your API key: last read ${ago(age)}, and again at the next background run${slow}${waiting}`, problem: r.problem };
  return { ok: true, detail: `Linear with your API key: read ${ago(age)}, and again with every background run${slow}${waiting}`, problem: r.problem };
}
