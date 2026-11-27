// FOLLOW-1: the words of the to-dos and follow-up tasks an accepted draft leaves. A call or a question that leans on
// "it", "this" or "that test" says what it stands for, or starts with what its item is about; a yes/no call reads as
// "Decide whether …"; an unmarked question that names a group asks that group; an ask keeps the question as written;
// an ask's why is a whole sentence; and a company's name keeps its capital.
import { beforeEach, describe, expect, it } from "vitest";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { askText, followUpsOnAccept, readFollowUps } from "../src/review/followups.js";
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

  it("an unmarked question that names a group asks that group; never the role it asks for, two groups or a person", () => {
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
      [null, "Find out: Who signs the contract at Globex, and who is the procurement contact? (PMX-21)"],
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
      // "this" stands for a whole sentence: the label goes first.
      "**Globex integration.** The contract needs a signed DPA [T1]. Does the integration need this for the contract? — needs: research",
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
      "Globex integration: does the integration need this for the contract?",
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
