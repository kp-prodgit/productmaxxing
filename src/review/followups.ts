import { createHash } from "node:crypto";
import { join } from "node:path";
import { followUpsOn } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { privateDir, readJson, withLock, writeJson } from "../core/fsutil.js";
import { paths } from "../core/paths.js";
import { readReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import { skillInventory } from "../core/skills.js";
import { STAGES, type Task } from "../core/types.js";
import { plain, sections, sentencesOf, sourcePeople, type Section } from "../run/comment.js";
import { quoteGuard, trackerGuard } from "../core/tracker-text.js";
import { meetingSeries } from "../inputs/inputs.js";
import { receiptOf, runEvidence, sourcesHere } from "../run/evidence.js";
import { evidenceStore } from "../run/packs.js";
import { privateNames } from "../run/run.js";
import { stageProposals, readProposals, type Proposal } from "../synth/proposals.js";
import { STRATEGY_SOURCE, SOURCES_LINE, strategyFiles } from "../synth/synthesize.js";
import { keepTodo, loadTodos } from "../todo/todo.js";
import type { ReviewItem } from "./queue.js";

/**
 * FOLLOW-1: what an accepted draft leaves for later. Drafts end with the calls they leave to the PM ("PM decides") and
 * the questions they couldn't answer (open or blocking). Accepting the draft used to end the chain there. Now each call
 * becomes a private to-do for the PM who accepted, and each question that needs work becomes a suggested task, staged
 * exactly like synthesis's, so it waits in Needs you until the PM approves it (APPROVE-1). Nothing reaches the tracker
 * here. A team turns it off with `followUps: false` in pmx.config.json.
 */

/** A call the draft leaves to the PM: it becomes a private to-do. */
export interface DraftDecision {
  /** The to-do's words: the decision to make, with the task's identifier. */
  text: string;
  /** The options and recommendation the draft gives, in its own words. Stays on this Mac. */
  why: string;
  /** A deadline the draft states ("before Dec 8"), as YYYY-MM-DD, or null. */
  due: string | null;
  key: string;
}

/** A question the draft leaves open that needs work: it becomes a suggested task. */
export interface DraftQuestion {
  /** The question, in the draft's words (plain text, no source IDs). */
  question: string;
  /** The rest of the item: context, the PM decides note, the recommendation. Sentence by sentence. */
  rest: string[];
  where: "blocking" | "open";
  key: string;
}

/**
 * At most this many suggested tasks from one accepted draft, blocking questions first and then in the draft's order, so
 * one draft doesn't flood Needs you. The rest stay in the draft, and the accept's answer and the task's details say so.
 */
export const FOLLOW_TASKS = 3;
/** At most this many "PM decides" to-dos from one accepted draft, in the draft's order. */
export const FOLLOW_TODOS = 5;

const LIST = /^ ?(?:[-*+•]|\d+[.)])\s+/;
const NESTED = /^\s{2,}(?:[-*+•]|\d+[.)])\s+/;
const PM_DECIDES = /PM decides/i;
const QUESTIONS = /\bblocking\b|\bquestions?\b/i;
/** A line that only introduces the list under it: "Blocking:", "Open questions:". */
const LABEL = /^(?:blocking(?: questions?)?|open questions?|questions?(?: still open)?|still open)\s*:?$/i;
/** A question that asks the PM to choose rather than someone to find something out. */
const CHOICE = /^(?:should|shall|do we (?:want|go|keep|drop|offer|build|ship|launch)|whether|go or no-go|go\/no-go|is it worth|which option)\b/i;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const keyOf = (kind: string, text: string) => createHash("sha256").update(`${kind}\n${norm(text)}`).digest("hex").slice(0, 12);

interface Block { text: string; list: boolean; sub?: boolean }

/**
 * A section's lines as blocks: top-level list items (their nested lines folded in), paragraphs, and `###` sub-headings.
 * Tables and quotes are left out.
 */
