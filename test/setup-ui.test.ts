import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { DEFAULT_TEAM, type PersonalConfig } from "../src/core/config.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { buildChecklist, recordChecklist } from "../src/setup/checklist.js";
import { runStatus } from "../src/commands/status.js";
import { freshHome, git, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";

const fail = (id: string, detail: string) => ({ id, ok: false, detail, level: "fail" as const });
const ok = (id: string) => ({ id, ok: true, detail: id, level: "fail" as const });

describe("PMX's page shows where this Mac stands (SETUP-1)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const app of [false, true]) it(`Status shows the summary and every step, in the page's own words${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({
      app, hash: "status",
      before: async (ctx) => {
        await recordChecklist(buildChecklist({
          now: new Date(), version: "0.35.0", personal: ctx.personal, team: { ...DEFAULT_TEAM, approve: { startNow: false }, tracker: { kind: "linear", teamKey: "PMX", projectId: "p" } } as any,
          checks: [ok("os.macos"), ok("node"), ok("claude.installed"), ok("config.team"), ok("schedule.launchd"), fail("profile.signed-in", "PMX's Claude profile isn't signed in: run `pmx claude login`")],
          state: { lastTick: { at: new Date().toISOString(), failed: [], failStreak: 0 }, collectReports: [] } as any, claude: true, hasRemote: false, memoryFilled: true,
          proposals: 2, tasks: { pool: 3, ready: 0, blocked: 0 }, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: null, extra: [],
        }));
      },
    });
    await ui.until(() => ui!.$("#setup-summary"), "the setup summary");
    expect(ui.text("#setup-summary")).toMatch(/Where you stand.*PMX is set up, but 3 required steps are left before it can do its job: PMX's own Claude profile is signed in; PMX reaches your team's Linear; Meetings reach PMX\./);
    expect(ui.text("#setup-summary")).toMatch(/Next: PMX's own Claude profile is signed in\. Only you can sign in PMX's own Claude profile, once\. In the Claude app, type \/pmx-setup and Claude shows you how\./);
    await ui.click(ui.button("See every step", "main"));
    await ui.until(() => ui!.$("#setup-work"), "the steps");
    expect(ui.text("#setup-step-work-ready")).toMatch(/A teammate makes tasks Ready for agents.*0 Ready for agents, 3 in the backlog.*Next: A teammate moves the backlog.s tasks worth an agent.s time to Todo in Linear, or to Ready on your team.s board.*To do/);
    expect(ui.text("#setup-step-setup-remote")).toMatch(/no remote.*Look at this/);
    // The page never names PMX's terminal commands: /pmx-setup does those with the PM.
    expect(pageText(ui)).not.toMatch(/\bpmx [a-z]/);
  }, 30000);
});

describe("team settings without a remote, and approval wording (BOARD-9, #11)", () => {
  beforeEach(freshHome);

  it("applies only PMX's settings branches, and only when there's no remote to review them", async () => {
    const solo = await pmxRepo();
    const h = pipelineHandlers(await testCtx({ repo: solo.repo }));
    expect(await h.teamApply("main")).toMatchObject({ status: 400 });
    expect(await h.teamApply("pmx/settings-1; rm -rf /")).toMatchObject({ status: 400 });
    const shared = await pmxRepo({}, { remote: true });
    await git(shared.repo, "branch", "pmx/settings-20261120120000");
    const r = await pipelineHandlers(await testCtx({ repo: shared.repo })).teamApply("pmx/settings-20261120120000");
    expect(r).toMatchObject({ status: 409, body: { error: expect.stringMatching(/has a remote, so this is a pull request/) } });
  });

  it("says that approving sends a task to the pool, and that a teammate makes it Ready", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team: { approve: { startNow: false } } });
    const { stageProposals } = await import("../src/synth/proposals.js");
    const [p] = await stageProposals([{ title: "Spec SCIM", category: "spec", size: "S", description: "Why.\n\npmx:source T1", sources: ["T1"], from: null } as any]);
    const msg = await pipelineHandlers(ctx).proposals?.("approve", [p!.id]);
    expect(msg).toMatch(/^Approved PMX-\d+: it goes to your team's backlog in Linear\. An agent takes it only after a teammate moves it to Todo in Linear\.$/);
  });

  it("says Start now makes a task Ready for agents, and Later puts it in the pool (APPROVE-3)", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const { stageProposals } = await import("../src/synth/proposals.js");
    const [a, b] = await stageProposals([{ title: "Spec SCIM", category: "spec", size: "S", description: "Why.", sources: ["T1"], from: null } as any, { title: "Spec audit logs", category: "spec", size: "S", description: "Why.", sources: ["T2"], from: null } as any]);
    expect(await pipelineHandlers(ctx).proposals?.("start", [a!.id])).toMatch(/^Started PMX-\d+: it becomes Ready for agents now, and an agent takes it from there\.$/);
    expect(await pipelineHandlers(ctx).proposals?.("approve", [b!.id])).toMatch(/^Approved PMX-\d+ for later: it waits in your team's backlog in Linear\. When you want an agent on it, move it to Todo in Linear\.$/);
  });

  it("pmx status says practice mode and a stale team package", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: new Date(), personal: { installedAt: new Date().toISOString() } as Partial<PersonalConfig> as any });
    expect(await runStatus(ctx)).toMatch(/\nAgents: practice mode until \d{4}-\d\d-\d\d: your agent says which task it would take, without running it/);
  });

  it("has the commands Claude needs: checklist, guide and migrate", () => {
    for (const name of ["checklist", "guide", "migrate"]) expect(commands.find((c) => c.name === name), name).toBeTruthy();
    expect(commands.find((c) => c.name === "checklist")!.usage).toBe("pmx checklist [--json] [--all] [--fix [<step>]] [--install-skill]");
  });
});
