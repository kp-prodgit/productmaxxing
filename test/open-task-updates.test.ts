// INPUT-2 (founder decision, KP 2026-11-27): an open task takes a later call's newer facts, through the tracker guard.
// The end-to-end case: an open task said "GPU cost is 18% over budget", a later call said 22%, and Linear kept 18%.
// Also the two repeat lows from the same test: a restated clause that adds only a figure, and a labeled line said again.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { updatedLine } from "../src/commands/team.js";
import { readReceipt } from "../src/core/receipt.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { formatReceipt } from "../src/explain/format.js";
import { taskEvidence } from "../src/run/evidence.js";
import { evidenceStore } from "../src/run/packs.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { matchFacts, mergeSourcesLine, newSources, openStep, planOpenUpdate, rangeDays } from "../src/synth/open-update.js";
import { approveProposals, mergeFacts, newFacts, readProposals } from "../src/synth/proposals.js";
import { foldDetail, labeledRepeat, newerFigure, updates } from "../src/synth/repeats.js";
import { synthesize } from "../src/synth/synthesize.js";
import { readOutbox, relayDir, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import { paths } from "../src/core/paths.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const FIRST = new Date("2026-11-20T18:00:00Z");
const LATER = new Date("2026-11-26T18:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "pmx-1" };
const team = { internalDomains: ["us.example"], tracker: LINEAR };

const CALL_1 = ["---", "title: Acme weekly", "date: 2026-11-20T14:00:00Z", "participants: jane@acme.example, ana@us.example", "---",
  "Jane: Our GPU spend is running well past what finance planned for this quarter.", "",
  "Ana: How far past the plan are you?", "",
  "Jane: Eighteen percent, and finance wants a cost model before the renewal."].join("\n");
const CALL_2 = ["---", "title: Acme cost review", "date: 2026-11-26T15:00:00Z", "participants: jane@acme.example, ana@us.example", "---",
  "Jane: The overrun grew again since last week, it is twenty-two percent now.", "",
  "Ana: Thanks, that changes the model."].join("\n");

const TITLE = "Model Acme's GPU cost overrun";
const SAID = "GPU cost is 18% over budget. Acme needs a cost model before its renewal.";
const NEWER = "GPU cost is now 22% over budget. Acme needs a cost model before its renewal.";

/** The synthesis reply for the one call in the prompt, by its title: the same need, with `rationale`. */
const reply = (title: string, rationale: string, more: Record<string, unknown> = {}) => mockRuntime((o) => {
  const id = o.prompt.match(new RegExp(`id="([A-Z]\\d+)"[^>]*title="${title}"`))![1]!;
  return JSON.stringify({ tasks: [{ title: TITLE, category: "spec", size: "M", rationale, sources: [id], support: { [id]: "The customer says how far over plan its GPU spend is." }, companies: { [id]: { name: "Acme", as: "customer" } }, ...more }] });
});

/** A task in Linear from the first call, approved on this Mac (so its synthesis run is here), and a later call's run. */
async function openTask(o: { status?: Task["status"] } = {}) {
  const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
  const dir = await tmp("calls-");
  await writeTranscript(dir, "acme-1.md", CALL_1);
  const personal = { sources: { transcriptDirs: [dir], slackChannel: null } };
  const tracker = memoryTracker();
  const first = await testCtx({ repo, runtime: reply("Acme weekly", SAID), team, personal, now: FIRST });
  await synthesize(first, await services(first, { tracker }), { days: 7 });
  const a = await approveProposals(first, await services(first, { tracker }), ["1"]);
  expect(a.posted.map((p) => p.identifier)).toEqual(["PMX-1"]);
  const task = [...tracker.tasks.values()][0]!;
  if (o.status) await tracker.setStatus(task.id, o.status);
  const before = { ...tracker.tasks.get(task.id)! };
  const later = async (rationale: string, x: { dryRun?: boolean; more?: Record<string, unknown> } = {}) => {
    await writeTranscript(dir, "acme-2.md", CALL_2);
    const ctx = await testCtx({ repo, runtime: reply("Acme cost review", rationale, { sameAs: "PMX-1", ...x.more }), team, personal, now: LATER });
    const svc = await services(ctx, { tracker });
    const r = await synthesize(ctx, svc, { days: 7, ...(x.dryRun ? { dryRun: true } : {}) });
    return { r, ctx, svc };
  };
  return { repo, tracker, task, before, later, receiptId: before.description.match(/`pmx explain (synthesize-\S+)`/)![1]! };
}

const summaryOf = (d: string) => d.split("\n\n")[0];

describe("an open task takes a later call's newer facts (INPUT-2, founder 2026-11-27)", () => {
  beforeEach(freshHome);

  it("a task in the backlog: its description gets the newer figure, its Sources line and a pmx:source line, a comment says what changed, and its pack has the new quotes", async () => {
    const { tracker, task, before, later, receiptId } = await openTask();
    expect(summaryOf(before.description)).toBe(SAID);
    const { r, ctx } = await later(NEWER);

    const now = tracker.tasks.get(task.id)!;
    // The sentence the newer one supersedes is replaced in place, not kept beside it.
    expect(summaryOf(now.description)).toBe(NEWER);
    expect(now.description).toContain(`**Sources:** 2 customer calls with Acme (Nov 20–26). They stay on the PM's Mac: \`pmx explain ${receiptId}\` there shows them.`);
    expect(now.sources).toEqual(["T1", "T2"]);
    expect(now.description).toMatch(/pmx:source T1\npmx:source T2$/);
    expect(now.title).toBe(before.title);
    // One short comment, through the guard: no names, no quotes.
    expect(tracker.comments.get(task.id)).toEqual(["Updated from a call on Nov 26: GPU cost is now 22% over budget (was 18%)."]);

    // The task's own run learns the new source, so its agent and `pmx explain` find it.
    const own = (await readReceipt(receiptId))!;
    const added = own.sources.find((s) => s.id === "T2")!;
    expect(added).toMatchObject({ decision: "used", title: "Acme cost review" });
    expect(added.addedFrom).toMatch(/^synthesize-20261126T180000Z$/);
    expect((await taskEvidence(ctx, now)).sources.map((s) => s.id)).toEqual(["T1", "T2"]);
    // RUN-5: its pack has the new quotes too, with no names.
    const pack = await evidenceStore(ctx.repo).read("PMX-1");
    expect(pack!.sources.map((s) => s.id)).toEqual(["T1", "T2"]);
    expect(JSON.stringify(pack)).toMatch(/twenty-two percent/);
    expect(JSON.stringify(pack)).not.toMatch(/Jane/);

    // The answer says it was updated, not only heard again; the receipt and `pmx explain` say what changed.
    expect(r.updated).toEqual([{ identifier: "PMX-1", title: TITLE, how: "description", sources: 1, changes: ["GPU cost is now 22% over budget (was 18%)."] }]);
    expect(updatedLine(r.updated![0]!)).toBe("updated PMX-1 with newer facts from 1 source: GPU cost is now 22% over budget (was 18%).");
    expect(r.skipped.join("\n")).not.toMatch(/heard again/);
    expect(r.staged).toEqual([]);
    const receipt = (await readReceipt("synthesize-20261126T180000Z"))!;
    expect(receipt.synth!.tasks[0]!.posted).toEqual({ duplicateOf: "PMX-1", updated: { how: "description", changes: ["GPU cost is now 22% over budget (was 18%)."], sources: 1 } });
    expect(formatReceipt(receipt, [])).toContain("updated PMX-1: GPU cost is now 22% over budget (was 18%). (1 new source)");
    expect(await readProposals()).toEqual([]);
  });

  it("a task whose draft is in review gets the comment only: nothing changes under the reviewer", async () => {
    const { tracker, task, before, later, receiptId } = await openTask({ status: "review" });
    const { r } = await later(NEWER);
    const now = tracker.tasks.get(task.id)!;
    expect(now.description).toBe(before.description);
    expect(now.sources).toEqual(["T1"]);
    expect(tracker.comments.get(task.id)).toEqual([
      "A call on Nov 26 brought newer facts: GPU cost is now 22% over budget (was 18%). PMX left the description as it is while its draft is in review.",
    ]);
    // Its run doesn't learn a source no line of it cites.
    expect((await readReceipt(receiptId))!.sources.some((s) => s.addedFrom)).toBe(false);
    expect(r.updated).toEqual([expect.objectContaining({ identifier: "PMX-1", how: "comment", why: "its draft is in review" })]);
    expect(updatedLine(r.updated![0]!, false)).toBe("commented on PMX-1 with newer facts from 1 source (its draft is in review, so its description stays)");
    const receipt = (await readReceipt("synthesize-20261126T180000Z"))!;
    expect(formatReceipt(receipt, [])).toContain("commented on PMX-1: GPU cost is now 22% over budget (was 18%). (its draft is in review, so its description stays; 1 new source)");
  });

  it("a done task is left alone: R6's done-as rule covers it", async () => {
    const { tracker, task, before, later } = await openTask({ status: "done" });
    tracker.tasks.get(task.id)!.createdAt = "2026-11-21T09:00:00Z";
    const { r } = await later(NEWER);
    expect(tracker.tasks.get(task.id)!.description).toBe(before.description);
    expect(tracker.comments.get(task.id) ?? []).toEqual([]);
    expect(r.updated).toBeUndefined();
    expect(r.skipped).toContainEqual(expect.stringMatching(/^Model Acme's GPU cost overrun: done as PMX-1 \(Nov 21\); heard again in 1 source\(s\)$/));
  });

  it("a name in the new facts never reaches the task: that sentence is cut, the newer figure still goes", async () => {
    const { tracker, task, later } = await openTask();
    const { r } = await later(`${NEWER} Jane wants a weekly GPU cost report from the team.`);
    const now = tracker.tasks.get(task.id)!;
    expect(summaryOf(now.description)).toBe(NEWER);
    expect(now.description).not.toMatch(/Jane/);
    expect(tracker.comments.get(task.id)!.join(" ")).not.toMatch(/Jane/);
    expect(r.updated![0]!.changes).toEqual(["GPU cost is now 22% over budget (was 18%)."]);
  });

  it("a later call that brings no new fact changes nothing: the task is heard again, as before", async () => {
    const { tracker, task, before, later } = await openTask();
    const { r } = await later(SAID);
    expect(tracker.tasks.get(task.id)!.description).toBe(before.description);
    expect(tracker.comments.get(task.id) ?? []).toEqual([]);
    expect(r.updated).toBeUndefined();
    expect(r.skipped).toContain(`${TITLE}: already open as PMX-1; heard again in 1 more source(s)`);
  });

  it("a dry run says what a real run would do, and writes nothing", async () => {
    const { tracker, task, before, later, receiptId } = await openTask();
    const { r } = await later(NEWER, { dryRun: true });
    expect(tracker.tasks.get(task.id)!.description).toBe(before.description);
    expect(tracker.comments.get(task.id) ?? []).toEqual([]);
    expect((await readReceipt(receiptId))!.sources.some((s) => s.addedFrom)).toBe(false);
    expect(r.skipped).toContain(`${TITLE}: already open as PMX-1; a real run would have updated PMX-1 with newer facts from 1 source`);
  });

  it("through the Claude relay, the description rewrite and the comment are queued as ops for the next sync", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await tmp("calls-");
    await writeTranscript(dir, "acme-2.md", CALL_2);
    const description = `${SAID}\n\n**Why size M:** One spec.\n\n**Sources:** a customer call with Acme (Nov 20). They stay on the PM's Mac: \`pmx explain synthesize-20261120T180000Z\` there shows them.\n\npmx:source T1`;
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: LATER.toISOString(), projectId: "pmx-1", issues: [{
      id: "uuid-7", identifier: "PMX-7", title: TITLE, description, url: "", priority: 0, createdAt: "2026-11-20T18:00:00Z", state: { name: "Backlog", type: "backlog" },
      labels: { nodes: [{ name: "inbox", parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }, { name: "backlog", parent: { name: "pmx-state" } }] }, comments: { nodes: [] },
    }] }));
    const ctx = await testCtx({ repo, runtime: reply("Acme cost review", NEWER, { sameAs: "PMX-7" }), team, personal: { sources: { transcriptDirs: [dir], slackChannel: null } }, now: LATER });
    const r = await synthesize(ctx, await services(ctx, { tracker: relayTracker(ctx.team, () => {}, () => LATER) }), { days: 7 });
    const ops = (await readOutbox()).ops;
    expect(ops.map((op) => [op.kind, "target" in op ? op.target : null])).toEqual([["rewrite", "PMX-7"], ["comment", "PMX-7"]]);
    const rewrite = ops[0] as Extract<(typeof ops)[number], { kind: "rewrite" }>;
    // Its synthesis run isn't on this Mac: the facts and the Sources line change, and no pmx:source line it can't back.
    expect(rewrite.description).toBe(description.replace(SAID, NEWER).replace("a customer call with Acme (Nov 20)", "2 customer calls with Acme (Nov 20–26)"));
    expect((ops[1] as Extract<(typeof ops)[number], { kind: "comment" }>).body).toBe("Updated from a call on Nov 26: GPU cost is now 22% over budget (was 18%).");
    expect(r.updated).toEqual([expect.objectContaining({ identifier: "PMX-7", how: "description", queued: true })]);
    expect(updatedLine(r.updated![0]!, false)).toBe("updated PMX-7 with newer facts from 1 source, in Linear at the next Claude sync");
  });
});

