// R3, R12 (PRIV-6, INPUT-2, APPROVE-1): a task waiting for the PM is checked again when it's approved, by today's
// tracker rules and sentence de-duplication, against its own sources. A task an older PMX staged never reaches Linear on
// that PMX's rules: a name it let through is left out or holds the task, a repeated sentence goes once, a description
// that lost its first sentence still reads, and a task whose sources are gone says so.
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listReceipts } from "../src/core/receipt.js";
import { paths } from "../src/core/paths.js";
import { registerServices, services } from "../src/core/services.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { evidenceStore } from "../src/run/packs.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { addEvidence, approveProposals, changedText, CHECKED, companiesOf, formatProposals, heldText, mergeFacts, nearDuplicate, newFacts, proposalsFile, readProposals, stageProposals, type Proposal } from "../src/synth/proposals.js";
import { sameFact } from "../src/synth/repeats.js";
import { leadWithTitle, parseCandidates, synthesize } from "../src/synth/synthesize.js";
import { moveWork } from "../src/todo/move.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

/** A customer call: Sam Ortiz is the customer's contact, Lee Park the PM. Neither name may reach Linear. */
const CALL = [
  "---", "title: Globex beta planning", "participants: Sam Ortiz <sam@globex.example>, Lee Park <lee@us.com>", "---",
  "Sam Ortiz: Our close date moved again, and we need approvals working in the beta.",
  "",
  "Lee Park: Which parts matter first?",
  "",
  "Sam Ortiz: Approve and reject first. A log screen can come later.",
].join("\n");

const TITLE = "Spec the approval workflow for Globex's Dec 8 beta";
let injected: ReturnType<typeof memoryTracker> | null = null;
const team = { internalDomains: ["us.com"], tracker: { kind: "linear" as const, teamKey: "PMX", projectId: "pmx-1" } };

/** Today's synthesis stages one clean task from the call, as this PMX would. */
async function staged(o: { personal?: Record<string, unknown> } = {}) {
  const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
  const dir = await tmp("calls-");
  const file = await writeTranscript(dir, "globex.md", CALL);
  const runtime = mockRuntime(async (r) => {
    const id = [...r.prompt.matchAll(/<item id="([A-Z]\d+)"/g)][0]![1]!;
    return JSON.stringify({ tasks: [{
      title: TITLE, category: "spec", size: "M", rationale: "Globex needs approve and reject in its Dec 8 beta. Globex's deal now closes after GA, on Jan 29.",
      sources: [id], support: { [id]: "The customer asked for approvals in the beta." }, companies: { [id]: { name: "Globex", as: "customer" } },
    }] });
  });
  const ctx = await testCtx({ repo, runtime, team, personal: { sources: { transcriptDirs: [dir], slackChannel: null }, ...o.personal } as any });
  const tracker = memoryTracker([]);
  injected = tracker;
  const svc = await services(ctx, { tracker });
  await synthesize(ctx, svc, { days: 7 });
  const [p] = await readProposals();
  expect(p).toMatchObject({ title: TITLE, checked: CHECKED });
  return { repo, dir, file, ctx, tracker, svc, p: p! };
}

/** The same proposal as an older PMX left it: its words, and no record of which rules checked them. */
async function asOlderPmx(p: Proposal, change: Partial<Proposal>): Promise<Proposal> {
  const { checked: _, ...older } = { ...p, ...change };
  await writeFile(proposalsFile(), JSON.stringify({ v: 1, proposals: [older] }));
  return older as Proposal;
}

/** The summary paragraph a description opens with, and the rest PMX wrote. */
const summaryOf = (d: string) => d.split("\n\n")[0];
const restOf = (d: string) => d.split("\n\n").slice(1).join("\n\n");

