// FOLLOW-1, R2: a follow-up question one person can answer becomes the accepting PM's to-do ("Ask <role>: …"), not a
// task. Only questions that need research or a document become suggested tasks, titled with the whole question, of a
// kind picked from the question. The drafting skills mark each question ("— ask: <role>", "— needs: <kind of work>");
// without a mark, the reader goes by the question's words.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { services } from "../src/core/services.js";
import { bundledSkillsDir } from "../src/core/skills.js";
import type { Task } from "../src/core/types.js";
import { pull } from "../src/pull/pull.js";
import { draftCounts } from "../src/run/comment.js";
import { askText, FOLLOW_ASKS, FOLLOW_TASKS, FOLLOW_TODOS, followUpKind, followUpsOnAccept, followUpText, readFollowUps } from "../src/review/followups.js";
import { decide, loadQueue } from "../src/review/queue.js";
import { followUpHint } from "../src/review/tui.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { readProposals } from "../src/synth/proposals.js";
import { loadTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const NOW = new Date(2026, 10, 26, 10);

/** A spec draft whose open questions carry the skills' marks: three for a person to answer, one for research. */
const MARKED = `# PMX-21: Spec the editor plugin for Initech

## Problem

Initech's editors copy content between tools by hand [T1].

## Evidence

- Manual copying every day [T1]
- A plugin request from a second account [S1]

## Validated by

Not validated yet: no account has committed [T1].

## Proposal

A plugin for the editor, built on the public API.

## Success metrics

- Editors stop copying by hand.

## Blocking questions

- Who signs the contract at Globex, and who is the procurement contact? — ask: the account lead. Needed before Dec 12.

## Open questions

- Can a designer be freed for the plugin UI in December? — ask: the design lead
- Who funds the $10,000, and what is our share? — ask: the finance lead
- Which editors do our largest accounts use alongside the plugin? — needs: research
- **Open:** what Initech asked for, since no cited source shows it.
`;

/** The same draft as an older skill, or a team's own copy, wrote it: no marks. */
const UNMARKED = MARKED.replace(/ — (?:ask|needs): [^.\n]+\.?/g, "");

/** Two questions to ask and one to research: the answer counts two to-dos and one suggested task. */
const SMALL = `# PMX-22: Spec SSO for the admin console

## Problem

Admins at Globex sign in with a shared password [T1].

## Evidence

- A shared admin password [T1]
- A second SSO ask [S1]

## Validated by

Not validated yet [T1].

## Proposal

SSO for the admin console.

## Success metrics

- No shared admin passwords.

## Open questions

- Is the security review for Globex approved? — ask: the security lead
- When will the identity team's new API ship? — ask: the platform engineering lead
- How many admins sign in from more than one device? — needs: research
`;

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-21", identifier: "PMX-21", title: "Spec the editor plugin for Initech",
  description: "Editors copy by hand.\n\n- [T1] Initech call: we copy everything by hand\n- [S1] #feedback: plugin ask\n\n**Based on** one meeting and one channel thread (2026-11-01, 2026-11-02). The sources stay on the PM's Mac.\n\npmx:source T1\npmx:source S1",
  url: "https://linear.app/acme/issue/PMX-21", category: "spec", size: "M", status: "ready", priority: 2, agent: null,
  sources: ["T1", "S1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

/** A task drafted through `pull`, its draft waiting for review, as the accept surfaces see it. */
async function drafted(o: { draft: string; task?: Partial<Task>; team?: Partial<TeamConfig> }) {
  const { repo } = await pmxRepo(o.team ?? {});
  const tracker = memoryTracker([task(o.task)]);
  const runtime = mockRuntime(async (r) => {
    const out = r.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(r.cwd, out)), { recursive: true });
    await writeFile(join(r.cwd, out), o.draft);
    return { text: "Drafted.", costUsd: 0.1 };
  });
  const ctx = await testCtx({ repo, runtime, team: o.team, now: NOW });
  const svc = await services(ctx, { tracker });
  const r = await pull(ctx, svc, { dryRun: false });
  expect(r.ran?.outcome).toBe("ok");
  return { tracker, ctx, svc };
}

