// RUN-5 backfill: tasks approved before evidence packs have none, so every other Mac's agent skipped them ("quoted only
// on the Mac that suggested it"). The Mac with their synthesis run now writes their packs from its background run, a
// few at a time, with the same builder and checks as an approval. FOLLOW-1: a call from a draft another PM suggested
// says who suggested it.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANARY_MARKER } from "../src/core/canary.js";
import { execOk } from "../src/core/exec.js";
import { Git } from "../src/core/git.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { services } from "../src/core/services.js";
import { loadState, updateState } from "../src/core/state.js";
import { AUTO_STEPS, type UpgradeDeps } from "../src/core/upgrade.js";
import { plan, pull } from "../src/pull/pull.js";
import { markStore } from "../src/lease/marks.js";
import { loadQueue, recordDecision } from "../src/review/queue.js";
import { taskEvidence } from "../src/run/evidence.js";
import { evidenceStore } from "../src/run/packs.js";
import { BACKFILL_MAX, backfillEvidence, evidenceStep, removePackNow, storeFor, tidyEvidence } from "../src/run/share.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { approveProposals, readProposals } from "../src/synth/proposals.js";
import { synthesize } from "../src/synth/synthesize.js";
import { moveWork } from "../src/todo/move.js";
import { keepTodo, loadTodos } from "../src/todo/todo.js";
import { memoryTracker, type Tracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

/** A spec that passes its checklist and leaves one call to the PM. */
const SPEC = (id: string) => `# Spec SCIM provisioning

## Problem

Admins copy users into the product by hand every week [${id}].

## Evidence

- A weekly CSV export that takes two hours [${id}]

## Validated by

Not yet.

## Proposal

SCIM 2.0 provisioning.

## Success metrics

- No weekly export.

## Implications

- **Pricing for small teams.** Options: SCIM in every plan, or only in Business. **PM decides:** whether to include SCIM in every plan.

## Open questions

None: the evidence settles it [${id}].
`;

/** The cited call. Its last turn has a sentence the privacy rules cut (pay). */
const CALL = [
  "---", "title: Acme weekly", "participants: jane@acme.com, ana@us.com", "---",
  "Jane: Every Friday we export a CSV of our users and paste it into your admin screen.",
  "",
  "Ana: How long does that take?",
  "",
  "Jane: About two hours. SCIM provisioning would fix it, our identity provider supports it.",
  "",
  "Ana: Thanks. Separately, my salary review is on Monday so I may be slow to reply.",
].join("\n");

const team = { internalDomains: ["us.com"], tracker: { kind: "linear" as const, teamKey: "PMX", projectId: "pmx-1" } };

function runtime() {
  return mockRuntime(async (o) => {
    if (!o.tools.length) {
      const items = [...o.prompt.matchAll(/<item id="([A-Z]\d+)"[^>]*>\n([\s\S]*?)<\/item>/g)];
      const id = items.find((m) => m[2]!.includes("SCIM"))![1]!;
      return JSON.stringify({ tasks: [{ title: "Spec SCIM provisioning", category: "spec", size: "M", rationale: "Admins keep user lists in sync by hand.", sources: [id], support: { [id]: "The customer exports users weekly." } }] });
    }
    const task = await readFile(join(o.cwd, ".pmx/tmp/task.md"), "utf8");
    const id = task.match(/### \[([A-Z]\d+)\]/)?.[1] ?? "T1";
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(o.cwd, out)), { recursive: true });
    await writeFile(join(o.cwd, out), SPEC(id));
    return { text: "Drafted.", costUsd: 0.1 };
  });
}

