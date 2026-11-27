import { beforeEach, describe, expect, it } from "vitest";
import { scriptedAsker } from "../src/core/ask.js";
import { filterItems, followsUp, HELD_MARKER, HOLD_RULES, outsideSpeaker, screenText, sentences, TOPICS, type FilterRules, type HoldReason, type PassageCut } from "../src/core/filter.js";
import { DATA_RULES } from "../src/core/prompt.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import type { SignalItem } from "../src/core/types.js";
import { runDigest } from "../src/commands/digest.js";
import { formatReceipt } from "../src/explain/format.js";
import { resolveLive } from "../src/explain/resolve.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const rules: FilterRules = { internalDomains: ["us.com"], requireExternalParticipant: true, neverIngest: { people: ["Bob Smith"], channels: [], meetingTitles: [] } };
const item = (text: string, over: Partial<SignalItem> = {}): SignalItem => ({
  id: "T1", kind: "transcript", ref: "/x/call.md", title: "Acme call", at: "2026-11-02", participants: ["jane@acme.com", "kp@us.com"], text, ...over,
});
const counts = (): Record<HoldReason, number> => ({
  "one-on-one": 0, performance: 0, compensation: 0, health: 0, hiring: 0, "never-ingest": 0,
  "no-external-participant": 0, "no-company-domain": 0, "source-off": 0, "unknown-participants": 0, "place-not-approved": 0,
});
const screen = (text: string, r: FilterRules = rules) => {
  const passages: PassageCut[] = [];
  const held = counts();
  return { out: screenText(text, r, held, passages), passages, held };
};
const ruleOf = (s: string) => Object.entries(TOPICS).find(([, m]) => m.test(s))?.[0] ?? null;

