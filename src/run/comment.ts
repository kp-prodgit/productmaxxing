import { domainLabel } from "../core/filter.js";
import { peopleIn, trackerGuard, type TrackerRules } from "../core/tracker-text.js";

/**
 * TASK-10: the comment PMX leaves on the task when a draft is ready, written by PMX from the draft itself. Before, it
 * was the agent's last line of output cut at 300 characters, often mid-sentence and saying nothing about the work, and
 * without a GitHub pull request it was all a Linear reader ever saw of it. Now it has the draft's title, a sentence or
 * two from its summary (or its first section), cut only at a sentence boundary, how many questions and "PM decides"
 * calls it leaves, and where to read it. Never a quote, a name, contact details or fundraising (F14): a sentence that
 * has one is left out. A company, a date and a role ("the VP of Brand's team") may stay. N5: the names are the CRM list,
 * the do-not-read people and everyone the task's sources name: their participants, inside and outside the company,
 * and their speakers.
 */
export const COMMENT_MAX = 600;
const SUMMARY_MAX = 320;

export interface DraftCommentInput {
  /** The task's title, used when the draft has no title of its own that's safe to repeat. */
  title: string;
  /** The draft's Markdown; null for a prototype, which has no summary to read. */
  markdown: string | null;
  /** Where the draft is: the pull request's link, or `branch:<name>` for a draft kept on this Mac. */
  prUrl: string;
  /** The draft's path in the team repo, or a prototype's preview link. */
  path: string;
  /** The agent that drafted it, whose Mac holds the draft until it's accepted. */
  agent: string;
  /** Names that must never appear: the team's CRM list and the PM's do-not-read people. */
  names?: string[];
  /** N5: the people the task's sources name (participants and speakers, from `sourcePeople`), matched as names are written. */
  people?: string[];
  noun?: "Draft" | "Prototype";
}

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

/** Plain words from a Markdown line: no emphasis, links, code marks or source IDs like [T7]. */
export function plain(s: string): string {
  return s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, "$1")
    .replace(/\s*\[(?:[A-Z]{1,3}\d+(?:\s*[,;]\s*[A-Z]{1,3}\d+)*)\]/g, "")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const LIST = /^\s{0,3}(?:[-*+•]|\d+[.)])\s+/;

/**
 * Whether a sentence is safe to repeat in the tracker (F14, PRIV-6): no quote, transcript markup or redaction
 * placeholder, no name on `names` (or the other names and titles in `rules`), no contact details and nothing about
 * fundraising. The same guard as suggested tasks: a company or a date may stay.
 */
export function safe(sentence: string, names: string[], rules: Omit<TrackerRules, "names"> = {}): boolean {
  return !trackerGuard({ ...rules, names }).problem(sentence);
}

/**
 * N5: who the task's sources name, for the tracker guard: every participant (inside and outside the company, where this
 * Mac has the files) and every speaker in the passages, as `peopleIn` reads them. A company's own name never counts as
 * a person's: the participants' email domains and the team's own are left out ("Acme" in "Acme Support").
 */
export function sourcePeople(e: { sources: { passages: string[] }[]; people?: string[] }, internalDomains: string[] = []): string[] {
  const emails = (e.people ?? []).flatMap((p) => p.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? []);
  const companies = [...new Set([...emails.map((m) => m.split("@")[1]!), ...internalDomains].map(domainLabel).filter(Boolean))];
  return peopleIn([{ participants: e.people ?? [] }, ...e.sources.map((s) => ({ text: s.passages.join("\n") }))], companies);
}

/** Sentences, split only after . ! or ? followed by a capital, a digit or an opening bracket. */
export function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/).map((x) => x.trim()).filter(Boolean);
}

/**
 * One or two sentences from the draft's Summary, or its first section when it has none: whole sentences only, at most
 * SUMMARY_MAX characters, leaving out tables, quoted passages and any sentence that isn't safe to repeat.
 */
