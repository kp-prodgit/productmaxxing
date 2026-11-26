import { beforeEach, describe, expect, it } from "vitest";
import { readReceipt } from "../src/core/receipt.js";
import { formatReceipt, reconciledText } from "../src/explain/format.js";
import { page } from "../src/explain/page.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { askShape, formatTodos, parseTodos, reconcileTodos, refreshTodos, sameAsk, type FoundTodo } from "../src/todo/todo.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-20T15:00:00Z");
const DAYS: Record<string, string> = { T1: "2026-11-11", T2: "2026-11-12", T3: "2026-11-13", T4: "2026-11-14", T5: "2026-11-15", T6: "2026-11-16", T7: "2026-11-17" };
const day = (id: string) => DAYS[id] ?? "";
const f = (key: string, text: string, source: string, due: string | null = null, also: string[] = []): FoundTodo => ({ key, text, due, source, why: `From ${source}.`, at: day(source), also });
const keys = () => { let k = 0; return () => `N${++k}`; };

/** Seven meetings on seven days, read three per call; the PM is Ana. */
async function setup(reply: (ids: string[], earlier: { key: string; text: string }[], n: number) => object) {
  const { repo } = await pmxRepo();
  const dir = await tmp("overtaken-");
  for (let d = 1; d <= 7; d++) {
    await writeTranscript(dir, `m${d}.md`, `---\ntitle: Meeting ${d}\ndate: 2026-11-${10 + d}T10:00:00Z\nparticipants: sam@acme.example, ana@us.example\n---\nSam: Can you look at item ${d}?\n\nAna: I'll look at item ${d}.`);
  }
  let call = 0;
  const runtime = mockRuntime((o) => {
    const ids = [...o.prompt.matchAll(/<item id="(T\d+)"/g)].map((m) => m[1]!);
    const earlier = [...o.prompt.matchAll(/^- (E\d+): "([^"]*)"/gm)].map((m) => ({ key: m[1]!, text: m[2]! }));
    return JSON.stringify(reply(ids, earlier, ++call));
  });
  const ctx = await testCtx({ repo, runtime, now: NOW, team: { internalDomains: ["us.example"] }, personal: { identity: { names: ["Ana"], emails: ["ana@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null } } });
  return { ctx, runtime };
}
const keyOf = (earlier: { key: string; text: string }[], text: string) => earlier.find((e) => e.text === text)!.key;

describe("an earlier to-do a later meeting overtook (TODO-6)", () => {
  beforeEach(freshHome);

  it("is dropped with the meeting that shows it and why; one left out, or marked without a reason, stays", async () => {
    const ROADMAP = "Send Lee the draft roadmap before the planning review";
    const SSO = "Tell Acme whether SSO can make the beta";
    const CHECKLIST = "Send Sam the onboarding checklist";
    const { ctx, runtime } = await setup((ids, earlier, n) => {
      if (n === 1) return { todos: [
        { text: ROADMAP, due: "2026-11-14", source: ids[0], why: "You offered Lee the draft first." },
        { text: SSO, due: null, source: ids[1], why: "You told Acme you'd find out." },
        { text: CHECKLIST, due: null, source: ids[2], why: "You said you'd send it." },
      ] };
      if (n === 2) return {
        overtaken: [
          // The review it prepared for took place with the material.
          { id: keyOf(earlier, ROADMAP), source: ids[1], why: "Lee presented the draft roadmap in the planning review." },
          // Someone else took it over.
          { id: keyOf(earlier, SSO), source: ids[2], why: "Sam took over telling Acme about SSO in the beta." },
          // No reason, or no meeting: PMX keeps it.
          { id: keyOf(earlier, CHECKLIST), source: ids[0] },
          keyOf(earlier, CHECKLIST),
        ],
        todos: [],
      };
      return { todos: [] };
    });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    expect(r.calls).toBe(3);
    expect(r.added.map((t) => t.text)).toEqual([CHECKLIST]);
    // The second call is told what overtaken means, and that a reason is required.
    expect(runtime.calls[1]!.prompt).toContain("**Overtaken.** When a meeting below shows its outcome happened anyway");
    expect(runtime.calls[1]!.prompt).toContain("Without that meeting and sentence, PMX keeps it.");
    expect(runtime.calls[1]!.prompt).toContain("Anything else: leave it out.** It stays on the PM's list as it is: leaving an earlier to-do out never drops it.");
    // The third call still lists the one left standing.
    expect(runtime.calls[2]!.prompt.match(/^- E\d+: .*/gm)).toEqual(['- E3: "Send Sam the onboarding checklist", from the meeting on 2026-11-13']);
    const receipt = (await readReceipt(r.receiptId!))!;
    expect(receipt.todo!.reconciled).toEqual([
      { text: ROADMAP, how: "overtaken", by: "T5", why: "Lee presented the draft roadmap in the planning review." },
      { text: SSO, how: "overtaken", by: "T6", why: "Sam took over telling Acme about SSO in the beta." },
    ]);
    const out = formatReceipt(receipt, []);
    expect(out).toContain(`overtaken in "Meeting 5" on 2026-11-15 [T5], so dropped: ${ROADMAP}. Lee presented the draft roadmap in the planning review.`);
    expect(out).toContain(`overtaken in "Meeting 6" on 2026-11-16 [T6], so dropped: ${SSO}. Sam took over telling Acme about SSO in the beta.`);
  });

  it("the skill says when a to-do is overtaken and what is the same ask, with generic examples", async () => {
    const { ctx, runtime } = await setup(() => ({ todos: [] }));
    await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    const prompt = runtime.calls[0]!.prompt;
    expect(prompt).toContain("## Overtaken by a later meeting");
    expect(prompt).toContain("the meeting it prepared for took place with the material;");
    expect(prompt).toContain("someone else delivered it, or took it over;");
    expect(prompt).toContain("its due date has passed and a later meeting shows the need is gone.");
    expect(prompt).toContain("When unsure, it stays.");
    expect(prompt).toContain("## Same ask, one to-do");
    expect(prompt).toContain("Never merge to-dos for different people or different outcomes");
    // Inputs the PM asked colleagues for, for work the PM owes, are the PM's to collect.
    expect(prompt).toContain("**Collecting what the PM asked for counts.**");
    // W5 stays.
    expect(prompt).toContain("Never invent a to-do or a due date.");
  });

  it("parses overtaken only with an earlier ID, a meeting the call was given and a reason", () => {
    const text = JSON.stringify({
      overtaken: [
        { id: "E1", source: "T2", why: "The options were presented in the review." },
        "E2",
        { id: "E3", source: "T2" },
        { id: "E4", source: "T9", why: "A meeting the call wasn't given." },
        { id: "E5", source: "T2", why: "Given again below." },
        { id: "E6", source: "T2", why: "Also done." },
        { id: "E1", source: "T2", why: "Twice." },
        { id: "E8", source: "T2", why: "Not an earlier to-do." },
      ],
      done: ["E6"],
      todos: [{ text: "Send it", due: null, source: "T1", why: "x", replaces: "E5" }],
    });
    const p = parseTodos(text, new Set(["T1", "T2"]), new Set(["E1", "E2", "E3", "E4", "E5", "E6"]));
    expect(p.overtaken).toEqual([{ id: "E1", source: "T2", why: "The options were presented in the review." }]);
    expect(p.done).toEqual([{ id: "E6" }]);
  });

  it("never drops one the same answer gives again, or one passed without a reason", () => {
    const found = [f("E1", "Send the deck", "T1"), f("E2", "Ask Lee about SSO", "T1"), f("E3", "Book the review", "T2")];
    const r = reconcileTodos(found, {
      todos: [{ text: "Send the deck", due: null, source: "T4", why: "Again." }],
      done: [],
      overtaken: [{ id: "E1", source: "T4", why: "Shown." }, { id: "E2", source: "T4", why: "" }, { id: "E3", source: "T4", why: "The review took place." }],
    }, day, keys());
    expect(r.found.map((x) => [x.text, x.source, x.also])).toEqual([["Ask Lee about SSO", "T1", []], ["Send the deck", "T4", ["T1"]]]);
    expect(r.reconciled).toEqual([{ text: "Book the review", how: "overtaken", by: "T4", why: "The review took place." }, { text: "Send the deck", how: "merged", by: "T4" }]);
  });

  it("the explain page says it in the same words as the terminal", () => {
    const fn = page("n").match(/const reconciledText = \(x, sources\) => \{[\s\S]*?\n\};/)![0];
    const onPage = new Function(`${fn}; return reconciledText;`)() as (x: unknown, s: unknown) => string;
    const sources = [{ id: "T5", title: "Planning review", at: "2026-11-25T10:00:00Z", decision: "used" }] as any;
    const cases = [
      { text: "Send Lee the roadmap", how: "overtaken", by: "T5", why: "Lee presented it." },
      { text: "Send Lee the roadmap", how: "done", by: "T9" },
      { text: "Check rollover with Lee", how: "same-ask", by: "T5", into: "Get Lee's answers on rollover" },
    ] as const;
    for (const x of cases) {
      const term = reconciledText(x, sources);
      expect(onPage(x, sources)).toBe(term[0]!.toUpperCase() + term.slice(1));
    }
    expect(reconciledText(cases[0], sources)).toBe('overtaken in "Planning review" on 2026-11-25 [T5], so dropped: Send Lee the roadmap. Lee presented it.');
    expect(reconciledText(cases[1], sources)).toBe("done in a later meeting [T9], so dropped: Send Lee the roadmap");
  });
});

describe("the same ask, kept once (TODO-6)", () => {
  beforeEach(freshHome);

  it("reads a to-do's people, kind of ask and topic", () => {
    expect(askShape("Get the finance lead's answers on the overage cap and rollover so Sam has them by Tuesday")).toEqual({
      parties: new Set(["finance", "sam"]), kind: "ask", topic: new Set(["overage", "cap", "rollover"]),
    });
    expect(askShape("Set up 30 minutes with Sam on who launches the integrations in January")).toEqual({
      parties: new Set(["sam"]), kind: "talk", topic: new Set(["launch", "integration"]),
    });
    // Acronyms are topic, not people; months, weekdays and "a quarter" are timing.
    expect(askShape("Check a quarter of rollover with Lee by Friday")).toEqual({ parties: new Set(["lee"]), kind: "ask", topic: new Set(["rollover"]) });
    expect(askShape("Take the SSO question to Acme")).toEqual({ parties: new Set(["acme"]), kind: "ask", topic: new Set(["sso"]) });
  });

  it("merges the near-duplicates the test rig found, in their shape", () => {
    // Three to-dos for one ask to finance, by function or by name.
    for (const who of ["finance", "Lee"]) {
      const cap = `Check an overage cap with ${who}`;
      const rollover = `Check a quarter of rollover with ${who}`;
      const both = `Get ${who === "finance" ? "the finance lead" : "Lee"}'s answers on the overage cap and rollover so Sam has them by Tuesday`;
      expect([sameAsk(cap, both), sameAsk(rollover, both), sameAsk(both, cap)]).toEqual([true, true, true]);
      // On their own, the two checks are different asks; the third ties them together.
      expect(sameAsk(cap, rollover)).toBe(false);
    }
    // Time set up to discuss the same thing with the same person.
    expect(sameAsk("Talk with Sam about the integrations choice", "Set up 30 minutes with Sam on who launches the integrations in January")).toBe(true);
    expect(sameAsk("Take the SSO question to Lee", "Ask Lee whether SSO can make the beta")).toBe(true);
    expect(sameAsk("Send Sam the deck", "Send Sam the deck and the pricing sheet")).toBe(true);
  });

  it("never merges different people, different kinds of ask, or different outcomes", () => {
    const apart: [string, string][] = [
      ["Send Sam the deck", "Send Lee the deck"],
      ["Check the SSO answer with Lee", "Check the SSO answer with Sam"],
      ["Ask legal about the retention clause", "Ask security about the retention clause"],
      ["Show the options to Lee before they go to anyone else", "Send Sam the options side by side before Acme's Wednesday meeting"],
      ["Send Sam the pricing deck", "Send Sam the pricing FAQ"],
      ["Send Sam the pricing deck", "Send Sam the security questionnaire"],
      ["Send Acme the SOC 2 report", "Send Acme the security questionnaire"],
      ["Send Sam the deck", "Ask Sam for feedback on the deck"],
      ["Send Sam the deck", "Walk Sam through the deck"],
      ["Talk to Sam about hiring", "Talk to Sam about the roadmap"],
      ["Tell Acme whether SSO can be pulled into the beta", "Tell Acme the beta start date"],
      ["Set up 30 minutes with Lee on the migration plan", "Talk to Sam about the renewal discount"],
      ["Set up 30 minutes with Lee on the migration plan", "Talk to Lee about the renewal discount"],
      // Nobody named: only the same words merge.
      ["Draft the pricing note", "Draft the pricing note for the launch"],
      ["Send Jane the one-pager", "Share the slide with Jane by Friday"],
    ];
    for (const [a, b] of apart) expect([a, b, sameAsk(a, b)]).toEqual([a, b, false]);
  });

  it("folds a later call's to-do with earlier ones that are the same ask: fuller words, earliest date, every meeting", () => {
    const BOTH = "Get the finance lead's answers on the overage cap and rollover so Sam has them by Tuesday";
    const found = [
      f("E1", "Check an overage cap with finance", "T1"),
      f("E2", "Check a quarter of rollover with finance", "T2", "2026-11-21"),
      f("E3", "Send Sam the onboarding checklist", "T2"),
    ];
    const r = reconcileTodos(found, { todos: [{ text: BOTH, due: "2026-11-24", source: "T4", why: "You told Sam you'd get them." }], done: [] }, day, keys());
    expect(r.found.map((x) => [x.key, x.text, x.due, x.source, x.also, x.why])).toEqual([
      ["E3", "Send Sam the onboarding checklist", null, "T2", [], "From T2."],
      ["N1", BOTH, "2026-11-21", "T4", ["T1", "T2"], "You told Sam you'd get them."],
    ]);
    expect(r.reconciled).toEqual([
      { text: "Check an overage cap with finance", how: "same-ask", by: "T4", into: BOTH },
      { text: "Check a quarter of rollover with finance", how: "same-ask", by: "T4", into: BOTH },
    ]);
  });

  it("keeps the earlier, fuller words when the later to-do is a part of it, and works within one answer", () => {
    const BOTH = "Get Lee's answers on the overage cap and rollover so Sam has them by Tuesday";
    const r = reconcileTodos([], { todos: [
      { text: BOTH, due: null, source: "T2", why: "You told Sam." },
      { text: "Check a quarter of rollover with Lee", due: "2026-11-13", source: "T1", why: "You said you'd check." },
      { text: "Talk with Sam about the integrations choice", due: null, source: "T1", why: "You offered." },
      { text: "Set up 30 minutes with Sam on who launches the integrations in January", due: null, source: "T3", why: "You said let's grab time." },
    ], done: [] }, day, keys());
    expect(r.found.map((x) => [x.text, x.due, x.source, x.also, x.why])).toEqual([
      [BOTH, "2026-11-13", "T2", ["T1"], "You told Sam."],
      ["Set up 30 minutes with Sam on who launches the integrations in January", null, "T3", ["T1"], "You said let's grab time."],
    ]);
    expect(r.reconciled.map((x) => [x.how, x.text, x.into])).toEqual([
      ["same-ask", "Check a quarter of rollover with Lee", BOTH],
      ["same-ask", "Talk with Sam about the integrations choice", "Set up 30 minutes with Sam on who launches the integrations in January"],
    ]);
  });

  it("an explicit done or overtaken wins over the check, and different asks stay apart", () => {
    const found = [f("E1", "Show the options to Lee", "T1"), f("E2", "Send Sam the deck", "T1"), f("E3", "Draft the pricing note", "T2")];
    const r = reconcileTodos(found, {
      overtaken: [{ id: "E1", source: "T4", why: "The options were presented." }],
      done: [],
      todos: [
        // The same ask as the overtaken one, but that one is gone: a new to-do, never brought back.
        { text: "Show the revised options to Lee", due: null, source: "T4", why: "You offered again." },
        { text: "Send Lee the deck", due: null, source: "T4", why: "You offered." },
        { text: "Draft the pricing note for the launch", due: null, source: "T4", why: "You said so." },
      ],
    }, day, keys());
    expect(r.found.map((x) => x.text)).toEqual(["Send Sam the deck", "Draft the pricing note", "Show the revised options to Lee", "Send Lee the deck", "Draft the pricing note for the launch"]);
    expect(r.reconciled).toEqual([{ text: "Show the options to Lee", how: "overtaken", by: "T4", why: "The options were presented." }]);
  });

  it("a full run keeps one to-do per ask, citing every meeting, and explain says why (W5: nothing invented)", async () => {
    const BOTH = "Get the finance lead's answers on the overage cap and rollover so Sam has them by Tuesday";
    const given: string[] = [];
    const { ctx } = await setup((ids, _earlier, n) => {
      const todos = n === 1 ? [
        { text: "Check an overage cap with finance", due: null, source: ids[0], why: "You said you'd check." },
        { text: "Check a quarter of rollover with finance", due: null, source: ids[1], why: "You said you'd check." },
        { text: "Talk with Sam about the integrations choice", due: null, source: ids[2], why: "You offered." },
      ] : n === 2 ? [
        { text: BOTH, due: "2026-11-17", source: ids[0], why: "You told Sam you'd get them." },
        { text: "Send Acme the SOC 2 report", due: null, source: ids[1], why: "You promised Acme." },
      ] : [
        { text: "Set up 30 minutes with Sam on who launches the integrations in January", due: null, source: ids[0], why: "You said let's grab time." },
      ];
      given.push(...todos.map((t) => t.text));
      return { todos };
    });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 14) });
    expect(r.added.map((t) => [t.text, t.due, t.source.title, (t.also ?? []).map((a) => a.title)])).toEqual([
      [BOTH, "2026-11-17", "Meeting 4", ["Meeting 1", "Meeting 2"]],
      ["Send Acme the SOC 2 report", null, "Meeting 5", []],
      ["Set up 30 minutes with Sam on who launches the integrations in January", null, "Meeting 7", ["Meeting 3"]],
    ]);
    // Every to-do kept is one the model gave, in its words.
    expect(r.added.every((t) => given.includes(t.text))).toBe(true);
    const receipt = (await readReceipt(r.receiptId!))!;
    const out = formatReceipt(receipt, []);
    expect(out).toContain(`the same ask as "${BOTH}" [T4], kept once citing both: Check an overage cap with finance`);
    expect(out).toContain(`the same ask as "${BOTH}" [T4], kept once citing both: Check a quarter of rollover with finance`);
    expect(out).toContain('the same ask as "Set up 30 minutes with Sam on who launches the integrations in January" [T7], kept once citing both: Talk with Sam about the integrations choice');
    expect(formatTodos(r.added)).toContain('from "Meeting 4" on 2026-11-14, also "Meeting 1" on 2026-11-11, also "Meeting 2" on 2026-11-12: You told Sam you\'d get them.');
  });
});
