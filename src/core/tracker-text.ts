import { makeRedactor } from "./redact.js";

/**
 * What a PMX task in Linear may say (F14, PRIV-6; founder decision 2026-11-25): the customer or partner company, the
 * deal stage and the dates the sources state ("Acme's Dec 8 beta", "renewal due Jan 15"). Never people's names, quotes,
 * meeting titles or fundraising. One guard for every place PMX writes tracker text: suggested tasks, follow-ups, the
 * draft-ready comment and the company roll-up. It judges a sentence at a time, so a description loses only the sentence
 * that can't go, never the rest.
 */
export type TextProblem = "transcript" | "quote" | "placeholder" | "fundraising" | "name" | "title" | "contact";

/** What each problem is, in a PM's words, for one sentence and for several. */
export const PROBLEM_TEXT: Record<TextProblem, [string, string]> = {
  transcript: ["carried transcript markup", "carried transcript markup"],
  quote: ["quoted someone", "quoted someone"],
  placeholder: ["had a redaction placeholder", "had redaction placeholders"],
  fundraising: ["was about fundraising", "were about fundraising"],
  name: ["named a person", "named people"],
  title: ["named a meeting by its title", "named meetings by their titles"],
  contact: ["had contact details", "had contact details"],
};

export interface TrackerRules {
  /**
   * Names someone listed on purpose (the team's CRM list, the PM's do-not-read people): matched in any case, as whole
   * words.
   */
  names?: string[];
  /**
   * Names found in the sources (participants, speaker labels): matched as a capitalized word ("Lee", "Lee Park"), so an
   * ordinary word that is also a name in lower case ("will", "grant") still reads as a word.
   */
  people?: string[];
  /** Meeting titles. A sentence that repeats one of three words or more is cut. */
  titles?: string[];
  /** The team's approved meeting series (F3): their names are meeting titles too, matched from two words. */
  series?: string[];
}

/** "Microphone:", "System audio:", "Speaker 2:", "[00:12:03]": transcript markup. */
export const TRANSCRIPT_MARKS = /\b(microphone|system audio|speaker \d+)\s*:|\[\d{1,2}:\d{2}(:\d{2})?\]/i;
const QUOTE = /["“”„«»]|(?:^|\s)'[^']{3,}'(?=[\s.,;:!?]|$)/;
const PLACEHOLDER = /\[(?:PERSON|EMAIL|PHONE|CARD|ID|HELD)(?:-\d+)?\]/;

/**
 * Fundraising (F14, F5): investors, a round, Series A/B/…, valuation, a term sheet, dilution, the cap table, the option
 * pool, a raise. The test found "investors are asking the moat question" from a Series B call in a Linear description;
 * the words are business-confidential even when no number goes with them. When in doubt a sentence is cut.
 */
const FUNDRAISING_ANY_CASE = new RegExp(
  [
    "\\binvestors?('s|s')?\\b", "\\bventure (capital(ists?)?|firms?|funds?|partners?|backed)\\b", "\\bangel (investors?|rounds?|checks?)\\b",
    "\\b(seed|pre-seed|bridge|funding|fundraising|financing|investment|equity|priced|extension|growth) rounds?\\b", "\\bnext round\\b(?! of)",
    "\\brounds? of (funding|financing|investment)\\b",
    "\\bseries[- ][a-h][- ]?(round|funding|raise|deck|extension|lead|investors?|term)",
    "\\bfund-?rais\\w*", "\\bfund rais\\w*",
    "\\bvaluations?\\b", "\\bpre-money\\b", "\\bpost-money\\b",
    "\\bterm ?sheets?\\b", "(?<!brand )\\bdilution\\b", "\\bdilutive\\b", "\\banti-dilution\\b",
    "\\bcap tables?\\b", "\\boption pools?\\b",
    "\\b(raise|raises|raising|raised) (a |an |our |the |their |its |new |more |another )?(round|capital|funds|funding|money|series)\\b",
    "\\b(raise|raises|raising|raised) (us)?[$€£]\\s?\\d",
    "\\b(our|the|this|next|upcoming|last) raise\\b",
    "\\blead investors?\\b",
  ].join("|"),
  "i",
);
/** Words whose case tells them apart: "Series B" (not a series of tests), "VCs", an "IPO". */
const FUNDRAISING_CASED = /\bSeries [A-H]\b|\bVCs?\b|\bIPOs?\b/;

export const isFundraising = (s: string): boolean => FUNDRAISING_ANY_CASE.test(s) || FUNDRAISING_CASED.test(s);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Words that are names only sometimes: months and days (dates may go to the tracker), and words a source's name list
 * often holds that are ordinary words in a task ("Price", "Will" at the start of a sentence). A single-word name from
 * the sources is never one of these; a full name ("Will Price") still is matched.
 */
const NOT_A_NAME = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "will", "mark", "bill", "grant", "rose", "chase", "frank", "joy", "hope", "faith", "sky", "max", "dawn", "summer", "art", "pat", "sue",
  "ray", "rob", "jack", "drew", "gene", "page", "lane", "price", "long", "young", "king", "hill", "wood", "white", "black", "brown",
  "green", "rich", "case", "cash", "early", "west", "north", "south", "east", "love", "star", "stone", "field", "ford", "cook", "head",
  "the", "and", "for", "you", "all", "new", "one", "two", "our", "team",
]);
/** Speaker labels and mailbox names that aren't anyone's name. */
const GENERIC = new Set([
  "speaker", "microphone", "system", "audio", "me", "you", "host", "guest", "interviewer", "interviewee", "customer", "client", "user", "participant",
  "unknown", "moderator", "facilitator", "notetaker", "note", "taker", "bot", "assistant", "everyone", "all", "pm", "ae", "cs", "sales", "support",
  "admin", "info", "hello", "contact", "billing", "help", "noreply", "no", "reply", "ops", "product", "marketing", "eng", "engineering", "design",
  "hr", "legal", "finance", "team", "office", "recruiting", "careers", "jobs", "press", "security", "it", "dev", "test", "q", "a", "agent", "buyer",
  "fireflies", "granola", "otter", "fathom", "gong", "zoom", "slack", "teams", "meet", "notes", "them", "us", "we", "they",
]);
/**
 * Words that start a line as a heading, not a speaker ("Summary:", "Next steps:", "Action items:"). A speaker label
 * made only of these is no one's name.
 */
