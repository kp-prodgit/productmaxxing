import { createHash } from "node:crypto";
import type { SignalItem } from "./types.js";

/**
 * The personal-content filter (B2, PRIV-2). Fixed rules only (Q10, decided 2026-11-03):
 * deterministic, testable and the same on every machine.
 *
 * Held material is discarded, never stored. Each decision is explained by rule and location
 * (PRIV-4): which source, which rule, and a hash of each held passage, never its text.
 */

export type HoldReason =
  | "one-on-one"
  | "performance"
  | "compensation"
  | "health"
  | "hiring"
  | "never-ingest"
  | "no-external-participant"
  | "no-company-domain"
  | "source-off"
  | "unknown-participants";

type Topic = "performance" | "compensation" | "health" | "hiring" | "one-on-one";

/** The fixed topic rules, with plain-language labels and examples for `pmx explain`. */
export const TOPIC_RULES: Record<Topic, { label: string; examples: string[]; patterns: string[] }> = {
  performance: {
    label: "Performance and HR",
    examples: ["performance review", "PIP", "calibration meeting", "underperforming", "written warning", "disciplinary", "promo packet"],
    patterns: [
      "performance (review|improvement plan|rating|issue|conversation)s?", "perf reviews?", "PIP", "calibration (meeting|session)s?",
      "underperform\\w*", "written warning", "disciplinary", "promo(tion)? packets?", "terminat\\w+ (his|her|their) employment",
    ],
  },
  compensation: {
    label: "Pay and compensation",
    examples: ["salary", "comp band", "pay raise", "bonus", "equity grant", "RSUs", "severance", "payroll"],
    patterns: [
      "salary", "salaries", "compensation", "comp bands?", "pay (raise|rise|band|grade|cut)s?", "raise for (me|him|her|them)",
      "bonus(es)?", "equity grants?", "stock grants?", "RSUs?", "severance", "payroll",
    ],
  },
  health: {
    label: "Health and leave",
    examples: ["medical", "diagnosis", "therapy", "sick leave", "surgery", "pregnant", "parental leave", "mental health", "FMLA"],
    patterns: [
      "medical", "diagnos\\w*", "therapy", "therapist", "sick (leave|day)s?", "illness", "surgery", "pregnan\\w*", "maternity", "paternity",
      "parental leave", "disabilit(y|ies)", "mental health", "FMLA", "doctor'?s? (note|appointment)", "hospital\\w*", "medication",
    ],
  },
  hiring: {
    label: "Hiring and interviews",
    examples: ["job interview", "candidate feedback", "interview debrief", "recruiter", "offer letter", "reference check", "headcount"],
    patterns: [
      "hiring (manager|committee|decision|panel|plan)s?", "recruit(er|ers|ing|ment)", "(job|video|phone|onsite|on-site|technical|final|panel|screening) interviews?",
      "interview (loop|debrief|feedback|panel|scorecard|process)s?", "candidates? (for the|for our|debrief|feedback|pipeline|interview)\\w*", "offer letters?",
      "reference checks?", "background checks?", "headcount",
    ],
  },
  "one-on-one": {
    label: "1:1s and career talks",
    examples: ["1:1", "one-on-one", "skip-level", "career chat"],
    patterns: ["1:1s?", "1-1s?", "1 on 1", "one[- ]on[- ]ones?", "1-on-1s?", "skip[- ]levels?", "career (chat|conversation)s?"],
  },
};

export const TOPICS = Object.fromEntries(
  Object.entries(TOPIC_RULES).map(([k, r]) => [k, new RegExp(`\\b(${r.patterns.join("|")})\\b`, "i")]),
) as Record<Topic, RegExp>;

/** Plain-language names for every hold reason, shared by the terminal and the explain page. */
export const HOLD_LABELS: Record<HoldReason | "all-passages-held", string> = {
  "one-on-one": "1:1s and career talks",
  performance: "Performance and HR",
  compensation: "Pay and compensation",
  health: "Health and leave",
  hiring: "Hiring and interviews",
  "never-ingest": "Your do-not-read list",
  "no-external-participant": "No one from outside the company",
  "no-company-domain": "Company email domain not set",
  "source-off": "A source you turned off for this",
  "unknown-participants": "No participant list",
  "all-passages-held": "Every passage was cut",
};

export interface FilterRules {
  internalDomains: string[];
  /** Transcripts need an external participant (B2). Slack items skip this check. */
  requireExternalParticipant: boolean;
  neverIngest: { people: string[]; channels: string[]; meetingTitles: string[] };
  /**
   * Individual scope only (TODO-2): the PM's own 1:1s and internal meetings may be read, because the
   * result never leaves their Mac. Performance, pay and health passages are still cut.
   */
  allowOneOnOne?: boolean;
  /**
   * Team scope: a meeting that keeps returning to a sensitive topic (two or more passages) is held whole, not
   * just cut, so what's left of it never reaches the team's tracker.
   */
  wholeMeeting?: boolean;
  /** Sources (connector names, "file", "slack") this run may not read, from the PM's routes (BOARD-3). */
  blockedSources?: string[];
}