/** The Mac that suggested the work (Ana's): a customer call, and synthesis staging one proposal. */
async function suggestingMac() {
  const { repo, origin } = await pmxRepo({ internalDomains: ["us.com"] }, { remote: true });
  const dir = await tmp("t-");
  await writeTranscript(dir, "acme.md", CALL);
  const rt = runtime();
  const personal = { sources: { transcriptDirs: [dir], slackChannel: null } };
  const ctx = await testCtx({ repo, runtime: rt, team, personal });
  const tracker = memoryTracker();
  const svc = await services(ctx, { tracker });
  await synthesize(ctx, svc, { days: 7 });
  return { repo, origin: origin!, dir, rt, ctx, tracker, svc, personal, home: process.env.PMX_HOME! };
}

/** Approved the way PMX did before evidence packs: straight to the tracker, nothing staged for the team repo. */
async function approvedBefore(tracker: ReturnType<typeof memoryTracker>, n = 1) {
  const [p] = await readProposals();
  for (let i = 0; i < n; i++) await tracker.createInbox({ title: n === 1 ? p!.title : `${p!.title} ${i + 1}`, description: p!.description, category: p!.category, size: p!.size, sources: p!.sources, ready: true });
}

const byId = (tracker: ReturnType<typeof memoryTracker>, identifier: string) => [...tracker.tasks.values()].find((t) => t.identifier === identifier)!;
const packIn = async (gitDir: string, id: string): Promise<any> => JSON.parse(await execOk("git", ["--git-dir", gitDir, "show", `refs/pmx/evidence/${id}:${id}.json`]));
const packsIn = async (gitDir: string) => (await git(gitDir, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/pmx/evidence")).split("\n").filter(Boolean).sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
const ids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `PMX-${from + i}`);

async function clone(origin: string, name: string): Promise<string> {
  const repo = join(await tmp(`${name}-`), "pmx");
  await execOk("git", ["clone", "-q", origin, repo]);
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  return repo;
}

describe("evidence packs for tasks approved before them (RUN-5 backfill)", () => {
  beforeEach(freshHome);

  it("the Mac with the task's synthesis run writes the same pack an approval would, and another Mac's agent then drafts it", async () => {
    const a = await suggestingMac();
    await approvedBefore(a.tracker);
    expect(await packsIn(a.origin)).toEqual([]);
    const mainBefore = await git(a.repo, "rev-parse", "main");

    // Sam's Mac skips it, as the test rig saw, and can't write its pack: it has no synthesis run for it.
    const homeB = await freshHome();
    const b = await testCtx({ repo: await clone(a.origin, "mac-b"), runtime: a.rt, team, personal: { handle: "sam", machineId: "m2" } });
    const svcB = await services(b, { tracker: a.tracker });
    expect((await plan(b, svcB)).decisions.map((d) => d.why).join(" ")).toMatch(/its sources are quoted only on the Mac that suggested it/);
    expect(await backfillEvidence(b, svcB)).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await packsIn(a.origin)).toEqual([]);

    // Ana's Mac writes it.
    process.env.PMX_HOME = a.home;
    expect(await backfillEvidence(a.ctx, a.svc)).toEqual({ shared: ["PMX-1"], notices: [], more: 0, failed: 0 });
    const pack = await packIn(a.origin, "PMX-1");
    const task = byId(a.tracker, "PMX-1");
    // Exactly what this Mac's agent is shown, as at approval: the cited passages, filtered and redacted, nothing else.
    expect(pack).toEqual({ v: 1, task: "PMX-1", at: a.ctx.now().toISOString(), nameSwap: 3, companies: ["acme"], sources: (await taskEvidence(a.ctx, task)).sources });
    const text = JSON.stringify(pack);
    expect(text).toContain("SCIM provisioning would fix it");
    expect(text).not.toMatch(/salary|Acme weekly|jane@acme\.com|synthesize-\d/);
    expect(await evidenceStore(new Git(a.repo)).writer("PMX-1")).toBe("ana");
    // Not on main, and the checkout untouched.
    expect(await git(a.repo, "rev-parse", "main")).toBe(mainBefore);
    expect(await git(a.repo, "status", "--porcelain")).toBe("");
    const logged = (await new RunLogStore(a.ctx).entries()).filter((e) => e.type === "evidence");
    expect(logged).toEqual([expect.objectContaining({ taskId: "PMX-1", action: "shared" })]);

    // Running it again changes nothing.
    const tip = await git(a.origin, "rev-parse", "refs/pmx/evidence/PMX-1");
    expect(await backfillEvidence(a.ctx, a.svc)).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await git(a.origin, "rev-parse", "refs/pmx/evidence/PMX-1")).toBe(tip);

    // Sam's agent now drafts it.
    process.env.PMX_HOME = homeB;
    expect((await plan(b, svcB)).candidates.map((t) => t.identifier)).toEqual(["PMX-1"]);
    expect((await pull(b, svcB, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
  });

  it("only that Mac's open tasks: in the backlog, Ready or blocked; not done, being drafted, in review, dropped or a teammate's", async () => {
    const a = await suggestingMac();
    await approvedBefore(a.tracker, 8);
    const set = async (identifier: string, status: "inbox" | "blocked" | "running" | "review" | "done") => a.tracker.setStatus(byId(a.tracker, identifier).id, status);
    await set("PMX-1", "inbox");
    await set("PMX-3", "blocked");
    await set("PMX-4", "running");
    await set("PMX-5", "review");
    await set("PMX-6", "done");
    await a.tracker.rewrite(byId(a.tracker, "PMX-7").id, { cancel: true });
    // Closed in Linear while PMX's label still says Ready.
    a.tracker.workflow.get(byId(a.tracker, "PMX-8").id)!.type = "completed";
    // A teammate's task (its synthesis run isn't here), and one that cites nothing.
    await a.tracker.createInbox({ title: "A teammate's task", description: "Sources: a call. `pmx explain synthesize-20261101T100000Z` there shows them.", category: "spec", size: "S", sources: ["T1"], ready: true });
    await a.tracker.createInbox({ title: "Cites nothing", description: byId(a.tracker, "PMX-1").description, category: "spec", size: "S", sources: [], ready: true });

    expect((await backfillEvidence(a.ctx, a.svc)).shared).toEqual(["PMX-1", "PMX-2", "PMX-3"]);
    expect(await packsIn(a.origin)).toEqual(["PMX-1", "PMX-2", "PMX-3"]);
  });

  it("writes at most a set number a run, and the next runs go on where it stopped", async () => {
    expect(BACKFILL_MAX).toBe(20);
    const a = await suggestingMac();
    await approvedBefore(a.tracker, 5);
    expect(await backfillEvidence(a.ctx, a.svc, { max: 2 })).toEqual({ shared: ["PMX-1", "PMX-2"], notices: [], more: 3, failed: 0 });
    expect(await backfillEvidence(a.ctx, a.svc, { max: 2 })).toEqual({ shared: ["PMX-3", "PMX-4"], notices: [], more: 1, failed: 0 });
    expect(await backfillEvidence(a.ctx, a.svc, { max: 2 })).toEqual({ shared: ["PMX-5"], notices: [], more: 0, failed: 0 });
    expect(await backfillEvidence(a.ctx, a.svc, { max: 2 })).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await packsIn(a.origin)).toEqual(ids(1, 5));
  });

  it("the update makes the background run look at once; it writes 20 a run, goes on at the next and then rests a day", async () => {
    const a = await suggestingMac();
    await approvedBefore(a.tracker, 21);
    const step = AUTO_STEPS.find((s) => s.id === "evidence-backfill")!;
    expect(step).toMatchObject({ since: "0.37.0", title: "This Mac's open tasks share their quotes with your team" });
    expect(step.interactiveOnly).toBeFalsy();
    const deps = {} as UpgradeDeps;
    const day = 24 * 3600000;
    const ctxAt = (ms: number) => testCtx({ repo: a.repo, team, personal: a.personal, now: new Date(a.ctx.now().getTime() + ms) });
    const step$ = (ctx: Awaited<ReturnType<typeof ctxAt>>) => evidenceStep(ctx, async () => a.svc);

    // A look that finished a moment ago (a build from before the release, say): nothing is due yet.
    await updateState((s) => { s.evidenceBackfill = { at: a.ctx.now().toISOString(), due: false }; });
    expect(await step$(a.ctx)).toBeNull();
    expect(await packsIn(a.origin)).toEqual([]);

    // The update asks for it, once.
    expect(await step.run(deps)).toBe("the next background run shares the quotes of this Mac's open tasks that have none yet with your team");
    expect(await step.run(deps)).toBeNull();
    expect((await loadState()).evidenceBackfill!.due).toBe(true);

    const first = await ctxAt(60000);
    expect(await step$(first)).toBe(`shared the quotes of ${ids(1, 19).join(", ")} and PMX-20 with your team; 1 more task's quotes go to your team at the next background run`);
    expect((await loadState()).evidenceBackfill).toEqual({ at: first.now().toISOString(), due: true });
    const second = await ctxAt(120000);
    expect(await step$(second)).toBe("shared the quotes of PMX-21 with your team");
    expect((await loadState()).evidenceBackfill).toEqual({ at: second.now().toISOString(), due: false });
    expect(await packsIn(a.origin)).toEqual(ids(1, 21));

    // A task approved before packs that turns up later is picked up by the daily look.
    await approvedBefore(a.tracker, 1);
    expect(await step$(await ctxAt(3600000))).toBeNull();
    expect(await step$(await ctxAt(day + 180000))).toBe("shared the quotes of PMX-22 with your team");
  });

  it("refuses a pack with a canary, says so once, tries again each run, and shares it once the rule holds", async () => {
    const a = await suggestingMac();
    await approvedBefore(a.tracker);
    // A privacy rule let a test meeting's words through: nothing of it may reach the team repo.
    await writeTranscript(a.dir, "acme.md", CALL.replace("SCIM provisioning would fix it", `SCIM provisioning would fix it ${CANARY_MARKER}`));
    const r = await backfillEvidence(a.ctx, a.svc);
    expect(r).toMatchObject({ shared: [], more: 0, failed: 1 });
    expect(r.notices).toEqual(["PMX couldn't share PMX-1's quotes with your team: a privacy rule let PMX's test meeting through, so nothing was sent; run `pmx doctor`. Until it does, only this Mac's agent can draft it; PMX tries again in its next background run."]);
    expect(await packsIn(a.origin)).toEqual([]);
    // Told once; tried again at the next run, and the background run stays due.
    expect(await backfillEvidence(a.ctx, a.svc)).toEqual({ shared: [], notices: [], more: 0, failed: 1 });
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBeNull();
    expect((await loadState()).evidenceBackfill!.due).toBe(true);

    // A team repo it can't reach waits for the next run, quietly.
    await writeTranscript(a.dir, "acme.md", CALL);
    await git(a.repo, "remote", "set-url", "origin", join(dirname(a.origin), "gone.git"));
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBeNull();
    expect((await loadState()).evidenceBackfill!.due).toBe(true);
    await git(a.repo, "remote", "set-url", "origin", a.origin);
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBe("shared the quotes of PMX-1 with your team");
    expect((await loadState()).evidenceBackfill!.due).toBe(false);
    expect((await packIn(a.origin, "PMX-1")).sources[0].passages.join(" ")).not.toContain(CANARY_MARKER);
  });

  it("a task with nothing to quote here is remembered, not read again every run, and looked at again after a week", async () => {
    const a = await suggestingMac();
    await approvedBefore(a.tracker);
    await rm(join(a.dir, "acme.md"));
    expect(await backfillEvidence(a.ctx, a.svc)).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    await writeTranscript(a.dir, "acme.md", CALL);
    expect((await backfillEvidence(a.ctx, a.svc)).shared).toEqual([]);
    const later = await testCtx({ repo: a.repo, team, personal: a.personal, now: new Date(a.ctx.now().getTime() + 8 * 86400000) });
    expect((await backfillEvidence(later, a.svc)).shared).toEqual(["PMX-1"]);
  });

  it("leaves a task the share queue still holds to it", async () => {
    const a = await suggestingMac();
    // Approved now, but its share fails: the queue keeps it, retries it and has told the PM.
    const good = a.origin;
    await git(a.repo, "remote", "set-url", "origin", join(dirname(good), "gone.git"));
    expect((await approveProposals(a.ctx, a.svc, ["1"], { start: true })).notShared).toHaveLength(1);
    await git(a.repo, "remote", "set-url", "origin", good);
    expect(await backfillEvidence(a.ctx, a.svc)).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBe("shared the quotes of PMX-1 with your team");
  });
});

describe("a removed pack stays removed (N7, RUN-5)", () => {
  beforeEach(freshHome);

  it("a Mac with an older copy of Linear doesn't share it again, and any Mac removes one that comes back", async () => {
    const a = await suggestingMac();
    await approvedBefore(a.tracker);
    expect((await backfillEvidence(a.ctx, a.svc)).shared).toEqual(["PMX-1"]);
    const pack = await packIn(a.origin, "PMX-1");
    // Ana's copy of Linear, from her last sync before Sam's Mac finished the task.
    const before = structuredClone(await a.tracker.list());
    const anaCopy: Tracker = { ...a.tracker, async syncedAt() { return a.ctx.now().toISOString(); }, async list() { return structuredClone(before); } };

    // Sam's Mac drafts it from the pack and accepts it, which removes the pack at once: its tidy has nothing left.
    const homeB = await freshHome();
    const later = new Date(a.ctx.now().getTime() + 3600000);
    const b = await testCtx({ repo: await clone(a.origin, "mac-b"), runtime: a.rt, team, personal: { handle: "sam", machineId: "m2" }, now: later });
    const svcB = await services(b, { tracker: a.tracker });
    expect((await pull(b, svcB, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const { items, host } = await loadQueue(b, svcB);
    await recordDecision(b, svcB, host, items[0]!, "accepted");
    expect(await packsIn(a.origin)).toEqual([]);
    expect(await tidyEvidence(b, svcB)).toEqual([]);
    // The removal is in the team repo, with the task's mark, not only in a run log.
    const mark = JSON.parse(await git(a.origin, "for-each-ref", "--format=%(contents:subject)", "refs/pmx/task-state/PMX-1"));
    expect(mark).toMatchObject({ state: "done", by: "sam@m2", packRemovedAt: later.toISOString() });

    // Ana's backfill still sees the task open, and shares nothing.
    process.env.PMX_HOME = a.home;
    expect(await backfillEvidence(a.ctx, { tracker: anaCopy })).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await packsIn(a.origin)).toEqual([]);

    // A Mac on an older PMX writes it again, after Sam's background run listed the team's packs: its tidy lists them
    // again and removes it.
    process.env.PMX_HOME = homeB;
    const storeB = storeFor(b);
    expect(await storeB.list()).toEqual([]);
    await evidenceStore(new Git(a.repo)).write({ put: [pack] }, "evidence: quotes for PMX-1");
    expect(await packsIn(a.origin)).toEqual(["PMX-1"]);
    expect(await tidyEvidence(b, svcB, storeB)).toEqual([{ id: "PMX-1", why: "done" }]);
    expect(await packsIn(a.origin)).toEqual([]);

    // And Ana's tidy removes it too, though her copy of Linear still shows the task Ready.
    process.env.PMX_HOME = a.home;
    await evidenceStore(new Git(a.repo)).write({ put: [pack] }, "evidence: quotes for PMX-1");
    expect(await tidyEvidence(a.ctx, { tracker: anaCopy })).toEqual([{ id: "PMX-1", why: "done" }]);
    expect(await packsIn(a.origin)).toEqual([]);
    const removed = (await new RunLogStore(a.ctx).entries()).filter((e) => e.type === "evidence" && e.action === "removed");
    expect(removed.map((e) => e.agent)).toEqual(["sam@m2", "sam@m2", "ana@m1"]);
  });
});

describe("an accepted or dropped task's quotes leave the team repo at once (RUN-5)", () => {
  beforeEach(freshHome);

  const markIn = async (gitDir: string, id: string) => JSON.parse(await git(gitDir, "for-each-ref", "--format=%(contents:subject)", `refs/pmx/task-state/${id}`));
  const evidenceLog = async (ctx: Awaited<ReturnType<typeof testCtx>>) => (await new RunLogStore(ctx).entries()).filter((e) => e.type === "evidence").map((e: any) => [e.taskId, e.action, e.reason ?? null, e.agent]);
  /** A Mac's copy of Linear from before a step another Mac took: the tasks as they were. */
  const copyFrom = async (a: Awaited<ReturnType<typeof suggestingMac>>): Promise<Tracker> => {
    const before = structuredClone(await a.tracker.list());
    return { ...a.tracker, async syncedAt() { return a.ctx.now().toISOString(); }, async list() { return structuredClone(before); } };
  };

  it("an accept on another PM's Mac removes the pack with its tombstone, after its follow-ups read it, and no backfill shares it again", async () => {
    const a = await suggestingMac();
    await approveProposals(a.ctx, a.svc, ["1"], { start: true });
    expect(await packsIn(a.origin)).toEqual(["PMX-1"]);
    const anaCopy = await copyFrom(a);

    const homeB = await freshHome();
    const later = new Date(a.ctx.now().getTime() + 3600000);
    const b = await testCtx({ repo: await clone(a.origin, "mac-b"), runtime: a.rt, team, personal: { handle: "sam", machineId: "m2" }, now: later });
    const svcB = await services(b, { tracker: a.tracker });
    expect((await pull(b, svcB, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const { items, host } = await loadQueue(b, svcB);
    const d = await recordDecision(b, svcB, host, items[0]!, "accepted");
    // The accept says what it always did; its follow-ups still read who suggested the task from the pack.
    expect(d.message).toBe("PMX-1 accepted. 1 decision added to your to-dos.");
    expect(d.followUps).toMatchObject({ suggestedBy: "ana" });
    expect(byId(a.tracker, "PMX-1").status).toBe("done");

    // Gone from the team repo now, not at the next clean-up, with the tombstone in the task's mark and a run log line.
    expect(await packsIn(a.origin)).toEqual([]);
    expect(await markIn(a.origin, "PMX-1")).toMatchObject({ state: "done", by: "sam@m2", at: later.toISOString(), packRemovedAt: later.toISOString() });
    expect(await evidenceLog(b)).toEqual([["PMX-1", "shared", null, "ana@m1"], ["PMX-1", "removed", "done", "sam@m2"]]);
    expect(await tidyEvidence(b, svcB)).toEqual([]);

    // Ana's backfill, on a copy of Linear from before the accept that still shows the task Ready, shares nothing.
    process.env.PMX_HOME = a.home;
    expect(await backfillEvidence(a.ctx, { tracker: anaCopy })).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await packsIn(a.origin)).toEqual([]);
    // Nor does her background run, which leaves the tombstone as it is.
    await updateState((s) => { s.evidenceBackfill = { at: a.ctx.now().toISOString(), due: true }; });
    expect(await evidenceStep(a.ctx, async () => ({ tracker: anaCopy }))).toBeNull();
    expect(await packsIn(a.origin)).toEqual([]);
    expect(await markIn(a.origin, "PMX-1")).toMatchObject({ state: "done", packRemovedAt: later.toISOString() });
  });

  it("an accept whose removal the team repo refuses still stands, and the clean-up removes the quotes later", async () => {
    const a = await suggestingMac();
    await approveProposals(a.ctx, a.svc, ["1"], { start: true });
    expect((await pull(a.ctx, a.svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    // The team repo takes every push but the removal of a pack.
    const hook = join(a.origin, "hooks", "pre-receive");
    await mkdir(dirname(hook), { recursive: true });
    await writeFile(hook, [
      "#!/bin/sh",
      "while read old new ref; do",
      '  case "$ref" in refs/pmx/evidence/*) [ "$new" = 0000000000000000000000000000000000000000 ] && { echo "not today" >&2; exit 1; } ;; esac',
      "done",
      "exit 0",
    ].join("\n") + "\n", { mode: 0o755 });

    const { items, host } = await loadQueue(a.ctx, a.svc);
    const d = await recordDecision(a.ctx, a.svc, host, items[0]!, "accepted");
    expect(d.message).toBe("PMX-1 accepted. 1 decision added to your to-dos.");
    expect(byId(a.tracker, "PMX-1").status).toBe("done");
    expect((await new RunLogStore(a.ctx).entries()).filter((e) => e.type === "verdict").map((e: any) => [e.taskId, e.verdict])).toEqual([["PMX-1", "accepted"]]);
    // The quotes are still there, and the mark says done but records no removal.
    expect(await packsIn(a.origin)).toEqual(["PMX-1"]);
    const mark = await markIn(a.origin, "PMX-1");
    expect(mark).toMatchObject({ state: "done", by: "ana@m1" });
    expect(mark).not.toHaveProperty("packRemovedAt");
    expect(await evidenceLog(a.ctx)).toEqual([["PMX-1", "shared", null, "ana@m1"]]);

    // Once the team repo takes it, the clean-up removes it by the task's mark, with the tombstone.
    await rm(hook);
    const later = await testCtx({ repo: a.repo, team, personal: a.personal, now: new Date(a.ctx.now().getTime() + 3 * 3600000) });
    expect(await tidyEvidence(later, a.svc)).toEqual([{ id: "PMX-1", why: "done" }]);
    expect(await packsIn(a.origin)).toEqual([]);
    expect(await markIn(a.origin, "PMX-1")).toMatchObject({ state: "done", packRemovedAt: later.now().toISOString() });
  });

  it("a reject keeps the quotes, since the task may be drafted again; taking the task off the team's list removes them at once", async () => {
    const a = await suggestingMac();
    await approveProposals(a.ctx, a.svc, ["1"], { start: true });
    expect((await pull(a.ctx, a.svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const { items, host } = await loadQueue(a.ctx, a.svc);
    await recordDecision(a.ctx, a.svc, host, items[0]!, "rejected", { note: "Wrong customer." });
    expect(await packsIn(a.origin)).toEqual(["PMX-1"]);
    expect(await markIn(a.origin, "PMX-1")).not.toHaveProperty("packRemovedAt");

    // A teammate moves it back to Ready by hand, and Ana takes it off the team's list as a private to-do: dropped.
    await a.tracker.setStatus(byId(a.tracker, "PMX-1").id, "ready");
    const samCopy = await copyFrom(a);
    const m = await moveWork(a.ctx, async () => a.svc, "PMX-1", "private");
    // R16c: the to-do keeps the task's source, so moving it back brings it.
    expect(m.message).toBe("Now your private to-do: Spec SCIM provisioning. PMX-1 is canceled in Linear. It keeps its source, so moving it to the team again brings it back.");
    expect(await packsIn(a.origin)).toEqual([]);
    expect(await markIn(a.origin, "PMX-1")).toMatchObject({ state: "dropped", by: "ana@m1", packRemovedAt: a.ctx.now().toISOString() });
    expect(await evidenceLog(a.ctx)).toEqual([["PMX-1", "shared", null, "ana@m1"], ["PMX-1", "removed", "dropped", "ana@m1"]]);
    // A backfill on a copy of Linear from before the move still sees it Ready, and shares nothing.
    expect(await backfillEvidence(a.ctx, { tracker: samCopy })).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
    expect(await packsIn(a.origin)).toEqual([]);
  });

  it("a team without a tracker, or a task with no pack, has nothing to remove and gets no tombstone", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const none = await testCtx({ repo });
    expect(await removePackNow(none, memoryTracker(), "PMX-1", "done")).toBe(false);
    const ctx = await testCtx({ repo, team });
    await markStore(ctx.repo).update("PMX-2", () => ({ v: 1, task: "PMX-2", state: "done", at: ctx.now().toISOString(), by: ctx.agent, machine: "m1", landed: null }));
    expect(await removePackNow(ctx, memoryTracker(), "PMX-2", "done")).toBe(false);
    expect(await markStore(ctx.repo).read("PMX-2")).not.toHaveProperty("packRemovedAt");
    expect(await removePackNow(ctx, memoryTracker(), "PENDING-1A2B3C", "done")).toBe(false);
  });
});

describe("who suggested a task whose draft another PM accepted (FOLLOW-1)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });
  beforeEach(freshHome);

  it("the calls go to the accepting PM, and each says who suggested the task", async () => {
    const a = await suggestingMac();
    await approveProposals(a.ctx, a.svc, ["1"], { start: true });

    await freshHome();
    const b = await testCtx({ repo: await clone(a.origin, "mac-b"), runtime: a.rt, team, personal: { handle: "sam", machineId: "m2" } });
    const svcB = await services(b, { tracker: a.tracker });
    expect((await pull(b, svcB, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const { items, host } = await loadQueue(b, svcB);
    const d = await recordDecision(b, svcB, host, items[0]!, "accepted");
    expect(d.message).toBe("PMX-1 accepted. 1 decision added to your to-dos.");
    expect(d.followUps).toMatchObject({ suggestedBy: "ana" });
    expect((await loadTodos()).items.map((t) => [t.text, t.source])).toEqual([
      ["Decide whether to include SCIM in every plan (PMX-1)", { title: "From PMX-1's accepted draft, outputs/spec/PMX-1.md", at: b.now().toISOString().slice(0, 10), keys: [], suggestedBy: "ana" }],
    ]);
  });

  it("a PM accepting a task their own Mac suggested gets no such line", async () => {
    const a = await suggestingMac();
    await approveProposals(a.ctx, a.svc, ["1"], { start: true });
    expect((await pull(a.ctx, a.svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const { items, host } = await loadQueue(a.ctx, a.svc);
    const d = await recordDecision(a.ctx, a.svc, host, items[0]!, "accepted");
    expect(d.followUps?.todos).toHaveLength(1);
    expect(d.followUps?.suggestedBy).toBeUndefined();
    expect((await loadTodos()).items[0]!.source).not.toHaveProperty("suggestedBy");
  });

  it("PMX's page says so in the to-do's details", { timeout: 30000 }, async () => {
    const now = new Date();
    ui = await openBoard({
      hash: "anytime", now,
      before: async () => {
        await keepTodo({ text: "Decide whether to include SCIM in every plan (PMX-1)", source: { title: "From PMX-1's accepted draft, outputs/spec/PMX-1.md", at: now.toISOString().slice(0, 10), keys: [], suggestedBy: "sam" } }, now);
        await keepTodo({ text: "Ping legal" }, now);
      },
    });
    const open = async (text: string) => {
      await ui!.until(() => ui!.text().includes(text), "the to-do");
      const row = ui!.all("main [role=listitem]").find((r) => r.textContent?.includes(text))!;
      await ui!.click([...row.querySelectorAll("button")].find((b) => b.textContent === "Open")!);
      return ui!.until(() => ui!.$("#sheet.open"), "the to-do's details");
    };
    const sheet = await open("Decide whether to include SCIM");
    expect(sheet.querySelector("#suggested-by")!.textContent).toBe("Suggested by sam; decisions went to you.");
    expect(sheet.textContent).toContain("From PMX-1's accepted draft, outputs/spec/PMX-1.md.");
    expect((await open("Ping legal")).querySelector("#suggested-by")).toBeNull();
  });
});
