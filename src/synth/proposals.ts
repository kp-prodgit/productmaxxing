import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CANARY_REFUSAL, hasCanary } from "../core/canary.js";
import { startsNow } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { readReceipt, writeReceipt, type SourceReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import type { Size } from "../core/types.js";
import { openThemes, themeNamed } from "./themes.js";
import { shareEvidence, stageShares, type PackQuotes } from "../run/share.js";
import { sentencesIn } from "../core/tracker-text.js";
import { fillable, groupsLine, mergeGroups, type SourceGroup } from "./synthesize.js";
import { doneDay, recentlyDone } from "./done.js";
import { recheckProposal } from "./recheck.js";
import { addsNothing, anchorsIn, anchorsOf, asks, differs, newWords, piecesOf, sameFact, saysMore, sharedCompanies, stem, swapsTerm, tellsApart, withoutDates } from "./repeats.js";

/**
 * Proposed tasks waiting for the PM (APPROVE-1). Synthesis stages what it would write to the tracker here, exactly
 * as it would be written, and nothing reaches the tracker until the PM approves it. The file stays on this Mac:
 * `from` names the meetings by their own titles, for the PM's eyes only, and is never written anywhere else.
 */
export interface Proposal {
  id: string;
  at: string;
  receipt: string;
  title: string;
  description: string;
  category: string;
  size: Size;
  sources: string[];
  from: { id: string; title: string; at: string; why: string }[];
  /**
   * Later runs that heard the same need again (INPUT-2): their receipts and how many sources each added. Their
   * meetings are in `from` too, marked with the receipt they came from.
   */
  again?: {
    receipt: string; at: string; n: number;
    /** N2: the IDs the added sources have in this proposal's own run, and the sentences its description gained. */
    ids?: string[]; added?: string[];
    /** R12a: the sentences of the run that said one of the description's more fully, each now in that one's place. */
    fuller?: string[];
  }[];
  /** N2: the sources line's parts, so a later run's sources join it. Proposals staged before 0.37.0 have none. */
  sourceGroups?: SourceGroup[];
  /**
   * A roadmap theme from the team's memory/engine/themes.json (EQ-38), suggested by synthesis or set by the PM. It
   * becomes a pmx-theme label only if the theme is still open when the PM approves.
   */
  theme?: string;
  /**
   * FOLLOW-1: a follow-up from an accepted draft, not from synthesis: the task whose draft left the question, where that
   * draft is in the team repo, and whether the draft called it blocking or open. Shown as "Follows PMX-12". `draft`: the
   * draft's pull request, when it has one on the web. `more`: how many of the draft's questions stayed in it, over the cap.
   * R6: `where: "done"` is synthesis's own follow-up to work the team finished recently (`done`, the day it was done,
   * YYYY-MM-DD): new work its sources raised since. It has its own sources and run, and no draft path.
   */
  follows?: { identifier: string; path: string; url?: string | null; where: "blocking" | "open" | "done"; draft?: string | null; more?: number; done?: string };
  /**
   * R16: an open task in the tracker that names no sources (a to-do moved to the team), which this suggestion is the
   * same need as. Approving it gives that task this description and its sources instead of making a second task.
   */
  fills?: string;
  /**
   * RUN-5: a follow-up's copy of the quotes it cites, from its original's pack as the accept read it (followUpQuotes),
   * since the accept removes that pack. On this Mac only; it goes with the proposal, and approving it builds its pack.
   */
  quotes?: PackQuotes;
  /**
   * R5: the name swap that copy's passages went through, as a pack's `nameSwap` (`keptQuotes`): approval reads no
   * people out of a swapped copy, as out of a swapped pack.
   */
  quotesSwap?: number;
  /**
   * R3: the version of the tracker rules (`CHECKED`) that checked this text, against the sources it had, when it was
   * staged. Approval checks it again; when its sources can't be read by then, it still goes only if this says those
   * rules were the ones in force now. Proposals staged before this have none, so theirs count as older rules.
   */
  checked?: number;
  /**
   * R3: why approving didn't send it (PRIV-6), in a PM's words, and when. It waits until the PM drops it or keeps it as
   * their own to-do; approving it again checks it again.
   */
  held?: { at: string; why: string };
}

/**
 * The tracker rules' version for `Proposal.checked`. Raise it whenever a change to the guard in src/core/tracker-text.ts
 * (or what synthesis passes it) would catch more in a source than before, so a task staged under the older rules is
 * checked again before it can go without its sources.
 * 2 (D2-1): a name the sources use as someone's ("Dana knows…", "Dana on our side…"), and one after a cue in the text
 * itself ("Ask Dana…").
 */
export const CHECKED = 2;

interface Staged {
  v: 1;
  proposals: Proposal[];
}

export const proposalsFile = () => join(paths.staging(), "proposals.json");

export async function readProposals(): Promise<Proposal[]> {
  return (await readJson<Staged>(proposalsFile()))?.proposals ?? [];
}

async function save(proposals: Proposal[]): Promise<void> {
  await privateDir(paths.staging());
  await writeJson(proposalsFile(), { v: 1, proposals } satisfies Staged, 0o600);
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Adds proposals, skipping any whose title is already waiting. Returns the ones added, with their IDs. */
export async function stageProposals(list: Omit<Proposal, "id">[]): Promise<Proposal[]> {
  return withLock(proposalsFile(), () => stageLocked(list));
}

async function stageLocked(list: Omit<Proposal, "id">[]): Promise<Proposal[]> {
  const all = await readProposals();
  const waiting = new Set(all.map((p) => norm(p.title)));
  const added: Proposal[] = [];
  for (const p of list) {
    if (hasCanary(JSON.stringify(p))) throw new Error(CANARY_REFUSAL);
    if (waiting.has(norm(p.title))) continue;
    const full = { ...p, id: `p${randomBytes(3).toString("hex")}` };
    added.push(full);
    waiting.add(norm(p.title));
  }
  await save([...all, ...added]);
  return added;
}

/** What a later run brings to a proposal still waiting (INPUT-2, N2). */
export interface MoreEvidence {
  /** The later run's receipt. */
  receipt: string;
  /** Its sources, by that run's IDs, for the PM's own view. */
  from: Proposal["from"];
  days: string[];
  /** N2: the later run's summary of the need, already through the tracker guard. Its new facts join the description. */
  rationale?: string;
  /** N2: those sources as the later run's receipt has them, so this proposal's own run learns them under new IDs. */
  sources?: SourceReceipt[];
  /** N2: each source's part of the sources line, by the later run's ID. */
  groups?: Record<string, SourceGroup>;
  /** N2: the Slack permalink a `pmx:source` line carries, by the later run's ID. */
  refs?: Record<string, string>;
  /** When the later run happened (ISO); now when not given. */
  at?: string;
}

/**
 * Adds a later run's sources to a proposal still waiting (INPUT-2). The PM sees every source under the proposal. N2:
 * what Linear would get changes with them: the description gains the later run's new facts (sentences it doesn't
 * already say, through the tracker guard), its Sources line counts the new sources, and each gets a `pmx:source` line,
 * under an ID the proposal's own synthesis run now records too, so `pmx explain` and the drafting agent find it. A
 * proposal from before N2, or whose run is gone, says how many more sources and when instead. False when the proposal
 * is gone (approved or dropped since).
 */
export async function addEvidence(id: string, e: MoreEvidence): Promise<boolean> {
  return withLock(proposalsFile(), () => evidenceLocked(id, e));
}

/** At most this many sentences join a description from one later run, and the summary stays under this many characters. */
const ADD_MAX = 3;
const SUMMARY_MAX = 1500;
const STOP = new Set("about after again also because been before being both could does from have into just more most much must only other over same should some such than that their them then there these they this those through very want were what when where which while will with would your the and for are was".split(" "));
const factWords = (s: string) => new Set((withoutDates(s).toLowerCase().match(/[\p{L}\p{N}$][\p{L}\p{N}$'’.%-]*/gu) ?? []).map((w) => w.replace(/[.'’-]+$/, "")).filter((w) => /\d/.test(w) || (w.length >= 4 && !STOP.has(w))));

/** A sentence's content words, figures aside, stemmed ("internally" and "internal" alike): what it's about rather than what it adds. */
const contentWords = (s: string) => new Set([...factWords(s)].filter((w) => !/\d|\$/.test(w)).map(stem));

/**
 * The same sentence said again in other words, like two "The brief should frame…": most content words of the larger
 * of the two (60%) are in both, compared stemmed, and at least three of them unless they're all the same. A figure or
 * date it adds doesn't make it new; one that differs from the other's ("its close moved to Feb 12" after "… to Jan 29")
 * does (R12a). Short sentences share two words by chance: "Acme's renewal moved" and "Acme's pilot moved" are two facts.
 * So are two that differ by a distinctive term (`swapsTerm`): "lists SSO" and "lists SCIM", "server-side" and
 * "client-side rendering".
 */
export function nearDuplicate(a: string, b: string): boolean {
  if (differs(anchorsOf(a), anchorsOf(b)) || swapsTerm(a, b)) return false;
  const x = contentWords(a), y = contentWords(b);
  if (!x.size || !y.size) return false;
  const shared = [...x].filter((w) => y.has(w)).length;
  const most = Math.max(x.size, y.size);
  return shared / most >= 0.6 && (shared >= 3 || shared === most);
}

/** What a later run's sentences do to a description's summary (INPUT-2, R12a). */
export interface FactMerge {
  /** The summary's sentences after the merge, each fact once (the fuller of two in the other's place), then the new ones. */
  sentences: string[];
  /** The later run's sentences that say something new, in order. */
  added: string[];
  /** The summary's sentences a later one said more fully (`saysMore`), and the sentence now in each one's place. */
  fuller: { was: string; now: string }[];
}

/**
 * The later run's sentences that say something the description doesn't (INPUT-2): fewer than 60% of their words are
 * in it (or fewer than three, and not all), not a near-duplicate of one of its sentences (or of one added before it),
 * and not the same fact in other words (`sameFact`, R12a). `companies`: the companies the task's sources name. A date
 * or figure that differs from the description's is always a new fact, and so is a claim turned around, another company
 * or another question (`tellsApart`). Dates are compared as dates, not as words. A sentence that says one of the
 * description's more fully isn't a new fact either: `mergeFacts` puts it in that one's place.
 */
export function newFacts(description: string, rationale: string, max = SUMMARY_MAX, companies: string[] = []): string[] {
  return mergeFacts(description, rationale, max, companies).added;
}

/** `newFacts`, with what the merge makes of the summary: a later sentence that says one of its facts more fully takes that one's place. */
export function mergeFacts(description: string, rationale: string, max = SUMMARY_MAX, companies: string[] = []): FactMerge {
  const summary = description.split(/\n\n/)[0] ?? "";
  return mergeSentences(sentencesIn(summary.replace(/\s+/g, " ").trim()), sentencesIn(rationale.replace(/\s+/g, " ").trim()), max, companies);
}

/**
 * The same merge, of sentences already split (R12a). Each later sentence:
 *
 * - takes the place of a sentence there that it says more fully (`saysMore`), so the fuller of the two stays;
 * - is compared clause by clause (`byClause`): clauses said again are left out, the rest joins as a sentence of its own,
 *   and a first clause that says a first clause there more fully takes that one's place in its sentence;
 * - else is left out when it says a sentence there again (`nearDuplicate`, `sameFact`) and states no date or figure that
 *   one doesn't, or when most of its words are in the sentences it could repeat; a date or figure only it states is
 *   never left out;
 * - else joins `base` (up to three of them, the summary under `max` characters).
 */
export function mergeSentences(base: string[], later: string[], max = SUMMARY_MAX, companies: string[] = []): FactMerge {
  const said = [...base];
  const out: string[] = [];
  const fuller: FactMerge["fuller"] = [];
  let len = said.join(" ").length;
  const fits = (at: number, now: string) => len + now.length - said[at]!.length <= max;
  const replace = (at: number, now: string) => {
    const was = said[at]!;
    said[at] = now;
    len += now.length - was.length;
    if (at >= base.length) out[at - base.length] = now;
    else {
      const f = fuller.find((r) => r.now === was);
      if (f) f.now = now;
      else fuller.push({ was, now });
    }
  };
  const add = (t: string) => {
    if (out.length >= ADD_MAX || len + t.length + 1 > max) return;
    out.push(t);
    said.push(t);
    len += t.length + 1;
  };
  // Most of its words (and three, or all) are in the sentences it could repeat, and it states no date or figure they don't.
  const spread = (t: string) => {
    const w = [...factWords(t)];
    const have = factWords(said.filter((x) => !tellsApart(x, t, companies)).join(" "));
    const inIt = w.filter((x) => have.has(x)).length;
    return !w.length || (anchorsIn(said.join(" "), t) && inIt / w.length >= 0.6 && (inIt >= 3 || inIt === w.length));
  };
  for (const s of later) {
    if (!factWords(s).size) continue;
    // The sentences it could say again: a different date or figure, a claim turned around, another company, another
    // question or another distinctive term makes it a new fact beside that one, however many words they share.
    const i = said.findIndex((x) => !tellsApart(x, s, companies) && (nearDuplicate(x, s) || sameFact(x, s, companies)));
    const twin = i >= 0 ? said[i]! : null;
    if (twin && saysMore(twin, s)) {
      if (fits(i, s)) replace(i, s);
      continue;
    }
    const c = byClause(said, s, companies, twin);
    if (c.settled && (!c.place || fits(c.place.at, c.place.now))) {
      if (c.place) replace(c.place.at, c.place.now);
      if (c.add && !spread(c.add)) add(c.add);
      continue;
    }
    // Said again as a whole, it still joins when a clause of it says what nothing there does.
    if (twin ? anchorsIn(twin, s) && !c.unmatched : spread(s)) continue;
    add(s);
  }
  return { sentences: said, added: out, fuller };
}

/**
 * What `byClause` makes of a later sentence: whether its clauses settle it, what of it then joins (null: nothing) and a
 * sentence there it changes, and whether a clause of it matches nothing there and brings two words or more none says.
 */
interface ByClause { settled: boolean; add: string | null; place: { at: number; now: string } | null; unmatched: boolean }

/**
 * A later sentence compared clause by clause with the sentences already there (R12a), since a summary's sentence often
 * carries two facts ("Acme will not sign before it has an answer, and its close date moved to Jan 29"). A clause is
 * said again when a clause there says the same fact (`sameFact`, with the companies both sentences name, or
 * `nearDuplicate`) and holds every word of it (`addsNothing`), or, when the whole sentence says one there again
 * (`twin`), when it adds no date or figure and at most one word to that one. Its first clause, when it says a first
 * clause there more fully, takes that one's place ("Vandelay, a $360k pilot, will use the beta…, so the spec…"). What's
 * left joins as a sentence of its own when it can stand as one: the clauses before the first one said again, when all
 * after it are, or the clauses after the last one said again, from one that stands on its own ("; …", ", and its …",
 * ", so the …"). Not settled when none is said again, or what's left can't stand alone: the sentence is then judged
 * whole. A question is always judged whole.
 */
function byClause(said: string[], s: string, companies: string[], twin: string | null): ByClause {
  const whole: ByClause = { settled: false, add: null, place: null, unmatched: false };
  if (asks(s)) return whole;
  const mine = piecesOf(s);
  if (!mine.length) return whole;
  const theirs = said.flatMap((x, at) => (asks(x) ? [] : piecesOf(x).map((p, k) => ({ ...p, at, k, x }))));
  const same = (t: (typeof theirs)[number], c: string) =>
    !tellsApart(t.text, c, companies) && (nearDuplicate(t.text, c) || sameFact(t.text, c, companies, sharedCompanies(t.x, s, companies)));
  const done = mine.map((c) =>
    (!!twin && !tellsApart(twin, c.text, companies) && anchorsIn(twin, c.text) && newWords(twin, c.text) <= 1)
    || theirs.some((t) => same(t, c.text) && addsNothing(t.text, c.text)));
  whole.unmatched = mine.some((c, k) => !done[k] && !theirs.some((t) => same(t, c.text)) && newWords(said.join(" "), c.text) >= 2);
  let place: ByClause["place"] = null;
  const first = mine[0]!;
  const lead = done[0] ? undefined : theirs.find((t) => t.k === 0 && same(t, first.text) && saysMore(t.text, first.text));
  if (lead) {
    place = { at: lead.at, now: `${s.slice(0, first.to)}${lead.x.slice(lead.to)}` };
    done[0] = true;
  }
  if (!done.some(Boolean)) return whole;
  if (done.every(Boolean)) return { ...whole, settled: true, place };
  const k = done.indexOf(false);
  if (k === 0) {
    const j = done.indexOf(true);
    return done.slice(j).every(Boolean) ? { ...whole, settled: true, add: `${s.slice(0, mine[j]!.join).trimEnd().replace(/[,;:]$/, "")}.` } : whole;
  }
  if (!done.slice(k).some(Boolean) && mine[k]!.free) {
    const rest = s.slice(mine[k]!.from).trim();
    return { ...whole, settled: true, add: `${rest.charAt(0).toUpperCase()}${rest.slice(1)}`, place };
  }
  return whole;
}

const SOURCES_LINE_PARTS = /^\*\*Sources:\*\* (.*?)\. They stay on the PM's Mac(.*)$/m;

/**
 * The companies a task's sources name (F14): from its sources line's parts (`call|Acme|customer`), and else from its
 * description's Sources line ("a customer call with Acme (Nov 20)"). R12a's "same company" means one of these.
 */
export function companiesOf(p: Pick<Proposal, "description" | "sourceGroups">, more: SourceGroup[] = []): string[] {
  const fromGroups = [...(p.sourceGroups ?? []), ...more].map((g) => g.key.match(/^call\|([^|]+)\|/)?.[1]).filter((c): c is string => !!c);
  const line = p.description.match(SOURCES_LINE_PARTS)?.[1] ?? "";
  const fromLine = [...line.matchAll(/\bcalls? with ([^;(]+?) \(/g)].map((m) => m[1]!.trim());
  return [...new Set([...fromGroups, ...fromLine])];
}

async function evidenceLocked(id: string, e: MoreEvidence): Promise<boolean> {
  const all = await readProposals();
  const p = all.find((x) => x.id === id);
  if (!p) return false;
  const seen = new Set(p.from.map((f) => `${f.title}|${f.at}`));
  const fresh = e.from.filter((f) => !seen.has(`${f.title}|${f.at}`));
  if (!fresh.length) return true;

  // N2: the proposal's own run learns the new sources, with IDs after its own, so its `pmx:source` lines, `pmx explain`
  // and the drafting agent's evidence (RUN-3, RUN-5) all find them. Only for a synthesis proposal with a Sources line.
  const ids = new Map<string, string>();
  const line = p.description.match(SOURCES_LINE_PARTS);
  const parts = fresh.map((f) => e.groups?.[f.id]).filter((g): g is SourceGroup => !!g);
  // A follow-up to an accepted draft carries its original's lines; R6: one to finished work is synthesis's own.
  const full = !!line && parts.length > 0 && (!p.follows || p.follows.where === "done");
  const r = full && e.sources?.length && p.receipt ? await readReceipt(p.receipt) : null;
  if (r) {
    const top: Record<string, number> = {};
    for (const x of r.sources) { const m = x.id?.match(/^([A-Z])(\d+)$/); if (m) top[m[1]!] = Math.max(top[m[1]!] ?? 0, Number(m[2])); }
    let changed = false;
    for (const f of fresh) {
      const src = e.sources!.find((x) => x.id === f.id && x.decision === "used");
      if (!src) continue;
      const known = r.sources.find((x) => x.decision === "used" && x.id && x.refHash === src.refHash);
      if (known) { ids.set(f.id, known.id!); continue; }
      const prefix = f.id.match(/^[A-Z]/)?.[0] ?? "T";
      const next = `${prefix}${(top[prefix] = (top[prefix] ?? 0) + 1)}`;
      r.sources.push({ ...src, id: next, addedFrom: e.receipt });
      ids.set(f.id, next);
      changed = true;
    }
    if (changed) await writeReceipt(r, e.at ? new Date(e.at) : new Date());
  }
  p.from = [...p.from, ...fresh.map((f) => ({ ...f, id: ids.get(f.id) ?? `${f.id}@${e.receipt}` }))];
  const newIds = [...new Set(fresh.map((f) => ids.get(f.id)).filter((x): x is string => !!x && !p.sources.includes(x)))];
  p.sources = [...p.sources, ...newIds];

  const m = full && e.rationale ? mergeFacts(p.description, e.rationale, SUMMARY_MAX, companiesOf(p, parts)) : null;
  const added = m?.added ?? [];
  const fuller = m?.fuller ?? [];
  if (full && line) {
    // N2: Linear gets the later call's facts and its source, not only that it was heard again.
    const merged = p.sourceGroups ? mergeGroups(p.sourceGroups, parts) : null;
    const said = merged ? groupsLine(merged) : `${line[1]}; ${groupsLine(mergeGroups([], parts))}`;
    if (merged) p.sourceGroups = merged;
    const [summary, ...rest] = p.description.split("\n\n");
    // R12a: a sentence this run said more fully is in the other's place, in an earlier run's added sentences too.
    const lead = fuller.length ? m!.sentences.join(" ") : added.length ? `${summary} ${added.join(" ")}` : summary;
    for (const f of fuller) for (const a of p.again ?? []) if (a.added) a.added = a.added.map((x) => (x === f.was ? f.now : x));
    let d = [lead, ...rest].join("\n\n");
    d = d.replace(SOURCES_LINE_PARTS, (_m, _old: string, tail: string) => `**Sources:** ${said}. They stay on the PM's Mac${tail}`);
    const lines = newIds.map((x) => {
      const from = [...ids].find(([, v]) => v === x)?.[0];
      return `pmx:source ${x}${from && e.refs?.[from] ? ` ${e.refs[from]}` : ""}`;
    });
    p.description = lines.length ? `${d.replace(/\s+$/, "")}${/(^|\n)pmx:source /.test(d) ? "\n" : "\n\n"}${lines.join("\n")}` : d;
  } else {
    // Before N2 (no Sources line, or no parts given), the description says how many more sources and when, never which.
    const more = (p.again ?? []).reduce((a, x) => a + x.n, 0) + fresh.length;
    const days = [...new Set([...(p.description.match(/^\*\*Heard again\*\*.*\(([^)]*)\)\.$/m)?.[1]?.split(", ") ?? []), ...e.days])].sort().join(", ");
    const heard = `**Heard again** in ${more === 1 ? "one more source" : `${more} more sources`} (${days}).`;
    p.description = /^\*\*Heard again\*\*.*$/m.test(p.description)
      ? p.description.replace(/^\*\*Heard again\*\*.*$/m, heard)
      : p.description.replace(/^(\*\*(?:Sources:|Based on)\*\*.*)$/m, `$1\n${heard}`);
  }
  p.again = [...(p.again ?? []), { receipt: e.receipt, at: e.at ?? new Date().toISOString(), n: fresh.length, ...(newIds.length ? { ids: newIds } : {}), ...(added.length ? { added } : {}), ...(fuller.length ? { fuller: fuller.map((f) => f.now) } : {}) }];
  if (hasCanary(JSON.stringify(p))) throw new Error(CANARY_REFUSAL);
  await save(all);
  return true;
}

/** N2: what later runs changed in a proposal, for the PM: "Nov 26: 1 more source (T7), and 2 sentences in the description". */
export function changedText(p: Pick<Proposal, "again">): string | null {
  const ch = (p.again ?? []).filter((a) => a.ids?.length || a.added?.length || a.fuller?.length);
  if (!ch.length) return null;
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const sentences = (n: number) => (n === 1 ? "1 sentence" : `${n} sentences`);
  return ch.map((a) => {
    const what = [a.ids?.length ? `${a.ids.length === 1 ? "1 more source" : `${a.ids.length} more sources`} (${a.ids.join(", ")})` : "", a.added?.length ? `${sentences(a.added.length)} in the description: ${a.added.join(" ")}` : ""].filter(Boolean).join(", and ");
    const fuller = a.fuller?.length ? `said ${sentences(a.fuller.length)} of the description more fully: ${a.fuller.join(" ")}` : "";
    if (!what) return `${day(a.at)}, a later run ${fuller}`;
    return `${day(a.at)}, a later run added ${what}${fuller ? `${/[.!?]$/.test(what) ? "" : "."} It ${fuller}` : ""}`;
  }).join(" · ");
}

/** Proposals matching what the PM typed: an ID, a 1-based number from `pmx proposals`, or "all". */
function pick(all: Proposal[], refs: string[]): { hit: Proposal[]; missing: string[] } {
  if (refs.includes("all") || refs.includes("--all")) return { hit: all, missing: [] };
  const hit: Proposal[] = [];
  const missing: string[] = [];
  for (const r of refs) {
    const p = /^\d+$/.test(r) ? all[Number(r) - 1] : all.find((x) => x.id === r.toLowerCase());
    if (p) { if (!hit.includes(p)) hit.push(p); }
    else missing.push(r);
  }
  return { hit, missing };
}

/** Marks each task in its synthesis receipt, so `pmx explain` and the flow view say what became of it (FLOW-1). */
async function markReceipt(p: Proposal, posted: { identifier: string } | { dropped: true; reason?: string } | { duplicateOf: string; done?: string } | { todo: string }, now: Date): Promise<void> {
  const r = await readReceipt(p.receipt);
  const t = r?.synth?.tasks.find((x) => x.posted && "staged" in x.posted && x.posted.staged === p.id);
  if (!r || !t) return;
  t.posted = posted;
  await writeReceipt(r, now);
}

/**
 * The PM sets, changes or clears a proposal's roadmap theme (EQ-38). Only a theme open in the team's repo now is
 * accepted, spelled as the theme spells it. `null` clears it.
 */
export async function setProposalTheme(repo: string, refs: string[], name: string | null): Promise<{ changed: Proposal[]; missing: string[]; theme: string | null }> {
  const theme = name === null ? null : themeNamed(name, await openThemes(repo));
  if (name !== null && !theme) {
    const open = (await openThemes(repo)).map((t) => t.name);
    throw new Error(open.length ? `"${name}" isn't one of your team's open roadmap themes: ${open.join(", ")}.` : "Your team's repo has no open roadmap themes (memory/engine/themes.json, from PMX Engine's /pmxe-memory).");
  }
  return withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const { hit, missing } = pick(all, refs);
    for (const p of hit) {
      if (theme) p.theme = theme;
      else delete p.theme;
    }
    await save(all);
    return { changed: hit, missing, theme };
  });
}

/** Start now is off for this team (APPROVE-3): a teammate decides what agents take. */
export const START_OFF = "Your team has a teammate decide what agents take, so Start now is off: approve the task and it waits in the backlog until a teammate moves it to Todo in Linear.";

/** R3: records why approving didn't send a proposal, so `pmx proposals` and Needs you say so. It stays waiting. */
export async function holdProposal(id: string, why: string, now = new Date()): Promise<void> {
  await withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const p = all.find((x) => x.id === id);
    if (!p) return;
    p.held = { at: now.toISOString(), why };
    await save(all);
  });
}

