import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSkillSource } from "../src/claude/skill.js";
import { appliedSchedule, COLLECT_TASK, LINEAR_SYNC_TASK, syncDueCron, taskDescription, taskDue, taskFile, taskRunHealth, tasksJson, taskState, workingTimes } from "../src/claude/tasks.js";
import { commands } from "../src/commands/index.js";
import { DEFAULT_TEAM, loadPersonalConfig, savePersonalConfig, type TeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { loadState } from "../src/core/state.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { buildChecklist } from "../src/setup/checklist.js";
import { pmxLabels, relayDir, relayHealth } from "../src/tracker/relay.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";
import { runStatus } from "../src/commands/status.js";
import { readFile } from "node:fs/promises";
import { openBoard, type Ui } from "./ui-helpers.js";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;
const LEGACY = { collect: "every weekday at 12:30 and 17:30", linear: "every hour from 8:00 to 18:00 on weekdays" };

async function writeTask(t: typeof COLLECT_TASK, description: string | null, prompt = t.prompt) {
  await mkdir(join(taskFile(t.id), ".."), { recursive: true });
  await writeFile(taskFile(t.id), `---\nname: ${t.id}\n${description === null ? "" : `description: ${description}\n`}---\n\n${prompt}\n`);
}
const runCmd = async (name: string, values: Record<string, unknown>, ctx: unknown) => {
  const out: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { out.push(a.join(" ")); });
  try { await commands.find((c) => c.name === name)!.run({ values, positionals: name === "linear" ? ["relay"] : [], ask: {} as never, ctx: async () => ctx, cliPath: "" } as never); }
  finally { spy.mockRestore(); }
  return out.join("\n");
};

