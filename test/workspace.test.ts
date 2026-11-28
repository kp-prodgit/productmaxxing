import { readdir, readFile } from "node:fs/promises";
import { beforeEach, describe, expect, it } from "vitest";
import { readJson, withLock, writeJson } from "../src/core/fsutil.js";
import { pipelineAct, type PipelineActions } from "../src/flow/pipeline-act.js";
import { buildLogbook } from "../src/flow/pipeline.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { handleMcp } from "../src/mcp/server.js";
import { keyOk, pair, pairedCount, pairingsFile, unpairAll } from "../src/mcp/pair.js";
import { stageProposals, readProposals, dropProposals } from "../src/synth/proposals.js";
import { addTodo, completeTodo, loadTodos, placeTodo } from "../src/todo/todo.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const NOW = new Date("2026-11-11T15:00:00Z");
const call = (name: string, args: object, ctx: any, deps = {}) =>
  handleMcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, async () => ctx, deps) as Promise<any>;

describe("0.23.0: stores take a lock (BOARD-6)", () => {
  beforeEach(freshHome);

  it("runs one writer at a time, and takes over a lock left by a process that died", async () => {
    const order: string[] = [];
    const f = `${process.env.PMX_HOME}/x.json`;
    await Promise.all([1, 2, 3].map((n) => withLock(f, async () => { order.push(`in${n}`); await new Promise((r) => setTimeout(r, 15)); order.push(`out${n}`); })));
    for (let i = 0; i < order.length; i += 2) expect(order[i]!.slice(2)).toBe(order[i + 1]!.slice(3));
    const { mkdir, utimes } = await import("node:fs/promises");
    await mkdir(`${f}.lock`);
    const old = new Date(Date.now() - 120000);
    await utimes(`${f}.lock`, old, old);
    expect(await withLock(f, async () => "ran")).toBe("ran");
  });

  it("two writes of one file at the same moment both finish, and the file is one of them whole", async () => {
    // PMX's servers build a context per request, and each writes the same settings files (the board's preview of a
    // do-not-read entry and its Save, sent together): neither may fail, and no file may be a mix of two.
    const f = `${process.env.PMX_HOME}/same.json`;
    const values = Array.from({ length: 8 }, (_, n) => ({ n, pad: "x".repeat(n * 4000) }));
    for (let round = 0; round < 25; round++) {
      await Promise.all(values.map((v) => writeJson(f, v)));
      expect(values).toContainEqual(await readJson(f));
    }
    expect((await readdir(process.env.PMX_HOME!)).filter((x) => x.endsWith(".tmp"))).toEqual([]);
  });

  it("a to-do ticked while another write is under way isn't lost", async () => {
    const a = await addTodo({ text: "Send Acme the SOC 2 report" }, NOW);
    const b = await addTodo({ text: "Book the site visit", due: "2026-11-14" }, NOW);
    await Promise.all([completeTodo(a.id, NOW), placeTodo(b.id, { when: "evening" })]);
    const items = (await loadTodos()).items;
    expect(items.find((t) => t.id === a.id)).toMatchObject({ status: "done" });
    expect(items.find((t) => t.id === b.id)).toMatchObject({ status: "open", when: "evening", due: null });
  });

  it("dropping a proposal and staging a new one at once keeps both changes", async () => {
    const [p] = await stageProposals([{ at: NOW.toISOString(), receipt: "r", title: "Export approvals", description: "d", category: "spec", size: "S", sources: [], from: [] }]);
    await Promise.all([dropProposals([p!.id], NOW), stageProposals([{ at: NOW.toISOString(), receipt: "r", title: "Fix the email name", description: "d", category: "spec", size: "S", sources: [], from: [] }])]);
    expect((await readProposals()).map((x) => x.title)).toEqual(["Fix the email name"]);
  });
});

