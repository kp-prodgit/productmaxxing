/**
 * R12a (INPUT-2): when a sentence says again what one already in a description says. A later call's summary rarely
 * repeats the description's words: it says the same fact its own way ("Globex Hotels chose Initech on Nov 23" and
 * "Globex Hotels' expansion closed lost on Nov 23, on price against Initech"). These rules find that, and say which of
 * the two says it more fully, so that one stays. A sentence that brings a new fact always stays: a date or a figure that
 * differs from the other's, a claim turned around ("doesn't want"), another company, another question, or another
 * distinctive term ("SSO" and "SCIM", "server-side" and "client-side"). Long sentences are also compared clause by
 * clause (`piecesOf`), since a summary's sentence often carries two facts.
 */

/** A word as these rules compare it: lower case, no possessive, and the endings English adds taken off. */
export function stem(word: string): string {
  let s = word.toLowerCase().replace(/['’]s?$/, "");
  if (s.length <= 3) return s;
  s = s.replace(/ies$/, "y");
  s = s.replace(/(?:ically|ally)$/, "al");
  if (/ly$/.test(s) && s.length - 2 >= 4) s = s.slice(0, -2);
  if (/(?:ing|ed)$/.test(s)) { const t = s.replace(/(?:ing|ed)$/, ""); if (t.length >= 3) s = t; }
  else if (/(?:[sxz]|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (/[^s]s$/.test(s)) s = s.slice(0, -1);
  if (/(?:al|e)$/.test(s)) { const t = s.replace(/(?:al|e)$/, ""); if (t.length >= 3) s = t; }
  return s;
}

const MONTH = "(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\b\\.?";
/** Dates as a summary writes them, capitalized ("Nov 23", "23 November", "January", "2026-11-23", "Friday"). */
const DATE = new RegExp(`\\b(\\d{4}-\\d{2}-\\d{2})\\b|\\b${MONTH}(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b)?(?:,?\\s+\\d{4})?|\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}(?:,?\\s+\\d{4})?|\\b(Mon|Tues?|Wed(?:nes)?|Thu(?:rs)?|Fri|Sat(?:ur)?|Sun)day\\b`, "g");
/** Figures: amounts, counts and shares ("$22k", "14-property", "40 seats", "15%"). */
const FIGURE = /(?<![\p{L}\p{N}])\$?\d+(?:[.,]\d+)*(?:\s?(?:k|m|bn|%|percent)(?![\p{L}]))?/giu;

/** The dates and figures a sentence states, as comparable keys. */
export interface Anchors { dates: Set<string>; figures: Set<string> }

export function anchorsOf(s: string): Anchors {
  const dates = new Set<string>();
  const rest = s.replace(DATE, (_m, iso?: string, m1?: string, d1?: string, d2?: string, m2?: string, wd?: string) => {
    if (iso) dates.add(iso);
    else if (m1) dates.add(`${m1.slice(0, 3).toLowerCase()}${d1 ? ` ${Number(d1)}` : ""}`);
    else if (m2) dates.add(`${m2.slice(0, 3).toLowerCase()} ${Number(d2)}`);
    else if (wd) dates.add(wd.slice(0, 3).toLowerCase());
    return " ";
  });
  const figures = new Set([...rest.matchAll(FIGURE)].map((m) => m[0].toLowerCase().replace(/,/g, "").replace(/\s+/g, "").replace("percent", "%")));
  return { dates, figures };
}

/** A sentence without its dates, which these rules compare as dates (`anchorsOf`), never as words. */
export const withoutDates = (s: string): string => s.replace(DATE, " ");

/**
 * Whether `b` states a date or figure that differs from `a`'s: one `a` doesn't have, where `a` states one of that kind.
 * "Its close moved to Feb 12" differs from "Its close moved to Jan 29"; "… at about $22k a year" only adds to a
 * sentence with no figure.
 */
export function differs(a: Anchors, b: Anchors): boolean {
  const newIn = (x: Set<string>, y: Set<string>) => y.size > 0 && x.size > 0 && [...y].some((v) => !x.has(v));
  return newIn(a.dates, b.dates) || newIn(a.figures, b.figures);
}

/** `b` states nothing dated or counted that `a` doesn't: every date and figure in it is in `a`. */
const within = (a: Anchors, b: Anchors) => [...b.dates].every((d) => a.dates.has(d)) && [...b.figures].every((f) => a.figures.has(f));
/** `b` states no date or figure `a` doesn't. */
export const anchorsIn = (a: string, b: string): boolean => within(anchorsOf(a), anchorsOf(b));
const shareAnchor = (a: Anchors, b: Anchors) => [...b.dates].some((d) => a.dates.has(d)) || [...b.figures].some((f) => a.figures.has(f));
const anchorCount = (a: Anchors) => a.dates.size + a.figures.size;

/** Words that hold a sentence together, and words nearly every task says, which tell two facts apart from nothing. */
const FILLER = new Set(("a an the and or but nor so yet for of to in on at by with from into onto about over under after before between through during " +
  "without within against among around until since than like per via off out up down is are was were be been being am do does did has have had " +
  "can could will would shall should must might may not no its it it's this that these those their there they them he she his her him we us our " +
  "you your i me my mine all any each every both either some such one two three also too only just even still very more most much many other " +
  "same then now here whose who whom what which when where why how whether if as while because although though unless").split(" "));
const GENERIC = new Set(["need", "want", "beta", "task", "customer", "team", "work", "use", "make", "ask", "say", "call", "show", "add", "help", "get", "keep", "give", "take", "plan", "date"].map(stem));
const MONTH_WORD = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
/** Words that turn a claim around: "not", "never", "doesn't", "won't", "without". */
const NEGATION = /^(?:not|no|never|cannot|none|nor|without|\p{L}+n['’]t)$/iu;
/** One change said in other words: a close that moved, slipped, was pushed, delayed or postponed moved. */
const SAME_WORD = new Map(["mov", "slip", "slipp", "push", "delay", "shift", "postpon", "slid"].map((w) => [w, "mov"]));

/** A sentence's words in order, a hyphenated one in its parts ("brand-kit" is "brand" and "kit", as in "brand kits"). */
const partsOf = (s: string) => [...s.matchAll(/[\p{L}][\p{L}'’-]*/gu)].flatMap((m) => m[0].split("-")).filter(Boolean);

/** One word as these rules compare it, stemmed, or null for filler, a date's month or day, and a word that negates. */
function contentWord(part: string): string | null {
  const raw = part.replace(/['’]s?$/, "");
  const acronym = raw.length >= 2 && raw === raw.toUpperCase() && /\p{Lu}/u.test(raw);
  if (!raw || NEGATION.test(part) || MONTH_WORD.test(raw) || (!acronym && (raw.length < 3 || FILLER.has(raw.toLowerCase())))) return null;
  const s = stem(raw);
  return SAME_WORD.get(s) ?? s;
}

/** A sentence's content, stemmed: words of three letters or more, and acronyms ("GA", "SSO"), never filler, dates or negations. */
export function stemsOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const p of partsOf(s)) { const w = contentWord(p); if (w) out.add(w); }
  return out;
}

/** The words a sentence denies: the first content word after each word that negates ("doesn't want SSO": want). */
function negated(s: string): Set<string> {
  const out = new Set<string>();
  let open = false;
  for (const p of partsOf(s)) {
    if (NEGATION.test(p)) { open = true; continue; }
    if (!open || /^longer$/i.test(p)) continue;
    const w = contentWord(p);
    if (w) { out.add(w); open = false; }
  }
  return out;
}

/** One sentence denies what the other says: "Hooli wants SSO" and "Hooli doesn't want SSO". */
function flips(a: string, b: string): boolean {
  const na = negated(a), nb = negated(b), sa = stemsOf(a), sb = stemsOf(b);
  return [...na].some((w) => sb.has(w) && !nb.has(w)) || [...nb].some((w) => sa.has(w) && !na.has(w));
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (s: string, company: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(company).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(s);
/** The sentence asks: a question mark, or whether, which, what or how. */
export const asks = (s: string): boolean => /\?\s*$/.test(s) || /\b(?:whether|which|what|how)\b/i.test(s);

/** A capitalized word, as a name is written ("Globex", "Initech", "McKinsey"); an acronym ("GA", "SSO") isn't one. */
const NAME = String.raw`\p{Lu}\p{Ll}[\p{L}\p{N}]*(?:-\p{Lu}[\p{L}\p{N}]*)*`;
const NAMES = String.raw`${NAME}(?:\s+${NAME})*`;
/**
 * How a sentence names a company: a possessive ("Hooli's", "Globex Hotels'"), two or more capitalized words ("Globex
 * Hotels"), a capitalized name after at, with or for ("a pilot with Initech"), or any capitalized word inside the
 * sentence ("owed to Acme"). A capitalized word that starts the sentence, on its own, isn't one: it may only be
 * starting the sentence.
 */
const SHAPES = [
  new RegExp(String.raw`(?<![\p{L}\p{N}])(${NAMES})['’]s?(?![\p{L}\p{N}])`, "gu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}])(${NAME}(?:\s+${NAME})+)(?![\p{L}\p{N}])`, "gu"),
  new RegExp(String.raw`(?<![\p{L}\p{N}])(?:[Aa]t|[Ww]ith|[Ff]or)\s+(${NAMES})(?![\p{L}\p{N}])`, "gu"),
  new RegExp(String.raw`(?<=[^\s.!?]\s+)(${NAMES})(?![\p{L}\p{N}])`, "gu"),
];
/** Capitalized words that start a sentence before a name, with no comma ("However Acme's close …"). */
const NOT_NAMES = new Set(("let today tomorrow yesterday tonight however meanwhile overall instead otherwise again later earlier next first last " +
  "finally separately additionally currently recently initially originally ultimately similarly").split(" "));

/** A capitalized word that isn't a name: filler that starts a sentence ("The"), a month or day, "However". */
const notName = (w: string) => FILLER.has(w.toLowerCase()) || MONTH_WORD.test(w) || NOT_NAMES.has(w.toLowerCase());

/**
 * The companies a sentence names in a company's shape, without a word that only starts the sentence or a month ("The
 * Globex team", "However Acme's close": Globex, Acme).
 */
function namesIn(s: string): string[] {
  const out = new Set<string>();
  for (const re of SHAPES) for (const m of s.matchAll(re)) {
    const w = m[1]!.split(/\s+/);
    while (w.length && notName(w[0]!)) w.shift();
    while (w.length && notName(w.at(-1)!)) w.pop();
    if (w.length) out.add(w.join(" "));
  }
  return [...out];
}

/** The companies `a` names, from the task's sources (`companies`) or in a company's shape, that `b` doesn't. */
function ownCompanies(a: string, b: string, companies: string[]): string[] {
  return [...new Set([...companies.filter((c) => c.trim().length >= 2 && names(a, c)), ...namesIn(a)])].filter((c) => !names(b, c));
}

/** The companies both sentences name: one the task's sources name, or one either sentence names in a company's shape. */
export function sharedCompanies(a: string, b: string, companies: string[]): string[] {
  return [...new Set([...companies.filter((c) => c.trim().length >= 2), ...namesIn(a), ...namesIn(b)])].filter((c) => names(a, c) && names(b, c));
}

/** An acronym of two to six capitals ("SSO", "SCIM", "SOC2"), a plural's "s" aside. */
const ACRONYM = /(?<![\p{L}\p{N}])(\p{Lu}[\p{Lu}\p{N}&]{1,5})s?(?![\p{L}\p{N}])/gu;
const A_NAME = new RegExp(String.raw`(?<![\p{L}\p{N}])${NAME}`, "gu");
/** A hyphenated word ("server-side", "per-seat"), its parts in lower case. */
const COMPOUND = /(?<![\p{L}\p{N}-])(\p{L}{2,})-(\p{L}{2,})(?![\p{L}\p{N}-])/gu;

/** The terms that set a sentence's fact apart: its acronyms, and its capitalized names (a product, a plan, a company). */
function termsOf(s: string): { acronyms: string[]; names: string[] } {
  const acronyms = [...new Set([...s.matchAll(ACRONYM)].map((m) => m[1]!).filter((a) => (a.match(/\p{Lu}/gu) ?? []).length >= 2))];
  const names = [...new Set([...s.matchAll(A_NAME)].map((m) => m[0]).filter((w) => !notName(w)))];
  return { acronyms, names };
}
const hasAcronym = (s: string, a: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(a)}s?(?![\\p{L}\\p{N}])`, "u").test(s);

/**
 * The two say the same of different things: each has a distinctive term the other lacks (an acronym, a product, plan or
 * company name: "lists SSO" and "lists SCIM", "the Teams plan" and "the Slides plan"), or a hyphenated word whose first
 * part differs ("server-side" and "client-side rendering"). A term only one of them adds is a detail, not this.
 */
export function swapsTerm(a: string, b: string): boolean {
  const ta = termsOf(a), tb = termsOf(b);
  const only = (t: typeof ta, other: string) => [...t.acronyms.filter((x) => !hasAcronym(other, x)), ...t.names.filter((x) => !names(other, x))];
  if (only(ta, b).length && only(tb, a).length) return true;
  const parts = (s: string) => {
    const m = new Map<string, Set<string>>();
    for (const [, first, second] of s.matchAll(COMPOUND)) {
      const k = second!.toLowerCase();
      m.set(k, (m.get(k) ?? new Set()).add(first!.toLowerCase()));
    }
    return m;
  };
  const pa = parts(a), pb = parts(b);
  return [...pa].some(([k, xs]) => {
    const ys = pb.get(k);
    return !!ys && [...xs].some((x) => !ys.has(x)) && [...ys].some((y) => !xs.has(y));
  });
}

/** What a sentence asks with ("whether", "how", …). Two questions asked with different words ask different things. */
const asked = (s: string) => new Set([...s.matchAll(/\b(whether|which|what|how|when|why|who|where)\b/gi)].map((m) => m[1]!.toLowerCase()));
function otherQuestion(a: string, b: string): boolean {
  if (!asks(a) || !asks(b)) return false;
  const x = asked(a), y = asked(b);
  return ![...x].every((w) => y.has(w)) && ![...y].every((w) => x.has(w));
}

/** The first word a sentence is about ("The synthesis should…": synthesis; "Hooli's licence…": Hooli). */
function subjectOf(s: string): string | null {
  for (const p of partsOf(s)) { const w = contentWord(p); if (w) return w; }
  return null;
}

/**
 * `b` is a new fact beside `a`, however many words they share (R12a): it states a date or figure that differs from
 * `a`'s, it denies what `a` says or `a` denies what it says ("Hooli wants SSO", "Hooli doesn't want SSO"), each names a
 * company the other doesn't, each has a distinctive term the other lacks (`swapsTerm`: "SSO" and "SCIM"), or both ask,
 * with different words ("whether …", "how …").
 */
export function tellsApart(a: string, b: string, companies: string[] = []): boolean {
  return differs(anchorsOf(a), anchorsOf(b)) || flips(a, b) || otherQuestion(a, b) || swapsTerm(a, b)
    || (ownCompanies(a, b, companies).length > 0 && ownCompanies(b, a, companies).length > 0);
}

/**
 * `b` says all `a` says, and more, so `b` stays where `a` was (R12a): it states every date and figure `a` states (and
 * none of a kind `a` states that `a` doesn't), every word `a` says but the generic ones, and something besides: a date
 * or figure, or more words. When both state the same date or figure and `b` adds one ("14-property"), it may say one of
 * `a`'s words its own way ("chose" as "closed lost").
 */
export function saysMore(a: string, b: string): boolean {
  const A = anchorsOf(a), B = anchorsOf(b);
  if (!within(B, A) || differs(A, B)) return false;
  const x = stemsOf(a), y = stemsOf(b);
  const lost = [...x].filter((w) => !GENERIC.has(w) && !y.has(w)).length;
  return anchorCount(B) > anchorCount(A) ? lost <= (shareAnchor(A, B) ? 1 : 0) : lost === 0 && y.size > x.size;
}

/**
 * `b` says a fact `a` already gives, in its own words, perhaps more fully (R12a). Never when `tellsApart`; never when
 * `b` states a date or figure `a` doesn't, unless it `saysMore` (and replaces `a`). A company is one the task's sources
 * name (`companies`), or one both sentences name where either names it as a company: "Hooli's", "Globex Hotels",
 * "with Initech". Then one of three ways:
 *
 * - **The same company and the same date or figure.** Both name a company and share a date or a figure, and besides
 *   the company they share two content words (or an acronym like "GA"): "Globex, whose close slipped past GA to
 *   Jan 29" and "Globex won't sign before GA; its close date moved to Jan 29". Two facts about the same company on
 *   different dates, or another point on the same date, stay.
 * - **The same question.** Both ask (whether, which, what, how, or a question mark), with the same words, and they
 *   share at least four content words, half of the shorter one's or more: "whether imprints can share a parent kit and
 *   what a guideline refresh costs" and "whether one parent kit with imprint styles is possible, and what a refresh
 *   costs".
 * - **The same subject and most of the same words.** Neither asks, both are about the same thing (a company both name,
 *   or the same first word: "The synthesis should…"), and they share at least five content words, 70% of the shorter
 *   one's, a company counting once: "Hooli's licence does not cover server-side rendering" and "Hooli's foundry licence
 *   does not cover server-side rendering, and an add-on would be needed".
 *
 * `context`: companies both sentences are about though they don't name them, as two clauses of sentences that do
 * ("…owed to Acme, whose close slipped past GA to Jan 29" and "…, and its close date moved to Jan 29").
 */
export function sameFact(a: string, b: string, companies: string[] = [], context: string[] = []): boolean {
  if (tellsApart(a, b, companies)) return false;
  const A = anchorsOf(a), B = anchorsOf(b);
  if (!within(A, B) && !saysMore(a, b)) return false;
  const x = stemsOf(a), y = stemsOf(b);
  const named = [...new Set([...sharedCompanies(a, b, companies), ...context])];
  const own = new Set(named.flatMap((c) => [...stemsOf(c)]));
  const key = (s: Set<string>) => [...s].filter((w) => !own.has(w) && !GENERIC.has(w));
  const kx = key(x), ky = key(y);
  const shared = ky.filter((w) => kx.includes(w)).length;
  if (named.length && shareAnchor(A, B) && shared >= 2) return true;
  if (asks(a) || asks(b)) {
    if (!asks(a) || !asks(b)) return false;
    const xs = [...x].filter((w) => !GENERIC.has(w)), ys = [...y].filter((w) => !GENERIC.has(w));
    const both = ys.filter((w) => xs.includes(w)).length;
    return both >= 4 && both >= 0.5 * Math.min(xs.length, ys.length);
  }
  const subject = named.length > 0 || (subjectOf(a) !== null && subjectOf(a) === subjectOf(b));
  if (!subject) return false;
  const one = named.length ? 1 : 0;
  return shared + one >= 5 && shared + one >= 0.7 * (Math.min(kx.length, ky.length) + one);
}

/** `b`'s words, but the generic ones, that `a` doesn't say. */
export function newWords(a: string, b: string): number {
  const x = stemsOf(a);
  return [...stemsOf(b)].filter((w) => !GENERIC.has(w) && !x.has(w)).length;
}

/** `b` says nothing `a` doesn't: no date or figure `a` lacks, and two words or more, every one of them in `a` but the generic ones. */
export function addsNothing(a: string, b: string): boolean {
  return anchorsIn(a, b) && newWords(a, b) === 0 && [...stemsOf(b)].filter((w) => !GENERIC.has(w)).length >= 2;
}

/** One clause of a sentence, as `piecesOf` finds it. */
export interface Piece {
  /** Its words, without the word that joins it to the clause before and without the sentence's final mark. */
  text: string;
  /** Where its words start and end in the sentence. */
  from: number;
  to: number;
  /** Where the words that join it to the clause before start (0 for the first). */
  join: number;
  /** It can stand as a sentence once its joining word is gone (after "; ", ", and", ", but", ", so"). */
  free: boolean;
}

/** A clause has a verb: a form of be, have or do, a modal, a negation, or a word in -ed ("moved"). */
const CLAUSE_MARK = /\b(?:is|are|was|were|be|been|will|would|can|could|should|must|may|might|shall|has|have|had|does|do|did|not|never|cannot)\b|n['’]t\b|\p{L}{3}(?<!e)ed\b/iu;
/**
 * Where a sentence's clauses meet: "; ", ", and " (not the last item of a list, "price, a brand kit, and the training"),
 * ", but ", ", so ", a bare "and" or "so" before a clause of its own ("… rendering and an add-on could take …"), and
 * ", which ", ", whose ", ", with ", ", since ", ", citing " and the like, whose clause can't stand on its own.
 */
const JOINS = /(;\s+)|(,\s+(and|but|so)\s+)|(\s+(?:and|so)\s+(?=(?:a|an|the|its|their|it|they|we|this|that|these|those|our)\s))|(,\s+(?:which|whose|where|while|with|since|because|as|once|citing|including|though|although|after|before|until|unless)\s+)/giu;

/** A sentence's clauses, in order (R12a). A sentence with no place where clauses meet is one piece. */
export function piecesOf(s: string): Piece[] {
  const end = s.replace(/[\s.!?]+$/, "").length;
  const body = s.slice(0, end);
  const found = [...body.matchAll(JOINS)];
  const cuts: { at: number; from: number; free: boolean }[] = [];
  let start = 0;
  found.forEach((m, n) => {
    const at = m.index!, from = at + m[0].length;
    const after = body.slice(from, found[n + 1]?.index ?? end);
    if (m[2] && m[3]!.toLowerCase() === "and" && (body.slice(start, at).includes(",") || after.trim().split(/\s+/).length < 3)) return;
    if (m[4] && !CLAUSE_MARK.test(after)) return;
    cuts.push({ at, from, free: !m[5] });
    start = from;
  });
  const out: Piece[] = [];
  let from = 0, join = 0, free = true;
  for (const c of [...cuts, { at: end, from: end, free: true }]) {
    const text = body.slice(from, c.at).trim();
    if (text) out.push({ text, from, to: c.at, join, free });
    [from, join, free] = [c.from, c.at, c.free];
  }
  return out;
}
