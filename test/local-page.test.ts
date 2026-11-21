import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { ACT_PATHS, pipelineAct } from "../src/flow/pipeline-act.js";
import { noteWebServer, openWebServer, stopWebServer, webServerFile, webServerStatus } from "../src/flow/web-server.js";
import { MCP_TOOLS } from "../src/mcp/server.js";
import { freshHome } from "./helpers.js";

const NOTE = { pid: 1, url: "http://127.0.0.1:5/flow#t=secret-token", version: "x", startedAt: "2026-11-20T10:00:00.000Z" };

describe("this Mac's page, from the page in Claude (BOARD-8)", () => {
  beforeEach(freshHome);

  it("says whether the page runs and since when, never its link", async () => {
    expect(await webServerStatus()).toEqual({ running: false, since: null });
    const unnote = await noteWebServer("http://127.0.0.1:1/flow#t=secret-token", new Date(NOTE.startedAt));
    const seen: string[] = [];
    const answering = (async (url: string, init: any) => { seen.push(`${url} ${init.headers.authorization}`); return { ok: true }; }) as any;
    const status = await webServerStatus({ fetch: answering });
    expect(status).toEqual({ running: true, since: NOTE.startedAt });
    expect(JSON.stringify(status)).not.toContain("secret-token");
    expect(seen).toEqual(["http://127.0.0.1:1/api/pipeline?hours=1 Bearer secret-token"]);
    expect(await webServerStatus({ fetch: (async () => { throw new Error("refused"); }) as any })).toEqual({ running: false, since: null });
    await unnote();
  });

  it("opens a running page; starts one that isn't, waits for it, then opens it; says so when it doesn't start", async () => {
    const opened: string[][] = [];
    const exec = (async (cmd: string, args: string[]) => { opened.push([cmd, ...args]); return { code: 0, stdout: "", stderr: "" }; }) as any;
    expect(await openWebServer(exec, { running: async () => NOTE, launch: async () => { throw new Error("must not start a second page"); } })).toEqual({ started: false });
    expect(opened).toEqual([["open", NOTE.url]]);

    let launched = 0, asked = 0;
    const running = async () => (launched && ++asked > 2 ? NOTE : null);
    expect(await openWebServer(exec, { running, launch: async () => { launched++; }, stepMs: 1 })).toEqual({ started: true });
    expect([launched, opened.length]).toEqual([1, 2]);

    await expect(openWebServer(exec, { running: async () => null, launch: async () => {}, waitMs: 20, stepMs: 5 })).rejects.toThrow(/didn't start\. Run pmx open in Terminal/);
    expect(opened).toHaveLength(2);
  });

  it("stops the page's process and forgets it; never the server answering the call", async () => {
    expect(await stopWebServer()).toBe(false);
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const exited = new Promise((r) => child.on("exit", r));
    await writeFile(webServerFile(), JSON.stringify({ ...NOTE, pid: child.pid }), { mode: 0o600 });
    expect(await stopWebServer()).toBe(true);
    await exited;
    await expect(readFile(webServerFile(), "utf8")).rejects.toThrow();

    await noteWebServer(NOTE.url);
    await expect(stopWebServer()).rejects.toThrow(/This is the page on this Mac itself/);
  });

  it("is one of the paired page's actions, checked like the others", async () => {
    expect(ACT_PATHS).toContain("local-page");
    const act = MCP_TOOLS.find((t) => t.name === "board_act")!;
    expect((act.inputSchema.properties.path as any).enum).toContain("local-page");
    const got: string[] = [];
    const o = { localPage: async (a: string) => { got.push(a); return { status: 200, body: { ok: a } }; } } as any;
    expect(await pipelineAct(o, "local-page", { action: "open" })).toEqual([200, { ok: "open" }]);
    expect(await pipelineAct(o, "local-page", {})).toEqual([200, { ok: "" }]);
    expect(got).toEqual(["open", ""]);
  });
});
