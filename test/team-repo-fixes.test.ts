// End-to-end test of 0.37.0 with five PMs on one team repo that wasn't on GitHub: two team settings changes sent in the
// same second shared a branch (R9); `pmx vendor` named two of the three files it wrote (R10); `--check` warned about an
// assignee a redo removed on purpose (R11); a teammate's leftover draft could be accepted again after an accept on
// another Mac (R13); merged settings changes stayed "waiting" for good (R22); follow-ups didn't count the PM's own
// company domains as the company's (R4); a finished task "followed a move" in a stale copy of Linear; Linear's issue
// mentions broke what PMX reads back (R23); and a display-name participant's domain kept its ">".
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { execOk } from "../src/core/exec.js";
import { domainOf, filterItems, outsideDomains, outsideSpeaker } from "../src/core/filter.js";
import { Git } from "../src/core/git.js";
import { localHost } from "../src/core/host.js";
import { registerServices, services } from "../src/core/services.js";
import type { SignalItem, Task } from "../src/core/types.js";
import { vendoredFiles, vendorMessage } from "../src/core/vendor.js";
import { checkChange, proposeTeamChanges, SETTINGS_BRANCH } from "../src/flow/actions.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { pendingTeamPrs, rememberTeamPr } from "../src/flow/team-prs.js";
import { draftDecided, finishedElsewhere, type TaskMark } from "../src/lease/marks.js";
import { pull } from "../src/pull/pull.js";
import { evidenceStore } from "../src/run/packs.js";
import { followUpsOnAccept } from "../src/review/followups.js";
import { loadQueue, recordDecision } from "../src/review/queue.js";
import { scriptedReview, terminalReview } from "../src/review/tui.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { readProposals } from "../src/synth/proposals.js";
import { followMoves } from "../src/tracker/follow.js";
import { toMeeting, toTask } from "../src/tracker/linear.js";
import { followsIn, plainMentions } from "../src/tracker/mentions.js";
import { checkRelay, readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker, type Tracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";

const NOW = new Date("2026-11-26T15:58:17Z");
const STAMP = "20261126155817";
const LINEAR = { kind: "linear", teamKey: "PMX", projectId: "proj-1" } as TeamConfig["tracker"];

/** A team repo set up before decision briefs, with its own edited copy of pmx-synthesize, so both sends change files. */
async function olderTeam(remote: boolean) {
  const r = await pmxRepo({}, { remote });
  const cfgPath = join(r.repo, "pmx.config.json");
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
  delete cfg.categories["decision-brief"];
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  await rm(join(r.repo, ".claude", "skills", "pmx-decision-brief"), { recursive: true });
  const synth = join(r.repo, ".claude", "skills", "pmx-synthesize", "SKILL.md");
  await writeFile(synth, `${await readFile(synth, "utf8")}\nOur own line.\n`);
  await git(r.repo, "add", "-A");
  await git(r.repo, "commit", "-qm", "older team");
  if (remote) await git(r.repo, "push", "-q", "origin", "main");
  return { ...r, categories: cfg.categories };
}

describe("each team settings change gets a branch of its own (R9)", () => {
  beforeEach(freshHome);

  it("two sends in the same second never share a branch, and each is titled by what it does", async () => {
    const { repo, categories } = await olderTeam(true);
    const ctx = await testCtx({ repo, team: { categories }, now: NOW });
    const skills = await proposeTeamChanges(ctx, [checkChange({ kind: "skill-update", name: "pmx-synthesize" }, ctx.team)]);
    const kind = await proposeTeamChanges(ctx, [checkChange({ kind: "builtin-kind", name: "decision-brief" }, ctx.team)]);
    expect([skills.branch, kind.branch]).toEqual([`pmx/settings-${STAMP}`, `pmx/settings-${STAMP}-2`]);
    expect(kind.url).toBe(`branch:pmx/settings-${STAMP}-2`);
    // Each branch is one commit on the team's base, with only its own change.
    for (const b of [skills.branch, kind.branch]) expect(await git(repo, "rev-list", "--count", `origin/main..${b}`)).toBe("1");
    expect(await git(repo, "log", "-1", "--format=%s", skills.branch)).toBe("PMX's newer skills: pmx-synthesize");
    expect(await git(repo, "log", "-1", "--format=%s", kind.branch)).toBe("New kind of work: decision-brief");
    expect(await git(repo, "diff", "--name-only", `origin/main..${kind.branch}`)).not.toContain("pmx-synthesize");

    // A name already on the team repo, from another Mac in the same second, is skipped too.
    await git(dirname(repo) + "/origin.git", "branch", `pmx/settings-${STAMP}-3`, "main");
    const cap = await proposeTeamChanges(ctx, [checkChange({ kind: "review-cap", value: 4 }, ctx.team)]);
    expect(cap.branch).toBe(`pmx/settings-${STAMP}-4`);
    // Sent from Terminal, it doesn't say it came from the board; from the board, it does.
    expect(await git(repo, "log", "-1", "--format=%s", cap.branch)).toBe("Team settings from PMX");
    const board = await proposeTeamChanges(ctx, [checkChange({ kind: "review-cap", value: 5 }, ctx.team)], { from: "board" });
    expect(await git(repo, "log", "-1", "--format=%s", board.branch)).toBe("Team settings from the PMX board");
    expect([skills, kind, cap, board].every((r) => SETTINGS_BRANCH.test(r.branch))).toBe(true);
  });

  it("the board applies a second branch from the same second, without a remote", async () => {
    const { repo, categories } = await olderTeam(false);
    const ctx = await testCtx({ repo, team: { categories }, now: NOW });
    await proposeTeamChanges(ctx, [checkChange({ kind: "skill-update", name: "pmx-synthesize" }, ctx.team)]);
    const second = await proposeTeamChanges(ctx, [checkChange({ kind: "review-cap", value: 4 }, ctx.team)]);
    expect(second.branch).toBe(`pmx/settings-${STAMP}-2`);
    expect(await pipelineHandlers(ctx).teamApply(second.branch)).toMatchObject({ status: 200 });
    expect(JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8")).reviewQueueCap).toBe(4);
  });
});

describe("a merged settings change isn't waiting any more, on a team repo that isn't on GitHub (R22)", () => {
  beforeEach(freshHome);

  it("without a remote: merged into the local base", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    const r = await proposeTeamChanges(ctx, [checkChange({ kind: "review-cap", value: 4 }, ctx.team)]);
    const host = localHost(new Git(repo));
    expect(await host.isOpen(r.branch)).toBe(true);
    await git(repo, "merge", "-q", r.branch);
    expect(await host.isOpen(r.branch)).toBe(false);
    await rememberTeamPr({ id: r.id, url: r.url, at: NOW.toISOString(), changes: ["Stop pulling at 4 drafts"] });
    expect(await pendingTeamPrs(ctx)).toEqual([]);
  });

  it("with a remote: only once it's in the team repo's base, not when merged on this Mac alone", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const ctx = await testCtx({ repo, now: NOW });
    const r = await proposeTeamChanges(ctx, [checkChange({ kind: "review-cap", value: 4 }, ctx.team)]);
    await rememberTeamPr({ id: r.id, url: r.url, at: NOW.toISOString(), changes: ["Stop pulling at 4 drafts"] });
    const host = localHost(new Git(repo));
    await git(repo, "merge", "-q", r.branch);
    expect(await host.isOpen(r.branch)).toBe(true);
    expect(await pendingTeamPrs(ctx)).toHaveLength(1);
    await git(repo, "push", "-q", "origin", "main");
    expect(await host.isOpen(r.branch)).toBe(false);
    await rememberTeamPr({ id: r.id, url: r.url, at: NOW.toISOString(), changes: ["Stop pulling at 4 drafts"] });
    expect(await pendingTeamPrs(ctx)).toEqual([]);
  });
});

