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
 * Which follow-ups this Mac already made from each accepted draft (`made`), and which it left in the draft over the caps
 * (`left`), so accepting it again neither doubles them nor makes the ones left behind.
 */
interface Ledger { v: 1; drafts: Record<string, { at: string; made: string[]; left?: string[]; requeued?: Requeued[] }> }
export const followUpsFile = () => join(paths.staging(), "follow-ups.json");

/**
 * D2-8: one waiting follow-up an older PMX made from this draft, read again by today's rules (src/review/requeue.ts):
 * now a to-do to ask someone (`ask`) or a call of the PM's (`decision`), with that to-do's ID, still work with a new
 * title and kind (`work`), or no follow-up at all, dropped (`dropped`). Its title then (`was`), and its words now (`now`).
 */
export interface Requeued { at: string; proposal: string; was: string; as: "ask" | "decision" | "work" | "dropped"; now: string; todo?: string; category?: string }

/**
 * Records in the ledger what reading a draft's older follow-ups again did (D2-8), with the follow-ups it now made, so
 * accepting that draft again makes none of them twice.
 */
export async function recordRequeued(identifier: string, path: string, changes: Requeued[], keys: string[], now: Date): Promise<void> {
  if (!changes.length) return;
  const key = `${identifier} ${path}`;
  await privateDir(paths.staging());
  await withLock(followUpsFile(), async () => {
    const l = (await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} };
    const d = l.drafts[key] ?? { at: now.toISOString(), made: [] };
    d.made = [...new Set([...d.made, ...keys])];
    d.left = d.left?.filter((k) => !d.made.includes(k));
    if (!d.left?.length) delete d.left;
    d.requeued = [...(d.requeued ?? []), ...changes];
    l.drafts[key] = d;
    await writeJson(followUpsFile(), l, 0o600);
  });
}

export interface FollowUpResult {
  /** The team turned follow-ups off, or the draft isn't a document. */
  skipped: "off" | "no-draft" | null;
  /** The PM's calls, as to-dos. */
  todos: { id: string; text: string }[];
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
  /** Calls over FOLLOW_TODOS: they stay in the draft. */
  moreDecisions: number;
  draft: string | null;
  /**
   * The handle of the PM who suggested the task, when it isn't the PM accepting it: the calls still came to this PM.
   * From the task's evidence pack (RUN-5), which names the Mac that wrote it; null without one.
   */
  suggestedBy?: string | null;
}

