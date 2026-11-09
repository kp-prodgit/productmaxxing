import type { Ctx } from "../core/context.js";
import { totalHeld } from "../core/filter.js";
import { DATA_RULES, dataBlock } from "../core/prompt.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { Services } from "../core/services.js";
import { createHash } from "node:crypto";
import { newReceiptId, writeReceipt, type RunReceipt, type SizeFlag, type Sizing, type TaskReceipt } from "../core/receipt.js";
import { parseRubric, type SizeRubric } from "../core/skillcheck.js";
import { categoryMenu, loadSkill, skillBody, SKILL_USES } from "../core/skills.js";
import { updateState } from "../core/state.js";
import { SIZES, type CandidateTask, type SignalItem, type Size } from "../core/types.js";
import { checkBudget, recordSpend } from "../budget/provider.js";
import { gather } from "../digest/gather.js";
import { planMeetings, startOfDay } from "../meetings/ledger.js";
import type { MeetingEntry } from "../tracker/types.js";
import { addEvidence, readProposals, stageProposals } from "./proposals.js";
import { knownBlock, matchKnown, sameTitle, type Known } from "./dedup.js";

export interface SynthResult {
  /** Dry run: what would be proposed. */
  posted: { identifier: string; title: string }[];
  /** Proposed tasks waiting for the PM's approval (APPROVE-1). Nothing reaches the tracker before that. */
  staged: { id: string; title: string }[];
  skipped: string[];
  held: number;
  /** The meeting ledger (MEET-2): lodged and finished now, already done by someone, claimed elsewhere, before the window. */
  meetings: { processed: { entry: string; tasks: string[] }[]; already: number; busy: number; before: number };
}

/** Model output derived from source text stays on one line, so it can never start a `pmx:` control line. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();


const cellKey = (s: string) => s.toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

/**
 * Checks the model's size against the rubric (PRIV-4, sizing): the cell it quotes must be the rubric's
 * cell for that category and size, and countable categories must cite a fitting number of sources.
 * Disagreements are flags for the human at triage; they never drop a task.
 */
export function checkSizing(t: { category: string; size: Size; sources: string[] }, raw: unknown, rubric?: SizeRubric): Sizing {
  const given = raw && typeof raw === "object" ? (raw as { cell?: unknown; why?: unknown }) : {};
  const cell = given.cell ? oneLine(String(given.cell)).slice(0, 200) : null;
  const why = given.why ? oneLine(String(given.why)).slice(0, 300) : "";
  const expectedCell = rubric?.cells[t.category]?.[t.size] ?? null;
  const flags: SizeFlag[] = [];
  if (!why) flags.push("no-reason");
  if (cell && expectedCell && cellKey(cell) !== cellKey(expectedCell)) flags.push("cell-mismatch");
  const range = rubric?.ranges[t.category]?.[t.size];
  if (range) {
    const [min, max] = range;
    if (t.sources.length < min) flags.push("count-below");
    if (max !== null && t.sources.length > max) flags.push("count-above");
  }
  return { cell, expectedCell, why, flags };
}

/**
 * Rules PMX adds to every synthesis prompt, whatever the team's copy of the skill says (PRIV-6): the description is
 * all a teammate sees in the tracker, so it's a summary, never the transcript.
 */
export const OUTPUT_RULES = `## Rules PMX enforces
- \`rationale\` is the task's whole description in the tracker: two to four sentences, in your own words, on what the task needs and why. Never quote a source. No names, speaker labels (like "Microphone:"), transcript lines or anything said about a person.
- Cite only sources that directly support the task. One source is fine; never add an unrelated one.
- Give \`support\`: an object with one sentence per cited source ID on how that source supports the task. PMX drops any source without one, and any task left with none.`;

/** "Microphone:", "System audio:", "Speaker 2:", "[00:12:03]": transcript markup that must never reach the tracker. */
const TRANSCRIPT_MARKS = /\b(microphone|system audio|speaker \d+)\s*:|\[\d{1,2}:\d{2}(:\d{2})?\]/i;
const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * Whether `text` repeats a source: eight or more words in a row from any source, or transcript markup (PRIV-6).
 * Model-written text can echo what it read, so this is checked in code, not left to the prompt.
 */
export function quotesSource(text: string, sources: string[], run = 8): boolean {
  if (TRANSCRIPT_MARKS.test(text)) return true;
  const w = words(text);
  if (w.length < run) return false;
  const grams = new Set<string>();
  for (let i = 0; i + run <= w.length; i++) grams.add(w.slice(i, i + run).join(" "));
  return sources.some((src) => {
    const s = words(src);
    for (let i = 0; i + run <= s.length; i++) if (grams.has(s.slice(i, i + run).join(" "))) return true;
    return false;
  });
}

