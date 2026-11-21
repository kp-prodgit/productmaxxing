import { DEFAULT_TEAM, type TeamCategory } from "../core/config.js";
import { HOLD_LABELS, type HoldReason } from "../core/filter.js";
import type { SynthStatus } from "../synth/status.js";
import { COMMITMENT } from "../todo/todo.js";
import type { RunReceipt } from "../core/receipt.js";
import type { RunLogEntry } from "../core/runlog.js";
import { acceptStats } from "../review/queue.js";
import type { SizeRubric } from "../core/skillcheck.js";
import type { SkillInfo } from "../core/skills.js";
import { SIZES, STAGES, type Size, type Stage } from "../core/types.js";
import type { Proposal } from "../synth/proposals.js";
import type { FlowCheck } from "./graph.js";
import type { ActivityItem, Automation } from "./automations.js";
import type { DigestBoard } from "./digests.js";
import type { InputsBoard } from "../inputs/board.js";
import type { Job } from "./jobs.js";

const BUILT_IN_CATEGORIES = new Set(Object.keys(DEFAULT_TEAM.categories));

/**
 * The pipeline board's data (BOARD-3): what PMX read, held, sent to Claude and Linear, and what happened next, plus the
 * skills, scheduled tasks and rules behind each step. Built only from records PMX already keeps. Two levels:
 *  - "local": this Mac's own page. Proposal titles, the do-not-read list and which meetings a proposal came from.
 *  - "shared": the Claude artifact, through the local MCP server. Counts only for anything private: no meeting or
 *    proposal titles, no do-not-read entries.
 */
export type PipelineLevel = "local" | "shared";

/** The connections on the map. Sources each get their own edge into collection (`src:<connector>`). */
export const EDGE_IDS = ["c-f", "s-f", "f-h", "f-t", "f-d", "t-t", "d-a", "a-x", "a-i", "i-b", "i-r", "r-g", "g-v", "v-d"] as const;
export type EdgeId = (typeof EDGE_IDS)[number];

export interface PipelineEdge {
  n: number;
  unit: string;
  /** Text sent to Claude on this connection, in tokens, where PMX records it. */
  tokens?: number | null;
  last: string | null;
}

/**
 * Something the PM should fix, in words, with what fixes it: a Terminal command to copy, and/or the place on the board
 * that fixes it ("rule:<id>" for a Rules section, "tab:<id>" for a tab, "check:<id>" for a privacy check).
 */
export interface HealthProblem {
  text: string;
  cmd?: string;
  fix?: string;
  /** Something the local page can do about it with one click (BOARD-5), like "install-job". */
  action?: string;
}

/**
 * A category end to end (CAT-1): the kind of Linear task, the skill that drafts it, the file the draft must be and what
 * it must contain, how big each size is, and how the team has judged its drafts. Config and counts only, so the shared
 * page shows it too.
 */
export interface PipelineCategory {
  id: string;
  /** The skill description's first sentence ("Spec drafting"), or the id in words. */
  name: string;
  /** The rest of the skill description: what a draft is. */
  produces: string;
  /** The lifecycle stage from the skill's `pmx:` line (CAT-2), or null for a skill that doesn't say. */
  stage: Stage | null;
  skill: { name: string; version: string | null; copy: string | null; missing: boolean };
  /** How this job runs (JOB-1): its environment kind, tool allowlist and output shape. Null when the skill is missing. */
  env: { kind: string; tools: string[]; output: string } | null;
  /** Problems with the job's authored environment (empty = valid); a job with problems is refused at run time. */
  envProblems: string[];
  output: string | null;
  sections: string[];
  minCitations: number;
  externalFacing: boolean;
  /** Every PM's agent on the team takes it; the switch is locked on (JOB-9). */
  required: boolean;
  /** The team made it with the kind-of-work template (or by hand), rather than it coming with PMX (JOB-8). */
  custom: boolean;
  /** When synthesis should propose it, from the skill's `pmx.propose` (JOB-8). Null for a skill that doesn't say. */
  propose: { when: string; not: string | null } | null;
  sizes: Record<Size, { minutes: number; usd: number; text: string }>;
  takenOn: boolean;
  paused: string | null;
  /** Tasks with this category now. `proposed` waits for the PM's approval on this Mac. */
  tasks: { proposed: number; inbox: number; ready: number; working: number; review: number; done: number; blocked: number };
  /** In the board's time window. */
  runs: { n: number; drafts: number };
  /** Over the team's auto-pause window. `rate` is null before the first decision. */
  reviews: { accepted: number; redo: number; rejected: number; rate: number | null; days: number; pauseBelow: number; minReviews: number };
}

