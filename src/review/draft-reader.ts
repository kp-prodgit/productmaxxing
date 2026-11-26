import { createHash } from "node:crypto";

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

/**
 * Plain words from a Markdown line: no emphasis, links, code marks or source IDs like [T7]. What a code span holds is
 * kept as written (`gpu_ms` stays gpu_ms), and so is an underscore inside a word (adapter_version).
 */
export function plain(s: string): string {
  const code: string[] = [];
  return s
    .replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${code.push(c) - 1}\u0000`)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\s*\[(?:[A-Z]{1,3}\d+(?:\s*[,;]\s*[A-Z]{1,3}\d+)*)\]/g, "")
    .replace(/[*`]+/g, "")
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
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
  key: string;
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
   * "what Initech asked for, since no cited source shows it" is "Find out what Initech asked for". Never a fragment.
   */
  title: string;
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
  key: string;
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
/** The sections a draft built around one decision gives it: a decision brief's Decision, Options and Recommendation. */
const DECISION_HEADING = /^(?:the\s+)?decision(?:\s+(?:needed|to make))?$/i;
const AROUND_HEADING = /^(?:(?:the\s+)?decision(?:\s+(?:needed|to make))?|options?(?:\s+considered)?|recommend(?:ation|ations|ed option)?)$/i;
const RECOMMENDATION_HEADING = /^recommend(?:ation|ations|ed option)?$/i;

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (kind: string, text: string) => createHash("sha256").update(`${kind}\n${norm(text)}`).digest("hex").slice(0, 12);

interface Block { text: string; list: boolean; sub?: boolean }

/**
 * A section's lines as blocks: top-level list items (their nested lines folded in), paragraphs, and `###` sub-headings.
 * Tables and quotes are left out.
 */