export const FLAG_TEXT: Record<SizeFlag, string> = {
  "no-reason": "the model gave no reason for this size",
  "cell-mismatch": "the rubric cell it quoted isn't the one for this category and size",
  "count-below": "it cites fewer sources than this size expects",
  "count-above": "it cites more sources than this size expects",
};

/** Pulls the JSON object out of the model's reply and validates every task against team config. */
export function parseCandidates(text: string, categories: string[], validIds: Set<string>, rubric?: SizeRubric, sourceText: Map<string, string> = new Map()): { tasks: CandidateTask[]; skipped: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("Synthesis returned no JSON.");
  const raw = JSON.parse(text.slice(start, end + 1));
  const tasks: CandidateTask[] = [];
  const skipped: string[] = [];
  for (const t of (raw.tasks ?? []).slice(0, 10)) {
    const title = oneLine(String(t.title ?? "")).slice(0, 120);
    // A source counts only with a reason it supports this task (PRIV-6), so an unrelated meeting isn't cited to fill space.
    const support = t.support && typeof t.support === "object" ? (t.support as Record<string, unknown>) : {};
    const cited = [...new Set((Array.isArray(t.sources) ? t.sources : []).map(String).filter((id: string) => validIds.has(id)))] as string[];
    const sources = cited.filter((id) => oneLine(String(support[id] ?? "")).length >= 10);
    const rationale = oneLine(String(t.rationale ?? "")).slice(0, 1000);
    if (!title) { skipped.push("untitled task"); continue; }
    if (!categories.includes(t.category)) { skipped.push(`${title}: unknown category ${t.category}`); continue; }
    if (!SIZES.includes(t.size)) { skipped.push(`${title}: bad size ${t.size}`); continue; }
    if (!sources.length) { skipped.push(`${title}: ${cited.length ? "no source has a reason it supports the task" : "no valid sources"}`); continue; }
    const all = [...sourceText.values()];
    if (quotesSource(`${title} ${rationale}`, all)) { skipped.push(`${title}: its text repeats a meeting word for word, and the tracker gets summaries only`); continue; }
    const dropped = cited.filter((id) => !sources.includes(id));
    if (dropped.length) skipped.push(`${title}: dropped source(s) ${dropped.join(", ")} with no reason they support it`);
    const sizing = checkSizing({ category: t.category, size: t.size, sources }, t.sizing, rubric);
    const sameAs = typeof t.sameAs === "string" && /^[\w-]{2,40}$/.test(t.sameAs) ? t.sameAs : null;
    tasks.push({ title, category: t.category, size: t.size as Size, rationale, sources, sizing, support: Object.fromEntries(sources.map((id) => [id, oneLine(String(support[id])).slice(0, 300)])), ...(sameAs ? { sameAs } : {}) });
  }
  return { tasks, skipped };
}

/**
 * The task description (PRIV-6): the model's summary, why it's this size, and when the sources were, never what they
 * said or what they were called. Which meetings they were stays in the PM's receipt on their Mac.
 */
