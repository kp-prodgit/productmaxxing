// SETUP-2: every checklist step PMX can do itself has a button; Claude's steps show their slash command with Copy;
// a person's step is one sentence and a link. The buttons run an allowlist of PMX's own code, never a step's text, and
// one that changes the background job or the Claude app's settings asks on the Mac first.
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appSkillTarget, SETUP_SKILL } from "../src/claude/skill.js";
import { commands } from "../src/commands/index.js";
import { DEFAULT_TEAM, type PersonalConfig } from "../src/core/config.js";
import type { Exec } from "../src/core/exec.js";
import { exec as realExec } from "../src/core/exec.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { buildChecklist, checklistFile, readHistory, recordChecklist, type Checklist } from "../src/setup/checklist.js";
import { FIXES, runFix } from "../src/setup/fix.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";

const ok = (id: string, detail = id) => ({ id, ok: true, detail, level: "fail" as const });
const fail = (id: string, detail: string) => ({ id, ok: false, detail, level: "fail" as const });
const warn = (id: string, detail: string) => ({ id, ok: false, detail, level: "warn" as const });
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "p" };

/** A Mac with one step of each kind open: the background job off (PMX), the scheduled tasks missing (Claude), Claude Code missing (a person). */
function mixed(personal: PersonalConfig, now = new Date()): Checklist {
  return buildChecklist({
    now, version: currentVersion(), personal, team: { ...DEFAULT_TEAM, tracker: LINEAR } as any,
    checks: [ok("os.macos"), ok("node"), fail("claude.installed", "Claude Code installed (https://code.claude.com)"), ok("config.team"), fail("schedule.launchd", "no launchd job registered"),
      warn("claude.task.pmx-collect-meetings", "Claude scheduled task \"PMX: collect meetings and update to-dos\" is missing: type /pmx-schedule in the Claude app"), ok("claude.allow")],
    state: { lastTick: null, collectReports: [] } as any, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null,
    setupSkill: "missing", linearCron: null, engine: null, extra: [],
  });
}
const steps = (cl: Checklist) => cl.sections.flatMap((s) => s.steps);
const step = (cl: Checklist, id: string) => steps(cl).find((s) => s.id === id)!;

/** An exec that records every command and never runs one. */
function recordingExec(): Exec & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (cmd: string, args: string[]) => { calls.push([cmd, ...args].join(" ")); return { code: 1, stdout: "", stderr: "not in tests" }; }) as Exec & { calls: string[] };
  f.calls = calls;
  return f;
}