describe("the update rules (INPUT-2)", () => {
  const base = { id: "t1", identifier: "PMX-1", title: "T", description: "", url: "", category: "spec", size: "M" as const, priority: 0, agent: null, sources: ["T1"], prUrl: null, createdAt: "2026-11-20T00:00:00Z" };
  const now = new Date("2026-11-26T12:00:00Z");

  it("only a task in the backlog or Ready, with no agent on it, has its description changed; drafting, review and blocked get a comment; done gets nothing", () => {
    expect(openStep({ ...base, status: "inbox" }, { now })).toEqual({ how: "description" });
    expect(openStep({ ...base, status: "ready" }, { now })).toEqual({ how: "description" });
    expect(openStep({ ...base, status: "ready" }, { now, leases: [{ taskId: "t1", holder: "bo@m2", acquiredAt: "", expiresAt: "2026-11-26T13:00:00Z", token: "x" }] })).toEqual({ how: "comment", why: "an agent is drafting it" });
    expect(openStep({ ...base, status: "ready" }, { now, leases: [{ taskId: "t1", holder: "bo@m2", acquiredAt: "", expiresAt: "2026-11-26T11:00:00Z", token: "x" }] })).toEqual({ how: "description" });
    expect(openStep({ ...base, status: "running", agent: "bo@m2" }, { now })).toEqual({ how: "comment", why: "an agent is drafting it" });
    expect(openStep({ ...base, status: "review" }, { now })).toEqual({ how: "comment", why: "its draft is in review" });
    expect(openStep({ ...base, status: "blocked" }, { now })).toEqual({ how: "comment", why: "it's blocked" });
    expect(openStep({ ...base, status: "done" }, { now }).how).toBe("none");
    expect(openStep({ ...base, status: "ready", workflow: { type: "canceled", name: "Canceled", recorded: "unstarted", label: "ready" } }, { now }).how).toBe("none");
    // Another Mac's step its copy of Linear can't show yet (PULL-14).
    const look = { asOf: Date.parse("2026-11-26T09:00:00Z"), now, agent: "ana@m1" };
    const mark = (state: "review" | "done") => ({ v: 1 as const, task: "PMX-1", state, at: "2026-11-26T10:00:00Z", by: "bo@m2", machine: "m2", landed: null });
    expect(openStep({ ...base, status: "ready" }, { now, mark: mark("review"), look })).toEqual({ how: "comment", why: "its draft is in review" });
    expect(openStep({ ...base, status: "ready" }, { now, mark: mark("done"), look }).how).toBe("none");
  });

  it("a newer date or figure for the same fact supersedes it; another fact with another figure doesn't", () => {
    expect(updates("GPU cost is 18% over budget.", "GPU cost is now 22% over budget.")).toBe(true);
    expect(updates("Acme's close moved to Jan 29.", "Acme's close moved to Feb 12.")).toBe(true);
    expect(updates("Globex needs 40 seats in the beta.", "Globex now needs 60 seats in the beta.", ["Globex"])).toBe(true);
    // Another thing on another date, another measure, another term, a claim turned around, or a word of it gone.
    expect(updates("Acme's renewal moved to Jan 29.", "Acme's pilot moved to Feb 12.")).toBe(false);
    expect(updates("Globex needs 40 seats in the beta.", "Globex needs 60 seats at GA.", ["Globex"])).toBe(false);
    expect(updates("Globex needs 40 seats.", "Globex needs 60 hours of training.", ["Globex"])).toBe(false);
    expect(updates("GPU cost is 18% over budget.", "GPU cost is not 22% over budget.")).toBe(false);
    expect(updates("GPU cost is 18% over budget.", "GPU spend is running 22% over plan.")).toBe(false);
    expect(updates("GPU cost is 18% over budget.", "GPU cost is 18% over budget.")).toBe(false);
    // Only for an open task: a waiting suggestion keeps both, as before.
    const said = "GPU cost is 18% over budget. Acme needs a cost model.";
    expect(mergeFacts(said, "GPU cost is now 22% over budget.").sentences).toEqual(["GPU cost is 18% over budget.", "Acme needs a cost model.", "GPU cost is now 22% over budget."]);
    const m = mergeFacts(said, "GPU cost is now 22% over budget.", undefined, [], { newer: true });
    expect(m.sentences).toEqual(["GPU cost is now 22% over budget.", "Acme needs a cost model."]);
    expect(m.newer).toEqual([{ was: "GPU cost is 18% over budget.", now: "GPU cost is now 22% over budget.", from: "GPU cost is now 22% over budget." }]);
    expect(m.added).toEqual([]);
    // In a clause of a longer sentence, the clause is replaced in place.
    expect(mergeFacts("Acme will not sign before it has an answer, and its close date moved to Jan 29.", "Its close date moved to Feb 12.", undefined, ["Acme"], { newer: true }).sentences)
      .toEqual(["Acme will not sign before it has an answer, and its close date moved to Feb 12."]);
  });

  it("a sentence the tracker guard refuses is left out of the update, and the one it would replace stays", () => {
    const description = "GPU cost is 18% over budget.\n\n**Sources:** a customer call with Acme (Nov 20). They stay on the PM's Mac.\n\npmx:source T1";
    const items = [{ id: "T2", kind: "transcript" as const, ref: "/x/acme-2.md", title: "Acme cost review", at: "2026-11-26T15:00:00Z", participants: [], text: "" }];
    const run = { id: "synthesize-20261126T180000Z", sources: [{ kind: "transcript" as const, refHash: "h2", decision: "used" as const, id: "T2", detail: "", passagesCut: [], passagesUsed: 1 }] };
    const plan = (rationale: string) => planOpenUpdate({
      task: { ...base, status: "inbox", description }, step: { how: "description" }, cands: [{ title: "T", category: "spec", size: "M", rationale, sources: ["T2"] }],
      items, run, own: null, check: (s) => !/Dana/.test(s), now,
    });
    // Dana's sentence would supersede the 18%: it can't go, so nothing changes.
    expect(plan("Dana says GPU cost is now 22% over budget.")).toBeNull();
    const p = plan("GPU cost is now 22% over budget. Dana's team needs a weekly cost report.")!;
    expect(p.changes).toEqual(["GPU cost is now 22% over budget (was 18%)."]);
    expect(p.description).not.toMatch(/Dana/);
    expect(p.comment).toBe("Updated from a call on Nov 26: GPU cost is now 22% over budget (was 18%).");
    // A description PMX didn't write (no Sources line) isn't changed.
    expect(planOpenUpdate({ task: { ...base, status: "inbox", description: "GPU cost is 18% over budget.\n\npmx:source T1" }, step: { how: "description" }, cands: [{ title: "T", category: "spec", size: "M", rationale: "GPU cost is now 22% over budget.", sources: ["T2"] }], items, run, own: null, check: () => true, now })).toBeNull();
  });

  it("the Sources line counts the new sources with the part of the same kind, company and place", () => {
    const thread = (d: string) => ({ key: "thread|#launch", one: "a thread in #launch", many: "{n} threads in #launch", dates: [d] });
    const call = (d: string) => ({ key: "call|Acme|customer", one: "a customer call with Acme", many: "{n} customer calls with Acme", dates: [d] });
    expect(mergeSourcesLine("2 threads in #launch (Nov 18–21); a customer call with Acme (Nov 20)", [thread("2026-11-26")], now)).toBe("3 threads in #launch (Nov 18–26); a customer call with Acme (Nov 20)");
    expect(mergeSourcesLine("a customer call with Acme (Nov 20)", [call("2026-11-26"), call("2026-11-25")], now)).toBe("3 customer calls with Acme (Nov 20–26)");
    expect(mergeSourcesLine("a customer call with Acme (Nov 20)", [thread("2026-11-26")], now)).toBe("a customer call with Acme (Nov 20); a thread in #launch (Nov 26)");
    // Sources are in the past: a month after this one is last year's.
    expect(rangeDays("Nov 18–21", now)).toEqual(["2026-11-18", "2026-11-21"]);
    expect(rangeDays("Nov 28–Dec 2", now)).toEqual(["2025-11-28", "2025-12-02"]);
    expect(rangeDays("Dec 28–Jan 2", new Date("2026-01-05T12:00:00Z"))).toEqual(["2025-12-28", "2026-01-02"]);
    expect(rangeDays("Dec 30, 2025–Jan 2, 2026", now)).toEqual(["2025-12-30", "2026-01-02"]);
    expect(rangeDays("Dec 12", now)).toEqual(["2025-12-12", "2025-12-12"]);
  });
});

