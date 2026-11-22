import { appliedSchedule, neededTasks, nextCronTime, syncDueCron, taskRunHealth, taskState, workingTimes } from "../claude/tasks.js";
import { checklistForPage, pageWords, readHistory } from "../setup/checklist.js";
import { webServerStatus } from "./web-server.js";
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
import { isProductLead, startsNow } from "../core/config.js";
import { privacyRules } from "../digest/gather.js";
import { linearAccess } from "../linear/access.js";
import { readProposals } from "../synth/proposals.js";
import { openThemes } from "../synth/themes.js";
import { loadTodos } from "../todo/todo.js";
import { kindOf, toTask } from "../tracker/linear.js";
import { overlay, readOutbox, readResolved, readSnapshot, relayHealth } from "../tracker/relay.js";
import { buildFlowGraph } from "./graph.js";
import { buildLogbook, buildPipeline, rubricFor, type HealthProblem, type PipelineData, type PipelineLevel } from "./pipeline.js";
import { pendingTeamPrs } from "./team-prs.js";
import { pausedCategories } from "../core/services.js";
import { analyticsOn, cloudTarget } from "../cloud/account.js";
import { killSwitchOn } from "../core/killswitch.js";
import { currentVersion } from "../core/version.js";
import { pageProblem, stalePages } from "../claude/pages.js";
import { synthStatus } from "../synth/status.js";
import { buildActivity, buildAutomations } from "./automations.js";
import { loadDigestBoard } from "./digests.js";
import { jobList } from "./jobs.js";
import { buildInputsBoard } from "../inputs/board.js";
import type { EngineSource } from "./strategy.js";

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

/** A cron day-of-week field ("1-5", "*", "0,6") as the days it runs, 0 = Sunday. */
export function cronDays(f: string): number[] {
  if (f === "*") return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const p of f.split(",")) { const [a, b = a] = p.split("-").map(Number); for (let d = a!; d <= b!; d++) out.add(d % 7); }
  return [...out].sort();
}

