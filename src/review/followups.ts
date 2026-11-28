import { join } from "node:path";
import { followUpsOn } from "../core/config.js";
import { confidentialDomains } from "../core/filter.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { readReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import { skillInventory } from "../core/skills.js";
import { STAGES, type Task } from "../core/types.js";
import { sourceCompanies, sourcePeople, sourceThings } from "../run/comment.js";
import { quoteGuard, trackerGuard } from "../core/tracker-text.js";
import { meetingSeries } from "../inputs/inputs.js";
import { receiptOf, runEvidence, sourcesHere, type Evidence } from "../run/evidence.js";
import { knownThings } from "../run/known-people.js";
import { evidenceStore } from "../run/packs.js";
import { keptQuotes } from "../run/share.js";
import { privateNames } from "../run/run.js";
import { CHECKED, stageProposals, readProposals, type Proposal } from "../synth/proposals.js";
import { STRATEGY_SOURCE, SOURCES_LINE, strategyFiles } from "../synth/synthesize.js";
import { keepTodo, loadTodos } from "../todo/todo.js";
import { cut, deadlineIn, norm, readFollowUps, statements, type DraftQuestion } from "./draft-reader.js";
import { legacyKeys } from "./legacy/follow-up-keys.js";
import type { ReviewItem } from "./queue.js";

export { deadlineIn, readFollowUps, type DraftDecision, type DraftQuestion } from "./draft-reader.js";

/**
 * FOLLOW-1: what an accepted draft leaves for later. Drafts end with the calls they leave to the PM ("PM decides") and
 * the questions they couldn't answer (open or blocking). Accepting the draft used to end the chain there. Now each call
 * becomes a private to-do for the PM who accepted; each question one person can answer (R2: "— ask: <role>", or its
 * words) becomes a private to-do too, "Ask <role>: <question>"; and each question that needs research or a document
 * becomes a suggested task, staged exactly like synthesis's, so it waits in Needs you until the PM approves it
 * (APPROVE-1). Nothing reaches the tracker here. A team turns it off with `followUps: false` in pmx.config.json.
 */

/**
 * At most this many suggested tasks from one accepted draft, blocking questions first and then in the draft's order, so
 * one draft doesn't flood Needs you. The rest stay in the draft, and the accept's answer and the task's details say so.
 */
export const FOLLOW_TASKS = 3;
/** At most this many "PM decides" to-dos from one accepted draft, in the draft's order. */
export const FOLLOW_TODOS = 5;
/**
 * At most this many "Ask <role>: …" to-dos from one accepted draft (R2), blocking questions first, as for tasks. Their own
 * cap, not a share of FOLLOW_TODOS: the PM's calls and the questions to put to someone are different work, and sharing
 * would let five calls crowd out the blocking question that settles them, or the questions crowd out the calls. Three,
 * like FOLLOW_TASKS, so a draft's questions are held to the same number whichever way they go.
 */
export const FOLLOW_ASKS = 3;

/**
 * The kind of work that answers a follow-up question (FOLLOW-1, R2). In order: a kind of work the draft names in the
 * item ("a validation plan"); the kind its "— needs: …" mark names; the question's own words (comparing competitors or
 * alternatives: a competitive analysis; whether customers will pay, commit or sign, or validating: a validation plan; how
 * to build it: a spec, or a build brief for a prototype; what users do or need, or how many: research); the next stage
 * after the task's own kind (a problem brief's questions go to research, then a spec; a competitive analysis's to
 * research, then validation); a kind of work in the next lifecycle stage, then the same one; and last the task's own
 * kind. Only kinds the team has count. Null when the team has none.
 */
