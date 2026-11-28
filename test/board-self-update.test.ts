// BOARD-1 (0.41.0): the team board updates itself like PMX's workspace page does (FLOW-8). Published once with this
// version, where the Claude app has PMX's server, the board asks PMX on its owner's Mac for the board page /pmx-board
// would publish now and publishes it over itself, in the Artifact tool's document shape. A board from before keeps
// its notification and needs /pmx-board once more. What the board shows doesn't change.
import { mkdir, readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BOARD_TOOLS, boardCapabilities, boardChanged, boardJson, boardPage, boardSelfUpdates, boardStale, boardTemplate, boardTemplateHash, boardWaits, capsHash, fillBoard, formatBoard, setBoardUrl } from "../src/claude/board.js";
import { stalePages } from "../src/claude/pages.js";
import { appSkillSource, BOARD_SKILL } from "../src/claude/skill.js";
import { DEFAULT_TEAM, loadPersonalConfig, savePersonalConfig, type PersonalConfig, type TeamConfig } from "../src/core/config.js";
import { currentVersion } from "../src/core/version.js";
import { handleMcp, installMcp, MCP_TOOLS } from "../src/mcp/server.js";
import { buildChecklist } from "../src/setup/checklist.js";
import { runDoctor } from "../src/commands/doctor.js";
import { exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { freshHome, personal, pmxRepo, testCtx, tmp } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "Northfield PM", tracker: { kind: "linear", teamKey: "NFD", projectId: "proj-nfd-1" } } as TeamConfig;
const URL1 = "https://claude.ai/artifact/BoardOnThisMac01";
const RESET = "*,*::before,*::after{box-sizing:border-box}html,body{margin:0}";
const SELF = capsHash(boardCapabilities(true));
const v = currentVersion();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Board = NonNullable<PersonalConfig["board"]>;
/** A board this Mac published: with today's page or an older one, with or without the capabilities to update itself. */
const board = (o: { page?: "current" | "older"; self?: boolean; version?: string } = {}): Board => ({
  url: URL1, version: o.version ?? "0.40.0", publishedAt: "2026-11-20T10:00:00.000Z",
  template: o.page === "older" ? "0".repeat(16) : boardTemplateHash()!, ...(o.self === false ? {} : { caps: SELF }),
});

describe("what the board is published with (BOARD-1)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
  });

  it("with PMX's server in the Claude app: the page's own republish capability, one PMX tool, and the page's hash", async () => {
    await installMcp("/n/node", "/p/cli.js");
    const me = personal("/repo");
    await savePersonalConfig(me);
    const j: any = await boardJson(team, me);
    expect(j).toMatchObject({ ready: true, selfUpdate: true });
    expect(j.selfUpdateNeeds).toBeUndefined();
    expect(j.capabilities).toEqual({ mcp: { servers: [{ server: "Linear", tools: [...BOARD_TOOLS] }, { server: "host:pmx", tools: ["board_page"] }] }, artifact: {} });
    expect(MCP_TOOLS.map((t) => t.name)).toContain("board_page");
    const cfg = JSON.parse(/id="pmx-config">([\s\S]*?)<\/script>/.exec(await readFile(j.html, "utf8"))![1]!);
    expect(cfg).toEqual({ team: "Northfield PM", teamKey: "NFD", projectId: "proj-nfd-1", version: v, template: boardTemplateHash(), caps: JSON.stringify(j.capabilities) });
    // The link is remembered with those capabilities, so PMX knows this board updates itself.
    await setBoardUrl(me, URL1, new Date("2026-11-27T10:00:00Z"));
    const saved = (await loadPersonalConfig()).board!;
    expect(saved).toEqual({ url: URL1, version: v, publishedAt: "2026-11-27T10:00:00.000Z", template: boardTemplateHash(), caps: SELF });
    expect(boardSelfUpdates(saved)).toBe(true);
    expect(formatBoard(team, { ...me, board: saved }, { ok: true }, true)).toMatch(/It updates itself after a PMX update, the next time you open it in the Claude app on this Mac\./);
  });

  it("without PMX's server: published as before, and /pmx-board is told what would make it update itself", async () => {
    const me = personal("/repo");
    await savePersonalConfig(me);
    const j: any = await boardJson(team, me);
    expect(j).toMatchObject({ ready: true, selfUpdate: false, capabilities: boardCapabilities() });
    expect(j.selfUpdateNeeds).toMatch(/pmx mcp --install.*type \/pmx-board once more/);
    expect(await readFile(j.html, "utf8")).not.toMatch(/"template":|"caps":/);
    await setBoardUrl(me, URL1, new Date());
    expect((await loadPersonalConfig()).board!.caps).toBeUndefined();
    expect(boardSelfUpdates((await loadPersonalConfig()).board)).toBe(false);
  });

  it("/pmx-board tells Claude and the user that the board updates itself from now on", async () => {
    const skill = await readFile(appSkillSource(BOARD_SKILL), "utf8");
    expect(skill).toMatch(/When `selfUpdate` is true, `capabilities` includes `artifact` and PMX's own server \(`host:pmx`, one tool\)/);
    expect(skill).toMatch(/from now on the board updates itself/);
    expect(skill).toMatch(/If `selfUpdate` is false: tell the user the `selfUpdateNeeds` sentence/);
    expect(skill).toMatch(/Never create a second board/);
  });
});

