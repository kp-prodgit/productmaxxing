import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../core/paths.js";
import type { Evidence } from "./evidence.js";

/**
 * The web guard (RUN-6): a PreToolUse hook in a web run's settings, on WebSearch and WebFetch, so the rule that nothing
 * from the team's evidence goes into a search is kept by PMX's code and not only by the prompt. Before a web run, PMX
 * writes what the hook checks into the run's worktree (`.pmx/tmp/web-guard.json`), as salted hashes only, so the agent,
 * which can read that folder, learns no name it wasn't shown. Its digest goes outside the worktree, where the run can't
 * write (`~/.pmx/claude/web-guard/`): a guard file the agent changed or removed blocks every web call (fail closed).
 * Each blocked call is counted there by rule ID only, never with its words, for the run record.
 *
 * A call is blocked when its search query, or its URL (host, path and decoded query string), carries:
 * - `quote`: any 5 words in a row from the task's source passages;
 * - `person`: a person's name or email from the sources: participants, speakers, the CRM list, the do-not-read list;
 * - `company`: a customer or partner company of the sources (an outside participant's email domain, a company the
 *   description's sources line names, a company on the CRM list, or one the passages name with a strong signal:
 *   `passageCompanies`), unless the task names it as a competitor: in its title, or elsewhere in its description when
 *   it isn't one of those companies. R18: not every capitalized word in the passages, which made "price", "brand",
 *   "teams" and "enterprise" customers and blocked ordinary searches about competitors' plans. A company is its whole
 *   name, and each of its words that isn't a common word (`COMMON`): "Umbrella Health" blocks "umbrella health" and
 *   "umbrella", never "health" alone.
 */
export const GUARD_FILE = ".pmx/tmp/web-guard.json";
export type GuardRule = "quote" | "person" | "company" | "guard";

export interface WebGuard {
  v: 1;
  salt: string;
  quotes: string[];
  people: string[];
  emails: string[];
  companies: string[];
}

/** The task description's line naming its sources in words (src/synth/synthesize.ts, SOURCES_LINE). */
const SOURCES_LINE = /^\*\*(?:Sources:|Based on)\*\*.*$/m;
const QUOTE_WORDS = 5;
const NAME_WORDS = 4;
const words = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];
const h = (salt: string, s: string) => createHash("sha256").update(`${salt}\n${s}`).digest("hex").slice(0, 20);
const grams = (ws: string[], n: number) => Array.from({ length: Math.max(0, ws.length - n + 1) }, (_, i) => ws.slice(i, i + n).join(" "));
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

/** Capitalized words that are only the shape of a sentence, a date or a company's legal form, not a name. */
const NOT_NAMES = new Set(("i a an the and or but so if we you they he she it this that these those our your their my me us them " +
  "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
  "jan feb mar apr jun jul aug sep sept oct nov dec " +
  "inc corp corporation ltd llc co company group gmbh plc ok okay yes no hi hello thanks thank").split(" "));

/**
 * Proper names in text: capitalized words that don't start a sentence or a line (`all`: wherever they are, for a title),
 * aren't short acronyms (SCIM, CSV), and aren't dates or a company's legal form. Each as a lower-case word.
 */
