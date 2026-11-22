// BOARD-11 and SETUP-3 (usability slice 4): PMX Engine inside PMX's page, for the head of product, and one checklist
// for both tools. PMX reads `pmxe status --json` and `pmxe checklist --json` through its bridge, keeps only their
// labels, and shows them live on this Mac's page and the paired page in Claude. The never list: none of it reaches what
// Claude reads through `pmx mcp`, the page PMX publishes in Claude, or anything PMX stores.
import { chmod, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exec } from "../src/core/exec.js";
import { engineChecklist, engineSource, engineView } from "../src/engine/bridge.js";
import { needsLine, needsYou } from "../src/flow/needs.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { engineWords, everyMinute, STUDIO_PLACES } from "../src/flow/strategy.js";
import { handleMcp } from "../src/mcp/server.js";
import { buildChecklist, recordChecklist } from "../src/setup/checklist.js";
import { runStatus } from "../src/commands/status.js";
import { checklistOutput } from "../src/commands/index.js";
import { freshHome, pmxRepo, testCtx, tmp } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600000).toISOString();

/** `pmxe status --json` as PMX Engine 0.12.0 prints it, plus what a misbehaving Engine might add. */
const STATUS = () => ({
  format: 1, tool: "pmxe", version: "0.12.0", at: new Date().toISOString(), workspace: { name: "Acme Product" },
  waiting: [
    { id: "approve:vision@company.e1:eng", kind: "approve", label: "Approve Vision, edition 1 for Engineering.", who: "you", where: "studio", place: "release", since: hoursAgo(100) },
    { id: "send:vision@company.e1:mkt", kind: "send", label: "Send Vision, edition 1 to Marketing and PMM by pasting the command in the Claude app.", who: "you", where: "claude app", place: "release", since: hoursAgo(2) },
    { id: "release:tam@healthcare", kind: "release", label: "Market size, Healthcare is written and has not been released yet.", who: "you", where: "studio", place: "release/ready" },
    { id: "fix:pricing@company", kind: "fix", label: "Pricing has 2 problems to fix before it can be released.", who: "you", where: "studio", place: "../../etc/passwd" },
    { id: "claude:pricing@company.e2:elt", kind: "sending", label: "Pricing, edition 2: Claude is sending it to ELT.", who: "claude", where: "claude app", place: "release", since: hoursAgo(1) },
    { id: "signoff:vision@company.e1:morgan", kind: "signoff", label: "Vision, edition 1: Engineering waits on Morgan Reyes's sign-off.", who: "a colleague", where: "elsewhere", place: "release", since: hoursAgo(30) },
    { id: "odd", kind: "approve", label: "Approve everything for everyone.", who: "everyone", where: "studio", place: "release" },
  ],
  releases: [
    { id: "vision@company.e1", kind: "release", label: "Vision, edition 1", edition: 1, reached: ["ELT"], waiting: ["Engineering", "Marketing and PMM"], next: { group: "Engineering", who: "you", step: "Approve Vision, edition 1 for Engineering." } },
    { id: "pricing@company.e2", kind: "release", label: "Pricing, edition 2", edition: 2, reached: [], waiting: ["ELT"], next: { group: "ELT", who: "claude", step: "Pricing, edition 2: Claude is sending it to ELT." } },
  ],
  pages: { count: 13, ready: 12 },
  counts: { you: 4, others: 2, releases: 2, documents: 8, released: 2, proposals: 0 },
  sections: ["Strategy text marker: a section's words, which Engine never sends and PMX never keeps."],
});

