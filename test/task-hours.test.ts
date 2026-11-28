import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSkillSource } from "../src/claude/skill.js";
import { appliedSchedule, COLLECT_TASK, formatTasks, LINEAR_SYNC_TASK, syncDueCron, taskDescription, taskDue, taskFile, taskRunHealth, tasksJson, taskState, workingTimes } from "../src/claude/tasks.js";
import { commands } from "../src/commands/index.js";
import { DEFAULT_TEAM, loadPersonalConfig, savePersonalConfig, type TeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { loadState } from "../src/core/state.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { buildChecklist } from "../src/setup/checklist.js";
import { gatherChecklist } from "../src/setup/gather.js";
import { pmxLabels, relayDir, relayHealth } from "../src/tracker/relay.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";
import { runStatus } from "../src/commands/status.js";
import { readFile } from "node:fs/promises";
import { openBoard, type Ui } from "./ui-helpers.js";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;
// How PMX worded the sync's weekday schedule before 0.41.0: a task from before 0.36.0 still has it in its description.
const LEGACY = { collect: "every weekday at 12:30 and 17:30", linear: "every hour from 8:00 to 18:00 on weekdays" };
// 0.41.0: the words for working hours, the same everywhere, and true to what `taskDue` lets through.
const WEEKDAYS = { window: "weekdays, 8:00 to 19:00", sync: "every hour on weekdays from 8:00 to 19:00 (the last run starts at 18:00)" };

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
    expect(workingTimes(LINEAR_SYNC_TASK, "weekdays")).toEqual({ cron: "0 8-18 * * 1-5", schedule: WEEKDAYS.sync });
    expect(workingTimes(LINEAR_SYNC_TASK, "always")).toEqual({ cron: "0 * * * *", schedule: "every hour, every day" });
    // 0.41.0: with no hours chosen, around the clock.
    expect(workingTimes(LINEAR_SYNC_TASK)).toEqual(workingTimes(LINEAR_SYNC_TASK, "always"));
    expect(workingTimes(COLLECT_TASK)).toEqual({ cron: "30 12,17 * * *", schedule: "every day at 12:30 and 17:30" });
  });

  it("says inside or outside the PM's hours, by this Mac's clock", () => {
    const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m); // Nov 2026: the 20th is a Friday, the 21st a Saturday
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 8, 0)).due).toBe(true);
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 18, 40)).due).toBe(true); // the 18:00 run, late
    // 0.41.0: the words say the hours PMX keeps: the 18:00 run is the last and works until 19:00.
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 7, 0))).toEqual({ due: false, why: "outside your working hours (weekdays, 8:00 to 19:00)" });
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 7, 59)).due).toBe(false);
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 18, 59)).due).toBe(true);
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(20, 19, 0)).due).toBe(false);
    expect(taskDue(LINEAR_SYNC_TASK, "weekdays", at(21, 12, 0)).due).toBe(false);
    expect(taskDue(COLLECT_TASK, "weekdays", at(20, 17, 30)).due).toBe(true);
    expect(taskDue(COLLECT_TASK, "weekdays", at(21, 12, 30))).toEqual({ due: false, why: "outside your working hours (weekdays only)" });
    // 0.41.0: a PM who never chose works around the clock, Saturday night included.
    expect(taskDue(COLLECT_TASK, undefined, at(21, 12, 30))).toEqual({ due: true, why: "PMX works around the clock on this Mac" });
    expect(taskDue(LINEAR_SYNC_TASK, undefined, at(21, 3, 0)).due).toBe(true);
    for (const t of [COLLECT_TASK, LINEAR_SYNC_TASK]) expect(taskDue(t, "always", at(21, 3, 0)).due).toBe(true);
  });

  it("outside the hours, the task's first command says stop, and the run counts as run; inside, it gives the instructions", async () => {
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const saturday = new Date(2026, 10, 21, 12, 30);
    const ctx = await testCtx({ repo, now: saturday, team: { tracker: team.tracker }, personal: { taskHours: "weekdays" } });
    const out = await runCmd("collect", { prompt: true }, ctx);
    expect(out).toMatch(/^PMX: this run is outside your working hours \(weekdays only\), so there's nothing to do now\. Stop here: report "Outside working hours, nothing to do\." and do nothing else\./);
    expect((await loadState()).taskRuns[COLLECT_TASK.id]).toEqual({ startedAt: saturday.toISOString(), finishedAt: saturday.toISOString() });
    const relay = await runCmd("linear", { prompt: true }, ctx);
    expect(relay).toMatch(/^PMX: this run is outside your working hours \(weekdays, 8:00 to 19:00\)/);
    // Around the clock, the same Saturday run does its work: chosen, or (0.41.0) with nothing chosen.
    for (const personal of [{ taskHours: "always" as const }, {}]) {
      const always = await testCtx({ repo, now: saturday, team: { tracker: team.tracker }, personal });
      expect(always.personal.taskHours).toBe(personal.taskHours);
      expect(await runCmd("linear", { prompt: true }, always)).toMatch(/^# Sync ProductMaxxing \(PMX\) with Linear/);
      expect((await loadState()).taskRuns[LINEAR_SYNC_TASK.id]).toEqual({ startedAt: saturday.toISOString(), finishedAt: null });
      expect(await runCmd("collect", { prompt: true }, always)).not.toMatch(/outside your working hours/);
    }
  });

  it("a task from before 0.36.0 gets its new prompt and schedule from one more /pmx-schedule; a schedule the PM set stays", async () => {
    // Weekday schedule and the old prompt: outdated, and /pmx-schedule moves it to every day.
    await writeTask(LINEAR_SYNC_TASK, `ProductMaxxing: ${LINEAR_SYNC_TASK.why}. Runs ${LEGACY.linear}.`, "an older prompt");
    expect(await taskState(LINEAR_SYNC_TASK)).toBe("outdated");
    // The app's description still has the old words; PMX knows the schedule by them, and says it in today's.
    expect(await appliedSchedule(LINEAR_SYNC_TASK)).toEqual({ cron: "0 8-18 * * 1-5", schedule: WEEKDAYS.sync, known: true });
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
    expect(hours({}).detail).toMatch(/still runs only every hour on weekdays from 8:00 to 19:00 \(the last run starts at 18:00\), so what you approve at night/);
    // 0.41.0: after it, with nothing chosen, Linear syncs around the clock, and that's simply done.
    const now = hours({ linearCron: "0 * * * *" });
    expect(now).toMatchObject({ status: "done", title: "Linear syncs whenever PMX runs", detail: "Linear syncs every hour, every day" });
    expect(now.fix).toBeUndefined();
    expect(hours({ linearCron: "0 * * * *", personal: { ...personal, taskHours: "always" } })).toMatchObject({ status: "done", detail: "Linear syncs every hour, every day" });
    // Working hours are a choice the PM made: stated with what it costs and where to change it, not a step left to do.
    const chosen = hours({ linearCron: "0 * * * *", personal: { ...personal, taskHours: "weekdays" } });
    expect(chosen).toMatchObject({ status: "done", title: "Linear syncs in your working hours" });
    expect(chosen.detail).toMatch(/^Linear syncs in your working hours only, as you chose \(weekdays, 8:00 to 19:00; the last sync starts at 18:00\), so what you approve at night or on a weekend waits.*Health → Settings → Schedule on PMX's page goes back to every hour, every day$/);
    expect(chosen.fix).toBeUndefined();
    expect(JSON.stringify([now, chosen])).not.toMatch(/pmx-schedule|18:00 on weekdays|8:00 to 18:00/);
  });

  it("with no Linear sync task in the Claude app, the hours step claims no schedule: the missing task is another step's", async () => {
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const ctx = await testCtx({ repo, team: { tracker: team.tracker } });
    const steps = async () => (await gatherChecklist({ personal: ctx.personal, team: ctx.team, checks: [], exec: ctx.exec, keychain: memoryKeychain(), now: ctx.now() })).sections.flatMap((s) => s.steps);
    // No task file at all: PMX can't read a schedule from it, and must not take it for a task from before 0.36.0.
    expect(await taskState(LINEAR_SYNC_TASK)).toBe("missing");
    const none = (await steps()).find((s) => s.id === "linear.hours")!;
    expect(none).toMatchObject({ status: "skip", detail: "the Claude app has no Linear sync task yet; \"The Claude app runs PMX's scheduled tasks\" says how to set it up" });
    expect(JSON.stringify(none)).not.toMatch(/still runs only|8:00|weekdays|once more|pmx-schedule/);
    expect(none.fix).toBeUndefined();
    expect((await steps()).some((s) => s.id === "claude.tasks")).toBe(true);
    // A task that is there says its schedule: one from before 0.36.0 still asks for /pmx-schedule, today's is done.
    await writeTask(LINEAR_SYNC_TASK, `ProductMaxxing: ${LINEAR_SYNC_TASK.why}. Runs ${LEGACY.linear}.`, "an older prompt");
    expect((await steps()).find((s) => s.id === "linear.hours")).toMatchObject({ status: "warn", detail: expect.stringMatching(/still runs only every hour on weekdays from 8:00 to 19:00/), fix: { kind: "claude", command: "/pmx-schedule" } });
    await writeTask(LINEAR_SYNC_TASK, taskDescription(LINEAR_SYNC_TASK));
    expect((await steps()).find((s) => s.id === "linear.hours")).toMatchObject({ status: "done", detail: "Linear syncs every hour, every day" });
    // The same from the inputs alone, whatever schedule comes with them.
    const input = { now: new Date(), version: "0.41.0", team, checks: [], claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current" as const, engine: null, extra: [],
      personal: ctx.personal, state: { lastTick: null, collectReports: [] } as any, linearCron: "0 8-18 * * 1-5" };
    const only = (o: object) => buildChecklist({ ...input, ...o } as any).sections.flatMap((s) => s.steps).find((s) => s.id === "linear.hours")!;
    expect(only({ linearTaskMissing: true }).status).toBe("skip");
    expect(only({}).status).toBe("warn");
    expect(only({ linearCron: null, linearTaskMissing: false })).toMatchObject({ status: "skip", detail: "PMX writes to Linear directly" });
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
    expect(await syncDueCron()).toBe("0 * * * *"); // 0.41.0: nothing chosen is around the clock
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

    // `pmx status` says it too, by the PM's hours. On working hours only, nothing was due before 08:00.
    await writeTask(LINEAR_SYNC_TASK, taskDescription(LINEAR_SYNC_TASK));
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const status = (h: number, m: number, personal: object = {}) => testCtx({ repo, now: at(h, m), team: { tracker: team.tracker }, personal }).then(runStatus);
    expect(await status(9, 31, { taskHours: "weekdays" })).toMatch(/^Linear: ✘ through Claude, last synced 7h ago, and missed the sync due at 08:00/m);
    expect(await status(7, 55, { taskHours: "weekdays" })).toMatch(/^Linear: through Claude, synced 6h ago/m);
    // 0.41.0: with nothing chosen the sync is due every hour, so the same copy is behind before 08:00 too.
    expect(await status(7, 55)).toMatch(/^Linear: ✘ through Claude, last synced 6h ago, and missed the sync due at 03:00/m);
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

  it("around the clock is the usual setting, and working hours the choice, wherever PMX says the hours (0.41.0)", async () => {
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const ctx = await testCtx({ repo, team: { tracker: team.tracker } });
    expect(ctx.personal.taskHours).toBeUndefined();
    await savePersonalConfig(ctx.personal);
    for (const t of [COLLECT_TASK, LINEAR_SYNC_TASK]) await writeTask(t, taskDescription(t));
    const esc = (x: string) => x.replace(/[()]/g, "\\$&");
    const board = async () => (await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain })).rules;
    // Nothing chosen: `pmx schedule` reads as around the clock, with working hours as the option.
    const usual = await formatTasks(team, memoryKeychain(), ctx.personal.taskHours);
    expect(usual).toMatch(/^. PMX: sync Linear through Claude: set up, every hour, every day; /m);
    expect(usual).toMatch(/^Hours: around the clock, PMX's usual setting\. \(For working hours only, weekdays, 8:00 to 19:00 for the Linear sync: pmx schedule --hours weekdays\.\)$/m);
    expect(usual).toMatch(/^· They work around the clock unless you choose working hours only/m);
    expect(usual).not.toMatch(/Outside them each run|; works /);
    // The page's settings say the same.
    expect((await board()).taskHours).toBe("always");

    // Choosing working hours says exactly which hours, in the same words each time, and how to go back.
    const said = await runCmd("schedule", { hours: "weekdays" }, ctx);
    expect((await loadPersonalConfig()).taskHours).toBe("weekdays");
    expect(said).toMatch(new RegExp(`^PMX's Claude tasks now work in your working hours only: the Linear sync ${esc(WEEKDAYS.sync)}, and meeting collection at 12:30 and 17:30 on weekdays\\. Outside them each run starts briefly and stops\\.`));
    expect(said).toMatch(/^To go back to around the clock, PMX's usual setting: pmx schedule --hours always$/m);
    const chosen = await formatTasks(team, memoryKeychain(), "weekdays");
    expect(chosen).toMatch(new RegExp(`^. PMX: sync Linear through Claude: set up, every hour, every day; works ${esc(WEEKDAYS.sync)}; `, "m"));
    expect(chosen).toMatch(/^. PMX: collect meetings and update to-dos: set up, every day at 12:30 and 17:30; works every weekday at 12:30 and 17:30; /m);
    expect(chosen).toMatch(new RegExp(`^Hours: working hours only, as you chose: the Linear sync ${esc(WEEKDAYS.sync)}, and meeting collection on weekdays\\. Outside them each run starts briefly and stops\\. \\(Back to around the clock, PMX's usual setting: pmx schedule --hours always\\.\\)$`, "m"));
    expect((await board()).taskHours).toBe("weekdays");
    // Nothing still says the sync stops at 18:00.
    expect(`${usual}\n${said}\n${chosen}`).not.toMatch(/8:00 to 18:00|8:00–18:00/);
  });

  it("the user docs say the same hours as the code (0.41.0)", async () => {
    const docs = await Promise.all(["README.md", "GUIDE.md"].map((f) => readFile(join(__dirname, "..", f), "utf8")));
    for (const d of docs) {
      expect(d).not.toMatch(/8:00 to 18:00|8:00–18:00|hourly on weekdays\)|weekdays 12:30 and 17:30/);
      expect(d).toMatch(/8:00 to 19:00/);
    }
    // README: one account of when changes reach Linear, wherever it's said.
    expect(docs[0]).toMatch(/Changes reach Linear at the next sync \(every hour, every day, while the Claude app is open and the Mac is awake\), not instantly\./);
    expect(docs[0]).toMatch(/\*\*Working hours only\*\* \(`pmx schedule --hours weekdays`\) is the other choice/);
    expect(docs[1]).toMatch(/\| Claude app, every day at 12:30 and 17:30 \| automatic \|/);
  });
});

describe("the hours button on PMX's page (CLAUDE-6)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const app of [false, true]) it(`Schedule switches between working hours and whenever PMX runs${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ app, hash: "health/settings/schedule" });
    await ui.until(() => ui!.$("#task-hours"), "the hours card");
    // 0.41.0: with nothing chosen, the card opens on whenever PMX runs, and says that's the usual setting.
    expect(ui.text("#task-hours")).toMatch(/^Whenever PMX runs: the Linear sync every hour, every day, and meeting collection every day at 12:30 and 17:30\. This is PMX's usual setting\./);
    expect(ui.text("#task-hours")).not.toMatch(/Outside working hours/);
    expect(ui.button("Sync whenever PMX runs", "#task-hours").getAttribute("aria-pressed")).toBe("true");
    await ui.click(ui.button("Working hours only", "#task-hours"));
    await ui.until(() => ui!.posts.some((p) => p[0] === "task-hours"), "the change to be sent");
    expect(ui.posts.find((p) => p[0] === "task-hours")![1]).toEqual({ hours: "weekdays" });
    await ui.until(() => /^Working hours only/.test(ui!.text("#task-hours")), "the card to say so");
    expect(ui.text("#task-hours")).toMatch(/^Working hours only, as you chose: the Linear sync every hour on weekdays from 8:00 to 19:00 \(the last run starts at 18:00\), and meeting collection at 12:30 and 17:30 on weekdays\..*Outside working hours each run starts briefly and stops\./);
    expect((await loadPersonalConfig()).taskHours).toBe("weekdays");
    expect(ui.button("Working hours only", "#task-hours").getAttribute("aria-pressed")).toBe("true");
    // And back, once the page has read the board again after the change.
    await new Promise((r) => setTimeout(r, 400));
    await ui.click(ui.button("Sync whenever PMX runs", "#task-hours"));
    await ui.until(() => /^Whenever PMX runs/.test(ui!.text("#task-hours")), "the card to say so");
    expect((await loadPersonalConfig()).taskHours).toBe("always");
    await new Promise((r) => setTimeout(r, 400)); // the page's reload after the change, before the page closes
  }, 30000);
});
