import { SCHEMA } from "./version.js";
import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ItemDecision, HoldReason, PassageCut } from "./filter.js";
import { TOPICS } from "./filter.js";
import { privateDir, readJson, writeJson } from "./fsutil.js";
import { paths } from "./paths.js";
import type { RedactionKind } from "./redact.js";
import { isThread, type Size } from "./types.js";

/**
 * A run receipt (PRIV-4): how one digest or synthesis run decided what to read, what it left out
 * and why, what was masked, which skills and model ran, and what it cost. `pmx explain` shows it.
 *
 * It lives only in ~/.pmx/receipts (0700 folder, 0600 files) for at most 14 days, and never in git.
 * It never holds what was left out: held sources are a path hash plus the rule, held passages a hash
 * plus the rule. `pmx explain` finds them again in the PM's own files, on screen only.
 */
export interface RunReceipt {
  v: 1;
  id: string;
  type: "digest" | "synthesize" | "todo";
  at: string;
  agent: string;
  dryRun?: boolean;
  outcome: "staged" | "no-signal" | "failed" | "posted" | "dry-run";
  window: { days: number; since: string; scope: "personal" | "team" | "individual" };
  rules: {
    internalDomains: string[];
    requireExternalParticipant: boolean;
    /** Individual to-dos only: 1:1s and internal meetings were allowed (TODO-2). */
    allowOneOnOne?: boolean;
    topicRulesHash: string;
    /** How many entries each do-not-read list has. Never the entries. */
    neverIngest: { people: number; channels: number; meetingTitles: number };
    folders: string[];
    /** F3: the team's approved internal meeting series this run read (team runs only). Team-approved names, not titles. */
    meetingSeries?: string[];
    /** F5: the team's confidential domains this run held from team work (team runs only). Team settings, not people. */
    confidentialDomains?: string[];
  };
  /** Sources that couldn't be read at all, e.g. "Slack: no token in the keychain". */
  skippedSources: string[];
  sources: SourceReceipt[];
  masked: Record<RedactionKind, number>;
  skills: { name: string; version: string; source: "team" | "org" | "bundled" }[];
  /** `calls`: how many Claude calls the run made, where it can be more than one (to-dos, TODO-6); the rest are totals. */
  model: { name: string; runtime: string; tools: string; costUsd: number | null; tokens: number | null; durationMs: number; promptSha256: string; calls?: number } | null;
  digest?: { cited: string[]; removedClaims: number; staged: string };
  /**
   * `heldOver` (SIG-9): needs found beyond the team's task limit, kept on this Mac for the next run. `waiting` (N1):
   * suggestions of one of PMX's kinds of work the team hasn't turned on, kept until it does. `quoted` (N4): what was left
   * out for repeating a source word for word, with the words it shared and which source (a source ID, or the released
   * strategy's file): the PM's own sources' words, on this Mac only, so `pmx explain` can show why.
   */
  synth?: {
    tasks: TaskReceipt[]; skipped: string[]; heldOver?: { title: string; category: string; sources: string[]; rounds: number }[];
    waiting?: { title: string; category: string; sources: string[] }[];
    quoted?: { task: string; part: "title" | "description"; source: string; words: string; skipped: boolean }[];
    /**
     * INPUT-2: open tasks that took a newer figure from this run's other work (`matchFacts`), which no task of this run
     * was matched to: the task, and what changed.
     */
    updated?: (OpenUpdated & { identifier: string })[];
  };
  /** Individual to-dos (TODO-1): what was added, and from which used source. Stays on this Mac. */
  todo?: {
    /** `also`: the other meetings the same commitment was made in (TODO-6). */
    added: { text: string; source: string; due: string | null; also?: string[] }[]; duplicates: number; dropped: string[];
    /**
     * TODO-6: how many batches of meetings it read, and what a later meeting (`by`) did to a to-do an earlier batch
     * found: showed it done (and `why`, when Claude said), showed it overtaken (and `why`: its outcome happened
     * anyway), changed it, or said it again; or PMX found it the same ask as another to-do, kept in the words of
     * `into`. Only "done" and "overtaken" drop one. TODO-8: `stored` is a to-do already on the PM's list, from an email
     * thread read again with new messages: done or overtaken ticks it, and a change is made to it.
     */
    batches?: number; reconciled?: { text: string; how: "done" | "overtaken" | "replaced" | "merged" | "same-ask"; by?: string; why?: string; into?: string; stored?: string }[];
    /**
     * R16 (TODO-5): to-dos from this run the PM moved to the team as product tasks, with the sources each carried (this
     * run's IDs). The task's description names this receipt, so its agent finds those sources here (RUN-3), and the
     * receipt is kept as long as a synthesis run behind a task.
     */
    moved?: { identifier: string; sources: string[]; at: string }[];
  };
  /** Fake confidential items run through this run's own rules in memory (FLOW-3). Each must be held. */
  canaries?: { total: number; held: number; failed: string[] };
  /** Copies of a meeting already in this run, from another recorder or folder, read once (INPUT-2). A count only. */
  twins?: number;
  error?: string;
}