export function properNames(text: string, o: { all?: boolean } = {}): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    // A speaker's label at the start of a passage's line is a person, counted on its own; a title has none.
    const body = o.all ? line : line.replace(/^\s*(?:[>*-]\s*)*(?:[\p{L}][\p{L} .'-]{0,40}:\s+)?/u, "");
    const tokens = [...body.matchAll(/[\p{L}\p{N}][\p{L}\p{N}&'.-]*|[.!?]/gu)].map((m) => m[0]);
    let start = true;
    for (const t of tokens) {
      if (/^[.!?]$/.test(t)) { start = true; continue; }
      const w = t.replace(/[.'-]+$/, "");
      const name = /^\p{Lu}/u.test(w) && !(/^[\p{Lu}\d]{2,5}s?$/u.test(w));
      if (name && (!start || o.all) && !NOT_NAMES.has(w.toLowerCase())) out.add(w.toLowerCase());
      start = false;
    }
  }
  return [...out];
}

/** Speaker labels at the start of a passage's lines ("Jane:", "Max Lee:"). */
export function speakers(passages: string[]): string[] {
  const out = new Set<string>();
  for (const p of passages) for (const line of p.split("\n")) {
    const m = line.match(/^\s*([\p{Lu}][\p{L}'-]+(?: [\p{Lu}][\p{L}'-]+){0,3}):\s/u);
    if (m && !NOT_NAMES.has(m[1]!.toLowerCase())) out.add(m[1]!);
  }
  return [...out];
}

const label = (domain: string) => domain.toLowerCase().split(".").filter((x) => x && !["www", "mail", "app", "com", "org", "net", "io", "co", "example"].includes(x))[0] ?? null;

/**
 * R18: words that are never a customer by themselves, because a search about a competitor's plans and prices carries
 * them ("Globex Teams plan price", "brand kit features"). In a company's whole name they still count ("Acme Studio").
 */
export const COMMON = new Set(("price prices pricing cost costs brand brands kit kits team teams enterprise enterprises studio studios pro plus " +
  "premium basic free starter standard business plan plans tier tiers feature features edition editions suite cloud app apps platform " +
  "design designs tool tools ai online software solutions services systems digital global international labs group partners media " +
  "data tech technologies health industries holdings ventures review reviews comparison alternative alternatives").split(" "));
/** A company's legal form at the end of its name, which a search rarely carries: "Acme Corp" is Acme. */
const LEGAL = new Set("inc corp corporation ltd limited llc llp co company gmbh ag sa bv nv plc pty".split(" "));

/** A company's name as the guard holds it: its words, without a legal form at the end. */
function companyWords(name: string): string[] {
  const ws = words(name);
  while (ws.length > 1 && LEGAL.has(ws.at(-1)!)) ws.pop();
  return ws;
}

/**
 * The companies the description's sources line names (PRIV-6, F14): "a customer call with Acme (Nov 20); 2 partner
 * calls with Umbrella Health (Nov 3–5)" names Acme and Umbrella Health. Threads and internal meetings name none.
 */
export function sourceLineCompanies(description: string): string[] {
  const line = (description.match(SOURCES_LINE)?.[0] ?? "").replace(/^\*\*(?:Sources:|Based on)\*\*\s*/, "").replace(/\.\s*They stay on the PM's Mac.*$/, "");
  return line.split(";").flatMap((part) => {
    const m = part.match(/\bcalls? with (.+?)\s*(?:\(|$)/);
    return m ? [m[1]!.replace(/[.\s]+$/, "")] : [];
  }).filter(Boolean);
}

/**
 * The CRM list's companies, if it has any (SEC-8 keeps people on it): a line with a company's legal form at the end
 * ("Acme Corp", "Initrode GmbH"), an `&` ("Vandelay & Sons"), or a domain ("acme.example").
 */
export function crmCompanies(lines: string[]): string[] {
  return lines.map((l) => l.trim()).filter((l) => l && !l.includes("@")).flatMap((l) => {
    if (/^[\w-]+(?:\.[\w-]+)+$/.test(l)) return label(l) ? [label(l)!] : [];
    const ws = words(l);
    return ws.length > 1 && (LEGAL.has(ws.at(-1)!) || l.includes("&")) ? [l] : [];
  });
}

/**
 * A company found in the passages: its words, and how much of it the guard holds. `all`: its whole name and each of its
 * own words, as for a company the sources line names. `name`: its whole name only (one word or a run of them).
 */
export interface PassageCompany { words: string[]; hold: "all" | "name" }

/** Words before a customer: "the customer Initrode", "our client Hooli Hotels", "the prospect Vandelay". */
const CUSTOMER_BEFORE = new Set("customer customers client clients prospect prospects partner partners".split(" "));
/** Words that go before a company as often as before anything else: "a pilot with Initrode", "the call at Hooli". */
const PLACE_BEFORE = new Set("at with for from".split(" "));
/** Words after one: "the Hooli deal", "Initrode's renewal", "the Vandelay pilot". */
const CUE_AFTER = new Set("deal deals account accounts pilot pilots contract contracts renewal renewals opportunity opp rfp rfi procurement expansion".split(" "));
/** Labels a CRM record puts before its company: "Account: Hooli Hotels", "Opportunity: Initrode — Renewal". */
const RECORD_LABEL = /^\s*(?:[-*•>]\s*)*(?:account|opportunity|opp|customer|client|company|prospect|partner|organi[sz]ation|org|deal)(?:\s+name)?\s*:\s*/i;
/** Words after a run that make it a product or a feature, not a company: "Magic Resize feature", "Brand Kit plan". */
const PRODUCT_AFTER = new Set("feature features plan plans tier tiers add on addon plugin plugins template templates tool tools button mode editor app apps integration integrations api sso login connector connectors extension sync export import bot workspace".split(" "));
/**
 * Words that are never a company's own: a sentence's or a heading's opener ("Yesterday Hooli Hotels asked…", "Next
 * steps — …"), a role ("the Customer's request"), and the words products and features are named with ("Single Sign-On",
 * "Audit Log"). The guard's other lists (`COMMON`, `LEGAL`) count too.
 */
const NOT_COMPANY = new Set(("every each all some any many most few several both other another such no not only just very " +
  "yesterday today tomorrow also however meanwhile then now last next earlier later update updates note notes fyi re " +
  "summary recap agenda action actions item items step steps stage owner owners status everyone everybody nobody someone somebody let " +
  "customer customers client clients user users buyer buyers admin admins partner vendor vendors competitor competitors product products " +
  "people folks account accounts deal deals opportunity renewal pilot contract quote quotes " +
  "single sign signin signon login logout audit log logs export import sync share sharing search approval approvals workflow workflows " +
  "template templates dashboard report reports permission permissions role roles access security settings").split(" "));
const NAME_SHAPE = /^\p{Lu}[\p{Ll}\p{M}]+(?:-\p{Lu}?[\p{Ll}\p{M}]+)*$/u;

interface Tok { raw: string; w: string; cap: boolean; poss: boolean; start: boolean; sep: string; end: number }

function tokens(line: string): Tok[] {
  const out: Tok[] = [];
  let prev = 0;
  for (const m of line.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
    let raw = m[0]!.replace(/[-'’]+$/, "");
    const poss = /['’]s$/i.test(raw) || /s['’]$/.test(m[0]!);
    if (/['’]s$/i.test(raw)) raw = raw.slice(0, -2);
    if (!raw) continue;
    const sep = line.slice(prev, m.index!);
    prev = m.index! + m[0]!.length;
    out.push({ raw, w: words(raw).join(" "), cap: NAME_SHAPE.test(raw), poss, start: !out.length || /[.!?:;—–]/.test(sep), sep, end: prev });
  }
  return out;
}

const SPACE = /^[ \t]+$/;

/**
 * R18: the customers and partners internal sources name, where no email domain, sources line or CRM list does: a
 * competitive analysis is often fed by the team's own threads and a CRM record, every participant inside the company.
 * Strong signals only, so ordinary words stay searchable:
 * - a possessive ("Initrode's"), a customer word before ("our client Hooli Hotels") or a deal word after ("the Hooli
 *   deal", "the Vandelay pilot"), a CRM record's label or title ("Account: Hooli Hotels", "Hooli Hotels — Teams
 *   Expansion"), or an ampersand ("Vandelay & Kramer"): the whole name and each of its own words;
 * - "at", "with", "for" or "from" before ("a pilot with Initrode"): the whole name, unless the passages show it's a tool
 *   ("Initrode integration");
 * - a run of two or more capitalized words ("Hooli Hotels"): the whole name only, unless it's a product (a word like
 *   "feature" or "plan" after it) or the passages also write it in lower case.
 * Never a competitor the title names, its products and plans ("Globex Teams", "Globex's Magic Resize"), or a run of
 * ordinary words ("Brand Kit", "Enterprise Price"). A single capitalized word with none of these is no customer. A
 * person's name may come out as a company here; the guard blocks it either way.
 */
export function passageCompanies(passages: string[], competitor: (w: string) => boolean = () => false): PassageCompany[] {
  const out = new Map<string, PassageCompany>();
  const lines = passages.flatMap((p) => p.split("\n"));
  // What the passages write in lower case ("we love magic resize"), and the capitalized words they put before a tool
  // word ("Initrode integration"), across every line.
  const lower = new Set<string>(), tools = new Set<string>();
  for (const l of lines) {
    const ts = tokens(l);
    let seg: string[] = [];
    const flush = () => { for (let n = 1; n <= NAME_WORDS; n++) for (const g of grams(seg, n)) lower.add(g); seg = []; };
    ts.forEach((t, i) => {
      if (t.raw === t.raw.toLowerCase()) seg.push(...t.w.split(" ")); else flush();
      const next = ts[i + 1];
      if (t.cap && next && SPACE.test(next.sep) && PRODUCT_AFTER.has(next.w)) tools.add(t.w);
    });
    flush();
  }
  const soft = (w: string) => w.length < 3 || COMMON.has(w) || NOT_NAMES.has(w) || LEGAL.has(w) || NOT_COMPANY.has(w);
  const add = (ws: string[], hold: PassageCompany["hold"], shapeOnly = false) => {
    while (ws.length && soft(ws[0]!)) ws = ws.slice(1);
    // Not a legal form, a date or an opener at its end ("Initrode GmbH", "Hooli Monday"); a common word stays ("Acme Studio").
    while (ws.length > 1 && (LEGAL.has(ws.at(-1)!) || NOT_NAMES.has(ws.at(-1)!) || NOT_COMPANY.has(ws.at(-1)!))) ws = ws.slice(0, -1);
    if (!ws.length || ws.length > NAME_WORDS || ws.every(soft) || ws.some(competitor) || (hold === "name" && ws.length === 1 && shapeOnly)) return;
    const key = ws.join(" ");
    if (out.get(key)?.hold !== "all") out.set(key, { words: ws, hold });
  };
  for (const raw of lines) {
    // A CRM record's company comes after its label ("Account: Hooli Hotels"); a speaker's label is a person, counted
    // elsewhere ("Dana:", "Max Lee:").
    const labelled = RECORD_LABEL.test(raw);
    const line = labelled ? raw.replace(RECORD_LABEL, "") : raw.replace(/^\s*(?:[>*-]\s*)*(?:[\p{L}][\p{L} .'-]{0,40}:\s+)/u, "");
    const ts = tokens(line);
    for (let i = 0; i < ts.length; i++) {
      if (!ts[i]!.cap) continue;
      // A run of capitalized words, joined by spaces or by "&" ("Vandelay & Kramer"); a possessive ends it.
      let j = i, amp = false;
      while (j + 1 < ts.length && ts[j + 1]!.cap && !ts[j]!.poss && (SPACE.test(ts[j + 1]!.sep) || (/^[ \t]*&[ \t]*$/.test(ts[j + 1]!.sep) && (amp = true)))) j++;
      const run = ts.slice(i, j + 1), before = ts[i - 1], before2 = ts[i - 2], after = ts[j + 1], last = run.at(-1)!;
      const from = i;
      i = j;
      // A competitor's product or plan: "Globex's Magic Resize", "Globex Teams".
      if (before && competitor(before.w) && /^[ \t]*$/.test(run[0]!.sep)) continue;
      const ws = run.flatMap((t) => t.w.split(" "));
      const joined = SPACE.test(run[0]!.sep);
      const cue = (set: Set<string>) => !!before && joined && (set.has(before.w) || (["the", "our", "a", "an"].includes(before.w) && !!before2 && set.has(before2.w) && SPACE.test(before.sep)));
      const dealAfter = !!after && SPACE.test(after.sep) && CUE_AFTER.has(after.w);
      const recordTitle = from === 0 && (labelled || /^[ \t]+[—–-][ \t]+\S/.test(line.slice(last.end)));
      if (last.poss || cue(CUSTOMER_BEFORE) || dealAfter || recordTitle || amp) { add(ws, "all"); continue; }
      const product = !!after && SPACE.test(after.sep) && PRODUCT_AFTER.has(after.w);
      if (product || lower.has(ws.join(" "))) continue;
      if (cue(PLACE_BEFORE)) { if (!(ws.length === 1 && tools.has(ws[0]!))) add(ws, "name"); continue; }
      // Only its shape: a whole name of two words or more. A sentence's first word may be the sentence's own.
      if (ws.length >= 2) { add(ws, "name", true); if (run[0]!.start && ws.length > 2) add(ws.slice(1), "name", true); }
    }
  }
  return [...out.values()];
}

/**
 * What the guard checks for one web run, from the task and the evidence the agent was shown. `people`: names and emails
 * to keep out (participants, the CRM list, the do-not-read list). `crm`: the CRM list's lines, for the companies it has.
 * `internalDomains`: the company's own, never a customer.
 */
export function buildGuard(o: {
  task: { title: string; description: string };
  evidence: Pick<Evidence, "sources"> & { people?: string[] };
  people: string[];
  crm?: string[];
  internalDomains: string[];
}): WebGuard {
  const salt = randomBytes(12).toString("hex");
  const passages = o.evidence.sources.flatMap((s) => s.passages);
  const quotes = new Set<string>();
  for (const p of passages) for (const g of grams(words(p), QUOTE_WORDS)) quotes.add(h(salt, g));
  const everyone = [...o.people, ...(o.evidence.people ?? []), ...speakers(passages)];
  const emails = new Set<string>(), people = new Set<string>();
  for (const x of everyone) {
    for (const e of x.match(EMAIL) ?? []) {
      emails.add(h(salt, e.toLowerCase()));
      // "jane.doe@acme.example" names Jane Doe.
      const local = words(e.split("@")[0]!.replace(/[._-]+/g, " "));
      if (local.length >= 2 && local.length <= NAME_WORDS) people.add(h(salt, local.join(" ")));
    }
    const name = words(x.replace(EMAIL, " "));
    if (name.length && name.length <= NAME_WORDS && name.join(" ").length >= 3) people.add(h(salt, name.join(" ")));
  }
  // Customers and partners (R18): outside participants' companies (their email domains), the companies the
  // description's sources line names (PRIV-6, F14), the CRM list's, and those the passages name with a strong signal
  // (`passageCompanies`). Never every capitalized word in the passages.
  const internal = new Set(o.internalDomains.map((d) => d.toLowerCase()));
  const domains = new Set<string>();
  for (const x of everyone) for (const e of x.match(EMAIL) ?? []) {
    const d = e.split("@")[1]!.toLowerCase();
    if (![...internal].some((i) => d === i || d.endsWith(`.${i}`))) domains.add(d);
  }
  // The task's competitors: names in its title, and in the rest of its description unless they're one of those
  // companies. A competitor stays searchable with its products and plans ("Globex Teams", "Globex Pro").
  const inTitle = new Set(properNames(o.task.title, { all: true }));
  const inDescription = new Set(properNames(o.task.description.replace(/^pmx:\w+ .*$/gm, "").replace(SOURCES_LINE, "")));
  const named = [...sourceLineCompanies(o.task.description), ...crmCompanies(o.crm ?? [])].map(companyWords);
  // Only the title makes a company the passages name a competitor: a description may name the customer it's for.
  const inPassages = passageCompanies(passages, (w) => inTitle.has(w));
  const own = new Set([...[...domains].map(label).filter((l): l is string => !!l), ...named.flat(), ...inPassages.flatMap((c) => c.words)]);
  const competitor = (w: string) => inTitle.has(w) || (inDescription.has(w) && !own.has(w));
  const companies = new Set<string>();
  for (const d of domains) {
    const l = label(d);
    if (!l || l.length < 3 || competitor(l)) continue;
    const host = words(d.replace(/^(?:www|mail|app)\./, ""));
    if (host.length > 1 && host.length <= NAME_WORDS) companies.add(h(salt, host.join(" ")));
    if (!COMMON.has(l)) companies.add(h(salt, l));
  }
  // A named company: its whole name, and each of its words that isn't common, unless the task names it as a competitor.
  for (const c of inPassages) if (c.hold === "name") companies.add(h(salt, c.words.join(" ")));
  for (const ws of [...named, ...inPassages.filter((c) => c.hold === "all").map((c) => c.words)]) {
    const distinct = ws.filter((w) => w.length >= 3 && !COMMON.has(w) && !NOT_NAMES.has(w) && !LEGAL.has(w));
    if (!ws.length || (distinct.length && distinct.every(competitor))) continue;
    if (ws.length > 1 && ws.length <= NAME_WORDS) companies.add(h(salt, ws.join(" ")));
    for (const w of distinct) if (!competitor(w)) companies.add(h(salt, w));
  }
  return { v: 1, salt, quotes: [...quotes], people: [...people], emails: [...emails], companies: [...companies] };
}

/** The text a web call carries: a search's query (and domains), a fetch's whole URL, decoded. */
function callText(tool: string, input: any): string[] {
  const out: string[] = [];
  if (tool === "WebSearch") {
    out.push(String(input?.query ?? ""));
    for (const d of [...(input?.allowed_domains ?? []), ...(input?.blocked_domains ?? [])]) out.push(String(d).replace(/\./g, " "));
  } else {
    const raw = String(input?.url ?? "");
    let u: URL | null = null;
    try { u = new URL(raw); } catch {}
    const dec = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    if (u) {
      out.push(u.hostname.replace(/\./g, " "), dec(u.pathname).replace(/[/_.-]+/g, " "), dec(u.search.slice(1)).replace(/[&=_]+/g, " "), dec(u.hash.slice(1)), dec(`${u.username} ${u.password}`));
      for (const [, v] of u.searchParams) out.push(v);
    } else out.push(dec(raw));
  }
  return out.filter(Boolean);
}

/** Checks one web call against the guard. Returns the rules it breaks, or none. */
export function checkWebCall(tool: string, input: unknown, g: WebGuard): GuardRule[] {
  const rules = new Set<GuardRule>();
  const quotes = new Set(g.quotes), people = new Set(g.people), emails = new Set(g.emails), companies = new Set(g.companies);
  for (const text of callText(tool, input)) {
    for (const e of text.match(EMAIL) ?? []) if (emails.has(h(g.salt, e.toLowerCase()))) rules.add("person");
    const ws = words(text.replace(EMAIL, " "));
    if (grams(ws, QUOTE_WORDS).some((x) => quotes.has(h(g.salt, x)))) rules.add("quote");
    for (let n = 1; n <= NAME_WORDS; n++) for (const x of grams(ws, n)) {
      if (people.has(h(g.salt, x))) rules.add("person");
      // A company is held as its whole name and its own words (R18), so any run of up to four words may be one.
      if (companies.has(h(g.salt, x))) rules.add("company");
    }
  }
  return ORDER.filter((r) => rules.has(r));
}

const ORDER: GuardRule[] = ["quote", "person", "company", "guard"];

const REASONS: Record<GuardRule, string> = {
  quote: "it repeats words from the task's sources",
  person: "it names a person from the task's sources",
  company: "it names a customer or partner from the task's sources",
  guard: "PMX's web guard for this run is missing or was changed",
};

/** Where the guard's digest and blocked count live, outside the worktree, for one run's folder. */
async function store(dir: string) {
  const key = createHash("sha256").update(await realpath(dir).catch(() => dir)).digest("hex").slice(0, 16);
  const root = join(paths.claudeProfile(), "web-guard");
  return { root, digest: join(root, `${key}.sha256`), blocked: join(root, `${key}.blocked`) };
}

/** Writes a run's guard before the agent starts (RUN-6). */
export async function writeGuard(dir: string, g: WebGuard): Promise<void> {
  const text = JSON.stringify(g) + "\n";
  await mkdir(join(dir, ".pmx", "tmp"), { recursive: true });
  await writeFile(join(dir, GUARD_FILE), text);
  const s = await store(dir);
  await mkdir(s.root, { recursive: true, mode: 0o700 });
  await writeFile(s.digest, createHash("sha256").update(text).digest("hex"), { mode: 0o600 });
  await rm(s.blocked, { force: true });
}

/** How many web calls the guard blocked in a run, and which rules, read after it. */
export async function guardBlocked(dir: string): Promise<{ count: number; rules: GuardRule[] }> {
  const lines = (await readFile((await store(dir)).blocked, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const rules = new Set<GuardRule>();
  for (const l of lines) for (const r of (() => { try { return JSON.parse(l).rules as GuardRule[]; } catch { return [] as GuardRule[]; } })()) rules.add(r);
  return { count: lines.length, rules: [...rules] };
}

/** Removes a run's guard once it's over. */
export async function clearGuard(dir: string): Promise<void> {
  const s = await store(dir);
  await Promise.all([rm(join(dir, GUARD_FILE), { force: true }), rm(s.digest, { force: true }), rm(s.blocked, { force: true })]);
}

/**
 * `pmx hook web-guard`: Claude Code's PreToolUse hook for WebSearch and WebFetch in a web run. Reads the tool call's
 * JSON on stdin. Allows with exit 0 and nothing printed. Blocks with exit 2 and the reason on stderr, which Claude Code
 * shows the agent, plus the same decision as JSON on stdout (`decision: "block"`, and `permissionDecision: "deny"`)
 * for the forms that read it. Anything it can't read or check blocks (fail closed).
 */
export async function webGuardHook(stdin: string, env: NodeJS.ProcessEnv = process.env): Promise<{ code: 0 | 2; stdout: string; stderr: string }> {
  let input: any = null;
  try { input = JSON.parse(stdin); } catch {}
  const tool = String(input?.tool_name ?? "");
  const dir = env.PMX_WEB_GUARD_DIR || String(input?.cwd ?? "");
  let rules: GuardRule[] = ["guard"];
  let s: Awaited<ReturnType<typeof store>> | null = null;
  if (dir && (tool === "WebSearch" || tool === "WebFetch")) {
    s = await store(dir);
    const text = await readFile(join(dir, GUARD_FILE), "utf8").catch(() => null);
    const want = await readFile(s.digest, "utf8").catch(() => null);
    if (text !== null && want !== null && createHash("sha256").update(text).digest("hex") === want.trim()) {
      try { rules = checkWebCall(tool, input.tool_input, JSON.parse(text) as WebGuard); } catch { rules = ["guard"]; }
    }
  }
  if (!rules.length) return { code: 0, stdout: "", stderr: "" };
  if (s) await appendFile(s.blocked, JSON.stringify({ at: new Date().toISOString(), tool, rules }) + "\n", { mode: 0o600 }).catch(() => {});
  const reason = `PMX blocked this ${tool === "WebFetch" ? "page" : "search"}: ${rules.map((r) => REASONS[r]).join(", and ")}. Search for and fetch only competitors, their products and prices, and public topics, in your own words; never anything from the task's evidence, its customers or people.`;
  return {
    code: 2,
    stdout: JSON.stringify({ decision: "block", reason, hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }) + "\n",
    stderr: reason + "\n",
  };
}
