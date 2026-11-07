import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { budget, BudgetPaused, recordSpend, usageLine } from "../src/budget/provider.js";
import { runDoctor } from "../src/commands/doctor.js";
import { runTick } from "../src/commands/tick.js";
import { DEFAULT_TEAM, linearRef, loadTeamConfig, type TeamConfig } from "../src/core/config.js";
import { companyDomains, filterItems } from "../src/core/filter.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd, plist, stableNode } from "../src/core/launchd.js";
import { services } from "../src/core/services.js";
import { loadState, updateState } from "../src/core/state.js";
import type { SignalItem } from "../src/core/types.js";
import { privacyRules } from "../src/digest/gather.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { refreshTodos } from "../src/todo/todo.js";
import { checkRelay, overlay, pmxLabels, readSnapshot, relayDir, relayHealth, relayPrompt, relayTracker, type Snapshot } from "../src/tracker/relay.js";
import { scrubTask, WITHDRAWN, writtenByPmx } from "../src/tracker/tidy.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const item = (over: Partial<SignalItem>): SignalItem => ({ id: "T1", kind: "transcript", ref: "/x/a.md", title: "Call", at: "2026-11-03", participants: [], text: "Jane: SSO is slow.", ...over });
const none = { people: [], channels: [], meetingTitles: [] };
const team = (over: Partial<TeamConfig> = {}) => ({ ...DEFAULT_TEAM, team: "t", ...over }) as TeamConfig;

describe("0.14.0: private meetings never reach the team (PRIV-6, B2)", () => {
  const r = (domains: string[]) => ({ internalDomains: domains, requireExternalParticipant: true, neverIngest: none, wholeMeeting: true });

  it("without a company domain, holds every meeting instead of calling colleagues outsiders", () => {
    const sam = item({ title: "Sam / Priya", participants: ["sam@inside-co.com", "kp@inside-co.com"] });
    expect(filterItems([sam], r([])).decisions[0]).toMatchObject({ decision: "held", rule: "one-on-one" });
    const allHands = item({ title: "All hands", participants: ["a@inside-co.com", "b@inside-co.com", "c@inside-co.com"] });
    expect(filterItems([allHands], r([])).decisions[0]).toMatchObject({ decision: "held", rule: "no-company-domain" });
    expect(filterItems([allHands], r(["inside-co.com"])).decisions[0]).toMatchObject({ decision: "held", rule: "no-external-participant" });
  });

  it("learns the company domain from the PM's own work email, never from a public mail provider", () => {
    expect(companyDomains([], { emails: ["kp@Inside-Co.com", "me@gmail.com"] })).toEqual(["inside-co.com"]);
    expect(companyDomains(["https://Acme.com/"], { companyDomains: ["@us.acme.com"] })).toEqual(["acme.com", "us.acme.com"]);
    const p = { neverIngest: none, identity: { names: [], emails: ["kp@inside-co.com"] } } as any;
    expect(privacyRules({ team: team(), personal: p }).internalDomains).toEqual(["inside-co.com"]);
  });

  it("holds hiring interviews and 1:1-shaped meetings by title, but keeps customer interviews", () => {
    const outside = ["buyer@acme.com", "kp@us.com"];
    const held = (title: string) => filterItems([item({ title, participants: outside })], r(["us.com"])).decisions[0]!;
    expect(held("Video Interview - Jordan Lee for Forward Deployed Product Lead")).toMatchObject({ decision: "held", rule: "hiring" });
    expect(held("Interview debrief")).toMatchObject({ decision: "held", rule: "hiring" });
    expect(held("Q3 salary planning")).toMatchObject({ decision: "held", rule: "compensation" });
    expect(held("Ana / Raj")).toMatchObject({ decision: "held", rule: "one-on-one" });
    expect(held("Customer interview: Acme")).toMatchObject({ decision: "kept" });
    expect(held("Acme renewal")).toMatchObject({ decision: "kept" });
  });

  it("holds a whole meeting that keeps returning to a sensitive topic; one passage is just cut", () => {
    const outside = ["buyer@acme.com", "kp@us.com"];
    const two = item({ participants: outside, text: "Jane: SSO is slow.\n\nKP: The recruiter called.\n\nJane: Our hiring manager wants the offer letter out." });
    expect(filterItems([two], r(["us.com"])).decisions[0]).toMatchObject({ decision: "held", rule: "hiring", detail: expect.stringMatching(/2 passages .* whole meeting/) });
    const one = item({ participants: outside, text: "Jane: SSO is slow.\n\nKP: The recruiter called." });
    const d = filterItems([one], r(["us.com"]));
    expect(d.decisions[0]).toMatchObject({ decision: "kept" });
    expect(d.kept[0]!.text).not.toMatch(/recruiter/);
    // Private to-dos still read 1:1s, and only cut passages.
    expect(filterItems([two], { ...r(["us.com"]), requireExternalParticipant: false, allowOneOnOne: true, wholeMeeting: false }).kept).toHaveLength(1);
  });
});

