import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { pipelineTemplate } from "../src/flow/pipeline-page.js";
import { afterUpdateNote, handoff, LIST_CHANGED, noteServer, oldServerNote, oldServers, serversDir, type Next } from "../src/mcp/handoff.js";
import { handleMcp, serveMcp } from "../src/mcp/server.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const INSTALLED = new Date("2026-11-12T10:00:00");
const ps = (rows: string) => async () => ({ code: 0, stdout: rows, stderr: "" });
const CLI = "/opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js";

function fakeStart() {
  const started: { sent: string[]; exit: () => void }[] = [];
  const start = (_write: (l: string) => void, onExit: () => void): Next => {
    const n = { sent: [] as string[], exit: onExit };
    started.push(n);
    return { send: (l) => n.sent.push(l), close: () => {} };
  };
  return { started, start };
}

describe("0.24.1: PMX's server in the Claude app follows an update (FLOW-4)", () => {
  beforeEach(freshHome);

  it("answers itself while the installed pmx is its own, and hands every message to the new one once it changed", () => {
    const out: string[] = [];
    let installed = "0.24.1";
    const f = fakeStart();
    const h = handoff((l) => out.push(l), { running: "0.24.1", installed: () => installed, start: f.start });
    expect(h.route('{"id":1}')).toBe(false);
    installed = "0.25.0";
    expect(h.route('{"id":2}')).toBe(true);
    expect(h.route('{"id":3}')).toBe(true);
    expect(f.started).toHaveLength(1);
    expect(f.started[0]!.sent).toEqual(['{"id":2}', '{"id":3}']);
    expect(out).toEqual([LIST_CHANGED]);
    // The new server stopped: the next message starts it again rather than falling back to the old code.
    f.started[0]!.exit();
    expect(h.route('{"id":4}')).toBe(true);
    expect(f.started).toHaveLength(2);
    expect(f.started[1]!.sent).toEqual(['{"id":4}']);
  });

  it("serveMcp passes messages on without answering them from the old code, and says its tool list can change", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const init = (await handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, async () => ctx)) as any;
    expect(init.result.capabilities.tools.listChanged).toBe(true);

    const input = new PassThrough();
    const out: string[] = [];
    const f = fakeStart();
    const done = serveMcp(async () => ctx, {}, { input, write: (l) => out.push(l), handoff: { running: "0.24.1", installed: () => "0.25.0", start: f.start } });
    input.write('{"jsonrpc":"2.0","id":7,"method":"tools/list"}\n');
    input.end();
    await done;
    expect(f.started[0]!.sent).toEqual(['{"jsonrpc":"2.0","id":7,"method":"tools/list"}']);
    expect(out).toEqual([LIST_CHANGED]);
  });

  it("finds servers the Claude app started before the install that can't switch by themselves", async () => {
    await mkdir(serversDir(), { recursive: true });
    await writeFile(join(serversDir(), "222.json"), "{}");
    const rows = [
      `  111 Wed Nov 11 09:00:00 2026     /opt/homebrew/bin/node ${CLI} mcp`,       // before the install, no note: old
      `  222 Wed Nov 11 09:00:00 2026     /opt/homebrew/bin/node ${CLI} mcp`,       // left a note: switches itself
      `  333 Thu Nov 12 11:00:00 2026     /opt/homebrew/bin/node ${CLI} mcp`,       // started after the install
      `  444 Wed Nov 11 09:00:00 2026     /opt/homebrew/bin/node ${CLI} tick`,      // not the server
      `  555 Wed Nov 11 09:00:00 2026     /usr/bin/some-other mcp`,
    ].join("\n");
    const old = await oldServers(ps(rows) as any, { installedAt: INSTALLED });
    expect(old.map((s) => s.pid)).toEqual([111]);
    expect(await oldServers((async () => ({ code: 1, stdout: "", stderr: "" })) as any, { installedAt: INSTALLED })).toEqual([]);
    expect(oldServerNote(0)).toBeNull();
    expect(oldServerNote(1)).toMatch(/Quit the Claude app completely \(⌘Q, not just closing its window\) and open it again/);
  });

  it("each server leaves a note while it runs", async () => {
    const remove = await noteServer(4242, new Date("2026-11-12T10:00:00Z"));
    expect(JSON.parse(await readFile(join(serversDir(), "4242.json"), "utf8"))).toMatchObject({ pid: 4242, handsOff: true });
    await remove();
    await expect(readFile(join(serversDir(), "4242.json"), "utf8")).rejects.toThrow();
  });

  it("after an update, says to restart the Claude app first, then to publish the pages again", async () => {
    const rows = `  111 Wed Nov 11 09:00:00 2026     /opt/homebrew/bin/node ${CLI} mcp`;
    const personal = { flow: { url: "https://claude.ai/artifact/f1", version: "0.24.0", publishedAt: "2026-11-11T00:00:00Z" }, board: null };
    const note = (await afterUpdateNote(null, personal, ps(rows) as any, "0.24.1"))!;
    expect(note.indexOf("Quit the Claude app")).toBeGreaterThanOrEqual(0);
    expect(note.indexOf("Quit the Claude app")).toBeLessThan(note.indexOf("Update your PMX page"));
    expect(await afterUpdateNote(null, { flow: null, board: null }, ps("") as any, "0.24.1")).toBeNull();
  });
});

describe("0.24.1: Flow is back in the workspace's menu (BOARD-3)", () => {
  it("the page has a Flow map and the list of the steps, and opens old #flow links on the map", async () => {
    const page = await readFile(pipelineTemplate(), "utf8");
    // 0.36.0 (BOARD-10): both are tabs of Health; old #flow lands on the map, old #status/flow on the steps.
    expect(page).toMatch(/health: \["overview", "running", "setup", "activity", "steps", "flow", "settings"\]/);
    expect(page).toContain("flowMap = () =>");
    expect(page).toContain("steps: () => ({ sub:");
    expect(page).toMatch(/const OLD = \{[^}]*flow: \["health", "flow"\]/);
    expect(page).toMatch(/STATUS_TAB = \{[^}]*flow: "steps"/);
    // The local page's policy refuses style attributes: the map sets styles through the CSSOM only.
    expect(page).not.toMatch(/h\("[a-z]+", \{[^}]*style:/);
  });
});
