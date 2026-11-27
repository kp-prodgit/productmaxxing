import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { BOARD_SKILL, appSkillInstalled, appSkillSource, appSkillTarget, installAppSkill, refreshAppSkills, skillInstalledByPmx } from "../src/claude/skill.js";
import { COLLECT_TASK, formatTasks, tasksJson, taskFile, taskDescription } from "../src/claude/tasks.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { tmp } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;

describe("/pmx-schedule skill (CLAUDE-2)", () => {
  beforeEach(async () => {
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("installs into the PM's own Claude skills, refreshes its own copy, and never overwrites theirs", async () => {
    expect(appSkillTarget()).toBe(join(process.env.PMX_CLAUDE_HOME!, "skills", "pmx-schedule", "SKILL.md"));
    expect(await appSkillInstalled()).toBe(false);
    expect(await installAppSkill()).toBe("installed");
    expect(await readFile(appSkillTarget(), "utf8")).toBe(await readFile(appSkillSource(), "utf8"));
    expect(await installAppSkill()).toBe("current");

    await writeFile(appSkillTarget(), "<!-- Installed by ProductMaxxing -->\nname: pmx-schedule\nold version");
    expect(await installAppSkill()).toBe("updated");

    await writeFile(appSkillTarget(), "---\nname: pmx-schedule\n---\nmy own version");
    expect(await installAppSkill()).toBe("kept-yours");
    expect(await readFile(appSkillTarget(), "utf8")).toContain("my own version");
  });

  it("refreshes a copy installed before the rename (RENAME-1), never the PM's own", async () => {
    // Product Git (0.14.0 and older) wrote this line; 0.40.0 read such a copy as the PM's own and never updated it.
    const old = "---\nname: pmx-schedule\n---\n\n<!-- Installed by Product Git (pmx init / pmx schedule --install-skill), which keeps it up to date. Your edits are overwritten on the next update. -->\nan old prompt";
    await mkdir(join(appSkillTarget(), ".."), { recursive: true });
    await writeFile(appSkillTarget(), old);
    expect(await skillInstalledByPmx("pmx-schedule")).toBe(true);
    expect(await installAppSkill()).toBe("updated");
    expect(await readFile(appSkillTarget(), "utf8")).toBe(await readFile(appSkillSource(), "utf8"));

    // After an update: the old copy is refreshed; a copy the PM wrote is left alone.
    await writeFile(appSkillTarget(), old);
    await mkdir(join(appSkillTarget(BOARD_SKILL), ".."), { recursive: true });
    await writeFile(appSkillTarget(BOARD_SKILL), "---\nname: pmx-board\n---\nmy own board");
    expect(await refreshAppSkills()).toEqual(["pmx-schedule"]);
    expect(await readFile(appSkillTarget(BOARD_SKILL), "utf8")).toContain("my own board");
  });

  it("tells Claude exactly what to create, and nothing else", async () => {
    const skill = await readFile(appSkillSource(), "utf8");
    expect(skill).toContain("pmx schedule --json");
    expect(skill).toMatch(/never change or delete any other scheduled task/);

    const j = await tasksJson(team, memoryKeychain());
    expect(j.present).toEqual([]);
    // CLAUDE-6 (0.36.0): the app runs them every day; PMX's own hours decide which runs do anything.
    expect(j.missing.map((t) => [t.taskId, t.cronExpression])).toEqual([["pmx-collect-meetings", "30 12,17 * * *"], ["pmx-sync-linear", "0 * * * *"]]);
    expect(j.missing[0]!.prompt).toContain("pmx collect --prompt");

    await mkdir(join(taskFile(COLLECT_TASK.id), ".."), { recursive: true });
    await writeFile(taskFile(COLLECT_TASK.id), "---\nname: pmx-collect-meetings\n---\n\nan older prompt");
    const old = await tasksJson(team, memoryKeychain());
    expect(old.outdated.map((t) => t.taskId)).toEqual(["pmx-collect-meetings"]); // /pmx-schedule updates its prompt
    expect(old.present).toEqual([]);
    // 0.14.0: an old description is outdated too, so the app never shows stale text.
    await writeFile(taskFile(COLLECT_TASK.id), `---\nname: pmx-collect-meetings\ndescription: x\n---\n\n${COLLECT_TASK.prompt}\n`);
    expect((await tasksJson(team, memoryKeychain())).outdated.map((t) => t.taskId)).toEqual(["pmx-collect-meetings"]);
    await writeFile(taskFile(COLLECT_TASK.id), `---\nname: pmx-collect-meetings\ndescription: ${taskDescription(COLLECT_TASK)}\n---\n\n${COLLECT_TASK.prompt}\n`);
    expect((await tasksJson(team, memoryKeychain())).present).toEqual(["pmx-collect-meetings"]);
  });

  it("points to /pmx-schedule once the skill is installed", async () => {
    expect(await formatTasks(team, memoryKeychain())).toMatch(/pmx schedule --install-skill/);
    await installAppSkill();
    const out = await formatTasks(team, memoryKeychain());
    expect(out).toMatch(/type \/pmx-schedule/);
    expect(out).toContain('Create (or, if it exists, update) a scheduled task titled "PMX: sync Linear through Claude"'); // the paste fallback stays
  });
});
