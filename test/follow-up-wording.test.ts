// FOLLOW-1: the words of the to-dos and follow-up tasks an accepted draft leaves. A call or a question that leans on
// "it", "this" or "that test" says what it stands for, or starts with what its item is about; a yes/no call reads as
// "Decide whether …"; an unmarked question that names a group asks that group; an ask keeps the question as written;
// an ask's why is a whole sentence; and a company's name keeps its capital.
import { beforeEach, describe, expect, it } from "vitest";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { followUpItems } from "../src/review/draft-reader.js";
import { askText, askWhy, followUpsOnAccept, readFollowUps } from "../src/review/followups.js";
import { readProposals } from "../src/synth/proposals.js";
import { loadTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

const NOW = new Date(2026, 10, 26, 10);

const draft = (title: string, heading: string, items: string[], intro = "") =>
  [`# ${title}`, "", ...(intro ? [intro, ""] : []), `## ${heading}`, "", ...items.map((x) => `- ${x}`), ""].join("\n");
const calls = (md: string, id: string, title?: string) => readFollowUps(md, id, NOW, { title }).decisions.map((d) => d.text);
const titles = (md: string, id: string, title?: string) => readFollowUps(md, id, NOW, { title }).questions.map((q) => q.title);

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-21", identifier: "PMX-21", title: "Spec the editor plugin for Initech",
  description: "Editors copy by hand.\n\n- [T1] Initech call: we copy everything by hand\n\n**Based on** one meeting (2026-11-01). The sources stay on the PM's Mac.\n\npmx:source T1",
  url: "https://linear.app/acme/issue/PMX-21", category: "spec", size: "M", status: "ready", priority: 2, agent: null,
  sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

async function accept(md: string, over: Partial<Task> = {}) {
  const { repo } = await pmxRepo();
  const ctx = await testCtx({ repo, now: NOW });
  const svc = await services(ctx, { tracker: memoryTracker([]) });
  const t = task(over);
  return followUpsOnAccept(ctx, svc, { task: t, record: null, files: [{ path: `outputs/spec/${t.identifier}.md`, content: md }], citations: {} });
}

describe("the words of an accepted draft's follow-ups (FOLLOW-1)", () => {
  beforeEach(freshHome);

  it("a call that leans on it, they or that test says what it stands for, or starts with its label", () => {
    const md = draft("PMX-13: Price dedicated capacity", "Pricing", [
      // The label says what "it" is.
      "**Dedicated-capacity price.** Globex wants dedicated capacity at a fixed price [T1]. **PM decides:** whether it is a separate line or bundled.",
      // The sentence before names "that test", and "they".
      "A pricing test with 30 admins would settle the floor [T2]. **PM decides:** whether to commission that test before Dec 8.",
      "The overage terms aren't in any source [T1]. **PM decides:** whether they are part of the contract.",
      // Nothing names "that test": the item's label goes first.
      "**Price floor.** A survey of 30 admins would settle it [T2]. **PM decides:** whether to commission that test before Dec 8.",
      // Neither a label nor a sentence that safely says what "it" is: left as written, never a guess at Globex.
      "Globex wants a second region [T1]. **PM decides:** whether it is a separate line or bundled.",
      // "it is worth" stands for nothing.
      "**Second call.** **PM decides:** whether it is worth asking Globex again.",
    ]);
    const r = readFollowUps(md, "PMX-13", NOW);
    expect(r.decisions.map((d) => [d.text, d.due])).toEqual([
      ["Decide whether the dedicated-capacity price is a separate line or bundled (PMX-13)", null],
      ["Decide whether to commission the pricing test before Dec 8 (PMX-13)", "2026-12-08"],
      ["Decide whether the overage terms are part of the contract (PMX-13)", null],
      ["Price floor: decide whether to commission that test before Dec 8 (PMX-13)", "2026-12-08"],
      ["Decide whether it is a separate line or bundled (PMX-13)", null],
      ["Decide whether it is worth asking Globex again (PMX-13)", null],
    ]);
  });

  it("a yes/no call is worded as whether, in the question's own words", () => {
    const md = draft("PMX-40: Plan usage pricing", "Implications", [
      "**PM decides:** Is the monthly allowance pooled across workspaces, or per seat?",
      "Do we have another email integration planned for Q1? **PM decides.**",
      "Are the overage terms part of the renewal? **PM decides.**",
      "Does the integration need a signed DPA? **PM decides.**",
      "Do admins want a usage report? **PM decides.**",
      "Can a designer be freed for the plugin UI? **PM decides.**",
      "Will Globex accept a one-year lock? **PM decides.**",
      "Should the rollout pause until January? **PM decides.**",
      "Has Globex signed the DPA? **PM decides.**",
      "Have we agreed a price with Initech? **PM decides.**",
      // Where the subject ends isn't clear: left as the draft asks it.
      "Does the team prioritize the export plan? **PM decides.**",
    ]);
    expect(calls(md, "PMX-40")).toEqual([
      "Decide whether the monthly allowance is pooled across workspaces, or per seat (PMX-40)",
      "Decide whether another email integration is planned for Q1 (PMX-40)",
      "Decide whether the overage terms are part of the renewal (PMX-40)",
      "Decide whether the integration needs a signed DPA (PMX-40)",
      "Decide whether admins want a usage report (PMX-40)",
      "Decide whether a designer can be freed for the plugin UI (PMX-40)",
      "Decide whether Globex will accept a one-year lock (PMX-40)",
      "Decide whether the rollout should pause until January (PMX-40)",
      "Decide whether Globex has signed the DPA (PMX-40)",
      "Decide whether we have agreed a price with Initech (PMX-40)",
      "Decide: Does the team prioritize the export plan? (PMX-40)",
    ]);
  });

  it("an unmarked question that names a group asks that group, and one for a role at a company asks that company's team; never two groups or a person", () => {
    const md = draft("PMX-21: Spec the order flow", "Open questions", [
      "When will procurement at Globex sign the order?",
      "Has the security team approved the vendor form?",
      "Is the budget approved by their CFO?",
      "Has legal signed off on the DPA?",
      "Who signs the contract at Globex, and who is the procurement contact?",
      "Has legal approved it, or has procurement?",
      "Is the DPA approved by Lee Park?",
    ]);
    const qs = readFollowUps(md, "PMX-21", NOW).questions;
    expect(qs.map((q) => [q.ask?.role ?? null, askText(q.ask?.role ?? null, q.title, "PMX-21", q.about)])).toEqual([
      ["Globex's procurement", "Ask Globex's procurement: When will procurement at Globex sign the order? (PMX-21)"],
      ["the security team", "Ask the security team: Has the security team approved the vendor form? (PMX-21)"],
      ["their CFO", "Ask their CFO: Is the budget approved by their CFO? (PMX-21)"],
      ["legal", "Ask legal: Has legal signed off on the DPA? (PMX-21)"],
      // Who holds a role at Globex: Globex's team for it, never the role itself.
      ["Globex's procurement", "Ask Globex's procurement: Who signs the contract at Globex, and who is the procurement contact? (PMX-21)"],
      [null, "Find out: Has legal approved it, or has procurement? (PMX-21)"],
      [null, "Find out: Is the DPA approved by Lee Park? (PMX-21)"],
    ]);
  });

  it("an ask keeps the question's words and order, with a capital, its question mark and no filler", () => {
    expect(askText("the security lead at the account", "what exactly will the risk committee accept as proof of isolation?", "PMX-39"))
      .toBe("Ask the security lead at the account: What will the risk committee accept as proof of isolation? (PMX-39)");
    // Never reworded: a yes/no question stays one.
    expect(askText("legal", "Is the DPA really approved?", "PMX-39")).toBe("Ask legal: Is the DPA approved? (PMX-39)");
    expect(askText("legal", "Find out exactly what the DPA covers", "PMX-39")).toBe("Ask legal what the DPA covers (PMX-39)");
    // "exactly" before a number says something.
    expect(askText("legal", "Is the notice period exactly 30 days?", "PMX-39")).toBe("Ask legal: Is the notice period exactly 30 days? (PMX-39)");
    // Cut short, it still ends with its question mark.
    const long = askText("the account lead", `Who ${"signs ".repeat(60)}?`, "PMX-1");
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long).toMatch(/…\? \(PMX-1\)$/);
  });

  it("a follow-up title that leans on this or it says what it stands for, or starts with its label or the task's subject", async () => {
    const md = draft("PMX-43: Spec the Globex email integration", "Open questions", [
      // "this" stands for what the sentence before needs, a short noun phrase.
      "**Globex integration.** The contract needs a signed DPA [T1]. Does the integration need this for the contract? — needs: research",
      // "this" stands for a whole sentence, which no short phrase says: the label goes first.
      "**Globex renewal.** Legal reviewed the contract twice [T1]. Does the integration need this for the renewal? — needs: research",
      // No label: the subject of the task the draft is for.
      "Does the integration need this for the sandbox? — needs: research",
      // "it" is the label, or the subject of the sentence before.
      "**Globex integration.** Does it need a signed DPA for the sandbox? — needs: research",
      "The importer is slow [T1]. Does it need a rewrite? — needs: research",
      // "that test" is the test the sentence before names.
      "A pricing test with 30 admins would settle the floor [T2]. Who runs that test? — ask: the data team",
      // "their" can't be replaced: the label it points back to stays.
      "Initech partner terms: what are their co-marketing specifics? — ask: the account lead",
    ], "Globex wants an email integration [T1].");
    const title = "Spec the Globex email integration";
    expect(titles(md, "PMX-43", title)).toEqual([
      "Does the integration need the signed DPA for the contract?",
      "Globex renewal: does the integration need this for the renewal?",
      "Globex email integration: does the integration need this for the sandbox?",
      "Does the Globex integration need a signed DPA for the sandbox?",
      "Does the importer need a rewrite?",
      "Who runs the pricing test?",
      "Initech partner terms: what are their co-marketing specifics?",
    ]);
    // Accepted, the tasks carry those titles, and an ask is put about what its title starts with.
    const r = await accept(md, { id: "lin-43", identifier: "PMX-43", title });
    expect((await readProposals()).map((p) => p.title)).toEqual(titles(md, "PMX-43", title).slice(0, 3));
    expect(r.asks.map((a) => a.text)).toEqual([
      "Ask the data team: Who runs the pricing test? (PMX-43)",
      "Ask the account lead about the Initech partner terms: What are their co-marketing specifics? (PMX-43)",
    ]);
  });

  it("an ask the draft says nothing more about says in a whole sentence where it comes from", async () => {
    const md = [
      "# PMX-39: Spec tenant isolation", "",
      "## Blocking questions", "", "- Who signs the security addendum at Globex? — ask: the account lead", "",
      "## Open questions", "", "- Is the vendor form approved? — ask: the security lead", "- Who owns the audit log? — ask: the platform lead. Needed before Dec 12.", "",
    ].join("\n");
    await accept(md, { id: "lin-39", identifier: "PMX-39", title: "Spec tenant isolation" });
    expect((await loadTodos()).items.map((t) => [t.text, t.why])).toEqual([
      ["Ask the account lead: Who signs the security addendum at Globex? (PMX-39)", "PMX-39's accepted draft lists this as a blocking question."],
      ["Ask the security lead: Is the vendor form approved? (PMX-39)", "PMX-39's accepted draft lists this as an open question."],
      // The draft's own words, when it has some.
      ["Ask the platform lead: Who owns the audit log? (PMX-39)", "Needed before Dec 12."],
    ]);
  });

  it("a decision on a company's terms keeps the company's capital; only a common word loses it", () => {
    const intro = "Admins at Globex asked for a two-year lock [T1].";
    const one = (item: string, i = intro, title?: string) => calls(draft("PMX-16: Decide on the renewal", "Terms", [item], i), "PMX-16", title);
    expect(one("**Globex renewal terms:** **PM decides**.")).toEqual(["Decide on the Globex renewal terms (PMX-16)"]);
    expect(one("**PM decides:** Globex renewal terms.")).toEqual(["Decide on the Globex renewal terms (PMX-16)"]);
    expect(one("**PM decides:** Globex's renewal terms.")).toEqual(["Decide on Globex's renewal terms (PMX-16)"]);
    expect(one("**Renewal window:** **PM decides**.")).toEqual(["Decide on the renewal window (PMX-16)"]);
    // The task's title names the company too.
    expect(one("**Globex renewal terms:** **PM decides**.", "A two-year lock came up [T1].", "Decide on Globex's renewal terms")).toEqual(["Decide on the Globex renewal terms (PMX-16)"]);
  });
});

