import { createHash } from "node:crypto";
import { isThread, type SignalItem } from "./types.js";

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
  | "unknown-participants"
  | "place-not-approved"
  | "not-attended";

type Topic = "performance" | "compensation" | "health" | "hiring" | "one-on-one";

/**
 * One fixed topic rule. A passage is cut when it matches a pattern, unless that match sits inside one of the
 * rule's `notWhen` contexts: ordinary product talk that happens to use the same words (F1, 2026-11-25). An
 * exception is always narrower than the pattern it spares, so when in doubt the passage is still cut.
 */
export interface TopicRule {
  label: string;
  examples: string[];
  patterns: string[];
  notWhen?: string[];
}

/** Things, not people, that "underperform": a model, a page, a campaign. Used only right before the verb. */
const THINGS =
  "(model|feature|page|variant|campaign|ad|endpoint|channel|segment|cohort|sku|product|version|build|experiment|metric|benchmark|algorithm|baseline|ranker|classifier|prompt|checkpoint|release|funnel|template|market|stock|portfolio|fund|region|tier|integration|app|site|email|flow|server|database|font|layout|headline|banner|keyword)s?|quer(y|ies)|search|retrieval|onboarding|cache|index";
/** Words that may sit between such a thing and the verb: "the model still underperforms", "variant B has been underperforming". */
const AUX = "(still|really|slightly|consistently|badly|clearly|significantly|noticeably|also|often|usually|always|now|currently|again|is|are|was|were|has|have|had|been|being|will|would|could|might|may|can|keeps|kept|tends|seems|appears|continues|did|does|do|not|to)";

