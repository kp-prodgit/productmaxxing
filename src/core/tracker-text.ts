import { confidentialMatcher, domainLabel, FUNDRAISING_CASED as CASED_WORDS, FUNDRAISING_WORDS } from "./filter.js";
import { makeRedactor } from "./redact.js";

/**
 * What a PMX task in Linear may say (F14, PRIV-6; founder decision 2026-11-25): the customer or partner company, the
 * deal stage and the dates the sources state ("Acme's Dec 8 beta", "renewal due Jan 15"). Never people's names, quotes,
 * meeting titles or fundraising. One guard for every place PMX writes tracker text: suggested tasks, follow-ups, the
 * draft-ready comment and the company roll-up. It judges a sentence at a time, so a description loses only the sentence
 * that can't go, never the rest.
 */
export type TextProblem = "transcript" | "quote" | "placeholder" | "fundraising" | "confidential" | "name" | "title" | "contact";

/** What each problem is, in a PM's words, for one sentence and for several. */
export const PROBLEM_TEXT: Record<TextProblem, [string, string]> = {
  transcript: ["carried transcript markup", "carried transcript markup"],
  quote: ["quoted someone", "quoted someone"],
  placeholder: ["had a redaction placeholder", "had redaction placeholders"],
  fundraising: ["was about fundraising", "were about fundraising"],
  confidential: ["named an investor or other confidential contact", "named investors or other confidential contacts"],
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
   * Names found in the sources (participants, speaker labels and their text, from `namesIn`): matched as a capitalized
   * word ("Lee", "Lee Park"), so an ordinary word that is also a name in lower case ("will", "grant") still reads as a word.
   */
  people?: string[];
  /** Meeting titles. A sentence that repeats one of three words or more is cut. */
  titles?: string[];
  /** The team's approved meeting series (F3): their names are meeting titles too, matched from two words. */
  series?: string[];
  /**
   * F5: confidential companies, by their email domains' names ("initech-ventures"): the team's `confidentialDomains`,
   * and the companies of meetings held as fundraising (`confidentialCompanies` in src/core/filter.ts). Blocked like
   * fundraising: "Initech Ventures", "initech-ventures", and "Initech" on its own as a name is written.
   */
  confidential?: string[];
}

/** "Microphone:", "System audio:", "Speaker 2:", "[00:12:03]": transcript markup. */
export const TRANSCRIPT_MARKS = /\b(microphone|system audio|speaker \d+)\s*:|\[\d{1,2}:\d{2}(:\d{2})?\]/i;
const QUOTE = /["“”„«»]|(?:^|\s)'[^']{3,}'(?=[\s.,;:!?]|$)/;
/** A redaction placeholder, with what PMX keeps about a person (R5): "[PERSON-2]", "[PERSON-2, Globex]", "[EMAIL]". */
const PLACEHOLDER = /\[(?:PERSON|EMAIL|PHONE|CARD|ID|HELD)(?:-\d+)?(?:,[^\[\]\n]{1,60})?\]/;

/**
 * Fundraising (F14, F5): investors, a round, Series A/B/…, valuation, a term sheet, dilution, the cap table, the option
 * pool, a raise, a data room, an investor update, due diligence for a raise. The test found "investors are asking the
 * moat question" from a Series B call in a Linear description; the words are business-confidential even when no number
 * goes with them. When in doubt a sentence is cut. One list with the privacy filter's (`FUNDRAISING_WORDS` in
 * src/core/filter.ts), which holds a meeting about it from team work.
 */
const FUNDRAISING_ANY_CASE = new RegExp(FUNDRAISING_WORDS.join("|"), "i");
/** Words whose case tells them apart: "Series B" (not a series of tests), "VCs", an "IPO". */
const FUNDRAISING_CASED = new RegExp(CASED_WORDS.join("|"));

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
  // @here and @channel in a thread, and the tools a team talks to: not people.
  "here", "channel", "folks", "guys", "pmx", "claude",
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
  // An email's header lines ("From:", "Cc:"), which name people but aren't one.
  "from", "to", "cc", "bcc", "subject", "sent", "fw", "fwd", "forwarded", "attachment", "attachments",
]);

/**
 * Words a product, a feature, a role, a team or a meeting is named with ("Brand Kit", "Audit Log", "Single Sign-On",
 * "Q4 Planning", "Product Lead"), and the words that start a sentence or a turn ("Pricing came up", "Yeah", "Loop in").
 * Capitalized, they look like a name; they never make one on their own. A full name from the participants still
 * matches whatever words it has.
 */
