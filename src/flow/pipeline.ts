import { HOLD_LABELS, type HoldReason } from "../core/filter.js";
import type { RunReceipt } from "../core/receipt.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { SizeRubric } from "../core/skillcheck.js";
import type { SkillInfo } from "../core/skills.js";
import { SIZES, type Size } from "../core/types.js";
import type { Proposal } from "../synth/proposals.js";
import type { FlowCheck } from "./graph.js";

/**
 * The pipeline board's data (BOARD-3): what PMX read, held, sent to Claude and Linear, and what happened next, plus the
 * skills, scheduled tasks and rules behind each step. Built only from records PMX already keeps. Two levels:
 *  - "local": this Mac's own page. Proposal titles, the do-not-read list and which meetings a proposal came from.
 *  - "shared": the Claude artifact, through the local MCP server. Counts only for anything private: no meeting or
 *    proposal titles, no do-not-read entries.
 */
export type PipelineLevel = "local" | "shared";

/** The connections on the map. Sources each get their own edge into collection (`src:<connector>`). */
export const EDGE_IDS = ["c-f", "s-f", "f-h", "f-t", "f-d", "t-t", "d-a", "a-x", "a-i", "i-r", "r-g", "g-v", "v-d"] as const;
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
  proposals: { id: string; title: string; category: string; size: Size; from: string; description: string }[];
  drafts: { identifier: string; title: string; url: string | null; since: string | null }[];
  /** Open to-dos. Local level only: they never leave the Mac. */
  todos: { id: string; text: string; due: string | null; from: string }[];
  /** Team settings pull requests opened from the board that are still open. */
  pendingTeam: { url: string; at: string; changes: string[] }[];
  /** `problems` stays plain text for boards published before 0.17.0; `items` carries each one's fix. */
  health: { ok: boolean; problems: string[]; items: HealthProblem[]; facts: string[] };
  checks: FlowCheck[];
  held: { rule: string; label: string; n: number }[];
  skills: { name: string; what: string; node: string | null; where: string; runs: number; copy: string; category: string | null }[];
  schedules: { name: string; where: "Claude app" | "This Mac"; when: string; last: string | null; next: string | null; ok: boolean; detail: string; node: string | null; hours: number[] }[];
  rules: PipelineRules;
}

export interface PipelineRules {
  routes: Record<string, "off" | "mine" | "linear">;
  teamDomains: string[];
  myDomains: string[];
  /** Local: the entries. Shared: how many of each, never the entries. */
  neverIngest: { people: string[] | number; titles: string[] | number; channels: string[] | number };
  budget: { dailyUsd: number | null; teamCap: number; spentUsd: number; tokens: number };
  categories: { name: string; accepted: boolean }[];
  reviewCap: number;
  sizes: Record<Size, { minutes: number; usd: number }>;
  rubric: Record<string, Record<Size, string>>;
  slackChannels: string[];
  allowedSources: string[];
}

export interface PipelineInputs {
  level: PipelineLevel;
  now: Date;
  hours: number;
  agent: string;
  receipts: RunReceipt[];
  runlog: RunLogEntry[] | null;
  /** Linear as PMX sees it (relay snapshot with queued changes, or the API). */
  issues: { identifier: string; title: string; url?: string; createdAt?: string; status: string | null; meeting: boolean }[];
  linearSyncedAt: string | null;
  collectReports: { at: string; connector: string | null; saved: number }[];
  todosCreated: string[];
  /** Open to-dos on this Mac. */
  openTodos?: { id: string; text: string; due: string | null; source: { title: string; at: string } }[];
  pendingTeam?: PipelineData["pendingTeam"];
  proposals: Proposal[];
  checks: FlowCheck[];
  health: { problems: HealthProblem[]; facts: string[] };
  lastTick: string | null;
  skills: (SkillInfo & { runsInWindow: number })[];
  schedules: PipelineData["schedules"];
  rules: PipelineRules;
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
  for (const c of i.collectReports.filter((c) => inWin(c.at))) {
    const k = c.connector ?? "file";
    const cur = bySource.get(k) ?? { n: 0, last: null };
    bySource.set(k, { n: cur.n + c.saved, last: latest([cur.last, c.at]) });
  }
  if (!bySource.size) for (const r of receipts) for (const s of r.sources) if (s.kind === "transcript") {
    const k = s.origin ?? "file";
    const cur = bySource.get(k) ?? { n: 0, last: null };
    bySource.set(k, { n: cur.n + 1, last: latest([cur.last, r.at]) });
  }
  const sources: PipelineData["sources"] = [...bySource].map(([id, v]) => ({ id, label: CONNECTOR_LABEL[id] ?? id, connected: true, ...v }));
  if (!sources.length) sources.push({ id: "granola", label: "Meeting connector", connected: false, n: 0, last: null });

