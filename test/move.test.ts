// TODO-5: a PM's work moves between a private to-do, a to-do in Linear and a product task, in any direction.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pipelineAct } from "../src/flow/pipeline-act.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { readProposals, stageProposals } from "../src/synth/proposals.js";
import { moveWork } from "../src/todo/move.js";
import { addTodo, COMMITMENT, loadTodos } from "../src/todo/todo.js";
import { readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import type { Task } from "../src/core/types.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
/** Waits for something this Mac writes after the page's request returns. */
async function eventually(fn: () => Promise<boolean>, what: string, ms = 6000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 30));
  }
}
const task = (n: number, over: Partial<Task> = {}): Task => ({
  id: `task-${n}`, identifier: `PMX-${n}`, title: `Task ${n}`, description: "From two customer calls.", url: "", category: "spec", size: "M",
  status: "inbox", priority: 0, agent: null, sources: [], prUrl: null, createdAt: NOW.toISOString(), ...over,
});

async function setup(o: { optIn?: boolean; seed?: Task[] } = {}) {
  const { repo } = await pmxRepo();
  const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "ana", todosToLinear: o.optIn ?? true } as any });
  const tr = memoryTracker(o.seed ?? []);
  const move = (ref: string, to: any, opt: { kind?: string; size?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt);
  const todos = async () => (await loadTodos()).items;
  return { ctx, tr, move, todos };
}