/** The Linear sync's health, in a PM's words (BOARD-5): what's wrong and where to look, without PMX's command names. */
export function relayWords(detail: string, waiting: number): { text: string; cmd?: string } {
  const queued = waiting ? ` ${waiting} change${waiting === 1 ? " is" : "s are"} waiting to go to Linear.` : "";
  if (/not synced yet/.test(detail)) return { text: `Linear hasn't synced yet. PMX reaches Linear through a task in your Claude app; type /pmx-schedule there to set it up.${queued}`, cmd: "/pmx-schedule" };
  const h = detail.match(/last synced (\d+)h ago/);
  if (h) return { text: `Linear last synced ${h[1]} hours ago. A sync was missed, so agents may be working from an old copy of your tasks. The "Sync Linear" task in your Claude app runs only while the app is open and the Mac is awake; open Claude and check it ran.${queued}`, cmd: "/pmx-schedule" };
  if (/label\(s\) missing/.test(detail)) return { text: "Some of PMX's labels are missing in Linear, so cards can't move yet. The next Linear sync in your Claude app creates them." };
  if (/not this team's/.test(detail)) return { text: "The last Linear sync read a different project than your team's. Check your team's Linear settings, then let the next sync run.", cmd: "/pmx-setup" };
  return { text: plain(detail.replace(/^Linear through Claude: /, "Linear sync: ")) };
}

/**
 * Reads everything the pipeline board shows from this Mac and the PMX repo (BOARD-3). `engine` (BOARD-11): PMX Engine,
 * as a command hands it over; read only for this Mac's own page, and not where the PM hid it (`pmx open --hide-studio`).
 */
export async function loadPipeline(ctx: Pick<Ctx, "team" | "personal" | "repo" | "exec" | "agent" | "now" | "launchd" | "fetch" | "keychain">, o: { level: PipelineLevel; hours?: number; keychain: Keychain; engine?: EngineSource }): Promise<PipelineData> {
  const now = ctx.now();
  // Started first, so Engine answers while PMX reads its own records.
  const engine = o.level === "local" && o.engine && ctx.personal.studio !== "hidden" ? o.engine.view().catch(() => null) : Promise.resolve(null);
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
    return { identifier: t.identifier, title: t.title, url: t.url || undefined, createdAt: n.createdAt, status: t.status, meeting: kindOf(n) === "meeting", category: t.category, agent: t.agent };
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
  const tick = tickHealth(state.lastTick, 3, ctx.now());
  if (tick && !tick.ok) problems.push({ text: plain(tick.detail), fix: "tab:automations" });
  const job = await ctx.launchd.installed().catch(() => null);
  if (!job) problems.push({ text: "Automatic runs are off, so PMX only works while you have it open. Turn them on and it checks for new meetings every 30 minutes.", action: "install-job", step: "job.installed", label: "Turn on automatic runs" });
  const tasks = await neededTasks(ctx.team, o.keychain);
  const schedules: PipelineData["schedules"] = [];
  for (const t of tasks) {
    const st = await taskState(t);
    const ran = st === "missing" ? null : await taskRunHealth(t, now);
    if (st === "missing") problems.push({ text: `"${t.title.replace(/^PMX: /, "")}" isn't set up in your Claude app yet. Type /pmx-schedule there and Claude sets it up.`, cmd: "/pmx-schedule", fix: "tab:automations" });
    else if (ran && !ran.ok) problems.push({ text: plain(`"${t.title.replace(/^PMX: /, "")}" ${ran.detail}`), fix: "tab:automations" });
    const run = state.taskRuns[t.id];
    // When it does its work: what the Claude app has, less the hours PMX stops its runs in (CLAUDE-6). A task from
    // before 0.36.0 runs on the schedule the app has until /pmx-schedule updates it.
    const applied = st === "missing" ? t : await appliedSchedule(t);
    const { cron, schedule } = applied.cron === t.cron ? workingTimes(t, ctx.personal.taskHours) : applied;
    const cronHours = cron.split(/\s+/)[1] ?? "*";
    const mins = Number(cron.split(/\s+/)[0]) || 0;
    const hrs = cronHours === "*" ? [...Array(24).keys()] : cronHours.split(",").flatMap((p) => { const [a, b = a] = p.split("-").map(Number); return Array.from({ length: b! - a! + 1 }, (_, k) => a! + k); });
    schedules.push({
      name: t.title.replace(/^PMX: /, ""), where: "Claude app", when: schedule, last: run?.finishedAt ?? run?.startedAt ?? null, next: nextCronTime(cron, now)?.toISOString() ?? null,
      ok: st !== "missing" && !!ran?.ok, detail: st === "missing" ? "not set up" : st === "outdated" ? "set up with an older prompt" : ran?.detail ?? "", node: t.id === "pmx-collect-meetings" ? "collect" : "inbox",
      hours: hrs.map((h) => h + mins / 60), days: cronDays(cron.split(/\s+/)[4] ?? "*"),
    });
  }
  schedules.push({
    name: "Background job", where: "This Mac", when: "every 30 minutes while this Mac is awake", last: state.lastTick?.at ?? null,
    next: state.lastTick ? new Date(Date.parse(state.lastTick.at) + 30 * 60000).toISOString() : null, ok: !!job && (!tick || tick.ok),
    detail: !job ? "not registered" : tick?.detail ?? "hasn't run yet", node: null, hours: [...Array(48).keys()].map((h) => h / 2), days: [0, 1, 2, 3, 4, 5, 6],
  });
  const access = await linearAccess(ctx.team, o.keychain).catch(() => "none" as const);
  let relay: { ok: boolean; problem?: string } = { ok: true };
  if (access === "relay") {
    const r = await relayHealth(ctx.team, now, { cron: await syncDueCron(ctx.personal.taskHours) });
    if (!r.ok) {
      const w = relayWords(r.detail, outbox.ops.length);
      problems.push({ ...w, fix: "tab:automations" });
      relay = { ok: false, problem: w.text };
    }
  }
  const b = budget(ctx.personal, ctx.team, state, now);
  const blocked = budgetBlock(b);
  if (blocked) problems.push({ text: plain(blocked), fix: "rule:budget" });
  const rules0 = privacyRules(ctx);
  if (!rules0.internalDomains.length) problems.push({ text: "PMX doesn't know your company's email domain yet, so it keeps every meeting private and can't spot customer calls. Add your domain under Who counts as a customer.", fix: "rule:domains" });
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
  const local = o.level === "local";
  const proposals = await readProposals();
  const paused = await pausedCategories(ctx as Ctx).catch(() => new Map<string, string>());
  const ks = await killSwitchOn(ctx.repo).catch(() => ({ on: false, reason: null }));
  if (ks.on) problems.unshift({ text: `Your team turned on the emergency stop${ks.reason ? ` (${ks.reason})` : ""}. Nothing runs until they turn it off.` });
  const digest = await loadDigestBoard(ctx, { local, receipts, runlog: log, lastDigestWeek: state.lastDigestWeek }).catch(() => null);
  const jobs = local ? jobList() : [];
  const tasksNow = issues.filter((x) => !x.meeting);
  const automations = buildAutomations({
    now, agent: ctx.agent, handle: ctx.personal.handle, installedAt: ctx.personal.installedAt, jobInstalled: !!job, lastTick: state.lastTick, tickOk: !tick || tick.ok,
    schedules, collectReports: state.collectReports, receipts, runlog: log, tracker: ctx.team.tracker.kind !== "none", synthesizer: ctx.team.synthesizer,
    company: ctx.team.company?.teams.length ? { machine: ctx.team.company.machine } : null, lastSynthAt: state.lastSynthAt, lastRollupAt: state.lastRollupAt,
    lastEventSyncAt: state.lastEventSyncAt, analytics: !!cloudTarget(ctx.team, ctx.personal) && analyticsOn(ctx.personal),
    autoUpdate: { on: !!ctx.team.cli?.autoUpdate, state: state.autoUpdate, version: currentVersion() },
    linear: { mode: access, syncedAt: snap?.syncedAt ?? null, waiting: outbox.ops.length, ...relay },
    proposals: proposals.length, drafts: tasksNow.filter((x) => x.status === "review").length, reviewCap: ctx.team.reviewQueueCap, todos: todos.filter((t) => t.status === "open").length,
    paused: [...paused.keys()], digest, pendingTeam: 0, killSwitch: ks, jobs, startNow: startsNow(ctx.team),
  });
  const pendingTeam = await pendingTeamPrs({ ...ctx, keychain: o.keychain }).catch(() => []);
  const tc = automations.find((a) => a.id === "team-changes");
  if (tc && pendingTeam.length) { tc.status = "waiting"; tc.statusText = `${pendingTeam.length} in review`; }
  if (digest?.waiting.length) facts.push(`digest waiting`);
  const inputs = buildInputsBoard({ team: ctx.team, personal: ctx.personal, agent: ctx.agent, state, receipts, now, hours, local });
  // FLOW-5, BOARD-1: a page this Mac published with an older pmx runs the older code until Claude publishes it again.
  for (const p of stalePages(ctx.team, ctx.personal)) problems.push({ text: pageProblem(p), cmd: `/${p.skill}` });
  const synth = await synthStatus(ctx as Ctx, { local, receipts, automatic: !!job, lastSynthAt: state.lastSynthAt }).catch(() => null);
  const unplugged = inputs.rows.filter((r) => r.status === "not-connected");
  if (unplugged.length) problems.push({ text: `${unplugged.map((r) => r.connector).join(" and ")} ${unplugged.length === 1 ? "isn't" : "aren't"} connected in your Claude app, so PMX can't read ${unplugged.length === 1 ? "it" : "them"}. Add ${unplugged.length === 1 ? "it" : "them"} under Settings → Connectors in the Claude app.`, fix: "tab:sources" });
  return buildPipeline({
    level: o.level, now, hours, agent: ctx.agent, receipts, runlog: log, issues, linearSyncedAt: snap?.syncedAt ?? null,
    collectReports: state.collectReports, todosCreated: todos.map((t) => t.createdAt), proposals,
    openTodos: todos.filter((t) => t.status === "open"), pendingTeam,
    logbook: local ? buildLogbook({ now, agent: ctx.agent, todos, receipts, runlog: log }) : [],
    boardUrl: ctx.team.board?.url ?? ctx.personal.board?.url ?? null,
    roadmapUrl: ctx.team.roadmap?.url ?? null,
    localPage: local ? await webServerStatus().catch(() => null) : null,
    setup: local ? checklistForPage((await readHistory())?.last ?? null) : null,
    themes: (await openThemes(ctx.personal.repoPath)).map((t) => t.name),
    // The page names no pmx commands (SETUP-2): a fix is a button, a slash command or a place on the page.
    checks: graph.checks, health: { problems: problems.map((x) => ({ ...x, text: pageWords(x.text) || "PMX needs a look on this Mac: see Health, then Setup.", ...(x.cmd && !x.cmd.startsWith("/") ? { cmd: undefined } : {}) })), facts }, lastTick: state.lastTick?.at ?? null, skills, schedules,
    teamCategories: ctx.team.categories, paused, autoPause: ctx.team.autoPause,
    automations, activity: buildActivity({ now, hours, agent: ctx.agent, receipts, runlog: log, collectReports: state.collectReports, lastTick: state.lastTick }),
    digest, jobs, killSwitch: ks, version: currentVersion(),
    engine: await engine,
    inputs,
    synth,
    rules: {
      routes: { ...(ctx.personal.sources.routes ?? {}) },
      teamDomains: ctx.team.internalDomains, myDomains: ctx.personal.companyDomains ?? [],
      neverIngest: { people: [...ni.people], titles: [...ni.meetingTitles], channels: [...ni.channels] },
      budget: { dailyUsd: ctx.personal.budget.dailyUsd, teamCap: ctx.team.caps.perDayUsd, spentUsd: b.spentUsd, tokens: b.tokens },
      todosToLinear: !!ctx.personal.todosToLinear,
      // CLAUDE-6: when PMX's Claude tasks do their work; a PMX setting from 0.36.0.
      taskHours: ctx.personal.taskHours ?? "weekdays",
      startNow: startsNow(ctx.team),
      productLead: ctx.team.productLead ?? null,
      productLeadIsYou: isProductLead(ctx.team, ctx.personal),
      // `accepted` is the PM's own choice; a required kind is taken either way, and stays the PM's choice if the team stops requiring it.
      categories: cats.map((c) => ({ name: c, accepted: ctx.personal.categories.includes(c), required: !!ctx.team.categories[c]?.required })),
      reviewCap: ctx.team.reviewQueueCap,
      sizes: Object.fromEntries(SIZES.map((z) => [z, { minutes: ctx.team.sizes[z].minutes, usd: ctx.team.sizes[z].costUsd }])) as Record<Size, { minutes: number; usd: number }>,
      rubric: rubricFor(rubric, cats),
      slackChannels: ctx.team.slackChannels, allowedSources: ctx.team.allowedSources,
    },
  });
}