describe("pmx vendor names every file it wrote (R10)", () => {
  it("both packages, and the team config with --require, and says to commit them all", () => {
    expect(vendoredFiles()).toEqual([".pmx/cli/productmaxxing.tgz", ".pmx/cli/productgit.tgz"]);
    const plain = vendorMessage({ repo: "/r", version: "0.37.1" });
    expect(plain).toContain("Wrote .pmx/cli/productmaxxing.tgz (productmaxxing 0.37.1) and .pmx/cli/productgit.tgz (the same build, for teammates' Macs on PMX 0.14.0 or older) in /r.");
    expect(plain).toContain("Commit both files (.pmx/cli/productmaxxing.tgz and .pmx/cli/productgit.tgz) in a PR of its own.");
    const req = vendorMessage({ repo: "/r", version: "0.37.1", config: "pmx.config.json", autoUpdate: true });
    expect(req).toContain("Set cli.min to 0.37.1 in pmx.config.json");
    expect(req).toContain("Auto-update is on");
    // COMPAT-6: on unless the team turned it off, so a team that never chose is told its Macs install it by themselves.
    expect(vendorMessage({ repo: "/r", version: "0.37.1", config: "pmx.config.json" })).toContain("Auto-update is on: each machine's background job installs it within the hour of the merge (--no-auto-update turns that off).");
    expect(plain).toContain("Once it merges, teammates' Macs install it by themselves within the hour; `pmx update` does it at once.");
    const off = vendorMessage({ repo: "/r", version: "0.37.1", config: "pmx.config.json", autoUpdate: false });
    expect(off).toContain("Auto-update is off for your team (cli.autoUpdate is false): each teammate runs `pmx update` (--auto-update turns it back on).");
    expect(off).toContain("Teammates update with `pmx update`.");
    expect(req).toContain("Commit all three files (.pmx/cli/productmaxxing.tgz, .pmx/cli/productgit.tgz and pmx.config.json) in a PR of its own.");
  });
});