/** Which source an item came from, as routes name it. */
export const sourceOf = (item: Pick<SignalItem, "kind" | "origin">) => (item.kind === "slack" ? "slack" : item.origin?.source ?? "file");

/** Mail providers anyone can sign up with: never a company's own domain. */
const PUBLIC_MAIL = new Set(["gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "fastmail.com"]);

/** Turns "@Acme.com", "https://acme.com" or "pm@acme.com" into "acme.com". Null for anything else. */
export function cleanDomain(s: string): string | null {
  const d = s.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^.*@/, "").replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

/**
 * The company's own domains (B2): the team's `internalDomains`, plus this PM's own work domains, so a team
 * that never filled in `internalDomains` still can't mistake its own people for customers.
 */
export function companyDomains(teamDomains: string[], own: { companyDomains?: string[] | null; emails?: string[] | null } = {}): string[] {
  const fromEmails = (own.emails ?? []).filter((e) => e.includes("@")).map(cleanDomain).filter((d): d is string => !!d && !PUBLIC_MAIL.has(d));
  return [...new Set([...teamDomains, ...(own.companyDomains ?? [])].map(cleanDomain).filter((d): d is string => !!d).concat(fromEmails))];
}

/** Why one source was used or left out. Holds name the rule; passages are hashes, never text. */
export interface ItemDecision {
  item: SignalItem;
  decision: "kept" | "held";
  rule?: HoldReason | "all-passages-held";
  /** A plain-language reason. Names only company or outside domains, never people. */
  detail: string;
  passages: { rule: HoldReason; hash: string }[];
  passagesKept: number;
}

export interface FilterResult {
  kept: SignalItem[];
  held: Record<HoldReason, number>;
  /** Items dropped whole (as opposed to single segments). */
  heldItems: number;
  decisions: ItemDecision[];
}

const emptyCounts = (): Record<HoldReason, number> => ({
  "one-on-one": 0, performance: 0, compensation: 0, health: 0, hiring: 0, "never-ingest": 0,
  "no-external-participant": 0, "no-company-domain": 0, "source-off": 0, "unknown-participants": 0,
});

/** "Sam / Priya", "Ana <> Raj", "Lee & Kim": two people's names, the shape of a 1:1's calendar title. */
const NAME_PAIR = /^\s*\p{Lu}[\p{L}'.-]+(\s\p{Lu}[\p{L}'.-]+)?\s*(\/|<>|&|\||\+|x|-|and)\s*\p{Lu}[\p{L}'.-]+(\s\p{Lu}[\p{L}'.-]+)?\s*$/u;
/** A title about an interview that isn't user research ("Customer interview" is research; "Video Interview - …" is hiring). */
const HIRING_TITLE = /\binterview/i;
const RESEARCH_INTERVIEW = /\b(customer|user|discovery|research|usability|client|buyer|partner|expert|stakeholder)s?\s+interview/i;
const TITLE_TOPIC_DETAIL: Record<Topic, string> = {
  "one-on-one": "the title looks like a 1:1 or career talk",
  performance: "the title is about performance or HR",
  compensation: "the title is about pay or compensation",
  health: "the title is about health or leave",
  hiring: "the title is about hiring or an interview",
};

const lc = (s: string) => s.toLowerCase();
const domainOf = (p: string) => (p.includes("@") ? lc(p.split("@").pop()!) : null);

function mentions(text: string, needle: string): boolean {
  if (!needle.trim()) return false;
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "iu");
  return re.test(text);
}

export function itemHoldReason(item: SignalItem, r: FilterRules): HoldReason | null {
  return itemDecision(item, r).reason;
}