describe("moving work between private, to-do and product (TODO-5)", () => {
  beforeEach(freshHome);

  it("private → to-do in Linear → private: sent as a commitment, then taken back with a comment and canceled", async () => {
    const { tr, move, todos } = await setup();
    const t = await addTodo({ text: "Send Acme the SOC 2 report", due: "2026-11-24" }, NOW);
    const sent = await move(t.id, "todo");
    expect(sent).toMatchObject({ from: "private", to: "todo", todo: t.id, identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ category: COMMITMENT, title: "Send Acme the SOC 2 report" });
    await expect(move(t.id, "todo")).rejects.toThrow(/already a to-do in Linear/);

    const back = await move(t.id, "private");
    expect(back).toMatchObject({ from: "todo", to: "private", identifier: null });
    expect(back.message).toMatch(/PMX-1 is canceled in Linear/);
    expect(tr.comments.get("task-1")).toEqual(["ana took this back to their private to-dos."]);
    expect(tr.tasks.has("task-1")).toBe(false);
    expect((await todos())[0]).toMatchObject({ id: t.id, status: "open", linear: null });
  });

  it("private → product needs a kind of work, then leaves the PM's to-dos as a team task", async () => {
    const { tr, move, todos } = await setup();
    const t = await addTodo({ text: "Write up the export failures", due: "2026-11-24" }, NOW);
    await expect(move(t.id, "product")).rejects.toThrow(/Pick a kind of work for the task: .*spec/);
    await expect(move(t.id, "product", { kind: "poetry" })).rejects.toThrow(/"poetry" isn't one of your team's kinds of work/);
    await expect(move(t.id, "product", { kind: "spec", size: "XXL" })).rejects.toThrow(/A size is S, M, L, XL/);
    const r = await move(t.id, "product", { kind: "Spec", size: "m" });
    expect(r).toMatchObject({ from: "private", to: "product", todo: null, identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ category: "spec", size: "M", status: "inbox", title: "Write up the export failures" });
    expect(tr.tasks.get("task-1")!.description).toMatch(/^A task ana moved here from their own to-dos, due 2026-11-24\.\n\nPMX sent only these words/);
    expect(await todos()).toEqual([]);
  });

  it("nothing leaves the Mac while sending to-dos to Linear is off; taking work in from Linear still works", async () => {
    const { tr, move, todos } = await setup({ optIn: false, seed: [task(5)] });
    const t = await addTodo({ text: "Call Dana back" }, NOW);
    await expect(move(t.id, "todo")).rejects.toThrow(/is off, so they stay on this Mac/);
    await expect(move(t.id, "product", { kind: "spec" })).rejects.toThrow(/is off/);
    expect(tr.tasks.size).toBe(1);
    await move("PMX-5", "todo");
    expect((await todos()).map((x) => x.linear ?? null)).toEqual([null, "PMX-5"]);
  });

  it("product → to-do: the team task becomes the PM's commitment, leaves Ready, and shows in their to-dos", async () => {
    const { tr, move, todos } = await setup({ seed: [task(7, { status: "ready" })] });
    const r = await move("pmx-7", "todo");
    expect(r).toMatchObject({ from: "product", to: "todo", identifier: "PMX-7" });
    expect(tr.tasks.get("task-7")).toMatchObject({ category: COMMITMENT, status: "inbox" });
    expect(tr.comments.get("task-7")).toEqual(["ana took this as their own to-do. Agents don't pick it up."]);
    expect((await todos())[0]).toMatchObject({ text: "Task 7", linear: "PMX-7", source: { title: "Moved from PMX-7", keys: [] }, receiptId: "" });
    await expect(move("PMX-7", "todo")).rejects.toThrow(/already a to-do in Linear/);
  });

  it("to-do → product keeps the same issue: kind and size change, PMX's commitment text is replaced, the to-do leaves", async () => {
    const { tr, move, todos } = await setup();
    const t = await addTodo({ text: "Draft the pricing page spec", due: "2026-11-25" }, NOW);
    await move(t.id, "todo");
    expect(tr.tasks.get("task-1")!.description).toMatch(/^A commitment ana made/);
    const r = await move(t.id, "product", { kind: "spec", size: "L" });
    expect(r).toMatchObject({ from: "todo", to: "product", identifier: "PMX-1", todo: null });
    expect(tr.tasks.get("task-1")).toMatchObject({ category: "spec", size: "L" });
    expect(tr.tasks.get("task-1")!.description).toMatch(/^A task ana moved here from their own to-dos, due 2026-11-25\./);
    expect(tr.comments.get("task-1")).toEqual(["ana made this a spec task for the team."]);
    expect(await todos()).toEqual([]);

    // Back to a to-do and then into the team's list again: the synthesis text of a real task is never replaced.
    const seeded = await setup({ seed: [task(3)] });
    await seeded.move("PMX-3", "todo");
    await seeded.move("PMX-3", "product", { kind: "research-synthesis" });
    expect(seeded.tr.tasks.get("task-3")).toMatchObject({ category: "research-synthesis", description: "From two customer calls." });
  });

  it("product → private: the team task is canceled with a comment and becomes a private to-do", async () => {
    const { tr, move, todos } = await setup({ seed: [task(9)] });
    const r = await move("PMX-9", "private");
    expect(r).toMatchObject({ from: "product", to: "private", identifier: null });
    expect(tr.tasks.has("task-9")).toBe(false);
    expect(tr.comments.get("task-9")).toEqual(["ana took this off the team's list to keep as a private to-do."]);
    expect((await todos())[0]).toMatchObject({ text: "Task 9", linear: null });
  });

  it("a proposal can be kept as a private to-do or a to-do in Linear, or approved by moving it to product", async () => {
    const { tr, move, todos } = await setup();
    const from = [{ id: "T1", title: "Acme weekly sync", at: "2026-11-18T14:00:00Z", why: "Asked twice for CSV export." }];
    const base = { at: NOW.toISOString(), receipt: "r-none", description: "Spec it.", category: "spec", size: "M" as const, sources: ["T1"], from };
    const [a, b, c] = await stageProposals([{ ...base, title: "CSV export that doesn't break" }, { ...base, title: "Follow up with Acme" }, { ...base, title: "Bulk edit for roles" }]);
    const kept = await move(a!.id, "private");
    expect(kept).toMatchObject({ from: "product", to: "private", identifier: null });
    expect((await todos())[0]).toMatchObject({ text: "CSV export that doesn't break", why: "Asked twice for CSV export.", source: { title: "Acme weekly sync", at: "2026-11-18" }, receiptId: "r-none" });
    expect(await move(b!.id, "todo")).toMatchObject({ to: "todo", identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ category: COMMITMENT, title: "Follow up with Acme" });
    expect(await move(c!.id, "product")).toMatchObject({ to: "product", identifier: "PMX-2" });
    expect(tr.tasks.get("task-2")).toMatchObject({ category: "spec", size: "M", description: "Spec it." });
    expect(await readProposals()).toEqual([]);
  });

  it("work someone started, finished work, done to-dos and unknown references stay put, with a reason", async () => {
    const { move } = await setup({ seed: [task(1, { status: "running", agent: "bo@m2" }), task(2, { status: "done" }), task(3, { agent: "bo@m2", status: "ready" })] });
    await expect(move("PMX-1", "private")).rejects.toThrow(/PMX-1 is already being worked on in Linear, so it stays where it is/);
    await expect(move("PMX-2", "todo")).rejects.toThrow(/PMX-2 is done in Linear/);
    await expect(move("PMX-3", "todo")).rejects.toThrow(/already being worked on/);
    await expect(move("PMX-1", "product")).rejects.toThrow(/already a product task/);
    await expect(move("PMX-44", "private")).rejects.toThrow(/PMX-44 isn't a task in your team's PMX project/);
    await expect(move("zzzzzz", "private")).rejects.toThrow(/No to-do "zzzzzz"/);
    await expect(move("PMX-1", "elsewhere")).rejects.toThrow(/private, todo or product/);
    const { completeTodo } = await import("../src/todo/todo.js");
    const t = await addTodo({ text: "Old one" }, NOW);
    await completeTodo(t.id, NOW);
    await expect(move(t.id, "todo")).rejects.toThrow(/is done\. Only open to-dos move/);
  });

  it("a commitment made on another Mac moves too; a to-do whose issue is gone comes back private", async () => {
    const { tr, move, todos } = await setup({ seed: [task(4, { category: COMMITMENT, title: "Book the offsite" })] });
    expect(await move("PMX-4", "private")).toMatchObject({ from: "todo", to: "private" });
    expect((await todos())[0]).toMatchObject({ text: "Book the offsite", linear: null });
    const t = await addTodo({ text: "Ping legal" }, NOW);
    await move(t.id, "todo");
    tr.tasks.clear();
    await expect(move(t.id, "product", { kind: "spec" })).rejects.toThrow(/isn't in your team's PMX project any more/);
    expect(await move(t.id, "private")).toMatchObject({ to: "private" });
    expect((await todos()).find((x) => x.id === t.id)?.linear).toBe(null);
  });
});

