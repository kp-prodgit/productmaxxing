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
 * - `company`: a customer or partner company named in the sources (an outside participant's email domain, a name in the
 *   passages, or a company the description's sources line names), unless the task names it as a competitor: in its
 *   title, or elsewhere in its description when it isn't one of those sources' own companies.
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
 * What the guard checks for one web run, from the task and the evidence the agent was shown. `people`: names and emails
 * to keep out (participants, the CRM list, the do-not-read list). `internalDomains`: the company's own, never a customer.
 */
export function buildGuard(o: {
  task: { title: string; description: string };
  evidence: Pick<Evidence, "sources"> & { people?: string[] };
  people: string[];
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
  // Customers and partners: outside participants' companies, and the names the passages mention.
  const internal = new Set(o.internalDomains.map((d) => d.toLowerCase()));
  const outside = new Set<string>();
  for (const x of everyone) for (const e of x.match(EMAIL) ?? []) {
    const d = e.split("@")[1]!.toLowerCase();
    if ([...internal].some((i) => d === i || d.endsWith(`.${i}`))) continue;
    const l = label(d);
    if (l && l.length >= 3) outside.add(l);
  }
  // The description's sources line (PRIV-6, F14) names the sources' companies: "a customer call with Acme (Nov 20)".
  const line = o.task.description.match(SOURCES_LINE)?.[0] ?? "";
  const named = new Set(properNames(line.replace(/^\*\*(?:Sources:|Based on)\*\*\s*/, "").replace(/\.\s*They stay on the PM's Mac.*$/, ""), { all: true }));
  const fromText = new Set([...properNames(passages.join("\n")), ...named]);
  // The task's competitors: names in its title, and in the rest of its description unless they're a source's company.
  const inTitle = new Set(properNames(o.task.title, { all: true }));
  const inDescription = new Set(properNames(o.task.description.replace(/^pmx:\w+ .*$/gm, "").replace(SOURCES_LINE, "")));
  const competitor = (c: string) => inTitle.has(c) || (inDescription.has(c) && !outside.has(c) && !named.has(c));
  const companies = new Set<string>();
  for (const c of [...outside, ...fromText]) if (!competitor(c)) companies.add(h(salt, c));
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
      if (n === 1 && companies.has(h(g.salt, x))) rules.add("company");
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