describe("topic rules read product talk as product talk (F1)", () => {
  const cases: [string, string | null][] = [
    // 1:1s: the calendar kind, never a ratio.
    ["My 1:1 with Sam moved to Thursday.", "one-on-one"],
    ["Can we cover this in our 1:1s instead?", "one-on-one"],
    ["Let's take it to a 1-on-1.", "one-on-one"],
    ["Export the hero image in a 1:1 aspect ratio.", null],
    ["The 1:1 square crop cuts off the logo.", null],
    ["We need 16:9 and 1:1 versions of the ad.", null],
    ["Thumbnails are cropped to 1:1 now.", null],
    // Hiring: a role, a candidate, the company's own headcount. Not research participants or a customer's freeze.
    ["I'm recruiting for the PM role.", "hiring"],
    ["The recruiter sent two profiles.", "hiring"],
    ["We recruited Lee from a competitor last spring.", "hiring"],
    ["We recruited 12 participants for the usability study.", null],
    ["Recruiting users for the diary study starts Monday.", null],
    ["User research recruiting is slow this month.", null],
    ["We have three candidates for the role.", "hiring"],
    ["Two candidates for the senior designer position dropped out.", "hiring"],
    ["There are two candidates for the default template.", null],
    ["Candidate feedback is due Friday.", "hiring"],
    ["The release candidate feedback came back clean.", null],
    ["I'm not getting headcount.", "hiring"],
    ["Our headcount plan for next year is flat.", "hiring"],
    ["We have two open reqs on the data team.", "hiring"],
    ["They said we need more headcount.", "hiring"],
    ["They won't give us headcount until the round closes.", "hiring"],
    ["Their brand team has a headcount freeze until March.", null],
    ["The market is in a headcount freeze, so customers buy fewer seats.", null],
    // Performance: a person, not a model.
    ["Sam is underperforming on the team.", "performance"],
    ["His performance has slipped since the reorg.", "performance"],
    ["I think that he underperforms when he's rushed.", "performance"],
    ["The model underperforms on serif fonts.", null],
    ["Variant B still underperforms on mobile.", null],
    ["It underperforms the baseline by 4 points.", null],
    // Health: a hospital, not hospitality.
    ["She was in the hospital last week.", "health"],
    ["He was hospitalized in May.", "health"],
    ["Our hospitality customers want group bookings.", null],
    ["Hotels and hospitality are our biggest segment.", null],
    // Pay (F4): equity refreshes, options, vesting. A company's option pool is fundraising, not one person's pay.
    ["Is my equity refresh coming this cycle?", "compensation"],
    ["Equity refreshes go out in March.", "compensation"],
    ["She asked about a refresh grant.", "compensation"],
    ["His stock options vest in March.", "compensation"],
    ["Her options vest monthly after that.", "compensation"],
    ["The option grant is 10,000 shares.", "compensation"],
    ["What's the vesting schedule for new hires?", "compensation"],
    ["There's a one-year cliff.", "compensation"],
    ["The strike price is set by the board.", "compensation"],
    // F5: and fundraising is held from team work by its own rule.
    ["The term sheet asks for a 10% option pool.", "fundraising"],
    ["Export options are in the settings menu.", null],
    ["We need more options for the date picker.", null],
  ];
  it.each(cases)("%s", (s, want) => expect(ruleOf(s)).toBe(want));

  it("doesn't cut a customer's own headcount, but still cuts ours and anything about a person", () => {
    const people = ["lee.park@acme.com", "kim.ross@us.com", "kp@us.com"];
    const said = (line: string) => filterItems([item(`KP: How is the rollout going?\n\n${line}`, { participants: people })], rules).kept[0]?.text ?? "";
    const freeze = "We froze headcount on the support team until the summer, so I can't add people either, which is why we need the automation.";
    expect(said(`Lee Park: Please. ${freeze}`)).toContain(freeze);
    expect(said(`Lee: Please. ${freeze}`)).toContain(freeze);
    expect(said(`Kim Ross: Please. ${freeze}`)).not.toContain("headcount");
    expect(said("Lee Park: We have two candidates for the PM role and one of them is my cousin.")).not.toContain("candidates");
    expect(said("Lee Park: Please. My salary is frozen too, which is the entire reason I'm doing this.")).not.toContain("salary");
    // A label it can't place counts as inside: two people called Lee, or a name that isn't in any email.
    const two = outsideSpeaker({ participants: ["lee.park@acme.com", "lee.chan@us.com"] }, rules);
    expect([two("Lee: "), two("Lee Park: "), two("Pat: "), two("")]).toEqual([false, true, false, false]);
    expect(outsideSpeaker({ participants: ["lee.park@acme.com"] }, { internalDomains: [] })("Lee Park: ")).toBe(false);
    expect(outsideSpeaker({ participants: ["lee.park@acme.com"] }, rules)("[00:01:02] Lee Park: ")).toBe(true);
  });

  it("judges a meeting title with the same rules", () => {
    const d = (title: string) => filterItems([item("Jane: We need SCIM.", { title })], rules).decisions[0]!;
    expect(d("Instagram 1:1 crop review")).toMatchObject({ decision: "kept" });
    expect(d("Hospitality vertical: Acme")).toMatchObject({ decision: "kept" });
    expect(d("Equity refresh planning")).toMatchObject({ decision: "held", rule: "compensation" });
  });
});

