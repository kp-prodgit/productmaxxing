import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { plan, pull } from "../src/pull/pull.js";
import { failStreaks } from "../src/pull/failures.js";
import { pickPassages, taskEvidence } from "../src/run/evidence.js";
import { taskSnapshot } from "../src/run/run.js";
import { idsIn } from "../src/core/skillcheck.js";
import { listReceipts, newReceiptId, writeReceipt } from "../src/core/receipt.js";
import { bundledSkillsDir } from "../src/core/skills.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { approveProposals } from "../src/synth/proposals.js";
import { synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const SPEC = (cite: string) => `# Spec SCIM provisioning

## Problem

Admins copy users into the product by hand every week ${cite}.

## Evidence

- A weekly CSV export that takes two hours ${cite}

## Validated by

Not yet.

## Proposal

SCIM 2.0 provisioning.

## Success metrics

- No weekly export.

## Open questions

- Which identity providers first?
`;

const CALL = [
  "---", "title: Acme weekly", "participants: jane@acme.com, kp@us.com", "---",
  "Jane: Every Friday we export a CSV of our users and paste it into your admin screen.",
  "",
  "Kp: How long does that take?",
  "",
  "Jane: About two hours. SCIM provisioning would fix it, our identity provider supports it.",
  "",
  "Kp: Thanks, that's useful. Anything else on the roadmap?",
  "",
  "Jane: Dark mode would be nice.",
].join("\n");

/** One runtime for both steps: synthesis has no tools; the drafting run writes its output and keeps what it was shown. */
function runtime(draft: (task: string) => string) {
  const seen: string[] = [];
  const rt = mockRuntime(async (o) => {
    if (!o.tools.length) return JSON.stringify({ tasks: [{ title: "Spec SCIM provisioning", category: "spec", size: "M", rationale: "Admins keep user lists in sync by hand.", sources: ["T1"], support: { T1: "The customer exports users weekly." } }] });
    const task = await readFile(join(o.cwd, ".pmx/tmp/task.md"), "utf8");
    seen.push(task);
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(o.cwd, out)), { recursive: true });
    await writeFile(join(o.cwd, out), draft(task));
    return { text: "Drafted.", costUsd: 0.1 };
  });
  return Object.assign(rt, { seen });
}

