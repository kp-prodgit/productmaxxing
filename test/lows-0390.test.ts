// Small fixes from the end-to-end tests of 0.39.0: the accept rate leaves out redos of runs that went wrong (REV-3);
// dropping a queued task gives back the to-do it came from (R16b); a task taken back keeps its kind, size, summary, source
// IDs and follows link (TODO-5, R16c); the relay check doesn't warn about an issue it canceled (LINEAR-2); and the board
// and the review page leave out a draft another Mac decided, saying why on the review page (R13, PULL-14).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { pausedFrom } from "../ee/src/autopause.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { markStore } from "../src/lease/marks.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { pull } from "../src/pull/pull.js";
import { PAGE } from "../src/review/page.js";
import { acceptStats, decide, degradedRun, formatStats, loadQueue, type ReviewItem } from "../src/review/queue.js";
import { startReviewServer } from "../src/review/server.js";
import type { RunRecord } from "../src/run/record.js";
import { evidenceStore } from "../src/run/packs.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { giveBackTodos, moveWork } from "../src/todo/move.js";
import { addTodo, completeTodo, loadTodos, refreshTodos } from "../src/todo/todo.js";
import { checkRelay, dropOps, readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { commands } from "../src/commands/index.js";
import { memoryTracker, type Tracker } from "../src/tracker/types.js";
import { execOk } from "../src/core/exec.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "proj-1" };
const DRAFT = "# Draft\n\n## Problem\n\nManual sync [T1].\n\n## Evidence\n\n- CSV export [T1]\n- Requests [S1]\n\n## Validated by\n\nNot yet [T1].\n\n## Proposal\n\nSCIM.\n\n## Success metrics\n\n- Fast.\n\n## Open questions\n\n- IdPs?\n";

const node = (identifier: string, status: string, over: Record<string, unknown> = {}) => ({
  id: `uuid-${identifier}`, identifier, title: `Task ${identifier}`, description: "", url: `https://linear.app/x/${identifier}`, priority: 0, createdAt: "2026-11-18T09:00:00Z",
  labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }] }, comments: { nodes: [] }, ...over,
});
async function snapshot(issues: any[], syncedAt = NOW) {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: syncedAt.toISOString(), projectId: "proj-1", issues }));
}