const node = (identifier: string, status: string, o: { state?: [string, string]; recorded?: string; assignee?: string | null; description?: string; comments?: string[]; kind?: string } = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Task ${identifier}`, description: o.description ?? "", url: `https://linear.app/x/${identifier}`, priority: 0, createdAt: "2026-11-01T00:00:00Z",
  labels: { nodes: [
    { name: status, parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } },
    ...(o.recorded ? [{ name: o.recorded, parent: { name: "pmx-state" } }] : []), ...(o.kind ? [{ name: o.kind, parent: { name: "pmx-kind" } }] : []),
  ] },
  comments: { nodes: (o.comments ?? []).map((body) => ({ body })) },
  ...(o.state ? { state: { name: o.state[0], type: o.state[1] } } : {}),
  ...("assignee" in o ? { assignee: o.assignee ? { id: o.assignee } : null } : {}),
});

async function snapshot(issues: any[]) {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues }));
}

const relayTeam = { ...DEFAULT_TEAM, team: "t", tracker: LINEAR } as TeamConfig;

describe("--check judges the assignee by the batch's last change to it (R11)", () => {
  beforeEach(freshHome);

  it("a redo that cleared the agent after it was assigned isn't 'not assigned'; an assign that didn't land still is", async () => {
    await snapshot([node("PMX-18", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null }), node("PMX-19", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null })]);
    const t = relayTracker(relayTeam, () => {}, () => NOW);
    await t.setAgent("PMX-18", "ana@m1");
    await t.setStatus("PMX-18", "review");
    // The redo: the agent cleared on purpose, the task back in Ready.
    await t.setAgent("PMX-18", null);
    await t.setStatus("PMX-18", "ready");
    await t.setAgent("PMX-19", "ana@m1");
    const ops = (await readOutbox()).ops;
    await writeFile(join(relayDir(), "results.json"), JSON.stringify(ops.map((o) => ({ id: o.id, ok: true }))));
    await snapshot([node("PMX-18", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null }), node("PMX-19", "ready", { state: ["Todo", "unstarted"], recorded: "unstarted", assignee: null })]);
    const out = (await checkRelay(relayTeam, NOW)).join("\n");
    expect(out).not.toMatch(/PMX-18 is/);
    expect(out).toMatch(/⚠ PMX-19 is not assigned in Linear, though the change was reported done\./);
  });
});