export function itemDecision(item: SignalItem, r: FilterRules): { reason: HoldReason | null; detail: string } {
  const ni = r.neverIngest;
  if (r.blockedSources?.includes(sourceOf(item))) return { reason: "source-off", detail: `you set ${sourceOf(item)} not to feed this` };
  // A meeting's title names what it's about: any sensitive topic there holds the whole meeting.
  for (const [topic, re] of Object.entries(TOPICS) as [Topic, RegExp][]) {
    if (topic === "one-on-one" && r.allowOneOnOne) continue;
    if (re.test(item.title)) return { reason: topic, detail: TITLE_TOPIC_DETAIL[topic] };
  }
  if (HIRING_TITLE.test(item.title) && !RESEARCH_INTERVIEW.test(item.title)) return { reason: "hiring", detail: TITLE_TOPIC_DETAIL.hiring };
  const people = new Set(item.participants.map(lc));
  if (!r.allowOneOnOne && item.kind === "transcript" && people.size <= 2 && NAME_PAIR.test(item.title))
    return { reason: "one-on-one", detail: "two people and a title naming two people: a 1:1" };
  if (ni.meetingTitles.some((t) => lc(item.title).includes(lc(t)))) return { reason: "never-ingest", detail: "the title matches your do-not-read list" };
  if (ni.channels.some((c) => lc(c).replace(/^#/, "") === lc(item.ref).replace(/^#/, "") || lc(item.title) === lc(c).replace(/^#/, "")))
    return { reason: "never-ingest", detail: "the channel is on your do-not-read list" };
  if (item.participants.some((p) => ni.people.some((x) => lc(p) === lc(x) || mentions(p, x))))
    return { reason: "never-ingest", detail: "a participant is on your do-not-read list" };
  if (item.kind === "transcript" && r.requireExternalParticipant) {
    if (item.participants.length === 0) return { reason: "unknown-participants", detail: "the file lists no participants, so PMX can't tell it's a customer call" };
    // Default-deny (B2): without the company's own domain, every attendee would look like an outsider.
    if (!r.internalDomains.length) return { reason: "no-company-domain", detail: "PMX doesn't know your company's email domain, so it can't tell a customer call from an internal meeting. Set it with `pmx init`" };
    const internal = r.internalDomains.map(lc);
    const outside = [...new Set(item.participants.map(domainOf).filter((d): d is string => d !== null && !internal.includes(d)))];
    if (!outside.length) {
      const why = `everyone is on your company's domains (${internal.join(", ")}) or has no email address`;
      return { reason: "no-external-participant", detail: why };
    }
    return { reason: null, detail: `has someone from outside the company (${outside.join(", ")})` };
  }
  return { reason: null, detail: item.kind === "slack" ? "a message in an approved channel" : "passed every rule" };
}

/** Utterances or paragraphs: the unit the topic rules judge. Shared with `pmx explain` to locate holds. */
export function segments(text: string): string[] {
  return text.split(/\n(?=\s*\n)|\n(?=[^\n]{1,60}:\s)/);
}

/** A held passage is remembered only by this hash, so it can be located later in the PM's own file. */
export const passageHash = (seg: string) => createHash("sha256").update(seg.trim()).digest("hex").slice(0, 16);

/** Drops the segments that hit a topic rule. `passages` collects each hold as rule + hash. */
export function screenText(text: string, r: FilterRules, counts: Record<HoldReason, number>, passages?: ItemDecision["passages"]): string {
  const kept: string[] = [];
  for (const seg of segments(text)) {
    let reason: HoldReason | null = null;
    for (const [topic, re] of Object.entries(TOPICS) as [Topic, RegExp][]) {
      if (topic === "one-on-one" && r.allowOneOnOne) continue;
      if (re.test(seg)) {
        reason = topic;
        break;
      }
    }
    if (!reason && r.neverIngest.people.some((p) => mentions(seg, p))) reason = "never-ingest";
    if (reason) {
      counts[reason]++;
      passages?.push({ rule: reason, hash: passageHash(seg) });
    } else kept.push(seg);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function filterItems(items: SignalItem[], r: FilterRules): FilterResult {
  const held = emptyCounts();
  const kept: SignalItem[] = [];
  const decisions: ItemDecision[] = [];
  let heldItems = 0;
  for (const item of items) {
    const { reason, detail } = itemDecision(item, r);
    if (reason) {
      held[reason]++;
      heldItems++;
      decisions.push({ item, decision: "held", rule: reason, detail, passages: [], passagesKept: 0 });
      continue;
    }
    const passages: ItemDecision["passages"] = [];
    const text = screenText(item.text, r, held, passages);
    // Two or more sensitive passages: the meeting is about that topic, so none of it goes to the team.
    const topics = passages.filter((p) => p.rule !== "never-ingest");
    if (r.wholeMeeting && topics.length >= 2) {
      const rule = topics[0]!.rule;
      held[rule]++;
      heldItems++;
      decisions.push({ item, decision: "held", rule, detail: `${topics.length} passages are about ${HOLD_LABELS[rule].toLowerCase()}, so PMX holds the whole meeting`, passages, passagesKept: 0 });
      continue;
    }
    const passagesKept = text ? segments(text).filter((s) => s.trim()).length : 0;
    if (text) {
      kept.push({ ...item, text });
      decisions.push({ item, decision: "kept", detail, passages, passagesKept });
    } else decisions.push({ item, decision: "held", rule: "all-passages-held", detail: "every passage hit a privacy rule", passages, passagesKept: 0 });
  }
  return { kept, held, heldItems, decisions };
}

export function totalHeld(h: Record<HoldReason, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}