/** A task approving didn't send (R3), and why. */
export interface Held { id: string; title: string; why: string }

/**
 * A task approving sent: its new identifier, or (R16, `filled`) the open task without sources it gave this task's
 * description and sources to.
 */
export interface Posted { id: string; identifier: string; title: string; theme?: string; ready: boolean; filled?: true }

/** What the PM is told about a task approving didn't send, with what they can do about it; in Terminal, the command too. */
export const heldText = (h: Held, o: { command?: boolean } = {}) =>
  `${h.title.replace(/[\s.!?]+$/, "")}: ${h.why}. It stays waiting for you: drop it, or keep it as your own to-do${o.command ? ` (\`pmx move ${h.id} private\`)` : ""}`;

/**
 * Writes the chosen proposals to the tracker and takes them off the list. By default each goes to the pool (inbox).
 * `start` is the PM's Start now (APPROVE-3): the same text, created straight in Ready, and only when the team allows it.
 * This is the only way a Ready task is created; synthesis itself only ever stages proposals.
 *
 * R3, R12 (PRIV-6, INPUT-2): each is checked again first, with the tracker guard and the sentence de-duplication as they
 * are now, against its sources (`recheckProposal`). Linear gets the staged text without any sentence that can't go
 * (`checked` says what was left out); a title that can't go, or a description with nothing left, isn't sent and stays
 * waiting with the reason (`held`), and so does a task an older PMX staged whose sources can't be read any more.
 *
 * R6: a task with the title of one the team finished in the last DONE_DAYS days isn't posted either ("already done as
 * PMX-5"), unless it's a follow-up that links that task. R16: a task that `fills` an open task naming no sources gives
 * that task its checked description and sources (`filled`), instead of making a second task with the same need.
 */
export async function approveProposals(ctx: Ctx, svc: Services, refs: string[], o: { start?: boolean } = {}): Promise<{ posted: Posted[]; duplicates: string[]; missing: string[]; unthemed: string[]; notShared: string[]; held: Held[]; checked: string[] }> {
  if (o.start && !startsNow(ctx.team)) throw new Error(START_OFF);
  const all = await readProposals();
  const { hit, missing } = pick(all, refs);
  const held: Held[] = [];
  const checked: string[] = [];
  const reads = new Map();
  // EQ-38: a theme is checked again now, so one held, withdrawn or narrowed since it was suggested never becomes a label.
  const themes = hit.some((p) => p.theme) ? await openThemes(ctx.personal.repoPath) : [];
  const unthemed: string[] = [];
  // Only the same title stops a proposal the PM approved: synthesis already folded repeats in (INPUT-2), and the PM's
  // own decision isn't second-guessed by a fuzzy match.
  const listed = await svc.tracker.list();
  // R6: the same goes for work the team finished lately, whose title synthesis may not have seen (accepted since).
  const recent = await recentlyDone(ctx, listed);
  const finished = new Map(recent.map((d) => [norm(d.title), d]));
  const open = new Map(listed.filter((t) => t.status !== "done" && !recent.some((d) => d.identifier === t.identifier)).map((t) => [norm(t.title), t.identifier]));
  const posted: Posted[] = [];
  const duplicates: string[] = [];
  const done = new Set<string>();
  for (const p of hit) {
    // R16: the open task with no sources it gives its sources to, while it's still open, sourceless and nobody's.
    const target = p.fills ? listed.find((t) => t.identifier === p.fills && fillable(t)) : undefined;
    const same = open.get(norm(p.title));
    const dup = same && same !== target?.identifier ? same : undefined;
    const was = finished.get(norm(p.title));
    const doneDup = was && p.follows?.identifier !== was.identifier ? was : undefined;
    if (dup) {
      duplicates.push(`${p.title} (already ${dup})`);
      await markReceipt(p, { duplicateOf: dup }, ctx.now());
    } else if (doneDup) {
      duplicates.push(`${p.title} (already done as ${doneDup.identifier}, ${doneDay(doneDup.at)})`);
      await markReceipt(p, { duplicateOf: doneDup.identifier, done: doneDup.at }, ctx.now());
    } else if (target) {
      const c = await recheckProposal(ctx, p, { reads });
      if (c.held) {
        held.push({ id: p.id, title: p.title, why: c.held });
        await holdProposal(p.id, c.held, ctx.now());
        continue;
      }
      // Its title, kind and size are the PM's from when they moved it; it gains what agents need to draft it.
      await svc.tracker.rewrite(target.id, { description: c.description });
      if (o.start && target.status !== "ready") await svc.tracker.setStatus(target.id, "ready");
      posted.push({ id: p.id, identifier: target.identifier, title: target.title, ready: o.start || target.status === "ready", filled: true });
      checked.push(`${target.identifier} named no sources, so approving "${p.title}" gave it this task's description and ${p.sources.length === 1 ? "its source" : `its ${p.sources.length} sources`} instead of making a second task`);
      if (c.leftOut) checked.push(`PMX left ${c.leftOut} out of ${target.identifier} when you approved it`);
      if (c.unread) checked.push(`PMX couldn't check ${target.identifier} against its sources again (${c.unread}), so it went as PMX's current rules passed it when it was suggested`);
      await markReceipt(p, { identifier: target.identifier }, ctx.now());
      await stageShares(ctx, [{ identifier: target.identifier, title: target.title, description: c.description, sources: p.sources, follows: null }]);
    } else {
      // R3: what Linear gets is decided now, by today's rules, not by the rules of the PMX that staged it.
      const c = await recheckProposal(ctx, p, { reads });
      if (c.held) {
        held.push({ id: p.id, title: p.title, why: c.held });
        await holdProposal(p.id, c.held, ctx.now());
        continue;
      }
      const theme = p.theme ? themeNamed(p.theme, themes) : null;
      if (p.theme && !theme) unthemed.push(`${p.title}: "${p.theme}" is no longer an open roadmap theme, so it went without one`);
      const t = await svc.tracker.createInbox({ title: c.title, description: c.description, category: p.category, size: p.size, sources: p.sources, ...(theme ? { theme } : {}), ...(o.start ? { ready: true } : {}) });
      posted.push({ id: p.id, identifier: t.identifier, title: t.title, ...(theme ? { theme } : {}), ready: !!o.start });
      if (c.leftOut) checked.push(`PMX left ${c.leftOut} out of ${t.identifier} when you approved it`);
      if (c.unread) checked.push(`PMX couldn't check ${t.identifier} against its sources again (${c.unread}), so it went as PMX's current rules passed it when it was suggested`);
      open.set(norm(p.title), t.identifier);
      await markReceipt(p, { identifier: t.identifier }, ctx.now());
      // RUN-5: the quotes this task cites go to the team repo once it has its identifier, so any PM's agent can draft it.
      // A draft's follow-up may reuse its task's quotes (FOLLOW-1); R6: one to finished work has its own sources.
      await stageShares(ctx, [{ identifier: t.identifier, title: c.title, description: c.description, sources: p.sources, follows: p.follows && p.follows.where !== "done" ? p.follows.identifier : null, quotes: p.quotes ?? null, quotesSwap: p.quotesSwap ?? null }]);
    }
    done.add(p.id);
    // Saved after each one, so a failure halfway never posts the same task twice.
    await withLock(proposalsFile(), async () => save((await readProposals()).filter((x) => !done.has(x.id))));
  }
  // The approval stands whatever happens here: a pack that can't be written yet is tried again, and the PM told once.
  const shared = posted.length && ctx.team.tracker.kind !== "none" ? await shareEvidence(ctx, { say: "answer" }).catch((e: any) => ({ shared: [], notices: [`PMX couldn't share the quotes of ${posted.map((x) => x.identifier).join(", ")} with your team: ${e?.message ?? e}.`] })) : null;
  return { posted, duplicates, missing, unthemed, notShared: shared?.notices ?? [], held, checked };
}

