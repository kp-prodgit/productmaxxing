// FOLLOW-1: accepting a draft no longer ends the chain. Its "PM decides" calls become the accepting PM's private
// to-dos, and its open and blocking questions become suggested tasks waiting in Needs you, never in Linear before the
// PM approves them. F21: `pmx review` decides by task id without a terminal, and says so when it can't ask.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reviewCommand } from "../src/commands/review.js";
import { validateTeamConfig, DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { registerServices, services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { pull } from "../src/pull/pull.js";
import { bundledSkillsDir } from "../src/core/skills.js";
import { draftComment, draftCounts } from "../src/run/comment.js";
import { deadlineIn, draftFile, FOLLOW_TASKS, FOLLOW_TODOS, followUpKind, followUpsOnAccept, followUpText, readFollowUps } from "../src/review/followups.js";
import { decide, loadQueue } from "../src/review/queue.js";
import { startReviewServer } from "../src/review/server.js";
import { NO_TERMINAL, scriptedReview } from "../src/review/tui.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { approveProposals, formatProposal, readProposals, stageProposals } from "../src/synth/proposals.js";
import { loadTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { relayDir } from "../src/tracker/relay.js";
import { freshHome, git, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";

/** A spec draft with every kind of follow-up: calls in a list and in a line, a blocking list, and open questions. */
const DRAFT = `# PMX-14: Draft a one-pager for SCIM sync

## Problem

Admins keep users in step by hand: they export a CSV every Friday [T1].

## Evidence

- CSV export every week [T1]
- A third SCIM ask this quarter [S1]

## Validated by

Not yet: no account has committed [T1].

## Proposal

SCIM sync in the admin console.

## Success metrics

- Admins stop the weekly export.

## Implications

- **Self-serve setup is the gap.** Admins give up when setup needs a support call [T1]. Options: a guided setup, or a support-led one. Recommend a guided setup. **PM decides.**
- **Pricing for small teams.** Options: SCIM in every plan, or only in Business. **PM decides:** whether to include SCIM in every plan. Recommendation: Business only, settled before Dec 8.
- SCIM is the most asked-for admin feature this quarter [S1].

## Decision this draft supports, and blocking questions

Supports: whether SCIM ships in the first release. **PM decides.**

Blocking:
1. Which identity providers do our largest accounts use [T1]?
2. Would an account pay for SCIM as an add-on, or sign a pilot to try it [S1]?

## Open questions

- How long does a CSV import take an admin today? **PM decides:** pursue. Recommend asking two admins this week.
- Should we offer SCIM on the free plan? **PM decides.**
`;

/** A draft with nothing left over: no calls, no questions. */
const DONE_DRAFT = DRAFT.replace(/## Implications[\s\S]*$/, "## Open questions\n\nNone: the evidence settles it [T1].\n");

/** More than the caps allow: seven calls, three open questions before two blocking ones. */
const BIG_DRAFT = DRAFT.replace(/## Implications[\s\S]*$/, [
  "## Implications", "",
  ...["guided setup", "a support-led setup", "SCIM in every plan", "a Business-only plan", "an admin audit log", "a sync status page", "a migration tool"].map((x, i) => `- **Call ${i + 1}.** Whether to offer ${x} [T1]. **PM decides.**`),
  "", "## Open questions", "",
  "- How long does a CSV import take an admin today?",
  "- How many admins run the export by hand?",
  "- Which plans do those admins pay for?",
  "", "## Blocking questions", "",
  "1. Which identity providers do our largest accounts use [T1]?",
  "2. Does the importer handle nested groups [S1]?",
  "",
].join("\n"));

/**
 * R1: a decision brief shaped exactly as the pmx-decision-brief skill asked before this fix: Decision, Options,
 * Criteria, Evidence by option, a Recommendation ending in a bare **PM decides**, and Open questions. Its decision made
 * no to-do, while the draft-ready comment counted one call.
 */
const DECISION_BRIEF = `# PMX-16: Decide on Globex's renewal terms

## Decision

Whether to accept, counter or decline Globex's request for a two-year price lock at renewal. Lee Park makes the call, and it's needed before Dec 12 [T1]. With no answer by then, the current terms roll over for a year [T1].

## Options

1. **Accept.** Lock today's price for two years [T1].
2. **Counter.** Offer a one-year lock with a usage floor [S1].
3. **Decline.** Renew at list price [S1].

## Criteria

1. Revenue at stake: the account's renewal [T1].
2. Margin risk over two years [S1].
3. How reversible it is: a one-year lock can be extended.

## Evidence by option

- **Accept.** For: keeps the account [T1]. Against: margin risk if costs rise [S1].
- **Counter.** For: limits the risk to one year [S1]. Against: *Unknown* whether Globex takes it; Sam Ortiz could ask.
- **Decline.** For: full margin [S1]. Against: the account may leave [T1].

## Recommendation

Counter with a one-year lock and a usage floor: it keeps the account and caps the margin risk at a year [T1] [S1]. A competing two-year offer in writing would change this.

**PM decides**

## Open questions

- Will Globex accept a one-year lock [T1]?
`;

/** The skill's form from now on: the Recommendation ends with the decision, in a few words. */
const DECISION_BRIEF_NAMED = DECISION_BRIEF.replace("**PM decides**\n", "**PM decides:** whether to accept, counter or decline the two-year lock.\n");

/** The call also marked beside the choice in the Decision section, labelled "Choice:", as one real draft did. */
const DECISION_BRIEF_INLINE = DECISION_BRIEF.replace(
  "Whether to accept, counter or decline Globex's request for a two-year price lock at renewal.",
  "Choice: accept, counter or decline Globex's request for a two-year price lock at renewal (**PM decides**).",
);

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-1", identifier: "PMX-14", title: "Draft a one-pager for SCIM sync",
  // Quoted inline, as tasks before PRIV-6 were, so this Mac can run it without a synthesis receipt.
  description: "Admins sync users by hand.\n\n- [T1] Acme call: we export a CSV every Friday\n- [S1] #feedback: third SCIM ask\n\n**Based on** one meeting and one channel thread (2026-11-01, 2026-11-02). The sources stay on the PM's Mac.\n\npmx:source T1\npmx:source S1",
  url: "https://linear.app/acme/issue/PMX-14", category: "spec", size: "M", status: "ready", priority: 2, agent: null,
  sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

async function drafted(o: { draft?: string; team?: Partial<TeamConfig>; tasks?: Task[]; task?: Partial<Task> } = {}) {
  const { repo } = await pmxRepo(o.team ?? {});
  const tracker = memoryTracker([task(o.task), ...(o.tasks ?? [])]);
  const runtime = mockRuntime(async (r) => {
    const out = r.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(r.cwd, out)), { recursive: true });
    await writeFile(join(r.cwd, out), o.draft ?? DRAFT);
    return { text: "Drafted.", costUsd: 0.1 };
  });
  const ctx = await testCtx({ repo, runtime, team: o.team, now: new Date(2026, 10, 26, 10) });
  const svc = await services(ctx, { tracker });
  const r = await pull(ctx, svc, { dryRun: false });
  expect(r.ran?.outcome).toBe("ok");
  return { repo, tracker, ctx, svc };
}

describe("reading a draft's follow-ups (FOLLOW-1)", () => {
  const now = new Date(2026, 10, 26, 10);

  it("each PM decides call is a decision to make, and each open or blocking question one to answer", () => {
    const r = readFollowUps(DRAFT, "PMX-14", now);
    // R2b: the draft names a call ("PM decides: whether to …"), so it gives its named and worded calls only: the bare
    // mark after "Self-serve setup is the gap." has no decision of its own and stays in the draft. R2e: a question
    // marked PM decides ("…? PM decides: pursue.") is the PM's call, never a task.
    expect(r.decisions.map((d) => d.text)).toEqual([
      "Decide whether to include SCIM in every plan (PMX-14)",
      "Decide whether SCIM ships in the first release (PMX-14)",
      "Decide whether to pursue the question: How long does a CSV import take an admin today? (PMX-14)",
      "Decide whether to offer SCIM on the free plan (PMX-14)",
    ]);
    // The recommendation rides along in the draft's own words; only a stated deadline becomes a due date.
    expect(r.decisions.map((d) => [d.why, d.due])).toEqual([
      ["Options: SCIM in every plan, or only in Business. Recommendation: Business only, settled before Dec 8.", "2026-12-08"],
      ["", null],
      ["Recommend asking two admins this week.", null],
      ["", null],
    ]);
    expect(r.questions.map((q) => [q.where, q.question, q.rest.join(" ")])).toEqual([
      ["blocking", "Which identity providers do our largest accounts use?", ""],
      ["blocking", "Would an account pay for SCIM as an add-on, or sign a pilot to try it?", ""],
    ]);
    // A plain bullet, the Summary and the evidence are not follow-ups.
    expect(JSON.stringify(r)).not.toMatch(/most asked-for|export every week/);
  });

  it("a draft with no calls or questions has none", () => {
    expect(readFollowUps(DONE_DRAFT, "PMX-14", now)).toEqual({ decisions: [], questions: [] });
    expect(readFollowUps("# Title\n\nJust a note.\n", "PMX-1", now)).toEqual({ decisions: [], questions: [] });
  });

  it("reads questions under a ### sub-heading or a Blocking: line, and nothing from a prototype", () => {
    const md = "# T\n\n## Risks\n\n### Open questions\n\n- Who owns the importer?\n\n### Notes\n\n- Import is slow.\n\n## Plan\n\nBlocking:\n- Is the vendor contract signed?\n";
    expect(readFollowUps(md, "PMX-3", now).questions.map((q) => [q.where, q.question])).toEqual([["open", "Who owns the importer?"], ["blocking", "Is the vendor contract signed?"]]);
    const files = [{ path: "outputs/prototype/PMX-3/README.md", content: md }];
    expect(draftFile({ files, record: { artifact: { kind: "url", ref: "https://preview.example/p/3" } } as any })).toBeNull();
    expect(draftFile({ files, record: null })?.path).toBe("outputs/prototype/PMX-3/README.md");
  });

  it("reads a deadline only where the draft states one", () => {
    expect(deadlineIn("Recommendation: yes, before Dec 8.", now)).toBe("2026-12-08");
    expect(deadlineIn("Due by 2027-01-15 at the latest.", now)).toBe("2027-01-15");
    expect(deadlineIn("Decide by 3 March.", now)).toBe("2027-03-03");
    expect(deadlineIn("The board meets on Dec 15.", now)).toBeNull();
    expect(deadlineIn("Close date 2027-02-12.", now)).toBeNull();
  });

  it("chooses the next stage of work from the task's kind, or the kind the draft names", () => {
    const all = Object.keys(DEFAULT_TEAM.categories);
    expect(followUpKind("Which providers do accounts use?", "problem-brief", all)).toBe("research-synthesis");
    expect(followUpKind("Which providers do accounts use?", "competitive-analysis", all)).toBe("research-synthesis");
    expect(followUpKind("Which providers do accounts use?", "spec", all)).toBe("research-synthesis");
    // A question about commitment or payment goes to a validation plan; "pilot-wide" isn't one.
    expect(followUpKind("Would an account pay for it, or sign a pilot?", "competitive-analysis", all)).toBe("validation-plan");
    expect(followUpKind("Is the figure pilot-wide or the peak?", "problem-brief", all)).toBe("research-synthesis");
    // The kind the draft names wins.
    expect(followUpKind("Needs a build brief for the importer.", "problem-brief", all)).toBe("build-brief");
    // Only the team's own kinds: without research, a problem brief's questions go to a spec.
    expect(followUpKind("Which providers?", "problem-brief", ["problem-brief", "spec"])).toBe("spec");
    // A team's own kind of work goes by its stage: the next stage, then its own.
    const stages = { "stakeholder-update": "identify", "launch-check": "build" };
    expect(followUpKind("What's left?", "stakeholder-update", ["stakeholder-update", "launch-check"], stages)).toBe("launch-check");
    expect(followUpKind("What's left?", "launch-check", ["stakeholder-update", "launch-check"], stages)).toBe("launch-check");
    expect(followUpKind("What's left?", "spec", [])).toBeNull();
  });
});

describe("a decision brief's decision becomes one to-do (FOLLOW-1, R1)", () => {
  const now = new Date(2026, 10, 26, 10);
  const one = (md: string) => {
    const r = readFollowUps(md, "PMX-16", now);
    return { decisions: r.decisions.map((d) => [d.text, d.why, d.due]), questions: r.questions.map((q) => [q.where, q.question]) };
  };
  const WHY = "Recommendation: Counter with a one-year lock and a usage floor: it keeps the account and caps the margin risk at a year.";

  it("a bare PM decides ending the Recommendation is the Decision section's choice, the Recommendation's why and the Decision's date", () => {
    expect(one(DECISION_BRIEF)).toEqual({
      decisions: [["Decide whether to accept, counter or decline Globex's request for a two-year price lock at renewal (PMX-16)", WHY, "2026-12-12"]],
      questions: [["open", "Will Globex accept a one-year lock?"]],
    });
    // The same when the mark ends the Recommendation's last paragraph instead of standing alone.
    expect(one(DECISION_BRIEF.replace("would change this.\n\n**PM decides**\n", "would change this. **PM decides**.\n"))).toEqual(one(DECISION_BRIEF));
  });

  it("**PM decides:** <the decision> gives the to-do its words, with the same why and date", () => {
    expect(one(DECISION_BRIEF_NAMED).decisions).toEqual([["Decide whether to accept, counter or decline the two-year lock (PMX-16)", WHY, "2026-12-12"]]);
  });

  it("(PM decides) beside a Choice: line is the same one decision, its label left out", () => {
    const decision = [["Decide whether to accept, counter or decline Globex's request for a two-year price lock at renewal (PMX-16)", WHY, "2026-12-12"]];
    // Marked twice, beside the choice and at the end of the Recommendation: still one to-do.
    expect(one(DECISION_BRIEF_INLINE).decisions).toEqual(decision);
    // Marked beside the choice only.
    expect(one(DECISION_BRIEF_INLINE.replace("**PM decides**\n", "")).decisions).toEqual(decision);
    // Outside a decision brief, a "Choice:" label is left out of the to-do too.
    const spec = DRAFT.replace("- SCIM is the most asked-for", "- Choice: renew, extend or drop the importer contract (**PM decides**). Recommend renewing before Jan 15.\n- SCIM is the most asked-for");
    expect(readFollowUps(spec, "PMX-14", now).decisions.find((d) => /importer/.test(d.text))).toMatchObject({
      text: "Decide whether to renew, extend or drop the importer contract (PMX-14)", why: "Recommend renewing before Jan 15.", due: "2027-01-15",
    });
    const labelled = DRAFT.replace("- SCIM is the most asked-for", "- Decision: keep or retire the legacy importer. **PM decides.**\n- SCIM is the most asked-for");
    expect(readFollowUps(labelled, "PMX-14", now).decisions.map((d) => d.text)).toContain("Decide whether to keep or retire the legacy importer (PMX-14)");
  });

  it("other calls in a decision brief are read as before", () => {
    const md = DECISION_BRIEF.replace("- Will Globex accept", "- Should we also offer a usage report? **PM decides.**\n- Will Globex accept");
    expect(one(md).decisions.map((d) => d[0])).toEqual([
      "Decide whether to accept, counter or decline Globex's request for a two-year price lock at renewal (PMX-16)",
      "Decide whether to also offer a usage report (PMX-16)",
    ]);
  });

  it("the draft-ready comment counts the calls and questions accepting reads, for these drafts and every skill's own example", async () => {
    const counted = (md: string) => {
      const r = readFollowUps(md, "PMX-1", now);
      // A call worded as something to do is counted apart, as a thing to do (FOLLOW-1, 2026-11-27).
      return { open: r.questions.filter((q) => q.where === "open").length, blocking: r.questions.filter((q) => q.where === "blocking").length, pmDecides: r.decisions.filter((d) => !d.action).length, actions: r.decisions.filter((d) => d.action).length };
    };
    const examples: [string, string][] = [];
    for (const s of ["pmx-build-brief", "pmx-competitive", "pmx-decision-brief", "pmx-problem-brief", "pmx-research", "pmx-spec", "pmx-validation-plan", "pmx-validation-readout"]) {
      examples.push([s, await readFile(join(bundledSkillsDir(), s, "fixtures", "expected.md"), "utf8")]);
    }
    for (const [name, md] of [["spec", DRAFT], ["big", BIG_DRAFT], ["done", DONE_DRAFT], ["brief", DECISION_BRIEF], ["named", DECISION_BRIEF_NAMED], ["inline", DECISION_BRIEF_INLINE], ...examples] as [string, string][]) {
      expect(draftCounts(md), name).toEqual(counted(md));
    }
    // The skills built around one decision give it, with its recommendation alongside and the Decision section's date.
    const example = (s: string) => readFollowUps(examples.find(([n]) => n === s)![1], "PMX-1", now).decisions.map((d) => [d.text, d.why, d.due]);
    expect(example("pmx-decision-brief")).toEqual([[
      "Decide which integration ships with the launch (PMX-1)", "Recommendation: The email builder first: it carries a paid commitment and has no partner paperwork in the way.", "2026-12-02",
    ]]);
    expect(example("pmx-validation-readout")).toEqual([["Decide whether to scale, iterate or stop (PMX-1)", "Recommendation: Scale: ask more security owners now, with the contractor fix as proof.", null]]);
    // A readout written before this fix, with a bare PM decides under its options, names them.
    const bare = examples.find(([n]) => n === "pmx-validation-readout")![1].replace("**PM decides:** whether to scale, iterate or stop.", "**PM decides**.");
    expect(readFollowUps(bare, "PMX-1", now).decisions.map((d) => d.text)).toEqual(["Decide between Scale, Iterate and Stop (PMX-1)"]);
    const base = { title: "Decide on Globex's renewal terms", prUrl: "branch:pmx/task/PMX-16-x", path: "outputs/decision-brief/PMX-16.md", agent: "ana@m1" };
    for (const md of [DECISION_BRIEF, DECISION_BRIEF_NAMED, DECISION_BRIEF_INLINE]) {
      expect(draftComment({ ...base, markdown: md })).toContain("\nIt leaves 1 open question and 1 call marked PM decides.\n");
    }
  });
});

describe("accepting a draft makes its follow-ups (FOLLOW-1)", () => {
  beforeEach(freshHome);

  it("calls become private to-dos and questions suggested tasks, nothing in Linear, and the answer says so", async () => {
    const { tracker, ctx, svc } = await drafted();
    const before = tracker.tasks.size;
    const { items, host } = await loadQueue(ctx, svc);
    const msg = await decide(ctx, svc, host, items[0]!, "accepted", { reviewMinutes: 3 });
    expect(msg).toBe("PMX-14 accepted. 4 decisions added to your to-dos; 2 follow-up tasks wait for your approval in Needs you.");
    expect(tracker.tasks.get("lin-1")!.status).toBe("done");
    // APPROVE-1: nothing reached the tracker.
    expect(tracker.tasks.size).toBe(before);

    const todos = (await loadTodos()).items;
    expect(todos.map((t) => [t.text, t.due, t.source.title])).toEqual([
      ["Decide whether to include SCIM in every plan (PMX-14)", "2026-12-08", "From PMX-14's accepted draft, outputs/spec/PMX-14.md"],
      ["Decide whether SCIM ships in the first release (PMX-14)", null, "From PMX-14's accepted draft, outputs/spec/PMX-14.md"],
      ["Decide whether to pursue the question: How long does a CSV import take an admin today? (PMX-14)", null, "From PMX-14's accepted draft, outputs/spec/PMX-14.md"],
      ["Decide whether to offer SCIM on the free plan (PMX-14)", null, "From PMX-14's accepted draft, outputs/spec/PMX-14.md"],
    ]);
    expect(todos.every((t) => t.status === "open" && t.source.keys.length === 0)).toBe(true);

    const ps = await readProposals();
    expect(ps.map((p) => [p.title, p.category, p.size, p.follows])).toEqual([
      ["Which identity providers do our largest accounts use?", "research-synthesis", "S", { identifier: "PMX-14", path: "outputs/spec/PMX-14.md", url: "https://linear.app/acme/issue/PMX-14", where: "blocking" }],
      ["Would an account pay for SCIM as an add-on, or sign a pilot to try it?", "validation-plan", "S", { identifier: "PMX-14", path: "outputs/spec/PMX-14.md", url: "https://linear.app/acme/issue/PMX-14", where: "blocking" }],
    ]);
    // The original task's sources, and a pointer to the accepted draft; the question in its words.
    const open = ps[1]!;
    expect(open.sources).toEqual(["T1", "S1"]);
    expect(open.description).toBe([
      "Would an account pay for SCIM as an add-on, or sign a pilot to try it?",
      "",
      "**Follows PMX-14:** a blocking question its accepted draft left, in the team repo at `outputs/spec/PMX-14.md`.",
      "**Size S, not checked:** PMX doesn't size follow-ups. Change the size if the work is bigger.",
      "**Based on** one meeting and one channel thread (2026-11-01, 2026-11-02). The sources stay on the PM's Mac.",
      "",
      "pmx:source T1",
      "pmx:source S1",
    ].join("\n"));
    expect(formatProposal(open, 2, false)).toBe(`2. [${open.id}] Would an account pay for SCIM as an add-on, or sign a pilot to try it?  (validation-plan, size S, follows PMX-14)`);

    // The run log and Linear get exactly what an accept always records.
    const verdicts = (await new RunLogStore(ctx).entries()).filter((e) => e.type === "verdict");
    expect(verdicts).toMatchObject([{ verdict: "accepted", taskId: "PMX-14", reviewMinutes: 3 }]);
    expect(tracker.comments.get("lin-1")!.at(-1)).toBe("Accepted by ana.");

    // Approving one is like approving any proposal: it reaches the tracker with its kind, size and sources.
    const r = await approveProposals(ctx, svc, [ps[0]!.id]);
    const made = [...tracker.tasks.values()].find((t) => t.identifier === r.posted[0]!.identifier)!;
    expect(made).toMatchObject({ title: "Which identity providers do our largest accounts use?", category: "research-synthesis", size: "S", status: "inbox", sources: ["T1", "S1"] });
  });

  it("a decision brief's decision becomes one to-do with its why and date, as the draft-ready comment counted (R1)", async () => {
    const { tracker, ctx, svc } = await drafted({ draft: DECISION_BRIEF, task: { identifier: "PMX-16", title: "Decide on Globex's renewal terms", category: "decision-brief" } });
    expect(tracker.comments.get("lin-1")!.at(-1)).toContain("\nIt leaves 1 open question and 1 call marked PM decides.\n");
    const { items, host } = await loadQueue(ctx, svc);
    expect(await decide(ctx, svc, host, items[0]!, "accepted")).toBe("PMX-16 accepted. 1 decision added to your to-dos; 1 follow-up task waits for your approval in Needs you.");
    expect((await loadTodos()).items.map((t) => [t.text, t.why, t.due, t.source.title])).toEqual([[
      "Decide whether to accept, counter or decline Globex's request for a two-year price lock at renewal (PMX-16)",
      "Recommendation: Counter with a one-year lock and a usage floor: it keeps the account and caps the margin risk at a year.",
      "2026-12-12",
      "From PMX-16's accepted draft, outputs/decision-brief/PMX-16.md",
    ]]);
    expect((await readProposals()).map((p) => p.title)).toEqual(["Will Globex accept a one-year lock?"]);
  });

  it("accepting the same draft again doesn't double them, even after the PM acted on them", async () => {
    const { ctx, svc } = await drafted();
    const { items, host } = await loadQueue(ctx, svc);
    const item = items[0]!;
    await decide(ctx, svc, host, item, "accepted");
    // The PM approves one task and drops nothing; the others still wait. A second accept of the same draft (another
    // surface retrying, or the same draft decided again) makes nothing new.
    await approveProposals(ctx, svc, [(await readProposals())[0]!.id]);
    const again = await followUpsOnAccept(ctx, svc, item);
    expect(again).toMatchObject({ todos: [], proposals: [], repeated: 6, duplicates: 0 });
    expect(followUpText(again)).toBe("6 follow-ups were already made from this draft.");
    expect((await loadTodos()).items).toHaveLength(4);
    expect(await readProposals()).toHaveLength(1);
  });

  it("makes at most 3 tasks (blocking questions first) and 5 to-dos per draft; the rest stay in the draft, also on a second accept", async () => {
    expect([FOLLOW_TASKS, FOLLOW_TODOS]).toEqual([3, 5]);
    const { ctx, svc } = await drafted({ draft: BIG_DRAFT });
    const { items, host } = await loadQueue(ctx, svc);
    const item = items[0]!;
    expect(await decide(ctx, svc, host, item, "accepted")).toBe("PMX-14 accepted. 5 decisions added to your to-dos; 3 follow-up tasks wait for your approval in Needs you; 2 more questions stay in the draft; 2 more decisions stay in the draft.");
    const ps = await readProposals();
    expect(ps.map((p) => [p.follows!.where, p.title])).toEqual([
      ["blocking", "Which identity providers do our largest accounts use?"],
      ["blocking", "Does the importer handle nested groups?"],
      ["open", "How long does a CSV import take an admin today?"],
    ]);
    expect(ps.every((p) => p.follows!.more === 2)).toBe(true);
    expect(formatProposal(ps[0]!, 1, true)).toContain("· Follows PMX-14: a blocking question from its accepted draft, outputs/spec/PMX-14.md (2 more questions stay there)");
    // R2b: "**Call 1.** Whether to offer …" is a label, then the decision: the to-do is the decision.
    expect((await loadTodos()).items.map((t) => t.text)).toEqual(["guided setup", "a support-led setup", "SCIM in every plan", "a Business-only plan", "an admin audit log"].map((x) => `Decide whether to offer ${x} (PMX-14)`));
    // Accepting it again makes neither the ones made nor the ones left in the draft.
    const again = await followUpsOnAccept(ctx, svc, item);
    expect(again).toMatchObject({ todos: [], proposals: [], repeated: 8, moreQuestions: 2, moreDecisions: 2 });
    expect(followUpText(again)).toBe("2 more questions stay in the draft; 2 more decisions stay in the draft; 8 follow-ups were already made from this draft.");
    expect(await readProposals()).toHaveLength(3);
    expect((await loadTodos()).items).toHaveLength(5);
  });

  it("skips what is already open or waiting under the same title", async () => {
    const { ctx, svc } = await drafted({ tasks: [task({ id: "lin-2", identifier: "PMX-15", title: "Which identity providers do our largest accounts use?", status: "inbox" })] });
    await stageProposals([{ at: new Date().toISOString(), receipt: "", title: "Would an account pay for SCIM as an add-on, or sign a pilot to try it", description: "Waiting.", category: "spec", size: "S", sources: [], from: [] }]);
    const { items, host } = await loadQueue(ctx, svc);
    const msg = await decide(ctx, svc, host, items[0]!, "accepted");
    expect(msg).toBe("PMX-14 accepted. 4 decisions added to your to-dos; 2 follow-ups were already on your list.");
    expect((await readProposals()).map((p) => p.title)).toEqual(["Would an account pay for SCIM as an add-on, or sign a pilot to try it"]);
  });

  it("a follow-up that can't be made never undoes the accept, and says why in a sentence with no command", async () => {
    const { tracker, ctx, svc } = await drafted();
    // A to-do list written by a newer pmx can't be changed by this one.
    await writeFile(join(process.env.PMX_HOME!, "todos.json"), JSON.stringify({ v: 99, processed: {}, items: [] }));
    const { items, host } = await loadQueue(ctx, svc);
    const msg = await decide(ctx, svc, host, items[0]!, "accepted");
    expect(msg).toMatch(/^PMX-14 accepted\. PMX couldn't make its follow-ups: .*todos\.json was written by a newer pmx \(format 99; .*\)\.$/);
    expect(msg).not.toMatch(/\bpmx [a-z]|`/);
    expect(tracker.tasks.get("lin-1")!.status).toBe("done");
    expect((await new RunLogStore(ctx).entries()).filter((e) => e.type === "verdict")).toHaveLength(1);
  });

  it("a draft with nothing left over says only that it was accepted", async () => {
    const { ctx, svc } = await drafted({ draft: DONE_DRAFT });
    const { items, host } = await loadQueue(ctx, svc);
    expect(await decide(ctx, svc, host, items[0]!, "accepted")).toBe("PMX-14 accepted.");
    expect(await readProposals()).toEqual([]);
    expect((await loadTodos()).items).toEqual([]);
  });

  it("a team turns it off with followUps: false, validated like its other settings", async () => {
    const { ctx, svc } = await drafted({ team: { followUps: false } });
    const { items, host } = await loadQueue(ctx, svc);
    expect(await decide(ctx, svc, host, items[0]!, "accepted")).toBe("PMX-14 accepted.");
    expect(await readProposals()).toEqual([]);
    expect((await loadTodos()).items).toEqual([]);
    const team = (over: object) => ({ ...DEFAULT_TEAM, team: "t", ...over }) as TeamConfig;
    expect(() => validateTeamConfig(team({ followUps: "no" }))).toThrow(/followUps must be true or false, not "no"/);
    expect(validateTeamConfig(team({ followUps: false })).followUps).toBe(false);
    expect(validateTeamConfig(team({})).followUps).toBeUndefined();
  });

  it("keeps the tracker's text rules: a question with a quote, a private name or a source's words stays in the draft", async () => {
    const { repo } = await pmxRepo();
    const crm = join(repo, "..", "crm.txt");
    await writeFile(crm, "Jo Bramwell\n");
    const ctx = await testCtx({ repo, personal: { crmNamesFile: crm } });
    const svc = await services(ctx, { tracker: memoryTracker([]) });
    const md = [
      "# PMX-20: Spec", "", "## Open questions", "",
      "- Does Jo Bramwell's team still export by hand?",
      "- Is \"good enough\" what light users pay for?",
      "- Will admins at Acme keep exporting a spreadsheet every single Friday afternoon by hand?",
      "- Which identity providers matter most? Admins said they keep exporting a spreadsheet every single Friday afternoon by hand. Recommend a short survey.",
    ].join("\n");
    const item = {
      task: task({ id: "lin-20", identifier: "PMX-20", category: "spec" }), record: null,
      files: [{ path: "outputs/spec/PMX-20.md", content: md }],
      citations: { T1: "Admins keep exporting a spreadsheet every single Friday afternoon by hand, and hate it." },
    };
    const r = await followUpsOnAccept(ctx, svc, item);
    expect(r.leftOut).toBe(3);
    const ps = await readProposals();
    expect(ps.map((p) => p.title)).toEqual(["Which identity providers matter most?"]);
    // The sentence that repeats a source is left out of the description; the recommendation stays.
    expect(ps[0]!.description.split("\n")[0]).toBe("Which identity providers matter most? Recommend a short survey.");
    expect(followUpText(r)).toBe("1 follow-up task waits for your approval in Needs you; 3 questions stayed in the draft, because their words can't go to Linear as written.");
  });
});

describe("pmx review without a terminal (F21)", () => {
  // The command builds its own services, as `pmx review` does; this hands it the test's tracker.
  let injected: ReturnType<typeof memoryTracker> | null = null;
  registerServices({ tracker: async () => injected as any });
  beforeEach(freshHome);
  afterEach(() => { injected = null; });
  const drafted2 = async () => { const d = await drafted(); injected = d.tracker; return d; };

  const run = async (ctx: any, values: Record<string, unknown>, positionals: string[] = [], tty = false) => {
    const out: string[] = [], err: string[] = [];
    const log = console.log, error = console.error;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      const code = await reviewCommand.run({ values, positionals, ctx: async () => ctx, ask: null as any, cliPath: "", tty });
      return { code, out: out.join("\n"), err: err.join("\n") };
    } finally { console.log = log; console.error = error; }
  };

  it("refuses in one sentence, exits non-zero and decides nothing", async () => {
    const { tracker, ctx } = await drafted2();
    const r = await run(ctx, {});
    expect(r).toEqual({ code: 1, out: "", err: NO_TERMINAL });
    expect(NO_TERMINAL).toBe("No terminal here: use --accept, --redo or --reject with a task id.");
    expect(tracker.tasks.get("lin-1")!.status).toBe("review");
    expect(reviewCommand.usage).toMatch(/--accept <PMX-12 …> \| --redo <PMX-12> --note "…" \| --reject <PMX-12> --note "…"/);
  });

  it("--accept records what the terminal review records, follow-ups included", async () => {
    const { tracker, ctx } = await drafted2();
    const r = await run(ctx, { accept: ["pmx-14"] });
    expect(r.code).toBe(0);
    expect(r.out).toBe("PMX-14 accepted. 4 decisions added to your to-dos; 2 follow-up tasks wait for your approval in Needs you.\nYour to-dos: pmx todo · Tasks waiting for your approval: pmx proposals");
    expect(tracker.tasks.get("lin-1")!.status).toBe("done");
    expect(tracker.comments.get("lin-1")!.at(-1)).toBe("Accepted by ana.");
    const verdicts = (await new RunLogStore(ctx).entries()).filter((e) => e.type === "verdict");
    expect(verdicts).toMatchObject([{ verdict: "accepted", taskId: "PMX-14", category: "spec", reviewMinutes: null }]);
    expect(await readProposals()).toHaveLength(2);
  });

  it("--redo and --reject need a note, take one task, and record it", async () => {
    const { tracker, ctx, svc } = await drafted2();
    await expect(scriptedReview(ctx, svc, { redo: "PMX-14" })).rejects.toThrow('A redo needs a note: add --note "…".');
    await expect(scriptedReview(ctx, svc, { reject: "PMX-14", note: " " })).rejects.toThrow(/A reject needs a note/);
    await expect(scriptedReview(ctx, svc, { redo: "PMX-14", reject: "PMX-14", note: "x" })).rejects.toThrow(/not both/);
    await expect(scriptedReview(ctx, svc, { accept: ["PMX-14"], note: "x" })).rejects.toThrow("--note goes with --redo or --reject.");
    await expect(scriptedReview(ctx, svc, { accept: ["PMX-14", "PMX-14"] })).rejects.toThrow(/named twice/);
    const r = await run(ctx, { redo: "PMX-14", note: "Add rollout risks" });
    expect(r).toMatchObject({ code: 0, out: "PMX-14 redo." });
    expect(tracker.tasks.get("lin-1")).toMatchObject({ status: "ready", agent: null });
    expect(tracker.tasks.get("lin-1")!.description).toMatch(/^pmx:note Add rollout risks$/m);
    expect(tracker.comments.get("lin-1")!.at(-1)).toBe("Redo requested by ana: Add rollout risks");
    // A redo makes no follow-ups.
    expect(await readProposals()).toEqual([]);
  });

  it("a task that isn't waiting decides nothing and says which, exit non-zero", async () => {
    const { tracker, ctx } = await drafted2();
    const r = await run(ctx, { accept: ["PMX-14"] }, ["PMX-99"]);
    expect(r).toEqual({ code: 1, out: "", err: "PMX-99 isn't waiting for review here, so nothing was decided. Waiting for review here: PMX-14." });
    expect(tracker.tasks.get("lin-1")!.status).toBe("review");
    const reject = await run(ctx, { reject: "PMX-14", note: "Wrong segment" });
    expect(reject).toMatchObject({ code: 0, out: "PMX-14 rejected." });
    expect(tracker.tasks.get("lin-1")!.status).toBe("blocked");
  });
});

describe("the pages after Accept (FOLLOW-1)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });
  beforeEach(freshHome);

  it("the review page's Accept answers with what it made", async () => {
    const { ctx, svc } = await drafted();
    const s = await startReviewServer(ctx, svc);
    try {
      const token = new URL(s.url).searchParams.get("t")!;
      const r = await fetch(`http://127.0.0.1:${s.port}/api/items/lin-1/accept`, { method: "POST", headers: { "x-pmx-token": token, "content-type": "application/json" }, body: "{}" });
      expect(await r.json()).toEqual({ ok: true, message: "PMX-14 accepted. 4 decisions added to your to-dos; 2 follow-up tasks wait for your approval in Needs you." });
    } finally { await s.close(); }
  });

  for (const app of [false, true]) it(`PMX's page says what Accept made, and the follow-ups wait in Needs you as "Follows PMX-7"${app ? " (Claude app)" : ""}`, async () => {
    const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
    const branch = "pmx/task/PMX-7-spec-scim-sync";
    ui = await openBoard({
      app, hash: "needs", team: { tracker: LINEAR as any },
      before: async (ctx) => {
        const repo = ctx.personal.repoPath;
        await git(repo, "checkout", "-q", "-b", branch);
        await mkdir(join(repo, "outputs", "spec"), { recursive: true });
        // One question more than the cap of 3 tasks (the open question marked PM decides is a call, not a task).
        await writeFile(join(repo, "outputs", "spec", "PMX-7.md"), `${DRAFT.replace(/PMX-14/g, "PMX-7")}- How many admins run the export by hand?\n- Which plans do those admins pay for?\n`);
        await git(repo, "add", "-A");
        await git(repo, "commit", "-q", "-m", "PMX-7: Spec SCIM sync");
        await git(repo, "checkout", "-q", "main");
        await mkdir(relayDir(), { recursive: true });
        await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [{
          id: "uuid-7", identifier: "PMX-7", title: "Spec SCIM sync", description: "Admins sync users by hand.\n\npmx:source T1\npmx:source S1",
          url: "https://linear.app/acme/issue/PMX-7", priority: 0, createdAt: new Date().toISOString(), comments: { nodes: [{ body: `pmx:pr branch:${branch}\nDraft ready for review.` }] },
          labels: { nodes: [{ name: "review", parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "S", parent: { name: "pmx-size" } }, { name: ctx.agent, parent: { name: "pmx-agent" } }] },
        }] }));
      },
    });
    const card = (text: string) => ui!.all("main [role=listitem]").find((r) => r.textContent?.includes(text));
    await ui.until(() => card("Spec SCIM sync"), "the draft card");
    await ui.click([...card("Spec SCIM sync")!.querySelectorAll(".acts button")].find((b) => b.textContent === "Accept")!);
    await ui.until(() => /PMX-7 accepted\. 4 decisions added to your to-dos; 3 follow-up tasks wait for your approval in Needs you; 1 more question stays in the draft\./.test(ui!.text("#toast")), "the accept's answer", 15000);
    const followUp = await ui.until(() => card("Which identity providers do our largest accounts use?"), "a follow-up in Needs you", 15000);
    expect([...followUp.querySelectorAll(".chip")].map((c) => c.textContent)).toContain("Follows PMX-7");
    expect(ui.all("main [role=listitem]").filter((r) => /Follows PMX-7/.test(r.textContent ?? ""))).toHaveLength(3);
    // Its details say how many questions stayed in the draft, where the draft is, and link to the task.
    await ui.click(followUp.querySelector(".t")!);
    const follows = await ui.until(() => ui!.$("#sheet.open #follows"), "the follow-up's details");
    expect(follows.querySelector("p")!.textContent).toBe("PMX-7: a question its accepted draft left open. 1 more question stays in the draft. The draft is in your team repo at outputs/spec/PMX-7.md. Approve it to give it to the team; drop it if it doesn't need doing.");
    expect([...follows.querySelectorAll("a")].map((a) => [a.textContent!.trim(), a.getAttribute("href")])).toEqual([["Open PMX-7 in Linear", "https://linear.app/acme/issue/PMX-7"]]);
    // The PM's calls are their to-dos now, citing the task and the draft.
    const todos = (await loadTodos()).items.map((t) => t.text);
    expect(todos).toContain("Decide whether SCIM ships in the first release (PMX-7)");
    expect(pageText(ui)).not.toMatch(/\bpmx [a-z]/);
    // Nothing reached Linear but the accept itself: the relay queues its comment and status, no new task.
    const outbox = JSON.parse(await readFile(join(relayDir(), "outbox.json"), "utf8"));
    expect(outbox.ops.map((o: any) => o.kind)).not.toContain("create-task");
  }, 45000);
});
