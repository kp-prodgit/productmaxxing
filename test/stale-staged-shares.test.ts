// RUN-5 (end-to-end test 2026-11-27): a task queued for Linear through the Claude relay and taken back or dropped before
// Linear had it kept its staged share under a PENDING-… identifier that never resolves, so every later share pass looked
// at it. Now taking it back or dropping it removes the share at once, and the background run lets go of any left from
// before, once, saying so; a share whose task still waits in the outbox, or that has its identifier and waits to be
// written, stays.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { paths } from "../src/core/paths.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { NAME_SWAP } from "../src/run/packs.js";
import { evidenceStep, shareEvidence, stageShares } from "../src/run/share.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { moveWork } from "../src/todo/move.js";
import { loadTodos, refreshTodos } from "../src/todo/todo.js";
import { checkRelay, readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-27T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "proj-1" };
const TODO = "Write up the export naming need for the team";

/** The identifiers waiting in this Mac's share queue, and the ones a to-do is parked under for a drop (R16b). */
const listed = async (name: string, key: "tasks" | "todos") => {
  const raw = await readFile(join(paths.staging(), name), "utf8").catch(() => null);
  return raw ? (JSON.parse(raw)[key] as { identifier: string }[]).map((x) => x.identifier) : [];
};
const staged = () => listed("evidence-share.json", "tasks");
const parked = () => listed("moved-todos.json", "todos");

async function snapshot() {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [] }));
}

/**
 * A Mac on the Claude relay whose to-do from a customer call went to the team: only queued for Linear (PENDING-…), with
 * the call as its source, so its share is staged until the sync gives it an identifier.
 */
