import type { Ctx } from "../core/context.js";
import { totalHeld } from "../core/filter.js";
import { DATA_RULES, dataBlock } from "../core/prompt.js";
import { RunLogStore } from "../core/runlog-store.js";
import { DEFAULT_TEAM, maxTasks, SYNTH_TASKS } from "../core/config.js";
import type { Services } from "../core/services.js";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { newReceiptId, readReceipt, refHash, writeReceipt, type RunReceipt, type SizeFlag, type Sizing, type TaskReceipt } from "../core/receipt.js";
import { parseRubric, type SizeRubric } from "../core/skillcheck.js";
import { categoryMenu, loadSkill, skillBody, SKILL_USES } from "../core/skills.js";
import { updateState } from "../core/state.js";
import { COMPANY_ROLES, SIZES, type CandidateTask, type CompanyRole, type SignalItem, type Size, type Task } from "../core/types.js";
import { CANARY_REFUSAL } from "../core/canary.js";
import { domainLabel } from "../core/filter.js";
import { cutText, isFundraising, meaningful, quoteGuard, sentencesIn, thingsIn, trackerGuard, type TrackerGuard, type TrackerRules } from "../core/tracker-text.js";
import { meetingSeries } from "../inputs/inputs.js";
import { checkBudget, recordSpend } from "../budget/provider.js";
import { gather } from "../digest/gather.js";
import { planMeetings, startOfDay } from "../meetings/ledger.js";
import type { MeetingEntry } from "../tracker/types.js";
import { addEvidence, CHECKED, companiesOf, newFacts, readProposals, stageProposals } from "./proposals.js";
import { doneDay, DONE_DAYS, recentlyDone, sameWords, type DoneTask } from "./done.js";
import { COMMITMENT } from "../todo/todo.js";
import { inlineSources, receiptOf } from "../run/evidence.js";
import { shareEvidence } from "../run/share.js";
import { lookAt, markStore, type TaskMark } from "../lease/marks.js";
import type { LeaseInfo } from "../lease/types.js";
import { followsIn } from "../tracker/mentions.js";
import { applyOpenUpdate, matchFacts, newSources, openStep, planOpenUpdate, updatedRecord, type OpenStep } from "./open-update.js";
import { heldOverBlock, heldSource, heldSourcesIn, isHeldSource, kindWords, nextHeld, nextWaiting, readHeldOver, saveHeldOver, WAIT_DAYS, type HeldNeed } from "./held-over.js";
import { knownBlock, matchKnown, sameTitle, type Known } from "./dedup.js";
import { openThemes, themeBlock, themeNamed, type RoadmapTheme } from "./themes.js";

export interface SynthResult {
  /** Dry run: what would be proposed. `leftOut`: how many sentences of its description Linear wouldn't get (PRIV-6). */
  posted: { identifier: string; title: string; leftOut?: number }[];
  /** Proposed tasks waiting for the PM's approval (APPROVE-1). Nothing reaches the tracker before that. */
  staged: { id: string; title: string; leftOut?: number }[];
  skipped: string[];
  held: number;
  /** SIG-9: needs found beyond the team's task limit, kept on this Mac for the next run. */
  heldOver: number;
  /** N1: suggestions waiting for a kind of work the team hasn't turned on, by kind. */
  waiting?: { kind: string; n: number }[];
  /**
   * INPUT-2 (founder, 2026-11-27): open tasks a need was heard again for that took this run's newer facts: their
   * description and a comment (`description`), or a comment only (`comment`, with why). `queued`: through the Claude
   * relay, Linear has it at the next sync. `figure`: only a newer figure from the run's other work (`matchFacts`).
   */
  updated?: { identifier: string; title: string; how: "description" | "comment"; sources: number; changes: string[]; why?: string; queued?: boolean; figure?: boolean }[];
  /** The meeting ledger (MEET-2): lodged and finished now, already done by someone, claimed elsewhere, before the window. */
  meetings: { processed: { entry: string; tasks: string[] }[]; already: number; busy: number; before: number };
}

/** Model output derived from source text stays on one line, so it can never start a `pmx:` control line. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();


const cellKey = (s: string) => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/**
 * Checks the model's size against the rubric (PRIV-4, sizing): the cell it quotes must be the rubric's
 * cell for that category and size, and countable categories must cite a fitting number of sources.
 * Disagreements are flags for the human at triage; they never drop a task.
 */
export function checkSizing(t: { category: string; size: Size; sources: string[] }, raw: unknown, rubric?: SizeRubric): Sizing {
  const given = raw && typeof raw === "object" ? (raw as { cell?: unknown; why?: unknown }) : {};
  const cell = given.cell ? oneLine(String(given.cell)).slice(0, 200) : null;
  const why = given.why ? oneLine(String(given.why)).slice(0, 300) : "";
  const expectedCell = rubric?.cells[t.category]?.[t.size] ?? null;
  const flags: SizeFlag[] = [];
  if (!why) flags.push("no-reason");
  if (cell && expectedCell && cellKey(cell) !== cellKey(expectedCell)) flags.push("cell-mismatch");
  const range = rubric?.ranges[t.category]?.[t.size];
  if (range) {
    const [min, max] = range;
    if (t.sources.length < min) flags.push("count-below");
    if (max !== null && t.sources.length > max) flags.push("count-above");
  }
  return { cell, expectedCell, why, flags };
}

/**
 * Rules PMX adds to every synthesis prompt, whatever the team's copy of the skill says (PRIV-6): the description is
 * all a teammate sees in the tracker, so it's a summary, never the transcript.
 */
export const OUTPUT_RULES = `## Rules PMX enforces
- \`rationale\` is the task's whole description in the tracker: two to four sentences, in your own words, on what the task needs and why. It may name the customer or partner company as the sources name it, the deal stage, and the dates and deadlines the sources state ("Acme's Dec 8 beta", "renewal due Jan 15"). Never quote a source. Never name a person (an attendee, a speaker or anyone mentioned), a meeting's title, speaker labels (like "Microphone:") or transcript lines, and never write about fundraising: investors, a round, Series A or B, valuation, a term sheet, dilution, the cap table, the option pool or a raise. PMX cuts any sentence that does.
- Give \`companies\`: for each cited source that was with an outside company, \`{"name": "…", "as": "customer" | "prospect" | "partner"}\`, the company as that source names it (in its text, its title or its \`orgs\`). Leave a source out when you aren't sure, and always when the company is an investor or a fund: the tracker then says "an external call". Never invent or guess a company.
- Cite only sources that directly support the task. One source is fine; never add an unrelated one.
- Give \`support\`: an object with one sentence per cited source ID on how that source supports the task. PMX drops any source without one, and any task left with none.`;

/**
 * F3: what PMX adds to the prompt when the batch has meetings from the team's approved internal series, whatever the
 * team's copy of the skill says. They're context, above all for decisions already made.
 */
export const SERIES_RULES = `## Internal meetings your team approved
Items marked internal="team meeting series" are recurring internal meetings your team approved for this (a launch weekly, exec staff, a design review). Read them as context, above all for what the team already decided:
- Never propose a task to decide again what one of them decided. Build on the decision instead, and say it in the rationale without naming the meeting or anyone in it: "An internal meeting settled the beta scope on Nov 25: …".
- A task still needs a customer or partner source, or a clear internal decision to act on. A task whose only sources are these meetings is fine for carrying out a decision (a spec for a scope the team settled, a decision brief for a choice still open with a date) and for launch readiness ("Launch readiness: …"). PMX drops one that is a problem brief, research, a competitive analysis or a validation from internal meetings alone: those need customers.
- Leave them out of \`companies\`: they have no outside company.`;

/** F3: kinds of work that need customers or partners, so a task from internal meetings alone is never one of them. */
export const CUSTOMER_KINDS = ["problem-brief", "research-synthesis", "competitive-analysis", "validation-plan", "validation-readout"];

/**
 * SIG-9: the team's task limit and what to do with the needs beyond it. PMX adds this to every synthesis prompt, so it
 * holds whatever number a team's older copy of the skill still says.
 */