export interface PipelineData {
  v: 1;
  level: PipelineLevel;
  at: string;
  hours: number;
  freshness: { linearSyncedAt: string | null; lastTick: string | null; lastCollect: string | null };
  sources: { id: string; label: string; connected: boolean; n: number; last: string | null }[];
  edges: Record<EdgeId, PipelineEdge>;
  needs: { proposals: number; drafts: number; todos: number };
  /** Local level only. */
  proposals: { id: string; title: string; category: string; size: Size; from: string; description: string; theme: string | null }[];
  /** The team's open roadmap themes (EQ-38), for the proposals' theme picker. Local level only, like the proposals. */
  themes?: string[];
  drafts: { identifier: string; title: string; url: string | null; since: string | null }[];
  /**
   * The team's tasks nobody has started (pool and Ready), newest first, so the PM can take one as their own to-do
   * (TODO-5). Local level only. Absent from boards before 0.35.0.
   */
  pool?: { identifier: string; title: string; url: string | null; status: string; category: string | null }[];
  /** Open to-dos. Local level only: they never leave the Mac. */
  /** `at`: the meeting's day, or the day the PM added it; the board's period picker filters on it (TODO-4). */
  todos: { id: string; text: string; due: string | null; from: string; at: string; when: "today" | "evening" | "someday" | null; linear?: string | null }[];
  /** What the PM finished in the last 14 days, newest first (BOARD-6). This Mac's page only. */
  logbook?: LogbookEntry[];
  /** The team's Plan board artifact, when one is published (BOARD-1). */
  boardUrl?: string | null;
  /** The product managers' page in PMX Engine, when the team has one (CLI-7). A link from team config, never content. */
  roadmapUrl?: string | null;
  /** BOARD-8: whether this Mac's own page runs, for the Claude app's page. Never its link. This Mac's page only. */
  localPage?: { running: boolean; since: string | null } | null;
  /** SETUP-1: where this Mac stands, from the background job's last checklist. This Mac's page only. */
  setup?: import("../setup/checklist.js").SetupView | null;
  /** Team settings pull requests opened from the board that are still open. */
  pendingTeam: { url: string; at: string; changes: string[] }[];
  /** `problems` stays plain text for boards published before 0.17.0; `items` carries each one's fix. */
  health: { ok: boolean; problems: string[]; items: HealthProblem[]; facts: string[] };
  checks: FlowCheck[];
  held: { rule: string; label: string; n: number }[];
  skills: { name: string; what: string; node: string | null; where: string; runs: number; copy: string; category: string | null }[];
  categories: PipelineCategory[];
  /** Category labels on Linear tasks that no skill handles: agents skip these tasks. */
  unknownCategories: { id: string; tasks: number }[];
  /** `days` (0 = Sunday) from 0.20.0: the timeline draws a task only on days it runs. */
  schedules: { name: string; where: "Claude app" | "This Mac"; when: string; last: string | null; next: string | null; ok: boolean; detail: string; node: string | null; hours: number[]; days?: number[] }[];
  rules: PipelineRules;
  /** BOARD-5: every automated step and every point that waits for the PM. Optional: boards before 0.20.0 lack it. */
  automations?: Automation[];
  /** What happened in the window, newest first: counts and task IDs only. */
  activity?: ActivityItem[];
  /** The weekly digest. Its text only on this Mac's own page. */
  digest?: DigestBoard | null;
  /** Steps started with "Run now" on this page. Local level only. */
  jobs?: Job[];
  /** The team's emergency stop. */
  killSwitch?: { on: boolean; reason: string | null };
  /** The pmx version this board's data came from. */
  version?: string;
  /** INPUT-1, INPUT-2 (0.21.0): every connector PMX reads through, and the duplicates it caught. */
  inputs?: InputsBoard | null;
  /** SIG-6 (0.25.0): who proposes tasks, when it last ran, and why none are waiting, meeting by meeting on this Mac's page. */
  synth?: SynthStatus | null;
}

