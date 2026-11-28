// PULL-12: a task PMX stopped after failed runs in a row shows on PMX's page, with Try again, Edit task and Drop, and
// the same in `pmx review`. Only tasks PMX itself stopped: a task a person moved to Blocked isn't one.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import type { Ctx } from "../src/core/context.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { failStreaks, failureReason, stoppedTasks } from "../src/pull/failures.js";
import { pull } from "../src/pull/pull.js";
import { dropStopped, listStopped, retryStopped } from "../src/pull/stopped.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { readOutbox, relayDir } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const run = (taskId: string, ts: string, outcome: "ok" | "failed" | "capped" | "refused", o: { durationMs?: number; skillVersion?: string } = {}): RunLogEntry => ({
  type: "run", taskId, ts, agent: "ana@m1", machine: "m1", category: "spec", size: "S", skill: "pmx-spec", skillVersion: o.skillVersion ?? "1.0.0",
  outcome, durationMs: o.durationMs ?? 60000, tokens: null, costUsd: null, runtime: "claude-code",
});
async function eventually(fn: () => Promise<boolean>, what: string, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
const task = (identifier: string, status: string) => ({ identifier, title: `Task ${identifier}`, url: `https://linear.app/acme/issue/${identifier}`, status, category: "spec" });

describe("which tasks PMX stopped (PULL-12)", () => {
  it("only Blocked tasks with two failed runs in a row; a person's Blocked, a draft since, Try again or Drop leave it out", () => {
    const log: RunLogEntry[] = [
      run("PMX-1", "2026-11-20T10:00:00Z", "failed"), run("PMX-1", "2026-11-20T11:00:00Z", "capped"),
      run("PMX-2", "2026-11-20T10:00:00Z", "failed"),
      run("PMX-3", "2026-11-20T09:00:00Z", "failed"), run("PMX-3", "2026-11-20T10:00:00Z", "failed"), run("PMX-3", "2026-11-20T11:00:00Z", "ok"),
      run("PMX-5", "2026-11-20T09:00:00Z", "failed"), run("PMX-5", "2026-11-20T10:00:00Z", "failed"),
      { type: "release", taskId: "PMX-5", reason: "retry", ts: "2026-11-20T12:00:00Z", agent: "ana@m1", machine: "m1" },
      run("PMX-6", "2026-11-20T09:00:00Z", "failed"), run("PMX-6", "2026-11-20T10:00:00Z", "failed"),
      { type: "drop", taskId: "PMX-6", ts: "2026-11-20T12:00:00Z", agent: "ana@m1", machine: "m1" },
      run("PMX-7", "2026-11-20T09:00:00Z", "failed"), run("PMX-7", "2026-11-20T10:00:00Z", "refused"),
    ];
    const tasks = ["PMX-1", "PMX-2", "PMX-3", "PMX-4", "PMX-5", "PMX-6", "PMX-7"].map((id) => task(id, "blocked"));
    expect(stoppedTasks(tasks, log)).toEqual([{ identifier: "PMX-1", title: "Task PMX-1", url: "https://linear.app/acme/issue/PMX-1", category: "spec", runs: 2, reason: "The last run hit the spending cap for one run.", at: "2026-11-20T11:00:00Z" }]);
    // The same task, moved back to Ready by hand, isn't stopped any more.
    expect(stoppedTasks([task("PMX-1", "ready")], log)).toEqual([]);
    expect(failStreaks(log).get("PMX-5")).toBeUndefined();
    expect([
      failureReason({ outcome: "failed", durationMs: 0, skillVersion: "-" }), failureReason({ outcome: "failed", durationMs: 0, skillVersion: "1.0.0" }), failureReason({ outcome: "failed", durationMs: 9000, skillVersion: "1.0.0" }),
    ]).toEqual(["Its kind of work has no skill PMX can run.", "The last run stopped before an agent started: its kind of work isn't set up to run.", "The agent's last draft didn't pass its checks."]);
  });
});

const inline = (over: Partial<Task>): Task => ({
  id: "lin-1", identifier: "PMX-1", title: "Spec SCIM provisioning",
  description: "Admins sync users by hand.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n\npmx:source T1",
  url: "https://linear.app/acme/issue/PMX-1", category: "spec", size: "S", status: "ready", priority: 1, agent: null,
  sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});
/** An agent whose drafts never pass: no headings, no citations. */
const failing = () => mockRuntime(async (o) => {
  const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
  await mkdir(dirname(join(o.cwd, out)), { recursive: true });
  await writeFile(join(o.cwd, out), "no headings, no citations");
  return { text: "Drafted.", costUsd: 0.1 };
});

describe("Try again and Drop (PULL-12)", () => {
  beforeEach(freshHome);

  it("Try again puts the task back in Ready with its count started over, logged, with one comment; one more failure doesn't stop it", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const ctx = await testCtx({ repo, runtime: failing(), now: new Date(2026, 10, 4, 10) });
    const tracker = memoryTracker([inline({}), inline({ id: "lin-2", identifier: "PMX-2", title: "Spec audit logs", status: "blocked" })]);
    const svc = await services(ctx, { tracker });
    await pull(ctx, svc, { dryRun: false });
    await pull(ctx, svc, { dryRun: false });
    expect(tracker.tasks.get("lin-1")!.status).toBe("blocked");
    expect(tracker.comments.get("lin-1")!.at(-1)).toMatch(/choose Try again under Needs you on PMX's page \(or drop it there\)\.$/);
    // PMX-2 was moved to Blocked by a person: it isn't one PMX stopped.
    expect((await listStopped(ctx, svc)).map((t) => [t.identifier, t.runs, t.reason])).toEqual([["PMX-1", 2, "The agent's last draft didn't pass its checks."]]);
    await expect(retryStopped(ctx, svc, "PMX-2")).rejects.toThrow(/PMX-2 isn't stopped after failed runs/);

    const before = tracker.comments.get("lin-1")!.length;
    expect(await retryStopped(ctx, svc, "pmx-1")).toBe("PMX-1 is back in Ready. An agent tries it again on PMX's next background run, and it stops again only if the next two runs fail too.");
    expect(tracker.tasks.get("lin-1")!.status).toBe("ready");
    expect(tracker.comments.get("lin-1")!.slice(before)).toEqual([`Try again: ${ctx.agent} moved PMX-1 back to Ready after 2 runs in a row without a draft. Its count starts over, so it stops again only if its next two runs fail too.`]);
    const entries = await new RunLogStore(ctx).entries();
    expect(entries.at(-1)).toMatchObject({ type: "release", taskId: "PMX-1", reason: "retry", agent: ctx.agent });
    expect(await listStopped(ctx, svc)).toEqual([]);

    // One more failure goes back to Ready, not Blocked: the count started over.
    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).not.toMatch(/moved to Blocked/);
    expect(tracker.tasks.get("lin-1")!.status).toBe("ready");
    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toMatch(/moved to Blocked after 2 runs in a row without a draft$/);
  });

  it("Drop takes the task out of the agents' queue for good, logged, with one comment", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const ctx = await testCtx({ repo, runtime: failing(), now: new Date(2026, 10, 4, 10) });
    const tracker = memoryTracker([inline({})]);
    const svc = await services(ctx, { tracker });
    await pull(ctx, svc, { dryRun: false });
    await pull(ctx, svc, { dryRun: false });
    const before = tracker.comments.get("lin-1")!.length;
    expect(await dropStopped(ctx, svc, "PMX-1")).toBe("Dropped PMX-1: no agent will take it again. It moves to canceled in Linear.");
    expect(tracker.comments.get("lin-1")!.slice(before)).toEqual([`Dropped by ${ctx.agent} after 2 runs in a row without a draft. No agent will take it again.`]);
    // The memory tracker's cancel takes the task away; Linear's moves it to canceled.
    expect(tracker.tasks.has("lin-1")).toBe(false);
    expect((await new RunLogStore(ctx).entries()).at(-1)).toMatchObject({ type: "drop", taskId: "PMX-1" });
    await expect(dropStopped(ctx, svc, "PMX-1")).rejects.toThrow(/isn't stopped after failed runs/);
  });

  it("pmx review --stopped lists them, and --retry and --drop act on one", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const ctx = await testCtx({ repo, runtime: failing(), now: new Date(2026, 10, 4, 10) });
    const cmd = commands.find((c) => c.name === "review")!;
    expect(cmd.usage).toContain("pmx review --stopped | --retry <PMX-12> | --drop <PMX-12>");
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      expect(await cmd.run({ positionals: [], values: { stopped: true }, ctx: async () => ctx, ask: null as any } as any)).toBe(0);
    } finally { console.log = log; }
    expect(logs).toEqual(["No task is stopped after failed runs."]);
  });
});