describe("the end-to-end test's lows on 0.39.0 (FOLLOW-1)", () => {
  beforeEach(freshHome);
  const asks = (md: string, id: string) => readFollowUps(md, id, NOW).questions.map((q) => askText(q.ask?.role ?? null, q.title, id, q.about));

  it("1. a title's \"this\" or \"these pages\" says what it stands for, from the item or the sentence before it in the draft", () => {
    const md = [
      "# PMX-43: Spec the partner terms and listing timing", "", "## Open questions", "",
      // The item's text before the question comes down to a short noun phrase.
      "- Initech asked how per-client usage and retrain billing will be reported [C2]. Does the integration need this for the contract? — needs: a problem brief",
      "", "## Blocking questions", "",
      "Initech asked for a usage report [T1].", "",
      // The sentence before the item in the draft says it.
      "- Does the integration need this for the sandbox? — needs: research",
      // Only the sentence right before: a later item that says nothing more keeps the prefix.
      "- Does the export need this too? — needs: research",
    ].join("\n");
    expect(titles(md, "PMX-43")).toEqual([
      "Does the integration need per-client usage and retrain billing reporting for the contract?",
      "Does the integration need the usage report for the sandbox?",
      "Partner terms and listing timing: does the export need this too?",
    ]);
    // "these pages" in a draft that cites web pages, with nothing before to say which: the pages the draft cites.
    const cited = (md: string) => titles(md, "PMX-41");
    const pages = "\n\n## Open questions\n\n- Do these pages match what is live, and what do the full pages say on SCIM? — needs: a manual read\n";
    expect(cited(`# PMX-41: Compare governance\n\nEvery cell rests on a search summary [web: https://example.com/help, 2026-11-27].${pages}`))
      .toEqual(["Do the pages PMX-41's draft cites match what is live, and what do the full pages say on SCIM?"]);
    // A draft that cites no page: left as the draft asks it, with the task's subject first.
    expect(cited(`# PMX-41: Compare governance\n\nEvery cell rests on the sources [T1].${pages}`)).toEqual(["Governance: do these pages match what is live, and what do the full pages say on SCIM?"]);
  });

  it("2. an ask is \"Ask <role>: <Question>? (ID)\": the question's own words, one \"?\", no \"via …\" after it", () => {
    const md = "# PMX-24: Brief tenant isolation\n\n## Open questions\n\n- What exactly will the risk committee accept as \"kept out of shared batching\": dedicated GPUs, a dedicated serving pool, or logical isolation with evidence? — ask: the security lead at the account, via the account lead.\n";
    const q = readFollowUps(md, "PMX-24", NOW).questions[0]!;
    expect([q.ask?.role, q.rest]).toEqual(["the security lead at the account", ["Ask via the account lead."]]);
    expect(asks(md, "PMX-24")).toEqual(["Ask the security lead at the account: What will the risk committee accept as \"kept out of shared batching\": dedicated GPUs, a dedicated serving pool, or logical isolation with evidence? (PMX-24)"]);
    // A clause that is a question as the draft asks it takes the colon, and ends at its one "?".
    for (const t of [
      askText("the security lead", "Find out what exactly will the committee accept?, via the account lead", "PMX-24"),
      askText("legal", "Find out who is the procurement contact", "PMX-24"),
      askText("legal", "Is the DPA signed?, via the account lead", "PMX-24"),
    ]) {
      expect(t).toMatch(/^Ask [^:?]+: \p{Lu}[^?]*\? \(PMX-24\)$/u);
      expect(t).not.toMatch(/via/);
    }
    // A "?" the question quotes is part of it.
    expect(askText("legal", "Is \"good enough?\" what the buyer approved?", "PMX-24")).toBe("Ask legal: Is \"good enough?\" what the buyer approved? (PMX-24)");
    // One that reports a question stays a clause.
    expect(askText("legal", "Find out whether the DPA is signed", "PMX-24")).toBe("Ask legal whether the DPA is signed (PMX-24)");
    // The mark's way to reach someone goes with a call's "Ask …" too.
    expect(calls("# T\n\n## Open questions\n\n- **PM decides:** Is the allowance pooled? — ask: the pricing owner, via the account lead\n", "PMX-24")).toEqual(["Decide whether the allowance is pooled (PMX-24)"]);
    expect(readFollowUps("# T\n\n## Open questions\n\n- **PM decides:** Is the allowance pooled? — ask: the pricing owner, via the account lead\n", "PMX-24", NOW).decisions[0]!.why).toBe("Ask the pricing owner, via the account lead.");
  });

  it("3. a PM decides mark on what the draft believes is the decision it informs, or whether the belief holds; never \"Decide: We believe …\"", () => {
    const md = draft("PMX-49: Synthesize the plugin research", "Insights", [
      "We believe Dec 3 is too early to rely on a review estimate from colleagues. Anecdotes run from days to weeks [C29]. This informs whether to treat the plugin as a committed slot or a conditional one. **PM decides.**",
      "We believe the token-storage review should finish before commitment, because it can end the plugin option [C29]. This informs go or no-go on the plugin. **PM decides.**",
      "**We believe progress states are the lowest-risk wait fix.** They address two themes [T8]. Decision informed: scope of wait-state work for the beta. **PM decides.** Recommendation: ship staged progress and a completion email together.",
      "We think Dec 3 is too early to rely on a review estimate. **PM decides.**",
      "We recommend a staged rollout. **PM decides.**",
    ]);
    const r = readFollowUps(md, "PMX-49", NOW).decisions;
    expect(r.map((d) => [d.text, d.why])).toEqual([
      ["Decide whether to treat the plugin as a committed slot or a conditional one (PMX-49)", "We believe Dec 3 is too early to rely on a review estimate from colleagues."],
      ["Decide whether to go ahead with the plugin (PMX-49)", "We believe the token-storage review should finish before commitment, because it can end the plugin option."],
      ["Decide on the scope of wait-state work for the beta (PMX-49)", "We believe progress states are the lowest-risk wait fix. Recommendation: ship staged progress and a completion email together."],
      // Nothing it informs: whether the belief holds, with a month's capital kept.
      ["Decide whether Dec 3 is too early to rely on a review estimate (PMX-49)", "We think Dec 3 is too early to rely on a review estimate."],
      ["Decide on a staged rollout (PMX-49)", "We recommend a staged rollout."],
    ]);
    // After "PM decides:" too.
    expect(calls(draft("PMX-49: Plan", "Calls", ["**PM decides:** We believe the token-storage review should finish before commitment."]), "PMX-49"))
      .toEqual(["Decide whether the token-storage review should finish before commitment (PMX-49)"]);
    for (const d of r) expect(d.text).not.toMatch(/^Decide: We\b/);
  });

  it("4. two calls on one thing are one to-do: the better-formed first, the other's choice joined to it", () => {
    const md = [
      "# PMX-13: Validation plan for dedicated capacity", "",
      "## The ask", "",
      "- **Dedicated capacity price:** not set. The account lead will say by Dec 1 whether it's possible for the beta [C12]. **PM decides** whether it is a separate line or bundled.",
      "", "## Open questions", "",
      "1. **PM decides:** pilot length and price structure.",
      // The same three-word subject, far from the first: one call.
      "2. **PM decides:** dedicated capacity price and whether it can be ready for the beta. The account lead owes the number by Dec 1 [C4].",
      // One word in common, on the lines either side: one call.
      "3. **PM decides:** whether the price is per seat.",
      "4. **PM decides:** whether the price can be ready for January.",
      "", "## Later", "", "- The deck is long [T1].",
      // One word in common, far away: its own call.
      "- **PM decides:** whether the price includes support.",
      // A bare call on a thing beside a worded one adds nothing.
      "- **PM decides:** whether the kill date moves to March.",
      "- **PM decides:** kill date.",
    ].join("\n");
    expect(readFollowUps(md, "PMX-13", NOW).decisions.map((d) => [d.text, d.due])).toEqual([
      ["Decide whether the dedicated capacity price is a separate line or bundled, and whether it can be ready for the beta (PMX-13)", "2026-12-01"],
      ["Decide on the pilot length and price structure (PMX-13)", null],
      ["Decide whether the price is per seat, and whether it can be ready for January (PMX-13)", null],
      ["Decide whether the price includes support (PMX-13)", null],
      ["Decide whether the kill date moves to March (PMX-13)", null],
    ]);
    // On its own, "<thing> and whether …" is the decision on the thing, never "Decide: dedicated capacity price and …".
    expect(calls(draft("PMX-13: Plan", "Calls", ["**PM decides:** dedicated capacity price and whether it can be ready for the beta."]), "PMX-13"))
      .toEqual(["Decide on the dedicated capacity price and whether it can be ready for the beta (PMX-13)"]);
  });

  it("5. a question that asks who holds a role at a company asks that company's team, never a person", () => {
    const md = draft("PMX-21: Spec the order flow", "Open questions", [
      "Who signs the contract at Globex, and who is the procurement contact?",
      "Who is the procurement contact at Globex?",
      // No company: no team to ask.
      "Who is the procurement contact?",
      // Two groups: neither.
      "Who signs at Globex, and who is the legal or security contact?",
    ]);
    expect(readFollowUps(md, "PMX-21", NOW).questions.map((q) => q.ask?.role ?? null)).toEqual(["Globex's procurement", "Globex's procurement", null, null]);
    expect(asks(md, "PMX-21")[0]).toBe("Ask Globex's procurement: Who signs the contract at Globex, and who is the procurement contact? (PMX-21)");
  });

  it("6. a why is a statement: a bare question the draft left beside it gives way to the sentence that says where it comes from", async () => {
    const md = [
      "# PMX-39: Decide on the plugin", "", "## Open questions", "",
      "- Is the plugin's token storage safe, and can API v1 and OAuth support a plugin in the beta? Has a reviewer been asked? [C29] — ask: the platform lead",
      "- Who owns the audit log? Has anyone asked? Needed before Dec 12. — ask: the platform lead",
      "- **PM decides:** whether to ship in January. Has legal agreed? Recommend asking legal first.",
      "- **PM decides:** whether to pause the beta. Has legal agreed?",
    ].join("\n");
    await accept(md, { id: "lin-39", identifier: "PMX-39", title: "Decide on the plugin" });
    expect((await loadTodos()).items.map((t) => [t.text, t.why])).toEqual([
      ["Decide whether to ship in January (PMX-39)", "Recommend asking legal first."],
      ["Decide whether to pause the beta (PMX-39)", ""],
      ["Ask the platform lead: Is the plugin's token storage safe, and can API v1 and OAuth support a plugin in the beta? (PMX-39)", "PMX-39's accepted draft lists this as an open question."],
      ["Ask the platform lead: Who owns the audit log? (PMX-39)", "Needed before Dec 12."],
    ]);
  });
});