function blocksOf(s: Section): Block[] {
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
 * should be set as an add-on. Anything else is left as written.
 */
function whetherOf(s: string): string {
  // "Should we …?", "Shall we …?", and "Do we give Globex numbers …?" (not "Do we know …?", which asks a fact).
  const we = s.match(/^(?:should|shall) we\s+(.+?)\??$/i) ?? s.match(/^do we\s+(?!know|have|need|understand|see)(.+?)\??$/i);
  if (we) return `whether to ${we[1]}`;
  const it = s.match(SHOULD_IT);
  return it ? `whether ${it[1]} should ${it[2]!.toLowerCase()}${it[3]}` : s;
}

/** Nouns that make a verb the first word of a compound noun: "kill date", "launch plan", "ship date". */
const COMPOUND = /^(?:dates?|criteria|criterion|plans?|windows?|lists?|deadlines?|points?|thresholds?|floors?|ceilings?|times?|timing|orders?|periods?|cadence|sequence|reviews?|gates?)$/i;
/** A decision already worded as one: "whether …", "which …", "between …", "on the …". */
const CHOSEN = /^(?:(?:whether|if|how|which|what|who|when|where|to|between)\b|on\s)/i;
const AUX = /\b(?:is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|should|must|may|might|shall)\b/i;
/** A noun phrase, not a sentence or a question: "Deletion window", "kill date and price floor". */
const nounPhrase = (c: string) => c.split(/\s+/).length <= 8 && !AUX.test(c) && !/[?:;]/.test(c);
/** "the deletion window" for "Deletion window"; a phrase with its own determiner keeps it. */
const theOf = (c: string) => (DETERMINER.test(c) ? lowerFirst(c) : `the ${/^\p{Lu}{2}/u.test(c) ? c : lowerFirst(c)}`);

/**
 * A choice worded as the decision to make: "accept, counter or decline …" is whether to; "Should we …?" and "Should the
 * price …?" too. Only a verb gets "whether to": "kill date and price floor" is a noun phrase, the decision on it.
 */
function asChoice(core: string): string {
  const second = core.replace(/^to\s+/i, "").split(/\s+/)[1]?.replace(/[^\w]/g, "") ?? "";
  let c = DO.test(core) && !COMPOUND.test(second) ? `whether to ${core.replace(/^to\s+/i, "").replace(/^./, (x) => x.toLowerCase())}` : core;
  c = whetherOf(c).replace(/^((?:whether|if|how|which|what|who|when|where)\b.+?)\?$/i, "$1");
  return !CHOSEN.test(c) && nounPhrase(c) ? `on ${theOf(c)}` : c;
}

/** The to-do's words: "Decide whether to … (PMX-12)", or "Decide: <the item's lead> (PMX-12)". At most 200 characters. */
function worded(core: string, identifier: string): string {
  const id = ` (${identifier})`;
  const verb = /^(?:(?:whether|if|how|which|what|who|when|where|to|between)\b|on\s)/i.test(core) ? "Decide " : "Decide: ";
  const body = cut(core.replace(/^./, (c) => (verb === "Decide " ? c.toLowerCase() : c)), 200 - verb.length - id.length);
  return `${verb}${body}${id}`;
}

/**
 * A call as the reader found it: `clause` when the draft names it after "PM decides:" (or it is a decision brief's one
 * decision), `worded` when the draft words it as a choice ("Supports: whether …", "Should we …?", "Choice: …"), and
 * `lead` when only the item's first sentence gives it. A draft that names its calls (R2b) gives only its named and
 * worded ones: a lead beside them is a mark with no decision of its own.
 */
type Call = DraftDecision & { how: "clause" | "worded" | "lead" };

/** A short label with no verb: "Internal plan", "Length", "Price options", "Call 1". */
const VERB = /\b(?:is|are|was|were|be|been|has|have|had|do|does|did|can|could|will|would|should|must|may|might|needs?|gives?|makes?|takes?|keeps?|wants?|asks?|pays?|goes|gets?)\b|\w(?:ed|ing)\b/i;
const labelish = (s: string) => !!s && s.split(/\s+/).length <= 4 && !VERB.test(s);
/** A sentence that is a note, not a decision: "Assumption: …", "Unknown: …". */
const NOTE = /^(?:assumptions?|unknowns?|notes?|context|evidence|sources?|why|risks?|caveats?)\s*:/i;
/** A mark that only qualifies a label: "Price options (all PM decides): …", "Options (PM decides):". */
const MARK_IN_LABEL = /\([^()]*\bPM decides\b[^()]*\)\s*:/i;
const lowerFirst = (s: string) => s.replace(/^\p{Lu}(?=\p{Ll})/u, (c) => c.toLowerCase());

/** The PM who accepts, as a role: a question "— ask: the PM" is the PM's own call (R2). */
export const isPm = (role: string) => /^(?:the\s+)?(?:pm|product manager|accepting pm|you)$/i.test(role.trim());

/** The decision a "PM decides" item or line asks for, worded as the decision to make, and what the draft says about it. */
function decisionOf(text: string, identifier: string, now: Date): Call | null {
  const { text: p, mark } = unmark(plain(text));
  // R2b: a mark inside a label ("Price options (all PM decides): …") has no decision of its own.
  if (MARK_IN_LABEL.test(p)) return null;
  const ss = sentencesOf(p);
  // R2f: whom the draft says to ask, or the work it says the call needs, goes with the call.
  const role = mark?.ask ? roleOf(mark.value) : null;
  const also = mark ? (mark.ask ? (role && !isPm(role) ? `Ask ${role}.` : "") : mark.value ? `Needs ${mark.value}.` : "") : "";
  // 1. "PM decides: whether to …" (or "PM decides: Deletion window."): the clause after it is the decision, and what
  //    the draft says after it (and the options before it) is its why.
  // 2. A label before it: "Supports: how to position …. PM decides.", "Decision this draft supports: whether …", or
  //    "Choice: accept, counter or decline … (PM decides)", the label left out.
  const clause = clauseOf(p);
  let core = clause.core || afterLabel(p, LABELLED);
  let how: Call["how"] = clause.core ? "clause" : "worded";
  let why: string | null = null;
  if (clause.core || clause.go) {
    const at = ss.findIndex((x) => PM_DECIDES.test(x));
    why = [...ss.slice(0, Math.max(at, 0)).filter((x) => /^(?:options?\s*:|recommend)/i.test(x)), ...clause.rest].join(" ");
  }
  if (core) {
    // "PM decides: Length: 60 or 90 days" is the decision on the length.
    const labelled = core.match(/^([^:]{1,40}):\s+(.+)$/);
    core = labelled && labelish(labelled[1]!) ? `on ${theOf(labelled[1]!)}: ${labelled[2]}` : asChoice(core);
  }
  // 3. The item's lead, its first sentence, with the options the draft gives when they fit.
  const options = ss.find((s) => /^options?\s*:/i.test(s));
  let withOptions = false;
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
    // "Price: PM decides." names the decision by its label: "Decide on the price".
    const named = marked.match(/^(.{1,40}?):\s*\(?PM decides\W*$/i)?.[1];
    if (clause.go && lead) {
      // "How long does an import take? PM decides: pursue." is the decision whether to pursue the question.
      core = lead.endsWith("?") ? `whether to pursue: ${lead}` : `whether to pursue ${lowerFirst(lead)}`;
      how = "worded";
    } else if (named && labelish(named)) core = `on ${theOf(named)}`;
    else if (label) {
      const body = (colon && label === colon[1] ? colon[2]! : "") || next;
      if (!body || NOTE.test(body) || /^[^:]{1,30}:\s/.test(body) && !/^options?\s*:/i.test(body)) return null;
      if (/^(?:whether|should|shall|which|do we|is it worth|between)\b/i.test(body) || DO.test(body)) { core = asChoice(body); how = "worded"; }
      else core = `on ${theOf(label)}: ${body.replace(/^options?\s*:\s*/i, "")}`;
    } else if (lead.endsWith("?")) {
      // R2e: a call asked as a question is worded as a choice ("Ship …, or raise it?" is whether to ship …).
      core = asChoice(lead);
      how = "worded";
    } else {
      core = lead;
      const both = options && core && !/^options?\s*:/i.test(core) ? `${core}. ${strip(options)}` : "";
      if (both && both.length <= 200 - 10 - identifier.length) { core = both; withOptions = true; }
      // "Should we offer X?" is the decision whether to offer X; "Pilot price" the decision on the pilot price.
      const asked = whetherOf(core).replace(/^(whether\b.+?)\?$/i, "$1");
      if (asked !== core && /^whether\b/i.test(asked)) how = "worded";
      core = !CHOSEN.test(asked) && !DO.test(asked) && nounPhrase(asked) ? `on ${theOf(asked)}` : asked;
    }
    // Never "Decide: Options: …" or "Decide: Length: …": a stray label is no decision.
    if (!CHOSEN.test(core) && /^[^:()]{1,40}:(?:\s|$)/.test(core)) return null;
  }
  if (!core) return null;
  const said = [why ?? ownWhy(ss, withOptions), also].filter(Boolean).join(" ");
  return { text: worded(core, identifier), why: cut(said, 400), due: deadlineIn(p, now), key: keyOf("d", core), how };
}

/** What an item says about its own call: its options (unless they're in the to-do already) and its recommendation. */
function ownWhy(ss: string[], withOptions = false): string {
  return ss.filter((s) => (!withOptions && /^options?\s*:/i.test(s)) || /^recommend(?:ation|ed|s)?\b/i.test(s)).map((s) => s.replace(/\s*PM decides\.?$/i, "").trim()).filter(Boolean).join(" ");
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
function oneDecision(parts: Part[], identifier: string, now: Date): DraftDecision | null {
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
  core = asChoice(core);
  const rec = parts.find((p) => RECOMMENDATION_HEADING.test(plain(p.heading)));
  const why = (rec ? inShort(rec.blocks.filter((b) => !b.sub).map((b) => b.text)) : "")
    || inShort(decision.blocks.filter((b) => /\brecommend(?:s|ed|ation)?\b/i.test(b.text) && !/^\W*PM decides\W*$/i.test(b.text)).map((b) => b.text))
    || marked.map((b) => ownWhy(sentencesOf(plain(b.text)))).find(Boolean)
    || "";
  // The date the Decision section states for it, then one beside a mark, then one among the Decision section's items.
  const dateIn = (bs: Block[]) => bs.map((b) => deadlineIn(plain(b.text), now)).find(Boolean) ?? null;
  const due = dateIn(decision.blocks.filter((b) => !b.list && !b.sub)) ?? dateIn(marked) ?? dateIn(decision.blocks.filter((b) => b.list));
  return { text: worded(core, identifier), why: cut(why, 400), due, key: keyOf("d", core) };
}

/**
 * The mark a drafting skill puts on each question (R2): "— ask: <role>" when one person can answer it, "— needs: <kind
 * of work>" when it takes research or a document. Also read after a spaced hyphen, in brackets ("(ask: legal)"), or as
 * a sentence of its own ("Needs: research."). The colon is required, so prose like "— needs approval" isn't a mark.
 */
const MARK = /(?:\s*[—–]\s*|\s+-{1,2}\s+|\s*\(\s*|(?:^|(?<=[.?!])\s+))(ask|needs?)\s*:\s*([^.;,?!()[\]—–]*)\)?\.?/i;

/** The item without its mark, and the mark. */
function unmark(p: string): { text: string; mark: { ask: boolean; value: string } | null } {
  const m = MARK.exec(p);
  if (!m) return { text: p, mark: null };
  const text = `${p.slice(0, m.index)} ${p.slice(m.index + m[0].length)}`.replace(/\s+([.?!,;:])/g, "$1").replace(/\s+/g, " ").trim();
  return { text, mark: { ask: /^ask$/i.test(m[1]!), value: m[2]!.replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, "") } };
}

const DETERMINER = /^(?:the|our|their|its|your|a|an|someone|somebody|whoever|each)\b/i;
/** A team asked as a whole: "Ask legal", "Ask finance". */
const TEAM = /^(?:legal|finance|sales|support|marketing|procurement|security|engineering|design|product|data|ops|operations|leadership|partnerships|accounting|compliance|research)$/i;
/** A team known by its letters: "Ask IT". Other letters are a role: "the CFO". */
const TEAM_LETTERS = /^(?:IT|HR|QA|PR|BD)$/;
/** Words that make a phrase a role: "the account lead", "Globex's procurement contact", "the data team". */
const ROLE_WORD = /\b(?:leads?|owners?|managers?|head|director|vp|chief|officer|contact|engineers?|engineering|designers?|design|counsel|lawyer|champion|sponsor|buyer|admin|administrator|team|finance|legal|sales|support|security|procurement|marketing|analysts?|architect|partner|rep|representative|executive|exec|founder|desk|office|department|committee|board|pm)\b/i;
/** Who isn't one person to ask: several people, customers in general, a pronoun, or no one. */
const NOT_ONE = /^(?:\d|one|two|three|four|five|six|seven|eight|nine|ten|a few|few|some|several|many|more|most|all|any|them|him|her|us|we|i|you|they|it|this|that|everyone|anyone|nobody|no one|around|customers?|users?|admins|accounts?|buyers|prospects?|people|interviewees?|in|at|on|during|after|before|for|about|whether|if)\b/i;
const capWord = (w: string) => /^\p{Lu}\p{Ll}/u.test(w) && !/['’]s$/.test(w);

/**
 * The role a draft gives for who answers a question, worded to follow "Ask": "the finance lead", "legal", "the CFO",
 * "Globex's procurement contact". Null for anything that may be a person's name ("Lee Park", "Sam from finance"):
 * PMX's to-dos from drafts name roles, never people. `strict` also wants a word that makes it a role (for a role read
 * from the draft's prose rather than its mark).
 */
function roleOf(raw: string, strict = false): string | null {
  let r = raw.replace(/\s+/g, " ").trim().replace(/[\s.,;:]+$/, "");
  // "Lee Park, the finance lead": the part that is a role.
  if (r.includes(",")) r = r.split(/\s*,\s*/).find((x) => DETERMINER.test(x) && ROLE_WORD.test(x)) ?? "";
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
const ASK_SENTENCE = /^(?:ask|check with|confirm with|a question for)\s+(.+?)(?:\s+(?:for|about|to|whether|if|before|by|after|this|next|when|how|what|which|who|in|during)\b.*)?[.!]?$/i;
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
  return ASK_SHAPES.some((re) => re.test(title)) && !RESEARCH_WORDS.test(title) ? { role: null, by: "words" } : null;
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
 * A question item: the question first (through its "?"), then the rest of what the draft says about it; its whole
 * title; and who answers it (R2): the draft's mark, else its words.
 */
function questionOf(text: string, where: DraftQuestion["where"]): DraftQuestion | null {
  const { text: p, mark } = unmark(plain(text).replace(/^(?:Q\d+|blocking|open)\s*[:.)-]\s*/i, ""));
  const ss = sentencesOf(p);
  if (!ss.length) return null;
  const q = ss.findIndex((s) => s.endsWith("?"));
  const upto = q >= 0 && q <= 1 ? q : 0;
  const question = ss.slice(0, upto + 1).join(" ");
  const rest = ss.slice(upto + 1);
  const title = titleOf(ss);
  // R2c: without a mark, only a question is one: an item with a "?", or worded as one ("what …", "whether …", "It's
  // unclear how …"). A statement ("The sources mention a second answer due Dec 15.") stays in the draft.
  if (!mark && !p.includes("?") && !title.startsWith("Find out ")) return null;
  const ask = mark ? (mark.ask ? { role: roleOf(mark.value), by: "mark" as const } : null) : askIn(title, rest);
  return { question, title, rest, where, ask, needs: mark && !mark.ask ? mark.value || null : null, key: keyOf("q", question) };
}

/**
 * Reads a draft's follow-ups. Calls: every item or line marked "PM decides" outside its question sections, and in them
 * a line that isn't a list item ("Supports: … PM decides") or an item that asks the PM to choose ("Should we …?").
 * In a draft built around one decision, the calls in its Decision, Options and Recommendation sections are that one
 * decision (`oneDecision`). Questions: every other top-level item in a section whose heading names questions or
 * blocking ones, or listed under a "Blocking:" line. R2e, R2f: an item there marked PM decides is a call whatever its
 * "?" ("…? PM decides: pursue." is whether to pursue it), and a "— needs:" or "— ask:" mark beats its words.
 */
export function readFollowUps(markdown: string, identifier: string, now: Date): { decisions: DraftDecision[]; questions: DraftQuestion[] } {
  const doc = sections(markdown);
  const decisions: Call[] = [];
  const questions: DraftQuestion[] = [];
  const seen = new Set<string>();
  const add = <T extends { key: string }>(list: T[], x: T | null) => { if (x && !seen.has(x.key)) { seen.add(x.key); list.push(x); } };
  const all: Part[] = [{ heading: "", blocks: blocksOf({ heading: "", lines: doc.intro }) }, ...doc.sections.map((s) => ({ heading: s.heading, blocks: blocksOf(s) }))];
  const brief = oneDecision(all, identifier, now);
  const one: Call | null = brief ? { ...brief, how: "clause" } : null;
  for (const s of all) {
    const areaOf = (h: string): DraftQuestion["where"] | null => (QUESTIONS.test(h) ? (/blocking/i.test(h) ? "blocking" : "open") : null);
    // A call in the Decision, Options or Recommendation section of a draft built around one decision is that decision.
    const call = (text: string) => (one && AROUND_HEADING.test(plain(s.heading)) ? one : decisionOf(text, identifier, now));
    // Where list items are questions: the section's heading says so, or a `###` sub-heading under it does.
    let area = areaOf(plain(s.heading));
    let label: DraftQuestion["where"] | null = null;
    for (const b of s.blocks) {
      if (b.sub) { area = areaOf(plain(b.text)); label = null; continue; }
      if (!b.list) {
        const t = plain(b.text);
        if (LABEL.test(t)) { label = /blocking/i.test(t) ? "blocking" : "open"; continue; }
        label = null;
        if (PM_DECIDES.test(b.text)) add(decisions, call(b.text));
        continue;
      }
      const where = label ?? area;
      if (where) {
        // R2e, R2f: an item marked PM decides is the PM's call, whatever its "?" (whom to ask, or the work it needs,
        // go into its why); an item marked "— needs:" is work and one marked "— ask:" is an ask, whatever its words;
        // an item marked "— ask: the PM" is the PM's own call. Only an unmarked item goes by its words.
        const { text: q, mark } = unmark(plain(b.text));
        const decided = PM_DECIDES.test(q) || (mark?.ask && isPm(mark.value)) || (!mark && CHOICE.test(q.replace(/^(?:Q\d+|blocking|open)\s*[:.)-]\s*/i, "")));
        const found = decided ? null : questionOf(b.text, where);
        const d = decided || (found?.ask?.role && isPm(found.ask.role)) ? decisionOf(b.text, identifier, now) : null;
        // A call the reader can't word stays a question rather than being lost.
        if (d) add(decisions, d);
        else add(questions, found ?? questionOf(b.text, where));
      } else if (PM_DECIDES.test(b.text)) add(decisions, call(b.text));
    }
  }
  // R2b: a draft that names its calls ("PM decides: …") gives those and the ones it words as a choice, never a lead
  // beside them, so marks with no decision of their own can't take the to-dos the named calls need.
  const named = decisions.some((d) => d.how === "clause");
  return { decisions: decisions.filter((d) => !named || d.how !== "lead").map(({ how: _how, ...d }) => d), questions };
}