describe("evidence for agent runs (RUN-3)", () => {
  beforeEach(freshHome);

  it("quotes each source from the Mac that proposed the task, so a draft that cites it passes", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] }, { remote: true });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", CALL);
    const rt = runtime(() => SPEC("[T1]"));
    const ctx = await testCtx({ repo, runtime: rt, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const tracker = memoryTracker();
    const svc = await services(ctx, { tracker });
    await synthesize(ctx, svc, { days: 7 });
    await approveProposals(ctx, svc, ["1"]);
    const task = [...tracker.tasks.values()][0]!;
    // Linear has the ID only (PRIV-6).
    expect(task.description).toContain("pmx:source T1");
    expect(task.description).not.toMatch(/CSV|Jane|two hours/);
    await tracker.setStatus(task.id, "ready");

    const r = await pull(ctx, svc, { dryRun: false });
    expect(r.ran).toMatchObject({ outcome: "ok" });
    const shown = rt.seen[0]!;
    const data = shown.slice(shown.indexOf("<task_data>"), shown.indexOf("</task_data>"));
    expect(data).toContain("## Sources you can cite");
    expect(data).toContain("### [T1] A meeting on");
    expect(data).toContain("> Jane: About two hours. SCIM provisioning would fix it");
    // The passages most about the task come first in importance, but in the order they were said.
    expect(data.indexOf("Every Friday")).toBeLessThan(data.indexOf("About two hours"));
    expect(idsIn(shown)).toEqual(new Set(["T1"]));
    expect(tracker.tasks.get(task.id)!.status).toBe("review");
  });

  it("another Mac has no quotes for the task, so it says why and never spends a run", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] }, { remote: true });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", CALL);
    const rt = runtime(() => SPEC("[T1]"));
    const ctx = await testCtx({ repo, runtime: rt, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const tracker = memoryTracker();
    const svc = await services(ctx, { tracker });
    await synthesize(ctx, svc, { days: 7 });
    await approveProposals(ctx, svc, ["1"]);
    const task = [...tracker.tasks.values()][0]!;
    await tracker.setStatus(task.id, "ready");

    await freshHome();
    const other = await testCtx({ repo, runtime: rt, team: { internalDomains: ["us.com"] } });
    const sel = await plan(other, await services(other, { tracker }));
    expect(sel.candidates).toEqual([]);
    expect(sel.decisions[0]!.why).toBe("its sources are quoted only on the Mac that proposed it, and a spec draft must cite its sources 2 times");
    // A task with no sources at all says so too.
    await tracker.createInbox({ title: "By hand", description: "Typed into Linear.", category: "spec", size: "S", sources: [] }).then((t) => tracker.setStatus(t.id, "ready"));
    expect((await plan(other, await services(other, { tracker }))).decisions.map((d) => d.why)).toContain("it names no sources, and a spec draft must cite its sources 2 times");
    expect(rt.calls.filter((c) => c.tools.length)).toEqual([]);
  });

  it("gives nothing for a source that's gone or that the privacy rules now leave out", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    const file = await writeTranscript(dir, "acme.md", CALL);
    const rt = runtime(() => "");
    const ctx = await testCtx({ repo, runtime: rt, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const tracker = memoryTracker();
    const svc = await services(ctx, { tracker });
    await synthesize(ctx, svc, { days: 7 });
    await approveProposals(ctx, svc, ["1"]);
    const task = [...tracker.tasks.values()][0]!;
    expect((await taskEvidence(ctx, task)).sources.map((s) => s.id)).toEqual(["T1"]);

    ctx.personal.neverIngest = { ...ctx.personal.neverIngest, meetingTitles: ["Acme weekly"] };
    expect(await taskEvidence(ctx, task)).toEqual({ sources: [], missing: [{ id: "T1", why: "your privacy rules now leave it out" }] });
    ctx.personal.neverIngest = { ...ctx.personal.neverIngest, meetingTitles: [] };
    await rm(file);
    expect((await taskEvidence(ctx, task)).missing).toEqual([{ id: "T1", why: "its meeting or thread is no longer in your folders" }]);
    // Without evidence the snapshot has no source to cite, as before.
    expect(idsIn(taskSnapshot(task, "outputs/spec/x.md", await taskEvidence(ctx, task)))).toEqual(new Set());
  });

  it("keeps the synthesis run behind an approved task for 60 days, and other receipts for 14", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", CALL);
    const ctx = await testCtx({ repo, runtime: runtime(() => ""), team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const svc = await services(ctx, { tracker: memoryTracker() });
    await synthesize(ctx, svc, { days: 7 });
    const synth = (await listReceipts())[0]!;
    await writeReceipt({ v: 1, id: newReceiptId("digest", ctx.now()), type: "digest", at: ctx.now().toISOString(), sources: [] } as any, ctx.now());
    const digest = (await listReceipts()).find((id) => id.startsWith("digest"))!;
    await approveProposals(ctx, svc, ["1"]);
    const later = (days: number) => writeReceipt({ v: 1, id: newReceiptId("todo", new Date(ctx.now().getTime() + days * 86400000)), type: "todo", sources: [] } as any, new Date(ctx.now().getTime() + days * 86400000));
    await later(20);
    expect(await listReceipts()).toContain(synth);
    expect(await listReceipts()).not.toContain(digest);
    await later(61);
    expect(await listReceipts()).not.toContain(synth);
  });

  it("picks the passages that share words with the task, capped, and never a bracketed ID", () => {
    const text = ["A: hello there", "", "B: the export takes hours [T9]", "", "A: weather is nice", "", "B: export again"].join("\n");
    expect(pickPassages(text, "Weekly export")).toEqual(["B: the export takes hours [T9]", "B: export again"]);
    expect(pickPassages("A: nothing in common", "Weekly export")).toEqual(["A: nothing in common"]);
    expect(pickPassages(Array.from({ length: 30 }, (_, i) => `A${i}: export ${"x".repeat(900)}`).join("\n\n"), "export").length).toBeLessThanOrEqual(8);
  });
});