describe("0.14.0: doctor says what's wrong (BUDGET-2, B2)", () => {
  beforeEach(freshHome);

  it("fails without a company domain and warns when the budget pauses PMX", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, personal: { budget: { dailyUsd: 0, resetHour: 0 } } });
    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: ctx.exec });
    expect(checks.find((c) => c.id === "privacy.company-domains")).toMatchObject({ ok: false, level: "fail", detail: expect.stringMatching(/company's email domain/) });
    expect(checks.find((c) => c.id === "budget")).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/PMX is paused: your daily cap is \$0/) });
  });

  it("fails when the background job runs a Node or Claude Code that's gone, and warns on a versioned Homebrew Node", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const ctx = await testCtx({ repo, team: { internalDomains: ["us.com"] } });
    const launchd = fakeLaunchd();
    const deps = { personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd, exec: ctx.exec };
    await launchd.install(plist({ node: "/gone/node", cli: "/x/cli.js", pmxHome: "/h", claude: "/Users/x/.nvm/versions/node/v22.2.0/bin/claude" }));
    expect((await runDoctor(deps)).find((c) => c.id === "schedule.job-paths")).toMatchObject({ ok: false, level: "fail", detail: expect.stringMatching(/Node at \/gone\/node and Claude Code at .*nvm.*no longer exist/) });
    const cellar = join(await tmp("brew-"), "Cellar/node/26.13.0_2/bin");
    await mkdir(cellar, { recursive: true });
    await writeFile(join(cellar, "node"), "");
    await launchd.install(plist({ node: join(cellar, "node"), cli: "/x/cli.js", pmxHome: "/h" }));
    expect((await runDoctor(deps)).find((c) => c.id === "schedule.job-paths")).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/brew upgrade node/) });
  });

  it("gives the job Homebrew's stable Node link instead of a versioned folder", async () => {
    const yes = async (f: string) => f === "/opt/homebrew/opt/node/bin/node";
    expect(await stableNode("/opt/homebrew/Cellar/node/26.13.0_2/bin/node", yes)).toBe("/opt/homebrew/opt/node/bin/node");
    expect(await stableNode("/usr/local/Cellar/node@24/24.1.0/bin/node", async (f) => f === "/usr/local/bin/node")).toBe("/usr/local/bin/node");
    expect(await stableNode("/Users/x/.nvm/versions/node/v24.1.0/bin/node", yes)).toBe("/Users/x/.nvm/versions/node/v24.1.0/bin/node");
  });
});

