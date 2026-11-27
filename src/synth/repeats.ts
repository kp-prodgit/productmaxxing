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

/** A date as these rules compare it ("nov 23", "2026-11-23", "fri"), from DATE's groups. */
const dateKey = (iso?: string, m1?: string, d1?: string, d2?: string, m2?: string, wd?: string): string | null =>
  iso ? iso : m1 ? `${m1.slice(0, 3).toLowerCase()}${d1 ? ` ${Number(d1)}` : ""}` : m2 ? `${m2.slice(0, 3).toLowerCase()} ${Number(d2)}` : wd ? wd.slice(0, 3).toLowerCase() : null;
/** A figure as these rules compare it ("$22k", "15%", "40"). */
const figureKey = (f: string) => f.toLowerCase().replace(/,/g, "").replace(/\s+/g, "").replace("percent", "%");

export function anchorsOf(s: string): Anchors {
  const dates = new Set<string>();
  const rest = s.replace(DATE, (_m, iso?: string, m1?: string, d1?: string, d2?: string, m2?: string, wd?: string) => {
    const k = dateKey(iso, m1, d1, d2, m2, wd);
    if (k) dates.add(k);
    return " ";
  });
  const figures = new Set([...rest.matchAll(FIGURE)].map((m) => figureKey(m[0])));
  return { dates, figures };
}

