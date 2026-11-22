import type { PersonalConfig, TeamConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { HOLD_LABELS, type HoldReason } from "../core/filter.js";
import { listReceipts, readReceipt, type RunReceipt } from "../core/receipt.js";
import { gather } from "../digest/gather.js";
import { gitMeetingLedger } from "../meetings/git-ledger.js";
import { planMeetings, startOfDay } from "../meetings/ledger.js";

/**
 * Where proposed tasks come from, and why there are none (SIG-6). Before 0.25.0 a team with no synthesis Mac chosen
 * never proposed a task and nothing said why: a new PM saw a connected Linear, an empty project and a list of personal
 * to-dos. Now a Mac proposes tasks from its own calls until the team picks one Mac to do it for everyone, and the
 * board, `pmx proposals` and `pmx doctor` say what happened to each recent meeting.
 */

/**
 * Whether this Mac proposes tasks. With a synthesis Mac chosen, only that one does, so every call is read once for the
 * whole team. With none chosen, each Mac does from the calls it collected; a meeting two PMs both saved is read once,
 * through the team's meeting record in the PMX repo.
 */
export function synthesizesHere(team: Pick<TeamConfig, "synthesizer" | "tracker">, personal: Pick<PersonalConfig, "handle">, agent: string): boolean {
  if (team.tracker.kind === "none") return false;
  return !team.synthesizer || team.synthesizer === agent || team.synthesizer === personal.handle;
}

/** How far back a run reads: from a day before the last run (the meeting record skips what's done), 7 days before the first, never more than 14. */
export function synthWindow(lastSynthAt: string | null, now: Date): { since: Date; days: number } {
  const floor = startOfDay(now, 14), today = startOfDay(now);
  let since = lastSynthAt && !Number.isNaN(Date.parse(lastSynthAt)) ? startOfDay(new Date(lastSynthAt), 1) : startOfDay(now, 7);
  if (since < floor) since = floor;
  if (since > today) since = today;
  return { since, days: Math.ceil((now.getTime() - since.getTime()) / 86400000) + 1 };
}

export type MeetingOutcome = "pending" | "read" | "held";
/** One recent meeting and what happened to it. A meeting kept out has no title here, only its date and the rule. */
export interface SynthMeeting { at: string; outcome: MeetingOutcome; title: string | null; rule: string | null; label: string | null }

export interface SynthStatus {
  where: "here" | "elsewhere" | "off";
  synthesizer: string | null;
  /** The background job runs it every 30 minutes. */
  automatic: boolean;
  lastRunAt: string | null;
  days: number;
  counts: { meetings: number; pending: number; read: number; held: number };
  heldBy: { rule: string; label: string; n: number }[];
  /** A rough cost of reading the pending meetings now, in US dollars. */
  estimateUsd: number | null;
  /** Why there are no proposed tasks, in a sentence or two. */
  reason: string;
  /** Newest first. This Mac's own page only. */
  meetings: SynthMeeting[];
}

const DAYS = 14;
const labelOf = (rule: string) => HOLD_LABELS[rule as HoldReason | "all-passages-held"] ?? rule;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** "5 internal-only (no one from outside the company)": how many meetings one rule kept out, in words. */
const HELD_AS: Record<string, string> = {
  "no-external-participant": "internal-only (no one from outside the company)", "no-company-domain": "held because your company's email domain isn't set",
  "one-on-one": "1:1s or career talks", "never-ingest": "on your do-not-read list", "unknown-participants": "with no participant list",
  "source-off": "from a source you turned off for tasks", performance: "about performance or HR", compensation: "about pay", health: "about health or leave",
  hiring: "about hiring", "all-passages-held": "where every passage was cut",
};
export const heldPhrase = (rule: string, n: number) => `${n} ${HELD_AS[rule] ?? labelOf(rule).toLowerCase()}`;
const usd = (n: number) => (n < 0.01 ? "under $0.01" : `about $${n < 1 ? n.toFixed(2) : n.toFixed(1)}`);

/**
 * A rough cost for reading `chars` characters of meetings: the average of this Mac's past runs per meeting when it has
 * some, else about 4 characters a token at list input prices plus a short answer.
 */
export function estimateCost(pending: { chars: number }[], receipts: RunReceipt[]): number | null {
  if (!pending.length) return null;
  const past = receipts.filter((r) => r.type === "synthesize" && !r.dryRun && r.model?.costUsd != null);
  const used = past.reduce((a, r) => a + r.sources.filter((s) => s.decision === "used").length, 0);
  if (used >= 3) return (past.reduce((a, r) => a + (r.model!.costUsd ?? 0), 0) / used) * pending.length;
  const tokens = pending.reduce((a, p) => a + p.chars, 0) / 4 + 8000;
  return tokens * 3e-6 + 3000 * 15e-6;
}

export async function synthStatus(ctx: Ctx, o: { local: boolean; receipts: RunReceipt[]; automatic: boolean; lastSynthAt: string | null }): Promise<SynthStatus> {
  const where = ctx.team.tracker.kind === "none" ? "off" : synthesizesHere(ctx.team, ctx.personal, ctx.agent) ? "here" : "elsewhere";
  const lastRun = [o.lastSynthAt, ...o.receipts.filter((r) => r.type === "synthesize" && !r.dryRun).map((r) => r.at)].filter(Boolean).sort().pop() ?? null;
  const base: SynthStatus = {
    where, synthesizer: ctx.team.synthesizer, automatic: o.automatic, lastRunAt: lastRun, days: DAYS,
    counts: { meetings: 0, pending: 0, read: 0, held: 0 }, heldBy: [], estimateUsd: null, reason: "", meetings: [],
  };
  if (where === "off") return { ...base, reason: "No task tracker is set up, so PMX makes only your own to-dos, which stay on this Mac." };
  if (where === "elsewhere") return { ...base, reason: `Tasks are suggested on ${ctx.team.synthesizer}, your team's synthesis Mac, so every call is read once for the whole team. This Mac makes your own to-dos.` };

  // The same reading a run does, without the model: which meetings the privacy filter keeps out, and which the team's
  // meeting record has already seen.
  const g = await gather(ctx, { days: DAYS, scope: "team" });
  const entries = await gitMeetingLedger(ctx.repo).list().catch(() => []);
  const plan = planMeetings(g.items, entries, startOfDay(ctx.now(), DAYS));
  const heldMeetings = g.heldList.filter((h) => h.kind === "transcript");
  const pending = plan.fresh.map((f) => f.item);
  const read = plan.already.map((a) => a.item);
  const by = new Map<string, number>();
  for (const h of heldMeetings) by.set(h.rule, (by.get(h.rule) ?? 0) + 1);
  const heldBy = [...by].map(([rule, n]) => ({ rule, label: labelOf(rule), n })).sort((a, b) => b.n - a.n);
  const counts = { meetings: pending.length + read.length + heldMeetings.length, pending: pending.length, read: read.length, held: heldMeetings.length };
  const estimateUsd = estimateCost(pending.map((p) => ({ chars: p.text.length })), o.receipts);
  const heldText = heldBy.map((h) => heldPhrase(h.rule, h.n)).join(", ");

  let reason: string;
  if (!counts.meetings) reason = `No meetings were collected in the last ${DAYS} days, so there's nothing to suggest tasks from yet. The collection task in your Claude app saves them; check it under Health.`;
  else if (counts.pending) reason = `${plural(counts.pending, "customer meeting")} ${counts.pending === 1 ? "hasn't" : "haven't"} been read for tasks yet. ${o.automatic ? "PMX reads them on its next background run, within 30 minutes, or run it now." : "Automatic runs are off, so they wait until you run it."}${estimateUsd != null ? ` Reading them costs ${usd(estimateUsd)}.` : ""}`;
  else if (!counts.read) reason = `PMX checked ${plural(counts.meetings, "meeting")} from the last ${DAYS} days and kept all of them out of tasks: ${heldText}. Tasks come only from calls with someone outside your company; these still give you to-dos, which stay on this Mac.`;
  else reason = `${lastRun ? "The last run" : "PMX"} read ${plural(counts.read, "customer meeting")} from the last ${DAYS} days and found nothing new to suggest.${counts.held ? ` ${plural(counts.held, "other meeting")} ${counts.held === 1 ? "was" : "were"} kept out: ${heldText}.` : ""}`;

  const meetings: SynthMeeting[] = o.local ? [
    ...pending.map((i) => ({ at: i.at, outcome: "pending" as const, title: i.title, rule: null, label: null })),
    ...read.map((i) => ({ at: i.at, outcome: "read" as const, title: i.title, rule: null, label: null })),
    ...heldMeetings.map((h) => ({ at: h.at, outcome: "held" as const, title: null, rule: h.rule, label: labelOf(h.rule) })),
  ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40) : [];
  return { ...base, counts, heldBy, estimateUsd, reason, meetings };
}

/** The status in Terminal, for `pmx proposals` with nothing waiting and for `pmx doctor`. */
export function formatSynthStatus(st: SynthStatus, now: Date): string {
  const ago = (iso: string) => { const h = Math.round((now.getTime() - Date.parse(iso)) / 3600000); return h < 1 ? "less than an hour ago" : h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`; };
  const lines = [`No new tasks are waiting. ${st.reason}`];
  if (st.where !== "here") return lines.join("\n");
  lines.push(`Last synthesis: ${st.lastRunAt ? ago(st.lastRunAt) : "never"}. Last ${st.days} days: ${st.counts.meetings} meeting(s) collected, ${st.counts.read} read for tasks, ${st.counts.pending} not read yet, ${st.counts.held} kept out.`);
  if (st.counts.pending) lines.push(`Read them now: pmx synthesize --since ${new Date(now.getTime() - st.days * 86400000).toISOString().slice(0, 10)}${st.estimateUsd != null ? ` (${usd(st.estimateUsd)})` : ""}`);
  if (!st.automatic) lines.push("Automatic runs are off: `pmx init` turns them on, so PMX suggests tasks every 30 minutes.");
  lines.push("To-dos are different: they come from your own meetings, 1:1s included, and never leave this Mac. Tasks go to Linear only after you approve them.");
  return lines.join("\n");
}

/** This Mac's synthesis receipts from the last two weeks, for the cost estimate and the last run. */
export async function recentReceipts(now = new Date()): Promise<RunReceipt[]> {
  const out: RunReceipt[] = [];
  const since = new Date(now.getTime() - 14 * 86400000).toISOString();
  for (const id of (await listReceipts()).filter((x) => x.includes("synthesize")).slice(0, 60)) {
    const r = await readReceipt(id).catch(() => null);
    if (r?.type === "synthesize" && r.at >= since) out.push(r);
  }
  return out;
}

/**
 * `pmx doctor`'s check (SIG-6): this Mac should be proposing tasks and has meetings to read, but has never done it.
 * Counts transcript files from the last 14 days without reading them. Null when there's nothing to warn about.
 */
export async function neverSynthesized(team: Pick<TeamConfig, "synthesizer" | "tracker">, personal: Pick<PersonalConfig, "handle" | "sources">, agent: string, lastSynthAt: string | null, jobInstalled: boolean, now = new Date()): Promise<string | null> {
  if (!synthesizesHere(team, personal, agent) || lastSynthAt || (await recentReceipts(now)).length) return null;
  const { readdir, stat } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const since = now.getTime() - 14 * 86400000;
  let n = 0;
  for (const dir of personal.sources.transcriptDirs) for (const f of await readdir(dir).catch(() => [] as string[])) {
    if (f.endsWith(".md") && ((await stat(join(dir, f)).catch(() => null))?.mtimeMs ?? 0) >= since) n++;
  }
  if (!n) return null;
  return `${team.tracker.kind === "linear" ? "Linear is connected and " : ""}${n} meeting file(s) were collected in the last 14 days, but this Mac has never suggested a task from them${jobInstalled ? "" : " (automatic runs are off)"}. \`pmx proposals\` says why; \`pmx synthesize\` runs it now. New tasks still wait for your approval.`;
}
