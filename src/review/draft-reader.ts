import { itemIds } from "./follow-up-id.js";

/**
 * Reading a draft's Markdown: its title and sections, its words without Markdown, its sentences (TASK-10), and what it
 * leaves for later (FOLLOW-1): the calls it marks "PM decides" and the questions it leaves open or blocking. The
 * draft-ready comment counts what `readFollowUps` reads and accepting the draft makes it, so the two never disagree.
 * Nothing here reads a file or a setting.
 */

export interface Section { heading: string; lines: string[] }

/** A draft's title, the lines before its first `##` section, and each `##` section with its lines. Code blocks are left out. */
export function sections(md: string): { title: string | null; intro: string[]; sections: Section[] } {
  let title: string | null = null;
  const intro: string[] = [];
  const out: Section[] = [];
  let fence = false;
  for (const line of md.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h1 = line.match(/^#\s+(.+?)\s*#*\s*$/);
    if (h1 && title === null && !out.length) { title = h1[1]!; continue; }
    const h2 = line.match(/^#{2,3}\s+(.+?)\s*#*\s*$/);
    if (h2 && line.startsWith("## ")) { out.push({ heading: h2[1]!, lines: [] }); continue; }
    (out.at(-1)?.lines ?? intro).push(line);
  }
  return { title, intro, sections: out };
}

/** A source ID, or a list of them: [T7], [C4, T3]. */
const CITE = String.raw`\[(?:[A-Z]{1,3}\d+(?:\s*[,;]\s*[A-Z]{1,3}\d+)*)\]`;
/** Words that set one source against another, or a point against one: "[C4] versus [T3]", "compared with [T3]". */
const VERSUS = String.raw`(?:[Vv]ersus|[Vv]s(?:\.(?=\s*\[))?|[Cc]ompared\s+(?:with|to)|against)`;
/** What joins two source IDs: "[C4] versus [T3]", "[T1] and [T2]", "[T1], [T2]". */
const JOINS = String.raw`(?:${VERSUS}|and|or|&|\/|,|;)`;
const CITE_RUN = String.raw`${CITE}(?:\s*${JOINS}\s*${CITE})*`;
/** The end of a sentence, a clause or the text, which a word left before it would dangle at. */
const CITE_END = String.raw`(?=\s*(?:[.,;:!?)…]|$))`;
/**
 * FOLLOW-1 (end-to-end test 2026-11-27): source IDs with the words that joined them, so none is left dangling: "[C4]
 * versus [T3]" goes whole, and so does a "versus", "vs", "compared with" or "against" right before IDs that end a
 * sentence ("higher versus [T3]."), and one right after them ("[C4] versus."). "and" or "or" before what follows the IDs
 * stays: "It grew [T1], and costs fell."
 */
const CITES = new RegExp(String.raw`(?:\s+${VERSUS}(?=\s*${CITE_RUN}${CITE_END}))?\s*${CITE_RUN}(?:\s*${JOINS}${CITE_END})?`, "g");

/**
 * Plain words from a Markdown line: no emphasis, links, code marks or source IDs like [T7], nor a word that joined
 * them (`CITES`), nor punctuation they leave after a sentence's end ("negotiating? [C4] versus [T3]." is "negotiating?").
 * What a code span holds is kept as written (`gpu_ms` stays gpu_ms), and so is an underscore inside a word
 * (adapter_version).
 */
export function plain(s: string): string {
  const code: string[] = [];
  return s
    .replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    // Where source IDs were, until emphasis is gone and what's before them shows.
    .replace(CITES, "\u0001")
    .replace(/[*`]+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
    .replace(/([.!?…])\u0001\s*[.,;:]+(?=\s|$)/g, "$1")
    .replace(/\u0001/g, "")
    .replace(/\u0000(\d+)\u0000/g, (_m, i: string) => code[Number(i)]!)
    .replace(/\s+/g, " ")
    .trim();
}

/** Sentences, split only after . ! or ? followed by a capital, a digit or an opening bracket. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).map((x) => x.trim()).filter(Boolean);
}

/** A call the draft leaves to the PM: it becomes a private to-do. */
export interface DraftDecision {
  /** The to-do's words: the decision to make, with the task's identifier. */
  text: string;
  /** The options and recommendation the draft gives, in its own words. Stays on this Mac. */
  why: string;
  /** A deadline the draft states ("before Dec 8"), as YYYY-MM-DD, or null. */
  due: string | null;
  /**
   * The follow-up's fixed ID: the item of the draft it was read from (src/review/follow-up-id.ts), never its wording.
   * `ids`: every item it was read from, `id` first: one call the draft marks twice, or two calls on one thing, are one
   * follow-up read from two items. The ledger keeps each, so accepting the draft again makes it once however PMX
   * words or joins its items then.
   */
  id: string;
  ids: string[];
  /**
   * FOLLOW-1 (end-to-end test 2026-11-27): a call worded as something to do, a to-do as written ("Check the scope …"),
   * not a decision: the accept's answer, the re-read's notice and the draft-ready comment count it apart.
   */
  action?: true;
}

/**
 * A question the draft leaves open or blocking (FOLLOW-1, R2). One a person can answer (`ask`) becomes the accepting
 * PM's to-do, "Ask <role>: <question>"; one that needs research or a document becomes a suggested task.
 */
export interface DraftQuestion {
  /** The question, in the draft's words (plain text, no source IDs, no mark). */
  question: string;
  /**
   * The question whole, for a task's title or a to-do: the item's sentence through its "?", without a label before it
   * ("Pricing: would …?" is "Would …?"). An item that isn't a question gets the fewest words added to make it a task:
   * "what Initech asked for, since no cited source shows it" is "Find out what Initech asked for". Never a fragment, and
   * never a word like "it" or "this" with nothing to say what it is: "When do the Initech partner terms close?", or the
   * item's label or task's subject before it ("Globex integration: does the integration need this …?").
   */
  title: string;
  /** What the title starts with, when it starts with what it's about: "the Globex integration", for "Ask legal about …". */
  about: string | null;
  /** The rest of the item: context, the PM decides note, the recommendation. Sentence by sentence. */
  rest: string[];
  where: "blocking" | "open";
  /**
   * Set when one person can answer it: the draft's "— ask: <role>" mark (`by: "mark"`), else the item's own words, like
   * "Ask the data team." or a question such as "Who signs …?" (`by: "words"`). `role` is a role ("the finance lead"),
   * never a person's name: null when the draft gives none, or gives a name.
   */
  ask: { role: string | null; by: "mark" | "words" } | null;
  /** The kind of work the draft's "— needs: <kind of work>" mark names, in its words ("a validation plan"), or null. */
  needs: string | null;
  /**
   * The follow-up's fixed ID: the item of the draft it was read from (src/review/follow-up-id.ts), never its wording.
   * `ids`: every item it was read from, `id` first: one call the draft marks twice, or two calls on one thing, are one
   * follow-up read from two items. The ledger keeps each, so accepting the draft again makes it once however PMX
   * words or joins its items then.
   */
  id: string;
  ids: string[];
  /**
   * The task's title, when the title leans on something nothing in the item or the task says ("Is the other partners'
   * need real?"), so the ask's why names the task (FOLLOW-1).
   */
  from?: string;
  /**
   * FOLLOW-1 (end-to-end test 2026-11-27): a title made from the item's own ask ("Ask Dana Lee's team whether they want
   * …") leans on whom it asks, so when the tracker rules cut that role, "they" would stand for no one. Then the ask goes
   * to the team of the company the role names (`company`: "Globex's account lead Dana" is Globex), else reads as the
   * item's question would without its own ask (`title`, `about`, `from`): its label or the task's subject first, else
   * in its own words.
   */
  unasked?: { company: string | null; title: string; about: string | null; from?: string };
}

const LIST = /^ ?(?:[-*+•]|\d+[.)])\s+/;
const NESTED = /^\s{2,}(?:[-*+•]|\d+[.)])\s+/;
const PM_DECIDES = /PM decides/i;
const QUESTIONS = /\bblocking\b|\bquestions?\b/i;
/** A line that only introduces the list under it: "Blocking:", "Open questions:". */
const LABEL = /^(?:blocking(?: questions?)?|open questions?|questions?(?: still open)?|still open)\s*:?$/i;
/** A question that asks the PM to choose rather than someone to find something out. */
const CHOICE = /^(?:should|shall|do we (?:want|go|keep|drop|offer|build|ship|launch)|whether|go or no-go|go\/no-go|is it worth|which option)\b/i;
/** A label before the decision itself: "Supports: …", "Decision this draft supports: …", "Choice: accept, counter or decline …". */
const LABELLED = /^(?:the\s+)?(?:decision[^:]{0,40}|choice|supports|this supports|what this supports)\s*:\s*(.+)$/i;
/** The same labels that name the choice itself, for a decision brief's Decision and Options sections. */
const CHOICE_LABEL = /^(?:the\s+)?(?:choice|decision(?:\s+(?:needed|to make|required))?)\s*:\s*(.+)$/i;
/** A choice worded as what to do ("accept, counter or decline …"): the decision is whether to. */
const DO = /^(?:to\s+)?(?:accept|add|adopt|approve|build|buy|cancel|change|choose|commit|continue|counter|cut|decline|defer|delay|drop|expand|extend|fund|hire|hold|include|invest|keep|kill|launch|lead|lower|match|move|offer|partner|pause|pick|pursue|raise|reject|remove|renew|replace|retire|scale|sell|ship|sign|start|stop|switch|wait|walk)\b/i;
/**
 * FOLLOW-1 (end-to-end test 2026-11-27): a call worded as something to do, not a choice: "check the scope against the
 * list in writing with Globex's legal lead", "send the plan", "confirm the date with legal". It is a to-do as written
 * ("Check the scope … (PMX-6)"), never "Decide: check …". A choice's verb (`DO`: accept, ship, offer …) is the decision
 * whether to.
 */
const ACTION = /^(?:check|confirm|verify|send|email|ask|call|share|schedule|book|follow\s+up|write(?:\s+up)?|draft|prepare|collect|gather|find\s+out|look\s+into|reach\s+out|tell|remind|request|clarify|review|loop\s+in|set\s+up|chase|contact|update|document|get)\b\s*(.*)$/i;

/** Nouns that make a verb the first word of a compound noun: "kill date", "launch plan", "ship date". */
const COMPOUND = /^(?:dates?|criteria|criterion|plans?|windows?|lists?|deadlines?|points?|thresholds?|floors?|ceilings?|times?|timing|orders?|periods?|cadence|sequence|reviews?|gates?)$/i;

/**
 * An action, by its first word and what follows it: an object with a determiner, a pronoun, a preposition, a team, a
 * name or a clause ("check whether …"), or two words or more that don't make a compound noun ("review cadence" is a
 * noun phrase, the decision on it).
 */
function isAction(core: string): boolean {
  const m = core.replace(/^to\s+/i, "").match(ACTION);
  if (!m) return false;
  const rest = m[1]!.split(/\s+/).filter(Boolean);
  const w = bareWord(rest[0] ?? "");
  if (!w || COMPOUND.test(w)) return false;
  return DET.test(w) || PRONOUN.test(w) || /^(?:them|him|her|us|me)$/i.test(w) || PREP.test(w) || TEAM.test(w) || /^\p{Lu}/u.test(w) || CLAUSE_WORD.test(w) || rest.length >= 2;
}

/** The sections a draft built around one decision gives it: a decision brief's Decision, Options and Recommendation. */
const DECISION_HEADING = /^(?:the\s+)?decision(?:\s+(?:needed|to make))?$/i;
const AROUND_HEADING = /^(?:(?:the\s+)?decision(?:\s+(?:needed|to make))?|options?(?:\s+considered)?|recommend(?:ation|ations|ed option)?)$/i;
const RECOMMENDATION_HEADING = /^recommend(?:ation|ations|ed option)?$/i;

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * What the reader finds before it knows which item it is from: `readAll` gives it its fixed ID, from the item alone.
 * Nothing that words a follow-up (`decisionOf`, `questionOf`, `oneDecision`) sees an ID or makes one.
 */
type Unread<T> = Omit<T, "id" | "ids">;

/**
 * Within one reading of one draft, two items that read as the same call, or ask the same question, are one follow-up,
 * as they always were ("PM decides" on the same choice in the summary and again in a list). This says only that, for
 * this reading: it is never stored and identifies nothing later. A follow-up's identity is its `id`.
 */
const sameAs = (x: { core: string } | { question: string }) => ("core" in x ? `call\n${norm(x.core)}` : `question\n${norm(x.question)}`);

/** One item of the draft, as its author wrote it, and its fixed ID (`partsOf`). */
interface Block { text: string; list: boolean; sub?: boolean; id: string }

/**
 * A section's lines as blocks: top-level list items (their nested lines folded in), paragraphs, and `###` sub-headings.
 * Tables and quotes are left out.
 */
function blocksOf(s: Section): Omit<Block, "id">[] {
  const out: { lines: string[]; list: boolean; sub?: boolean }[] = [];
  let open = false;
  for (const raw of s.lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { open = false; continue; }
    if (/^\s*[|>]/.test(line)) { open = false; continue; }
    const sub = line.match(/^#{3,6}\s+(.+?)\s*#*$/);
    if (sub) { out.push({ lines: [sub[1]!], list: false, sub: true }); open = false; continue; }
    const last = out.at(-1);
    if (LIST.test(line)) { out.push({ lines: [line.replace(LIST, "")], list: true }); open = true; continue; }
    // A nested bullet, or an indented line, explains the item above it.
    if ((NESTED.test(line) || /^\s{2,}\S/.test(line)) && last?.list) { last.lines.push(line.trim().replace(LIST, "")); open = true; continue; }
    if (open && last) { last.lines.push(line.trim()); continue; }
    out.push({ lines: [line.trim()], list: false });
    open = true;
  }
  return out.map((b) => ({ text: b.lines.join(" "), list: b.list, ...(b.sub ? { sub: true } : {}) }));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A deadline the text states: a date after "by", "before", "due" or "until", like "before Dec 8" or "by 2026-12-08".
 * A date without a year is the next one on or after a month ago. Anything else (a close date, "on Dec 15") is no deadline.
 */
export function deadlineIn(text: string, now: Date): string | null {
  const lead = "\\b(?:by|before|due(?: by| on)?|until|no later than)\\s+(?:the\\s+)?";
  const iso = new RegExp(`${lead}(\\d{4})-(\\d{2})-(\\d{2})\\b`, "i").exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = new RegExp(`${lead}${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
  const dm = md ? null : new RegExp(`${lead}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
  const hit = md ? { m: md[1]!, d: md[2]!, y: md[3] } : dm ? { m: dm[2]!, d: dm[1]!, y: dm[3] } : null;
  if (!hit) return null;
  const month = MONTHS.indexOf(hit.m.slice(0, 3).toLowerCase());
  const day = Number(hit.d);
  if (month < 0 || day < 1 || day > 31) return null;
  let year = hit.y ? Number(hit.y) : now.getFullYear();
  if (!hit.y && new Date(year, month, day).getTime() < now.getTime() - 31 * 86400000) year++;
  const d = new Date(year, month, day);
  if (d.getMonth() !== month) return null;
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

const strip = (s: string) => s.replace(/\s*\(?\bPM decides\b\)?[.:]?\s*$/i, "").replace(/[\s.;:,]+$/, "").trim();
export const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);
/** A sentence without its "(PM decides)" mark. */
const unmarked = (s: string) => s.replace(/\s*\(\s*PM decides\s*\)/gi, "").trim();

/** What follows a mark that names its call: "PM decides: Deletion window.", "PM decides whether to …". */
const CLAUSE = /PM decides\s*(?:[:—–-]\s*|\s+(?=(?:whether|which|if|how|between)\b))(.+)$/i;

/**
 * The decision a "PM decides: …" clause names (R2d: a short one too, "Deletion window"), and what the draft says after
 * it. "PM decides: yes" names none; "PM decides: pursue" says to decide whether to pursue the item (`go`).
 */
function clauseOf(p: string): { core: string; rest: string[]; go: boolean } {
  const [first = "", ...rest] = sentencesOf(p.match(CLAUSE)?.[1] ?? "");
  const core = strip(first);
  const after = rest.filter((x) => !/^PM decides\b/i.test(x));
  if (/^(?:pursue|go|go\/no-go)$/i.test(core)) return { core: "", rest: after, go: true };
  return { core: !core || /^(?:yes|no|drop|flag|tbd)$/i.test(core) ? "" : core, rest: after, go: false };
}

/** The decision after a label ("Choice: accept, counter or decline …"), up to the mark or the end of its sentence. */
function afterLabel(p: string, label: RegExp): string {
  const rest = p.match(label)?.[1];
  return rest ? strip(rest.split(/\s*\(?\bPM decides\b/i)[0]!.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)[0]!) : "";
}

/** The verbs that follow a subject in "Should the price be set …?", "Should it ship …?". */
const SHOULD_VERB = "be|have|stay|remain|go|ship|launch|include|cover|move|start|wait|use|get|come|run|replace|support|offer|apply|count|cost|change|land|follow|join|take|lead|carry|charge|keep|need|wait|end|open|close";
const SHOULD_IT = new RegExp(`^(?:should|shall)\\s+((?:it|they)|(?:the|this|that|these|those|our|its|their)\\s+\\S.*?|[\\w'’-]+(?:\\s+[\\w'’-]+){0,4}?)\\s+(${SHOULD_VERB})\\b(.*?)\\??$`, "i");

/**
 * "Should we offer X?" is the decision whether to offer X; "Should the price be set as an add-on?" whether the price
 * should be set as an add-on; any other yes/no question too (`yesNo`): "Is the allowance pooled …?" is whether the
 * allowance is pooled. Anything else is left as written.
 */
function whetherOf(s: string): string {
  // "Should we …?", "Shall we …?", and "Do we give Globex numbers …?" (not "Do we know …?", which asks a fact).
  const we = s.match(/^(?:should|shall) we\s+(.+?)\??$/i) ?? s.match(/^do we\s+(?!know|have|need|understand|see)(.+?)\??$/i);
  if (we) return `whether to ${we[1]}`;
  const it = s.match(SHOULD_IT);
  return it ? `whether ${it[1]} should ${it[2]!.toLowerCase()}${it[3]}` : yesNo(s) ?? s;
}

/**
 * Plain verbs, for where a question's subject ends: "Does the integration | need …?", "Can a designer | be freed …?".
 * Nouns that are verbs too end it only when no verb follows them: "Does the price cap | apply …?".
 */
const VERBS = new RegExp(`^(?:${SHOULD_VERB}|accept|add|adopt|approve|build|buy|cancel|choose|commit|counter|cut|decline|defer|delay|drop|expand|extend|fund|hire|hold|invest|kill|lower|match|partner|pause|pick|pursue|raise|reject|remove|renew|retire|scale|sell|sign|stop|switch|walk|want|require|expect|allow|pay|agree|mean|matter|affect|block|depend|share|own|prefer|work|fit|help|make|know|see|give|let|ask|tell|show|handle|integrate|sync|migrate|upgrade|happen|become|belong|differ|vary|grow|fall|rise|return|leave|send|receive|meet|exceed|beat|pass|fail|win|lose|reach|hit|sit)$`, "i");
const NOUN_TOO = /^(?:cap|limit|plan|price|cost|change|test|use|work|run|support|offer|lead|end|open|close|count|charge|share|block|hold|cut|drop|match|scale|return|fund|partner|ship|launch|land|move|start|wait|stay|need)$/i;
const PRONOUN = /^(?:it|they|we|you|i|he|she|there)$/i;
const DET = /^(?:the|a|an|our|their|its|your|this|that|these|those|another|any|each|every|some|no|all|both|either|neither)$/i;
const PREP = /^(?:of|for|from|with|to|at|by|in|on|per|across|within|under|over|between|about|after|before|during|without|into|via|than|as|like)$/i;
/** Words that start what a question says of its subject: "Is the plan | ready …?", "Is SSO | part of …?". */
const PREDICATE = /^(?:part|worth|enough|ready|available|possible|feasible|necessary|required|needed|likely|unlikely|viable|acceptable|safe|fine|ok|okay|true|clear|open|live|final|firm|flexible|negotiable|separate|optional|mandatory|free|still|already|also|really|actually|even|too|more|less|same|different|better|worse|cheaper|right|wrong|due|late|early)$/i;
/** A predicate that starts with a preposition: "Is the allowance | per seat?", "Is the DPA | in the contract?". */
const PREDICATE_PREP = /^(?:per|in|on|at|within|under|over|inside|outside|out|up|behind|ahead|across|beyond)$/i;
const IRREGULAR = /^(?:been|built|sold|paid|held|kept|made|done|known|shown|given|taken|met|sent|spent|bought|brought|chosen|frozen|written|seen|gone|found|told|won|lost|got|gotten|begun|broken|driven|drawn|grown|thrown)$/i;
/** Past participles that are nouns too ("the feature set"): one only when a preposition or the end follows. */
const IRREGULAR_IF = /^(?:set|cut|put|run|split|shut|hit|let|led|left|read)$/i;
const NOT_PARTICIPLE = /^(?:need|feed|seed|speed|shed|bred|hundred|embed|exceed|proceed|succeed)$/i;
const bareWord = (w: string) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
const participle = (w: string, next: string) => IRREGULAR.test(w) || (IRREGULAR_IF.test(w) && (!next || PREP.test(next) || /^(?:up|yet|or|and)$/i.test(next))) || (/^\p{Ll}{2,}ed$/u.test(w) && !NOT_PARTICIPLE.test(w));
/** A plural noun phrase, by its head (the word before any preposition): "the partner terms", not "the price of seats". */
const pluralOf = (np: string) => {
  const ws = np.split(/\s+/).map(bareWord);
  const at = ws.findIndex((w, i) => i > 0 && PREP.test(w));
  const head = (at > 0 ? ws[at - 1] : ws.at(-1)) ?? "";
  return /^(?:these|those)$/i.test(ws[0] ?? "") || (/\p{Ll}s$/u.test(head) && !/(?:ss|us|is)$/i.test(head));
};
/** A verb with -s, after a subject like "the integration": "needs", "has", "goes", "carries". */
const third = (v: string) => (/^have$/i.test(v) ? "has" : /^be$/i.test(v) ? "is" : /(?:s|sh|ch|x|z|o)$/i.test(v) ? `${v}es` : /[^aeiou]y$/i.test(v) ? `${v.slice(0, -1)}ies` : `${v}s`);

/**
 * Where a yes/no question's subject ends: at the first of its words that `starts` the rest, after the subject's first
 * word, or its first two after a determiner ("the monthly allowance | pooled"). -1 when none does, or when the words
 * before it read as more than a subject (a second determiner, a comma): the question is then left as written.
 */
function subjectEnd(words: string[], starts: (w: string, prev: string, next: string) => boolean): number {
  const w0 = bareWord(words[0] ?? "");
  if (PRONOUN.test(w0)) return words.length > 1 ? 1 : -1;
  // "this" or "that" is the subject itself when what follows starts the rest ("Is this enough?").
  if (/^(?:this|that|these|those)$/i.test(w0) && words.length > 1 && starts(bareWord(words[1]!), "", bareWord(words[2] ?? ""))) return 1;
  const min = DET.test(w0) || /['’]s$/.test(words[0] ?? "") ? 2 : 1;
  for (let i = min; i < Math.min(words.length, 9); i++) {
    if (!starts(bareWord(words[i]!), bareWord(words[i - 1]!), bareWord(words[i + 1] ?? ""))) continue;
    const subject = words.slice(0, i);
    const ok = subject.every((x, j) => !/[,;:()]/.test(x) && !AUX.test(x) && (j === 0 || !DET.test(bareWord(x)) || PREP.test(bareWord(subject[j - 1]!))));
    return ok ? i : -1;
  }
  return -1;
}

/**
 * A yes/no question as the clause after "Decide whether" (FOLLOW-1): "Is the allowance pooled or per seat?" is "the
 * allowance is pooled or per seat", "Does the integration need X?" "the integration needs X", "Can a designer be
 * freed?" "a designer can be freed", and "Do we have another integration planned?" "another integration is planned".
 * The question's own words in its own order otherwise; null when where its subject ends isn't clear.
 */
function yesNo(s: string): string | null {
  const m = s.match(/^(is|are|was|were|has|have|does|do|can|could|will|would|should|shall|must|may|might)\s+(.+?)\s*\?$/i);
  if (!m) return null;
  const aux = m[1]!.toLowerCase();
  const words = m[2]!.split(/\s+/);
  const notDet = (prev: string) => !DET.test(prev) && !/['’]s$/.test(prev);
  if (aux === "do" && /^we$/i.test(words[0]!) && /^have$/i.test(words[1] ?? "") && DET.test(words[2] ?? "")) {
    const np = words.slice(2);
    const at = subjectEnd(np, (w, prev, next) => participle(w, next) && notDet(prev));
    if (at > 1) return `whether ${np.slice(0, at).join(" ")} ${pluralOf(np.slice(0, at).join(" ")) ? "are" : "is"} ${np.slice(at).join(" ")}`;
  }
  let at = -1;
  if (/^(?:is|are|was|were)$/.test(aux)) {
    at = subjectEnd(words, (w, prev, next) => (/^(?:a|an|the)$/i.test(w) && !PREP.test(prev)) || ((PREDICATE.test(w) || participle(w, next)) && notDet(prev)));
    if (at < 0) at = subjectEnd(words, (w) => PREDICATE_PREP.test(w));
  } else if (/^(?:has|have)$/.test(aux)) {
    at = subjectEnd(words, (w, prev, next) => (participle(w, next) || /^(?:already|still|also|ever|yet|now|just|not|never)$/i.test(w)) && notDet(prev));
  } else {
    at = subjectEnd(words, (w, prev, next) => VERBS.test(w) && !(NOUN_TOO.test(w) && VERBS.test(next)) && notDet(prev));
  }
  if (at < 1) return null;
  const subject = words.slice(0, at).join(" ");
  const [verb = "", ...rest] = words.slice(at);
  if (aux === "does") return [`whether ${subject}`, verb.replace(/^[\p{L}-]+/u, (v) => third(v.toLowerCase())), ...rest].join(" ");
  if (aux === "do") return [`whether ${subject}`, verb, ...rest].join(" ");
  return [`whether ${subject}`, aux, verb, ...rest].join(" ");
}

/**
 * FOLLOW-1 (end-to-end test 2026-11-27): a question word's question as the clause after "Decide", in a clause's order:
 * "How many seats does the pilot cover?" is "how many seats the pilot covers", "What is a retrain worth?" "what a
 * retrain is worth", never "Decide how many seats does the pilot cover". Only when what follows the question word's
 * verb is a subject, a phrase with "the", "a", "our", a name or a pronoun, that ends clearly (`yesNo`); "What is
 * blocking the beta?" asks of its question word, and stays as it is.
 */
function whClause(s: string): string | null {
  const m = s.match(/^((?:how\s+(?:many|much|long|often|soon|far)|what|which|who|whom|when|where|why|how)(?:\s+[^\s?]+){0,8}?)\s+(does|do|is|are|was|were|has|have|will|would|can|could|should)\s+(.+?)\s*\?$/i);
  if (!m || m[1]!.split(/\s+/).slice(1).some((w) => AUX.test(w) || /[,;:]/.test(w))) return null;
  const first = m[3]!.split(/\s+/)[0]!;
  const w0 = bareWord(first);
  if (!DET.test(w0) && !PRONOUN.test(w0) && !/['’]s$/.test(first) && !/^\p{Lu}/u.test(w0)) return null;
  const c = yesNo(`${m[2]} ${m[3]}?`);
  return c ? `${m[1]!.replace(/^\p{Lu}/u, (x) => x.toLowerCase())} ${c.replace(/^whether\s+/, "")}` : null;
}

/** A decision already worded as one: "whether …", "which …", "between …", "on the …". */
const CHOSEN = /^(?:(?:whether|if|how|which|what|who|when|where|to|between)\b|on\s)/i;
const AUX = /\b(?:is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|should|must|may|might|shall)\b/i;
/** A noun phrase, not a sentence or a question: "Deletion window", "kill date and price floor". */
const nounPhrase = (c: string) => c.split(/\s+/).length <= 8 && !AUX.test(c) && !/[?:;]/.test(c);
/**
 * "the deletion window" for "Deletion window"; a phrase with its own determiner keeps it, and so does a company's
 * possessive or a name alone: "Globex's renewal terms", "Globex". Only a common word loses its capital (`commonFirst`):
 * "Globex renewal terms" is "the Globex renewal terms".
 */
function theOf(c: string, r: Reading, known = false): string {
  const lc = /^\p{Lu}{2}/u.test(c) ? c : commonFirst(c, r, known);
  if (DETERMINER.test(lc) || /^\p{Lu}[\p{L}\p{N}&-]*['’]s\s/u.test(lc) || /^\p{Lu}\p{Ll}+$/u.test(lc)) return lc;
  return `the ${lc}`;
}

/** A sentence that says what the draft believes or recommends: "We believe Dec 3 is too early …", "We recommend …". */
const BELIEF = /^(?:we|i)\s+(?:(?:still|strongly|now|also)\s+)?(believe|think|recommend|suggest|expect|feel|propose)\s+(?:that\s+)?(.+?)[.!]?$/i;
/** The decision a belief says it informs: "This informs whether to treat …", "Decision informed: scope of …". */
const INFORMS = /^(?:(?:this|that|it|which)\s+(?:informs|decides|settles|shapes|affects|drives|feeds(?:\s+into)?|bears on)\s+|(?:the\s+)?decisions?\s+(?:it\s+|this\s+)?informed\s*:\s*)(.+?)[.!]?$/i;
/** "<a noun phrase> and whether …": a call on a thing, and a choice about it. */
const AND_WHETHER = /^(.{3,80}?)\s+and\s+((?:whether|which|how|when|who|what|if)\b.+)$/i;

/**
 * FOLLOW-1: what a draft believes, as the decision it recommends on. "We believe the token-storage review should finish
 * before commitment" is whether it should; "We recommend a staged rollout" the decision on a staged rollout; "We
 * recommend we ship in January" whether to ship in January. A reason after it (", because …") is the why's, not the
 * decision's.
 */
function beliefCore(b: RegExpMatchArray, r: Reading): string {
  const clause = b[2]!.split(/,\s*(?:because|since|as|so|given)\b/i)[0]!.replace(/[\s.;:,]+$/, "");
  if (/^(?:recommend|suggest|propose)$/i.test(b[1]!)) {
    const we = clause.match(/^(?:we|you)\s+(?:should\s+|must\s+)?(.+)$/i)?.[1] ?? clause.match(/^to\s+(.+)$/i)?.[1];
    if (we || DO.test(clause)) return `whether to ${(we ?? clause).replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase())}`;
    if (/^\p{Ll}+ing\b/u.test(clause) || nounPhrase(clause)) return `on ${/^\p{Ll}+ing\b/u.test(clause) ? clause : theOf(clause, r)}`;
  }
  return `whether ${commonFirst(clause, r)}`;
}

/**
 * FOLLOW-1: a call marked PM decides on what the draft believes or recommends ("We believe Dec 3 is too early to rely on
 * a review estimate") is the draft's recommendation, not a decision. The decision is the one the item says the belief
 * informs ("This informs whether to treat the plugin as a committed slot"), else the belief asked as whether it holds
 * (`beliefCore`). The belief is the why. Null when the lead isn't a belief.
 */
function fromBelief(lead: string, ss: string[], r: Reading): { core: string; why: string; informed: boolean } | null {
  const b = lead.match(BELIEF);
  if (!b) return null;
  const why = `${lead.replace(/[\s.!;:,]+$/, "")}.`;
  const informs = ss.map((s) => unmarked(s).replace(/\s*\(?\bPM decides\b\)?[.:]?\s*$/i, "").match(INFORMS)?.[1]).find(Boolean);
  const x = informs?.split(/:\s/)[0]!.replace(/[\s.;,]+$/, "");
  if (x && x.split(/\s+/).length >= 2) {
    // "go or no-go on the plugin" is whether to go ahead with it.
    const go = x.match(/^(?:a\s+)?go(?:\s+or\s+|\/)no-go\s+(?:on|for|with)\s+(.+)$/i);
    return { core: go ? `whether to go ahead with ${go[1]}` : asChoice(x, r), why, informed: true };
  }
  return { core: beliefCore(b, r), why, informed: false };
}

/**
 * A choice worded as the decision to make: "accept, counter or decline …" is whether to; "Should we …?" and "Should the
 * price …?" too, and any yes/no question ("Is the allowance pooled …?"). Only a verb gets "whether to": "kill date and
 * price floor" is a noun phrase, the decision on it.
 */
function asChoice(core: string, r: Reading): string {
  // Never "Decide: We believe …": what the draft believes is asked as whether it holds (`beliefCore`).
  const belief = core.match(BELIEF);
  if (belief) return beliefCore(belief, r);
  // An action is a to-do as it is: "check the scope against the list …" (`isAction`, `worded`).
  if (isAction(core)) return core;
  // "dedicated capacity price and whether it can be ready for the beta" is the decision on the price, and whether ….
  const and = core.match(AND_WHETHER);
  if (and && nounPhrase(and[1]!) && !CHOSEN.test(and[1]!) && !DO.test(and[1]!)) return `on ${theOf(and[1]!, r)} and ${and[2]}`;
  const second = core.replace(/^to\s+/i, "").split(/\s+/)[1]?.replace(/[^\w]/g, "") ?? "";
  let c = DO.test(core) && !COMPOUND.test(second) ? `whether to ${core.replace(/^to\s+/i, "").replace(/^./, (x) => x.toLowerCase())}` : core;
  c = whetherOf(c);
  c = whClause(c) ?? c.replace(/^((?:whether|if|how|which|what|who|when|where)\b.+?)\?$/i, "$1");
  return !CHOSEN.test(c) && nounPhrase(c) ? `on ${theOf(c, r)}` : c;
}

/** A call on doing something, then the question it hangs on: "whether to warn users: Does a font change …?". */
const HANGS_ON = /^((?:whether|how|what|which|when|where)\s+(?:not\s+)?to\s+[^:?]+?):\s+(\p{Lu}[\s\S]*\?)$/u;
/** Verbs whose thing can be the question itself: "whether to ask the question: …", "whether to pursue the question: …". */
const ASKS_IT = /^(?:whether|how|when|where)\s+(?:not\s+)?to\s+(?:ask|pursue|answer|chase|escalate|research|investigate|explore|revisit|reopen)$/i;

/**
 * The to-do's words: "Decide whether to … (PMX-12)", or "Decide: <the item's lead> (PMX-12)". A call that leans on a
 * word nothing in it explains starts with what its item is about (`about`): "Price floor: decide whether to commission
 * that test … (PMX-33)". A call that carries the question it hangs on reads as the call, the question after it
 * (FOLLOW-1, end-to-end test 2026-11-27): "Decide whether to ask the question: What is the real cost …?" when the
 * question is what the call is on, else "Decide how to package, given the question: Is the price conditional …?",
 * never "Decide how to package: Is …?", which reads as a question. No quotation marks: the tracker rules read those as
 * someone quoted, and the to-do could never go to Linear. At most 200 characters.
 */
function worded(core: string, identifier: string, about: string | null = null): string {
  const id = ` (${identifier})`;
  // An action is a to-do as written: "Check the scope against the list … (PMX-6)" (FOLLOW-1).
  if (isAction(core)) {
    const head = about ? `${about}: ` : "";
    const body = core.replace(/^to\s+/i, "").replace(/^./, (c) => (head ? c.toLowerCase() : c.toUpperCase()));
    return `${head}${cut(body, 200 - head.length - id.length)}${id}`;
  }
  const verb = /^(?:(?:whether|if|how|which|what|who|when|where|to|between)\b|on\s)/i.test(core) ? "Decide " : "Decide: ";
  const head = about && verb === "Decide " ? `${about}: decide ` : verb;
  const hangs = core.match(HANGS_ON);
  const reworded = hangs ? `${hangs[1]}${ASKS_IT.test(hangs[1]!) ? " the question" : ", given the question"}: ${hangs[2]}` : null;
  // Only when the question fits whole: a longer one keeps 0.40.2's "<call>: <Q>?" rather than lose its end, so whether a
  // call takes its question (`decisionOf`, by this length) stays what 0.40.2 decided (rig rerun 2026-11-27).
  const said = reworded && head.length + reworded.length + id.length <= 200 ? reworded : core;
  const body = cut(said.replace(/^./, (c) => (verb === "Decide " ? c.toLowerCase() : c)), 200 - head.length - id.length);
  return `${head}${body}${id}`;
}

/**
 * A call as the reader found it: `clause` when the draft names it after "PM decides:" (or it is a decision brief's one
 * decision), `worded` when the draft words it as a choice ("Supports: whether …", "Should we …?", "Choice: …"), and
 * `lead` when only the item's first sentence gives it. A draft that names its calls (R2b) gives only its named and
 * worded ones: a lead beside them is a mark with no decision of its own.
 */
type Call = DraftDecision & {
  how: "clause" | "worded" | "lead";
  /** The decision before it's worded ("whether the price is …"), what the to-do starts with, and where it is in the draft. */
  core: string; about: string | null; at: number;
};

/**
 * A short label with no verb: "Internal plan", "Length", "Price options", "Call 1". Never a question's start: "Which
 * approval gate applies: …, or both?" asks which (FOLLOW-1), so it is no label to decide "on".
 */
const VERB = /\b(?:is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|should|must|may|might|needs?|gives?|makes?|takes?|keeps?|wants?|asks?|pays?|goes|gets?)\b|\w(?:ed|ing)\b/i;
const QUESTION_START = /^(?:what|which|who|whom|whose|how|whether|if|when|where|why)\b/i;
const labelish = (s: string) => !!s && s.split(/\s+/).length <= 4 && !VERB.test(s) && !QUESTION_START.test(s);
/** A sentence that is a note, not a decision: "Assumption: …", "Unknown: …". */
const NOTE = /^(?:assumptions?|unknowns?|notes?|context|evidence|sources?|why|risks?|caveats?)\s*:/i;
/** A mark that only qualifies a label: "Price options (all PM decides): …", "Options (PM decides):". */
const MARK_IN_LABEL = /\([^()]*\bPM decides\b[^()]*\)\s*:/i;

/**
 * What reading one draft knows beyond an item: the words it writes as names and the words it writes in lowercase
 * (`properWords`), and the subject of the task it drafts ("Globex email integration"), for a question that leans on it.
 */
interface Reading {
  proper: ReadonlySet<string>; common: ReadonlySet<string>; subject: string | null;
  /** The draft's task ("PMX-41"), and whether the draft cites web pages or links, for "these pages" (`referent`). */
  id?: string; cites?: boolean;
  /** The task's title, without its identifier, for a thin to-do's why to name it (FOLLOW-1). */
  title?: string | null;
}

/**
 * The words a draft (and its task's title) writes capitalized inside a sentence and never in lowercase: a company, a
 * product, a plan ("Globex", "Business"). A word capitalized only at the start of a sentence, a label or after a colon,
 * or in a heading in title case, is a common word.
 */
function properWords(md: string, title?: string | null): { proper: Set<string>; common: Set<string> } {
  const doc = sections(md);
  const caps = new Set<string>();
  const lower = new Set<string>();
  const titleCase = (s: string) => !s.split(/\s+/).slice(1).some((w) => /^\p{Ll}[\p{L}-]{3,}/u.test(w));
  const lines = [...[title, doc.title].filter((t): t is string => !!t && !titleCase(t)), ...doc.intro, ...doc.sections.flatMap((s) => s.lines)];
  for (const raw of lines) {
    if (/^\s*\|/.test(raw)) continue;
    const heading = raw.match(/^\s*#{3,6}\s+(.+)$/)?.[1];
    if (heading && titleCase(heading)) continue;
    for (const s of sentencesOf(plain((heading ?? raw).replace(/^\s*(?:[-*+•>]|\d+[.)])\s+/, "")))) {
      const words = s.split(" ");
      words.forEach((w, i) => {
        const word = bareWord(w).replace(/['’]s$/, "").split("-")[0]!;
        if (/^\p{Ll}/u.test(word)) lower.add(word.toLowerCase());
        // A capital inside a sentence, or a possessive anywhere ("Initech's terms"), says it's a name.
        else if (/^\p{Lu}\p{Ll}+$/u.test(word) && ((i > 0 && !/^[("“‘'[]/u.test(w) && !/[:;—–("“‘]$/u.test(words[i - 1]!) && words[i - 1] !== "-") || /\p{L}['’]s\W*$/u.test(w))) caps.add(word.toLowerCase());
      });
    }
  }
  return { proper: new Set([...caps].filter((w) => !lower.has(w))), common: lower };
}

/**
 * A phrase with its first word in lowercase when that's a common word, not a name the draft capitalizes (R2,
 * FOLLOW-1). `known`: only a word the draft also writes in lowercase, for a label moved inside a sentence, where an
 * unknown name ("Initech partner terms") had better keep its capital.
 */
const commonFirst = (s: string, r: Reading, known = false) => {
  const w = s.match(/^\p{Lu}\p{Ll}+(?![\p{L}\p{N}])/u)?.[0]?.toLowerCase();
  const date = !!w && CALENDAR.test(w) && (w !== "may" || /^May\s+\d/.test(s));
  return w && !r.proper.has(w) && !date && (!known || r.common.has(w)) ? `${s[0]!.toLowerCase()}${s.slice(1)}` : s;
};
/** A month or a weekday keeps its capital wherever it is: "whether Dec 3 is too early …" ("May" only before a day). */
const CALENDAR = new RegExp(`^(?:${MONTH.slice(1, -1)}|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:rs(?:day)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)$`, "i");
const capFirst = (s: string) => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/**
 * The subject of a task's title, to say what a question from its draft is about: "Spec the Globex email integration"
 * is "Globex email integration", "Draft a one-pager for SCIM sync" "SCIM sync". Null when it isn't a short phrase.
 */
function subjectOfTitle(title: string | null | undefined): string | null {
  if (!title) return null;
  const t = plain(title).replace(/^[A-Z][A-Z0-9]*-\d+\s*[:—–-]\s*/, "").replace(/[\s.!?]+$/, "")
    .replace(/^(?:spec(?: out)?|draft|write(?: up)?|research|validate|plan|decide(?: on)?|build|prototype|analy[sz]e|compare|scope|size|design|explore|investigate|define|evaluate|assess|review|test|map|audit|prepare|price|outline|propose|document|summari[sz]e|synthesi[sz]e|understand|clarify)\s+/i, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .replace(/^(?:one-pager|brief|plan|spec|analysis|case|proposal|readout|(?:validation|decision|problem|build) (?:plan|readout|brief)|competitive analysis|research synthesis|pilot plan)\s+(?:for|on|of|about)\s+(?:the\s+)?/i, "");
  return t && t.split(/\s+/).length <= 6 && !/[?:;]/.test(t) && !AUX.test(t) ? t : null;
}

/** What an item's label names, when it names what the item is about: "Dedicated-capacity price"; not "Call 1" or a note. */
function topicOf(s: string | null | undefined): string | null {
  const t = (s ?? "").replace(/[\s.:;,]+$/, "").trim();
  if (!t || t.split(/\s+/).length > 5 || /[?;,()\d]/.test(t) || AUX.test(t) || NOTE.test(`${t}:`)) return null;
  if (/^(?:options?|recommend\w*|open|blocking|pm decides|call|step|questions?|item|q)\b/i.test(t)) return null;
  return /\b(?:needs?|gives?|makes?|takes?|keeps?|wants?|asks?|pays?|goes|gets?|waits?|says?|uses?|runs?|costs?)\b/i.test(t) ? null : t;
}

/** An item's label: its bold lead ("**Dedicated-capacity price.** …"), "<label>: …", or a short first sentence before more. */
function labelOf(raw: string, ss: string[], at: number): string | null {
  const bold = raw.replace(LIST, "").match(/^\s*\*\*([^*]{1,60}?)[\s.:]*\*\*/)?.[1];
  if (bold) return topicOf(plain(bold));
  const colon = ss[0]?.match(/^([^:?]{1,40}):\s/)?.[1];
  return topicOf(colon ?? (at > 0 && !PM_DECIDES.test(ss[0] ?? "") ? ss[0] : null));
}

/** Verbs that end a sentence's subject: "The dedicated-capacity price | isn't in any source." */
const FINITE = /^(?:is|isn['’]t|was|wasn['’]t|has|hasn['’]t|are|aren['’]t|were|weren['’]t|have|haven['’]t|will|won['’]t|would|can|can['’]t|could|should|must|may|might|does|doesn['’]t|do|don['’]t|(?:need|cost|come|go|include|cover|run|ship|take|make|give|lack|depend|matter|stay|remain|look|seem|sit|start|end|require|carr|appl|count|work|mean|help|block|affect|hold|keep|var|want|ask|pay|get|offer|support|replace|add|exceed|sell|settle|close|renew|expire)(?:s|es|ies)?)$/i;
/** Words a pronoun never stands for: what the draft rests on, and its own parts. */
const META = /^(?:sources?|drafts?|evidence|data|transcripts?|calls?|meetings?|threads?|notes?|quotes?|recommendations?|questions?|options?|answers?|pm|team)$/i;

/** A sentence's subject when it's a definite noun phrase ("The dedicated-capacity price isn't set"), and its number. */
function subjectOf(s: string): { np: string; plural: boolean } | null {
  const words = s.replace(/[\s.!?]+$/, "").split(/\s+/);
  if (!/^(?:the|our)$/i.test(words[0] ?? "")) return null;
  for (let i = 2; i < Math.min(words.length, 8); i++) {
    // "The run cost isn't set": "cost" is the noun before the verb.
    if (!FINITE.test(bareWord(words[i]!)) || FINITE.test(bareWord(words[i + 1] ?? ""))) continue;
    const np = words.slice(0, i);
    if (np.some((w) => /[,;:()]/.test(w) || PRONOUN.test(bareWord(w)) || DEMONSTRATIVE.test(bareWord(w)))) return null;
    const head = np.map(bareWord).find((_w, j, all) => j > 0 && (j === all.length - 1 || PREP.test(all[j + 1]!))) ?? "";
    if (META.test(head)) return null;
    const v = bareWord(words[i]!).toLowerCase();
    const plural = /^(?:are|aren|were|weren|have|haven|do|don)/.test(v) ? true : /^(?:is|isn|was|wasn|has|hasn|does|doesn)/.test(v) || /s$/.test(v) ? false : pluralOf(np.join(" "));
    return { np: np.join(" "), plural };
  }
  return null;
}

/**
 * A word a decision or a question leans on with nothing in it to say what it is (FOLLOW-1): "whether it is a separate
 * line …", "whether to commission that test …", "Does it need …?", "… need this for the contract?". `personal` for
 * it, they or them; `noun` for a demonstrative before one ("that test"); neither for a demonstrative alone ("this").
 * `weak`: a "that" before a word, which may only join two clauses, so it counts only when it can be resolved.
 */
interface Lean { from: number; to: number; word: string; personal: boolean; noun: string | null; weak: boolean }
const DEMONSTRATIVE = /^(?:this|that|these|those)$/i;
const TIME = /^(?:week|month|quarter|year|sprint|cycle|time|morning|afternoon|evening|weekend|release|round|day)s?$/i;
/** "it" that stands for nothing: "whether it is worth …", "whether it makes sense to …", "Is it worth …?". */
const DUMMY_IT = /^it\s+(?:(?:is|['’]s|was|would be|will be)\s+)?(?:worth|time|too|possible|feasible|realistic|better|best|ok|okay|fine|safe|enough|necessary|wise|likely|unclear|clear|true)\b|^it\s+(?:makes?|made)\s+sense\b|^it\s+pays?\b/i;
const CONJ = /^(?:and|or|but|nor|so|yet|if|whether|than)$/i;

function leanAt(text: string, from: number, word: string, next: string | undefined): Lean | null {
  const to = from + word.length;
  if (/^(?:it|they|them)$/i.test(word)) return /^it$/i.test(word) && DUMMY_IT.test(text.slice(from)) ? null : { from, to, word, personal: true, noun: null, weak: false };
  const n = next ? bareWord(next) : "";
  // A demonstrative alone: before a preposition, a verb like "is", a conjunction or nothing.
  if (!n || PREP.test(n) || AUX.test(n) || CONJ.test(n)) return { from, to, word, personal: false, noun: null, weak: false };
  // "that the …", "that we …", "this quarter", "that Globex …": no word to resolve.
  if (DET.test(n) || PRONOUN.test(n) || TIME.test(n) || /^\p{Lu}/u.test(n)) return null;
  return { from, to: from + word.length + 1 + next!.length, word, personal: false, noun: n, weak: /^that$/i.test(word) };
}

/** The word a decision's clause leans on, right after "whether", "whether to <verb>", "on" or at its start. */
const DECISION_LEAN = /^((?:(?:whether|if|how|when|where|which|why)\s+(?:(?:not\s+)?to\s+[\p{L}-]+\s+)?)|to\s+[\p{L}-]+\s+|on\s+|between\s+)?(it|they|them|this|that|these|those)\b(?:\s+([\p{L}][\p{L}\p{N}'’-]*))?/iu;
function decisionLean(core: string): Lean | null {
  const m = core.match(DECISION_LEAN);
  return m ? leanAt(core, m[1]?.length ?? 0, m[2]!, m[3]) : null;
}

/** The word a question leans on: "it" or "they" as its subject ("When do they close?"), or a demonstrative anywhere. */
const QUESTION_LEAN = /^((?:(?:what|which|who|whom|how|when|where|why)(?:\s+(?:much|many|long|often|soon|far|else|exactly|really|actually))?\s+)?(?:is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|must|may|might)\s+)(it|they)\b/i;
function questionLean(q: string): Lean | null {
  const m = q.match(QUESTION_LEAN);
  if (m) {
    const l = leanAt(q, m[1]!.length, m[2]!, undefined);
    if (l) return l;
  }
  for (const d of q.matchAll(/\b(this|that|these|those)\b(?:\s+([\p{L}][\p{L}\p{N}'’-]*))?/giu)) {
    const l = leanAt(q, d.index!, d[1]!, d[2]);
    if (l) return l;
  }
  return null;
}

/**
 * What the item says around a word that leans on something: its label, the sentence before, and the ones before that;
 * and `prior`, the sentence before the item in the draft, when that's a paragraph's ("The contract needs X. \n\n- Does
 * the integration need this?").
 */
interface Around { label: string | null; before: string | null; also: string[]; prior?: string | null }
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What a leaning word stands for, when the item says so safely (FOLLOW-1): "it" is the item's label, or the subject of
 * the sentence before when that's a definite noun phrase of the same number ("The dedicated-capacity price isn't set.");
 * "that test" is a test the label or a sentence before names with its own words ("A pricing test …" is "the pricing
 * test"). A demonstrative alone ("this") stands for what the sentence before says, which no phrase can safely replace:
 * null, as for anything else unsure. Nothing is added that the draft doesn't say.
 */
function referent(l: Lean, a: Around, r: Reading): string | null {
  // The sentence before the word: the item's own, else the one before the item in the draft.
  const before = a.before ?? a.prior ?? null;
  if (l.personal) {
    const plural = /^(?:they|them)$/i.test(l.word);
    if (a.label && pluralOf(a.label) === plural) return theOf(a.label, r, true);
    const s = before ? subjectOf(before) : null;
    return s && s.plural === plural ? commonFirst(s.np, r) : null;
  }
  // FOLLOW-1: "this" alone stands for what the sentence before says, when that comes down to a short noun phrase
  // (`phraseOf`): "Initech asked how per-client usage and retrain billing will be reported. Does the integration need
  // this?" is "… need per-client usage and retrain billing reporting?".
  if (!l.noun) return phraseOf(before, r);
  const stem = l.noun.toLowerCase().replace(/(?:es|s)$/, "");
  if (stem.length < 3) return null;
  const last = (a.label ?? "").split(/\s+/).at(-1)?.toLowerCase() ?? "";
  if (a.label && a.label.split(/\s+/).length > 1 && last.replace(/(?:es|s)$/, "") === stem) return theOf(a.label, r, true);
  const re = new RegExp(`(?:^|\\s)(?:[Aa]n?|[Tt]he|[Oo]ne|[Oo]ur)\\s+((?:[\\p{L}\\p{N}][\\p{L}\\p{N}'’-]*\\s+){1,3}?)${escapeRe(stem)}(?:s|es)?\\b`, "u");
  for (const s of [a.before, ...a.also, a.prior]) {
    const mods = s?.match(re)?.[1]?.trim();
    if (!mods || mods.split(/\s+/).some((w) => PREP.test(w) || DET.test(w) || AUX.test(w) || PRONOUN.test(w) || CONJ.test(w) || DEMONSTRATIVE.test(w))) continue;
    return `the ${commonFirst(mods, r)} ${l.noun}`;
  }
  // "these pages" in a draft that cites web pages, with nothing before to say which: the pages it cites.
  if (/^(?:these|those)$/i.test(l.word) && r.cites && CITED.test(l.noun)) return `the ${l.noun.toLowerCase()} ${r.id ? `${r.id}'s draft` : "the draft"} cites`;
  return null;
}

/** What a draft cites, for "these pages" with nothing before it to say which. */
const CITED = /^(?:pages|links|sites|websites|articles|docs)$/i;

/** Verbs that say what someone asked for, raised or needs: "Initech asked how …", "The contract requires …". */
const RAISED = /^(.{2,60}?)\s+(?:asked|asks|wants|wanted|requested|requests|needs|needed|requires|required|expects|expected|raised|raises|flagged|flags|mentioned|mentions)\s+(?:(?:for|about)\s+)?(.+)$/i;
/** "reported" as "reporting", "billed" as "billing", "applied" as "applying", "agreed" as "agreeing". */
const gerundOf = (w: string) => (/ied$/.test(w) ? `${w.slice(0, -3)}ying` : /eed$/.test(w) ? `${w.slice(0, -1)}ing` : `${w.slice(0, -2)}ing`);
/** Words that start a clause, not a noun phrase. */
const CLAUSE_WORD = /^(?:that|which|who|whom|whose|whether|if|because|since|when|where|why|how|what|not|no|than|unless|until|while)$/i;

/**
 * The short noun phrase a sentence comes down to, for "this" (FOLLOW-1), or null: the sentence itself when it's one
 * ("Per-client billing reports."); what someone asked for, raised or needs ("Initech asked for a usage report" is "the
 * usage report"); or how they asked something will be done ("… asked how per-client usage and retrain billing will be
 * reported" is "per-client usage and retrain billing reporting"). At most 8 words, no clause, nothing that leans itself.
 */
function phraseOf(s: string | null | undefined, r: Reading): string | null {
  const t = (s ?? "").replace(/[\s.!]+$/, "").trim();
  if (!t || /[?;:()"“”]/.test(t)) return null;
  const words = (np: string) => np.split(/\s+/).map(bareWord);
  const short = (np: string) => words(np).length <= 8 && words(np).every((w, i) => w && !AUX.test(w) && !FINITE.test(w) && !PRONOUN.test(w) && !DEMONSTRATIVE.test(w) && !CLAUSE_WORD.test(w) && (i === 0 || !DET.test(w)) && !PREDICATE.test(w));
  const the = (np: string) => commonFirst(np.replace(/^(?:a|an)\s+/i, "the "), r);
  const raised = t.match(RAISED);
  if (raised && raised[1]!.split(/\s+/).length <= 6 && !/,/.test(raised[1]!)) {
    const how = raised[2]!.match(/^how\s+(.+?)\s+(?:will|would|should|can|could|is|are|gets?)\s+(?:be\s+|get\s+)?(\p{Ll}{3,}ed)$/u);
    if (how && short(how[1]!) && words(how[1]!).length <= 7) return the(`${how[1]} ${gerundOf(how[2]!)}`);
    return short(raised[2]!) && !DO.test(raised[2]!) ? the(raised[2]!) : null;
  }
  // The sentence is the phrase: no word but its last that could be a verb ("…s", "…ed"), and no verb to start it.
  const ws = words(t);
  if (ws.length > 6 || DO.test(t) || !short(t) || ws.slice(0, -1).some((w) => /\p{Ll}(?:[^s]s|ed)$/u.test(w))) return null;
  return the(t);
}

/** The PM who accepts, as a role: a question "— ask: the PM" is the PM's own call (R2). */
export const isPm = (role: string) => /^(?:the\s+)?(?:pm|product manager|accepting pm|you)$/i.test(role.trim());

/** The decision a "PM decides" item or line asks for, worded as the decision to make, and what the draft says about it. */
function decisionOf(text: string, identifier: string, now: Date, r: Reading): Unread<Call> | null {
  const { text: p, mark } = unmark(plain(text), false);
  // R2b: a mark inside a label ("Price options (all PM decides): …") has no decision of its own.
  if (MARK_IN_LABEL.test(p)) return null;
  const ss = sentencesOf(p);
  // R2f: whom the draft says to ask, or the work it says the call needs, goes with the call.
  const role = mark?.ask ? roleOf(mark.value) : null;
  const also = mark ? (mark.ask ? (role && !isPm(role) ? `Ask ${role}${mark.via ? `, via ${mark.via}` : ""}.` : "") : mark.value ? `Needs ${mark.value}.` : "") : "";
  // 1. "PM decides: whether to …" (or "PM decides: Deletion window."): the clause after it is the decision, and what
  //    the draft says after it (and the options before it) is its why.
  // 2. A label before it: "Supports: how to position …. PM decides.", "Decision this draft supports: whether …", or
  //    "Choice: accept, counter or decline … (PM decides)", the label left out.
  const clause = clauseOf(p);
  let core = clause.core || afterLabel(p, LABELLED);
  let how: Call["how"] = clause.core ? "clause" : "worded";
  let why: string | null = null;
  // Where the call is, for what it leans on: the sentence with its mark, and the one before it.
  const at = Math.max(ss.findIndex((x) => PM_DECIDES.test(x)), 0);
  if (clause.core || clause.go) {
    why = statements([...ss.slice(0, at).filter((x) => /^(?:options?\s*:|recommend)/i.test(x)), ...clause.rest]).join(" ");
  }
  if (core) {
    // "PM decides: We believe …" is the draft's recommendation: the decision is the one it informs, the belief its why.
    const belief = fromBelief(core, [...clause.rest, ...ss], r);
    // "PM decides: Length: 60 or 90 days" is the decision on the length.
    const labelled = core.match(/^([^:]{1,40}):\s+(.+)$/);
    if (belief) {
      core = belief.core;
      why = [belief.why, ...statements(clause.rest).filter((x) => !INFORMS.test(x))].join(" ");
    } else core = labelled && labelish(labelled[1]!) ? `on ${theOf(labelled[1]!, r)}: ${labelled[2]}` : asChoice(core, r);
  }
  // 3. The item's lead, its first sentence, with the options the draft gives when they fit.
  const options = ss.find((s) => /^options?\s*:/i.test(s));
  let withOptions = false;
  let leadLabel: string | null = null;
  const fromLead = !core;
  if (!core) {
    how = "lead";
    // "**PM decides:** Deletion window." leaves ": Deletion window": the colon or dash the mark had goes with it, and so
    // do brackets the mark leaves empty.
    const bare = (x: string) => strip(x.replace(PM_DECIDES, "").replace(/^[\s:;,.—–-]+/, "")).replace(/\s*\(\s*(?:all|each|both|every)?\s*\)/gi, "").trim();
    const lead = bare(ss[0] ?? "");
    const next = ss.slice(1).map(bare).find((x) => x && !/^(?:pursue|go)$/i.test(x)) ?? "";
    const marked = ss.find((x) => PM_DECIDES.test(x)) ?? "";
    // A label before the decision ("Length: …", or "**Call 1.** Whether to …"): the decision is what follows it, when
    // that reads as one; a note ("Assumption: …"), another label or nothing is no decision at all.
    const colon = lead.match(/^([^:]{1,40}):\s*(.*)$/);
    const label = colon && labelish(colon[1]!) ? colon[1]! : !colon && labelish(lead) && next ? lead : null;
    leadLabel = label;
    // "Price: PM decides." names the decision by its label: "Decide on the price".
    const named = marked.match(/^(.{1,40}?):\s*\(?PM decides\W*$/i)?.[1];
    // FOLLOW-1: never "Decide: We believe …". A belief is the why of the decision it informs, or of whether it holds.
    const belief = fromBelief(lead, ss, r);
    if (belief) {
      core = belief.core;
      why = [belief.why, ownWhy(ss)].filter(Boolean).join(" ");
      if (belief.informed) how = "worded";
    } else if (clause.go && lead) {
      // "How long does an import take? PM decides: pursue." is the decision whether to pursue the question.
      core = lead.endsWith("?") ? `whether to pursue: ${lead}` : `whether to pursue ${commonFirst(lead, r)}`;
      how = "worded";
    } else if (named && labelish(named)) core = `on ${theOf(named, r)}`;
    else if (label) {
      const body = (colon && label === colon[1] ? colon[2]! : "") || next;
      if (!body || NOTE.test(body) || /^[^:]{1,30}:\s/.test(body) && !/^options?\s*:/i.test(body)) return null;
      if (/^(?:whether|should|shall|which|do we|is it worth|between)\b/i.test(body) || DO.test(body)) { core = asChoice(body, r); how = "worded"; }
      else core = `on ${theOf(label, r)}: ${body.replace(/^options?\s*:\s*/i, "")}`;
    } else if (lead.endsWith("?")) {
      // R2e: a call asked as a question is worded as a choice ("Ship …, or raise it?" is whether to ship …).
      core = asChoice(lead, r);
      how = "worded";
    } else {
      core = lead;
      const both = options && core && !/^options?\s*:/i.test(core) ? `${core}. ${strip(options)}` : "";
      if (both && both.length <= 200 - 10 - identifier.length) { core = both; withOptions = true; }
      // "Should we offer X?" is the decision whether to offer X; "Pilot price" the decision on the pilot price.
      const asked = whetherOf(core).replace(/^(whether\b.+?)\?$/i, "$1");
      if (asked !== core && /^whether\b/i.test(asked)) how = "worded";
      core = !CHOSEN.test(asked) && !DO.test(asked) && !isAction(asked) && nounPhrase(asked) ? `on ${theOf(asked, r)}` : asked;
    }
    // Never "Decide: Options: …" or "Decide: Length: …": a stray label is no decision.
    if (!CHOSEN.test(core) && /^[^:()]{1,40}:(?:\s|$)/.test(core)) return null;
  }
  if (!core) return null;
  // A call that leans on "it", "they" or "that test" says what it stands for, from the item's label or the sentence
  // before the mark ("Decide whether the dedicated-capacity price is …"); when that isn't safe, the to-do starts with the
  // item's label ("Price floor: decide whether to commission that test …"). A call read from the lead has only its label.
  const topic = (leadLabel && topicOf(leadLabel)) || labelOf(text, ss, fromLead ? 0 : at);
  let about: string | null = null;
  const l = decisionLean(core);
  let ref: string | null = null;
  const pre = fromLead ? "" : (ss[at] ?? "").split(/\s*\(?\bPM decides\b/i)[0]!;
  if (l) {
    const before = fromLead ? null : pre.split(/\s+/).length >= 3 ? pre : at >= 1 && !(at === 1 && topic) ? ss[at - 1]! : null;
    ref = referent(l, { label: topic, before, also: ss.slice(topic ? 1 : 0, Math.max(at - 1, 0)) }, r);
    if (ref) core = `${core.slice(0, l.from)}${ref}${core.slice(l.to)}`;
    else about = topic ? capFirst(topic) : null;
  }
  // FOLLOW-1 (end-to-end test 2026-11-27): a thin call ("whether to warn users") says what it's about: the item's label
  // first ("Font restarts: decide whether to warn users"), else the question the item asks before it ("Decide whether
  // to warn users, given the question: Does a font change mid-run restart the job?"), else the task's subject. A call
  // whose leaning word nothing resolves, with no label, takes the question too. With none of them, the why names the
  // task.
  let names = "";
  if (!about && !fromLead && (l ? !ref : THIN.test(core))) {
    // The item's nearest question before the mark, through its "?" ("Is the price conditional …? says pricing is …").
    const asked = [pre, ...ss.slice(0, at).reverse()].map((x) => x.match(/^(.*\?)/)?.[1]?.trim()).find(Boolean) ?? null;
    // Kept as "<call>: <Question>?", as 0.40.2 worded it; `worded` says it as the call, the question after it
    // (`HANGS_ON`).
    const withAsked = asked ? `${core}: ${capFirst(asked)}` : null;
    if (!l && topic) about = capFirst(topic);
    else if (withAsked && worded(withAsked, identifier).length <= 200 && !worded(withAsked, identifier).includes("…")) core = withAsked;
    else if (!l && r.subject) about = capFirst(r.subject);
    else if (r.title) names = `The call is from ${identifier}, "${r.title}".`;
  }
  const said = [names, why ?? ownWhy(ss, withOptions), also].filter(Boolean).join(" ");
  return { text: worded(core, identifier, about), why: cut(said, 400), due: deadlineIn(p, now), how, core, about, at: 0, ...acted(core) };
}

/** A call worded as something to do (`isAction`) is a to-do as written, counted apart from the decisions (FOLLOW-1). */
const acted = (core: string): { action?: true } => (isAction(core) ? { action: true } : {});

/**
 * A thin call: whether (or how, when …) to do something, with at most one bare word after the verb and nothing to
 * say what about ("whether to warn users", "how to package"). "whether to pause the beta" names its thing.
 */
const THIN = /^(?:whether|how|what|which|when|where)\s+(?:not\s+)?to\s+[\p{Ll}-]+(?:\s+(?!(?:the|a|an|our|their|its|this|that|these|those|it|them|in|on|at|by|for|with|before|after|until|to|from)\b)[\p{Ll}-]+)?$/u;

/**
 * FOLLOW-1: a why is a statement, the reason or the recommendation. A question the draft left beside the call or the
 * question ("Has a reviewer been asked?") is no reason: it stays in the draft.
 */
export const statements = (ss: string[]) => ss.filter((s) => s.trim() && !/\?["”’)\]]*$/.test(s.trim()));

/** What an item says about its own call: its options (unless they're in the to-do already) and its recommendation. */
function ownWhy(ss: string[], withOptions = false): string {
  return statements(ss).filter((s) => (!withOptions && /^options?\s*:/i.test(s)) || /^recommend(?:ation|ed|s)?\b/i.test(s)).map((s) => s.replace(/\s*PM decides\.?$/i, "").trim()).filter(Boolean).join(" ");
}

/**
 * The recommended option and why, in short, without the PM decides mark: the first sentence, and the next one too when
 * the first is short and gives no reason ("Counter at one year [T2]. It keeps the account.").
 */
function inShort(texts: string[]): string {
  const ss = texts.flatMap((t) => sentencesOf(plain(t))).map(unmarked).filter((s) => s && !/^PM decides\b/i.test(s) && !/^recommended\.?$/i.test(s));
  if (!ss.length) return "";
  const reason = /[:;—–]|\b(?:because|since|as it|so that)\b/i.test(ss[0]!);
  const s = cut(ss[1] && !reason && ss[0]!.length < 100 ? `${ss[0]} ${ss[1]}` : ss[0]!, 300);
  return /\brecommend/i.test(s) ? s : `Recommendation: ${s}`;
}

interface Part { heading: string; blocks: Block[] }

/**
 * A draft built around one decision (a decision brief; a validation readout) states it in its `## Decision` section
 * and recommends an option, in `## Recommendation` or among the options. Every call marked "PM decides" in its Decision,
 * Options or Recommendation section is that one decision, however it's marked: a bare **PM decides** standing alone or
 * ending the recommendation, "**PM decides:** <the decision>", or "(PM decides)" beside the choice. Its words are, in
 * order: the "PM decides: …" clause; a line in the Decision or Options section that labels the choice ("Choice: accept,
 * counter or decline …"), the label left out; the Decision section's first sentence; or the options the Decision
 * section lists, by their bold leads. Its why is the Recommendation, in short (else the option the Decision section
 * recommends); its date is the deadline the Decision section states (`deadlineIn`). Null when the draft has no such
 * section, no call marked in them, or nothing to word the decision with: then each call is read on its own, as in any
 * draft.
 */
function oneDecision(parts: Part[], identifier: string, now: Date, r: Reading): Unread<DraftDecision & { core: string }> | null {
  const decision = parts.find((p) => DECISION_HEADING.test(plain(p.heading)));
  if (!decision) return null;
  const around = parts.filter((p) => AROUND_HEADING.test(plain(p.heading)));
  const marked = around.flatMap((p) => p.blocks.filter((b) => !b.sub && PM_DECIDES.test(b.text)));
  if (!marked.length) return null;
  const options = around.filter((p) => /^options?\b/i.test(plain(p.heading)));
  let core = marked.map((b) => clauseOf(plain(b.text)).core).find((c) => c.split(/\s+/).length >= 3) ?? "";
  if (!core) {
    const lines = [decision, ...options].flatMap((p) => p.blocks.filter((b) => !b.sub).flatMap((b) => sentencesOf(plain(b.text))));
    core = lines.map((s) => afterLabel(s, CHOICE_LABEL)).find(Boolean) ?? "";
  }
  const first = decision.blocks.find((b) => !b.sub);
  if (!core && first && !first.list) {
    const s = strip(unmarked(sentencesOf(plain(first.text))[0] ?? ""));
    // "Lee Park decides whether to …", "The choice is which …": the decision starts at its question word.
    const from = /^(?:whether|which|how|if|between|what|who|when|where)\b/i.test(s) ? null : s.match(/\b(?:decides?|chooses?|is)\s+((?:whether|which|how|if|between)\b.+)$/i)?.[1];
    core = from ?? s;
  }
  if (!core) {
    const leads = (p: Part) => p.blocks.filter((b) => b.list).map((b) => b.text.match(/^\*\*(.+?)\*\*/)?.[1]).filter((x): x is string => !!x).map((x) => plain(x).replace(/[\s.:;,]+$/, "")).filter(Boolean);
    const named = [decision, ...options].map(leads).find((l) => l.length >= 2);
    if (named) core = `between ${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
  }
  if (!core) return null;
  core = asChoice(core, r);
  const rec = parts.find((p) => RECOMMENDATION_HEADING.test(plain(p.heading)));
  const why = (rec ? inShort(rec.blocks.filter((b) => !b.sub).map((b) => b.text)) : "")
    || inShort(decision.blocks.filter((b) => /\brecommend(?:s|ed|ation)?\b/i.test(b.text) && !/^\W*PM decides\W*$/i.test(b.text)).map((b) => b.text))
    || marked.map((b) => ownWhy(sentencesOf(plain(b.text)))).find(Boolean)
    || "";
  // The date the Decision section states for it, then one beside a mark, then one among the Decision section's items.
  const dateIn = (bs: Block[]) => bs.map((b) => deadlineIn(plain(b.text), now)).find(Boolean) ?? null;
  const due = dateIn(decision.blocks.filter((b) => !b.list && !b.sub)) ?? dateIn(marked) ?? dateIn(decision.blocks.filter((b) => b.list));
  return { text: worded(core, identifier), why: cut(why, 400), due, core, ...acted(core) };
}

/**
 * The mark a drafting skill puts on each question (R2): "— ask: <role>" when one person can answer it, "— needs: <kind
 * of work>" when it takes research or a document. Also read after a spaced hyphen, in brackets ("(ask: legal)"), or as
 * a sentence of its own ("Needs: research."). The colon is required, so prose like "— needs approval" isn't a mark.
 */
const MARK = /(?:\s*[—–]\s*|\s+-{1,2}\s+|\s*\(\s*|(?:^|(?<=[.?!])\s+))(ask|needs?)\s*:\s*((?:(?!\s+(?:via|through)\s)[^.;,?!()[\]—–])*)(?:\s*,?\s+(?:via|through)\s+([^.;?!()[\]—–]*))?\)?\.?/i;

/**
 * The item without its mark, and the mark. A way to reach whom it names ("— ask: the security lead at the account, via
 * the account lead") is no part of the role, nor of the question: it is said after the question, as a sentence of its
 * own ("Ask via the account lead.").
 */
function unmark(p: string, sayVia = true): { text: string; mark: { ask: boolean; value: string; via?: string } | null } {
  const m = MARK.exec(p);
  if (!m) return { text: p, mark: null };
  const via = m[3]?.replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, "");
  const after = `${via && sayVia ? ` Ask via ${via}.` : ""} ${p.slice(m.index + m[0].length)}`;
  const text = `${p.slice(0, m.index)}${after}`.replace(/\s+([.?!,;:])/g, "$1").replace(/\s+/g, " ").trim();
  return { text, mark: { ask: /^ask$/i.test(m[1]!), value: m[2]!.replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, ""), ...(via ? { via } : {}) } };
}

const DETERMINER = /^(?:the|our|their|its|your|a|an|someone|somebody|whoever|each)\b/i;
/** A team asked as a whole: "Ask legal", "Ask finance". */
const TEAM = /^(?:legal|finance|sales|support|marketing|procurement|security|engineering|design|product|data|ops|operations|leadership|partnerships|accounting|compliance|research)$/i;
/** A team known by its letters: "Ask IT". Other letters are a role: "the CFO". */
const TEAM_LETTERS = /^(?:IT|HR|QA|PR|BD)$/;
/** Words that make a phrase a role: "the account lead", "Globex's procurement contact", "the data team". */
const ROLE_WORD = /\b(?:leads?|owners?|managers?|head|director|vp|chief|officer|cfo|ceo|cto|cio|ciso|coo|cro|cmo|cpo|dpo|contact|engineers?|engineering|designers?|design|counsel|lawyer|champion|sponsor|buyer|admin|administrator|team|finance|legal|sales|support|security|procurement|marketing|analysts?|architect|partners?|customer|client|rep|representative|executive|exec|founder|desk|office|department|committee|board|pm)\b/i;
/** Who isn't one person to ask: several people, customers in general, a pronoun, or no one. */
const NOT_ONE = /^(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|a few|few|some|several|many|more|most|all|any|them|him|her|us|we|i|you|they|it|this|that|everyone|anyone|nobody|no one|around|customers?|users?|admins|accounts?|buyers|prospects?|people|interviewees?|in|at|on|during|after|before|for|about|whether|if)\b/i;
const capWord = (w: string) => /^\p{Lu}\p{Ll}/u.test(w) && !/['’]s$/.test(w);
/**
 * How, when or how else to ask, after whom: "Ask the VP Brand directly", "— ask: legal in person", "Ask the CFO first".
 * No part of the role (FOLLOW-1, end-to-end test 2026-11-27).
 */
const MANNER = /\s+(?:directly|personally|first|again|separately|in person|offline|privately|informally|formally|explicitly|yourself|too|also|as well|in advance|beforehand|early|now|today|soon|asap|one[- ]on[- ]one|1:1|in writing|by (?:e-?mail|phone)|over (?:e-?mail|the phone)|on a call)$/i;

/**
 * The role a draft gives for who answers a question, worded to follow "Ask": "the finance lead", "legal", "the CFO",
 * "Globex's procurement contact". Null for anything that may be a person's name ("Lee Park", "Sam from finance"):
 * PMX's to-dos from drafts name roles, never people. How to ask them ("directly", "in person", "first": `MANNER`) is no
 * part of it: "the VP Brand directly" is "the VP Brand", wherever the role is used (the tracker rules that check it,
 * the company's team an ask falls back to). `strict` also wants a word that makes it a role (for a role read from the
 * draft's prose rather than its mark).
 */
function roleOf(raw: string, strict = false): string | null {
  let r = raw.replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, "");
  // "Lee Park, the finance lead": the part that is a role.
  if (r.includes(",")) r = r.split(/\s*,\s*/).find((x) => DETERMINER.test(x) && ROLE_WORD.test(x)) ?? "";
  for (let was = ""; was !== r;) { was = r; r = r.replace(MANNER, "").replace(/[\s.,;:]+$/, ""); }
  if (!r || r.length > 60 || r.split(" ").length > 8) return null;
  if (TEAM_LETTERS.test(r)) return r;
  if (NOT_ONE.test(r)) return null;
  const words = r.split(" ");
  const acronym = /^\p{Lu}{2,5}$/u.test(words[0]!);
  // Two capitalized words in a row that aren't a role ("Finance Lead") read as a full name; a capitalized lead that
  // isn't a team, a company's possessive ("Globex's") or an acronym reads as a first name, unless a role word follows
  // ("Globex procurement").
  const roleish = (w: string) => ROLE_WORD.test(w) || TEAM.test(w) || DETERMINER.test(w);
  if (words.some((w, i) => i > 0 && capWord(w) && capWord(words[i - 1]!) && !roleish(w) && !roleish(words[i - 1]!))) return null;
  if (capWord(words[0]!) && !TEAM.test(words[0]!) && !DETERMINER.test(words[0]!)) {
    if (words.length === 1 || /^(?:from|at|in|on|of|with|and)$/i.test(words[1]!) || !ROLE_WORD.test(words.slice(1).join(" "))) return null;
  }
  if (strict && !TEAM.test(r) && !acronym && !ROLE_WORD.test(r)) return null;
  if (TEAM.test(r)) return r.toLowerCase();
  if (acronym) return `the ${r}`;
  if (DETERMINER.test(r)) return r.replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());
  if (/^\p{Ll}/u.test(r)) return `the ${r}`;
  return r;
}

/**
 * Without a mark (an older draft, a team's own copy of a skill): a question one person can answer, by its words. Who
 * signs, funds, pays, owns or approves something, or who the contact is; whether someone can be freed or spared;
 * whether something is approved, signed, budgeted or scheduled; when something ships, closes or renews; what our share,
 * the budget, the deadline or the terms are; whether a company has budget or sign-off. Never one about customers or
 * users in general, a count, a comparison or the market: those need research.
 */
const ASK_SHAPES = [
  /^who(?:['’]s|\s+is|\s+are)?\s+(?:the\s+|our\s+|their\s+)?(?:[\w'’-]+\s+){0,3}?(?:contact|owner|buyer|sponsor|champion|signer|signatory|decision[- ]maker|approver|point person)\b/i,
  /^who\s+(?:will\s+|can\s+)?(?:signs?|funds?|pays?|owns?|approves?|decides?|leads?|runs?|staffs?|holds?|handles?|negotiates?|makes the call|is responsible)\b/i,
  /^(?:can|could)\s+(?:[\w'’-]+\s+){1,4}?(?:be\s+)?(?:freed|free up|spared?|staffed|assigned|loaned|lent|available|take on|pick up|join|cover)\b/i,
  /^(?:is|are|has|have|was|were)\b.*\b(?:approved|signed(?: off)?|budgeted|funded|confirmed|scheduled|staffed|allocated|agreed|cleared|on the roadmap|in (?:the|this quarter['’]s|next quarter['’]s) (?:plan|budget|roadmap))\b/i,
  /^when\s+(?:will|does|do|is|are|can|did|would)\b.*\b(?:ship|ships|shipped|land|lands|launch|launches|release|released|ready|close|closes|start|starts|begin|begins|go live|sign|signs|renew|renews|expire|expires|end|ends|arrive|arrives|done|available|deliver|due)\b/i,
  /^what(?:['’]s|\s+is|\s+are|\s+was)\s+(?:our|the|their|its|\p{Lu}[\w&-]*['’]s)\s+(?:[\w-]+\s+){0,2}?(?:share|budget|deadline|date|price|quote|term|terms|renewal|timeline|headcount|allocation|split|status|contact|owner|discount|contract|commitment)\b/iu,
  /^(?:[Dd]oes|[Dd]o|[Dd]id|[Hh]as|[Hh]ave|[Ww]ill)\s+\p{Lu}[\w&-]*(?:['’]s)?\s+(?:[\w-]+\s+){0,3}?(?:have|got|get)\s+(?:a\s+|the\s+)?(?:budget|approval|sign-off|headcount)\b/u,
];
const RESEARCH_WORDS = /\b(?:customers|users|accounts|admins|buyers|prospects|segments?|market|how many|how often|competitors?|compar(?:e|ison)|most|typical(?:ly)?|on average)\b/i;
/** "Ask the data team.", "Check with legal.": who the draft says to ask, cut before what to ask them. */
const ASK_SENTENCE = /^(?:ask|check with|confirm with|a question for)\s+(?!via\b|through\b)(.+?)(?:\s+(?:for|about|to|whether|if|before|by|after|this|next|when|how|what|which|who|in|during)\b.*)?[.!]?$/i;
/** "Sales could find out before Dec 2.", "The data team can answer it." */
const CAN_ANSWER = /^(.{2,40}?)\s+(?:can|could|would|will)\s+(?:answer|confirm|find out|tell us|know)\b/i;

function askIn(title: string, rest: string[]): DraftQuestion["ask"] {
  for (const s of rest) {
    const a = s.match(ASK_SENTENCE);
    if (a && !NOT_ONE.test(a[1]!)) return { role: roleOf(a[1]!, true), by: "words" };
    const c = s.match(CAN_ANSWER);
    const role = c ? roleOf(c[1]!, true) : null;
    if (role) return { role, by: "words" };
  }
  const party = partyIn(title);
  if (party) return { role: party, by: "words" };
  return ASK_SHAPES.some((re) => re.test(title)) && !RESEARCH_WORDS.test(title) ? { role: roleIn(title), by: "words" } : null;
}

/**
 * FOLLOW-1 (end-to-end test 2026-11-27): a question about what another party expects, wants, needs, uses or plans is
 * theirs to answer: "How many refreshes per team per year does the customer expect?" is "Ask the customer: …",
 * marked PM decides or not. Only a party that reads as a role (`roleOf`: "the customer", "the buyer", "their CFO",
 * "Globex's procurement"), never the PM, "we", a thing ("Does the integration need …?") or users in general ("Do admins
 * want …?", which need research).
 */
const PARTY = /\b(?:does|do|will|would)\s+((?:the|their)\s+[^,?;:()]{1,40}?|[\p{L}\p{N}&-]+['’]s\s+[^,?;:()]{1,30}?)\s+(?:expect|want|need|use|plan)\b/iu;
function partyIn(question: string): string | null {
  const m = question.match(PARTY);
  const role = m ? roleOf(m[1]!, true) : null;
  return role && !isPm(role) ? role : null;
}

const GROUP = "legal|finance|procurement|security|compliance|sales|support|marketing|engineering|data|design|product|platform|identity|partnerships|accounting|operations|ops|leadership|infosec|privacy|risk|purchasing|IT|HR";
const GROUP_HEAD = "team|department|org|function|desk|office|group|lead|owner|contact|counsel|manager|head|director|committee|board|officer|champion|sponsor|buyer";
const OWNER = "(?:the|their|our|its|\\p{Lu}[\\p{L}\\p{N}&-]*['’]s)";
const AT_COMPANY = "(?:\\s+at\\s+\\p{Lu}[\\p{L}\\p{N}&-]*)?";
/** The groups a question can name as the ones who know: a team or role, an executive, or a team by its name alone. */
const GROUPS_IN = [
  // "the security team", "Globex's procurement contact", "the platform engineering lead", "the risk committee at Globex".
  new RegExp(`(?:\\b${OWNER}\\s+(?:\\p{Ll}[\\p{L}-]*\\s+)?)?\\b(?:${GROUP})\\s+(?:${GROUP_HEAD})s?\\b${AT_COMPANY}`, "gu"),
  // "their CFO", "the CISO at Globex".
  new RegExp(`(?:\\b${OWNER}\\s+)?\\b(?:CFO|CEO|CTO|CIO|CISO|COO|CRO|CMO|CPO|DPO)\\b${AT_COMPANY}`, "gu"),
  // A team by its name, doing what's asked: "Has legal signed …?", "approved by finance", "When will procurement at Globex …?".
  new RegExp(`(?<=\\b(?:[Dd]oes|[Dd]o|[Dd]id|[Hh]as|[Hh]ave|[Hh]ad|[Ww]ill|[Ww]ould|[Cc]an|[Cc]ould|[Ss]hould|[Mm]ust|by|from|with)\\s+)(?:\\p{Lu}[\\p{L}\\p{N}&-]*['’]s\\s+)?(?:legal|finance|procurement|compliance|security|sales|infosec|purchasing|IT|HR)\\b(?!\\s+(?:${GROUP_HEAD}|reviews?|questionnaires?|teams?)\\b)${AT_COMPANY}`, "gu"),
];

/**
 * FOLLOW-1: who to ask, when an unmarked question names a group that can answer it: "the security team", "their CFO",
 * "legal", "procurement at Globex" (asked as "Globex's procurement"). Not the role a question asks for ("who is the
 * procurement contact?"), not two different groups, and never a person: `roleOf` says what reads as a role.
 */
function roleIn(question: string): string | null {
  // The role a question asks for isn't who knows it: "… and who is the procurement contact?", "Which team owns …?".
  const q = question.replace(/\b(?:[Ww]ho|[Ww]hom)(?:['’]s|\s+is|\s+are|\s+will\s+be|\s+would\s+be)\s+[^,?;]*/gu, " ").replace(/\b[Ww]hich\s+[^,?;]*/gu, " ");
  const roles = GROUPS_IN.flatMap((re) => [...q.matchAll(re)].map((m) => {
    // "procurement at Globex" is Globex's procurement.
    const at = m[0].match(/^(?:(?:the|their|our|its)\s+)?(.+?)\s+at\s+(\p{Lu}[\p{L}\p{N}&-]*)$/u);
    return at ? `${at[2]}'s ${at[1]}` : m[0];
  }));
  // One group, however often it's named: "the security team" holds "security".
  const key = (x: string) => x.toLowerCase().replace(/^(?:the|their|our|its)\s+/, "");
  const groups = [...new Set(roles.map(key))].filter((k, _i, all) => !all.some((o) => o !== k && o.includes(k)));
  return groups.length === 1 ? roleOf(roles.find((x) => key(x) === groups[0])!, true) : roles.length ? null : companyTeam(question);
}

/** The groups a role asked for belongs to: "the procurement contact" is procurement's. */
const GROUP_WORD = new RegExp(`^(?:${GROUP.split("|").filter((g) => !/^[A-Z]+$/.test(g)).join("|")})$`, "i");

/**
 * FOLLOW-1: a question that asks who holds a role at a company ("Who signs the contract at Globex, and who is the
 * procurement contact?") is for that company's team for the role: "Globex's procurement". Only with the company named
 * after "at" and one group in the roles asked for; never a person.
 */
function companyTeam(question: string): string | null {
  const company = question.match(/\bat\s+(\p{Lu}[\p{L}\p{N}&-]*)/u)?.[1];
  if (!company || DET.test(company) || CALENDAR.test(company) || PRONOUN.test(company)) return null;
  const asked = [...question.matchAll(/\b(?:[Ww]ho|[Ww]hom)(?:['’]s|\s+is|\s+are|\s+will\s+be|\s+would\s+be)\s+([^,?;]*)/gu)].map((m) => m[1]!);
  const groups = new Set(asked.flatMap((a) => a.split(/\s+/).map(bareWord).filter((w) => GROUP_WORD.test(w) || /^(?:IT|HR)$/.test(w)).map((w) => (/^(?:IT|HR)$/.test(w) ? w : w.toLowerCase()))));
  return groups.size === 1 ? roleOf(`${company}'s ${[...groups][0]}`, true) : null;
}

const QWORD = "(?:what|which|who|whom|whose|how|whether|if|when|where|why)";
/** A label before a question: "Pricing: would accounts pay?" */
const LEAD = new RegExp(`^[^:?]{1,40}:\\s+(?=${QWORD}\\b|(?:is|are|do|does|did|can|could|will|would|should|has|have)\\b)`, "i");
/** An item that says something is unknown rather than asking: what is unknown, as a clause ("what Initech asked for"). */
const UNKNOWN_LEAD = new RegExp(`^(?:(?:it(?:['’]s|\\s+is)\\s+)?(?:still\\s+)?(?:unclear|unknown|not (?:yet )?(?:known|clear)|open|tbd|to be confirmed)\\s*:?\\s*|(?:we\\s+)?(?:still\\s+)?(?:don['’]t|do not) know\\s+|(?:to\\s+)?(?:confirm|check|find out|learn|establish|verify|clarify)\\s+)(${QWORD}\\b.+)$`, "i");
const UNKNOWN_TAIL = new RegExp(`^(${QWORD}\\b.+?)\\s+(?:is|are|remains?|stays?)\\s+(?:still\\s+)?(?:unclear|unknown|not (?:yet )?(?:known|clear)|open|unconfirmed|to be confirmed)\\b.*$`, "i");

/** A word in the question that points back to its label: "Initech partner terms: when do they close?" */
const BACK = /\b(?:they|them|their|theirs|it|its|this|these|those)\b/i;

/**
 * The item's question, whole (DraftQuestion.title). A label before it goes ("Pricing: would accounts pay?" is "Would
 * accounts pay?"), unless the question points back to it ("Initech partner terms: when do they close?" keeps it).
 */
function titleOf(ss: string[]): string {
  const at = ss.findIndex((s) => s.endsWith("?"));
  const raw = (at >= 0 ? ss[at] : ss[0]) ?? "";
  const unlabelled = raw.replace(LEAD, "");
  const t = unlabelled !== raw && BACK.test(unlabelled) ? raw : unlabelled;
  if (!t.endsWith("?")) {
    // A clause, not a question: "Find out" makes it a task, and the reason after it ("since …") stays in the description.
    const clause = t.match(UNKNOWN_LEAD)?.[1] ?? t.match(UNKNOWN_TAIL)?.[1]
      ?? (new RegExp(`^${QWORD}\\b`, "i").test(t) && (/^\p{Ll}/u.test(t) || /^(?:what|which|who|whose|how|whether)\b/i.test(t)) ? t : null);
    if (clause) return `Find out ${clause.replace(/,\s*(?:since|because|as|so)\b.*$/i, "").replace(/[\s.;:,]+$/, "").replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase())}`;
  }
  return t.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
}

/**
 * A title that leans on a word with nothing in it to say what it is (FOLLOW-1): "Does the integration need this for the
 * contract?". The word is replaced by what it stands for when the item says so safely (`referent`): "Initech partner
 * terms: when do they close?" is "When do the Initech partner terms close?". Else the title starts with the item's
 * label or, without one, the subject of the task the draft is for ("Globex integration: does the integration need this
 * …?"), and `about` names it for an ask. A "Find out …" title is a statement and stays as it is. `prior`: the sentence
 * before the item in the draft, for a question that is the item's first sentence.
 */
function leaned(title: string, raw: string, ss: string[], r: Reading, prior: string | null = null): { title: string; about: string | null } {
  if (title.startsWith("Find out ")) return { title, about: null };
  const at = Math.max(ss.findIndex((s) => s.endsWith("?")), 0);
  // A label `titleOf` kept, since the question points back to it.
  const head = title.match(LEAD)?.[0];
  const kept = head ? head.replace(/:\s*$/, "") : null;
  const asked = head ? title.slice(head.length) : title;
  const label = kept ? topicOf(kept) : labelOf(raw, ss, at);
  const l = questionLean(asked);
  if (!l) return { title, about: kept ? theOf(kept, r, true) : null };
  const before = at >= 1 && !(at === 1 && label && !kept) ? ss[at - 1]! : null;
  const ref = referent(l, { label, before, also: ss.slice(label && !kept ? 1 : 0, Math.max(at - 1, 0)), prior: at === 0 && !label ? prior : null }, r);
  if (ref) return { title: capFirst(`${asked.slice(0, l.from)}${ref}${asked.slice(l.to)}`), about: null };
  if (kept) return { title, about: theOf(kept, r, true) };
  const prefix = l.weak ? null : label ?? r.subject;
  return prefix ? { title: `${capFirst(prefix)}: ${commonFirst(asked, r)}`, about: theOf(prefix, r, true) } : { title, about: null };
}

/**
 * A question item: the question first (through its "?"), then the rest of what the draft says about it; its whole
 * title, with what it leans on said (`leaned`); and who answers it (R2): the draft's mark, else its words.
 */
function questionOf(text: string, where: DraftQuestion["where"], r: Reading, prior: string | null = null): Unread<DraftQuestion> | null {
  const { text: p, mark } = unmark(plain(text).replace(/^(?:Q\d+|blocking|open)\s*[:.)-]\s*/i, ""));
  // A question ends at its "?": what the draft put after it in the same sentence (", via the account lead") is a
  // sentence of its own, never part of the question.
  const ss = sentencesOf(p).flatMap((x) => {
    const m = x.match(/^(.+?\?)(?:\s*[,;]\s*|\s+[—–-]\s+)(\S.*)$/);
    if (!m) return [x];
    const tail = m[2]!.replace(/[\s.;,]+$/, "");
    return [m[1]!, `${/^(?:via|through)\b/i.test(tail) ? `Ask ${tail}` : capFirst(tail)}.`];
  });
  if (!ss.length) return null;
  const q = ss.findIndex((s) => s.endsWith("?"));
  const upto = q >= 0 && q <= 1 ? q : 0;
  const question = ss.slice(0, upto + 1).join(" ");
  const rest = ss.slice(upto + 1);
  const whole = titleOf(ss);
  // R2c: without a mark, only a question is one: an item with a "?", or worded as one ("what …", "whether …", "It's
  // unclear how …"). A statement ("The sources mention a second answer due Dec 15.") stays in the draft.
  if (!mark && !p.includes("?") && !whole.startsWith("Find out ")) return null;
  // Who answers it goes by the question as the draft words it, before its title says what it leans on.
  let ask: DraftQuestion["ask"] = mark ? (mark.ask ? { role: roleOf(mark.value), by: "mark" as const } : null) : askIn(whole, rest);
  let { title, about } = leaned(whole, text, ss, r, prior);
  let kept = rest;
  let from: string | null = null;
  let unasked: DraftQuestion["unasked"];
  if (title === whole && !whole.startsWith("Find out ")) {
    const label = labelOf(text, ss, Math.max(q, 0));
    if (q === 1 && label && whole === capFirst(ss[1]!) && !QUESTION_START.test(ss[1]!) && !AUX_START.test(ss[1]!)) {
      // FOLLOW-1 (end-to-end test 2026-11-27): a label, then a question with no subject of its own: the label is its
      // subject. "Separation of duties definition. Same user only, or also same role or team?" is "Separation of
      // duties definition: same user only, or also same role or team?", never the question alone.
      title = `${capFirst(label)}: ${commonFirst(ss[1]!, r)}`;
      about = theOf(label, r, true);
    } else if (OTHER.test(whole)) {
      // FOLLOW-1 (end-to-end test 2026-11-27): "the other …" leans on what the question doesn't say ("Is the other
      // partners' need real?"). The item's own ask says it, when it has one ("Ask the other four beta partners whether
      // they want the approve step on or off by default."); else the item's label or the task's subject goes first;
      // else the why names the task.
      const own = mark ? null : ownAsk(rest);
      const prefix = label ?? r.subject;
      if (own) {
        title = `Find out ${own.clause}`;
        ask = { role: own.role, by: "words" };
        kept = rest.filter((x) => x !== own.sentence);
        // "whether they want …" leans on whom it asks: should that role be cut, the ask still says who "they" are,
        // or reads as the question would without an ask of its own.
        if (/\b(?:they|them|their|theirs)\b/i.test(own.clause)) {
          const company = companyOf(own.role);
          unasked = prefix ? { company, title: `${capFirst(prefix)}: ${commonFirst(whole, r)}`, about: theOf(prefix, r, true) }
            : { company, title: whole, about, ...(r.title ? { from: r.title } : {}) };
        }
      } else if (prefix) {
        title = `${capFirst(prefix)}: ${commonFirst(whole, r)}`;
        about = theOf(prefix, r, true);
      } else from = r.title ?? null;
    }
  }
  return { question, title, about, rest: kept, where, ask, needs: mark && !mark.ask ? mark.value || null : null, ...(from ? { from } : {}), ...(unasked ? { unasked } : {}) };
}

/**
 * The company a role names, as its possessive or after "at": "Globex's account lead Dana", "the account lead at
 * Globex". Its team is whom to ask when the tracker rules cut the role itself (FOLLOW-1); they still check the company.
 */
function companyOf(role: string): string | null {
  const c = role.match(/^(\p{Lu}[\p{L}\p{N}&-]*)['’]s\s/u)?.[1] ?? role.match(/\bat\s+(\p{Lu}[\p{L}\p{N}&-]*)/u)?.[1];
  return c && !DET.test(c) && !CALENDAR.test(c) && !PRONOUN.test(c) && !TEAM_LETTERS.test(c) ? c : null;
}

/** A question that starts with its verb: "Is …?", "Does …?", "Can …?". */
const AUX_START = /^(?:is|are|was|were|do|does|did|can|could|will|would|should|shall|has|have|had|must|may|might|isn['’]t|aren['’]t|don['’]t|doesn['’]t|won['’]t|can['’]t)\b/i;
/** "the other partners", "the others": a question that leans on someone it doesn't name. */
const OTHER = /\bthe\s+others?\b/i;

/**
 * The item's own ask, in a sentence of its own, with whom and what: "Ask the other four beta partners whether they want
 * the approve step on or off by default." The one asked is a role or a group the draft names (`roleOf`), never a person.
 */
function ownAsk(rest: string[]): { role: string; clause: string; sentence: string } | null {
  for (const s of rest) {
    const m = s.match(/^(?:ask|check with|confirm with)\s+(?!via\b|through\b)(.+?)\s+((?:whether|if|what|how|which|who|when|where|why)\b.+?)[.!]?$/i);
    const role = m && !NOT_ONE.test(m[1]!) ? roleOf(m[1]!, true) : null;
    if (role && !isPm(role)) return { role, clause: m![2]!.replace(/[\s.;:,]+$/, ""), sentence: s };
  }
  return null;
}

/** A call's subject, for two calls on one thing (`mergeCalls`): what it's about, and how the call is worded about it. */
interface CallSubject { np: string; key: string; form: "whether" | "and" | "on"; tail: string }

/**
 * The thing a call is about: "whether the dedicated capacity price is a separate line …" (`whether`, the rest after
 * the subject), "on the dedicated capacity price and whether it can be ready …" (`and`, the choice after "and"), or
 * "on the kill date" (`on`). Null for a call on doing something ("whether to …") or one whose subject isn't clear.
 */
function subjectOfCall(core: string): CallSubject | null {
  const key = (np: string) => norm(np.replace(/^(?:the|our|a|an)\s+/i, ""));
  const w = core.match(/^whether\s+(?!to\b|not\b)(.+)$/i);
  if (w) {
    // "the kill date moves to March": the subject ends at its verb, one `subjectOf` knows or any plain verb with -s.
    const ws = w[1]!.split(/\s+/);
    const at = ws.findIndex((x, i) => i >= 2 && /^(?:the|our)$/i.test(ws[0]!) && (AUX.test(x) || (/\p{Ll}s$/u.test(x) && VERBS.test(x.replace(/(?<=(?:s|sh|ch|x|z|o))es$|s$/, "")))));
    const np = subjectOf(w[1]!)?.np ?? (at > 0 && ws.slice(0, at).every((x) => !/[,;:()]/.test(x) && !PRONOUN.test(bareWord(x))) ? ws.slice(0, at).join(" ") : null);
    return np ? { np, key: key(np), form: "whether", tail: w[1]!.slice(np.length) } : null;
  }
  const and = core.match(/^on\s+(.{3,80}?)\s+and\s+((?:whether|which|how|when|who|what|if)\b.+)$/i);
  if (and && nounPhrase(and[1]!)) return { np: and[1]!, key: key(and[1]!), form: "and", tail: and[2]! };
  const on = core.match(/^on\s+([^:]+)$/i);
  return on && nounPhrase(on[1]!) ? { np: on[1]!, key: key(on[1]!), form: "on", tail: "" } : null;
}

/**
 * FOLLOW-1: two calls on one thing are one to-do. Calls share a subject when it's the same noun phrase ("the dedicated
 * capacity price"): one of two words or more anywhere in the draft, one word only from the same item or the lines
 * either side. Merged, the better-formed comes first and the other's choice joins it: "whether the dedicated capacity
 * price is a separate line or bundled, and whether it can be ready for the beta". A bare "on the price" beside a
 * worded call on it adds nothing, so the worded one stays; so does the better-formed when the two don't fit in one
 * to-do. The whys join, and the earlier due date stands. The one to-do is read from both calls' items: it keeps the IDs
 * of both (`ids`), the earlier item's first.
 */
function mergeCalls(calls: Call[], identifier: string): Call[] {
  const out: Call[] = [];
  const rank = { whether: 0, and: 1, on: 2 } as const;
  for (const c of calls) {
    const s = subjectOfCall(c.core);
    const i = s ? out.findIndex((o) => {
      const t = subjectOfCall(o.core);
      return !!t && t.key === s.key && !!s.key && (s.key.split(" ").length >= 2 || Math.abs(o.at - c.at) <= 1);
    }) : -1;
    if (!s || i < 0) { out.push(c); continue; }
    const o = out[i]!;
    const t = subjectOfCall(o.core)!;
    const [first, second, fs, ss] = rank[s.form] < rank[t.form] ? [c, o, s, t] : [o, c, t, s];
    const it = pluralOf(fs.np) ? "they" : "it";
    const join = ss.form === "on" ? null : ss.form === "and" ? ss.tail : `whether ${it}${ss.tail}`;
    let core = fs.form === "on" || !join ? first.core : `${first.core}, and ${join}`;
    if (fs.form === "and" && ss.form === "and") core = `${first.core}, and ${ss.tail}`;
    if (`${first.about ? `${first.about}: decide` : "Decide"} ${core} (${identifier})`.length > 200) core = first.core;
    const whys = [...new Set([first.why, second.why].filter(Boolean))].filter((x, _k, all) => !all.some((y) => y !== x && y.includes(x)));
    const dues = [first.due, second.due].filter((d): d is string => !!d).sort();
    const ids = [...new Set([...o.ids, ...c.ids])];
    out[i] = { ...first, core, text: worded(core, identifier, first.about), why: cut(whys.join(" "), 400), due: dues[0] ?? null, id: ids[0]!, ids, how: o.how === "clause" || c.how === "clause" ? "clause" : first.how, at: o.at };
  }
  return out;
}

/**
 * One item a draft's follow-ups are read from, with its fixed ID (`id`), and what it became (FOLLOW-1): a call, a
 * question, or neither. `junk`: neither, and nothing someone can do either ("Written plan owed."): no follow-up at all
 * (D2-8).
 */
export interface FollowUpItem { text: string; id: string; decision: DraftDecision | null; question: DraftQuestion | null; junk?: true }

/**
 * Something someone can do, by its first word: an action ("Send the plan", "Check with legal"), a choice's verb
 * ("Ship the beta …") or any plain verb (`VERBS`). "Written plan owed." and "Pilot length for Globex" aren't.
 */
function doable(s: string): boolean {
  const w = bareWord(s.split(/\s+/)[0] ?? "");
  return ACTION.test(s) || DO.test(s) || VERBS.test(w);
}

/**
 * A fragment, not a sentence: eight words or fewer and no verb that makes it one ("Written plan owed.", "Pilot length
 * for Globex"). "The preview link is switched off on Nov 27." says something, so it is never junk.
 */
function fragment(s: string): boolean {
  const ws = s.replace(/[.!]+$/, "").split(/\s+/).map(bareWord).filter(Boolean);
  return ws.length > 0 && ws.length <= 8 && !ws.some((w) => AUX.test(w) || FINITE.test(w) || (/\p{Ll}s$/u.test(w) && VERBS.test(w.replace(/(?<=(?:s|sh|ch|x|z|o))es$|s$/, ""))));
}

/**
 * Reads a draft's follow-ups. Calls: every item or line marked "PM decides" outside its question sections, and in them
 * a line that isn't a list item ("Supports: … PM decides") or an item that asks the PM to choose ("Should we …?").
 * In a draft built around one decision, the calls in its Decision, Options and Recommendation sections are that one
 * decision (`oneDecision`). Questions: every other top-level item in a section whose heading names questions or
 * blocking ones, or listed under a "Blocking:" line. R2e, R2f: an item there marked PM decides is a call whatever its
 * "?" ("…? PM decides: pursue." is whether to pursue it), and a "— needs:" or "— ask:" mark beats its words. Two calls
 * on one thing are one (`mergeCalls`).
 */
export function readFollowUps(markdown: string, identifier: string, now: Date, task: { title?: string | null } = {}): { decisions: DraftDecision[]; questions: DraftQuestion[] } {
  const { decisions, questions } = readAll(markdown, identifier, now, task);
  return { decisions, questions };
}

/**
 * D2-8: each item of a draft its follow-ups are read from (plain text, as `plain` gives it), with the call or the
 * question it is now, so a follow-up an older PMX made from it can be read again by today's rules.
 */
export function followUpItems(markdown: string, identifier: string, now: Date, task: { title?: string | null } = {}): FollowUpItem[] {
  return readAll(markdown, identifier, now, task).items;
}

/**
 * A draft's items, section by section, each with its fixed ID (FOLLOW-1). The IDs are made here, from the items as the
 * author wrote them and nothing else, before anything is read from them or worded: so no wording rule, now or later,
 * can change one (src/review/follow-up-id.ts).
 */
function partsOf(doc: ReturnType<typeof sections>): Part[] {
  const parts = [{ heading: "", blocks: blocksOf({ heading: "", lines: doc.intro }) }, ...doc.sections.map((s) => ({ heading: s.heading, blocks: blocksOf(s) }))];
  const ids = itemIds(parts.flatMap((p) => p.blocks.map((b) => b.text)));
  let n = 0;
  return parts.map((p) => ({ heading: p.heading, blocks: p.blocks.map((b) => ({ ...b, id: ids[n++]! })) }));
}

/** Every item of a draft, in its order, with its fixed ID and its text as the author wrote it (FOLLOW-1). */
export function draftItems(markdown: string): { id: string; text: string }[] {
  return partsOf(sections(markdown)).flatMap((p) => p.blocks.map((b) => ({ id: b.id, text: b.text })));
}

function readAll(markdown: string, identifier: string, now: Date, task: { title?: string | null }): { decisions: DraftDecision[]; questions: DraftQuestion[]; items: FollowUpItem[] } {
  const doc = sections(markdown);
  // First, and from the draft alone: each item's fixed ID.
  const all = partsOf(doc);
  const title = plain(task.title ?? doc.title ?? "").replace(/^[A-Z][A-Z0-9]*-\d+\s*[:—–-]\s*/, "").replace(/[\s.]+$/, "") || null;
  const r: Reading = { ...properWords(markdown, task.title), subject: subjectOfTitle(task.title ?? doc.title), id: identifier, cites: /\[web:|https?:\/\//i.test(markdown), title };
  const decisions: Call[] = [];
  const questions: DraftQuestion[] = [];
  const read: { text: string; id: string }[] = [];
  const nothing: { text: string; id: string; junk: boolean }[] = [];
  /** What this reading already has, by what it reads as (`sameAs`): a second item that reads the same joins it. */
  const seen = new Map<string, { ids: string[] }>();
  function add(list: Call[], x: Unread<Call> | null, from: Block, at: number): void;
  function add(list: DraftQuestion[], x: Unread<DraftQuestion> | null, from: Block, at: number): void;
  function add(list: (Call | DraftQuestion)[], x: Unread<Call> | Unread<DraftQuestion> | null, from: Block, at: number): void {
    if (!x) return;
    read.push({ text: plain(from.text), id: from.id });
    const same = sameAs(x);
    const first = seen.get(same);
    // The same follow-up, read from one more item: it keeps that item's ID too.
    if (first) { if (!first.ids.includes(from.id)) first.ids.push(from.id); return; }
    const made = "core" in x ? { ...x, at, id: from.id, ids: [from.id] } : { ...x, id: from.id, ids: [from.id] };
    seen.set(same, made);
    list.push(made);
  }
  const brief = oneDecision(all, identifier, now, r);
  const one: Unread<Call> | null = brief ? { ...brief, how: "clause", about: null, at: 0 } : null;
  all.forEach((s, si) => {
    const areaOf = (h: string): DraftQuestion["where"] | null => (QUESTIONS.test(h) ? (/blocking/i.test(h) ? "blocking" : "open") : null);
    // A call in the Decision, Options or Recommendation section of a draft built around one decision is that decision.
    const call = (text: string) => (one && AROUND_HEADING.test(plain(s.heading)) ? one : decisionOf(text, identifier, now, r));
    // Where list items are questions: the section's heading says so, or a `###` sub-heading under it does.
    let area = areaOf(plain(s.heading));
    let label: DraftQuestion["where"] | null = null;
    s.blocks.forEach((b, bi) => {
      // Where the item is, so calls from the same item or the lines either side of it can be told (`mergeCalls`).
      const at = si * 10000 + bi;
      if (b.sub) { area = areaOf(plain(b.text)); label = null; return; }
      if (!b.list) {
        const t = plain(b.text);
        if (LABEL.test(t)) { label = /blocking/i.test(t) ? "blocking" : "open"; return; }
        label = null;
        if (PM_DECIDES.test(b.text)) add(decisions, call(b.text), b, at);
        return;
      }
      const where = label ?? area;
      if (where) {
        // R2e, R2f: an item marked PM decides is the PM's call, whatever its "?" (whom to ask, or the work it needs,
        // go into its why); an item marked "— needs:" is work and one marked "— ask:" is an ask, whatever its words;
        // an item marked "— ask: the PM" is the PM's own call. Only an unmarked item goes by its words.
        const { text: q, mark } = unmark(plain(b.text));
        const lead = q.replace(/^(?:Q\d+|blocking|open)\s*[:.)-]\s*/i, "");
        // FOLLOW-1 (end-to-end test 2026-11-27): a question about what another party expects, wants, needs, uses or
        // plans is theirs to answer, marked PM decides or not ("How many … does the customer expect? PM decides."):
        // an ask of them, the mark left out. Not when the mark names a call of its own ("PM decides: whether to offer
        // it on Team"), or says to pursue it.
        const called = PM_DECIDES.test(q) ? clauseOf(lead) : null;
        const party = !mark && !!called && !called.core && !called.go && !!partyIn(sentencesOf(lead).find((x) => x.endsWith("?")) ?? "");
        const text = party ? b.text.replace(/\*{0,2}\(?\s*PM decides\s*\)?[.:]?\*{0,2}/gi, "").trim() : b.text;
        const decided = (PM_DECIDES.test(q) && !party) || (mark?.ask && isPm(mark.value)) || (!mark && CHOICE.test(lead));
        // The sentence before the item in the draft, when a paragraph right before it says it (FOLLOW-1).
        const prev = s.blocks[bi - 1];
        const prior = prev && !prev.list && !prev.sub && !LABEL.test(plain(prev.text)) ? sentencesOf(plain(prev.text)).at(-1) ?? null : null;
        const found = decided ? null : questionOf(text, where, r, prior);
        const d = decided || (found?.ask?.role && isPm(found.ask.role)) ? decisionOf(b.text, identifier, now, r) : null;
        // A call the reader can't word stays a question rather than being lost.
        const question = d ? null : found ?? (decided ? questionOf(text, where, r, prior) : null);
        if (d) add(decisions, d, b, at);
        else if (question) add(questions, question, b, at);
        else {
          // D2-8: an item that is no follow-up by today's rules (R2c: no question, no call). One that isn't something
          // to do either ("Written plan owed.", not "Send the plan.") is no follow-up at all (`junk`).
          const first = sentencesOf(lead)[0] ?? "";
          nothing.push({ text: plain(b.text), id: b.id, junk: !mark && !PM_DECIDES.test(q) && fragment(first) && !doable(first) });
        }
      } else if (PM_DECIDES.test(b.text)) add(decisions, call(b.text), b, at);
    });
  });
  // R2b: a draft that names its calls ("PM decides: …") gives those and the ones it words as a choice, never a lead
  // beside them, so marks with no decision of their own can't take the to-dos the named calls need.
  const named = decisions.some((d) => d.how === "clause");
  const kept = mergeCalls(decisions.filter((d) => !named || d.how !== "lead"), identifier);
  const out = kept.map(({ how: _how, core: _core, about: _about, at: _at, ...d }) => d);
  // Each item, by its ID, to the one call or question it was read as.
  const called = new Map<string, DraftDecision>(out.flatMap((d) => d.ids.map((id) => [id, d] as const)));
  const asked = new Map<string, DraftQuestion>(questions.flatMap((q) => q.ids.map((id) => [id, q] as const)));
  const items: FollowUpItem[] = [
    ...read.map(({ text, id }) => ({ text, id, decision: called.get(id) ?? null, question: asked.get(id) ?? null })),
    ...nothing.map((x) => ({ text: x.text, id: x.id, decision: null, question: null, ...(x.junk ? { junk: true as const } : {}) })),
  ];
  return { decisions: out, questions, items };
}