describe("moving work through the Claude relay (LINEAR-2)", () => {
  beforeEach(freshHome);
  const node = (identifier: string, labels: [string, string][]) => ({
    id: `uuid-${identifier}`, identifier, title: `Task ${identifier}`, description: "", url: "", priority: 0, createdAt: NOW.toISOString(),
    labels: { nodes: labels.map(([g, n]) => ({ name: n, parent: { name: g } })) }, comments: { nodes: [] },
  });

  it("queues the label changes and comments the relay task applies, including on an issue not synced yet (a commitment is already size S)", async () => {
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [node("PMX-5", [["pmx-status", "ready"], ["pmx-category", "spec"], ["pmx-size", "M"]])] }));
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "ana", todosToLinear: true } as any });
    const tr = relayTracker(ctx.team, () => {}, () => NOW);
    const move = (ref: string, to: any, o = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, o);

    await move("PMX-5", "todo");
    const t = await addTodo({ text: "Ask finance about the discount" }, NOW);
    const sent = await move(t.id, "todo");
    expect(sent.identifier).toMatch(/^PENDING-/);
    await move(t.id, "product", { kind: "spec" });
    const ops = (await readOutbox()).ops.map(({ id, at, ...o }) => o);
    expect(ops.slice(0, 3)).toEqual([
      { kind: "set-label", target: "PMX-5", group: "pmx-category", value: COMMITMENT },
      { kind: "set-label", target: "PMX-5", group: "pmx-status", value: "inbox" },
      { kind: "comment", target: "PMX-5", body: "ana took this as their own to-do. Agents don't pick it up." },
    ]);
    expect(ops[3]).toMatchObject({ kind: "create-task", category: COMMITMENT, title: "Ask finance about the discount" });
    const ref = `ref:${(await readOutbox()).ops[3]!.id}`;
    expect(ops.slice(4)).toEqual([
      { kind: "set-label", target: ref, group: "pmx-category", value: "spec" },
      expect.objectContaining({ kind: "rewrite", target: ref, description: expect.stringMatching(/^A task ana moved here/) }),
      { kind: "comment", target: ref, body: "ana made this a spec task for the team." },
    ]);
  });
});