describe("repeat lows from the end-to-end test (R12a, 2026-11-27)", () => {
  it("a restated clause that adds only a figure gives the existing clause the detail, instead of saying the clause twice", () => {
    const said = "Vandelay will use the beta internally only if these are missing, so the spec should define the beta cut and the GA gap.";
    const later = "Vandelay, a $360k pilot, will use the beta for internal work only if these two are missing.";
    const want = "Vandelay, a $360k pilot, will use the beta internally only if these are missing, so the spec should define the beta cut and the GA gap.";
    expect(mergeFacts(said, later).sentences).toEqual([want]);
    expect(newFacts(said, later)).toEqual([]);
    expect(mergeFacts(said, later).fuller).toEqual([{ was: said, now: want }]);
    // The real description's clause sits after another one, in a sentence with a list in brackets.
    const real = "Vandelay has put its requirements in writing (separation of duties, log fields, seven-year retention, agent attribution) and will use the beta internally only if these are missing, so the spec should define the beta cut and the GA gap.";
    expect(mergeFacts(`The full workflow follows at GA on Jan 26. ${real}`, later).sentences).toEqual(["The full workflow follows at GA on Jan 26.", real.replace("Vandelay has", "Vandelay, a $360k pilot, has")]);
    // A detail with something else new, a possessive to put it after, or a detail already there: judged as before.
    expect(foldDetail([said], "Vandelay, a $360k pilot, will use the beta only with SSO.")).toBeNull();
    expect(foldDetail(["Vandelay's team will use the beta internally only if these are missing."], later)).toBeNull();
    expect(mergeFacts(want, later).sentences).toEqual([want]);
    // A list is not a detail.
    expect(foldDetail(["Acme needs SSO in the beta."], "Acme, Globex, and Initech need SSO in the beta.")).toBeNull();
  });

  it("a short labeled line whose date and subject the description already says is a repeat", () => {
    const summary = "Acme needs approve and reject in its Dec 8 beta.";
    expect(labeledRepeat(summary, "Launch readiness: Dec 8 beta.")).toBe(true);
    expect(mergeFacts(summary, "Launch readiness: Dec 8 beta.").sentences).toEqual([summary]);
    // Another date, or a subject the description doesn't say, is new.
    expect(mergeFacts("Acme needs approve and reject in its Dec 15 beta.", "Launch readiness: Dec 8 beta.").added).toEqual(["Launch readiness: Dec 8 beta."]);
    expect(labeledRepeat(summary, "Launch readiness: Dec 8 pricing page.")).toBe(false);
    // A labeled line with no date or figure is judged as any sentence is.
    expect(labeledRepeat(summary, "Launch readiness: beta.")).toBe(false);
  });
});