describe("the end-to-end test's lows on the re-read of older follow-ups (FOLLOW-1, 2026-11-27)", () => {
  const asks = (md: string, id: string, title?: string) => readFollowUps(md, id, NOW, { title }).questions.map((q) => askText(q.ask?.role ?? null, q.title, id, q.about));

  it("1. a call asked with \"which\" or \"what\" is \"Decide which …\", never \"Decide on the which …\"", () => {
    const md = draft("PMX-14: Price the multi-team deal", "Open questions", [
      "Which approval gate applies: the $50k vendor threshold, the $20k-per-team self-approval limit, or both? A quote near $40k would sit close to both. Pursue: ask the buyer directly. **PM decides.**",
      "**PM decides:** Which plan tier: Team or Business?",
    ]);
    expect(calls(md, "PMX-14")).toEqual([
      "Decide which approval gate applies: the $50k vendor threshold, the $20k-per-team self-approval limit, or both (PMX-14)",
      "Decide which plan tier: Team or Business (PMX-14)",
    ]);
    // A question word without its "?" is the decision too, not a label to decide "on".
    expect(calls(draft("PMX-18: Spec the approval step", "Open questions", ["What slips. Engineering estimates two sprints. **PM decides.**"]), "PMX-18")).toEqual(["Decide what slips (PMX-18)"]);
  });

  it("2. a question about what another party expects, wants, needs or plans asks that party, and a call keeps a clause's word order", () => {
    const md = draft("PMX-14: Price the multi-team deal", "Open questions", [
      "How many refreshes per team per year does the customer expect? Needed before we set a retrain allowance. Pursue: yes, a one-line email. **PM decides.**",
      "What does the buyer need from the security review?",
      // What we need, or what a thing needs, stays the PM's call, and so does a call the mark names.
      "Do we need a second region before the beta? **PM decides.**",
      "Does the buyer need SSO? **PM decides:** whether to offer it on the Team plan.",
      "How many seats does the pilot cover? **PM decides.**",
      "What is a retrain worth to us? **PM decides.**",
      // The question word asks of itself: left as written.
      "What is blocking the beta? **PM decides.**",
    ]);
    const r = readFollowUps(md, "PMX-14", NOW);
    expect(asks(md, "PMX-14")).toEqual([
      "Ask the customer: How many refreshes per team per year does the customer expect? (PMX-14)",
      "Ask the buyer: What does the buyer need from the security review? (PMX-14)",
    ]);
    // The mark is gone from what the to-do's why says.
    expect(r.questions[0]!.rest).toEqual(["Needed before we set a retrain allowance.", "Pursue: yes, a one-line email."]);
    expect(r.decisions.map((d) => d.text)).toEqual([
      "Decide whether we need a second region before the beta (PMX-14)",
      // Its "it" says nothing, so the question before the mark goes with it.
      "Decide whether to offer it on the Team plan: Does the buyer need SSO? (PMX-14)",
      "Decide how many seats the pilot covers (PMX-14)",
      "Decide what a retrain is worth to us (PMX-14)",
      "Decide what is blocking the beta (PMX-14)",
    ]);
    for (const t of r.decisions.map((d) => d.text)) expect(t).not.toMatch(/\bDecide how many \S+(?: \S+)* does\b/);
  });
});