function blocksOf(s: Section): Block[] {
  const out: { lines: string[]; list: boolean; sub?: boolean }[] = [];
  let open = false;
  for (const raw of s.lines) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim()) { open = false; continue; }
    if (/^\s*[|>]/.test(line)) { open = false; continue; }
    const sub = line.match(/^#{3,6}\s+(.+?)\s*#*$/);
    if (sub) { out.push({ lines: [sub[1]!], list: false, sub: true }); open = false; continue; }
    const last = out.at(-1);
    if (LIST.test(line)) { out.push({ lines: [line.replace(LIST, "")], list: true }); open = true; continue; }
    // A nested bullet, or an indented line, explains the item above it.
    if ((NESTED.test(line) || /^\s{2,}\S/.test(line)) && last?.list) { last.lines.push(line.trim().replace(LIST, "")); open = true; continue; }
    if (open && last) { last.lines.push(line.trim()); continue; }
    out.push({ lines: [line.trim()], list: false });
    open = true;
  }
  return out.map((b) => ({ text: b.lines.join(" "), list: b.list, ...(b.sub ? { sub: true } : {}) }));
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A deadline the text states: a date after "by", "before", "due" or "until", like "before Dec 8" or "by 2026-12-08".
 * A date without a year is the next one on or after a month ago. Anything else (a close date, "on Dec 15") is no deadline.
 */
export function deadlineIn(text: string, now: Date): string | null {
  const lead = "\\b(?:by|before|due(?: by| on)?|until|no later than)\\s+(?:the\\s+)?";
  const iso = new RegExp(`${lead}(\\d{4})-(\\d{2})-(\\d{2})\\b`, "i").exec(text);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const md = new RegExp(`${lead}${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
  const dm = md ? null : new RegExp(`${lead}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH}\\.?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
  const hit = md ? { m: md[1]!, d: md[2]!, y: md[3] } : dm ? { m: dm[2]!, d: dm[1]!, y: dm[3] } : null;
  if (!hit) return null;
  const month = MONTHS.indexOf(hit.m.slice(0, 3).toLowerCase());
  const day = Number(hit.d);
  if (month < 0 || day < 1 || day > 31) return null;
  let year = hit.y ? Number(hit.y) : now.getFullYear();
  if (!hit.y && new Date(year, month, day).getTime() < now.getTime() - 31 * 86400000) year++;
  const d = new Date(year, month, day);
  if (d.getMonth() !== month) return null;
  return `${year}-${pad(month + 1)}-${pad(day)}`;
}