const COMMON = new Set((
  // Products and features.
  "access account accounts activity add addon admins adoption advisory agenda alert alerts alpha analytics api app apps approval approvals " +
  "archive area asset assets audit audits auth automation backlog backup badge banner basic beta board boards brand brief briefs bulk bundle " +
  "button buttons cache calendar call calls campaign campaigns canvas card cards cart catalog center centre change changes channels chart charts " +
  "chat checklist checkout city cloud code collection comment comments community compliance component components config connect connector " +
  "connectors console content contract contracts control controls copy core cost costs coupon create credit credits csv custom customers " +
  "dashboard dashboards data database deal deals deck default delete delivery demo deploy deployment desk desktop digest digital directory " +
  "discount doc docs document documents domain download downloads drive dynamic edit edition editor email emails engine enterprise entry " +
  "escalation essentials event events expense export exports express feature features feed fee fees file files filter filters flow flows " +
  "folder folders form forms forum framework free funnel gallery gateway general global graph grid group groups growth guide guides health " +
  "history home hub identity image images import imports inbox index insight insights instance integration integrations interface internal " +
  "inventory invite invoice invoices job journey key keys kit kits label labels lab labs landing launch layer layout ledger legacy library " +
  "license licenses limit limits link links list lists live local lock log logs login logout logo main management manual map maps market " +
  "marketplace master media meeting meetings member members menu message messages metric metrics migration mobile mode model models module " +
  "modules monitor monitoring monthly multi native network notice notification notifications offer onboarding online open operations order " +
  "orders org organization overview panel partners pass passes password payment payments payout payroll performance permission permissions " +
  "personal pilot pipeline plan plans platform playbook plugin plus policy policies poll portal portfolio post posts premium preview pricing " +
  "primary print privacy private pro process products profile program project projects prompt protocol prototype provider public publish " +
  "query queue quick quota quote quotes rate rating record records refund region regional release releases remote renewal report reporting " +
  "reports requests research reset review reviews reward rewards roadmap role roles rollout room rule rules sandbox save scan schedule schema " +
  "score scorecard screen script search seat seats secure segment segments self send server service services session sessions settings " +
  "setting setup share shared sheet shop sign signup single site sites smart solution space spaces spec specs sprint stack stage standard " +
  "standup starter storage store story strategy stream studio style subscription subscriptions suite survey sync system systems table tables " +
  "tag tags task tasks template templates tenant terminal tests theme themes thread threads ticket tickets tier tiers token tokens tool tools " +
  "total tour tracker trail training trial unified universal unlimited upgrade upload usage users vault vendor version video view views " +
  "wallet web webhook weekly widget wiki window wizard workflow workflows workforce workspace workspaces yearly questionnaire " +
  // Words that start a sentence or a turn.
  "agree agreed ask asked confirm confirmed emailed get got join loop make move need ping please reach remind ship sounds start stop take " +
  "talk tell thank thanks try use want yeah yes yep nope okay ok sure right well cool nice awesome perfect great sorry totally exactly " +
  "basically honestly anyway anyways alright hopefully obviously apparently unfortunately luckily ideally currently initially finally " +
  "personally separately similarly definitely absolutely probably maybe um uh hmm oh wow true fair fine good bad " +
  // Roles, organizations and the calendar.
  "analyst architect associate ceo cfo champion chief cio ciso consultant coo coordinator cpo cto designer developer director engineer " +
  "engineers evp executive founder founders intern lead leads manager managers officer owners president principal rep reps senior specialist " +
  "sponsor staff svp vp agency bank capital college company corp corporation foundation gmbh holdings inc industries institute llc ltd " +
  "networks plc school solutions technologies university ventures afternoon annual evening morning night quarter quarterly today tomorrow " +
  "tonight week weekend year yesterday holiday kickoff offsite retro planning month"
).split(" "));

/** Places, and the words of places of two words ("San Francisco", "Hong Kong", "Tel Aviv"): never a person's name. */
const PLACES = new Set((
  "america americas europe asia africa pacific atlantic emea apac latam nordics canada mexico brazil argentina chile peru colombia uk england " +
  "scotland wales ireland britain france germany spain portugal italy netherlands belgium switzerland austria sweden norway denmark finland " +
  "poland ukraine israel egypt nigeria kenya india china japan korea singapore indonesia vietnam thailand malaysia philippines australia " +
  "zealand london berlin munich madrid barcelona rome milan amsterdam dublin stockholm oslo copenhagen helsinki zurich geneva vienna prague " +
  "warsaw lisbon brussels tokyo seoul beijing shanghai shenzhen bangalore bengaluru mumbai delhi pune hyderabad chennai dubai toronto " +
  "vancouver montreal seattle boston chicago denver atlanta miami detroit philadelphia pittsburgh baltimore minneapolis nashville texas " +
  "california florida ohio oregon york jersey francisco angeles diego santa san los las vegas kong tel aviv sao buenos aires kuala lumpur " +
  "dhabi rica puerto lanka sri palo alto saudi arabia states kingdom island islands river lake valley bay beach coast county state town " +
  "street avenue road"
).split(" "));

/** Ordinary words that are also surnames ("Lee Park", "Dana Brown"): a name's last word may be one. */
const SURNAME_WORDS = new Set((
  "park brown white green black gray grey young king hill wood woods stone field fields ford cook hall bell rose page lane price long west " +
  "north south east love star frost fox wolf bird bush banks mills wells rich case cash chase grant mark marks lord knight bishop moss reed " +
  "rice rivers brooks waters ward best short little small strong sharp wise hunt hunter cross power powers gold golden silver steel early " +
  "summers winter day shaw snow bond baker carter cooper fisher mason miller parker porter taylor turner walker wright smith noble sterling"
).split(" "));

