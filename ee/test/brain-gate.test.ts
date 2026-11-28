import { rm, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import type { Ctx } from "../../src/core/context.js";
import { loadGates } from "../../src/core/gates.js";
import { paths } from "../../src/core/paths.js";
import { registerServices, services } from "../../src/core/services.js";
import { loadState } from "../../src/core/state.js";
import type { Task } from "../../src/core/types.js";
import { mockRuntime } from "../../src/runtime/mock.js";
import { memoryTracker, type Tracker } from "../../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx } from "../../test/helpers.js";
import { brainKey, brainPass, listBrainReceipts } from "../src/brain/brain.js";
import { brainTickStep, teamBrain } from "../src/index.js";

/**
 * BRAIN-4: the brain's step of the background run makes no model call when the board, the limits and the day are the
 * same as at its last pass, and the job's log says so. Without what it remembered, it runs.
 */

const NOW = new Date("2026-11-05T09:00:00Z");
const hours = (h: number) => new Date(NOW.getTime() + h * 3600000);
const at = <T extends Ctx>(ctx: T, when: Date): T => ({ ...ctx, now: () => when });

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-1", identifier: "PMX-1", title: "Draft a one-pager for member exports", description: "Admins export members by hand.",
  url: "https://linear.app/x/PMX-1", category: "spec", size: "S", status: "inbox", priority: 3, agent: null,
  sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

let injected: Tracker = memoryTracker();
registerServices({ tracker: async () => injected });

describe("the brain's pass when nothing changed (BRAIN-4)", () => {
  beforeEach(freshHome);

  async function setup() {
    const { repo } = await pmxRepo();
    const tracker = memoryTracker([task(), task({ id: "lin-2", identifier: "PMX-2", status: "ready" })]);
    injected = tracker;
    const runtime = mockRuntime(() => JSON.stringify({ summary: "One to hold.", decisions: [{ task: "PMX-1", action: "hold", why: "Needs the customer's list first.", confidence: 0.7 }] }));
    const ctx = await testCtx({
      repo, runtime, now: NOW,
      team: { tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" }, synthesizer: "ana", brain: { level: "recommend", machine: null, everyHours: 4 } },
    });
    return { ctx, runtime, tracker };
  }
  const comments = (t: ReturnType<typeof memoryTracker>) => [...t.comments.values()].flat().length;

  it("asks the model once, then skips while the board and the limits stay the same, and says so in the log", async () => {
    const { ctx, runtime, tracker } = await setup();
    expect(await brainTickStep(ctx)).toBe("brain (recommend): 0 done, 0 waiting for approval, 1 suggested");
    expect(runtime.calls).toHaveLength(1);
    expect(comments(tracker)).toBe(1);
    expect(await brainTickStep(at(ctx, hours(1)))).toBeNull(); // every 4 hours

    // Due again, the same day. The first pass spent some of the day's budget, which isn't a change to the board.
    const line = await brainTickStep(at(ctx, hours(5)));
    expect(line).toBe("brain (recommend): skipped, nothing changed: the board and the limits are as they were at the last pass (2026-11-05 09:00 UTC), so no model call");
    expect(runtime.calls).toHaveLength(1);
    // Nothing is suggested twice, and no receipt is written for a pass that decided nothing.
    expect(comments(tracker)).toBe(1);
    expect(await listBrainReceipts()).toHaveLength(1);
    // It counts as the pass, so the next is 4 hours later.
    expect((await loadState()).lastBrainAt).toBe(hours(5).toISOString());
    expect(await brainTickStep(at(ctx, hours(6)))).toBeNull();
  });

  it("asks again when a task changed, and on a new day, when every task is a day older", async () => {
    const { ctx, runtime, tracker } = await setup();
    await brainTickStep(ctx);
    await tracker.setPriority("lin-1", 1);
    expect(await brainTickStep(at(ctx, hours(5)))).toMatch(/1 suggested$/);
    expect(runtime.calls).toHaveLength(2);
    expect(await brainTickStep(at(ctx, hours(10)))).toMatch(/skipped, nothing changed/);
    // 2026-11-06 03:00 UTC: the first pass of the next day runs, whatever the board looks like.
    expect(await brainTickStep(at(ctx, hours(18)))).toMatch(/1 suggested$/);
    expect(runtime.calls).toHaveLength(3);
  });

  it("runs when the last pass isn't remembered, and always when a person runs it", async () => {
    const { ctx, runtime } = await setup();
    await brainTickStep(ctx);
    await rm(paths.gates());
    expect(await brainTickStep(at(ctx, hours(5)))).toMatch(/1 suggested$/);
    expect(runtime.calls).toHaveLength(2);

    await writeFile(paths.gates(), "[1, 2");
    expect(await loadGates()).toEqual({});
    expect(await brainTickStep(at(ctx, hours(10)))).toMatch(/1 suggested$/);
    expect(runtime.calls).toHaveLength(3);

    // `pmx brain`: the model is asked, whatever is remembered.
    const policy = teamBrain(ctx.team);
    const byHand = await brainPass(at(ctx, hours(11)), await services(ctx), { policy, policyVersion: 0 });
    expect(byHand.unchanged).toBeUndefined();
    expect(runtime.calls).toHaveLength(4);
  });

  it("leaves out only what moves by itself: a task's age in days and the dollars left today", () => {
    const base = { team: { model: "m", caps: { perRunUsd: 3, perDayUsd: 20 } }, personal: { budget: { dailyUsd: 10, resetHour: 0, overrideUsd: null } } } as unknown as Pick<Ctx, "team" | "personal">;
    const policy = teamBrain({ brain: { level: "recommend" } } as any);
    const prompt = (age: number, left: string, title = "Member exports") => `Review queue: 0 of 3. Today's remaining agent budget: $${left}.\n<task id="PMX-1" status="inbox" age_days="${age}" sources="1">\n${title}\n</task>`;
    const key = (p: string, o = { policy, policyVersion: 0 }, c = base, now = NOW) => brainKey(c, o, p, now);
    expect(key(prompt(4, "10.00"))).toBe(key(prompt(5, "9.98")));
    expect(key(prompt(4, "10.00", "Member exports, with filters"))).not.toBe(key(prompt(4, "10.00")));
    expect(key(prompt(4, "10.00"), { policy: { ...policy, level: "approve" }, policyVersion: 0 })).not.toBe(key(prompt(4, "10.00")));
    expect(key(prompt(4, "10.00"), undefined, { ...base, personal: { budget: { dailyUsd: 25, resetHour: 0, overrideUsd: null } } } as any)).not.toBe(key(prompt(4, "10.00")));
    expect(key(prompt(4, "10.00"), undefined, base, hours(24))).not.toBe(key(prompt(4, "10.00")));
  });
});