/**
 * What approving did, in a PM's words (APPROVE-1, APPROVE-3): where the tasks went and when an agent takes them. Through
 * the Claude relay a task reaches Linear only at the next sync, and the words say so.
 */
export function approvedText(posted: { identifier: string }[], o: { start: boolean; startNow: boolean }): string {
  if (!posted.length) return "";
  const ids = posted.map((p) => p.identifier).join(", ");
  const one = posted.length === 1;
  const sync = posted.some((p) => p.identifier.startsWith("PENDING-"));
  if (o.start) return `Started ${ids}: ${one ? "it becomes" : "they become"} Ready for agents ${sync ? "in Linear at the next Claude sync" : "now"}, and ${one ? "an agent takes it" : "agents take them"} from there.`;
  if (o.startNow) return `Approved ${ids} for later: ${one ? "it waits" : "they wait"} in your team's backlog in Linear${sync ? " from the next Claude sync" : ""}. When you want an agent on ${one ? "it" : "one"}, move it to Todo in Linear.`;
  return `Approved ${ids}: ${one ? "it goes" : "they go"} to your team's backlog in Linear${sync ? " at the next Claude sync" : ""}. An agent takes ${one ? "it" : "one"} only after a teammate moves it to Todo in Linear.`;
}

/** R6: a drop's reason as it's kept: one line, at most 300 characters. Empty is none. */
export const dropReason = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, 300) : "");