describe("a sentence is cut, not the whole turn (F1)", () => {
  it("keeps an exec's argument when only its last sentence is about headcount", () => {
    const turn = "Ana: Engineering can't do both well by January. The platform work alone takes the quarter. If we go consumer, half of the roadmap is wrong. And I'm not getting headcount.";
    const { out, passages, held } = screen(`Jane: Which way do we go?\n\n${turn}\n\nJane: Then we pick one.`);
    expect(out).toBe(`Jane: Which way do we go?\n\nAna: Engineering can't do both well by January. The platform work alone takes the quarter. If we go consumer, half of the roadmap is wrong. ${HELD_MARKER}\n\nJane: Then we pick one.`);
    expect(passages).toEqual([{ rule: "hiring", hash: expect.stringMatching(/^[0-9a-f]{16}$/), part: { cut: 1, of: 4 } }]);
    expect(held.hiring).toBe(1);
  });

  it("cuts the sentences around one about a person's performance, and keeps the rest of the turn", () => {
    const turn = [
      "Kim: The import fix shipped on Tuesday and the retry button works for every file type we tested.",
      "Support tickets about imports dropped by half this week.",
      "Off the record, Lee is underperforming.",
      "He missed two deadlines.",
      "Anyway, next on the list is the CSV export, which still times out for the largest workspaces we have.",
      "It needs a progress bar and an email when the file is ready, because admins close the tab.",
    ].join(" ");
    const { out, passages } = screen(turn);
    expect(out).toBe(`Kim: The import fix shipped on Tuesday and the retry button works for every file type we tested. ${HELD_MARKER} Anyway, next on the list is the CSV export, which still times out for the largest workspaces we have. It needs a progress bar and an email when the file is ready, because admins close the tab.`);
    expect(out).not.toMatch(/Lee|deadlines|Support tickets/);
    expect(passages).toEqual([{ rule: "performance", hash: expect.any(String), part: { cut: 3, of: 6 } }]);
  });

  it("keeps cutting while the next sentences still talk about that person", () => {
    const turn = [
      "Kim: The beta has forty customers now and every one of them finished onboarding without a support ticket.",
      "Admins say the new import screen is the reason, and two of them asked to be references for the launch page.",
      "Sam is on medical leave.",
      "Lee covers the accounts.",
      "She'll be back in April and wants the handover notes.",
      "The launch date holds, and the pricing page goes live the same morning so sales can start quoting the new plans.",
      "The last open item is the CSV export, which still times out for the largest workspaces we have and needs a fix before then.",
      "Raj has a fix in review that streams the file instead of building it in memory, and it should land this week.",
    ].join(" ");
    const { out, passages } = screen(turn);
    expect(out).not.toMatch(/medical|covers|April|Admins say/);
    expect(out).toContain(`without a support ticket. ${HELD_MARKER} The launch date holds`);
    expect(passages[0]).toMatchObject({ rule: "health", part: { cut: 4, of: 8 } });
  });

  it("marks each cut in a turn, and keeps the speaker's name when the first sentence goes", () => {
    const { out } = screen("Raj: Our hiring plan is frozen. The dashboard loads in four seconds on a good day and in twelve on a bad one. Admins want it under two. We are adding two open reqs next quarter. Caching would help most.");
    expect(out).toBe(`Raj: ${HELD_MARKER} The dashboard loads in four seconds on a good day and in twelve on a bad one. Admins want it under two. ${HELD_MARKER} Caching would help most.`);
  });

  it("cuts the whole turn, as before, when more than half of it would go", () => {
    const short = screen("Jane: SSO is slow.\n\nKim: The import fix shipped. Lee is underperforming. He missed two deadlines.");
    expect(short.out).toBe("Jane: SSO is slow.");
    expect(short.passages).toEqual([{ rule: "performance", hash: expect.any(String) }]);
    // Half the sentences but most of the words: still the whole turn.
    const long = screen("Kim: Fine. Okay. Lee has been underperforming on every project this quarter and the team has noticed it. Sure.");
    expect(long.out).toBe("");
  });

  it("cuts the whole turn when it also names someone on the do-not-read list, or its speaker label matches", () => {
    const listed = screen("Kim: The import fix shipped on Tuesday and works for every file type. Admins are happy with it. Bob Smith asked about headcount. The export is next.");
    expect(listed.out).toBe("");
    expect(listed.passages).toEqual([{ rule: "hiring", hash: expect.any(String) }]);
    const label = screen("My salary: it's late again. The dashboard loads in four seconds on a good day. Admins want it under two. Caching would help most.");
    expect(label.out).toBe("");
  });

  it("cuts the whole turn when a phrase runs across a line break", () => {
    const { out } = screen("Kim: Sam's bonus is late. The dashboard loads in four seconds on a good day and in twelve on a bad one.\nAdmins want it under two, and my performance\nreview is next week. Caching would help most, and so would a smaller first page.");
    expect(out).toBe("");
  });

  it("splits sentences without breaking on abbreviations, decimals or versions", () => {
    expect(sentences("We use v2.1 now, e.g. for SSO. It's 2.5x faster!  Done").map((s) => s.text)).toEqual(["We use v2.1 now, e.g. for SSO.", "It's 2.5x faster!", "Done"]);
    expect(sentences("line one\nline two. Three").map((s) => s.text)).toEqual(["line one", "line two.", "Three"]);
  });

  it("tells Claude what the marker means", () => {
    expect(DATA_RULES("t")).toContain(`${HELD_MARKER} marks sentences PMX's privacy rules cut`);
  });
});