const inline = (over: Partial<Task>): Task => ({
  id: "lin-1", identifier: "PMX-1", title: "Spec SCIM provisioning",
  description: "Admins sync users by hand.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n\npmx:source T1",
  url: "https://linear.app/acme/issue/PMX-1", category: "spec", size: "S", status: "ready", priority: 1, agent: null,
  sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

describe("failed runs back off (PULL-11)", () => {
  beforeEach(freshHome);

  it("runs the next ready task after a failure, and moves a task to Blocked after two in a row", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const rt = runtime((task) => (task.includes("PMX-1:") ? "no headings, no citations" : SPEC("[T1]")));
    const ctx = await testCtx({ repo, runtime: rt, now: new Date(2026, 10, 4, 10) });
    const tracker = memoryTracker([inline({}), inline({ id: "lin-2", identifier: "PMX-2", title: "Spec audit logs", priority: 2 })]);
    const svc = await services(ctx, { tracker });

    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toMatch(/^PMX-1: failed \(missing heading/);
    expect(tracker.tasks.get("lin-1")!.status).toBe("ready");
    expect(tracker.comments.get("lin-1")!.at(-1)).toMatch(/Returned to ready\. Other ready tasks run before it\.$/);

    // PMX-1 has the higher priority, but it just failed: PMX-2 goes first.
    const sel = await plan(ctx, svc);
    expect(sel.candidates.map((t) => t.identifier)).toEqual(["PMX-2", "PMX-1"]);
    expect(sel.decisions.find((d) => d.task.identifier === "PMX-1")!.why).toMatch(/its last run failed, so it goes after the others/);
    expect((await pull(ctx, svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    expect(tracker.tasks.get("lin-2")!.status).toBe("review");

    const third = await pull(ctx, svc, { dryRun: false });
    expect(third.ran!.message).toMatch(/moved to Blocked after 2 runs in a row without a draft$/);
    expect(tracker.tasks.get("lin-1")).toMatchObject({ status: "blocked", agent: null });
    expect(tracker.comments.get("lin-1")!.at(-1)).toMatch(/That's 2 runs in a row without a draft, so it's moved to Blocked and no agent picks it up\./);
    expect((await pull(ctx, svc, { dryRun: false })).ran).toBeNull();
  });

  it("keeps what a failed run wrote on a local branch it never pushes, and runs the task again from a clean start (RUN-4)", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    let n = 0;
    const found: boolean[] = [];
    const rt = mockRuntime(async (o) => {
      const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      found.push(existsSync(join(o.cwd, out)));
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), ++n === 1 ? "no headings, no citations" : SPEC("[T1]"));
      return { text: "Drafted.", costUsd: 0.1 };
    });
    const ctx = await testCtx({ repo, runtime: rt, now: new Date(2026, 10, 4, 10) });
    const tracker = memoryTracker([inline({})]);
    const svc = await services(ctx, { tracker });

    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toMatch(/; what it wrote is on pmx\/failed\/PMX-1$/);
    expect(tracker.comments.get("lin-1")).toEqual([expect.stringMatching(new RegExp(`did not produce a draft: .*\\. What the agent wrote is kept on ${ctx.agent}'s Mac, on the local branch pmx/failed/PMX-1 of the team repo\\. It isn't pushed: it may quote meetings that stay on that Mac\\. Returned to ready\\.`))]);
    expect(await git(repo, "show", "pmx/failed/PMX-1:outputs/spec/PMX-1.md")).toBe("no headings, no citations");
    const kept = await git(repo, "ls-tree", "-r", "--name-only", "pmx/failed/PMX-1");
    expect(kept).toContain(".pmx/runs/PMX-1.json");
    expect(kept).not.toContain(".pmx/tmp");
    expect(await git(repo, "branch", "--list", "pmx/task/*")).toBe("");
    expect(await git(repo, "ls-remote", "origin")).not.toContain("pmx/failed");

    // The next run starts from the team's branch, not from what failed; a draft that passes clears the kept one.
    expect((await pull(ctx, svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    expect(found).toEqual([false, false]);
    expect(await git(repo, "branch", "--list", "pmx/failed/*")).toBe("");
  });

  it("a task skipped before its run backs off like a failed run: no agent, no spend, one comment per state, then Blocked", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    // A team copy of the spec skill whose environment is invalid: no run can start.
    const text = (await readFile(join(bundledSkillsDir(), "pmx-spec", "SKILL.md"), "utf8"))
      .replace(/^pmx: \{/m, 'pmx: {"env": {"tools": []}, ');
    await mkdir(join(repo, ".claude", "skills", "pmx-spec"), { recursive: true });
    await writeFile(join(repo, ".claude", "skills", "pmx-spec", "SKILL.md"), text);
    await git(repo, "add", "-A");
    await git(repo, "commit", "-q", "-m", "broken skill");
    await git(repo, "push", "-q", "origin", "main");
    const rt = runtime(() => SPEC("[T1]"));
    const ctx = await testCtx({ repo, runtime: rt, now: new Date(2026, 10, 4, 10) });
    const tracker = memoryTracker([inline({})]);
    const svc = await services(ctx, { tracker });

    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toMatch(/^PMX-1: failed \(invalid environment: env\.tools must not be empty\)$/);
    expect(tracker.tasks.get("lin-1")!.status).toBe("ready");
    expect((await plan(ctx, svc)).decisions.find((d) => d.task.identifier === "PMX-1")!.why).toMatch(/its last run failed, so it goes after the others/);
    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toMatch(/; moved to Blocked after 2 runs in a row without a draft$/);
    expect(tracker.tasks.get("lin-1")).toMatchObject({ status: "blocked", agent: null });
    expect(await pull(ctx, svc, { dryRun: false })).toMatchObject({ ran: null });

    expect(rt.seen).toEqual([]);
    expect(tracker.comments.get("lin-1")).toEqual([
      expect.stringMatching(/skipped PMX-1 before starting an agent: invalid environment: env\.tools must not be empty\. Returned to ready\. Other ready tasks run before it\.$/),
      expect.stringMatching(/skipped PMX-1 before starting an agent: .*\. That's 2 runs in a row without a draft, so it's moved to Blocked/),
    ]);
    const runs = (await new RunLogStore(ctx).entries()).filter((e) => e.type === "run");
    expect(runs).toEqual([expect.objectContaining({ taskId: "PMX-1", outcome: "failed", durationMs: 0, tokens: null, costUsd: null }), expect.objectContaining({ outcome: "failed", costUsd: null })]);
  });

  it("a task whose skill is missing backs off too, instead of failing at the head of the queue", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const team = { categories: { spec: { skill: "pmx-nope" } } } as any;
    const ctx = await testCtx({ repo, team, runtime: runtime(() => SPEC("[T1]")), now: new Date(2026, 10, 4, 10) });
    const tracker = memoryTracker([inline({})]);
    const svc = await services(ctx, { tracker });
    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toBe("PMX-1: failed (its skill pmx-nope isn't in the team repo, the org skills or PMX's own)");
    expect(tracker.comments.get("lin-1")).toEqual([expect.stringMatching(/before starting an agent: its skill pmx-nope isn't in the team repo, the org skills or PMX's own\. Returned to ready\./)]);
    expect((await pull(ctx, svc, { dryRun: false })).ran!.message).toMatch(/moved to Blocked after 2 runs in a row without a draft$/);
  });

  it("counts failures in a row per task, across agents; a draft resets it and a refusal doesn't count", () => {
    const e = (taskId: string, outcome: string, ts: string, agent = "a") => ({ type: "run", taskId, outcome, ts, agent, machine: "m" }) as any;
    const s = failStreaks([
      e("PMX-1", "failed", "2026-11-20T10:00:00Z"), e("PMX-1", "capped", "2026-11-20T11:00:00Z", "b"), e("PMX-1", "refused", "2026-11-20T11:30:00Z"),
      e("PMX-2", "failed", "2026-11-20T09:00:00Z"), e("PMX-2", "ok", "2026-11-20T10:00:00Z"),
      e("PMX-3", "ok", "2026-11-20T09:00:00Z"), e("PMX-3", "failed", "2026-11-20T10:00:00Z"),
    ]);
    expect(Object.fromEntries(s)).toEqual({ "PMX-1": 2, "PMX-3": 1 });
  });
});