/** Accepting a draft straight through followUpsOnAccept, for the rules that don't need a pull. */
async function accept(md: string, o: { citations?: Record<string, string>; crm?: string[]; path?: string } = {}) {
  const { repo } = await pmxRepo();
  let personal = {};
  if (o.crm) {
    const crm = join(repo, "..", "crm.txt");
    await writeFile(crm, `${o.crm.join("\n")}\n`);
    personal = { crmNamesFile: crm };
  }
  const ctx = await testCtx({ repo, personal, now: NOW });
  const svc = await services(ctx, { tracker: memoryTracker([]) });
  const item = { task: task(), record: null, files: [{ path: o.path ?? "outputs/spec/PMX-21.md", content: md }], citations: o.citations ?? {} };
  return { r: await followUpsOnAccept(ctx, svc, item), item, ctx, svc };
}

const read = (md: string) => readFollowUps(md, "PMX-21", NOW).questions.map((q) => ({ where: q.where, title: q.title, ask: q.ask, needs: q.needs }));

describe("sorting a draft's questions: to ask or to work on (FOLLOW-1, R2)", () => {
  it("reads the skills' marks: a role to ask, or the kind of work a question needs", () => {
    expect(read(MARKED)).toEqual([
      { where: "blocking", title: "Who signs the contract at Globex, and who is the procurement contact?", ask: { role: "the account lead", by: "mark" }, needs: null },
      { where: "open", title: "Can a designer be freed for the plugin UI in December?", ask: { role: "the design lead", by: "mark" }, needs: null },
      { where: "open", title: "Who funds the $10,000, and what is our share?", ask: { role: "the finance lead", by: "mark" }, needs: null },
      { where: "open", title: "Which editors do our largest accounts use alongside the plugin?", ask: null, needs: "research" },
      // A fragment the draft left after its label becomes a whole task, with nothing added but "Find out".
      { where: "open", title: "Find out what Initech asked for", ask: null, needs: null },
    ]);
    // The mark is gone from what the task or the to-do says, and the rest of the item stays.
    const blocking = readFollowUps(MARKED, "PMX-21", NOW).questions[0]!;
    expect([blocking.question, blocking.rest]).toEqual(["Who signs the contract at Globex, and who is the procurement contact?", ["Needed before Dec 12."]]);
    // The mark also reads in brackets, after a spaced hyphen, or as a sentence of its own; never without its colon.
    const forms = "# T\n\n## Open questions\n\n- Who owns the importer? (ask: Legal)\n- Who approves the budget? - ask: the CFO\n- Which plans do admins use? Needs: a competitive analysis.\n- Who signs at Globex — needs approval first?\n";
    expect(read(forms).map((q) => [q.title, q.ask, q.needs])).toEqual([
      ["Who owns the importer?", { role: "legal", by: "mark" }, null],
      ["Who approves the budget?", { role: "the CFO", by: "mark" }, null],
      ["Which plans do admins use?", null, "a competitive analysis"],
      ["Who signs at Globex — needs approval first?", { role: null, by: "words" }, null],
    ]);
  });

  it("without a mark, a question one person can answer is still an ask, by its words; research stays work", () => {
    expect(read(UNMARKED).map((q) => [q.title, q.ask])).toEqual([
      // FOLLOW-1: who holds a role at a company is for that company's team.
      ["Who signs the contract at Globex, and who is the procurement contact?", { role: "Globex's procurement", by: "words" }],
      ["Can a designer be freed for the plugin UI in December?", { role: null, by: "words" }],
      ["Who funds the $10,000, and what is our share?", { role: null, by: "words" }],
      ["Which editors do our largest accounts use alongside the plugin?", null],
      ["Find out what Initech asked for", null],
    ]);
    const md = [
      "# T", "", "## Open questions", "",
      // Who to ask, in the draft's words.
      "- How many accounts have more than one workspace? Ask the data team.",
      "- When will the importer ship? Sales could find out before Dec 2.",
      // Status, dates and terms a person knows.
      "- Is the DPA approved?",
      "- What is our share of the co-marketing budget?",
      "- Does Globex have budget this quarter?",
      // Research: customers in general, counts, comparisons, and interviews to run.
      "- What is the price customers expect for SSO?",
      "- How long does a CSV import take an admin today? Recommend asking two admins this week.",
      "- Does the importer handle nested groups?",
      "- Will Globex accept a one-year lock?",
    ].join("\n");
    expect(read(md).map((q) => [q.title, q.ask?.role ?? (q.ask ? "(no role)" : "work")])).toEqual([
      ["How many accounts have more than one workspace?", "the data team"],
      ["When will the importer ship?", "sales"],
      ["Is the DPA approved?", "(no role)"],
      ["What is our share of the co-marketing budget?", "(no role)"],
      ["Does Globex have budget this quarter?", "(no role)"],
      ["What is the price customers expect for SSO?", "work"],
      ["How long does a CSV import take an admin today?", "work"],
      ["Does the importer handle nested groups?", "work"],
      ["Will Globex accept a one-year lock?", "work"],
    ]);
  });

  it("names a role, never a person: a name in the mark or the draft's words leaves the role out", () => {
    const md = [
      "# T", "", "## Open questions", "",
      "- Who funds the pilot? — ask: Lee Park",
      "- Who signs at Globex? Ask Lee Park, the account lead.",
      "- Who owns the importer? — ask: Sam from engineering",
      "- Who approves the DPA? — ask: Globex's procurement contact",
      "- Who runs the beta? — ask: the Product Lead",
    ].join("\n");
    expect(read(md).map((q) => q.ask?.role ?? null)).toEqual([null, "the account lead", null, "Globex's procurement contact", "the Product Lead"]);
  });

  it("titles are whole questions or tasks, never a fragment", () => {
    const md = [
      "# T", "", "## Open questions", "",
      "- Pricing: would accounts pay $20 a seat for SSO? — needs: a validation plan",
      "- Unclear: how long imports take for the largest accounts.",
      "- what the renewal includes?",
      "- The importer is slow [T1]. Admins wait hours [T1]. How long does an import take?",
      "- It's unclear whether Initech's pilot converts.",
    ].join("\n");
    expect(read(md).map((q) => q.title)).toEqual([
      "Would accounts pay $20 a seat for SSO?",
      "Find out how long imports take for the largest accounts",
      "What the renewal includes?",
      "How long does an import take?",
      "Find out whether Initech's pilot converts",
    ]);
  });

  it("a PM decides mark with a colon and a short call says it once (Decide on the deletion window, not Decide: : …)", () => {
    const md = "# T\n\n## Retention\n\n- **PM decides:** Deletion window.\n- **PM decides** — export format.\n";
    expect(readFollowUps(md, "PMX-17", NOW).decisions.map((d) => d.text)).toEqual(["Decide on the deletion window (PMX-17)", "Decide on the export format (PMX-17)"]);
  });

  it("an older plan's marks inside labels and option lists make no to-do; its named calls do (R2b)", () => {
    const plan = (named: boolean) => [
      "# PMX-30: Validation plan for the guided importer", "",
      "## Hypothesis", "", "Admins at multi-workspace customers will pay for a guided importer [T1].", "",
      "## The ask", "",
      "- **Internal plan.** Run the pilot with our own admins first, then Globex [T1]. **PM decides**.",
      "- **Length:** *Assumption:* the sources don't give one; 60 days. **PM decides.**",
      "- **Price options (all **PM decides**):** a flat pilot fee or the first quarter of the subscription [S1].",
      "- Should the price for dedicated capacity be set as an add-on? **PM decides.**",
      "- The buyer is Globex's IT lead [T1]. Price: **PM decides**.", "",
      "## What counts", "", "Options (**PM decides**):", "- A signed paid pilot counts as validated.", "- A security review started counts as validated.", "",
      ...(named ? [
        "## Open questions", "",
        "1. **PM decides:** whether to pilot with Globex before Initech.",
        "2. **PM decides:** whether the pilot fee is flat or the first quarter of the subscription.",
        "3. **PM decides:** which rung counts as validated, before Dec 10.",
      ] : []),
    ].join("\n");
    const calls = (md: string) => readFollowUps(md, "PMX-30", NOW).decisions.map((d) => [d.text, d.due]);
    // With "PM decides: …" calls, those and the calls worded as a choice are the decisions; the rest stay in the draft.
    expect(calls(plan(true))).toEqual([
      ["Decide whether the price for dedicated capacity should be set as an add-on (PMX-30)", null],
      ["Decide whether to pilot with Globex before Initech (PMX-30)", null],
      ["Decide whether the pilot fee is flat or the first quarter of the subscription (PMX-30)", null],
      ["Decide which rung counts as validated, before Dec 10 (PMX-30)", "2026-12-10"],
    ]);
    // Without them, a label leads to its decision, and a mark with no decision of its own still makes none.
    const loose = calls(plan(false)).map(([t]) => t);
    expect(loose).toEqual([
      "Decide on the internal plan: Run the pilot with our own admins first, then Globex (PMX-30)",
      "Decide whether the price for dedicated capacity should be set as an add-on (PMX-30)",
      "Decide on the price (PMX-30)",
    ]);
    for (const t of [...loose, ...calls(plan(true)).map(([x]) => x)]) expect(t).not.toMatch(/Decide: [^:()]{1,40}:|\(\s*\)|\(all|Assumption/);
  });

  it("\"Should the …\" and \"Should it …\" calls are worded as whether, like \"Should we …\"", () => {
    const md = "# T\n\n## Implications\n\n- Should it ship in the first release? **PM decides.**\n- Should the ship date move to January? **PM decides.**\n- Should we offer SCIM on the free plan? **PM decides.**\n";
    expect(readFollowUps(md, "PMX-1", NOW).decisions.map((d) => d.text)).toEqual([
      "Decide whether it should ship in the first release (PMX-1)",
      "Decide whether the ship date should move to January (PMX-1)",
      "Decide whether to offer SCIM on the free plan (PMX-1)",
    ]);
  });

  it("an unmarked statement isn't a question, and a question that points back to its label says what it means (R2c)", () => {
    const md = [
      "# T", "", "## Open questions", "",
      "- The sources mention a second partner answer due Dec 15.",
      "- B2C counts for Globex and Initech asks.",
      "- Initech partner terms: when do they close, and what are the co-marketing specifics?",
      "- how long imports take is still unknown.",
      "- Pilot length for Globex — needs: a validation plan",
    ].join("\n");
    expect(read(md).map((q) => q.title)).toEqual([
      "When do the Initech partner terms close, and what are the co-marketing specifics?",
      "Find out how long imports take",
      // Marked by the skill as a question, so it is one.
      "Pilot length for Globex",
    ]);
    expect(draftCounts(md)).toEqual({ open: 3, blocking: 0, pmDecides: 0, actions: 0 });
  });

  it("the draft-ready comment still counts every question once, asks included", () => {
    expect(draftCounts(MARKED)).toEqual({ open: 4, blocking: 1, pmDecides: 0, actions: 0 });
    expect(draftCounts(UNMARKED)).toEqual(draftCounts(MARKED));
  });
});

/** R2e: calls marked PM decides and worded as questions, beside questions that need work. */
const CALLS_AS_QUESTIONS = `# PMX-40: Validation plan for concurrent runs

## Hypothesis

Design partners will pay for more concurrent runs [T1].

## Open questions

- **PM decides:** Ship beta with 4 concurrent on Team, or raise it for design partners?
- Do we give Globex any numbers before Dec 4? **PM decides.**
- **PM decides:** Should we ship with 4 concurrent?
- Ship the beta to Initech first, or raise the limit? **PM decides.**
- Would design partners pay for more concurrent runs? — needs: a validation plan
- How many teams run more than 4 at once? — needs: research
- Which editors do our largest accounts use? — needs: research
`;

describe("a call marked PM decides is the PM's, an explicit mark beats the words (FOLLOW-1, R2e, R2f, R2d)", () => {
  const calls = (md: string, id = "PMX-40") => readFollowUps(md, id, NOW).decisions.map((d) => [d.text, d.why, d.due]);

  it("R2e: an item marked PM decides is a decision whatever its \"?\", and never takes a task's place", () => {
    expect(calls(CALLS_AS_QUESTIONS).map(([t, , due]) => [t, due])).toEqual([
      ["Decide whether to ship beta with 4 concurrent on Team, or raise it for design partners (PMX-40)", null],
      ["Decide whether to give Globex any numbers before Dec 4 (PMX-40)", "2026-12-04"],
      ["Decide whether to ship with 4 concurrent (PMX-40)", null],
      ["Decide whether to ship the beta to Initech first, or raise the limit (PMX-40)", null],
    ]);
    expect(read(CALLS_AS_QUESTIONS).map((q) => [q.title, q.needs])).toEqual([
      ["Would design partners pay for more concurrent runs?", "a validation plan"],
      ["How many teams run more than 4 at once?", "research"],
      ["Which editors do our largest accounts use?", "research"],
    ]);
    // The draft-ready comment counts what the reader reads.
    expect(draftCounts(CALLS_AS_QUESTIONS)).toEqual({ open: 3, blocking: 0, pmDecides: 4, actions: 0 });
  });

  it("R2f: a needs mark is work and an ask mark an ask, whatever the words; with PM decides it's the call, the role in its why", () => {
    const md = [
      "# T", "", "## Open questions", "",
      "- Should training runs have their own limit? — needs: research",
      "- Should training runs have their own limit for design partners?",
      "- **PM decides:** Is the monthly allowance pooled across workspaces? — ask: the pricing owner",
      "- Who signs the overage terms? — ask: the account lead",
      "- Who owns the overage invoice? — ask: the PM",
    ].join("\n");
    expect(read(md).map((q) => [q.title, q.ask?.role ?? null, q.needs])).toEqual([
      ["Should training runs have their own limit?", null, "research"],
      ["Who signs the overage terms?", "the account lead", null],
    ]);
    expect(calls(md)).toEqual([
      // Unmarked, the words decide: "Should <something> …?" is whether it should.
      ["Decide whether training runs should have their own limit for design partners (PMX-40)", "", null],
      ["Decide whether the monthly allowance is pooled across workspaces (PMX-40)", "Ask the pricing owner.", null],
      // The PM is no one to ask: a question for the PM is the PM's call.
      ["Decide who owns the overage invoice (PMX-40)", "", null],
    ]);
  });

  it("R2d: a short call after \"PM decides:\" is the decision, and what follows it is its why, never dropped", () => {
    const md = [
      "# PMX-17: Spec retention", "", "## Retention", "",
      "- **PM decides:** Deletion window. No source gives one. Recommend asking the data lead and legal before Dec 9.",
      "- **PM decides:** whether to keep raw logs past the window.",
      "- **PM decides:** kill date and price floor.",
      "- **PM decides:** whether to cap `gpu_ms` per `adapter_version`, as the _retention_ note says.",
    ].join("\n");
    expect(calls(md, "PMX-17")).toEqual([
      ["Decide on the deletion window (PMX-17)", "No source gives one. Recommend asking the data lead and legal before Dec 9.", "2026-12-09"],
      ["Decide whether to keep raw logs past the window (PMX-17)", "", null],
      // "kill date" is a noun, not "whether to kill".
      ["Decide on the kill date and price floor (PMX-17)", "", null],
      // Code keeps its underscores; emphasis doesn't.
      ["Decide whether to cap gpu_ms per adapter_version, as the retention note says (PMX-17)", "", null],
    ]);
  });
});

describe("the kind of work a question needs comes from the question (FOLLOW-1, R2)", () => {
  const all = Object.keys(DEFAULT_TEAM.categories);
  const kind = (q: string, own: string | null = "spec", needs: string | null = null, kinds = all) => followUpKind(q, own, kinds, {}, { needs, question: q });

  it("a kind the item names, then the mark, then the question's words, then the next stage", () => {
    // The item names a kind: it wins, even over the mark.
    expect(kind("Needs a build brief for the importer.", "spec", "research")).toBe("build-brief");
    // The mark.
    expect(kind("Which plans do admins use?", "spec", "a validation plan")).toBe("validation-plan");
    expect(kind("Which plans do admins use?", "problem-brief", "research")).toBe("research-synthesis");
    expect(kind("Which plans do admins use?", "spec", "a prototype")).toBe("build-brief");
    // The question's words.
    expect(kind("How do competitors price SSO compared with us?")).toBe("competitive-analysis");
    expect(kind("Will Globex sign a paid pilot before January?", "competitive-analysis")).toBe("validation-plan");
    expect(kind("How would we build the importer for nested groups?", "problem-brief")).toBe("spec");
    expect(kind("What should the prototype stub, and what must be real?", "problem-brief")).toBe("build-brief");
    expect(kind("Which editors do our largest accounts use?", "validation-plan")).toBe("research-synthesis");
    // Nothing in the question: the next stage after the task's kind, as before.
    expect(kind("Is the figure pilot-wide or the peak?", "problem-brief")).toBe("research-synthesis");
    expect(kind("What's left?", "validation-plan")).toBe("validation-readout");
  });

  it("only kinds the team has count, the mark's and the words' too", () => {
    const few = ["problem-brief", "spec"];
    expect(kind("Which plans do admins use?", "problem-brief", "a validation plan", few)).toBe("spec");
    expect(kind("How do competitors price SSO compared with us?", "problem-brief", null, few)).toBe("spec");
    expect(kind("What's left?", "spec", null, [])).toBeNull();
  });
});

describe("accepting a draft: questions to ask become to-dos, work becomes tasks (FOLLOW-1, R2)", () => {
  beforeEach(freshHome);

  it("the answer counts the to-dos and the task: 2 questions to ask, 1 suggested task", async () => {
    const { tracker, ctx, svc } = await drafted({ draft: SMALL, task: { id: "lin-22", identifier: "PMX-22", title: "Spec SSO for the admin console" } });
    const before = tracker.tasks.size;
    const { items, host } = await loadQueue(ctx, svc);
    expect(await decide(ctx, svc, host, items[0]!, "accepted")).toBe("PMX-22 accepted. 2 questions to ask added to your to-dos; 1 follow-up task waits for your approval in Needs you.");
    expect((await loadTodos()).items.map((t) => [t.text, t.source.title])).toEqual([
      ["Ask the security lead: Is the security review for Globex approved? (PMX-22)", "From PMX-22's accepted draft, outputs/spec/PMX-22.md"],
      ["Ask the platform engineering lead: When will the identity team's new API ship? (PMX-22)", "From PMX-22's accepted draft, outputs/spec/PMX-22.md"],
    ]);
    expect((await readProposals()).map((p) => [p.title, p.category])).toEqual([["How many admins sign in from more than one device?", "research-synthesis"]]);
    // Nothing reached Linear (APPROVE-1), and the terminal points to both lists.
    expect(tracker.tasks.size).toBe(before);
  });

  it("R2e: accepting gives the calls to the PM and the task places to the work, the validation plan included", async () => {
    const { r } = await accept(CALLS_AS_QUESTIONS);
    expect(followUpText(r)).toBe("4 decisions added to your to-dos; 3 follow-up tasks wait for your approval in Needs you.");
    expect((await readProposals()).map((p) => [p.title, p.category])).toEqual([
      ["Would design partners pay for more concurrent runs?", "validation-plan"],
      ["How many teams run more than 4 at once?", "research-synthesis"],
      ["Which editors do our largest accounts use?", "research-synthesis"],
    ]);
  });

  it("the three one-message questions become to-dos with their roles, the research one a task, the fragment a whole title", async () => {
    const { r } = await accept(MARKED);
    expect(followUpText(r)).toBe("3 questions to ask added to your to-dos; 2 follow-up tasks wait for your approval in Needs you.");
    expect((await loadTodos()).items.map((t) => [t.text, t.due, t.why])).toEqual([
      // Blocking first; due on the date the draft gives.
      ["Ask the account lead: Who signs the contract at Globex, and who is the procurement contact? (PMX-21)", "2026-12-12", "Needed before Dec 12."],
      ["Ask the design lead: Can a designer be freed for the plugin UI in December? (PMX-21)", null, "PMX-21's accepted draft lists this as an open question."],
      ["Ask the finance lead: Who funds the $10,000, and what is our share? (PMX-21)", null, "PMX-21's accepted draft lists this as an open question."],
    ]);
    const ps = await readProposals();
    expect(ps.map((p) => [p.title, p.category, p.follows?.where])).toEqual([
      ["Which editors do our largest accounts use alongside the plugin?", "research-synthesis", "open"],
      ["Find out what Initech asked for", "research-synthesis", "open"],
    ]);
    // The description keeps the draft's words, without the mark.
    expect(ps[0]!.description.split("\n")[0]).toBe("Which editors do our largest accounts use alongside the plugin?");
    expect(ps[1]!.description.split("\n")[0]).toBe("what Initech asked for, since no cited source shows it.");
    expect(followUpHint([r])).toBe("Your to-dos: pmx todo · Tasks waiting for your approval: pmx proposals");
  });

  it("an unmarked draft sorts the same way; a question with no role says Find out:", async () => {
    const { r } = await accept(UNMARKED);
    expect(r).toMatchObject({ asks: [{}, {}, {}], proposals: [{}, {}] });
    expect((await loadTodos()).items.map((t) => [t.text, t.due])).toEqual([
      ["Ask Globex's procurement: Who signs the contract at Globex, and who is the procurement contact? (PMX-21)", "2026-12-12"],
      ["Find out: Can a designer be freed for the plugin UI in December? (PMX-21)", null],
      ["Find out: Who funds the $10,000, and what is our share? (PMX-21)", null],
    ]);
    expect((await readProposals()).map((p) => p.title)).toEqual(["Which editors do our largest accounts use alongside the plugin?", "Find out what Initech asked for"]);
  });

  it("makes at most 3 ask to-dos per draft, their own cap beside 5 decisions; the rest stay, also on a second accept", async () => {
    expect([FOLLOW_ASKS, FOLLOW_TODOS, FOLLOW_TASKS]).toEqual([3, 5, 3]);
    const md = [
      "# PMX-21: Spec", "", "## Implications", "",
      ...[1, 2, 3, 4, 5].map((n) => `- **Call ${n}.** Whether to offer option ${n} [T1]. **PM decides.**`),
      "", "## Open questions", "",
      ...["the finance lead", "the account lead", "legal", "the design lead", "the data team"].map((role, i) => `- Who approves step ${i + 1} of the rollout? — ask: ${role}`),
    ].join("\n");
    const { r, ctx, svc, item } = await accept(md);
    expect(followUpText(r)).toBe("5 decisions and 3 questions to ask added to your to-dos; 2 more questions stay in the draft.");
    expect(r.asks.map((a) => a.text)).toEqual([
      "Ask the finance lead: Who approves step 1 of the rollout? (PMX-21)",
      "Ask the account lead: Who approves step 2 of the rollout? (PMX-21)",
      "Ask legal: Who approves step 3 of the rollout? (PMX-21)",
    ]);
    const again = await followUpsOnAccept(ctx, svc, item);
    expect(again).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 8, moreQuestions: 2 });
    expect((await loadTodos()).items).toHaveLength(8);
  });

  it("an ask is a private to-do: Linear's quote rule doesn't keep it in the draft (R2a)", async () => {
    const md = [
      "# PMX-21: Spec", "", "## Open questions", "",
      "- Will the admins keep exporting a spreadsheet every single Friday afternoon by hand? — ask: the account lead",
      "- Who signs the order at Globex? — ask: the account lead. Admins keep exporting a spreadsheet every single Friday afternoon by hand. Recommend asking this week.",
      "- Is \"good enough\" what the buyer approved? — ask: the account lead",
    ].join("\n");
    const { r } = await accept(md, { citations: { T1: "Admins keep exporting a spreadsheet every single Friday afternoon by hand, and hate it." } });
    expect(r).toMatchObject({ leftOut: 0, proposals: [] });
    expect(followUpText(r)).toBe("3 questions to ask added to your to-dos.");
    expect((await loadTodos()).items.map((t) => [t.text, t.why])).toEqual([
      ["Ask the account lead: Will the admins keep exporting a spreadsheet every single Friday afternoon by hand? (PMX-21)", "PMX-21's accepted draft lists this as an open question."],
      ["Ask the account lead: Who signs the order at Globex? (PMX-21)", "Admins keep exporting a spreadsheet every single Friday afternoon by hand. Recommend asking this week."],
      ["Ask the account lead: Is \"good enough\" what the buyer approved? (PMX-21)", "PMX-21's accepted draft lists this as an open question."],
    ]);
  });

  it("a role the tracker rules would cut, like a name on the CRM list, is left out of the to-do", async () => {
    const { r } = await accept("# PMX-21: Spec\n\n## Open questions\n\n- Who signs the order? — ask: the Bramwell account lead\n", { crm: ["Bramwell"] });
    expect(r.asks.map((a) => a.text)).toEqual(["Find out: Who signs the order? (PMX-21)"]);
  });

  it("an item's own ask whose role the tracker rules cut never leaves a bare \"they\" (FOLLOW-1, 2026-11-27)", async () => {
    const md = [
      "# PMX-21: Spec", "", "## Open questions", "",
      "- **Is the other partners' need real?** Ask Dana Lee's team at Globex whether they want the approve step on or off by default.",
      "- **Do the other admins need the export?** Ask Dana Lee's team whether they need it before the beta.",
    ].join("\n");
    const { r } = await accept(md, { crm: ["Dana Lee"] });
    expect(r.asks.map((a) => a.text)).toEqual([
      // The company the cut role names: its team.
      "Ask Globex's team whether they want the approve step on or off by default (PMX-21)",
      // No company: the item's question, with the task's subject first.
      "Find out about the editor plugin for Initech: Do the other admins need the export? (PMX-21)",
    ]);
    for (const a of r.asks) expect(a.text).not.toMatch(/^Find out whether they\b|Dana/);
  });

  it("an ask already open isn't doubled", async () => {
    const md = "# PMX-21: Spec\n\n## Open questions\n\n- Is the DPA approved? — ask: legal\n";
    await accept(md);
    // Another draft of the same task (a redo) asks the same: the open to-do stands.
    const second = await accept(md, { path: "outputs/spec/PMX-21-redo.md" });
    expect(second.r).toMatchObject({ asks: [], duplicates: 1 });
    expect((await loadTodos()).items.map((t) => t.text)).toEqual(["Ask legal: Is the DPA approved? (PMX-21)"]);
  });

  it("an ask to-do's words: a role or none, a clause asked as is, never over 200 characters", () => {
    expect(askText("the finance lead", "Who funds the pilot?", "PMX-1")).toBe("Ask the finance lead: Who funds the pilot? (PMX-1)");
    expect(askText(null, "Who funds the pilot?", "PMX-1")).toBe("Find out: Who funds the pilot? (PMX-1)");
    expect(askText("legal", "Find out whether the DPA is signed", "PMX-1")).toBe("Ask legal whether the DPA is signed (PMX-1)");
    expect(askText(null, "Find out what Initech asked for", "PMX-1")).toBe("Find out what Initech asked for (PMX-1)");
    expect(askText("the account lead", `Who ${"signs ".repeat(60)}?`, "PMX-1").length).toBeLessThanOrEqual(200);
  });
});

