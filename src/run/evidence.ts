import { readFile } from "node:fs/promises";
import type { Ctx } from "../core/context.js";
import { filterItems, segments } from "../core/filter.js";
import { paths } from "../core/paths.js";
import { readReceipt, refHash, type SourceReceipt } from "../core/receipt.js";
import { makeRedactor } from "../core/redact.js";
import type { SignalItem, Task } from "../core/types.js";
import { privacyRules } from "../digest/gather.js";
import { channelInputs } from "../inputs/inputs.js";
import { readThreads, readTranscripts } from "../sources/transcripts.js";

/**
 * The evidence a run gives the agent (RUN-3). A task in Linear names its sources only by ID (`pmx:source T14`), and
 * never says what they said (PRIV-6). The Mac whose synthesis run gave out those IDs still has that run's receipt and
 * the meetings themselves, so it can show the agent the passages behind each ID, screened and redacted exactly as
 * team synthesis would screen them today. Any other Mac has no evidence for the task, and doesn't run it.
 */
export interface Evidence {
  sources: { id: string; kind: "meeting" | "thread"; at: string; passages: string[] }[];
  /** Source IDs with nothing to show here, and why. */
  missing: { id: string; why: string }[];
}

/** The synthesis receipt a task's description names: `pmx explain synthesize-…` (SIG-6). */
export function receiptOf(t: Pick<Task, "description">): string | null {
  return t.description.match(/`pmx explain (synthesize-\d{8}T\d{6}Z)`/)?.[1] ?? null;
}

/** Tasks written before PRIV-6 carried their quotes in the description, as `- [T1] …`. They still run anywhere. */
export function inlineSources(t: Pick<Task, "description">): string[] {
  return [...t.description.matchAll(/^- \[([A-Z]\d+)\] \S/gm)].map((m) => m[1]!);
}

type UsedSource = SourceReceipt & { id: string; at: string };
const usedIn = (sources: SourceReceipt[]) => sources.filter((s): s is UsedSource => s.decision === "used" && !!s.id && !!s.at);

/** Which of the task's source IDs this Mac's receipt knows, without reading any meeting. For the pull policy. */
export async function sourcesHere(t: Pick<Task, "description" | "sources">): Promise<{ receipt: boolean; ids: string[] }> {
  const id = receiptOf(t);
  const r = id ? await readReceipt(id) : null;
  if (!r) return { receipt: false, ids: [] };
  const used = new Set(usedIn(r.sources).map((s) => s.id));
  return { receipt: true, ids: t.sources.filter((s) => used.has(s)) };
}

/** Each source's passages are cut to this, so a long meeting can't crowd out the task. */
const MAX_PASSAGES = 8;
const MAX_PASSAGE = 700;
const MAX_SOURCE = 4000;
const STOP = new Set("about after again also because been before being both could does doing done each from have having into just more most much must only other over same should some such than that their them then there these they this those through very want were what when where which while will with would your".split(" "));
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g)?.filter((w) => !STOP.has(w)) ?? []);

/** The passages most about the task, in the order they were said. A meeting that shares no words with it gives its opening. */
export function pickPassages(text: string, about: string): string[] {
  const want = words(about);
  const segs = segments(text).map((s) => s.trim()).filter(Boolean);
  const scored = segs.map((s, i) => ({ s, i, n: [...words(s)].filter((w) => want.has(w)).length }));
  const best = scored.some((x) => x.n) ? [...scored].filter((x) => x.n).sort((a, b) => b.n - a.n || a.i - b.i) : scored;
  const out: { s: string; i: number }[] = [];
  let size = 0;
  for (const x of best) {
    if (out.length >= MAX_PASSAGES) break;
    const s = x.s.length > MAX_PASSAGE ? `${x.s.slice(0, MAX_PASSAGE).trimEnd()}…` : x.s;
    if (size + s.length > MAX_SOURCE && out.length) break;
    size += s.length;
    out.push({ s, i: x.i });
  }
  return out.sort((a, b) => a.i - b.i).map((x) => x.s);
}