const LABEL_WORDS = new Set([
  "summary", "decision", "decisions", "next", "steps", "agenda", "context", "problem", "update", "updates", "example", "result", "results",
  "goal", "goals", "owner", "owners", "action", "actions", "items", "item", "pros", "cons", "question", "questions", "answer", "answers",
  "todo", "todos", "risk", "risks", "status", "plan", "why", "what", "how", "when", "where", "who", "timeline", "scope", "budget", "cost",
  "date", "time", "outcome", "outcomes", "recap", "follow", "ups", "up", "blockers", "blocker", "feedback", "ask", "asks", "request", "issue",
  "issues", "bug", "fix", "step", "phase", "option", "options", "idea", "ideas", "tl", "dr", "ps", "re", "fyi", "edit", "edited", "link",
  "source", "title", "participants", "attendees", "topic", "topics", "takeaways", "takeaway", "highlights", "conclusion", "recommendation",
  "note", "important", "warning", "tip", "reminder", "draft", "proposal", "background", "details", "requirements", "requirement",
]);

/**
 * The people a batch of sources names, for this guard (F14): attendees' names (from "Lee Park <lee@acme.example>", or an
 * address's "lee.park" or "lee"), and the speaker labels in what they said. Kept in memory for one run, never written.
 * `exclude` holds words that are company names here (an outside domain's name, "Acme" in "Acme Support"), so a
 * shared mailbox's name never blocks the company it belongs to.
 */
