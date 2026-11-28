import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { appSkillSource, appSkillTarget, SETUP_SKILL } from "../src/claude/skill.js";
import { fakeLaunchd, plist } from "../src/core/launchd.js";
import { paths, pmxHome } from "../src/core/paths.js";
import { loadState, updateState } from "../src/core/state.js";
import { loadPersonalConfig, savePersonalConfig, type PersonalConfig } from "../src/core/config.js";
import { AUTO_STEPS, markFreshInstall, TASK_HOURS_KEPT, TASK_HOURS_MOVED, upgradeOnStart, type AutoStep } from "../src/core/upgrade.js";
import { buildChecklist } from "../src/setup/checklist.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, personal, tmp } from "./helpers.js";

const noExec = (async () => ({ code: 1, stdout: "", stderr: "" })) as any;
const deps = (o: Partial<Parameters<typeof upgradeOnStart>[0]> = {}) => ({ exec: noExec, launchd: fakeLaunchd(), cliPath: "/x/cli.js", interactive: true, devInstall: async () => false, ...o });
const v = currentVersion();

/** Steps that only count their runs, at the versions a test needs. */
function counting() {
  const ran: string[] = [];
  const mk = (id: string, since: string | null, o: Partial<AutoStep> = {}): AutoStep => ({ id, since, title: id, run: async () => { ran.push(id); return `did ${id}`; }, ...o });
  return { ran, mk };
}

