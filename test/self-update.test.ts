// FLOW-8: after a PMX update, PMX's page in Claude publishes PMX's newer page over itself, once, for a viewer who can
// write it, in the exact document shape the Artifact tool publishes, with the platform's reset from its live head.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stalePages } from "../src/claude/pages.js";
import { flowCapabilities, flowJson, flowPageHtml, markFlowPublished } from "../src/claude/flow.js";
import { loadPersonalConfig } from "../src/core/config.js";
import { currentVersion } from "../src/core/version.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { buildChecklist } from "../src/setup/checklist.js";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const RESET = "*,*::before,*::after{box-sizing:border-box}html,body{margin:0}";
const URL0 = "https://claude.ai/artifact/PageOnTheMac1";
const OLD = "0.30.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const flow = { flow: { url: URL0, version: OLD, publishedAt: "2026-11-01T10:00:00.000Z" } } as any;

/** The Claude app's `artifact` namespace for the page: records each publish, and answers with `fail` when given. */
function artifactNs(fail?: string) {
  const published: string[] = [];
  return { published, ns: { async publish(html: string) { published.push(html); if (fail) throw Object.assign(new Error(fail), { code: fail }); return { version: "v2" }; } } };
}

describe("PMX's page updates itself (FLOW-8)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("a writer's page publishes PMX's newer page once, in the Artifact tool's shape, with the reset from its own head", async () => {
    const a = artifactNs();
    ui = await openBoard({ app: true, pageVersion: OLD, caps: true, head: `<style>${RESET}</style><style>.later{}</style>`, uses: { artifact: a.ns }, personal: flow });
    await ui.until(() => a.published.length === 1, "the page to publish itself");
    const want = await flowPageHtml(ui.ctx.team);
    expect(a.published[0]).toBe(`<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>${RESET}</style></head><body>${want}</body></html>`);
    // Exactly what `pmx flow --publish-json` gives /pmx-flow to publish.
    const { mkdir, readFile } = await import("node:fs/promises");
    await mkdir(process.env.PMX_CLAUDE_HOME!, { recursive: true });
    const j: any = await flowJson(ui.ctx.team, ui.ctx.personal);
    expect(await readFile(j.html, "utf8")).toBe(want);
    expect(j.capabilities).toEqual(flowCapabilities());
    // PMX records the version the page now runs, keeping its link.
    await ui.until(() => ui!.posts.some((p) => p[0] === "page-published"), "the page to report it");
    expect(ui.posts.find((p) => p[0] === "page-published")![1]).toEqual({ version: currentVersion() });
    for (let i = 0; i < 200 && (await loadPersonalConfig()).flow?.version !== currentVersion(); i++) await sleep(25);
    expect((await loadPersonalConfig()).flow).toMatchObject({ url: URL0, version: currentVersion() });
    // Another read of the board in this page doesn't publish again.
    await ui.go("#health/settings/schedule");
    await ui.click(ui.button("Working hours only", "#task-hours")); // 0.41.0: the button that changes the setting, so the page reads the board again
    await sleep(500);
    expect(a.published).toHaveLength(1);
  }, 30000);

  for (const code of ["not_writer", "not_granted", "conflict"]) it(`a ${code} leaves the page as it is, without trying again`, async () => {
    const a = artifactNs(code);
    ui = await openBoard({ app: true, pageVersion: OLD, caps: true, head: `<style>${RESET}</style>`, uses: { artifact: a.ns }, personal: flow });
    await ui.until(() => a.published.length === 1, "the one try");
    await ui.go("#health/settings/schedule");
    await ui.click(ui.button("Working hours only", "#task-hours")); // 0.41.0: the button that changes the setting, so the page reads the board again
    await sleep(500);
    expect(a.published).toHaveLength(1);
    expect(ui.posts.some((p) => p[0] === "page-published")).toBe(false);
    if (code !== "conflict") expect(ui.win.localStorage.getItem(`pmx-selfpub:${currentVersion()}`)).toBe("no");
    // Nobody is nagged on a page they can't write.
    await ui.go("#needs");
    expect(ui.text("main")).not.toMatch(/This page is from pmx/);
  }, 30000);

  it("a viewer the Claude app says can't edit never publishes", async () => {
    const a = artifactNs();
    ui = await openBoard({ app: true, pageVersion: OLD, caps: true, head: `<style>${RESET}</style>`, uses: { artifact: a.ns, user: { canEdit: async () => false } }, personal: flow });
    await sleep(800);
    expect(a.published).toEqual([]);
    expect(ui.posts.some((p) => p[0] === "page-html")).toBe(false);
  }, 30000);

  it("without the platform's reset in the head, or with other capabilities, it doesn't publish, and says to type /pmx-flow", async () => {
    for (const o of [{ head: "", caps: true }, { head: `<style>${RESET}</style>`, caps: false }]) {
      const a = artifactNs();
      ui = await openBoard({ app: true, pageVersion: OLD, ...o, uses: { artifact: a.ns }, personal: flow, hash: "needs" });
      const fix = await ui.until(() => ui!.all("main [role=listitem]").find((r) => /This page is from pmx/.test(r.textContent ?? "")), "the fix card");
      expect(fix.textContent).toMatch(`This page is from pmx ${OLD}, and PMX on this Mac is ${currentVersion()}. Type /pmx-flow in the Claude app to update it; it keeps its link.`);
      expect(fix.querySelector(".cmdline code")!.textContent).toBe("/pmx-flow");
      expect(a.published).toEqual([]);
      await ui.close(); ui = null;
    }
  }, 40000);

  it("a page as new as PMX does nothing", async () => {
    const a = artifactNs();
    ui = await openBoard({ app: true, caps: true, head: `<style>${RESET}</style>`, uses: { artifact: a.ns }, personal: flow });
    await sleep(600);
    expect(a.published).toEqual([]);
  }, 30000);
});

