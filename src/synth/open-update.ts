import { CANARY_REFUSAL, hasCanary } from "../core/canary.js";
import type { Ctx } from "../core/context.js";
import { writeReceipt, type OpenUpdated, type RunReceipt } from "../core/receipt.js";
import type { Services } from "../core/services.js";
import { sentencesIn } from "../core/tracker-text.js";
import type { CandidateTask, SignalItem, Task } from "../core/types.js";
import { markBlocks, type Look, type TaskMark } from "../lease/marks.js";
import type { LeaseInfo } from "../lease/types.js";
import { stageShares } from "../run/share.js";
import { companiesOf, mergeFacts, type Newer } from "./proposals.js";
import { anchorsOf, anchorWords, newerFigure, piecesOf, question, sameStems, statesFigure, type FigureUpdate } from "./repeats.js";
import { dateRange, groupsLine, mergeGroups, sourceGroups, type SourceGroup } from "./synthesize.js";

/**
 * INPUT-2 (founder decision, KP 2026-11-27): an open task takes a later call's newer facts. Before this, a need heard
 * again for a task already in Linear was only recorded as "heard again" on the PM's Mac, so a task that said "GPU cost
 * is 18% over budget" kept 18% after a call said 22%. Now, when synthesis finds a need already open as a task and its
 * new sources say something the task's description doesn't (the merge waiting suggestions use, `mergeFacts`, with a
 * newer date or figure for the same fact taking the older one's place):
 *
 * - a task in the backlog or Ready, that no agent has taken, gets the new facts in its description (a sentence a newer
 *   one supersedes is replaced, a new fact is added), its Sources line counts the new sources, each gets a `pmx:source`
 *   line under an ID the task's own synthesis run records (when that run is on this Mac), and its evidence pack is
 *   shared again with their quotes (RUN-5), plus one short comment that says what changed;
 * - a task an agent is drafting, whose draft is in review, or that is blocked gets the comment only, so nothing changes
 *   under the agent or the reviewer, and the reviewer still sees the newer figure;
 * - a done or canceled task gets nothing: R6's "done as PMX-5" rule covers it.
 *
 * Every sentence that changes goes through the run's tracker guard and quote rule first, with the new sources' people,
 * as a suggestion's does, and one that fails is left out. Only a description PMX wrote (a summary and its Sources line)
 * is changed. Through the Claude relay the rewrite and the comment are queued as ops, like other description changes.
 */

/** What PMX may do to an open task that a later call brings newer facts for. */
export type OpenStep = { how: "description" } | { how: "comment"; why: string } | { how: "none"; why: string };

/**
 * Where the task is, for the update: in the backlog or Ready with no agent on it (`description`); an agent drafting it,
 * its draft in review, blocked, or held where a person moved it in Linear (TASK-8) (`comment`); done or canceled
 * (`none`). A claim lease that hasn't expired counts as an agent drafting it, and the task's mark in the team repo
 * (PULL-14) counts while this Mac's copy of Linear can't show that step yet: a draft in review or rejected, done or
 * dropped.
 */
export function openStep(t: Task, o: { leases?: LeaseInfo[]; mark?: TaskMark | null; look?: Look | null; now: Date }): OpenStep {
  if (t.status === "done" || t.workflow?.type === "completed" || t.workflow?.type === "canceled") return { how: "none", why: "it's done" };
  const marked = o.mark && o.look && markBlocks(o.mark, o.look) ? o.mark.state : null;
  if (marked === "done" || marked === "dropped") return { how: "none", why: marked === "done" ? "it's done" : "it was dropped" };
  if (t.status === "review" || marked === "review") return { how: "comment", why: "its draft is in review" };
  const claimed = (o.leases ?? []).some((l) => l.taskId === t.id && Date.parse(l.expiresAt) > o.now.getTime());
  if (t.status === "claimed" || t.status === "running" || claimed || t.agent) return { how: "comment", why: "an agent is drafting it" };
  if (t.status === "blocked" || marked === "blocked") return { how: "comment", why: "it's blocked" };
  if (t.workflow?.held) return { how: "comment", why: "it's held in Linear" };
  if (t.status === "inbox" || t.status === "ready") return { how: "description" };
  return { how: "none", why: "PMX doesn't know its status" };
}