describe("0.23.0: to-dos the PM places (BOARD-6)", () => {
  beforeEach(freshHome);

  it("adds, dates, moves and reopens to-dos, and refuses what isn't one", async () => {
    const t = await addTodo({ text: "  Read the   RFP ", when: "evening" }, NOW);
    expect(t).toMatchObject({ text: "Read the RFP", when: "evening", due: null, source: { title: "Added by you", keys: [] } });
    await expect(addTodo({ text: " " }, NOW)).rejects.toThrow(/some words/);
    await expect(addTodo({ text: "x", due: "Friday" }, NOW)).rejects.toThrow(/2026-11-14/);
    await expect(addTodo({ text: "x", when: "tonight" }, NOW)).rejects.toThrow(/Today, This Evening or Someday/);
    await placeTodo(t.id, { due: "2026-11-13", when: null });
    await completeTodo(t.id, NOW);
    await placeTodo(t.id, { due: "2026-11-13", reopen: true });
    expect((await loadTodos()).items[0]).toMatchObject({ status: "open", doneAt: null, due: "2026-11-13" });
    await expect(placeTodo("zzzzzz", {})).rejects.toThrow(/No to-do/);
  });

  it("the Logbook lists what this PM finished, approved, dropped and decided, newest first", () => {
    const log = buildLogbook({
      now: NOW, agent: "ana@m1",
      todos: [{ text: "Send the deck", status: "done", doneAt: "2026-11-11T10:00:00Z" }, { text: "Old", status: "done", doneAt: "2026-10-01T10:00:00Z" }, { text: "Open", status: "open", doneAt: null }],
      receipts: [{ at: "2026-11-10T09:00:00Z", synth: { tasks: [{ title: "Map is slow", posted: { identifier: "PRO2-122" } }, { title: "Dark mode", posted: { dropped: true } }, { title: "Waiting", posted: { staged: "p1" } }] } }],
      runlog: [{ type: "verdict", ts: "2026-11-09T09:00:00Z", agent: "ana@m1", taskId: "PRO2-115", verdict: "accepted" } as any, { type: "verdict", ts: "2026-11-09T09:00:00Z", agent: "bo@m2", taskId: "PRO2-116", verdict: "rejected" } as any],
    });
    expect(log.map((l) => [l.kind, l.text, l.ref])).toEqual([["done", "Send the deck", null], ["approved", "Map is slow", "PRO2-122"], ["dropped", "Dark mode", null], ["accepted", "PRO2-115", "PRO2-115"]]);
  });
});

