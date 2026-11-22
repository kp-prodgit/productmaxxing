// OBS-5: Health → Running shows what PMX is doing on this Mac right now, with memory from one ps call matched to PMX's
// own processes; this Mac's page stops by itself when nobody uses it.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Exec } from "../src/core/exec.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { agentRunFile, etimeSeconds, noteAgentRun, parsePs, RUN_COST, runningNow } from "../src/flow/running.js";
import { noteWebServer, PAGE_IDLE_MS, serveUntilStopped, watchIdle, webServerFile } from "../src/flow/web-server.js";
import { relayDir } from "../src/tracker/relay.js";
import { freshHome } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("what PMX runs on this Mac (OBS-5)", () => {
  beforeEach(freshHome);

  it("reads ps's columns and elapsed times", () => {
    expect(etimeSeconds("05:07")).toBe(307);
    expect(etimeSeconds("02:00:01")).toBe(7201);
    expect(etimeSeconds("3-01:00:00")).toBe(3 * 86400 + 3600);
    expect(parsePs("  PID  PPID    RSS     ELAPSED COMMAND\n  12     1  20480       01:00 /bin/node /x/cli.js mcp\nbad line\n")).toEqual([
      { pid: 12, ppid: 1, rssKb: 20480, elapsedS: 60, command: "/bin/node /x/cli.js mcp" },
    ]);
  });

  it("matches PMX's own processes only: its job's pass, the agent run's Claude Code, its servers", async () => {
    const now = new Date("2026-11-21T15:00:00Z");
    const me = process.pid;
    const launchd = Object.assign(fakeLaunchd(), { running: async () => true });
    await launchd.install(`<plist><dict><key>ProgramArguments</key>\n  <array>\n    <string>/opt/homebrew/opt/node/bin/node</string>\n    <string>/opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js</string>\n    <string>tick</string>\n  </array></dict></plist>`);
    const settings = paths.runSettings();
    const ps = [
      "  PID  PPID    RSS     ELAPSED COMMAND",
      `  ${me}     1  81920       10:00 /opt/homebrew/opt/node/bin/node /opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js mcp`,
      `  801   ${me}  10240       02:00 /usr/bin/git -C /r fetch`,
      "  700     1  61440       05:00 /opt/homebrew/opt/node/bin/node /opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js tick",
      `  710   700 491520       04:30 /Users/kp/.local/bin/claude -p Draft PMX-12 --settings ${settings} --strict-mcp-config`,
      "  720   700   8192       04:00 /usr/bin/git status",
      "  900     1  40960     1-00:00:00 /opt/homebrew/opt/node/bin/node /opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js open --no-open",
      "  950     1 999999       09:00 /Applications/Claude.app/Contents/MacOS/Claude",
      "  960     1 512000       09:00 /Users/kp/.local/bin/claude --settings /Users/kp/.claude/settings.json",
    ].join("\n");
    const calls: string[] = [];
    const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stdout: ps, stderr: "" }; };
    // The run's note, from the pass's pmx (here: a live pid, this test's parent), and this Mac's page.
    await writeFile(agentRunFile(), JSON.stringify({ task: "PMX-12", title: "Spec the audit log export", startedAt: "2026-11-21T14:55:30Z", pid: process.ppid }));
    await writeFile(webServerFile(), JSON.stringify({ pid: 900, url: "http://127.0.0.1:1/flow#t=x", version: "0.36.0", startedAt: "2026-11-20T15:00:00Z" }));
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: "2026-11-21T14:00:00Z", projectId: "p", issues: [] }));

    const v = await runningNow({ exec, launchd, now, mcpCli: "/opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js", relay: true, self: { pid: me, id: "mcp" } });
    expect(calls).toEqual(["ps -axo pid,ppid,rss,etime,command"]);
    expect(v.job).toMatchObject({ installed: true, running: true, pass: { pid: 700, since: "2026-11-21T14:55:00.000Z", memoryMb: 60 + 480 + 8 } });
    expect(v.agent).toEqual({ task: "PMX-12", title: "Spec the audit log export", since: "2026-11-21T14:55:30Z", memoryMb: 480 });
    const [mcp, page] = v.servers;
    expect(mcp).toMatchObject({ id: "mcp", running: true, here: true, processes: [{ pid: me, memoryMb: 80 + 10 }] });
    expect(page).toMatchObject({ id: "page", running: true, here: false, processes: [{ pid: 900, since: "2026-11-20T15:00:00.000Z", memoryMb: 40 }] });
    expect(page!.note).toMatch(new RegExp(`stops by itself after ${Math.round(PAGE_IDLE_MS / 3600000)} hours`));
    expect(v.claude.linear).toEqual({ syncedAt: "2026-11-21T14:00:00Z", lastRun: null });
    // The Claude app and someone else's Claude Code session aren't PMX's.
    expect(v.memory).toEqual({ totalMb: 80 + 10 + 60 + 480 + 8 + 40, processes: 6 });
    expect(v.note).toBe(RUN_COST);
    expect(RUN_COST).toBe("An agent run is one Claude Code process, usually 400–550 MB, one at a time.");
  });

  it("without a job, a run or a page, says so; a note from a run that ended is cleared by that run", async () => {
    const exec: Exec = async () => ({ code: 0, stdout: `  PID  PPID    RSS     ELAPSED COMMAND\n  ${process.pid}     1  20480       01:00 node cli.js mcp\n`, stderr: "" });
    const v = await runningNow({ exec, launchd: fakeLaunchd(), now: new Date(), self: { pid: process.pid, id: "mcp" } });
    expect(v.job).toMatchObject({ installed: false, running: false, nextPass: null, pass: null });
    expect(v.agent).toBeNull();
    expect(v.servers.map((s) => [s.id, s.running])).toEqual([["mcp", true], ["page", false]]);
    expect(v.claude.linear).toBeNull();
    const done = await noteAgentRun("PMX-3", "x", new Date());
    expect(JSON.parse(await readFile(agentRunFile(), "utf8"))).toMatchObject({ task: "PMX-3", pid: process.pid });
    await done();
    await expect(readFile(agentRunFile(), "utf8")).rejects.toThrow();
  });
});

