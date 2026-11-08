import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { isoWeek, type Ctx } from "../core/context.js";
import { readJson, writeJson, privateDir, writeText } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import type { RunReceipt } from "../core/receipt.js";
import type { RunLogEntry } from "../core/runlog.js";
import { RunLogStore } from "../core/runlog-store.js";
import { discardStaged, readStaged, stagingPath } from "../digest/digest.js";
import { dmDigest, publishDigest } from "../digest/publish.js";

/**
 * The weekly digest on the board (BOARD-5): what's waiting for the PM's approval, every past week and how it ended,
 * when the next one is built, and where an approved one goes. Built only from what PMX already keeps on this Mac: the
 * staged files, the digest receipts and the run log. Approving from the board does what `pmx digest --review` does.
 */
export interface DigestWeek {
  week: string;
  /** When it was built, or when PMX last looked and found nothing. */
  at: string;
  status: "waiting" | "approved" | "rejected" | "no-signal" | "failed" | "expired";
  sources: number;
  held: number;
  removedClaims: number;
  costUsd: number | null;
  /** The pull request (or `branch:` for a repo without GitHub) an approved digest opened. */
  url: string | null;
}

export interface DigestBoard {
  /** 0 = Sunday … 6 = Saturday. */
  weekday: number;
  /** This week's key, like 2026-W45. */
  week: string;
  /** The day the next digest is built (YYYY-MM-DD), by the first background pass that day. */
  next: string;
  /** Staged and waiting for approval, newest first. `markdown` only on this Mac's own page. */
  waiting: { week: string; at: string | null; sources: number; held: number; removedClaims: number; markdown: string | null }[];
  history: DigestWeek[];
  /** Where an approved digest goes. The Slack user and channel only on this Mac's own page. */
  dm: { on: boolean; user: string | null };
  slackChannel: string | null;
  /** What the digest may read, in words. */
  reads: string[];
}

interface Stored { week: string; url: string; at: string }
const prFile = () => join(paths.home(), "digest-prs.json");

export async function rememberDigestPr(p: Stored): Promise<void> {
  const list = (await readJson<Stored[]>(prFile())) ?? [];
  await writeJson(prFile(), [...list.filter((x) => x.week !== p.week), p].slice(-60));
}

/** Weeks with a staged digest file on this Mac, and when each was written. */
export async function stagedWeeks(): Promise<{ week: string; at: string | null }[]> {
  const names = await readdir(paths.staging()).catch(() => [] as string[]);
  const out: { week: string; at: string | null }[] = [];
  for (const n of names) {
    const m = n.match(/^digest-(\d{4}-W\d{2})\.md$/);
    if (!m) continue;
    const at = await stat(join(paths.staging(), n)).then((s) => s.mtime.toISOString(), () => null);
    out.push({ week: m[1]!, at });
  }
  return out.sort((a, b) => b.week.localeCompare(a.week));
}

/** The next day the background job builds a digest: today if it hasn't yet this week, else the weekday after. */
export function nextDigestDay(now: Date, weekday: number, lastWeek: string | null): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let add = (weekday - d.getDay() + 7) % 7;
  if (add === 0 && lastWeek === isoWeek(now)) add = 7;
  d.setDate(d.getDate() + add);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export interface DigestInputs {
  now: Date;
  agent: string;
  local: boolean;
  weekday: number;
  lastDigestWeek: string | null;
  receipts: RunReceipt[];
  runlog: RunLogEntry[] | null;
  staged: { week: string; at: string | null; markdown: string | null }[];
  prs: Stored[];
  dmUser: string | null;
  slackChannel: string | null;
  reads: string[];
}

/**
 * Pure: the digest's board data from records already read. Past weeks are what happened, one row per outcome: a week
 * approved and then rebuilt shows its approval in history and its new build as waiting.
 */
export function buildDigestBoard(i: DigestInputs): DigestBoard {
  const receipts = i.receipts.filter((r) => r.type === "digest" && !r.dryRun).sort((a, b) => a.at.localeCompare(b.at));
  const counts = (r: RunReceipt | undefined) => ({
    sources: r ? r.sources.filter((s) => s.decision === "used").length : 0,
    held: r ? r.sources.filter((s) => s.decision === "left-out").length : 0,
    removedClaims: r?.digest?.removedClaims ?? 0,
    costUsd: r?.model?.costUsd ?? null,
  });
  const weekOf = (at: string) => isoWeek(new Date(at));
  // The build a week's outcome is about: the newest receipt of that week at or before the outcome.
  const buildFor = (week: string, before: string) => receipts.filter((r) => weekOf(r.at) === week && r.at <= before).at(-1) ?? receipts.filter((r) => weekOf(r.at) === week).at(0);
  const mine = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "digest" }> => e.type === "digest" && e.agent === i.agent && e.outcome !== "staged");
  const prs = new Map(i.prs.map((p) => [p.week, p]));
  const history: DigestWeek[] = [];
  for (const e of mine) {
    const week = e.week ?? weekOf(e.ts);
    const r = buildFor(week, e.ts);
    history.push({ week, at: e.ts, status: e.outcome === "approved" ? "approved" : "rejected", ...counts(r), url: e.outcome === "approved" ? prs.get(week)?.url ?? null : null });
  }
  // Approvals from before the run log carried a week, matched by their pull request.
  for (const [week, p] of prs) if (!history.some((h) => h.week === week && h.status === "approved")) history.push({ week, at: p.at, status: "approved", ...counts(buildFor(week, p.at)), url: p.url });
  for (const r of receipts) if (r.outcome === "no-signal" || r.outcome === "failed") history.push({ week: weekOf(r.at), at: r.at, status: r.outcome, ...counts(r), url: null });
  // A build nobody decided on, whose staged copy is gone: replaced by a newer build or cleared by hand.
  const decided = new Set(history.map((h) => `${h.week}@${h.at}`));
  for (const r of receipts) {
    if (r.outcome !== "staged") continue;
    const w = weekOf(r.at);
    const later = receipts.some((x) => x !== r && weekOf(x.at) === w && x.at > r.at) || history.some((h) => h.week === w && h.at >= r.at);
    if (!later && !i.staged.some((s) => s.week === w) && !decided.has(`${w}@${r.at}`)) history.push({ week: w, at: r.at, status: "expired", ...counts(r), url: null });
  }
  history.sort((a, b) => b.at.localeCompare(a.at));
  return {
    weekday: i.weekday,
    week: isoWeek(i.now),
    next: nextDigestDay(i.now, i.weekday, i.lastDigestWeek),
    // A waiting digest's time is its build's, so every place on the board shows the same one.
    waiting: i.staged.map((s) => {
      const r = receipts.filter((x) => weekOf(x.at) === s.week && x.outcome === "staged").at(-1);
      const c = counts(r);
      return { week: s.week, at: r?.at ?? s.at, sources: c.sources, held: c.held, removedClaims: c.removedClaims, markdown: i.local ? s.markdown : null };
    }),
    history: history.slice(0, 26),
    dm: { on: !!i.dmUser, user: i.local ? i.dmUser : null },
    slackChannel: i.local ? i.slackChannel : null,
    reads: i.reads,
  };
}