describe("the drafting skills mark their questions (FOLLOW-1, R2)", () => {
  const drafting = ["pmx-build-brief", "pmx-competitive", "pmx-decision-brief", "pmx-problem-brief", "pmx-research", "pmx-spec", "pmx-validation-plan", "pmx-validation-readout"];

  it("every drafting skill asks for the mark, and every question in its example carries one", async () => {
    for (const s of drafting) {
      const skill = (await readFile(join(bundledSkillsDir(), s, "SKILL.md"), "utf8")).replace(/\s+/g, " ");
      expect(skill, s).toContain("`— ask: <role>` when one person can answer it");
      expect(skill, s).toContain("`— needs: <kind of work>` when it takes research or a document");
      expect(skill, s).toContain("Name a role, never a person.");
      const example = await readFile(join(bundledSkillsDir(), s, "fixtures", "expected.md"), "utf8");
      const qs = readFollowUps(example, "PMX-1", NOW).questions;
      // A call worded as a question and marked PM decides needs no mark: approving or dropping its task is the call.
      const unmarked = qs.filter((q) => q.ask?.by !== "mark" && !q.needs && !q.rest.some((x) => /PM decides/i.test(x)));
      expect(unmarked.map((q) => q.question), s).toEqual([]);
      expect(qs.length + readFollowUps(example, "PMX-1", NOW).decisions.length, s).toBeGreaterThan(0);
    }
  });
});