export function peopleIn(items: { participants?: string[]; text?: string }[], exclude: Iterable<string> = []): string[] {
  const skip = new Set([...exclude].map((x) => norm(x)).filter(Boolean));
  const out = new Set<string>();
  const add = (raw: string) => {
    const words = norm(raw).split(" ").filter((w) => w.length >= 2 && !/\d/.test(w));
    if (!words.length || words.length > 4 || words.every((w) => GENERIC.has(w))) return;
    const named = words.filter((w) => !GENERIC.has(w) && !skip.has(w));
    if (!named.length) return;
    // The original spelling, capitalized, so a sentence reads "Lee" and "Lee Park" the way a source writes them.
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    if (named.length > 1) out.add(named.map(cap).join(" "));
    for (const w of named) if (w.length >= 3 && !NOT_A_NAME.has(w)) out.add(cap(w));
  };
  for (const it of items) {
    for (const p of it.participants ?? []) {
      const email = p.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
      const display = p.replace(/<?[\w.+-]+@[\w-]+(\.[\w-]+)+>?/g, " ").replace(/["'()]/g, " ").trim();
      if (display) add(display);
      if (email) add(email.split("@")[0]!.replace(/[._+-]+/g, " "));
    }
    // A speaker label: one to three words, each capitalized as a name is ("Lee Park:", "Sam:"), not a heading.
    for (const m of (it.text ?? "").matchAll(/^[ \t]*([\p{L}][\p{L}'’. -]{0,38}?)[ \t]*:[ \t]/gmu)) {
      const words = m[1]!.trim().split(/\s+/);
      if (words.length > 3 || !words.every((w) => /^\p{Lu}/u.test(w)) || words.every((w) => LABEL_WORDS.has(norm(w)))) continue;
      add(m[1]!);
    }
  }
  return [...out];
}

/** A compiled guard, so a run checks many sentences without building its patterns again. */
export interface TrackerGuard {
  /** The first problem a sentence (or a title) has, or null when it may go to the tracker. */
  problem(text: string): TextProblem | null;
  /**
   * Text with every sentence that has a problem left out, and what was left out. The rest is kept as written, so a
   * description that loses one sentence still reads.
   */
  clean(text: string): { text: string; cut: TextProblem[] };
}

/** Sentences, split only after . ! or ? followed by a capital, a digit or an opening bracket. */
export const sentencesIn = (text: string): string[] => text.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).map((x) => x.trim()).filter(Boolean);

export function trackerGuard(r: TrackerRules = {}): TrackerGuard {
  const listed = [...new Set((r.names ?? []).map((n) => n.trim()).filter((n) => n.length >= 3))]
    .map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu"));
  const found = [...new Set((r.people ?? []).map((n) => n.trim()).filter((n) => n.length >= 3))].map((n) => {
    const multi = /\s/.test(n);
    // A full name in any case; one word only capitalized, as a name is written.
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, multi ? "iu" : "u");
  });
  // A title of three words or more, or an approved series' name (two words at least, by its own rule). A shorter title
  // is usually just a company and a deal stage ("Acme renewal"), which the tracker may say.
  const titles = [...new Set([...(r.titles ?? []).map(norm).filter((t) => t.split(" ").length >= 3), ...(r.series ?? []).map(norm).filter((t) => t.split(" ").length >= 2)])];
  const redactor = makeRedactor();
  const problem = (s: string): TextProblem | null => {
    if (TRANSCRIPT_MARKS.test(s)) return "transcript";
    if (QUOTE.test(s)) return "quote";
    if (PLACEHOLDER.test(s)) return "placeholder";
    if (isFundraising(s)) return "fundraising";
    if (listed.some((re) => re.test(s)) || found.some((re) => re.test(s))) return "name";
    if (titles.length) {
      const n = ` ${norm(s)} `;
      if (titles.some((t) => n.includes(` ${t} `))) return "title";
    }
    if (redactor.redact(s) !== s) return "contact";
    return null;
  };
  return {
    problem,
    clean(text) {
      const cut: TextProblem[] = [];
      const kept = sentencesIn(text).filter((s) => {
        const p = problem(s);
        if (p) cut.push(p);
        return !p;
      });
      return { text: kept.join(" "), cut };
    },
  };
}

/**
 * The quote rule (PRIV-6, N4): one for every place PMX writes tracker text from what it read. A sentence repeats a
 * source when it shares a run of eight or more words with it that is quoted prose, not a name or a fragment:
 *
 * - **A source's sentence:** the run covers nearly all of one sentence of the source (85% of its words, at least
 *   eight). A list item, a heading, a table row or a label line ("Beta scope: approve/reject, audit log export") is
 *   not a sentence, so repeating one isn't quoting.
 * - **Someone's words:** at least six of the run's words are ordinary words (not a name, product, number or date),
 *   and the run reads like speech or prose, not a noun phrase: a first- or second-person word or a contraction ("we",
 *   "our", "don't"); two verbs, auxiliaries or pronouns ("it would", "keep exporting a"); or function words ("the",
 *   "that", "in") making up at least 35% of the run.
 *
 * So "beta approve/reject and audit log export", "142 questions plus a data handling addendum" or a list of
 * competitors and features may be repeated, and "we export a CSV every Friday and SCIM would fix it" or "keep
 * exporting a spreadsheet every single Friday afternoon by hand" may not.
 * Only the sentence with the match is left out; the caller decides whether what's left is still a task.
 */
export interface QuoteSource {
  /** What the receipt calls it: a source ID ("T3") or a label ("your team's released strategy (vision.md)"). */
  id: string;
  text: string;
}

/** A sentence that repeats a source: the words it shares, as the sentence has them, and which source. */
export interface QuoteHit {
  words: string;
  source: string;
  /** "sentence": it repeats one of the source's sentences; "speech": quoted words that read as someone's. */
  why: "sentence" | "speech";
}

export interface QuoteGuard {
  /** The first quote in a sentence (or a title), or null. */
  match(sentence: string): QuoteHit | null;
  /** Text with every sentence that quotes a source left out, and each quote found. */
  clean(text: string): { text: string; cut: QuoteHit[] };
}

/** Words a run of eight must share, as before N4. */
export const QUOTE_RUN = 8;

/** Dates as a source may write them in lower case ("due dec 1"). "may" and "march" are words too, so only capitalized. */
const MONTH_DAY = new Set("january february april june july august september october november december jan feb apr jun jul aug sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday tue tues thu thur thurs fri".split(" "));
/** First and second person and contractions: someone talking, never the model's summary. */
const SPEECH = new Set(("i i'm i've i'd i'll me my mine we we're we've we'd we'll us our ours you you're you've you'd you'll your yours let's " +
  "don't doesn't didn't can't won't wouldn't isn't aren't wasn't weren't haven't hasn't hadn't shouldn't couldn't it's that's there's what's " +
  "here's gonna wanna yeah okay ok honestly").split(" "));
/** Pronouns, auxiliaries and modals: two of them make a clause. */
const CLAUSE = new Set(("he she it they them their theirs him his her hers is are was were am be been being do does did have has had can could " +
  "will would shall should must might need needs want wants think know not").split(" "));
/** Verbs a feature or a deliverable is rarely named with: someone saying what they do, want or think. */
const VERBS = new Set(("keep keeps kept keeping want wanted wanting need needed say said says saying tell tells told ask asks asked try tries tried " +
  "trying hate hates hated love loves loved think thinks thought know knows knew feel feels felt seem seems seemed get gets got getting gotten " +
  "go goes going went gone come comes came coming make makes made making take takes took taking give gives gave giving spend spends spent spending " +
  "struggle struggles struggled struggling wish hope hopes hoped guess mean means meant believe expect expects expected wonder worry worried " +
  "waste wastes wasted wasting rely relies prefer prefers").split(" "));
/** Words that start an object or a phrase after a verb: "exporting a", "approved by". */
const AFTER_VERB = new Set("a an the this that these those every each their our my your his her its it them us me him all some any to in on at by with from into up out off over through back".split(" "));
/** Words that hold prose together. A fragment of names and nouns has few of them. */
const FUNCTION = new Set([...SPEECH, ...CLAUSE, ...("a an the this that these those every each some any no all both either neither another such what which " +
  "whose who whom there here of to in on at by for with from into onto about over under after before between through during without within " +
  "against among around until since than like per via off out up down and or but nor so yet if because when while although though unless whether " +
  "as then just really very also too only even still already actually maybe probably").split(" ")]);

interface Tok { w: string; raw: string; at: number; end: number; first: boolean; unit: number }

const TOKEN = /[\p{L}\p{N}][\p{L}\p{N}'’]*/gu;
/** A line that is a list item, a heading, a table row or a quoted block: never a sentence of its own. */
const NOT_PROSE = /^\s*(?:[-*+•]|\d+[.)]|#{1,6}|\||>)\s*/;
/** A speaker label at the start of a line ("Lee Park:", "Microphone:"): not part of what was said. */
const SPEAKER = /^\s*(?:\[[\d:\s-]+\]\s*)?[\p{L}][\p{L}'’. -]{0,38}:\s+/u;

function toks(text: string, unit: number, base = 0): Tok[] {
  const out: Tok[] = [];
  let first = true;
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0]!.replace(/’/g, "'");
    out.push({ w: raw.toLowerCase().normalize("NFD").replace(/\p{M}/gu, ""), raw, at: base + m.index!, end: base + m.index! + m[0]!.length, first, unit });
    first = false;
  }
  return out;
}

/** A source as words, each with the sentence (unit) it's in, and which units are prose sentences. */
function sourceWords(text: string): { t: Tok[]; units: { n: number; prose: boolean }[] } {
  const t: Tok[] = [];
  const units: { n: number; prose: boolean }[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const listy = NOT_PROSE.test(line);
    const said = line.replace(SPEAKER, "");
    for (const s of sentencesIn(said)) {
      const w = toks(s, units.length);
      if (!w.length) continue;
      // A sentence ends like one or reads like a clause; a label line ("Scope: SSO, SCIM, audit log") does neither.
      const prose = !listy && (/[.!?]["”']?$/.test(s.trim()) || w.some((x) => SPEECH.has(x.w) || CLAUSE.has(x.w)));
      units.push({ n: w.length, prose });
      t.push(...w);
    }
  }
  return { t, units };
}

const nameLike = (x: Tok) =>
  /\d/.test(x.raw) || MONTH_DAY.has(x.w) || (x.raw.length > 1 && x.raw === x.raw.toUpperCase() && /\p{Lu}/u.test(x.raw))
  || (/^\p{Lu}/u.test(x.raw) && x.w !== "i" && !x.w.startsWith("i'") && !(x.first && FUNCTION.has(x.w)));

/** Whether a shared run of source words is quoted prose (see QuoteSource), and how. */
function quoted(run: Tok[], units: { n: number; prose: boolean }[], min: number): QuoteHit["why"] | null {
  const per = new Map<number, number>();
  for (const x of run) per.set(x.unit, (per.get(x.unit) ?? 0) + 1);
  for (const [u, n] of per) { const s = units[u]!; if (s.prose && s.n >= min && n >= Math.ceil(s.n * 0.85)) return "sentence"; }
  const plain = run.filter((x) => !nameLike(x));
  if (plain.length < 6) return null;
  const fn = plain.filter((x) => FUNCTION.has(x.w)).length;
  // A verb: an auxiliary, a pronoun or a verb from the list, or a word in -ing or -ed that takes an object ("exporting a").
  const verbs = run.filter((x, i) => !nameLike(x) && (CLAUSE.has(x.w) || VERBS.has(x.w) || (/..(?:ing|ed)$/.test(x.w) && x.w.length >= 5 && !!run[i + 1] && AFTER_VERB.has(run[i + 1]!.w)))).length;
  if (plain.some((x) => SPEECH.has(x.w)) || verbs >= 2 || (fn >= 3 && fn >= run.length * 0.35)) return "speech";
  return null;
}

export function quoteGuard(sources: QuoteSource[], o: { run?: number } = {}): QuoteGuard {
  const run = o.run ?? QUOTE_RUN;
  const docs = sources.filter((s) => s.text?.trim()).map((s) => ({ id: s.id, ...sourceWords(s.text) }));
  // Every run of `run` words in the sources, once, with where it is: built once, so each sentence is a lookup.
  const index = new Map<string, [number, number][]>();
  docs.forEach((d, di) => {
    for (let i = 0; i + run <= d.t.length; i++) {
      const k = d.t.slice(i, i + run).map((x) => x.w).join(" ");
      const at = index.get(k);
      if (!at) index.set(k, [[di, i]]);
      else if (at.length < 8) at.push([di, i]);
    }
  });
  const match = (sentence: string): QuoteHit | null => {
    const s = toks(sentence, 0);
    for (let i = 0; i + run <= s.length; i++) {
      const at = index.get(s.slice(i, i + run).map((x) => x.w).join(" "));
      if (!at) continue;
      for (const [di, p] of at) {
        const d = docs[di]!;
        let a = 0, b = run;
        while (i - a > 0 && p - a > 0 && s[i - a - 1]!.w === d.t[p - a - 1]!.w) a++;
        while (i + b < s.length && p + b < d.t.length && s[i + b]!.w === d.t[p + b]!.w) b++;
        const why = quoted(d.t.slice(p - a, p + b), d.units, run);
        if (why) return { words: sentence.slice(s[i - a]!.at, s[i + b - 1]!.end), source: d.id, why };
      }
    }
    return null;
  };
  return {
    match,
    clean(text) {
      const cut: QuoteHit[] = [];
      const kept = sentencesIn(text).filter((s) => {
        const hit = match(s);
        if (hit) cut.push(hit);
        return !hit;
      });
      return { text: kept.join(" "), cut };
    },
  };
}

/** Whether what's left of a description after cuts is still a description: a sentence of five words or more. */
export const meaningful = (text: string): boolean => sentencesIn(text).some((s) => (s.match(TOKEN) ?? []).length >= 5);

/** "1 sentence that named a person and 2 about fundraising", for a skipped line. */
export function cutText(cut: TextProblem[]): string {
  const n = new Map<TextProblem, number>();
  for (const p of cut) n.set(p, (n.get(p) ?? 0) + 1);
  return [...n].map(([p, k]) => `${k} ${k === 1 ? "sentence that" : "sentences that"} ${PROBLEM_TEXT[p][k === 1 ? 0 : 1]}`).join(", ");
}