/** What a later run does to one open task. */
export interface OpenPlan {
  task: Task;
  step: Exclude<OpenStep, { how: "none" }>;
  /** The task's new description, or null for a comment only. */
  description: string | null;
  /** The comment, in PMX's words, with the changes; empty when it couldn't be said within the rules. */
  comment: string;
  /** What changed, as the comment says it: "GPU cost is now 22% over budget (was 18%)." */
  changes: string[];
  /** This run's IDs of the sources the task didn't have. */
  fresh: string[];
  /** The task's own synthesis run with the new sources it learns, written before the task changes; null for none. */
  own: RunReceipt | null;
  /** The new sources' IDs in the task's own run: its new `pmx:source` lines. */
  newIds: string[];
  /** Only the run's other facts changed it (`matchFacts`): a newer figure, not the same need heard again. */
  figure?: true;
}

/** PMX's Sources line in a description (`describe`): its parts, and what follows them. */
const SOURCES_PARTS = /^\*\*Sources:\*\* (.*?)\. They stay on the PM's Mac(.*)$/m;
/** At most this much of a comment is the changes, so it stays short. */
const COMMENT_MAX = 700;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const noStop = (s: string) => s.replace(/[\s.!?]+$/, "");

/**
 * "Nov 20", "Nov 18–21", "Nov 28–Dec 2" or "Dec 30, 2025–Jan 2, 2026" (`dateRange`), back as its first and last day.
 * A range without a year is this year's, or last year's for a month after this one.
 */