/**
 * Builds the agent's evidence for a task on this Mac. Every passage goes through the team's privacy rules as they are
 * now and through the same redaction as synthesis; a source a rule now leaves out gives nothing. Reads only the PM's
 * allowlisted folders, like synthesis does.
 */
export async function taskEvidence(ctx: Ctx, t: Pick<Task, "title" | "description" | "sources">): Promise<Evidence> {
  const out: Evidence = { sources: [], missing: [] };
  if (!t.sources.length) return out;
  const id = receiptOf(t);
  const r = id ? await readReceipt(id) : null;
  if (!r) {
    out.missing = t.sources.map((s) => ({ id: s, why: "its synthesis run isn't on this Mac" }));
    return out;
  }
  const used = new Map(usedIn(r.sources).map((s) => [s.id, s]));
  const wanted = t.sources.map((s) => ({ id: s, src: used.get(s) }));
  for (const w of wanted) if (!w.src) out.missing.push({ id: w.id, why: "its synthesis run has no source with this ID" });
  const found = wanted.filter((w): w is { id: string; src: UsedSource } => !!w.src);
  if (!found.length) return out;

  // Files are read from a day before the earliest source, so a long backlog of meetings isn't read for nothing.
  const sinceMs = Math.min(...found.map((w) => Date.parse(w.src.at.length === 10 ? `${w.src.at}T00:00:00Z` : w.src.at))) - 2 * 86400000;
  const items: SignalItem[] = [];
  const { team, personal } = ctx;
  if (found.some((w) => w.src.kind === "transcript") && team.allowedSources.includes("transcripts") && personal.sources.transcriptDirs.length)
    items.push(...(await readTranscripts({ dirs: personal.sources.transcriptDirs, sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0 })));
  if (found.some((w) => w.src.kind !== "transcript") && channelInputs(team).length)
    items.push(...(await readThreads({ dir: paths.threads(), sinceMs: Number.isFinite(sinceMs) ? sinceMs : 0 })));
  const byHash = new Map(items.map((i) => [refHash(i.ref), i]));

  const rules = privacyRules(ctx);
  const names = personal.crmNamesFile ? (await readFile(personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : [];
  const redact = makeRedactor(names);
  const about = `${t.title}\n${t.description.replace(/^pmx:\w+ .*$/gm, "")}`;
  for (const w of found) {
    const item = byHash.get(w.src.refHash);
    if (!item) { out.missing.push({ id: w.id, why: "its meeting or thread is no longer in your folders" }); continue; }
    const kept = filterItems([item], rules).kept[0];
    if (!kept) { out.missing.push({ id: w.id, why: "your privacy rules now leave it out" }); continue; }
    // Bracketed IDs inside a passage would read as sources the agent may cite.
    const passages = pickPassages(redact.redact(kept.text), about).map((p) => p.replace(/\[([A-Z]\d+)\]/g, "($1)").replaceAll("</task_data>", "[removed]"));
    if (!passages.length) { out.missing.push({ id: w.id, why: "nothing in it passed your privacy rules" }); continue; }
    out.sources.push({ id: w.id, kind: w.src.kind === "transcript" ? "meeting" : "thread", at: w.src.at.slice(0, 10), passages });
  }
  return out;
}

/** The evidence as the agent reads it, inside the task's data block. Each source is cited by the ID in its heading. */
export function evidenceBlock(e: Evidence): string[] {
  if (!e.sources.length) return [];
  return [
    "## Sources you can cite",
    "",
    "PMX screened and redacted these passages with your team's privacy rules. Cite a source by its ID, like [T1]. Cite nothing else.",
    "",
    ...e.sources.flatMap((s) => [`### [${s.id}] A ${s.kind} on ${s.at}`, "", ...s.passages.flatMap((p) => [p.split("\n").map((l) => `> ${l}`).join("\n"), ""])]),
  ];
}