/** The fixed topic rules, with plain-language labels and examples for `pmx explain`. */
export const TOPIC_RULES: Record<Topic, TopicRule> = {
  performance: {
    label: "Performance and HR",
    examples: ["performance review", "PIP", "calibration meeting", "underperforming", "written warning", "disciplinary", "promo packet"],
    patterns: [
      "performance (review|improvement plan|rating|issue|conversation)s?", "perf reviews?", "PIP", "calibration (meeting|session)s?",
      "underperform\\w*", "(his|her|my) (job |work )?performance", "written warning", "disciplinary", "promo(tion)? packets?",
      "terminat\\w+ (his|her|their) employment",
    ],
    notWhen: [
      // "The model underperforms on serif fonts": a thing that underperforms is product talk.
      `\\b(${THINGS})('s)?(\\s+(?!(he|she|they|i|we|you)\\b)[\\w.-]{1,12})?(\\s+${AUX}){0,3}\\s+underperform\\w*`,
      `\\b(it|which)(\\s+${AUX}){0,3}\\s+underperform\\w*`,
    ],
  },
  compensation: {
    label: "Pay and compensation",
    examples: ["salary", "comp band", "pay raise", "bonus", "equity grant", "equity refresh", "stock options", "RSUs", "severance", "payroll"],
    // A company's option pool (fundraising, the cap table) isn't one person's pay, so "option pool" alone isn't
    // cut here; a person's grant from it is ("option grant", "stock options", "vesting schedule", "strike price").
    patterns: [
      "salary", "salaries", "compensation", "comp bands?", "pay (raise|rise|band|grade|cut)s?", "raise for (me|him|her|them)",
      "bonus(es)?", "equity (grant|refresh|package)(s|es)?", "stock grants?", "refresh(er)? grants?", "stock options?", "option grants?",
      "(unvested|vested) (options|shares|equity|stock)", "(options|shares|equity|grants?) (\\w+ ){0,2}vest(s|ed|ing)?",
      "vesting (schedule|cliff|date|period|start)s?", "(vesting|one-year|1-year|one year|1 year|12-month) cliffs?", "strike prices?",
      "RSUs?", "severance", "payroll",
    ],
  },
  health: {
    label: "Health and leave",
    examples: ["medical", "diagnosis", "therapy", "sick leave", "surgery", "pregnant", "parental leave", "mental health", "FMLA"],
    patterns: [
      "medical", "diagnos\\w*", "therapy", "therapist", "sick (leave|day)s?", "illness", "surgery", "pregnan\\w*", "maternity", "paternity",
      "parental leave", "disabilit(y|ies)", "mental health", "FMLA", "doctor'?s? (note|appointment)", "hospitals?", "hospitali[sz](ed|ation|ations)",
      "medication",
    ],
  },
  hiring: {
    label: "Hiring and interviews",
    examples: ["job interview", "candidate feedback", "interview debrief", "recruiter", "offer letter", "reference check", "headcount"],
    patterns: [
      "hiring (manager|committee|decision|panel|plan)s?", "recruit(er|ers|ing|ment|ed)", "(job|video|phone|onsite|on-site|technical|final|panel|screening) interviews?",
      "interview (loop|debrief|feedback|panel|scorecard|process)s?",
      "candidates? for (the |our |this |that |a |an )?([\\w-]+ ){0,3}(role|position|opening|job|req|PM|engineer|designer|manager|lead|director|analyst)s?",
      "candidates? (debrief|feedback|pipeline|interview)\\w*", "offer letters?", "reference checks?", "background checks?",
      "(open|unfilled|approved) ((PM|product|engineering|eng|design|sales|marketing|data|support|senior|staff) )?(req|reqs|requisitions?)", "headcount",
    ],
    notWhen: [
      // Research recruiting: "we recruited 12 participants", "recruiting users for the usability study".
      "\\b(research|participant|user|usability|study|panel|beta|tester)s?\\s+recruit\\w*",
      "\\brecruit(ing|ment|ed)\\s+([\\w-]+\\s+){0,3}(participants?|users?|customers?|testers?|panelists?|respondents?|interviewees?)\\b",
      "\\brecruit(ing|ment|ed)\\s+([\\w-]+\\s+){0,2}for (the|a|an|our|this|that) ([\\w-]+\\s+){0,2}(study|studies|survey|usability|research|beta|panel|pilot|test|diary|interviews)\\b",
      // A release candidate is a build.
      "\\brelease candidates?",
      // Someone else's headcount is business news about them: "their brand team has a headcount freeze". Not "they":
      // that may be the company's own leadership ("they won't give us headcount"). A customer's own words are
      // spared by who says them (see `outsideSpeaker`).
      "\\b(their|customers?|customer's|clients?|client's|markets?|market's|industry|industry's|competitors?|competitor's)\\b((?!\\b(our|we|we're|we've|my|i|i'm|i've|us)\\b)[^.!?;\\n]){0,40}\\bheadcount",
    ],
  },
  "one-on-one": {
    label: "1:1s and career talks",
    examples: ["1:1", "one-on-one", "skip-level", "career chat"],
    patterns: ["1:1s?", "1-1s?", "1 on 1", "one[- ]on[- ]ones?", "1-on-1s?", "skip[- ]levels?", "career (chat|conversation)s?"],
    notWhen: [
      // A ratio, a size or a mapping: "a 1:1 aspect ratio", "1:1 square", "16:9 and 1:1".
      "\\b1[:-]1\\s+(aspect|ratio|square|scale|mapping|map|match|copy|replica|relationship|correspondence|pixel|crop|format|image|thumbnail|tile|grid|frame|video|preview|logo|icon|banner|post|creative|size|parity|replacement|port|migration)s?\\b",
      "\\b(aspect ratios?|ratios?|crop(ped)?|scaled?|squares?|resized?|formats?|sizes?)\\s+((of|to|at|in|is|as|like)\\s+)?(a\\s+)?1[:-]1\\b",
      "\\d+\\s*[:x]\\s*\\d+\\s*(,|/|and|or|to|vs\\.?|&)\\s*1[:-]1\\b",
      "\\b1[:-]1\\s*(,|/|and|or|to|vs\\.?|&)\\s*\\d+\\s*[:x]\\s*\\d+",
    ],
  },
};

/** A compiled topic rule. `all` lists its matches that no `notWhen` context spares. */
export interface TopicMatcher {
  /** Patterns and exceptions, for the receipt's rules hash. */
  readonly source: string;
  all(text: string): RegExpMatchArray[];
  exec(text: string): RegExpMatchArray | null;
  test(text: string): boolean;
}

// Curly apostrophes become straight ones before matching ("I’ll", "doctor’s note"); the length stays the same.
const straight = (s: string) => s.replace(/[‘’]/g, "'");