// The rig's run on #127 (2026-11-27): the real task said "November GPU spend is running 18% over plan and nobody can say
// which tenants or workloads drive it", and the later sources said 22% in other words.
const STALE = "November GPU spend is running 18% over plan and nobody can say which tenants or workloads drive it.";
const VIEW = `${STALE} Metering events exist but there is no screen. The spec should cover internal and customer views.`;
const WORDINGS = [
  "November GPU spend is now 22% over plan and nobody can say which tenants or workloads drive it.",
  "November GPU spend is now running 22% over plan.",
  "GPU costs are running 22% over budget this month.",
];
const NEW_FIGURE = "GPU costs are running 22% over budget this month.";

describe("a newer figure for the same thing, whatever its wording (INPUT-2, rig test of #127)", () => {
  const now = new Date("2026-11-26T12:00:00Z");
  const base = { id: "t1", identifier: "PMX-46", title: "Draft a spec for a per-tenant usage and GPU cost view", url: "", category: "spec", size: "M" as const, priority: 0, agent: null, sources: ["C1"], prUrl: null, createdAt: "2026-11-20T00:00:00Z", status: "inbox" as const };
  const description = `${VIEW}\n\n**Why size M:** One-pager.\n\n**Sources:** a thread in #platform-eng (Nov 20). They stay on the PM's Mac.\n\npmx:source C1`;
  const items = [{ id: "C2", kind: "thread" as const, ref: "https://acme.slack.com/archives/C9/p2", title: "#platform-eng", at: "2026-11-26T15:00:00Z", participants: [], text: "GPU costs are 22% over budget this month.", place: "#platform-eng" }];
  const run = { id: "synthesize-20261126T180000Z", sources: [{ kind: "thread" as const, refHash: "h2", decision: "used" as const, id: "C2", detail: "", passagesCut: [], passagesUsed: 1 }] };
  const cand = (rationale: string) => ({ title: "Spec the usage view", category: "spec", size: "M" as const, rationale, sources: ["C2"] });
  const plan = (rationale: string) => planOpenUpdate({ task: { ...base, description }, step: { how: "description" }, cands: [cand(rationale)], items, run, own: null, check: () => true, now })!;

  it("each of the rig's wordings replaces the 18% in the task's own sentence, keeps its other facts, and the comment says (was 18%)", () => {
    for (const w of WORDINGS) {
      const p = plan(w);
      const summary = p.description!.split("\n\n")[0]!;
      expect(summary).toBe(VIEW.replace("18%", "22%"));
      expect(summary).not.toMatch(/18%/);
      expect(summary.match(/22%/g)).toHaveLength(1);
      expect(p.changes).toEqual([`${w.replace(/\.$/, "")} (was 18%).`]);
      expect(p.comment).toBe(`Updated from a thread on Nov 26: ${w.replace(/\.$/, "")} (was 18%).`);
    }
    // The figure's clause in a longer sentence; the later sentence's other clause is judged on its own.
    expect(mergeFacts("GPU cost is 18% over budget, and finance wants a cost model before renewal.", "GPU costs are running 22% over budget this month, and finance froze new GPU orders.", undefined, [], { newer: true }).sentences)
      .toEqual(["GPU cost is 22% over budget, and finance wants a cost model before renewal.", "Finance froze new GPU orders."]);
    // A newer date for the same event, in an open task.
    expect(mergeFacts("Acme's renewal date is Jan 15.", "Acme's renewal moved to Feb 1.", undefined, ["Acme"], { newer: true }).sentences).toEqual(["Acme's renewal moved to Feb 1."]);
    expect(mergeFacts("Acme's renewal date is Jan 15, and its legal review starts Dec 1.", "Acme now expects its renewal on Feb 1.", undefined, ["Acme"], { newer: true }).sentences).toEqual(["Acme now expects its renewal on Feb 1, and its legal review starts Dec 1."]);
  });

  it("the measure must match, not only the unit: another subject, measure, month, claim or company stays a fact of its own", () => {
    // The rig's cross-measure pairs, and the same unit of another thing.
    expect(newerFigure("Copy tone is on-brand 78% of the time.", "BrandScore drops from 91 to 84.")).toBeNull();
    expect(newerFigure("Copy tone is on-brand 78% of the time.", "Image style is on-brand 85% of the time.")).toBeNull();
    expect(newerFigure("The API allows 60 req/min.", "The API allows 120 burst requests.")).toBeNull();
    expect(newerFigure("The rate limit is 60 requests per minute.", "The rate limit burst is 120 requests.")).toBeNull();
    expect(newerFigure("The rate limit is 60 requests per minute.", "The rate limit is now 90 requests per minute.")).toMatchObject({ was: "60", now: "90" });
    const apart = ["GPU cost is 22% of revenue.", "December GPU spend is 22% over plan.", "GPU spend is not 22% over plan.", "Globex's GPU spend is 22% over plan.", "CPU spend is running 22% over plan.", "Training queues are 22% longer than planned."];
    for (const w of apart) {
      expect(newerFigure(STALE, w)).toBeNull();
      const m = mergeFacts(VIEW, w, undefined, [], { newer: true });
      expect(m.newer).toEqual([]);
      expect(m.sentences[0]).toBe(STALE);
    }
    // 18% of revenue and 22% over budget are two measures, in a task too: the 18% stays, the other is added.
    const p = planOpenUpdate({ task: { ...base, description: description.replace("18% over plan", "18% of revenue") }, step: { how: "description" }, cands: [cand(NEW_FIGURE)], items, run, own: null, check: () => true, now })!;
    expect(p.description!.split("\n\n")[0]).toContain("18% of revenue");
    expect(p.changes).toEqual([NEW_FIGURE]);
    // The task's own company may be named by one of the two.
    expect(newerFigure("GPU cost is 18% over budget.", "Acme's GPU cost is 22% over budget.", ["Acme"])).toMatchObject({ was: "18%", now: "22%" });
  });

  it("two subjects that share a head word but each have their own qualifier are two measures (rig rerun of #127)", () => {
    // "spend" in both, the same month, the same unit: marketing's isn't the GPU's.
    expect(newerFigure("November GPU spend is 18% over plan.", "November launch marketing spend is 22% over plan.")).toBeNull();
    expect(mergeFacts(VIEW, "November launch marketing spend is 22% over plan.", undefined, [], { newer: true }).sentences.slice(0, 1)).toEqual([STALE]);
    expect(newerFigure("The GPU cost is 18% over budget.", "The retrain cost is 22% over budget.")).toBeNull();
    // A qualifier on one side only, or one side's holding the other's, is the same measure.
    expect(newerFigure("November GPU spend is 18% over plan.", "GPU spend is 22% over plan.")).toMatchObject({ was: "18%", now: "22%" });
    expect(newerFigure("GPU spend is 18% over plan.", "Cloud GPU spend is 22% over plan.")).toMatchObject({ was: "18%", now: "22%" });
    expect(newerFigure("Spend is 18% over plan.", "GPU spend is 22% over plan.")).toMatchObject({ was: "18%", now: "22%" });
    // Through fact matching too: the marketing figure goes to no GPU task.
    const view = { ...base, description };
    const ads = { ...cand("November launch marketing spend is 22% over plan."), title: "Review launch marketing spend" };
    expect(matchFacts({ tasks: [view], cands: [ads], heard: new Map(), items, now }).facts.size).toBe(0);
  });

  it("the comment doesn't say the old figure twice when the new words name it", () => {
    const p = plan("November GPU spend is now 22% over plan, up from 18% earlier in the month.");
    expect(p.description!.split("\n\n")[0]).toBe(VIEW.replace("18%", "22%"));
    expect(p.changes).toEqual(["November GPU spend is now 22% over plan, up from 18% earlier in the month."]);
    expect(p.comment).toBe("Updated from a thread on Nov 26: November GPU spend is now 22% over plan, up from 18% earlier in the month.");
    expect(p.comment).not.toMatch(/\(was/);
  });

  it("a figure from the run's other work goes to every open task that states the older one for the same measure, and only the figure", () => {
    const retrain = { ...base, id: "t2", identifier: "PMX-22", title: "Draft a decision brief on retrain policy", description: description.replace(VIEW, "November GPU is 18% over plan, and retrains are the biggest lever.") };
    const queue = { ...base, id: "t5", identifier: "PMX-30", title: "Plan training capacity for the beta", description: description.replace(VIEW, "Training queues are 18% longer than planned for the beta.") };
    const view = { ...base, description };
    const done = { ...view, id: "t3", identifier: "PMX-9", status: "done" as const };
    const brief = { ...cand(`${NEW_FIGURE} The brief should set guardrails before the board deck.`), title: "Draft a decision brief on GPU budget guardrails" };
    const got = matchFacts({ tasks: [retrain, done, view, queue], cands: [brief], heard: new Map(), items, now });
    expect([...got.facts]).toEqual([["PMX-22", [{ sentence: NEW_FIGURE, sources: ["C2"] }]], ["PMX-46", [{ sentence: NEW_FIGURE, sources: ["C2"] }]]]);
    // The same 18% about another measure is left, and the answer can say why.
    expect(got.left).toEqual([{ identifier: "PMX-30", was: "18%", sentence: NEW_FIGURE }]);
    // A task the candidate is the same need as takes it in its own merge.
    expect([...matchFacts({ tasks: [retrain, view], cands: [brief], heard: new Map([["PMX-22", [brief]]]), items, now }).facts.keys()]).toEqual(["PMX-46"]);
    // Only from a source new to the task, and only the figure: nothing else of the other work joins.
    const p = planOpenUpdate({ task: view, step: { how: "description" }, cands: [], facts: got.facts.get("PMX-46"), items, run, own: null, check: () => true, now })!;
    expect(p.description!.split("\n\n")[0]).toBe(VIEW.replace("18%", "22%"));
    expect(p.figure).toBe(true);
    expect(planOpenUpdate({ task: { ...view, sources: ["C1"] }, step: { how: "description" }, cands: [], facts: [{ sentence: NEW_FIGURE, sources: ["C2"] }], items, run, own: { ...run, sources: [{ ...run.sources[0]!, id: "C1" }] } as any, check: () => true, now })).toBeNull();
  });

  it("a repeat counts only the sources new to the task", () => {
    const own = { sources: [{ kind: "thread" as const, refHash: "h1", decision: "used" as const, id: "C1", detail: "", passagesCut: [], passagesUsed: 1 }] } as any;
    const later = { sources: [{ ...own.sources[0], id: "C7" }, { ...own.sources[0], refHash: "h2", id: "C8" }, { ...own.sources[0], id: "C9" }] };
    expect(newSources({ sources: ["C1"] }, ["C7", "C9"], later, own)).toEqual([]);
    expect(newSources({ sources: ["C1"] }, ["C7", "C8", "C9"], later, own)).toEqual(["C8"]);
    // Without the task's own run here, each counts.
    expect(newSources({ sources: ["C1"] }, ["C7", "C8"], later, null)).toEqual(["C7", "C8"]);
  });
});

describe("fact-level matching end to end (INPUT-2, rig test of #127)", () => {
  beforeEach(freshHome);
  const inputs = [{ connector: "Slack", places: ["#platform-eng"] }];
  const thread = (name: string, date: string, body: string) => writeTranscript(paths.threads(), `${name}.md`, `---\nkind: thread\ntitle: #platform-eng\ndate: ${date}\nplace: #platform-eng\nparticipants: lee@acme.example\nsource: slack\nsource_id: C9:${name}\nlink: https://acme.slack.com/archives/C9/${name}\nowner: Ana <ana@us.example>\n---\n${body}`);
  const byText = (prompt: string, words: string) => [...prompt.matchAll(/<item id="([A-Z]\d+)"[^>]*>\n([\s\S]*?)<\/item>/g)].find((m) => m[2]!.includes(words))![1]!;
  const t = { internalDomains: ["us.example"], tracker: LINEAR, inputs };
  /** Open tasks from one thread, each saying what `said` gives it, approved on this Mac. */
  async function tasksFrom(said: Record<string, string>) {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    await thread("p1", "2026-11-20T15:00:00Z", "Lee: We have metering events for GPU use but no screen, and November spend is well past the plan already.");
    const tracker = memoryTracker();
    const first = await testCtx({ repo, runtime: mockRuntime((o) => {
      const id = byText(o.prompt, "metering events");
      return JSON.stringify({ tasks: Object.entries(said).map(([title, rationale]) => ({ title, category: "spec", size: "M", rationale, sources: [id], support: { [id]: "The thread raises it." } })) });
    }), team: t, now: FIRST });
    await synthesize(first, await services(first, { tracker }), { days: 7 });
    expect((await approveProposals(first, await services(first, { tracker }), ["all"])).posted).toHaveLength(Object.keys(said).length);
    const by = (title: string) => [...tracker.tasks.values()].find((x) => x.title === title)!;
    return { repo, tracker, by };
  }
  const later = async (repo: string, tracker: ReturnType<typeof memoryTracker>, reply: (o: { prompt: string }) => unknown) => {
    const ctx = await testCtx({ repo, runtime: mockRuntime((o) => JSON.stringify(reply(o))), team: t, now: LATER });
    return synthesize(ctx, await services(ctx, { tracker }), { days: 7 });
  };

  it("synthesis staged the 22% as other work: each open task with the 18% still takes it by its step, and the rest say why", async () => {
    const { repo, tracker, by } = await tasksFrom({
      "Draft a spec for a per-tenant usage and GPU cost view": VIEW,
      "Draft a problem brief on retrain time and cost": "Every guideline change triggers a full retrain. November GPU spend is already 18% over plan, so retrains hit both customer speed and cost.",
      "Draft a decision brief on retrain policy": "November GPU is 18% over plan, and retrains are the biggest lever.",
      "Plan training capacity for the beta": "Training queues are 18% longer than planned for the beta.",
      "Draft a pricing model for GPU usage": "GPU spend is 18% over plan, so pricing must cover it.",
    });
    const [view, brief, policy, queue, pricing] = ["Draft a spec for a per-tenant usage and GPU cost view", "Draft a problem brief on retrain time and cost", "Draft a decision brief on retrain policy", "Plan training capacity for the beta", "Draft a pricing model for GPU usage"].map(by);
    await tracker.setStatus(policy!.id, "review");
    await tracker.setStatus(pricing!.id, "done");
    tracker.tasks.get(pricing!.id)!.createdAt = "2026-11-21T09:00:00Z";
    const before = new Map([...tracker.tasks.values()].map((x) => [x.id, x.description]));
    await thread("p2", "2026-11-26T15:00:00Z", "Lee: Finance says GPU costs are 22% over budget this month, and the board deck needs guardrails.");
    const r = await later(repo, tracker, (o) => {
      const id = byText(o.prompt, "board deck");
      return { tasks: [{ title: "Draft a decision brief on GPU budget guardrails before the board deck", category: "spec", size: "M", rationale: `${NEW_FIGURE} The board needs guardrails it can approve.`, sources: [id], support: { [id]: "The thread asks for guardrails." } }] };
    });
    // The separate suggestion still stands, beside the updates.
    expect(r.staged.map((p) => p.title)).toEqual(["Draft a decision brief on GPU budget guardrails before the board deck"]);
    const desc = (x: Task) => tracker.tasks.get(x.id)!.description;
    const comments = (x: Task) => tracker.comments.get(x.id) ?? [];
    // Backlog: the description and a comment, in both tasks that said 18%.
    expect(desc(view!).split("\n\n")[0]).toBe(VIEW.replace("18%", "22%"));
    expect(desc(view!)).toContain("**Sources:** 2 threads in #platform-eng (Nov 20–26).");
    expect(tracker.tasks.get(view!.id)!.sources).toHaveLength(2);
    expect(comments(view!)).toEqual([`Updated from a thread on Nov 26: ${NEW_FIGURE.replace(/\.$/, "")} (was 18%).`]);
    expect(desc(brief!).split("\n\n")[0]).toBe("Every guideline change triggers a full retrain. November GPU spend is already 22% over plan, so retrains hit both customer speed and cost.");
    expect(comments(brief!)).toEqual([`Updated from a thread on Nov 26: ${NEW_FIGURE.replace(/\.$/, "")} (was 18%).`]);
    // In review: the comment only.
    expect(desc(policy!)).toBe(before.get(policy!.id));
    expect(comments(policy!)).toEqual([`A thread on Nov 26 brought newer facts: ${NEW_FIGURE.replace(/\.$/, "")} (was 18%). PMX left the description as it is while its draft is in review.`]);
    // Another measure with the same 18%: left, and the answer says why. Done: left alone.
    expect(desc(queue!)).toBe(before.get(queue!.id));
    expect(comments(queue!)).toEqual([]);
    expect(r.skipped).toContainEqual(expect.stringMatching(new RegExp(`^${queue!.identifier}: also says 18% where this run brought a newer figure .*but PMX left it: its sentence isn't plainly about the same measure`)));
    expect(desc(pricing!)).toBe(before.get(pricing!.id));
    expect(comments(pricing!)).toEqual([]);

    expect(r.updated!.map((u) => [u.identifier, u.how, u.figure])).toEqual([[view!.identifier, "description", true], [brief!.identifier, "description", true], [policy!.identifier, "comment", true]]);
    expect(updatedLine(r.updated![0]!, false)).toBe(`updated ${view!.identifier} with a newer figure from a new source`);
    const receipt = (await readReceipt("synthesize-20261126T180000Z"))!;
    expect(receipt.synth!.updated!.map((u) => u.identifier)).toEqual([view!.identifier, brief!.identifier, policy!.identifier]);
    expect(formatReceipt(receipt, [])).toContain(`updated ${view!.identifier}: ${NEW_FIGURE.replace(/\.$/, "")} (was 18%). (a newer figure from 1 new source)`);
  });

  it("a repeat whose sources the task already has says so, and changes nothing", async () => {
    const { repo, tracker, by } = await tasksFrom({ "Draft a spec for a per-tenant usage and GPU cost view": VIEW });
    const task = by("Draft a spec for a per-tenant usage and GPU cost view");
    const before = task.description;
    const r = await later(repo, tracker, (o) => {
      const id = byText(o.prompt, "metering events");
      return { tasks: [{ title: task.title, category: "spec", size: "M", rationale: VIEW.replace("18%", "22%"), sources: [id], support: { [id]: "The thread asks for a usage screen." }, sameAs: task.identifier }] };
    });
    expect(r.skipped).toContain(`${task.title}: already open as ${task.identifier}; heard again (no new sources)`);
    expect(tracker.tasks.get(task.id)!.description).toBe(before);
    expect(tracker.comments.get(task.id) ?? []).toEqual([]);
    expect(r.updated).toBeUndefined();
  });
});