async function queuedFromTodo() {
  await snapshot();
  const { repo } = await pmxRepo({ internalDomains: ["ours.example"] });
  const dir = await tmp("calls-");
  await writeTranscript(dir, "check-in.md", "---\ntitle: Quarry Labs check-in\ndate: 2026-11-26T14:00:00Z\nparticipants: odile@quarrylabs.example, mel@ours.example\n---\nOdile: Our admins still rename every export by hand before the weekly upload.\n\nMel: Understood, I'll take the naming part and write it up for everyone by Dec 4.");
  const runtime = mockRuntime((p) => JSON.stringify({ todos: [{ text: TODO, source: p.prompt.match(/id="([A-Z]\d+)"[^>]*title="Quarry Labs check-in"/)![1]!, why: "You said you would.", due: "2026-12-04" }] }));
  const ctx = await testCtx({
    repo, runtime, now: NOW, team: { internalDomains: ["ours.example"], tracker: LINEAR as any },
    personal: { handle: "mel", identity: { names: ["Mel"], emails: ["mel@ours.example"] }, sources: { transcriptDirs: [dir], slackChannel: null } } as any,
  });
  const tr = relayTracker(ctx.team, () => {}, () => NOW);
  const move = (ref: string, to: any, o: { kind?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, o);
  await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
  const [todo] = (await loadTodos()).items;
  expect(todo!.sources).toEqual([expect.any(String)]);
  const made = await move(todo!.id, "product", { kind: "spec" });
  expect(made.identifier).toMatch(/^PENDING-[0-9A-F]{6}$/);
  expect(await staged()).toEqual([made.identifier]);
  expect(await parked()).toEqual([made.identifier]);
  return { ctx, todo: todo!, pending: made.identifier!, move };
}

async function printed(run: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try { await run(); } finally { console.log = orig; }
  return logs;
}

describe("a task that leaves the relay's queue before Linear has it leaves the share queue too (RUN-5, R16b)", () => {
  beforeEach(freshHome);

  it("taking it back to your to-dos removes its staged share, and the to-do parked for a drop", async () => {
    const q = await queuedFromTodo();
    const back = await q.move(q.pending, "private");
    expect(back.message).toContain(`${q.pending} hadn't reached Linear yet, so nothing of it goes there.`);
    expect((await readOutbox()).ops).toEqual([]);
    expect(await staged()).toEqual([]);
    expect(await parked()).toEqual([]);
    expect((await loadTodos()).items.map((t) => t.text)).toEqual([TODO]);
  });

  it("dropping it with `pmx linear outbox drop` removes its staged share and gives the to-do back", async () => {
    const q = await queuedFromTodo();
    const cmd = commands.find((c) => c.name === "linear")!;
    const logs = await printed(() => cmd.run({ values: {}, positionals: ["outbox", "drop", q.pending], ask: {} as never, cliPath: "", ctx: async () => { throw new Error("not needed"); } } as never));
    expect(logs).toEqual([`- dropped create ${q.pending}`, "Nothing of these reaches Linear.", `"${TODO}" is your private to-do again.`]);
    expect(await staged()).toEqual([]);
    expect(await parked()).toEqual([]);
    expect((await loadTodos()).items).toEqual([q.todo]);
  });

  it("the background run lets go of shares left from before, once, and keeps one still queued or waiting to be written", async () => {
    await snapshot();
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "mel" } as any });
    const tr = relayTracker(ctx.team, () => {}, () => NOW);
    const svc = async () => ({ tracker: tr });
    const queued = await tr.createInbox({ title: "Spec export naming rules", description: "From a customer call.", category: "spec", size: "S", sources: ["T1"] });
    // A copy of quotes, so a task with its identifier has something to write without the call's file on this Mac.
    const quotes = [{ id: "T1", kind: "meeting" as const, at: "2026-11-26", passages: ["Admins rename every export by hand before the weekly upload."] }];
    const share = (identifier: string) => ({ identifier, title: "Spec export naming rules", description: "From a customer call.", sources: ["T1"], quotes, quotesSwap: NAME_SWAP });
    // Left from before the fix: two tasks taken back before Linear had them, one the sync is about to create, and one
    // still in the outbox.
    await stageShares(ctx, [share("PENDING-0A1B2C"), share(queued.identifier), share("PENDING-3D4E5F"), share("PENDING-6A7B8C")]);

    // An approval's pass lets go of nothing: only the background run's does, and says so.
    const store = { list: async () => [], read: async () => null, writer: async () => null, write: async () => { throw new Error("not reached"); } };
    expect(await shareEvidence(ctx, { say: "answer", store })).toEqual({ shared: [], notices: [] });
    expect(await staged()).toEqual(["PENDING-0A1B2C", queued.identifier, "PENDING-3D4E5F", "PENDING-6A7B8C"]);

    // The sync created PENDING-6A7B8C as PMX-7: its pack waits to be written, and is.
    await writeFile(join(relayDir(), "resolved.json"), JSON.stringify({ "PENDING-6A7B8C": { identifier: "PMX-7", at: NOW.toISOString() } }));
    expect(await evidenceStep(ctx, svc)).toBe("shared the quotes of PMX-7 with your team; stopped waiting to share the quotes of PENDING-0A1B2C and PENDING-3D4E5F: those tasks were taken out of the queue for Linear before Linear had them, so they will never be in Linear");
    expect(await staged()).toEqual([queued.identifier]);
    // Once: the next run has nothing to say, and the queued task keeps its share.
    expect(await evidenceStep(ctx, svc)).toBeNull();
    expect(await staged()).toEqual([queued.identifier]);

    // The sync creates it, and its quotes are shared under its identifier.
    const op = (await readOutbox()).ops.find((o) => o.kind === "create-task")!;
    await writeFile(join(relayDir(), "results.json"), JSON.stringify([{ id: op.id, ok: true, identifier: "PMX-8", issueId: "uuid-8" }]));
    await checkRelay(ctx.team, NOW);
    expect(await evidenceStep(ctx, svc)).toBe("shared the quotes of PMX-8 with your team");
    expect(await staged()).toEqual([]);
  });

  it("a Mac with no outbox lets go of nothing before the week is up", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "mel" } as any });
    await stageShares(ctx, [{ identifier: "PENDING-9F8E7D", title: "Spec export naming rules", description: "d", sources: ["T1"] }]);
    const store = { list: async () => [], read: async () => null, writer: async () => null, write: async () => { throw new Error("not reached"); } };
    expect(await shareEvidence(ctx, { say: "notify", store, clear: true })).toEqual({ shared: [], notices: [] });
    expect(await staged()).toEqual(["PENDING-9F8E7D"]);
  });
});