describe("what PMX says about a board after an update (BOARD-1)", () => {
  it("a board published before 0.41.0 keeps its notification; one that updates itself needs no /pmx-board", () => {
    // Before 0.41.0: its page changed, so the PM is still told to type /pmx-board, as before.
    const before = board({ page: "older", self: false });
    expect([boardChanged(before), boardStale(before), boardWaits(before)]).toEqual([true, true, false]);
    expect(stalePages(team, { flow: null, board: before }, v).map((p) => p.skill)).toEqual(["pmx-board"]);
    expect(formatBoard(team, { ...personal("/r"), board: before }, { ok: true }, true)).toMatch(/Type \/pmx-board in the Claude app to update it; it keeps its link\. From then on it updates itself\./);
    // One from before 0.36.0 has no hash: its pmx decides, as before.
    expect(boardStale({ url: URL1, version: "0.30.0", publishedAt: "2026-10-01T00:00:00Z" }, v)).toBe(true);

    // Published with 0.41.0 or later: a changed page is the board's own to take. Nobody is told to type anything.
    const self = board({ page: "older" });
    expect([boardChanged(self), boardStale(self), boardWaits(self)]).toEqual([true, false, true]);
    expect(stalePages(team, { flow: null, board: self }, v)).toEqual([]);
    expect(formatBoard(team, { ...personal("/r"), board: self }, { ok: true }, true)).toMatch(/Open the board in the Claude app on this Mac and it updates itself, for your teammates too/);
    // And when its page didn't change, there's nothing at all.
    const same = board();
    expect([boardChanged(same), boardStale(same), boardWaits(same)]).toEqual([false, false, false]);
    // A later PMX that changes the board's capabilities: a page can't change its own, so /pmx-board is needed again.
    const otherCaps = { ...board({ page: "older" }), caps: "1".repeat(16) };
    expect([boardStale(otherCaps), boardWaits(otherCaps)]).toEqual([true, false]);
  });

  it("the checklist asks the owner only to open the board, and says so in the line about what's left", () => {
    const cl = buildChecklist({
      now: new Date("2026-11-27T10:30:00Z"), version: v, personal: { ...personal("/r"), board: board({ page: "older" }) }, team, claude: true, hasRemote: true, memoryFilled: true,
      checks: [{ id: "claude.board", ok: false, level: "warn", detail: `! team board ${URL1}: its page changed in a PMX update, and it updates itself the next time you open it in the Claude app on this Mac` }],
      state: { ...(EMPTY as any), upgrade: { lastVersion: v, from: "0.40.3", at: "2026-11-27T10:00:00.000Z", applied: Object.fromEntries(["app-skills", "mcp-entry", "background-job", "evidence-names-3", "follow-ups-requeue"].map((id) => [`${id}@${v}`, { at: "2026-11-27T10:00:00.000Z", did: "nothing to do" }]).concat([["task-hours-always", { at: "2026-11-27T10:00:00.000Z", did: "nothing to do" }]])) } },
      proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: null, extra: [],
    });
    const step = cl.sections.find((s) => s.id === "claude")!.steps.find((s) => s.id === "claude.board")!;
    expect(step).toMatchObject({ status: "warn", required: false, who: "you", how: "app", afterUpdate: true, do: "Open your team board in the Claude app on this Mac: it updates itself, for your teammates too", fix: { kind: "person", link: URL1 } });
    expect(step.do).not.toMatch(/\/pmx-board/);
    expect(cl.upgrade!.left).toMatch(/^Still to do by hand: .*Open your team board in the Claude app on this Mac: it updates itself, for your teammates too/);
  });
});