describe("approval checks a waiting task again (R3, R12)", () => {
  beforeEach(freshHome);
  // The page's handlers build their own services, as PMX's page does; this hands them the test's tracker.
  registerServices({ tracker: async () => injected as any });
  afterEach(() => { injected = null; });

  it("an older PMX's task whose title names someone from its sources isn't sent, and says why everywhere", async () => {
    const { ctx, tracker, svc, p } = await staged({ personal: { todosToLinear: true } });
    await asOlderPmx(p, { title: "Lee: reply to Sam Ortiz on approval workflow and audit log in the Dec 8 beta." });

    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.posted).toEqual([]);
    expect(r.held).toEqual([{ id: p.id, title: "Lee: reply to Sam Ortiz on approval workflow and audit log in the Dec 8 beta.", why: "its title names a person, which Linear never gets" }]);
    expect(heldText(r.held[0]!, { command: true })).toBe(`Lee: reply to Sam Ortiz on approval workflow and audit log in the Dec 8 beta: its title names a person, which Linear never gets. It stays waiting for you: drop it, or keep it as your own to-do (\`pmx move ${p.id} private\`)`);
    expect(tracker.tasks.size).toBe(0);
    // It waits, with the reason, in `pmx proposals` and in Needs you.
    const [waiting] = await readProposals();
    expect(waiting!.held).toMatchObject({ why: "its title names a person, which Linear never gets" });
    expect(formatProposals([waiting!], false)).toContain(`Not sent when you approved it: its title names a person, which Linear never gets. Drop it, or keep it as your own to-do: \`pmx move ${p.id} private\``);
    expect((await pipelineHandlers(ctx).data(24)).proposals[0]).toMatchObject({ held: "its title names a person, which Linear never gets" });
    // The page's Approve and the move to a to-do in Linear (its title would be the to-do's words) say the same.
    expect(await pipelineHandlers(ctx).proposals("approve", [waiting!.id])).toMatch(/^Not sent: Lee: reply to Sam Ortiz .*its title names a person/);
    await expect(moveWork(ctx, async () => svc, waiting!.id, "todo")).rejects.toThrow(/^Not sent: .*its title names a person/);
    expect(tracker.tasks.size).toBe(0);
    expect(await readProposals()).toHaveLength(1);
  });

  it("an older PMX's description that names someone from its sources reaches Linear without that sentence", async () => {
    const { ctx, tracker, svc, p } = await staged();
    // The size reasoning is Claude's words too, so it's judged the same way.
    const old = await asOlderPmx(p, {
      description: p.description.replace(/^[^\n]*/, "Globex's deal now closes after GA, on Jan 29. Sam Ortiz wants approve and reject in the Dec 8 beta.")
        .replace(/^\*\*Why size M:\*\*.*$/m, "**Why size M:** One-pager. Sam Ortiz expects two weeks of work."),
    });

    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.posted).toHaveLength(1);
    expect(r.held).toEqual([]);
    expect(r.checked).toEqual(["PMX left 2 sentences that named people out of PMX-1 when you approved it"]);
    const sent = [...tracker.tasks.values()][0]!;
    expect(sent.title).toBe(TITLE);
    expect(summaryOf(sent.description)).toBe("Globex's deal now closes after GA, on Jan 29.");
    expect(sent.description).not.toMatch(/Sam|Ortiz|Lee|Park/);
    // Everything else PMX wrote below the summary is as staged: the size, the readable sources and the `pmx:source` line.
    expect(restOf(sent.description)).toBe(restOf(old.description).replace(" Sam Ortiz expects two weeks of work.", ""));
    expect(sent.description).toMatch(/^\*\*Why size M:\*\* One-pager\.$/m);
    expect(sent.description).toMatch(/\*\*Sources:\*\* a customer call with Globex \(/);
    expect(await readProposals()).toEqual([]);
  });

  it("a task this PMX staged goes exactly as the PM saw it", async () => {
    const { ctx, tracker, svc, p } = await staged();
    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r).toMatchObject({ held: [], checked: [] });
    expect([...tracker.tasks.values()][0]!.description).toBe(p.description);
  });

  it("a description with a repeated sentence reaches Linear with it once", async () => {
    const { ctx, tracker, svc, p } = await staged();
    const base = summaryOf(p.description);
    // Merges from before the de-duplication (INPUT-2) added the same facts again in other words: the close date (the
    // same company and date), and the same question. A third call brought a new date, which stays. The model's own
    // summary also said one sentence twice.
    const close = "Globex won't sign before GA, since its close date moved to Jan 29.";
    const asked = "The team still has to learn whether approve and reject can share one screen for every admin, and what an audit log export costs per year.";
    const moved = "Globex's beta moved from Dec 8 to Dec 15.";
    const question = "The spec should settle whether approve and reject can share one screen and what an audit log export costs.";
    await asOlderPmx(p, {
      description: p.description.replace(base, `${base} ${question} Globex needs approve and reject in its Dec 8 beta. ${close} ${asked} ${moved}`),
      again: [
        { receipt: "synthesize-20261105T100000Z", at: "2026-11-05T10:00:00Z", n: 1, added: [close, asked] },
        { receipt: "synthesize-20261106T100000Z", at: "2026-11-06T10:00:00Z", n: 1, added: [moved] },
      ],
    });

    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.checked).toEqual(["PMX left 3 repeated sentences out of PMX-1 when you approved it"]);
    expect(summaryOf([...tracker.tasks.values()][0]!.description)).toBe(`${base} ${question} ${moved}`);
  });

  it("a sentence an older merge said again more fully reaches Linear once, the fuller one in the other's place", async () => {
    const { ctx, tracker, svc, p } = await staged();
    const base = summaryOf(p.description);
    const [first, deal] = ["Globex needs approve and reject in its Dec 8 beta.", "Globex's deal now closes after GA, on Jan 29."];
    expect(base).toBe(`${first} ${deal}`);
    // A merge from before R12a's fuller rule added the close again, with what it waits on.
    const fuller = "Globex's deal now closes after GA, on Jan 29, once its security review is done.";
    await asOlderPmx(p, {
      description: p.description.replace(base, `${base} ${fuller}`),
      again: [{ receipt: "synthesize-20261105T100000Z", at: "2026-11-05T10:00:00Z", n: 1, added: [fuller] }],
    });

    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.checked).toEqual(["PMX left 1 repeated sentence out of PMX-1 when you approved it"]);
    expect(summaryOf([...tracker.tasks.values()][0]!.description)).toBe(`${first} ${fuller}`);
  });

  it("a description whose first sentence is left out still reads: it leads with the title", async () => {
    // At approval: an older PMX let a name through in the first sentence, and the next one leans on it.
    const { ctx, tracker, svc, p } = await staged();
    await asOlderPmx(p, { description: p.description.replace(/^[^\n]*/, "Sam Ortiz wants approve and reject in Globex's Dec 8 beta. The full workflow and a log screen follow at GA, after the Jan 29 close.") });
    await approveProposals(ctx, svc, ["1"]);
    expect(summaryOf([...tracker.tasks.values()][0]!.description)).toBe(`${TITLE}. The full workflow and a log screen follow at GA, after the Jan 29 close.`);

    // In synthesis, the same: the guard leaves out the first sentence and the summary leads with the title.
    const reply = (rationale: string) => JSON.stringify({ tasks: [{ title: TITLE, category: "spec", size: "M", rationale, sources: ["T1"], support: { T1: "The customer asked for approvals in the beta." } }] });
    const guarded = { people: { found: ["Sam Ortiz", "Sam", "Ortiz"], listed: [] } };
    const parse = (rationale: string) => parseCandidates(reply(rationale), ["spec"], new Set(["T1"]), undefined, new Map(), guarded).tasks[0]!.rationale;
    expect(parse("Sam Ortiz wants approvals in the Dec 8 beta. They want the full workflow and a log screen only at GA.")).toBe(`${TITLE}. They want the full workflow and a log screen only at GA.`);
    // Only when what's left starts mid-thought, and only when the first sentence went.
    expect(parse("Sam Ortiz wants approvals in the Dec 8 beta. Globex's deal now closes after GA, on Jan 29.")).toBe("Globex's deal now closes after GA, on Jan 29.");
    expect(parse("Globex needs approvals in the Dec 8 beta. Sam Ortiz signs off. The full workflow follows at GA.")).toBe("Globex needs approvals in the Dec 8 beta. The full workflow follows at GA.");
    // Words that refer back, by case: "IT admins" isn't "It"; a question keeps its own mark.
    expect(leadWithTitle("Spec SCIM", "IT admins sync users by hand every week.")).toBe("IT admins sync users by hand every week.");
    expect(leadWithTitle("Which identity providers first?", "Its answer sets the order.")).toBe("Which identity providers first? Its answer sets the order.");
    expect(leadWithTitle("This quarter's SSO asks", "This quarter's SSO asks. They come from three accounts.")).toBe("This quarter's SSO asks. They come from three accounts.");
  });

  it("with its sources unreadable, a task this PMX checked goes, with every check that needs no sources, and says so", async () => {
    const { ctx, tracker, svc, p, file } = await staged({ personal: { neverIngest: { people: ["Dana Reyes"], channels: [], meetingTitles: [] } } });
    // The PM's later edits aside, the staged text gained a sentence about fundraising and one naming a do-not-read person.
    const rows = JSON.parse(await readFile(proposalsFile(), "utf8"));
    rows.proposals[0].description = p.description.replace(/^[^\n]*/, (s) => `${s} Investors want the audit log before the next round. Dana Reyes owns the rollout.`);
    await writeFile(proposalsFile(), JSON.stringify(rows));
    await rm(file);

    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.posted).toHaveLength(1);
    expect(r.checked).toEqual([
      "PMX left 1 sentence that was about fundraising, 1 sentence that named a person out of PMX-1 when you approved it",
      "PMX couldn't check PMX-1 against its sources again (its meetings and threads are no longer in your folders), so it went as PMX's current rules passed it when it was suggested",
    ]);
    expect(summaryOf([...tracker.tasks.values()][0]!.description)).toBe(summaryOf(p.description));
  });

  it("with its sources unreadable, a task an older PMX staged waits, since only they could show what its rules let through", async () => {
    const { ctx, tracker, p } = await staged();
    await asOlderPmx(p, {});
    // Its synthesis run is gone from this Mac (receipts are kept 14 days).
    for (const id of await listReceipts()) await rm(join(paths.receipts(), `${id}.json`));

    const msg = await pipelineHandlers(ctx).proposals("approve", ["1"]);
    expect(msg).toBe(`Not sent: ${TITLE}: PMX can't read its sources again to check it (its synthesis run is no longer on this Mac), and an older PMX suggested it, with rules that let more through. It stays waiting for you: drop it, or keep it as your own to-do.`);
    expect(tracker.tasks.size).toBe(0);
    expect((await readProposals())[0]!.held!.why).toMatch(/^PMX can't read its sources again/);
  });

  /** A follow-up of PMX-14 on a Mac without PMX-14's synthesis run, as an older PMX staged it, and the team's copy of its quotes. */
  const followUpOf = (title: string, text = title) => ({
    at: "2026-11-05T10:00:00Z", receipt: "", title, category: "spec", size: "S" as const, sources: ["T1"], from: [],
    description: `${text}\n\n**Follows PMX-14:** an open question its accepted draft left, in the team repo at outputs/PMX-14.md.\n\npmx:source T1`,
    follows: { identifier: "PMX-14", path: "outputs/PMX-14.md", where: "open" as const },
  });
  const sharePack = (ctx: Awaited<ReturnType<typeof testCtx>>) => evidenceStore(ctx.repo).write({ put: [{ v: 1, task: "PMX-14", at: "2026-11-05T10:00:00Z", sources: [{ id: "T1", kind: "meeting", at: "2026-11-05", passages: ["Sam Ortiz: Approve and reject first. A log screen can come later."] }] }] }, "test pack");
  const otherMac = async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const ctx = await testCtx({ repo, team });
    const tracker = memoryTracker([]);
    return { ctx, tracker, svc: await services(ctx, { tracker }) };
  };

  it("an older PMX's follow-up whose task's quotes are gone from the team repo waits, since nothing can check it", async () => {
    const { ctx, tracker, svc } = await otherMac();
    await stageProposals([followUpOf("Lee: reply to Sam Ortiz on approval workflow and audit log in the Dec 8 beta.")]);
    expect((await approveProposals(ctx, svc, ["1"])).held.map((h) => h.why)).toEqual(["PMX can't read its sources again to check it (PMX-14's synthesis run isn't on this Mac, and your team's copy of its quotes doesn't have them), and an older PMX suggested it, with rules that let more through"]);
    expect(tracker.tasks.size).toBe(0);
  });

  it("a follow-up whose task's quotes are still in the team repo is held for the name in its title, not for unreadable sources", async () => {
    const { ctx, tracker, svc } = await otherMac();
    await sharePack(ctx);
    await stageProposals([followUpOf("Lee: reply to Sam Ortiz on approval workflow and audit log in the Dec 8 beta.")]);
    const r = await approveProposals(ctx, svc, ["1"]);
    // The pack's speakers are the task's people (RUN-5): the name holds the title, and the source check did run.
    expect(r.held.map((h) => h.why)).toEqual(["its title names a person, which Linear never gets"]);
    expect(r.checked).toEqual([]);
    expect(tracker.tasks.size).toBe(0);
    expect((await readProposals())[0]!.held!.why).toBe("its title names a person, which Linear never gets");
  });

  it("a follow-up whose task's pack an accept removed is checked against the copy it kept (RUN-5)", async () => {
    const { ctx, tracker, svc } = await otherMac();
    const quotes = [{ id: "T1", kind: "meeting", at: "2026-11-05", passages: ["Sam Ortiz: Approve and reject first. A log screen can come later."] }];
    await stageProposals([{ ...followUpOf("Lee: reply to Sam Ortiz on approval workflow and audit log in the Dec 8 beta."), quotes }]);
    const r = await approveProposals(ctx, svc, ["1"]);
    // No pack in the team repo, yet the source check ran on the kept copy: held for the name, not for unreadable sources.
    expect(r.held.map((h) => h.why)).toEqual(["its title names a person, which Linear never gets"]);
    expect(r.checked).toEqual([]);
    expect(tracker.tasks.size).toBe(0);
  });

  it("a follow-up checked against its task's pack knows the pack's companies are companies (R5)", async () => {
    const { ctx, tracker, svc } = await otherMac();
    // A swapped pack: no participants, so only its companies say a notes label like "Globex:" is no one's.
    const pack = { v: 1 as const, task: "PMX-14", at: "2026-11-05T10:00:00Z", nameSwap: 2, companies: ["globex"], sources: [{ id: "T1", kind: "meeting" as const, at: "2026-11-05", passages: ["Globex: approve and reject first, a log screen can come later. [PERSON-1, Globex] signs."] }] };
    await evidenceStore(ctx.repo).write({ put: [pack] }, "test pack");
    await stageProposals([followUpOf("Ask Globex which approval steps the Dec 8 beta needs")]);
    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.held).toEqual([]);
    expect([...tracker.tasks.values()][0]!.title).toBe("Ask Globex which approval steps the Dec 8 beta needs");
  });

  it("a follow-up whose task's quotes are still in the team repo goes without a sentence naming someone in them", async () => {
    const { ctx, tracker, svc } = await otherMac();
    await sharePack(ctx);
    await stageProposals([followUpOf("Which approval steps does the Dec 8 beta need?", "Which approval steps does the Dec 8 beta need? Sam Ortiz asked for approve and reject first. A log screen can wait for GA.")]);
    const r = await approveProposals(ctx, svc, ["1"]);
    expect(r.held).toEqual([]);
    expect(r.checked).toEqual(["PMX left 1 sentence that named a person out of PMX-1 when you approved it"]);
    expect(summaryOf([...tracker.tasks.values()][0]!.description)).toBe("Which approval steps does the Dec 8 beta need? A log screen can wait for GA.");
  });
});

