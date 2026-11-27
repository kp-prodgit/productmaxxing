import { join } from "node:path";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { notify } from "../core/notify.js";
import { holdRulesKey, screened, screensOut } from "../core/filter.js";
import { privacyRules } from "../digest/gather.js";
import { heldNow } from "./evidence.js";
import { paths } from "../core/paths.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { Services } from "../core/services.js";
import { loadState, updateState } from "../core/state.js";
import type { Task } from "../core/types.js";
import { followsIn } from "../tracker/mentions.js";
import { queuedIdentifiers, readResolved } from "../tracker/relay.js";
import type { Tracker } from "../tracker/types.js";
import { sourceCompanies } from "./comment.js";
import { sourcesHere, swapLists, swapPassages, taskEvidence, type Evidence } from "./evidence.js";
import { evidenceStore, NAME_SWAP, packCompanies, packSources, swappedPack, TASK, type EvidencePack, type EvidenceStore } from "./packs.js";
import { expired, markStore, type TaskMark } from "../lease/marks.js";

/**
 * Sharing an approved task's quotes with the team (RUN-5). Approval stages the task here, on the Mac that suggested it;
 * its pack is written to the team repo as soon as the task has its identifier in the tracker: at once with a Linear key,
 * or after the next Claude sync through the relay (a PENDING-… identifier until then). The pack is worked out at that
 * moment with the same function a run on this Mac uses (taskEvidence), so it holds exactly what this Mac's agent would
 * be shown, under the privacy rules as they are then. The file holds the task's tracker text (what Linear has) and no
 * quote, and stays on this Mac (owner-only).
 */
interface Waiting {
  identifier: string;
  title: string;
  description: string;
  sources: string[];
  at: string;
  /** FOLLOW-1: a follow-up's original task, whose pack may quote the same sources when this Mac has none of them. */
  follows?: string | null;
  /** FOLLOW-1: the follow-up's copy of the original's quotes, kept at the accept, for when the original's pack is gone. */
  quotes?: PackQuotes;
  /** R5: the name swap that copy went through (`keptQuotes`), as a pack's `nameSwap`. */
  quotesSwap?: number;
  /**
   * INPUT-2: an open task that took a later call's sources: its pack is written again with their quotes, and keeps the
   * passages of the sources this Mac no longer has the files of (the pack there has them), and when it was first written.
   */
  keep?: boolean;
  /** The PM was told it failed (once per task). */
  told?: boolean;
}

const file = () => join(paths.staging(), "evidence-share.json");
const read = async (): Promise<Waiting[]> => (await readJson<{ v: 1; tasks: Waiting[] }>(file()))?.tasks ?? [];
const save = async (tasks: Waiting[]) => { await privateDir(paths.staging()); await writeJson(file(), { v: 1, tasks }, 0o600); };

/** A task's identifier waits this long for its first Claude sync, and a failing share is retried for this long. */
const GIVE_UP_MS = 7 * 86400000;
/** A pack outlives a task that's gone from the tracker by at most this much, however stale a Mac's copy of it. */
export const PACK_MAX_MS = 30 * 86400000;
/** Clocks on two Macs can differ: a pack is taken as older than a tracker copy only with this much to spare. */
const SKEW_MS = 10 * 60000;
/** How often a Mac looks for packs whose tasks are done or dropped. */
const TIDY_EVERY_MS = 3 * 3600000;

export const storeFor = (ctx: Pick<Ctx, "repo" | "personal">) => evidenceStore(ctx.repo, { email: `${ctx.personal.handle}@pmx.local` });

/**
 * Stages approved tasks that cite sources, for their packs (RUN-5). A team without a tracker has no tasks to share. A
 * task staged again before its pack was written (INPUT-2: an open task that took a later call's sources) waits with
 * its newer text and sources, and the copy of quotes it had.
 */
export async function stageShares(ctx: Pick<Ctx, "team" | "now">, tasks: { identifier: string; title: string; description: string; sources: string[]; follows?: string | null; quotes?: PackQuotes | null; quotesSwap?: number | null; keep?: boolean }[]): Promise<void> {
  const want = tasks.filter((t) => t.sources.length);
  if (ctx.team.tracker.kind === "none" || !want.length) return;
  await withLock(file(), async () => {
    const all = await read();
    for (const { quotes, quotesSwap, keep, ...t } of want) {
      const was = all.findIndex((w) => w.identifier === t.identifier);
      const w: Waiting = { ...t, follows: t.follows ?? null, ...(quotes?.length ? { quotes, ...(quotesSwap ? { quotesSwap } : {}) } : {}), ...(keep ? { keep } : {}), at: ctx.now().toISOString() };
      if (was < 0) all.push(w);
      else if (keep) {
        const cur = all[was]!;
        all[was] = { ...cur, title: w.title, description: w.description, sources: [...new Set([...cur.sources, ...w.sources])], keep: true };
      }
    }
    await save(all);
  });
}

/** The passages a pack holds per source. */
export type PackQuotes = EvidencePack["sources"];