function compile(r: TopicRule): TopicMatcher {
  const re = new RegExp(`\\b(${r.patterns.join("|")})\\b`, "gi");
  const nots = (r.notWhen ?? []).map((p) => new RegExp(p, "gi"));
  const all = (raw: string) => {
    const text = straight(raw);
    const found = [...text.matchAll(re)];
    if (!found.length || !nots.length) return found;
    const spared = nots.flatMap((n) => [...text.matchAll(n)].map((x) => [x.index!, x.index! + x[0].length] as const));
    return found.filter((m) => !spared.some(([a, b]) => a < m.index! + m[0].length && b > m.index!));
  };
  return { source: [re.source, ...nots.map((n) => `-${n.source}`)].join(" "), all, exec: (t) => all(t)[0] ?? null, test: (t) => all(t).length > 0 };
}

export const TOPICS = Object.fromEntries(Object.entries(TOPIC_RULES).map(([k, r]) => [k, compile(r)])) as Record<Topic, TopicMatcher>;

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
  "place-not-approved": "A channel your team hasn't approved",
  "not-attended": "A meeting you weren't in",
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
  /**
   * Threads only (INPUT-1): whether the place a thread was posted in is one the team approves now. A thread from a
   * place taken off the list, or never on it, is held whole. Without it no thread is read.
   */
  approvedPlace?: (source: string, place: string) => boolean;
  /**
   * Individual scope only (COLLECT-4): who the PM is. A meeting is read for the PM's own to-dos only when they were in
   * it, because the relaxed rules above are for the PM's own meetings (TODO-2): one the synthesis Mac collected for the
   * team, and any other whose participant list doesn't name them (see `notAttended`). Team runs read it under the
   * team's rules like any other.
   */
  attendedBy?: { emails: string[]; names: string[] };
  /**
   * Team scope only (F3, INPUT-4): title patterns of recurring internal meetings the team approved, checked already
   * (`checkSeries`). A meeting with no one from outside the company whose title contains one is used instead of held,
   * and every other rule still applies to it: a held title, a 1:1, the do-not-read list and the topic screen win.
   */
  meetingSeries?: string[];
}