const strip = (s: string) => s.replace(/\s*\(?\bPM decides\b\)?[.:]?\s*$/i, "").replace(/[\s.;:,]+$/, "").trim();
const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, "")}…`);

/** The decision a "PM decides" item or line asks for, worded as the decision to make, and what the draft says about it. */
function decisionOf(text: string, identifier: string, now: Date): DraftDecision | null {
  const p = plain(text);
  const ss = sentencesOf(p);
  // 1. "PM decides: whether to …": the clause after it is the decision.
  const after = p.match(/PM decides\s*[:—–-]\s*(.+)$/i)?.[1] ?? "";
  let core = strip(sentencesOf(after)[0] ?? "");
  if (core.split(/\s+/).length < 3 || /^(?:yes|no|pursue|go|drop|flag)\b/i.test(core)) core = "";
  // 2. "Supports: how to position …. PM decides." or "Decision this draft supports: whether …".
  if (!core) {
    const label = p.match(/^(?:the\s+)?(?:decision[^:]{0,40}|supports|this supports|what this supports)\s*:\s*(.+)$/i)?.[1];
    if (label) core = strip(label.split(/\s*\(?\bPM decides\b/i)[0]!.split(/(?<=[.!?])\s+(?=[A-Z0-9(])/)[0]!);
  }
  // 3. The item's lead, its first sentence, with the options the draft gives when they fit.
  const options = ss.find((s) => /^options?\s*:/i.test(s));
  let withOptions = false;
  if (!core) {
    core = strip((ss[0] ?? "").replace(PM_DECIDES, ""));
    const both = options && core && !/^options?\s*:/i.test(core) ? `${core}. ${strip(options)}` : "";
    if (both && both.length <= 200 - 10 - identifier.length) { core = both; withOptions = true; }
  }
  // "Should we offer X?" is the decision whether to offer X.
  core = core.replace(/^(?:should|shall) we\s+(.+?)\??$/i, "whether to $1").replace(/^(whether\b.+?)\?$/i, "$1");
  if (!core) return null;
  const id = ` (${identifier})`;
  const verb = /^(?:whether|if|how|which|what|who|when|where|to|between)\b/i.test(core) ? "Decide " : "Decide: ";
  const body = cut(core.replace(/^./, (c) => (verb === "Decide " ? c.toLowerCase() : c)), 200 - verb.length - id.length);
  const why = ss.filter((s) => (!withOptions && /^options?\s*:/i.test(s)) || /^recommend(?:ation|ed|s)?\b/i.test(s)).map((s) => s.replace(/\s*PM decides\.?$/i, "").trim()).filter(Boolean).join(" ");
  return { text: `${verb}${body}${id}`, why: cut(why, 400), due: deadlineIn(p, now), key: keyOf("d", core) };
}

/** A question item: the question first (through its "?"), then the rest of what the draft says about it. */
function questionOf(text: string, where: DraftQuestion["where"]): DraftQuestion | null {
  const p = plain(text).replace(/^(?:Q\d+|blocking|open)\s*[:.)-]\s*/i, "");
  const ss = sentencesOf(p);
  if (!ss.length) return null;
  const q = ss.findIndex((s) => s.endsWith("?"));
  const upto = q >= 0 && q <= 1 ? q : 0;
  const question = ss.slice(0, upto + 1).join(" ");
  return { question, rest: ss.slice(upto + 1), where, key: keyOf("q", question) };
}

/**
 * Reads a draft's follow-ups. Calls: every item or line marked "PM decides" outside its question sections, and in them
 * a line that isn't a list item ("Supports: … PM decides") or an item that asks the PM to choose ("Should we …?").
 * Questions: every other top-level item in a section whose heading names questions or blocking ones, or listed under a
 * "Blocking:" line. A question marked "PM decides: pursue" is still a question: approving or dropping its task is the
 * decision.
 */
export function readFollowUps(markdown: string, identifier: string, now: Date): { decisions: DraftDecision[]; questions: DraftQuestion[] } {
  const doc = sections(markdown);
  const decisions: DraftDecision[] = [];
  const questions: DraftQuestion[] = [];
  const seen = new Set<string>();
  const add = <T extends { key: string }>(list: T[], x: T | null) => { if (x && !seen.has(x.key)) { seen.add(x.key); list.push(x); } };
  const all: { heading: string; blocks: Block[] }[] = [{ heading: "", blocks: blocksOf({ heading: "", lines: doc.intro }) }, ...doc.sections.map((s) => ({ heading: s.heading, blocks: blocksOf(s) }))];
  for (const s of all) {
    const areaOf = (h: string): DraftQuestion["where"] | null => (QUESTIONS.test(h) ? (/blocking/i.test(h) ? "blocking" : "open") : null);
    // Where list items are questions: the section's heading says so, or a `###` sub-heading under it does.
    let area = areaOf(plain(s.heading));
    let label: DraftQuestion["where"] | null = null;
    for (const b of s.blocks) {
      if (b.sub) { area = areaOf(plain(b.text)); label = null; continue; }
      if (!b.list) {
        const t = plain(b.text);
        if (LABEL.test(t)) { label = /blocking/i.test(t) ? "blocking" : "open"; continue; }
        label = null;
        if (PM_DECIDES.test(b.text)) add(decisions, decisionOf(b.text, identifier, now));
        continue;
      }
      const where = label ?? area;
      if (where) {
        const p = plain(b.text);
        const choice = CHOICE.test(p) || (!p.includes("?") && PM_DECIDES.test(p));
        if (choice) add(decisions, decisionOf(b.text, identifier, now));
        else add(questions, questionOf(b.text, where));
      } else if (PM_DECIDES.test(b.text)) add(decisions, decisionOf(b.text, identifier, now));
    }
  }
  return { decisions, questions };
}

