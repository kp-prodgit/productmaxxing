import { STAGES } from "../src/core/types.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { collectPrompt } from "../src/collect/collect.js";
import { filterItems } from "../src/core/filter.js";
import type { RunReceipt } from "../src/core/receipt.js";
import { privacyRules } from "../src/digest/gather.js";
import { startExplainServer } from "../src/explain/server.js";
import { applyPersonal, checkChange, loosens, proposeTeamChanges, setRubricCell } from "../src/flow/actions.js";
import { buildFlowGraph } from "../src/flow/graph.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { pipelineTemplate } from "../src/flow/pipeline-page.js";
import { buildPipeline, splitDescription, type PipelineInputs } from "../src/flow/pipeline.js";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { skillInventory } from "../src/core/skills.js";
import { handleMcp } from "../src/mcp/server.js";
import { stageProposals } from "../src/synth/proposals.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";

const NOW = new Date("2026-11-07T15:00:00Z");
const src = (over: Partial<RunReceipt["sources"][number]>): RunReceipt["sources"][number] => ({ kind: "transcript", refHash: "h1", decision: "used", detail: "", passagesCut: [], passagesUsed: 3, origin: "granola", title: "Acme renewal", ...over });
const receipt = (over: Partial<RunReceipt>): RunReceipt => ({
  v: 1, id: "synthesize-20261107T120000Z", type: "synthesize", at: "2026-11-07T12:00:00Z", agent: "ana@m1", outcome: "staged",
  window: { days: 1, since: "", scope: "team" }, rules: { internalDomains: [], requireExternalParticipant: true, topicRulesHash: "", neverIngest: { people: 0, channels: 0, meetingTitles: 0 }, folders: [] },
  skippedSources: [], sources: [], masked: { email: 0, phone: 0, card: 0, id: 0, person: 0 }, skills: [], model: { name: "m", runtime: "r", tools: "", costUsd: 0.1, tokens: 4000, durationMs: 1, promptSha256: "" }, ...over,
});
const rules = { routes: {}, teamDomains: ["us.com"], myDomains: [], neverIngest: { people: ["Dana Reyes"], titles: ["Board prep"], channels: [] }, budget: { dailyUsd: null, teamCap: 20, spentUsd: 0, tokens: 0 },
  categories: [{ name: "spec", accepted: true }], reviewCap: 3, sizes: { S: { minutes: 15, usd: 0.5 }, M: { minutes: 30, usd: 1.5 }, L: { minutes: 60, usd: 4 }, XL: { minutes: 120, usd: 8 } },
  rubric: { spec: { S: "a", M: "b", L: "c", XL: "d" } }, slackChannels: ["C1"], allowedSources: ["transcripts", "slack"] } as PipelineInputs["rules"];