/** A title or a series pattern as the series rule compares them: lower case, accents and punctuation gone. */
const seriesKey = (s: string) => ` ${s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** The approved series pattern a meeting title contains, as whole words ("Launch weekly" in "Launch weekly: Nov 25"). */
export function seriesOf(title: string, patterns: string[] | undefined): string | null {
  if (!patterns?.length) return null;
  const t = seriesKey(title);
  return patterns.find((p) => seriesKey(p).trim() && t.includes(seriesKey(p))) ?? null;
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
 * The outside companies' email domains among a meeting's participants (F14): not the company's own, and not a mail
 * provider anyone can sign up with. Only the domains, never the addresses.
 */
export function outsideDomains(participants: string[], internalDomains: string[]): string[] {
  const internal = internalDomains.map(lc);
  return [...new Set(participants.map(domainOf).filter((d): d is string => !!d && !internal.includes(d) && !PUBLIC_MAIL.has(d)))];
}

/** A domain's own name, for comparing with a company's: "acme.example" and "mail.acme.co.uk" both give "acme". */
export function domainLabel(domain: string): string {
  const parts = domain.toLowerCase().split(".").filter(Boolean);
  if (parts.length > 1) parts.pop();
  if (parts.length > 1 && ["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"].includes(parts.at(-1)!)) parts.pop();
  return parts.at(-1) ?? "";
}

/**
 * The company's own domains (B2): the team's `internalDomains`, plus this PM's own work domains, so a team
 * that never filled in `internalDomains` still can't mistake its own people for customers.
 */
export function companyDomains(teamDomains: string[], own: { companyDomains?: string[] | null; emails?: string[] | null } = {}): string[] {
  const fromEmails = (own.emails ?? []).filter((e) => e.includes("@")).map(cleanDomain).filter((d): d is string => !!d && !PUBLIC_MAIL.has(d));
  return [...new Set([...teamDomains, ...(own.companyDomains ?? [])].map(cleanDomain).filter((d): d is string => !!d).concat(fromEmails))];
}

/**
 * One cut passage, by rule and the hash of its whole turn. `part`: only some sentences of the turn were cut
 * and the rest was used. `followUp`: the turn was cut as a direct reply to a cut passage about a person.
 */
export interface PassageCut {
  rule: HoldReason;
  hash: string;
  part?: { cut: number; of: number };
  followUp?: true;
}

/** Why one source was used or left out. Holds name the rule; passages are hashes, never text. */
export interface ItemDecision {
  item: SignalItem;
  decision: "kept" | "held";
  rule?: HoldReason | "all-passages-held";
  /** A plain-language reason. Names only company or outside domains, never people. */
  detail: string;
  passages: PassageCut[];
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
  "no-external-participant": 0, "no-company-domain": 0, "source-off": 0, "unknown-participants": 0, "place-not-approved": 0, "not-attended": 0,
});

/** "Sam / Priya", "Ana <> Raj", "Lee & Kim": two people's names, the shape of a 1:1's calendar title. */
export const NAME_PAIR = /^\s*\p{Lu}[\p{L}'.-]+(\s\p{Lu}[\p{L}'.-]+)?\s*(\/|<>|&|\||\+|x|-|and)\s*\p{Lu}[\p{L}'.-]+(\s\p{Lu}[\p{L}'.-]+)?\s*$/u;
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

const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const bareName = (s: string) => s.replace(new RegExp(EMAIL.source, "g"), "").replace(/[<>()"']/g, " ").replace(/\s+/g, " ").trim();

type Me = { emails: string[]; names: string[] };
type Attendable = Pick<SignalItem, "participants" | "forTeam" | "owner">;

/** Who the PM is for one meeting: who PMX knows they are, and the file's own `owner` line (the PM who collected it). */
function whoIs(item: Attendable, me: Me): { emails: Set<string>; names: string[] } {
  const owner = item.forTeam?.owner ?? item.owner ?? "";
  return {
    emails: new Set([...me.emails, ...(owner.match(EMAIL) ?? []).slice(0, 1)].map(lc)),
    names: [...me.names, bareName(owner)].map(bareName).filter((n) => n.length >= 2),
  };
}

/**
 * Whether the PM was in a meeting, from its participants: one of the PM's emails, or their name. The PM is who
 * `pmx collect --check` learned they are (or `pmx todo --me`), and the meeting file's own `owner` line.
 */
export function attended(item: Attendable, me: Me): boolean {
  const { emails, names } = whoIs(item, me);
  return item.participants.some((p) => {
    const email = p.match(EMAIL)?.[0];
    if (email && emails.has(lc(email))) return true;
    const name = bareName(p);
    if (name.length < 2) return false;
    // A full name matches the same name; a recorder that gives only a first name ("Ana") counts too.
    return names.some((n) => lc(n) === lc(name) || mentions(name, n) || (!name.includes(" ") && lc(n.split(" ")[0]!) === lc(name)));
  });
}

/**
 * Why a meeting may not feed the PM's own to-dos, or null when it may (COLLECT-4). One the synthesis Mac collected for
 * the team (`scope: team`) needs the PM on its participant list. So does any other meeting with a participant list,
 * once PMX knows who the PM is: a team meeting collected before files carried the scope line, or another person's
 * call in a folder the PM reads. Decided on every run, with who PMX knows the PM is then, so `pmx todo --me` applies
 * to meetings already collected. A meeting with no participant list is read as before: nothing says who was in it.
 */
export function notAttended(item: Attendable, me: Me): string | null {
  if (attended(item, me)) return null;
  if (item.forTeam) return "your synthesis Mac collected it for the team, and you weren't in it, so it never feeds your own to-dos";
  const who = whoIs(item, me);
  if (!item.participants.length || (!who.emails.size && !who.names.length)) return null;
  const n = new Set(item.participants.map(lc)).size;
  return `you aren't among its ${n} participant${n === 1 ? "" : "s"}, so it never feeds your own to-dos. If you were in it under another name or email, give every name and email you use: \`pmx todo --me <name> --me <email>\``;
}

