import { readFile } from "node:fs/promises";
import type { Ctx } from "../core/context.js";
import { confidentialCompanies, domainLabel, filterItems, outsideDomains } from "../core/filter.js";
import { paths } from "../core/paths.js";
import { readReceipt, refHash, type RunReceipt, type SourceReceipt } from "../core/receipt.js";
import { cutText, meaningful, namesIn, quoteGuard, sentencesIn, trackerGuard, type QuoteSource, type TextProblem } from "../core/tracker-text.js";
import type { SignalItem } from "../core/types.js";
import { privacyRules } from "../digest/gather.js";
import { channelInputs, meetingSeries } from "../inputs/inputs.js";
import { linedCompanies, sourceCompanies, sourcePeople, sourceThings } from "../run/comment.js";
import { knownThings } from "../run/known-people.js";
import { evidenceStore, packCompanies, packSources, swappedPack } from "../run/packs.js";
import { readThreads, readTranscripts } from "../sources/transcripts.js";
import { CHECKED, companiesOf, mergeSentences, type Proposal } from "./proposals.js";
import { leadWithTitle, PROBLEM_WORDS, STRATEGY_SOURCE, strategyFiles } from "./synthesize.js";

/**
 * R3, R12 (PRIV-6, INPUT-2, APPROVE-1): a task waiting for the PM is checked again when the PM approves it, with the
 * tracker guard and the sentence de-duplication as they are now, against what synthesis checked it against: its
 * sources' people and passages (read again from the PM's folders through its synthesis run), its meetings' titles, the
 * team's approved series, the CRM and do-not-read lists and the released strategy. A task staged by an older PMX, whose
 * rules let more through, so never reaches Linear on those rules.
 */
export interface Recheck {
  /** What Linear gets: the title as staged, and the description without what can't go. */
  title: string;
  description: string;
  /** Why it can't go to Linear at all, in a PM's words ("its title names a person, which Linear never gets"), or null. */
  held: string | null;
  /** What was left out of the description now, in a PM's words ("1 sentence that named a person"), or null. */
  leftOut: string | null;
  /** Why the check against its sources couldn't run in full ("its synthesis run is no longer on this Mac"), or null. */
  unread: string | null;
}

/** What a proposal is checked against. Kept in memory for this approval only, never written. */
interface Against {
  /** Names found in the sources (participants, speakers) and names listed on purpose (the CRM list, do-not-read). */
  people: string[];
  listed: string[];
  titles: string[];
  series: string[];
  meetings: QuoteSource[];
  strategy: QuoteSource[];
  /** Why some or all of the task's own sources couldn't be read again, or null when every one was. */
  unread: string | null;
  /** Synthesis already left something out of this description when it suggested it (its receipt says so). */
  cutBefore: boolean;
  /** F5: confidential companies: the team's confidential domains, and those of its sources held as fundraising. */
  confidential: string[];
  /**
   * D2-1: the companies and products its sources show, and those its Sources line names: never a person after a cue
   * ("Ask Globex for the list"). Undefined when no source of it could be read.
   */
  things?: string[];
  /** R6: the companies this Mac knows from elsewhere (the CRM list's, every source it collected): never a person either. */
  known: string[];
}

/** Files read once per approval, however many tasks it checks. */
type Reads = Map<string, Promise<SignalItem[]>>;