/**
 * FOLLOW-1, RUN-5: what a follow-up keeps of its original's quotes, staged with its proposal on the accepting Mac. An
 * accept removes the original's pack from the team repo, so a follow-up approved later on a Mac without the original's
 * meetings would have nothing to quote. Only quotes read from the team's pack (`from: "team"`), exactly as the pack had
 * them: the Mac that suggested the task quotes its own files when the follow-up is approved, under its privacy rules
 * as they are then, and keeps no copy. Undefined when there's nothing to keep.
 */
export function followUpQuotes(e: { sources: PackQuotes; from?: string | null }): PackQuotes | undefined {
  if (e.from !== "team" || !e.sources.length) return undefined;
  return e.sources.map((s) => ({ id: s.id, kind: s.kind, at: s.at, passages: [...s.passages] }));
}

/**
 * R5 (RUN-5): the copy a follow-up keeps (`followUpQuotes`), with the name swap it went through (`quotesSwap`): read
 * from the team's pack, its passages went through today's swap (`runEvidence`: a pack from before it is swapped as it's
 * read). Approval then reads no people out of it, as from a swapped pack (`recheckProposal`), and its own pack is
 * written from it as it is. A copy kept before this has no record of it, so it's read and swapped again.
 */
export function keptQuotes(e: { sources: PackQuotes; from?: string | null; swapped?: boolean }): { quotes?: PackQuotes; quotesSwap?: number } {
  const quotes = followUpQuotes(e);
  return quotes ? { quotes, ...(e.swapped ? { quotesSwap: NAME_SWAP } : {}) } : {};
}

export interface ShareResult {
  shared: string[];
  /** "PMX couldn't share PMX-12's quotes with your team: …", once per task. */
  notices: string[];
  /**
   * With `clear`: the PENDING-… tasks whose staged share was let go, since they left the Claude relay's queue before
   * Linear had them and so never get an identifier. Only when there are some.
   */
  cleared?: string[];
  /**
   * With `clear`: the tasks Linear has whose staged share was let go unwritten, since their mark (PULL-14) says PMX took
   * them back or dropped them, so they're canceled in Linear. Only when there are some.
   */
  canceled?: string[];
}

const list = (ids: string[]) => (ids.length <= 2 ? ids.join(" and ") : `${ids.slice(0, -1).join(", ")} and ${ids.at(-1)}`);

/**
 * A task's pack as this Mac would write it now (RUN-5), or null when this Mac has nothing of it to quote. Exactly what
 * this Mac's agent would be shown: the task's own cited sources, screened and redacted as they are now, with every
 * person PMX finds swapped for a placeholder (taskEvidence, R5), and the sources' outside companies. A follow-up whose
 * sources aren't on this Mac reuses its original's pack, which the team has already, with its names swapped if it's
 * from before R5, or, once an accept removed that pack, the copy of it this Mac kept with the follow-up (followUpQuotes),
 * checked like a pack and swapped the same way. The one builder for an approval, the backfill and a rewrite (`at`: the pack's first write); the
 * store refuses a pack that carries a canary (FLOW-3).
 */
async function packFor(ctx: Ctx, store: EvidenceStore, t: { title: string; description: string; sources: string[]; follows?: string | null; quotes?: PackQuotes | null; quotesSwap?: number | null }, id: string, now: Date, at?: string, seen?: { missing?: Evidence["missing"] }): Promise<EvidencePack | null> {
  const e: Evidence = await taskEvidence(ctx, { title: t.title, description: t.description, sources: t.sources }).catch(() => ({ sources: [], missing: [] }));
  if (seen) seen.missing = e.missing;
  let sources = e.sources;
  let companies = e.companies ?? [];
  if (!sources.length && t.follows) {
    const o = await store.read(t.follows).catch(() => null);
    sources = packSources(o, t.sources);
    companies = packCompanies(o);
    if (sources.length && !swappedPack(o)) sources = swapPassages(sources, [...companies, ...sourceCompanies(t.description, t.title)], await swapLists(ctx)).sources;
  }
  if (!sources.length && t.quotes?.length) {
    const kept: EvidencePack = { v: 1, task: id, at: now.toISOString(), ...(t.quotesSwap ? { nameSwap: t.quotesSwap } : {}), sources: t.quotes };
    sources = packSources(kept, t.sources);
    if (sources.length && !swappedPack(kept)) sources = swapPassages(sources, sourceCompanies(t.description, t.title), await swapLists(ctx)).sources;
  }
  return sources.length ? { v: 1, task: id, at: at ?? now.toISOString(), nameSwap: NAME_SWAP, ...(companies.length ? { companies } : {}), sources } : null;
}

/**
 * INPUT-2 (RUN-5): an open task's pack written again after it took a later call's sources (`built`, from this Mac's
 * files now), keeping from the pack there the passages of the sources whose files this Mac no longer has, so the update
 * never loses quotes, and when it was first written. Only from a pack through today's name swap, and never a source the
 * privacy rules now hold: `missing` says why each one wasn't built.
 */
