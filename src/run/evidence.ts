import { readFile } from "node:fs/promises";
import type { Ctx } from "../core/context.js";
import { filterItems, segments } from "../core/filter.js";
import { paths } from "../core/paths.js";
import { readReceipt, refHash, type SourceReceipt } from "../core/receipt.js";
import { lastPerson, peopleSwap, type KnownPeople } from "../core/people-swap.js";
import { makeRedactor } from "../core/redact.js";
import type { SignalItem, Task } from "../core/types.js";
import { privacyRules } from "../digest/gather.js";
import { channelInputs } from "../inputs/inputs.js";
import { readThreads, readTranscripts } from "../sources/transcripts.js";
import { sourceCompanies } from "./comment.js";
import { knownPeople } from "./known-people.js";
import { evidenceStore, packCompanies, packSources, swappedPack, type EvidenceStore } from "./packs.js";

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
  /**
   * RUN-6: who took part in the quoted sources, as their files list them, for the web guard to keep out of searches;
   * R5: and every name PMX swapped out of the passages, for the tracker guard too. Never shown to the agent and never
   * in an evidence pack.
   */
  people?: string[];
  /**
   * R5: the sources' outside companies, as their participants' email domains name them ("globex"): never a person,
   * however a passage writes them. In the evidence pack too, so a Mac drafting from it knows them.
   */
  companies?: string[];
  /** R5c: the passages went through the name swap, so they name no one and aren't read for people (`sourcePeople`). */
  swapped?: boolean;
}

/**
 * The receipt a task's description names: `pmx explain synthesize-…` (SIG-6), or `pmx explain todo-…` for a to-do the PM
 * moved to the team, whose sources are its to-do run's (R16, TODO-5).
 */