/** The CRM list and the do-not-read people, as synthesis lists them (`gather`). */
async function listedNames(ctx: Pick<Ctx, "personal">): Promise<string[]> {
  const crm = ctx.personal.crmNamesFile ? (await readFile(ctx.personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : [];
  return [...crm, ...(ctx.personal.neverIngest?.people ?? [])].map((n) => n.trim()).filter((n) => n.length >= 3);
}

/**
 * The files a run's receipts name, read again from the PM's allowlisted folders, as synthesis read them: before any
 * filter or redaction, so everyone they name counts. A source the team no longer reads, or whose file is gone, is
 * simply not found.
 */
async function filesOf(ctx: Ctx, receipts: RunReceipt[], reads: Reads): Promise<Map<string, SignalItem>> {
  const { team, personal } = ctx;
  const all = receipts.flatMap((r) => r.sources);
  const day = 86400000;
  // From a couple of days before the earliest run's window and source, so every file it read is read again.
  const dates = [...receipts.map((r) => Date.parse(r.window?.since ?? "")), ...all.map((s) => Date.parse(s.at ?? ""))].filter(Number.isFinite);
  const sinceMs = dates.length ? Math.min(...dates) - 2 * day : 0;
  const read = (key: string, f: () => Promise<SignalItem[]>) => {
    const k = `${key}:${sinceMs}`;
    if (!reads.has(k)) reads.set(k, f().catch(() => []));
    return reads.get(k)!;
  };
  const items: SignalItem[] = [];
  if (all.some((s) => s.kind === "transcript") && team.allowedSources.includes("transcripts") && personal.sources.transcriptDirs.length)
    items.push(...(await read("transcripts", () => readTranscripts({ dirs: personal.sources.transcriptDirs, sinceMs }))));
  if (all.some((s) => s.kind !== "transcript") && channelInputs(team).length) items.push(...(await read("threads", () => readThreads({ dir: paths.threads(), sinceMs }))));
  return new Map(items.map((i) => [refHash(i.ref), i]));
}

async function against(ctx: Ctx, p: Proposal, reads: Reads): Promise<Against> {
  const rules = privacyRules(ctx);
  const internal = rules.internalDomains;
  const listed = await listedNames(ctx);
  const series = meetingSeries(ctx.team);
  const strategy = (await strategyFiles(ctx.personal.repoPath).catch(() => [] as { name: string; text: string }[])).map((f) => ({ id: STRATEGY_SOURCE(f.name), text: f.text }));
  const titles = new Set((p.from ?? []).map((f) => f.title).filter((t): t is string => !!t));
  const own = p.receipt ? await readReceipt(p.receipt).catch(() => null) : null;
  const later = await Promise.all((p.again ?? []).map((a) => readReceipt(a.receipt).catch(() => null)));
  const receipts = [own, ...later].filter((r): r is RunReceipt => !!r);
  const cutBefore = !!own?.synth?.tasks.find((t) => t.posted && "staged" in t.posted && t.posted.staged === p.id)?.leftOut;
  for (const r of receipts) for (const s of r.sources) if (s.decision === "used" && s.kind === "transcript" && s.title) titles.add(s.title);
  // R6: a to-do typed with no meeting behind it still knows the companies this Mac has met ("Ask Hart & Stone for…").
  const known = await knownThings(ctx).catch(() => [] as string[]);
  const base = { listed, series, strategy, cutBefore, titles: [...titles], confidential: confidentialCompanies([], rules), known };

  if (!own) {
    // FOLLOW-1: a follow-up accepted on a Mac without the original's synthesis run reads its team's copy of the quotes,
    // as it did when it was staged (RUN-5).
    // R6: a follow-up to finished work has sources of its own, under its own run's IDs, never its task's pack.
    const draftFollowUp = !!p.follows && p.follows.where !== "done";
    const pack = draftFollowUp && p.sources.length ? await evidenceStore(ctx.repo).read(p.follows!.identifier).catch(() => null) : null;
    // RUN-5: an accept removes the original's pack, so a follow-up keeps its own copy of those quotes; check against it.
    // R5: with the name swap the copy went through, as a pack has its own.
    const kept = !pack && draftFollowUp && p.quotes?.length ? { v: 1 as const, task: p.follows?.identifier ?? "", at: p.at, ...(p.quotesSwap ? { nameSwap: p.quotesSwap } : {}), sources: p.quotes } : null;
    const quoted = pack ? packSources(pack, p.sources) : kept ? packSources(kept, p.sources) : [];
    const missing = p.sources.filter((id) => !quoted.some((s) => s.id === id));
    return {
      ...base,
      // R4: the task's own customer and products are never people, as `run.ts` and `followups.ts` pass them; R5: nor
      // the sources' outside companies its pack lists.
      // R5c: a pack (or the copy a follow-up kept of one) through today's name swap names no one, so its passages aren't
      // read for people.
      people: sourcePeople({ sources: quoted, swapped: swappedPack(pack ?? kept) }, internal, [...sourceCompanies(p.description, p.title), ...packCompanies(pack)]),
      things: sourceThings({ sources: quoted, companies: packCompanies(pack) }, internal, p.description),
      meetings: quoted.map((s) => ({ id: s.id, text: s.passages.join("\n") })),
      unread: !missing.length ? null : draftFollowUp ? `${p.follows!.identifier}'s synthesis run isn't on this Mac, and your team's copy of its quotes doesn't have ${quoted.length ? "all of them" : "them"}` : "its synthesis run is no longer on this Mac",
    };
  }

  // Everyone the run's files name, as synthesis read them: every file its receipts list, used or left out, as `gather`
  // passes the whole batch to `peopleIn`. Quotes are checked against the used ones, which is what Claude read.
  const files = await filesOf(ctx, receipts, reads);
  const found = receipts.flatMap((r) => r.sources.map((s) => ({ s, i: files.get(s.refHash) }))).filter((x): x is { s: SourceReceipt; i: SignalItem } => !!x.i);
  const raw = [...new Map(found.map((x) => [x.s.refHash, x.i])).values()];
  const companies = [...new Set([...raw.flatMap((i) => outsideDomains(i.participants ?? [], internal)), ...internal].map(domainLabel).filter(Boolean))];
  // D2-1: and the words they write as a company or product ("the Globex team", "at Globex"), read in the same pass.
  const orgs = new Set<string>();
  const people = namesIn(raw, companies, { things: orgs }).map((n) => n.name);
  const meetings = found.filter((x) => x.s.decision === "used").map((x) => ({ id: x.s.id ?? "a source", text: x.i.text }));
  const usedHere = new Set(found.filter((x) => x.s.decision === "used" && x.s.id && own.sources.includes(x.s)).map((x) => x.s.id!));
  const missing = p.sources.filter((id) => !usedHere.has(id));
  return {
    ...base,
    people,
    ...(raw.length ? { things: [...companies, ...orgs, ...linedCompanies(p.description)] } : {}),
    // F5: the meetings the run read that team work holds as fundraising or a confidential contact's (an investor's
    // call a to-do came from, say): their companies' names never reach Linear.
    confidential: confidentialCompanies(filterItems(raw, rules).decisions, rules),
    meetings,
    unread: !missing.length ? null : missing.length === p.sources.length ? "its meetings and threads are no longer in your folders" : `${missing.length} of its ${p.sources.length} sources are no longer in your folders`,
  };
}

/** Lines PMX writes itself from what it checked: the sources line, `pmx:` lines, a follow-up's own lines. Never judged again. */
const PMX_LINE = /^(?:pmx:|\*\*(?:Sources:|Based on|Heard again|Follows |Size S, not checked:|Check the size:))/;
/** A line's bold label ("**Why size M:** "), kept when what follows it is judged. */
const LABEL = /^\*\*[^*\n]{1,40}:\*\*\s*/;

const normSentence = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Checks one waiting task again (R3, R12). The title is all or nothing, as in synthesis. The description loses each
 * sentence that can't go and each sentence a later run repeated, and leads with the title when what's left starts
 * mid-thought (R12b). When its sources can't be read again, every check that doesn't need them still runs (the CRM and
 * do-not-read lists, its meetings' titles as it keeps them, the series, fundraising, quotation marks, placeholders,
 * contact details, the released strategy, repeats). A task staged under the current rules (`checked`) then still goes,
 * since those rules already judged it against what it had; one an older PMX staged waits, since only its sources could
 * show what those rules let through.
 */
export async function recheckProposal(ctx: Ctx, p: Proposal, o: { titleOnly?: boolean; reads?: Reads } = {}): Promise<Recheck> {
  const a = await against(ctx, p, o.reads ?? new Map());
  const guard = trackerGuard({ names: a.listed, people: a.people, titles: a.titles, series: a.series, confidential: a.confidential, things: a.things, known: a.known });
  const meetings = quoteGuard(a.meetings);
  const released = quoteGuard(a.strategy);
  const out: Recheck = { title: p.title, description: p.description, held: null, leftOut: null, unread: a.unread };

  const tq = meetings.match(p.title), ts = tq ? null : released.match(p.title);
  if (tq || ts) return { ...out, held: `its title repeats ${tq ? "a meeting" : "your team's released strategy"} word for word, and Linear gets summaries only` };
  const bad = guard.problem(p.title);
  if (bad) return { ...out, held: `its title ${PROBLEM_WORDS[bad]}, which Linear never gets` };
  // Its sources can't be read, and the rules that checked it against them when it was staged were an older PMX's.
  if (a.unread && (p.checked ?? 0) < CHECKED) return { ...out, held: `PMX can't read its sources again to check it (${a.unread}), and an older PMX suggested it, with rules that let more through` };
  if (o.titleOnly) return out;

  let fromMeeting = 0, fromStrategy = 0;
  const problems: TextProblem[] = [];
  const ok = (s: string) => {
    if (meetings.match(s)) { fromMeeting++; return false; }
    if (released.match(s)) { fromStrategy++; return false; }
    const pr = guard.problem(s);
    if (pr) { problems.push(pr); return false; }
    return true;
  };

  const [summary = "", ...rest] = p.description.split("\n\n");
  const said = sentencesIn(summary.replace(/\s+/g, " ").trim());
  // INPUT-2: the sentences later runs added, in order, so they're judged again as a merge would judge them now.
  const groups = (p.again ?? []).map((x) => x.added ?? []).filter((g) => g.length);
  const tail = groups.flat();
  const merged = tail.length > 0 && tail.length < said.length && said.slice(-tail.length).every((s, i) => s === tail[i]);
  const own = merged ? said.slice(0, -tail.length) : said;
  const kept: string[] = [];
  let repeats = 0;
  const seen = new Set<string>();
  for (const s of own.filter(ok)) {
    // The same sentence twice, word for word, is said once.
    if (seen.has(normSentence(s))) { repeats++; continue; }
    seen.add(normSentence(s));
    kept.push(s);
  }
  if (merged) {
    let at = 0;
    for (const g of groups) {
      const passed = said.slice(own.length + at, own.length + (at += g.length)).filter(ok);
      // R12a: a fact said again goes once, the fuller of the two sentences in the other's place.
      const m = passed.length ? mergeSentences(kept, passed, undefined, companiesOf(p)) : null;
      repeats += passed.length - (m?.added.length ?? 0);
      if (m) kept.splice(0, kept.length, ...m.sentences);
    }
  }
  // Nothing left out keeps the summary exactly as staged; otherwise what's left must still be a description.
  let lead = summary;
  if (kept.length !== said.length) {
    lead = kept.join(" ");
    if (!(p.follows && p.follows.where !== "done" ? lead.trim() : meaningful(lead))) return { ...out, held: `nothing in its description can go to Linear (${leftOutText(fromMeeting, fromStrategy, problems, repeats)})` };
  }
  // R12b: once its first sentence is gone (now, or when synthesis suggested it), a summary that refers back to it leads
  // with the title, so it still reads as a whole.
  if (kept[0] !== said[0] || a.cutBefore) lead = leadWithTitle(p.title, lead);
  const lines = judgeRest(rest, ok);
  const n = fromMeeting + fromStrategy + problems.length + repeats;
  if (!n && lead === summary) return out;
  return { ...out, description: [lead, ...lines].join("\n\n"), leftOut: n ? leftOutText(fromMeeting, fromStrategy, problems, repeats) : null };
}

/**
 * The rest of a description after its summary: PMX's own lines as they are, and every other line (the size reasoning,
 * an older PMX's lines) without the sentences that can't go. A line left with nothing is dropped.
 */
function judgeRest(blocks: string[], ok: (s: string) => boolean): string[] {
  const judged = blocks.map((b) => b.split("\n").flatMap((line) => {
    if (!line.trim() || PMX_LINE.test(line)) return [line];
    const label = line.match(LABEL)?.[0] ?? "";
    const body = line.slice(label.length);
    const all = sentencesIn(body);
    const kept = all.filter(ok);
    if (kept.length === all.length) return [line];
    return kept.length ? [`${label}${kept.join(" ")}`] : [];
  }).join("\n"));
  // A paragraph that lost every line goes with them.
  return judged.filter((b, i) => b.trim() || !blocks[i]!.trim());
}

function leftOutText(fromMeeting: number, fromStrategy: number, problems: TextProblem[], repeats: number): string {
  const sent = (n: number, what: string) => `${plural(n, "sentence that", "sentences that")} ${what}`;
  return [
    fromMeeting ? sent(fromMeeting, "repeated a meeting word for word") : "",
    fromStrategy ? sent(fromStrategy, "repeated your team's released strategy word for word") : "",
    problems.length ? cutText(problems) : "",
    repeats ? plural(repeats, "repeated sentence", "repeated sentences") : "",
  ].filter(Boolean).join(", and ");
}