export function draftSummary(markdown: string, names: string[] = [], max = SUMMARY_MAX, rules: Omit<TrackerRules, "names"> = {}): string {
  const doc = sections(markdown);
  const from = doc.sections.find((s) => /^summary\b/i.test(plain(s.heading))) ?? doc.sections[0] ?? { heading: "", lines: doc.intro };
  const paras: string[] = [];
  let cur: string[] = [];
  for (const line of from.lines) {
    if (!line.trim() || /^\s*[|>]/.test(line)) { if (cur.length) paras.push(cur.join(" ")); cur = []; continue; }
    if (LIST.test(line)) { if (cur.length) paras.push(cur.join(" ")); cur = [line.replace(LIST, "")]; continue; }
    cur.push(line.trim());
  }
  if (cur.length) paras.push(cur.join(" "));
  const picked: string[] = [];
  let len = 0;
  for (const s of paras.flatMap((p) => sentencesOf(plain(p)))) {
    if (picked.length >= 2) break;
    if (!/[.!?]$/.test(s) || !safe(s, names, rules)) continue;
    if (len + s.length + (picked.length ? 1 : 0) > max) { if (picked.length) break; continue; }
    picked.push(s);
    len += s.length + (picked.length > 1 ? 1 : 0);
  }
  return picked.join(" ");
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** How many questions the draft leaves open or blocking, and how many calls it marks "PM decides". */
export function draftCounts(markdown: string): { open: number; blocking: number; pmDecides: number } {
  const doc = sections(markdown);
  // Top-level list items only: a nested bullet explains its parent, it isn't another question.
  const items = (s: Section) => s.lines.filter((l) => /^ ?(?:[-*+•]|\d+[.)])\s+/.test(l)).length;
  let open = 0, blocking = 0;
  for (const s of doc.sections) {
    const h = plain(s.heading);
    if (/blocking/i.test(h)) blocking += items(s);
    else if (/\bquestions?\b/i.test(h)) open += items(s);
  }
  const all = [...doc.intro, ...doc.sections.flatMap((s) => s.lines)];
  const pmDecides = all.filter((l) => /PM decides/i.test(l)).length;
  return { open, blocking, pmDecides };
}

/** TASK-10: the comment, without the `pmx:pr` line PMX puts above it. At most COMMENT_MAX characters, never cut mid-sentence. */
export function draftComment(i: DraftCommentInput): string {
  const names = i.names ?? [];
  const rules = { people: i.people ?? [] };
  const noun = i.noun ?? "Draft";
  const doc = i.markdown ? sections(i.markdown) : null;
  const own = doc?.title ? plain(doc.title).replace(/^[A-Z]{1,6}-\d+:\s*/, "") : "";
  const title = own && safe(own, names, rules) && own.length <= 120 ? own : i.title;
  const head = `${noun} ready for review: ${title.replace(/[.\s]+$/, "")}.`;
  const counts = i.markdown ? draftCounts(i.markdown) : { open: 0, blocking: 0, pmDecides: 0 };
  const asks = [
    counts.blocking ? plural(counts.blocking, "blocking question") : null,
    counts.open ? plural(counts.open, "open question") : null,
    counts.pmDecides ? `${plural(counts.pmDecides, "call")} marked PM decides` : null,
  ].filter(Boolean);
  const leaves = asks.length ? `It leaves ${asks.join(", ").replace(/, ([^,]*)$/, " and $1")}.` : "";
  const where = /^https?:\/\//.test(i.prUrl)
    ? `Read it in the pull request: ${i.prUrl}`
    : /^https?:\/\//.test(i.path)
      ? `Open it at ${i.path}; it's on ${i.agent}'s Mac until it's accepted.`
      : `Read it in the team repo at ${i.path}, on ${i.agent}'s Mac until it's accepted.`;
  const build = (summary: string) => [head, summary, leaves, where].filter(Boolean).join("\n");
  for (const max of [SUMMARY_MAX, 200, 120]) {
    const text = build(i.markdown ? draftSummary(i.markdown, names, max, rules) : "");
    if (text.length <= COMMENT_MAX) return text;
  }
  return build("");
}