export function receiptOf(t: Pick<Task, "description">): string | null {
  return t.description.match(/`pmx explain ((?:synthesize|todo)-\d{8}T\d{6}Z)`/)?.[1] ?? null;
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
/** A passage cut to MAX_PASSAGE, never inside a bracket, so a placeholder like `[PERSON-2, Globex]` stays whole (R5). */
const clip = (p: string) => {
  if (p.length <= MAX_PASSAGE) return p;
  let s = p.slice(0, MAX_PASSAGE);
  if (s.lastIndexOf("[") > s.lastIndexOf("]")) s = s.slice(0, s.lastIndexOf("["));
  return `${s.trimEnd()}…`;
};

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
    const s = clip(x.s);
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
 *
 * R5 (founder decision 2026-11-26, no people's names in the team repo): every person the task's sources name, found
 * by `namesIn` (participants, speakers, names in the text), on the CRM list, or by email address or @handle, becomes
 * one placeholder for the whole task, with their company where their email's domain gives it: `[PERSON-2, Globex]`
 * (`src/core/people-swap.ts`). The same here as in the pack, so an agent on this Mac drafts from exactly what a
 * teammate's agent gets, and a draft written here can't name people either: it lands in the team repo all the same.
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
  const { listed, known } = await swapLists(ctx);
  // Emails, phone numbers, cards and IDs; the names (the CRM list's among them) are swapped first, one number a person.
  const redact = makeRedactor();
  const about = `${t.title}\n${t.description.replace(/^pmx:\w+ .*$/gm, "")}`;
  const kept: { w: (typeof found)[number]; item: SignalItem; text: string }[] = [];
  for (const w of found) {
    const item = byHash.get(w.src.refHash);
    if (!item) { out.missing.push({ id: w.id, why: "its meeting or thread is no longer in your folders" }); continue; }
    const k = filterItems([item], rules).kept[0];
    if (!k) { out.missing.push({ id: w.id, why: "your privacy rules now leave it out" }); continue; }
    kept.push({ w, item, text: k.text });
  }
  const swap = peopleSwap({
    items: kept.map((k) => ({ participants: k.item.participants ?? [], text: k.text })),
    listed, known, internalDomains: rules.internalDomains, companies: sourceCompanies(t.description, t.title),
    from: lastPerson(kept.map((k) => k.text).join("\n")),
  });
  for (const { w, item, text } of kept) {
    // Bracketed IDs inside a passage would read as sources the agent may cite.
    const passages = pickPassages(redact.redact(swap.swap(text)), about).map((p) => p.replace(/\[([A-Z]\d+)\]/g, "($1)").replaceAll("</task_data>", "[removed]"));
    if (!passages.length) { out.missing.push({ id: w.id, why: "nothing in it passed your privacy rules" }); continue; }
    out.sources.push({ id: w.id, kind: w.src.kind === "transcript" ? "meeting" : "thread", at: w.src.at.slice(0, 10), passages });
    if (item.participants?.length) out.people = [...new Set([...(out.people ?? []), ...item.participants])];
  }
  if (out.sources.length) {
    if (swap.names.length) out.people = [...new Set([...(out.people ?? []), ...swap.names])];
    if (swap.companies.length) out.companies = swap.companies;
    out.swapped = true;
  }
  return out;
}

/**
 * R5a: who this Mac knows by name (`knownPeople`), and the names listed on purpose (the CRM list, the do-not-read
 * people), swapped wherever they are.
 */
export async function swapLists(ctx: Ctx): Promise<{ known: KnownPeople; listed: string[] }> {
  const { personal } = ctx;
  const crm = personal.crmNamesFile ? (await readFile(personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : [];
  const listed = [...crm, ...(personal.neverIngest?.people ?? [])].map((n) => n.trim()).filter((n) => n.length >= 3 && !n.includes("@"));
  return { listed, known: await knownPeople(ctx) };
}

/**
 * R5: passages from a pack written before PMX swapped names (no `nameSwap`), with the names `namesIn` finds in them
 * (speakers and the text; a pack has no participants) swapped the same way, numbered on from any `[PERSON-n]` they
 * have. `companies`: never a person (the pack's own, the task's Sources line). Kept within RUN-3's bounds.
 */
export function swapPassages(sources: Evidence["sources"], companies: string[] = [], lists: { known?: KnownPeople; listed?: string[] } = {}): { sources: Evidence["sources"]; names: string[] } {
  const swap = peopleSwap({ items: sources.map((s) => ({ text: s.passages.join("\n\n") })), companies, ...lists, from: lastPerson(sources.flatMap((s) => s.passages).join("\n")) });
  const out = sources.map((s) => {
    let size = 0;
    const passages: string[] = [];
    for (const p of s.passages.map((x) => clip(swap.swap(x)))) {
      if (size + p.length > MAX_SOURCE && passages.length) break;
      size += p.length;
      passages.push(p);
    }
    return { ...s, passages };
  });
  return { sources: out, names: swap.names };
}

/**
 * The evidence a run on this Mac gives the agent (RUN-3, RUN-5). The Mac that suggested the task quotes its own files,
 * under its privacy rules as they are now. Any other Mac reads the task's evidence pack from the team repo: the same
 * screened passages, written there when the task was approved. `from` says which, for the run's pull request.
 */
export async function runEvidence(ctx: Ctx, t: Pick<Task, "identifier" | "title" | "description" | "sources">, store?: EvidenceStore): Promise<Evidence & { from: "here" | "team" | null }> {
  if (!t.sources.length) return { sources: [], missing: [], from: null };
  if ((await sourcesHere(t)).receipt) return { ...(await taskEvidence(ctx, t)), from: "here" };
  const pack = await (store ?? evidenceStore(ctx.repo)).read(t.identifier).catch(() => null);
  let sources = pack ? packSources(pack, t.sources) : [];
  if (!sources.length) return { ...(await taskEvidence(ctx, t)), from: null };
  const missing = t.sources.filter((id) => !sources.some((s) => s.id === id)).map((id) => ({ id, why: "your team's copy of its quotes doesn't have it" }));
  const companies = packCompanies(pack);
  // R5: a pack from before the name swap still names people until its Mac rewrites it; its agent here never sees them.
  let people: string[] = [];
  if (!swappedPack(pack)) ({ sources, names: people } = swapPassages(sources, [...companies, ...sourceCompanies(t.description, t.title)], await swapLists(ctx)));
  return { sources, missing, from: "team", swapped: true, ...(companies.length ? { companies } : {}), ...(people.length ? { people } : {}) };
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

/**
 * F5 (RUN-5): whether the privacy rules as they are now hold one of a task's sources from team work: taskEvidence left
 * it out for them, not because its file is gone or its run isn't on this Mac.
 */
export const heldNow = (e: Pick<Evidence, "missing">, id: string): boolean =>
  e.missing.some((m) => m.id === id && (m.why === "your privacy rules now leave it out" || m.why === "nothing in it passed your privacy rules"));
