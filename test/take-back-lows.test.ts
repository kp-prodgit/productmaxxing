// Two lows of taking work back (RUN-5, TODO-5, R16b): a task Linear has, taken back while its share was still staged
// (after a push that failed), had its quotes written to the team repo by the next share pass, for the clean-up to remove
// later; now the take-back unstages it, and the share pass never writes a staged share whose task's mark says PMX took
// it back or dropped it. And taking back a queued task a to-do became made a new to-do and dropped the original; now
// the original comes back as it was, as `pmx linear outbox drop` gives it back.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { execOk } from "../src/core/exec.js";
import { paths } from "../src/core/paths.js";
import type { Task } from "../src/core/types.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { evidenceStore, NAME_SWAP } from "../src/run/packs.js";
import { evidenceStep, shareEvidence, stageShares } from "../src/run/share.js";
import { quotesFor } from "../src/todo/kept-quotes.js";
import { moveWork } from "../src/todo/move.js";
import { addTodo, loadTodos } from "../src/todo/todo.js";
import { readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";

const NOW = new Date("2026-11-27T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "proj-1" };
const QUOTES = [{ id: "T1", kind: "meeting" as const, at: "2026-11-26", passages: ["Admins rename every export by hand before the weekly upload."] }];
const COPY = { quotes: QUOTES, quotesSwap: NAME_SWAP };

const listed = async (name: string, key: "tasks" | "todos") => {
  const raw = await readFile(join(paths.staging(), name), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw)[key] as { identifier: string }[]).map((x) => x.identifier) : [];
};
/** The identifiers waiting in this Mac's share queue, and the ones a to-do is parked under for a drop (R16b). */
const staged = () => listed("evidence-share.json", "tasks");
const parked = () => listed("moved-todos.json", "todos");
/** The tasks with a pack in the team repo. */
const packsIn = async (gitDir: string) => (await git(gitDir, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/pmx/evidence")).split("\n").filter(Boolean);

const task = (n: number, title: string): Task => ({
  id: `task-${n}`, identifier: `PMX-${n}`, title, description: "From a customer call.\n\npmx:source T1", url: `memory://task-${n}`,
  category: "spec", size: "S", status: "inbox", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: NOW.toISOString(),
});
/** A share staged with a copy of quotes, so its pack can be written without the call's file on this Mac. */
const share = (identifier: string, title: string) => ({ identifier, title, description: "From a customer call.\n\npmx:source T1", sources: ["T1"], quotes: QUOTES, quotesSwap: NAME_SWAP });

async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try { await run(); } finally { console.log = orig; }
  return logs;
}

describe("a task taken back or dropped never has its staged quotes written to the team repo (RUN-5)", () => {
  beforeEach(freshHome);

  /** A Mac with a Linear key (the memory tracker) and a team repo with a remote, with three tasks Linear has. */
  async function linearMac() {
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const tr = memoryTracker([task(1, "Spec export naming rules"), task(2, "Spec the bulk role editor"), task(3, "Spec the upload schedule")]);
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "mel" } as any });
    return { ctx, tr, origin: origin!, svc: async () => ({ tracker: tr }), move: (ref: string, to: any) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to) };
  }

  it("taking back a task whose push failed unstages its share, so the next pass writes only a live task's", async () => {
    const m = await linearMac();
    // PMX-3's share waits under the PENDING-… the Claude sync gave it its identifier for.
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "resolved.json"), JSON.stringify({ "PENDING-0A1B2C": { identifier: "PMX-3", at: NOW.toISOString() } }));
    await stageShares(m.ctx, [share("PMX-1", "Spec export naming rules"), share("PMX-2", "Spec the bulk role editor"), share("PENDING-0A1B2C", "Spec the upload schedule")]);
    // The team repo refused the push, so all three stay staged.
    const refusing = { list: async () => [], read: async () => null, writer: async () => null, write: async () => { throw new Error("the team repo refused the push"); } };
    expect((await shareEvidence(m.ctx, { say: "answer", store: refusing as any })).shared).toEqual([]);
    expect(await staged()).toEqual(["PMX-1", "PMX-2", "PENDING-0A1B2C"]);

    const back = await m.move("PMX-1", "private");
    expect(back.message).toBe("Now your private to-do: Spec export naming rules. PMX-1 is canceled in Linear. It keeps its source, so moving it to the team again brings it back.");
    await m.move("PMX-3", "private");
    expect(await staged()).toEqual(["PMX-2"]);
    // The copy of quotes the staged share held stays with the to-do, since the team repo never had a pack of it.
    expect(await quotesFor(back.todo!)).toEqual(COPY);

    // The next pass writes the live task's pack, and nothing of the two taken back.
    expect(await shareEvidence(m.ctx, { say: "answer" })).toEqual({ shared: ["PMX-2"], notices: [] });
    expect(await packsIn(m.origin)).toEqual(["PMX-2"]);
    expect(await staged()).toEqual([]);
  });

  it("a share whose task another Mac took back is never written, and the background run lets it go, saying why", async () => {
    const m = await linearMac();
    await stageShares(m.ctx, [share("PMX-1", "Spec export naming rules"), share("PMX-2", "Spec the bulk role editor")]);
    const home = process.env.PMX_HOME;

    // A teammate's Mac takes PMX-1 back to their to-dos: canceled in Linear, and marked dropped in the team repo.
    await freshHome();
    const repoB = join(await tmp("mac-b-"), "pmx");
    await execOk("git", ["clone", "-q", m.origin, repoB]);
    const other = await testCtx({ repo: repoB, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "ben", machineId: "m2" } as any });
    expect((await moveWork(other, async () => ({ tracker: m.tr }) as any, "PMX-1", "private")).message).toContain("PMX-1 is canceled in Linear.");
    process.env.PMX_HOME = home;

    // An approval's pass writes only the live task's pack, and lets go of nothing, so what's let go is always said.
    expect(await shareEvidence(m.ctx, { say: "answer" })).toEqual({ shared: ["PMX-2"], notices: [] });
    expect(await packsIn(m.origin)).toEqual(["PMX-2"]);
    expect(await staged()).toEqual(["PMX-1"]);

    // The background run lets it go unwritten, once, and says why.
    expect(await evidenceStep(m.ctx, m.svc)).toBe("stopped waiting to share the quotes of PMX-1: that task was taken back or dropped, so it's canceled in Linear and its quotes stay off your team's repo");
    expect(await staged()).toEqual([]);
    expect(await packsIn(m.origin)).toEqual(["PMX-2"]);
    expect(await evidenceStep(m.ctx, m.svc)).toBeNull();
  });

  it("the background run's pass still shares a live task's quotes", async () => {
    const m = await linearMac();
    await stageShares(m.ctx, [share("PMX-2", "Spec the bulk role editor")]);
    expect(await evidenceStep(m.ctx, m.svc)).toBe("shared the quotes of PMX-2 with your team");
    expect(await packsIn(m.origin)).toEqual(["PMX-2"]);
  });
});