export function rangeDays(range: string, now: Date): [string, string] | null {
  const m = range.match(/^([A-Z][a-z]{2}) (\d{1,2})(?:, (\d{4}))?(?:–(?:([A-Z][a-z]{2}) )?(\d{1,2})(?:, (\d{4}))?)?$/);
  if (!m) return null;
  const m1 = MONTHS.indexOf(m[1]!), m2 = m[4] ? MONTHS.indexOf(m[4]) : m1;
  if (m1 < 0 || m2 < 0) return null;
  const d1 = Number(m[2]), d2 = m[5] ? Number(m[5]) : d1;
  const y2 = m[6] ? Number(m[6]) : m2 > now.getUTCMonth() ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const y1 = m[3] ? Number(m[3]) : m1 > m2 ? y2 - 1 : y2;
  const iso = (y: number, mo: number, d: number) => `${y}-${String(mo + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return [iso(y1, m1, d1), iso(y2, m2, d2)];
}

/**
 * The Sources line's parts with a later run's sources counted in (INPUT-2): a part of the same kind, company and place
 * ("2 threads in #launch (Nov 18–21)") counts them and spans their dates ("3 threads in #launch (Nov 18–26)"); the rest
 * join as parts of their own. A task in Linear keeps only the line, so its parts are read back from it.
 */
export function mergeSourcesLine(line: string, add: SourceGroup[], now: Date): string {
  const parts = line.split("; ");
  const extra: SourceGroup[] = [];
  for (const g of mergeGroups([], add)) {
    const at = parts.findIndex((p) => countOf(p, g) !== null);
    const was = at >= 0 ? countOf(parts[at]!, g)! : null;
    const days = was ? rangeDays(was.range, now) : null;
    if (!was || !days) { extra.push(g); continue; }
    const old = was.n === 1 ? [days[0]] : [days[0], ...Array.from({ length: was.n - 2 }, () => days[0]), days[1]];
    parts[at] = groupsLine([{ ...g, dates: [...old, ...g.dates] }]);
  }
  return [...parts, ...(extra.length ? [groupsLine(extra)] : [])].join("; ");
}

/** How many sources a part of the Sources line counts for a group, and its date range, or null when it isn't that group's. */
function countOf(part: string, g: SourceGroup): { n: number; range: string } | null {
  const m = part.match(/^(.*) \(([^()]*)\)$/);
  const head = m ? m[1]! : part;
  const range = m ? m[2]! : "";
  if (head === g.one) return { n: 1, range };
  const k = head.match(new RegExp(`^${escapeRe(g.many).replace("\\{n\\}", "(\\d+)")}$`));
  return k ? { n: Number(k[1]), range } : null;
}

/** "a call", "2 calls and a thread", "an internal meeting": the new sources, by kind, never by name. */
function fromWords(items: SignalItem[]): string {
  const n = { call: 0, meeting: 0, thread: 0 };
  for (const i of items) {
    if (i.kind === "transcript") { if (i.series) n.meeting++; else n.call++; }
    else n.thread++;
  }
  const parts = ([[n.call, "a call", "calls"], [n.meeting, "an internal meeting", "internal meetings"], [n.thread, "a thread", "threads"]] as const)
    .filter(([k]) => k > 0).map(([k, one, many]) => (k === 1 ? one : `${k} ${many}`));
  return parts.length <= 2 ? parts.join(" and ") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** A newer sentence as the comment says it: "GPU cost is now 22% over budget (was 18%)." */
function newerText(r: Newer): string {
  // In the later source's words when the task kept its own, with the figure it replaced, unless those words say it
  // already ("…22% over plan, up from 18% earlier in the month").
  const text = r.said ?? r.now;
  const now = new Set(anchorWords(text).map((a) => a.key));
  const old = (r.figures ?? [...new Map(anchorWords(r.was).map((a) => [a.key, a.text])).values()]).filter((f) => !anchorWords(f).some((a) => now.has(a.key)));
  return old.length ? `${noStop(text)} (was ${old.join(", ")}).` : text;
}

/**
 * The sources (this run's IDs) new to an open task: by their files, where the task's own run (`own`) says which its
 * sources are; without it, every one. A source cited twice counts once.
 */
export function newSources(task: Pick<Task, "sources">, ids: string[], run: Pick<RunReceipt, "sources">, own: RunReceipt | null, items?: SignalItem[]): string[] {
  const out: string[] = [];
  const hashes = new Set<string>();
  for (const id of [...new Set(ids)]) {
    if (items && !items.some((i) => i.id === id)) continue;
    const src = run.sources.find((x) => x.decision === "used" && x.id === id);
    if (src) {
      if (hashes.has(src.refHash)) continue;
      hashes.add(src.refHash);
      const known = own?.sources.find((x) => x.decision === "used" && x.id && x.refHash === src.refHash);
      if (known && task.sources.includes(known.id!)) continue;
    }
    out.push(id);
  }
  return out;
}

/** A sentence from the run's other work that gives an open task a newer figure (`matchFacts`), and the sources that state it. */
export interface Fact { sentence: string; sources: string[] }

/** A task's summary sentences, without PMX's own lines after it. */
const summaryOf = (t: Pick<Task, "description">) => sentencesIn((t.description.split("\n\n")[0] ?? "").replace(/\s+/g, " ").trim());

/**
 * INPUT-2 (rig test of #127, 2026-11-27): a newer figure reaches the open tasks it's about even when synthesis didn't
 * match the need to them. Live, a thread's "GPU costs are running 22% over budget this month" went into a new decision
 * brief, so the open task that said 18% kept it. For each sentence of the run's candidates (`cands`: their rationales,
 * already through the tracker guard) that states a figure, every open task whose summary has a sentence about the same
 * measure with an older figure (`newerFigure`, figures only: the same subject, the same unit, nothing that tells them
 * apart) gets it, so a second task that says the same 18% isn't left stale. A sentence's own matched task (`heard`)
 * takes it in its merge instead. Only tasks PMX wrote (a Sources line) that aren't done (`openStep`). The sources are
 * the candidate's that state the figure, or all of them when none does as written. `left`: tasks that state the same
 * older figure in a sentence sharing words with it but aren't plainly about the same measure, so the answer says why
 * they weren't changed.
 */
export function matchFacts(o: { tasks: Task[]; cands: CandidateTask[]; heard: Map<string, CandidateTask[]>; items: SignalItem[]; now: Date }): { facts: Map<string, Fact[]>; left: { identifier: string; was: string; sentence: string }[] } {
  const facts = new Map<string, Fact[]>();
  const left: { identifier: string; was: string; sentence: string }[] = [];
  const open = o.tasks.filter((t) => SOURCES_PARTS.test(t.description) && openStep(t, { now: o.now }).how !== "none");
  const byId = new Map(o.items.map((i) => [i.id, i]));
  for (const c of o.cands) {
    const mine = new Set([...o.heard].filter(([, cs]) => cs.includes(c)).map(([id]) => id));
    const named = Object.values(c.companies ?? {}).map((x) => x.name);
    for (const s of sentencesIn(c.rationale)) {
      if (!anchorsOf(s).figures.size) continue;
      const hits = open.map((t) => ({ t, u: figureFor(t, s, [...companiesOf({ description: t.description }), ...named]) }));
      const matched = hits.filter((x) => x.u && !mine.has(x.t.identifier));
      for (const { t, u } of matched) {
        const digits = u!.now.replace(/[^\d.]/g, "");
        const stating = c.sources.filter((id) => new RegExp(`(?<![\\p{N}.,])${digits.replace(".", "\\.")}(?![\\p{N}])`, "u").test(byId.get(id)?.text ?? ""));
        facts.set(t.identifier, [...(facts.get(t.identifier) ?? []), { sentence: s, sources: stating.length ? stating : c.sources }]);
      }
      // The same older figure, said of something that may be the same: why it wasn't changed is said.
      const olds = new Set(hits.filter((x) => x.u).map((x) => x.u!.was));
      const words = sameStems(s);
      for (const { t, u } of hits) {
        if (u || mine.has(t.identifier)) continue;
        const near = summaryOf(t).find((x) => [...olds].some((w) => statesFigure(x, w)) && [...sameStems(x)].some((w) => words.has(w)));
        if (near) left.push({ identifier: t.identifier, was: [...olds].find((w) => statesFigure(near, w))!, sentence: s });
      }
    }
  }
  return { facts, left };
}

/** The newer figure a sentence gives for one of an open task's summary sentences, or null. */
function figureFor(t: Task, s: string, companies: string[]): FigureUpdate | null {
  let best: FigureUpdate | null = null;
  for (const x of summaryOf(t)) {
    for (const p of question(x) ? [] : piecesOf(x)) {
      for (const q of question(s) ? [] : piecesOf(s)) {
        const u = newerFigure(p.text, q.text, companies);
        if (u && (!best || u.subject > best.subject)) best = u;
      }
    }
  }
  return best;
}

/**
 * What a later run's candidates (`cands`, the same need as the open task) do to it, or null when nothing changes: its
 * description isn't PMX's (no Sources line), none of their sources is new to it, or nothing they say is new once each
 * changed sentence has been through `check` (the run's tracker guard and quote rule). `own`: the task's own synthesis
 * run, when it's on this Mac and the task cites it directly (not a draft's follow-up), so its new sources get IDs there.
 */
export function planOpenUpdate(o: {
  task: Task; step: Exclude<OpenStep, { how: "none" }>; cands: CandidateTask[]; facts?: Fact[]; items: SignalItem[];
  run: Pick<RunReceipt, "id" | "sources">; own: RunReceipt | null; check: (s: string) => boolean; now: Date;
}): OpenPlan | null {
  const { task } = o;
  const line = task.description.match(SOURCES_PARTS);
  if (!line) return null;
  const byId = new Map(o.items.map((i) => [i.id, i]));
  const used = (id: string) => o.run.sources.find((x) => x.decision === "used" && x.id === id);
  // The sources it didn't have: a repeat with none brings it nothing, and only a new source can bring a newer figure.
  const heardFresh = newSources(task, o.cands.flatMap((c) => c.sources), o.run, o.own, o.items);
  const facts = (o.facts ?? []).filter((f) => newSources(task, f.sources, o.run, o.own, o.items).length);
  if (!heardFresh.length && !facts.length) return null;

  const named = Object.fromEntries([...o.cands].flatMap((c) => Object.entries(c.companies ?? {})));
  const companies = [...new Set([...companiesOf({ description: task.description }), ...Object.values(named).map((c) => c.name)])];
  // R12b: a summary that synthesis led with its title says nothing new by that.
  const later = heardFresh.length ? o.cands.flatMap((c) => sentencesIn(c.rationale).filter((x) => noStop(x) !== noStop(c.title.trim()))) : [];
  const m = mergeFacts(task.description, later.join(" "), undefined, companies, { newer: true, facts: facts.map((f) => f.sentence) });
  // A sentence that can't go to Linear is left out: the one it would replace stays as it was.
  const sentences = [...m.sentences];
  const keep = (r: Newer) => {
    if (o.check(r.now) && (!r.said || o.check(r.said))) return true;
    sentences[sentences.indexOf(r.now)] = r.was;
    return false;
  };
  const newer = m.newer.filter(keep);
  const fuller = m.fuller.filter(keep);
  const added = m.added.filter((s) => {
    if (o.check(s)) return true;
    sentences.splice(sentences.indexOf(s), 1);
    return false;
  });
  if (!newer.length && !fuller.length && !added.length) return null;
  const changes = [...newer.map(newerText), ...fuller.map((r) => r.now), ...added];
  // The run's other facts that took: their sources are the task's too.
  const took = new Set(newer.map((r) => r.from).filter((x): x is string => !!x));
  const fromFacts = facts.filter((f) => took.has(f.sentence));
  const heardChanged = newer.some((r) => !r.from || !fromFacts.some((f) => f.sentence === r.from)) || fuller.length > 0 || added.length > 0;
  const fresh = newSources(task, [...(heardChanged ? heardFresh : []), ...fromFacts.flatMap((f) => f.sources)], o.run, o.own, o.items);
  if (!fresh.length) return null;

  let description: string | null = null;
  let own: RunReceipt | null = null;
  const newIds: string[] = [];
  if (o.step.how === "description") {
    // The task's own run learns the new sources, with IDs after its own (as `addEvidence` does for a waiting one).
    const ids = new Map<string, string>();
    if (o.own) {
      const run = structuredClone(o.own);
      const top: Record<string, number> = {};
      for (const x of run.sources) { const k = x.id?.match(/^([A-Z])(\d+)$/); if (k) top[k[1]!] = Math.max(top[k[1]!] ?? 0, Number(k[2])); }
      for (const id of fresh) {
        const src = used(id);
        if (!src) continue;
        const known = run.sources.find((x) => x.decision === "used" && x.id && x.refHash === src.refHash);
        if (known) { ids.set(id, known.id!); continue; }
        const prefix = id.match(/^[A-Z]/)?.[0] ?? "T";
        const next = `${prefix}${(top[prefix] = (top[prefix] ?? 0) + 1)}`;
        run.sources.push({ ...src, id: next, addedFrom: o.run.id });
        ids.set(id, next);
        own = run;
      }
    }
    for (const x of ids.values()) if (!task.sources.includes(x) && !newIds.includes(x)) newIds.push(x);
    const groups = fresh.flatMap((id) => sourceGroups({ sources: [id], companies: named }, o.items));
    const [, ...rest] = task.description.split("\n\n");
    let d = [sentences.join(" "), ...rest].join("\n\n");
    d = d.replace(SOURCES_PARTS, (_m, old: string, tail: string) => `**Sources:** ${mergeSourcesLine(old, groups, o.now)}. They stay on the PM's Mac${tail}`);
    const lines = newIds.map((x) => {
      const from = [...ids].find(([, v]) => v === x)?.[0];
      const item = from ? byId.get(from) : undefined;
      return `pmx:source ${x}${item?.kind === "slack" ? ` ${item.ref}` : ""}`;
    });
    description = lines.length ? `${d.replace(/\s+$/, "")}${/(^|\n)pmx:source /.test(d) ? "\n" : "\n\n"}${lines.join("\n")}` : d;
  }

  // One short comment, in PMX's words around the changes, which passed the guard; checked whole too.
  const items = fresh.map((id) => byId.get(id)!);
  const what = fromWords(items);
  const when = dateRange(items.map((i) => i.at));
  const said: string[] = [];
  for (const c of changes) if ([...said, c].join(" ").length <= COMMENT_MAX || !said.length) said.push(c);
  const comment = o.step.how === "description"
    ? `Updated from ${what}${when ? ` on ${when}` : ""}: ${said.join(" ")}`
    : `${what.charAt(0).toUpperCase()}${what.slice(1)}${when ? ` on ${when}` : ""} brought newer facts: ${said.join(" ")} PMX left the description as it is while ${o.step.why}.`;
  const ok = sentencesIn(comment).every(o.check);
  if (!ok && !description) return null;
  return { task, step: o.step, description, comment: ok ? comment : "", changes, fresh, own, newIds, ...(heardChanged ? {} : { figure: true as const }) };
}