export interface PipelineRules {
  routes: Record<string, "off" | "mine" | "linear">;
  teamDomains: string[];
  myDomains: string[];
  /** Local: the entries. Shared: how many of each, never the entries. */
  neverIngest: { people: string[] | number; titles: string[] | number; channels: string[] | number };
  budget: { dailyUsd: number | null; teamCap: number; spentUsd: number; tokens: number };
  categories: { name: string; accepted: boolean; required?: boolean }[];
  reviewCap: number;
  sizes: Record<Size, { minutes: number; usd: number }>;
  rubric: Record<string, Record<Size, string>>;
  slackChannels: string[];
  allowedSources: string[];
  /** SIG-7 (0.25.0): whether this PM chose to send their own to-dos to Linear, one at a time. */
  todosToLinear?: boolean;
}

export interface PipelineInputs {
  level: PipelineLevel;
  inputs?: InputsBoard | null;
  synth?: SynthStatus | null;
  now: Date;
  hours: number;
  agent: string;
  receipts: RunReceipt[];
  runlog: RunLogEntry[] | null;
  /** Linear as PMX sees it (relay snapshot with queued changes, or the API). */
  issues: { identifier: string; title: string; url?: string; createdAt?: string; status: string | null; meeting: boolean; category?: string | null }[];
  linearSyncedAt: string | null;
  collectReports: { at: string; connector: string | null; saved: number; inputs?: { id: string; shape: "calls" | "channels"; saved: number }[] }[];
  todosCreated: string[];
  /** Open to-dos on this Mac. */
  openTodos?: { id: string; text: string; due: string | null; when?: "today" | "evening" | "someday" | null; source: { title: string; at: string }; linear?: string | null; receiptId?: string }[];
  logbook?: LogbookEntry[];
  boardUrl?: string | null;
  roadmapUrl?: string | null;
  localPage?: { running: boolean; since: string | null } | null;
  setup?: import("../setup/checklist.js").SetupView | null;
  themes?: string[];
  pendingTeam?: PipelineData["pendingTeam"];
  proposals: Proposal[];
  checks: FlowCheck[];
  health: { problems: HealthProblem[]; facts: string[] };
  lastTick: string | null;
  skills: (SkillInfo & { runsInWindow: number })[];
  /** The team's categories as pmx.config.json has them. */
  teamCategories?: Record<string, TeamCategory>;
  /** Paused categories with the reason (REV-3). */
  paused?: Map<string, string>;
  autoPause?: { windowDays: number; threshold: number; minVerdicts: number };
  schedules: PipelineData["schedules"];
  rules: PipelineRules;
  automations?: Automation[];
  activity?: ActivityItem[];
  digest?: DigestBoard | null;
  jobs?: Job[];
  killSwitch?: { on: boolean; reason: string | null };
  version?: string;
}

const CONNECTOR_LABEL: Record<string, string> = { granola: "Granola", fireflies: "Fireflies", otter: "Otter", fathom: "Fathom", tldv: "tl;dv", zoom: "Zoom", "google-meet": "Google Meet", file: "Transcript folder" };
const latest = (xs: (string | null | undefined)[]) => xs.filter(Boolean).sort().at(-1) ?? null;

/** Which step on the map a skill belongs to. */
function skillNode(s: SkillInfo): { node: string | null; where: string } {
  if (s.name === "pmx-synthesize" || s.name === "pmx-size") return { node: "draft", where: "Drafts tasks" };
  if (s.name === "pmx-todo") return { node: "findtodo", where: "Finds to-dos" };
  if (s.kind === "category") return { node: "agent", where: `Agent works${s.category ? ` (${s.category})` : ""}` };
  if (s.name === "pmx-digest") return { node: null, where: "Your weekly digest" };
  if (s.name === "pmx-rollup") return { node: null, where: "pmx company, on the company Mac" };
  if (s.name === "pmx-brain") return { node: null, where: "pmx brain (Team plan)" };
  return { node: null, where: "Your own Claude Code session" };
}

/**
 * The stage of PMX's own categories, for a team copy of a skill written before skills named their stage (CAT-2), so
 * the board still groups them by where the work sits in the product's life.
 */
const DEFAULT_STAGE: Record<string, Stage> = {
  "research-synthesis": "identify", "competitive-analysis": "identify", "problem-brief": "identify",
  spec: "build", "build-brief": "build", "validation-plan": "validate", "validation-readout": "validate", "tracking-hygiene": "operate",
};