/** `pmxe checklist --json` (format 1), with the `do` commands PMX leaves out. */
const CHECKLIST = {
  format: 1, tool: "pmxe", version: "0.12.0", at: new Date().toISOString(),
  where: "Workspace set up and 12 of 13 pages published; 1 edition waits for Engineering approval.",
  next: { id: "pages.published", title: "Every page is published", status: "todo", required: true },
  sections: [
    { id: "mac", title: "This Mac", steps: [
      { id: "mac.node", title: "Node 22.12 or later", status: "done", detail: "Node 22.15.0.", required: true },
      { id: "mac.latest", title: "This Mac runs the latest PMX Engine", status: "skip", detail: "Not checked: the checklist never asks npm by itself. pmxe checklist --check-update asks it.", required: false },
    ] },
    { id: "workspace", title: "Workspace", steps: [
      { id: "workspace.lint", title: "The content passes lint", status: "warn", detail: "2 lint errors: those parts reach nobody, and their files cannot be released.", do: "pmxe lint shows each one; fix it in the studio.", who: "you", how: "studio", required: false },
    ] },
    { id: "pages", title: "Pages", steps: [
      { id: "pages.published", title: "Every page is published", status: "todo", detail: "12 of 13 pages published.", do: "/pmxe-hubs, typed in the Claude app in the head of product's own chat on the workspace folder", who: "you", how: "claude", required: true },
    ] },
    { id: "claude", title: "Claude app", steps: [
      { id: "claude.skill.pmxe-setup", title: "/pmxe-setup is in the Claude app", status: "warn", detail: "Not installed.", do: "pmxe skills --install (ask first: it writes under ~/.claude/skills)", who: "you", how: "terminal", required: false },
    ] },
  ],
  counts: { done: 1, todo: 1, warn: 2, skip: 1 },
  upgrade: null,
};

/** Labels from Engine that must never reach what Claude reads, the page PMX publishes in Claude, or PMX's files. */
const MARKERS = ["Approve Vision, edition 1 for Engineering", "Morgan Reyes", "Claude is sending it to ELT", "Market size, Healthcare", "12 of 13 pages", "The content passes lint", "Acme Product", "Strategy text marker"];

/** A stand-in for `pmxe`: canned JSON, each call logged, and `studio` logged with its arguments. */
async function fakePmxe(o: { status?: unknown; checklist?: unknown; statusText?: string; statusExit?: number } = {}): Promise<{ cmd: string; calls: () => Promise<string[]>; studio: () => Promise<string> }> {
  const dir = await tmp("fake-pmxe-s4-");
  await writeFile(join(dir, "status.out"), o.statusText ?? JSON.stringify(o.status ?? STATUS()));
  await writeFile(join(dir, "checklist.out"), JSON.stringify(o.checklist ?? CHECKLIST));
  const cmd = join(dir, "pmxe");
  await writeFile(cmd, `#!/bin/sh
echo "$@" >> "${dir}/calls.log"
case "$1" in
  --version) echo 0.12.0 ;;
  status) cat "${dir}/status.out"; exit ${o.statusExit ?? 0} ;;
  checklist) cat "${dir}/checklist.out" ;;
  studio) echo "$@" >> "${dir}/studio.log" ;;
esac
`);
  await chmod(cmd, 0o755);
  const lines = async (f: string) => (await readFile(join(dir, f), "utf8").catch(() => "")).split("\n").filter(Boolean);
  return { cmd, calls: () => lines("calls.log"), studio: async () => (await readFile(join(dir, "studio.log"), "utf8").catch(() => "")) };
}

const waitFor = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100 && !(await fn()); i++) await new Promise((r) => setTimeout(r, 20)); };

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory()) out.push(...(await filesUnder(join(dir, e.name))));
    else out.push(join(dir, e.name));
  }
  return out;
}