describe("a direct reply to a cut passage about a person is cut too (F2)", () => {
  // The F2 shape: a turn about an underperforming contractor, then replies with no trigger words of their own.
  const probe = [
    "Lee: Can we start with the import errors?",
    "",
    "Sam: First, the contractor on the data team is underperforming and missed every deadline this month.",
    "",
    "Kim: Yeah, it's been rough since the reorg.",
    "",
    "Lee: I'll take over their work until we find someone.",
    "",
    "Kim: Moving on, the import errors come from the CSV parser. It drops quoted commas. Can we fix that first?",
  ].join("\n");

  it("cuts the reply and the hand-over, and keeps the next topic", () => {
    const { out, passages, held } = screen(probe);
    expect(out).toBe("Lee: Can we start with the import errors?\n\nKim: Moving on, the import errors come from the CSV parser. It drops quoted commas. Can we fix that first?");
    expect(out).not.toMatch(/contractor|rough|take over/);
    expect(passages.map((p) => [p.rule, p.followUp ?? false])).toEqual([["performance", false], ["performance", true], ["performance", true]]);
    expect(held.performance).toBe(3);
  });

  it("cuts at most two replies", () => {
    const { out } = screen(probe.replace("\n\nKim: Moving on", "\n\nSam: Sounds good.\n\nKim: Moving on"));
    expect(out).toContain("Sam: Sounds good.");
  });

  it("keeps an unrelated next turn", () => {
    const cut = "Sam: The contractor on the data team is underperforming.";
    for (const next of [
      "Kim: The export takes ten minutes for big workspaces. Admins complain every week. Can we make it async?",
      "Kim: SSO setup still takes two hours.",
      "Kim: Anyway, back to the import errors.",
    ]) expect(screen(`${cut}\n\n${next}`).out, next).toBe(next);
  });

  it("follows a sentence cut too, and stops at the first turn that isn't a reply", () => {
    const turn = "Ana: The import fix shipped on Tuesday and works for every file type we tested so far. Admins are happy with the retry button and the new error list. Tickets dropped. Sam is on sick leave. So I'm covering. Next up is the export, which still times out for the largest workspaces we have.";
    const { out } = screen(`${turn}\n\nKim: Hope she's okay.\n\nLee: The export is the bigger problem for admins. It times out after ten minutes. Can we chunk it?\n\nKim: Sure.`);
    expect(out).toContain("Ana: The import fix shipped on Tuesday");
    expect(out).toContain(`new error list. ${HELD_MARKER} Next up is the export`);
    expect(out).not.toMatch(/sick|covering|Hope she/);
    expect(out).toContain("Lee: The export is the bigger problem");
    expect(out).toContain("Kim: Sure.");
  });

  it("starts no follow-up after a cut about a plan rather than a person", () => {
    const { out } = screen("Ana: I'm not getting headcount.\n\nKim: Yeah, that's fair.");
    expect(out).toBe("Kim: Yeah, that's fair.");
  });

  it("doesn't count a reply as a second passage that holds the whole meeting", () => {
    const d = filterItems([item(probe)], { ...rules, wholeMeeting: true }).decisions[0]!;
    expect(d).toMatchObject({ decision: "kept", passagesKept: 2 });
  });

  it("reads replies by their cues", () => {
    expect(followsUp("Kim: Agreed, that's overdue.")).toBe(true);
    expect(followsUp("Kim: That's fair. We should have flagged it in March, and the client noticed before we did, which is the worst part.")).toBe(true);
    expect(followsUp("Kim: I can cover the Monday standups.")).toBe(true);
    expect(followsUp("Kim: Their manager will want to know. The client asked about it. We should have a plan.")).toBe(true);
    expect(followsUp("Kim: Their IT team wants SCIM. They also asked about audit logs. Can we send docs?")).toBe(false);
    expect(followsUp("Kim: Moving on, I'll cover her accounts.")).toBe(true);
    expect(followsUp("Kim: Yeah, I'll take the API work from here.")).toBe(true);
    expect(followsUp("Kim: Okay, I'll ship the SSO fix tonight.")).toBe(false);
    expect(followsUp("Kim: Sure. Can you write up the OAuth flow?")).toBe(false);
  });
});