describe("moving work from the board (TODO-5)", () => {
  beforeEach(freshHome);
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("the dispatcher checks a move's shape, and the handler answers with what happened", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    const h = pipelineHandlers(ctx);
    expect(await pipelineAct(h, "move", { to: "private" })).toEqual([400, { error: "ref and to are required" }]);
    expect(await pipelineAct(h, "move", { ref: "abc123", to: "away" })).toEqual([400, { error: "Unknown move." }]);
    const t = await addTodo({ text: "Ping legal" }, NOW);
    const [status, body] = await pipelineAct(h, "move", { ref: t.id, to: "todo" });
    expect(status).toBe(400);
    expect((body as any).error).toMatch(/is off, so they stay on this Mac\. Turn it on in Settings, under What Linear gets, or with pmx todo --linear on\./);
  });

  it("Where in a to-do's details moves it to a product task, and Plan's Take as my to-do takes a team task back", { timeout: 30000 }, async () => {
    ui = await openBoard({
      hash: "anytime", now: NOW, team: { tracker: LINEAR as any }, personal: { todosToLinear: true } as any,
      before: async () => {
        await mkdir(relayDir(), { recursive: true });
        await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [{
          id: "uuid-PMX-5", identifier: "PMX-5", title: "Spec the CSV export", description: "", url: "", priority: 0, createdAt: NOW.toISOString(),
          labels: { nodes: [{ name: "ready", parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }] }, comments: { nodes: [] },
        }] }));
        await addTodo({ text: "Write up the export failures" }, NOW);
      },
    });
    await ui.until(() => ui!.text().includes("Write up the export failures"), "the to-do");
    await ui.click(ui.button("Open", "main [role=listitem]"));
    await ui.until(() => ui!.$("#sheet.open"), "the to-do's details");
    const where = ui.all("#sheet [aria-labelledby=where-l] button");
    expect(where.map((b) => [b.textContent, b.getAttribute("aria-pressed"), (b as HTMLButtonElement).disabled])).toEqual([["Private", "true", false], ["To-do in Linear", "false", false], ["Product task", "false", false]]);
    await ui.click(ui.button("Product task", "#sheet"));
    await ui.until(() => ui!.$("#mv-kind"), "the kind of work picker");
    await ui.pick("#mv-kind", "build-brief");
    await ui.pick("#mv-size", "L");
    (ui.$("#mv-kind")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => ui!.posts.some((p) => p[0] === "move"), "the move to be sent");
    expect(ui.posts.find((p) => p[0] === "move")![1]).toMatchObject({ to: "product", kind: "build-brief", size: "L" });
    await eventually(async () => (await loadTodos()).items.length === 0, "the to-do to leave");
    await eventually(async () => (await readOutbox()).ops.some((o) => o.kind === "create-task" && o.category === "build-brief" && o.size === "L"), "the product task to be queued");

    await ui.go("plan");
    await ui.until(() => ui!.text().includes("Spec the CSV export"), "the team's task nobody has started");
    await ui.click(ui.button("Take as my to-do"));
    await ui.until(() => ui!.$("#modal h3"), "the take dialog");
    expect(ui.text("#modal h3")).toBe("Take PMX-5 as your to-do?");
    await ui.click(ui.button("To-do in Linear", "#modal"));
    await eventually(async () => (await loadTodos()).items.some((x) => x.linear === "PMX-5"), "PMX-5 as a to-do in Linear");
    expect((await readOutbox()).ops.some((o) => o.kind === "set-label" && o.target === "PMX-5" && o.value === COMMITMENT)).toBe(true);
    // The page reloads after the move: PMX-5 leaves the work nobody has started, where the new product task waits.
    await ui.until(() => !ui!.text().includes("Spec the CSV export"), "Plan to redraw without PMX-5");
    expect(ui.all("main [role=listitem]").map((r) => r.textContent).filter((t) => /Take as my to-do/.test(t ?? ""))).toEqual([expect.stringMatching(/^Write up the export failuresPENDING-\w+Pool/)]);
  });
});