/** "Research synthesis. Turns …" → ["Research synthesis", "Turns …"]. */
export function splitDescription(id: string, description: string): { name: string; produces: string } {
  const m = description.match(/^([^.]{2,40})\.\s+(.+)$/s);
  if (m) return { name: m[1]!.trim(), produces: m[2]!.trim() };
  const words = id.replace(/[-_]+/g, " ");
  return { name: words.charAt(0).toUpperCase() + words.slice(1), produces: description.trim() };
}

function buildCategories(i: PipelineInputs, runs: Extract<RunLogEntry, { type: "run" }>[]): { categories: PipelineCategory[]; unknown: PipelineData["unknownCategories"] } {
  const cfg: Record<string, TeamCategory> = i.teamCategories ?? Object.fromEntries(i.rules.categories.map((c) => [c.name, { skill: i.skills.find((s) => s.category === c.name)?.name ?? "" }]));
  const ap = i.autoPause ?? { windowDays: 30, threshold: 0.3, minVerdicts: 5 };
  const days = ap.windowDays;
  const stats = acceptStats(i.runlog ?? [], i.now, days);
  const tasks = i.issues.filter((x) => !x.meeting);
  const count = (id: string, st: string[]) => tasks.filter((x) => x.category === id && st.includes(x.status ?? "")).length;
  const categories = Object.entries(cfg).map(([id, c]): PipelineCategory => {
    const sk = i.skills.find((s) => s.name === c.skill);
    const { name, produces } = splitDescription(id, sk?.description ?? "");
    const st = stats[id];
    const mine = runs.filter((e) => e.category === id);
    return {
      id, name, produces,
      stage: STAGES.find((s) => s === sk?.check?.stage) ?? DEFAULT_STAGE[id] ?? null,
      skill: { name: c.skill, version: sk?.version ?? null, copy: sk ? (sk.runs === "team" ? "team's copy" : sk.runs === "org" ? "org (synced)" : "built-in") : null, missing: !sk },
      env: sk?.env ? { kind: sk.env.kind, tools: sk.env.tools, output: sk.env.output.kind } : null,
      envProblems: sk?.envProblems ?? [],
      output: sk?.check?.output ?? null, sections: sk?.check?.sections ?? [], minCitations: sk?.check?.minCitations ?? 0,
      externalFacing: !!c.externalFacing,
      required: !!c.required,
      custom: !BUILT_IN_CATEGORIES.has(id),
      propose: sk?.propose ? { when: sk.propose.when, not: sk.propose.not ?? null } : null,
      sizes: Object.fromEntries(SIZES.map((z) => [z, { minutes: i.rules.sizes[z].minutes, usd: i.rules.sizes[z].usd, text: i.rules.rubric[id]?.[z] ?? "" }])) as PipelineCategory["sizes"],
      takenOn: !!(i.rules.categories.find((x) => x.name === id)?.accepted || c.required),
      paused: i.paused?.get(id) ?? null,
      tasks: {
        proposed: i.proposals.filter((p) => p.category === id).length,
        inbox: count(id, ["inbox"]), ready: count(id, ["ready"]), working: count(id, ["claimed", "running"]),
        review: count(id, ["review"]), done: count(id, ["done"]), blocked: count(id, ["blocked"]),
      },
      runs: { n: mine.length, drafts: mine.filter((e) => e.outcome === "ok").length },
      reviews: { accepted: st?.accepted ?? 0, redo: st?.redo ?? 0, rejected: st?.rejected ?? 0, rate: st?.total ? st.rate : null, days, pauseBelow: ap.threshold, minReviews: ap.minVerdicts },
    };
  });
  const byUnknown = new Map<string, number>();
  // A PM's own commitment sent to Linear (SIG-7) has no skill on purpose: agents never take it.
  for (const t of tasks) if (t.category && t.category !== COMMITMENT && !cfg[t.category] && t.status !== "done") byUnknown.set(t.category, (byUnknown.get(t.category) ?? 0) + 1);
  return { categories, unknown: [...byUnknown].map(([id, n]) => ({ id, tasks: n })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function buildPipeline(i: PipelineInputs): PipelineData {
  const hours = Math.max(1, Math.min(336, Math.round(i.hours)));
  const since = new Date(i.now.getTime() - hours * 3600000).toISOString();
  const until = i.now.toISOString();
  const inWin = (at: string | null | undefined) => !!at && at >= since && at <= until;
  const receipts = i.receipts.filter((r) => inWin(r.at) && !r.dryRun);
  const local = i.level === "local";

  // One count per distinct source per kind of run: the same meeting read twice is one meeting.
  const distinct = (rs: RunReceipt[], pick: (s: RunReceipt["sources"][number]) => boolean) => {
    const seen = new Map<string, string>();
    for (const r of rs) for (const s of r.sources) if (pick(s)) seen.set(s.refHash, latest([seen.get(s.refHash), r.at])!);
    return { n: seen.size, last: latest([...seen.values()]) };
  };
  const tokens = (rs: RunReceipt[]) => rs.reduce((a, r) => a + (r.model?.tokens ?? 0), 0);
  const team = receipts.filter((r) => r.type === "synthesize" || r.type === "digest");
  const synth = receipts.filter((r) => r.type === "synthesize");
  const todo = receipts.filter((r) => r.type === "todo");

  // Sources: each connector seen in collection reports or receipts, plus Slack when the team approved channels.
  const bySource = new Map<string, { n: number; last: string | null }>();
  const count = (k: string, n: number, at: string) => {
    const cur = bySource.get(k) ?? { n: 0, last: null };
    bySource.set(k, { n: cur.n + n, last: latest([cur.last, at]) });
  };
  for (const c of i.collectReports.filter((c) => inWin(c.at))) {
    // From 0.21.0 a run reports each connector it read calls from (INPUT-1); threads have their own node.
    const calls = c.inputs?.filter((x) => x.shape === "calls" && x.saved);
    if (calls?.length) for (const x of calls) count(x.id, x.saved, c.at);
    else if (!c.inputs) count(c.connector ?? "file", c.saved, c.at);
  }
  if (!bySource.size) for (const r of receipts) for (const s of r.sources) if (s.kind === "transcript") {
    const k = s.origin ?? "file";
    const cur = bySource.get(k) ?? { n: 0, last: null };
    bySource.set(k, { n: cur.n + 1, last: latest([cur.last, r.at]) });
  }
  // Recorders the PM added show on the map even before they've saved a call.
  for (const r of i.inputs?.rows ?? []) if (r.shape === "calls" && !bySource.has(r.id)) bySource.set(r.id, { n: 0, last: null });
  const named = new Map((i.inputs?.rows ?? []).map((r) => [r.id, r.connector]));
  const sources: PipelineData["sources"] = [...bySource].map(([id, v]) => ({ id, label: CONNECTOR_LABEL[id] ?? named.get(id) ?? id, connected: true, ...v }));
  if (!sources.length) sources.push({ id: "granola", label: "Meeting connector", connected: false, n: 0, last: null });

  const tasks = synth.flatMap((r) => (r.synth?.tasks ?? []).map((t) => ({ t, at: r.at })));
  const posted = tasks.filter(({ t }) => t.posted && "identifier" in t.posted);
  const dropped = tasks.filter(({ t }) => t.posted && "dropped" in t.posted);
  const proposed = tasks.filter(({ t }) => t.posted && !("duplicateOf" in t.posted) && !("dryRun" in t.posted) && !("mergedInto" in t.posted));
  const runs = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run" && e.agent === i.agent && inWin(e.ts));
  const verdicts = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "verdict" }> => e.type === "verdict" && inWin(e.ts));
  const tasksNow = i.issues.filter((x) => !x.meeting);
  const ready = tasksNow.filter((x) => x.status === "ready");
  // The pool: approved team tasks a teammate hasn't picked on the team board yet (BOARD-7). The PM's own to-dos aren't team work.
  const pool = tasksNow.filter((x) => x.status === "inbox" && x.category !== COMMITMENT);
  const review = tasksNow.filter((x) => x.status === "review");

  const edges: Record<EdgeId, PipelineEdge> = {
    "c-f": { ...distinct(receipts, (s) => s.kind === "transcript"), unit: "meetings" },
    "s-f": { ...distinct(receipts, (s) => s.kind !== "transcript"), unit: "threads" },
    "f-h": { ...distinct(team, (s) => s.decision === "left-out"), unit: "meetings" },
    "f-t": { ...distinct(todo, (s) => s.decision === "used"), unit: "meetings", tokens: tokens(todo) },
    "f-d": { ...distinct(synth, (s) => s.decision === "used"), unit: "meetings and threads", tokens: tokens(synth) },
    "t-t": { n: i.todosCreated.filter(inWin).length, unit: "to-dos", last: latest(i.todosCreated.filter(inWin)) },
    "d-a": { n: proposed.length, unit: "tasks", last: latest(proposed.map((x) => x.at)) },
    "a-x": { n: dropped.length, unit: "tasks", last: latest(dropped.map((x) => x.at)) },
    "a-i": { n: posted.length, unit: "tasks", last: latest(posted.map((x) => x.at)) },
    "i-b": { n: pool.length, unit: "tasks in the pool now", last: i.linearSyncedAt },
    "i-r": { n: ready.length, unit: "tasks ready now", last: i.linearSyncedAt },
    "r-g": { n: runs.length, unit: "runs", tokens: runs.reduce((a, e) => a + (e.tokens ?? 0), 0), last: latest(runs.map((e) => e.ts)) },
    "g-v": { n: runs.filter((e) => e.outcome === "ok").length, unit: "drafts", last: latest(runs.filter((e) => e.outcome === "ok").map((e) => e.ts)) },
    "v-d": { n: verdicts.filter((v) => v.verdict === "accepted").length, unit: "drafts", last: latest(verdicts.filter((v) => v.verdict === "accepted").map((v) => v.ts)) },
  };

  const heldBy = new Map<string, Set<string>>();
  for (const r of team) for (const s of r.sources) if (s.decision === "left-out") {
    const rule = s.rule ?? "unknown";
    heldBy.set(rule, (heldBy.get(rule) ?? new Set()).add(s.refHash));
  }
  const held = [...heldBy].map(([rule, set]) => ({ rule, label: HOLD_LABELS[rule as HoldReason] ?? rule, n: set.size })).sort((a, b) => b.n - a.n);

  // A failed privacy check outranks everything else that needs the PM.
  const CHECK_PROBLEM: Record<string, string> = {
    "held-never-in-linear": "Privacy check failed: a meeting PMX kept private may be in Linear.",
    canaries: "Privacy check failed: a test meeting got past the privacy rules.",
    "outbox-clean": "Privacy check failed: a change waiting to go to Linear carries a test marker.",
    "runlog-chain": "The agent history doesn't add up: an entry was changed or is missing.",
  };
  const problems: HealthProblem[] = [
    ...i.checks.filter((c) => c.status === "violated").map((c) => ({ text: `${CHECK_PROBLEM[c.id] ?? `Privacy check failed: ${c.label}.`} See which in Privacy checks.`, fix: `check:${c.id}` })),
    ...i.health.problems,
  ];

  const cats = buildCategories(i, runs);

  const sharedRules: PipelineRules = local ? i.rules : {
    ...i.rules,
    neverIngest: {
      people: Array.isArray(i.rules.neverIngest.people) ? i.rules.neverIngest.people.length : i.rules.neverIngest.people,
      titles: Array.isArray(i.rules.neverIngest.titles) ? i.rules.neverIngest.titles.length : i.rules.neverIngest.titles,
      channels: Array.isArray(i.rules.neverIngest.channels) ? i.rules.neverIngest.channels.length : i.rules.neverIngest.channels,
    },
  };

  return {
    v: 1, level: i.level, at: until, hours,
    freshness: { linearSyncedAt: i.linearSyncedAt, lastTick: i.lastTick, lastCollect: latest(i.collectReports.map((c) => c.at)) },
    sources, edges,
    needs: { proposals: i.proposals.length, drafts: review.length, todos: (i.openTodos ?? []).length },
    // A proposal the PM hasn't approved stays theirs, so only this Mac's page shows it.
    proposals: local ? i.proposals.map((p) => ({
      id: p.id, title: p.title, category: p.category, size: p.size, description: p.description, theme: p.theme ?? null,
      from: p.from.length === 1 ? `1 source (${p.from[0]!.at.slice(0, 10)})` : `${p.from.length} sources (${[...new Set(p.from.map((f) => f.at.slice(0, 10)))].join(", ")})`,
    })) : [],
    drafts: review.map((x) => ({ identifier: x.identifier, title: x.title, url: x.url ?? null, since: x.createdAt ?? null })),
    pool: local ? tasksNow.filter((x) => (x.status === "inbox" || x.status === "ready") && x.category !== COMMITMENT).sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "")).slice(0, 50)
      .map((x) => ({ identifier: x.identifier, title: x.title, url: x.url ?? null, status: x.status!, category: x.category ?? null })) : [],
    // A to-do from no meeting (added by the PM, or taken from the team's list) says so as it is; the rest name their meeting.
    todos: local ? (i.openTodos ?? []).map((t) => ({ id: t.id, text: t.text, due: t.due, when: t.when ?? null, at: t.source.at.slice(0, 10), ...(t.linear ? { linear: t.linear } : {}), from: t.source.title === "Added by you" || t.receiptId === "" ? t.source.title : `${t.source.title} (${t.source.at.slice(0, 10)})` })) : [],
    logbook: local ? i.logbook ?? [] : [],
    boardUrl: i.boardUrl ?? null,
    roadmapUrl: i.roadmapUrl ?? null,
    localPage: local ? i.localPage ?? null : null,
    setup: local ? i.setup ?? null : null,
    themes: local ? i.themes ?? [] : [],
    pendingTeam: i.pendingTeam ?? [],
    health: { ok: !problems.length, problems: problems.map((p) => p.text), items: problems, facts: i.health.facts },
    checks: i.checks,
    held,
    skills: i.skills.map((s) => ({ name: s.name, what: s.description, ...skillNode(s), runs: s.runsInWindow, copy: s.runs === "team" ? "team's copy" : "built-in", category: s.category })),
    categories: cats.categories,
    unknownCategories: cats.unknown,
    schedules: i.schedules,
    rules: sharedRules,
    automations: i.automations ?? [],
    activity: i.activity ?? [],
    inputs: i.inputs ?? null,
    synth: i.synth ?? null,
    digest: i.digest ? { ...i.digest, waiting: i.digest.waiting.map((w) => ({ ...w, markdown: local ? w.markdown : null })), dm: { on: i.digest.dm.on, user: local ? i.digest.dm.user : null }, slackChannel: local ? i.digest.slackChannel : null } : null,
    jobs: local ? i.jobs ?? [] : [],
    killSwitch: i.killSwitch ?? { on: false, reason: null },
    version: i.version,
  };
}