export interface SourceReceipt {
  /** "thread" from 0.21.0: a conversation from an approved channel, through a connector (INPUT-1). */
  kind: "transcript" | "slack" | "thread";
  /** sha256 of the absolute path or permalink, so `pmx explain` can find a left-out file again. */
  refHash: string;
  decision: "used" | "left-out";
  /** Only for used sources: they're cited in the draft anyway. */
  id?: string;
  file?: string;
  title?: string;
  at?: string;
  rule?: HoldReason | "all-passages-held";
  detail: string;
  /** A cut may be only some sentences of a turn (`part`) or a direct reply to a cut (`followUp`); older receipts have neither. */
  passagesCut: PassageCut[];
  passagesUsed: number;
  /** The connector a collected transcript came from (granola, fireflies…), or "file"; "slack" for Slack (FLOW-1). */
  origin?: string;
  /** Slack only: the allowlisted channel ID, from the permalink. */
  channel?: string;
  /** Threads only: the approved place, as the team listed it. */
  place?: string;
  /**
   * Left-out transcripts only: the meeting identity hashes (MEET-1), so the flow view can check that no held
   * meeting ever reached the Linear meeting ledger (FLOW-3). Hashes only; never shown or shared.
   */
  keys?: string[];
  /**
   * N2: a source a later run (this receipt ID) added to a task from this run that was still waiting for approval, under
   * an ID of this run's, so the task's `pmx:source` line, `pmx explain` and its evidence find it here.
   */
  addedFrom?: string;
  /** Team runs: where this meeting stood in the team's meeting ledger (MEET-2). */
  ledger?: { state: "processed-now" | "already-processed" | "in-progress-elsewhere" | "before-window" | "would-process"; entry: string | null };
}

export interface TaskReceipt {
  title: string;
  category: string;
  size: Size;
  sources: string[];
  sizing: Sizing | null;
  /** PRIV-6: what PMX left out of its description, which Linear never gets ("1 sentence that repeated a meeting word for word"). */
  leftOut?: string;
  /**
   * Where it went (FLOW-1): the Linear identifier it was created as (PENDING-… through the Claude relay until
   * the next sync; the flow view resolves it), the existing task it duplicated, or nowhere on a dry run.
   */
  /** `staged`: waiting for the PM's approval as that proposal (APPROVE-1); `dropped`: the PM said no. */
  /** `mergedInto`: the same need as a proposal already waiting, so its sources were added to that one (INPUT-2). */
  /** `todo`: the PM kept it as their own to-do, with that ID, instead of sending it (TODO-5). */
  /**
   * R6: `duplicateOf` with `done` (the day, YYYY-MM-DD): work the team finished recently, heard again, so not suggested.
   * `dropped` with `reason`: why the PM dropped it, in their words (`pmx proposals drop … --reason`), on this Mac only.
   */
  /**
   * INPUT-2 (founder, 2026-11-27): `duplicateOf` with `updated`: an open task the need was heard again for, which took
   * this run's newer facts.
   */
  posted?: { identifier: string } | { duplicateOf: string; done?: string; updated?: OpenUpdated } | { dryRun: true } | { staged: string } | { dropped: true; reason?: string } | { mergedInto: string } | { todo: string };
}

/**
 * INPUT-2: what a later run did to an open task it heard a need again for. `description`: in the backlog or Ready, its
 * description took the newer facts and a comment says what changed; `comment`: an agent was drafting it or its draft was
 * in review (`why`), so only the comment. `changes` as the comment says them ("GPU cost is now 22% over budget (was
 * 18%)."), already through the tracker guard; `sources`: how many of the run's sources were new to it; `queued`: through
 * the Claude relay, so Linear has it at the next sync; `noComment`: the comment couldn't be said within the rules;
 * `figure`: only a newer figure from the run's other work changed it (`matchFacts`), not the same need heard again.
 */
export interface OpenUpdated { how: "description" | "comment"; changes: string[]; sources: number; why?: string; queued?: true; noComment?: true; figure?: true }

export type SizeFlag = "no-reason" | "cell-mismatch" | "count-below" | "count-above";