describe("pmx doctor on a board after an update (BOARD-1)", () => {
  beforeEach(async () => {
    await freshHome();
    process.env.PMX_CLAUDE_HOME = await tmp("claude-home-");
    await mkdir(process.env.PMX_CLAUDE_HOME, { recursive: true });
  });
  const boardCheck = async (b: Board, teamOver: Partial<TeamConfig> = {}) => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team: { ...team, ...teamOver }, personal: { board: b } });
    return (await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec })).find((c) => c.id === "claude.board")!;
  };

  it("an older board still says to type /pmx-board; one that updates itself says only to open it; an unchanged one says nothing", async () => {
    expect(await boardCheck(board({ page: "older", self: false }))).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/published with an older pmx, and its page changed since; .*\/pmx-board in the Claude app to update it$/) });
    const waits = await boardCheck(board({ page: "older" }));
    expect(waits).toMatchObject({ ok: false, level: "warn", detail: `team board ${URL1}: its page changed in a PMX update, and it updates itself the next time you open it in the Claude app on this Mac` });
    expect(waits.detail).not.toMatch(/\/pmx-board/);
    expect(await boardCheck(board())).toMatchObject({ ok: true, detail: `team board ${URL1}` });
    // The Mac's own board is still its own when the team shares it in its settings; a teammate's board never is.
    expect(await boardCheck(board({ page: "older", self: false }), { board: { url: URL1 } })).toMatchObject({ ok: false, detail: expect.stringMatching(/\/pmx-board/) });
    expect(await boardCheck(board({ page: "older" }), { board: { url: URL1 } })).toMatchObject({ ok: false, detail: expect.stringMatching(/updates itself the next time you open it/) });
    expect(await boardCheck(board({ page: "older", self: false }), { board: { url: "https://claude.ai/artifact/SomeoneElses1" } })).toMatchObject({ ok: true });
  }, 60000);
});

describe("PMX's answer to the board's own page (board_page)", () => {
  beforeEach(freshHome);

  async function mac(b: Board | null, teamOver: Partial<TeamConfig> = {}) {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team: { ...team, ...teamOver }, personal: b ? { board: b } : {} });
    await savePersonalConfig(ctx.personal);
    const ask = async (args: object) => ((await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "board_page", arguments: args } }, async () => ({ ...ctx, personal: await loadPersonalConfig() }))) as any).result.structuredContent;
    return { ctx, ask };
  }

  it("gives this Mac's own board PMX's page as /pmx-board would publish it, and only that board", async () => {
    const { ask } = await mac(board({ page: "older" }));
    const page = await ask({ project: "proj-nfd-1", have: "0".repeat(16) });
    expect(page).toMatchObject({ yours: true, current: false, version: v, template: boardTemplateHash(), capabilities: boardCapabilities(true) });
    expect(page.html).toBe(fillBoard(await readFile(boardTemplate(), "utf8"), team, { selfUpdate: true }));
    // Nothing is recorded until the board runs that page.
    expect((await loadPersonalConfig()).board!.template).toBe("0".repeat(16));

    // Another project's board, a call with no project, a Mac that published no board, and a board a teammate shares
    // in the team's settings: each is told only that it isn't this Mac's.
    expect(await ask({ project: "proj-other", have: "x" })).toEqual({ yours: false });
    expect(await ask({ have: "x" })).toEqual({ yours: false });
    expect(await (await mac(null)).ask({ project: "proj-nfd-1" })).toEqual({ yours: false });
    expect(await (await mac(board({ page: "older" }), { board: { url: "https://claude.ai/artifact/SomeoneElses1" } })).ask({ project: "proj-nfd-1" })).toEqual({ yours: false });
  });

  it("records the page the board now runs, keeping its link, and writes nothing else", async () => {
    const { ask } = await mac(board({ page: "older" }));
    const before = await loadPersonalConfig();
    expect(await ask({ project: "proj-nfd-1", have: boardTemplateHash() })).toEqual({ yours: true, current: true, version: v, template: boardTemplateHash() });
    const after = await loadPersonalConfig();
    expect(after.board).toMatchObject({ url: URL1, version: v, template: boardTemplateHash(), caps: SELF });
    expect({ ...after, board: null }).toEqual({ ...before, board: null });
    expect(boardWaits(after.board)).toBe(false);
    // Asked again, it has nothing to record.
    const stamp = after.board!.publishedAt;
    await ask({ project: "proj-nfd-1", have: boardTemplateHash() });
    expect((await loadPersonalConfig()).board!.publishedAt).toBe(stamp);
  });
});