/**
 * Words before a name that only a person is (R4): "ask Dana", "thanks Sam", "told Lee", "cc Robin", "per Dana", "hi Sam".
 * "from", "with" and "by" go before a company as often ("questionnaire from Globex"), so a single word after them is a
 * name only when the sources show it as one elsewhere; a full name after them is caught as any full name is.
 */
export const PERSON_CUES = new Set("ask asks asked asking tell tells told thanks thank thx cc bcc ping pinged hi hey hello dear per".split(" "));
const OTHER_CUES = new Set("from with by via".split(" "));
/** Words that open a turn spoken to someone: "Okay Mina, can you send it?", "Sorry Sam!". */
const VOCATIVE = new Set("okay ok yeah yes sure right sorry bye morning welcome great perfect".split(" "));
/**
 * R4a: words that say the capitalized words before them name a product or a company, not a person: "the Globex Slides
 * add-on", "the Initech Docs plugin", "the Globex Slides plan". A person's name doesn't go right before them ("Dana
 * Ruiz's plan" has a possessive), so a run of capitalized words before one is never a full name, anywhere in the
 * sources. Nouns that are rarely verbs only: "Lee Park pilots it" and "Sam deals with it" are people.
 */
const PRODUCT_AFTER = new Set(("add on|add ons|addon|addons|plugin|plugins|plug in|plug ins|extension|extensions|app|apps|integration|" +
  "integrations|api|apis|sdk|connector|connectors|widget|widgets|template|templates|bot|module|modules|plan|workspace|workspaces|tier|" +
  "licenses|seats|subscription|instance|tenant|admins|users|inc|corp|llc|ltd|gmbh|plc|portal|platform|cloud|dashboard|beta|rollout|" +
  "trial|migration|renewal").split("|"));
/**
 * Words that say the one word before them is a company ("Globex team", "Initech Legal", "the Globex beta"): its
 * departments, its deal and what it uses. Nouns only, so a person's verb ("Dana wants", "Sam owns") never counts.
 */
const ORG_AFTER = new Set([...PRODUCT_AFTER, ...("team teams account deal contract pilot license console admin customers employees staff people " +
  "support legal security sales finance procurement marketing engineering product design it ops hr leadership launch org side folks").split(" ")]);
const ORG_BEFORE = new Set("at customer client partner prospect vendor competitor".split(" "));

/** Words that are never a name's: function words, cues, dates, headings, mailboxes, places. Built when first needed. */
let NEVER: Set<string> | null = null;
const never = (): Set<string> => NEVER ??= new Set([
  ...FUNCTION, ...MONTH_DAY, ...PERSON_CUES, ...OTHER_CUES, ...GENERIC, ...LABEL_WORDS, ...PLACES,
  "may", "march", "tue", "tues", "thu", "thur", "thurs", "fri", "sat", "mon", "wed",
  ...["the", "and", "for", "you", "all", "new", "one", "two", "our", "team"],
]);
/** An ordinary word on its own: on one of the lists above, whatever the sources do with it. */
const soft = (w: string): boolean => COMMON.has(w) || never().has(w);