export const NEXT_KIND: Record<string, string[]> = {
  "problem-brief": ["research-synthesis", "spec"],
  "research-synthesis": ["problem-brief", "validation-plan"],
  "competitive-analysis": ["research-synthesis", "validation-plan"],
  "build-brief": ["validation-plan", "validation-readout"],
  "validation-plan": ["validation-readout", "spec"],
  "validation-readout": ["validation-plan", "spec"],
  spec: ["research-synthesis", "validation-plan"],
  "tracking-hygiene": ["tracking-hygiene"],
};
/** Words about a commitment or a payment, the evidence a validation plan goes after. "pilot-wide" isn't one. */
const COMMITMENT = /\b(?:commit(?:s|ted|ment|ments)?|pilots?|paid|pay(?:s|ing)?|purchases?|procurement|budget|conver(?:t|ts|ting|sion|sions)|validat(?:e|es|ed|ing|ion))\b(?!-)|\b(?:would|will)\s+(?:[\w-]+\s+){0,3}?(?:buy|sign)\b/i;
/** Comparing us with competitors or the alternatives. */
const COMPARE = /\b(?:compar(?:e|es|ed|ing|ison|isons)|competitors?|competitive|competition|rivals?|alternatives?|versus|vs)\b/i;
/** How to build it: a spec, or for a prototype a build brief. */
const BUILD = /\bhow\s+(?:do|would|should|could|can|will)\s+(?:we|it|they)\s+(?:build|implement|ship|integrate|support|handle|design|architect|structure|migrate)\b|\bhow\s+to\s+(?:build|implement|ship|integrate|design)\b|\bwhat\s+(?:would|should|do)\s+we\s+(?:build|ship)\b|\b(?:requirements|acceptance criteria|edge cases|architecture|data model)\b|\b(?:prototype|mvp)\b/i;
const PROTOTYPE = /\b(?:prototype|mvp|stub(?:bed)?|demo)\b/i;
/** What users do or need, or how many: research. */
const RESEARCH = /\bhow\s+(?:many|often|much|long)\b|\b(?:customers?|users?|admins?|accounts?|buyers?|people|segments?)\b[^?]*?\b(?:use|uses|used|need|needs|want|wants|struggle|struggles|try|tried|prefer|prefers|run|runs|ask for|asked for|work around)\b|\b(?:market size|size (?:of )?the market)\b/i;
/** The words a "— needs: …" mark may use for a kind of work, beyond its name. */
const NEEDS_ALIASES: [RegExp, string][] = [
  [/\b(?:validation readout|readout)\b/i, "validation-readout"],
  [/\b(?:validation|validate|pilot)\b/i, "validation-plan"],
  [/\b(?:competitive|competitors?|comparison)\b/i, "competitive-analysis"],
  [/\b(?:build brief|prototype|mvp)\b/i, "build-brief"],
  [/\b(?:spec|prd|one-pager|specification)\b/i, "spec"],
  [/\bproblem brief\b/i, "problem-brief"],
  [/\bdecision brief\b/i, "decision-brief"],
  [/\b(?:research|interviews?|survey|data)\b/i, "research-synthesis"],
];

/** The kind a text names, among the team's: "a validation plan", "a build-brief". */
function namedKind(text: string, kinds: string[]): string | undefined {
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
  return kinds.find((k) => lower.includes(` ${k} `) || lower.includes(` ${k.replace(/-/g, " ")} `));
}

export function followUpKind(
  text: string, own: string | null, kinds: string[], stages: Record<string, string | null> = {},
  o: { needs?: string | null; question?: string } = {},
): string | null {
  if (!kinds.length) return null;
  const named = namedKind(text, kinds);
  if (named) return named;
  if (o.needs) {
    const marked = namedKind(o.needs, kinds) ?? NEEDS_ALIASES.find(([re, k]) => re.test(o.needs!) && kinds.includes(k))?.[1];
    if (marked) return marked;
  }
  // The question's own words; the item's, when the caller has no question apart.
  const q = o.question ?? text;
  const has = (k: string) => kinds.includes(k);
  if (COMPARE.test(q) && has("competitive-analysis")) return "competitive-analysis";
  if (COMMITMENT.test(q) && has("validation-plan")) return "validation-plan";
  if (BUILD.test(q)) {
    const build = (PROTOTYPE.test(q) ? ["build-brief", "spec"] : ["spec", "build-brief"]).find(has);
    if (build) return build;
  }
  if (RESEARCH.test(q) && has("research-synthesis")) return "research-synthesis";
  for (const k of own ? NEXT_KIND[own] ?? [] : []) if (kinds.includes(k)) return k;
  const stage = own ? stages[own] ?? null : null;
  const at = stage ? STAGES.indexOf(stage as (typeof STAGES)[number]) : -1;
  if (at >= 0) {
    const next = kinds.find((k) => k !== own && stages[k] === STAGES[at + 1]);
    if (next) return next;
    const same = kinds.find((k) => k !== own && stages[k] === stage);
    if (same) return same;
  }
  return own && kinds.includes(own) ? own : kinds[0]!;
}

/**
 * One follow-up this Mac made from an accepted draft, by its fixed ID (FOLLOW-1): the item of the draft it was read
 * from (src/review/follow-up-id.ts), never its wording. With what it became: a call of the PM's (`decision`), a thing to
 * do as written (`action`) or a question to ask (`ask`), each with its to-do's ID (`todo`); or work, with its suggested
 * task's ID (`proposal`). `already`: an open to-do or task with the same words was there, so nothing new was made
 * (`todo`: that to-do). `legacy`: a PMX before 0.41.0 made it, and recorded only this wording key, not what it became.
 * `predates`: a PMX before 0.41.0 accepted this draft and recorded keys no reader gives back any more, so the item is
 * taken as made then, and nothing was made now (`followUpsOnAccept`). A follow-up read from two items (`ids`) has one
 * entry for each, with the same to-do.
 */
export interface Made { id: string; as: "decision" | "action" | "ask" | "work"; todo?: string; proposal?: string; already?: true; legacy?: string; predates?: true; at: string }