describe("taking back a queued task gives back the to-do it came from, as it was (TODO-5, R16b)", () => {
  beforeEach(freshHome);

  const followed = {
    id: "uuid-PMX-12", identifier: "PMX-12", title: "Spec export naming rules",
    description: "Admins rename every export by hand before the weekly upload.\n\n**Follows PMX-9:** Is the export naming in scope?\n\npmx:source T1",
    url: "", priority: 0, createdAt: NOW.toISOString(), comments: { nodes: [] },
    labels: { nodes: [{ name: "inbox", parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }] },
  };

  /** A Mac on the Claude relay, with PMX-12 in Linear and its pack in the team repo. */
  async function relayMac() {
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [followed] }));
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "mel", todosToLinear: true } as any });
    await evidenceStore(ctx.repo).write({ put: [{ v: 1, task: "PMX-12", at: NOW.toISOString(), nameSwap: NAME_SWAP, sources: QUOTES }] }, "test: PMX-12's quotes");
    const tr = relayTracker(ctx.team, () => {}, () => NOW);
    return { ctx, tr, move: (ref: string, to: any, o: { kind?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, o) };
  }

  /**
   * A to-do taken back from PMX-12 (its kind, size, summary, Follows line, source and a copy of its quotes), moved to the
   * team again: only queued for Linear, parked for a drop, its share staged.
   */
  async function queuedFromTodo() {
    const m = await relayMac();
    await m.move("PMX-12", "private");
    const [todo] = (await loadTodos()).items;
    expect(todo).toMatchObject({ kind: "spec", size: "M", why: "Admins rename every export by hand before the weekly upload.", follows: "**Follows PMX-9:** Is the export naming in scope?", sources: ["T1"] });
    expect(await quotesFor(todo!.id)).toEqual(COPY);
    const made = await m.move(todo!.id, "product");
    expect(made.identifier).toMatch(/^PENDING-[0-9A-F]{6}$/);
    expect((await loadTodos()).items).toEqual([]);
    expect(await quotesFor(todo!.id)).toBeNull();
    expect(await parked()).toEqual([made.identifier]);
    expect(await staged()).toEqual([made.identifier]);
    return { ...m, todo: todo!, pending: made.identifier! };
  }

  it("on the page: the same to-do comes back, with its copy of quotes and its Follows line, and the PM is told so", async () => {
    const q = await queuedFromTodo();
    const r = await pipelineHandlers(q.ctx).move({ ref: q.pending, to: "private" });
    expect(r.status).toBe(200);
    expect((r.body as any).message).toBe(`"Spec export naming rules" is your private to-do again, as it was before you moved it. ${q.pending} hadn't reached Linear yet, so nothing of it goes there.`);
    expect((r.body as any).moved).toMatchObject({ from: "product", to: "private", todo: q.todo.id, identifier: null });
    // Its ID, due date, kind, size, note, sources and Follows line, as they were; no new to-do.
    expect((await loadTodos()).items).toEqual([q.todo]);
    expect(await quotesFor(q.todo.id)).toEqual(COPY);
    expect(await parked()).toEqual([]);
    expect(await staged()).toEqual([]);
    // Only PMX-12's take-back waits for the sync: nothing of the queued task.
    expect((await readOutbox()).ops.map((o) => o.kind)).toEqual(["comment", "rewrite"]);

    // Moving it to the team again carries the same Follows line and source, from the same copy of quotes.
    const again = await q.move(q.todo.id, "product");
    const op = (await readOutbox()).ops.find((o) => o.kind === "create-task") as any;
    expect(op.description).toContain("**Follows PMX-9:** Is the export naming in scope?");
    expect(op.description).toContain("pmx:source T1");
    expect(await staged()).toEqual([again.identifier]);
  });

  it("with `pmx linear outbox drop`, as before: the same to-do and its copy of quotes", async () => {
    const q = await queuedFromTodo();
    const cmd = commands.find((c) => c.name === "linear")!;
    const logs = await printed(() => cmd.run({ values: {}, positionals: ["outbox", "drop", q.pending], ask: {} as never, cliPath: "", ctx: async () => { throw new Error("not needed"); } } as never));
    expect(logs).toEqual([`- dropped create ${q.pending}`, "Nothing of these reaches Linear.", `"Spec export naming rules" is your private to-do again.`]);
    expect((await loadTodos()).items).toEqual([q.todo]);
    expect(await quotesFor(q.todo.id)).toEqual(COPY);
    expect(await parked()).toEqual([]);
    expect(await staged()).toEqual([]);
  });

  it("a queued task no to-do became still makes a new to-do, with its Follows line and the copy of quotes its share held", async () => {
    const m = await relayMac();
    const description = "Admins rename every export by hand.\n\n**Follows PMX-9:** Is the export naming in scope?\n\npmx:source T1";
    const made = await m.tr.createInbox({ title: "Compare export tools", description, category: "spec", size: "M", sources: ["T1"] });
    await stageShares(m.ctx, [{ identifier: made.identifier, title: made.title, description, sources: ["T1"], quotes: QUOTES, quotesSwap: NAME_SWAP }]);
    const back = await m.move(made.identifier, "private");
    expect(back.message).toBe(`Now your private to-do: Compare export tools. ${made.identifier} hadn't reached Linear yet, so nothing of it goes there. It keeps its source, so moving it to the team again brings it back.`);
    const [todo] = (await loadTodos()).items;
    expect(todo).toMatchObject({ id: back.todo, text: "Compare export tools", kind: "spec", size: "M", why: "Admins rename every export by hand.", follows: "**Follows PMX-9:** Is the export naming in scope?", sources: ["T1"] });
    expect(await quotesFor(todo!.id)).toEqual(COPY);
    expect(await staged()).toEqual([]);
    expect((await readOutbox()).ops).toEqual([]);
  });

  it("a to-do sent to Linear as your own and taken back is the same to-do, private again, and so is one then moved to the team", async () => {
    const m = await relayMac();
    const own = await addTodo({ text: "Book the design review", due: "2026-12-02" }, NOW);
    const sent = await m.move(own.id, "todo");
    expect(sent.identifier).toMatch(/^PENDING-/);
    const back = await m.move(sent.identifier!, "private");
    expect(back.message).toBe(`Back to your private to-dos: Book the design review. ${sent.identifier} hadn't reached Linear yet, so nothing of it goes there.`);
    expect((await loadTodos()).items).toEqual([{ ...own, linear: null }]);
    expect((await readOutbox()).ops).toEqual([]);

    // Sent as your own, then made a task for the team before the sync: parked with its Linear link, and back without it.
    const later = await addTodo({ text: "Spec the upload schedule", due: "2026-12-04" }, NOW);
    const queued = await m.move(later.id, "todo");
    await m.move(later.id, "product", { kind: "spec" });
    expect(await parked()).toEqual([queued.identifier]);
    const again = await m.move(queued.identifier!, "private");
    expect(again.message).toBe(`"Spec the upload schedule" is your private to-do again, as it was before you moved it. ${queued.identifier} hadn't reached Linear yet, so nothing of it goes there.`);
    expect((await loadTodos()).items).toEqual([{ ...own, linear: null }, { ...later, linear: null }]);
    expect(await parked()).toEqual([]);
    expect((await readOutbox()).ops).toEqual([]);
  });
});