export function itemDecision(item: SignalItem, r: FilterRules): { reason: HoldReason | null; detail: string; series?: string } {
  const ni = r.neverIngest;
  if (r.blockedSources?.includes(sourceOf(item))) return { reason: "source-off", detail: `you set ${sourceOf(item)} not to feed this` };
  const absent = r.attendedBy && item.kind === "transcript" ? notAttended(item, r.attendedBy) : null;
  if (absent) return { reason: "not-attended", detail: absent };
  if (item.kind === "thread" && !(item.place && !/^D(?=[A-Z0-9]*\d)[A-Z0-9]{8,10}$/.test(item.place) && r.approvedPlace?.(sourceOf(item), item.place)))
    return { reason: "place-not-approved", detail: "it was posted in a place your team hasn't approved, or no longer approves" };
  // A meeting's title names what it's about: any sensitive topic there holds the whole meeting.
  for (const [topic, re] of activeTopics(r)) if (re.test(item.title)) return { reason: topic, detail: TITLE_TOPIC_DETAIL[topic] };
  if (HIRING_TITLE.test(item.title) && !RESEARCH_INTERVIEW.test(item.title)) return { reason: "hiring", detail: TITLE_TOPIC_DETAIL.hiring };
  const people = new Set(item.participants.map(lc));
  if (!r.allowOneOnOne && item.kind === "transcript" && people.size <= 2 && NAME_PAIR.test(item.title))
    return { reason: "one-on-one", detail: "two people and a title naming two people: a 1:1" };
  if (ni.meetingTitles.some((t) => lc(item.title).includes(lc(t)))) return { reason: "never-ingest", detail: "the title matches your do-not-read list" };
  const bare = (x: string) => lc(x).replace(/^#/, "");
  if (ni.channels.some((c) => bare(c) === bare(item.ref) || bare(item.title) === bare(c) || (item.place && bare(item.place) === bare(c))))
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
      // F3: a recurring internal meeting the team approved. Everything above (a held title, a 1:1's title, the
      // do-not-read list) has already had its say; a meeting of two is a 1:1 whatever it's called.
      const series = seriesOf(item.title, r.meetingSeries);
      if (series && people.size <= 2) return { reason: "one-on-one", detail: `its title matches your team's meeting series (${series}), but only two people were in it, so PMX treats it as a 1:1` };
      if (series) return { reason: null, detail: `an approved team meeting series (${series})`, series };
      const why = `everyone is on your company's domains (${internal.join(", ")}) or has no email address`;
      return { reason: "no-external-participant", detail: why };
    }
    return { reason: null, detail: `has someone from outside the company (${outside.join(", ")})` };
  }
  return { reason: null, detail: isThread(item) ? "a thread in an approved channel" : "passed every rule" };
}

/** Utterances or paragraphs: the unit the topic rules judge. Shared with `pmx explain` to locate holds. */
export function segments(text: string): string[] {
  return text.split(/\n(?=\s*\n)|\n(?=[^\n]{1,60}:\s)/);
}

/** A held passage is remembered only by this hash, so it can be located later in the PM's own file. */
export const passageHash = (seg: string) => createHash("sha256").update(seg.trim()).digest("hex").slice(0, 16);

/** What stands where sentences were cut from a turn that is otherwise used, styled like the redaction placeholders. */
export const HELD_MARKER = "[HELD]";

/** The topic rules a run applies, in order: the 1:1 rule is off where 1:1s may be read (TODO-2). */
function activeTopics(r: FilterRules): [Topic, TopicMatcher][] {
  return (Object.entries(TOPICS) as [Topic, TopicMatcher][]).filter(([t]) => !(t === "one-on-one" && r.allowOneOnOne));
}

/** Abbreviations whose full stop doesn't end a sentence. */
const ABBREV = /(?:^|[\s(])(?:e\.g|i\.e|etc|vs|cf|mr|mrs|ms|dr|prof|approx|incl)\.$/i;

/** A turn's sentences, each with the space after it, so the turn can be put back together exactly. A line break also ends one. */
export function sentences(text: string): { text: string; sep: string }[] {
  const out: { text: string; sep: string }[] = [];
  const re = /([.!?…]+["'”’)\]]*)(\s+)|([ \t]*\n\s*)/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m[3] !== undefined ? m.index : m.index + m[1]!.length;
    if (m[1] && ABBREV.test(text.slice(start, end))) continue;
    if (end > start) out.push({ text: text.slice(start, end), sep: m[3] ?? m[2]! });
    else if (out.length) out[out.length - 1]!.sep += m[0];
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ text: text.slice(start), sep: "" });
  return out;
}

/** Leading space, then a speaker label ("Jane: ", "00:01:02 Jane Doe: "), then what was said. */
const LABEL = /^(\s*)([^\n.!?]{1,60}?:[ \t]+)?/;
function parts(seg: string): { lead: string; label: string; body: string } {
  const m = LABEL.exec(seg)!;
  return { lead: m[1]!, label: m[2] ?? "", body: seg.slice(m[0].length) };
}

/** Hiring talk about a plan, not a person ("I'm not getting headcount", "our hiring plan", "two open reqs"). */
const PLAN_TALK = /^(headcount|hiring plans?|(open|unfilled|approved)\b.*)$/i;
/** A sentence that spells out who a plan would hire: "Two backend engineers in Q1." */
const PLAN_DETAIL =
  /\b(\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten|a few|several|more|another)\s+(more\s+|extra\s+|new\s+|additional\s+)?([\w-]+\s+){0,2}(engineers?|designers?|PMs?|product managers?|people|hires?|heads|roles?|reqs?|writers?|researchers?|analysts?|developers?|devs|contractors?|FTEs?)\b/i;

/** Name tokens: "Lee Park" and "lee.park@acme.com" both give ["lee", "park"]. Numbers (timestamps) are dropped. */
const nameTokens = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{N}]+/u).filter((t) => t && !/^\d+$/.test(t));