describe("a finished task's old move in a stale copy of Linear isn't followed (TASK-8, PULL-14)", () => {
  beforeEach(freshHome);

  const mark = (state: TaskMark["state"], o: Partial<TaskMark> = {}): TaskMark => ({ v: 1, task: "PMX-34", state, at: "2026-11-26T06:58:00Z", by: "ana@m1", machine: "m1", landed: "2026-11-26T06:58:00Z", ...o });
  const look = (asOf: string | null) => ({ asOf: asOf ? Date.parse(asOf) : null, now: new Date("2026-11-26T07:30:00Z"), agent: "sam@m2" });

  it("reads the mark: done or dropped on another Mac, while this copy can't show it", () => {
    expect(finishedElsewhere(mark("done"), look("2026-11-26T06:00:00Z"))).toBe(true);
    expect(finishedElsewhere(mark("dropped"), look("2026-11-26T06:00:00Z"))).toBe(true);
    // A copy read well after the step landed shows Linear as it is: a later move is a person's, and followed.
    expect(finishedElsewhere(mark("done"), look("2026-11-26T07:20:00Z"))).toBe(false);
    expect(finishedElsewhere(mark("review"), look("2026-11-26T06:00:00Z"))).toBe(false);
    expect(finishedElsewhere(mark("ready"), look("2026-11-26T06:00:00Z"))).toBe(false);
    expect(finishedElsewhere(null, look("2026-11-26T06:00:00Z"))).toBe(false);
  });

  it("neither follows nor says it did, and queues nothing for Linear", async () => {
    await snapshot([node("PMX-34", "inbox", { state: ["Todo", "unstarted"], recorded: "backlog" }), node("PMX-35", "inbox", { state: ["Todo", "unstarted"], recorded: "backlog" })]);
    const t = relayTracker(relayTeam, () => {}, () => NOW);
    expect(await followMoves(t, { finished: (id) => id === "PMX-34" })).toEqual(["PMX-35 followed a move in Linear to Todo: Ready for agents"]);
    expect((await readOutbox()).ops.map((o) => [o.kind, "target" in o ? o.target : null])).toEqual([["follow-state", "PMX-35"]]);
  });
});