export interface Sizing {
  /** The rubric cell the model says it matched, e.g. "Themes across 3–8 sources". */
  cell: string | null;
  /** The rubric's own cell for this category and size. */
  expectedCell: string | null;
  why: string;
  /** Deterministic checks that disagree with the model's size. They flag, never block. */
  flags: SizeFlag[];
}

export const refHash = (ref: string) => createHash("sha256").update(ref.startsWith("http") ? ref : resolve(ref)).digest("hex").slice(0, 16);

export const topicRulesHash = () =>
  createHash("sha256").update(Object.values(TOPICS).map((r) => r.source).join("\n")).digest("hex").slice(0, 12);

export function sourceReceipts(decisions: ItemDecision[], titleOf: (t: string) => string): SourceReceipt[] {
  return decisions.map((d) => {
    const channel = isThread(d.item) ? d.item.ref.match(/\/archives\/([A-Z0-9]+)(\/|$)/)?.[1] : undefined;
    const base = {
      kind: d.item.kind, refHash: refHash(d.item.ref), detail: d.detail, passagesCut: d.passages, passagesUsed: d.passagesKept,
      origin: d.item.kind === "slack" ? "slack" : d.item.origin?.source ?? "file", ...(channel ? { channel } : {}), ...(d.item.place ? { place: d.item.place } : {}),
    };
    // Keys let the flow view check that a private meeting never reached the meeting ledger (FLOW-3). A team meeting
    // kept out of the PM's to-dos only because they weren't in it (COLLECT-4) isn't private, and synthesis may read it.
    const keys = d.item.keys?.length && d.rule !== "not-attended" ? { keys: [...d.item.keys, ...(d.item.legacyKeys ?? [])] } : {};
    if (d.decision === "held") return { ...base, decision: "left-out", rule: d.rule, ...keys };
    return { ...base, decision: "used", id: d.item.id, file: d.item.ref.startsWith("http") ? d.item.ref : basename(d.item.ref), title: titleOf(d.item.title), at: d.item.at };
  });
}

export function newReceiptId(type: RunReceipt["type"], at: Date): string {
  return `${type}-${at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}`;
}

const ID = /^(digest|synthesize|todo)-\d{8}T\d{6}Z$/;
const KEEP_DAYS = 14;
// Hourly runs make about 50 receipts a week, so 400 keeps the full 14 days the flow view looks back over.
const KEEP_MAX = 400;

export async function writeReceipt(r: RunReceipt, now = new Date()): Promise<void> {
  await privateDir(paths.home());
  await privateDir(paths.receipts());
  await writeJson(join(paths.receipts(), `${r.id}.json`), r, 0o600);
  await pruneReceipts(now);
}

export async function listReceipts(): Promise<string[]> {
  const names = await readdir(paths.receipts()).catch(() => [] as string[]);
  return names.filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter((id) => ID.test(id)).sort((a, b) => stamp(b).localeCompare(stamp(a)));
}

const stamp = (id: string) => id.split("-").pop()!;

/** `id` must be a listed receipt ID, never a path. */
export async function readReceipt(id: string): Promise<RunReceipt | null> {
  if (!ID.test(id) || !(await listReceipts()).includes(id)) return null;
  const r = await readJson<RunReceipt>(join(paths.receipts(), `${id}.json`));
  // A receipt from a newer pmx is skipped rather than misread (COMPAT-3).
  return r && r.v <= SCHEMA.receipt ? r : null;
}

/** A synthesis run behind a task sent to Linear holds that task's evidence (RUN-3), so it's kept this long. */
const KEEP_EVIDENCE_DAYS = 60;

async function pruneReceipts(now: Date): Promise<void> {
  const ids = await listReceipts();
  const at = (days: number) => new Date(now.getTime() - days * 86400000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const cutoff = at(KEEP_DAYS);
  const evidence = at(KEEP_EVIDENCE_DAYS);
  for (const [i, id] of ids.entries()) {
    if (i < KEEP_MAX && stamp(id) >= cutoff) continue;
    if ((id.startsWith("synthesize-") || id.startsWith("todo-")) && stamp(id) >= evidence && (await feedsTasks(id))) continue;
    await rm(join(paths.receipts(), `${id}.json`), { force: true });
  }
}

const feedsTasks = async (id: string) => {
  const r = await readJson<RunReceipt>(join(paths.receipts(), `${id}.json`));
  // R16: a to-do run whose to-do became a team task holds that task's evidence too.
  return !!r?.synth?.tasks.some((t) => t.posted && "identifier" in t.posted) || !!r?.todo?.moved?.length;
};