/** The rubric as the board edits it: category → size → text, for every category the team has. */
export function rubricFor(rubric: SizeRubric, categories: string[]): Record<string, Record<Size, string>> {
  return Object.fromEntries(categories.map((c) => [c, Object.fromEntries(SIZES.map((z) => [z, rubric.cells[c]?.[z] ?? ""])) as Record<Size, string>]));
}

export interface LogbookEntry {
  at: string;
  kind: "done" | "approved" | "dropped" | "accepted" | "redo" | "rejected" | "shared" | "digest-rejected";
  text: string;
  /** The Linear identifier, when there is one. */
  ref: string | null;
}

/**
 * The Logbook (BOARD-6): to-dos ticked done, proposals approved or dropped, drafts decided and digests shared or
 * rejected by this PM, from records PMX already keeps. Titles are the PM's own, so only this Mac's page gets it.
 */
export function buildLogbook(i: {
  now: Date; agent: string; days?: number;
  todos: { text: string; status: string; doneAt: string | null }[];
  receipts: { at: string; synth?: { tasks: { title: string; posted?: object }[] } | null }[];
  runlog: RunLogEntry[] | null;
}): LogbookEntry[] {
  const since = new Date(i.now.getTime() - (i.days ?? 14) * 86400000).toISOString();
  const out: LogbookEntry[] = [];
  for (const t of i.todos) if (t.status === "done" && t.doneAt && t.doneAt >= since) out.push({ at: t.doneAt, kind: "done", text: t.text, ref: null });
  for (const r of i.receipts) {
    if (r.at < since) continue;
    for (const t of r.synth?.tasks ?? []) {
      const p = t.posted as Record<string, unknown> | undefined;
      if (p && typeof p.identifier === "string" && !p.identifier.startsWith("PENDING-")) out.push({ at: r.at, kind: "approved", text: t.title, ref: p.identifier });
      else if (p && typeof p.identifier === "string") out.push({ at: r.at, kind: "approved", text: t.title, ref: null });
      else if (p && p.dropped === true) out.push({ at: r.at, kind: "dropped", text: t.title, ref: null });
    }
  }
  for (const e of i.runlog ?? []) {
    if (e.ts < since || e.agent !== i.agent) continue;
    if (e.type === "verdict") out.push({ at: e.ts, kind: e.verdict, text: e.taskId, ref: e.taskId });
    if (e.type === "digest" && e.outcome !== "staged") out.push({ at: e.ts, kind: e.outcome === "approved" ? "shared" : "digest-rejected", text: `Digest, week of ${e.ts.slice(0, 10)}`, ref: null });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 200);
}