describe("0.14.0: one budget for every run (BUDGET-1, BUDGET-2)", () => {
  beforeEach(freshHome);

  it("has no cap of the PM's own by default, counts tokens, and says the dollars are an estimate", async () => {
    const p = { budget: { dailyUsd: null, resetHour: 0 }, plan: "max" } as any;
    const s = await loadState();
    recordSpend(s, p, new Date(), 0.67, 41000);
    recordSpend(s, p, new Date(), 0.14, 9000);
    const b = budget(p, team(), s, new Date());
    expect(b).toMatchObject({ personalCapUsd: null, capUsd: DEFAULT_TEAM.caps.perDayUsd, tokens: 50000, spentUsd: 0.81 });
    expect(usageLine(b, "max")).toMatch(/^Usage today: 50k tokens, \$0\.81 at API list prices \(your Claude plan isn't billed per token\); no cap of your own; team cap \$20\.00/);
    expect(usageLine({ ...b, personalCapUsd: 0 }, "max")).toMatch(/PAUSED: your daily cap is \$0/);
  });

  it("a cap of 0 stops to-dos too, with no model call, and the background job says so once, not as a failure", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme\ndate: 2026-11-06T09:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Please send me the pricing sheet.");
    const runtime = mockRuntime(() => JSON.stringify({ todos: [] }));
    const ctx = await testCtx({ repo, runtime, team: { internalDomains: ["us.com"] }, personal: { budget: { dailyUsd: 0, resetHour: 0 }, sources: { transcriptDirs: [dir], slackChannel: null } } });
    await expect(refreshTodos(ctx, { since: new Date("2026-11-06T00:00:00") })).rejects.toBeInstanceOf(BudgetPaused);
    expect(runtime.calls).toHaveLength(0);
    const paused = async () => { throw new BudgetPaused("PMX is paused: your daily cap is $0."); };
    expect(await runTick(ctx, [["todo", paused], ["digest", paused], ["pull", async () => "dry run"]])).toEqual(["budget: PMX is paused: your daily cap is $0.", "pull: dry run"]);
  });
});

describe("0.14.0: Linear links, sync time and labels (BOARD-2)", () => {
  beforeEach(freshHome);
  const linear = team({ tracker: { kind: "linear", teamKey: "PMX", projectId: "pmx-5f2a91c0d3e4" } });

  it("turns a pasted Linear link into the key or slug, in config and in the snapshot check", async () => {
    expect(linearRef("team", "https://linear.app/acme/team/PMX/")).toBe("PMX");
    expect(linearRef("project", "https://linear.app/acme/project/pmx-5f2a91c0d3e4/overview")).toBe("pmx-5f2a91c0d3e4");
    expect(linearRef("project", "pmx-5f2a91c0d3e4")).toBe("pmx-5f2a91c0d3e4");
    const { repo } = await pmxRepo({ tracker: { kind: "linear", teamKey: "https://linear.app/a/team/PMX/", projectId: "https://linear.app/a/project/pmx-5f2a91c0d3e4/overview" } });
    expect((await loadTeamConfig(repo)).tracker).toEqual({ kind: "linear", teamKey: "PMX", projectId: "pmx-5f2a91c0d3e4" });

    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "https://linear.app/a/project/pmx-5f2a91c0d3e4/overview", issues: [] }));
    expect(await relayTracker(linear).list()).toEqual([]);
  });

  it("stamps the sync with the real time and flags missing labels; the sync creates them every run", async () => {
    const snap: Snapshot = { v: 1, syncedAt: "2026-11-07T00:00:00Z", projectId: "pmx-5f2a91c0d3e4", issues: [], labels: ["pmx-status/inbox"] };
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify(snap));
    const now = new Date();
    await utimes(join(relayDir(), "snapshot.json"), now, now);
    await checkRelay(linear, now);
    expect(Math.abs(Date.parse((await readSnapshot())!.syncedAt) - now.getTime())).toBeLessThan(2000);
    expect((await relayHealth(linear, now)).detail).toMatch(/PMX label\(s\) missing in Linear \(pmx-status\/ready/);
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ ...snap, syncedAt: now.toISOString(), labels: pmxLabels(linear) }));
    expect((await relayHealth(linear, now)).ok).toBe(true);
    const prompt = await relayPrompt(linear);
    expect(prompt).toContain("## 0. Make sure PMX's labels exist");
    expect(prompt).toMatch(/- pmx-status: inbox, ready, claimed, running, review, done, blocked/);
  });
});

describe("0.14.0: taking back what PMX wrote (TIDY-1)", () => {
  beforeEach(freshHome);

  it("finds old excerpts and meeting titles, and rewrites them without deleting anything", async () => {
    const old = "Customers want a scope summary.\n\n**Sources**\n\n- [T6] Sam / Priya (2026-11-05): Microphone: so the Acme thing…\n- [T1] All hands (2026-11-03): System audio: welcome…\n\npmx:source T6\npmx:source T1";
    expect(scrubTask(old)).toBe("Customers want a scope summary.\n\n**Based on** 2 sources. The sources stay on the PM's Mac.\n\npmx:source T6\npmx:source T1");
    expect(scrubTask("Fine.\n\n**Based on** one meeting (2026-11-05).\n\npmx:source T1")).toBeNull();

    const tracker = memoryTracker();
    const t = await tracker.createInbox({ title: "Summarize Acme scope", description: old, category: "spec", size: "S", sources: ["T6"] });
    const m = await tracker.lodgeMeeting({ keys: ["mabcdef0123456789"], at: "2026-11-05", agent: "kp@m1" });
    tracker.meetings.get(m.id)!.title = "Meeting · Sam / Priya · 2026-11-05";
    const written = await writtenByPmx(tracker);
    expect(written.map((w) => [w.identifier, w.problems.length])).toEqual([[t.identifier, 1], [m.identifier, 1]]);
    for (const w of written) await tracker.rewrite(w.id, w.fix!);
    expect(tracker.tasks.get(t.id)!.description).not.toMatch(/Microphone|Sam|All hands/);
    expect(tracker.meetings.get(m.id)!.title).toBe("Processed meeting mabcdef01");
    expect((await writtenByPmx(tracker)).every((w) => !w.problems.length)).toBe(true);
  });

  it("queues rewrites and withdrawals through the Claude relay, and a withdrawn issue drops out", async () => {
    const linear = team({ tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } });
    const node = { id: "u1", identifier: "PMX-9", title: "T", description: "x", url: "", priority: 0, createdAt: "", labels: { nodes: [{ name: "inbox", parent: { name: "pmx-status" } }] }, comments: { nodes: [] } };
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [node] }));
    const tr = relayTracker(linear);
    await tr.rewrite("PMX-9", { description: WITHDRAWN, cancel: true });
    const outbox = JSON.parse(await readFile(join(relayDir(), "outbox.json"), "utf8"));
    expect(outbox.ops[0]).toMatchObject({ kind: "rewrite", target: "PMX-9", description: WITHDRAWN, cancel: true });
    expect(await tr.list()).toEqual([]);
    expect(overlay({ v: 1, syncedAt: "", projectId: "proj-1", issues: [node] }, [{ ...outbox.ops[0], cancel: false }])[0].description).toBe(WITHDRAWN);
    expect(await relayPrompt(linear)).toContain("`rewrite`: on the target, replace the title");
    expect(await stat(join(relayDir(), "outbox.json"))).toBeTruthy();
  });

  it("the memory tracker used by tests and teams without Linear supports it too", async () => {
    const svc = await services(await testCtx({ repo: (await pmxRepo()).repo }), { tracker: memoryTracker() });
    const t = await svc.tracker.createInbox({ title: "x", description: "d", category: "spec", size: "S", sources: [] });
    await svc.tracker.rewrite(t.id, { cancel: true });
    expect(await svc.tracker.list()).toEqual([]);
    await updateState(() => {});
  });
});

