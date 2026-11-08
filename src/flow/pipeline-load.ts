import { neededTasks, nextCronTime, taskRunHealth, taskState } from "../claude/tasks.js";
import { budget, budgetBlock } from "../budget/provider.js";
import { tickHealth } from "../commands/tick.js";
import type { Ctx } from "../core/context.js";
import type { Keychain } from "../core/keychain.js";
import { listReceipts, readReceipt, type RunReceipt } from "../core/receipt.js";
import { RunLogStore } from "../core/runlog-store.js";
import { verify, type RunLogEntry } from "../core/runlog.js";
import { parseRubric } from "../core/skillcheck.js";
import { loadSkill, skillInventory } from "../core/skills.js";
import { loadState } from "../core/state.js";
import { SIZES, type Size } from "../core/types.js";
import { privacyRules } from "../digest/gather.js";
import { linearAccess } from "../linear/access.js";
import { readProposals } from "../synth/proposals.js";
import { loadTodos } from "../todo/todo.js";
import { kindOf, toTask } from "../tracker/linear.js";
import { overlay, readOutbox, readResolved, readSnapshot, relayHealth } from "../tracker/relay.js";
import { buildFlowGraph } from "./graph.js";
import { buildPipeline, rubricFor, type HealthProblem, type PipelineData, type PipelineLevel } from "./pipeline.js";
import { pendingTeamPrs } from "./team-prs.js";

// The run log lives on a git branch; the artifact polls every minute, so it's fetched at most once a minute.
let runlogCache: { at: number; repo: string; entries: RunLogEntry[] | null } | null = null;
async function runlog(ctx: Pick<Ctx, "team" | "personal" | "repo" | "exec" | "agent" | "now">): Promise<RunLogEntry[] | null> {
  if (runlogCache && runlogCache.repo === ctx.personal.repoPath && Date.now() - runlogCache.at < 60000) return runlogCache.entries;
  const store = new RunLogStore(ctx as Ctx);
  const entries = (await store.exists().catch(() => false)) ? await store.entries().catch(() => null) : null;
  runlogCache = { at: Date.now(), repo: ctx.personal.repoPath, entries };
  return entries;
}