const EMAIL_IN = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const URL_IN = /\b(?:https?:\/\/|www\.)\S+/gi;
/** An @mention written as a handle ("@dana.ruiz", "@sam"); "@Dana Ruiz" is read as a name after a cue. */
const HANDLE = /(^|[\s(,;])@([\p{Ll}\d][\p{L}\p{N}._-]*)/gu;
/** A label at a line's start: a speaker ("Lee Park:"), a heading ("Next steps:") or an email header ("From:"). */
const LINE_LABEL = /^[ \t]*([\p{L}][\p{L}'’. -]{0,38}?)[ \t]*:[ \t]/u;
const WORD = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’-]*/gu;
/**
 * A word shaped like a name: a capital and then lower case ("Dana", "José", "Smith-Jones"), with the inner capital
 * names have ("McKay", "O'Neil", "DeShawn"). Not an acronym (SSO, API), a figure (Q4), or a product's inner capital
 * (a name like "DocuSign").
 */
const NAME_SHAPE = /^(?:Mc|Mac|O['’]|D['’]|De|Di|Da|La|Le|Van|Von)?\p{Lu}[\p{Ll}\p{M}]+(?:-\p{Lu}[\p{Ll}\p{M}]+)*$/u;

/** R5c: a stage change or CRM line: an arrow between two states ("Proposal → Closed Lost", "Stage: New -> Won"). */
const STAGE_LINE = /→|⇒|⟶|\s->\s/;
/** R5a: words for a person's role, after which a name in parentheses, or before which "X, my", is that person's. */
const ROLES = new Set(("vp svp evp avp ceo cto cfo coo cmo cpo cio ciso cro cso president founder cofounder owner head director manager " +
  "lead chief officer publisher editor counsel lawyer attorney engineer architect designer developer analyst admin administrator " +
  "buyer champion sponsor contact rep ae csm consultant advisor adviser assistant coordinator specialist recruiter controller " +
  "accountant boss chair chairman chairwoman principal producer author writer agent").split(" "));
const POSSESSORS = new Set("my our your their his her".split(" "));

/**
 * R5a: whether the one word at `i` is named as someone's role: in parentheses right after a role ("Her VP (Robin)",
 * "the publisher (Inez)"), before ", my <role>" ("Robin, my VP"), or after "our <role>," ("our head of product, Inez").
 */
function roleNamed(l: Line, i: number): boolean {
  const x = l.words[i]!, p = l.words[i - 1], n = l.words[i + 1];
  if (p && ROLES.has(p.w) && /^[ \t]*\([ \t]*$/.test(x.sep) && /^[ \t]*\)/.test(l.body.slice(x.end))) return true;
  if (n && POSSESSORS.has(n.w) && /^[ \t]*,[ \t]*$/.test(n.sep) && l.words.slice(i + 2, i + 5).some((y) => ROLES.has(y.w))) return true;
  if (p && /^[ \t]*,[ \t]*$/.test(x.sep)) {
    const back = l.words.slice(Math.max(0, i - 4), i);
    const own = back.findIndex((y) => POSSESSORS.has(y.w));
    return own >= 0 && back.slice(own + 1).some((y) => ROLES.has(y.w));
  }
  return false;
}

/**
 * R5 (low): whether a participant's display name has a person's form. A one-word one ("Dana") is a person's when its
 * address is theirs (dana@, dana.ruiz@, druiz@), or, with no address, when the sources never write it as a company or
 * product (`things`: "the Kestrel team", "at Kestrel"): a shared mailbox's or a brand's name is no one's.
 */
export function personForm(display: string, email: string | undefined, things: Set<string>): boolean {
  const words = norm(display).split(" ").filter(Boolean);
  if (words.length !== 1) return true;
  const w = words[0]!;
  if (!email) return !things.has(w);
  const local = norm(email.split("@")[0]!.replace(/[._+-]+/g, " ")).split(" ").filter(Boolean);
  return local.includes(w) || local.join("").startsWith(w) || local[0]?.[0] === w[0];
}

/** How the finder came to a name (R4). */
export type NameHow = "participant" | "speaker" | "text";

/** A name the sources give, and how it was found. */
export interface FoundName {
  /** As the guard matches it: a full name ("Dana Ruiz") or one word of one ("Dana", "Ruiz"). */
  name: string;
  /** A participant's name or address, a speaker label, or the running text (a full name, a cue, a list, an @mention). */
  how: NameHow;
  /** For one word of a longer name, that name: "Dana Ruiz" for "Dana". */
  of?: string;
}

interface Word { raw: string; w: string; at: number; end: number; start: boolean; poss: boolean; shaped: boolean; sep: string; quoted: boolean }
interface Line { body: string; words: Word[]; cued: boolean }

/** A line's words, each with what came before it, and whether it starts a sentence or ends with a possessive. */
function lineWords(body: string): Word[] {
  const out: Word[] = [];
  let prev = 0;
  // R5c: what's in quotes is a UI string or someone's words ("Teach Acme your brand"), never read for a full name.
  const quotes = [...body.matchAll(/"[^"\n]{1,200}"|“[^”\n]{1,200}”|`[^`\n]{1,200}`/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  for (const m of body.matchAll(WORD)) {
    let raw = m[0]!.replace(/[-'’]+$/, "");
    const poss = /['’]s$/i.test(raw) || /s['’]$/.test(m[0]!);
    if (/['’]s$/i.test(raw)) raw = raw.slice(0, -2);
    if (!raw) continue;
    const sep = body.slice(prev, m.index!);
    out.push({ raw, w: norm(raw), at: m.index!, end: m.index! + m[0]!.length, start: !out.length || /[.!?:;]/.test(sep), poss, shaped: NAME_SHAPE.test(raw), sep, quoted: quotes.some(([a, b]) => m.index! > a && m.index! < b) });
    prev = m.index! + m[0]!.length;
  }
  return out;
}

/** Consecutive name-shaped words with only spaces between them and no possessive inside: "Dana Ruiz", "Brand Kit". */
function runsOf(words: Word[]): number[][] {
  const runs: number[][] = [];
  let cur: number[] = [];
  words.forEach((x, i) => {
    const joins = cur.length && /^[ \t]+$/.test(x.sep) && !words[i - 1]!.poss;
    if (!x.shaped) { if (cur.length) runs.push(cur); cur = []; return; }
    if (!joins && cur.length) { runs.push(cur); cur = []; }
    cur.push(i);
  });
  if (cur.length) runs.push(cur);
  return runs;
}

/**
 * Every name a batch of sources gives, for the tracker guard (F14, R4), each with how it was found:
 *
 * - **participant:** attendees' names ("Lee Park <lee@acme.example>", or an address's "lee.park" or "lee");
 * - **speaker:** the labels at a line's start ("Lee Park:", "Sam:"), not headings ("Next steps:", "Brand Kit:");
 * - **text:** a name in what was said or written: a full name ("questionnaire in from Dana Ruiz"), one word after a
 *   cue only a person gets ("ask Dana", "thanks Sam", "told Lee", "cc Robin", "per Dana", "@Dana", "@sam.ortiz"),
 *   a single name in a list with a known one ("Dana Ruiz and Sam"), and an email address's name.
 *
 * Each word of a full name is a name too, as long as it's long enough and not an ordinary word ("Dana" and "Ruiz" for
 * "Dana Ruiz"), so "Ask Dana for the questionnaire." is caught. Never a name: a company (`exclude`, and any domain an
 * address in the text has, or a word the text writes as a company: "Globex team", "at Globex"), a product, feature,
 * role or heading ("Brand Kit", "Audit Log", "Single Sign-On", "Q4 Planning", "Product Lead"), words before a product
 * word anywhere in the sources ("the Globex Slides add-on"), the longer items of a list of products ("Pagecraft, Globex
 * Slides, Mailbloom": three or more, with one-word items no source shows as people), a word that's capitalized only
 * because it starts a sentence ("Pricing came up"), a word the sources also write in lower case, a month or a day, a
 * place, or an acronym. Kept in memory for one run, never written.
 */
export function namesIn(items: { participants?: string[]; text?: string }[], exclude: Iterable<string> = [], o: { things?: Set<string> } = {}): FoundName[] {
  const skip = new Set<string>();
  const phrases: string[] = [];
  for (const x of exclude) { const n = norm(x); if (!n) continue; if (n.includes(" ")) phrases.push(n); else skip.add(n); }
  const out = new Map<string, FoundName>();
  const seen = new Set<string>();
  const put = (name: string, how: NameHow, of?: string) => {
    if (out.has(name)) return;
    out.set(name, of ? { name, how, of } : { name, how });
    seen.add(norm(name));
  };
  // Words the participants and speakers have: a name, whatever else the text does with the word.
  const known = new Set<string>();

  const add = (raw: string, how: NameHow) => {
    const words = norm(raw).split(" ").filter((w) => w.length >= 2 && !/\d/.test(w));
    if (!words.length || words.length > 4 || words.every((w) => GENERIC.has(w))) return;
    const named = words.filter((w) => !GENERIC.has(w) && !skip.has(w));
    // A mailbox or a label made only of ordinary words ("Brand Ops", "Product Lead") is no one's name.
    if (!named.length || named.every(soft)) return;
    // The original spelling, capitalized, so a sentence reads "Lee" and "Lee Park" the way a source writes them.
    const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
    const full = named.length > 1 ? named.map(cap).join(" ") : undefined;
    if (full) put(full, how);
    for (const w of named) {
      known.add(w);
      if (w.length >= 3 && !NOT_A_NAME.has(w) && !COMMON.has(w)) put(cap(w), how, full);
    }
  };

  // The text, read once: its lines and words, how often each word is in lower case or capitalized mid-sentence, and
  // which words it writes as a company.
  const lines: Line[] = [];
  const speakers: string[] = [];
  const handles: string[] = [];
  const lower = new Map<string, number>(), capital = new Map<string, number>();
  const org = new Set<string>();
  // Words the text writes right after a cue only a person gets ("thanks Sam", "@Avery"): a person, wherever else they are.
  const cuedWords = new Set<string>();
  const bump = (m: Map<string, number>, w: string) => m.set(w, (m.get(w) ?? 0) + 1);
  for (const it of items) {
    for (const rawLine of (it.text ?? "").split(/\r?\n/)) {
      let body = rawLine;
      let cued = false;
      const label = body.match(LINE_LABEL);
      if (label) {
        // A speaker label: one to three words, each capitalized as a name is ("Lee Park:", "Sam:"), not a heading.
        const words = label[1]!.trim().split(/\s+/);
        if (words.every((w) => /^\p{Lu}/u.test(w))) {
          if (words.length <= 3 && !words.every((w) => LABEL_WORDS.has(norm(w)))) speakers.push(label[1]!);
          cued = words.length === 1 && ["from", "to", "cc", "bcc"].includes(norm(words[0]!));
          body = body.slice(label[0].length);
        }
      }
      // R5c: a stage change or CRM line ("[Stage Proposal → Closed Lost]") names stages, not people.
      if (STAGE_LINE.test(body)) body = "";
      body = body.replace(EMAIL_IN, (e) => {
        handles.push(e.split("@")[0]!);
        const d = domainLabel(e.split("@")[1]!);
        if (d) skip.add(norm(d));
        return " ; ";
      }).replace(URL_IN, " ; ").replace(HANDLE, (_m, pre: string, h: string) => { handles.push(h); return `${pre} ; `; });
      const words = lineWords(body);
      words.forEach((x, i) => {
        const prev = words[i - 1];
        if (x.raw === x.raw.toLowerCase() && /\p{L}/u.test(x.raw)) {
          // "thanks dana" in a quick reply is still a name.
          if (!(prev && PERSON_CUES.has(prev.w) && /^[ \t,]+$/.test(x.sep))) bump(lower, x.w);
        } else if (x.shaped && !x.start) bump(capital, x.w);
        // "Globex team", "Initech Legal", "at Globex": one capitalized word written as a company.
        const next = words[i + 1];
        const orgNext = !!next && ORG_AFTER.has(next.w) && /^[ \t]+$/.test(next.sep);
        const alone = x.shaped && !x.poss && !(prev?.shaped && /^[ \t]+$/.test(x.sep) && !soft(prev.w)) && !(next?.shaped && /^[ \t]+$/.test(next.sep) && !orgNext);
        if (alone && (orgNext || (prev && ORG_BEFORE.has(prev.w) && /^[ \t]+$/.test(x.sep)))) org.add(x.w);
        if (x.shaped && (/@[ \t]*$/.test(x.sep) || (prev && PERSON_CUES.has(prev.w) && /^[ \t]*[,:]?[ \t]*$/.test(x.sep)))) cuedWords.add(x.w);
        // R4a: "the Globex Slides add-on": the capitalized words before a product word are a product or its company.
        if (PRODUCT_AFTER.has(x.w) && /^[ \t]+$/.test(x.sep)) {
          for (let k = i - 1, n = 0; k >= 0 && n < 3; k--, n++) {
            const y = words[k]!;
            if (!y.shaped || y.poss || soft(y.w)) break;
            org.add(y.w);
            if (!/^[ \t]+$/.test(y.sep)) break;
          }
        }
      });
      lines.push({ body, words, cued });
    }
  }

  for (const it of items) {
    for (const p of it.participants ?? []) {
      const email = p.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0];
      const display = p.replace(/<?[\w.+-]+@[\w-]+(\.[\w-]+)+>?/g, " ").replace(/["'()]/g, " ").trim();
      if (display && personForm(display, email, org)) add(display, "participant");
      if (email) add(email.split("@")[0]!.replace(/[._+-]+/g, " "), "participant");
    }
  }
  // R5c: a label that starts with a company is the company's ("Globex Hotels:" in notes), not a speaker named "Hotels".
  for (const s of speakers) if (!startsWithCompany(norm(s), skip, phrases)) add(s, "speaker");
  for (const h of handles) add(h.replace(/[._+-]+/g, " "), "text");
  // R5c: so is a capitalized run that starts with one, possessive included ("Globex Hotels' expansion"): its other
  // words are the company's, unless a participant or speaker has them.
  for (const l of lines) for (const run of runsOf(l.words)) {
    const ws = run.map((i) => l.words[i]!);
    if (ws.length < 2 || !startsWithCompany(norm(ws.map((x) => x.raw).join(" ")), skip, phrases)) continue;
    for (const x of ws.slice(1)) if (!known.has(x.w)) org.add(x.w);
  }

  // An ordinary word: one of the lists above, a company, or a word the sources write in lower case at least as often
  // as capitalized mid-sentence ("the brand kit", "our audit log"). A participant's or speaker's word never is.
  const ordinary = (w: string): boolean => {
    if (w.split(" ").some((p) => soft(p) || skip.has(p))) return true;
    if (known.has(w)) return false;
    if (org.has(w)) return true;
    const lo = lower.get(w) ?? 0;
    return lo > 0 && lo >= (capital.get(w) ?? 0);
  };
  const given = (x: Word) => x.shaped && !ordinary(x.w);
  const last = (x: Word) => x.shaped && (!ordinary(x.w) || (SURNAME_WORDS.has(x.w) && !never().has(x.w) && !skip.has(x.w)));
  const weak = (x: Word) => NOT_A_NAME.has(x.w) || ordinary(x.w);
  const single = (x: Word) => given(x) && x.w.length >= 3 && !NOT_A_NAME.has(x.w);
  const isCompany = (n: string) => phrases.some((p) => ` ${p} `.includes(` ${n} `) || ` ${n} `.includes(` ${p} `));
  const fullName = (ws: Word[]): boolean => {
    if (!given(ws[0]!) || !last(ws.at(-1)!) || ws.slice(1, -1).some((x) => !given(x) && !last(x))) return false;
    if (weak(ws[0]!) && weak(ws.at(-1)!)) return false;
    return !isCompany(norm(ws.map((x) => x.raw).join(" ")));
  };
  const putFull = (ws: Word[]) => {
    const full = ws.map((x) => x.raw).join(" ");
    put(full, "text");
    for (const x of ws) if (x.w.length >= 3 && !NOT_A_NAME.has(x.w) && !ordinary(x.w)) put(x.raw, "text", full);
  };

  // Each line's lists: capitalized runs joined by commas, "and" or "&", each without its leading ordinary words
  // ("Thanks Dana Ruiz" is "Dana Ruiz", after a cue).
  const LIST_SEP = /^(?:[ \t]*,[ \t]*(?:(?:and|&)[ \t]+)?|[ \t]+(?:and|&)[ \t]+)$/i;
  const sepOk = (s: string) => /^[ \t]*[,:]?[ \t]*$/.test(s) && s.length > 0;
  const lists = new Map<Line, { items: Word[][]; things: boolean }[]>();
  const inThings = new Set<Word>();
  for (const l of lines) {
    const runs = runsOf(l.words).filter((run) => !run.some((i) => l.words[i]!.quoted)).map((run) => {
      let from = 0;
      while (from < run.length - 1 && soft(l.words[run[from]!]!.w)) from++;
      const first = run[0]!, lead = run.slice(0, from).map((i) => l.words[i]!), before = l.words[first - 1];
      const cued = lead.some((x) => PERSON_CUES.has(x.w)) || /@[ \t]*$/.test(l.words[first]!.sep) || (first === 0 && l.cued)
        || (!!before && PERSON_CUES.has(before.w) && sepOk(l.words[first]!.sep));
      return { ws: run.slice(from).map((i) => l.words[i]!), cued };
    });
    const found: { items: Word[][]; things: boolean }[] = [];
    for (let a = 0; a < runs.length;) {
      let b = a;
      while (b + 1 < runs.length && LIST_SEP.test(l.body.slice(runs[b]!.ws.at(-1)!.end, runs[b + 1]!.ws[0]!.at))) b++;
      const items = runs.slice(a, b + 1).map((r) => r.ws);
      // R4a: a list of three or more whose one-word items the sources never show as people ("Pagecraft, Globex Slides,
      // Mailbloom") is a list of products or companies, unless a cue only a person gets opens it ("Thanks Dana Ruiz,
      // Sam and Avery"). Its longer items aren't full names there.
      const singles = items.filter((ws) => ws.length === 1).map((ws) => ws[0]!);
      const things = items.length >= 3 && singles.length >= 2 && !runs[a]!.cued && !singles.some((x) => known.has(x.w) || cuedWords.has(x.w));
      if (things) for (const ws of items) if (ws.length > 1) for (const x of ws) inThings.add(x);
      if (items.length > 1) found.push({ items, things });
      a = b + 1;
    }
    lists.set(l, found);
  }

  // A full name: two or three name-shaped words, the first not an ordinary word, the last not one or a surname that is
  // ("Park"). A run of four or more is a title ("Globex Fieldbook Rollout Plan"); its words aren't read as names.
  const taken = new Set<Word>();
  for (const l of lines) {
    for (const run of runsOf(l.words)) {
      const ws = run.map((i) => l.words[i]!);
      if (ws.some((x) => inThings.has(x) || x.quoted)) continue;
      let from = 0;
      while (from < ws.length && soft(ws[from]!.w)) from++;
      if (ws.length - from >= 4 || ws.length - from < 2) continue;
      for (let i = from; i < ws.length - 1;) {
        // A sentence's first word before a full name is the sentence's, not the name's: "Remind Dana Ruiz".
        const three = ws.slice(i, i + 3);
        const opens = ws[i]!.start && three.length === 3 && fullName(three.slice(1));
        const n = opens ? 0 : three.length === 3 && fullName(three) ? 3 : fullName(ws.slice(i, i + 2)) ? 2 : 0;
        if (!n) { i++; continue; }
        const name = ws.slice(i, i + n);
        putFull(name);
        for (const x of name) taken.add(x);
        i += n;
      }
    }
  }

  // One word after a cue only a person gets: "ask Dana", "Thanks, Sam", "thank you Lee", "@Dana", "Cc: Robin", and
  // one spoken to: "Okay Mina, can you send it?".
  for (const l of lines) {
    l.words.forEach((x, i) => {
      if (taken.has(x) || !single(x)) return;
      const p = l.words[i - 1], pp = l.words[i - 2];
      const cued = /@[ \t]*$/.test(x.sep)
        || (i === 0 && l.cued)
        || (!!p && PERSON_CUES.has(p.w) && sepOk(x.sep))
        // R5a: "w/ Sean", a note's "with" that's only ever a person's.
        || (!!p && p.w === "w" && /^\/[ \t]*$/.test(x.sep))
        // R5a: a role's name: "Her VP (Robin)", "the publisher (Inez)", "Robin, my VP", "our head of product, Inez".
        || roleNamed(l, i)
        || (!!p && !!pp && ["you", "to"].includes(p.w) && ["thank", "thanks"].includes(pp.w) && /^[ \t]+$/.test(p.sep) && sepOk(x.sep))
        || (!!p && VOCATIVE.has(p.w) && /^[ \t]*,?[ \t]+$/.test(x.sep) && /^[ \t]*[,!?]/.test(l.body.slice(x.end)));
      if (cued && !isCompany(x.w)) put(x.raw, "text");
    });
  }

  // A list with a name in it: "Dana Ruiz and Sam", "Lee, Sam and Robin", "Sam & Lee". Its other one-word items are
  // names, unless it's a list of things (above).
  for (const l of lines) {
    for (const { items, things } of lists.get(l) ?? []) {
      if (things || !items.some((ws) => seen.has(norm(ws.map((x) => x.raw).join(" "))))) continue;
      for (const ws of items) if (ws.length === 1 && single(ws[0]!) && !isCompany(ws[0]!.w)) put(ws[0]!.raw, "text");
    }
  }
  // R5: the words the sources write as a company or a product, for a caller that reads participants itself.
  for (const w of org) o.things?.add(w);
  return [...out.values()];
}

/**
 * The people a batch of sources names, for this guard (F14): every name `namesIn` finds, from the attendees, the
 * speaker labels and the running text. `exclude` holds words that are company names here (an outside domain's name,
 * "Acme" in "Acme Support"), so a shared mailbox's name never blocks the company it belongs to.
 */
export function peopleIn(items: { participants?: string[]; text?: string }[], exclude: Iterable<string> = []): string[] {
  return namesIn(items, exclude).map((n) => n.name);
}

/** Words before a name in a task's own text that say it's someone to reach: "Remind Dana", "Email Sam". */
const REACH = new Set("remind reminds reminded email emailed call called message messaged nudge brief briefed invite invited loop introduce notify contact meet".split(" "));
/** Words before "with" or "to" that do: "Confirm with Dana", "Reply to Sam", "Follow up with Lee". */
const REACH_WITH = new Set("confirm check align sync meet talk speak up reply write chat back catch".split(" "));

/**
 * R4b: the proper names a text PMX already wrote to the tracker uses as things, for `namesIn`'s `exclude`. A task's own
 * title and description name its customer ("Globex needs restricted terms…"), and they went through this guard, so a
 * single capitalized word in them is a company or a product. An evidence pack has no participants, so on a teammate's
 * Mac this is how "Globex" is known to be one. Never vouched for: a full name ("Dana Ruiz"), or a word after a cue only
 * a person gets ("Ask Dana for…", "Reply to Dana", "Confirm with Dana"), since a task written before R4 may still name
 * someone that way and the guard must keep catching them. Machine lines (`pmx:source T1`) and the quoted lines of tasks
 * from before PRIV-6 (`- [T1] …`) are left out.
 */
export function thingsIn(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*pmx:\w+\s/.test(line) || /^\s*- \[[A-Z]{1,3}\d+\]/.test(line)) continue;
    const words = lineWords(line.replace(EMAIL_IN, " ; ").replace(URL_IN, " ; "));
    for (const run of runsOf(words)) {
      let from = 0;
      while (from < run.length && soft(words[run[from]!]!.w)) from++;
      if (run.length - from !== 1) continue;
      const i = run[from]!, x = words[i]!, p = words[i - 1], pp = words[i - 2];
      const reached = /@[ \t]*$/.test(x.sep) || (!!p && (PERSON_CUES.has(p.w) || REACH.has(p.w)
        || (["with", "to"].includes(p.w) && !!pp && REACH_WITH.has(pp.w))));
      if (!reached) out.add(x.raw);
    }
  }
  return [...out];
}

/** A name's words as the finder compares them: lower case, no accents, one space between words ("jose nunez"). */
export const nameKey = norm;

/** R5c: whether words (as `norm` writes them) start with a company: one of `skip`'s words, or one of `phrases`. */
function startsWithCompany(n: string, skip: Set<string>, phrases: string[]): boolean {
  return skip.has(n.split(" ")[0]!) || phrases.some((p) => n === p || n.startsWith(`${p} `));
}

/**
 * R5: the name a participant's display name, an address's local part, a handle or a speaker label gives, read as
 * `namesIn` reads them: its words as `nameKey` writes them ("dana ruiz", "sam"), or null when it's no one's: a mailbox
 * or a role ("support", "Speaker 1", "Customer"), only ordinary words ("Brand Ops"), or a company (`exclude`). `label`:
 * a speaker label, which is a company's when it starts with one (R5c).
 */
export function personKey(raw: string, exclude: Iterable<string> = [], o: { label?: boolean } = {}): string | null {
  const all = [...exclude].map(norm).filter(Boolean);
  const skip = new Set(all.filter((x) => !x.includes(" ")));
  // R5c: a speaker label that starts with a company ("Globex Hotels:") is the company's.
  if (o.label && startsWithCompany(norm(raw), skip, all.filter((x) => x.includes(" ")))) return null;
  const words = norm(raw).split(" ").filter((w) => w.length >= 2 && !/\d/.test(w));
  if (!words.length || words.length > 4 || words.every((w) => GENERIC.has(w))) return null;
  const named = words.filter((w) => !GENERIC.has(w) && !skip.has(w));
  if (!named.length || named.every((w) => COMMON.has(w) || never().has(w))) return null;
  return named.join(" ");
}

/**
 * R5: the label a line starts with when it's a speaker's, as `namesIn` reads speakers: one to three capitalized words
 * and a colon ("Lee Park:", "Sam:"), never a heading ("Next steps:") or an email's header ("From:"), with where it is
 * in the line. Whether it's a person is `personKey`'s call.
 */
export function speakerLabel(line: string): { label: string; start: number; end: number } | null {
  const m = line.match(LINE_LABEL);
  if (!m) return null;
  const words = m[1]!.trim().split(/\s+/);
  if (!words.every((w) => /^\p{Lu}/u.test(w)) || words.length > 3 || words.every((w) => LABEL_WORDS.has(norm(w)))) return null;
  const start = m[0].indexOf(m[1]!);
  return { label: m[1]!, start, end: start + m[1]!.length };
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
  // F5: an investor's or another confidential contact's name, as fundraising is: "Send Initech Ventures the cost model".
  const confidential = confidentialMatcher((r.confidential ?? []).map((c) => (c.includes(".") ? domainLabel(c) : c)));
  const problem = (s: string): TextProblem | null => {
    if (TRANSCRIPT_MARKS.test(s)) return "transcript";
    if (QUOTE.test(s)) return "quote";
    if (PLACEHOLDER.test(s)) return "placeholder";
    if (isFundraising(s)) return "fundraising";
    if (confidential?.test(s)) return "confidential";
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
