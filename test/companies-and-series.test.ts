import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCanaries } from "../src/core/canary.js";
import { validateTeamConfig, DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { filterItems, type FilterRules } from "../src/core/filter.js";
import { dataBlock } from "../src/core/prompt.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import { services } from "../src/core/services.js";
import { isFundraising, peopleIn, trackerGuard } from "../src/core/tracker-text.js";
import type { CandidateTask, SignalItem } from "../src/core/types.js";
import { TEAM_CONFIG_FILE } from "../src/core/paths.js";
import { collectPrompt } from "../src/collect/collect.js";
import { privacyRules } from "../src/digest/gather.js";
import { formatReceipt } from "../src/explain/format.js";
import { checkChange, describe as describeChange, loosens, proposeTeamChanges } from "../src/flow/actions.js";
import { checkSeries, meetingSeries } from "../src/inputs/inputs.js";
import { parseThemes } from "../src/company/rollup.js";
import { draftComment, safe } from "../src/run/comment.js";
import { receiptOf, taskEvidence } from "../src/run/evidence.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { addEvidence, approveProposals, readProposals, stageProposals } from "../src/synth/proposals.js";
import { checkCompany, dateRange, describe as describeTask, parseCandidates, sourceLine, synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const NOW = new Date("2026-11-26T12:00:00Z");

describe("what a task in Linear may say (F14)", () => {
  const guard = trackerGuard({ names: ["Jane Doe"], people: ["Lee Park", "Lee", "Sam"], titles: ["Acme / Us: onboarding escalation"], series: ["Exec staff"] });

  it("may name the company, the deal stage and the dates the sources state", () => {
    for (const ok of [
      "Acme's Dec 8 beta is at risk without SSO.",
      "Globex's renewal is due Jan 15 and depends on the audit log.",
      "A regulated buyer needs a written approval workflow before rollout.",
      "The pilot with Acme converts to a paid plan in Q1.",
      "Raise the export limit for admins.",
      "Run a series of usability tests before the next round of feedback.",
      "Brand dilution worries the design lead's customers.",
      "We will grant access to the beta on Dec 2.",
    ]) expect(guard.problem(ok), ok).toBeNull();
  });

  it("never names people, quotes, meeting titles, or fundraising", () => {
    expect(guard.problem("Lee asked for SCIM before the beta.")).toBe("name");
    expect(guard.problem("Lee Park wants the audit log first.")).toBe("name");
    expect(guard.problem("jane doe owns the rollout.")).toBe("name");
    expect(guard.problem("The customer said \"we export a CSV\" every week.")).toBe("quote");
    expect(guard.problem("The [PERSON-2] account needs SSO.")).toBe("placeholder");
    expect(guard.problem("Speaker 2: this is broken.")).toBe("transcript");
    expect(guard.problem("It came up in the Acme / Us onboarding escalation.")).toBe("title");
    expect(guard.problem("Exec staff settled the scope on Nov 25.")).toBe("title");
    expect(guard.problem("Call lee.park@acme.example about it.")).toBe("contact");
    expect(trackerGuard().problem("Email ops@acme.example about it.")).toBe("contact");
    // A lower-case word that is also someone's first name is still a word.
    expect(trackerGuard({ people: ["Sam", "Will"] }).problem("We will ship the same fix.")).toBeNull();
  });

  it("finds fundraising in every form the test met, and not in product talk", () => {
    for (const s of [
      "Investors are asking the moat question.", "The Series B depends on the unit economics.", "A higher valuation needs better margins.",
      "The term sheet is due next week.", "Dilution limits the option pool.", "Update the cap table first.", "We raise $20M in March.",
      "The fundraising timeline moves to Q1.", "Our next round closes in January.", "VCs want a B2B story.", "The lead investor wants a moat.",
      "We are raising a seed round.", "The raise slips if margins don't improve.",
    ]) expect(isFundraising(s), s).toBe(true);
    for (const s of ["Raise the limit on exports.", "Run a series of A/B tests.", "A round of usability tests.", "Their brand dilution worries them.", "The series a customer asked about."]) expect(isFundraising(s), s).toBe(false);
  });

  it("cuts only the sentences that can't go, and says how many", () => {
    const r = guard.clean("Acme's Dec 8 beta needs SSO. Lee wants it in writing. Investors are asking the moat question. It blocks rollout.");
    expect(r.text).toBe("Acme's Dec 8 beta needs SSO. It blocks rollout.");
    expect(r.cut).toEqual(["name", "fundraising"]);
  });

  it("knows who the sources name: attendees and speakers, never a company's own name or a date", () => {
    const found = peopleIn([
      { participants: ["Lee Park <lee.park@acme.example>", "sam@us.example", "Acme Support <support@acme.example>", "june@us.example"], text: "Lee Park: Hi.\n\nSam: Hello.\n\nMicrophone: test\n\nSpeaker 2: ok" },
    ], ["acme", "us"]);
    expect(found).toEqual(expect.arrayContaining(["Lee Park", "Lee", "Park", "Sam"]));
    expect(found).not.toContain("Acme");
    expect(found).not.toContain("June");
    expect(found).not.toContain("Microphone");
    expect(found).not.toContain("Support");
  });

  const items: SignalItem[] = [
    { id: "T1", kind: "transcript", ref: "/x/a.md", title: "Acme / Us: onboarding escalation", at: "2026-11-20T14:00:00Z", participants: [], text: "Lee Park: Our Dec 8 beta needs SSO.", orgs: ["acme.example"] },
    { id: "T2", kind: "transcript", ref: "/x/b.md", title: "Globex Series B", at: "2026-11-19T14:00:00Z", participants: [], text: "Ana: The round closes soon.", orgs: ["globex.example"] },
    { id: "C1", kind: "thread", ref: "/x/c1.md", title: "#launch", at: "2026-11-18T09:00:00Z", participants: [], text: "Sam: SSO again.", place: "#launch" },
    { id: "C2", kind: "thread", ref: "/x/c2.md", title: "#launch", at: "2026-11-21T09:00:00Z", participants: [], text: "Sam: SSO.", place: "#launch" },
    { id: "C3", kind: "thread", ref: "/x/c3.md", title: "#launch", at: "2026-11-19T09:00:00Z", participants: [], text: "Sam: SSO!", place: "#launch" },
    { id: "T3", kind: "transcript", ref: "/x/d.md", title: "Launch weekly: Nov 25", at: "2026-11-25T15:00:00Z", participants: [], text: "Sam: We settled the beta scope.", series: "Launch weekly" },
  ];

  it("keeps a company only when its source names it, never an investor's", () => {
    const g = trackerGuard();
    expect(checkCompany({ name: "Acme", as: "customer" }, items[0]!, g)).toEqual({ name: "Acme", as: "customer" });
    // From the outside domain alone, when the text doesn't say it.
    expect(checkCompany({ name: "Acme", as: "customer" }, { ...items[0]!, title: "Onboarding", text: "Our beta needs SSO." }, g)).toEqual({ name: "Acme", as: "customer" });
    expect(checkCompany({ name: "Globex", as: "customer" }, items[0]!, g)).toBeNull();
    expect(checkCompany({ name: "Acme", as: "investor" }, items[0]!, g)).toBeNull();
    expect(checkCompany({ name: "Globex", as: "partner" }, items[1]!, g)).toBeNull();
    expect(checkCompany({ name: "Lee Park", as: "customer" }, items[0]!, trackerGuard({ people: ["Lee Park"] }))).toBeNull();
    expect(checkCompany({ name: "Us", as: "partner" }, items[5]!, g)).toBeNull();
  });

  it("gives each task readable source lines: kind, company, channel and dates, never titles or people", () => {
    const c = { sources: ["T1", "C1", "C2", "C3", "T3"], companies: { T1: { name: "Acme", as: "customer" as const } } };
    const line = sourceLine(c, items);
    expect(line).toBe("a customer call with Acme (Nov 20); 3 threads in #launch (Nov 18–21); an internal team meeting (Nov 25)");
    expect(sourceLine({ sources: ["T1"] }, items)).toBe("an external call (Nov 20)");
    expect(dateRange(["2026-11-28", "2026-12-02"])).toBe("Nov 28–Dec 2");
    expect(dateRange(["2026-12-30", "2027-01-02"])).toBe("Dec 30, 2026–Jan 2, 2027");
    const desc = describeTask({ title: "x", category: "spec", size: "M", rationale: "Acme's Dec 8 beta needs SSO.", ...c } as CandidateTask, items, "synthesize-20261126T120000Z");
    expect(desc).toContain("**Sources:** a customer call with Acme (Nov 20); 3 threads in #launch (Nov 18–21); an internal team meeting (Nov 25). They stay on the PM's Mac: `pmx explain synthesize-20261126T120000Z` there shows them.");
    // The machine lines PMX reads back stay last, and the agent's evidence still finds its receipt.
    expect(desc.split("\n").slice(-5)).toEqual(["pmx:source T1", "pmx:source C1", "pmx:source C2", "pmx:source C3", "pmx:source T3"]);
    expect(receiptOf({ description: desc })).toBe("synthesize-20261126T120000Z");
    expect(desc).not.toMatch(/Lee|Sam|escalation|Launch weekly|Series B/);
  });

  it("synthesis keeps the company, cuts what can't go, and drops a task whose title can't", () => {
    const reply = JSON.stringify({ tasks: [
      { title: "Spec SSO for Acme's Dec 8 beta", category: "spec", size: "M", sources: ["T1", "C1"], support: { T1: "The customer needs SSO for the beta.", C1: "The channel asks for SSO again." },
        rationale: "Acme's Dec 8 beta needs SSO before rollout. Lee wants it in writing. Investors are asking the moat question. Globex has the same gap.",
        companies: { T1: { name: "Acme", as: "customer" }, C1: { name: "Globex", as: "customer" } } },
      { title: "Brief Lee on the SSO gap", category: "spec", size: "S", rationale: "SSO is missing.", sources: ["T1"], support: { T1: "The customer needs SSO." } },
      { title: "Prepare the Series B moat answer", category: "spec", size: "S", rationale: "The moat is thin.", sources: ["T2"], support: { T2: "The call is about the moat." } },
      { title: "Write up the onboarding gap", category: "spec", size: "S", rationale: "Lee wants it. Investors ask.", sources: ["T1"], support: { T1: "The customer needs it." } },
    ] });
    const r = parseCandidates(reply, ["spec"], new Set(items.map((i) => i.id)), undefined, new Map(), { people: { found: peopleIn([{ participants: ["lee.park@acme.example"], text: items[0]!.text }], ["acme"]), listed: [] }, titles: items.map((i) => i.title), items });
    expect(r.tasks.map((t) => t.title)).toEqual(["Spec SSO for Acme's Dec 8 beta"]);
    expect(r.tasks[0]!.rationale).toBe("Acme's Dec 8 beta needs SSO before rollout.");
    expect(r.tasks[0]!.companies).toEqual({ T1: { name: "Acme", as: "customer" } });
    // Kept, so the note goes with the task, not among the skipped ones.
    expect(r.tasks[0]!.leftOut).toEqual({ sentences: 3, why: "1 sentence that named a person, 1 sentence that was about fundraising, and 1 sentence that named a company its sources don't" });
    expect(r.skipped).toEqual([
      "Brief Lee on the SSO gap: its title names a person, which Linear never gets",
      "Prepare the Series B moat answer: its title is about fundraising, which Linear never gets",
      "Write up the onboarding gap: nothing in its description can go to Linear (1 sentence that named a person, 1 sentence that was about fundraising)",
    ]);
  });

  it("the draft-ready comment, follow-ups and the company roll-up follow the same rules", () => {
    expect(safe("Does Acme need SSO before its Dec 8 beta?", [])).toBe(true);
    expect(safe("Do investors care about the moat?", [])).toBe(false);
    expect(safe("Ask Jane Doe about it.", ["Jane Doe"])).toBe(false);
    const md = ["# Spec SSO", "", "## Summary", "", "Investors want a moat answer. Acme's Dec 8 beta needs SSO before rollout. The audit log comes second.", ""].join("\n");
    const said = draftComment({ title: "Spec SSO", markdown: md, prUrl: "branch:x", path: "outputs/spec/PMX-1.md", agent: "ana@m1" });
    expect(said).toContain("Acme's Dec 8 beta needs SSO before rollout. The audit log comes second.");
    expect(said).not.toMatch(/nvestor/);
    const themes = parseThemes(JSON.stringify({ themes: [
      { title: "Investor moat story", category: "spec", size: "M", rationale: "x", tasks: ["a/PMX-1", "b/PMX-2"] },
      { title: "SSO across teams", category: "spec", size: "M", rationale: "Both teams need SSO for Acme. The valuation depends on it.", tasks: ["a/PMX-1", "b/PMX-2"] },
    ] }), new Set(["a/PMX-1", "b/PMX-2"]), ["spec"]);
    expect(themes.themes.map((t) => [t.title, t.rationale])).toEqual([["SSO across teams", "Both teams need SSO for Acme."]]);
    expect(themes.skipped).toEqual(["Investor moat story: its title can't go to Linear as written"]);
  });
});

describe("the new description works with what reads it back", () => {
  beforeEach(freshHome);

  it("a repeat adds its sources after the Sources line", async () => {
    await stageProposals([{ at: NOW.toISOString(), receipt: "r0", title: "T", description: "R\n\n**Sources:** a customer call with Acme (Nov 20). They stay on the PM's Mac.\n\npmx:source T1", category: "spec", size: "S", sources: ["T1"], from: [] }]);
    const [p] = await readProposals();
    expect(await addEvidence(p!.id, { receipt: "r1", from: [{ id: "T1", title: "Call", at: "2026-11-21", why: "w" }], days: ["2026-11-21"] })).toBe(true);
    expect((await readProposals())[0]!.description).toBe("R\n\n**Sources:** a customer call with Acme (Nov 20). They stay on the PM's Mac.\n**Heard again** in one more source (2026-11-21).\n\npmx:source T1");
  });
});

const series = (title: string, participants: string[], text = "Sam: We settled the beta scope: approve or reject, an export lock and an event log export.\n\nLee: Agreed, that's the beta."): SignalItem =>
  ({ id: "T1", kind: "transcript", ref: "/x/weekly.md", title, at: "2026-11-25", participants, text });
const TEAM3 = ["sam@us.example", "lee@us.example", "kim@us.example"];

describe("approved internal meeting series (F3)", () => {
  beforeEach(freshHome);

  it("a series is two or more words that name the meeting, never a 1:1, hiring, pay, performance or health meeting", () => {
    expect(checkSeries("  Launch   weekly ")).toBe("Launch weekly");
    expect(checkSeries("Exec staff")).toBe("Exec staff");
    expect(checkSeries("Design review")).toBe("Design review");
    expect(() => checkSeries("Standup")).toThrow(/one word/);
    expect(() => checkSeries("Team sync")).toThrow(/could be any meeting/);
    expect(() => checkSeries("Weekly meeting")).toThrow(/could be any meeting/);
    expect(() => checkSeries("1:1 sync")).toThrow(/1:1s and career talks/);
    expect(() => checkSeries("Sam / Lee")).toThrow(/1:1s and career talks/);
    expect(() => checkSeries("Hiring sync")).toThrow(/hiring and interviews/);
    expect(() => checkSeries("Interview debrief")).toThrow(/hiring and interviews/);
    expect(() => checkSeries("Comp review")).toThrow(/pay and compensation/);
    expect(() => checkSeries("Performance review")).toThrow(/performance and hr/);
    expect(() => checkSeries("Bad|pattern here")).toThrow(/isn't a meeting series/);
    const team = validateTeamConfig({ ...DEFAULT_TEAM, team: "t", meetingSeries: ["Launch weekly", "Exec staff"] } as TeamConfig);
    expect(meetingSeries(team)).toEqual(["Launch weekly", "Exec staff"]);
    expect(() => validateTeamConfig({ ...DEFAULT_TEAM, team: "t", meetingSeries: ["Team sync"] } as TeamConfig)).toThrow(/meetingSeries: "Team sync" could be any meeting/);
    expect(() => validateTeamConfig({ ...DEFAULT_TEAM, team: "t", meetingSeries: "Launch weekly" } as unknown as TeamConfig)).toThrow(/meetingSeries must be a list/);
  });

  const rules: FilterRules = { internalDomains: ["us.example"], requireExternalParticipant: true, wholeMeeting: true, neverIngest: { people: [], channels: [], meetingTitles: [] }, meetingSeries: ["Launch weekly", "Exec staff"] };

  it("an internal meeting in an approved series is used at team scope; held patterns, 1:1s and every other rule still win", () => {
    const used = filterItems([series("Launch weekly: Nov 25", TEAM3)], rules);
    expect(used.decisions[0]).toMatchObject({ decision: "kept", detail: "an approved team meeting series (Launch weekly)" });
    expect(used.kept[0]!.series).toBe("Launch weekly");
    // Without the series, as before: held as internal.
    expect(filterItems([series("Launch weekly: Nov 25", TEAM3)], { ...rules, meetingSeries: [] }).decisions[0]).toMatchObject({ decision: "held", rule: "no-external-participant" });
    expect(filterItems([series("Product sync", TEAM3)], rules).decisions[0]).toMatchObject({ decision: "held", rule: "no-external-participant" });
    // Two people are a 1:1, whatever the title; a 1:1 title or a held title is held first.
    expect(filterItems([series("Launch weekly", TEAM3.slice(0, 2))], rules).decisions[0]).toMatchObject({ decision: "held", rule: "one-on-one" });
    expect(filterItems([series("1:1 Launch weekly", TEAM3)], rules).decisions[0]).toMatchObject({ decision: "held", rule: "one-on-one" });
    expect(filterItems([series("Exec staff: hiring plan", TEAM3)], rules).decisions[0]).toMatchObject({ decision: "held", rule: "hiring" });
    expect(filterItems([series("Exec staff", TEAM3)], { ...rules, neverIngest: { people: [], channels: [], meetingTitles: ["exec staff"] } }).decisions[0]).toMatchObject({ decision: "held", rule: "never-ingest" });
    expect(filterItems([series("Exec staff", TEAM3)], { ...rules, neverIngest: { people: ["kim@us.example"], channels: [], meetingTitles: [] } }).decisions[0]).toMatchObject({ decision: "held", rule: "never-ingest" });
    // The topic screen cuts a sentence, and holds the whole meeting when it keeps coming back.
    const pay = filterItems([series("Exec staff", TEAM3, "Sam: We settled the beta scope today. Approve or reject ships first. The export lock is next. The event log export comes third. SSO waits for Q1. Docs follow the release. Lee's salary band moves next quarter.\n\nKim: Okay, the SSO plan for Q1 is set.")], rules);
    expect(pay.decisions[0]).toMatchObject({ decision: "kept", passages: [{ rule: "compensation", part: { cut: 2, of: 7 } }] });
    expect(pay.kept[0]!.text).not.toMatch(/salary|Docs follow/);
    expect(pay.kept[0]!.text).toContain("The export lock is next.");
    expect(pay.kept[0]!.text).toContain("the SSO plan for Q1 is set");
    const twice = filterItems([series("Exec staff", TEAM3, "Sam: Lee is on parental leave.\n\nKim: Okay, moving on.\n\nSam: The bonus pool is set.\n\nKim: Next, the beta scope.")], rules);
    expect(twice.decisions[0]).toMatchObject({ decision: "held" });
    // An outside call still needs no series.
    expect(filterItems([series("Acme weekly", ["jane@acme.example", "sam@us.example"])], rules).decisions[0]).toMatchObject({ decision: "kept", detail: "has someone from outside the company (acme.example)" });
  });

  it("only team work reads series: never a digest or to-dos' rules, and canaries prove the rules still hold", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, team: { internalDomains: ["us.example"], meetingSeries: ["Launch weekly"] } });
    expect(privacyRules(ctx).meetingSeries).toEqual(["Launch weekly"]);
    expect(privacyRules(ctx, false, { digest: true }).meetingSeries).toEqual([]);
    expect(privacyRules(ctx, true).meetingSeries).toEqual([]);
    const can = runCanaries(privacyRules(ctx));
    expect(can.failed).toEqual([]);
    expect(can.total).toBe(10);
    // The internal-only canary holds even when its title is in a series: two people are a 1:1.
    expect(runCanaries({ ...privacyRules(ctx), meetingSeries: ["Team sync PMX"] }).failed).toEqual([]);
  });

  it("is a team setting changed only by review, from Settings → Sources", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const ctx = await testCtx({ repo, now: NOW, team: { internalDomains: ["us.example"], meetingSeries: ["Exec staff"] } });
    const c = checkChange({ kind: "meeting-series", patterns: ["Launch weekly", "Exec staff", "launch weekly"] }, ctx.team);
    expect(c).toEqual({ kind: "meeting-series", patterns: ["Launch weekly", "Exec staff"] });
    expect(loosens(c, ctx.personal, ctx.team)).toBe(true);
    expect(loosens(checkChange({ kind: "meeting-series", patterns: [] }, ctx.team), ctx.personal, ctx.team)).toBe(false);
    expect(() => checkChange({ kind: "meeting-series", patterns: ["Hiring sync"] }, ctx.team)).toThrow(/hiring/);
    expect(describeChange(c)).toBe("Read the team's internal meeting series for team work: Launch weekly, Exec staff");
    const pr = await proposeTeamChanges(ctx, [c]);
    const cfg = JSON.parse(await git(repo, "show", `${pr.branch}:${TEAM_CONFIG_FILE}`));
    expect(cfg.meetingSeries).toEqual(["Launch weekly", "Exec staff"]);
    // Nothing changes in the PM's checkout until it merges.
    expect(JSON.parse(await readFile(join(repo, TEAM_CONFIG_FILE), "utf8")).meetingSeries).toBeUndefined();
  });

  it("the synthesis Mac's collection asks for the series' meetings; other Macs don't", async () => {
    const { repo } = await pmxRepo();
    const team = { internalDomains: ["us.example"], meetingSeries: ["Launch weekly"], tracker: { kind: "linear" as const, teamKey: "PRO", projectId: "p1" }, synthesizer: "ana" };
    const ctx = await testCtx({ repo, now: NOW, team });
    expect(await collectPrompt(ctx, { scope: "team" })).toContain(`include them whenever they're shared with me or my workspace, even when I wasn't in them: meetings whose title contains "Launch weekly"`);
    expect(await collectPrompt(ctx, { scope: "mine" })).not.toContain("Launch weekly");
  });

  it("synthesis reads them as decisions already made, Linear never gets their titles, agents get their passages, and explain says why", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] }, { remote: true });
    const dir = await tmp("t-");
    await writeTranscript(dir, "weekly.md", [
      "---", "title: Launch weekly: Nov 25", "date: 2026-11-25T15:00:00Z", "participants: sam@us.example, lee@us.example, kim@us.example", "---",
      "Sam: We settled the beta scope: approve or reject, an export lock and an event log export. The platform team owns the questionnaire. Docs ship with the release. SSO waits for Q1. Kim's bonus is set too.", "",
      "Lee: Agreed, that's the beta. The questionnaire is due Dec 1.",
    ].join("\n"));
    await writeTranscript(dir, "acme.md", [
      "---", "title: Acme / Us: onboarding escalation", "date: 2026-11-24T15:00:00Z", "participants: lee.park@acme.example, sam@us.example", "---",
      "Lee Park: Our Dec 8 beta needs a written approval workflow, or legal won't sign.",
    ].join("\n"));
    const reply = JSON.stringify({ tasks: [
      { title: "Spec the settled beta approval scope", category: "spec", size: "M", sources: ["T1", "T2"], support: { T1: "The customer needs approvals for the beta.", T2: "The team settled the beta scope." },
        rationale: "Acme needs approvals in writing before its Dec 8 beta. An internal meeting settled the beta scope on Nov 25, with approvals and an export lock first. Lee Park wants it in writing.",
        companies: { T1: { name: "Acme", as: "customer" } } },
      { title: "Brief the approval problem", category: "problem-brief", size: "S", rationale: "Approvals are unclear.", sources: ["T2"], support: { T2: "The team talked about approvals." } },
      { title: "Launch readiness: answer the questionnaire", category: "problem-brief", size: "S", rationale: "Launch readiness: the questionnaire is due Dec 1.", sources: ["T2"], support: { T2: "The team set the questionnaire date." } },
    ] });
    const runtime = mockRuntime(async (o) => (o.tools.length ? { text: "Drafted.", costUsd: 0.1 } : reply));
    const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"], meetingSeries: ["Launch weekly"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const tracker = memoryTracker();
    const svc = await services(ctx, { tracker });
    const r = await synthesize(ctx, svc, { days: 7 });

    const prompt = runtime.calls[0]!.prompt;
    expect(prompt).toContain("## Internal meetings your team approved");
    expect(prompt).toMatch(/<item id="T2" kind="transcript" date="[^"]+" title="Launch weekly: Nov 25" internal="team meeting series">/);
    expect(prompt).toMatch(/<item id="T1" kind="transcript" date="[^"]+" title="Acme \/ Us: onboarding escalation" orgs="acme.example">/);
    // The series meeting went through the topic screen like any other.
    expect(prompt).not.toMatch(/bonus|SSO waits/);
    expect(prompt).toContain("Docs ship with the release. [HELD]");

    expect(r.staged.map((p) => p.title)).toEqual(["Spec the settled beta approval scope", "Launch readiness: answer the questionnaire"]);
    expect(r.skipped).toContain("Brief the approval problem: only your team's internal meetings support it, and problem-brief needs a customer or partner source");
    const [p] = await readProposals();
    expect(p!.description.split("\n")[0]).toBe("Acme needs approvals in writing before its Dec 8 beta. An internal meeting settled the beta scope on Nov 25, with approvals and an export lock first.");
    expect(p!.description).toContain("**Sources:** a customer call with Acme (Nov 24); an internal team meeting (Nov 25).");
    expect(p!.description).not.toMatch(/Launch weekly|escalation|Lee|Sam|Kim|bonus/);

    const receipt = (await readReceipt((await listReceipts()).find((id) => id.startsWith("synthesize"))!))!;
    expect(receipt.rules.meetingSeries).toEqual(["Launch weekly"]);
    expect(formatReceipt(receipt, [])).toMatch(/✔ used {6}\[T2\] weekly\.md: an approved team meeting series \(Launch weekly\)/);
    expect(formatReceipt(receipt, [])).toContain("Internal meetings in your team's approved series are used for team work, with every other rule: Launch weekly.");

    // Approved and taken by an agent: the series meeting's filtered passages are evidence like any source's.
    await approveProposals(ctx, svc, ["1"]);
    const task = [...tracker.tasks.values()].find((t) => t.title === "Spec the settled beta approval scope")!;
    const ev = await taskEvidence(ctx, task);
    expect(ev.missing).toEqual([]);
    const weekly = ev.sources.find((s) => s.id === "T2")!;
    expect(weekly.passages.join("\n")).toContain("We settled the beta scope");
    expect(weekly.passages.join("\n")).not.toMatch(/bonus/);
  });

  it("the data block marks series and outside domains, and leaves both off when there are none", () => {
    const { block } = dataBlock([{ id: "T1", kind: "transcript", ref: "/x", title: "Call", at: "2026-11-25", participants: [], text: "hi" }]);
    expect(block).toMatch(/<item id="T1" kind="transcript" date="2026-11-25" title="Call">/);
  });
});