describe("Linear's issue mentions read as the identifiers they stand for (R23)", () => {
  beforeEach(freshHome);

  const mention = (id: string) => `<issue id="0d6a1f2e-${id}" label="${id}" href="https://linear.app/x/issue/${id}/task" />`;
  const back = [
    "Which identity providers matter most?",
    "",
    `**Follows** ${mention("PMX-34")}**:** an open question its accepted draft left, in the team repo at outputs/problem-brief/${mention("PMX-34")}.md.`,
    "**Size S, not checked:** PMX doesn't size follow-ups. Change the size if the work is bigger.",
    "",
    "pmx:source T1",
  ].join("\n");

  it("reads a follow-up's original task and draft path in either form", () => {
    expect(plainMentions(back).split("\n")[2]).toBe("**Follows** PMX-34**:** an open question its accepted draft left, in the team repo at outputs/problem-brief/PMX-34.md.");
    expect(followsIn(back)).toBe("PMX-34");
    expect(followsIn("Q?\n\n**Follows PMX-34:** an open question its accepted draft left, in the team repo at `outputs/problem-brief/PMX-34.md`.")).toBe("PMX-34");
    expect(followsIn(`**Follows** <issue label="PMX-7" id="x">PMX-7</issue>**:** a blocking question`)).toBe("PMX-7");
    expect(followsIn("Q?\n\n**Follows up on** the pricing call.")).toBeNull();
    // Markup that isn't an issue mention stays as it is.
    expect(plainMentions(`<issue id="x" />`)).toBe(`<issue id="x" />`);
  });

  it("a task's description, its draft link and a meeting's tasks come back as PMX wrote them", async () => {
    const task = toTask(node("PMX-40", "inbox", { description: back, comments: [`pmx:pr branch:pmx/task/${mention("PMX-40")}-draft-a-brief`] }));
    expect(task.description).toContain("**Follows** PMX-34**:**");
    expect(task.description).toContain("outputs/problem-brief/PMX-34.md");
    expect(task.prUrl).toBe("branch:pmx/task/PMX-40-draft-a-brief");
    const lodged = node("PMX-41", "running", { kind: "meeting", description: `Meeting.\n\npmx:meeting k1\npmx:task ${mention("PMX-34")}` });
    expect(toMeeting(lodged).tasks).toEqual(["PMX-34"]);
    // Finishing the meeting doesn't add the task it already lists a second time.
    await snapshot([lodged]);
    const t = relayTracker(relayTeam, () => {}, () => NOW);
    await t.finishMeeting("PMX-41", { status: "done", tasks: ["PMX-34", "PMX-35"], note: "Processed." });
    expect((await readOutbox()).ops.at(-1)).toMatchObject({ kind: "finish-meeting", lines: ["pmx:task PMX-35"] });
  });
});

describe("participants written with a display name (R5)", () => {
  const r = (domains: string[]) => ({ internalDomains: domains, requireExternalParticipant: true, neverIngest: { people: [], channels: [], meetingTitles: [] }, wholeMeeting: true });
  const item = (participants: string[]): SignalItem => ({ id: "T1", kind: "transcript", ref: "/x/a.md", title: "Weekly sync", at: "2026-11-03", participants, text: "Sam: SSO is slow.", });

  it("reads the domain of the address in angle brackets, or of a bare address", () => {
    expect(domainOf("Dana Ruiz <dana@globex.example>")).toBe("globex.example");
    expect(domainOf(`"Ruiz, Dana" <Dana@Globex.example>`)).toBe("globex.example");
    expect(domainOf("dana@globex.example")).toBe("globex.example");
    expect(domainOf("Dana Ruiz")).toBeNull();
    expect(outsideDomains(["Dana Ruiz <dana@globex.example>", `"Ruiz, Dana" <dana@globex.example>`, "Sam <sam@us.com>", "lee@initech.example"], ["us.com"])).toEqual(["globex.example", "initech.example"]);
  });

  it("a colleague written as \"Sam <sam@us.com>\" is inside the company", () => {
    const team = item(["Sam <sam@us.com>", "Ana <ana@us.com>", `"Ortiz, Lee" <lee@us.com>`]);
    expect(filterItems([team], r(["us.com"])).decisions[0]).toMatchObject({ decision: "held", rule: "no-external-participant" });
    const call = item(["Sam <sam@us.com>", "Dana Ruiz <dana@globex.example>"]);
    expect(filterItems([call], r(["us.com"])).decisions[0]).toMatchObject({ decision: "kept" });
    const outside = outsideSpeaker(call, r(["us.com"]));
    expect(outside("Dana Ruiz")).toBe(true);
    expect(outside("Sam")).toBe(false);
  });
});