/**
 * What this Mac made from each accepted draft, so accepting it again neither makes a follow-up twice nor makes the ones
 * left behind. `followUps`: each one made, by its fixed ID, with what it became. `leftIds`: the ones left in the draft
 * over the caps, by their IDs. A later accept, and the re-read of older follow-ups (D2-8), find a follow-up by its ID,
 * whatever PMX's wording rules have become since.
 *
 * LEGACY, `made` and `left`: the wording-based keys PMX 0.40.3 and earlier recorded instead. They are kept as that PMX
 * left them, and never added to. Accepting a draft again reads them once more through the frozen 0.40.3 reader
 * (./legacy/follow-up-keys.ts): an item whose old key is here was made already, and gets its fixed ID in `followUps`.
 * `made` stays an array, empty for a new draft, because an older PMX reading this file expects one. `bridged`: when the
 * first accept by a PMX with IDs settled those old keys, giving every item of the draft its ID; from then on the IDs
 * alone say what was made.
 */
interface DraftLedger { at: string; made: string[]; left?: string[]; bridged?: string; followUps?: Made[]; leftIds?: string[]; requeued?: Requeued[] }
interface Ledger { v: 1; drafts: Record<string, DraftLedger> }
export const followUpsFile = () => join(paths.staging(), "follow-ups.json");

/** The follow-ups made, with the new ones: the first record of an ID stands. */
const withMade = (have: Made[] | undefined, more: Made[]): Made[] => {
  const out = [...(have ?? [])];
  for (const m of more) if (!out.some((x) => x.id === m.id)) out.push(m);
  return out;
};

/**
 * D2-8: one waiting follow-up an older PMX made from this draft, read again by today's rules (src/review/requeue.ts):
 * now a to-do to ask someone (`ask`), a call of the PM's (`decision`) or something to do as written (`action`, "Check
 * the scope …"), with that to-do's ID, still work with a new title and kind (`work`), or no follow-up at all, dropped
 * (`dropped`). Its title then (`was`), and its words now (`now`). `why`: why it was dropped. The ledger is on the Mac
 * that read it again, so the reason is always here, wherever the run that suggested the original task was (its receipt
 * may be on another PM's Mac, and never lists a follow-up an accept made).
 */
export interface Requeued { at: string; proposal: string; was: string; as: "ask" | "decision" | "action" | "work" | "dropped"; now: string; todo?: string; category?: string; why?: string }

/**
 * Records in the ledger what reading a draft's older follow-ups again did (D2-8), with the follow-ups it now made, each
 * by its fixed ID with its to-do (`made`), so accepting that draft again makes none of them twice.
 */
export async function recordRequeued(identifier: string, path: string, changes: Requeued[], made: Made[], now: Date): Promise<void> {
  if (!changes.length) return;
  const key = `${identifier} ${path}`;
  await privateDir(paths.staging());
  await withLock(followUpsFile(), async () => {
    const l = (await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} };
    const d: DraftLedger = l.drafts[key] ?? { at: now.toISOString(), made: [] };
    d.made ??= [];
    const followUps = withMade(d.followUps, made);
    if (followUps.length) d.followUps = followUps;
    d.leftIds = d.leftIds?.filter((id) => !followUps.some((m) => m.id === id));
    if (!d.leftIds?.length) delete d.leftIds;
    d.requeued = [...(d.requeued ?? []), ...changes];
    l.drafts[key] = d;
    await writeJson(followUpsFile(), l, 0o600);
  });
}

export interface FollowUpResult {
  /** The team turned follow-ups off, or the draft isn't a document. */
  skipped: "off" | "no-draft" | null;
  /** The PM's calls, as to-dos. `action`: one worded as something to do ("Check the scope …"), not a decision. */
  todos: { id: string; text: string; action?: true }[];
  /** Questions one person can answer, as to-dos: "Ask <role>: <question> (PMX-12)" (R2). */
  asks: { id: string; text: string }[];
  proposals: { id: string; title: string; category: string }[];
  /** Made already when this draft was accepted before. */
  repeated: number;
  /** The same to-do is open, or a task with the same title is open or waiting. */
  duplicates: number;
  /** Questions whose words can't go to the tracker as written: a quote, a name, a meeting title, contact details, fundraising or a source repeated. */
  leftOut: number;
  /** Questions over FOLLOW_TASKS or FOLLOW_ASKS: they stay in the draft. */
  moreQuestions: number;
  /** Calls over FOLLOW_TODOS: they stay in the draft. `moreActions`: those of them worded as something to do. */
  moreDecisions: number;
  moreActions: number;
  draft: string | null;
  /**
   * The handle of the PM who suggested the task, when it isn't the PM accepting it: the calls still came to this PM.
   * From the task's evidence pack (RUN-5), which names the Mac that wrote it; null without one.
   */
  suggestedBy?: string | null;
}