/**
 * Whether a turn's speaker is from outside the company: their label ("Lee Park:") names an outside participant
 * (lee.park@acme.com) and no one else in the meeting. A speaker it can't place this way counts as inside. A
 * customer's headcount or hiring plan is news about their business, so plan talk from them isn't cut (F1);
 * anything about a person still is.
 */
export function outsideSpeaker(item: Pick<SignalItem, "participants">, r: Pick<FilterRules, "internalDomains">): (label: string) => boolean {
  const internal = r.internalDomains.map(lc);
  if (!internal.length) return () => false;
  const people = item.participants.map((p) => {
    const d = domainOf(p);
    return { outside: d !== null && !internal.includes(d), tokens: nameTokens(p.includes("@") ? p.slice(0, p.lastIndexOf("@")) : p) };
  });
  return (label) => {
    const name = nameTokens(label);
    if (!name.length) return false;
    const named = people.filter((p) => name.every((t) => p.tokens.includes(t)));
    return named.length > 0 && named.every((p) => p.outside);
  };
}
/** Whether these matches are about a person: their review, pay, health, 1:1 or candidacy. Those cut more around them. */
const aboutAPerson = (topic: Topic, found: RegExpMatchArray[]) => topic !== "hiring" || found.some((m) => !PLAN_TALK.test(m[0]));

interface TurnCut {
  rule: HoldReason;
  /** The turn with its cut sentences replaced by the marker, or null when the whole turn goes. */
  kept: string | null;
  part?: { cut: number; of: number };
  /** Cut for a rule about a person, so a direct reply after it is cut too (F2). */
  personal: boolean;
}

/** A sentence that still talks about a person just named: "he" or "she", or "they" with nothing new named. */
const aboutThem = (text: string) => ONE_PERSON.test(text) || (THEY.test(text) && !NEW_SUBJECT.test(text));

/**
 * Judges one turn (F1, 2026-11-25). Only the sentences that match are cut, and the rest of the turn is used.
 * When the rule is about a person, the sentence before and after go too, and the ones after that while they
 * still talk about that person; after hiring plan talk, a next sentence that spells out who it would hire. The
 * whole turn goes, as before, when that would be more than half of it (by sentences or by length), when its
 * speaker label matches, or when it names someone on the do-not-read list.
 */
