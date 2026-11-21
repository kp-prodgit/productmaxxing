import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appSkillSource } from "../src/claude/skill.js";
import { appliedSchedule, atHours, COLLECT_TASK, LINEAR_SYNC_TASK, taskDescription, taskFile, taskRunHealth, tasksJson, taskState } from "../src/claude/tasks.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { pmxLabels, relayDir, relayHealth } from "../src/tracker/relay.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";
import { runStatus } from "../src/commands/status.js";
import { readFile } from "node:fs/promises";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;

async function writeTask(t: typeof COLLECT_TASK, description: string | null) {
  await mkdir(join(taskFile(t.id), ".."), { recursive: true });
  await writeFile(taskFile(t.id), `---\nname: ${t.id}\n${description === null ? "" : `description: ${description}\n`}---\n\n${t.prompt}\n`);
}

describe("when PMX's Claude tasks run (CLAUDE-5)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("asks for around-the-clock schedules, and says in each description when the task runs", async () => {
    const j = await tasksJson(team, memoryKeychain(), "always");
    expect(j.missing.map((t) => [t.taskId, t.cronExpression])).toEqual([["pmx-collect-meetings", "30 12,17 * * *"], ["pmx-sync-linear", "0 * * * *"]]);
    expect(j.missing[1]!.description).toBe("ProductMaxxing: carries PMX's changes to Linear and brings back the project, because PMX reaches Linear through your Claude app. Runs every hour, every day.");
    expect((await tasksJson(team, memoryKeychain())).missing.map((t) => t.cronExpression)).toEqual(["30 12,17 * * 1-5", "0 8-18 * * 1-5"]);
  });

  it("moves an existing task to the new schedule through /pmx-schedule, and leaves an up-to-date one alone", async () => {
    // A task made by an older pmx: weekday schedule, description without one. Still current on weekdays: no nudge on update.
    await writeTask(LINEAR_SYNC_TASK, `ProductMaxxing: ${LINEAR_SYNC_TASK.why}.`);
    expect(await taskState(LINEAR_SYNC_TASK)).toBe("current");
    expect(await appliedSchedule(LINEAR_SYNC_TASK)).toEqual({ cron: "0 8-18 * * 1-5", schedule: "every hour from 8:00 to 18:00 on weekdays" });

    const always = atHours(LINEAR_SYNC_TASK, "always");
    expect(await taskState(always)).toBe("outdated");
    const j = await tasksJson(team, memoryKeychain(), "always");
    expect(j.outdated.find((t) => t.taskId === "pmx-sync-linear")).toMatchObject({ reschedule: true, cronExpression: "0 * * * *" });

    // Once /pmx-schedule wrote the new description, the app has the new schedule.
    await writeTask(LINEAR_SYNC_TASK, taskDescription(always));
    expect(await taskState(always)).toBe("current");
    expect((await appliedSchedule(LINEAR_SYNC_TASK)).cron).toBe("0 * * * *");
    // Only a prompt change: the PM's own edits to the schedule stay.
    await writeTask(COLLECT_TASK, "x");
    expect((await tasksJson(team, memoryKeychain())).outdated.find((t) => t.taskId === "pmx-collect-meetings")).toMatchObject({ reschedule: false });

    const skill = await readFile(appSkillSource(), "utf8");
    expect(skill).toMatch(/If the entry's `reschedule` is true, .* also set its schedule to `cronExpression`\. Change nothing else about it\./);
  });

  it("judges a missed run by the schedule the app has", async () => {
    await writeTask(COLLECT_TASK, taskDescription(atHours(COLLECT_TASK, "always")));
    const sat = new Date(2026, 10, 7, 9, 0); // Saturday 09:00
    const { utimes } = await import("node:fs/promises");
    await utimes(taskFile(COLLECT_TASK.id), sat, sat);
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 7, 9, 30))).toMatchObject({ ok: true, detail: expect.stringContaining("next run Sat Nov 07 12:30") });
    // On weekdays only, Saturday 14:00 would be fine; every day, the 12:30 run was missed.
    expect(await taskRunHealth(COLLECT_TASK, new Date(2026, 10, 7, 14, 0))).toMatchObject({ ok: false, detail: expect.stringContaining("Sat Nov 07 12:30") });
  });

  it("calls the Linear copy behind once a sync it was due for is missed, not only after six hours", async () => {
    const synced = new Date(2026, 10, 20, 2, 5); // Friday 02:05 local
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: synced.toISOString(), projectId: "proj-1", issues: [], labels: pmxLabels(team) }));
    const at = (h: number, m = 0) => new Date(2026, 10, 20, h, m);
    // Every hour: the 03:00 sync was missed by 04:31.
    expect((await relayHealth(team, at(4, 0), { cron: "0 * * * *" })).ok).toBe(true);
    const late = await relayHealth(team, at(4, 31), { cron: "0 * * * *" });
    expect(late).toMatchObject({ ok: false });
    expect(late.detail).toMatch(/^Linear through Claude: last synced 2h ago, and missed the sync due at 03:00 \(0 change\(s\) waiting\)/);
    // Weekdays 8–18: nothing was due overnight, so 07:55 is fine, and 09:31 is behind.
    expect((await relayHealth(team, at(7, 55), { cron: "0 8-18 * * 1-5" })).ok).toBe(true);
    expect((await relayHealth(team, at(9, 31), { cron: "0 8-18 * * 1-5" })).ok).toBe(false);
    // Without a schedule, the old six-hour limit.
    expect((await relayHealth(team, at(7, 55))).ok).toBe(true);
    expect((await relayHealth(team, at(8, 10))).ok).toBe(false);

    // `pmx status` says it too, by the schedule the Claude app has (weekdays here).
    const { repo } = await pmxRepo({ tracker: team.tracker });
    const ctx = await testCtx({ repo, now: at(9, 31), team: { tracker: team.tracker } });
    expect(await runStatus(ctx)).toMatch(/^Linear: ✘ through Claude, last synced 7h ago, and missed the sync due at 08:00/m);
    expect(await runStatus(await testCtx({ repo, now: at(7, 55), team: { tracker: team.tracker } }))).toMatch(/^Linear: through Claude, synced 6h ago/m);
  });
});
