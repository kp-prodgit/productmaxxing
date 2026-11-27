// D2-8 (FOLLOW-1, UPGRADE-1): the follow-ups a PMX before 0.38.0 left waiting for approval, read again by today's rules
// once, at the first background run after the update. A question one person can answer becomes an "Ask <role>: …"
// to-do, a call a decision to-do, and work keeps waiting with today's title and kind. One whose draft can't be read stays.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { readJson } from "../src/core/fsutil.js";
import { paths } from "../src/core/paths.js";
import { listReceipts } from "../src/core/receipt.js";
import { services } from "../src/core/services.js";
import { loadState, updateState } from "../src/core/state.js";
import type { Task } from "../src/core/types.js";
import { AUTO_STEPS, REQUEUE_ASKED, upgradeOnStart } from "../src/core/upgrade.js";
import { currentVersion } from "../src/core/version.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { followUpsFile, followUpsOnAccept, type Requeued } from "../src/review/followups.js";
import { NOT_A_FOLLOW_UP, requeueStep, requeueText, type RequeueResult } from "../src/review/requeue.js";
import { readProposals, stageProposals, type Proposal } from "../src/synth/proposals.js";
import { loadTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const NOW = new Date(2026, 10, 26, 10);
const PATH = "outputs/spec/PMX-21.md";

/** A draft as a PMX before 0.38.0 read it: no "— ask:" or "— needs:" marks. */
const DRAFT = `# PMX-21: Spec the editor plugin for Initech

## Problem

Initech's editors copy content between tools by hand [T1].

## Blocking questions

- Who signs the contract at Globex, and who is the procurement contact? Needed before Dec 12.

## Open questions

- Can a designer be freed for the plugin UI in December?
- **PM decides:** Ship the beta with 4 concurrent runs, or raise it for design partners?
- Which editors do our largest accounts use alongside the plugin?
- what Initech asked for, since no cited source shows it.
`;

/** The end-to-end test's lows (2026-11-27), in a draft as a PMX before 0.38.0 read it. */
const LOWS = `# PMX-21: Spec the approval step

## Open questions

- How many refreshes per team per year does the customer expect? Needed before we set a retrain allowance. **PM decides.**
- Which approval gate applies: the $50k vendor threshold, the $20k-per-team self-approval limit, or both? Pursue: ask the buyer directly. **PM decides.**
- **Does the beta scope meet the compliance bar?** Compare it with the fields [C14]. **PM decides:** check the scope against the list in writing with Globex's Legal & Compliance lead. Recommend yes.
- Does a font change mid-run restart the job? [C26] **PM decides:** whether to warn users. Recommendation: confirm first.
- **Is the other partners' need real?** Ask the other four beta partners whether they want the approve step on or off by default. Evidence so far is Globex only [C14].
- **Separation of duties definition.** Same user only, or also same role or team? Needs the customer's input [C9].
- **Written plan owed.** Our head of product promised Globex a written plan by Nov 24 [C9]. The sources do not show whether it was sent.
- Send the plan.
`;

/** A follow-up as 0.37.0 staged it: its title the question as the draft wrote it, no `checked`. */
const staged = (title: string, o: Partial<Omit<Proposal, "id">> = {}): Omit<Proposal, "id"> => ({
  at: "2026-11-20T10:00:00.000Z", receipt: "synthesize-20261101T100000Z", title,
  description: `${title}\n\n**Follows PMX-21:** an open question its accepted draft left, in the team repo at ${PATH}.\n**Size S, not checked:** PMX doesn't size follow-ups. Change the size if the work is bigger.\n\npmx:source T1`,
  category: "validation-plan", size: "S", sources: ["T1"], from: [],
  follows: { identifier: "PMX-21", path: PATH, url: "https://linear.app/acme/issue/PMX-21", where: "open" }, ...o,
});

async function mac(draft: string | null = DRAFT) {
  const { repo } = await pmxRepo();
  if (draft !== null) {
    await mkdir(dirname(join(repo, PATH)), { recursive: true });
    await writeFile(join(repo, PATH), draft);
  }
  return { repo, ctx: await testCtx({ repo, now: NOW }) };
}

const step = AUTO_STEPS.find((s) => s.id === "follow-ups-requeue")!;
const deps = { exec: (async () => ({ code: 1, stdout: "", stderr: "" })) as any, launchd: fakeLaunchd(), cliPath: "/x/cli.js", interactive: false, devInstall: async () => false };

describe("the waiting follow-ups an older PMX made, read again by today's rules (D2-8, FOLLOW-1, UPGRADE-1)", () => {
  beforeEach(freshHome);

  it("questions one person can answer become to-dos, with their due date and where they came from, and leave Needs you", async () => {
    const { ctx } = await mac();
    await stageProposals([
      staged("Who signs the contract at Globex, and who is the procurement contact?", { follows: { identifier: "PMX-21", path: PATH, url: null, where: "blocking" } }),
      staged("Can a designer be freed for the plugin UI in December?"),
    ]);
    await updateState((s) => { s.followUpRequeue = { due: true, at: null }; });
    expect(await requeueStep(ctx)).toBe("PMX turned 2 waiting follow-ups into to-dos (2 questions one person can answer).");
    expect((await loadTodos()).items.map((t) => [t.text, t.due, t.why, t.source.title])).toEqual([
      // Due on the date the draft gives, as on the day it was staged.
      ["Ask Globex's procurement: Who signs the contract at Globex, and who is the procurement contact? (PMX-21)", "2026-12-12", "Needed before Dec 12.", `From PMX-21's accepted draft, ${PATH}`],
      ["Find out: Can a designer be freed for the plugin UI in December? (PMX-21)", null, "PMX-21's accepted draft lists this as an open question.", `From PMX-21's accepted draft, ${PATH}`],
    ]);
    // The run and sources it had as a task stay with it, so moving it to the team again carries them.
    expect((await loadTodos()).items.map((t) => [t.receiptId, t.sources])).toEqual([["synthesize-20261101T100000Z", ["T1"]], ["synthesize-20261101T100000Z", ["T1"]]]);
    expect(await readProposals()).toEqual([]);
  });

  it("a call becomes a decision to-do, work keeps waiting with today's title and kind, and each change is recorded", async () => {
    const { ctx } = await mac();
    await stageProposals([
      staged("Ship the beta with 4 concurrent runs, or raise it for design partners?"),
      staged("Which editors do our largest accounts use alongside the plugin?"),
      staged("what Initech asked for, since no cited source shows it."),
    ]);
    await updateState((s) => { s.followUpRequeue = { due: true, at: null }; });
    expect(await requeueStep(ctx)).toBe("PMX turned 1 waiting follow-up into a to-do (1 call that is yours). 2 that need work still wait for your approval, with a clearer title.");
    expect((await loadTodos()).items.map((t) => t.text)).toEqual(["Decide whether to ship the beta with 4 concurrent runs, or raise it for design partners (PMX-21)"]);
    // The whole question as the title, and the kind of work the question asks for: what accounts use is research.
    expect((await readProposals()).map((p) => [p.title, p.category, p.follows?.identifier, p.checked])).toEqual([
      ["Which editors do our largest accounts use alongside the plugin?", "research-synthesis", "PMX-21", undefined],
      ["Find out what Initech asked for", "research-synthesis", "PMX-21", undefined],
    ]);
    // The follow-ups ledger says what became of each, by the draft it came from.
    const ledger = await readJson<{ drafts: Record<string, { requeued: { was: string; as: string; now: string }[] }> }>(followUpsFile());
    expect(ledger!.drafts[`PMX-21 ${PATH}`]!.requeued.map((r) => [r.as, r.was, r.now])).toEqual([
      ["decision", "Ship the beta with 4 concurrent runs, or raise it for design partners?", "Decide whether to ship the beta with 4 concurrent runs, or raise it for design partners (PMX-21)"],
      ["work", "Which editors do our largest accounts use alongside the plugin?", "Which editors do our largest accounts use alongside the plugin?"],
      ["work", "what Initech asked for, since no cited source shows it.", "Find out what Initech asked for"],
    ]);
    // Accepting the draft again makes none of them twice.
    const svc = await services(ctx, { tracker: memoryTracker([]) });
    const task = { id: "lin-21", identifier: "PMX-21", title: "Spec the editor plugin for Initech", description: "x", url: "", category: "spec", size: "M", status: "ready", priority: 2, agent: null, sources: [], prUrl: null, createdAt: "2026-11-01T00:00:00Z" } as Task;
    const again = await followUpsOnAccept(ctx, svc, { task, record: null, files: [{ path: PATH, content: DRAFT }], citations: {} });
    expect(again.todos).toEqual([]);
    expect((await loadTodos()).items.filter((t) => /ship the beta/.test(t.text))).toHaveLength(1);
  });

  it("leaves alone a follow-up whose draft can't be read, one a newer PMX staged, and synthesis's own tasks", async () => {
    const { ctx } = await mac();
    await stageProposals([
      staged("Who owns the importer at Globex?", { follows: { identifier: "PMX-22", path: "outputs/spec/PMX-22.md", url: null, where: "open" } }),
      staged("Who funds the pilot, and what is our share?", { follows: { identifier: "PMX-23", path: "../outside.md", url: null, where: "open" } }),
      staged("Can a designer be freed for the plugin UI in December?", { checked: 2 }),
      { ...staged("Who signs the order form?"), follows: undefined },
      staged("Who owns the done task's follow-up?", { follows: { identifier: "PMX-5", path: "", url: null, where: "done" } }),
    ]);
    const before = await readProposals();
    await updateState((s) => { s.followUpRequeue = { due: true, at: null }; });
    expect(await requeueStep(ctx)).toBeNull();
    expect(await readProposals()).toEqual(before);
    expect((await loadTodos()).items).toEqual([]);
    expect((await loadState()).followUpRequeue).toMatchObject({ due: false, did: "no waiting follow-up from an older PMX needed a change" });
  });

  it("the end-to-end test's lows: each reads as a person would write it, and a fragment that is no follow-up is dropped (2026-11-27)", async () => {
    const { ctx } = await mac(LOWS);
    await stageProposals([
      staged("How many refreshes per team per year does the customer expect?"),
      staged("Which approval gate applies: the $50k vendor threshold, the $20k-per-team self-approval limit, or both?"),
      staged("Does the beta scope meet the compliance bar?"),
      staged("Does a font change mid-run restart the job?"),
      staged("Is the other partners' need real?"),
      staged("Separation of duties definition. Same user only, or also same role or team?"),
      staged("Written plan owed."),
      staged("Send the plan."),
    ]);
    await updateState((s) => { s.followUpRequeue = { due: true, at: null }; });
    // "Check the scope …" is a thing to do, counted apart from the calls that are the PM's (2026-11-27).
    expect(await requeueStep(ctx)).toBe("PMX turned 5 waiting follow-ups into to-dos (2 questions one person can answer, 2 calls that are yours and 1 thing to do). One that needs work still waits for your approval, with a clearer title. It dropped \"Written plan owed.\", which is no question, call or task.");
    expect((await loadTodos()).items.map((t) => t.text)).toEqual([
      "Ask the customer: How many refreshes per team per year does the customer expect? (PMX-21)",
      "Decide which approval gate applies: the $50k vendor threshold, the $20k-per-team self-approval limit, or both (PMX-21)",
      "Check the scope against the list in writing with Globex's Legal & Compliance lead (PMX-21)",
      "Decide whether to warn users, given the question: Does a font change mid-run restart the job? (PMX-21)",
      "Ask the other four beta partners whether they want the approve step on or off by default (PMX-21)",
    ]);
    // The label stays the subject of the work still waiting; the short action stays as it was; the fragment is gone.
    expect((await readProposals()).map((p) => p.title)).toEqual(["Separation of duties definition: same user only, or also same role or team?", "Send the plan."]);
    const ledger = await readJson<{ drafts: Record<string, { requeued: { was: string; as: string; now: string }[] }> }>(followUpsFile());
    expect(ledger!.drafts[`PMX-21 ${PATH}`]!.requeued.filter((r) => r.as === "dropped").map((r) => r.was)).toEqual(["Written plan owed."]);
  });

  it("a dropped follow-up's reason is in the ledger on this Mac, though the run behind its task is on another PM's Mac (2026-11-27)", async () => {
    const { ctx } = await mac(LOWS);
    await stageProposals([staged("Written plan owed."), staged("Does the beta scope meet the compliance bar?")]);
    // The synthesis run that suggested PMX-21 is on another PM's Mac: this Mac has no receipt to say why.
    expect(await listReceipts()).toEqual([]);
    await updateState((s) => { s.followUpRequeue = { due: true, at: null }; });
    // The notice still says what it dropped.
    expect(await requeueStep(ctx)).toBe("PMX turned 1 waiting follow-up into a to-do (1 thing to do). It dropped \"Written plan owed.\", which is no question, call or task.");
    const ledger = await readJson<{ drafts: Record<string, { requeued: { was: string; as: string; now: string; why?: string }[] }> }>(followUpsFile());
    expect(ledger!.drafts[`PMX-21 ${PATH}`]!.requeued.map((r) => [r.as, r.was, r.now, r.why ?? null])).toEqual([
      // A call worded as something to do is recorded as one.
      ["action", "Does the beta scope meet the compliance bar?", "Check the scope against the list in writing with Globex's Legal & Compliance lead (PMX-21)", null],
      ["dropped", "Written plan owed.", "", "PMX: no question, call or task by today's rules"],
    ]);
    expect(NOT_A_FOLLOW_UP).toBe("PMX: no question, call or task by today's rules");
  });

  it("the notice counts each kind apart when there is more than one, a thing to do apart from the calls (2026-11-27)", () => {
    const none: RequeueResult = { asks: [], decisions: [], actions: [], retitled: [], dropped: [], unchanged: 0, unreadable: 0 };
    const r = (as: "ask" | "decision" | "action") => ({ at: NOW.toISOString(), proposal: "p1", was: "x", as, now: "y" });
    expect(requeueText({ ...none, decisions: [r("decision"), r("decision")], actions: [r("action")] }))
      .toBe("PMX turned 3 waiting follow-ups into to-dos (2 calls that are yours and 1 thing to do).");
    expect(requeueText({ ...none, asks: [r("ask")], decisions: [r("decision")] }))
      .toBe("PMX turned 2 waiting follow-ups into to-dos (1 question one person can answer and 1 call that is yours).");
    // One kind: counted too (2026-11-27).
    expect(requeueText({ ...none, decisions: [r("decision"), r("decision")] })).toBe("PMX turned 2 waiting follow-ups into to-dos (2 calls that are yours).");
  });

  it("a notice with one kind counts it too, and each word agrees with its count, at one and at many (2026-11-27)", () => {
    const none: RequeueResult = { asks: [], decisions: [], actions: [], retitled: [], dropped: [], unchanged: 0, unreadable: 0 };
    const r = (as: Requeued["as"], was = "x") => ({ at: NOW.toISOString(), proposal: "p1", was, as, now: "y" });
    const many = (as: Requeued["as"], k: number) => Array.from({ length: k }, () => r(as));
    // Each kind alone, at one and at many: never "(questions one person can answer)" for one.
    expect([1, 12].flatMap((k) => [
      requeueText({ ...none, asks: many("ask", k) }), requeueText({ ...none, decisions: many("decision", k) }), requeueText({ ...none, actions: many("action", k) }),
    ])).toEqual([
      "PMX turned 1 waiting follow-up into a to-do (1 question one person can answer).",
      "PMX turned 1 waiting follow-up into a to-do (1 call that is yours).",
      "PMX turned 1 waiting follow-up into a to-do (1 thing to do).",
      "PMX turned 12 waiting follow-ups into to-dos (12 questions one person can answer).",
      "PMX turned 12 waiting follow-ups into to-dos (12 calls that are yours).",
      "PMX turned 12 waiting follow-ups into to-dos (12 things to do).",
    ]);
    // Every kind at once, each at one and at many.
    expect(requeueText({ ...none, asks: many("ask", 1), decisions: many("decision", 1), actions: many("action", 1) }))
      .toBe("PMX turned 3 waiting follow-ups into to-dos (1 question one person can answer, 1 call that is yours and 1 thing to do).");
    expect(requeueText({ ...none, asks: many("ask", 3), decisions: many("decision", 2), actions: many("action", 4) }))
      .toBe("PMX turned 9 waiting follow-ups into to-dos (3 questions one person can answer, 2 calls that are yours and 4 things to do).");
    // With work still waiting and one dropped, each in its own number too.
    expect(requeueText({ ...none, asks: many("ask", 1), retitled: [r("work")], dropped: [r("dropped", "Written plan owed.")] }))
      .toBe("PMX turned 1 waiting follow-up into a to-do (1 question one person can answer). One that needs work still waits for your approval, with a clearer title. It dropped \"Written plan owed.\", which is no question, call or task.");
    expect(requeueText({ ...none, retitled: [r("work")] })).toBe("PMX gave 1 waiting follow-up a clearer title; it still waits for your approval.");
    expect(requeueText(none)).toBeNull();
  });

  it("runs once: the update asks for it, the next background run does it and records what it did, and nothing runs it again", async () => {
    const { ctx } = await mac();
    await writeFile(paths.config(), "{}");
    await updateState((s) => { s.whatsNew = { seen: "0.37.0", since: null }; });
    await stageProposals([staged("Can a designer be freed for the plugin UI in December?")]);
    expect(step).toMatchObject({ since: null, title: "Waiting follow-ups an older PMX suggested follow today's rules" });
    expect(step.interactiveOnly).toBeFalsy();
    // Nothing is due before the update asks for it.
    expect(await requeueStep(ctx)).toBeNull();
    expect(await readProposals()).toHaveLength(1);

    // The update, in the background job: the step asks for it.
    const up = await upgradeOnStart(deps, [step]);
    expect(up.did).toEqual([{ id: "follow-ups-requeue", title: step.title, did: REQUEUE_ASKED }]);
    expect((await loadState()).followUpRequeue).toEqual({ due: true, at: null });

    // The background run does it, says so once, and the update's record says what it came to.
    expect(await requeueStep(ctx)).toBe("PMX turned 1 waiting follow-up into a to-do (1 question one person can answer).");
    const st = await loadState();
    expect(st.followUpRequeue).toEqual({ due: false, at: NOW.toISOString(), did: "PMX turned 1 waiting follow-up into a to-do (1 question one person can answer)." });
    expect(st.upgrade!.applied[`follow-ups-requeue@${currentVersion()}`]!.did).toBe("PMX turned 1 waiting follow-up into a to-do (1 question one person can answer).");

    // Never again: not at the next run, not when a follow-up like it waits again, not at a later update.
    await stageProposals([staged("Who signs the contract at Globex, and who is the procurement contact?")]);
    expect(await requeueStep(ctx)).toBeNull();
    expect(await step.run(deps)).toBeNull();
    await updateState((s) => { s.upgrade!.lastVersion = "0.39.0"; s.upgrade!.applied = {}; });
    expect((await upgradeOnStart(deps, [step])).did.map((d) => d.did)).toEqual(["nothing to do"]);
    expect(await requeueStep(ctx)).toBeNull();
    expect((await readProposals()).map((p) => p.title)).toEqual(["Who signs the contract at Globex, and who is the procurement contact?"]);
    expect((await loadTodos()).items).toHaveLength(1);
  });
});
