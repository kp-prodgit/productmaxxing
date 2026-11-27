// R6: finished work isn't suggested again as new. R16: a to-do moved to the team carries its meetings, and a task
// without sources doesn't block the sourced one. R15: moving a to-do to the team isn't gated on sending to-dos to Linear.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { services } from "../src/core/services.js";
import { checkOutput, skillMeta } from "../src/core/skillcheck.js";
import { loadSkill } from "../src/core/skills.js";
import type { Task } from "../src/core/types.js";
import { formatReceipt } from "../src/explain/format.js";
import { pipelineAct } from "../src/flow/pipeline-act.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { citationGaps, pull } from "../src/pull/pull.js";
import { webCitations } from "../src/run/environments.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { doneWithin } from "../src/synth/done.js";
import { approveProposals, CHECKED, dropProposals, formatProposals, readProposals, stageProposals } from "../src/synth/proposals.js";
import { synthesize } from "../src/synth/synthesize.js";
import { moveWork } from "../src/todo/move.js";
import { addTodo, loadTodos, refreshTodos } from "../src/todo/todo.js";
import { checkRelay, dropOps, formatOutbox, readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
const CALL = "Jane: Our admins still export a CSV every Friday to sync users.\n\nAna: Thanks, that helps.\n\nJane: The EU admins also need it to keep data in the EU region.";

const task = (n: number, over: Partial<Task> = {}): Task => ({
  id: `task-${n}`, identifier: `PMX-${n}`, title: `Task ${n}`, description: "Admins sync users by hand.\n\npmx:source T1", url: `memory://task-${n}`, category: "spec", size: "M",
  status: "done", priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-11-18T09:00:00Z", ...over,
});
const idOf = (prompt: string, title: string) => prompt.match(new RegExp(`id="([A-Z]\\d+)"[^>]*title="${title}"`))![1]!;

async function callsDir(): Promise<string> {
  const dir = await tmp("calls-");
  await writeTranscript(dir, "acme.md", `---\ntitle: Acme weekly\ndate: 2026-11-19T14:00:00Z\nparticipants: jane@acme.example, ana@us.example\n---\n${CALL}`);
  return dir;
}

describe("finished work isn't suggested again as new (R6, INPUT-2)", () => {
  beforeEach(freshHome);

  it("counts tasks done in the last 30 days: an accepted draft from its verdict, even before Linear shows it done", () => {
    const tasks = [
      task(1, { title: "Closed in Linear this week" }),
      task(2, { title: "Accepted this morning", status: "review", createdAt: "2026-09-01T00:00:00Z" }),
      task(3, { title: "Closed long ago", createdAt: "2026-09-01T00:00:00Z" }),
      task(4, { title: "Accepted, then sent back", status: "ready" }),
      task(5, { title: "Still open", status: "inbox" }),
    ];
    const verdict = (taskId: string, verdict: "accepted" | "redo", ts: string) => ({ type: "verdict" as const, taskId, category: "spec", size: "M", verdict, reviewMinutes: null, editSize: null, ts, agent: "bo@m2", machine: "m2" });
    const runs = [verdict("PMX-2", "accepted", "2026-11-20T08:00:00Z"), verdict("PMX-4", "accepted", "2026-11-19T08:00:00Z"), verdict("PMX-4", "redo", "2026-11-19T09:00:00Z")];
    expect(doneWithin(tasks, runs, NOW).map((d) => [d.identifier, d.at])).toEqual([["PMX-2", "2026-11-20"], ["PMX-1", "2026-11-18"]]);
  });

  it("a done task's repeat is recorded as done and heard again; new work after it is a follow-up that links it", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await callsDir();
    const runtime = mockRuntime((o) => {
      const id = idOf(o.prompt, "Acme weekly");
      const t = (title: string, rationale: string, more: Record<string, unknown> = {}) => ({ title, category: "spec", size: "M", rationale, sources: [id], support: { [id]: "The customer describes the weekly export." }, ...more });
      return JSON.stringify({ tasks: [
        // The same title as a task done this week, with no word from the model: PMX's own check catches it.
        t("Draft a one-pager for SCIM sync", "Admins sync users by hand every week."),
        // New work after a task accepted this morning, with something its description doesn't say.
        t("Keep synced user data in the EU region", "EU admins need synced user data to stay in the EU region before they can turn sync on.", { follows: "PMX-2" }),
        // The model says it follows, but nothing in it is new: it's the done task heard again.
        t("Weekly user export follow-up", "Admins sync users by hand every week.", { follows: "pmx-1" }),
      ] });
    });
    const tracker = memoryTracker([
      task(1, { title: "Draft a one-pager for SCIM sync" }),
      task(2, { title: "Spec SCIM provisioning", status: "review", description: "Admins sync users by hand.\n\npmx:source T1" }),
      task(3, { title: "Validate the pricing page", createdAt: "2026-09-01T00:00:00Z" }),
    ]);
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    await new RunLogStore(ctx).record({ type: "verdict", agent: "bo@m2", machine: "m2", taskId: "PMX-2", category: "spec", size: "M", verdict: "accepted", reviewMinutes: 3, editSize: 0, ts: "2026-11-20T08:00:00Z" });
    const svc = await services(ctx, { tracker });
    const r = await synthesize(ctx, svc, { days: 3, since: startOfDay(NOW, 2) });

    const prompt = runtime.calls[0]!.prompt;
    expect(prompt).toMatch(/## Done recently\nEach line is a task your team finished in the last 30 days[^\n]*\n- PMX-2 \(done Nov 20\): Spec SCIM provisioning\n- PMX-1 \(done Nov 18\): Draft a one-pager for SCIM sync\n/);
    expect(prompt).toContain('"follows": "<that ID>"');
    // Done before the window: not listed, and not open either.
    expect(prompt).not.toContain("Validate the pricing page");
    expect(prompt).not.toMatch(/## Already on the team's list[\s\S]*PMX-2/);

    expect(r.skipped).toEqual([
      "Draft a one-pager for SCIM sync: done as PMX-1 (Nov 18); heard again in 1 source(s)",
      "Weekly user export follow-up: done as PMX-1 (Nov 18); heard again in 1 source(s)",
    ]);
    expect(r.staged.map((s) => s.title)).toEqual(["Keep synced user data in the EU region"]);
    const [p] = await readProposals();
    expect(p!.follows).toEqual({ identifier: "PMX-2", path: "", url: "memory://task-2", where: "done", done: "2026-11-20" });
    expect(p!.description).toMatch(/^EU admins need synced user data[^\n]*\n\n\*\*Follows PMX-2, done Nov 20:\*\* this is the new work its sources raised since\.\n/);
    expect(formatProposals([p!])).toContain("follows PMX-2)");
    const receipt = (await readReceipt(p!.receipt))!;
    expect(receipt.synth!.tasks.map((t) => t.posted)).toEqual([{ duplicateOf: "PMX-1", done: "2026-11-18" }, { staged: p!.id }, { duplicateOf: "PMX-1", done: "2026-11-18" }]);
    expect(tracker.tasks.size).toBe(3);
  });

  it("approval refuses a done task's exact title, unless it's a follow-up that links that task", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW });
    const tracker = memoryTracker([task(1, { title: "Draft a one-pager for SCIM sync" })]);
    const svc = await services(ctx, { tracker });
    const base = { at: NOW.toISOString(), receipt: "synthesize-none", description: "Admins sync users by hand every week, and the EU ones need it kept in the region.", category: "spec", size: "S" as const, sources: [], from: [], checked: CHECKED };
    const [again] = await stageProposals([{ ...base, title: "Draft a one-pager for SCIM sync" }]);
    const r = await approveProposals(ctx, svc, [again!.id]);
    expect(r.duplicates).toEqual(["Draft a one-pager for SCIM sync (already done as PMX-1, Nov 18)"]);
    expect(r.posted).toEqual([]);
    expect(tracker.tasks.size).toBe(1);
    expect((await readReceipt("synthesize-none"))).toBeNull();
    // A follow-up that links the done task goes, even with its title.
    const [after] = await stageProposals([{ ...base, title: "Draft a one-pager for SCIM sync!", follows: { identifier: "PMX-1", path: "", url: null, where: "done", done: "2026-11-18" } }]);
    const f = await approveProposals(ctx, svc, [after!.id]);
    expect(f.duplicates).toEqual([]);
    expect(f.posted.map((x) => [x.identifier, x.title])).toEqual([["PMX-2", "Draft a one-pager for SCIM sync!"]]);
    expect(await readProposals()).toEqual([]);
  });

  it("a drop can say why; the run's receipt keeps the reason and pmx explain shows it", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await callsDir();
    const runtime = mockRuntime((o) => {
      const id = idOf(o.prompt, "Acme weekly");
      const t = (title: string) => ({ title, category: "spec", size: "S", rationale: "Admins sync users by hand every week.", sources: [id], support: { [id]: "The customer describes the weekly export." } });
      return JSON.stringify({ tasks: [t("Brief on weekly user exports"), t("Research admin console exports")] });
    });
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    await synthesize(ctx, await services(ctx, { tracker: memoryTracker([]) }), { days: 3, since: startOfDay(NOW, 2) });
    const [a, b] = await readProposals();
    await dropProposals([a!.id], NOW, "  done as\nPMX-5  ");
    // The page's Drop takes one too; a reason goes with a drop only.
    const h = pipelineHandlers(ctx);
    expect(await pipelineAct(h, "proposals", { action: "approve", ids: [b!.id], reason: "why" })).toEqual([400, { error: "reason is a few words, for a drop" }]);
    expect(await pipelineAct(h, "proposals", { action: "drop", ids: [b!.id], reason: "Already covered by the SSO work" })).toEqual([200, { message: 'Dropped "Research admin console exports": Already covered by the SSO work.' }]);

    const receipt = (await readReceipt((await listReceipts()).find((x) => x.startsWith("synthesize-"))!))!;
    expect(receipt.synth!.tasks.map((t) => t.posted)).toEqual([{ dropped: true, reason: "done as PMX-5" }, { dropped: true, reason: "Already covered by the SSO work" }]);
    const out = formatReceipt(receipt, []);
    expect(out).toContain("Brief on weekly user exports (spec, 1 source)");
    expect(out).toContain("      you dropped it: done as PMX-5");
    expect(out).toContain("      you dropped it: Already covered by the SSO work");
  });
});