describe("the checklist says who does each open step and how (SETUP-2)", () => {
  beforeEach(freshHome);

  it("classes every open step: PMX's button, Claude's slash command, or a person's sentence", async () => {
    const cl = mixed({ handle: "kp", repoPath: "/r", installedAt: "2026-11-01T00:00:00Z" } as any);
    expect(step(cl, "job.installed").fix).toEqual({ kind: "pmx", label: "Turn on automatic runs", asks: true, text: expect.stringMatching(/It asks you on the Mac first\.$/) });
    expect(step(cl, "claude.tasks").fix).toMatchObject({ kind: "claude", command: "/pmx-schedule" });
    expect(step(cl, "claude.installed").fix).toEqual({ kind: "person", text: "Install Claude Code, then open this page again.", link: "https://code.claude.com" });
    expect(step(cl, "claude.setup").fix).toMatchObject({ kind: "pmx", label: "Add /pmx-setup" });
    expect(step(cl, "claude.setup").fix!.asks).toBeUndefined();
    // Every open step has one, and every PMX button is in the allowlist; done steps have none.
    for (const s of steps(cl)) {
      if (s.status === "todo" || s.status === "warn") expect(s.fix, s.id).toBeTruthy();
      else expect(s.fix, s.id).toBeUndefined();
      if (s.fix?.kind === "pmx") expect(Object.keys(FIXES), s.id).toContain(s.id);
    }
    // The page's words for them name no pmx command.
    expect(JSON.stringify(steps(cl).map((s) => [s.fix, s.page]))).not.toMatch(/\bpmx [a-z]/);
  });

  it("refuses a step outside the allowlist, one that isn't open, and one PMX can't do; never runs a step's text", async () => {
    const { repo } = await pmxRepo();
    const exec = recordingExec();
    const ctx = { ...(await testCtx({ repo })), exec };
    const cl = mixed(ctx.personal);
    const yes = async () => true;
    expect(await runFix("claude.installed", cl, { ctx, confirm: yes })).toEqual({ status: 404, message: "PMX can't do that step itself." });
    expect(await runFix("toString", cl, { ctx, confirm: yes })).toMatchObject({ status: 404 });
    expect(await runFix("job.paths", cl, { ctx, confirm: yes })).toMatchObject({ status: 409, message: "That step is already done, or doesn't apply on this Mac." });
    expect(await runFix("job.installed", null, { ctx, confirm: yes })).toMatchObject({ status: 409 });
    // A step the checklist says Claude does is refused even if it were allowlisted.
    const claudeOnly = structuredClone(cl);
    step(claudeOnly, "job.installed").fix = { kind: "claude", command: "/pmx-setup", text: "Claude does it." };
    expect(await runFix("job.installed", claudeOnly, { ctx, confirm: yes })).toEqual({ status: 409, message: "Claude does it." });

    // A recorded step whose text was changed to a command: the fix runs PMX's own code, and nothing from the text.
    const tampered = structuredClone(cl);
    const marker = join(await tmp("marker-"), "ran");
    step(tampered, "job.installed").do = `touch ${marker}`;
    const r = await runFix("job.installed", tampered, { ctx, confirm: yes, cliPath: "/usr/local/lib/pmx/cli.js" });
    expect(r).toMatchObject({ status: 200, message: "Automatic runs are on. PMX checks every 30 minutes while this Mac is awake." });
    expect(await (ctx.launchd as ReturnType<typeof fakeLaunchd>).installed()).toMatch(/<string>\/usr\/local\/lib\/pmx\/cli\.js<\/string>\s*<string>tick<\/string>/);
    expect(exec.calls.join("\n")).not.toMatch(/touch|ran/);
    await expect(stat(marker)).rejects.toThrow();
  });

  it("asks on the Mac before changing the background job or the Claude app's settings, and not for PMX's own commands", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    await recordChecklist(mixed(ctx.personal));
    const asked: (string | undefined)[] = [];
    const no = pipelineHandlers(ctx, { confirm: async (p) => { asked.push(p); return false; } });
    const r: any = await no.checklistFix!("job.installed");
    expect(r).toMatchObject({ status: 409, body: { error: "Nothing changed: you chose Don't Allow on the Mac, or nobody answered." } });
    expect(asked).toEqual([expect.stringMatching(/^Your PMX page wants to turn on PMX's background job on this Mac, so PMX checks every 30 minutes on its own\.\n\nAllow it only if you just clicked it on your PMX page\.$/)]);
    expect(await ctx.launchd.installed()).toBeNull();
    // The page gets the checklist back either way, so it re-renders where the Mac stands.
    expect(r.body.setup.sections.length).toBeGreaterThan(0);

    // Adding /pmx-setup is what every update does unattended: no dialog.
    asked.length = 0;
    const added: any = await no.checklistFix!("claude.setup");
    expect(added).toMatchObject({ status: 200, body: { message: expect.stringMatching(/^\/pmx-setup is in the Claude app\./) } });
    expect(asked).toEqual([]);
    expect(await readFile(appSkillTarget(SETUP_SKILL), "utf8")).toContain("name: pmx-setup");
    // Worked out again and recorded: the step is done now.
    const now = (await readHistory())!.last!;
    expect(step(now, "claude.setup").status).toBe("done");
    expect(added.body.setup.sections.flatMap((s: any) => s.steps).find((s: any) => s.id === "claude.setup").status).toBe("done");
  });

  it("pmx checklist --fix <step> runs the same allowlist, asking in Terminal; plain --fix keeps doing the update steps", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const cmd = commands.find((c) => c.name === "checklist")!;
    const said: string[] = [];
    const errs: string[] = [];
    const log = console.log, err = console.error;
    console.log = () => {}; console.error = (m: string) => errs.push(m);
    try {
      const ask = { confirm: async (q: string) => { said.push(q); return false; } } as any;
      expect(await cmd.run({ values: { fix: true }, positionals: ["job.installed"], ask, ctx: async () => ctx, cliPath: "/x/cli.js" })).toBe(1);
      expect(said).toEqual(["PMX will turn on PMX's background job on this Mac, so PMX checks every 30 minutes on its own. Go ahead?"]);
      expect(errs.at(-1)).toMatch(/^Nothing changed/);
      expect(await cmd.run({ values: { fix: true }, positionals: ["profile.signed-in"], ask, ctx: async () => ctx, cliPath: "/x/cli.js" })).toBe(1);
      expect(errs.at(-1)).toBe("PMX can't do that step itself.");
      await expect(cmd.run({ values: {}, positionals: ["job.installed"], ask, ctx: async () => ctx, cliPath: "" })).rejects.toThrow(/only with --fix/);
    } finally { console.log = log; console.error = err; }
    expect(cmd.usage).toBe("pmx checklist [--json] [--all] [--fix [<step>]] [--install-skill]");
    expect(await stat(checklistFile()).then(() => true)).toBe(true);
  });
});

describe("the fix on PMX's page (SETUP-2)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const app of [false, true]) it(`Setup shows a button, a slash command with Copy, or a sentence and a link; the button does it${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ app, hash: "health/setup", before: async (ctx) => { await recordChecklist(mixed(ctx.personal)); } });
    await ui.until(() => ui!.$("#setup-step-job-installed"), "the steps");
    // PMX's own: a button with the Mac mark, since it asks on the Mac first.
    const turnOn = ui.button("Turn on automatic runs", "#setup-step-job-installed");
    expect(turnOn.querySelector("use")!.getAttribute("href")).toBe("#i-mac");
    // Claude's: the slash command, with Copy.
    expect(ui.$("#setup-step-claude-tasks .cmdline code")!.textContent).toBe("/pmx-schedule");
    expect(ui.button("Copy /pmx-schedule", "#setup-step-claude-tasks")).toBeTruthy();
    // A person's: one sentence and a link.
    expect(ui.text("#setup-step-claude-installed")).toMatch(/Next: Install Claude Code, then open this page again\./);
    expect(ui.$("#setup-step-claude-installed a")!.getAttribute("href")).toBe("https://code.claude.com");
    expect(ui.$("#setup-step-claude-installed button")).toBeNull();
    // Nowhere on the page, shown or folded, a pmx command.
    expect(pageText(ui)).not.toMatch(/\bpmx [a-z]/);

    await ui.click(ui.button("Add /pmx-setup", "#setup-step-claude-setup"));
    await ui.until(() => ui!.posts.some((p) => p[0] === "checklist-fix"), "the fix to be sent");
    expect(ui.posts.find((p) => p[0] === "checklist-fix")![1]).toEqual({ step: "claude.setup" });
    await ui.until(() => /Done/.test(ui!.text("#setup-step-claude-setup")), "the step to show done", 20000);
    expect(ui.text("#toast")).toMatch(/\/pmx-setup is in the Claude app/);
    await new Promise((r) => setTimeout(r, 300));
  }, 40000);

  it("Needs you's setup card carries the step's own button", async () => {
    ui = await openBoard({ hash: "needs", before: async (ctx) => { await recordChecklist(mixed(ctx.personal)); } });
    const card = await ui.until(() => ui!.all("main [role=listitem]").find((r) => /Next setup step/.test(r.textContent ?? "")), "the setup card");
    expect(card.textContent).toMatch(/Next setup step: Claude Code is installed/);
    expect(card.querySelector("a")!.getAttribute("href")).toBe("https://code.claude.com");
  }, 30000);
});