const hm = (iso: string | null) => (iso ? new Date(iso).toTimeString().slice(0, 5) : null);
/** Messages written for Terminal carry `code` marks; the board shows commands as their own chips instead. */
const plain = (t: string) => { const x = t.replace(/`([^`]+)`/g, "$1").trim(); return x.charAt(0).toUpperCase() + x.slice(1); };

/** Reads everything the pipeline board shows from this Mac and the PMX repo (BOARD-3). */
export async function loadPipeline(ctx: Pick<Ctx, "team" | "personal" | "repo" | "exec" | "agent" | "now" | "launchd" | "fetch">, o: { level: PipelineLevel; hours?: number; keychain: Keychain }): Promise<PipelineData> {
  const now = ctx.now();
  const hours = Math.max(1, Math.min(336, o.hours ?? 168));
  const receipts: RunReceipt[] = [];
  for (const id of await listReceipts()) {
    const r = await readReceipt(id);
    if (r) receipts.push(r);
  }
  const log = await runlog(ctx);
  const snap = await readSnapshot();
  const outbox = await readOutbox();
  const nodes = snap ? overlay(snap, outbox.ops) : [];
  const state = await loadState();
  const issues = nodes.map((n) => {
    const t = toTask(n);
    return { identifier: t.identifier, title: t.title, url: t.url || undefined, createdAt: n.createdAt, status: t.status, meeting: kindOf(n) === "meeting" };
  });

  // The privacy checks the flow view already computes, from the same records.
  const graph = buildFlowGraph({
    level: "shared", now, hours, agent: ctx.agent, receipts, runlog: log, chain: log ? verify(log) : null, issues: nodes, linearSyncedAt: snap?.syncedAt ?? null,
    outbox: outbox.ops.map((op) => ({ kind: op.kind, text: JSON.stringify(op) })), resolved: await readResolved(), state,
    caps: { personalUsd: ctx.personal.budget.dailyUsd ?? ctx.team.caps.perDayUsd, teamUsd: ctx.team.caps.perDayUsd, resetHour: ctx.personal.budget.resetHour },
  });

  // Health: what's wrong, in words, and when each part last ran.
  const problems: HealthProblem[] = [];
  const facts: string[] = [];
  const tick = tickHealth(state.lastTick);
  if (tick && !tick.ok) problems.push({ text: plain(tick.detail), fix: "tab:schedules" });
  const job = await ctx.launchd.installed().catch(() => null);
  if (!job) problems.push({ text: "PMX isn't set to run on its own on this Mac, so nothing happens until you run it. In Terminal, run pmx init and answer yes to the background job.", cmd: "pmx init" });
  const tasks = await neededTasks(ctx.team, o.keychain);
  const schedules: PipelineData["schedules"] = [];
  for (const t of tasks) {
    const st = await taskState(t);
    const ran = st === "missing" ? null : await taskRunHealth(t, now);
    if (st === "missing") problems.push({ text: `The Claude task "${t.title}" isn't set up. Type /pmx-schedule in the Claude app.`, cmd: "/pmx-schedule", fix: "tab:schedules" });
    else if (ran && !ran.ok) problems.push({ text: plain(`"${t.title}" ${ran.detail}`), fix: "tab:schedules" });
    const run = state.taskRuns[t.id];
    const cronHours = t.cron.split(/\s+/)[1] ?? "*";
    const mins = Number(t.cron.split(/\s+/)[0]) || 0;
    const hrs = cronHours === "*" ? [...Array(24).keys()] : cronHours.split(",").flatMap((p) => { const [a, b = a] = p.split("-").map(Number); return Array.from({ length: b! - a! + 1 }, (_, k) => a! + k); });
    schedules.push({
      name: t.title.replace(/^PMX: /, ""), where: "Claude app", when: t.schedule, last: run?.finishedAt ?? run?.startedAt ?? null, next: nextCronTime(t.cron, now)?.toISOString() ?? null,
      ok: st !== "missing" && !!ran?.ok, detail: st === "missing" ? "not set up" : st === "outdated" ? "set up with an older prompt" : ran?.detail ?? "", node: t.id === "pmx-collect-meetings" ? "collect" : "inbox",
      hours: hrs.map((h) => h + mins / 60),
    });
  }
  schedules.push({
    name: "Background job", where: "This Mac", when: "every 30 minutes while this Mac is awake", last: state.lastTick?.at ?? null,
    next: state.lastTick ? new Date(Date.parse(state.lastTick.at) + 30 * 60000).toISOString() : null, ok: !!job && (!tick || tick.ok),
    detail: !job ? "not registered" : tick?.detail ?? "hasn't run yet", node: null, hours: [...Array(48).keys()].map((h) => h / 2),
  });
  if ((await linearAccess(ctx.team, o.keychain)) === "relay") {
    const r = await relayHealth(ctx.team, now);
    if (!r.ok) problems.push({ text: plain(r.detail) });
  }
  const b = budget(ctx.personal, ctx.team, state, now);
  const blocked = budgetBlock(b);
  if (blocked) problems.push({ text: plain(blocked), fix: "rule:budget" });
  const rules0 = privacyRules(ctx);
  if (!rules0.internalDomains.length) problems.push({ text: "PMX doesn't know your company's email domain, so it keeps every meeting private. Add it under Who counts as a customer.", cmd: "pmx domains add <your domain>", fix: "rule:domains" });
  const collect = state.collectReports.at(-1)?.at ?? null;
  if (collect) facts.push(`collection ${hm(collect)}`);
  if (snap) facts.push(`Linear synced ${hm(snap.syncedAt)}`);
  if (state.lastTick) facts.push(`background job ${hm(state.lastTick.at)}`);

  // Skills, with how often each ran in the window.
  const since = new Date(now.getTime() - hours * 3600000).toISOString();
  const uses = new Map<string, number>();
  for (const r of receipts) if (r.at >= since) for (const s of r.skills) uses.set(s.name, (uses.get(s.name) ?? 0) + 1);
  for (const e of log ?? []) if (e.type === "run" && e.ts >= since) uses.set(e.skill, (uses.get(e.skill) ?? 0) + 1);
  const skills = (await skillInventory(ctx.personal.repoPath, ctx.team.categories)).map((s) => ({ ...s, runsInWindow: uses.get(s.name) ?? 0 }));

  const rubric = parseRubric((await loadSkill(ctx.personal.repoPath, "pmx-size")).text);
  const cats = Object.keys(ctx.team.categories);
  const ni = ctx.personal.neverIngest;
  const todos = (await loadTodos()).items;
  return buildPipeline({
    level: o.level, now, hours, agent: ctx.agent, receipts, runlog: log, issues, linearSyncedAt: snap?.syncedAt ?? null,
    collectReports: state.collectReports, todosCreated: todos.map((t) => t.createdAt), proposals: await readProposals(),
    openTodos: todos.filter((t) => t.status === "open"), pendingTeam: await pendingTeamPrs({ ...ctx, keychain: o.keychain }).catch(() => []),
    checks: graph.checks, health: { problems, facts }, lastTick: state.lastTick?.at ?? null, skills, schedules,
    rules: {
      routes: { ...(ctx.personal.sources.routes ?? {}) },
      teamDomains: ctx.team.internalDomains, myDomains: ctx.personal.companyDomains ?? [],
      neverIngest: { people: [...ni.people], titles: [...ni.meetingTitles], channels: [...ni.channels] },
      budget: { dailyUsd: ctx.personal.budget.dailyUsd, teamCap: ctx.team.caps.perDayUsd, spentUsd: b.spentUsd, tokens: b.tokens },
      categories: cats.map((c) => ({ name: c, accepted: ctx.personal.categories.includes(c) })),
      reviewCap: ctx.team.reviewQueueCap,
      sizes: Object.fromEntries(SIZES.map((z) => [z, { minutes: ctx.team.sizes[z].minutes, usd: ctx.team.sizes[z].costUsd }])) as Record<Size, { minutes: number; usd: number }>,
      rubric: rubricFor(rubric, cats),
      slackChannels: ctx.team.slackChannels, allowedSources: ctx.team.allowedSources,
    },
  });
}