describe("a to-do moved to the team (R16, R15, TODO-5)", () => {
  beforeEach(freshHome);

  async function setup(o: { optIn?: boolean; team?: Partial<TeamConfig>; crm?: string[] } = {}) {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await tmp("my-calls-");
    await writeTranscript(dir, "acme.md", `---\ntitle: Acme weekly\ndate: 2026-11-19T14:00:00Z\nparticipants: jane@acme.example, ana@us.example\n---\n${CALL}\n\nAna: Sure, I'll take the EU part and write it up for everyone.\n\nJane: Great, and could someone send over the security report?`);
    await writeTranscript(dir, "one-on-one.md", `---\ntitle: Ana and Bo\ndate: 2026-11-19T16:00:00Z\nparticipants: ana@us.example, bo@us.example\n---\nBo: Can you look at how other tools price seats?\n\nAna: I can look into how they price seats.`);
    const runtime = mockRuntime((o) => JSON.stringify({ todos: [
      { text: "Write up the EU sync need for the team", source: idOf(o.prompt, "Acme weekly"), why: "You said you would." },
      { text: "Compare seat pricing across the tools we lose deals to", source: idOf(o.prompt, "Ana and Bo"), why: "You said you would." },
      { text: "Send Jane the security report", source: idOf(o.prompt, "Acme weekly"), why: "The customer asked for it." },
    ] }));
    const crm = o.crm ? join(await tmp("crm-"), "names.txt") : null;
    if (crm) await writeFile(crm, o.crm!.join("\n"));
    const ctx = await testCtx({
      repo, runtime, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any, ...o.team },
      personal: { handle: "ana", todosToLinear: o.optIn ?? false, identity: { names: ["Ana"], emails: ["ana@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null }, crmNamesFile: crm } as any,
    });
    const tr = memoryTracker([]);
    const move = (ref: string, to: any, opt: { kind?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt);
    return { ctx, tr, move };
  }

  it("carries the meetings it came from as the task's sources, so an agent can draft it", async () => {
    const { ctx, tr, move } = await setup();
    await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
    const todo = (await loadTodos()).items.find((t) => t.text.startsWith("Write up"))!;
    expect(todo.sources).toHaveLength(1);
    const r = await move(todo.id, "product", { kind: "spec" });
    expect(r.message).toBe(`"Write up the EU sync need for the team" is now PMX-1, a spec task for the team, with the meeting it came from as its sources.`);
    const made = tr.tasks.get("task-1")!;
    expect(made.sources).toEqual(todo.sources);
    expect(made.description).toBe([
      "A task ana moved here from their own to-dos.", "",
      `**Sources:** a meeting (Nov 19). They stay on the PM's Mac: \`pmx explain ${todo.receiptId}\` there shows them.`, "",
      "PMX sent only these words: no meeting title, transcript, attendees or quotes.", "",
      `pmx:source ${todo.sources![0]}`,
    ].join("\n"));
    expect(made.description).not.toMatch(/Acme|Jane|CSV/);
    // Its to-do run is kept as long as a synthesis run behind a task, and the pull policy finds its source here.
    expect((await readReceipt(todo.receiptId))!.todo!.moved).toEqual([{ identifier: "PMX-1", sources: todo.sources, at: NOW.toISOString() }]);
    await tr.setStatus("task-1", "ready");
    expect(await citationGaps(ctx, await tr.list())).toEqual(new Map());
  });

  it("warns when agents can't draft it: a 1:1 stays with your to-dos, and a to-do from no meeting has no sources", async () => {
    const { ctx, tr, move } = await setup();
    await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
    const todo = (await loadTodos()).items.find((t) => t.text.startsWith("Compare"))!;
    const r = await move(todo.id, "product", { kind: "competitive-analysis" });
    expect(r.message).toBe(`"Compare seat pricing across the tools we lose deals to" is now PMX-1, a competitive-analysis task for the team. Agents can't draft PMX-1 yet: it names no sources agents can quote, since your team's privacy rules keep the meeting it came from away from agents, or its file is no longer in your folders, and a competitive-analysis draft must cite its sources 2 times. To have it drafted, wait for a meeting that raises it: synthesis then suggests it with sources, and approving that gives PMX-1 its sources.`);
    expect(tr.tasks.get("task-1")).toMatchObject({ sources: [] });
    expect(tr.tasks.get("task-1")!.description).not.toMatch(/Bo|pricing|pmx:source/);
    await tr.setStatus("task-1", "ready");
    expect(await citationGaps(ctx, await tr.list())).toEqual(new Map([["task-1", "it names no sources, and a competitive-analysis draft must cite its sources 2 times"]]));

    const typed = await addTodo({ text: "Spec the bulk role editor" }, NOW);
    expect((await move(typed.id, "product", { kind: "spec" })).message).toMatch(/^"Spec the bulk role editor" is now PMX-2, a spec task for the team\. Agents can't draft PMX-2 yet: it names no sources, and a spec draft must cite its sources 2 times\./);
  });

  it("on a team whose competitive analyses search the web, says another kind can be drafted without sources", async () => {
    const { move } = await setup({ team: { categories: { ...DEFAULT_TEAM.categories, "competitive-analysis": { skill: "pmx-competitive", web: true } } } });
    const t = await addTodo({ text: "Spec the bulk role editor" }, NOW);
    expect((await move(t.id, "product", { kind: "spec" })).message).toContain("To have it drafted, move it back (`pmx move PMX-1 private`) and make it a competitive-analysis, which can be drafted without them, or wait for a meeting that raises it");
    const c = await addTodo({ text: "Compare seat pricing across rival tools" }, NOW);
    expect((await move(c.id, "product", { kind: "competitive-analysis" })).message).toBe(`"Compare seat pricing across rival tools" is now PMX-2, a competitive-analysis task for the team.`);
  });

  it("its words go through the tracker guard first: a to-do naming someone from its meeting isn't sent, and says why", async () => {
    const { ctx, tr, move } = await setup();
    await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
    const named = (await loadTodos()).items.find((t) => t.text.startsWith("Send Jane"))!;
    await expect(move(named.id, "product", { kind: "spec" })).rejects.toThrow(`PMX didn't send it: its words name a person, which Linear never gets. Reword it with \`pmx todo edit ${named.id} "<new words>"\`, which keeps its meetings and due date, and move it again.`);
    // Nothing reached Linear, and the to-do is still the PM's.
    expect(tr.tasks.size).toBe(0);
    expect((await loadTodos()).items.map((t) => t.id)).toContain(named.id);
    // A clean to-do from the same meeting moves.
    const clean = (await loadTodos()).items.find((t) => t.text.startsWith("Write up"))!;
    expect(await move(clean.id, "product", { kind: "spec" })).toMatchObject({ to: "product", identifier: "PMX-1" });
  });

  it("a to-do naming someone on the CRM list isn't sent; one that doesn't moves", async () => {
    const { tr, move } = await setup({ crm: ["Dana Ruiz"] });
    const named = await addTodo({ text: "Ask Dana Ruiz for the signed order form" }, NOW);
    await expect(move(named.id, "product", { kind: "spec" })).rejects.toThrow(`PMX didn't send it: its words name a person, which Linear never gets. Reword it with \`pmx todo edit ${named.id} "<new words>"\`, which keeps its meetings and due date, and move it again.`);
    expect(tr.tasks.size).toBe(0);
    const clean = await addTodo({ text: "Spec the signed order form upload" }, NOW);
    expect(await move(clean.id, "product", { kind: "spec" })).toMatchObject({ to: "product", identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ title: "Spec the signed order form upload" });
    expect((await loadTodos()).items.map((t) => t.id)).toEqual([named.id]);
  });

  it("private → product works with sending to-dos to Linear off; only private → to-do in Linear needs it", async () => {
    const { tr, move } = await setup({ optIn: false });
    const t = await addTodo({ text: "Spec the bulk role editor" }, NOW);
    await expect(move(t.id, "todo")).rejects.toThrow(/Sending your own to-dos to Linear is off/);
    expect(await move(t.id, "product", { kind: "spec" })).toMatchObject({ from: "private", to: "product", identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ title: "Spec the bulk role editor", category: "spec" });
    expect((await loadTodos()).items).toEqual([]);
  });

  it("an open task with no sources doesn't block the sourced suggestion; approving it gives that task its sources", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await callsDir();
    const runtime = mockRuntime((o) => {
      const id = idOf(o.prompt, "Acme weekly");
      return JSON.stringify({ tasks: [{ title: "Compare user sync against rival tools", category: "competitive-analysis", size: "M", rationale: "Admins at Acme export users by hand every week, and EU admins need the data kept in the region.", sources: [id], support: { [id]: "The customer describes the weekly export." }, sameAs: "PMX-1" }] });
    });
    const tracker = memoryTracker([task(1, { title: "Compare user sync with rival tools", category: "competitive-analysis", status: "inbox", sources: [], description: "A task ana moved here from their own to-dos.\n\nPMX sent only these words: no meeting title, transcript, attendees or quotes." })]);
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const svc = await services(ctx, { tracker });
    const r = await synthesize(ctx, svc, { days: 3, since: startOfDay(NOW, 2) });
    expect(r.skipped).toEqual([]);
    const [p] = await readProposals();
    expect(p).toMatchObject({ title: "Compare user sync against rival tools", fills: "PMX-1" });
    expect(formatProposals([p!])).toContain("PMX-1 is open in Linear but names no sources, so agents can't draft it. Approving this gives PMX-1 this description");

    const a = await approveProposals(ctx, svc, [p!.id]);
    expect(a.posted).toEqual([{ id: p!.id, identifier: "PMX-1", title: "Compare user sync with rival tools", ready: false, filled: true }]);
    expect(a.checked).toEqual(['PMX-1 named no sources, so approving "Compare user sync against rival tools" gave it this task\'s description and its source instead of making a second task']);
    expect(tracker.tasks.size).toBe(1);
    const t = tracker.tasks.get("task-1")!;
    expect(t).toMatchObject({ title: "Compare user sync with rival tools", category: "competitive-analysis", sources: p!.sources });
    expect(t.description).toBe(p!.description);
    expect(t.description).toContain(`\`pmx explain ${p!.receipt}\``);
    await tracker.setStatus("task-1", "ready");
    expect(await citationGaps(ctx, await tracker.list())).toEqual(new Map());
  });
});

describe("taking work back from the team (R16b, R16c, TODO-5, LINEAR-2)", () => {
  beforeEach(freshHome);
  const node = (identifier: string) => ({
    id: `uuid-${identifier}`, identifier, title: `Task ${identifier}`, description: "", url: "", priority: 0, createdAt: NOW.toISOString(),
    labels: { nodes: [{ name: "inbox", parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }] }, comments: { nodes: [] },
  });
  async function relay(o: { optIn?: boolean } = {}) {
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: NOW.toISOString(), projectId: "proj-1", issues: [node("PMX-5")] }));
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "ana", todosToLinear: o.optIn ?? false } as any });
    const tr = relayTracker(ctx.team, () => {}, () => NOW);
    return { ctx, tr, move: (ref: string, to: any, opt = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt) };
  }

  it("a task only queued for Linear leaves the queue when it's taken back: nothing of it reaches Linear", async () => {
    const { move } = await relay({ optIn: true });
    const t = await addTodo({ text: "Spec the bulk role editor" }, NOW);
    const made = await move(t.id, "product", { kind: "spec" });
    expect(made.identifier).toMatch(/^PENDING-[0-9A-F]{6}$/);
    expect((await readOutbox()).ops.map((o) => o.kind)).toEqual(["create-task"]);
    const back = await move(made.identifier!, "private");
    // TODO-5 (R16b): the to-do it came from is back as it was, not a new one.
    expect(back.message).toBe(`"Spec the bulk role editor" is your private to-do again, as it was before you moved it. ${made.identifier} hadn't reached Linear yet, so nothing of it goes there.`);
    expect((await readOutbox()).ops).toEqual([]);
    expect((await loadTodos()).items).toEqual([t]);

    // The same for a to-do sent to Linear as your own and taken back before the sync.
    const c = await addTodo({ text: "Book the design review" }, NOW);
    const sent = await move(c.id, "todo");
    await move(sent.identifier!, "private");
    expect((await readOutbox()).ops).toEqual([]);
    // One Linear already has is still canceled there, with a comment.
    await move("PMX-5", "private");
    expect((await readOutbox()).ops.map((o) => o.kind)).toEqual(["comment", "rewrite"]);
  });

  it("a change Linear refused is said once with the way to drop it, and dropping it takes what depends on it", async () => {
    const { tr } = await relay();
    await tr.comment("PMX-5", "A note for the team.");
    const made = await tr.createInbox({ title: "Spec the bulk role editor", description: "d", category: "spec", size: "M", sources: [] });
    await tr.comment(made.id, "Another note.");
    const [note, create] = (await readOutbox()).ops;
    const refuse = async () => writeFile(join(relayDir(), "results.json"), JSON.stringify([{ id: note!.id, ok: false, error: "comments are locked on this issue" }]));
    await refuse();
    const first = await checkRelay(DEFAULT_TEAM_LINEAR());
    expect(first[0]).toBe("Applied 0 change(s) in Linear; 3 still waiting (Linear refused 1; `pmx linear outbox` lists them).");
    expect(first).toContain(`  ✘ Linear refused a comment on PMX-5: comments are locked on this issue. PMX tries again at the next sync, up to 3 times. To drop it now: pmx linear outbox drop ${note!.id.slice(0, 8)}`);
    await refuse();
    expect((await checkRelay(DEFAULT_TEAM_LINEAR())).join("\n")).not.toContain("✘ Linear refused");
    expect(await formatOutbox()).toContain(`  ${note!.id.slice(0, 8)}  a comment on PMX-5  (Linear refused it 2 times: comments are locked on this issue)`);

    expect(await dropOps([note!.id.slice(0, 8), "nope"])).toMatchObject({ dropped: [{ id: note!.id }], missing: ["nope"] });
    // A queued task drops with every change to it.
    const r = await dropOps([made.identifier]);
    expect(r.dropped.map((o) => o.kind)).toEqual(["create-task", "comment"]);
    expect(r.dropped[0]!.id).toBe(create!.id);
    expect((await readOutbox()).ops).toEqual([]);
    expect(await formatOutbox()).toBe("Nothing is waiting for Linear.");
  });

  it("a team task taken back as a to-do keeps its sources, so moving it to the team again brings them back", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await callsDir();
    const runtime = mockRuntime((o) => {
      const id = idOf(o.prompt, "Acme weekly");
      return JSON.stringify({ tasks: [{ title: "Spec user sync for EU admins", category: "spec", size: "M", rationale: "Admins at Acme export users by hand every week, and EU admins need the data kept in the region.", sources: [id], support: { [id]: "The customer describes the weekly export." } }] });
    });
    const tracker = memoryTracker([]);
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any }, personal: { handle: "ana", sources: { transcriptDirs: [dir], slackChannel: null } } as any });
    const svc = await services(ctx, { tracker });
    await synthesize(ctx, svc, { days: 3, since: startOfDay(NOW, 2) });
    const [p] = await readProposals();
    await approveProposals(ctx, svc, [p!.id]);
    const move = (ref: string, to: any, opt = {}) => moveWork(ctx, async () => svc, ref, to, opt);

    const back = await move("PMX-1", "private");
    expect(back.message).toBe("Now your private to-do: Spec user sync for EU admins. PMX-1 is canceled in Linear. It keeps its source, so moving it to the team again brings it back.");
    const todo = (await loadTodos()).items[0]!;
    expect(todo).toMatchObject({ source: { title: "Moved from PMX-1" }, receiptId: p!.receipt, sources: p!.sources });
    const again = await move(todo.id, "product", { kind: "spec" });
    expect(again.message).toBe(`"Spec user sync for EU admins" is now PMX-2, a spec task for the team, with the meeting it came from as its sources.`);
    expect(tracker.tasks.get("task-2")).toMatchObject({ sources: p!.sources });
    expect(tracker.tasks.get("task-2")!.description).toContain(`\`pmx explain ${p!.receipt}\``);
  });
});