describe("the accept rate leaves out redos of runs that went wrong (REV-3)", () => {
  beforeEach(freshHome);

  const record = (over: Partial<RunRecord> = {}): RunRecord => ({
    version: 1, provenance: "pmx-run", task: { id: "t", identifier: "PMX-9", category: "competitive-analysis", size: "M", sources: [] }, agent: "ana@m1", machine: "m1",
    runtime: { name: "claude-code", version: null }, model: "m", profile: { checksPassed: [], checksFailed: [], fingerprint: "" },
    skill: { name: "pmx-competitive", version: "1", commit: null, source: "bundled", allowlisted: false }, context: { claudeMdCommit: null, memoryCommit: null, baseCommit: "" },
    lease: { kind: "git", token: "" }, startedAt: NOW.toISOString(), durationMs: 1, tokens: null, costUsd: null, outcome: "ok", checklist: { ok: true, problems: [] },
    artifact: { kind: "file", ref: "outputs/competitive-analysis/PMX-9.md" }, ...over,
  });
  const item = (draft: string, over: Partial<RunRecord> = {}): Pick<ReviewItem, "files" | "record"> => ({ files: [{ path: "outputs/competitive-analysis/PMX-9.md", content: draft }], record: record(over) });
  const PLAIN = "# Compare\n\n## Summary\n\nGlobex wins on price [T1].\n";
  const CITED = "# Compare\n\n## Summary\n\nGlobex Teams costs $8 a seat [web: https://globex.example/pricing, 2026-11-20].\n";

  it("reads from the run record: a failed or partial run, a web run with no web, or one whose web calls were blocked and that cites no page", () => {
    expect(degradedRun({ files: [], record: null })).toBeNull();
    expect(degradedRun(item(PLAIN))).toBeNull();
    expect(degradedRun(item(PLAIN, { outcome: "failed" }))).toBe("failed");
    expect(degradedRun(item(PLAIN, { outcome: "capped" }))).toBe("partial");
    expect(degradedRun(item(PLAIN, { checklist: { ok: false, problems: ["missing heading Implications"] } }))).toBe("partial");
    // A web run whose web tools were denied, as drafts said before 0.38.0.
    expect(degradedRun(item(`${PLAIN}\nWebSearch and WebFetch were not available in this run, so every competitor column is unknown.\n`, { web: true, webBlocked: 0 }))).toBe("no-web");
    expect(degradedRun(item(PLAIN, { web: true, profile: { checksPassed: [], checksFailed: ["profile.web"], fingerprint: "" } }))).toBe("no-web");
    // The web guard blocked its calls and it cites no page; one that still cites a page counts.
    expect(degradedRun(item(PLAIN, { web: true, webBlocked: 3 }))).toBe("web-blocked");
    expect(degradedRun(item(CITED, { web: true, webBlocked: 3 }))).toBeNull();
    // A web run that had the web and cited nothing is the draft's own doing; so is a run without the web saying so.
    expect(degradedRun(item(PLAIN, { web: true, webBlocked: 0 }))).toBeNull();
    expect(degradedRun(item(`${PLAIN}\nThis run had no web access.\n`))).toBeNull();
  });

  it("an agent isn't paused for redos its runs caused: 1 accepted and 4 redos, 3 of them of degraded runs", () => {
    const team = { ...DEFAULT_TEAM, team: "t" } as TeamConfig;
    const now = new Date("2026-11-30T00:00:00Z");
    const verdict = (v: "accepted" | "redo", ts: string, degraded?: string): RunLogEntry =>
      ({ type: "verdict", agent: "a", machine: "m", ts, taskId: "x", category: "competitive-analysis", size: "M", verdict: v, reviewMinutes: 1, editSize: null, ...(degraded ? { degraded } : {}) }) as RunLogEntry;
    const entries = [verdict("accepted", "2026-11-20T00:00:00Z"), verdict("redo", "2026-11-21T00:00:00Z", "no-web"), verdict("redo", "2026-11-22T00:00:00Z", "web-blocked"),
      verdict("redo", "2026-11-23T00:00:00Z", "no-web"), verdict("redo", "2026-11-24T00:00:00Z")];
    const stats = acceptStats(entries, now, 30);
    expect(stats["competitive-analysis"]).toEqual({ accepted: 1, rejected: 0, redo: 1, total: 2, rate: 0.5, degraded: 3 });
    expect(pausedFrom(entries, team, now).size).toBe(0);
    expect(formatStats(stats)).toBe("competitive-analysis    50% accepted  (1 accepted, 1 redo, 0 rejected; 3 not counted, since their runs failed or got no web)");
    // The same redos with nothing wrong in their runs pause it, as before.
    const plain = entries.map((e) => ({ ...e, degraded: undefined }) as RunLogEntry);
    expect(pausedFrom(plain, team, now).get("competitive-analysis")).toMatch(/^accept rate 20% over 5 reviews/);
  });

  it("a redo of a draft whose web calls were blocked is logged as degraded; an accept never is", async () => {
    const { repo } = await pmxRepo();
    const tracker = memoryTracker([
      { id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync", description: "Why.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n- [S1] #feedback: third SCIM ask\n\npmx:source T1\npmx:source S1",
        url: "https://linear.app/x/PMX-14", category: "spec", size: "M", status: "ready", priority: 2, agent: null, sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z" },
    ]);
    const runtime = mockRuntime(async (o) => {
      const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), DRAFT);
      return { text: "Drafted.", costUsd: 0.3 };
    });
    const ctx = await testCtx({ repo, runtime, now: new Date(2026, 10, 4, 10) });
    const svc = await services(ctx, { tracker });
    expect((await pull(ctx, svc, { dryRun: false })).ran?.outcome).toBe("ok");
    const { items, host } = await loadQueue(ctx, svc);
    const it0 = { ...items[0]!, record: { ...items[0]!.record!, web: true, webBlocked: 2 } };
    await decide(ctx, svc, host, it0, "redo", { note: "Fill the competitor columns" });
    expect(await pull(ctx, svc, { dryRun: false })).toMatchObject({ ran: { outcome: "ok" } });
    const again = await loadQueue(ctx, svc);
    await decide(ctx, svc, again.host, { ...again.items[0]!, record: { ...again.items[0]!.record!, web: true, webBlocked: 2 } }, "accepted");
    const verdicts = (await new RunLogStore(ctx).entries()).filter((e): e is Extract<RunLogEntry, { type: "verdict" }> => e.type === "verdict");
    expect(verdicts.map((v) => [v.verdict, v.degraded])).toEqual([["redo", "web-blocked"], ["accepted", undefined]]);
  });
});