function inputs(level: "local" | "shared"): PipelineInputs {
  return {
    level, now: NOW, hours: 168, agent: "ana@m1", linearSyncedAt: "2026-11-07T14:00:00Z", collectReports: [{ at: "2026-11-07T12:30:00Z", connector: "granola", saved: 3 }],
    receipts: [
      receipt({ sources: [src({}), src({ refHash: "h2", decision: "left-out", rule: "one-on-one", title: undefined }), src({ refHash: "h3", kind: "slack", origin: "slack" })],
        synth: { skipped: [], tasks: [
          { title: "Draft SSO one-pager", category: "spec", size: "M", sources: ["T1"], posted: { identifier: "PMX-5" } } as any,
          { title: "Private idea", category: "spec", size: "S", sources: ["T1"], posted: { staged: "p1" } } as any,
          { title: "Dropped idea", category: "spec", size: "S", sources: ["T1"], posted: { dropped: true } } as any,
        ] } }),
      receipt({ id: "todo-20261107T123000Z", type: "todo", sources: [src({}), src({ refHash: "h2" })], model: { name: "m", runtime: "r", tools: "", costUsd: 0, tokens: 2500, durationMs: 1, promptSha256: "" } }),
      receipt({ id: "synthesize-20261020T120000Z", at: "2026-10-20T12:00:00Z", sources: [src({ refHash: "old" })] }),
    ],
    runlog: [
      { type: "run", ts: "2026-11-07T13:00:00Z", agent: "ana@m1", machine: "m1", taskId: "PMX-4", category: "spec", size: "M", skill: "pmx-spec", skillVersion: "1", outcome: "ok", durationMs: 1, tokens: 90000, costUsd: 1, runtime: "claude-code", prev: null, hash: "x" } as any,
      { type: "verdict", ts: "2026-11-07T14:00:00Z", agent: "bo@m2", machine: "m2", taskId: "PMX-3", category: "spec", size: "S", verdict: "accepted", reviewMinutes: 5, editSize: 1, prev: null, hash: "y" } as any,
    ],
    issues: [
      { identifier: "PMX-5", title: "Draft SSO one-pager", status: "inbox", meeting: false },
      { identifier: "PMX-4", title: "Spec audit logs", status: "review", meeting: false, createdAt: "2026-11-07T13:00:00Z" },
      { identifier: "PMX-2", title: "Ready one", status: "ready", meeting: false },
    ],
    todosCreated: ["2026-11-07T12:31:00Z", "2026-11-07T12:31:00Z"],
    proposals: [{ id: "p1", at: "2026-11-07T12:00:00Z", receipt: "x", title: "Private idea", description: "d", category: "spec", size: "S", sources: ["T1"], from: [{ id: "T1", title: "Acme renewal", at: "2026-11-07T10:00:00Z", why: "w" }] }],
    checks: [], health: { problems: [], facts: ["collection 12:30"] }, lastTick: "2026-11-07T14:30:00Z", skills: [], schedules: [], rules,
  };
}