describe("this Mac's page stops when nobody uses it (OBS-5)", () => {
  beforeEach(freshHome);

  it("stops after the idle time with no request, and each request starts the wait again", async () => {
    const server = createServer((_q, r) => r.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    await mkdir(paths.home(), { recursive: true });
    const unnote = await noteWebServer(url);
    const log: string[] = [];
    let stopped: string | null = null;
    const t0 = Date.now();
    void serveUntilStopped({ server, close: () => new Promise((r) => server.close(() => r())) }, unnote, { idleMs: 250, log: (l) => log.push(l), signals: false }).then((why) => { stopped = why; });
    for (let i = 0; i < 4; i++) { await sleep(120); await fetch(url).then((r) => r.text()); }
    expect(stopped).toBeNull(); // requests every 120 ms keep it up
    while (!stopped && Date.now() - t0 < 5000) await sleep(20);
    expect(stopped).toBe("idle");
    expect(log.join("\n")).toMatch(/No one used this page for 0 minutes, so it stopped\./);
    await expect(readFile(webServerFile(), "utf8")).rejects.toThrow();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("is four hours unless PMX_PAGE_IDLE_MS says otherwise, and stops watching when told", async () => {
    expect(PAGE_IDLE_MS).toBe(4 * 3600000);
    const server = createServer();
    let idle = 0;
    const stop = watchIdle(server, () => idle++, 40);
    stop();
    await sleep(120);
    expect(idle).toBe(0);
  });
});

describe("Health → Running on PMX's page (OBS-5)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const app of [false, true]) it(`opens the tab, asks PMX once, and asks again only on Refresh or reopening${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ app, hash: "health" });
    // The board's own read never carries what's running.
    expect(ui.posts.filter((p) => p[0] === "running")).toEqual([]);
    await ui.click(ui.button("Running", "main [role=tablist]"));
    expect(ui.win.location.hash).toBe("#health/running");
    await ui.until(() => ui!.$("#run-agent"), "the Running tab");
    expect(ui.text("#run-agent")).toMatch(/Agent run.*An agent run is one Claude Code process, usually 400–550 MB, one at a time\..*No agent run right now/);
    expect(ui.text("#run-job")).toMatch(/Background job.*Off: PMX runs only while you have it open/);
    expect(ui.text("#run-servers")).toMatch(/PMX's page on this Mac.*stops by itself after 4 hours/);
    expect(ui.text("#run-total")).toMatch(/^PMX is using about \d+ MB on this Mac right now, in \d+ process(es)?\. Checked/);
    await sleep(200);
    expect(ui.posts.filter((p) => p[0] === "running")).toHaveLength(1);
    await ui.click(ui.button("Refresh", "main"));
    await ui.until(() => ui!.posts.filter((p) => p[0] === "running").length === 2, "Refresh to ask again");
    await ui.go("#health/setup");
    await ui.go("#health/running");
    await ui.until(() => ui!.posts.filter((p) => p[0] === "running").length === 3, "reopening to ask again");
    await sleep(200);
  }, 30000);
});