/**
 * Writes one open task's update (INPUT-2): the task's own run learns its new sources first, then the description is
 * rewritten (`svc.tracker.rewrite`; through the Claude relay, a queued `rewrite` op), the comment added (a `comment` op),
 * and the task staged for its evidence pack again (RUN-5), keeping the quotes of sources this Mac can no longer read.
 * Refuses a canary (FLOW-3) before anything is written.
 */
export async function applyOpenUpdate(ctx: Pick<Ctx, "team" | "now">, svc: Pick<Services, "tracker">, p: OpenPlan): Promise<void> {
  if (hasCanary(JSON.stringify({ d: p.description, c: p.comment }))) throw new Error(CANARY_REFUSAL);
  if (p.description !== null) {
    if (p.own) await writeReceipt(p.own, ctx.now());
    await svc.tracker.rewrite(p.task.id, { description: p.description });
  }
  if (p.comment) await svc.tracker.comment(p.task.id, p.comment);
  if (p.description !== null && p.newIds.length) {
    await stageShares(ctx, [{ identifier: p.task.identifier, title: p.task.title, description: p.description, sources: [...new Set([...p.task.sources, ...p.newIds])], keep: true }]);
  }
}

/** What the receipt keeps of an update (`TaskReceipt.posted.updated`), for `pmx explain`. */
export function updatedRecord(p: OpenPlan, queued: boolean): OpenUpdated {
  return { how: p.step.how, changes: p.changes, sources: p.fresh.length, ...(p.step.how === "comment" ? { why: p.step.why } : {}), ...(queued ? { queued: true } : {}), ...(p.comment ? {} : { noComment: true }), ...(p.figure ? { figure: true } : {}) };
}