describe("the end-to-end test's lows on the re-read of older follow-ups, continued (FOLLOW-1, 2026-11-27)", () => {
  const asks = (md: string, id: string, title?: string) => readFollowUps(md, id, NOW, { title }).questions.map((q) => askText(q.ask?.role ?? null, q.title, id, q.about));

  it("3. a call worded as something to do is a to-do as written, never \"Decide: check …\"", () => {
    const md = draft("PMX-6: Brief the compliance approval", "Open questions", [
      "**Does the beta scope meet the compliance bar?** Compare it with the fields and the retention [C14]. **PM decides:** check the scope against the list in writing with Globex's Legal & Compliance lead. Recommend yes, before the Dec 3 committee.",
      "**PM decides:** send the written plan to Globex.",
      // A choice's verb is still the decision whether to, and a noun phrase the decision on it.
      "**PM decides:** ship the approval step in the beta.",
      "**PM decides:** review cadence.",
    ]);
    const r = readFollowUps(md, "PMX-6", NOW);
    expect(r.decisions.map((d) => [d.text, d.due, d.why])).toEqual([
      ["Check the scope against the list in writing with Globex's Legal & Compliance lead (PMX-6)", "2026-12-03", "Recommend yes, before the Dec 3 committee."],
      ["Send the written plan to Globex (PMX-6)", null, ""],
      ["Decide whether to ship the approval step in the beta (PMX-6)", null, ""],
      ["Decide on the review cadence (PMX-6)", null, ""],
    ]);
    for (const d of r.decisions) expect(d.text).not.toMatch(/^Decide: (?:check|send|confirm)\b/i);
    // An item's lead, in a draft that names no call.
    expect(calls(draft("PMX-6: Brief the compliance approval", "Open questions", ["Confirm the export fields with legal. **PM decides.**"]), "PMX-6")).toEqual(["Confirm the export fields with legal (PMX-6)"]);
  });

  it("4. a thin call says what it's about: its label, else the question before it, else the task's subject; else its why names the task", () => {
    const one = (item: string, title = "PMX-34: Brief wait-state progress") => readFollowUps(draft(title, "Open questions", [item]), "PMX-34", NOW).decisions.map((d) => [d.text, d.why]);
    expect(one("Does a font change mid-run restart the job? [C26] **PM decides:** whether to warn users. Recommendation: confirm first."))
      .toEqual([["Decide whether to warn users: Does a font change mid-run restart the job? (PMX-34)", "Recommendation: confirm first."]]);
    expect(one("**Font restarts.** A font change may restart the job [C26]. **PM decides:** whether to warn users."))
      .toEqual([["Font restarts: decide whether to warn users (PMX-34)", ""]]);
    expect(one("A font change may restart the job [C26]. **PM decides:** whether to warn users.", "PMX-34: Spec the importer retry"))
      .toEqual([["Importer retry: decide whether to warn users (PMX-34)", ""]]);
    // A leaning word nothing resolves takes the question before it too.
    expect(one("Do the other four beta partners feel this? Only one account shows it. **PM decides:** whether to ask them during onboarding."))
      .toEqual([["Decide whether to ask them during onboarding: Do the other four beta partners feel this? (PMX-34)", ""]]);
    // Nothing more is known: the call stays, and its why names the task.
    const title = "PMX-34: Draft a problem brief on wait-state progress and cancel for long-running jobs";
    expect(one("A font change may restart the job [C26]. **PM decides:** whether to warn users. Recommendation: confirm first.", title))
      .toEqual([["Decide whether to warn users (PMX-34)", "The call is from PMX-34, \"Draft a problem brief on wait-state progress and cancel for long-running jobs\". Recommendation: confirm first."]]);
    // A call that names its thing is left as it is.
    expect(one("Does the beta slip? **PM decides:** whether to pause the beta.")).toEqual([["Decide whether to pause the beta (PMX-34)", ""]]);
  });

  it("4. a question that leans on \"the other …\" is asked as the item says, else starts with its label or the task's subject; else its why names the task", () => {
    const md = (item: string, title = "PMX-18: Spec the approval step") => draft(title, "Open questions", [item]);
    expect(asks(md("**Is the other partners' need real?** Ask the other four beta partners whether they want the approve step on or off by default. Evidence so far is Globex only [C14]."), "PMX-18"))
      .toEqual(["Ask the other four beta partners whether they want the approve step on or off by default (PMX-18)"]);
    const q = readFollowUps(md("**Is the other partners' need real?** Ask the other four beta partners whether they want the approve step on or off by default. Evidence so far is Globex only [C14]."), "PMX-18", NOW).questions[0]!;
    expect(askWhy(q, "PMX-18")).toBe("Evidence so far is Globex only.");
    // No ask of its own: the task's subject first, as for "this".
    expect(titles(md("Is the other partners' need real? — needs: research"), "PMX-18")).toEqual(["Approval step: is the other partners' need real?"]);
    // Nothing more is known: the ask stays, and its why names the task.
    const none = readFollowUps(md("Is the other partners' need real? — ask: the account lead", "PMX-18: Draft a spec for beta approve and reject with audit log export"), "PMX-18", NOW).questions[0]!;
    expect(askText(none.ask!.role, none.title, "PMX-18", none.about)).toBe("Ask the account lead: Is the other partners' need real? (PMX-18)");
    expect(askWhy(none, "PMX-18")).toBe("PMX-18's accepted draft, \"Draft a spec for beta approve and reject with audit log export\", lists this as an open question.");
  });

  it("5. a label before a question with no subject of its own stays its subject", () => {
    expect(titles(draft("PMX-18: Spec the approval step", "Open questions", [
      "**Separation of duties definition.** Same user only, or also same role or team? Needs the customer's input [C9].",
      "Retention scope. Seven years only, or also for exports?",
      // A whole question needs no label.
      "**Pricing.** Would accounts pay $20 a seat for the approval step?",
    ]), "PMX-18")).toEqual([
      "Separation of duties definition: same user only, or also same role or team?",
      "Retention scope: seven years only, or also for exports?",
      "Would accounts pay $20 a seat for the approval step?",
    ]);
  });

  it("6. a fragment that is no question, call or task is no follow-up at all; a short action and a statement are kept apart", () => {
    const md = draft("PMX-18: Spec the approval step", "Open questions", [
      "**Written plan owed.** Our head of product promised Globex a written plan by Nov 24 [C9]. The sources do not show whether it was sent.",
      "Send the plan.",
      "The preview link is switched off on Nov 27.",
    ]);
    expect(followUpItems(md, "PMX-18", NOW).map((i) => [i.text.split(".")[0], i.decision, i.question, i.junk ?? false])).toEqual([
      ["Written plan owed", null, null, true],
      ["Send the plan", null, null, false],
      ["The preview link is switched off on Nov 27", null, null, false],
    ]);
    // None of them is a follow-up when the draft is accepted (R2c).
    expect(readFollowUps(md, "PMX-18", NOW)).toEqual({ decisions: [], questions: [] });
  });
});