describe("what PMX says about a page that updates itself (FLOW-8)", () => {
  beforeEach(freshHome);

  it("a page from 0.36.0 needs no /pmx-flow after an update; one from before needs it once more", () => {
    const at = (v: string) => ({ flow: { url: URL0, version: v, publishedAt: "2026-11-01T10:00:00Z" }, board: null });
    expect(stalePages(null, at("0.35.0"), "0.36.1").map((p) => p.skill)).toEqual(["pmx-flow"]);
    expect(stalePages(null, at("0.36.0"), "0.36.1")).toEqual([]);
    const base = {
      now: new Date(), team: { ...DEFAULT_TEAM, tracker: { kind: "none" } }, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null,
      setupSkill: "current" as const, linearCron: null, engine: null, extra: [], state: { lastTick: null, collectReports: [] },
    } as any;
    const page = (o: any) => buildChecklist({ ...base, ...o }).sections.flatMap((s) => s.steps).find((s) => s.id === "claude.page")!;
    const older = page({ version: "0.36.0", personal: { handle: "kp", repoPath: "/r", installedAt: "2026-11-01T00:00:00Z", ...at("0.35.0") }, checks: [{ id: "flow.page", ok: false, level: "warn", detail: "your /pmx-flow page is from pmx 0.35.0: type /pmx-flow in the Claude app to update it to 0.36.0, keeping its link" }] });
    expect(older).toMatchObject({ status: "warn", afterUpdate: true, fix: { kind: "claude", command: "/pmx-flow" } });
    expect(older.page).toBe("In the Claude app, type /pmx-flow once more: from this update on, the page updates itself next time you open it after PMX updates.");
    const newer = page({ version: "0.36.2", personal: { handle: "kp", repoPath: "/r", installedAt: "2026-11-01T00:00:00Z", ...at("0.36.0") }, checks: [] });
    expect(newer).toMatchObject({ status: "done", detail: "published with pmx 0.36.0; it updates itself to pmx 0.36.2 next time you open it" });
  });

  it("records only a version this PMX could have published, and only for a page it has a link for", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, personal: flow });
    expect(await markFlowPublished(ctx.personal, "9.0.0", new Date())).toMatchObject({ recorded: false });
    expect(await markFlowPublished(ctx.personal, "nope", new Date())).toMatchObject({ recorded: false });
    const h = pipelineHandlers(ctx);
    expect(await h.pagePublished!(currentVersion())).toMatchObject({ status: 200 });
    expect(ctx.personal.flow).toMatchObject({ url: URL0, version: currentVersion() });
    const none = pipelineHandlers(await testCtx({ repo }));
    expect(await none.pagePublished!(currentVersion())).toMatchObject({ status: 409 });
    expect(await h.pageHtml!()).toMatchObject({ status: 200, body: { version: currentVersion(), capabilities: flowCapabilities(), html: await flowPageHtml(ctx.team) } });
  });
});