describe("a task taken back or dropped gives the to-do back (R16b, R16c, TODO-5)", () => {
  beforeEach(freshHome);

  async function relayed(o: { issues?: any[] } = {}) {
    await snapshot(o.issues ?? []);
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await tmp("my-calls-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme weekly\ndate: 2026-11-19T14:00:00Z\nparticipants: jane@acme.example, ana@us.example\n---\nJane: Our admins still export a CSV every Friday to sync users.\n\nAna: Sure, I'll take the EU part and write it up for everyone by Nov 30.");
    const runtime = mockRuntime((p) => JSON.stringify({ todos: [{ text: "Write up the EU sync need for the team", source: p.prompt.match(/id="([A-Z]\d+)"[^>]*title="Acme weekly"/)![1]!, why: "You said you would.", due: "2026-11-30" }] }));
    const ctx = await testCtx({
      repo, runtime, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any },
      personal: { handle: "ana", todosToLinear: true, identity: { names: ["Ana"], emails: ["ana@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null } } as any,
    });
    const tr = relayTracker(ctx.team, () => {}, () => NOW);
    return { ctx, move: (ref: string, to: any, opt: { kind?: string; size?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt) };
  }

  it("dropping a queued task a to-do became gives the to-do back as it was: words, due date, receipt and sources", async () => {
    const { ctx, move } = await relayed();
    await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
    const [before] = (await loadTodos()).items;
    expect(before).toMatchObject({ due: "2026-11-30", sources: [expect.any(String)] });
    expect(before!.receiptId).toMatch(/^todo-/);
    const made = await move(before!.id, "product", { kind: "spec" });
    expect(made.identifier).toMatch(/^PENDING-[0-9A-F]{6}$/);
    expect((await loadTodos()).items).toEqual([]);

    const r = await dropOps([made.identifier!]);
    expect(r.dropped.map((op) => op.kind)).toEqual(["create-task"]);
    expect(await giveBackTodos(r.dropped)).toEqual([before]);
    expect((await loadTodos()).items).toEqual([before]);
    // Said once: a second drop of nothing gives nothing back.
    expect(await giveBackTodos(r.dropped)).toEqual([]);
    expect((await loadTodos()).items).toHaveLength(1);
  });

  it("dropping a queued to-do sent to Linear as your own makes it private again; the command says so", async () => {
    const { move } = await relayed();
    const t = await addTodo({ text: "Book the design review", due: "2026-11-28" }, NOW);
    const sent = await move(t.id, "todo");
    expect((await loadTodos()).items[0]!.linear).toBe(sent.identifier);
    const back = await giveBackTodos((await dropOps([sent.identifier!])).dropped);
    expect(back).toEqual([{ ...t, linear: null }]);
    expect((await loadTodos()).items).toEqual([{ ...t, linear: null }]);
    expect((await readOutbox()).ops).toEqual([]);

    // `pmx linear outbox drop` gives a moved to-do back and says so.
    const typed = await addTodo({ text: "Spec the bulk role editor" }, NOW);
    const made = await move(typed.id, "product", { kind: "spec" });
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    try {
      const cmd = commands.find((c) => c.name === "linear")!;
      expect(await cmd.run({ values: {}, positionals: ["outbox", "drop", made.identifier!], ask: {} as never, cliPath: "", ctx: async () => { throw new Error("not needed"); } } as never)).toBe(0);
    } finally { console.log = orig; }
    expect(logs).toEqual([`- dropped create ${made.identifier}`, "Nothing of these reaches Linear.", `"Spec the bulk role editor" is your private to-do again.`]);
    expect((await loadTodos()).items.map((x) => x.id)).toEqual([t.id, typed.id]);
  });

  it("a task taken back keeps its kind, size and summary, so moving it to the team again needs no kind and keeps its size", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const summary = "Admins export users by hand every week, and EU admins need the data kept in the region.";
    const tr = memoryTracker([{
      id: "task-1", identifier: "PMX-1", title: "Compare user sync with rival tools", description: `${summary}\n\n**Sources:** a customer call (Nov 19). They stay on the PM's Mac.`,
      url: "memory://task-1", category: "competitive-analysis", size: "L", status: "inbox", priority: 0, agent: null, sources: [], prUrl: null, createdAt: NOW.toISOString(),
    }]);
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any }, personal: { handle: "ana" } as any });
    const move = (ref: string, to: any, opt: { kind?: string; size?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt);
    await move("PMX-1", "private");
    const [todo] = (await loadTodos()).items;
    expect(todo).toMatchObject({ kind: "competitive-analysis", size: "L", why: summary });

    const again = await move(todo!.id, "product");
    expect(again.message).toMatch(/^"Compare user sync with rival tools" is now PMX-2, a competitive-analysis task for the team\./);
    const made = tr.tasks.get("task-2")!;
    expect(made).toMatchObject({ category: "competitive-analysis", size: "L" });
    expect(made.description.split("\n\n")[0]).toBe(summary);
    expect(made.description).toContain("A task ana moved here from their own to-dos.");
    // And back again: the summary is the to-do's note once more; a kind the PM picks wins, the size stays.
    await move("PMX-2", "private");
    const [twice] = (await loadTodos()).items;
    expect(twice).toMatchObject({ kind: "competitive-analysis", size: "L", why: summary });
    await move(twice!.id, "product", { kind: "spec" });
    expect(tr.tasks.get("task-3")).toMatchObject({ category: "spec", size: "L" });
    // A to-do from no team task still needs its kind.
    const typed = await addTodo({ text: "Spec the bulk role editor" }, NOW);
    await expect(move(typed.id, "product")).rejects.toThrow(/^Pick a kind of work for the task: /);
  });

  it("on a Mac without the task's receipt, its source IDs and Follows link stay on the to-do and come back with it", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const description = [
      "Can Globex Support run the export for admins?", "",
      "**Follows PMX-9:** an open question its accepted draft left, in the team repo at `outputs/spec/PMX-9.md`.",
      "**Size S, not checked:** PMX doesn't size follow-ups. Change the size if the work is bigger.",
      "**Sources:** a customer call (Nov 19). They stay on the PM's Mac: `pmx explain synthesize-20261119T150000Z` there shows them.", "",
      "pmx:source T1",
    ].join("\n");
    const tr = memoryTracker([{
      id: "task-1", identifier: "PMX-1", title: "Ask Globex Support about the export", description, url: "memory://task-1", category: "spec", size: "S", status: "inbox",
      priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: NOW.toISOString(),
    }]);
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any }, personal: { handle: "ana" } as any });
    // The original task's shared quotes are in the team repo, as RUN-5 writes them.
    await evidenceStore(ctx.repo).write({ put: [{ v: 1, task: "PMX-9", at: NOW.toISOString(), nameSwap: 2, sources: [{ id: "T1", kind: "meeting", at: "2026-11-19", passages: ["Admins export a CSV every Friday."] }] }] }, "evidence: PMX-9");
    const move = (ref: string, to: any, opt: { kind?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt);

    const back = await move("PMX-1", "private");
    expect(back.message).toBe("Now your private to-do: Ask Globex Support about the export. PMX-1 is canceled in Linear. It keeps its source, so moving it to the team again brings it back.");
    const [todo] = (await loadTodos()).items;
    expect(todo).toMatchObject({
      sources: ["T1"], follows: "**Follows PMX-9:** an open question its accepted draft left, in the team repo at `outputs/spec/PMX-9.md`.", receiptId: "", kind: "spec", size: "S",
      why: "Can Globex Support run the export for admins?",
    });

    const again = await move(todo!.id, "product");
    expect(again.message).toBe(`"Ask Globex Support about the export" is now PMX-2, a spec task for the team, with the meeting it came from as its sources.`);
    const made = tr.tasks.get("task-2")!;
    expect(made.sources).toEqual(["T1"]);
    expect(made.description).toContain("\n**Follows PMX-9:** an open question its accepted draft left, in the team repo at `outputs/spec/PMX-9.md`.\n");
    expect(made.description).toContain("**Sources:** a source the team's task cited before it was taken back.");
    expect(made.description.split("\n").at(-1)).toBe("pmx:source T1");
    // The new task's quotes come from the task it follows up on, so any Mac's agent can draft it.
    expect((await evidenceStore(ctx.repo).read("PMX-2"))?.sources.map((s) => s.id)).toEqual(["T1"]);
  });

  it("a task's own shared quotes and its Follows line in the done form come back with it, though taking it back removed its pack", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const follows = "**Follows PMX-18, done Nov 26:** this is the new work its sources raised since.";
    const description = [
      "Admins still export users by hand every Friday, and the EU ones need the data kept in the region.", "",
      follows,
      "**Sources:** a meeting (Nov 25); a thread in an approved channel (Nov 26). They stay on the PM's Mac: `pmx explain synthesize-20261126T090000Z` there shows them.", "",
      "pmx:source T29", "pmx:source C32",
    ].join("\n");
    const tr = memoryTracker([{
      id: "task-1", identifier: "PMX-44", title: "Spec user sync for EU admins", description, url: "memory://task-1", category: "spec", size: "M", status: "inbox",
      priority: 0, agent: null, sources: ["T29", "C32"], prUrl: null, createdAt: NOW.toISOString(),
    }]);
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any }, personal: { handle: "ana" } as any });
    const passages = [
      { id: "T29", kind: "meeting" as const, at: "2026-11-25", passages: ["[PERSON-1]: We export the user list every Friday.", "[PERSON-1]: The EU admins need it kept in the region."] },
      { id: "C32", kind: "thread" as const, at: "2026-11-26", passages: ["[PERSON-2]: Third ask for SCIM this month."] },
    ];
    // The teammate's Mac that suggested it shared its quotes; this Mac hasn't its synthesis run.
    await evidenceStore(ctx.repo).write({ put: [{ v: 1, task: "PMX-44", at: NOW.toISOString(), nameSwap: 2, sources: passages }] }, "evidence: PMX-44");
    const move = (ref: string, to: any, opt: { kind?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt);

    await move("PMX-44", "private");
    // Taking it back removed its pack from the team repo, as before.
    expect(await evidenceStore(ctx.repo).read("PMX-44")).toBeNull();
    const [todo] = (await loadTodos()).items;
    expect(todo).toMatchObject({ sources: ["T29", "C32"], follows, kind: "spec", size: "M" });

    await move(todo!.id, "product");
    const made = tr.tasks.get("task-2")!;
    expect(made.description.split("\n")).toContain(follows);
    expect(made.sources).toEqual(["T29", "C32"]);
    const pack = await evidenceStore(ctx.repo).read("PMX-2");
    expect(pack?.sources).toEqual(passages);
    // The copy was this Mac's only until then: it's gone now.
    expect(JSON.parse(await readFile(join(process.env.PMX_HOME!, "staging", "taken-back-quotes.json"), "utf8")).todos).toEqual({});
  });

  it("a to-do's copy of its old task's quotes goes when the to-do is done", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const tr = memoryTracker([{
      id: "task-1", identifier: "PMX-44", title: "Spec user sync for EU admins", description: "Admins export users by hand.\n\npmx:source T29", url: "memory://task-1", category: "spec", size: "M",
      status: "inbox", priority: 0, agent: null, sources: ["T29"], prUrl: null, createdAt: NOW.toISOString(),
    }]);
    const ctx = await testCtx({ repo, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "ana" } as any });
    await evidenceStore(ctx.repo).write({ put: [{ v: 1, task: "PMX-44", at: NOW.toISOString(), nameSwap: 2, sources: [{ id: "T29", kind: "meeting", at: "2026-11-25", passages: ["[PERSON-1]: We export it every Friday."] }] }] }, "evidence: PMX-44");
    await moveWork(ctx, async () => ({ tracker: tr }) as any, "PMX-44", "private");
    const [todo] = (await loadTodos()).items;
    const kept = async () => Object.keys(JSON.parse(await readFile(join(process.env.PMX_HOME!, "staging", "taken-back-quotes.json"), "utf8")).todos);
    expect(await kept()).toEqual([todo!.id]);
    await completeTodo(todo!.id, NOW);
    expect(await kept()).toEqual([]);
  });
});