describe("Settings → Sources: team meeting series (F3)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("adds a series for the team to approve, and refuses one PMX would never read", async () => {
    ui = await openBoard({ hash: "settings/sources", team: { internalDomains: ["us.example"], meetingSeries: ["Exec staff"] } });
    await ui.until(() => ui!.$("#s-series"), "the series row");
    expect(ui.text("#s-series")).toContain("Exec staff");
    const add = async (v: string) => { await ui!.type("#add-series", v); (ui!.$("#add-series")!.closest("form") as HTMLFormElement).requestSubmit(); };
    await add("Hiring sync");
    await ui.until(() => /always keeps 1:1s, hiring, performance, pay and health meetings out/.test(ui!.text("#s-series")), "the refusal");
    await add("Team sync");
    await ui.until(() => /could be any meeting/.test(ui!.text("#s-series")), "the generic refusal");
    expect(ui.bar()).toMatch(/No unsaved changes/);
    await add("Launch weekly");
    await ui.until(() => /1 for your team to approve/.test(ui!.bar()), "the team change");
    expect(ui.bar()).toMatch(/loosens privacy/);
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.text("#review")).toMatch(/Read the team's internal meeting series for team work: Exec staff, Launch weekly/);
    await ui.click(ui.$("#review input[type=checkbox]")!);
    await ui.click(ui.button("Send to your team", "#review"));
    await ui.until(() => /Saved your team's changes on this Mac|couldn't be sent/.test(ui!.text("#review")), "the change");
    const repo = ui.ctx.personal.repoPath;
    const b = (await git(repo, "branch", "--list", "pmx/settings-*", "--format=%(refname:short)")).split("\n").filter(Boolean).pop()!;
    expect(JSON.parse(await git(repo, "show", `${b}:pmx.config.json`)).meetingSeries).toEqual(["Exec staff", "Launch weekly"]);
  }, 30000);
});