describe("0.16.1: pmx init offers the /pmx-flow server (FLOW-4)", () => {
  beforeEach(freshHome);
  const withClaude = async (cmd: string, args: string[], o?: any) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : (await import("../src/core/exec.js")).exec(cmd, args, o));

  it("asks only when the Claude desktop app is on this Mac, registers a stable Node, and keeps an earlier yes current", async () => {
    const { runInit } = await import("../src/commands/init.js");
    const { scriptedAsker } = await import("../src/core/ask.js");
    const { mcpEntry } = await import("../src/mcp/server.js");
    const root = await tmp();
    const asked: string[] = [];
    const ask = (answers: Record<string, string | boolean>) => {
      const a = scriptedAsker(answers);
      return { ...a, confirm: async (q: string, def?: boolean) => { asked.push(q); return a.confirm(q, def); } };
    };
    const init = (answers: Record<string, string | boolean>) => runInit({
      ask: ask({ "PMX repo checkout": join(root, "pmx"), "Team name": "acme", handle: "ana", "Linear team key": "", transcripts: join(root, "t"), "email domains": "acme.com", ...answers }),
      keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude as any, out: { info() {}, warn() {}, error() {} } as any, now: () => new Date("2026-11-07T15:00:00Z"), cliPath: "/x/cli.js",
    });
    await init({});
    expect(asked.some((q) => /pmx-flow board/.test(q))).toBe(false);
    expect(await mcpEntry()).toBeNull();

    await mkdir(join(process.env.PMX_HOME!, "claude-desktop"), { recursive: true });
    await writeFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG!, JSON.stringify({ mcpServers: { other: { command: "x" } }, keep: true }));
    await init({ "pmx-flow board": false });
    expect(await mcpEntry()).toBeNull();
    await init({});
    expect(await mcpEntry()).toEqual({ command: await stableNode(process.execPath), args: ["/x/cli.js", "mcp"] });
    expect(JSON.parse(await readFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG!, "utf8"))).toMatchObject({ keep: true, mcpServers: { other: { command: "x" } } });

    // Registered before: updated to this pmx without asking again.
    asked.length = 0;
    await writeFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG!, JSON.stringify({ mcpServers: { pmx: { command: "/old/node", args: ["/old/cli.js", "mcp"] } } }));
    await init({});
    expect(asked.some((q) => /pmx-flow board/.test(q))).toBe(false);
    expect((await mcpEntry())!.args[0]).toBe("/x/cli.js");
  });

  it("doctor warns when the registered server's Node is gone or versioned", async () => {
    const { mcpHealth } = await import("../src/mcp/server.js");
    expect(await mcpHealth()).toBeNull();
    await mkdir(join(process.env.PMX_HOME!, "claude-desktop"), { recursive: true });
    await writeFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG!, JSON.stringify({ mcpServers: { pmx: { command: "/gone/node", args: ["/gone/cli.js", "mcp"] } } }));
    expect(await mcpHealth()).toMatchObject({ ok: false, detail: expect.stringMatching(/\/gone\/node, which no longer exists/) });
    const cellar = join(await tmp("brew-"), "Cellar/node/26.13.0_2/bin");
    await mkdir(cellar, { recursive: true });
    await writeFile(join(cellar, "node"), "");
    await writeFile(process.env.PMX_CLAUDE_DESKTOP_CONFIG!, JSON.stringify({ mcpServers: { pmx: { command: join(cellar, "node"), args: [join(cellar, "node"), "mcp"] } } }));
    expect(await mcpHealth()).toMatchObject({ ok: false, detail: expect.stringMatching(/brew upgrade node/) });
  });
});