export function limitRules(max: number): string {
  return `## Task limit
- Return at most ${max} ${max === 1 ? "task" : "tasks"} in \`tasks\`, the highest value first. This is your team's limit; it replaces any other number above.
- When you find more distinct needs than that, list the rest in \`heldOver\`, the highest value first: \`{"title": "…", "category": "…", "sources": ["T3"], "why": "…"}\`, where \`why\` is one sentence in your own words on why it matters. PMX keeps them on this Mac and offers them to the next run first. A need goes in one list, never both.`;
}

/**
 * N1 (CAT-8): the kinds of work PMX has that this team hasn't turned on. The menu above lists only the team's, and the
 * team's copy of the skill may still describe another (decision briefs on a team set up before them). A need of one of
 * those waits on the Mac until the team turns it on, instead of being lost or filed as a kind it isn't.
 */
export function kindRules(off: string[]): string {
  if (!off.length) return "";
  return `## Kinds of work your team hasn't turned on
- Use only the category ids listed above for \`category\` in \`tasks\`. Your instructions may also describe ${off.join(", ")}: your team hasn't turned ${off.length === 1 ? "it" : "them"} on.
- Never file a need as another kind to fit it in. When a need is clearly ${off.length === 1 ? `a ${off[0]}` : `one of ${off.join(", ")}`}, list it in \`heldOver\` with that id and its sources: PMX keeps it on this Mac and asks your team to turn the kind on.
`;
}

/** A need found beyond the task limit, before PMX keeps it (SIG-9). `sources` are this run's IDs. */
export interface HeldCandidate { title: string; category: string; why: string; sources: string[] }

/**
 * A waiting suggestion of one of PMX's own kinds of work the team hasn't turned on (CAT-8, N1). `sources` are this
 * run's IDs. It waits on this Mac with the held-over needs until the team turns the kind on.
 */
export type WaitingCandidate = HeldCandidate;

/**
 * N4: a sentence PMX left out of a task (or the whole task, `skipped`) because it repeated a source word for word: the
 * words it shared and which source, for the receipt and `pmx explain`. They're the PM's own sources' words, on this Mac.
 */
export interface QuotedCut { task: string; part: "title" | "description"; source: string; words: string; skipped: boolean }

export const FLAG_TEXT: Record<SizeFlag, string> = {
  "no-reason": "the model gave no reason for this size",
  "cell-mismatch": "the rubric cell it quoted isn't the one for this category and size",
  "count-below": "it cites fewer sources than this size expects",
  "count-above": "it cites more sources than this size expects",
};

/**
 * The released strategy PMX Engine put in team memory (EQ-37, bridge 3 of the join): what the product managers' page
 * shows, merged into `memory/engine/` by a reviewed pull request. Agents draft against it; the tracker never gets it
 * word for word. The README there says what the files are, so it isn't guarded.
 */
export async function releasedStrategy(repo: string): Promise<string[]> {
  return (await strategyFiles(repo)).map((f) => f.text);
}

/** The same files with their names, so a quote of one says which (N4). */
export async function strategyFiles(repo: string): Promise<{ name: string; text: string }[]> {
  const dir = join(repo, "memory", "engine");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".md") && n !== "README.md").sort();
  return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(dir, name), "utf8") })));
}

/** How a quote of the released strategy names its source (N4). */
export const STRATEGY_SOURCE = (name: string) => `your team's released strategy (${name})`;

/** What the tracker guard needs to know about one run's sources (F14): who they name, their titles, the team's series. */
export interface TrackerContext {
  /**
   * Names found in the sources and names listed on purpose (the CRM list, the do-not-read people). D2-1: and the
   * companies and products the sources show (`things`), never a person after a cue.
   */
  people?: { found: string[]; listed: string[]; things?: string[] };
  /** The batch's meetings' titles: never repeated in the tracker. */
  titles?: string[];
  /** The team's approved meeting series (F3): their names are titles too. */
  series?: string[];
  /** F5: confidential companies (`confidentialCompanies`): the team's confidential domains and fundraising meetings'. */
  confidential?: string[];
  /** The batch itself, so a company can be checked against the source that names it, and an internal-only task found. */
  items?: SignalItem[];
}