/** Reads the digest's records and builds its board data. */
export async function loadDigestBoard(ctx: Pick<Ctx, "personal" | "team" | "agent" | "now">, o: { local: boolean; receipts: RunReceipt[]; runlog: RunLogEntry[] | null; lastDigestWeek: string | null }): Promise<DigestBoard> {
  const weeks = await stagedWeeks();
  const staged = await Promise.all(weeks.map(async (w) => ({ ...w, markdown: o.local ? await readStaged(w.week) : null })));
  const allowed = ctx.team.allowedSources;
  const reads = [
    allowed.includes("transcripts") ? "Your customer calls from the last 7 days" : "",
    allowed.includes("slack") && ctx.personal.sources.slackChannel && ctx.team.slackChannels.includes(ctx.personal.sources.slackChannel) ? "Your team's approved Slack channel" : "",
  ].filter(Boolean);
  return buildDigestBoard({
    now: ctx.now(), agent: ctx.agent, local: o.local, weekday: ctx.personal.digest.weekday, lastDigestWeek: o.lastDigestWeek,
    receipts: o.receipts, runlog: o.runlog, staged, prs: (await readJson<Stored[]>(prFile())) ?? [],
    dmUser: ctx.personal.digest.slackDmUserId, slackChannel: ctx.personal.sources.slackChannel ?? null, reads,
  });
}

const WEEK = /^\d{4}-W\d{2}$/;

/**
 * The board's digest actions, as `pmx digest --review` does them (PRIV-3): nothing reaches git until the PM approves.
 *  - save: replaces the staged text with the PM's edit, still only on this Mac.
 *  - approve: commits it on a branch and opens a pull request, then sends the Slack DM if one is set.
 *  - reject: deletes the staged copy.
 */
export async function digestAction(ctx: Ctx, action: string, week: string, markdown?: string): Promise<{ status: number; body: unknown }> {
  if (!WEEK.test(week)) return { status: 400, body: { error: "That isn't a week like 2026-W45." } };
  if (!["save", "approve", "reject"].includes(action)) return { status: 400, body: { error: "action is save, approve or reject" } };
  const current = await readStaged(week);
  if (current === null) return { status: 404, body: { error: `The ${week} digest isn't waiting any more.` } };
  const log = new RunLogStore(ctx);
  if (markdown !== undefined) {
    const text = String(markdown).replace(/\r\n/g, "\n");
    if (text.trim().length < 20 || text.length > 60000) return { status: 400, body: { error: "A digest is 20 to 60,000 characters." } };
    await privateDir(paths.staging());
    await writeText(stagingPath(week), text, 0o600);
    if (action === "save") return { status: 200, body: { message: "Saved your edit. It's still only on this Mac." } };
  }
  if (action === "reject") {
    await discardStaged(week);
    await log.record({ type: "digest", agent: ctx.agent, machine: ctx.personal.machineId, week, outcome: "rejected", items: 0, held: 0, durationMs: 0, tokens: null, costUsd: null });
    return { status: 200, body: { message: `Deleted the ${week} digest. Nothing reached your team's repo.` } };
  }
  const text = (await readStaged(week))!;
  let pr: { url: string };
  try { pr = await publishDigest(ctx, week, text); }
  catch (e: any) { return { status: 502, body: { error: `Couldn't open the pull request: ${e.message}. The digest is still waiting.` } }; }
  await discardStaged(week);
  await rememberDigestPr({ week, url: pr.url, at: ctx.now().toISOString() });
  await log.record({ type: "digest", agent: ctx.agent, machine: ctx.personal.machineId, week, outcome: "approved", items: 0, held: 0, durationMs: 0, tokens: null, costUsd: null });
  const dm = await dmDigest(ctx, text).catch(() => false);
  const where = pr.url.startsWith("branch:") ? `committed on ${pr.url.slice(7)}` : "a pull request is open for your team";
  return { status: 200, body: { message: `Approved: ${where}${dm ? ", and it's in your Slack DMs" : ""}.`, url: pr.url.startsWith("branch:") ? null : pr.url } };
}