describe("working hours are a PMX setting (CLAUDE-6, 0.36.0)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("the Claude app runs PMX's tasks every day, whatever the hours, and each description says so", async () => {
    const j = await tasksJson(team, memoryKeychain());
    expect(j.missing.map((t) => [t.taskId, t.cronExpression])).toEqual([["pmx-collect-meetings", "30 12,17 * * *"], ["pmx-sync-linear", "0 * * * *"]]);
    expect(j.missing[1]!.description).toBe("ProductMaxxing: carries PMX's changes to Linear and brings back the project, because PMX reaches Linear through your Claude app. Runs every hour, every day.");
    // Each prompt's first step asks PMX, and stops at once outside the PM's hours. The prompt never names the hours,
    // so changing them never changes it.
    for (const t of [COLLECT_TASK, LINEAR_SYNC_TASK]) {
      expect(t.prompt).toMatch(/If it says this run is outside the user's working hours, stop there: report that one line and do nothing else\./);
      expect(t.prompt).not.toMatch(/weekday|8:00|18:00/);
    }
    expect(workingTimes(LINEAR_SYNC_TASK, "weekdays")).toEqual({ cron: "0 8-18 * * 1-5", schedule: LEGACY.linear });
    expect(workingTimes(LINEAR_SYNC_TASK, "always")).toEqual({ cron: "0 * * * *", schedule: "every hour, every day" });
  });

  it("says inside or outside the PM's hours, by this Mac's clock", () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m); // Nov 2026: the 20th is a Friday, the 21st a Saturday
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 8, 0)).due).toBe(true);
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 18, 40)).due).toBe(true); // the 18:00 run, late
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 7, 0))).toEqual({ due: false, why: "outside your working hours (weekdays, 8:00 to 18:00)" });
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 19, 0)).due).toBe(false);
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(21, 12, 0)).due).toBe(false);
    expect(taskDue(COLLECT_TASK, "weekdays", at(20, 17, 30)).due).toBe(true);
    expect(taskDue(COLLECT_TASK, "weekdays", at(21, 12, 30))).toEqual({ due: false, why: "outside your working hours (weekdays only)" });
    expect(taskDue(COLLECT_TASK, undefined, at(21, 12, 30)).due).toBe(false);
    for (const t of [COLLECT_TASK, LINEAR_SYNC_TASK]) expect(taskDue(t, "always", at(21, 3, 0)).due).toBe(true);
  });

  it("outside the hours, the task's first command says stop, and the run counts as run; inside, it gives the instructions", async () => {
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const saturday = new Date(2026, 10, 21, 12, 30);
    const ctx = await testCtx({ repo, now: saturday, team: { tracker: team.tracker } });
    const out = await runCmd("collect", { prompt: true }, ctx);
    expect(out).toMatch(/^PMX: this run is outside your working hours \(weekdays only\), so there's nothing to do now\. Stop here: report "Outside working hours, nothing to do\." and do nothing else\./);
    expect((await loadState()).taskRuns[COLLECT_TASK.id]).toEqual({ startedAt: saturday.toISOString(), finishedAt: saturday.toISOString() });
    const relay = await runCmd("linear", { prompt: true }, ctx);
    expect(relay).toMatch(/^PMX: this run is outside your working hours \(weekdays, 8:00 to 18:00\)/);
    // Around the clock, the same Saturday run does its work.
    const always = await testCtx({ repo, now: saturday, team: { tracker: team.tracker }, personal: { taskHours: "always" } });
    expect(await runCmd("linear", { prompt: true }, always)).not.toMatch(/outside your working hours/);
    expect((await loadState()).taskRuns[LINEAR_SYNC_TASK.id]).toEqual({ startedAt: saturday.toISOString(), finishedAt: null });
  });

  it("a task from before 0.36.0 gets its new prompt and schedule from one more /pmx-schedule; a schedule the PM set stays", async () => {
    // Weekday schedule and the old prompt: outdated, and /pmx-schedule moves it to every day.
    await writeTask(LINEAR_SYNC_TASK, `ProductMaxxing: ${LINEAR_SYNC_TASK.why}. Runs ${LEGACY.linear}.`, "an older prompt");
    expect(await taskState(LINEAR_SYNC_TASK)).toBe("outdated");
    expect(await appliedSchedule(LINEAR_SYNC_TASK)).toEqual({ cron: "0 8-18 * * 1-5", schedule: LEGACY.linear, known: true });
    const j = await tasksJson(team, memoryKeychain());
    expect(j.outdated.find((t) => t.taskId === "pmx-sync-linear")).toMatchObject({ reschedule: true, cronExpression: "0 * * * *" });
    // Once /pmx-schedule wrote it, it's current, and an hours change needs nothing more in the app.
    await writeTask(LINEAR_SYNC_TASK, taskDescription(LINEAR_SYNC_TASK));
    expect(await taskState(LINEAR_SYNC_TASK)).toBe("current");
    expect((await appliedSchedule(LINEAR_SYNC_TASK)).cron).toBe("0 * * * *");
    // A description PMX didn't write: only the prompt changes; the PM's own schedule stays.
    await writeTask(COLLECT_TASK, "x", "an older prompt");
    expect((await tasksJson(team, memoryKeychain())).outdated.find((t) => t.taskId === "pmx-collect-meetings")).toMatchObject({ reschedule: false });

    const skill = await readFile(appSkillSource(), "utf8");
    expect(skill).toMatch(/If the entry's `reschedule` is true, .* also set its schedule to `cronExpression`\. Change nothing else about it\./);
  });

  it("the checklist asks for /pmx-schedule once after this update, then makes an hours change one click", () => {
    const base = {
      now: new Date(), version: "0.36.0", team, checks: [], claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null,
      setupSkill: "current" as const, engine: null, extra: [],
    };
    const personal = { handle: "kp", repoPath: "/r", installedAt: "2026-11-01T00:00:00Z" } as any;
    const updated = { lastTick: null, collectReports: [], upgrade: { lastVersion: "0.36.0", from: "0.35.0", at: "2026-11-21T10:00:00Z", applied: {} } } as any;
    const hours = (o: object) => buildChecklist({ ...base, personal, state: updated, linearCron: "0 8-18 * * 1-5", ...o } as any).sections.flatMap((s) => s.steps).find((s) => s.id === "linear.hours")!;
    // The app still runs the weekday schedule from before: one more /pmx-schedule, part of this update.
    expect(hours({})).toMatchObject({ status: "warn", afterUpdate: true, fix: { kind: "claude", command: "/pmx-schedule" } });
    expect(hours({}).page).toMatch(/once more\. After that your working hours are a PMX setting, and changing them never needs it again\./);
    // After it, on working hours: PMX's own button, no /pmx-schedule.
    const now = hours({ linearCron: "0 * * * *" });
    expect(now).toMatchObject({ status: "warn", fix: { kind: "pmx", label: "Sync whenever PMX runs" } });
    expect(now.afterUpdate).toBeFalsy();
    expect(JSON.stringify(now)).not.toMatch(/pmx-schedule/);
    expect(hours({ linearCron: "0 * * * *", personal: { ...personal, taskHours: "always" } })).toMatchObject({ status: "done", detail: "Linear syncs every hour, every day" });
  });

  it("judges a missed run by the schedule the app has, and a behind Linear copy by the PM's hours", async () => {
    await writeTask(COLLECT_TASK, taskDescription(COLLECT_TASK));
    const sat = new Date(2026, 10, 7, 9, 0); // Saturday 09:00
    const { utimes } = await import("node:fs/promises");
    await utimes(taskFile(COLLECT_TASK.id), sat, sat);
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 7, 9, 30))).toMatchObject({ ok: true, detail: expect.stringContaining("next run Sat Nov 07 12:30") });
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 7, 14, 0))).toMatchObject({ ok: false, detail: expect.stringContaining("Sat Nov 07 12:30") });

    // The sync runs every hour, but on working hours nothing is due overnight, so PMX's copy isn't "behind" at 07:55.
    await writeTask(LINEAR_SYNC_TASK, taskDescription(LINEAR_SYNC_TASK));
    expect(await syncDueCron("weekdays")).toBe("0 8-18 * * 1-5");
    expect(await syncDueCron("always")).toBe("0 * * * *");
  });

  it("calls the Linear copy behind once a sync it was due for is missed, not only after six hours", async () => {
    const synced = new Date(2026, 10, 20, 2, 5); // Friday 02:05 local
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: synced.toISOString(), projectId: "proj-1", issues: [], labels: pmxLabels(team) }));
    const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m);
    expect((await relayHealth(team, at(4, 0), { cron: "0 * * * *" })).ok).toBe(true);
    const late = await relayHealth(team, at(4, 31), { cron: "0 * * * *" });
    expect(late).toMatchObject({ ok: false });
    expect(late.detail).toMatch(/^Linear through Claude: last synced 2h ago, and missed the sync due at 03:00 \(0 change\(s\) waiting\)/);
    expect((await relayHealth(team, at(7, 55), { cron: "0 8-18 * * 1-5" })).ok).toBe(true);
    expect((await relayHealth(team, at(9, 31), { cron: "0 8-18 * * 1-5" })).ok).toBe(false);
    expect((await relayHealth(team, at(7, 55))).ok).toBe(true);
    expect((await relayHealth(team, at(8, 10))).ok).toBe(false);

    // `pmx status` says it too, by the PM's working hours (weekdays by default).
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const ctx = await testCtx({ repo, now: at(9, 31), team: { tracker: team.tracker } });
    expect(await runStatus(ctx)).toMatch(/^Linear: ✘ through Claude, last synced 7h ago, and missed the sync due at 08:00/m);
    expect(await runStatus(await testCtx({ repo, now: at(7, 55), team: { tracker: team.tracker } }))).toMatch(/^Linear: through Claude, synced 6h ago/m);
  });

  it("pmx schedule --hours saves the setting and asks for nothing in the Claude app", async () => {
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const ctx = await testCtx({ repo, team: { tracker: team.tracker } });
    await savePersonalConfig(ctx.personal);
    const out = await runCmd("schedule", { hours: "always" }, ctx);
    expect(out).toMatch(/^PMX's Claude tasks now work whenever PMX runs: .* Nothing changes in the Claude app\./);
    expect((await loadPersonalConfig()).taskHours).toBe("always");
    const h = pipelineHandlers(ctx);
    expect(await h.taskHours!("never")).toMatchObject({ status: 400 });
    expect(await h.taskHours!("weekdays")).toMatchObject({ status: 200, body: { taskHours: "weekdays", message: expect.stringMatching(/Outside them each run starts briefly and stops\./) } });
    expect((await loadPersonalConfig()).taskHours).toBe("weekdays");
  });
});