function judgeTurn(seg: string, topics: [Topic, TopicMatcher][], r: FilterRules, outside: (label: string) => boolean): TurnCut | null {
  const { lead, label, body } = parts(seg);
  const theirs = !!label && outside(label);
  const matches = (t: Topic, m: TopicMatcher, text: string) => (theirs && t === "hiring" ? m.all(text).filter((x) => !PLAN_TALK.test(x[0])) : m.all(text));
  const hits = topics.filter(([t, m]) => matches(t, m, seg).length);
  const listed = r.neverIngest.people.some((p) => mentions(seg, p));
  if (!hits.length) return listed ? { rule: "never-ingest", kept: null, personal: false } : null;
  const rule = hits[0]![0];
  const personal = hits.some(([t, m]) => aboutAPerson(t, matches(t, m, seg)));
  const s = sentences(body);
  const cut = s.map(() => false);
  s.forEach((x, i) => {
    for (const [topic, m] of hits) {
      const found = matches(topic, m, x.text);
      if (!found.length) continue;
      cut[i] = true;
      if (!aboutAPerson(topic, found)) {
        // A plan's details: "I want to ask for headcount. Two backend engineers in Q1."
        if (i + 1 < s.length && PLAN_DETAIL.test(s[i + 1]!.text)) cut[i + 1] = true;
        continue;
      }
      if (i > 0) cut[i - 1] = true;
      // The sentence after, and on while the talk is still about that person: "She'll be back in April."
      for (let j = i + 1; j < s.length && (j === i + 1 || aboutThem(s[j]!.text)); j++) cut[j] = true;
    }
  });
  const n = cut.filter(Boolean).length;
  const size = (c: boolean) => s.reduce((a, x, i) => a + (cut[i] === c ? x.text.length : 0), 0);
  if (listed || !n || n * 2 > s.length || size(true) > size(false) || hits.some(([t, m]) => matches(t, m, label).length)) return { rule, kept: null, personal };
  let kept = lead + label;
  for (let i = 0; i < s.length; i++) {
    if (!cut[i]) {
      kept += s[i]!.text + s[i]!.sep;
      continue;
    }
    while (i + 1 < s.length && cut[i + 1]) i++;
    kept += HELD_MARKER + s[i]!.sep;
  }
  // What's left must match no rule: a phrase across a line break ("performance\nreview") is in no one sentence.
  if (hits.some(([t, m]) => matches(t, m, kept).length)) return { rule, kept: null, personal };
  return { rule, kept, part: { cut: n, of: s.length }, personal };
}

/** How many turns after a cut about a person may be cut as direct replies to it (F2). */
const FOLLOW_UPS = 2;
const FILLER = "(?:(?:um+|uh+|so|and|well|oh|hmm+)[,.]?\\s+)*";
/** A turn that opens by changing the subject. */
const SHIFT = new RegExp(
  `^${FILLER}(?:(?:ok(?:ay)?|alright|all right|right)[,.!]?\\s+)?(?:anyway|anyhow|moving on|back to|switching (?:gears|topics)|changing (?:gears|topics|the subject)|on (?:another|a different|a separate) (?:note|topic)|separately|unrelated(?:ly)?|next (?:topic|item|up|thing)|let's (?:move on|get back|go back|switch|turn to))\\b`,
  "i",
);
/** A turn that opens by taking over someone's work or answering news about them: "(Yeah,) I'll take over…", "Sorry", "Congrats". */
const HAND_OVER = new RegExp(
  `^${FILLER}(?:(?:yeah|yes|ok|okay|sure|right|agreed|fine|of course)[,.!]?\\s+)?(?:(?:sorry|i'm sorry|oh no|ugh|poor \\w+|congrats|congratulations|that(?:'s| is) (?:rough|tough|hard|sad|awful|a shame|too bad))\\b|i(?:'ll| will| can|'d| could)(?: \\w+)? (?:take|cover|pick up|handle|talk to|check in|follow up|step in|own|backfill|loop in|deal with|sit down|reach out))`,
  "i",
);
/** A turn that opens by agreeing: "Yeah", "Agreed", "That's fair". On its own this says little, so it counts only when nothing new follows. */
const AGREE = new RegExp(
  `^${FILLER}(?:yeah|yes|yep|yup|ok|okay|sure|of course|right|agreed|agree|true|totally|exactly|absolutely|definitely|fair|understood|noted|got it|makes sense|sounds (?:good|right|fair)|that(?:'s| is) (?:fair|right|true|fine)|that makes sense|wow|good call|no worries|same|me too|thanks|thank you)\\b`,
  "i",
);
const ONE_PERSON = /\b(he|she|him|his|her|hers|himself|herself)\b/i;
const THEY = /\b(they|them|their|theirs|themselves)\b/i;
/** Something new to talk about: an acronym (SSO, SCIM), a product's mixed-case name (OAuth, GitHub, iOS) or a number. */
const NEW_SUBJECT = /\b(?!OK\b)[A-Z]{2,}s?\b|\b[A-Z]{2,}[a-z]\w*|\b\w*[a-z][A-Z]\w*|\d/;

