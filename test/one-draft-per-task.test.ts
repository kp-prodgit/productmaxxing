// N6 (branch test of #104): one PM's Mac drafted a task and moved it to review; another Mac, whose Linear sync was
// older, still saw it Ready and drafted it again, since a claim lasts only while an agent runs. PULL-14: each task's
// last PMX step is marked in the team repo, where every Mac reads it whatever its copy of Linear says.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { execOk } from "../src/core/exec.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { MARK_KEEP_MS, takenText, tendMarks } from "../src/lease/marks.js";
import { claim, plan, pull } from "../src/pull/pull.js";
import { loadQueue, recordDecision } from "../src/review/queue.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { memoryTracker, type Tracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";

const DRAFT = `# Draft a one-pager for SCIM sync

## Problem

Admins sync users by hand [T1].

## Evidence

- Weekly CSV export [T1]
- Recurring requests [S1]

## Validated by

Not validated yet [T1].

## Proposal

SCIM 2.0 provisioning.

## Success metrics

- Minutes, not hours.

## Open questions

- Which IdPs first?
`;

const drafting = () =>
  mockRuntime(async (o) => {
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)?.[1];
    if (out) {
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), DRAFT);
    }
    return { text: "Drafted.", costUsd: 0.2 };
  });

const readyTask = (): Task => ({
  id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync",
  description: "Admins sync users by hand.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n- [S1] #feedback: third SCIM ask\n\npmx:source T1\npmx:source S1",
  url: "https://linear.app/acme/issue/PMX-14", category: "spec", size: "M", status: "ready", priority: 2, agent: null,
  sources: ["T1", "S1"], prUrl: null, createdAt: "2026-01-01T00:00:00Z",
});

/** A day well before this machine's clock, in local time: the team's run log stamps entries with the real time. */
const at = (hm: string, day = 5) => { const [h, m] = hm.split(":").map(Number); return new Date(2026, 0, day, h, m); };

/**
 * A Mac's copy of Linear, as its last Claude sync read it: the tasks as they were then. Its own changes go to Linear
 * (in life, at its next sync), so the copy doesn't show them.
 */
function copyOf(linear: ReturnType<typeof memoryTracker>, seen: Task[], syncedAt: Date): Tracker {
  return {
    ...linear,
    async syncedAt() { return syncedAt.toISOString(); },
    async list(o) { return structuredClone(seen).filter((t) => !o?.status || (t.status !== null && o.status.includes(t.status))); },
    async get(id) { const t = seen.find((x) => x.id === id || x.identifier === id); if (!t) throw new Error(`No task ${id}.`); return structuredClone(t); },
  };
}

/** Two PMs' Macs on one team repo (a temp bare origin) and one Linear. Sam's copy of Linear is from 06:00. */
async function twoMacs() {
  const homeA = await freshHome();
  const { repo, origin } = await pmxRepo({}, { remote: true });
  const linear = memoryTracker([readyTask()]);
  const before = structuredClone(await linear.list());
  const rtA = drafting();
  const ana = async (now: Date, tracker: Tracker = linear) => {
    process.env.PMX_HOME = homeA;
    const ctx = await testCtx({ repo, runtime: rtA, now });
    return { ctx, svc: await services(ctx, { tracker }) };
  };
  const homeB = await freshHome();
  const repoB = join(await tmp("mac-b-"), "pmx");
  await execOk("git", ["clone", "-q", origin!, repoB]);
  await git(repoB, "config", "user.name", "Test");
  await git(repoB, "config", "user.email", "test@example.com");
  const rtB = drafting();
  const sam = async (now: Date, copy: Tracker) => {
    process.env.PMX_HOME = homeB;
    const ctx = await testCtx({ repo: repoB, runtime: rtB, now, personal: { handle: "sam", machineId: "m2" } });
    return { ctx, svc: await services(ctx, { tracker: copy }) };
  };
  const mark = async () => {
    const r = await git(origin!, "for-each-ref", "--format=%(contents:subject)", "refs/pmx/task-state/PMX-14");
    return r ? JSON.parse(r) : null;
  };
  return { origin: origin!, linear, before, rtA, rtB, ana, sam, mark };
}

