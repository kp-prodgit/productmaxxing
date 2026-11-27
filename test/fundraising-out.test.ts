// F5 (end-to-end test 2026-11-26, FIX-PLAN #7): an investor's meetings passed as customer calls, so a Linear description
// said "investors are asking the moat question", a task's evidence pack quoted a Series B call, and a to-do moved from
// that call carried it as its sources. Now team work holds fundraising meetings (by title and by what's said) and the
// meetings of the team's confidential contacts (`confidentialDomains`), their companies' names never reach Linear, and
// packs shared before lose those sources at the next background run. The PM's own to-dos may still read them.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { confidentialCompanies, confidentialMatcher, filterItems, FUNDRAISING_SHARE, HOLD_RULES, holdRulesKey, TOPICS, type FilterRules } from "../src/core/filter.js";
import { DEFAULT_TEAM, validateTeamConfig, type TeamConfig } from "../src/core/config.js";
import { exec, execOk } from "../src/core/exec.js";
import { Git } from "../src/core/git.js";
import { TEAM_CONFIG_FILE } from "../src/core/paths.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { services } from "../src/core/services.js";
import { loadState } from "../src/core/state.js";
import { isFundraising, trackerGuard } from "../src/core/tracker-text.js";
import type { SignalItem } from "../src/core/types.js";
import { runDoctor } from "../src/commands/doctor.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { privacyRules } from "../src/digest/gather.js";
import { formatReceipt } from "../src/explain/format.js";
import { checkChange, describe as describeChange, isTeamChange, loosens, proposeTeamChanges } from "../src/flow/actions.js";
import { taskEvidence } from "../src/run/evidence.js";
import { readTranscripts } from "../src/sources/transcripts.js";
import { evidenceStore } from "../src/run/packs.js";
import { evidenceStep } from "../src/run/share.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { buildChecklist } from "../src/setup/checklist.js";
import { approveProposals, readProposals } from "../src/synth/proposals.js";
import { synthesize } from "../src/synth/synthesize.js";
import { moveWork } from "../src/todo/move.js";
import { loadTodos, refreshTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const INVESTOR = "initech-ventures.example";
const LINEAR = { kind: "linear" as const, teamKey: "PMX", projectId: "pmx-1" };

/** A customer call with Globex. */
const GLOBEX = [
  "---", "title: Globex beta planning", "participants: Jane Roe <jane@globex.example>, Ana Ito <ana@us.example>", "---",
  "Jane Roe: We need the stacked cost model in the Dec 8 beta, so finance can sign off on the rollout.",
  "",
  "Ana Ito: Which numbers matter most?",
  "",
  "Jane Roe: Cost per seat by team. This is a big investment for us, so the model has to be right.",
].join("\n");

/** An investor's Series B follow-up: never team work. */
const SERIES_B = (title = "Initech Ventures — Series B follow-up") => [
  "---", `title: ${title}`, `participants: Dana Wu <dana@${INVESTOR}>, Ana Ito <ana@us.example>`, "---",
  "Dana Wu: The partners keep coming back to the moat question. How defensible is the stacked cost model?",
  "",
  "Ana Ito: Globex is piloting it in the Dec 8 beta, and the launch plan follows.",
  "",
  "Dana Wu: Send me the stacked cost model, the launch plan and the beta success criteria.",
].join("\n");

const item = (over: Partial<SignalItem>): SignalItem => ({ id: "T1", kind: "transcript", ref: "/x/a.md", title: "Globex beta planning", at: "2026-11-20", participants: ["jane@globex.example", "ana@us.example"], text: "Jane: We need SSO.", ...over });
const team = (r: Partial<FilterRules> = {}): FilterRules => ({ internalDomains: ["us.example"], requireExternalParticipant: true, wholeMeeting: true, neverIngest: { people: [], channels: [], meetingTitles: [] }, ...r });
const decide = (it: SignalItem, r: FilterRules) => filterItems([it], r).decisions[0]!;

describe("an investor's meetings are held from team work (F5)", () => {
  beforeEach(freshHome);

  it("by the team's confidential domains: like an internal 1:1, and pmx explain says why", () => {
    const r = team({ confidentialDomains: [INVESTOR] });
    // A call with someone from it (or from a domain under it), whatever its title says.
    const call = item({ title: "Quarterly catch-up", participants: [`Dana Wu <dana@${INVESTOR}>`, "ana@us.example"], text: "Dana Wu: How defensible is the cost model?" });
    expect(decide(call, r)).toMatchObject({ decision: "held", rule: "confidential", detail: `someone in it is from ${INVESTOR}, one of your team's confidential domains` });
    expect(decide({ ...call, participants: [`dana@mail.${INVESTOR}`, "ana@us.example"] }, r)).toMatchObject({ rule: "confidential" });
    // A thread with them, and a meeting whose title names them when its file lists no addresses.
    expect(decide({ ...call, kind: "slack", participants: [`dana@${INVESTOR}`] }, r)).toMatchObject({ rule: "confidential" });
    expect(decide({ ...call, title: "Initech Ventures sync", participants: ["Dana Wu", "jane@globex.example"] }, r)).toMatchObject({ rule: "confidential", detail: `its title names ${INVESTOR}, one of your team's confidential domains` });
    // A customer call that names them twice is about them; once, only that passage goes.
    const named = "Jane: We need the cost model.\n\nAna: Initech Ventures asked for it too.\n\nJane: Fine.";
    const once = filterItems([item({ text: named })], r);
    expect(once.kept[0]!.text).not.toMatch(/Initech/);
    expect(once.kept[0]!.text).toContain("We need the cost model.");
    expect(decide(item({ text: `${named}\n\nJane: Does InitechVentures see the beta?` }), r)).toMatchObject({ decision: "held", rule: "confidential" });
    // Without the setting the same call is a customer call: that's the gap the setting closes.
    expect(decide(call, team())).toMatchObject({ decision: "kept" });
    // The PM's own to-dos may still read it (TODO-2).
    expect(decide(call, team({ confidentialDomains: [INVESTOR], requireExternalParticipant: false, allowOneOnOne: true, allowConfidential: true, wholeMeeting: false }))).toMatchObject({ decision: "kept" });
  });

  it("by a fundraising title or content, even with no setting, and not a customer call that mentions investment once", () => {
    const r = team();
    const investor = { participants: [`dana@${INVESTOR}`, "ana@us.example"] };
    expect(decide(item({ ...investor, title: "Initech Ventures — Series B follow-up" }), r)).toMatchObject({ decision: "held", rule: "fundraising", detail: "the title is about fundraising" });
    for (const title of ["Data room review", "Investor update prep", "Term sheet walkthrough", "Seed round sync", "Due diligence for the round"])
      expect(decide(item({ ...investor, title }), r), title).toMatchObject({ decision: "held", rule: "fundraising" });
    // A neutral title, and what's said is about the raise: two passages hold the whole meeting.
    const raise = "Dana: The partners keep coming back to the moat question before the Series B.\n\nAna: Understood.\n\nDana: Put the cost model in the data room by Friday.";
    expect(decide(item({ ...investor, title: "Quarterly catch-up", text: raise }), r)).toMatchObject({ decision: "held", rule: "fundraising", detail: "2 passages are about fundraising and investors, so PMX holds the whole meeting" });

    // A customer call: "investment" in passing is ordinary talk, and nothing is cut.
    const customer = filterItems([item({ text: GLOBEX.split("---")[2]!.trim() })], r);
    expect(customer.decisions[0]).toMatchObject({ decision: "kept", passages: [] });
    expect(customer.kept[0]!.text).toContain("This is a big investment for us");
    // One mention of the customer's investors is cut, a sentence and the figures after it, and the call is still used.
    const one = filterItems([item({ text: "Jane: We need SSO working for every admin before the Dec 8 beta. Our investors want the tool count down. We cut 30% last year. The audit log export comes second, after SSO ships.\n\nAna: Got it." })], r);
    expect(one.decisions[0]).toMatchObject({ decision: "kept", passages: [expect.objectContaining({ rule: "fundraising", part: { cut: 2, of: 4 } })] });
    expect(one.kept[0]!.text).toBe("Jane: We need SSO working for every admin before the Dec 8 beta. [HELD] The audit log export comes second, after SSO ships.\n\nAna: Got it.");
    // Product talk with the same words isn't fundraising.
    for (const text of ["Jane: The asset valuation report times out.", "Jane: Run a series of A/B tests on the valuation API.", "Jane: Raise the export limit.", "Jane: Retail investors log in to the investor portal every morning."])
      expect(filterItems([item({ text })], r).decisions[0], text).toMatchObject({ decision: "kept", passages: [] });
    // The PM's own to-dos read it (TODO-2).
    expect(decide(item({ ...investor, title: "Initech Ventures — Series B follow-up" }), team({ requireExternalParticipant: false, allowOneOnOne: true, allowConfidential: true, wholeMeeting: false }))).toMatchObject({ decision: "kept" });
  });

  it("their companies' names are blocked in tracker text like fundraising terms", () => {
    const r = team();
    const held = filterItems([
      item({ id: "T1" }),
      item({ id: "T2", ref: "/x/b.md", title: "Initech Ventures — Series B follow-up", participants: [`Dana Wu <dana@${INVESTOR}>`, "ana@us.example"] }),
    ], r);
    // The held fundraising meeting's company, never the customer's.
    expect(confidentialCompanies(held.decisions, r)).toEqual(["initech-ventures"]);
    expect(confidentialCompanies([], team({ confidentialDomains: ["@Acme-Capital.example"] }))).toEqual(["acme-capital"]);
    const guard = trackerGuard({ confidential: confidentialCompanies(held.decisions, r) });
    for (const s of ["Send Initech Ventures the stacked cost model, launch plan and beta success criteria.", "Share it with initech-ventures.", "Initech wants the launch plan.", "Ask INITECH about it."])
      expect(guard.problem(s), s).toBe("confidential");
    expect(guard.problem("Globex needs the stacked cost model in its Dec 8 beta.")).toBeNull();
    expect(guard.clean("Globex needs the cost model. Send Initech Ventures the same model.")).toEqual({ text: "Globex needs the cost model.", cut: ["confidential"] });
    // A one-word name that is also a word matches only as a name is written.
    const word = confidentialMatcher(["orchard"])!;
    expect(word.test("The orchard view loads slowly.")).toBe(false);
    expect(word.test("Orchard asked for the deck.")).toBe(true);
    // The guard's list gained what a raise is run with.
    for (const s of ["Dana asked for this view for the Initech Ventures data room.", "Draft the investor update.", "Investor due diligence starts Monday."]) expect(isFundraising(s), s).toBe(true);
    expect(isFundraising("This is a big investment for us.")).toBe(false);
  });

  it("the setting is validated, sent for review like other team settings, and doctor suggests it", async () => {
    const cfg = (c: unknown) => validateTeamConfig({ ...DEFAULT_TEAM, team: "t", internalDomains: ["us.example"], confidentialDomains: c } as TeamConfig);
    expect(cfg(["@Initech-Ventures.example", "https://www.acme-capital.example/", "initech-ventures.example"]).confidentialDomains).toEqual([INVESTOR, "acme-capital.example"]);
    expect(cfg(null).confidentialDomains).toBeNull();
    expect(() => cfg("initech-ventures.example")).toThrow(/confidentialDomains must be a list of email domains/);
    expect(() => cfg(["not a domain"])).toThrow(/"not a domain" isn't an email domain/);
    expect(() => cfg(["gmail.com"])).toThrow(/gmail\.com is a mail provider anyone can sign up with/);
    expect(() => cfg(["us.example"])).toThrow(/us\.example is one of your company's own internalDomains/);
    expect(DEFAULT_TEAM.confidentialDomains).toEqual([]);

    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const ctx = await testCtx({ repo, team: { internalDomains: ["us.example"], tracker: LINEAR } });
    const c = checkChange({ kind: "confidential-domain", op: "add", value: "dana@Initech-Ventures.example" }, ctx.team);
    expect(c).toEqual({ kind: "confidential-domain", op: "add", value: INVESTOR });
    expect(isTeamChange(c)).toBe(true);
    expect(loosens(c, ctx.personal, ctx.team)).toBe(false);
    expect(loosens({ ...c, op: "remove" }, ctx.personal, ctx.team)).toBe(true);
    expect(describeChange(c)).toBe(`Hold meetings with ${INVESTOR} from team work: an investor or other confidential contact`);
    expect(() => checkChange({ kind: "confidential-domain", op: "add", value: "gmail.com" }, ctx.team)).toThrow(/mail provider/);
    expect(() => checkChange({ kind: "confidential-domain", op: "add", value: "us.example" }, ctx.team)).toThrow(/your company's own domains/);
    const pr = await proposeTeamChanges(ctx, [c]);
    expect(JSON.parse(await git(repo, "show", `${pr.branch}:${TEAM_CONFIG_FILE}`)).confidentialDomains).toEqual([INVESTOR]);
    // Titled by what it does (R9).
    expect(await git(repo, "log", "-1", "--format=%s", pr.branch)).toBe(`Confidential domain: ${INVESTOR}`);
    // Nothing changes until it merges.
    expect(JSON.parse(await readFile(join(repo, TEAM_CONFIG_FILE), "utf8")).confidentialDomains).toEqual([]);
    // Once it has, taking it off again is titled the same way.
    const merged = { ...JSON.parse(await readFile(join(repo, TEAM_CONFIG_FILE), "utf8")), confidentialDomains: [INVESTOR] };
    await writeFile(join(repo, TEAM_CONFIG_FILE), `${JSON.stringify(merged, null, 2)}\n`);
    await git(repo, "commit", "-qam", "merged");
    const off = await proposeTeamChanges(await testCtx({ repo, now: new Date("2026-11-06T10:00:05Z"), team: { internalDomains: ["us.example"], tracker: LINEAR } }), [{ ...c, op: "remove" }]);
    expect(await git(repo, "log", "-1", "--format=%s", off.branch)).toBe(`Remove confidential domain: ${INVESTOR}`);

    // A warning, never a failure, as with the CRM list, and an optional checklist step.
    const checks = await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec });
    const check = checks.find((x) => x.id === "privacy.confidential-domains")!;
    expect(check).toMatchObject({ ok: false, level: "warn" });
    expect(check.detail).toMatch(/^your team lists no investors or other confidential contacts\. PMX holds fundraising meetings by their title and what's said, but an investor's call about something else reads like a customer call\. To list them, send their email domains to your team with `pmx domains confidential add <domain>`/);
    expect(checks.find((x) => x.id === "privacy.canaries")).toMatchObject({ ok: true, detail: expect.stringContaining("fundraising") });
    const listed = await runDoctor({ personal: ctx.personal, team: { ...ctx.team, confidentialDomains: [INVESTOR] }, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec });
    expect(listed.find((x) => x.id === "privacy.confidential-domains")).toMatchObject({ ok: true, detail: `meetings, emails and threads with someone from ${INVESTOR} are held from team work, and those companies' names never reach Linear` });
    expect(listed.find((x) => x.id === "privacy.canaries")).toMatchObject({ ok: true, detail: expect.stringContaining("a confidential contact") });
    const step = buildChecklist({
      now: new Date(), version: "0.38.0", personal: ctx.personal, team: ctx.team, checks: [check], state: { lastTick: null, collectReports: [], tickGaps: [] } as any, claude: true, hasRemote: true,
      memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: null, extra: [],
    } as any).sections.flatMap((x) => x.steps).find((x) => x.id === "setup.confidential")!;
    expect(step).toMatchObject({ status: "warn", required: false, who: "team-lead" });
    expect(step.do).toMatch(/^Optional: pmx domains confidential add/);
  });
});

/** The Mac that suggests the work, reading a customer call and an investor's call. */
async function suggestingMac(o: { investorTitle?: string; confidential?: string[]; reply?: (ids: { globex: string; investor: string | null }) => unknown } = {}) {
  const { repo, origin } = await pmxRepo({ internalDomains: ["us.example"] }, { remote: true });
  const dir = await tmp("calls-");
  await writeTranscript(dir, "globex.md", GLOBEX);
  await writeTranscript(dir, "initech.md", SERIES_B(o.investorTitle));
  const runtime = mockRuntime(async (r) => {
    const items = [...r.prompt.matchAll(/<item id="([A-Z]\d+)"[^>]*>\n([\s\S]*?)<\/item>/g)];
    const globex = items.find((m) => m[2]!.includes("Cost per seat"))![1]!;
    const investor = items.find((m) => m[2]!.includes("moat"))?.[1] ?? null;
    return JSON.stringify(o.reply?.({ globex, investor }) ?? { tasks: [] });
  });
  const personal = { sources: { transcriptDirs: [dir], slackChannel: null }, identity: { names: ["Ana Ito"], emails: ["ana@us.example"] } };
  const teamCfg = { internalDomains: ["us.example"], tracker: LINEAR, ...(o.confidential ? { confidentialDomains: o.confidential } : {}) };
  const ctx = await testCtx({ repo, runtime, team: teamCfg, personal: personal as any });
  const tracker = memoryTracker();
  const svc = await services(ctx, { tracker });
  return { repo, origin: origin!, dir, runtime, ctx, tracker, svc, personal, teamCfg };
}

const spec = (title: string, rationale: string, sources: string[]) => ({
  title, category: "spec", size: "M", rationale, sources, support: Object.fromEntries(sources.map((id) => [id, "This call asks for the stacked cost model."])),
});

describe("one fundraising passage never tips a meeting into a whole hold (F5a)", () => {
  it("changes the hold-rules key, so every Mac checks its shared packs again (F5b)", () => {
    // F5a changed only how passages are counted, which the patterns alone don't show: the version is in the key.
    expect(HOLD_RULES).toBeGreaterThanOrEqual(2);
    const r = { internalDomains: ["us.example"], confidentialDomains: [], neverIngest: { people: [], channels: [], meetingTitles: [] }, blockedSources: [], meetingSeries: [] } as unknown as FilterRules;
    expect(holdRulesKey(r)).toBe(holdRulesKey(r));
    expect(holdRulesKey(r)).toMatch(/^[0-9a-f]{16}$/);
  });

  // A thread from an approved channel, as the collection task saves it.
  const thread = (text: string): SignalItem => ({ id: "C1", kind: "thread", ref: "/x/c1.md", title: "#sales-deals", at: "2026-11-24", participants: [], text, place: "#sales-deals" });
  const r = team({ approvedPlace: () => true });
  const passagesOf = (it: SignalItem, rr = r) => decide(it, rr).passages.map((p) => p.rule);

  it("a pipeline review with one bonus line and one data-room line keeps everything else", () => {
    const review = [
      "Sam: Globex went with a cheaper rival: our per-seat price was 30% over their budget.",
      "",
      "Lee: If Globex signs next month I make half my Q4 bonus.",
      "",
      "Sam: Moving on. Acme lost on the missing SSO and the 14-day onboarding.",
      "",
      "Ana: Initech asked for the pipeline numbers for the investor data room.",
      "",
      "Sam: Next, pricing. The pricing page needs a team tier under 20 seats.",
    ].join("\n");
    const f = filterItems([thread(review)], r);
    expect(f.decisions[0]).toMatchObject({ decision: "kept" });
    expect(passagesOf(thread(review))).toEqual(["compensation", "fundraising"]);
    const kept = f.kept[0]!.text;
    expect(kept).not.toMatch(/bonus|data room/);
    for (const s of ["our per-seat price was 30% over their budget", "Acme lost on the missing SSO and the 14-day onboarding", "The pricing page needs a team tier under 20 seats"]) expect(kept).toContain(s);
  });

  it("a customer call with the customer's own data room and one bonus line keeps everything else", () => {
    const call = item({ text: [
      "Jane: Our board wants a data room for the acquisition by March.",
      "",
      "Ana: Understood. Which reports matter first?",
      "",
      "Jane: The cost per seat by team, and the audit log export for finance.",
      "",
      "Ana: Half my Q4 bonus rides on this rollout.",
      "",
      "Jane: Okay. SSO first, then the export.",
    ].join("\n") });
    const f = filterItems([call], r);
    expect(f.decisions[0]).toMatchObject({ decision: "kept" });
    // D2-3: the customer's own data room isn't fundraising, so only the bonus line goes.
    expect(f.decisions[0]!.passages.map((p) => p.rule)).toEqual(["compensation"]);
    expect(f.kept[0]!.text).not.toMatch(/bonus/);
    for (const s of ["Our board wants a data room for the acquisition by March.", "Which reports matter first?", "The cost per seat by team, and the audit log export for finance.", "SSO first, then the export."]) expect(f.kept[0]!.text).toContain(s);
  });

  it("a hold names the topics that reached it, and counts a passage once", () => {
    const turns = (...ls: string[]) => item({ text: ls.join("\n\n") });
    const pay = "Lee: My bonus moves to Q1.";
    const pay2 = "Kim: My salary review is in March.";
    const raise = "Dana: Put the cost model in the data room.";
    const raise2 = "Dana: The Series B closes in January.";
    // The older rule, unchanged: two personal topics together still hold it, and now say both.
    expect(decide(turns(pay, "Kim: The SSO plan for Q1 is set.", "Sam: I'm on sick leave next week."), r)).toMatchObject({ decision: "held", rule: "compensation", detail: "2 passages are about pay and health, so PMX holds the whole meeting" });
    expect(decide(turns(pay, pay2), r)).toMatchObject({ decision: "held", rule: "compensation", detail: "2 passages are about pay and compensation, so PMX holds the whole meeting" });
    // Fundraising holds it only with its own two; the pay passage beside them isn't counted in.
    expect(decide(turns(pay, raise, raise2), r)).toMatchObject({ decision: "held", rule: "fundraising", detail: "2 passages are about fundraising and investors, so PMX holds the whole meeting" });
    expect(decide(turns(pay, pay2, raise, raise2), r)).toMatchObject({ decision: "held", rule: "compensation", detail: "4 passages are about pay and fundraising, so PMX holds the whole meeting" });
    // One turn about both is one passage, under its first topic: never two.
    const both = decide(turns("Lee: My bonus depends on the data room being ready.", "Kim: The SSO plan for Q1 is set."), r);
    expect(both).toMatchObject({ decision: "kept", passages: [expect.objectContaining({ rule: "compensation" })] });
    expect(both.passages).toHaveLength(1);
    // A confidential contact's name counts only with its own kind too.
    const named = team({ confidentialDomains: [INVESTOR] });
    expect(decide(turns(pay, "Ana: Initech Ventures asked for the deck.", "Kim: The SSO plan for Q1 is set."), named)).toMatchObject({ decision: "kept" });
  });
});

// D2-3 (end-to-end test 2026-11-26): one investor line and a customer's data room held a whole Slack thread as "2 passages
// are about fundraising", so its pricing decision and a GPU cost update never reached team work, and a new task went to
// Linear with the stale figure. A data room is fundraising now only in context, and a thread is held for fundraising only
// when it's mostly about it.
describe("a customer's data room isn't fundraising, and a thread is held only when it's mostly about it (D2-3)", () => {
  const thread = (text: string, over: Partial<SignalItem> = {}): SignalItem => ({ id: "C1", kind: "thread", ref: "/x/c1.md", title: "#launch-pricing", at: "2026-11-25", participants: [], text, place: "#launch-pricing", ...over });
  const r = team({ approvedPlace: () => true });
  const turns = (...ls: string[]) => ls.join("\n\n");
  const pricing = "Sam: Decision: the public pricing page goes live on Dec 4.";
  const gpu = "Lee: GPU cost update: inference is now 22% of revenue, up from 18% last month.";
  const investorLine = "Ana: Initech Ventures wants the cost model in the data room by Friday.";
  const securityReview = "Kim: Globex's procurement set up a data room for our security docs.";
  const upload = "Sam: I'll upload the SOC 2 report there today.";

  it("the end-to-end thread is kept: only the investor line is cut, and the pricing decision and the 22% update reach team work", () => {
    for (const rules of [r, team({ approvedPlace: () => true, confidentialDomains: [INVESTOR] })]) {
      const f = filterItems([thread(turns(pricing, gpu, investorLine, securityReview, upload))], rules);
      expect(f.decisions[0]).toMatchObject({ decision: "kept", passages: [expect.objectContaining({ rule: "fundraising" })] });
      expect(f.decisions[0]!.passages).toHaveLength(1);
      const kept = f.kept[0]!.text;
      expect(kept).not.toMatch(/Initech|cost model/);
      expect(kept).toBe(turns(pricing, gpu, securityReview, upload));
      expect(kept).toContain("22% of revenue");
    }
    // Without the investor line, nothing in it is cut.
    expect(decide(thread(turns(pricing, gpu, securityReview, upload)), r)).toMatchObject({ decision: "kept", passages: [] });
  });

  it("a customer's, partner's or procurement's data room alone isn't cut, nor one with nothing about a raise near it", () => {
    for (const text of [
      securityReview,
      "Kim: Their data room has the vendor questionnaire.",
      "Kim: The customer's data room for the acquisition opens Monday.",
      "Kim: Procurement wants our SOC 2 report in a data room.",
      "Kim: Globex set up a data room for the security review.",
      "Kim: The partner's data room has the integration specs.",
      "Kim: Put the onboarding deck in the data room.",
    ]) expect(decide(thread(text), r), text).toMatchObject({ decision: "kept", passages: [] });
    // Fundraising next to it doesn't make someone else's data room ours: only the term sheet's sentence goes.
    const f = filterItems([thread("Ana: The SSO fix for every admin ships on Friday morning. The term sheet is in. Globex's procurement set up a data room for the security review.")], r);
    expect(f.kept[0]!.text).toBe("Ana: The SSO fix for every admin ships on Friday morning. [HELD] Globex's procurement set up a data room for the security review.");
    // A customer's own words (consistent with their headcount, F1): their "our data room" is theirs, even after a line
    // about our investors. From one of the company's own people, the same line is cut.
    const call = (who: string) => item({ text: turns("Ana: Our investors asked how the Globex rollout is going.", `${who}: Our data room opens Monday for the merger.`, "Jane: SSO first, then the export.") });
    expect(decide(call("Jane"), r)).toMatchObject({ decision: "kept", passages: [expect.objectContaining({ rule: "fundraising" })] });
    expect(decide(call("Jane"), r).passages).toHaveLength(1);
    expect(decide(call("Ana"), r).passages.map((p) => p.rule)).toEqual(["fundraising", "fundraising"]);
    // A title, an approved series and `pmx explain` still count a data room on its own (when in doubt).
    expect(TOPICS.fundraising.test("Put the onboarding deck in the data room.")).toBe(true);
    expect(TOPICS.fundraising.all("Put the onboarding deck in the data room.", {})).toEqual([]);
  });

  it("our data room for the Series B is cut, and so is a data room beside a round, a fund or a raise the sentence before", () => {
    const cut = (text: string) => decide(thread(text), r).passages.map((p) => p.rule);
    expect(cut("Ana: Our data room for the Series B opens Monday.")).toEqual(["fundraising"]);
    expect(cut("Ana: The data room for this round needs the cost model.")).toEqual(["fundraising"]);
    expect(cut(investorLine)).toEqual(["fundraising"]);
    // The sentence before has the raise: both go, and the rest of the turn is used.
    const f = filterItems([thread("Ana: The SSO fix for every admin ships on Friday morning. The audit log export for finance comes right after that. We're closing the Series B in January. Our data room opens Monday.")], r);
    expect(f.kept[0]!.text).toBe("Ana: The SSO fix for every admin ships on Friday morning. The audit log export for finance comes right after that. [HELD]");
    // The end of the turn before counts as the sentence before.
    expect(cut(turns("Dana: The Series B lead wants the cost model.", "Ana: I'll put it in a data room tonight."))).toEqual(["fundraising", "fundraising"]);
  });

  it("a thread mostly about the round is held; two fundraising passages in a longer one are cut and the rest is kept", () => {
    expect(FUNDRAISING_SHARE).toBe(1 / 3);
    // 3 of 5 passages.
    const round = thread(turns(
      "Dana: The Series B lead wants the cost model before the partner meeting.", "Ana: Understood.", "Sam: The SSO rollout is set for Q1.",
      "Ana: I'll put the cost model in the data room tonight.", "Kim: The term sheet should land next week.",
    ));
    expect(decide(round, r)).toMatchObject({ decision: "held", rule: "fundraising", detail: "3 passages are about fundraising and investors, so PMX holds the whole meeting" });
    // 2 of 7: each is cut, with its figures, and the thread's other news is used.
    const seven = [pricing, "Dana: The Series B lead wants the cost model.", "Lee: The SSO rollout is set for Q1.", "Kim: The audit log export ships next sprint.", "Ana: I'll put it in our data room tonight.", "Sam: Globex wants a team tier under 20 seats.", gpu];
    const f = filterItems([thread(turns(...seven))], r);
    expect(f.decisions[0]).toMatchObject({ decision: "kept" });
    expect(f.decisions[0]!.passages.map((p) => p.rule)).toEqual(["fundraising", "fundraising"]);
    expect(f.kept[0]!.text).toBe(turns(pricing, seven[2]!, seven[3]!, seven[5]!, gpu));
    // At a third exactly (2 of 6), it's held.
    expect(decide(thread(turns(...seven.slice(0, 6))), r)).toMatchObject({ decision: "held", rule: "fundraising", detail: "2 passages are about fundraising and investors, so PMX holds the whole meeting" });
  });

  it("an investor's thread is still held by its domain or title, and the hold rules' version is 3", () => {
    const named = team({ approvedPlace: () => true, confidentialDomains: [INVESTOR] });
    const text = turns(pricing, gpu, securityReview);
    expect(decide(thread(text, { participants: [`Dana Wu <dana@${INVESTOR}>`, "ana@us.example"] }), named)).toMatchObject({ decision: "held", rule: "confidential", detail: `someone in it is from ${INVESTOR}, one of your team's confidential domains` });
    expect(decide(thread(text, { title: "Initech Ventures diligence" }), named)).toMatchObject({ decision: "held", rule: "confidential", detail: `its title names ${INVESTOR}, one of your team's confidential domains` });
    for (const title of ["Series B data room", "Data room review"]) expect(decide(thread(text, { title }), r), title).toMatchObject({ decision: "held", rule: "fundraising", detail: "the title is about fundraising" });
    // Raised with this change, so every Mac checks its shared packs again (F5b).
    expect(HOLD_RULES).toBeGreaterThanOrEqual(3);
  });
});

describe("synthesis and evidence packs never get an investor's call (F5)", () => {
  beforeEach(freshHome);

  it("a Series B follow-up is held from synthesis, and its company's name from the task", async () => {
    const a = await suggestingMac({ reply: ({ globex }) => ({ tasks: [{
      ...spec("Spec the stacked cost model for Globex's Dec 8 beta", "Globex needs the stacked cost model in its Dec 8 beta. Initech Ventures asked for the same model.", [globex]),
      companies: { [globex]: { name: "Globex", as: "customer" } },
    }] }) });
    await synthesize(a.ctx, a.svc, { days: 7 });
    const prompt = a.runtime.calls[0]!.prompt;
    expect(prompt).toContain("Cost per seat");
    expect(prompt).not.toMatch(/moat|Initech|Series B|initech-ventures/);
    const [p] = await readProposals();
    expect(p!.description).toContain("Globex needs the stacked cost model in its Dec 8 beta.");
    expect(p!.description).not.toMatch(/Initech/);
    const r = (await readReceipt(p!.receipt))!;
    // Held: the receipt keeps the rule, never the title.
    expect(r.sources.filter((s) => s.decision === "left-out")).toEqual([expect.objectContaining({ rule: "fundraising", detail: "the title is about fundraising" })]);
    expect(formatReceipt(r, [])).toContain("Fundraising and investors, because the title is about fundraising");
  });

  it("with the investor's domain listed, a call with them about anything is held, and pmx explain says why", async () => {
    const a = await suggestingMac({ investorTitle: "Quarterly catch-up", confidential: [INVESTOR] });
    await synthesize(a.ctx, a.svc, { days: 7 });
    expect(a.runtime.calls[0]!.prompt).not.toMatch(/moat|Dana|defensible/);
    const r = (await readReceipt((await listReceipts()).find((id) => id.startsWith("synthesize-"))!))!;
    expect(r.rules.confidentialDomains).toEqual([INVESTOR]);
    const out = formatReceipt(r, []);
    expect(out).toContain(`An investor or other confidential contact, because someone in it is from ${INVESTOR}, one of your team's confidential domains`);
    expect(out).toContain(`Held from team work: meetings with someone from your team's confidential domains (${INVESTOR}), and their names.`);
  });

  it("an existing pack loses an investor source at the next background run", async () => {
    // Before the setting: the investor's call has a neutral title and one passage about the raise, so it read as a
    // customer call, and two tasks quote it.
    const a = await suggestingMac({ investorTitle: "Quarterly catch-up", reply: ({ globex, investor }) => ({ tasks: [
      { ...spec("Spec the stacked cost model for Globex's Dec 8 beta", "Globex needs the stacked cost model in its Dec 8 beta.", [globex, investor!]), companies: { [globex]: { name: "Globex", as: "customer" } } },
      spec("Write up how defensible the stacked cost model is", "The stacked cost model's defensibility needs a clear answer.", [investor!]),
    ] }) });
    await synthesize(a.ctx, a.svc, { days: 7 });
    expect((await approveProposals(a.ctx, a.svc, ["1", "2"])).posted.map((x) => x.identifier)).toEqual(["PMX-1", "PMX-2"]);
    const store = evidenceStore(new Git(a.repo));
    const packIn = async (id: string): Promise<any> => JSON.parse(await execOk("git", ["--git-dir", a.origin, "show", `refs/pmx/evidence/${id}:${id}.json`]));
    const packsIn = async () => (await git(a.origin, "for-each-ref", "--format=%(refname:lstrip=3)", "refs/pmx/evidence")).split("\n").filter(Boolean).sort();
    expect(await packsIn()).toEqual(["PMX-1", "PMX-2"]);
    const task1 = [...a.tracker.tasks.values()].find((t) => t.identifier === "PMX-1")!;
    const [globexId, investorId] = task1.sources;
    expect(JSON.stringify(await packIn("PMX-1"))).toContain("defensible");

    // The rules haven't changed since the packs were written: the step checks once and leaves them alone.
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBeNull();
    expect((await loadState()).evidenceRulesKey).toBe(holdRulesKey(privacyRules(a.ctx)));
    expect((await packIn("PMX-1")).sources.map((s: any) => s.id)).toEqual([globexId, investorId]);
    // An older PMX also left a customer's passage about its investors in the pack.
    const old = await packIn("PMX-1");
    old.sources = old.sources.map((s: any) => (s.id === globexId ? { ...s, passages: [...s.passages, "Jane Roe: Our investors want the tool count down before the board meeting."] } : s));
    await store.write({ put: [old] }, "an older PMX's pack");
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBeNull();

    // The team lists the investor's domain (a merged pull request): the next background run drops its call.
    const b = await testCtx({ repo: a.repo, team: { ...a.teamCfg, confidentialDomains: [INVESTOR] }, personal: a.personal as any });
    expect(await evidenceStep(b, async () => a.svc)).toBe("took what your privacy rules now hold out of the shared quotes of PMX-1; removed the shared quotes of PMX-2: your privacy rules now hold all of them");
    const pack = await packIn("PMX-1");
    expect(pack.sources.map((s: any) => s.id)).toEqual([globexId]);
    expect(pack.sources).toEqual((await taskEvidence(b, task1)).sources);
    expect(pack.at).toBe(old.at);
    expect(JSON.stringify(pack)).not.toMatch(/defensible|moat|Initech|investors/);
    expect(await packsIn()).toEqual(["PMX-1"]);
    // Removed and written afresh: the ref's history has no commit that still quotes the investor's call.
    expect(await git(a.origin, "log", "--format=%H", "refs/pmx/evidence/PMX-1")).not.toContain("\n");
    const logged = (await new RunLogStore(b).entries()).filter((e) => e.type === "evidence" && (e as any).reason === "held");
    expect(logged).toEqual([expect.objectContaining({ taskId: "PMX-1", action: "shared" }), expect.objectContaining({ taskId: "PMX-2", action: "removed" })]);
    // Checked once for these rules.
    expect(await evidenceStep(b, async () => a.svc)).toBeNull();
  });
});

describe("a to-do moved from an investor's call (F5, TODO-5)", () => {
  beforeEach(freshHome);

  it("stays the PM's own to-do, carries no sources, and its title naming the investor is refused", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const dir = await tmp("calls-");
    await writeTranscript(dir, "initech.md", SERIES_B());
    const runtime = mockRuntime(async (r) => {
      const id = [...r.prompt.matchAll(/<item id="([A-Z]\d+)"/g)][0]![1]!;
      return JSON.stringify({ todos: [
        { text: "Send Initech Ventures the stacked cost model, launch plan and beta success criteria", due: null, source: id, why: "You said you would." },
        { text: "Write the beta success criteria", due: null, source: id, why: "You said you would." },
      ] });
    });
    const ctx = await testCtx({ repo, runtime, team: { internalDomains: ["us.example"], tracker: LINEAR }, personal: { sources: { transcriptDirs: [dir], slackChannel: null }, identity: { names: ["Ana Ito"], emails: ["ana@us.example"] }, todosToLinear: true } as any });
    // The PM's own to-dos read the investor's call (TODO-2).
    const run = await refreshTodos(ctx, {});
    const [named, plain] = run.added;
    expect(named).toMatchObject({ text: "Send Initech Ventures the stacked cost model, launch plan and beta success criteria" });
    const receipt = (await readReceipt(run.receiptId!))!;
    expect(receipt.sources.filter((s) => s.decision === "used")).toHaveLength(1);
    // Team work never may: any source it would carry is read again through the team's rules, and this one is held.
    const call = (await readTranscripts({ dirs: [dir], sinceMs: 0 }))[0]!;
    expect(decide(call, privacyRules(ctx))).toMatchObject({ decision: "held", rule: "fundraising" });

    const tracker = memoryTracker();
    const move = (id: string) => moveWork(ctx, async () => ({ tracker }) as any, id, "product", { kind: "spec" });
    // Its words reach Linear only through the guard approval uses (R3): the investor's name never does.
    await expect(move(named!.id)).rejects.toThrow(`PMX didn't send it: its words name an investor or other confidential contact, which Linear never gets. Reword it with \`pmx todo edit ${named!.id} "<new words>"\`, which keeps its meetings and due date, and move it again.`);
    expect(tracker.tasks.size).toBe(0);
    expect((await loadTodos()).items.map((t) => t.id)).toContain(named!.id);
    // Worded without it, it goes, with no source and so no quotes for the team repo.
    const moved = await move(plain!.id);
    expect(moved).toMatchObject({ from: "private", to: "product", identifier: "PMX-1" });
    expect([...tracker.tasks.values()][0]).toMatchObject({ title: "Write the beta success criteria", sources: [] });
    expect(JSON.stringify([...tracker.tasks.values()])).not.toMatch(/Initech|moat/);
  });
});

describe("Linear text spares someone else's data room too (D2-3)", () => {
  it("leaves in a customer's security-review data room and still cuts the company's raise", () => {
    expect(isFundraising("Globex's procurement set up a data room for our security docs.")).toBe(false);
    expect(isFundraising("Their data room needs our security questionnaire by Dec 3.")).toBe(false);
    expect(isFundraising("Initech Ventures wants the cost model in the data room by Friday.")).toBe(true);
    expect(isFundraising("Our data room for the Series B opens Monday.")).toBe(true);
    expect(isFundraising("Put the deck in the data room.")).toBe(true);
  });
});