describe("follow-ups count the PM's own company domains as the company's (R4)", () => {
  beforeEach(freshHome);

  it("a question naming the PM's own company's team isn't held as a person's name", async () => {
    const { repo } = await pmxRepo();
    const md = ["# PMX-20: Spec", "", "## Open questions", "", "- Can Initech Support run the export for admins?"].join("\n");
    const task: Task = {
      id: "lin-20", identifier: "PMX-20", title: "Spec the admin export",
      description: "Admins export by hand.\n\n**Based on** one meeting (2026-11-20). The sources stay on the PM's Mac.\n\npmx:source T1",
      url: "https://linear.app/x/PMX-20", category: "spec", size: "M", status: "review", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z",
    };
    const item = { task, record: null, files: [{ path: "outputs/spec/PMX-20.md", content: md }], citations: {} };
    // On a teammate's Mac: the task's quotes from its evidence pack, where the PM's own company's support team speaks.
    const passages = ["Initech Support: the export runs every Friday for 40 admins.", "Lee Park: Initech Support should own it."];
    await evidenceStore(new Git(repo)).write({ put: [{ v: 1, task: "PMX-20", at: NOW.toISOString(), sources: [{ id: "T1", kind: "meeting", at: "2026-11-20", passages }] }] }, "test: pack");
    const team = await testCtx({ repo, team: { internalDomains: ["us.example"] } });
    expect((await followUpsOnAccept(team, await services(team, { tracker: memoryTracker([]) }), item)).leftOut).toBe(1);
    await freshHome();
    const mine = await testCtx({ repo, team: { internalDomains: ["us.example"] }, personal: { companyDomains: ["initech.example"] } });
    const r = await followUpsOnAccept(mine, await services(mine, { tracker: memoryTracker([]) }), item);
    expect(r.leftOut).toBe(0);
    const ps = await readProposals();
    expect(ps.map((p) => p.title)).toEqual(["Can Initech Support run the export for admins?"]);
    // R23: the draft's path is in backticks, which Linear leaves as it is.
    expect(ps[0]!.description).toContain("**Follows PMX-20:** an open question its accepted draft left, in the team repo at `outputs/spec/PMX-20.md`.");
  });
});

// R13: a Mac's copy of Linear, as its last Claude sync read it.
function copyOf(linear: ReturnType<typeof memoryTracker>, seen: Task[], syncedAt: Date): Tracker {
  return {
    ...linear,
    async syncedAt() { return syncedAt.toISOString(); },
    async list(o) { return structuredClone(seen).filter((t) => !o?.status || (t.status !== null && o.status.includes(t.status))); },
    async get(id) { const t = seen.find((x) => x.id === id || x.identifier === id); if (!t) throw new Error(`No task ${id}.`); return structuredClone(t); },
  };
}

const DRAFT = "# Draft a one-pager for SCIM sync\n\n## Problem\n\nAdmins sync users by hand [T1].\n\n## Evidence\n\n- Weekly CSV export [T1]\n- Recurring requests [S1]\n\n## Validated by\n\nNot validated yet [T1].\n\n## Proposal\n\nSCIM 2.0 provisioning.\n\n## Success metrics\n\n- Minutes, not hours.\n\n## Open questions\n\nNone [T1].\n";
const at = (hm: string) => { const [h, m] = hm.split(":").map(Number); return new Date(2026, 0, 5, h, m); };