describe("a task drafted on one Mac isn't drafted again on another (N6, PULL-14)", () => {
  beforeEach(freshHome);

  it("a Mac whose copy of Linear is older doesn't draft it; after a redo it does", async () => {
    const m = await twoMacs();
    const stale = copyOf(m.linear, m.before, at("06:00"));

    // Ana's Mac drafts it at 06:58 and moves it to review; the team repo has the step.
    const a = await m.ana(at("06:58"));
    expect((await pull(a.ctx, a.svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    expect(m.linear.tasks.get("lin-1")!.status).toBe("review");
    expect(await m.mark()).toMatchObject({ v: 1, task: "PMX-14", state: "review", by: "ana@m1", machine: "m1", at: at("06:58").toISOString(), landed: at("06:58").toISOString() });
    expect(await a.svc.lease.list()).toEqual([]);

    // Sam's Mac at 07:04 still sees it Ready, and says why it doesn't take it.
    const b = await m.sam(at("07:04"), stale);
    const sel = await plan(b.ctx, b.svc);
    expect(sel.decisions.map((d) => [d.task.identifier, d.ok, d.why])).toEqual([["PMX-14", false, "another Mac (ana@m1) drafted it at 06:58; waiting for review"]]);
    expect(sel.candidates).toEqual([]);
    expect((await pull(b.ctx, b.svc, { dryRun: false })).ran).toBeNull();
    // Even a pull that listed it before the draft ended reads the mark again once it wins the lease, and lets go.
    expect(await claim(b.ctx, b.svc, readyTask())).toEqual({ ok: false, holder: "team repo", expiresAt: "", reason: "another Mac (ana@m1) drafted it at 06:58; waiting for review" });
    expect(await b.svc.lease.list()).toEqual([]);
    expect(m.rtB.calls).toHaveLength(0);
    expect(m.linear.tasks.get("lin-1")!.status).toBe("review");

    // Ana asks for a redo: the mark says Ready again, so any Mac may take it, Sam's with its old copy too.
    const a2 = await m.ana(at("07:30"));
    const { items, host } = await loadQueue(a2.ctx, a2.svc);
    await recordDecision(a2.ctx, a2.svc, host, items[0]!, "redo", { note: "Name the identity providers." });
    expect(await m.mark()).toMatchObject({ state: "ready", by: "ana@m1", at: at("07:30").toISOString() });
    const b2 = await m.sam(at("07:40"), stale);
    expect((await plan(b2.ctx, b2.svc)).candidates.map((t) => t.identifier)).toEqual(["PMX-14"]);
    expect((await pull(b2.ctx, b2.svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    expect(m.rtB.calls).toHaveLength(1);
    // Sam's Mac reads Linear from a copy, so its step lands at its next sync.
    expect(await m.mark()).toMatchObject({ state: "review", by: "sam@m2", landed: null });
  });

  it("an accepted draft isn't drafted again either", async () => {
    const m = await twoMacs();
    const a = await m.ana(at("06:58"));
    await pull(a.ctx, a.svc, { dryRun: false });
    const a2 = await m.ana(at("07:30"));
    const { items, host } = await loadQueue(a2.ctx, a2.svc);
    await recordDecision(a2.ctx, a2.svc, host, items[0]!, "accepted");
    expect(m.linear.tasks.get("lin-1")!.status).toBe("done");
    const b = await m.sam(at("07:45"), copyOf(m.linear, m.before, at("06:00")));
    expect((await plan(b.ctx, b.svc)).decisions[0]!.why).toBe("another Mac (ana@m1) marked it done at 07:30");
    expect((await pull(b.ctx, b.svc, { dryRun: false })).ran).toBeNull();
    expect(m.rtB.calls).toHaveLength(0);
  });

  it("without a mark (a teammate's Mac on an older PMX), the team's run log stops it too", async () => {
    const m = await twoMacs();
    const a = await m.ana(at("06:58"));
    await pull(a.ctx, a.svc, { dryRun: false });
    await git(m.origin, "update-ref", "-d", "refs/pmx/task-state/PMX-14");
    expect(await m.mark()).toBeNull();
    const b = await m.sam(at("07:04"), copyOf(m.linear, m.before, at("06:00")));
    const run = (await new RunLogStore(b.ctx).entries()).find((e) => e.type === "run")!;
    expect((await plan(b.ctx, b.svc)).decisions[0]!.why).toBe(takenText("review", "ana@m1", run.ts, { agent: "sam@m2", now: b.ctx.now() }));
    expect((await pull(b.ctx, b.svc, { dryRun: false })).ran).toBeNull();
    expect(m.rtB.calls).toHaveLength(0);
  });

  it("a newer copy that doesn't show the draft yet waits until the drafting Mac's sync has put it in Linear", async () => {
    const m = await twoMacs();
    // Ana's Mac also reads Linear through a Claude sync: its step reaches Linear at its next sync.
    let anaSynced = at("06:00");
    const anaView: Tracker = { ...m.linear, async syncedAt() { return anaSynced.toISOString(); } };
    const a = await m.ana(at("06:58"), anaView);
    await pull(a.ctx, a.svc, { dryRun: false });
    expect(await m.mark()).toMatchObject({ state: "review", landed: null });

    // Sam's sync at 07:01 came before Ana's, so Linear still said Ready.
    const b = await m.sam(at("07:04"), copyOf(m.linear, m.before, at("07:01")));
    expect((await plan(b.ctx, b.svc)).decisions[0]!.why).toBe("another Mac (ana@m1) drafted it at 06:58; waiting for review");

    // Ana's sync at 07:30 applies it: her Mac marks it landed.
    anaSynced = at("07:30");
    const a2 = await m.ana(at("07:31"), anaView);
    expect(await tendMarks(a2.ctx, anaView)).toBe(1);
    expect(await m.mark()).toMatchObject({ state: "review", landed: at("07:30").toISOString() });
    // Another Mac never marks Ana's step landed.
    expect(await tendMarks(b.ctx, copyOf(m.linear, m.before, at("09:00")))).toBe(0);

    // A copy from before that still waits; one from after it shows Linear as it is, so its Ready (a person moved the
    // task back by hand) is followed.
    const b2 = await m.sam(at("07:40"), copyOf(m.linear, m.before, at("07:20")));
    expect((await plan(b2.ctx, b2.svc)).candidates).toEqual([]);
    const b3 = await m.sam(at("07:50"), copyOf(m.linear, m.before, at("07:45")));
    expect((await plan(b3.ctx, b3.svc)).candidates.map((t) => t.identifier)).toEqual(["PMX-14"]);

    // Marks go after a week, from any Mac.
    const later = await m.sam(new Date(at("06:58").getTime() + MARK_KEEP_MS + 60000), copyOf(m.linear, m.before, at("07:45")));
    expect(await tendMarks(later.ctx, later.svc.tracker)).toBe(1);
    expect(await m.mark()).toBeNull();
  });
});