describe("pmx linear relay --check after a cancel (LINEAR-2)", () => {
  beforeEach(freshHome);
  const team = { ...DEFAULT_TEAM, team: "t", tracker: LINEAR } as unknown as TeamConfig;

  it("doesn't warn about an issue the batch canceled, and warns once about one that's missing", async () => {
    await snapshot([node("PMX-31", "inbox")]);
    const tr = relayTracker(team, () => {}, () => NOW);
    await tr.comment("PMX-31", "ana took this off the team's list to keep as a private to-do.");
    await tr.rewrite("PMX-31", { cancel: true });
    const made = await tr.createInbox({ title: "Spec the audit log export", description: "d", category: "spec", size: "M", sources: [] });
    await tr.comment(made.id, "A note.");
    const [note, cancel, create, other] = (await readOutbox()).ops;
    await writeFile(join(relayDir(), "results.json"), JSON.stringify([
      { id: note!.id, ok: true, identifier: "PMX-31" }, { id: cancel!.id, ok: true, identifier: "PMX-31" },
      { id: create!.id, ok: true, identifier: "PMX-40" }, { id: other!.id, ok: true, identifier: "PMX-40" },
    ]));
    // The sync's export leaves the canceled PMX-31 out, and hasn't got PMX-40 yet.
    await snapshot([]);
    const out = await checkRelay(team, NOW);
    expect(out.filter((l) => l.includes("reported done but isn't in the snapshot"))).toEqual(["  ⚠ PMX-40 was reported done but isn't in the snapshot; PMX will check again next sync."]);
  });
});