/**
 * Discards proposals the PM says no to (APPROVE-1). R6: `reason`, the PM's own words ("done as PMX-5"), goes with the drop
 * in each one's synthesis receipt, on this Mac only, and `pmx explain` shows it for that run.
 */
export async function dropProposals(refs: string[], now = new Date(), reason?: string): Promise<{ dropped: Proposal[]; missing: string[] }> {
  const why = dropReason(reason);
  const r = await withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const { hit, missing } = pick(all, refs);
    const gone = new Set(hit.map((p) => p.id));
    await save(all.filter((p) => !gone.has(p.id)));
    return { dropped: hit, missing };
  });
  for (const p of r.dropped) await markReceipt(p, { dropped: true, ...(why ? { reason: why } : {}) }, now);
  return r;
}

/**
 * Takes one proposal off the list because the PM kept it as their own to-do instead (TODO-5). Nothing reaches the
 * tracker, and its receipt says where it went. Null when it's no longer waiting.
 */
export async function takeProposal(ref: string): Promise<Proposal | null> {
  return withLock(proposalsFile(), async () => {
    const all = await readProposals();
    const { hit } = pick(all, [ref]);
    const p = hit[0];
    if (!p) return null;
    await save(all.filter((x) => x.id !== p.id));
    return p;
  });
}