export function describe(c: CandidateTask, items: SignalItem[], receiptId?: string): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const srcs = c.sources.map((id) => byId.get(id)!);
  const meetings = srcs.filter((i) => i.kind === "transcript").length;
  const threads = srcs.length - meetings;
  const kinds = [meetings ? `${meetings === 1 ? "one meeting" : `${meetings} meetings`}` : "", threads ? `${threads === 1 ? "one channel thread" : `${threads} channel threads`}` : ""].filter(Boolean).join(" and ");
  const days = [...new Set(srcs.map((i) => i.at.slice(0, 10)))].sort().join(", ");
  const sz = c.sizing;
  const why = sz
    ? [`**Why size ${c.size}:** ${sz.cell ?? "no rubric cell given"}${sz.why ? `. ${sz.why}` : ""}`, ...sz.flags.map((f) => `**Check the size:** ${FLAG_TEXT[f]}.`), ""]
    : [];
  const based = `**Based on** ${kinds} (${days}). The sources stay on the PM's Mac${receiptId ? `: \`pmx explain ${receiptId}\` there shows them` : ""}.`;
  return [c.rationale, "", ...why, based, "", ...c.sources.map((id) => `pmx:source ${id} ${byId.get(id)!.kind === "slack" ? byId.get(id)!.ref : ""}`.trim())].join("\n");
}

/**
 * `pmx synthesize` (SIG-2, SIG-4). Reads team sources with no tools and proposes sized tasks. They wait on this Mac
 * until the PM approves them (APPROVE-1); only then do they go to the PMX project's inbox, and a human triages
 * before anything runs (SEC-2).
 */
export async function synthesize(
  ctx: Ctx, svc: Services,
  o: { days: number; dryRun?: boolean; since?: Date; skipIfNothingNew?: boolean },
): Promise<SynthResult> {
  const g = await gather(ctx, { days: o.days, scope: "team" });
  // Without `since`, the whole `days` window counts; the CLI and the polling step pass `since` (MEET-3).
  const since = o.since ?? startOfDay(ctx.now(), o.days);
  const receipt: RunReceipt = {
    v: 1, id: newReceiptId("synthesize", ctx.now()), type: "synthesize", at: ctx.now().toISOString(), agent: ctx.agent, dryRun: !!o.dryRun,
    outcome: "no-signal", ...g.receipt, skills: [], model: null,
  };
  const result0: SynthResult = { posted: [], staged: [], skipped: [], held: totalHeld(g.held), meetings: { processed: [], already: 0, busy: 0, before: 0 } };

  // The team's meeting ledger (MEET-2) lives in the PMX repo (PRIV-7). Markers older versions put in Linear still count.
  const legacy = await svc.tracker.listMeetings().catch(() => [] as MeetingEntry[]);
  const plan = planMeetings(g.items, [...(await svc.meetings.list()), ...legacy.filter((e) => e.status === "done")], since);
  const mark = (item: SignalItem, state: NonNullable<RunReceipt["sources"][number]["ledger"]>["state"], entry: string | null) => {
    const src = receipt.sources.find((x) => x.id === item.id);
    if (src) src.ledger = { state, entry };
  };
  for (const a of plan.already) mark(a.item, "already-processed", a.entry.identifier);
  for (const b of plan.before) mark(b, "before-window", null);
  result0.meetings.already = plan.already.length;
  result0.meetings.before = plan.before.length;

  // Before anything is claimed or lodged, so a paused budget leaves no meeting half-processed (BUDGET-2).
  if (plan.fresh.length || (!o.skipIfNothingNew && plan.other.length)) await checkBudget(ctx);
  // Nothing about a meeting goes to Linear: it's claimed with the lease while it's processed, and recorded in the
  // PMX repo once done (PRIV-7).
  const lodged: { item: SignalItem; lease: string }[] = [];
  if (o.dryRun) for (const f of plan.fresh) mark(f.item, "would-process", null);
  else {
    for (const f of plan.fresh) {
      const lease = `meeting-${f.item.keys![0]}`;
      const got = await svc.lease.acquire(lease, ctx.agent, 1800);
      if (!got.ok) {
        mark(f.item, "in-progress-elsewhere", null);
        result0.meetings.busy++;
        continue;
      }
      mark(f.item, "processed-now", null);
      lodged.push({ item: f.item, lease });
    }
  }
  const work = [...plan.other, ...(o.dryRun ? plan.fresh.map((f) => f.item) : lodged.map((l) => l.item))];
  const release = async () => {
    for (const l of lodged) await svc.lease.release(l.lease, ctx.agent).catch(() => false);
  };
  // Polling (MEET-3): with nothing new, no model call and no receipt.
  if (o.skipIfNothingNew && !lodged.length && !(o.dryRun && plan.fresh.length)) return result0;
  if (!work.length) {
    await writeReceipt(receipt, ctx.now());
    return result0;
  }

  const [synthName, sizeName] = SKILL_USES.synthesize;
  const synth = await loadSkill(ctx.personal.repoPath, synthName);
  const rubric = await loadSkill(ctx.personal.repoPath, sizeName);
  receipt.skills = [
    { name: synthName, version: synth.version, source: synth.source },
    { name: sizeName, version: rubric.version, source: rubric.source },
  ];
  const categories = Object.keys(ctx.team.categories);
  const { tag, block } = dataBlock(work);
  // What's already open or waiting, so a need heard again from another source isn't a second task (INPUT-2).
  const open = (await svc.tracker.list()).filter((t) => t.status !== "done");
  const known: Known[] = [
    ...(await readProposals()).map((p) => ({ id: p.id, title: p.title, where: "waiting" as const })),
    ...[...open].sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).map((t) => ({ id: t.identifier, title: t.title, where: "tracker" as const })),
  ];
  const prompt = [
    skillBody(synth.text),
    "",
    "## Size rubric",
    skillBody(rubric.text),
    "",
    await categoryMenu(ctx.personal.repoPath, ctx.team.categories),
    OUTPUT_RULES,
    knownBlock(known),
    DATA_RULES(tag),
    "",
    block,
  ].join("\n");

  const result = await ctx.runtime.run({ team: ctx.team, cwd: ctx.personal.repoPath, prompt, tools: [], maxTurns: 1 });
  await updateState((s) => recordSpend(s, ctx.personal, ctx.now(), result.costUsd, result.tokens));
  receipt.model = {
    name: ctx.team.model, runtime: ctx.runtime.name, tools: "none: no files, no web, no personal Claude settings",
    costUsd: result.costUsd, tokens: result.tokens, durationMs: result.durationMs, promptSha256: createHash("sha256").update(prompt).digest("hex"),
  };
  if (!result.ok) {
    await writeReceipt({ ...receipt, outcome: "failed", error: result.error ?? "unknown" }, ctx.now());
    // Not recorded as done, so the next pass retries these meetings.
    await release();
    throw new Error(`Synthesis run failed: ${result.error ?? "unknown"}`);
  }

  const { tasks, skipped } = parseCandidates(result.text, categories, new Set(work.map((i) => i.id)), parseRubric(rubric.text), new Map(work.map((i) => [i.id, i.text])));
  const posted: SynthResult["posted"] = [];
  const bySource = new Map<string, number>();
  // Where each task went, for the receipt and the flow view (FLOW-1).
  const went = new Map<CandidateTask, NonNullable<TaskReceipt["posted"]>>();
  const fresh: CandidateTask[] = [];
  const folded = new Set<CandidateTask>();
  const byId = new Map(work.map((i) => [i.id, i]));
  const fromOf = (c: CandidateTask) => c.sources.map((id) => ({ id, title: byId.get(id)!.title, at: byId.get(id)!.at, why: c.support?.[id] ?? "" }));
  for (const c of tasks) {
    // Two tasks from this run for one need become one: the second's sources go to the first.
    const twin = fresh.find((f) => sameTitle(f.title, c.title));
    if (twin) { twin.sources = [...new Set([...twin.sources, ...c.sources])]; twin.support = { ...c.support, ...twin.support }; folded.add(c); skipped.push(`${c.title}: the same need as "${twin.title}" in this run, so its sources were added there`); continue; }
    const hit = matchKnown(c, known);
    if (hit?.where === "tracker") { skipped.push(`${c.title}: already open as ${hit.id}; heard again in ${c.sources.length} more source(s)`); went.set(c, { duplicateOf: hit.id }); continue; }
    if (hit?.where === "waiting" && !o.dryRun) {
      const merged = await addEvidence(hit.id, { receipt: receipt.id, from: fromOf(c), days: c.sources.map((id) => byId.get(id)!.at.slice(0, 10)) });
      if (merged) { skipped.push(`${c.title}: the same need as a proposal already waiting, so its sources were added to it`); went.set(c, { mergedInto: hit.id }); continue; }
    }
    if (o.dryRun) { posted.push({ identifier: "(dry run)", title: c.title }); went.set(c, { dryRun: true }); continue; }
    fresh.push(c);
  }
  // APPROVE-1: proposals wait on this Mac, exactly as they'd be written, until the PM approves them.
  const staged = await stageProposals(fresh.map((c) => ({
    at: ctx.now().toISOString(), receipt: receipt.id, title: c.title, description: describe(c, work, receipt.id), category: c.category, size: c.size, sources: c.sources,
    from: fromOf(c),
  })));
  for (const c of fresh) {
    const s = staged.find((p) => p.title === c.title);
    if (!s) { skipped.push(`${c.title}: already waiting for your approval`); continue; }
    went.set(c, { staged: s.id });
    for (const id of c.sources) bySource.set(id, (bySource.get(id) ?? 0) + 1);
  }
  // Record each meeting as done in the team's ledger (MEET-2), with only how many tasks it led to.
  for (const l of lodged) {
    const made = bySource.get(l.item.id) ?? 0;
    await svc.meetings.done({ keys: l.item.keys!, at: l.item.at.slice(0, 10), agent: ctx.agent, tasks: made });
    result0.meetings.processed.push({ entry: l.item.keys![0]!, tasks: [] });
  }
  await release();

  receipt.outcome = o.dryRun ? "dry-run" : staged.length ? "staged" : "posted";
  receipt.synth = { tasks: tasks.filter((c) => !folded.has(c)).map((c) => ({ title: c.title, category: c.category, size: c.size, sources: c.sources, sizing: c.sizing ?? null, ...(went.get(c) ? { posted: went.get(c) } : {}) })), skipped };
  await writeReceipt(receipt, ctx.now());
  if (!o.dryRun) {
    await updateState((s) => (s.lastSynthAt = ctx.now().toISOString()));
    await new RunLogStore(ctx).record({
      type: "synthesize", agent: ctx.agent, machine: ctx.personal.machineId, receipt: receipt.id, posted: staged.length, held: totalHeld(g.held),
      durationMs: result.durationMs, tokens: result.tokens, costUsd: result.costUsd,
    });
  }
  return { ...result0, posted, staged: staged.map((p) => ({ id: p.id, title: p.title })), skipped };
}