describe("after a pay line, only a reply to it is cut (PRIV-2, B2)", () => {
  const pay = "Lee: If the rollout slips, I lose my $5k bonus.";

  it("keeps the customer's next line and the PM's next question in an eight-line call", () => {
    const call = [
      "Lee Park: The pilot went well, and the admins want SSO next.",
      "KP: Good to hear. Which teams use it most?",
      "Lee Park: Mostly brand and the regional marketing teams.",
      "Lee Park: Honestly, if this rollout slips into next quarter, that's half my bonus.",
      "Lee Park: We also need the export to run every night for the regional teams.",
      "KP: How many regional teams are there today?",
      "Lee Park: About forty, and each one has its own folder.",
      "KP: Thanks, I'll write that up.",
    ].join("\n");
    const { out, passages, held } = screen(call);
    expect(out).toBe(call.split("\n").filter((l) => !l.includes("bonus")).join("\n"));
    expect(passages).toEqual([{ rule: "compensation", hash: expect.any(String) }]);
    expect(held.compensation).toBe(1);
  });

  it("cuts a reply to the cut topic: a short reaction, its words or its figure", () => {
    for (const reply of ["Congrats, that's well deserved.", "Sorry to hear that.", "Fingers crossed.", "Yeah, totally.", "Is that before tax?", "That's a lot more than last year."]) {
      const { out, passages } = screen(`${pay}\n\nKP: ${reply}\n\nLee: The export is next.`);
      expect(out, reply).toBe("Lee: The export is next.");
      expect(passages.map((p) => p.followUp ?? false), reply).toEqual([false, true]);
    }
  });

  it("keeps a passage on another subject, short or not", () => {
    for (const next of ["Okay, how many seats would the pilot need?", "Yeah, the export also needs to run nightly.", "Sounds good, I'll send the deck tomorrow.", "We need the launch copy by Friday."])
      expect(screen(`${pay}\n\nKP: ${next}`).out, next).toBe(`KP: ${next}`);
  });

  it("never holds a three-line thread whole for one pay line, and the hold rules are rechecked", () => {
    const thread: SignalItem = { id: "C1", kind: "thread", ref: "/x/c1.md", title: "#launch", at: "2026-11-26", participants: [], place: "#launch",
      text: "Ana: if the Globex deal slips into Q1 that's half my Q4 bonus\nKim: We need the launch copy by Friday.\nAna: I'll send the draft tomorrow." };
    const d = filterItems([thread], { ...rules, wholeMeeting: true, approvedPlace: () => true }).decisions[0]!;
    expect(d).toMatchObject({ decision: "kept", passagesKept: 2 });
    expect(d.passages).toEqual([{ rule: "compensation", hash: expect.any(String) }]);
    expect(HOLD_RULES).toBeGreaterThanOrEqual(4);
  });
});