/**
 * The kind of work that answers a follow-up question (FOLLOW-1). In order: a kind of work the draft names in the item
 * ("a validation plan"); for a question about commitment or payment, the validation plan; the next stage after the
 * task's own kind (a problem brief's questions go to research, then a spec; a competitive analysis's to research, then
 * validation); a kind of work in the next lifecycle stage, then the same one; and last the task's own kind. Only kinds
 * the team has count. Null when the team has none.
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
const COMMITMENT = /\b(?:commit(?:s|ted|ment|ments)?|pilots?|paid|pay(?:s|ing)?|purchases?|procurement|budget|conver(?:t|ts|ting|sion|sions))\b(?!-)/i;

export function followUpKind(text: string, own: string | null, kinds: string[], stages: Record<string, string | null> = {}): string | null {
  if (!kinds.length) return null;
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9-]+/g, " ")} `;
  const named = kinds.find((k) => lower.includes(` ${k} `) || lower.includes(` ${k.replace(/-/g, " ")} `));
  if (named) return named;
  if (COMMITMENT.test(text) && kinds.includes("validation-plan")) return "validation-plan";
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
interface Ledger { v: 1; drafts: Record<string, { at: string; made: string[]; left?: string[] }> }
export const followUpsFile = () => join(paths.staging(), "follow-ups.json");

export interface FollowUpResult {
  /** The team turned follow-ups off, or the draft isn't a document. */
  skipped: "off" | "no-draft" | null;
  todos: { id: string; text: string }[];
  proposals: { id: string; title: string; category: string }[];
  /** Made already when this draft was accepted before. */
  repeated: number;
  /** The same to-do is open, or a task with the same title is open or waiting. */
  duplicates: number;
  /** Questions whose words can't go to the tracker as written: a quote, a name, a meeting title, contact details, fundraising or a source repeated. */
  leftOut: number;
  /** Questions over FOLLOW_TASKS: they stay in the draft. */
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

const EMPTY = (skipped: FollowUpResult["skipped"], draft: string | null = null): FollowUpResult => ({ skipped, todos: [], proposals: [], repeated: 0, duplicates: 0, leftOut: 0, moreQuestions: 0, moreDecisions: 0, draft });

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
    `**Follows ${task.identifier}:** ${q.where === "blocking" ? "a blocking question" : "an open question"} its accepted draft left, in the team repo at ${path}.`,
    "**Size S, not checked:** PMX doesn't size follow-ups. Change the size if the work is bigger.",
    ...(based ? [based] : []),
    ...(sources.length ? ["", ...sources] : []),
  ].join("\n");
}

/**
 * FOLLOW-1: after a draft is accepted, its calls become the accepting PM's private to-dos and its open work becomes
 * suggested tasks waiting in Needs you. Never throws for a draft it can't read; the accept itself is already done.
 */
