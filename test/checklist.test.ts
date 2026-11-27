import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { brainStep } from "../ee/src/index.js";
import type { DoctorCheck } from "../src/commands/doctor.js";
import { recordTick, tickHealth } from "../src/commands/tick.js";
import { DEFAULT_TEAM, type PersonalConfig } from "../src/core/config.js";
import { loadState, type State } from "../src/core/state.js";
import { buildChecklist, checklistFile, checklistForPage, formatChecklist, PAGE_HINT, readHistory, recordChecklist, type ChecklistInputs, type Step } from "../src/setup/checklist.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const NOW = new Date("2026-11-20T18:00:00Z");
const ok = (id: string, detail = id): DoctorCheck => ({ id, ok: true, detail, level: "fail" });
const warn = (id: string, detail: string): DoctorCheck => ({ id, ok: false, detail, level: "warn" });
const fail = (id: string, detail: string): DoctorCheck => ({ id, ok: false, detail, level: "fail" });
const HEALTHY = [
  ok("os.macos"), ok("node", "Node 24.1.0"), ok("claude.installed", "Claude Code 2.1"), ok("cli.team-minimum"), ok("profile.signed-in", "signed in"),
  ok("config.personal"), ok("config.team", "pmx.config.json valid (team Acme)"), ok("cli.team-package", "team package pmx 0.34.0"),
  ok("privacy.company-domains", "company domains acme.example"), ok("privacy.canaries", "180 of 180 test meetings held"),
  ok("schedule.launchd", "launchd job loaded"), ok("schedule.tick", "last pass ok"), ok("claude.allow", "allow rules present"),
  ok("claude.task.collect", "Claude scheduled task \"Collect meetings\""), ok("claude.task.collect.ran", "\"Collect meetings\" ran"),
  ok("claude.task.linear-sync", "Claude scheduled task \"Sync Linear\""), ok("linear.relay", "Linear through Claude: last synced 20 min ago"),
  ok("flow.mcp", "the Claude app can start PMX's server"), ok("claude.board", "team board https://claude.ai/artifact/b"),
];
const PERSONAL = { handle: "kp", repoPath: "/Users/kp/pmx", installedAt: "2026-11-08T07:25:00Z", taskHours: "always", flow: { url: "https://claude.ai/artifact/f", version: "0.34.0", publishedAt: "2026-11-19T01:49:00Z" } } as unknown as PersonalConfig;
const STATE = { lastTick: { at: "2026-11-20T17:40:00Z", failed: [], failStreak: 0 }, collectReports: [{ at: "2026-11-20T18:52:00Z", connector: "granola", saved: 7, skipped: {} }], tickGaps: [] } as unknown as State;

function inputs(o: Partial<ChecklistInputs> = {}): ChecklistInputs {
  return {
    now: NOW, version: "0.35.0", personal: PERSONAL, team: { ...DEFAULT_TEAM, tracker: { kind: "linear", teamKey: "PMX", projectId: "p" } } as any,
    checks: HEALTHY, state: STATE, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: { pool: 0, ready: 2, blocked: 0 },
    practiceUntil: null, lastRun: { taskId: "PMX-19", outcome: "ok", ts: "2026-11-20T17:00:00Z" }, setupSkill: "current", linearCron: "0 * * * *",
    engine: null, extra: [], ...o,
  };
}
const find = (cl: ReturnType<typeof buildChecklist>, id: string) => cl.sections.flatMap((s) => s.steps).find((s) => s.id === id)!;

