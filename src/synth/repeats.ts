/**
 * R12a (INPUT-2): when a sentence says again what one already in a description says. A later call's summary rarely
 * repeats the description's words: it says the same fact its own way ("Globex Hotels chose Initech on Nov 23" and
 * "Globex Hotels' expansion closed lost on Nov 23, on price against Initech"). These rules find that, and keep a
 * sentence that brings a new fact: a date or a figure that differs from the other's is always one.
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
const shareAnchor = (a: Anchors, b: Anchors) => [...b.dates].some((d) => a.dates.has(d)) || [...b.figures].some((f) => a.figures.has(f));

/** Words that hold a sentence together, and words nearly every task says, which tell two facts apart from nothing. */
const FILLER = new Set(("a an the and or but nor so yet for of to in on at by with from into onto about over under after before between through during " +
  "without within against among around until since than like per via off out up down is are was were be been being am do does did has have had " +
  "can could will would shall should must might may not no its it it's this that these those their there they them he she his her him we us our " +
  "you your i me my mine all any each every both either some such one two three also too only just even still very more most much many other " +
  "same then now here whose who whom what which when where why how whether if as while because although though unless").split(" "));
const GENERIC = new Set(["need", "want", "beta", "task", "customer", "team", "work", "use", "make", "ask", "say", "call", "show", "add", "help", "get", "keep", "give", "take", "plan"].map(stem));
const MONTH_WORD = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

/** A sentence's content, stemmed: words of three letters or more, and acronyms ("GA", "SSO"), never filler or dates. */
export function stemsOf(s: string): Set<string> {
  const out = new Set<string>();
  for (const m of s.matchAll(/[\p{L}][\p{L}'’-]*/gu)) {
    const raw = m[0].replace(/['’]s?$/, "");
    const acronym = raw.length >= 2 && raw === raw.toUpperCase() && /\p{Lu}/u.test(raw);
    if (MONTH_WORD.test(raw) || (!acronym && (raw.length < 3 || FILLER.has(raw.toLowerCase())))) continue;
    out.add(stem(raw));
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const names = (s: string, company: string) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(company).replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "iu").test(s);
const asks = (s: string) => /\?\s*$/.test(s) || /\b(?:whether|which|what|how)\b/i.test(s);

/**
 * `b` says a fact `a` already gives, though in other words (R12a). Two ways, each kept narrow:
 *
 * - **The same company and the same date or figure.** Both name a company the task's sources name, share a date or a
 *   figure, `b` states no date or figure `a` doesn't, and besides the company they share two content words (or an
 *   acronym like "GA"): "Globex, whose close slipped past GA to Jan 29" and "Globex won't sign before GA; its close
 *   date moved to Jan 29". Two facts about the same company on different dates, or with a figure only one gives, stay.
 * - **The same question.** Both ask (whether, which, what, how, or a question mark), `b` states no date or figure `a`
 *   doesn't, and they share at least four content words, half of the shorter one's or more: "whether imprints can share a parent
 *   kit and what a guideline refresh costs" and "whether one parent kit with imprint styles is possible, and what a
 *   refresh costs".
 */
export function sameFact(a: string, b: string, companies: string[] = []): boolean {
  const A = anchorsOf(a), B = anchorsOf(b);
  if (!within(A, B)) return false;
  const x = stemsOf(a), y = stemsOf(b);
  const named = companies.filter((c) => c.trim().length >= 2 && names(a, c) && names(b, c));
  if (named.length && shareAnchor(A, B)) {
    const own = new Set(named.flatMap((c) => [...stemsOf(c)]));
    const shared = [...y].filter((w) => x.has(w) && !own.has(w) && !GENERIC.has(w)).length;
    if (shared >= 2) return true;
  }
  if (asks(a) && asks(b)) {
    const xs = [...x].filter((w) => !GENERIC.has(w)), ys = [...y].filter((w) => !GENERIC.has(w));
    const shared = ys.filter((w) => xs.includes(w)).length;
    if (shared >= 4 && shared >= 0.5 * Math.min(xs.length, ys.length)) return true;
  }
  return false;
}