describe("0.23.0: the paired workspace in Claude (FLOW-4, FLOW-5, PRIV-7)", () => {
  beforeEach(freshHome);

  it("pairs only when the PM allows it on the Mac, and keeps only a hash of the key", async () => {
    expect(await pair(async () => false, NOW)).toBeNull();
    const key = await pair(async () => true, NOW);
    expect(key).toMatch(/^pmxk_/);
    expect(await keyOk(key)).toBe(true);
    expect(await keyOk(`${key}x`)).toBe(false);
    expect(await keyOk("pmxk_" + "a".repeat(32))).toBe(false);
    expect(await readFile(pairingsFile(), "utf8")).not.toContain(key!);
    for (let i = 0; i < 6; i++) await pair(async () => true, NOW);
    expect(await pairedCount()).toBe(5);
    expect(await keyOk(key)).toBe(false); // the oldest aged out
    expect(await unpairAll()).toBe(5);
    expect(await pairedCount()).toBe(0);
  });

  it("board and board_act refuse without a current key, and answer the full board with one", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    await stageProposals([{ at: NOW.toISOString(), receipt: "x", title: "Private idea from a call", description: "d", category: "spec", size: "S", sources: [], from: [] }]);
    // No key, a wrong key, a declined pairing: nothing titled comes back.
    for (const args of [{}, { key: "pmxk_" + "b".repeat(32) }]) {
      const r = await call("board", args, ctx);
      expect(r.result).toMatchObject({ isError: true, structuredContent: { code: "not_paired" } });
      expect(JSON.stringify(r)).not.toContain("Private idea");
      expect((await call("board_act", { ...args, path: "todo-add", body: { text: "x" } }, ctx)).result.structuredContent.code).toBe("not_paired");
    }
    expect((await call("pair", {}, ctx, { confirm: async () => false })).result).toMatchObject({ isError: true, structuredContent: { code: "declined" } });
    const key = (await call("pair", {}, ctx, { confirm: async () => true })).result.structuredContent.key;
    const board = (await call("board", { key, hours: 24 }, ctx)).result.structuredContent;
    expect(board).toMatchObject({ level: "local", proposals: [{ title: "Private idea from a call" }] });
    // Actions go through the same door as the local page.
    const add = (await call("board_act", { key, path: "todo-add", body: { text: "Call Dana back", when: "today" } }, ctx)).result.structuredContent;
    expect(add).toMatchObject({ status: 200, body: { message: "Added: Call Dana back" } });
    expect((await call("board_act", { key, path: "proposals", body: { action: "drop", ids: ["1"] } }, ctx)).result.structuredContent).toEqual({ status: 200, body: { message: 'Dropped "Private idea from a call".' } });
    // A change that lets more through still asks first, from the artifact as on the local page.
    expect((await call("board_act", { key, path: "changes", body: { changes: [{ kind: "my-domain", op: "remove", value: "nope.com" }] } }, ctx)).result.structuredContent).toMatchObject({ status: 409, body: { loosening: [expect.any(String)] } });
    expect((await call("board_act", { key, path: "nope", body: {} }, ctx)).result.structuredContent.status).toBe(404);
    // Disconnecting revokes every key.
    expect((await call("board_act", { key, path: "unpair", body: {} }, ctx)).result.structuredContent.body.message).toMatch(/Disconnected 1/);
    expect((await call("board", { key }, ctx)).result.structuredContent.code).toBe("not_paired");
  });

  it("one dispatcher checks every action's shape", async () => {
    const seen: unknown[] = [];
    const o = {
      data: async () => ({}) as any, whatIf: async (k: string, v: string) => ({ k, v }),
      proposals: async (a: string, ids: string[]) => (seen.push([a, ids]), "ok"),
      changes: async () => ({ status: 200, body: {} }), review: async () => ({ status: 200, body: {} }),
    } as PipelineActions;
    expect(await pipelineAct(o, "proposals", { action: "ship", ids: ["p1"] })).toEqual([400, { error: "action must be start, approve or drop" }]);
    expect(await pipelineAct(o, "proposals", { action: "approve", ids: [] })).toEqual([400, { error: "ids must be the IDs of tasks waiting for approval" }]);
    expect(await pipelineAct(o, "proposals", { action: "approve", ids: ["p1"] })).toEqual([200, { message: "ok" }]);
    expect(await pipelineAct(o, "what-if", { kind: "title", value: "Board prep" })).toEqual([200, { whatIf: { k: "title", v: "Board prep" } }]);
    expect(await pipelineAct(o, "todo-add", { text: "x" })).toEqual([404, { error: "not found" }]);
    expect(await pipelineAct(o, "proposals", null)).toEqual([400, { error: "the body must be a JSON object" }]);
    expect(seen).toEqual([["approve", ["p1"]]]);
  });

  it("the board's handlers add and place to-dos for the page", async () => {
    const { repo } = await pmxRepo();
    const h = pipelineHandlers(await testCtx({ repo }));
    const r: any = await h.todoAdd({ text: "Ask Globex about SSO", when: "someday" });
    expect(r.status).toBe(200);
    expect((await h.todoPlace(r.body.todo.id, { when: "nope" })).status).toBe(400);
    expect((await h.todoPlace("../x", {})).status).toBe(400);
    expect((await h.todoPlace(r.body.todo.id, { due: "2026-11-20" })).body).toEqual({ message: "Moved: Ask Globex about SSO" });
  });
});