describe("the board page publishes PMX's newer page over itself (BOARD-1)", () => {
  let dom: JSDOM | null = null;
  beforeEach(freshHome);
  afterEach(() => { dom?.window.close(); dom = null; });

  /**
   * The board as the Claude app shows it: the page /pmx-board published with an older pmx (`from`), inside the Artifact
   * tool's skeleton. Linear answers nothing here; PMX answers through its real MCP handler.
   */
  async function open(o: { from?: string | null; canEdit?: boolean | null; fail?: string; caps?: string; head?: string; self?: boolean; pmx?: (args: any) => any } = {}) {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team, personal: { board: board({ page: "older" }) } });
    await savePersonalConfig(ctx.personal);
    const template = await readFile(boardTemplate(), "utf8");
    const cfg = { team: team.team, teamKey: "NFD", projectId: "proj-nfd-1", version: o.from === null ? v : o.from ?? "0.40.0", ...(o.self === false ? {} : { template: "0".repeat(16), caps: o.caps ?? JSON.stringify(boardCapabilities(true)) }) };
    const page = template.replace(/(<script type="application\/json" id="pmx-config">)[\s\S]*?(<\/script>)/, (_, a: string, b: string) => `${a}${JSON.stringify(cfg)}${b}`);
    const published: string[] = [], pmxCalls: any[] = [], watched: string[] = [];
    dom = new JSDOM(`<!doctype html><html lang=en><head><meta charset=utf-8>${o.head ?? `<style>${RESET}</style>`}</head><body>${page}</body></html>`, {
      url: "http://artifact.test/", runScripts: "dangerously", pretendToBeVisual: true,
      beforeParse(w: any) {
        w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
        w.claude = {
          use: async (name: string) => {
            if (name === "user") return o.canEdit === null ? null : { canEdit: async () => o.canEdit ?? true };
            if (name === "artifact") return { async publish(html: string) { published.push(html); if (o.fail) throw Object.assign(new Error(o.fail), { code: o.fail }); return { version: "v2" }; } };
            if (name !== "mcp") return null;
            return {
              watchTool(server: string, tool: string) { watched.push(`${server}:${tool}`); return () => {}; },
              async invalidate() {},
              async callTool(server: string, tool: string, args: any) {
                if (server !== "host:pmx") throw new Error(`unexpected ${server}`);
                pmxCalls.push([tool, args]);
                if (o.pmx) return { payload: o.pmx(args) };
                const out: any = await handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, async () => ({ ...ctx, personal: await loadPersonalConfig() }));
                return { payload: out.result.structuredContent };
              },
            };
          },
        };
      },
    });
    const settle = async (done: () => boolean) => { for (let i = 0; i < 120 && !done(); i++) await sleep(25); await sleep(150); };
    return { ctx, published, pmxCalls, watched, settle, text: () => { const body = dom!.window.document.body.cloneNode(true) as HTMLElement; body.querySelectorAll("script, style").forEach((x) => x.remove()); return body.textContent ?? ""; }, template };
  }

  it("the owner's board publishes PMX's page once, in the Artifact tool's shape, with the reset from its own head", async () => {
    const b = await open({ head: `<style>${RESET}</style><style>.later{}</style>` });
    await b.settle(() => b.published.length > 0);
    expect(b.pmxCalls).toEqual([["board_page", { project: "proj-nfd-1", have: "0".repeat(16) }]]);
    const want = fillBoard(b.template, team, { selfUpdate: true });
    expect(b.published).toEqual([`<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${RESET}</style></head><body>${want}</body></html>`]);
    // The board itself is as it always was: its lanes, read from Linear, and not a word about the update.
    expect(b.watched.sort()).toEqual(["Linear:list_issue_labels", "Linear:list_issues"]);
    expect(b.text()).toMatch(/Backlog[\s\S]*Ready[\s\S]*In flight[\s\S]*Review[\s\S]*Done/);
    expect(b.text()).not.toMatch(/updat|PMX 0\.|publish/i);
  });

  it("a teammate, or anyone the Claude app doesn't say can edit, never asks PMX and never publishes", async () => {
    for (const canEdit of [false, null]) {
      const b = await open({ canEdit });
      await b.settle(() => false);
      expect(b.pmxCalls).toEqual([]);
      expect(b.published).toEqual([]);
      expect(b.watched).toHaveLength(2);
      dom?.window.close(); dom = null;
    }
  });

  it("a board published without these capabilities never asks; other capabilities, an older PMX or no reset never publish", async () => {
    const plain = await open({ self: false });
    await plain.settle(() => false);
    expect([plain.pmxCalls, plain.published]).toEqual([[], []]);
    dom?.window.close(); dom = null;
    // The page was published with other capabilities than today's: a page can't change its own, so /pmx-board does.
    const caps = await open({ caps: JSON.stringify(boardCapabilities()) });
    await caps.settle(() => caps.pmxCalls.length > 0);
    expect(caps.pmxCalls).toHaveLength(1);
    expect(caps.published).toEqual([]);
    dom?.window.close(); dom = null;
    // PMX on this Mac is older than the page (published from another Mac): its page never replaces a newer one.
    const newer = await open({ from: "999.0.0" });
    await newer.settle(() => newer.pmxCalls.length > 0);
    expect(newer.published).toEqual([]);
    dom?.window.close(); dom = null;
    const noReset = await open({ head: "" });
    await noReset.settle(() => noReset.pmxCalls.length > 0);
    expect(noReset.published).toEqual([]);
    dom?.window.close(); dom = null;
    // PMX says the page is current, or that the board isn't this Mac's: nothing to publish.
    for (const answer of [{ yours: true, current: true, version: v, template: "0".repeat(16) }, { yours: false }]) {
      const b = await open({ pmx: () => answer });
      await b.settle(() => b.pmxCalls.length > 0);
      expect(b.published).toEqual([]);
      dom?.window.close(); dom = null;
    }
  }, 30000);

  for (const code of ["not_writer", "conflict"]) it(`a ${code} leaves the board as it is, with one try`, async () => {
    const b = await open({ fail: code });
    await b.settle(() => b.published.length > 0);
    await sleep(300);
    expect(b.published).toHaveLength(1);
    expect(b.text()).not.toMatch(/updat|couldn't|error/i);
  });

  it("the page calls only the Linear tools and PMX's one tool it's published with", async () => {
    const page = await readFile(boardTemplate(), "utf8");
    expect([...page.matchAll(/callTool\(PMX, "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["board_page"]);
    expect(page).toMatch(/const PMX = "host:pmx";/);
    expect([...page.matchAll(/claude\.use\("([a-z]+)"\)/g)].map((m) => m[1]).sort()).toEqual(["artifact", "mcp", "permissions", "user"]);
  });
});

const EMPTY = { lastDigestWeek: null, lastSynthAt: null, ledger: {}, eeTrialStartedAt: null, lastEventSyncAt: null, lastPipelineSyncAt: null, lastBrainAt: null, lastCollectAt: null, lastRollupAt: null, cloudVersions: null, autoUpdate: null, lastTick: null, taskRuns: {}, caps: {}, collectReports: [], whatsNew: null };