/**
 * Whether a turn reads as a direct reply to the one before it (F2): "he"/"she" in its first two sentences; a
 * hand-over or sympathy cue at its start ("I'll take over…", "Sorry"); "they"/"their" in a first sentence that
 * names nothing new; or, if the turn names nothing new, an agreeing cue ("Yeah", "That's fair") or two sentences
 * or fewer. A turn that opens by changing the subject is a reply only through "he"/"she". Something new is an
 * acronym, a product name or a number ("Okay, I'll ship the SSO fix tonight", "Sure. Can you write up the OAuth
 * flow?"): the talk has moved on.
 */
export function followsUp(seg: string): boolean {
  const body = straight(parts(seg).body).trim();
  if (!body) return false;
  const s = sentences(body).map((x) => x.text);
  if (ONE_PERSON.test(s.slice(0, 2).join(" "))) return true;
  if (SHIFT.test(body)) return false;
  if (HAND_OVER.test(body)) return true;
  if (THEY.test(s[0]!) && !NEW_SUBJECT.test(s[0]!)) return true;
  if (NEW_SUBJECT.test(body)) return false;
  return AGREE.test(body) || s.length <= 2;
}

/**
 * Cuts what hits a topic rule, a turn or sentences at a time (see `judgeTurn`), and up to two direct replies
 * after a cut about a person, stopping at the first turn that isn't one. `passages` collects each cut as rule + hash.
 */
export function screenText(
  text: string, r: FilterRules, counts: Record<HoldReason, number>, passages?: ItemDecision["passages"], outside: (label: string) => boolean = () => false,
): string {
  const topics = activeTopics(r);
  const kept: string[] = [];
  let after: { rule: HoldReason; left: number } | null = null;
  for (const seg of segments(text)) {
    if (!seg.trim()) {
      kept.push(seg);
      continue;
    }
    const cut = judgeTurn(seg, topics, r, outside);
    if (cut) {
      counts[cut.rule]++;
      passages?.push({ rule: cut.rule, hash: passageHash(seg), ...(cut.part ? { part: cut.part } : {}) });
      if (cut.kept !== null) kept.push(cut.kept);
      if (cut.rule !== "never-ingest") after = cut.personal ? { rule: cut.rule, left: FOLLOW_UPS } : null;
      continue;
    }
    if (after && followsUp(seg)) {
      counts[after.rule]++;
      passages?.push({ rule: after.rule, hash: passageHash(seg), followUp: true });
      after = after.left > 1 ? { rule: after.rule, left: after.left - 1 } : null;
      continue;
    }
    after = null;
    kept.push(seg);
  }
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function filterItems(items: SignalItem[], r: FilterRules): FilterResult {
  const held = emptyCounts();
  const kept: SignalItem[] = [];
  const decisions: ItemDecision[] = [];
  let heldItems = 0;
  for (const item of items) {
    const { reason, detail, series } = itemDecision(item, r);
    if (reason) {
      held[reason]++;
      heldItems++;
      decisions.push({ item, decision: "held", rule: reason, detail, passages: [], passagesKept: 0 });
      continue;
    }
    const passages: ItemDecision["passages"] = [];
    const text = screenText(item.text, r, held, passages, outsideSpeaker(item, r));
    // Two or more sensitive passages: the meeting is about that topic, so none of it goes to the team. A reply cut
    // with the passage before it is part of that passage, so it isn't counted again.
    const topics = passages.filter((p) => p.rule !== "never-ingest" && !p.followUp);
    if (r.wholeMeeting && topics.length >= 2) {
      const rule = topics[0]!.rule;
      held[rule]++;
      heldItems++;
      decisions.push({ item, decision: "held", rule, detail: `${topics.length} passages are about ${HOLD_LABELS[rule].toLowerCase()}, so PMX holds the whole meeting`, passages, passagesKept: 0 });
      continue;
    }
    const passagesKept = text ? segments(text).filter((s) => s.trim()).length : 0;
    if (text) {
      kept.push({ ...item, text, ...(series ? { series } : {}) });
      decisions.push({ item, decision: "kept", detail, passages, passagesKept });
    } else decisions.push({ item, decision: "held", rule: "all-passages-held", detail: "every passage hit a privacy rule", passages, passagesKept: 0 });
  }
  return { kept, held, heldItems, decisions };
}

export function totalHeld(h: Record<HoldReason, number>): number {
  return Object.values(h).reduce((a, b) => a + b, 0);
}