describe("the install checklist (SETUP-1)", () => {
  beforeEach(freshHome);

  it("a Mac with pmx but no setup: says so, and the next step is pmx init, by the user, in Terminal", () => {
    const cl = buildChecklist(inputs({ personal: null, team: null, checks: [ok("os.macos"), ok("node"), ok("claude.installed")], hasRemote: null, memoryFilled: null, proposals: null, tasks: null }));
    expect(cl.where).toBe("pmx 0.35.0 is installed but not set up on this Mac yet: setup asks a few questions only you can answer, then registers the background job.");
    expect(cl.next).toMatchObject({ id: "setup.config", status: "todo", who: "you", how: "terminal", required: true });
    expect(cl.next!.do).toMatch(/^pmx init/);
    expect(cl).toMatchObject({ format: 1, tool: "pmx", version: "0.35.0" });
  });

  it("a healthy Mac: running, with what's waiting in the work and who does it (#11, #14)", () => {
    // A team with a separate triage owner (APPROVE-3 off): a teammate makes tasks Ready.
    const cl = buildChecklist(inputs({ team: { ...DEFAULT_TEAM, approve: { startNow: false }, tracker: { kind: "linear", teamKey: "PMX", projectId: "p" } } as any, proposals: 3, tasks: { pool: 4, ready: 0, blocked: 1 }, practiceUntil: "2026-11-22T07:25:00Z" }));
    expect(cl.where).toMatch(/^PMX is installed and running on this Mac\. 3 new tasks wait for your approval; 4 tasks in the backlog, none Ready for agents; agents are in practice mode until Nov 22\./);
    expect(find(cl, "work.ready")).toMatchObject({ status: "todo", who: "teammate", how: "linear" });
    expect(find(cl, "work.ready").detail).toMatch(/Approving sends a task to the backlog; an agent takes it only after a teammate moves it to Todo in Linear\./);
    expect(find(cl, "work.practice")).toMatchObject({ status: "warn", do: "Wait, or run one now with pmx pull --live" });
    expect(find(cl, "work.agents").detail).toMatch(/1 task Blocked after failing twice in a row/);
    expect(find(cl, "work.agents")).toMatchObject({ who: "you", how: "page", page: "In Needs you, under Stopped after failed runs, try each one again, edit it or drop it." });
    expect(cl.next!.id).toBe("work.approve");
    expect(cl.counts.todo).toBeGreaterThanOrEqual(2);
  });

  it("with Start now on, Ready comes from the PM's own approval, so it isn't a step anyone waits on (APPROVE-3)", () => {
    const cl = buildChecklist(inputs({ proposals: 3, tasks: { pool: 4, ready: 0, blocked: 0 } }));
    expect(find(cl, "work.ready")).toMatchObject({ title: "Start now makes tasks Ready for agents", status: "done" });
    expect(find(cl, "work.ready").detail).toMatch(/^0 Ready for agents, 4 in the backlog\. Start now on a new task makes it Ready at once \(Todo in Linear\); Later puts it in the backlog, where it waits until someone moves it to Todo in Linear/);
    expect(find(cl, "work.ready").who).toBeUndefined();
    expect(find(cl, "work.approve")).toMatchObject({ status: "todo", page: "Start now, Later or Drop each one in Needs you." });
  });

  it("says when the Mac slept and nothing ran (#9)", () => {
    const asleep = buildChecklist(inputs({ state: { ...STATE, lastTick: { at: "2026-11-20T11:55:00Z", failed: [], failStreak: 0 } } }));
    expect(find(asleep, "job.passes")).toMatchObject({ status: "warn", who: "you", how: "app", required: true });
    expect(find(asleep, "job.passes").detail).toMatch(/^no run since \d\d:\d\d \(6\.1 h ago\)\. PMX, its Claude tasks and the Linear sync run only while this Mac is awake/);
    const slept = buildChecklist(inputs({ state: { ...STATE, tickGaps: [{ from: "2026-11-20T07:55:00Z", to: "2026-11-20T13:45:00Z" }] } }));
    expect(find(slept, "job.passes").detail).toMatch(/nothing ran from \d\d:\d\d to \d\d:\d\d \(5\.8 h\), while this Mac was asleep or off/);
    expect(tickHealth({ at: "2026-11-20T11:55:00Z", failed: [], failStreak: 0 }, 3, NOW)).toMatchObject({ ok: false, detail: expect.stringMatching(/hasn't run since 2026-11-20 11:55 UTC \(6\.1 h ago\): this Mac was probably asleep or off/) });
    expect(tickHealth({ at: "2026-11-20T17:40:00Z", failed: [], failStreak: 0 }, 3, NOW)!.ok).toBe(true);
  });

  it("records the stretches with no pass as the background job runs", async () => {
    await recordTick([], new Date("2026-11-20T07:55:00Z"));
    await recordTick([], new Date("2026-11-20T08:25:00Z"));
    await recordTick([], new Date("2026-11-20T13:45:00Z"));
    expect((await loadState()).tickGaps).toEqual([{ from: "2026-11-20T08:25:00.000Z", to: "2026-11-20T13:45:00.000Z" }]);
  });

  it("after an update from 0.34.0: what PMX did, and each step still left for that version", () => {
    const upgrade = { lastVersion: "0.35.0", from: "0.34.0", at: "2026-11-20T17:00:00Z", applied: { "app-skills@0.35.0": { at: "2026-11-20T17:00:00Z", did: "updated /pmx-schedule" }, "mcp-entry@0.35.0": { at: "2026-11-20T17:00:00Z", did: "nothing to do" } } };
    const cl = buildChecklist(inputs({
      state: { ...STATE, upgrade }, linearCron: "0 8-18 * * 1-5", setupSkill: "missing",
      checks: [...HEALTHY.filter((c) => c.id !== "claude.task.collect"), warn("claude.task.collect", "Claude scheduled task \"Collect meetings\" has an older prompt: type /pmx-schedule in the Claude app"), warn("flow.page", "your /pmx-flow page is from pmx 0.34.0: type /pmx-flow in the Claude app to update it to 0.35.0")],
    }));
    expect(cl.upgrade).toMatchObject({ from: "0.34.0", to: "0.35.0", applied: [{ id: "app-skills", did: "updated /pmx-schedule" }, { id: "mcp-entry", did: "nothing to do" }] });
    expect(cl.upgrade!.pending.map((s) => s.id)).toEqual(["claude.tasks", "claude.page", "linear.hours", "update.background-job", "update.evidence-backfill", "update.evidence-names-3", "update.follow-ups-requeue"]);
    expect(find(cl, "update.background-job")).toMatchObject({ status: "warn", do: "pmx checklist --fix" });
    // RUN-5: a one-off step for a Mac from before 0.37.0, which PMX does on its next run (or now, from the checklist).
    expect(find(cl, "update.evidence-backfill")).toMatchObject({ status: "warn", title: "This Mac's open tasks share their quotes with your team", detail: "PMX will do it on its next run" });
    expect(find(cl, "update.version").detail).toMatch(/^pmx 0\.35\.0, updated from 0\.34\.0 on /);
    expect(find(cl, "claude.setup")).toMatchObject({ status: "warn", do: "pmx checklist --install-skill, then quit and reopen the Claude app" });
    const text = formatChecklist(cl);
    expect(text).toMatch(/\nStill to do after updating from 0\.34\.0:\n  ✘ The Claude app runs PMX's scheduled tasks: In the Claude app: Code tab, a new session with auto mode off, type \/pmx-schedule\n/);
    expect(text).toMatch(/\nNext: The Claude app runs PMX's scheduled tasks\. /);
  });

  it("a team repo with no remote, an empty team memory and a stale team package each say who fixes them (#16, #19)", () => {
    const cl = buildChecklist(inputs({ hasRemote: false, memoryFilled: false, checks: [...HEALTHY.filter((c) => c.id !== "cli.team-package"), warn("cli.team-package", "the team package is pmx 0.16.1; teammates who run pmx update get it. Team lead: run `pmx vendor --require` and merge it")] }));
    expect(find(cl, "setup.remote")).toMatchObject({ status: "warn", who: "team-lead", required: false });
    expect(find(cl, "setup.remote").detail).toMatch(/team setting changes become local branches you apply yourself/);
    expect(find(cl, "setup.package")).toMatchObject({ status: "warn", who: "team-lead", do: expect.stringMatching(/^pmx vendor --require/) });
    expect(find(cl, "setup.memory")).toMatchObject({ status: "warn", how: "claude" });
    expect(cl.where).toMatch(/3 optional steps left\.$/);
  });

  it("a required step that's off makes PMX set up but not yet able to do its job", () => {
    const cl = buildChecklist(inputs({ checks: [...HEALTHY.filter((c) => c.id !== "profile.signed-in"), fail("profile.signed-in", "PMX's Claude profile isn't signed in: run `pmx claude login`")] }));
    expect(cl.next).toMatchObject({ id: "profile.signed-in", do: "pmx claude login", who: "you" });
    expect(cl.where).toBe("PMX is set up, but 1 required step is left before it can do its job: PMX's own Claude profile is signed in.");
  });

  it("keeps when each step was first done, and every change, in ~/.pmx/checklist.json", async () => {
    const first = await recordChecklist(buildChecklist(inputs({ proposals: 2 })), { "setup.config": "2026-11-08T07:25:00Z" });
    expect(find(first, "setup.config").since).toBe("2026-11-08T07:25:00Z");
    expect(find(first, "work.approve").since).toBeNull();
    const later = await recordChecklist(buildChecklist(inputs({ now: new Date("2026-11-21T09:00:00Z"), proposals: 0 })));
    expect(find(later, "work.approve").since).toBe("2026-11-21T09:00:00.000Z");
    expect(find(later, "setup.config").since).toBe("2026-11-08T07:25:00Z");
    const h = (await readHistory())!;
    expect(h.log.filter((e) => e.id === "work.approve")).toEqual([
      { at: NOW.toISOString(), id: "work.approve", from: null, to: "todo" },
      { at: "2026-11-21T09:00:00.000Z", id: "work.approve", from: "todo", to: "done" },
    ]);
    expect(h.last!.at).toBe("2026-11-21T09:00:00.000Z");
    expect((await stat(checklistFile())).mode & 0o777).toBe(0o600);
  });

  it("PMX's page gets the same checklist without terminal commands", () => {
    const cl = buildChecklist(inputs({ personal: null, team: null, checks: [ok("os.macos"), fail("node", "Node 18: PMX needs 22.12 or later. Install Node 24 with `brew install node`, then run `pmx init`")], hasRemote: null, memoryFilled: null, proposals: null, tasks: null }));
    const page = checklistForPage(cl)!;
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/\bpmx [a-z]/);
    // BOARD-10: Needs you shows it as a card only when it is required, and says who does it.
    // SETUP-2: with what the page offers for it: here Claude, with /pmx-setup.
    expect(page.next).toEqual({ id: "mac.node", title: "Node 22.12 or later", page: "In the Claude app, type /pmx-setup: Claude installs a supported Node with you and sets PMX up again.", required: true, who: "you",
      fix: { kind: "claude", command: "/pmx-setup", text: "In the Claude app, type /pmx-setup: Claude installs a supported Node with you and sets PMX up again." } });
    expect(PAGE_HINT).toMatch(/\/pmx-setup/);
    expect(page.where).toBe(cl.where);
  });
});

describe("the brain on the checklist (#13)", () => {
  beforeEach(freshHome);

  it("says it's off and what that means, instead of being silently off", async () => {
    const { repo } = await pmxRepo();
    const step: Step = await brainStep(await testCtx({ repo }));
    expect(step).toMatchObject({ id: "work.brain", status: "skip" });
    expect(step.detail).toMatch(/^off: nothing triages the backlog automatically, so a task in the backlog becomes Ready only when someone moves it/);
    const on: Step = await brainStep(await testCtx({ repo, team: { brain: { level: "recommend", everyHours: 4 } } as any }));
    expect(on).toMatchObject({ status: "warn", detail: "set to recommend, but no Mac is chosen to run it, so it never runs" });
    // "Your work now" shows it even when it's off: what runs is part of where you stand.
    expect(formatChecklist(buildChecklist(inputs({ extra: [step] })))).toMatch(/– Automatic triage \(the brain\): off: nothing triages/);
  });
});

describe("what ships for Claude (SETUP-1)", () => {
  it("the guide and /pmx-setup are in the package, and the skill hands over to the guide and the checklist", async () => {
    const root = join(__dirname, "..");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.files).toEqual(expect.arrayContaining(["GUIDE.md", "app-skills"]));
    const skill = await readFile(join(root, "app-skills", "pmx-setup", "SKILL.md"), "utf8");
    expect(skill).toMatch(/^---\nname: pmx-setup\ndescription: .+\n---\n\n<!-- Installed by ProductMaxxing/);
    expect(skill).toContain("pmx guide");
    expect(skill).toContain("pmx checklist --json");
    const guide = await readFile(join(root, "GUIDE.md"), "utf8");
    // Every step the checklist can name is explained in the guide's step reference.
    for (const id of ["os.macos", "mac.node", "mac.pmx", "profile.signed-in", "setup.config", "setup.remote", "setup.package", "setup.privacy", "setup.memory", "job.installed", "job.paths", "job.passes", "claude.setup", "claude.allow", "claude.tasks", "claude.mcp", "claude.page", "claude.board", "linear.connected", "linear.hours", "work.meetings", "work.channels", "work.approve", "work.ready", "work.kinds", "work.practice", "work.agents", "work.brain"])
      expect(guide, id).toContain(`\`${id}\``);
  });
});

describe("a Mac whose first Linear sync hasn't run yet (F16)", () => {
  beforeEach(freshHome);

  it("shows the Linear step as waiting for the sync, with when it runs and where to see it, not as failing", async () => {
    const { relayHealth } = await import("../src/tracker/relay.js");
    const team = { ...DEFAULT_TEAM, tracker: { kind: "linear", teamKey: "PMX", projectId: "p" } } as any;
    const h = await relayHealth(team, NOW);
    expect(h.detail).toMatch(/not synced yet on this Mac\. PMX's Linear sync in the Claude app runs at the top of each hour, and this Mac's first one hasn't run yet/);
    const cl = buildChecklist(inputs({ checks: [...HEALTHY.filter((c) => c.id !== "linear.relay"), warn("linear.relay", h.detail)] }));
    const step = find(cl, "linear.connected");
    expect(step).toMatchObject({ status: "todo", fix: { kind: "page", to: "tab:health/running" } });
    expect(step.detail).toMatch(/^waiting for this Mac's first Linear sync\. PMX's Linear sync in the Claude app runs at the top of each hour; this Mac's first one hasn't run yet/);
    expect(JSON.stringify({ detail: step.detail, page: step.page, fix: step.fix })).not.toMatch(/\bpmx [a-z]/);
    // Once it syncs but falls behind, it's a warning again.
    const late = buildChecklist(inputs({ checks: [...HEALTHY.filter((c) => c.id !== "linear.relay"), warn("linear.relay", "Linear through Claude: last synced 5h ago, and missed the sync due at 13:00")] }));
    expect(find(late, "linear.connected").status).toBe("warn");
  });

  it("says the same on PMX's page, pointing at Health → Running", async () => {
    const { relayWords } = await import("../src/flow/pipeline-load.js");
    const w = relayWords("Linear through Claude: not synced yet on this Mac. …", 0);
    expect(w.text).toMatch(/^This Mac hasn't synced Linear yet\. PMX's Linear sync in the Claude app runs at the top of each hour; this Mac's first one hasn't run yet\. Health → Running shows when it ran\./);
    expect(w.text).not.toMatch(/\bpmx [a-z]/);
  });
});