/** Records in a proposal's receipt that it became the PM's to-do (TODO-5). */
export function markKept(p: Proposal, todo: string, now = new Date()): Promise<void> {
  return markReceipt(p, { todo }, now);
}

/** One proposal as the PM reviews it: what the tracker gets, then (marked) what only this Mac sees. */
export function formatProposal(p: Proposal, n: number, full: boolean, startNow = false): string {
  const head = `${n}. [${p.id}] ${p.title}  (${p.category}, size ${p.size}${p.theme ? `, theme ${p.theme}` : ""}${p.follows ? `, follows ${p.follows.identifier}` : ""}${p.fills ? `, gives ${p.fills} its sources` : ""})`;
  // R3: a task approving didn't send says why, in the brief list too.
  const notSent = p.held ? [`   Not sent when you approved it: ${p.held.why}. Drop it, or keep it as your own to-do: \`pmx move ${p.id} private\``] : [];
  if (!full) return [head, ...notSent].join("\n");
  const indent = (s: string) => s.split("\n").map((l) => `     ${l}`).join("\n");
  return [
    head,
    ...notSent,
    p.fills
      // R16: approving it gives the open task with no sources this description, so agents can draft it.
      ? `   ${p.fills} is open in Linear but names no sources, so agents can't draft it. Approving this gives ${p.fills} this description, with its sources, in place of its own; its title, kind and size stay:`
      : `   Linear gets this title, the status ${startNow ? "Todo with start, Backlog with approve" : "Backlog"}, labels pmx-status: ${startNow ? "ready with start, inbox with approve" : "inbox"}, pmx-category, pmx-size${p.theme ? `, pmx-theme: ${p.theme}` : ""}, pmx-state (the status's type, which PMX records), no priority or assignee yet, and this description:`,
    indent(p.description),
    "   Only you see this (it stays on this Mac):",
    ...(p.follows?.where === "done" ? [`     · Follows ${p.follows.identifier}: done${p.follows.done ? ` ${doneDay(p.follows.done)}` : ""}; your sources raised this since`] : []),
    ...(p.follows && p.follows.where !== "done" ? [`     · Follows ${p.follows.identifier}: ${p.follows.where === "blocking" ? "a blocking question" : "an open question"} from its accepted draft, ${p.follows.path}${p.follows.more ? ` (${p.follows.more} more ${p.follows.more === 1 ? "question stays" : "questions stay"} there)` : ""}`] : []),
    ...p.from.map((f) => `     · ${f.id} ${f.title} (${f.at.slice(0, 10)}): ${f.why}`),
    ...(changedText(p) ? [`     Changed since it was suggested: ${changedText(p)}`] : []),
  ].join("\n");
}

export function formatProposals(list: Proposal[], full = true, startNow = false): string {
  if (!list.length) return "No new tasks are waiting. `pmx synthesize` suggests some from your recent customer calls.";
  return [
    `${list.length} new task(s) waiting for you. Nothing is in Linear until you approve it.`,
    "",
    ...list.map((p, i) => formatProposal(p, i + 1, full, startNow)).join("\n\n").split("\n"),
    "",
    ...(startNow ? ["Start now (Ready for agents): pmx proposals start <number or ID …> (or --all)"] : []),
    `${startNow ? "Later (to the backlog)" : "Approve"}: pmx proposals approve <number or ID …> (or --all) · Drop: pmx proposals drop <number or ID …> (or --all) [--reason "…"]`,
    ...(list.some((p) => p.theme) ? ["Theme: pmx proposals theme <number or ID> \"<theme>\" (or none)"] : []),
  ].join("\n");
}