const EMPTY = (skipped: FollowUpResult["skipped"], draft: string | null = null): FollowUpResult => ({ skipped, todos: [], asks: [], proposals: [], repeated: 0, duplicates: 0, leftOut: 0, moreQuestions: 0, moreDecisions: 0, draft });

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
  const ledger = (await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} };
  const made = new Set(ledger.drafts[draftKey]?.made ?? []);
  const leftBefore = new Set(ledger.drafts[draftKey]?.left ?? []);
  const done: string[] = [];
  const stay: string[] = [];
  /** Made by an earlier accept: counted, not made again. Left in the draft then: still left there. */
  const fresh = <T extends { key: string }>(list: T[], more: "moreQuestions" | "moreDecisions") => list.filter((x) => {
    if (made.has(x.key)) { out.repeated++; return false; }
    if (leftBefore.has(x.key)) { out[more]++; stay.push(x.key); return false; }
    return true;
  });
  const decisions = fresh(found.decisions, "moreDecisions");
  // Blocking questions first, then the open ones, each in the draft's order. One a person can answer is a to-do to ask
  // them (R2); one that needs research or a document, a suggested task.
  const questions = fresh([...found.questions.filter((q) => q.where === "blocking"), ...found.questions.filter((q) => q.where !== "blocking")], "moreQuestions");
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

  // The PM's calls: private to-dos, on this Mac only.
  const open = new Set((await loadTodos()).items.filter((t) => t.status === "open").map((t) => norm(t.text)));
  for (const d of decisions) {
    if (out.todos.length >= FOLLOW_TODOS) { out.moreDecisions++; stay.push(d.key); continue; }
    if (open.has(norm(d.text))) { out.duplicates++; done.push(d.key); continue; }
    const t = await keepTodo({ text: d.text, due: d.due, why: d.why, source: provenance }, now);
    open.add(norm(t.text));
    out.todos.push({ id: t.id, text: t.text });
    done.push(d.key);
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
      if (out.asks.length >= FOLLOW_ASKS) { out.moreQuestions++; stay.push(q.key); continue; }
      // A role, never a person: one the tracker rules would cut (a name, a placeholder) is left out.
      const role = q.ask!.role && !tracker.problem(q.ask!.role) ? q.ask!.role : null;
      const text = askText(role, q.title, task.identifier, q.about);
      if (open.has(norm(text))) { out.duplicates++; done.push(q.key); continue; }
      // A whole sentence that says where the question comes from, when the draft says nothing more about it. A question
      // the draft left beside it ("Has a reviewer been asked?") is no reason (FOLLOW-1).
      const why = askWhy(q, task.identifier);
      const t = await keepTodo({ text, due: deadlineIn([q.question, ...q.rest].join(" "), now), why, source: provenance }, now);
      open.add(norm(t.text));
      out.asks.push({ id: t.id, text: t.text });
      done.push(q.key);
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
        if (staged.length >= FOLLOW_TASKS) { out.moreQuestions++; stay.push(q.key); continue; }
        // Not recorded as made, so accepting again says the same.
        if (!ok(q.question) || !ok(q.title)) { out.leftOut++; continue; }
        // R2: the question whole, never a fragment of it.
        const title = cut(q.title.replace(/\s+/g, " "), 120);
        if (taken.has(norm(title))) { out.duplicates++; done.push(q.key); continue; }
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
        done.push(s.q.key);
      }
    }
  }

  if (done.length || stay.length) {
    await privateDir(paths.staging());
    await withLock(followUpsFile(), async () => {
      const l = (await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} };
      const all = new Set([...(l.drafts[draftKey]?.made ?? []), ...done]);
      const left = [...new Set([...(l.drafts[draftKey]?.left ?? []), ...stay])].filter((k) => !all.has(k));
      const requeued = l.drafts[draftKey]?.requeued;
      l.drafts[draftKey] = { at: now.toISOString(), made: [...all], ...(left.length ? { left } : {}), ...(requeued?.length ? { requeued } : {}) };
      await writeJson(followUpsFile(), l, 0o600);
    });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What accepting made, in a PM's words, for every surface: "2 decisions and 1 question to ask added to your to-dos; 3
 * follow-up tasks wait for your approval in Needs you." Empty when there was nothing to make. Never a command.
 */
export function followUpText(r: FollowUpResult | null): string {
  if (!r || r.skipped) return "";
  const asks = r.asks?.length ?? 0;
  const todos = [r.todos.length ? plural(r.todos.length, "decision") : "", asks ? plural(asks, "question to ask", "questions to ask") : ""].filter(Boolean).join(" and ");
  const parts = [
    todos ? `${todos} added to your to-dos` : "",
    r.proposals.length ? `${plural(r.proposals.length, "follow-up task")} ${r.proposals.length === 1 ? "waits" : "wait"} for your approval in Needs you` : "",
    r.moreQuestions ? `${r.moreQuestions} more ${r.moreQuestions === 1 ? "question stays" : "questions stay"} in the draft` : "",
    r.moreDecisions ? `${r.moreDecisions} more ${r.moreDecisions === 1 ? "decision stays" : "decisions stay"} in the draft` : "",
    r.repeated ? `${plural(r.repeated, "follow-up")} ${r.repeated === 1 ? "was" : "were"} already made from this draft` : "",
    r.duplicates ? `${plural(r.duplicates, "follow-up")} ${r.duplicates === 1 ? "was" : "were"} already on your list` : "",
    r.leftOut ? `${plural(r.leftOut, "question")} stayed in the draft, because ${r.leftOut === 1 ? "its" : "their"} words can't go to Linear as written` : "",
  ].filter(Boolean);
  if (!parts.length) return "";
  const s = parts.join("; ");
  return `${s[0]!.toUpperCase()}${s.slice(1)}.`;
}
