import type { Ctx } from "../core/context.js";
import { RunLogStore } from "../core/runlog-store.js";
import type { Services } from "../core/services.js";
import type { Task } from "../core/types.js";
import { markTask } from "../lease/marks.js";
import { removePackNow } from "../run/share.js";
import { stoppedTasks, type StoppedTask } from "./failures.js";

/**
 * PULL-12: what the PM can do about a task PMX stopped after failed runs (PULL-11), from PMX's page or `pmx review`.
 * Try again puts it back in Ready with its failed-run count started over; Drop takes it out of the agents' queue for
 * good (canceled in Linear, never deleted). Each is logged in the team's run log and leaves one comment on the task.
 */
export async function listStopped(ctx: Ctx, svc: Services): Promise<StoppedTask[]> {
  const log = new RunLogStore(ctx);
  const entries = (await log.exists()) ? await log.entries() : [];
  return stoppedTasks(await svc.tracker.list({ status: ["blocked"] }), entries);
}

async function stopped(ctx: Ctx, svc: Services, ref: string): Promise<{ task: Task; s: StoppedTask; log: RunLogStore }> {
  const want = ref.trim().toLowerCase();
  const task = (await svc.tracker.list({ status: ["blocked"] })).find((t) => t.identifier.toLowerCase() === want || t.id === ref);
  const log = new RunLogStore(ctx);
  const s = task && (await log.exists()) ? stoppedTasks([task], await log.entries())[0] : undefined;
  if (!task || !s) throw new Error(`${ref.toUpperCase()} isn't stopped after failed runs: it may have been tried again or dropped already.`);
  return { task, s, log };
}

/** Through the Claude relay a change reaches Linear only at the next sync; the words say so. */
const relayed = (svc: Services) => svc.tracker.kind === "claude-relay";

/** Try again: back to Ready, with the failed-run count started over so one more failure doesn't stop it at once. */
export async function retryStopped(ctx: Ctx, svc: Services, ref: string): Promise<string> {
  const { task, s, log } = await stopped(ctx, svc, ref);
  // Logged first: the count starts over before any agent can see the task in Ready.
  await log.record({ type: "release", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task.identifier, reason: "retry" });
  await svc.tracker.comment(task.id, `Try again: ${ctx.agent} moved ${task.identifier} back to Ready after ${s.runs} runs in a row without a draft. Its count starts over, so it stops again only if its next two runs fail too.`);
  await svc.tracker.setStatus(task.id, "ready");
  await markTask(ctx, svc.tracker, task.identifier, "ready");
  return `${task.identifier} is back in Ready${relayed(svc) ? " from the next Claude sync" : ""}. An agent tries it again on PMX's next background run, and it stops again only if the next two runs fail too.`;
}

/**
 * Drop: the task leaves the agents' queue for good. It moves to canceled in Linear; nothing is deleted there. Its shared
 * quotes leave the team repo now (RUN-5), as the clean-up would remove them for a dropped task.
 */
export async function dropStopped(ctx: Ctx, svc: Services, ref: string): Promise<string> {
  const { task, s, log } = await stopped(ctx, svc, ref);
  await log.record({ type: "drop", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task.identifier });
  await svc.tracker.comment(task.id, `Dropped by ${ctx.agent} after ${s.runs} runs in a row without a draft. No agent will take it again.`);
  await svc.tracker.rewrite(task.id, { cancel: true });
  await markTask(ctx, svc.tracker, task.identifier, "dropped");
  await removePackNow(ctx, svc.tracker, task.identifier, "dropped");
  return `Dropped ${task.identifier}: no agent will take it again. It moves to canceled in Linear${relayed(svc) ? " at the next Claude sync" : ""}.`;
}