const words2 = (s: string) => ` ${s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/**
 * F14: the company the model says a source was with, kept only when that source names it: in its title or text, or as
 * its outside email domain ("Acme" for acme.example). An investor (or any role but customer, prospect or partner), a
 * call about fundraising, a person's name or anything the tracker may not say is never kept, and the tracker keeps the
 * role ("an external call").
 */
export function checkCompany(raw: unknown, item: Pick<SignalItem, "title" | "text" | "orgs" | "series">, guard: TrackerGuard = trackerGuard()): { name: string; as: CompanyRole | null } | null {
  const o = raw && typeof raw === "object" ? (raw as { name?: unknown; as?: unknown }) : typeof raw === "string" ? { name: raw } : null;
  if (!o || item.series) return null;
  const name = oneLine(String(o.name ?? "")).replace(/^the\s+/i, "").replace(/[.,]+$/, "");
  if (name.length < 2 || name.length > 60 || !/^[\p{L}\p{N}][\p{L}\p{N} &.,'’+-]*$/u.test(name)) return null;
  const as = (COMPANY_ROLES as readonly string[]).includes(String(o.as)) ? (o.as as CompanyRole) : null;
  if (o.as != null && !as) return null;
  if (guard.problem(name) || isFundraising(item.title)) return null;
  const key = words2(name);
  if (!key.trim()) return null;
  const flat = key.replace(/\s+/g, "");
  const inSource = words2(`${item.title} ${item.text}`).includes(key);
  const inDomain = (item.orgs ?? []).some((d) => {
    const l = domainLabel(d);
    return l.length >= 3 && flat.length >= 3 && (l === flat || l.startsWith(flat) || flat.startsWith(l));
  });
  return inSource || inDomain ? { name, as } : null;
}

/** The tracker guard for one run (F14): the names its sources hold, its meetings' titles and the team's series. */
export function runGuard(t: TrackerContext = {}): TrackerGuard {
  // D2-1: the companies the sources show: their own words for them, and the batch's outside domains.
  const things = t.people?.things || t.items ? [...(t.people?.things ?? []), ...(t.items ?? []).flatMap((i) => i.orgs ?? []).map(domainLabel)] : undefined;
  const rules: TrackerRules = { names: t.people?.listed ?? [], people: t.people?.found ?? [], titles: t.titles ?? [], series: t.series ?? [], confidential: t.confidential ?? [], ...(things ? { things } : {}) };
  return trackerGuard(rules);
}

/** What `parseCandidates` knows about the team besides its kinds of work. */
export interface ParseTeam {
  /** The released strategy (EQ-37), as text or as files with their names (N4: a quote says which). */
  guarded?: (string | { name: string; text: string })[];
  themes?: RoadmapTheme[];
  maxTasks?: number;
  /** N1: PMX's own kinds of work the team hasn't turned on. A suggestion of one waits instead of being dropped. */
  offKinds?: string[];
}

/**
 * Pulls the JSON object out of the model's reply and validates every task against team config. What the tracker may
 * say (F14, PRIV-6): a title that names a person, a meeting or fundraising, quotes, or repeats a source or the team's
 * released strategy (`guarded`) word for word (N4: the quote rule in src/core/tracker-text.ts) skips the task; a
 * rationale loses each sentence that does, or that names a company its sources don't, and the task is skipped only when
 * nothing meaningful is left. A `theme` is kept only when it names one of the team's open roadmap themes (`themes`,
 * EQ-38). A task from the team's internal meeting series alone (F3) is kept only for carrying out a decision or launch
 * readiness. A task or held need of one of PMX's kinds the team hasn't turned on (`offKinds`, N1) waits.
 */
export function parseCandidates(text: string, categories: string[], validIds: Set<string>, rubric?: SizeRubric, sourceText: Map<string, string> = new Map(), team: ParseTeam & TrackerContext = {}): { tasks: CandidateTask[]; skipped: string[]; heldOver: HeldCandidate[]; waiting: WaitingCandidate[]; quoted: QuotedCut[] } {
  const max = Math.min(team.maxTasks ?? SYNTH_TASKS.default, SYNTH_TASKS.max);
  const guard = runGuard(team);
  const byId = new Map((team.items ?? []).map((i) => [i.id, i]));
  // N4: one quote rule, built once per run: the batch's sources, and the released strategy by file.
  const meetings = quoteGuard([...sourceText].map(([id, t]) => ({ id, text: t })));
  const released = quoteGuard((team.guarded ?? []).map((g) => (typeof g === "string" ? { id: "your team's released strategy", text: g } : { id: STRATEGY_SOURCE(g.name), text: g.text })));
  const offKinds = new Set((team.offKinds ?? []).filter((k) => !categories.includes(k)));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Synthesis returned no JSON.");
  const raw = JSON.parse(text.slice(start, end + 1));
  const tasks: CandidateTask[] = [];
  const skipped: string[] = [];
  const quoted: QuotedCut[] = [];
  const all = Array.isArray(raw.tasks) ? raw.tasks : [];
  // SIG-9: tasks past the limit aren't lost: they're held over like the needs the model listed there itself.
  const over = all.slice(max).map((t: any) => ({ title: t?.title, category: t?.category, sources: t?.sources, why: t?.rationale }));
  const { held: heldOver, waiting: heldWaiting } = parseHeld([...over, ...(Array.isArray(raw.heldOver) ? raw.heldOver : [])], categories, validIds, offKinds);
  // N1: suggested tasks first, as the model ranked them, then the needs it held over.
  const waiting: WaitingCandidate[] = [];
  for (const t of all.slice(0, max)) {
    const title = oneLine(String(t.title ?? "")).slice(0, 120);
    // A source counts only with a reason it supports this task (PRIV-6), so an unrelated meeting isn't cited to fill space.
    const support = t.support && typeof t.support === "object" ? (t.support as Record<string, unknown>) : {};
    const cited = [...new Set((Array.isArray(t.sources) ? t.sources : []).map(String).filter((id: string) => validIds.has(id)))] as string[];
    const sources = cited.filter((id) => oneLine(String(support[id] ?? "")).length >= 10);
    let rationale = oneLine(String(t.rationale ?? "")).slice(0, 1000);
    const firstSaid = sentencesIn(rationale)[0];
    if (!title) { skipped.push("untitled task"); continue; }
    if (!categories.includes(t.category)) {
      // N1: one of PMX's own kinds the team hasn't turned on waits on this Mac, and Needs you asks to turn it on.
      if (offKinds.has(t.category) && cited.length) {
        if (!waiting.some((w) => sameTitle(w.title, title) || w.title.toLowerCase() === title.toLowerCase())) waiting.push({ title, category: t.category, why: rationale.slice(0, 300), sources: cited });
        skipped.push(`${title}: ${kindWords(t.category, 1)} isn't a kind of work your team has turned on, so it waits on this Mac until your team does (pmx jobs add ${t.category})`);
      } else skipped.push(`${title}: unknown category ${t.category}`);
      continue;
    }
    if (!SIZES.includes(t.size)) { skipped.push(`${title}: bad size ${t.size}`); continue; }
    if (!sources.length) { skipped.push(`${title}: ${cited.length ? "no source has a reason it supports the task" : "no valid sources"}`); continue; }
    // N4: a title that repeats a source or the strategy skips the task; a description loses only the sentences that do.
    const tm = meetings.match(title), ts = tm ? null : released.match(title);
    if (tm || ts) {
      const hit = (tm ?? ts)!;
      quoted.push({ task: title, part: "title", source: hit.source, words: hit.words, skipped: true });
      skipped.push(`${title}: its title repeats ${tm ? "a meeting" : "your team's released strategy"} word for word, and the tracker gets summaries only`);
      continue;
    }
    const qm = meetings.clean(rationale), qs = released.clean(qm.text);
    const qcut = [...qm.cut, ...qs.cut];
    if (qcut.length) {
      const gone = !meaningful(qs.text);
      for (const c of qcut) quoted.push({ task: title, part: "description", source: c.source, words: c.words, skipped: gone });
      if (gone) { skipped.push(`${title}: its text repeats ${qm.cut.length ? "a meeting" : "your team's released strategy"} word for word, and the tracker gets summaries only`); continue; }
      rationale = qs.text;
    }
    // F14: what the tracker may say. A title is all or nothing; a description loses only the sentences that can't go.
    const bad = guard.problem(title);
    if (bad) { skipped.push(`${title}: its title ${PROBLEM_WORDS[bad]}, which Linear never gets`); continue; }
    const companies: NonNullable<CandidateTask["companies"]> = {};
    const unnamed: string[] = [];
    const given = t.companies && typeof t.companies === "object" ? (t.companies as Record<string, unknown>) : {};
    for (const id of sources) {
      if (given[id] == null) continue;
      const item = byId.get(id);
      const ok = item ? checkCompany(given[id], item, guard) : null;
      if (ok) companies[id] = ok;
      else {
        const n = typeof given[id] === "string" ? given[id] : (given[id] as { name?: unknown })?.name;
        if (typeof n === "string" && oneLine(n).length >= 2) unnamed.push(oneLine(n));
      }
    }
    const kept = new Set(Object.values(companies).map((c) => words2(c.name)));
    const unverified = [...new Set(unnamed.map(words2))].filter((k) => k.trim() && !kept.has(k));
    const clean = guard.clean(rationale);
    let leftOut: CandidateTask["leftOut"];
    let named = 0;
    const left = sentencesIn(clean.text).filter((x) => {
      const hit = unverified.some((k) => words2(x).includes(k));
      if (hit) named++;
      return !hit;
    });
    if (clean.cut.length || named || qcut.length) {
      const sent = (n: number, what: string) => `${n} ${n === 1 ? "sentence that" : "sentences that"} ${what}`;
      const why = [
        qm.cut.length ? sent(qm.cut.length, "repeated a meeting word for word") : "",
        qs.cut.length ? sent(qs.cut.length, "repeated your team's released strategy word for word") : "",
        clean.cut.length ? cutText(clean.cut) : "",
        named ? `${named} ${named === 1 ? "sentence that named a company" : "sentences that named a company"} its sources don't` : "",
      ].filter(Boolean).join(", and ");
      if (!meaningful(left.join(" "))) {
        for (const q of quoted) if (q.task === title) q.skipped = true;
        skipped.push(`${title}: nothing in its description can go to Linear (${why})`);
        continue;
      }
      // Kept: the note goes with the task (the receipt, `pmx explain`, `pmx synthesize`), not among the skipped ones.
      leftOut = { sentences: qm.cut.length + qs.cut.length + clean.cut.length + named, why };
      // R12b: with its first sentence gone, a summary that starts mid-thought leads with the title.
      rationale = left[0] !== firstSaid ? leadWithTitle(title, left.join(" ")) : left.join(" ");
    }
    // F3: internal meetings alone can carry a decision or launch readiness, not a customer need.
    const srcItems = sources.map((id) => byId.get(id));
    if (srcItems.length && srcItems.every((i) => i?.series) && CUSTOMER_KINDS.includes(t.category) && !/^launch readiness:/i.test(rationale)) {
      skipped.push(`${title}: only your team's internal meetings support it, and ${t.category} needs a customer or partner source`);
      continue;
    }
    const dropped = cited.filter((id) => !sources.includes(id));
    if (dropped.length) skipped.push(`${title}: dropped source(s) ${dropped.join(", ")} with no reason they support it`);
    const sizing = checkSizing({ category: t.category, size: t.size, sources }, t.sizing, rubric);
    const sameAs = typeof t.sameAs === "string" && /^[\w-]{2,40}$/.test(t.sameAs) ? t.sameAs : null;
    // R6: a recently done task this is new work after, by the model's word; synthesis checks it says something new.
    const follows = typeof t.follows === "string" && /^[A-Za-z][A-Za-z0-9]*-\d+$/.test(t.follows.trim()) ? t.follows.trim().toUpperCase() : null;
    const theme = themeNamed(t.theme, team.themes ?? []);
    if (t.theme !== undefined && t.theme !== null && !theme) skipped.push(`${title}: kept without a theme, because its theme isn't one of your team's open roadmap themes`);
    tasks.push({
      title, category: t.category, size: t.size as Size, rationale, sources, sizing, support: Object.fromEntries(sources.map((id) => [id, oneLine(String(support[id])).slice(0, 300)])),
      ...(sameAs ? { sameAs } : {}), ...(follows ? { follows } : {}), ...(theme ? { theme } : {}), ...(Object.keys(companies).length ? { companies } : {}), ...(leftOut ? { leftOut } : {}),
    });
  }
  // A need in both lists is a task.
  const isTask = (h: { title: string }) => tasks.some((t) => sameTitle(t.title, h.title) || t.title.toLowerCase() === h.title.toLowerCase());
  for (const h of heldWaiting) if (!waiting.some((w) => sameTitle(w.title, h.title) || w.title.toLowerCase() === h.title.toLowerCase())) waiting.push(h);
  return { tasks, skipped, heldOver: heldOver.filter((h) => !isTask(h)), waiting: waiting.filter((h) => !isTask(h)), quoted };
}