describe("PMX Engine's status, through the bridge (BOARD-11)", () => {
  beforeEach(freshHome);
  afterEach(() => { process.env.PMX_PMXE = "none"; });

  it("keeps only Engine's labels, each checked, and the studio's own places", async () => {
    process.env.PMX_PMXE = (await fakePmxe()).cmd;
    const v = (await engineView(exec))!;
    expect(v).toMatchObject({ state: "ok", version: "0.12.0", workspace: "Acme Product", pages: { count: 13, ready: 12 } });
    // A move whose `who` isn't Engine's is dropped; a place that isn't the studio's is none.
    expect(v.waiting.map((w) => [w.id, w.who, w.where, w.place])).toEqual([
      ["approve:vision@company.e1:eng", "you", "studio", "release"], ["send:vision@company.e1:mkt", "you", "claude app", "release"],
      ["release:tam@healthcare", "you", "studio", "release/ready"], ["fix:pricing@company", "you", "studio", null],
      ["claude:pricing@company.e2:elt", "claude", "claude app", "release"], ["signoff:vision@company.e1:morgan", "a colleague", "elsewhere", "release"],
    ]);
    // The slash command for a group to send, with its release and group; none for Claude's own move.
    expect(v.waiting.map((w) => w.command)).toEqual([null, "/pmxe-release vision@company.e1 mkt", null, null, null, null]);
    expect(v.waiting[2]!.since).toBeNull();
    expect(v.releases).toEqual([
      { id: "vision@company.e1", label: "Vision, edition 1", reached: ["ELT"], waiting: ["Engineering", "Marketing and PMM"], next: { group: "Engineering", who: "you", step: "Approve Vision, edition 1 for Engineering." } },
      { id: "pricing@company.e2", label: "Pricing, edition 2", reached: [], waiting: ["ELT"], next: { group: "ELT", who: "claude", step: "Pricing, edition 2: Claude is sending it to ELT." } },
    ]);
    // Engine's checklist without its commands: a studio step opens there, a Claude step is its slash command.
    const steps = v.checklist!.sections.flatMap((s) => s.steps);
    expect(steps.map((s) => [s.id, s.status, s.place, s.command])).toEqual([
      ["mac.node", "done", null, null], ["mac.latest", "skip", null, null], ["workspace.lint", "warn", "home", null],
      ["pages.published", "todo", null, "/pmxe-hubs"], ["claude.skill.pmxe-setup", "warn", "home", null],
    ]);
    expect(steps.find((s) => s.id === "mac.latest")!.detail).toBe("Not checked: the checklist never asks npm by itself.");
    const all = JSON.stringify(v);
    expect(all).not.toContain("Strategy text marker");
    expect(all).not.toMatch(/"do"|pmxe lint|--install|\.\.\/\.\.\/etc|Approve everything/);
    expect(engineWords("Merging that pull request is the code owners' step; pmxe cannot see it.")).toBe("Merging that pull request is the code owners' step; PMX Engine cannot see it.");
    expect(engineWords("N approved groups to carry with /pmxe-release")).toBe("N approved groups to carry with /pmxe-release");
  });

  it("says an older Engine can't show here, and gives its checklist's next step; nothing at all without Engine", async () => {
    // Before 0.12.0, `pmxe status` printed text only.
    process.env.PMX_PMXE = (await fakePmxe({ statusText: "Content\n  vision@company   e1\n" })).cmd;
    expect(await engineView(exec)).toMatchObject({ state: "old", version: "0.12.0", workspace: null, releases: [],
      waiting: [{ id: "setup:pages.published", label: "Every page is published", who: "you", place: "home", command: "/pmxe-setup" }] });
    process.env.PMX_PMXE = (await fakePmxe({ statusText: JSON.stringify({ format: 1, tool: "pmxe", version: "0.12.0", error: "The workspace does not load." }), statusExit: 2 })).cmd;
    expect(await engineView(exec)).toMatchObject({ state: "error", releases: [] });
    process.env.PMX_PMXE = (await fakePmxe({ status: { ...STATUS(), workspace: null, waiting: [], releases: [] } })).cmd;
    expect(await engineView(exec)).toMatchObject({ state: "ok", workspace: null, waiting: [] });
    const broken = join(await tmp("broken-pmxe-"), "pmxe");
    await writeFile(broken, "#!/bin/sh\necho 'env: node: No such file or directory' >&2\nexit 127\n");
    await chmod(broken, 0o755);
    process.env.PMX_PMXE = broken;
    expect(await engineView(exec)).toMatchObject({ state: "problem", problem: expect.stringMatching(/but didn't start: env: node: No such file or directory$/) });
    process.env.PMX_PMXE = "none";
    expect(await engineView(exec)).toBeNull();
    const none = engineSource(exec);
    expect(await none.view()).toBeNull();
    expect(await none.open("release")).toMatchObject({ status: 404 });
  });

  it("reads at most once a minute, and opens the studio only at its own places", async () => {
    const fake = await fakePmxe();
    process.env.PMX_PMXE = fake.cmd;
    const src = engineSource(exec);
    const [a, b] = await Promise.all([src.view(), src.view()]);
    expect(a).toBe(b);
    await src.view();
    expect((await fake.calls()).filter((c) => c.startsWith("status"))).toEqual(["status --json"]);
    let t = 0;
    let reads = 0;
    const read = everyMinute(async () => ++reads, 60000, () => t);
    await read(); t = 59000; await read();
    expect(reads).toBe(1);
    t = 61000; await read();
    expect(reads).toBe(2);

    expect(STUDIO_PLACES).toEqual(["home", "content", "roadmap", "product", "claude", "claude/earlier", "release", "release/ready", "release/earlier", "pages", "settings", "settings/team", "settings/verticals", "settings/groups", "settings/claude", "help"]);
    for (const bad of ["../release", "release; rm -rf ~", "--demo", "", "Release"]) expect(await src.open(bad), bad).toMatchObject({ status: 400 });
    expect(await src.open("release/ready")).toMatchObject({ status: 200, body: { message: "Opening PMX Engine's studio in your browser on this Mac." } });
    await waitFor(async () => !!(await fake.studio()));
    expect(await fake.studio()).toBe("studio --at release/ready\n");
  });

  it("counts Engine's moves that are yours in Needs you, and in pmx status", async () => {
    process.env.PMX_PMXE = (await fakePmxe()).cmd;
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const engine = engineSource(exec, { checklist: false });
    const d = await loadPipeline(ctx, { level: "local", keychain: ctx.keychain, engine });
    expect(d.needsYou).toMatchObject({ engine: 4 });
    expect(d.needsYou!.total).toBe(needsYou({ ...d, engine: undefined }).total + 4);
    expect(needsLine(d.needsYou!)).toMatch(/4 steps in PMX Engine$/);
    expect((await runStatus(ctx, [], { engine })).split("\n")[0]).toMatch(/^Needs you: .*4 steps in PMX Engine$/);
    expect(await runStatus(ctx)).not.toMatch(/PMX Engine/);
    // The PM who hid it (pmx open --hide-studio) sees nothing of Engine.
    const hidden = await testCtx({ repo, personal: { studio: "hidden" } as any });
    expect((await loadPipeline(hidden, { level: "local", keychain: ctx.keychain, engine })).engine).toBeUndefined();
    expect(await pipelineHandlers(hidden, { engine }).engineOpen!("release")).toMatchObject({ status: 404 });
  });
});

describe("the never list: Engine's status only where the head of product's own page reads it", () => {
  beforeEach(freshHome);
  afterEach(() => { process.env.PMX_PMXE = "none"; });

  it("isn't in pipeline, checklist, flow_graph or the server's instructions, nor in the page PMX publishes, nor in ~/.pmx", async () => {
    process.env.PMX_PMXE = (await fakePmxe()).cmd;
    const home = process.env.PMX_HOME!;
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    // The checklist as the background job records it, with Engine there (SETUP-3: Engine's steps stay out of it).
    const summary = await engineChecklist(exec);
    const cl = await recordChecklist(buildChecklist({ now: new Date(), version: "0.36.0", personal: ctx.personal, team: ctx.team, checks: [], state: { collectReports: [] } as any, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: summary, extra: [] }));
    const step = cl.sections.flatMap((s) => s.steps).find((s) => s.id === "engine.installed")!;
    expect(step).toMatchObject({ status: "done", detail: "PMX Engine 0.12.0 is on this Mac; its own steps follow PMX's" });
    expect(cl.sections.map((s) => s.title)).toContain("PMX and PMX Engine");
    expect(cl.next?.id ?? "").not.toMatch(/^engine\./);

    // As `pmx mcp` wires it: the paired page's board gets Engine; nothing a chat can call does.
    const engine = engineSource(exec);
    let id = 0;
    const rpc = async (method: string, params: unknown = {}) => (await handleMcp({ jsonrpc: "2.0", id: ++id, method, params }, async () => ctx, { engine, confirm: async () => true })) as any;
    const tool = async (name: string, args: unknown = {}) => (await rpc("tools/call", { name, arguments: args })).result;
    const chat = [
      JSON.stringify(await rpc("initialize")), JSON.stringify(await rpc("tools/list")),
      JSON.stringify(await tool("pipeline", { hours: 168 })), JSON.stringify(await tool("checklist")),
      JSON.stringify(await tool("flow_graph", { hours: 24 })), JSON.stringify(await tool("flow_graph", { hours: 24, scope: "team" })),
      JSON.stringify(await tool("board", { key: "not-the-key" })), JSON.stringify(await tool("board_act", { key: "not-the-key", path: "engine-open", body: { place: "release" } })),
    ];
    for (const out of chat) for (const m of MARKERS) expect(out, m).not.toContain(m);
    expect((await tool("pipeline", { hours: 168 })).structuredContent.engine).toBeUndefined();
    expect((await tool("pipeline", { hours: 168 })).structuredContent.needsYou.engine).toBe(0);

    // The paired page, with its key: Engine's labels, live.
    const key = (await tool("pair")).structuredContent.key;
    const board = (await tool("board", { key, hours: 168 })).structuredContent;
    expect(board.engine.waiting.map((w: any) => w.label)).toContain("Approve Vision, edition 1 for Engineering.");
    expect(board.needsYou.engine).toBe(4);
    // The page the paired page publishes over itself after an update (FLOW-8) holds none of it.
    const html = (await tool("board_act", { key, path: "page-html", body: {} })).structuredContent.body.html;
    expect(html.length).toBeGreaterThan(10000);
    for (const m of MARKERS) expect(html, m).not.toContain(m);
    // Nothing PMX keeps on this Mac holds it either: not the checklist the `checklist` tool reads, not any cache.
    for (const f of await filesUnder(home)) {
      const text = await readFile(f, "utf8").catch(() => "");
      for (const m of MARKERS) expect(text, `${f}: ${m}`).not.toContain(m);
    }
  });
});

describe("one checklist for both tools (SETUP-3)", () => {
  beforeEach(freshHome);
  afterEach(() => { process.env.PMX_PMXE = "none"; });

  it("pmx checklist shows Engine's sections after PMX's, and --json adds them under engine", async () => {
    process.env.PMX_PMXE = (await fakePmxe()).cmd;
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const summary = await engineChecklist(exec);
    const cl = buildChecklist({ now: new Date(), version: "0.36.0", personal: ctx.personal, team: ctx.team, checks: [], state: { collectReports: [] } as any, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: summary, extra: [] });
    const text = checklistOutput(cl, summary, {});
    const [mine, theirs] = text.split("\n\nPMX Engine 0.12.0 on this Mac");
    expect(mine).toMatch(/^PMX 0\.36\.0 on this Mac/);
    expect(mine).not.toMatch(/lint|Every page is published/);
    expect(theirs).toMatch(/Where it stands: Workspace set up and 12 of 13 pages published; 1 edition waits for Engineering approval\./);
    expect(theirs).toMatch(/Workspace\n {2}! The content passes lint: 2 lint errors[^\n]*\n {6}→ Open in the studio \(pmx open studio\)/);
    expect(theirs).toMatch(/Pages\n {2}✘ Every page is published: 12 of 13 pages published\.\n {6}→ In the Claude app, type \/pmxe-hubs\n/);
    expect(theirs).toMatch(/\nNext in PMX Engine: Every page is published\. Each step's exact command: pmxe checklist$/);
    expect(theirs).not.toMatch(/pmxe lint|--install|This Mac runs the latest/);
    expect(checklistOutput(cl, summary, { all: true })).toMatch(/– This Mac runs the latest PMX Engine/);

    const j = JSON.parse(checklistOutput(cl, summary, { json: true }));
    // Format 1, fields only gain: PMX's own checklist as it was, and Engine's under `engine`, without commands.
    expect(j).toMatchObject({ format: 1, tool: "pmx", counts: cl.counts, next: cl.next });
    expect(j.engine).toMatchObject({ format: 1, tool: "pmxe", version: "0.12.0", next: { id: "pages.published" } });
    expect(JSON.stringify(j.engine)).not.toMatch(/"do"|pmxe lint/);
    // Without Engine, as on every PM's Mac: PMX's checklist only.
    expect(JSON.parse(checklistOutput(cl, null, { json: true })).engine).toBeUndefined();
    expect(checklistOutput(cl, null, {})).not.toMatch(/PMX Engine 0\.12\.0 on this Mac/);
  });
});

describe("the Strategy area and Needs you on the page (BOARD-11)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; process.env.PMX_PMXE = "none"; });

  for (const app of [false, true]) it(`shows where Engine stands, and opens the studio at the place${app ? " (Claude app)" : ""}`, async () => {
    const fake = await fakePmxe();
    process.env.PMX_PMXE = fake.cmd;
    const engine = engineSource(exec);
    ui = await openBoard({ app, hash: "needs", engine });
    await ui.until(() => !ui!.$("#nav-strategy")!.hidden, "the Strategy slot");

    // Needs you: one more group, last, with the head of product's own moves, aged from `since`, past 3 days marked.
    const groups = ui.all("main section.group").map((g) => g.getAttribute("aria-label"));
    expect(groups.at(-1)).toBe("PMX Engine");
    const eg = ui.$("main section.group[aria-label='PMX Engine']")!;
    expect([...eg.querySelectorAll(".row .t")].map((x) => x.textContent)).toEqual([
      "Approve Vision, edition 1 for Engineering.", "Send Vision, edition 1 to Marketing and PMM by pasting the command in the Claude app.",
      "Market size, Healthcare is written and has not been released yet.", "Pricing has 2 problems to fix before it can be released.",
    ]);
    const first = eg.querySelector(".row")!;
    expect(first.querySelector(".age.over")?.textContent).toBe("waiting 4 days");
    expect(eg.querySelectorAll(".row")[1]!.textContent).toMatch(/In the Claude app, type \/pmxe-release vision@company\.e1 mktCopy/);
    expect(eg.querySelectorAll(".row")[2]!.querySelector(".age")).toBeNull();
    // The badge counts them with everything else, as `pmx status` does.
    const d = await pipelineHandlers(ui.ctx, { engine }).data(168);
    expect(ui.$("#b-needs")!.textContent).toBe(String(d.needsYou!.total));

    // Strategy: Engine's moves by whose they are, releases in flight, and the pages.
    await ui.click(ui.$("#nav-strategy")!);
    await ui.until(() => ui!.$("main section.group[aria-label='Releases in flight']"), "the Strategy area");
    expect(ui.text("main h1")).toBe("Strategy");
    expect(ui.all("main section.group").map((g) => g.getAttribute("aria-label"))).toEqual(["Waiting on you", "Waiting on Claude or a colleague", "Releases in flight", "Pages"]);
    expect(ui.text("main section.group[aria-label='Waiting on Claude or a colleague']")).toMatch(/Pricing, edition 2: Claude is sending it to ELT\.Claude · its move, in the Claude appwaiting 1 hour.*Morgan Reyes's sign-off\.A colleague · their move; nothing waits on youwaiting 1 day/);
    expect(ui.text("main section.group[aria-label='Releases in flight']")).toMatch(/Vision, edition 1Reached ELTStill to come: Engineering and Marketing and PMMNext: Approve Vision, edition 1 for Engineering\. \(yours, for Engineering\).*Pricing, edition 2Reached no audience yetStill to come: ELTNext: Pricing, edition 2: Claude is sending it to ELT\. \(Claude's, for ELT\)/);
    expect(ui.text("main section.group[aria-label='Pages']")).toMatch(/12 of 13 pages ready to receive releases/);
    expect(ui.text("main .ph")).toMatch(/Acme Product, in PMX Engine 0\.12\.0 on this Mac/);
    // Only the moves made in the studio open there; Claude's and a colleague's have no button.
    const mine = ui.$("main section.group[aria-label='Waiting on you']")!;
    expect([...mine.querySelectorAll(".row")].map((r) => [...r.querySelectorAll("button")].map((b) => b.textContent))).toEqual([["Open in the studio"], ["Copy"], ["Open in the studio"], ["Open in the studio"]]);
    expect(ui.$("main section.group[aria-label='Waiting on Claude or a colleague']")!.querySelectorAll("button").length).toBe(0);
    await ui.click([...mine.querySelectorAll("button")].find((b) => b.textContent === "Open in the studio")!);
    await waitFor(async () => !!(await fake.studio()));
    expect(ui.posts.filter(([p]) => p === "engine-open")).toEqual([["engine-open", { place: "release" }]]);
    expect(await fake.studio()).toBe("studio --at release\n");

    // Health → Setup: Engine's sections after PMX's, with "Open in the studio" for a step done there, and no commands.
    await ui.go("#health/setup");
    await ui.until(() => ui!.$("#setup-engine"), "Engine's checklist");
    const ids = ui.all("main section.sc[id^=setup-], main #setup-engine").map((x) => x.id);
    expect(ids.indexOf("setup-engine")).toBeGreaterThan(ids.indexOf("setup-update") === -1 ? ids.indexOf("setup-work") : ids.indexOf("setup-update"));
    expect(ids.filter((x) => x.startsWith("setup-engine-"))).toEqual(["setup-engine-summary", "setup-engine-mac", "setup-engine-workspace", "setup-engine-pages", "setup-engine-claude"]);
    expect(ui.text("#setup-engine-summary")).toMatch(/Where it stands.*PMX Engine 0\.12\.0 · 1 step done, 3 to look at.*Workspace set up and 12 of 13 pages published; 1 edition waits for Engineering approval\.Next: Every page is published\./);
    expect(ui.text("#setup-engine-step-workspace-lint")).toMatch(/The content passes lint2 lint errors.*Open in the studioLook at this/);
    expect(ui.text("#setup-engine-step-pages-published")).toMatch(/\/pmxe-hubsCopyTo do/);
    expect(ui.$("#setup-engine-step-mac-latest")).toBeNull();
    // SETUP-3: the summary's counts and next step stay PMX's own.
    expect(ui.text("#setup-summary")).not.toMatch(/Every page is published|lint/);
    // The page names no pmx or pmxe command anywhere.
    expect(pageText(ui)).not.toMatch(/\bpmxe? [a-z]/);
    expect(pageText(ui)).not.toContain("Strategy text marker");
  }, 30000);

  it("says in one sentence when this Engine is too old to show here, and offers the studio", async () => {
    process.env.PMX_PMXE = (await fakePmxe({ statusText: "Content\n" })).cmd;
    ui = await openBoard({ hash: "strategy", engine: engineSource(exec) });
    await ui.until(() => ui!.$("#engine-lead"), "the sentence");
    expect(ui.text("#engine-lead")).toBe("This PMX Engine is too old to show here.Open the studio");
    // Its checklist's next step is the one card in Needs you, and in the Strategy area.
    expect(ui.text("main section.group[aria-label='Waiting on you']")).toMatch(/Every page is published\.?/);
    await ui.go("#needs");
    await ui.until(() => ui!.$("main section.group[aria-label='PMX Engine']"), "the PMX Engine card");
    expect(ui.text("main section.group[aria-label='PMX Engine']")).toMatch(/Every page is published.*In the Claude app, type \/pmxe-setupCopy/);
  }, 30000);

  it("shows nothing of Engine where it isn't on this Mac, as on every PM's", async () => {
    ui = await openBoard({ hash: "strategy", engine: engineSource(exec) });
    await ui.until(() => ui!.text("main h1") === "Needs you", "Needs you");
    expect(ui.win.location.hash).toBe("#needs");
    expect(ui.$("#nav-strategy")!.hidden).toBe(true);
    expect(ui.$("main section.group[aria-label='PMX Engine']")).toBeNull();
    await ui.go("#health/setup");
    await ui.until(() => ui!.$("#tab-setup[aria-selected=true]"), "Setup");
    expect(ui.$("#setup-engine")).toBeNull();
    expect(pageText(ui)).not.toMatch(/PMX Engine/);
  }, 30000);
});
