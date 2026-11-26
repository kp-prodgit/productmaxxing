// F12, F13 and F23 from an end-to-end test of a team two months from launch: every suggested task was an early-stage
// brief (no spec, no decision), the 10-task limit squeezed a backlog, and cost estimates ran about 15 times over.
import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { budget, recordSpend } from "../src/budget/provider.js";
import { DEFAULT_TEAM, maxTasks, validateTeamConfig, type TeamConfig } from "../src/core/config.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { services } from "../src/core/services.js";
import { parseRubric } from "../src/core/skillcheck.js";
import { bundledSkillsDir, categoryMenu } from "../src/core/skills.js";
import type { Task } from "../src/core/types.js";
import { checkChange, proposeTeamChanges } from "../src/flow/actions.js";
import { buildPipeline } from "../src/flow/pipeline.js";
import { estimateCost, estimateText } from "../src/pull/estimate.js";
import { selectTasks } from "../src/pull/select.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { heldOverCount, heldOverFile, heldOverLine, MAX_ROUNDS, nextHeld, readHeldOver } from "../src/synth/held-over.js";
import { readProposals } from "../src/synth/proposals.js";
import { parseCandidates, synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, personal, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t" } as TeamConfig;
const skill = (name: string) => readFile(join(bundledSkillsDir(), name, "SKILL.md"), "utf8");

describe("kinds of work that fit where a team is (F13, CAT-8, SIG-8)", () => {
  beforeEach(freshHome);

  it("a decision brief: options, criteria, evidence for each, a recommendation the PM decides, and the decision's date", async () => {
    expect(DEFAULT_TEAM.categories["decision-brief"]).toEqual({ skill: "pmx-decision-brief" });
    const text = await skill("pmx-decision-brief");
    expect(text).toMatch(/"requiredHeadings": \["Decision", "Options", "Criteria", "Evidence by option", "Recommendation", "Open questions"\]/);
    expect(text).toMatch(/the date it's needed by, with the source ID/);
    // R1: the Recommendation ends with the decision in words, so accepting the brief makes it a to-do (FOLLOW-1).
    expect(text).toMatch(/End it with a line of its own: `\*\*PM decides:\*\* <the decision, in a few words>`/);
    const rubric = parseRubric(await skill("pmx-size"));
    expect(rubric.cells["decision-brief"]?.M).toBe("One decision with a date, two to four options across 3–8 sources");
  });

  it("synthesis is told when to suggest a spec or a decision brief, and what a release needs", async () => {
    const menu = await categoryMenu("/nonexistent", DEFAULT_TEAM.categories);
    expect(menu).toMatch(/^- decision-brief: Decision brief\. Sets up one decision.*\n {2}Propose it when: The sources show a decision with a date/m);
    expect(menu).toMatch(/^- spec: .*\n {2}Propose it when: The requirements are already in writing or the scope is agreed/m);
    expect(menu).toMatch(/^- problem-brief: .*\n {2}Propose it when: .*\n {2}Don't propose it when: The requirements are already in writing or the scope is agreed: that's a spec\./m);
    const synth = await skill("pmx-synthesize");
    expect(synth).toMatch(/requirements are already in writing, or the scope is agreed\*\*[\s\S]*propose a `spec`, not a problem brief/);
    expect(synth).toMatch(/decision has a date, or there's an open choice between options\*\*[\s\S]*propose a `decision-brief`/);
    expect(synth).toMatch(/getting a release out[\s\S]*"Launch\s+readiness:"/);
    expect(synth).toMatch(/For a need that's new to the team, frame the task around the customer's problem/);
    expect(synth).not.toMatch(/at most 10/);
  });

  it("synthesis suggests only the kinds a team has turned on: an older team without decision-brief never gets one", () => {
    const older = Object.keys(DEFAULT_TEAM.categories).filter((c) => c !== "decision-brief");
    const out = JSON.stringify({ tasks: [{ title: "Decide which integration ships first", category: "decision-brief", size: "M", rationale: "A choice is due.", sources: ["T1"], support: { T1: "The date is set here." } }] });
    expect(parseCandidates(out, older, new Set(["T1"])).skipped).toEqual(["Decide which integration ships first: unknown category decision-brief"]);
    expect(parseCandidates(out, Object.keys(DEFAULT_TEAM.categories), new Set(["T1"])).tasks).toHaveLength(1);
  });

  it("an older team adds PMX's new kind by pull request: its line and its size row, off for everyone else until they switch it on", async () => {
    const { repo } = await pmxRepo();
    // A repo set up before decision-brief: no config line, and a team copy of the rubric without its row.
    const cfgPath = join(repo, "pmx.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    delete cfg.categories["decision-brief"];
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    const sizePath = join(repo, ".claude", "skills", "pmx-size", "SKILL.md");
    await writeFile(sizePath, (await readFile(sizePath, "utf8")).split("\n").filter((l) => !l.startsWith("| decision-brief |")).join("\n").replace("| validation-readout |", "| stakeholder-update | One note | A weekly note | A launch note | A board pack |\n| validation-readout |"));
    await git(repo, "commit", "-qam", "older team");
    const ctx = await testCtx({ repo, team: { categories: cfg.categories } });
    expect(() => checkChange({ kind: "builtin-kind", name: "astrology" }, ctx.team)).toThrow(/PMX has no kind of work called astrology/);
    expect(() => checkChange({ kind: "builtin-kind", name: "spec" }, ctx.team)).toThrow(/already has spec/);

    const r = await proposeTeamChanges(ctx, [checkChange({ kind: "builtin-kind", name: "decision-brief" }, ctx.team)]);
    const merged = JSON.parse(await ctx.repo.ok(["show", `${r.branch}:pmx.config.json`]));
    expect(merged.categories["decision-brief"]).toEqual({ skill: "pmx-decision-brief" });
    const rows = parseRubric(await ctx.repo.ok(["show", `${r.branch}:.claude/skills/pmx-size/SKILL.md`])).cells;
    expect(rows["decision-brief"]?.S).toBe("One choice between two options from 1–2 sources");
    expect(rows["stakeholder-update"]?.M).toBe("A weekly note");
    // A PM who set up before it doesn't take it until they switch it on (JOB-9: each PM's choice).
    expect(personal(repo, { categories: ["spec"] }).categories).not.toContain("decision-brief");
  });

  it("a team takes PMX's newer skills only when it asks, by pull request, keeping its own rubric rows", async () => {
    const { repo } = await pmxRepo();
    const synthPath = join(repo, ".claude", "skills", "pmx-synthesize", "SKILL.md");
    await writeFile(synthPath, (await readFile(synthPath, "utf8")).replace(/## Choose the kind of work by where the team is[\s\S]*?## Rules/, "## Rules"));
    const sizePath = join(repo, ".claude", "skills", "pmx-size", "SKILL.md");
    await writeFile(sizePath, (await readFile(sizePath, "utf8")).replace("| decision-brief |", "| stakeholder-update | One note | A weekly note | A launch note | A board pack |\n| old-decision-brief |"));
    await git(repo, "commit", "-qam", "older copies");
    const ctx = await testCtx({ repo });
    expect(() => checkChange({ kind: "skill-update", name: "../etc" }, ctx.team)).toThrow(/Name one of PMX's own skills/);
    const r = await proposeTeamChanges(ctx, ["pmx-synthesize", "pmx-size"].map((name) => checkChange({ kind: "skill-update", name }, ctx.team)));
    expect(await ctx.repo.ok(["show", `${r.branch}:.claude/skills/pmx-synthesize/SKILL.md`])).toBe((await skill("pmx-synthesize")).trimEnd());
    const rows = parseRubric(await ctx.repo.ok(["show", `${r.branch}:.claude/skills/pmx-size/SKILL.md`])).cells;
    expect(rows["stakeholder-update"]?.L).toBe("A launch note");
    expect(rows["decision-brief"]).toBeTruthy();
    expect(await ctx.repo.ok(["log", "-1", "--format=%s", r.branch])).toBe("PMX's newer skills: pmx-synthesize, pmx-size");
  });
});

describe("the task limit is the team's, and needs past it come back (F12, SIG-9)", () => {
  beforeEach(freshHome);

  it("synthesis.maxTasks is 15 by default, a whole number from 1 to 30", () => {
    expect(maxTasks(team)).toBe(15);
    expect(maxTasks({ synthesis: null })).toBe(15);
    expect(maxTasks({ synthesis: { maxTasks: 22 } })).toBe(22);
    for (const bad of [0, 31, 2.5, "10"]) expect(() => validateTeamConfig({ ...team, synthesis: { maxTasks: bad as any } })).toThrow(/synthesis\.maxTasks must be a whole number from 1 to 30/);
    expect(validateTeamConfig({ ...team, synthesis: { maxTasks: 30 } }).synthesis).toEqual({ maxTasks: 30 });
  });

  it("keeps the team's number of tasks and holds over the rest, the model's own list and any tasks past the limit", () => {
    const NAMES = ["", "Approval workflow audit trail", "Tenant isolation review", "Copy tone accuracy", "Metering for usage billing"];
    const t = (n: number) => ({ title: NAMES[n]!, category: "spec", size: "S", rationale: `Reason ${n}.`, sources: ["T1"], support: { T1: "The call raises it plainly." } });
    const out = JSON.stringify({
      tasks: [t(1), t(2), t(3), t(4)],
      heldOver: [
        { title: "Retraining after guideline changes", category: "research-synthesis", sources: ["T1", "T9"], why: "Brands change their rules." },
        { title: "Astrology", category: "astrology", sources: ["T1"], why: "x" },
        { title: "No sources", category: "spec", sources: ["T9"], why: "x" },
        { title: "Approval workflow audit trail", category: "spec", sources: ["T1"], why: "Already a task." },
      ],
    });
    const r = parseCandidates(out, Object.keys(DEFAULT_TEAM.categories), new Set(["T1"]), undefined, new Map(), { maxTasks: 2 });
    expect(r.tasks.map((x) => x.title)).toEqual(["Approval workflow audit trail", "Tenant isolation review"]);
    expect(r.heldOver).toEqual([
      { title: "Copy tone accuracy", category: "spec", why: "Reason 3.", sources: ["T1"] },
      { title: "Metering for usage billing", category: "spec", why: "Reason 4.", sources: ["T1"] },
      { title: "Retraining after guideline changes", category: "research-synthesis", why: "Brands change their rules.", sources: ["T1"] },
    ]);
  });

  it("holds over what doesn't fit on the synthesis Mac, owner-only, and offers it to the next run first with its sources", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    const a = await writeTranscript(dir, "acme.md", "---\ntitle: Acme\ndate: 2026-11-16\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Our approvers need a two-step sign-off and a seven-year audit trail before beta.");
    const b = await writeTranscript(dir, "globex.md", "---\ntitle: Globex\ndate: 2026-11-16\nparticipants: lee@globex.example, kp@us.com\n---\nLee: Retraining after every guideline change takes our team a week.");
    let reply = JSON.stringify({
      tasks: [{ title: "Specify approvals and the audit trail for beta", category: "spec", size: "M", rationale: "The requirements are written down already.", sources: ["T1"], support: { T1: "The buyer lists the approval steps." } }],
      heldOver: [{ title: "Understand retraining after guideline changes", category: "research-synthesis", sources: ["T2"], why: "A week lost per change." }],
    });
    const runtime = mockRuntime(() => reply);
    const now = new Date(2026, 10, 18, 10);
    const opts = { repo, runtime, now, team: { internalDomains: ["us.com"], synthesis: { maxTasks: 1 } }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } };
    const ctx = await testCtx(opts);
    const svc = await services(ctx, { tracker: memoryTracker() });

    const dry = await synthesize(ctx, svc, { days: 7, dryRun: true });
    expect(dry.heldOver).toBe(1);
    expect(await readHeldOver()).toBeNull();

    const first = await synthesize(ctx, svc, { days: 7 });
    expect(runtime.calls.at(-1)!.prompt).toContain("- Return at most 1 task in `tasks`, the highest value first. This is your team's limit");
    expect(first.staged.map((p) => p.title)).toEqual(["Specify approvals and the audit trail for beta"]);
    expect(first.heldOver).toBe(1);
    expect(await heldOverCount()).toBe(1);
    expect((await stat(heldOverFile())).mode & 0o777).toBe(0o600);
    const held = (await readHeldOver())!;
    expect(held.needs).toEqual([expect.objectContaining({ title: "Understand retraining after guideline changes", category: "research-synthesis", rounds: 1, sources: [expect.objectContaining({ kind: "transcript", refHash: expect.any(String), keys: expect.any(Array) })] })]);
    expect(JSON.stringify(held)).not.toMatch(/Lee|Globex|guideline change takes/);
    const receipt = (await readReceipt((await listReceipts()).find((id) => id.startsWith("synthesize"))!))!;
    expect(receipt.synth!.heldOver).toEqual([{ title: "Understand retraining after guideline changes", category: "research-synthesis", sources: ["T2"], rounds: 1 }]);
    expect(heldOverLine(6)).toBe("6 more needs were found; they come back in the next run.");
    expect(heldOverLine(1)).toBe("1 more need was found; it comes back in the next run.");

    // Two days later: the first meetings are older than this run's window, and a new one arrived.
    const old = new Date(2026, 10, 13).getTime() / 1000;
    await utimes(a, old, old);
    await utimes(b, old, old);
    await writeTranscript(dir, "initech.md", "---\ntitle: Initech\ndate: 2026-11-20\nparticipants: sam@initech.example, kp@us.com\n---\nSam: We'd pay for a light tier for occasional users.");
    reply = "";
    const later = await testCtx({ ...opts, now: new Date(2026, 10, 20, 10) });
    const block = (p: string) => p.slice(p.indexOf("## Needs held over"), p.indexOf("\n\n", p.indexOf("## Needs held over") + 30));
    const second = mockRuntime((o) => {
      const line = block(o.prompt).split("\n").find((l) => l.startsWith("- H1"))!;
      const id = line.match(/Sources: (\w+)\./)![1]!;
      expect(o.prompt).toContain(`<item id="${id}" kind="transcript"`);
      return JSON.stringify({ tasks: [
        { title: "Understand retraining after guideline changes", category: "research-synthesis", size: "S", rationale: "Teams lose a week on each change.", sources: [id], support: { [id]: "The customer describes the lost week." } },
      ], heldOver: [] });
    });
    const r2 = await synthesize({ ...later, runtime: second }, await services(later, { tracker: memoryTracker() }), { days: 2 });
    expect(second.calls).toHaveLength(1);
    expect(second.calls[0]!.prompt).toMatch(/## Needs held over from the last run \(reconsider these first\)\n.*\n- H1 \(research-synthesis\): Understand retraining after guideline changes\. A week lost per change\. Sources: T\d+\./);
    expect(r2.staged.map((p) => p.title)).toEqual(["Understand retraining after guideline changes"]);
    expect((await readProposals()).find((p) => p.title.startsWith("Understand"))!.from).toEqual([expect.objectContaining({ title: "Globex" })]);
    // Nothing left over: the file is gone, and Needs you says nothing more.
    expect(r2.heldOver).toBe(0);
    expect(await readHeldOver()).toBeNull();
  });

  it("a need held over three runs in a row is let go, and a new source brings it back", () => {
    const need = { title: "Retraining after guideline changes", category: "research-synthesis", why: "", sources: [] };
    let before: ReturnType<typeof nextHeld>["needs"] = [];
    for (let i = 1; i <= MAX_ROUNDS; i++) {
      const n = nextHeld([need], before, `2026-11-${10 + i}T00:00:00Z`);
      expect(n.needs[0]).toMatchObject({ rounds: i, since: "2026-11-11T00:00:00Z" });
      before = n.needs;
    }
    expect(nextHeld([need], before, "2026-11-20T00:00:00Z")).toMatchObject({ needs: [], dropped: [{ rounds: MAX_ROUNDS + 1 }] });
    expect(nextHeld([need], [], "2026-11-21T00:00:00Z").needs[0]!.rounds).toBe(1);
  });

  it("Needs you and pmx status carry how many needs wait for the next run", () => {
    const d = buildPipeline({ level: "local", now: new Date(), hours: 24, agent: "a@m", receipts: [], runlog: [], issues: [], linearSyncedAt: null, collectReports: [], todosCreated: [], proposals: [], heldOver: 6, checks: [], health: { problems: [], facts: [] }, lastTick: null, skills: [], schedules: [], rules: { routes: {}, teamDomains: [], myDomains: [], neverIngest: { people: [], titles: [], channels: [] }, budget: { dailyUsd: null, teamCap: 20, spentUsd: 0, tokens: 0 }, categories: [], reviewCap: 3, sizes: { S: { minutes: 15, usd: 0.05 }, M: { minutes: 30, usd: 0.1 }, L: { minutes: 60, usd: 0.25 }, XL: { minutes: 120, usd: 0.5 } }, rubric: {}, slackChannels: [], allowedSources: [] } } as any);
    expect(d.needs.heldOver).toBe(6);
    expect(heldOverLine(d.needs.heldOver!)).toBe("6 more needs were found; they come back in the next run.");
  });
});

describe("cost estimates learn from the team's runs (F23, PULL-13)", () => {
  const run = (costUsd: number | null, over: Partial<Extract<RunLogEntry, { type: "run" }>> = {}, day = 1): RunLogEntry => ({
    type: "run", ts: `2026-11-${String(day).padStart(2, "0")}T10:00:00Z`, agent: "a@m", machine: "m", taskId: `PMX-${day}`, category: "problem-brief", size: "M",
    skill: "pmx-problem-brief", skillVersion: "v", outcome: "ok", durationMs: 30000, tokens: 56000, costUsd, runtime: "claude-code", ...over,
  } as RunLogEntry);
  const eight = [0.08, 0.1, 0.09, 0.1, 0.08, 0.1, 0.09, 0.1].map((c, i) => run(c, {}, i + 1));

  it("the median of the last 10 good runs of this kind and size, rounded up to the cent; never other kinds, sizes or failed runs", () => {
    const e = estimateCost([...eight, run(3, { outcome: "failed" }, 20), run(5, { size: "L" }, 21), run(5, { category: "spec" }, 22), run(null, {}, 23)], team, "problem-brief", "M");
    expect(e).toEqual({ usd: 0.1, basis: "runs", runs: 8, tableUsd: 0.1 });
    expect(estimateText(e)).toBe("about $0.10, from the last 8 runs");
    // Only the last 10: older, pricier runs drop out.
    const many = [...Array.from({ length: 5 }, (_, i) => run(2, {}, i + 1)), ...Array.from({ length: 10 }, (_, i) => run(0.091, {}, i + 10))];
    expect(estimateCost(many, team, "problem-brief", "M")).toMatchObject({ usd: 0.1, runs: 10 });
  });

  it("the size table with fewer than 3 runs, but never below what those runs cost", () => {
    expect(estimateCost([], team, "decision-brief", "M")).toEqual({ usd: 0.1, basis: "table", runs: 0, tableUsd: 0.1 });
    expect(estimateText(estimateCost([], team, "decision-brief", "M"))).toBe("about $0.10, from your team's size table");
    const pricey = estimateCost([run(0.3, {}, 1), run(0.41, {}, 2)], team, "problem-brief", "M");
    expect(pricey).toEqual({ usd: 0.36, basis: "table", runs: 2, tableUsd: 0.1 });
    expect(estimateText(pricey)).toBe("about $0.36, from its 2 runs so far (more than your team's size table)");
  });

  it("today's fallback table is realistic: about $0.10 for an M draft", () => {
    expect(Object.fromEntries(Object.entries(DEFAULT_TEAM.sizes).map(([z, v]) => [z, v.costUsd]))).toEqual({ S: 0.05, M: 0.1, L: 0.25, XL: 0.5 });
  });

  it("a $10 cap lets about a hundred $0.10 drafts through, not six, and each run counts what it really cost", () => {
    const p = personal("/r", { budget: { dailyUsd: 10, resetHour: 0, overrideUsd: null } });
    // A team still on the old table ($1.50 for M): what its runs cost is what the estimate goes by.
    const old = { ...team, sizes: { ...team.sizes, M: { minutes: 30, costUsd: 1.5 } } } as TeamConfig;
    const state = { ledger: {}, lastDigestWeek: null, lastSynthAt: null, eeTrialStartedAt: null, lastEventSyncAt: null } as any;
    const now = new Date(2026, 10, 26, 9);
    const task = (n: number): Task => ({ id: `t${n}`, identifier: `PMX-${n}`, title: "Brief", description: "", url: "", category: "problem-brief", size: "M", status: "ready", priority: 3, agent: null, sources: [], prUrl: null, createdAt: "2026-11-01T00:00:00Z" });
    const pick = (runs: RunLogEntry[]) => selectTasks({ tasks: [task(1)], agent: "a@m", personal: p, team: old, now, budget: budget(p, old, state, now), inReview: 0, pausedCategories: new Map(), leasedTaskIds: new Set(), runs });
    expect(pick(eight).decisions[0]!.why).toMatch(/^fits: M, about \$0\.10, from the last 8 runs; priority 3/);
    let started = 0;
    const log = [...eight];
    while (pick(log).candidates.length && started < 500) {
      recordSpend(state, p, now, 0.1);
      log.push(run(0.1, {}, 9));
      started++;
    }
    expect(started).toBeGreaterThanOrEqual(99);
    // A run that costs more than expected still counts in full against the cap.
    const fresh = { ...state, ledger: {} };
    recordSpend(fresh, p, now, 2.75);
    expect(budget(p, old, fresh, now).remainingUsd).toBeCloseTo(7.25);
    const low = { ...fresh, ledger: { [Object.keys(fresh.ledger)[0]!]: 9.95 } };
    expect(selectTasks({ tasks: [task(1)], agent: "a@m", personal: p, team: old, now, budget: budget(p, old, low, now), inReview: 0, pausedCategories: new Map(), leasedTaskIds: new Set(), runs: eight }).decisions[0]!.why)
      .toBe("size M needs about $0.10, from the last 8 runs; $0.05 left today");
  });
});

describe("the page says what waits for the next run and what a run costs", () => {
  let ui: import("./ui-helpers.js").Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("Needs you has one line for needs held over, with or without tasks to approve", async () => {
    const { openBoard, pageText } = await import("./ui-helpers.js");
    const { saveHeldOver } = await import("../src/synth/held-over.js");
    const need = (n: number) => ({ title: `Need ${n}`, category: "spec", why: "", sources: [], rounds: 1, since: new Date().toISOString() });
    ui = await openBoard({ hash: "needs", before: async () => saveHeldOver({ v: 1, at: new Date().toISOString(), receipt: "synthesize-20261126T100000Z", readSince: new Date().toISOString(), needs: [1, 2, 3, 4, 5, 6].map(need) }) });
    const line = await ui.until(() => ui!.$("#held-over"), "held-over line");
    expect(line.textContent).toBe("6 more needs were found; they come back in the next run.");
    expect(pageText(ui)).not.toMatch(/\bproposals?\b/i);
  });
});