describe("a draft another Mac decided leaves the board and the review page (R13, PULL-14)", () => {
  beforeEach(freshHome);

  it("the board's Needs you leaves it out once the background run has fetched the mark, without fetching on each load", async () => {
    const { repo, origin } = await pmxRepo({ tracker: LINEAR as any }, { remote: true });
    const repoB = join(await tmp("mac-b-"), "pmx");
    await execOk("git", ["clone", "-q", origin!, repoB]);
    // Sam's copy of Linear, read at 09:00, still shows the leftover draft in review.
    await snapshot([node("PMX-14", "review"), node("PMX-15", "review")], new Date("2026-11-20T09:00:00Z"));
    const sam = await testCtx({ repo: repoB, now: NOW, team: { tracker: LINEAR as any }, personal: { handle: "sam", machineId: "m2" } });
    const drafts = async () => (await loadPipeline(sam, { level: "local", hours: 168, keychain: sam.keychain })).drafts.map((d) => d.identifier);
    expect(await drafts()).toEqual(["PMX-14", "PMX-15"]);

    // Ana's Mac accepted PMX-14 at 09:30, through her Claude sync.
    await markStore((await testCtx({ repo })).repo).update("PMX-14", () => ({ v: 1, task: "PMX-14", state: "done", at: "2026-11-20T09:30:00Z", by: "ana@m1", machine: "m1", landed: null }));
    // The board doesn't reach the team repo itself: until the background run fetches the marks, it shows what it had.
    expect(await drafts()).toEqual(["PMX-14", "PMX-15"]);
    await markStore(sam.repo).list();
    const board = await loadPipeline(sam, { level: "local", hours: 168, keychain: sam.keychain });
    expect(board.drafts.map((d) => d.identifier)).toEqual(["PMX-15"]);
    expect(board.needs.drafts).toBe(1);
  });

  it("pmx review --web says why a draft accepted on another Mac isn't there", async () => {
    const { repo } = await pmxRepo();
    const linear = memoryTracker([{ id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync", description: "Why.\n\npmx:source T1", url: "https://linear.app/x/PMX-14",
      category: "spec", size: "M", status: "review", priority: 2, agent: "sam@m2", sources: ["T1"], prUrl: "branch:pmx/task/PMX-14-sam", createdAt: "2026-11-01T00:00:00Z" }]);
    const copy: Tracker = { ...linear, async syncedAt() { return "2026-11-20T09:00:00Z"; } };
    const ctx = await testCtx({ repo, now: NOW, personal: { handle: "sam", machineId: "m2" } });
    await markStore(ctx.repo).update("PMX-14", () => ({ v: 1, task: "PMX-14", state: "done", at: "2026-11-20T09:30:00Z", by: "ana@m1", machine: "m1", landed: null }));
    const s = await startReviewServer(ctx, await services(ctx, { tracker: copy }), { all: true });
    try {
      const port = new URL(s.url).port;
      const token = new URL(s.url).searchParams.get("t")!;
      const q = await (await fetch(`http://127.0.0.1:${port}/api/queue`, { headers: { "x-pmx-token": token } })).json();
      expect(q.items).toEqual([]);
      expect(q.decided).toEqual([{ identifier: "PMX-14", text: expect.stringMatching(/^PMX-14 was accepted on another Mac \(ana@m1\) at \d\d:\d\d; this draft is no longer needed\.$/) }]);
    } finally {
      await s.close();
    }
    // The page lists them above the drafts, escaped like everything else.
    expect(PAGE).toContain(`decided.map((d) => '<p class="decided">' + escText(d.text) + '</p>')`);
  });
});