describe("review reads the team's task marks (R13, PULL-14)", () => {
  // PMX's page builds its own services, as the board does; this hands it the Mac's copy of Linear.
  let injected: Tracker | null = null;
  registerServices({ tracker: async () => injected as any });
  beforeEach(freshHome);
  afterEach(() => { injected = null; });

  it("a teammate's leftover draft of a task accepted on another Mac isn't offered, and says why, until the copy catches up", async () => {
    const homeA = await freshHome();
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const ready: Task = {
      id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync",
      description: "Admins sync users by hand.\n\n- [T1] Acme call: we export a CSV every Friday\n- [S1] #feedback: third SCIM ask\n\npmx:source T1\npmx:source S1",
      url: "https://linear.app/x/PMX-14", category: "spec", size: "M", status: "ready", priority: 2, agent: null, sources: ["T1", "S1"], prUrl: null, createdAt: "2026-01-01T00:00:00Z",
    };
    const linear = memoryTracker([ready]);
    const runtime = mockRuntime(async (o) => {
      const out = o.prompt.match(/Write the output to (\S+?\.md)/)?.[1];
      if (out) { await mkdir(dirname(join(o.cwd, out)), { recursive: true }); await writeFile(join(o.cwd, out), DRAFT); }
      return { text: "Drafted.", costUsd: 0.2 };
    });
    const ana = async (now: Date) => { process.env.PMX_HOME = homeA; const ctx = await testCtx({ repo, runtime, now }); return { ctx, svc: await services(ctx, { tracker: linear }) }; };
    const a = await ana(at("06:58"));
    expect((await pull(a.ctx, a.svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });

    // Sam's Mac kept its own draft of the same task, from a double draft before PULL-14; its copy of Linear shows it.
    const homeB = await freshHome();
    const repoB = join(await tmp("mac-b-"), "pmx");
    await execOk("git", ["clone", "-q", origin!, repoB]);
    await git(repoB, "config", "user.name", "Test");
    await git(repoB, "config", "user.email", "test@example.com");
    await git(repoB, "checkout", "-q", "-b", "pmx/task/PMX-14-sam");
    await mkdir(join(repoB, "outputs", "spec"), { recursive: true });
    await writeFile(join(repoB, "outputs", "spec", "PMX-14.md"), DRAFT);
    await git(repoB, "add", "-A");
    await git(repoB, "commit", "-qm", "PMX-14: draft");
    await git(repoB, "checkout", "-q", "main");
    const seen = [{ ...ready, status: "review" as const, agent: "sam@m2", prUrl: "branch:pmx/task/PMX-14-sam" }];
    const sam = async (now: Date, synced: Date) => {
      process.env.PMX_HOME = homeB;
      const ctx = await testCtx({ repo: repoB, now, personal: { handle: "sam", machineId: "m2" } });
      return { ctx, svc: await services(ctx, { tracker: copyOf(linear, seen, synced) }) };
    };
    // Before Ana decides, Sam's draft is in Sam's queue.
    const b0 = await sam(at("07:10"), at("07:00"));
    expect((await loadQueue(b0.ctx, b0.svc, { all: true })).items.map((i) => i.task.identifier)).toEqual(["PMX-14"]);

    // Ana accepts hers at 07:30; Sam's copy of Linear is from 07:00.
    const a2 = await ana(at("07:30"));
    const q = await loadQueue(a2.ctx, a2.svc);
    await recordDecision(a2.ctx, a2.svc, q.host, q.items[0]!, "accepted");
    const line = "PMX-14 was accepted on another Mac (ana@m1) at 07:30; this draft is no longer needed.";
    const b = await sam(at("07:45"), at("07:00"));
    const sq = await loadQueue(b.ctx, b.svc, { all: true });
    expect(sq.items).toEqual([]);
    expect(sq.decided).toEqual([{ id: "lin-1", identifier: "PMX-14", text: line }]);
    expect(await terminalReview(b.ctx, b.svc, { choose: async () => "accept", text: async () => "", confirm: async () => true } as any, { all: true })).toBe(`${line}\nNothing waiting for review.`);
    expect(await scriptedReview(b.ctx, b.svc, { accept: ["PMX-14"] })).toEqual({ text: `${line}\nNothing was decided.`, code: 1 });
    injected = b.svc.tracker;
    expect(await pipelineHandlers(b.ctx).review("PMX-14", "accepted", "")).toEqual({ status: 404, body: { error: line } });
    // Nothing was decided twice: Sam's draft is still there, and the task is done once.
    expect(await git(repoB, "branch", "--list", "pmx/task/PMX-14-sam")).toContain("pmx/task/PMX-14-sam");
    expect(linear.tasks.get("lin-1")!.status).toBe("done");

    // Once Sam's copy is read well after the accept landed, the copy decides again.
    expect(draftDecided("PMX-14", { v: 1, task: "PMX-14", state: "done", at: at("07:30").toISOString(), by: "ana@m1", machine: "m1", landed: at("07:30").toISOString() }, { asOf: at("07:50").getTime(), now: at("07:55"), agent: "sam@m2" })).toBeNull();
  });
});