const EMPTY = (skipped: FollowUpResult["skipped"], draft: string | null = null): FollowUpResult => ({ skipped, todos: [], asks: [], proposals: [], repeated: 0, duplicates: 0, leftOut: 0, moreQuestions: 0, moreDecisions: 0, moreActions: 0, draft });

/**
 * A clause in a question's own word order ("what will the committee accept", "who is the contact", "which plans do
 * admins use"), not one that reports a question ("what the DPA covers", "how long imports take").
 */
const DIRECT = /^(?:what|which|who|whom|whose|when|where|why|how(?:\s+(?:many|much|long|often|soon|far))?)\s+(?:[\w'’-]+\s+)?(?:is|are|was|were|will|would|can|could|should|shall|does|do|did|has|have|must|may|might)\b/i;

/** Words that add nothing to a question: "what exactly will …" asks what will. Not before a number ("exactly 30 days"). */
const FILLER = /\s+(?:exactly|precisely|actually|really|basically)\b(?!\s+(?:\d|(?:one|two|three|four|five|six|seven|eight|nine|ten|half|once|twice|the same)\b))/gi;

/**
 * An ask to-do's words (R2): "Ask the finance lead: Who funds the pilot? (PMX-12)", "Find out: …" when the draft names
 * no role, and "Ask legal whether …" ("Find out whether …") for a question the draft wrote as a clause. The question in
 * its own words and order, starting with a capital and ending with its "?", without filler like "exactly"; one whose
 * title starts with what it's about (`about`) is asked about it: "Ask legal about the Globex integration: Does the
 * integration need this …?". At most 200 characters, like any to-do.
 */
export function askText(role: string | null, title: string, identifier: string, about: string | null = null): string {
  const id = identifier ? ` (${identifier})` : "";
  let words = title.replace(FILLER, "");
  const clause = words.match(/^Find out (.+)$/)?.[1];
  // FOLLOW-1: a clause that is a question as the draft asks it ("what will the committee accept …?", "who is the
  // contact") is asked as one, after a colon: "Ask the security lead: What will the committee accept …?".
  if (clause && (clause.includes("?") || DIRECT.test(clause))) words = clause.replace(/[\s.;:,]+$/, "").replace(/\?*$/, "?");
  else if (clause) {
    const head = role ? `Ask ${role} ` : "Find out ";
    return `${head}${cut(clause, 200 - head.length - id.length)}${id}`;
  }
  // One question, ending at its "?": nothing the draft wrote after it (", via …") is part of it.
  words = words.replace(/^([^?]*\?)(?:\s*[,;]|\s+[—–-]\s|\s+\p{Lu}).*$/u, "$1");
  const leaned = about ? words.match(/^[^:?]{1,80}:\s+(.+)$/)?.[1] : undefined;
  const q = (leaned ?? words).replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  const head = `${role ? `Ask ${role}` : "Find out"}${leaned ? ` about ${about}` : ""}: `;
  const room = 200 - head.length - id.length;
  // Cut short, a question still ends with its "?".
  return `${head}${q.length > room && q.endsWith("?") ? `${cut(q, room - 1)}?` : cut(q, room)}${id}`;
}

/**
 * An ask to-do's why (FOLLOW-1): what the draft says beside the question, as statements (the reason, the recommendation,
 * a date), or else a whole sentence that says where it comes from. A title that leans on something nothing says
 * (`from`) gets that sentence too, naming the task.
 */
export function askWhy(q: Pick<DraftQuestion, "rest" | "where" | "from">, identifier: string): string {
  const said = statements(q.rest).join(" ");
  const where = `${identifier}'s accepted draft${q.from ? `, "${q.from}",` : ""} lists this as ${q.where === "blocking" ? "a blocking" : "an open"} question.`;
  return cut(said && q.from ? `${where} ${said}` : said || where, 400);
}

/**
 * An ask to-do's words and why (R2, FOLLOW-1), with its role only when the tracker rules let it through (`ok`): a role,
 * never a person. End-to-end test 2026-11-27: an item's own ask ("Ask Dana Lee's team whether they want …") whose role
 * they cut never leaves a bare "they" ("Find out whether they want …"): it asks the team of the company that role names
 * ("Ask Globex's team whether they want …"), when they let that through; else it reads as the item's question with its
 * label or the task's subject first; else in its own words ("Find out: Is the other partners' need real?").
 */
export function askTodo(q: DraftQuestion, identifier: string, ok: (s: string) => boolean): { text: string; why: string } {
  const role = q.ask?.role && ok(q.ask.role) ? q.ask.role : null;
  const u = role ? undefined : q.unasked;
  if (!u) return { text: askText(role, q.title, identifier, q.about), why: askWhy(q, identifier) };
  if (u.company && ok(u.company)) return { text: askText(`${u.company}'s team`, q.title, identifier, q.about), why: askWhy(q, identifier) };
  const alone = { ...q, title: u.title, about: u.about, from: u.from };
  return { text: askText(null, alone.title, identifier, alone.about), why: askWhy(alone, identifier) };
}

/** The draft a review item carries: the run's output, else the first Markdown file under outputs/. */
export function draftFile(item: Pick<ReviewItem, "files" | "record">): { path: string; content: string } | null {
  const ref = item.record?.artifact?.ref;
  // A prototype or a repo change has no draft to read follow-ups from, whatever Markdown it carries.
  if (item.record?.artifact && item.record.artifact.kind !== "file") return null;
  return item.files.find((f) => f.path === ref && f.path.endsWith(".md"))
    ?? item.files.find((f) => f.path.startsWith("outputs/") && f.path.endsWith(".md"))
    ?? null;
}

/** The suggested task's description: the question and what the draft says about it, then where it came from. */
function describeFollowUp(q: { question: string; rest: string[]; where: DraftQuestion["where"] }, task: Task, path: string): string {
  // The original task's readable source line (F14), so the follow-up says what it rests on too.
  const based = task.description.match(SOURCES_LINE)?.[0];
  const sources = [...task.description.matchAll(/^pmx:source .*$/gm)].map((m) => m[0]);
  return [
    [q.question, ...q.rest].join(" "),
    "",
    `**Follows ${task.identifier}:** ${q.where === "blocking" ? "a blocking question" : "an open question"} its accepted draft left, in the team repo at \`${path}\`.`,
    "**Size S, not checked:** PMX doesn't size follow-ups. Change the size if the work is bigger.",
    ...(based ? [based] : []),
    ...(sources.length ? ["", ...sources] : []),
  ].join("\n");
}

/**
 * FOLLOW-1: after a draft is accepted, its calls and the questions one person can answer (R2) become the accepting PM's
 * private to-dos, and its open work becomes suggested tasks waiting in Needs you. Never throws for a draft it can't
 * read; the accept itself is already done.
 */
export async function followUpsOnAccept(ctx: Ctx, svc: Services, item: Pick<ReviewItem, "task" | "files" | "record" | "citations"> & { prUrl?: string }): Promise<FollowUpResult> {
  if (!followUpsOn(ctx.team)) return EMPTY("off");
  const draft = draftFile(item);
  if (!draft) return EMPTY("no-draft");
  const { task } = item;
  const now = ctx.now();
  const found = readFollowUps(draft.content, task.identifier, now, { title: task.title });
  const out = EMPTY(null, draft.path);
  const draftKey = `${task.identifier} ${draft.path}`;
  const at = now.toISOString();
  const before = ((await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} }).drafts[draftKey];
  // What an earlier accept made or left, each follow-up by its fixed ID: first, and by itself enough.
  const madeBefore = before?.followUps ?? [];
  const leftBefore = new Set(before?.leftIds ?? []);
  // LEGACY: what a PMX before 0.41.0 made or left, by the wording keys it recorded. Read only when this draft's ledger
  // has some, through the frozen 0.40.3 reader, which says which of them each item of the draft had.
  const oldMade = new Set(before?.made ?? []);
  const oldLeft = new Set(before?.left ?? []);
  const old = oldMade.size || oldLeft.size ? legacyKeys(draft.content, task.identifier, now, { title: task.title }) : new Map<string, string[]>();
  const oldKeys = (x: { ids: string[] }) => x.ids.flatMap((id) => old.get(id) ?? []);
  // LEGACY, the first accept of this draft by a PMX with IDs (`settle`). The frozen reader gives back the keys of
  // 0.40.x. A draft accepted on an older PMX (0.37, 0.38 …) has keys from wording that no reader gives back ("Decide: :
  // Deletion window", for today's "Decide on the deletion window"), and its to-dos are on the PM's list under those
  // older words, so no check by words knows them either. An old key that no item of this draft gives (an orphan) is
  // the proof: the wording moved since. Then an item with no old key of its own can't be told from one made under the
  // older words, so it is taken as handled then, and nothing is made: as made (`predates`) while the ledger has an
  // orphan among its made keys, as left in the draft when its only orphans are among those left; with orphans among
  // both, as made up to that accept's cap for its kind, and left after it, as that accept went. With no orphan, every
  // old key is accounted for, so such an item is new, and made. Once only: this accept gives every item its ID, the
  // ledger says so (`bridged`), and from then on a new item in the draft is always made.
  const settle = !!before && !before.bridged && (oldMade.size > 0 || oldLeft.size > 0);
  const given = new Set([...old.values()].flat());
  const orphanMade = settle && [...oldMade].some((k) => !given.has(k));
  const orphanLeft = settle && [...oldLeft].some((k) => !given.has(k));
  const caps = { todo: FOLLOW_TODOS, ask: FOLLOW_ASKS, work: FOLLOW_TASKS };
  const had = { todo: 0, ask: 0, work: 0 };
  const capOf = (as: Made["as"]) => (as === "ask" || as === "work" ? as : "todo");
  const done: Made[] = [];
  const stay: string[] = [];
  /** Made now, or there already: recorded under each item it was read from, with what it became. */
  const record = (x: { ids: string[] }, as: Made["as"], what: Pick<Made, "todo" | "proposal" | "already" | "legacy" | "predates"> = {}) => { for (const id of x.ids) done.push({ id, as, ...what, at }); };
  /** Made by an earlier accept: counted, not made again. Left in the draft then: still left there. */
  const fresh = <T extends { ids: string[] }>(list: T[], as: (x: T) => Made["as"], more: (x: T) => "moreQuestions" | "moreDecisions" | "moreActions") => list.filter((x) => {
    const made = madeBefore.find((m) => x.ids.includes(m.id));
    const cap = capOf(as(x));
    if (made) {
      out.repeated++;
      had[cap]++;
      // Read from one more item than then (two calls PMX now reads as one): that item is made too.
      for (const id of x.ids) if (!madeBefore.some((m) => m.id === id)) done.push({ ...made, id });
      return false;
    }
    // LEGACY: made by a PMX before 0.41.0. Its fixed ID is recorded now, so its old key is never needed again.
    const key = oldKeys(x).find((k) => oldMade.has(k));
    if (key) { out.repeated++; had[cap]++; record(x, as(x), { legacy: key }); return false; }
    if (x.ids.some((id) => leftBefore.has(id)) || oldKeys(x).some((k) => oldLeft.has(k))) { out[more(x)]++; stay.push(...x.ids); return false; }
    // LEGACY: no old key of its own, in a draft whose ledger has keys from older wording (`settle`): handled then.
    if (orphanMade && (!orphanLeft || had[cap] < caps[cap])) { out.repeated++; had[cap]++; record(x, as(x), { predates: true }); return false; }
    if (orphanMade || orphanLeft) { out[more(x)]++; stay.push(...x.ids); return false; }
    return true;
  });
  /** A call over the cap is a decision or, worded as something to do, a thing to do (FOLLOW-1). */
  const moreCall = (d: { action?: true }) => (d.action ? "moreActions" : "moreDecisions");
  const callAs = (d: { action?: true }) => (d.action ? "action" : "decision");
  const decisions = fresh(found.decisions, callAs, moreCall);
  // Blocking questions first, then the open ones, each in the draft's order. One a person can answer is a to-do to ask
  // them (R2); one that needs research or a document, a suggested task.
  const questions = fresh([...found.questions.filter((q) => q.where === "blocking"), ...found.questions.filter((q) => q.where !== "blocking")], (q) => (q.ask ? "ask" : "work"), () => "moreQuestions");
  const asks = questions.filter((q) => q.ask);
  const work = questions.filter((q) => !q.ask);

  // Who suggested the task, when another PM did: the PM whose Mac wrote its evidence pack (RUN-5), read from the team
  // repo's copy that quoting it fetches anyway. Nothing is asked of that PM's Mac. A task this Mac suggested has none.
  const store = evidenceStore(ctx.repo);
  if (decisions.length || questions.length) {
    const theirs = task.sources.length && !(await sourcesHere(task).catch(() => ({ receipt: true }))).receipt;
    const by = theirs ? await store.writer(task.identifier).catch(() => null) : null;
    if (by && by !== ctx.personal.handle) out.suggestedBy = by;
  }
  const provenance = { title: `From ${task.identifier}'s accepted draft, ${draft.path}`, at: now.toISOString().slice(0, 10), keys: [] as string[], ...(out.suggestedBy ? { suggestedBy: out.suggestedBy } : {}) };

  // The PM's calls: private to-dos, on this Mac only. The net under the IDs: an open to-do with the same words is the
  // same to-do, whichever draft or PMX it came from. A second check only: what identifies a follow-up is its ID.
  const open = new Map((await loadTodos()).items.filter((t) => t.status === "open").map((t) => [norm(t.text), t.id]));
  for (const d of decisions) {
    if (out.todos.length >= FOLLOW_TODOS) { out[moreCall(d)]++; stay.push(...d.ids); continue; }
    if (open.has(norm(d.text))) { out.duplicates++; record(d, callAs(d), { todo: open.get(norm(d.text)), already: true }); continue; }
    const t = await keepTodo({ text: d.text, due: d.due, why: d.why, source: provenance }, now);
    open.set(norm(t.text), t.id);
    out.todos.push({ id: t.id, text: t.text, ...(d.action ? { action: true as const } : {}) });
    record(d, callAs(d), { todo: t.id });
  }

  if (questions.length) {
    const names = await privateNames(ctx).catch(() => [] as string[]);
    // RUN-5: on a Mac that didn't suggest the task, its evidence pack is what the run quoted, so it guards the same way.
    const evidence: Evidence = await runEvidence(ctx, task, store).catch(() => ({ sources: [], missing: [] }));
    // N4: the same quote rule as synthesis: a fragment of names, figures and features may stay; quoted prose never does.
    const quotes = quoteGuard([
      ...evidence.sources.map((s) => ({ id: s.id, text: s.passages.join("\n") })),
      ...Object.entries(item.citations ?? {}).map(([id, text]) => ({ id, text: String(text) })),
      ...(await strategyFiles(ctx.personal.repoPath).catch(() => [] as { name: string; text: string }[])).map((f) => ({ id: STRATEGY_SOURCE(f.name), text: f.text })),
    ]);
    const receipt = receiptOf(task);
    const r = receipt ? await readReceipt(receipt).catch(() => null) : null;
    // F14: the same tracker rules as suggested tasks: who the sources name (their speakers), the meetings' titles and
    // the team's series never go, and neither does fundraising.
    const rules = {
      // N5, R4: everyone the sources name: their participants (on the Mac that has the files), their speakers and the
      // names in their text. The companies the task's Sources line names are companies, never people.
      // R5: and the sources' outside companies the evidence (a pack too) lists.
      people: sourcePeople(evidence, [...ctx.team.internalDomains, ...(ctx.personal.companyDomains ?? [])], [...sourceCompanies(task.description, task.title), ...(evidence.companies ?? [])]),
      // D2-1: the companies the sources show, so "Ask Globex for…" may go while "Ask Dana for…" never does.
      things: sourceThings(evidence, [...ctx.team.internalDomains, ...(ctx.personal.companyDomains ?? [])], task.description),
      known: await knownThings(ctx).catch(() => [] as string[]),
      titles: (r?.sources ?? []).filter((s) => s.decision === "used" && s.kind === "transcript" && s.title).map((s) => s.title!),
      series: meetingSeries(ctx.team),
      // F5: nor do the team's investors' and other confidential contacts' names.
      confidential: confidentialDomains(ctx.team.confidentialDomains),
    };
    const tracker = trackerGuard({ ...rules, names });
    const ok = (s: string) => !tracker.problem(s) && !quotes.match(s);

    // The questions to put to someone: the PM's private to-dos, on this Mac only, in the draft's words like its decision
    // to-dos. Linear's quote rule isn't theirs (R2a): moving one to Linear later checks it there.
    for (const q of asks) {
      if (out.asks.length >= FOLLOW_ASKS) { out.moreQuestions++; stay.push(...q.ids); continue; }
      // A role, never a person: one the tracker rules would cut (a name, a placeholder) is left out, and an ask that
      // leaned on it says whom else to ask (`askTodo`). Its why: a whole sentence that says where the question comes
      // from, when the draft says nothing more about it; a question the draft left beside it ("Has a reviewer been
      // asked?") is no reason (FOLLOW-1).
      const { text, why } = askTodo(q, task.identifier, (s) => !tracker.problem(s));
      if (open.has(norm(text))) { out.duplicates++; record(q, "ask", { todo: open.get(norm(text)), already: true }); continue; }
      const t = await keepTodo({ text, due: deadlineIn([q.question, ...q.rest].join(" "), now), why, source: provenance }, now);
      open.set(norm(t.text), t.id);
      out.asks.push({ id: t.id, text: t.text });
      record(q, "ask", { todo: t.id });
    }

    // The open work: suggested tasks, staged like synthesis's and held to the same tracker-text rules (PRIV-6).
    if (work.length) {
      const kinds = Object.keys(ctx.team.categories);
      const stages = Object.fromEntries((await skillInventory(ctx.personal.repoPath, ctx.team.categories).catch(() => [])).filter((s) => s.category).map((s) => [s.category!, s.check?.stage ?? null]));
      const taken = new Set([...(await svc.tracker.list()).filter((t) => t.status !== "done").map((t) => norm(t.title)), ...(await readProposals()).map((p) => norm(p.title))]);
      const from: Proposal["from"] = (r?.sources ?? []).filter((s) => s.decision === "used" && s.id && task.sources.includes(s.id) && s.at)
        .map((s) => ({ id: s.id!, title: s.title ?? s.id!, at: s.at!, why: `A source of ${task.identifier}` }));
      const staged: { q: DraftQuestion; p: Omit<Proposal, "id"> }[] = [];
      for (const q of work) {
        if (staged.length >= FOLLOW_TASKS) { out.moreQuestions++; stay.push(...q.ids); continue; }
        // Not recorded as made, so accepting again says the same.
        if (!ok(q.question) || !ok(q.title)) { out.leftOut++; continue; }
        // R2: the question whole, never a fragment of it.
        const title = cut(q.title.replace(/\s+/g, " "), 120);
        // The net under the IDs, as for to-dos: a task open or waiting under the same title is the same task.
        if (taken.has(norm(title))) { out.duplicates++; record(q, "work", { already: true }); continue; }
        const kind = followUpKind(q.question + " " + q.rest.join(" "), task.category, kinds, stages, { needs: q.needs, question: `${q.title} ${q.question}` });
        if (!kind) continue;
        taken.add(norm(title));
        const rest = q.rest.filter(ok);
        staged.push({
          q, p: {
            at: now.toISOString(), receipt: receipt ?? "", title, description: describeFollowUp({ ...q, rest }, task, draft.path), category: kind, size: "S",
            sources: task.sources, from, ...keptQuotes(evidence),
            follows: { identifier: task.identifier, path: draft.path, url: task.url || null, where: q.where, ...(item.prUrl && /^https?:\/\//.test(item.prUrl) ? { draft: item.prUrl } : {}) },
            // R3: checked by this PMX's tracker rules, which approval relies on if it can't read the sources again.
            checked: CHECKED,
          },
        });
      }
      // Each says how many of its draft's questions stayed there, so its details can point to them.
      if (out.moreQuestions) for (const s of staged) s.p.follows!.more = out.moreQuestions;
      const added = await stageProposals(staged.map((s) => s.p));
      for (const s of staged) {
        const p = added.find((x) => x.title === s.p.title);
        if (p) out.proposals.push({ id: p.id, title: p.title, category: p.category });
        else out.duplicates++;
        record(s.q, "work", p ? { proposal: p.id } : { already: true });
      }
    }
  }

  if (done.length || stay.length || settle) {
    await privateDir(paths.staging());
    await withLock(followUpsFile(), async () => {
      const l = (await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} };
      const was = l.drafts[draftKey];
      const followUps = withMade(was?.followUps, done);
      const leftIds = [...new Set([...(was?.leftIds ?? []), ...stay])].filter((id) => !followUps.some((m) => m.id === id));
      l.drafts[draftKey] = {
        at,
        // LEGACY: an older PMX's keys, as it left them. Nothing is added to them.
        made: was?.made ?? [], ...(was?.left?.length ? { left: was.left } : {}),
        // Settled by this accept, or an earlier one: every item of the draft has its ID from then on.
        ...(was?.bridged ? { bridged: was.bridged } : settle ? { bridged: at } : {}),
        ...(followUps.length ? { followUps } : {}), ...(leftIds.length ? { leftIds } : {}),
        ...(was?.requeued?.length ? { requeued: was.requeued } : {}),
      };
      await writeJson(followUpsFile(), l, 0o600);
    });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "a", "a and b", "a, b and c". */
export const inWords = (xs: string[]) => {
  const ys = xs.filter(Boolean);
  return ys.length <= 1 ? ys.join("") : `${ys.slice(0, -1).join(", ")} and ${ys.at(-1)}`;
};

/**
 * What accepting made, in a PM's words, for every surface: "2 decisions and 1 question to ask added to your to-dos; 3
 * follow-up tasks wait for your approval in Needs you." A call worded as something to do is counted apart, as a thing to
 * do: "2 decisions, 1 thing to do and 1 question to ask …" (FOLLOW-1). Empty when there was nothing to make. Never a
 * command.
 */
export function followUpText(r: FollowUpResult | null): string {
  if (!r || r.skipped) return "";
  const asks = r.asks?.length ?? 0;
  const actions = r.todos.filter((t) => t.action).length;
  const decisions = r.todos.length - actions;
  const todos = inWords([
    decisions ? plural(decisions, "decision") : "", actions ? plural(actions, "thing to do", "things to do") : "",
    asks ? plural(asks, "question to ask", "questions to ask") : "",
  ]);
  const parts = [
    todos ? `${todos} added to your to-dos` : "",
    r.proposals.length ? `${plural(r.proposals.length, "follow-up task")} ${r.proposals.length === 1 ? "waits" : "wait"} for your approval in Needs you` : "",
    r.moreQuestions ? `${r.moreQuestions} more ${r.moreQuestions === 1 ? "question stays" : "questions stay"} in the draft` : "",
    r.moreDecisions ? `${r.moreDecisions} more ${r.moreDecisions === 1 ? "decision stays" : "decisions stay"} in the draft` : "",
    r.moreActions ? `${r.moreActions} more ${r.moreActions === 1 ? "thing to do stays" : "things to do stay"} in the draft` : "",
    r.repeated ? `${plural(r.repeated, "follow-up")} ${r.repeated === 1 ? "was" : "were"} already made from this draft` : "",
    r.duplicates ? `${plural(r.duplicates, "follow-up")} ${r.duplicates === 1 ? "was" : "were"} already on your list` : "",
    r.leftOut ? `${plural(r.leftOut, "question")} stayed in the draft, because ${r.leftOut === 1 ? "its" : "their"} words can't go to Linear as written` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const s = parts.join("; ");
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
}