describe("version-aware update steps (UPGRADE-1)", () => {
  // Each test gets its own Claude app folder: other test files install PMX's commands into the shared one.
  beforeEach(async () => { await freshHome(); process.env.PMX_CLAUDE_HOME = await tmp("pmx-claude-"); });

  it("runs what applies to the version a Mac came from, once each, and nothing on the next command", async () => {
    await writeFile(paths.config(), "{}");
    // A Mac whose last pmx predates this record: NEW-1 remembers the version it last ran.
    await updateState((s) => { s.whatsNew = { seen: "0.20.0", since: null }; });
    const { ran, mk } = counting();
    const steps = [mk("every", null), mk("since-0.25", "0.25.0"), mk("since-0.10", "0.10.0"), mk("later", "99.0.0")];
    const r = await upgradeOnStart(deps(), steps);
    expect(r.from).toBe("0.20.0");
    // 0.20.0 is before 0.25.0 and 99.0.0, not before 0.10.0.
    expect(ran.sort()).toEqual(["every", "later", "since-0.25"]);
    const rec = (await loadState()).upgrade!;
    expect(rec).toMatchObject({ lastVersion: v, from: "0.20.0" });
    expect(Object.keys(rec.applied).sort()).toEqual([`every@${v}`, "later", "since-0.25"]);
    ran.length = 0;
    expect((await upgradeOnStart(deps(), steps)).did).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("treats a set-up Mac with no record of its version as old; a Mac never set up, or a fresh install, as current", async () => {
    const { ran, mk } = counting();
    const steps = [mk("every", null), mk("since-0.25", "0.25.0"), mk("next", "99.0.0")];
    // Never set up: no settings, no record. Nothing to upgrade.
    expect(await upgradeOnStart(deps(), steps)).toMatchObject({ from: v, did: [] });
    expect(ran).toEqual([]);

    await freshHome();
    await writeFile(paths.config(), "{}");
    await upgradeOnStart(deps(), steps);
    expect(ran.sort()).toEqual(["every", "next", "since-0.25"]);

    await freshHome();
    await markFreshInstall(new Date(), steps);
    ran.length = 0;
    expect((await upgradeOnStart(deps(), steps)).did).toEqual([]);
    expect(ran).toEqual([]);
  });

  it("leaves a job reload to a command someone runs, and retries a step that failed", async () => {
    await writeFile(paths.config(), "{}");
    await updateState((s) => { s.whatsNew = { seen: "0.20.0", since: null }; });
    let fail = true;
    const { ran, mk } = counting();
    const steps = [mk("job", null, { interactiveOnly: true }), mk("flaky", null, { run: async () => { if (fail) throw new Error("not now"); ran.push("flaky"); return "ok"; } })];
    const bg = await upgradeOnStart(deps({ interactive: false }), steps);
    expect(bg.waiting.map((w) => [w.id, w.why])).toEqual([["job", "waits for the next pmx command you run"], ["flaky", "not now"]]);
    expect(ran).toEqual([]);
    fail = false;
    const fg = await upgradeOnStart(deps(), steps);
    expect(fg.did.map((d) => d.id)).toEqual(["job", "flaky"]);
    // The starting point stays the version this Mac came from.
    expect(fg.from).toBe("0.20.0");
  });

  it("refreshes PMX's commands in the Claude app and adds /pmx-setup where PMX installed /pmx-schedule", async () => {
    await mkdir(join(appSkillTarget(), ".."), { recursive: true });
    await writeFile(appSkillTarget(), "---\nname: pmx-schedule\n---\n<!-- Installed by ProductMaxxing -->\nold");
    const skills = AUTO_STEPS.find((s) => s.id === "app-skills")!;
    expect(await skills.run(deps())).toBe(`updated /pmx-schedule, /${SETUP_SKILL} (new)`);
    expect(await readFile(appSkillTarget(), "utf8")).toBe(await readFile(appSkillSource(), "utf8"));
    expect(await readFile(appSkillTarget(SETUP_SKILL), "utf8")).toBe(await readFile(appSkillSource(SETUP_SKILL), "utf8"));
    expect(await skills.run(deps())).toBeNull();
  });

  it("points the Claude app's PMX server at this pmx, but never from a source checkout", async () => {
    const file = process.env.PMX_CLAUDE_DESKTOP_CONFIG!;
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(file, JSON.stringify({ mcpServers: { pmx: { command: "/old/node", args: ["/old/cli.js", "mcp"] }, other: { command: "x" } } }));
    const mcp = AUTO_STEPS.find((s) => s.id === "mcp-entry")!;
    expect(await mcp.run(deps({ devInstall: async () => true }))).toBeNull();
    expect(await mcp.run(deps())).toBe("pointed the Claude app's PMX server at this pmx");
    const cfg = JSON.parse(await readFile(file, "utf8"));
    expect(cfg.mcpServers.pmx.args).toEqual(["/x/cli.js", "mcp"]);
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
  });

  it("rewrites a stale background job for this PMX home only, and never under a running pass", async () => {
    const job = mkJob();
    const cli0 = join(await tmp("pmx-cli-"), "cli.js");
    await writeFile(cli0, "");
    const cli = realpathSync(cli0);
    await job.install(plist({ node: "/gone/node", cli: "/gone/cli.js", pmxHome: pmxHome(), claude: null }));
    const step = AUTO_STEPS.find((s) => s.id === "background-job")!;
    job.busy = true;
    await expect(step.run(deps({ launchd: job, cliPath: cli }))).rejects.toThrow(/running right now/);
    job.busy = false;
    expect(await step.run(deps({ launchd: job, cliPath: cli }))).toBe("refreshed the background job with this pmx, Node and Claude Code");
    expect(job.plist).toContain(`<string>${cli}</string>`);
    expect(job.plist).not.toContain("/gone/");
    expect(await step.run(deps({ launchd: job, cliPath: cli }))).toBeNull();

    // A job another PMX home registered (a second install on this Mac) is left as it is.
    await job.install(plist({ node: "/gone/node", cli: "/gone/cli.js", pmxHome: "/elsewhere/.pmx", claude: null }));
    expect(await step.run(deps({ launchd: job, cliPath: cli }))).toBeNull();
    expect(job.plist).toContain("/gone/cli.js");
  });

  describe("0.41.0: PMX's Claude tasks work around the clock by default (CLAUDE-6)", () => {
    const hours = AUTO_STEPS.filter((s) => s.id === "task-hours-always");
    /** A Mac set up on an older pmx, with the hours its PM chose, or none. */
    const macFrom = async (from: string, taskHours?: PersonalConfig["taskHours"]) => {
      await savePersonalConfig(personal("/r", taskHours ? { taskHours } : {}));
      await updateState((s) => { s.upgrade = { lastVersion: from, from: "0.39.0", at: "2026-11-26T09:00:00.000Z", applied: {} }; });
    };

    it("moves a Mac that never chose its hours to around the clock, once, and says so with the way back", async () => {
      expect(hours).toHaveLength(1);
      expect(hours[0]).toMatchObject({ since: "0.41.0", title: "When the Linear sync and meeting collection work" });
      await macFrom("0.40.3");
      expect((await loadPersonalConfig()).taskHours).toBeUndefined();
      const r = await upgradeOnStart(deps(), hours);
      expect(r.did).toEqual([{ id: "task-hours-always", title: hours[0]!.title, did: TASK_HOURS_MOVED }]);
      expect(TASK_HOURS_MOVED).toBe("PMX's Linear sync and meeting collection now work around the clock, where they worked on weekdays only (to go back: pmx schedule --hours weekdays)");
      expect(TASK_HOURS_MOVED).not.toMatch(/\n/);
      expect((await loadPersonalConfig()).taskHours).toBe("always");
      // Once: the next commands say nothing, and a PM who then goes back to working hours keeps them.
      expect((await upgradeOnStart(deps(), hours)).did).toEqual([]);
      await savePersonalConfig({ ...(await loadPersonalConfig()), taskHours: "weekdays" });
      expect((await upgradeOnStart(deps(), hours)).did).toEqual([]);
      expect(await hours[0]!.run(deps())).toBe(TASK_HOURS_KEPT);
      expect((await loadPersonalConfig()).taskHours).toBe("weekdays");
    });

    it("keeps the hours a PM chose, weekdays or always, and never tells a PM on weekdays they're around the clock", async () => {
      for (const chosen of ["weekdays", "always"] as const) {
        await freshHome();
        await macFrom("0.40.3", chosen);
        const before = await readFile(paths.config(), "utf8");
        // A kept weekdays is said as kept; a chosen always had nothing to change.
        expect((await upgradeOnStart(deps(), hours)).did).toEqual([{ id: "task-hours-always", title: hours[0]!.title, did: chosen === "weekdays" ? TASK_HOURS_KEPT : "nothing to do" }]);
        expect(await readFile(paths.config(), "utf8")).toBe(before);
        expect((await loadPersonalConfig()).taskHours).toBe(chosen);

        // The checklist's Updates section, as the PM reads it: title and what was done, on one line.
        const cl = buildChecklist({
          now: new Date("2026-11-27T10:00:00Z"), version: v, personal: await loadPersonalConfig(), team: null, checks: [], state: await loadState(), claude: true, hasRemote: true, memoryFilled: true,
          proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: null, extra: [],
        });
        const step = cl.sections.find((s) => s.id === "update")!.steps.find((s) => s.id === "update.task-hours-always")!;
        const line = `${step.title}: ${step.detail}`;
        if (chosen === "weekdays") {
          expect(step.status).toBe("done");
          expect(line).toMatch(/^When the Linear sync and meeting collection work: kept the working hours you chose for the Linear sync and meeting collection \(weekdays; PMX's default is now around the clock: pmx schedule --hours always\) \(/);
          expect(line).not.toMatch(/work around the clock|nothing to do/);
        } else expect(line).toMatch(/^When the Linear sync and meeting collection work: nothing to do \(/);
      }
      expect(TASK_HOURS_KEPT).not.toMatch(/\n/);
    });

    it("tells a new install nothing, and a Mac with no settings nothing", async () => {
      // A fresh `pmx init`: no step for an older version applies, and its hours are the default, with none saved.
      await savePersonalConfig(personal("/r"));
      await markFreshInstall(new Date(), hours);
      expect((await upgradeOnStart(deps(), hours)).did).toEqual([]);
      // `pmx checklist --fix` runs every step whatever was recorded: a Mac that started on 0.41.0 or later never had
      // the weekday default, so there's nothing to move and nothing to say.
      await updateState((s) => { s.upgrade = { lastVersion: v, from: "0.41.0", at: "2026-11-27T09:00:00.000Z", applied: {} }; });
      expect(await hours[0]!.run(deps())).toBeNull();
      expect((await loadPersonalConfig()).taskHours).toBeUndefined();
      // No settings at all (pmx never set up): nothing to do.
      await freshHome();
      expect(await hours[0]!.run(deps())).toBeNull();
    });
  });
});

function mkJob() {
  const f = Object.assign(fakeLaunchd(), { busy: false });
  return Object.assign(f, { running: async () => f.busy });
}