/** The dates and figures a sentence states, each as it's written and as these rules compare it ("Jan 29", "jan 29"). */
export function anchorWords(s: string): { key: string; text: string }[] {
  const out: { key: string; text: string }[] = [];
  for (const m of s.matchAll(DATE)) {
    const k = dateKey(m[1], m[2], m[3], m[4], m[5], m[6]);
    if (k) out.push({ key: k, text: m[0].trim() });
  }
  for (const m of withoutDates(s).matchAll(FIGURE)) out.push({ key: figureKey(m[0]), text: m[0].trim() });
  return out;
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

/**
 * What a figure counts, so two figures of one measure can be told from two measures: a share ("%"), money ("$"), a
 * thousand or million ("k"), else the word after it, stemmed ("40 seats", "14-property": "seat", "property").
 */
function figureKinds(s: string): Map<string, string> {
  const rest = withoutDates(s);
  const out = new Map<string, string>();
  for (const m of rest.matchAll(FIGURE)) {
    const raw = m[0].toLowerCase().replace(/\s+/g, "");
    const next = rest.slice(m.index! + m[0].length).match(/^[\s-]*(\p{L}+)/u)?.[1];
    out.set(figureKey(m[0]), /%|percent/.test(raw) ? "%" : raw.startsWith("$") ? "$" : /\d(?:k|m|bn)$/.test(raw) ? "k" : next ? stem(next) : "#");
  }
  return out;
}

/** The distinctive terms one sentence has and the other doesn't: an acronym, or a capitalized product, plan or company name. */
function ownTerms(a: string, b: string): string[] {
  const t = termsOf(a);
  return [...t.acronyms.filter((x) => !hasAcronym(b, x)), ...t.names.filter((x) => !names(b, x))];
}

/**
 * INPUT-2 (founder, 2026-11-27): `b` says `a`'s fact again with a newer date or figure, so for an open task it takes
 * `a`'s place: "GPU cost is now 22% over budget" after "GPU cost is 18% over budget". `b` states a date where `a` states
 * one, or a figure of the same measure as one of `a`'s ("22%" for "18%", "60 seats" for "40 seats"), that `a` doesn't;
 * nothing else tells them apart (no claim turned around, no other question, no distinctive term or company only one of
 * them has); and `b` says every word `a` says but the generic ones, two of them at least, and at most three more. "Acme's
 * pilot moved to Feb 12" doesn't update "Acme's renewal moved to Jan 29", and "60 seats at GA" doesn't update "40 seats
 * in the beta": those are two facts.
 */
export function updates(a: string, b: string, companies: string[] = []): boolean {
  const A = anchorsOf(a), B = anchorsOf(b);
  if (!differs(A, B)) return false;
  if (flips(a, b) || otherQuestion(a, b) || ownTerms(a, b).length || ownTerms(b, a).length) return false;
  if (ownCompanies(a, b, companies).length || ownCompanies(b, a, companies).length) return false;
  const newDate = [...B.dates].some((d) => !A.dates.has(d)) && A.dates.size > 0;
  const kindsA = new Set(figureKinds(a).values());
  const newFigure = [...figureKinds(b)].some(([f, kind]) => !A.figures.has(f) && kindsA.has(kind));
  if (!newDate && !newFigure) return false;
  const x = stemsOf(a), y = stemsOf(b);
  const key = (s: Set<string>) => [...s].filter((w) => !GENERIC.has(w));
  const lost = key(x).filter((w) => !y.has(w)).length;
  const shared = key(x).filter((w) => y.has(w)).length;
  const gained = key(y).filter((w) => !x.has(w)).length;
  return lost === 0 && shared >= 2 && gained <= 3;
}

/** Words for one thing said other ways, stemmed: spend, spending, expenses and a bill are a cost; a budget, forecast or target is a plan. */
const SYNONYMS = new Map<string, string>([
  ...["cost", "costs", "spend", "spending", "expense", "expenses", "expenditure", "bill"].map((w) => [stem(w), "cost"] as const),
  ...["plan", "planned", "budget", "budgeted", "forecast", "forecasted", "target"].map((w) => [stem(w), "plan"] as const),
]);
const same = (w: string) => SYNONYMS.get(w) ?? w;
/** Verbs and adverbs a figure's subject often comes with ("is running 18%", "is already 18%"): never what it's about. */
const NOT_SUBJECT = new Set(["run", "runn", "grow", "ris", "rise", "ros", "stay", "remain", "sit", "sitt", "trend", "com", "look", "already", "current", "now", "nearly", "about", "around", "roughly", "almost", "up", "down", "still", "come"].map(stem));
/**
 * The verb a clause's subject ends at ("Copy tone | is on-brand 78%", "BrandScore | drops from 91 to 84", "GPU spend |
 * running 18% over plan"): a form of be, have or do, a modal, a word in -ed, or a verb figures often go with.
 */
const VERB = /^(?:is|are|was|were|be|been|being|has|have|had|does|do|did|will|would|can|could|should|must|may|might|shall|\p{L}{3,}(?<!e)ed|runs?|running|drops?|dropping|rises?|rose|rising|falls?|fell|falling|grows?|grew|growing|hits?|reach(?:es)?|reaching|climbs?|climbing|jumps?|jumping|sits?|sitting|stands?|standing|stays?|staying|ends?|ending|starts?|starting|goes|went|comes|came|needs?|wants?|expects?|allows?|takes?|gets?|scores?|averages?)$/iu;
/** Where the words a figure is about start: after the last comma, semicolon, bracket or word that joins a clause before it. */
const SUBJECT_START = /[,;:(]|\b(?:and|but|so|while|because|which|that|whose|where|with|after|before|since|than)\b/gi;
/** Words that compare a figure ("18% over plan", "18% of revenue"), as one word each. */
const COMPARE = new Map([...["over", "above", "past", "higher", "more", "up", "beyond", "ahead"].map((w) => [w, "over"] as const), ...["under", "below", "lower", "less", "down", "behind"].map((w) => [w, "under"] as const), ["of", "of"]]);

/** A figure or a date in a sentence, where it is, as it's written and as these rules compare it. */
interface Spot { key: string; text: string; at: number; end: number; date: boolean }

/** The sentence's dates and figures in order, each with where it is in the sentence itself. */
function spotsOf(s: string): Spot[] {
  const dates: Spot[] = [...s.matchAll(DATE)].flatMap((m) => {
    const k = dateKey(m[1], m[2], m[3], m[4], m[5], m[6]);
    const text = m[0].trimEnd();
    return k ? [{ key: k, text, at: m.index!, end: m.index! + text.length, date: true }] : [];
  });
  const figures: Spot[] = [...s.matchAll(FIGURE)].filter((m) => !dates.some((d) => m.index! < d.end && m.index! + m[0].length > d.at))
    .map((m) => { const text = m[0].trimEnd(); return { key: figureKey(m[0]), text, at: m.index!, end: m.index! + text.length, date: false }; });
  return [...dates, ...figures].sort((a, b) => a.at - b.at);
}

/**
 * What a figure measures: its kind (a share, money, thousands, or the word it counts: "40 seats" is "seat"), and how a
 * share or an amount is compared and to what ("18% over plan" and "22% over budget" alike, "18% of revenue" not).
 */
function unitOf(s: string, f: Spot): { kind: string; compare: string | null; to: string | null } {
  const raw = f.text.toLowerCase().replace(/\s+/g, "");
  const words = [...s.slice(f.end).matchAll(/[\p{L}][\p{L}'’-]*/gu)].slice(0, 4).map((m) => m[0]);
  if (/%|percent/.test(raw) || raw.startsWith("$") || /\d(?:k|m|bn)$/.test(raw)) {
    const kind = /%|percent/.test(raw) ? "%" : "$";
    const compare = words[0] ? COMPARE.get(words[0].toLowerCase()) ?? null : null;
    const noun = (compare ? words.slice(1) : []).map((w) => contentWord(w.replace(/^than$/i, ""))).find((w): w is string => !!w);
    return { kind, compare, to: noun ? same(noun) : null };
  }
  // The word it counts, and per what ("60 requests per minute", "60 req/min" aren't "120 burst requests").
  const m = s.slice(f.end).match(/^[\s-]*(\p{L}+)(?:\s*\/\s*(\p{L}+)|\s+(?:per|a|an|each)\s+(\p{L}+))?/u);
  const per = m?.[2] ?? m?.[3];
  return { kind: m ? `${same(stem(m[1]!))}${per ? `/${stem(per)}` : ""}` : "#", compare: null, to: null };
}

const sameUnit = (a: ReturnType<typeof unitOf>, b: ReturnType<typeof unitOf>) =>
  a.kind === b.kind && a.compare === b.compare && (a.to === b.to || !a.to || !b.to);

/**
 * What a figure or date measures: the subject of its clause (from the last comma, bracket or word that joins a clause
 * before it, up to the clause's first verb: "Copy tone" in "Copy tone is on-brand 78%", "GPU spend" in "…, and GPU
 * spend running 18% over plan"), stemmed, synonyms as one, companies aside. With no verb before it, the words before it.
 */
function aboutOf(s: string, f: Spot, companies: string[]): string[] {
  const before = s.slice(0, f.at);
  const cut = [...before.matchAll(SUBJECT_START)].at(-1);
  const clause = cut ? before.slice(cut.index! + cut[0].length) : before;
  const words = [...clause.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)];
  const verb = words.find((w) => VERB.test(w[0]));
  const subject = verb ? clause.slice(0, verb.index!) : clause;
  const own = new Set([...companies, ...namesIn(s)].flatMap((c) => [...stemsOf(c)]));
  // In order, so the words before the one both are about qualify it ("GPU" in "GPU spend"). Generic words qualify
  // too ("beta cost"); only another word is what two subjects can share.
  return [...new Set([...stemsOf(subject)].map(same).filter((w) => !own.has(w) && !NOT_SUBJECT.has(w)))];
}

/**
 * How much two figures' subjects share (`aboutOf`), or 0 when they're two measures (rig test of #127): they share a key
 * word, and the words before the last one they share (its qualifiers: "GPU" in "GPU spend", "launch marketing" in
 * "launch marketing spend") don't differ. A qualifier on one side only is fine, and so is one side's that holds all the
 * other's ("cloud GPU spend" and "GPU spend"); "launch marketing spend" and "GPU spend", or "retrain cost" and "GPU
 * cost", are two measures.
 */
function sharedSubject(a: string[], b: string[]): number {
  const shared = b.filter((w) => !GENERIC.has(w) && a.includes(w));
  if (!shared.length) return 0;
  const head = [...a].reverse().find((w) => shared.includes(w))!;
  const qa = new Set(a.slice(0, a.indexOf(head))), qb = new Set(b.slice(0, b.indexOf(head)));
  const within = (x: Set<string>, y: Set<string>) => [...x].every((w) => y.has(w));
  return qa.size && qb.size && !within(qa, qb) && !within(qb, qa) ? 0 : shared.length;
}

/** A question as such: a question mark, or a question word or verb first ("Whether…", "Is…"); "nobody can say which tenants…" isn't one. */
export const question = (s: string): boolean => /\?\s*$/.test(s) || /^(?:whether|which|what|how|when|why|who|where|is|are|does|do|did|can|could|will|would|should)\b/i.test(s.trim());

/** Whether a sentence states a figure as written ("18%"), compared as these rules compare figures. */
export const statesFigure = (s: string, figure: string): boolean => spotsOf(s).some((f) => !f.date && f.key === figureKey(figure));

/** A clause's content words, stemmed, synonyms as one: for how close two clauses are. */
export const sameStems = (s: string): Set<string> => new Set([...stemsOf(s)].map(same));

/** The newer figure (or date) a later clause gives for one in an earlier clause, as `newerFigure` finds it. */
export interface FigureUpdate {
  /** Where the older one is in the earlier clause, and how it's written. */
  at: number; end: number; was: string;
  /** The newer one, as the later clause writes it. */
  now: string;
  /** How many words of what they're about the two share: the more, the surer. */
  subject: number;
}

/**
 * INPUT-2 (end-to-end test 2026-11-27): `b` gives a newer figure for one `a` states, whatever its wording: "GPU costs are
 * running 22% over budget this month" for "November GPU spend is running 18% over plan and nobody can say why". The two
 * are about the same thing (the subjects of the figures' clauses share a key word, stemmed, with "cost" and "spend" or
 * "plan" and "budget" as one, and its qualifiers don't differ: `sharedSubject`), the figure measures the same (a share or an amount compared the same way to the same
 * thing, or the same counted word: "seats", "days"), it differs, and nothing else tells them apart: no claim turned
 * around, no other question, no distinctive term only one of them has, no company only one names (but the task's own,
 * `companies`), and no other date (December's spend isn't November's). With `dates`, a newer date for the same event
 * counts too ("the go or no-go moved to Dec 5" for "… is on Dec 3"), when neither states a figure the other doesn't.
 * Null when it gives none; the best when it gives several.
 */
export function newerFigure(a: string, b: string, companies: string[] = [], o: { dates?: boolean } = {}): FigureUpdate | null {
  if (question(a) || question(b) || flips(a, b) || otherQuestion(a, b) || swapsTerm(a, b)) return null;
  const own = (c: string) => companies.some((k) => k.toLowerCase() === c.toLowerCase() || names(k, c) || names(c, k));
  if ([...ownCompanies(a, b, companies), ...ownCompanies(b, a, companies)].some((c) => !own(c))) return null;
  const A = anchorsOf(a), B = anchorsOf(b);
  const sa = spotsOf(a), sb = spotsOf(b);
  let best: FigureUpdate | null = null;
  for (const nb of sb) {
    if (nb.date ? A.dates.has(nb.key) : A.figures.has(nb.key)) continue;
    if (nb.date ? !o.dates || differs({ dates: new Set(), figures: A.figures }, { dates: new Set(), figures: B.figures }) : differs({ dates: A.dates, figures: new Set() }, { dates: B.dates, figures: new Set() })) continue;
    const ub = nb.date ? null : unitOf(b, nb);
    const hb = aboutOf(b, nb, companies);
    for (const na of sa) {
      if (na.date !== nb.date || na.key === nb.key) continue;
      if (ub && !sameUnit(unitOf(a, na), ub)) continue;
      const subject = sharedSubject(aboutOf(a, na, companies), hb);
      if (!subject || (best && best.subject >= subject)) continue;
      best = { at: na.at, end: na.end, was: na.text, now: nb.text, subject };
    }
  }
  return best;
}

/**
 * A short detail set off right after the name a sentence starts with: "Vandelay, a $360k pilot, will use…" or "Vandelay
 * (a $360k pilot) will use…". A phrase of at most six words that starts with "a", "an", "the" or a figure and has no
 * verb of its own, so a list ("Acme, Globex and Initech") or a clause ("Acme, which renewed, …") is never one.
 */
export function detailOf(s: string): { name: string; detail: string; rest: string } | null {
  const m = s.match(new RegExp(String.raw`^(${NAMES})(?:,\s+([^,;()]{2,60}?),\s+|\s+\(([^()]{2,60})\)\s+)(?=\p{Ll})`, "u"));
  if (!m) return null;
  const detail = (m[2] ?? m[3])!.trim();
  if (!/^(?:an?|the)\s|^\$?\d/i.test(detail) || detail.split(/\s+/).length > 6 || CLAUSE_MARK.test(detail)) return null;
  return { name: m[1]!, detail, rest: `${m[1]} ${s.slice(m[0].length)}` };
}

/**
 * Fix (R12a, end-to-end test 2026-11-27): a later sentence that says a sentence there again, but for a short detail set
 * off after its subject ("Vandelay, a $360k pilot, will use the beta for internal work only if these two are missing"),
 * gives that sentence the detail instead of joining whole: the never-drop-a-figure rule kept the clause twice. Without
 * the detail, each of its clauses says nothing a clause of that sentence doesn't (`addsNothing`, and nothing tells them
 * apart), and that sentence names the same subject, as a plain word the detail can follow ("Vandelay will…", not
 * "Vandelay's"). The detail goes right after it: "Vandelay, a $360k pilot, will use the beta internally only if these
 * are missing, so the spec should define the beta cut and the GA gap." Null when it doesn't fold.
 */
export function foldDetail(said: string[], s: string, companies: string[] = []): { at: number; now: string } | null {
  const d = detailOf(s);
  if (!d || asks(s)) return null;
  const mine = piecesOf(d.rest);
  if (!mine.length) return null;
  const subject = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(d.name).replace(/\s+/g, "\\s+")}(?=\\s+[\\p{Ll}\\p{N}])`, "u");
  for (let at = 0; at < said.length; at++) {
    const x = said[at]!;
    const hit = asks(x) ? null : x.match(subject);
    // Already said: it isn't new to this sentence.
    if (!hit || x.toLowerCase().includes(d.detail.toLowerCase())) continue;
    const theirs = piecesOf(x);
    const again = mine.every((c) => theirs.some((t) => !tellsApart(t.text, c.text, companies) && addsNothing(t.text, c.text)));
    if (!again) continue;
    const end = hit.index! + hit[0].length;
    return { at, now: `${x.slice(0, end)}, ${d.detail},${x.slice(end)}` };
  }
  return null;
}

/** "Launch readiness: Dec 8 beta.": a label of at most three words, a colon, and at most eight words after it. */
const LABELED = /^(\p{Lu}[\p{L}'’-]*(?:\s+[\p{L}'’-]+){0,2}):\s+(.+?)[\s.!]*$/u;

/**
 * Fix (R12a, end-to-end test 2026-11-27): a short labeled line whose dates and figures, and every word after its label,
 * the text already says is a repeat: "Launch readiness: Dec 8 beta." beside a summary that says the Dec 8 beta. It needs
 * a date or figure, so a labeled line that only names a subject is judged as any sentence is.
 */
export function labeledRepeat(text: string, s: string): boolean {
  const m = s.match(LABELED);
  if (!m || m[2]!.split(/\s+/).length > 8) return false;
  const body = m[2]!;
  const B = anchorsOf(body);
  if (!B.dates.size && !B.figures.size) return false;
  if (!within(anchorsOf(text), B)) return false;
  const have = stemsOf(text);
  return [...stemsOf(body)].every((w) => have.has(w));
}