describe("the stopped-task card on PMX's page (PULL-12)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });
  const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
  const node = (n: number, status: string) => ({
    id: `uuid-${n}`, identifier: `PMX-${n}`, title: n === 19 ? "Spec SCIM provisioning" : `Task ${n}`, description: "", url: `https://linear.app/acme/issue/PMX-${n}`, priority: 0,
    createdAt: "2026-11-19T10:00:00Z", comments: { nodes: [] }, labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "S", parent: { name: "pmx-size" } }] },
  });
  // PMX-19 failed twice in a row and PMX stopped it; PMX-20 a person moved to Blocked.
  const seed = async (ctx: Ctx) => {
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [node(19, "blocked"), node(20, "blocked")] }));
    const store = new RunLogStore(ctx);
    for (const ts of ["2026-11-20T09:00:00Z", "2026-11-20T10:00:00Z"]) {
      const { type: _t, ts: _ts, ...e } = run("PMX-19", ts, "failed", { durationMs: 0 });
      await store.record({ type: "run", ...e, agent: ctx.agent, ts } as any);
    }
  };
  const card = (u: Ui) => u.all("main section.group").find((s) => s.getAttribute("aria-label") === "Stopped after failed runs");

  it("shows the task with its failed runs and why, above the tasks to approve, with Try again, Edit task and Drop", async () => {
    ui = await openBoard({ hash: "needs", team: { tracker: LINEAR as any }, before: seed });
    await ui.until(() => card(ui!), "the stopped-task card");
    const c = card(ui)!;
    expect(c.textContent).toMatch(/Spec SCIM provisioning/);
    expect(c.textContent).toMatch(/PMX-19/);
    expect(c.textContent).toMatch(/Stopped after 2 failed runs in a row/);
    expect(c.textContent).toMatch(/The last run stopped before an agent started: its kind of work isn't set up to run\./);
    expect(c.textContent).not.toMatch(/Task 20/);
    expect([...c.querySelectorAll(".acts button, .acts a")].map((b) => b.textContent!.trim())).toEqual(["Try again", "Edit task", "Drop"]);
    expect(c.querySelector(".acts a")!.getAttribute("href")).toBe("https://linear.app/acme/issue/PMX-19");
    expect(ui.$("#b-needs")!.textContent).not.toBe("");
    expect(c.textContent).not.toMatch(/\bpmx [a-z]/);

    await ui.click(ui.button("Try again", "main"));
    expect(ui.text("#toast")).toMatch(/Trying PMX-19 again\. It goes back to Ready at the next Linear sync, with its count of failed runs started over\./);
    await ui.until(() => ui!.posts.some((p) => p[0] === "stopped"), "Try again to be sent", 8000);
    expect(ui.posts.find((p) => p[0] === "stopped")![1]).toEqual({ identifier: "PMX-19", action: "retry" });
    await eventually(async () => (await readOutbox()).ops.some((o: any) => o.kind === "set-status" && o.value === "ready" && o.state === "unstarted"), "the task to go back to Ready");
    const ops = (await readOutbox()).ops as any[];
    expect(ops.filter((o) => o.kind === "comment").map((o) => o.body)).toEqual([expect.stringMatching(/^Try again: .* moved PMX-19 back to Ready after 2 runs in a row without a draft\./)]);
    // TASK-7: the label and Linear's own state go back together, in one save.
    expect(ops.find((o) => o.kind === "set-status")).toMatchObject({ target: "PMX-19", value: "ready", state: "unstarted" });
    await ui.until(() => !card(ui!), "the card to go");
  }, 30000);

  it("Drop cancels it in Linear at the next sync, with one comment", async () => {
    ui = await openBoard({ hash: "inbox", team: { tracker: LINEAR as any }, before: seed });
    await ui.until(() => card(ui!), "the stopped-task card");
    await ui.click(card(ui)!.querySelector("button.sa")!);
    expect(ui.text("#toast")).toMatch(/Dropped PMX-19\. No agent takes it again; it moves to canceled in Linear at the next Linear sync\./);
    await ui.until(() => ui!.posts.some((p) => p[0] === "stopped"), "Drop to be sent", 8000);
    await eventually(async () => (await readOutbox()).ops.some((o: any) => o.kind === "rewrite"), "the cancel to be queued");
    const ops = (await readOutbox()).ops as any[];
    expect(ops.map((o) => o.kind)).toEqual(["comment", "rewrite"]);
    expect(ops[0].body).toMatch(/^Dropped by .* after 2 runs in a row without a draft\. No agent will take it again\.$/);
    expect(ops[1]).toMatchObject({ target: "PMX-19", cancel: true });
    expect(ops[1]).not.toHaveProperty("description");
    await ui.until(() => !card(ui!), "the card to go");
  }, 30000);
});