const DEFAULT_TEAM_LINEAR = () => ({ ...DEFAULT_TEAM, team: "test", tracker: LINEAR }) as unknown as TeamConfig;

describe("a web run's page citations count toward the citations its draft must have (R16, RUN-6)", () => {
  beforeEach(freshHome);
  const WEB_TEAM: Partial<TeamConfig> = { categories: { ...DEFAULT_TEAM.categories, "competitive-analysis": { skill: "pmx-competitive", web: true } } };
  const DRAFT = [
    "# Compare user sync against rival tools", "",
    "## Summary", "", "Globex includes SCIM on every plan [web: https://globex.example/pricing, 2026-11-20].", "",
    "## Comparison", "", "| Capability | Us | Globex |", "|---|---|---|", "| SCIM | unknown | Included [web: https://globex.example/docs/scim, 2026-11-20] |", "",
    "## Switching bar", "", "*Assumption:* SCIM on every plan is what a buyer would switch for.", "",
    "## Implications", "", "- Whether to lead with SCIM. **PM decides**.", "",
  ].join("\n");

  it("the checklist counts them in a web run only, and the pull policy lists a sourceless competitive analysis there", async () => {
    const { repo } = await pmxRepo();
    const meta = skillMeta((await loadSkill(repo, "pmx-competitive")).text);
    expect(webCitations(DRAFT)).toBe(2);
    expect(webCitations("[web: https://globex.example/pricing] and [web]")).toBe(0);
    expect(checkOutput(meta, DRAFT, new Set()).problems).toEqual(["only 0 citations, need 2"]);
    expect(checkOutput(meta, DRAFT, new Set(), { web: webCitations(DRAFT) })).toEqual({ ok: true, problems: [], citations: 2 });

    const sourceless = task(1, { title: "Compare user sync against rival tools", category: "competitive-analysis", status: "ready", sources: [], description: "Compare it." });
    const off = await testCtx({ repo });
    expect(await citationGaps(off, [sourceless])).toEqual(new Map([["task-1", "it names no sources, and a competitive-analysis draft must cite its sources 2 times"]]));
    const on = await testCtx({ repo, team: WEB_TEAM });
    expect(await citationGaps(on, [sourceless])).toEqual(new Map());
  });

  it("a web run's draft that cites only pages passes its checklist", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const runtime = mockRuntime(async (o) => {
      const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), DRAFT);
      return { text: "Drafted.", costUsd: 0.1 };
    });
    const ctx = await testCtx({ repo, runtime, team: WEB_TEAM });
    const tracker = memoryTracker([task(1, { title: "Compare user sync against rival tools", category: "competitive-analysis", status: "ready", sources: [], description: "Compare it." })]);
    const r = await pull(ctx, await services(ctx, { tracker }), { dryRun: false });
    expect(runtime.calls[0]!.web).toBe(true);
    expect(r.ran).toMatchObject({ outcome: "ok" });
  });
});