describe("a fact a later call says again in other words joins a task once (R12a, INPUT-2)", () => {
  const once = (summary: string, later: string, companies: string[]) => newFacts(summary, later, undefined, companies);

  it("the same company and the same date or figure, the same question, or the same words stemmed", () => {
    // The same loss, the same company and date and figure.
    expect(once("Globex Hotels chose Initech for its 14-property expansion on Nov 23.", "Globex Hotels' 14-property expansion closed lost on Nov 23, mainly on price against Initech.", ["Globex Hotels"])).toEqual([]);
    // The same close date said twice in different words.
    expect(once("Globex, whose close slipped past GA to Jan 29, needs approve and reject in the Dec 8 beta.", "Globex won't sign before GA, and its close date moved to Jan 29.", ["Globex"])).toEqual([]);
    // The same licence point.
    expect(once("Initech's licence covers 40 seats until March, so the beta has to fit inside it.", "Under its licence, Initech gets 40 seats through March.", ["Initech"])).toEqual([]);
    // The same question, asked another way.
    expect(once("The brief should settle whether imprints can share a parent kit and what a guideline refresh costs.", "The team still has to learn whether one parent kit with imprint styles on top is possible for every brand, and what a refresh costs per year.", ["Globex"])).toEqual([]);
    // "internally" and "internal" are one word.
    expect(once("Initech will use the beta internally only if exports and roles are missing.", "Initech says it will use the beta for internal work only if those two are missing.", ["Initech"])).toEqual([]);
    expect(sameFact("Globex won't sign before GA; its close moved to Jan 29.", "Globex, whose close slipped past GA to Jan 29, needs approvals.", ["Globex"])).toBe(true);
  });

  it("keeps different facts about the same company: a different date or figure, or another point on the same date", () => {
    expect(once("Globex's close moved to Jan 29.", "Globex's close moved to Feb 12.", ["Globex"])).toEqual(["Globex's close moved to Feb 12."]);
    expect(once("Globex needs 40 seats in the beta.", "Globex now needs 60 seats in the beta.", ["Globex"])).toEqual(["Globex now needs 60 seats in the beta."]);
    expect(once("Globex's close moved to Jan 29.", "Globex's renewal is due Mar 1.", ["Globex"])).toEqual(["Globex's renewal is due Mar 1."]);
    expect(once("Globex needs approve and reject in its Dec 8 beta.", "An audit log export must also ship in Globex's Dec 8 beta.", ["Globex"])).toEqual(["An audit log export must also ship in Globex's Dec 8 beta."]);
    // A different question about the same things.
    expect(once("The brief should settle whether imprints can share a parent kit.", "It should also find out what a parent kit for imprints costs.", ["Globex"])).toEqual(["It should also find out what a parent kit for imprints costs."]);
    // Without a company the sources name, the company rule doesn't apply.
    expect(sameFact("Globex won't sign before GA; its close moved to Jan 29.", "Globex, whose close slipped past GA to Jan 29, needs approvals.", [])).toBe(false);
  });

  /** The summary's sentences after a later call's merge. */
  const merged = (summary: string, later: string, companies: string[] = []) => mergeFacts(summary, later, undefined, companies).sentences;
  // Four restatements from real merged descriptions, with other names. Their sources lines name no company, as when the
  // sources are threads in a channel, so the sentences' own company names count.
  const loss = ["Globex Hotels chose Initech on Nov 23, mainly on price.", "Globex Hotels' 14-property expansion closed lost on Nov 23, mainly on price against Initech."];
  const slip = ["Acme's close date moved to Jan 29.", "Acme will not sign before Jan 29; its close slipped past GA."];
  const licence = ["Hooli's licence does not cover server-side rendering.", "Hooli's foundry licence does not cover server-side rendering and an add-on would be needed."];
  const story = ["The synthesis should sharpen the price and brand-kit loss story.", "The synthesis should turn the loss into themes on price and brand kits."];

  it("a restatement that adds a detail goes once, and the fuller sentence stays where the other was", () => {
    // A figure ("14-property") with "chose" said its own way; the same date and close, with one clause more; the same
    // licence point with a qualifier and a clause more.
    for (const [said, fuller] of [loss, slip, licence] as [string, string][]) {
      expect(sameFact(said, fuller)).toBe(true);
      expect(newFacts(said, fuller)).toEqual([]);
      expect(merged(said, fuller)).toEqual([fuller]);
      // Said the other way round, the fuller one is already there and the shorter one is left out.
      expect(merged(fuller, said)).toEqual([fuller]);
    }
    // In its place among the description's other sentences, and with the company the sources name too.
    expect(merged(`${loss[0]} The brief should compare both price lists.`, loss[1]!, ["Globex Hotels"])).toEqual([loss[1], "The brief should compare both price lists."]);
    expect(mergeFacts(`${slip[0]} Acme needs SSO in the pilot.`, slip[1]!, undefined, ["Acme"]).fuller).toEqual([{ was: slip[0], now: slip[1] }]);
  });

  it("the same claim in other words, without a date or figure, goes once: the one already there when neither says more", () => {
    expect(sameFact(story[0]!, story[1]!)).toBe(true);
    expect(merged(story[0]!, story[1]!)).toEqual([story[0]]);
    expect(merged(story[1]!, story[0]!)).toEqual([story[1]]);
  });

  it("a claim turned around, another company or another question is a new fact, however many words they share", () => {
    expect(once("Acme renewed in March.", "Acme churned in March.", ["Acme"])).toEqual(["Acme churned in March."]);
    expect(once("Acme renewed in March.", "Acme churned in March.", [])).toEqual(["Acme churned in March."]);
    expect(once("Hooli wants SSO.", "Hooli doesn't want SSO.", ["Hooli"])).toEqual(["Hooli doesn't want SSO."]);
    expect(once("Hooli's licence covers server-side rendering.", "Hooli's licence does not cover server-side rendering.", [])).toEqual(["Hooli's licence does not cover server-side rendering."]);
    expect(once("The brief should find out whether Acme's admins need SSO in the pilot.", "The brief should find out how Acme's admins roll out SSO after the pilot.", ["Acme"]))
      .toEqual(["The brief should find out how Acme's admins roll out SSO after the pilot."]);
    expect(once("Acme's licence does not cover server-side rendering.", "Hooli's licence does not cover server-side rendering.", [])).toEqual(["Hooli's licence does not cover server-side rendering."]);
    // Two things of one company's on the same date, and the same claim with a date or figure of its own.
    expect(once("Acme's renewal moved to Jan 29.", "Acme's pilot moved to Jan 29.", ["Acme"])).toEqual(["Acme's pilot moved to Jan 29."]);
    expect(once(licence[0]!, "Hooli's licence does not cover server-side rendering after Mar 1.", [])).toEqual([]);
    expect(once("Hooli's licence does not cover server-side rendering before Feb 2.", "Hooli's licence does not cover server-side rendering after Mar 1.", [])).toEqual(["Hooli's licence does not cover server-side rendering after Mar 1."]);
  });

  // The same restatements as the real descriptions said them: the sentence already there often carries a second fact
  // in another clause, so the two are compared clause by clause.
  const real = {
    loss: ["Globex Hotels, an existing Teams customer, chose Initech on Nov 23 over a 105-seat expansion, citing price, a brand kit that is good enough, and the 45-minute training.",
      "Globex Hotels' 14-property expansion closed lost on Nov 23, mainly on price against Initech, with a good-enough included brand kit, 45-minute training and staff already knowing Initech as secondary reasons."],
    slip: ["A plan for faster retrains is owed to Acme, whose close slipped past GA to Jan 29.", "Acme will not sign before it has an answer, and its close date moved to Jan 29."],
    licence: ["Hooli's licence does not cover server-side rendering, and a publisher prospect and a freelancer hit the same uncertainty over print-only and desktop licences.",
      "Hooli's foundry licence does not cover server-side rendering and an add-on could take a couple of weeks."],
    story: ["The synthesis should sharpen the price and brand-kit loss story and flag the renewal risk on the 12 current seats, which run through March.",
      "The synthesis should turn the loss into themes the team can act on in pricing and positioning."],
    pilot: ["Vandelay will use the beta internally only if these are missing, so the spec should define the beta cut and the GA gap.",
      "Vandelay, a $360k pilot, will use the beta for internal work only if these two are missing."],
  };

  it("a clause said again is left out, and the rest of the sentence joins on its own", () => {
    // "its close date moved to Jan 29" says the close again: only "Acme will not sign before it has an answer" is new.
    expect(newFacts(real.slip[0]!, real.slip[1]!)).toEqual(["Acme will not sign before it has an answer."]);
    expect(merged(real.slip[0]!, real.slip[1]!)).toEqual([real.slip[0], "Acme will not sign before it has an answer."]);
    // Said the other way round, the plan owed to Acme is new and "past GA" says more: the whole sentence stays.
    expect(merged(real.slip[1]!, real.slip[0]!)).toEqual([real.slip[1], real.slip[0]]);
    // A first clause that says one there more fully ("foundry") takes its place; the add-on joins as its own sentence.
    const licence = mergeFacts(real.licence[0]!, real.licence[1]!);
    const foundry = "Hooli's foundry licence does not cover server-side rendering, and a publisher prospect and a freelancer hit the same uncertainty over print-only and desktop licences.";
    expect(licence.sentences).toEqual([foundry, "An add-on could take a couple of weeks."]);
    expect(licence.added).toEqual(["An add-on could take a couple of weeks."]);
    expect(licence.fuller).toEqual([{ was: real.licence[0], now: foundry }]);
    expect(merged(real.licence[1]!, real.licence[0]!)).toEqual([real.licence[1], "A publisher prospect and a freelancer hit the same uncertainty over print-only and desktop licences."]);
    // "$360k" is new, and the rest of the later sentence says the first clause again: it takes that clause's place.
    expect(newFacts(real.pilot[0]!, real.pilot[1]!)).toEqual([]);
    expect(merged(real.pilot[0]!, real.pilot[1]!)).toEqual(["Vandelay, a $360k pilot, will use the beta for internal work only if these two are missing, so the spec should define the beta cut and the GA gap."]);
    expect(merged(real.pilot[1]!, real.pilot[0]!)).toEqual([real.pilot[1], "The spec should define the beta cut and the GA gap."]);
  });

  it("a restatement with a figure of its own, or with few words in common, stays beside the other", () => {
    // "14-property" and "105-seat": a different figure is a new fact, so both stay, in either order.
    expect(merged(real.loss[0]!, real.loss[1]!)).toEqual(real.loss);
    expect(merged(real.loss[1]!, real.loss[0]!)).toEqual([real.loss[1], real.loss[0]]);
    // Only "synthesis", "loss" and "price" in common: two asks of the synthesis, not one said twice.
    expect(merged(real.story[0]!, real.story[1]!)).toEqual(real.story);
  });

  it("two sentences that differ by a distinctive term are two facts, in the near-duplicate rule too", () => {
    const sso = "Initech Enterprise lists SSO for every admin on the annual plan.", scim = "Initech Enterprise lists SCIM for every admin on the annual plan.";
    expect(nearDuplicate(sso, scim)).toBe(false);
    expect(sameFact(sso, scim)).toBe(false);
    expect(once(sso, scim, ["Initech"])).toEqual([scim]);
    const server = "Hooli's licence does not cover server-side rendering.", client = "Hooli's licence does not cover client-side rendering.";
    expect(nearDuplicate(server, client)).toBe(false);
    expect(once(server, client, [])).toEqual([client]);
    expect(once("The Teams plan lists SSO for every admin.", "The Slides plan lists SSO for every admin.", [])).toEqual(["The Slides plan lists SSO for every admin."]);
    // A term only the later one adds is a detail: it says the other more fully.
    expect(merged("Acme needs SSO before the pilot.", "Acme needs SSO and SCIM before the pilot.", ["Acme"])).toEqual(["Acme needs SSO and SCIM before the pilot."]);
  });

  it("the companies are the ones the task's sources line names", () => {
    expect(companiesOf({ description: "Summary.\n\n**Sources:** a customer call with Globex Hotels (Nov 20); 2 prospect calls with Initech (Nov 21–22); a thread in #launch (Nov 23). They stay on the PM's Mac." })).toEqual(["Globex Hotels", "Initech"]);
    expect(companiesOf({ description: "Summary.", sourceGroups: [{ key: "call|Globex|customer", one: "", many: "", dates: [] }, { key: "thread|#launch", one: "", many: "", dates: [] }] })).toEqual(["Globex"]);
  });

  describe("in a waiting task", () => {
    beforeEach(freshHome);
    const thread = { key: "thread|#competitive-intel", one: "a thread in #competitive-intel", many: "{n} threads in #competitive-intel", dates: ["2026-11-20"] };
    const waiting = async (summary: string) => (await stageProposals([{
      at: "2026-11-20T10:00:00Z", receipt: "", title: "Spec the pricing brief", category: "spec", size: "S", sources: ["T1"], checked: CHECKED,
      from: [{ id: "T1", title: "Pricing thread", at: "2026-11-20T10:00:00Z", why: "" }], sourceGroups: [thread],
      description: `${summary}\n\n**Sources:** a thread in #competitive-intel (Nov 20). They stay on the PM's Mac: \`pmx explain synthesize-20261120T100000Z\` there shows them.\n\npmx:source T1`,
    }]))[0]!;
    const later = (id: string, n: number, rationale: string) => addEvidence(id, {
      receipt: `synthesize-2026112${n}T100000Z`, from: [{ id: "T1", title: `Pricing thread ${n}`, at: `2026-11-2${n}T10:00:00Z`, why: "" }], days: [`2026-11-2${n}`],
      rationale, groups: { T1: { ...thread, dates: [`2026-11-2${n}`] } }, at: `2026-11-2${n}T12:00:00Z`,
    });

    it("a later call's fuller sentence takes the other's place, the PM sees it, and approval sends it once", async () => {
      const p = await waiting(`${loss[0]} The brief should compare both price lists.`);
      expect(await later(p.id, 4, `${loss[1]} Acme's close date moved to Jan 29.`)).toBe(true);
      let [w] = await readProposals();
      expect(summaryOf(w!.description)).toBe(`${loss[1]} The brief should compare both price lists. ${slip[0]}`);
      expect(w!.again).toMatchObject([{ added: [slip[0]], fuller: [loss[1]] }]);
      expect(changedText(w!)).toBe(`Nov 24, a later run added 1 sentence in the description: ${slip[0]} It said 1 sentence of the description more fully: ${loss[1]}`);

      // A third call says the sentence the second one added more fully: it takes that one's place there too.
      await later(p.id, 5, slip[1]!);
      [w] = await readProposals();
      expect(summaryOf(w!.description)).toBe(`${loss[1]} The brief should compare both price lists. ${slip[1]}`);
      expect(w!.again).toMatchObject([{ added: [slip[1]], fuller: [loss[1]] }, { fuller: [slip[1]] }]);
      expect(w!.again![1]!.added).toBeUndefined();
      expect(changedText(w!)).toMatch(/ · Nov 25, a later run said 1 sentence of the description more fully: Acme will not sign before Jan 29/);

      const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
      const ctx = await testCtx({ repo, team });
      const tracker = memoryTracker([]);
      await approveProposals(ctx, await services(ctx, { tracker }), ["1"]);
      expect(summaryOf([...tracker.tasks.values()][0]!.description)).toBe(`${loss[1]} The brief should compare both price lists. ${slip[1]}`);
    });
  });
});