describe("0.16.0: the pipeline board (BOARD-3)", () => {
  beforeEach(freshHome);

  it("counts what travelled on each connection from PMX's own records, in the window only", () => {
    const d = buildPipeline(inputs("local"));
    expect(d.sources).toEqual([{ id: "granola", label: "Granola", connected: true, n: 3, last: "2026-11-07T12:30:00Z" }]);
    expect(d.edges["c-f"].n).toBe(2);
    expect(d.edges["s-f"].n).toBe(1);
    expect(d.edges["f-h"]).toMatchObject({ n: 1, unit: "meetings" });
    expect(d.edges["f-d"]).toMatchObject({ n: 2, tokens: 4000 });
    expect(d.edges["f-t"]).toMatchObject({ n: 2, tokens: 2500 });
    expect(d.edges["t-t"].n).toBe(2);
    expect([d.edges["d-a"].n, d.edges["a-i"].n, d.edges["a-x"].n]).toEqual([3, 1, 1]);
    expect([d.edges["i-r"].n, d.edges["r-g"].n, d.edges["g-v"].n, d.edges["v-d"].n]).toEqual([1, 1, 1, 1]);
    expect(d.needs).toEqual({ proposals: 1, drafts: 1, todos: 0 });
    expect(d.held).toEqual([{ rule: "one-on-one", label: "1:1s and career talks", n: 1 }]);
    expect(d.proposals[0]).toMatchObject({ id: "p1", title: "Private idea", from: "1 source (2026-11-07)" });
    expect(d.rules.neverIngest.people).toEqual(["Dana Reyes"]);
  });

  it("the shared level (the Claude artifact) keeps proposals and the do-not-read list off the page", () => {
    const d = buildPipeline(inputs("shared"));
    expect(d.needs.proposals).toBe(1);
    expect(d.proposals).toEqual([]);
    expect(d.rules.neverIngest).toEqual({ people: 1, titles: 1, channels: 0 });
    expect(JSON.stringify(d)).not.toMatch(/Private idea|Acme renewal|Dana Reyes|Board prep/);
  });

  it("PRIV-7: the shared flow graph names no meeting and no unapproved task", () => {
    const i = inputs("shared");
    const g = (level: "local" | "shared") => buildFlowGraph({ level, now: NOW, hours: 168, agent: "ana@m1", receipts: i.receipts, runlog: null, chain: null, issues: null, linearSyncedAt: null, outbox: [], resolved: {},
      state: { ledger: {}, caps: {}, collectReports: [] }, caps: { personalUsd: 20, teamUsd: 20, resetHour: 0 } });
    const shared = JSON.stringify(g("shared").nodes.map((n) => n.label));
    expect(shared).not.toMatch(/Acme renewal|Private idea|Dropped idea/);
    expect(shared).toMatch(/Meeting 1/);
    expect(shared).toMatch(/Draft SSO one-pager/);
    expect(JSON.stringify(g("local").nodes.map((n) => n.label))).toMatch(/Acme renewal/);
  });

  it("routes: off holds a source everywhere; my to-dos only keeps it out of team runs; collection skips an off connector", async () => {
    const item = { id: "T1", kind: "transcript" as const, ref: "/x", title: "Acme renewal", at: "2026-11-07", participants: ["jane@acme.com", "ana@us.com"], text: "Jane: SSO is slow.", origin: { source: "granola", sourceId: "g1" } };
    const p = (routes: Record<string, "off" | "mine" | "linear">) => ({ team: { internalDomains: ["us.com"] } as any, personal: { neverIngest: { people: [], channels: [], meetingTitles: [] }, sources: { transcriptDirs: [], slackChannel: null, routes } } as any });
    expect(filterItems([item], privacyRules(p({ granola: "mine" }))).decisions[0]).toMatchObject({ decision: "held", rule: "source-off" });
    expect(filterItems([item], privacyRules(p({ granola: "mine" }), true)).decisions[0]!.decision).toBe("kept");
    expect(filterItems([item], privacyRules(p({ granola: "off" }), true)).decisions[0]!.rule).toBe("source-off");
    expect(filterItems([item], privacyRules(p({ fireflies: "off" }))).decisions[0]!.decision).toBe("kept");
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, personal: { sources: { transcriptDirs: [await tmp("t-")], slackChannel: null, routes: { granola: "off" } } } });
    const prompt = await collectPrompt(ctx, { scope: "mine" });
    expect(prompt).toMatch(/in this order: Fireflies, Otter/);
    expect(prompt).toMatch(/Never use granola/);
  });

  it("checks every change, says which ones loosen privacy, and applies personal ones on this Mac", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, personal: { companyDomains: ["us.com"], neverIngest: { people: ["Dana"], channels: [], meetingTitles: [] } } });
    expect(() => checkChange({ kind: "route", source: "granola", value: "everything" }, ctx.team)).toThrow(/off, mine or linear/);
    expect(() => checkChange({ kind: "my-domain", op: "add", value: "not a domain" }, ctx.team)).toThrow(/isn't an email domain/);
    expect(() => checkChange({ kind: "budget", value: 500 }, ctx.team)).toThrow(/0 to 20 dollars/);
    expect(() => checkChange({ kind: "rubric", category: "spec", size: "M", text: "x" }, ctx.team)).toThrow(/3 to 120/);
    expect(checkChange({ kind: "rubric", category: "spec", size: "M", text: "A one | pager\n" }, ctx.team)).toMatchObject({ text: "A one pager" });
    const changes = [
      checkChange({ kind: "route", source: "granola", value: "mine" }, ctx.team),
      checkChange({ kind: "my-domain", op: "remove", value: "us.com" }, ctx.team),
      checkChange({ kind: "never", list: "person", op: "remove", value: "Dana" }, ctx.team),
      checkChange({ kind: "budget", value: 0 }, ctx.team),
      checkChange({ kind: "category", name: "spec", accepted: false }, ctx.team),
    ];
    expect(changes.map((c) => loosens(c, ctx.personal))).toEqual([false, true, true, false, false]);
    expect(await applyPersonal(ctx.personal, changes)).toHaveLength(5);
    expect(ctx.personal).toMatchObject({ sources: { routes: { granola: "mine" } }, companyDomains: [], neverIngest: { people: [] }, budget: { dailyUsd: 0 } });
    expect(ctx.personal.categories).not.toContain("spec");
  });

  it("team changes become one pull request on a new branch, and the PM's own checkout is untouched", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.com"] } });
    const before = await ctx.repo.head();
    const r = await proposeTeamChanges(ctx, [
      checkChange({ kind: "size", size: "M", minutes: 45 }, ctx.team), checkChange({ kind: "review-cap", value: 5 }, ctx.team),
      checkChange({ kind: "team-domain", op: "add", value: "us.example.com" }, ctx.team), checkChange({ kind: "rubric", category: "spec", size: "S", text: "Problem statement and goals" }, ctx.team),
    ]);
    expect(r).toMatchObject({ branch: expect.stringMatching(/^pmx\/settings-\d{14}$/), url: `branch:${r.branch}` });
    expect(await ctx.repo.head()).toBe(before);
    const cfg = JSON.parse(await ctx.repo.ok(["show", `${r.branch}:pmx.config.json`]));
    expect(cfg).toMatchObject({ reviewQueueCap: 5, internalDomains: ["us.com", "us.example.com"], sizes: { M: { minutes: 45 } } });
    expect(await ctx.repo.ok(["show", `${r.branch}:.claude/skills/pmx-size/SKILL.md`])).toMatch(/\| spec \| Problem statement and goals \| One-pager \|/);
    expect(() => setRubricCell("no table", "spec", "S", "x")).toThrow(/no per-category table/);
  });

  it("the local page's writes need the token and JSON; loosening needs a confirmation; the artifact's tool gets the shared level", async () => {
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, personal: { companyDomains: ["us.com"] } });
    await stageProposals([{ at: NOW.toISOString(), receipt: "x", title: "Private idea", description: "d", category: "spec", size: "S", sources: [], from: [] }]);
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, pipeline: pipelineHandlers(ctx) });
    const token = new URL(s.flowUrl).hash.slice(3);
    const base = s.flowUrl.split("#")[0]!.replace(/\/flow$/, "");
    const post = (path: string, body: unknown, headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" }) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
    try {
      const page = await (await fetch(`${base}/flow`)).text();
      expect(page).toMatch(/"mode":"local"/);
      expect(page).not.toMatch(/fonts\.googleapis/);
      expect(page).toMatch(/<script nonce="/);
      const data = await (await fetch(`${base}/api/pipeline?hours=24`, { headers: { authorization: `Bearer ${token}` } })).json();
      expect(data.pipeline.proposals.map((p: any) => p.title)).toEqual(["Private idea"]);
      expect((await post("/api/pipeline/changes", { changes: [] }, { "content-type": "application/json" })).status).toBe(403);
      expect((await post("/api/pipeline/changes", { changes: [] }, { authorization: `Bearer ${token}`, "content-type": "text/plain" })).status).toBe(405);
      const loose = await post("/api/pipeline/changes", { changes: [{ kind: "my-domain", op: "remove", value: "us.com" }] });
      expect(loose.status).toBe(409);
      expect(ctx.personal.companyDomains).toEqual(["us.com"]);
      expect((await post("/api/pipeline/changes", { changes: [{ kind: "my-domain", op: "remove", value: "us.com" }], confirmLoosening: true })).status).toBe(200);
      expect(ctx.personal.companyDomains).toEqual([]);
      expect(await (await post("/api/pipeline/proposals", { action: "drop", ids: ["1"] })).json()).toEqual({ message: 'Dropped "Private idea".' });
    } finally {
      await s.close();
    }
    await stageProposals([{ at: NOW.toISOString(), receipt: "x", title: "Another private idea", description: "d", category: "spec", size: "S", sources: [], from: [] }]);
    const r: any = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pipeline", arguments: { hours: 24 } } }, async () => ctx);
    expect(r.result.structuredContent).toMatchObject({ level: "shared", needs: { proposals: 1 }, proposals: [] });
    expect(JSON.stringify(r.result)).not.toContain("Another private idea");
    expect(await readFile(join(process.env.PMX_HOME!, "staging", "proposals.json"), "utf8")).toContain("Another private idea");
  });

  it("the page never spreads a list of lists into the DOM, which prints [object HTMLDivElement] (Skills tab, 0.16.2)", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    // replaceChildren(...xs.map((x) => [a, b])) stringifies each inner array; flatMap or a flat list is right.
    expect(page.match(/\.\.\.[\w.$()"]+\.map\(\(?[^)]*\)?\s*=>\s*\[/g) ?? []).toEqual([]);
  });
});