describe("a short health aside is a health cut, and a clinic's product talk isn't (PRIV-2, B2)", () => {
  const cases: [string, string | null][] = [
    ["I'm out Tue morning (doctor), otherwise around.", "health"],
    ["Back after lunch (dentist appt).", "health"],
    ["Out Thursday for the dentist.", "health"],
    ["I'm off early for physio.", "health"],
    ["Sam is out sick today.", "health"],
    ["She called in sick.", "health"],
    ["I have a medical appointment at 9.", "health"],
    ["Therapy on Wednesday, so I'm offline after 3.", "health"],
    ["Her doctor's office called.", "health"],
    ["Our doctor's office customers want SMS reminders.", null],
    ["The clinic scheduling feature ships in March.", null],
    ["The therapy clinic scheduling feature is late.", null],
    ["Dental practices want online booking.", null],
    ["Doctor's appointment reminders go out by text.", null],
    ["We're sick of this flaky test.", null],
  ];
  it.each(cases)("%s", (s, want) => expect(ruleOf(s)).toBe(want));

  it("cuts the aside's sentence, keeps the work talk around it, and keeps the next turn", () => {
    // End-to-end test 2026-11-27: the aside took the whole turn, the work talk beside it too.
    const { out, passages } = screen("Kim: The pricing section is my component, so loop me in. I'm out Tue morning (doctor), otherwise around.\n\nAna: Globex sent the SOC 2 questions. I'll answer them Monday.");
    expect(out).toBe(`Kim: The pricing section is my component, so loop me in. ${HELD_MARKER}\n\nAna: Globex sent the SOC 2 questions. I'll answer them Monday.`);
    expect(passages).toEqual([{ rule: "health", hash: expect.any(String), part: { cut: 1, of: 2 } }]);
  });
});

describe("a health aside is cut a sentence at a time, like fundraising (PRIV-2, B2)", () => {
  it("keeps the work talk before and after the aside", () => {
    expect(screen("Kim: I'm out Thursday (doctor). The pricing section on the page is my component, so loop me in on whatever's decided.").out)
      .toBe(`Kim: ${HELD_MARKER} The pricing section on the page is my component, so loop me in on whatever's decided.`);
    expect(screen("Kim: The export spec is ready for review. Back after lunch (dentist appt). Send comments in the doc.").out)
      .toBe(`Kim: The export spec is ready for review. ${HELD_MARKER} Send comments in the doc.`);
    expect(screen("Kim: Sam is out sick today. The release notes go out Friday, with the importer fix.").out)
      .toBe(`Kim: ${HELD_MARKER} The release notes go out Friday, with the importer fix.`);
  });

  it("still cuts what follows about that person, and a reply to the aside", () => {
    // "She'll be back Monday" still talks about her.
    expect(screen("Kim: Sam is out sick today. She'll be back Monday. The release notes go out Friday, with the importer fix. The SSO page follows next week.").out)
      .toBe(`Kim: ${HELD_MARKER} The release notes go out Friday, with the importer fix. The SSO page follows next week.`);
    const { out, passages } = screen("Kim: I'm out Thursday (doctor). The pricing section on the page is my component, so loop me in on whatever's decided.\n\nAna: Feel better soon!\n\nAna: The SSO page ships Monday.");
    expect(out).toBe(`Kim: ${HELD_MARKER} The pricing section on the page is my component, so loop me in on whatever's decided.\n\nAna: The SSO page ships Monday.`);
    expect(passages.map((p) => [p.rule, p.followUp ?? false])).toEqual([["health", false], ["health", true]]);
  });

  it("anything else about health still cuts the sentences around it, and a clinic's product talk is still kept", () => {
    // Someone's own therapist or a diagnosis isn't an aside: the sentence before and after go too.
    expect(screen("Kim: My therapist moved my session. I'm offline after 3. The pricing section on the page is my component.").out).toBe("");
    expect(screen("Kim: The beta starts Monday. Lee had surgery last week. The pricing section on the page is my component, so loop me in on whatever's decided.").out).toBe("");
    for (const s of ["Kim: Doctor's office customers want appointment reminders by text.", "Kim: The landing page needs a doctor-approved disclaimer."]) expect(screen(s).out, s).toBe(s);
  });
});

