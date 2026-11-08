import type { Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";

/**
 * "Run now" on the board (BOARD-5): one step of the background job, run on this Mac by the board's own server, the
 * same code the 30-minute pass runs. Each step keeps its own rules (the synthesis Mac, the company Mac, the first
 * week's dry runs, the budget), so running one early can't do anything the background job wouldn't. One run per step
 * at a time; the board polls and shows how it ended.
 */
export const RUNNABLE = ["tick", "digest", "todo", "release", "synthesize", "company", "pull", "update", "events"] as const;
export type RunnableStep = (typeof RUNNABLE)[number];

export interface Job { step: RunnableStep; startedAt: string; finishedAt: string | null; ok: boolean | null; message: string | null }
const jobs = new Map<RunnableStep, Job>();

export function jobList(): Job[] {
  return [...jobs.values()];
}

/** What the step said, in words for the board. `null` from a step means it found nothing to do. */
async function runStep(ctx: Ctx, step: RunnableStep): Promise<string> {
  const ks = await killSwitchOn(ctx.repo).catch(() => ({ on: false, reason: null }));
  if (ks.on && step !== "update") throw new Error(`Your team's emergency stop is on (${ks.reason ?? "no reason given"}), so nothing runs.`);
  if (step === "digest") {
    const [{ runDigest }, { scriptedAsker }] = await Promise.all([import("../commands/digest.js"), import("../core/ask.js")]);
    const r = await runDigest(ctx, scriptedAsker({}), { stage: true });
    return r.startsWith("Staged") ? "This week's digest is ready. Read it in Digest, then approve or reject it." : r === "Nothing to digest." ? "No customer calls in the last 7 days to digest." : r;
  }
  if (step === "todo") {
    const { refreshTodos } = await import("../todo/todo.js");
    const r = await refreshTodos(ctx, {});
    return r.meetings.read ? `Read ${r.meetings.read} meeting(s) and found ${r.added.length} new to-do(s).` : "No new meetings to read for to-dos.";
  }
  const { tickSteps } = await import("../commands/index.js");
  if (step === "tick") {
    const { runTick, recordTick } = await import("../commands/tick.js");
    const lines = await runTick(ctx, tickSteps);
    await recordTick(lines, ctx.now());
    return lines.length ? lines.join("\n") : "Every step ran; none had anything new to do.";
  }
  const fn = tickSteps.find(([n]) => n === step)?.[1];
  if (!fn) throw new Error(`Unknown step ${step}.`);
  return (await fn(ctx)) ?? "Nothing to do right now.";
}

export function startJob(ctx: Ctx, step: string): { status: number; body: unknown } {
  if (!(RUNNABLE as readonly string[]).includes(step)) return { status: 400, body: { error: `Unknown step "${step}".` } };
  const s = step as RunnableStep;
  const cur = jobs.get(s);
  if (cur && !cur.finishedAt) return { status: 409, body: { error: "That's already running." } };
  const job: Job = { step: s, startedAt: ctx.now().toISOString(), finishedAt: null, ok: null, message: null };
  jobs.set(s, job);
  runStep(ctx, s).then(
    (m) => Object.assign(job, { finishedAt: new Date().toISOString(), ok: true, message: m.replace(/`([^`]+)`/g, "$1") }),
    (e: any) => Object.assign(job, { finishedAt: new Date().toISOString(), ok: false, message: String(e?.message ?? e).replace(/`([^`]+)`/g, "$1") }),
  );
  return { status: 202, body: { message: "Started.", job } };
}