describe("0.17.0: the board shows where to act (BOARD-4)", () => {
  beforeEach(freshHome);

  it("a failed privacy check comes first among the problems, and each problem says what fixes it", () => {
    const i = inputs("local");
    i.checks = [{ id: "canaries", status: "violated", label: "Test meetings were kept private", detail: "1 of 3 got past the rules" }, { id: "links", status: "ok", label: "x", detail: "y" }];
    i.health = { problems: [{ text: "PMX doesn't know your company's email domain.", cmd: "pmx domains add <your domain>", fix: "rule:domains" }], facts: [] };
    const d = buildPipeline(i);
    expect(d.health.ok).toBe(false);
    expect(d.health.items[0]).toMatchObject({ text: expect.stringMatching(/^Privacy check failed: a test meeting got past/), fix: "check:canaries" });
    expect(d.health.items[1]).toEqual({ text: "PMX doesn't know your company's email domain.", cmd: "pmx domains add <your domain>", fix: "rule:domains" });
    // Boards published in Claude before 0.17.0 read plain text here.
    expect(d.health.problems).toEqual(d.health.items.map((p) => p.text));
  });

  it("open to-dos are listed only on this Mac's page; the shared page gets their count", () => {
    const todo = { id: "t1", text: "Send Dana the pricing sheet", due: "2026-11-09", source: { title: "Acme renewal", at: "2026-11-07T10:00:00Z" } };
    const local = buildPipeline({ ...inputs("local"), openTodos: [todo], pendingTeam: [{ url: "https://github.com/x/y/pull/3", at: NOW.toISOString(), changes: ["review cap 5"] }] });
    expect(local.needs.todos).toBe(1);
    expect(local.todos).toEqual([{ id: "t1", text: "Send Dana the pricing sheet", due: "2026-11-09", from: "Acme renewal (2026-11-07)", at: "2026-11-07", when: null }]);
    expect(local.pendingTeam).toHaveLength(1);
    const shared = buildPipeline({ ...inputs("shared"), openTodos: [todo] });
    expect(shared.needs.todos).toBe(1);
    expect(shared.todos).toEqual([]);
    expect(JSON.stringify(shared)).not.toContain("pricing sheet");
  });

  it("units say what moved: meetings, tasks and drafts", () => {
    const d = buildPipeline(inputs("local"));
    expect([d.edges["f-h"].unit, d.edges["f-d"].unit, d.edges["d-a"].unit, d.edges["a-x"].unit, d.edges["i-r"].unit, d.edges["v-d"].unit])
      .toEqual(["meetings", "meetings and threads", "tasks", "tasks", "tasks ready now", "drafts"]);
  });

  it("a team pull request that fails is reported next to the personal changes it saved; drafts can be decided from the page", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.com"] }, personal: { companyDomains: [] } });
    const s = await startExplainServer({ team: ctx.team, personal: ctx.personal, pipeline: pipelineHandlers(ctx) });
    const token = new URL(s.flowUrl).hash.slice(3);
    const base = s.flowUrl.split("#")[0]!.replace(/\/flow$/, "");
    const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    try {
      // us.com is already the team's, so the pull request has nothing to change and fails; the personal domain still saves.
      const r = await post("/api/pipeline/changes", { changes: [{ kind: "my-domain", op: "add", value: "me.example.com" }, { kind: "team-domain", op: "add", value: "us.com" }] });
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ applied: [expect.stringMatching(/me\.example\.com/)], pr: null, prError: expect.stringMatching(/already in place/) });
      expect(ctx.personal.companyDomains).toEqual(["me.example.com"]);
      expect((await post("/api/pipeline/review", { identifier: "PMX-1", verdict: "maybe" })).status).toBe(400);
      expect((await post("/api/pipeline/review", { identifier: 1 })).status).toBe(400);
      const expired = await fetch(`${base}/api/pipeline?hours=24`, { headers: { authorization: "Bearer nope" } });
      expect(expired.status).toBe(403);
      expect((await expired.json()).error).toMatch(/link has expired: run pmx flow --web again/);
    } finally {
      await s.close();
    }
  });

  it("the page: every step of the flow and its counts is listed in order, views are reachable by link and keyboard, and the paired artifact acts through the same doors (BOARD-6, FLOW-5)", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    // Status → Flow lists the steps in order, with a count from every connection on the old map.
    expect(page).toMatch(/h\("ol", \{ class: "steps"/);
    for (const id of ["c-f", "s-f", "f-h", "f-t", "f-d", "t-t", "d-a", "a-x", "a-i", "i-b", "i-r", "r-g", "g-v", "v-d"]) expect(page).toContain(`"${id}"`);
    expect(page).toMatch(/addEventListener\("hashchange", onHash\)/);
    expect(page).toMatch(/document\.addEventListener\("keydown", \(e\) =>/);
    // Space and Enter belong to the focused control, never to a row selected behind it.
    expect(page).toMatch(/if \(\(e\.key === "Enter" \|\| e\.key === " "\) && isControl\(t\)\) return;/);
    // One door to read and one to act: the local server with its token, or host:pmx with the page's key.
    expect(page).toMatch(/async function read\(h\) \{\n\s+if \(LOCAL\) return \(await api\(`\/api\/pipeline\?hours=\$\{h\}`\)\)\.pipeline;/);
    expect(page).toMatch(/host\("board", \{ key, hours: h \}, \{ cache: false \}\)/);
    expect(page).toMatch(/async function act\(path, body\) \{\n\s+if \(LOCAL\) return api\(`\/api\/pipeline\/\$\{path\}`, body\);/);
    expect(page).toMatch(/host\("board_act", \{ key, path, body \}, \{ cache: false \}\)/);
    // Connect: PMX asks on the Mac; the key stays in this page's storage; Disconnect only on the artifact.
    expect(page).toMatch(/host\("pair", \{\}\)/);
    expect(page).toMatch(/store\.get\("pmx-key"\)/);
    expect(page).toMatch(/Check your Mac: PMX is asking you to allow this page/);
    expect(page).toMatch(/LOCAL \? null : btn\("Disconnect this page"/);
    expect(page).toMatch(/act\("unpair", \{\}\)/);
    expect(page).not.toMatch(/role: "radio"/);
    // A null child given to replaceChildren prints "null"; the page goes through put() where one can be empty.
    expect(page).not.toMatch(/replaceChildren\(\.\.\.parts\)/);
  });
});

describe("0.18.0: the board maps each category end to end (CAT-1)", () => {
  beforeEach(freshHome);

  const specSkill = {
    name: "pmx-spec", description: "Spec drafting. Writes a one-pager or PRD draft.", kind: "category", category: "spec", usedBy: "", runs: "team", version: "abc", status: "same as built-in", path: "",
    runsInWindow: 1, check: { output: "outputs/spec/{id}.md", sections: ["Problem", "Evidence"], minCitations: 2, stage: "productionize" },
    env: { kind: "document", tools: ["Read", "Write", "Edit", "Glob", "Grep"], template: null, runtime: null, output: { kind: "file", path: "outputs/spec/{id}.md" }, maxTurns: null }, envProblems: [],
  } as PipelineInputs["skills"][number];
  const withCats = (level: "local" | "shared"): PipelineInputs => {
    const i = inputs(level);
    return {
      ...i,
      skills: [specSkill],
      teamCategories: { spec: { skill: "pmx-spec" }, "release-notes": { skill: "pmx-release-notes", externalFacing: true } },
      paused: new Map([["release-notes", "accept rate 20% over 5 reviews"]]),
      autoPause: { windowDays: 30, threshold: 0.3, minVerdicts: 5 },
      issues: [
        ...i.issues.map((x) => ({ ...x, category: "spec" })),
        { identifier: "PMX-9", title: "Pricing page copy", status: "ready", meeting: false, category: "copywriting" },
        { identifier: "PMX-10", title: "Old copy", status: "done", meeting: false, category: "copywriting" },
      ],
    };
  };

  it("each category carries its skill, the draft it must produce, its sizes, its tasks now and its reviews", () => {
    const [spec, notes] = buildPipeline(withCats("local")).categories;
    expect(spec).toEqual({
      id: "spec", name: "Spec drafting", produces: "Writes a one-pager or PRD draft.", stage: "productionize",
      skill: { name: "pmx-spec", version: "abc", copy: "team's copy", missing: false },
      env: { kind: "document", tools: ["Read", "Write", "Edit", "Glob", "Grep"], output: "file" }, envProblems: [],
      output: "outputs/spec/{id}.md", sections: ["Problem", "Evidence"], minCitations: 2, externalFacing: false,
      required: false, custom: false, propose: null,
      sizes: { S: { minutes: 15, usd: 0.5, text: "a" }, M: { minutes: 30, usd: 1.5, text: "b" }, L: { minutes: 60, usd: 4, text: "c" }, XL: { minutes: 120, usd: 8, text: "d" } },
      takenOn: true, paused: null,
      tasks: { proposed: 1, inbox: 1, ready: 1, working: 0, review: 1, done: 0, blocked: 0 },
      runs: { n: 1, drafts: 1 },
      reviews: { accepted: 1, redo: 0, rejected: 0, rate: 1, days: 30, pauseBelow: 0.3, minReviews: 5 },
    });
    // A category whose skill doesn't exist says so, and keeps its pause and customer-facing flag.
    expect(notes).toMatchObject({ id: "release-notes", name: "Release notes", custom: true, stage: null, skill: { name: "pmx-release-notes", missing: true, copy: null }, output: null, externalFacing: true, takenOn: false, paused: "accept rate 20% over 5 reviews", reviews: { rate: null } });
  });

  it("Linear tasks in a category no skill handles are listed, open ones only; the shared page gets the same counts and no titles", () => {
    expect(buildPipeline(withCats("local")).unknownCategories).toEqual([{ id: "copywriting", tasks: 1 }]);
    const shared = buildPipeline(withCats("shared"));
    expect(shared.categories[0]!.tasks).toEqual(buildPipeline(withCats("local")).categories[0]!.tasks);
    expect(JSON.stringify(shared.categories)).not.toMatch(/Pricing page|Private idea|SSO/);
  });

  it("names come from the skill description's first sentence, or the category id in words", () => {
    expect(splitDescription("research-synthesis", "Research synthesis. Turns evidence into a readout.")).toEqual({ name: "Research synthesis", produces: "Turns evidence into a readout." });
    expect(splitDescription("win-loss", "")).toEqual({ name: "Win loss", produces: "" });
    expect(splitDescription("x", "Compares the named competitors on the feature area in a task, using only cited evidence.")).toMatchObject({ name: "X" });
  });

  it("the skill inventory reads each category skill's checklist; core skills have none", async () => {
    const { repo } = await pmxRepo({});
    const skills = await skillInventory(repo, DEFAULT_TEAM.categories);
    expect(skills.find((k) => k.name === "pmx-spec")!.check).toEqual({ output: "outputs/spec/{id}.md", sections: ["Problem", "Evidence", "Validated by", "Proposal", "Success metrics", "Open questions"], minCitations: 2, stage: "productionize" });
    expect(skills.find((k) => k.name === "pmx-synthesize")!.check).toBeUndefined();
  });

  it("the categories have their own view with its own route, and old links to them land there", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    // 0.23.0 (BOARD-6): categories and their skills live under Agents; 0.36.0 (BOARD-10): Agents is a tab of Work.
    // Old #agents, #categories and #skills links land there (#work is the Work area itself now).
    expect(page).toMatch(/<button type="button" class="ni" data-view="work">/);
    expect(page).toMatch(/const AREAS = \{ work: \["tasks", "agents", "digest"\]/);
    expect(page).toMatch(/agents: \["work", "agents"\], digest: \["work", "digest"\]/);
    expect(page).toMatch(/categories: \["work", "agents"\], skills: \["work", "agents"\], connections: \["health", "flow"\]/);
    expect(page).toMatch(/function agentsTab\(\) \{/);
  });

  it("0.19.0: categories are grouped by lifecycle stage, in order, with unstaged ones last (CAT-2)", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    const order = [...page.matchAll(/^\s+\["(identify|build|validate|productionize|operate)", "/gm)].map((m) => m[1]);
    expect(order).toEqual([...STAGES]);
    expect(page).toMatch(/groups\.push\(\{ k: "other", l: "Other kinds of work"/);
  });
});
