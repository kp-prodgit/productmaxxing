import { readJson, writeJson } from "./fsutil.js";
import { paths } from "./paths.js";

/** A background pass is due every 30 minutes; none for 2.5 of them means the Mac slept, was off, or the job stopped (OBS-4). */
export const TICK_GAP_MS = 75 * 60000;

/** Personal machine state in `~/.pmx/state.json`. Never synced. */
export interface State {
  lastDigestWeek: string | null;
  lastSynthAt: string | null;
  /** Self-tracked spend ledger (PULL-5): day (YYYY-MM-DD, in budget-reset time) → USD. */
  ledger: Record<string, number>;
  /** Tokens PMX's runs used per ledger day (BUDGET-1). */
  tokens?: Record<string, number>;
  eeTrialStartedAt: string | null;
  lastEventSyncAt: string | null;
  lastPipelineSyncAt: string | null;
  lastBrainAt: string | null;
  lastCollectAt: string | null;
  lastRollupAt: string | null;
  /** What the hosted app last said about CLI versions (COMPAT-5). */
  cloudVersions: { latest: string | null; min: string | null; seenAt: string } | null;
  /** The background auto-update (COMPAT-6): when it last looked, and what last happened. */
  autoUpdate: { checkedAt: string; result: string; version: string | null; notifiedFor: string | null } | null;
  /** The last time the background job fast-forwarded the team's PMX repo, and how it went (JOB-10). */
  teamSync?: { checkedAt: string; result: string; okAt?: string | null } | null;
  /** The background job's last pass: which steps failed, and how many passes in a row had a failure. */
  lastTick: { at: string; failed: string[]; failStreak: number } | null;
  /** OBS-4: stretches with no background pass (the Mac asleep or off), newest last, 14 days. */
  tickGaps?: { from: string; to: string }[];
  /** Each Claude scheduled task's last run, as PMX saw it: its `--prompt` call starts one, its last step finishes it. */
  taskRuns: Record<string, { startedAt: string; finishedAt: string | null }>;
  /** The personal daily cap that applied each ledger day, so the flow view shows past days against their own cap (FLOW-1). */
  caps: Record<string, number>;
  /**
   * What each collection run skipped before saving anything (FLOW-1), as counts only: meetings the Claude task
   * never wrote because of the do-not-read list leave no other trace on this Mac. Newest last, 14 days.
   */
  collectReports: {
    at: string; connector: string | null; saved: number; skipped: Record<CollectSkip, number>;
    /** From 0.21.0 (INPUT-1): threads saved from approved channels, and how each connector the run used went. */
    threads?: number;
    inputs?: { id: string; shape: "calls" | "channels"; status: "used" | "not-connected" | "failed" | null; saved: number }[];
    /** COLLECT-3: new files that carried no code from a recent `pmx collect --prompt`. */
    unverified?: number;
  }[];
  /** COLLECT-3: the codes the last few `pmx collect --prompt` runs issued. A file the task writes carries one. */
  collectRuns?: { code: string; at: string }[];
  /**
   * What's new (NEW-1): `seen` is the last version this Mac was told about; `since` is the version an update
   * replaced, so the new pmx can say what changed since then.
   */
  /** When this Mac moved from the ProductGit names (RENAME-1): keychain items, then the background job. */
  renamed?: { keychain?: string; launchd?: string } | null;
  whatsNew: { seen: string | null; since: string | null } | null;
  /** UPGRADE-1: the pmx that last ran here, the version it came from, and each update step done (src/core/upgrade.ts). */
  upgrade?: import("./upgrade.js").UpgradeRecord | null;
  /** RUN-5: when this Mac last removed the evidence packs of finished or dropped tasks from the team repo. */
  evidenceTidyAt?: string | null;
  /**
   * RUN-5: when this Mac last finished looking for its open tasks without an evidence pack, and whether its next
   * background run looks again (an update asks for it, and so does a look that stopped at its limit or had a failure).
   */
  evidenceBackfill?: { at: string | null; due: boolean } | null;
  /**
   * F5 (RUN-5): the privacy rules (`holdRulesKey`, a hash) this Mac last checked its shared packs against. When they
   * change (an update, a merged confidentialDomains, the do-not-read list), the next background run drops from those
   * packs what the rules now hold.
   */
  evidenceRulesKey?: string | null;
  /** R5e: the name swap (NAME_SWAP) whose rewrite this Mac last asked its backfill for. */
  evidenceNameSwap?: number | null;
  /** When this Mac's pmx started tracking task runs. Older runs left no record, so "never ran" counts from here. */
  taskRunsSince: string | null;
}

const EMPTY: State = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null, autoUpdate: null, lastTick: null, taskRuns: {}, taskRunsSince: null, caps: {}, collectReports: [], whatsNew: null };

/** Why the collection task skipped a meeting without saving it. */
export const COLLECT_SKIPS = ["never-ingest-title", "never-ingest-person", "no-transcript", "already-collected", "outside-window", "not-approved-place", "too-short"] as const;
export type CollectSkip = (typeof COLLECT_SKIPS)[number];

export async function loadState(): Promise<State> {
  return { ...EMPTY, ...((await readJson<Partial<State>>(paths.state())) ?? {}) };
}

export async function saveState(s: State): Promise<void> {
  // Keep 60 days of ledger.
  const days = Object.keys(s.ledger).sort();
  for (const d of days.slice(0, Math.max(0, days.length - 60))) delete s.ledger[d];
  for (const d of Object.keys(s.tokens ?? {}).sort().slice(0, Math.max(0, Object.keys(s.tokens ?? {}).length - 60))) delete s.tokens![d];
  for (const d of Object.keys(s.caps ?? {}).sort().slice(0, Math.max(0, Object.keys(s.caps ?? {}).length - 60))) delete s.caps[d];
  // The 14-day window is applied where a report is added, by PMX's own clock (recentReports); this only bounds the file.
  s.collectReports = (s.collectReports ?? []).slice(-200);
  await writeJson(paths.state(), s);
}

/** The collection reports from the 14 days before `now`, the window FLOW-1 keeps. */
export function recentReports<T extends { at: string }>(reports: T[], now: Date): T[] {
  const cutoff = new Date(now.getTime() - 14 * 86400000).toISOString();
  return reports.filter((r) => r.at >= cutoff);
}

export async function updateState(fn: (s: State) => void): Promise<State> {
  const s = await loadState();
  fn(s);
  await saveState(s);
  return s;
}

/** Records a Claude scheduled task's run starting (its `--prompt` step) or finishing (its last step). Never throws. */
export async function markTaskRun(taskId: string, phase: "start" | "finish", now = new Date()): Promise<void> {
  await updateState((s) => {
    const at = now.toISOString();
    if (phase === "start") s.taskRuns = { ...s.taskRuns, [taskId]: { startedAt: at, finishedAt: null } };
    else if (s.taskRuns[taskId] && !s.taskRuns[taskId].finishedAt) s.taskRuns[taskId].finishedAt = at;
  }).catch(() => {});
}
