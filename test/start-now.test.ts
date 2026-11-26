// APPROVE-3: Start now on a proposed task. The PM's approval of exactly the text shown can create the task straight in
// Ready, when the team allows it; Later is today's Approve (the pool); synthesis itself still only proposes.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { DEFAULT_TEAM, startsNow, validateTeamConfig, type TeamConfig } from "../src/core/config.js";
import { services } from "../src/core/services.js";
import { checkChange, describe as describeChange } from "../src/flow/actions.js";
import { approveProposals, formatProposals, readProposals, stageProposals, START_OFF } from "../src/synth/proposals.js";
import { overlay, readOutbox, readSnapshot, relayDir, relayPrompt, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "proj-1" };
const team = { ...DEFAULT_TEAM, team: "Acme PM", tracker: LINEAR } as TeamConfig;
const stage = () => stageProposals([
  { at: "2026-11-20T10:00:00Z", receipt: "r0", title: "Export approval history to CSV", description: "Admins need a record.\n\npmx:source T1", category: "spec", size: "M", sources: ["T1"], from: [] },
  { at: "2026-11-20T10:00:00Z", receipt: "r0", title: "Fix the project name in emails", description: "Emails show the wrong name.\n\npmx:source T2", category: "spec", size: "S", sources: ["T2"], from: [] },
]);
const snapshot = async () => {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [] }));
};

describe("Start now (APPROVE-3)", () => {
  beforeEach(freshHome);

  it("is on by default, and a team turns it off in pmx.config.json, checked like its other settings", () => {
    expect(startsNow(DEFAULT_TEAM)).toBe(true);
    expect(startsNow({ approve: null })).toBe(true);
    expect(startsNow({ approve: { startNow: false } })).toBe(false);
    expect(validateTeamConfig({ ...team, approve: { startNow: false } }).approve).toEqual({ startNow: false });
    expect(() => validateTeamConfig({ ...team, approve: { startNow: "yes" } } as any)).toThrow(/approve\.startNow must be true or false/);
  });

  it("creates the task in Ready with the memory tracker; Later sends it to the pool, as Approve did", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const tracker = memoryTracker([]);
    const svc = await services(ctx, { tracker });
    const [a, b] = await stage();
    const started = await approveProposals(ctx, svc, [a!.id], { start: true });
    expect(started.posted).toEqual([expect.objectContaining({ title: "Export approval history to CSV", ready: true })]);
    const later = await approveProposals(ctx, svc, [b!.id]);
    expect(later.posted).toEqual([expect.objectContaining({ title: "Fix the project name in emails", ready: false })]);
    expect([...tracker.tasks.values()].map((t) => [t.title, t.status])).toEqual([["Export approval history to CSV", "ready"], ["Fix the project name in emails", "inbox"]]);
    // Exactly the text the PM saw.
    expect([...tracker.tasks.values()][0]!.description).toBe("Admins need a record.\n\npmx:source T1");
    expect(await readProposals()).toEqual([]);
  });

  it("through the Claude relay, the create-task op carries Ready, and the sync's instructions label it from the op", async () => {
    await snapshot();
    const t = relayTracker(team);
    const made = await t.createInbox({ title: "Export approval history to CSV", description: "d", category: "spec", size: "M", sources: [], ready: true });
    await t.createInbox({ title: "Fix the project name in emails", description: "d", category: "spec", size: "S", sources: [] });
    expect(made.status).toBe("ready");
    const ops = (await readOutbox()).ops as any[];
    expect(ops.map((o) => [o.kind, o.status])).toEqual([["create-task", "ready"], ["create-task", undefined]]);
    expect(overlay((await readSnapshot())!, ops).map((n) => n.labels.nodes.find((l: any) => l.parent.name === "pmx-status").name)).toEqual(["ready", "inbox"]);
    const prompt = await relayPrompt(team);
    expect(prompt).toContain("labels pmx-status: <status> (the op's `status`: ready or inbox; inbox when it has none), pmx-category: <category>, pmx-size: <size>.");
    expect(prompt).not.toContain("labels pmx-status: inbox, pmx-category");
  });

  it("is refused when the team turned it off, and nothing is written", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team: { approve: { startNow: false } } });
    const tracker = memoryTracker([]);
    await stage();
    await expect(approveProposals(ctx, await services(ctx, { tracker }), ["all"], { start: true })).rejects.toThrow(START_OFF);
    expect(tracker.tasks.size).toBe(0);
    expect(await readProposals()).toHaveLength(2);
  });

  it("pmx proposals start makes the task Ready, and says when it reaches agents; list shows both choices", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const list = await stage();
    expect(formatProposals(list, true, true)).toMatch(/Start now \(Ready for agents\): pmx proposals start <number or ID …> \(or --all\)\nLater \(to the backlog\): pmx proposals approve/);
    expect(formatProposals(list, true, false)).not.toMatch(/proposals start/);
    const cmd = commands.find((c) => c.name === "proposals")!;
    expect(cmd.usage).toContain("pmx proposals start <number or ID …> | --all");
    const logs: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => logs.push(a.join(" "));
    try {
      const code = await cmd.run({ positionals: ["start", "1"], values: {}, ctx: async () => ctx, ask: null as any } as any);
      expect(code).toBe(0);
    } finally { console.log = log; }
    expect(logs.at(-1)).toMatch(/^Started PMX-\d+: it becomes Ready for agents now, and an agent takes it from there\.$/);
  });

  it("is a team setting the page proposes to the team like the others", async () => {
    expect(checkChange({ kind: "start-now", value: false }, team)).toEqual({ kind: "start-now", value: false });
    expect(() => checkChange({ kind: "start-now", value: "off" }, team)).toThrow(/Turn Start now on or off/);
    expect(describeChange({ kind: "start-now", value: false })).toBe("No Start now: approved tasks wait in the backlog until a teammate moves them to Todo in Linear");
  });
});

describe("Start now in the page's Settings (APPROVE-3)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("shows the team setting under Budget and limits, and turning it off is one change for the team to approve", async () => {
    ui = await openBoard({ hash: "settings/limits" });
    const sw = ui.switchFor("Start now on new tasks");
    expect(sw.getAttribute("aria-checked")).toBe("true");
    expect(ui.text()).toMatch(/On: Start now in Needs you approves a task and makes it Ready for agents at once/);
    await ui.click(sw);
    expect(ui.switchFor("Start now on new tasks").getAttribute("aria-checked")).toBe("false");
    expect(ui.bar()).toMatch(/1 for your team to approve/);
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.text("#review")).toMatch(/No Start now: approved tasks wait in the backlog until a teammate moves them to Todo in Linear/);
    await ui.click(ui.button("Send to your team", "#review"));
    await ui.until(() => /Saved your team's changes on this Mac|couldn't be sent/.test(ui!.text("#review")), "the proposal");
    const repo = ui.ctx.personal.repoPath;
    const b = (await git(repo, "branch", "--list", "pmx/settings-*", "--format=%(refname:short)")).split("\n").filter(Boolean).pop()!;
    expect(JSON.parse(await git(repo, "show", `${b}:pmx.config.json`)).approve).toEqual({ startNow: false });
    expect(ui.text("main")).not.toMatch(/\bpmx [a-z]/);
  }, 30000);
});