async function keptPack(store: EvidenceStore, id: string, sources: string[], built: EvidencePack | null, missing: Evidence["missing"]): Promise<EvidencePack | null> {
  const there = await store.read(id).catch(() => null);
  if (!there || !swappedPack(there)) return built;
  const gone = new Set(missing.filter((m) => m.why === "its meeting or thread is no longer in your folders").map((m) => m.id));
  const have = new Set((built?.sources ?? []).map((s) => s.id));
  const kept = packSources(there, sources).filter((s) => gone.has(s.id) && !have.has(s.id));
  if (!built && !kept.length) return null;
  const all = [...(built?.sources ?? []), ...kept].sort((a, b) => sources.indexOf(a.id) - sources.indexOf(b.id));
  const companies = [...new Set([...(built?.companies ?? []), ...packCompanies(there)])];
  return { v: 1, task: id, at: there.at, nameSwap: NAME_SWAP, ...(companies.length ? { companies } : {}), sources: all };
}

/** "PMX couldn't share PMX-12's quotes with your team: …", a sentence per reason. */
function notShared(failed: { id: string; why: string }[]): string[] {
  const by = new Map<string, string[]>();
  for (const f of failed) by.set(f.why, [...(by.get(f.why) ?? []), f.id]);
  return [...by].map(([why, ids]) => `PMX couldn't share ${ids.length === 1 ? `${ids[0]}'s quotes` : `the quotes of ${list(ids)}`} with your team: ${why}. Until it does, only this Mac's agent can draft ${ids.length === 1 ? "it" : "them"}; PMX tries again in its next background run.`);
}

async function logShared(ctx: Ctx, ids: string[]): Promise<void> {
  if (!ids.length) return;
  const log = new RunLogStore(ctx);
  for (const id of ids) await log.record({ type: "evidence", agent: ctx.agent, machine: ctx.personal.machineId, taskId: id, action: "shared" }).catch(() => {});
}

/**
 * RUN-5: the tasks whose mark in the team repo (PULL-14) says PMX dropped them: taken back to a PM's to-dos, withdrawn
 * (`pmx linear withdraw`) or dropped after failed runs, so canceled in Linear. The team's marks now, else as this Mac
 * last fetched them (its own steps among them); none when it can read neither.
 */
async function droppedTasks(ctx: Pick<Ctx, "repo">, now: Date): Promise<Set<string>> {
  const marks = markStore(ctx.repo);
  const all = await marks.list().catch(() => marks.cached()).catch(() => new Map<string, TaskMark>());
  return new Set([...all.values()].filter((m) => m.state === "dropped" && !expired(m, now)).map((m) => m.task));
}

/**
 * Writes the packs of every staged task whose identifier is known (RUN-5). `say`: where a failure is told, once per
 * task: in the answer to the PM's approval, or (from the background run and the Claude sync) as a notification.
 * `clear` (the background run's pass, which says so in its line): also lets go of each staged PENDING-… task that is
 * neither queued in this Mac's outbox nor given its identifier by the sync: one taken back or dropped before Linear had
 * it, or that Linear refused 3 times, which never gets an identifier (`cleared`). A Mac with no outbox lets go of none.
 * Never a task whose mark says PMX took it back or dropped it (canceled in Linear, on this Mac or another): every pass
 * leaves its pack unwritten, and `clear` lets go of its share (`canceled`), so its quotes never reach the team repo.
 */
export async function shareEvidence(ctx: Ctx, o: { say: "answer" | "notify"; store?: EvidenceStore; clear?: boolean }): Promise<ShareResult> {
  const out: ShareResult = { shared: [], notices: [] };
  const all = await read();
  if (!all.length) return out;
  const store = o.store ?? storeFor(ctx);
  const pending = all.some((w) => w.identifier.startsWith("PENDING-"));
  // The queue before the identifiers: the relay records an identifier before its op leaves the queue (checkRelay), so
  // a task in neither has left the queue for good. An outbox PMX can't read lets go of nothing.
  const queued = o.clear && pending ? await queuedIdentifiers().catch(() => null) : null;
  const resolved = pending ? await readResolved() : {};
  const now = ctx.now();
  const old = (w: Waiting) => now.getTime() - Date.parse(w.at) > GIVE_UP_MS;
  const idOf = (w: Waiting) => (w.identifier.startsWith("PENDING-") ? resolved[w.identifier]?.identifier ?? null : w.identifier);
  // Read only when there's a pack to write: a task taken back or dropped since its share was staged.
  const dropped = all.some((w) => !!idOf(w)) ? await droppedTasks(ctx, now) : new Set<string>();
  const drop = new Set<string>();
  const cleared: string[] = [];
  const canceled: string[] = [];
  const ready: { w: Waiting; pack: EvidencePack }[] = [];
  for (const w of all) {
    const id = idOf(w);
    if (!id) {
      if (queued && !queued.has(w.identifier)) { drop.add(w.identifier); cleared.push(w.identifier); }
      else if (old(w)) drop.add(w.identifier);
      continue;
    }
    // Canceled in Linear: nothing of it goes to the team repo, and the background run's pass lets it go, saying so.
    if (dropped.has(id)) {
      if (o.clear) { drop.add(w.identifier); canceled.push(id); }
      continue;
    }
    const seen: { missing?: Evidence["missing"] } = {};
    const built = await packFor(ctx, store, w, id, now, undefined, seen);
    const pack = w.keep ? await keptPack(store, id, w.sources, built, seen.missing ?? []) : built;
    // Nothing this Mac can quote, so nothing to share: the task runs where its sources are, as before.
    if (!pack) { drop.add(w.identifier); continue; }
    ready.push({ w, pack });
  }
  // One task at a time, so one that fails doesn't hold back the others, and each is told about once.
  const failed = new Map<string, string>();
  for (const r of ready) {
    try {
      await store.write({ put: [r.pack] }, `evidence: quotes for ${r.pack.task}`);
      out.shared.push(r.pack.task);
      drop.add(r.w.identifier);
    } catch (e: any) {
      failed.set(r.w.identifier, String(e?.message ?? e));
    }
  }
  out.notices.push(...notShared(ready.filter((r) => failed.has(r.w.identifier) && !r.w.told).map((r) => ({ id: r.pack.task, why: failed.get(r.w.identifier)! }))));
  await withLock(file(), async () => {
    const kept: Waiting[] = [];
    for (const w of await read()) {
      if (drop.has(w.identifier)) continue;
      // A share that kept failing for a week is let go: the task still runs on this Mac, as before RUN-5.
      if (failed.has(w.identifier)) { if (!old(w)) kept.push({ ...w, told: true }); }
      else kept.push(w);
    }
    await save(kept);
  });
  if (cleared.length) out.cleared = cleared;
  if (canceled.length) out.canceled = canceled;
  await logShared(ctx, out.shared);
  if (o.say === "notify" && out.notices.length) await notify("ProductMaxxing", out.notices.join(" ")).catch(() => {});
  return out;
}

/** Which staged shares are these tasks': staged under one of their identifiers, or under a PENDING-… the sync gave one. */
async function stagedAs(all: Waiting[], ids: Set<string>): Promise<(w: Waiting) => boolean> {
  const resolved = all.some((w) => w.identifier.startsWith("PENDING-") && !ids.has(w.identifier)) ? await readResolved() : {};
  return (w) => ids.has(w.identifier) || (w.identifier.startsWith("PENDING-") && ids.has(resolved[w.identifier]?.identifier ?? ""));
}

/**
 * RUN-5: the share staged for a task PMX takes out of the team's work goes at once, so none of its quotes reach the
 * team repo after. A task taken out of the Claude relay's queue before Linear had it (taken back to the PM's to-dos, or
 * `pmx linear outbox drop`) never gets an identifier. One Linear has that PMX takes back, withdraws or drops is
 * canceled there, and its share may still be staged after a push that failed, under its identifier or under the
 * PENDING-… it had before the sync gave it one. Returns the ones it removed.
 */
export async function unstageShares(identifiers: string[]): Promise<string[]> {
  const gone = new Set(identifiers);
  const before = await read();
  if (!gone.size || !before.length || !before.some(await stagedAs(before, gone))) return [];
  return withLock(file(), async () => {
    const all = await read();
    const mine = await stagedAs(all, gone);
    const removed = all.filter(mine).map((w) => w.identifier);
    if (removed.length) await save(all.filter((w) => !mine(w)));
    return removed;
  });
}

/**
 * R16c (RUN-5): the copy of quotes a task's staged share holds (a FOLLOW-1 follow-up's, or the copy a to-do kept), as a
 * pack, for a take-back when the team repo has no pack of the task: its share is still staged, waiting for the sync or
 * after a push that failed. Null when it holds none.
 */
export async function stagedPack(identifier: string): Promise<EvidencePack | null> {
  const all = await read();
  const mine = await stagedAs(all, new Set([identifier]));
  const w = all.find((x) => mine(x) && x.quotes?.length);
  return w ? { v: 1, task: identifier, at: w.at, ...(w.quotesSwap ? { nameSwap: w.quotesSwap } : {}), sources: w.quotes! } : null;
}

/** The background run's line for `cleared`: what it let go of, and why. */
const clearedLine = (ids: string[]) => ids.length === 1
  ? `stopped waiting to share the quotes of ${ids[0]}: that task was taken out of the queue for Linear before Linear had it, so it will never be in Linear`
  : `stopped waiting to share the quotes of ${list(ids)}: those tasks were taken out of the queue for Linear before Linear had them, so they will never be in Linear`;

/** The background run's line for `canceled`: what it let go of unwritten, and why. */
const canceledLine = (ids: string[]) => ids.length === 1
  ? `stopped waiting to share the quotes of ${ids[0]}: that task was taken back or dropped, so it's canceled in Linear and its quotes stay off your team's repo`
  : `stopped waiting to share the quotes of ${list(ids)}: those tasks were taken back or dropped, so they're canceled in Linear and their quotes stay off your team's repo`;

/**
 * The backfill's memory (RUN-5), on this Mac only (owner-only), by task ID: a task it had nothing to quote for, looked
 * at again after a week, a task whose pack it couldn't write, tried again at every background run and told once, and
 * (R5) a task whose pack it removed to write it again without names and couldn't write back yet.
 */
interface Tried { at: string; result: "nothing" | "failed" | "rewrite"; told?: boolean }
const backfillFile = () => join(paths.staging(), "evidence-backfill.json");
const readTried = async (): Promise<Record<string, Tried>> => (await readJson<{ v: 1; tasks: Record<string, Tried> }>(backfillFile()))?.tasks ?? {};

/** At most this many of this Mac's tasks get a pack in one background run, so a long backlog doesn't hold up the run. */
export const BACKFILL_MAX = 20;
/** Once the backfill has nothing left to write, it looks again this much later. */
const BACKFILL_EVERY_MS = 24 * 3600000;
/** A task this Mac had nothing to quote for is looked at again after this long: a folder or a privacy rule may have changed. */
const NOTHING_AGAIN_MS = 7 * 86400000;
/** Open tasks: waiting in the backlog, Ready, or blocked. One being drafted or in review has its agent already. */
const OPEN = new Set<string>(["inbox", "ready", "blocked"]);

export interface BackfillResult {
  shared: string[];
  /** "PMX couldn't share PMX-12's quotes with your team: …", once per task. */
  notices: string[];
  /** How many more of this Mac's tasks wait for a pack than one run writes: the next background run goes on. */
  more: number;
  /** How many packs couldn't be written: the next background run tries them again. */
  failed: number;
  /** R5: packs this Mac wrote before the name swap, written again without names. Only when there are some. */
  rewritten?: string[];
}

/**
 * RUN-5's backfill: tasks approved before evidence packs (or whose share was let go after a week) have none, so every
 * other Mac's agent skips them. On the Mac that holds a task's synthesis run (its receipt is here), this writes the
 * pack for each of that Mac's open tasks without one, with the same builder and checks as an approval (packFor; the
 * store refuses a canary). At most `max` tasks a run, those never tried first; a task the share queue still holds is
 * left to it. Writing what the team has already changes nothing, so running it again is safe.
 *
 * R5: packs written before PMX swapped names still name people, so the same run writes again each pack of this Mac's
 * tasks (any not done or dropped) that has no `nameSwap`, from its sources here if it still has them, else from the
 * pack's own passages with the names `namesIn` finds there swapped. The pack is removed and written afresh, keeping
 * when it was first written: a new commit on top would keep the names in the ref's history, and PMX never forces a
 * push. New packs come first within `max`; the rest go at the next run.
 */
export async function backfillEvidence(ctx: Ctx, svc: Pick<Services, "tracker">, o: { store?: EvidenceStore; max?: number; say?: "notify" | "none" } = {}): Promise<BackfillResult> {
  const out: BackfillResult = { shared: [], notices: [], more: 0, failed: 0 };
  if (ctx.team.tracker.kind === "none") return out;
  const now = ctx.now();
  const active = (await svc.tracker.list()).filter((t) => t.status !== null && t.status !== "done" && t.workflow?.type !== "completed" && t.workflow?.type !== "canceled"
    && t.sources.length && TASK.test(t.identifier) && !t.identifier.startsWith("PENDING-"));
  // Only the Mac with the task's synthesis run: its receipt is here. No meeting is read to find out.
  const mine: Task[] = [];
  for (const t of active) if ((await sourcesHere(t).catch(() => ({ receipt: false }))).receipt) mine.push(t);
  const tried = await readTried();
  // Open tasks, and (R5) one whose pack was removed for a rewrite that couldn't be written back, whatever its step.
  const here = mine.filter((t) => OPEN.has(t.status!) || tried[t.identifier]?.result === "rewrite");
  const keep = (next: Record<string, Tried>) => withLock(backfillFile(), async () => { await privateDir(paths.staging()); await writeJson(backfillFile(), { v: 1, tasks: next }, 0o600); });
  if (!mine.length) { if (Object.keys(tried).length) await keep({}); return out; }

  const store = o.store ?? storeFor(ctx);
  const packed = new Set(await store.list());
  // N7: never a task whose pack was removed, or that another Mac marked done or dropped (PULL-14), whatever this Mac's
  // copy of Linear says. A team repo it can't read now waits for the next run, like the packs.
  const marks = await markStore(ctx.repo).list();
  const finished = (id: string) => {
    const m = marks.get(id);
    return !!m && !expired(m, now) && (!!m.packRemovedAt || m.state === "done" || m.state === "dropped");
  };
  // Approved since RUN-5 and still waiting for its share: the share queue tries it, and tells about it.
  const queue = await read();
  const resolved = queue.some((w) => w.identifier.startsWith("PENDING-")) ? await readResolved() : {};
  const queued = new Set(queue.map((w) => (w.identifier.startsWith("PENDING-") ? resolved[w.identifier]?.identifier ?? w.identifier : w.identifier)));
  const want = here.filter((t) => !packed.has(t.identifier) && !queued.has(t.identifier) && !finished(t.identifier)).filter((t) => {
    const x = tried[t.identifier];
    return !(x?.result === "nothing" && now.getTime() - Date.parse(x.at) < NOTHING_AGAIN_MS);
  });
  // Never tried first (and a removed pack waiting to be written back), then the ones that failed, then the ones with
  // nothing to quote; oldest try first.
  const rank = (t: Task) => (!tried[t.identifier] || tried[t.identifier]!.result === "rewrite" ? 0 : tried[t.identifier]!.result === "failed" ? 1 : 2);
  want.sort((a, b) => rank(a) - rank(b) || (tried[a.identifier]?.at ?? "").localeCompare(tried[b.identifier]?.at ?? ""));
  const max = Math.max(0, o.max ?? BACKFILL_MAX);
  const batch = want.slice(0, max);
  // R5: this Mac's packs from before the name swap, after the new ones.
  const stale: { t: Task; p: EvidencePack }[] = [];
  for (const t of mine) {
    if (!packed.has(t.identifier) || finished(t.identifier) || queued.has(t.identifier)) continue;
    const p = await store.read(t.identifier).catch(() => null);
    if (p && !swappedPack(p)) stale.push({ t, p });
  }
  const again = stale.slice(0, Math.max(0, max - batch.length));
  out.more = want.length - batch.length + stale.length - again.length;

  // What's remembered: only this Mac's tasks that still have no pack, or an old one.
  const next: Record<string, Tried> = {};
  for (const t of here) if (!packed.has(t.identifier) && !finished(t.identifier) && tried[t.identifier]) next[t.identifier] = tried[t.identifier]!;
  for (const { t } of stale) if (tried[t.identifier]) next[t.identifier] = tried[t.identifier]!;
  const failed: { id: string; why: string }[] = [];
  // One task at a time, so one that fails doesn't hold back the others.
  for (const t of batch) {
    const id = t.identifier;
    const pack = await packFor(ctx, store, { title: t.title, description: t.description, sources: t.sources, follows: followsIn(t.description) }, id, now);
    if (!pack) { next[id] = { at: now.toISOString(), result: "nothing" }; continue; }
    try {
      const r = await store.write({ put: [pack] }, `evidence: quotes for ${id}`);
      if (r.put.includes(id)) out.shared.push(id);
      delete next[id];
    } catch (e: any) {
      out.failed++;
      if (!tried[id]?.told) failed.push({ id, why: String(e?.message ?? e) });
      next[id] = { at: now.toISOString(), result: tried[id]?.result === "rewrite" ? "rewrite" : "failed", told: true };
    }
  }
  const rewritten: string[] = [];
  for (const { t, p } of again) {
    const id = t.identifier;
    // From the sources here, as an approval would; else the same passages with the names they show swapped.
    let pack = await packFor(ctx, store, { title: t.title, description: t.description, sources: t.sources, follows: followsIn(t.description) }, id, now, p.at);
    if (!pack) {
      const companies = packCompanies(p);
      const sources = swapPassages(packSources(p, t.sources), [...companies, ...sourceCompanies(t.description, t.title)], await swapLists(ctx)).sources;
      pack = sources.length ? { v: 1, task: id, at: p.at, nameSwap: NAME_SWAP, ...(companies.length ? { companies } : {}), sources } : null;
    }
    try {
      await store.write({ remove: [id] }, `evidence: write the quotes of ${id} again without names`);
      if (pack) { await store.write({ put: [pack] }, `evidence: quotes for ${id}`); rewritten.push(id); }
      delete next[id];
    } catch (e: any) {
      out.failed++;
      if (!tried[id]?.told) failed.push({ id, why: String(e?.message ?? e) });
      next[id] = { at: now.toISOString(), result: "rewrite", told: true };
    }
  }
  if (rewritten.length) out.rewritten = rewritten;
  await keep(next);
  await logShared(ctx, [...out.shared, ...rewritten]);
  out.notices = notShared(failed);
  if (o.say === "notify" && out.notices.length) await notify("ProductMaxxing", out.notices.join(" ")).catch(() => {});
  return out;
}

/**
 * RUN-5: removes the packs of tasks that are done (accepted, or closed in the tracker) or dropped (canceled, so gone from
 * the tracker's list), and says so in the run log. Any Mac may do it. A pack whose task this Mac can't see is removed
 * only when this Mac's copy of the tracker was read after the pack was written, so a Mac behind on its Linear sync
 * never removes a new task's pack, and in any case 30 days after it was written. N7: the packs listed are the team
 * repo's now, and a pack whose task another Mac marked done or dropped, or whose pack was removed before (a Mac with an
 * older copy of Linear wrote it again), goes whatever this Mac's copy says. Each removal leaves a tombstone in the
 * task's mark (PULL-14), so no Mac's backfill writes it again. An accept or a drop through PMX removes its task's pack
 * at once (removePackNow); this background clean-up catches the rest: a task closed or canceled in Linear, and a
 * removal the team repo didn't take then.
 */
export async function tidyEvidence(ctx: Ctx, svc: Pick<Services, "tracker">, store: EvidenceStore = storeFor(ctx)): Promise<Gone[]> {
  const ids = await store.list();
  if (!ids.length) return [];
  const tasks: Task[] = await svc.tracker.list();
  const now = ctx.now().getTime();
  const synced = svc.tracker.syncedAt ? await svc.tracker.syncedAt() : null;
  const asOf = synced ? Date.parse(synced) : now;
  const byId = new Map(tasks.map((t) => [t.identifier, t]));
  const marks = await markStore(ctx.repo).list().catch(() => new Map<string, TaskMark>());
  const gone: Gone[] = [];
  for (const id of ids) {
    const m = marks.get(id);
    const said = m && !expired(m, ctx.now()) ? m : null;
    if (said && (said.state === "done" || said.state === "dropped" || said.packRemovedAt)) { gone.push({ id, why: said.state === "dropped" ? "dropped" : "done" }); continue; }
    const t = byId.get(id);
    if (t) {
      if (t.status === "done" || t.workflow?.type === "completed") gone.push({ id, why: "done" });
      continue;
    }
    const at = Date.parse((await store.read(id))?.at ?? "");
    if (!Number.isFinite(at) || at < asOf - SKEW_MS || now - at > PACK_MAX_MS) gone.push({ id, why: "dropped" });
  }
  if (!gone.length) return [];
  // A tombstone written afresh: the task's step as this Mac's copy of Linear shows it, so landed then.
  return removePacks(ctx, store, gone, synced ?? ctx.now().toISOString());
}

/** A finished task whose pack goes, and why. */
type Gone = { id: string; why: "done" | "dropped" };

/**
 * Removes finished tasks' packs from the team repo (RUN-5), for the clean-up and for an accept or a drop alike: each
 * ref deleted with a push that's never forced, a tombstone in each task's mark (PULL-14) so no Mac's backfill writes it
 * again, and a run log line by task ID. A mark that says done or dropped keeps its step and gains the tombstone;
 * otherwise the mark becomes the step, with `landed` for when the tracker had it. Throws, leaving every mark as it
 * was, when the team repo doesn't take a removal. Returns the packs it removed.
 */
async function removePacks(ctx: Ctx, store: EvidenceStore, gone: Gone[], landed: string | null): Promise<Gone[]> {
  const r = await store.write({ remove: gone.map((g) => g.id) }, `evidence: remove the quotes of ${gone.map((g) => g.id).join(", ")} (task done or dropped)`);
  const removed = gone.filter((g) => r.removed.includes(g.id));
  const at = ctx.now().toISOString();
  const marks = markStore(ctx.repo);
  for (const g of gone) {
    await marks.update(g.id, (cur) => {
      if (cur?.packRemovedAt && (cur.state === "done" || cur.state === "dropped")) return null;
      const same = cur && (cur.state === "done" || cur.state === "dropped");
      return same ? { ...cur, packRemovedAt: at }
        : { v: 1, task: g.id, state: g.why, at, by: ctx.agent, machine: ctx.personal.machineId, landed, packRemovedAt: at };
    }).catch(() => null);
  }
  const log = new RunLogStore(ctx);
  for (const g of removed) await log.record({ type: "evidence", agent: ctx.agent, machine: ctx.personal.machineId, taskId: g.id, action: "removed", reason: g.why }).catch(() => {});
  return removed;
}

/**
 * RUN-5 (founder, 2026-11-26): a task's shared quotes leave the team repo when its draft is accepted, and when PMX drops
 * the task, not at the next clean-up. The same removal and tombstone as the clean-up (removePacks), so no Mac shares
 * them again. Call it after the task's mark (markTask), so the tombstone joins that step. Never throws: a team repo it
 * can't reach, or a push it refuses, leaves the pack to the clean-up, which removes it by the task's mark. True when it
 * removed the pack.
 */
export async function removePackNow(ctx: Ctx, tracker: Pick<Tracker, "syncedAt">, identifier: string, why: Gone["why"]): Promise<boolean> {
  if (ctx.team.tracker.kind === "none" || !TASK.test(identifier)) return false;
  try {
    const store = storeFor(ctx);
    // The team's packs now: a task that has none has nothing to remove and needs no tombstone.
    if (!(await store.list()).includes(identifier)) return false;
    // A mark written afresh lands as markTask's would: at once when PMX reads the tracker itself, else at the next sync.
    return (await removePacks(ctx, store, [{ id: identifier, why }], tracker.syncedAt ? null : ctx.now().toISOString())).length > 0;
  } catch {
    return false;
  }
}

/**
 * F5 (RUN-5): a pack shared under older privacy rules may quote what today's rules hold from team work: an investor's
 * call, a fundraising meeting, a confidential contact's thread, or a passage about a raise in a customer call. The Mac
 * that wrote each pack (its task's synthesis run is here) works its sources out again (taskEvidence) and, when the
 * rules now hold one of them or cut one of its passages, builds the pack again with the same builder as an approval and
 * the backfill (packFor) from the sources they don't hold: exactly what this Mac would share now, so a source whose
 * file is gone goes too, with when it was first written. The pack is removed and written afresh, so no ref history
 * keeps those quotes; one left with nothing is just removed. `failed`: packs it couldn't write; the next background run
 * tries again.
 */
export async function dropHeldSources(ctx: Ctx, svc: Pick<Services, "tracker">, store: EvidenceStore = storeFor(ctx)): Promise<{ changed: string[]; removed: string[]; failed: number }> {
  const out = { changed: [] as string[], removed: [] as string[], failed: 0 };
  if (ctx.team.tracker.kind === "none") return out;
  const packed = new Set(await store.list());
  if (!packed.size) return out;
  const rules = privacyRules(ctx);
  const log = new RunLogStore(ctx);
  for (const t of await svc.tracker.list()) {
    if (!packed.has(t.identifier) || !t.sources.length || !(await sourcesHere(t).catch(() => ({ receipt: false }))).receipt) continue;
    const pack = await store.read(t.identifier).catch(() => null);
    const e = pack ? await taskEvidence(ctx, t).catch(() => null) : null;
    if (!pack || !e) continue;
    const held = new Set(pack.sources.filter((x) => heldNow(e, x.id)).map((x) => x.id));
    if (!held.size && !pack.sources.some((x) => x.passages.some((p) => screensOut(p, rules)))) continue;
    // Built again with the same builder as an approval and the backfill (packFor), from the sources the rules don't
    // hold, keeping when it was first written. A follow-up's fallback to its original's quotes was screened under the
    // rules then, so it's screened again.
    const built = await packFor(ctx, store, { title: t.title, description: t.description, sources: t.sources.filter((id) => !held.has(id)), follows: followsIn(t.description) }, t.identifier, ctx.now());
    const sources = (built?.sources ?? []).map((x) => ({ ...x, passages: x.passages.map((p) => (screensOut(p, rules) ? screened(p, rules) : p)).filter((p) => p.trim()) }))
      .filter((x) => x.passages.length);
    try {
      await store.write({ remove: [t.identifier] }, `evidence: remove the quotes of ${t.identifier} your privacy rules now hold`);
      if (built && sources.length) {
        await store.write({ put: [{ ...built, at: pack.at, sources }] }, `evidence: quotes for ${t.identifier}`);
        out.changed.push(t.identifier);
      } else out.removed.push(t.identifier);
      await log.record({ type: "evidence", agent: ctx.agent, machine: ctx.personal.machineId, taskId: t.identifier, action: built && sources.length ? "shared" : "removed", reason: "held" }).catch(() => {});
    } catch {
      out.failed++;
    }
  }
  return out;
}

/**
 * The background run's step for RUN-5: shares what's staged, lets go of what's staged for a task that left the relay's
 * queue before Linear had it or that PMX took back or dropped (canceled in Linear), and every few hours removes the
 * packs of finished tasks. Returns what changed in a line, or null.
 */
export async function evidenceStep(ctx: Ctx, svc: () => Promise<Pick<Services, "tracker">>): Promise<string | null> {
  if (ctx.team.tracker.kind === "none") return null;
  const lines: string[] = [];
  // One store a run, so the team's packs are fetched once.
  const store = storeFor(ctx);
  let tracker: Promise<Pick<Services, "tracker">> | null = null;
  const services = () => (tracker ??= svc());
  // The one pass that lets go of a share whose task left the relay's queue before Linear had it, or was canceled there
  // by PMX, and says so.
  const s = await shareEvidence(ctx, { say: "notify", store, clear: true });
  const st = await loadState();
  const now = ctx.now();
  // The backfill: due after an update (UPGRADE-1), daily, and at once again after a run that stopped at its limit or failed.
  const bf = st.evidenceBackfill;
  const b = !bf || bf.due || !bf.at || now.getTime() - Date.parse(bf.at) >= BACKFILL_EVERY_MS
    // A tracker PMX can't read yet (no Linear sync on this Mac), or a team repo it can't reach, waits for the next run.
    ? await services().then((x) => backfillEvidence(ctx, x, { store, say: "notify" })).catch(() => null)
    : null;
  if (b) await updateState((x) => { x.evidenceBackfill = { at: now.toISOString(), due: b.more > 0 || b.failed > 0 }; });
  const shared = [...s.shared, ...(b?.shared ?? [])];
  if (shared.length) lines.push(`shared the quotes of ${list(shared)} with your team`);
  if (s.cleared?.length) lines.push(clearedLine(s.cleared));
  if (s.canceled?.length) lines.push(canceledLine(s.canceled));
  if (b?.rewritten?.length) lines.push(`took the names out of the shared quotes of ${list(b.rewritten)}`);
  if (b?.more) lines.push(`${b.more} more ${b.more === 1 ? "task's quotes go" : "tasks' quotes go"} to your team at the next background run`);
  lines.push(...s.notices, ...(b?.notices ?? []));
  // F5: once the rules that decide what team work may read change (an update, a merged confidentialDomains, the
  // do-not-read list), this Mac's packs lose what those rules now hold.
  const key = holdRulesKey(privacyRules(ctx));
  if (st.evidenceRulesKey !== key) {
    const d = await services().then((x) => dropHeldSources(ctx, x, store)).catch(() => null);
    if (d && !d.failed) await updateState((x) => { x.evidenceRulesKey = key; });
    if (d?.changed.length) lines.push(`took what your privacy rules now hold out of the shared quotes of ${list(d.changed)}`);
    if (d?.removed.length) lines.push(`removed the shared quotes of ${list(d.removed)}: your privacy rules now hold all of them`);
  }
  if (!st.evidenceTidyAt || now.getTime() - Date.parse(st.evidenceTidyAt) >= TIDY_EVERY_MS) {
    // A tracker PMX can't read yet (no Linear sync on this Mac) waits for the next run; the pull step says why.
    const gone = await services().then((x) => tidyEvidence(ctx, x, store)).catch(() => null);
    if (gone) {
      await updateState((x) => { x.evidenceTidyAt = ctx.now().toISOString(); });
      if (gone.length) lines.push(`removed the shared quotes of ${list(gone.map((g) => `${g.id} (${g.why})`))}`);
    }
  }
  return lines.join("; ") || null;
}
