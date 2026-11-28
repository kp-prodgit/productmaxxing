// The golden corpus's runner (test/corpus.test.ts): one entry of test/corpus/filter/*.jsonl through the privacy filter
// exactly as a run uses it (`filterItems`: the meeting's own rules first, then the passage screen), and what came out
// in the corpus's own words: kept, cut, or the text that was left.
import { filterItems, type FilterRules } from "../src/core/filter.js";
import type { SignalItem } from "../src/core/types.js";

/** One line of a corpus file. See README.md, "Adding a line to the corpus". */
export interface CorpusEntry {
  /** A group of entries about one kind of line: "bonus", "commission", "health", "product"… */
  family: string;
  /** What is said: one turn, one message of a thread, or a short passage. Several turns are "Name: …" lines with a blank line between. */
  text: string;
  /** What must happen: "kept" (all of it), "cut" (none of it is used), or the exact text left, with [HELD] where sentences were cut. */
  expect: string;
  /** The rule that cuts it (the first one, for several), or null when it's kept whole. */
  topic: string | null;
  /** Why this is right, in a sentence. */
  why: string;
  context?: CorpusContext;
  /**
   * A known gap: `expect` and `topic` say what PMX does today, `want` what it should do (and `why`). The test fails when
   * PMX starts doing `want` while this is still here, so the fix flips the entry on purpose.
   */
  known_gap?: { want: string; why: string };
}

export interface CorpusContext {
  /** Who says it: someone from the customer ("outside") or a colleague ("inside"). Their name is put before the text. */
  speaker?: "outside" | "inside";
  /** false: no one from outside the company was in the meeting. */
  outside_present?: boolean;
  /** The team's confidential domains (investors, counsel). */
  confidential?: string[];
  /** People on the PM's do-not-read list. */
  never?: string[];
  /** The meeting's or thread's title. */
  title?: string;
  /** "thread": a message thread from an approved channel instead of a meeting. */
  kind?: "meeting" | "thread";
  /** "own": the PM's own to-dos, which may read 1:1s, internal meetings and fundraising. */
  scope?: "team" | "own";
  /** true: a meeting that returns to a sensitive topic in two or more passages is held whole, as team runs do. */
  whole_meeting?: boolean;
}

export const OUTSIDE = "Lee Park";
export const INSIDE = "Dana Ruiz";
const LABEL = { outside: `${OUTSIDE}: `, inside: `${INSIDE}: ` } as const;

/** What the filter did with an entry, in the corpus's words. */
export function runFilterEntry(e: CorpusEntry): { result: string; topic: string | null } {
  const c = e.context ?? {};
  const own = c.scope === "own";
  const rules: FilterRules = {
    internalDomains: ["us.example"],
    requireExternalParticipant: !own,
    neverIngest: { people: c.never ?? [], channels: [], meetingTitles: [] },
    wholeMeeting: !!c.whole_meeting,
    approvedPlace: () => true,
    ...(own ? { allowOneOnOne: true, allowConfidential: true } : {}),
    ...(c.confidential ? { confidentialDomains: c.confidential } : {}),
  };
  const label = c.speaker ? LABEL[c.speaker] : "";
  const text = label + e.text;
  const participants = [...(c.outside_present === false ? [] : [`${OUTSIDE} <lee@northwind.example>`]), `${INSIDE} <dana@us.example>`, "Sam Okafor <sam@us.example>"];
  const item: SignalItem = c.kind === "thread"
    ? { id: "C1", kind: "thread", ref: "https://chat.example/archives/C0123456789/p1", title: c.title ?? "#product-feedback", at: "2026-11-20", participants, text, place: "#product-feedback", origin: { source: "slack", sourceId: "c1" } }
    : { id: "T1", kind: "transcript", ref: "/corpus/call.md", title: c.title ?? "Northwind weekly sync", at: "2026-11-20", participants, text };
  const { kept, decisions } = filterItems([item], rules);
  const d = decisions[0]!;
  if (d.decision === "held") return { result: "cut", topic: d.rule === "all-passages-held" ? d.passages[0]?.rule ?? null : d.rule ?? null };
  const left = kept[0]!.text;
  const shown = label && left.startsWith(label) ? left.slice(label.length) : left;
  return { result: left === text.trim() ? "kept" : shown, topic: d.passages[0]?.rule ?? null };
}