describe("a bonus a product gives its customers isn't pay (PRIV-2, B2)", () => {
  const cases: [string, string | null][] = [
    ["Our launch bonus campaign for creators runs in January.", null],
    ["The bonus feature ships with the beta.", null],
    ["Annual plans get bonus credits for the first month.", null],
    ["We're adding bonus content to the onboarding course.", null],
    ["A welcome bonus for new users would lift sign-ups.", null],
    // A person's bonus is still pay.
    ["My bonus is late.", "compensation"],
    ["Her bonus this year depends on the rollout.", "compensation"],
    ["The bonus pool is set.", "compensation"],
    ["She asked about a signing bonus.", "compensation"],
    ["Reps get a bonus for accounts closed this quarter.", "compensation"],
    ["The launch bonus for the team is set.", "compensation"],
  ];
  it.each(cases)("%s", (s, want) => expect(ruleOf(s)).toBe(want));

  it("keeps a bonus campaign line in team work, and still cuts a pay line beside it", () => {
    const { out, passages } = screen("Kim: Our launch bonus campaign for creators runs in January.\n\nLee: If the rollout slips, I lose my $5k bonus.\n\nKim: The campaign page goes live Monday.");
    expect(out).toBe("Kim: Our launch bonus campaign for creators runs in January.\n\nKim: The campaign page goes live Monday.");
    expect(passages.map((p) => p.rule)).toEqual(["compensation"]);
  });
});

describe("pmx explain shows sentence cuts and replies (PRIV-4)", () => {
  beforeEach(freshHome);

  it("names the line, the sentences cut and the reply, on screen only", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("transcripts-");
    const body = [
      "Jane: Admins spend two hours on SSO setup.",
      "",
      "KP: The import fix shipped on Tuesday and works for every file type we tested.",
      "It also retries on timeouts. Admins like the new error list a lot.",
      "And the team isn't getting headcount.",
      "",
      "Jane: Our IT lead is out after surgery.",
      "",
      "KP: Sorry to hear that.",
      "",
      "Jane: SCIM would save us the two hours. Can you send the docs? We want it before the renewal.",
    ].join("\n");
    await writeTranscript(dir, "acme.md", `---\ntitle: Acme onboarding\nparticipants: jane@acme.com, kp@us.com\n---\n${body}`);
    const ctx = await testCtx({ repo, runtime: mockRuntime(() => "## Top themes\n- Admins spend two hours [T1]\n"), team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    await runDigest(ctx, scriptedAsker({ approve: "reject" }), {});
    const r = (await readReceipt((await listReceipts())[0]!))!;
    expect(r.sources[0]!.passagesCut).toEqual([
      { rule: "hiring", hash: expect.any(String), part: { cut: 1, of: 4 } },
      { rule: "health", hash: expect.any(String) },
      { rule: "health", hash: expect.any(String), followUp: true },
    ]);
    const live = await resolveLive(r, [dir]);
    expect(live[0]!.cuts).toEqual([
      { rule: "hiring", line: 9, matched: "headcount", part: { cut: 1, of: 4 } },
      { rule: "health", line: 11, matched: "surgery" },
      { rule: "health", line: 13, matched: null, followUp: true },
    ]);
    const shown = formatReceipt(r, live);
    expect(shown).toContain('cut 1 of 4 sentences at line 9 and used the rest of that turn: Hiring and interviews (matched "headcount")');
    expect(shown).toContain('cut line 11: Health and leave (matched "surgery")');
    expect(shown).toContain("cut line 13: Health and leave, as a direct reply to the passage cut before it");
    // The line is the one with the matched words (9), not the start of that turn (7).
    // Without the files, the receipt alone still says which kind of cut each was.
    const blind = formatReceipt(r, []);
    expect(blind).toContain("cut 1 of 4 sentences in a passage and used the rest of that turn: Hiring and interviews");
    expect(blind).toContain("cut a passage: Health and leave, as a direct reply to the passage cut before it");
  });
});