describe("the hours button on PMX's page (CLAUDE-6)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const app of [false, true]) it(`Schedule switches between working hours and whenever PMX runs${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ app, hash: "health/settings/schedule" });
    await ui.until(() => ui!.$("#task-hours"), "the hours card");
    expect(ui.text("#task-hours")).toMatch(/^Working hours: the Linear sync every hour from 8:00 to 18:00 on weekdays.*Outside working hours each run starts briefly and stops\./);
    expect(ui.button("Working hours only", "#task-hours").getAttribute("aria-pressed")).toBe("true");
    await ui.click(ui.button("Sync whenever PMX runs", "#task-hours"));
    await ui.until(() => ui!.posts.some((p) => p[0] === "task-hours"), "the change to be sent");
    expect(ui.posts.find((p) => p[0] === "task-hours")![1]).toEqual({ hours: "always" });
    await ui.until(() => /^Whenever PMX runs/.test(ui!.text("#task-hours")), "the card to say so");
    expect((await loadPersonalConfig()).taskHours).toBe("always");
    expect(ui.button("Sync whenever PMX runs", "#task-hours").getAttribute("aria-pressed")).toBe("true");
    await new Promise((r) => setTimeout(r, 400)); // the page's reload after the change, before the page closes
  }, 30000);
});