export async function followUpsOnAccept(ctx: Ctx, svc: Services, item: Pick<ReviewItem, "task" | "files" | "record" | "citations"> & { prUrl?: string }): Promise<FollowUpResult> {
  if (!followUpsOn(ctx.team)) return EMPTY("off");
  const draft = draftFile(item);
  if (!draft) return EMPTY("no-draft");
  const { task } = item;
  const now = ctx.now();
  const found = readFollowUps(draft.content, task.identifier, now);
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
  // Blocking questions first, then the open ones, each in the draft's order.
  const questions = fresh([...found.questions.filter((q) => q.where === "blocking"), ...found.questions.filter((q) => q.where !== "blocking")], "moreQuestions");

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

  // The open work: suggested tasks, staged like synthesis's and held to the same tracker-text rules (PRIV-6).
  if (questions.length) {
    const kinds = Object.keys(ctx.team.categories);
    const stages = Object.fromEntries((await skillInventory(ctx.personal.repoPath, ctx.team.categories).catch(() => [])).filter((s) => s.category).map((s) => [s.category!, s.check?.stage ?? null]));
    const names = await privateNames(ctx).catch(() => [] as string[]);
    // RUN-5: on a Mac that didn't suggest the task, its evidence pack is what the run quoted, so it guards the same way.
    const evidence = await runEvidence(ctx, task, store).catch(() => ({ sources: [], missing: [] }));
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
      // N5: everyone the sources name: their participants (on the Mac that has the files) and their speakers.
      people: sourcePeople(evidence, ctx.team.internalDomains),
      titles: (r?.sources ?? []).filter((s) => s.decision === "used" && s.kind === "transcript" && s.title).map((s) => s.title!),
      series: meetingSeries(ctx.team),
    };
    const tracker = trackerGuard({ ...rules, names });
    const ok = (s: string) => !tracker.problem(s) && !quotes.match(s);
    const taken = new Set([...(await svc.tracker.list()).filter((t) => t.status !== "done").map((t) => norm(t.title)), ...(await readProposals()).map((p) => norm(p.title))]);
    const from: Proposal["from"] = (r?.sources ?? []).filter((s) => s.decision === "used" && s.id && task.sources.includes(s.id) && s.at)
      .map((s) => ({ id: s.id!, title: s.title ?? s.id!, at: s.at!, why: `A source of ${task.identifier}` }));
    const staged: { q: DraftQuestion; p: Omit<Proposal, "id"> }[] = [];
    for (const q of questions) {
      if (staged.length >= FOLLOW_TASKS) { out.moreQuestions++; stay.push(q.key); continue; }
      // Not recorded as made, so accepting again says the same.
      if (!ok(q.question)) { out.leftOut++; continue; }
      const title = cut(q.question.replace(/\s+/g, " "), 120);
      if (taken.has(norm(title))) { out.duplicates++; done.push(q.key); continue; }
      const kind = followUpKind(q.question + " " + q.rest.join(" "), task.category, kinds, stages);
      if (!kind) continue;
      taken.add(norm(title));
      const rest = q.rest.filter(ok);
      staged.push({
        q, p: {
          at: now.toISOString(), receipt: receipt ?? "", title, description: describeFollowUp({ ...q, rest }, task, draft.path), category: kind, size: "S",
          sources: task.sources, from,
          follows: { identifier: task.identifier, path: draft.path, url: task.url || null, where: q.where, ...(item.prUrl && /^https?:\/\//.test(item.prUrl) ? { draft: item.prUrl } : {}) },
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

  if (done.length || stay.length) {
    await privateDir(paths.staging());
    await withLock(followUpsFile(), async () => {
      const l = (await readJson<Ledger>(followUpsFile())) ?? { v: 1, drafts: {} };
      const all = new Set([...(l.drafts[draftKey]?.made ?? []), ...done]);
      const left = [...new Set([...(l.drafts[draftKey]?.left ?? []), ...stay])].filter((k) => !all.has(k));
      l.drafts[draftKey] = { at: now.toISOString(), made: [...all], ...(left.length ? { left } : {}) };
      await writeJson(followUpsFile(), l, 0o600);
    });
  }
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What accepting made, in a PM's words, for every surface: "2 decisions added to your to-dos; 3 follow-up tasks wait
 * for your approval in Needs you." Empty when there was nothing to make. Never a command.
 */
export function followUpText(r: FollowUpResult | null): string {
  if (!r || r.skipped) return "";
  const parts = [
    r.todos.length ? `${plural(r.todos.length, "decision")} added to your to-dos` : "",
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