/** Why a title can't go to the tracker, in a PM's words. */
export const PROBLEM_WORDS: Record<import("../core/tracker-text.js").TextProblem, string> = {
  transcript: "carries transcript markup", quote: "quotes someone", placeholder: "has a redaction placeholder", fundraising: "is about fundraising",
  name: "names a person", title: "names a meeting by its title", contact: "has contact details",
  confidential: "names an investor or other confidential contact",
};
/**
 * The held-over needs the model listed (SIG-9), checked like tasks: a known kind of work and at least one real source.
 * One of PMX's kinds the team hasn't turned on (`offKinds`, N1) waits for it instead.
 */
function parseHeld(raw: any[], categories: string[], validIds: Set<string>, offKinds: Set<string> = new Set()): { held: HeldCandidate[]; waiting: WaitingCandidate[] } {
  const held: HeldCandidate[] = [];
  const waiting: WaitingCandidate[] = [];
  for (const h of raw) {
    const title = oneLine(String(h?.title ?? "")).slice(0, 120);
    const sources = [...new Set((Array.isArray(h?.sources) ? h.sources : []).map(String).filter((id: string) => validIds.has(id)))] as string[];
    const to = categories.includes(h?.category) ? held : offKinds.has(h?.category) ? waiting : null;
    if (!title || !to || !sources.length) continue;
    if (to.some((x) => x.title.toLowerCase() === title.toLowerCase())) continue;
    to.push({ title, category: h.category, why: oneLine(String(h?.why ?? "")).slice(0, 300), sources });
  }
  return { held, waiting };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 20", "Nov 18–21", "Nov 28–Dec 2", or with years when they differ. From the sources' own dates. */
export function dateRange(dates: string[]): string {
  const ds = [...new Set(dates.map((d) => d.slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort();
  if (!ds.length) return "";
  const part = (d: string) => { const [y, m, n] = d.split("-").map(Number); return { y: y!, m: m!, d: n! }; };
  const a = part(ds[0]!), b = part(ds.at(-1)!);
  const show = (x: { y: number; m: number; d: number }, year = false) => `${MONTHS[x.m - 1]} ${x.d}${year ? `, ${x.y}` : ""}`;
  if (ds.length === 1) return show(a);
  if (a.y !== b.y) return `${show(a, true)}–${show(b, true)}`;
  return a.m === b.m ? `${MONTHS[a.m - 1]} ${a.d}–${b.d}` : `${show(a)}–${show(b)}`;
}

/** A thread's place, as the tracker may name it: a channel the team approved ("#launch"), never a bare channel ID. */
const placeOf = (i: SignalItem) => {
  const p = i.place ?? (i.title.startsWith("#") ? i.title : null);
  return p && !/^[A-Z0-9]{8,12}$/.test(p) && p.length <= 60 ? p : null;
};

/**
 * F14: the task's sources in words a teammate can read in the tracker: the kind of source, the company, the place and
 * the dates. "a customer call with Acme (Nov 20); 3 threads in #launch (Nov 18–21); an internal team meeting (Nov 25)".
 * Never a meeting's title, a person or a quote: a company only as `checkCompany` kept it, a channel only as the team
 * approved it, and an internal series meeting only as "an internal team meeting".
 */
export function sourceLine(c: Pick<CandidateTask, "sources" | "companies">, items: SignalItem[]): string {
  return groupsLine(sourceGroups(c, items));
}

/**
 * The sources line's parts (N2), kept with a proposal so a later run that adds sources to it can say them all: one per
 * kind of source, company and place, with the words for one and for several (`{n}` for the count) and every date.
 */
export interface SourceGroup { key: string; one: string; many: string; dates: string[] }

export function sourceGroups(c: Pick<CandidateTask, "sources" | "companies">, items: SignalItem[]): SourceGroup[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map<string, SourceGroup>();
  for (const id of c.sources) {
    const i = byId.get(id);
    if (!i) continue;
    let key: string, one: string, many: string;
    if (i.kind === "transcript" && i.series) {
      [key, one, many] = ["internal", "an internal team meeting", "{n} internal team meetings"];
    } else if (i.kind === "transcript") {
      const co = c.companies?.[id];
      if (co?.as) [key, one, many] = [`call|${co.name}|${co.as}`, `a ${co.as} call with ${co.name}`, `{n} ${co.as} calls with ${co.name}`];
      else if (co) [key, one, many] = [`call|${co.name}|`, `a call with ${co.name}`, `{n} calls with ${co.name}`];
      else [key, one, many] = ["call", "an external call", "{n} external calls"];
    } else {
      const place = placeOf(i);
      if (place) [key, one, many] = [`thread|${place}`, `a thread in ${place}`, `{n} threads in ${place}`];
      else [key, one, many] = ["thread", "a thread in an approved channel", "{n} threads in approved channels"];
    }
    const g = groups.get(key) ?? { key, one, many, dates: [] };
    g.dates.push(i.at);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** Two lists of parts as one: a part of the same kind, company and place counts both's sources. */
export function mergeGroups(a: SourceGroup[], b: SourceGroup[]): SourceGroup[] {
  const out = a.map((g) => ({ ...g, dates: [...g.dates] }));
  for (const g of b) {
    const same = out.find((x) => x.key === g.key);
    if (same) same.dates.push(...g.dates);
    else out.push({ ...g, dates: [...g.dates] });
  }
  return out;
}

export function groupsLine(groups: SourceGroup[]): string {
  return groups.map((g) => {
    const when = dateRange(g.dates);
    return `${g.dates.length === 1 ? g.one : g.many.replace("{n}", String(g.dates.length))}${when ? ` (${when})` : ""}`;
  }).join("; ");
}

/**
 * Words a sentence opens with when it leans on the one before it: "This", "They", "Its", "The same", "The full …".
 * Case matters, so "IT admins" isn't "It".
 */
const REFERS_BACK = /^(?:This|That|These|Those|It|Its|They|Their|Them|He|She|His|Her|Such|Also|And|But|However|Instead|Otherwise|The same|The full|The rest|The other|The remaining)\b/;

/**
 * R12b (PRIV-6): when the tracker guard left out a description's first sentence and what's left opens with a word
 * that refers back to it ("The full workflow and a log screen follow at GA"), the description leads with the task's
 * title as a sentence, so it still reads as a whole. The title has passed the same guard and adds no fact of its own;
 * a description that doesn't open that way is left as it is.
 */
export function leadWithTitle(title: string, text: string): string {
  const t = title.replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, "");
  // Already led by it (synthesis did, and approval looks again), or it doesn't start mid-thought: as it is.
  if (!t || text.startsWith(t) || !REFERS_BACK.test(sentencesIn(text)[0] ?? "")) return text;
  return `${t}${/[!?]$/.test(t) ? "" : "."} ${text}`;
}

/** The readable source line in a description, from this version (`**Sources:**`) or before it (`**Based on**`). */
export const SOURCES_LINE = /^\*\*(?:Sources:|Based on)\*\*.*$/m;

/**
 * The task description (PRIV-6, F14): the model's summary, why it's this size, and its sources in words a teammate can
 * read (the kind of source, the company, the channel, the dates), never what they said or what they were called. Which
 * meetings they were stays in the PM's receipt on their Mac. The `pmx:source` lines PMX reads back come last.
 */
export function describe(c: CandidateTask, items: SignalItem[], receiptId?: string, after?: Pick<DoneTask, "identifier" | "at"> | null): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  // R6: a follow-up to work the team finished says which task, and that this is what's new since. Its own sources are
  // cited below, so the line isn't FOLLOW-1's "**Follows PMX-12:**", which lets a draft's follow-up use its task's quotes.
  const follows = after ? [`**Follows ${after.identifier}, done ${doneDay(after.at)}:** this is the new work its sources raised since.`] : [];
  const sz = c.sizing;
  const why = sz
    ? [`**Why size ${c.size}:** ${sz.cell ?? "no rubric cell given"}${sz.why ? `. ${sz.why}` : ""}`, ...sz.flags.map((f) => `**Check the size:** ${FLAG_TEXT[f]}.`), ""]
    : [];
  const line = sourceLine(c, items);
  const based = `**Sources:** ${line || `${c.sources.length} ${c.sources.length === 1 ? "source" : "sources"}`}. They stay on the PM's Mac${receiptId ? `: \`pmx explain ${receiptId}\` there shows them` : ""}.`;
  return [c.rationale, "", ...follows, ...why, based, "", ...c.sources.map((id) => `pmx:source ${id} ${byId.get(id)!.kind === "slack" ? byId.get(id)!.ref : ""}`.trim())].join("\n");
}

/**
 * `pmx synthesize` (SIG-2, SIG-4). Reads team sources with no tools and proposes sized tasks. They wait on this Mac
 * until the PM approves them (APPROVE-1); only then do they go to the PMX project's inbox, and a human triages
 * before anything runs (SEC-2).
 */
export async function synthesize(
  ctx: Ctx, svc: Services,
  o: { days: number; dryRun?: boolean; since?: Date; skipIfNothingNew?: boolean },
): Promise<SynthResult> {
  const g = await gather(ctx, { days: o.days, scope: "team" });
  // Without `since`, the whole `days` window counts; the CLI and the polling step pass `since` (MEET-3).
  const since = o.since ?? startOfDay(ctx.now(), o.days);
  const receipt: RunReceipt = {
    v: 1, id: newReceiptId("synthesize", ctx.now()), type: "synthesize", at: ctx.now().toISOString(), agent: ctx.agent, dryRun: !!o.dryRun,
    outcome: "no-signal", ...g.receipt, skills: [], model: null,
  };
  const result0: SynthResult = { posted: [], staged: [], skipped: [], held: totalHeld(g.held), heldOver: 0, meetings: { processed: [], already: 0, busy: 0, before: 0 } };

  // The team's meeting ledger (MEET-2) lives in the PMX repo (PRIV-7). Markers older versions put in Linear still count.
  const legacy = await svc.tracker.listMeetings().catch(() => [] as MeetingEntry[]);
  const plan = planMeetings(g.items, [...(await svc.meetings.list()), ...legacy.filter((e) => e.status === "done")], since);
  const mark = (item: SignalItem, state: NonNullable<RunReceipt["sources"][number]["ledger"]>["state"], entry: string | null) => {
    const src = receipt.sources.find((x) => x.id === item.id);
    if (src) src.ledger = { state, entry };
  };
  for (const a of plan.already) mark(a.item, "already-processed", a.entry.identifier);
  for (const b of plan.before) mark(b, "before-window", null);
  result0.meetings.already = plan.already.length;
  result0.meetings.before = plan.before.length;

  // SIG-9: needs the last run held over come back first. Their sources join this batch, read again from the PM's
  // folders through today's rules; they never start a run by themselves. N1: suggestions that waited for one of PMX's
  // kinds of work come back once the team has turned it on, and that does start a run, once; the rest wait on.
  const heldFile = await readHeldOver();
  const offKinds = Object.keys(DEFAULT_TEAM.categories).filter((c) => !Object.prototype.hasOwnProperty.call(ctx.team.categories, c));
  const kindOn = (heldFile?.waiting ?? []).filter((w) => Object.prototype.hasOwnProperty.call(ctx.team.categories, w.category)).map((w) => ({ ...w, kindOn: true }));
  const stillWaiting = (heldFile?.waiting ?? []).filter((w) => !Object.prototype.hasOwnProperty.call(ctx.team.categories, w.category));

  // Before anything is claimed or lodged, so a paused budget leaves no meeting half-processed (BUDGET-2).
  if (plan.fresh.length || kindOn.length || (!o.skipIfNothingNew && plan.other.length)) await checkBudget(ctx);
  // Nothing about a meeting goes to Linear: it's claimed with the lease while it's processed, and recorded in the
  // PMX repo once done (PRIV-7).
  const lodged: { item: SignalItem; lease: string }[] = [];
  if (o.dryRun) for (const f of plan.fresh) mark(f.item, "would-process", null);
  else {
    for (const f of plan.fresh) {
      const lease = `meeting-${f.item.keys![0]}`;
      const got = await svc.lease.acquire(lease, ctx.agent, 1800);
      if (!got.ok) {
        mark(f.item, "in-progress-elsewhere", null);
        result0.meetings.busy++;
        continue;
      }
      mark(f.item, "processed-now", null);
      lodged.push({ item: f.item, lease });
    }
  }
  const work = [...plan.other, ...(o.dryRun ? plan.fresh.map((f) => f.item) : lodged.map((l) => l.item))];
  const release = async () => {
    for (const l of lodged) await svc.lease.release(l.lease, ctx.agent).catch(() => false);
  };
  // Polling (MEET-3): with nothing new, no model call and no receipt.
  if (o.skipIfNothingNew && !lodged.length && !(o.dryRun && plan.fresh.length) && !kindOn.length) return result0;
  if (!work.length && !kindOn.length) {
    await writeReceipt(receipt, ctx.now());
    return result0;
  }
  // A meeting another Mac is processing right now stays out, as it does from the rest of this batch (MEET-2).
  const busy = new Set(o.dryRun ? [] : plan.fresh.filter((f) => !lodged.some((l) => l.item === f.item)).map((f) => f.item.id));
  const offeredFile = heldFile ? { ...heldFile, needs: [...heldFile.needs, ...kindOn] } : null;
  const back = await heldSources(ctx, { ...g, items: g.items.filter((i) => !busy.has(i.id)), all: g.items }, offeredFile, o.days, receipt);
  for (const i of back.items) if (!work.some((w) => w.id === i.id)) work.push(i);
  if (!work.length) {
    // N1: the waiting suggestions' sources are no longer readable here, so they're let go; a new source brings them back.
    await release();
    if (!o.dryRun && heldFile) await saveHeldOver({ ...heldFile, waiting: stillWaiting });
    await writeReceipt(receipt, ctx.now());
    return result0;
  }

  const [synthName, sizeName] = SKILL_USES.synthesize;
  const synth = await loadSkill(ctx.personal.repoPath, synthName);
  const rubric = await loadSkill(ctx.personal.repoPath, sizeName);
  receipt.skills = [
    { name: synthName, version: synth.version, source: synth.source },
    { name: sizeName, version: rubric.version, source: rubric.source },
  ];
  const categories = Object.keys(ctx.team.categories);
  const { tag, block } = dataBlock(work);
  // What's already open or waiting, so a need heard again from another source isn't a second task (INPUT-2).
  const listed = await svc.tracker.list();
  // R6: and what the team finished lately (accepted or done in the last DONE_DAYS days), so it isn't suggested again.
  const recent = await recentlyDone(ctx, listed);
  const finished = new Set(recent.map((d) => d.identifier));
  const open = listed.filter((t) => t.status !== "done" && !finished.has(t.identifier));
  const openKnown: Known[] = [
    ...(await readProposals()).map((p) => ({ id: p.id, title: p.title, where: "waiting" as const })),
    ...[...open].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).map((t) => ({ id: t.identifier, title: t.title, where: "tracker" as const })),
  ];
  const known: Known[] = [...openKnown, ...recent.map((d) => ({ id: d.identifier, title: d.title, where: "done" as const, at: d.at }))];
  // EQ-38: the open roadmap themes in the team's repo, from PMX Engine. Most teams have none, and the prompt is unchanged.
  const themes = await openThemes(ctx.personal.repoPath);
  const prompt = [
    skillBody(synth.text),
    "",
    "## Size rubric",
    skillBody(rubric.text),
    "",
    await categoryMenu(ctx.personal.repoPath, ctx.team.categories),
    ...(offKinds.length ? [kindRules(offKinds)] : []),
    OUTPUT_RULES,
    ...(work.some((i) => i.series) ? [SERIES_RULES] : []),
    limitRules(maxTasks(ctx.team)),
    ...(back.offered.length ? [heldOverBlock(back.offered)] : []),
    ...(themes.length ? [themeBlock(themes)] : []),
    knownBlock(known, DONE_DAYS),
    DATA_RULES(tag),
    "",
    block,
  ].join("\n");

  const result = await ctx.runtime.run({ team: ctx.team, cwd: ctx.personal.repoPath, prompt, tools: [], maxTurns: 1 });
  await updateState((s) => recordSpend(s, ctx.personal, ctx.now(), result.costUsd, result.tokens));
  receipt.model = {
    name: ctx.team.model, runtime: ctx.runtime.name, tools: "none: no files, no web, no personal Claude settings",
    costUsd: result.costUsd, tokens: result.tokens, durationMs: result.durationMs, promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
  if (!result.ok) {
    await writeReceipt({ ...receipt, outcome: "failed", error: result.error ?? "unknown" }, ctx.now());
    // Not recorded as done, so the next pass retries these meetings.
    await release();
    throw new Error(`Synthesis run failed: ${result.error ?? "unknown"}`);
  }

  const strategy = await strategyFiles(ctx.personal.repoPath);
  const tctx: TrackerContext = {
    // F14: who the sources name, what the meetings are called and the team's series never reach the tracker.
    people: { found: [...g.people.found, ...back.people.found], listed: g.people.listed, things: [...(g.people.things ?? []), ...(back.people.things ?? [])] }, titles: work.filter((i) => i.kind === "transcript").map((i) => i.title), series: meetingSeries(ctx.team), items: work,
    // F5: nor do investors' and other confidential contacts' names.
    confidential: g.confidential,
  };
  const { tasks, skipped, heldOver, waiting, quoted } = parseCandidates(result.text, categories, new Set(work.map((i) => i.id)), parseRubric(rubric.text), new Map(work.map((i) => [i.id, i.text])), {
    guarded: strategy, themes, maxTasks: maxTasks(ctx.team), offKinds, ...tctx,
  });
  const posted: SynthResult["posted"] = [];
  const bySource = new Map<string, number>();
  // Where each task went, for the receipt and the flow view (FLOW-1).
  const went = new Map<CandidateTask, NonNullable<TaskReceipt["posted"]>>();
  const fresh: CandidateTask[] = [];
  const folded = new Set<CandidateTask>();
  // INPUT-2: open tasks a need was heard again for, with each repeat of it and its line in `skipped`.
  const heard = new Map<string, { task: Task; cands: { c: CandidateTask; at: number }[] }>();
  // R6: follow-ups to recently done tasks, and R16: suggestions that give a sourceless open task its sources.
  const after = new Map<CandidateTask, DoneTask>();
  const fills = new Map<CandidateTask, string>();
  const byId = new Map(work.map((i) => [i.id, i]));
  const fromOf = (c: CandidateTask) => c.sources.map((id) => ({ id, title: byId.get(id)!.title, at: byId.get(id)!.at, why: c.support?.[id] ?? "" }));
  for (const c of tasks) {
    // Two tasks from this run for one need become one: the second's sources go to the first.
    const twin = fresh.find((f) => sameTitle(f.title, c.title));
    if (twin) { twin.sources = [...new Set([...twin.sources, ...c.sources])]; twin.support = { ...c.support, ...twin.support }; folded.add(c); skipped.push(`${c.title}: the same need as "${twin.title}" in this run, so its sources were added there`); continue; }
    // R6: finished work isn't suggested again as new. New work after a done task (the model's `follows`, and something
    // its description doesn't say) is a follow-up that links it; the same work again, by the model's `sameAs` or a title
    // the same or nearly the same as the done task's, is recorded as done and heard again, whatever the prompt got.
    const followed = c.follows ? recent.find((d) => d.identifier === c.follows) ?? null : null;
    // The same fact in other words (R12a's `sameFact`, by the done task's companies) isn't new either.
    const linked = followed && newFacts(followed.description, c.rationale, undefined, companiesOf({ description: followed.description })).length ? followed : null;
    const doneHit = linked ? null : followed ?? doneMatch(c, recent);
    if (doneHit) {
      skipped.push(`${c.title}: done as ${doneHit.identifier} (${doneDay(doneHit.at)}); heard again in ${c.sources.length} source(s)`);
      went.set(c, { duplicateOf: doneHit.identifier, done: doneHit.at });
      continue;
    }
    const hit = matchKnown(c, openKnown);
    // R16: an open task that names no sources (a to-do moved to the team) can't be drafted, so it doesn't cover a need
    // with sources: the sourced version is suggested, and approving it gives that task these sources (APPROVE-1).
    const sourceless = hit?.where === "tracker" ? open.find((t) => t.identifier === hit.id && fillable(t)) : undefined;
    if (hit?.where === "tracker" && !sourceless) {
      const at = skipped.push(`${c.title}: already open as ${hit.id}; heard again in ${c.sources.length} more source(s)`) - 1;
      went.set(c, { duplicateOf: hit.id });
      // INPUT-2: and it may bring the open task newer facts, once every repeat of it in this run is known.
      const t = open.find((x) => x.identifier === hit.id);
      if (t) heard.set(t.identifier, { task: t, cands: [...(heard.get(t.identifier)?.cands ?? []), { c, at }] });
      continue;
    }
    if (hit?.where === "waiting" && !o.dryRun) {
      // N2: the waiting task gains this run's facts (its summary, already through the tracker guard) and its sources.
      const merged = await addEvidence(hit.id, {
        receipt: receipt.id, from: fromOf(c), days: c.sources.map((id) => byId.get(id)!.at.slice(0, 10)), rationale: c.rationale,
        sources: receipt.sources.filter((x) => x.decision === "used" && !!x.id && c.sources.includes(x.id)),
        groups: Object.fromEntries(c.sources.flatMap((id) => sourceGroups({ sources: [id], companies: c.companies }, work).map((gr) => [id, gr] as const))),
        refs: Object.fromEntries(c.sources.filter((id) => byId.get(id)!.kind === "slack").map((id) => [id, byId.get(id)!.ref])), at: ctx.now().toISOString(),
      });
      if (merged) { skipped.push(`${c.title}: the same need as a task already waiting for you, so its sources were added to it`); went.set(c, { mergedInto: hit.id }); continue; }
    }
    if (o.dryRun) { posted.push({ identifier: "(dry run)", title: c.title, ...(c.leftOut ? { leftOut: c.leftOut.sentences } : {}) }); went.set(c, { dryRun: true }); continue; }
    if (linked) after.set(c, linked);
    if (sourceless) fills.set(c, sourceless.identifier);
    fresh.push(c);
  }
  // INPUT-2 (founder, 2026-11-27): an open task heard again takes this run's newer facts, through the tracker guard.
  const { updated, figures } = await updateOpen(ctx, svc, { heard, open, cands: tasks.filter((c) => !folded.has(c)), items: work, receipt, tctx, strategy, dryRun: !!o.dryRun, skipped, went });
  // APPROVE-1: proposals wait on this Mac, exactly as they'd be written, until the PM approves them.
  const staged = await stageProposals(fresh.map((c) => ({
    at: ctx.now().toISOString(), receipt: receipt.id, title: c.title, description: describe(c, work, receipt.id, after.get(c)), category: c.category, size: c.size, sources: c.sources,
    from: fromOf(c), sourceGroups: sourceGroups(c, work), ...(c.theme ? { theme: c.theme } : {}),
    // R6: a follow-up to work the team finished links it, as an accepted draft's follow-ups do (FOLLOW-1).
    ...(after.get(c) ? { follows: { identifier: after.get(c)!.identifier, path: "", url: after.get(c)!.url || null, where: "done" as const, done: after.get(c)!.at } } : {}),
    // R16: approving it gives this open task, which names no sources, its description and sources.
    ...(fills.get(c) ? { fills: fills.get(c)! } : {}),
    // R3: checked by this PMX's tracker rules, which approval relies on if it can't read the sources again.
    checked: CHECKED,
  })));
  for (const c of fresh) {
    const s = staged.find((p) => p.title === c.title);
    if (!s) { skipped.push(`${c.title}: already waiting for your approval`); continue; }
    went.set(c, { staged: s.id });
    for (const id of c.sources) bySource.set(id, (bySource.get(id) ?? 0) + 1);
  }
  // Record each meeting as done in the team's ledger (MEET-2), with only how many tasks it led to.
  for (const l of lodged) {
    const made = bySource.get(l.item.id) ?? 0;
    await svc.meetings.done({ keys: l.item.keys!, at: l.item.at.slice(0, 10), agent: ctx.agent, tasks: made });
    result0.meetings.processed.push({ entry: l.item.keys![0]!, tasks: [] });
  }
  await release();

  receipt.outcome = o.dryRun ? "dry-run" : staged.length ? "staged" : "posted";
  // SIG-9: what's kept for the next run. A need already on the list, or suggested now, isn't held.
  const keep = heldOver.filter((h) => !matchKnown(h, known) && !fresh.some((f) => sameTitle(f.title, h.title)));
  const next = nextHeld(keep.map((h) => ({ title: h.title, category: h.category, why: h.why, sources: h.sources.map((id) => heldSource(byId.get(id)!)) })), heldFile?.needs ?? [], ctx.now().toISOString());
  for (const d of next.dropped) skipped.push(`${d.title}: held over ${d.rounds - 1} runs in a row, so it's let go; a new source raising it brings it back`);
  // N1: what waits for a kind of work the team hasn't turned on, until it does.
  const wait = nextWaiting(waiting.map((h) => ({ title: h.title, category: h.category, why: h.why, sources: h.sources.map((id) => heldSource(byId.get(id)!)) })), stillWaiting, ctx.now().toISOString());
  for (const d of wait.dropped) skipped.push(`${d.title}: waited ${WAIT_DAYS} days for your team to turn on ${kindWords(d.category)}, so it's let go; a new source raising it brings it back`);
  if (!o.dryRun) await saveHeldOver({ v: 1, at: ctx.now().toISOString(), receipt: receipt.id, readSince: back.readSince, needs: next.needs, waiting: wait.waiting });
  receipt.synth = {
    tasks: tasks.filter((c) => !folded.has(c)).map((c) => ({ title: c.title, category: c.category, size: c.size, sources: c.sources, sizing: c.sizing ?? null, ...(c.leftOut ? { leftOut: c.leftOut.why } : {}), ...(went.get(c) ? { posted: went.get(c) } : {}) })), skipped,
    ...(next.needs.length ? { heldOver: next.needs.map((n) => ({ title: n.title, category: n.category, sources: keep.find((h) => h.title === n.title)?.sources ?? [], rounds: n.rounds })) } : {}),
    ...(waiting.length ? { waiting: waiting.map((w) => ({ title: w.title, category: w.category, sources: w.sources })) } : {}),
    ...(quoted.length ? { quoted } : {}),
    ...(figures.length ? { updated: figures } : {}),
  };
  await writeReceipt(receipt, ctx.now());
  if (!o.dryRun) {
    await updateState((s) => (s.lastSynthAt = ctx.now().toISOString()));
    await new RunLogStore(ctx).record({
      type: "synthesize", agent: ctx.agent, machine: ctx.personal.machineId, receipt: receipt.id, posted: staged.length, held: totalHeld(g.held),
      durationMs: result.durationMs, tokens: result.tokens, costUsd: result.costUsd,
    });
  }
  const kinds = new Map<string, number>();
  for (const w of o.dryRun ? [...stillWaiting, ...waiting] : wait.waiting) kinds.set(w.category, (kinds.get(w.category) ?? 0) + 1);
  const cutFrom = (title: string) => fresh.find((c) => c.title === title)?.leftOut?.sentences;
  return { ...result0, posted, staged: staged.map((p) => ({ id: p.id, title: p.title, ...(cutFrom(p.title) ? { leftOut: cutFrom(p.title) } : {}) })), skipped, heldOver: next.needs.length, waiting: [...kinds].map(([kind, n]) => ({ kind, n })), ...(updated.length ? { updated } : {}) };
}

/**
 * INPUT-2 (founder decision, KP 2026-11-27; src/synth/open-update.ts): each open task this run heard a need again for
 * takes the run's newer facts, and (rig test of #127) so does an open task a newer figure from the run's other work is
 * about, whether or not synthesis matched a need to it (`matchFacts`): in the backlog or Ready, its description and a
 * comment; while an agent drafts it or its draft is in review, a comment only; done or canceled, nothing. Every changed
 * sentence goes through the run's tracker guard (with the task's own companies as things, never people) and quote
 * rule. The receipt records it with the task heard again (`posted.updated`), or for a newer figure alone in
 * `synth.updated`, and the run's answer says "updated PMX-46 with newer facts from 2 sources" (or "with a newer figure
 * from a new source") in place of "heard again". A repeat's line counts only the sources new to the task ("heard again
 * (no new sources)"). A dry run says what a real run would do and writes nothing. A task whose update fails stays heard
 * again.
 */
async function updateOpen(ctx: Ctx, svc: Services, o: {
  heard: Map<string, { task: Task; cands: { c: CandidateTask; at: number }[] }>; open: Task[]; cands: CandidateTask[]; items: SignalItem[]; receipt: RunReceipt;
  tctx: TrackerContext; strategy: { name: string; text: string }[]; dryRun: boolean; skipped: string[]; went: Map<CandidateTask, NonNullable<TaskReceipt["posted"]>>;
}): Promise<{ updated: NonNullable<SynthResult["updated"]>; figures: NonNullable<NonNullable<RunReceipt["synth"]>["updated"]> }> {
  const out: NonNullable<SynthResult["updated"]> = [];
  const figures: NonNullable<NonNullable<RunReceipt["synth"]>["updated"]> = [];
  // An agent's claim and the team's marks (PULL-14): what this Mac's copy of Linear may not show yet. Read once, and
  // only when an update would be written, since the marks are fetched from the team repo.
  let seen: { leases: LeaseInfo[]; marks: Map<string, TaskMark>; look: Awaited<ReturnType<typeof lookAt>> } | null = null;
  const team = async () => (seen ??= {
    leases: await svc.lease.list().catch(() => [] as LeaseInfo[]),
    marks: await markStore(ctx.repo).list().catch(() => new Map<string, TaskMark>()),
    look: await lookAt(ctx, svc.tracker),
  });
  const meetings = quoteGuard(o.items.map((i) => ({ id: i.id, text: i.text })));
  const released = quoteGuard(o.strategy.map((f) => ({ id: STRATEGY_SOURCE(f.name), text: f.text })));
  const queued = svc.tracker.kind === "claude-relay";
  const gone = new Set<number>();
  // Its new sources get IDs in its own synthesis run, when that's here; a draft's follow-up cites its original's.
  const runs = new Map<string, RunReceipt | null>();
  const ownOf = async (t: Task) => {
    if (!runs.has(t.identifier)) { const id = followsIn(t.description) ? null : receiptOf(t); runs.set(t.identifier, id ? await readReceipt(id).catch(() => null) : null); }
    return runs.get(t.identifier)!;
  };
  // A repeat counts only the sources new to the task: its own run says which files its sources are.
  for (const [identifier, h] of o.heard) {
    const own = await ownOf(h.task);
    for (const x of h.cands) {
      const n = newSources(h.task, x.c.sources, o.receipt, own, o.items).length;
      o.skipped[x.at] = `${x.c.title}: already open as ${identifier}; ${n ? `heard again in ${n} more source(s)` : "heard again (no new sources)"}`;
    }
  }
  // A newer figure from the run's other work goes to the open task it's about, matched or not.
  const { facts, left } = matchFacts({ tasks: o.open, cands: o.cands, heard: new Map([...o.heard].map(([id, h]) => [id, h.cands.map((x) => x.c)])), items: o.items, now: ctx.now() });
  // A task that states the same older figure but isn't plainly about the same measure is left, and the answer says so.
  const said = new Set<string>();
  for (const l of left) {
    if (facts.has(l.identifier) || said.has(l.identifier)) continue;
    said.add(l.identifier);
    o.skipped.push(`${l.identifier}: also says ${l.was} where this run brought a newer figure ("${l.sentence}"), but PMX left it: its sentence isn't plainly about the same measure (another subject, unit, date or company)`);
  }
  const targets = new Map<string, Task>([...[...o.heard.values()].map((h) => [h.task.identifier, h.task] as const), ...[...facts.keys()].map((id) => [id, o.open.find((t) => t.identifier === id)!] as const)]);
  for (const [identifier, task] of targets) {
    const cands = o.heard.get(identifier)?.cands ?? [];
    // The task's own companies and products, as its title and description name them, are never people (R4b).
    const guard = runGuard({ ...o.tctx, people: { found: o.tctx.people?.found ?? [], listed: o.tctx.people?.listed ?? [], things: [...(o.tctx.people?.things ?? []), ...thingsIn(`${task.title}\n${task.description}`)] } });
    const check = (s: string) => !guard.problem(s) && !meetings.match(s) && !released.match(s);
    const own = await ownOf(task);
    const planFor = (step: Exclude<OpenStep, { how: "none" }>) => planOpenUpdate({ task, step, cands: cands.map((x) => x.c), facts: facts.get(identifier), items: o.items, run: o.receipt, own, check, now: ctx.now() });
    // Where Linear says it is first; then, before anything is written, what an agent's claim or a mark says.
    // A task the run's other work gave a newer figure that doesn't take it: the answer says why.
    const why = (reason: string) => { if (!cands.length) o.skipped.push(`${identifier}: a newer figure came in ("${facts.get(identifier)![0]!.sentence}"), but PMX left it: ${reason}`); };
    const first = openStep(task, { now: ctx.now() });
    const firstPlan = first.how === "none" ? null : planFor(first);
    if (!firstPlan) {
      if (facts.has(identifier)) why(!facts.get(identifier)!.some((f) => newSources(task, f.sources, o.receipt, own, o.items).length) ? "it already cites the source with the newer figure" : "the sentence with it can't go to Linear under the tracker rules");
      continue;
    }
    const t = await team();
    const step = openStep(task, { leases: t.leases, mark: t.marks.get(identifier) ?? null, look: t.look, now: ctx.now() });
    const plan = step.how === "none" ? null : planFor(step);
    if (!plan) { if (step.how === "none") why(`another Mac's step shows ${step.why}`); continue; }
    const n = plan.fresh.length;
    const did = `${plan.step.how === "description" ? "updated" : "commented on"} ${identifier} ${plan.figure ? `with a newer figure from ${n === 1 ? "a new source" : `${n} new sources`}` : `with newer facts from ${n} ${n === 1 ? "source" : "sources"}`}`;
    if (o.dryRun) {
      for (const x of cands) o.skipped[x.at] = `${x.c.title}: already open as ${identifier}; a real run would have ${did}`;
      if (!cands.length) o.skipped.push(`${task.title}: a real run would have ${did}`);
      continue;
    }
    try {
      await applyOpenUpdate(ctx, svc, plan);
    } catch (e: any) {
      if (e?.message === CANARY_REFUSAL) throw e;
      for (const x of cands) o.skipped[x.at] += `; PMX couldn't update it: ${String(e?.message ?? e).slice(0, 200)}`;
      if (!cands.length) o.skipped.push(`${task.title}: PMX couldn't give ${identifier} its newer figure: ${String(e?.message ?? e).slice(0, 200)}`);
      continue;
    }
    const rec = updatedRecord(plan, queued);
    for (const x of cands) { o.went.set(x.c, { duplicateOf: identifier, updated: rec }); gone.add(x.at); }
    if (!cands.length) figures.push({ identifier, ...rec });
    out.push({ identifier, title: task.title, how: plan.step.how, sources: n, changes: plan.changes, ...(plan.step.how === "comment" ? { why: plan.step.why } : {}), ...(queued ? { queued } : {}), ...(plan.figure ? { figure: true } : {}) });
  }
  // The answer says what was updated in their place, not "heard again".
  for (const at of [...gone].sort((a, b) => b - a)) o.skipped.splice(at, 1);
  // RUN-5: the updated tasks' packs get the new quotes now; one that can't be written yet goes at the next background run.
  if (out.some((u) => u.how === "description") && ctx.team.tracker.kind !== "none") await shareEvidence(ctx, { say: "notify" }).catch(() => null);
  return { updated: out, figures };
}

/**
 * R6: the recently done task a suggestion repeats: the one its `sameAs` names, or one whose title is the same or nearly
 * the same (`sameTitle`, the near-identical check INPUT-2 uses for open tasks).
 */
export function doneMatch(c: Pick<CandidateTask, "title" | "sameAs">, recent: DoneTask[]): DoneTask | null {
  const said = c.sameAs ? recent.find((d) => d.identifier.toLowerCase() === c.sameAs!.toLowerCase()) : undefined;
  return said ?? recent.find((d) => sameWords(d.title, c.title) || sameTitle(d.title, c.title)) ?? null;
}

/**
 * R16: an open task that names no sources and that a suggestion with sources can give them to: a product task (not the
 * PM's own commitment, SIG-7) in the backlog or Ready that no agent has taken, with no quotes in its description either.
 */
export function fillable(t: Pick<Task, "sources" | "category" | "status" | "agent" | "description">): boolean {
  return !t.sources.length && !inlineSources(t).length && t.category !== COMMITMENT && (t.status === "inbox" || t.status === "ready") && !t.agent;
}

/**
 * SIG-9: the sources of the needs the last run held over, as items of this batch. Most are already in this run's
 * reading window. When the last run read further back (a first run reads a week), those files are read again with the
 * same privacy rules and redaction, and given IDs after this batch's own, with a line in the receipt like any source.
 */
async function heldSources(ctx: Ctx, g: Awaited<ReturnType<typeof gather>> & { all?: SignalItem[] }, file: Awaited<ReturnType<typeof readHeldOver>>, days: number, receipt: RunReceipt): Promise<{ items: SignalItem[]; offered: { need: HeldNeed; ids: string[] }[]; readSince: string; people: { found: string[]; things?: string[] } }> {
  const since = g.receipt.window.since;
  if (!file?.needs.length) return { items: [], offered: [], readSince: since, people: { found: [] } };
  const people: string[] = [];
  const things: string[] = [];
  const pool = [...g.items];
  const found = heldSourcesIn(file.needs, pool);
  const short = file.needs.some((n) => found.get(n)!.length < n.sources.length);
  // N1: a suggestion that waited for its kind of work may be older than the last run's reach.
  const back = Math.min(Date.parse(file.readSince), ...file.needs.flatMap((n) => n.sources.map((x) => Date.parse(x.at))).filter(Number.isFinite));
  let readSince = since;
  if (short && Number.isFinite(back) && back < Date.parse(since)) {
    const wider = await gather(ctx, { days: Math.min(15, Math.max(days, Math.ceil((ctx.now().getTime() - back) / 86400000) + 1)), scope: "team" });
    readSince = wider.receipt.window.since;
    people.push(...wider.people.found);
    things.push(...(wider.people.things ?? []));
    const top: Record<string, number> = {};
    // IDs after every ID this batch gave out, the busy meetings' too, so none is used twice.
    const all = [...pool, ...(g.all ?? [])];
    for (const i of all) { const m = i.id.match(/^([A-Z])(\d+)$/); if (m) top[m[1]!] = Math.max(top[m[1]!] ?? 0, Number(m[2])); }
    const have = new Set(all.map((i) => refHash(i.ref)));
    for (const i of wider.items) {
      if (have.has(refHash(i.ref)) || !file.needs.some((n) => n.sources.some((s) => isHeldSource(i, s)))) continue;
      const p = i.id.match(/^[A-Z]/)?.[0] ?? "T";
      const id = `${p}${(top[p] = (top[p] ?? 0) + 1)}`;
      const src = wider.receipt.sources.find((x) => x.decision === "used" && x.refHash === refHash(i.ref));
      if (src) receipt.sources.push({ ...src, id });
      pool.push({ ...i, id });
      have.add(refHash(i.ref));
    }
  }
  const matched = heldSourcesIn(file.needs, pool);
  const items = [...new Set([...matched.values()].flat())];
  return { items, offered: file.needs.map((need) => ({ need, ids: matched.get(need)!.map((i) => i.id) })), readSince, people: { found: people, things } };
}
