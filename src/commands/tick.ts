import { scriptedAsker } from "../core/ask.js";
import { isoWeek, type Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { loadState, updateState, TICK_GAP_MS } from "../core/state.js";
import { readDirect, sayLinearProblem } from "../linear/direct.js";
import { LinearError } from "../tracker/linear.js";
import { runDigest } from "./digest.js";

export type TickStep = (ctx: Ctx) => Promise<string | null>;

/** The digest step: on the PM's digest weekday, build and stage the digest once per week. */
export const digestStep: TickStep = async (ctx) => {
  const state = await loadState();
  const now = ctx.now();
  if (now.getDay() !== ctx.personal.digest.weekday) return null;
  if (state.lastDigestWeek === isoWeek(now)) return null;
  return runDigest(ctx, scriptedAsker({}), { stage: true });
};

/**
 * `pmx tick`, run by launchd every 30 minutes. Each step is independent: one failing
 * doesn't stop the others. The kill switch stops everything (SEC-6).
 */
export async function runTick(ctx: Ctx, steps: [string, TickStep][]): Promise<string[]> {
  const ks = await killSwitchOn(ctx.repo).catch(() => ({ on: false, reason: null }));
  if (ks.on) return [`kill switch on (${ks.reason}): nothing ran`];
  const out: string[] = [];
  let paused = false, linearSaid = false;
  for (const [name, step] of steps) {
    try {
      const r = await step(ctx);
      if (r) out.push(`${name}: ${r}`);
    } catch (e: any) {
      // A paused or used-up budget isn't a failure (BUDGET-2): said once per pass, not once per step.
      if (e?.budgetPaused) {
        if (!paused) out.push(`budget: ${e.message}`);
        paused = true;
      } else if (e instanceof LinearError && e.failure !== "forbidden") {
        // LINEAR-2: a key Linear no longer accepts, or its rate limit, stops every step that needs Linear. Said once per
        // pass, in plain words with what to do (the key), or once in all (the rate limit, which PMX waits out); the
        // key also as one notification. Never a step's failure, and never a quiet switch to the Claude app's sync.
        if (!linearSaid) {
          // Nothing on record (a tracker that keeps none): the refusal's own words, so it is never swallowed.
          const recorded = await readDirect().then((r) => !!r.problem, () => false);
          const line = recorded ? await sayLinearProblem().catch(() => e.message as string) : (e.message as string);
          if (line) out.push(`linear: ${line}`);
        }
        linearSaid = true;
      } else out.push(`${name}: failed: ${e.message}`);
    }
  }
  return out;
}

/** Saves the pass's failures, so `pmx status` and `pmx doctor` show a job that keeps failing. Never throws. */
export async function recordTick(lines: string[], now = new Date()): Promise<void> {
  const failed = lines.filter((l) => /^[\w-]+: failed: /.test(l));
  await updateState((s) => {
    // OBS-4: a pass that comes long after the last one means the Mac slept (or was off) in between, and nothing ran.
    if (s.lastTick && now.getTime() - Date.parse(s.lastTick.at) > TICK_GAP_MS)
      s.tickGaps = [...(s.tickGaps ?? []).filter((g) => now.getTime() - Date.parse(g.to) < 14 * 86400000), { from: s.lastTick.at, to: now.toISOString() }].slice(-20);
    s.lastTick = { at: now.toISOString(), failed, failStreak: failed.length ? (s.lastTick?.failStreak ?? 0) + 1 : 0 };
  }).catch(() => {});
}

/** What `pmx status` and `pmx doctor` say about the background job's recent runs. Null before its first run. */
export function tickHealth(t: { at: string; failed: string[]; failStreak: number } | null, minStreak = 3, now?: Date): { ok: boolean; detail: string } | null {
  if (!t) return null;
  const when = t.at.slice(0, 16).replace("T", " ");
  // OBS-4: no pass for a while is the Mac asleep or off, or the job stopped. Either way nothing runs.
  if (now && now.getTime() - Date.parse(t.at) > TICK_GAP_MS) {
    const h = (now.getTime() - Date.parse(t.at)) / 3600000;
    return { ok: false, detail: `background job hasn't run since ${when} UTC (${h < 48 ? `${h.toFixed(1)} h` : `${Math.round(h / 24)} days`} ago): this Mac was probably asleep or off, and PMX runs only while it's awake` };
  }
  if (!t.failed.length) return { ok: true, detail: `background job's last run ${when} UTC: no failures` };
  const first = (t.failed[0] ?? "").slice(0, 300);
  return {
    ok: t.failStreak < minStreak,
    detail: `background job failed ${t.failStreak} run${t.failStreak === 1 ? "" : "s"} in a row (last ${when} UTC): ${first}. Log: ~/.pmx/logs/tick.log`,
  };
}