  const tasks = synth.flatMap((r) => (r.synth?.tasks ?? []).map((t) => ({ t, at: r.at })));
  const posted = tasks.filter(({ t }) => t.posted && "identifier" in t.posted);
  const dropped = tasks.filter(({ t }) => t.posted && "dropped" in t.posted);
  const proposed = tasks.filter(({ t }) => t.posted && !("duplicateOf" in t.posted) && !("dryRun" in t.posted));
  const runs = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run" && e.agent === i.agent && inWin(e.ts));
  const verdicts = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "verdict" }> => e.type === "verdict" && inWin(e.ts));
  const tasksNow = i.issues.filter((x) => !x.meeting);
  const ready = tasksNow.filter((x) => x.status === "ready");
  const review = tasksNow.filter((x) => x.status === "review");

  const edges: Record<EdgeId, PipelineEdge> = {
    "c-f": { ...distinct(receipts, (s) => s.kind === "transcript"), unit: "meetings" },
    "s-f": { ...distinct(receipts, (s) => s.kind === "slack"), unit: "threads" },
    "f-h": { ...distinct(team, (s) => s.decision === "left-out"), unit: "meetings" },
    "f-t": { ...distinct(todo, (s) => s.decision === "used"), unit: "meetings", tokens: tokens(todo) },
    "f-d": { ...distinct(synth, (s) => s.decision === "used"), unit: "meetings and threads", tokens: tokens(synth) },
    "t-t": { n: i.todosCreated.filter(inWin).length, unit: "to-dos", last: latest(i.todosCreated.filter(inWin)) },
    "d-a": { n: proposed.length, unit: "tasks", last: latest(proposed.map((x) => x.at)) },
    "a-x": { n: dropped.length, unit: "tasks", last: latest(dropped.map((x) => x.at)) },
    "a-i": { n: posted.length, unit: "tasks", last: latest(posted.map((x) => x.at)) },
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
      id: p.id, title: p.title, category: p.category, size: p.size, description: p.description,
      from: p.from.length === 1 ? `1 source (${p.from[0]!.at.slice(0, 10)})` : `${p.from.length} sources (${[...new Set(p.from.map((f) => f.at.slice(0, 10)))].join(", ")})`,
    })) : [],
    drafts: review.map((x) => ({ identifier: x.identifier, title: x.title, url: x.url ?? null, since: x.createdAt ?? null })),
    todos: local ? (i.openTodos ?? []).map((t) => ({ id: t.id, text: t.text, due: t.due, from: `${t.source.title} (${t.source.at.slice(0, 10)})` })) : [],
    pendingTeam: i.pendingTeam ?? [],
    health: { ok: !problems.length, problems: problems.map((p) => p.text), items: problems, facts: i.health.facts },
    checks: i.checks,
    held,
    skills: i.skills.map((s) => ({ name: s.name, what: s.description, ...skillNode(s), runs: s.runsInWindow, copy: s.runs === "team" ? "team's copy" : "built-in", category: s.category })),
    schedules: i.schedules,
    rules: sharedRules,
  };
}

/** The rubric as the board edits it: category → size → text, for every category the team has. */
export function rubricFor(rubric: SizeRubric, categories: string[]): Record<string, Record<Size, string>> {
  return Object.fromEntries(categories.map((c) => [c, Object.fromEntries(SIZES.map((z) => [z, rubric.cells[c]?.[z] ?? ""])) as Record<Size, string>]));
}
