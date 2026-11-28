// FOLLOW-1: a follow-up is identified by a fixed ID, never by its wording. The ID is the item of the draft it was read
// from (src/review/follow-up-id.ts); the ledger on the PM's Mac keeps it with the to-do or task it became; accepting the
// same draft again, or after the re-read of older follow-ups, finds it by that ID and makes none twice, whatever PMX's
// wording rules have become. A ledger PMX 0.40.3 or earlier wrote, with keys made from its wording, is still honoured
// through a frozen copy of that reader (src/review/legacy/).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readJson } from "../src/core/fsutil.js";
import { services } from "../src/core/services.js";
import { updateState } from "../src/core/state.js";
import type { Task } from "../src/core/types.js";
import { draftItems, followUpItems, readFollowUps } from "../src/review/draft-reader.js";
import { itemIds, itemWords } from "../src/review/follow-up-id.js";
import { followUpsFile, followUpsOnAccept, followUpText, type Made } from "../src/review/followups.js";
import { legacyKeys } from "../src/review/legacy/follow-up-keys.js";
import { requeueStep } from "../src/review/requeue.js";
import { readProposals, stageProposals, type Proposal } from "../src/synth/proposals.js";
import { completeTodo, loadTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx } from "./helpers.js";

/**
 * Two stand-ins. `texts`: everything the ID function is ever given. `reword`: tomorrow's wording rules, a reader that
 * finds the same follow-ups in the same items and words every one of them differently.
 */
const sim = vi.hoisted(() => ({ reword: false, texts: [] as string[] }));

vi.mock("../src/review/follow-up-id.js", async (original) => {
  const real = await original<typeof import("../src/review/follow-up-id.js")>();
  return { ...real, itemIds: (texts: readonly string[]) => { sim.texts.push(...texts); return real.itemIds(texts); } };
});

vi.mock("../src/review/draft-reader.js", async (original) => {
  const real = await original<typeof import("../src/review/draft-reader.js")>();
  type Call = ReturnType<typeof real.readFollowUps>["decisions"][number];
  type Question = ReturnType<typeof real.readFollowUps>["questions"][number];
  const call = <T extends Call | null>(d: T): T => (d && sim.reword ? { ...d, text: `Make the call: ${d.text[0]!.toLowerCase()}${d.text.slice(1)}` } : d);
  const question = <T extends Question | null>(q: T): T => (q && sim.reword ? { ...q, title: `In other words: ${q.title}` } : q);
  return {
    ...real,
    readFollowUps: (...a: Parameters<typeof real.readFollowUps>) => {
      const r = real.readFollowUps(...a);
      return { decisions: r.decisions.map(call), questions: r.questions.map(question) };
    },
    followUpItems: (...a: Parameters<typeof real.followUpItems>) => real.followUpItems(...a).map((i) => ({ ...i, decision: call(i.decision), question: question(i.question) })),
  };
});

const NOW = new Date(2026, 10, 26, 10);
const PATH = "outputs/spec/PMX-52.md";
const TITLE = "Brief the Northwind pilot terms";

/**
 * A draft with every kind of follow-up, more of them than one accept makes (seven calls for five to-dos, four
 * questions that need work for three tasks), and one call the draft marks twice in the same words.
 */
const DRAFT = `# PMX-52: Brief the Northwind pilot terms

## Summary

Northwind wants a pilot before it signs [T1].

## Implications

- **Pilot price.** Options: $12 a seat, or $15 with onboarding. **PM decides:** whether to hold the pilot price at $12 a seat. Recommend $12, settled before Dec 8.
- **Dedicated capacity price.** The dedicated capacity price isn't in any source [T2]. **PM decides:** whether it is a separate line or bundled.
- **PM decides:** Seat minimum: 25 or 50 seats.
- **PM decides:** whether to offer a 60-day exit clause [T3].
- **PM decides:** whether to name Northwind in the launch post.
- **PM decides:** whether to add a second pilot site in March.

## Blocking questions

- Who signs the order form at Northwind, and who is the procurement contact? Needed before Dec 12.
- How many seats does the customer expect to fill in the first quarter? **PM decides.**
- Does a seat change mid-term restart the billing period? [C4] **PM decides:** whether to warn admins.

## Open questions

- Which plan do accounts of Northwind's size usually start on [T2]?
- Would a second design partner pay for dedicated capacity? — needs: a validation plan
- How long does onboarding take an admin today?
- How many admins asked for seat reports this quarter?
- Is the security review scheduled? — ask: the security lead
- **PM decides:** whether to name Northwind in the launch post.
`;

/** What accepting DRAFT makes, as PMX 0.40.3 said it and as PMX says it now: the counts are the same. */
const MADE = "5 decisions and 3 questions to ask added to your to-dos; 3 follow-up tasks wait for your approval in Needs you; 1 more question stays in the draft; 2 more decisions stay in the draft.";
const AGAIN = "1 more question stays in the draft; 2 more decisions stay in the draft; 11 follow-ups were already made from this draft.";

/**
 * The follow-ups ledger exactly as PMX 0.40.3 (commit ab341c1, before this change) wrote it after accepting DRAFT as
 * PMX-52 "Brief the Northwind pilot terms": taken from a run of that code, not worked out by this one. Its keys are
 * hashes of 0.40.3's own wording of each follow-up.
 */
const LEDGER_0403 = {
  v: 1,
  drafts: {
    [`PMX-52 ${PATH}`]: {
      at: "2026-11-26T16:00:00.000Z",
      made: ["3782ee68f705", "500a81b5f40b", "4982c04ab641", "e3343aa76e3f", "c1394d6a1a7f", "56b2a8679fd1", "ee03662a8097", "b2ddede32f72", "ffc32c8a0326", "bdf2a0c7cfca", "8eee1ad2e2aa"],
      left: ["902babf4db89", "8dfb4f53518e", "c37661a97e19"],
    },
  },
};

/**
 * Keys as a PMX before 0.40 recorded them for four of DRAFT's follow-ups, from its wording of them then (": Seat
 * minimum: 25 or 50 seats", the question with its mark still in it …). Literal: the frozen 0.40.3 reader gives none of
 * them for any item of DRAFT, and neither does anything else.
 */
const OLDER = { seatMinimum: "7611f66ddbc7", warnAdmins: "69043614077f", customer: "26f0e3f15508", security: "573704d24cae" };

/**
 * The ledger of a Mac that accepted DRAFT on that older PMX: the same follow-ups made and left as LEDGER_0403, three of
 * the made and one of the left under the older keys.
 */
const LEDGER_OLDER = {
  v: 1,
  drafts: {
    [`PMX-52 ${PATH}`]: {
      at: "2026-11-12T16:00:00.000Z",
      made: ["3782ee68f705", "500a81b5f40b", OLDER.seatMinimum, "e3343aa76e3f", "c1394d6a1a7f", "56b2a8679fd1", OLDER.customer, OLDER.security, "ffc32c8a0326", "bdf2a0c7cfca", "8eee1ad2e2aa"],
      left: ["902babf4db89", OLDER.warnAdmins, "c37661a97e19"],
    },
  },
};

type Entry = { at: string; made: string[]; left?: string[]; bridged?: string; followUps?: Made[]; leftIds?: string[]; requeued?: unknown[] };
const ledger = async (key = `PMX-52 ${PATH}`) => (await readJson<{ v: number; drafts: Record<string, Entry> }>(followUpsFile()))!.drafts[key]!;

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-52", identifier: "PMX-52", title: TITLE, description: "Northwind asked for a pilot.", url: "https://linear.app/acme/issue/PMX-52",
  category: "spec", size: "M", status: "ready", priority: 2, agent: null, sources: [], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

async function mac() {
  const { repo } = await pmxRepo();
  const ctx = await testCtx({ repo, now: NOW });
  const svc = await services(ctx, { tracker: memoryTracker([]) });
  const accept = (md = DRAFT, over: Partial<Task> = {}) => {
    const t = task(over);
    return followUpsOnAccept(ctx, svc, { task: t, record: null, files: [{ path: `outputs/spec/${t.identifier}.md`, content: md }], citations: {} });
  };
  return { repo, ctx, svc, accept };
}

const src = (...p: string[]) => join(dirname(fileURLToPath(import.meta.url)), "..", "src", ...p);
const read = (md = DRAFT, id = "PMX-52", title: string | undefined = TITLE) => readFollowUps(md, id, NOW, { title });
const idsOf = (r: ReturnType<typeof read>) => [...r.decisions, ...r.questions].map((f) => f.ids);
const wordsOf = (r: ReturnType<typeof read>) => [...r.decisions.map((d) => d.text), ...r.questions.map((q) => q.title)];

beforeEach(async () => {
  sim.reword = false;
  sim.texts = [];
  await freshHome();
});

describe("a follow-up's fixed ID is its item in the draft, never PMX's wording of it (FOLLOW-1)", () => {
  it("is the item's own words and its place among items with the same words, and never changes", () => {
    // Pinned: a change to how an item's words are read, or to the hash, gives every item a new ID and every PM who
    // accepts a draft again their to-dos twice. If this fails, undo the change rather than the expectation.
    const item = "**PM decides:** whether to name Northwind in the launch post.";
    expect(itemIds([item])).toEqual(["f1-89620b1a61549e99"]);
    // Emphasis, a dash for a colon, a line break inside the item or more spaces: the same item.
    expect(itemIds(["PM decides — whether to name   Northwind\nin the launch post"])).toEqual(["f1-89620b1a61549e99"]);
    expect(itemWords(item)).toBe("pm decides whether to name northwind in the launch post");
    // Another word, another item.
    expect(itemIds([item.replace("post", "email")])).toEqual(["f1-e1c8d92055811724"]);
    // Letters of any language are words; nothing else is.
    expect(itemWords("Prüfen: «Größe» für 2 Büros?")).toBe("prüfen größe für 2 büros");
  });

  it("two items with the same words are two items: the second has its own ID", () => {
    const item = "**PM decides:** whether to name Northwind in the launch post.";
    const ids = itemIds([item, "Another item.", item, item]);
    expect(ids).toEqual(["f1-89620b1a61549e99", ids[1], "f1-3c4a56d6c221d797", ids[3]]);
    expect(new Set(ids).size).toBe(4);
    // In a draft: each item its own, in the draft's order, and what counts as one item is pinned with them.
    const items = draftItems(DRAFT);
    expect(items.map((i) => i.id)).toEqual([
      "f1-95b111d60bb5ee33", "f1-03f060349fdfb253", "f1-85a057abe6f5f689", "f1-693097ee8b954bfe", "f1-7531d8f2118a57a9", "f1-89620b1a61549e99", "f1-75426f4c3b70aedb",
      "f1-41c2885a4554a573", "f1-066d5ad90ac71bb0", "f1-edfc2fd42c3e141e",
      "f1-9b30280b7b36ef8a", "f1-993a00533a649a44", "f1-fd9d2ff50d7612d3", "f1-9e7d9c77aeb42e9e", "f1-8997d5b2d9a5a9db", "f1-3c4a56d6c221d797",
    ]);
    expect([items[5]!.text, items[15]!.text]).toEqual([item, item]);
    // A nested line belongs to its item, so it is part of what the item is.
    const nested = draftItems("## Open questions\n\n- Who funds the pilot?\n  - Finance said Q1.\n- Who funds the pilot?\n");
    expect(nested.map((i) => i.text)).toEqual(["Who funds the pilot? Finance said Q1.", "Who funds the pilot?"]);
    expect(nested[0]!.id).not.toBe(nested[1]!.id);
  });

  it("no wording can reach it: the ID is made from the draft's items alone, before anything is worded", async () => {
    // By construction. The ID function is given the draft's items as the author wrote them, and nothing else, ever:
    // while reading, accepting, working out the old keys and reading older follow-ups again.
    // Under tomorrow's wording too, where every follow-up's words differ from its item's.
    const { accept } = await mac();
    for (const reword of [false, true]) {
      sim.reword = reword;
      const r = read();
      followUpItems(DRAFT, "PMX-52", NOW, { title: TITLE });
      legacyKeys(DRAFT, "PMX-52", NOW, { title: TITLE });
      await accept();
      // The draft's items, read here from its lines: a paragraph, or a list item without its mark.
      const own = DRAFT.split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.replace(/^- /, ""));
      expect(new Set(sim.texts)).toEqual(new Set(own));
      for (const t of sim.texts) expect(t).not.toMatch(/\(PMX-52\)|^(?:Decide|Ask|Find out|Make the call|In other words)\b/);
      if (reword) expect(wordsOf(r).some((w) => sim.texts.includes(w))).toBe(false);
    }
    // It knows nothing of the reader: it imports the hash and nothing else.
    const id = await readFile(src("review", "follow-up-id.ts"), "utf8");
    expect([...id.matchAll(/^import .* from "(.+)";$/gm)].map((m) => m[1])).toEqual(["node:crypto"]);
    // The reader makes IDs in one place, from the items (`partsOf`), and makes no hash or key of its own.
    const reader = await readFile(src("review", "draft-reader.ts"), "utf8");
    expect(reader.match(/\bitemIds\(/g)).toHaveLength(1);
    expect(reader).toContain("const ids = itemIds(parts.flatMap((p) => p.blocks.map((b) => b.text)));");
    expect(reader).not.toMatch(/createHash|node:crypto|\bkeyOf\b|legacy\//);
  });

  it("a different wording of the same item keeps its ID", () => {
    const now = read();
    // Tomorrow's rules word every follow-up differently: each keeps the ID it has today.
    sim.reword = true;
    const later = read();
    expect(wordsOf(later).every((w, i) => w !== wordsOf(now)[i])).toBe(true);
    expect(idsOf(later)).toEqual(idsOf(now));
    sim.reword = false;
    // The task under another identifier, so every to-do's words differ: the items' IDs are the same.
    const other = read(DRAFT, "PMX-900");
    expect(other.decisions.map((d) => d.text)).not.toEqual(now.decisions.map((d) => d.text));
    expect(idsOf(other)).toEqual(idsOf(now));
    // Words PMX takes from around the item, here the task's title, change the follow-up's words and never its ID.
    const md = "## Open questions\n\n- Does the integration need this for the contract?\n";
    const [a, b] = [read(md, "PMX-8", "Spec the Globex email integration"), read(md, "PMX-8", "Spec the Initech billing sync")];
    expect([a.questions[0]!.title, b.questions[0]!.title]).toEqual(["Globex email integration: does the integration need this for the contract?", "Initech billing sync: does the integration need this for the contract?"]);
    expect(a.questions[0]!.id).toBe(b.questions[0]!.id);
    expect(a.questions[0]!.id).toBe(itemIds(["Does the integration need this for the contract?"])[0]);
  });

  it("each follow-up carries the ID of every item it was read from, and the re-read's items carry the same IDs", () => {
    const r = read();
    const byText = new Map(draftItems(DRAFT).map((i) => [i.text, i.id]));
    // One follow-up from one item, by that item's ID.
    expect(r.decisions[0]).toMatchObject({ text: "Decide whether to hold the pilot price at $12 a seat (PMX-52)", id: "f1-03f060349fdfb253", ids: ["f1-03f060349fdfb253"] });
    expect(r.questions.map((q) => q.ids)).toEqual(["Who signs the order form at Northwind, and who is the procurement contact? Needed before Dec 12.", "How many seats does the customer expect to fill in the first quarter? **PM decides.**",
      "Which plan do accounts of Northwind's size usually start on [T2]?", "Would a second design partner pay for dedicated capacity? — needs: a validation plan", "How long does onboarding take an admin today?",
      "How many admins asked for seat reports this quarter?", "Is the security review scheduled? — ask: the security lead"].map((t) => [byText.get(t)]));
    // The call the draft marks twice in the same words is one to-do, as it always was, read from two items.
    expect(r.decisions[4]).toMatchObject({ text: "Decide whether to name Northwind in the launch post (PMX-52)", id: "f1-89620b1a61549e99", ids: ["f1-89620b1a61549e99", "f1-3c4a56d6c221d797"] });
    // Two calls on one thing are one to-do (`mergeCalls`), read from both items, the earlier first.
    const both = "## Pricing\n\n- **Dedicated capacity price.** The dedicated capacity price isn't set [T2]. **PM decides:** whether it is a separate line or bundled.\n- **PM decides:** dedicated capacity price and whether it can be ready for the beta.\n";
    const merged = read(both, "PMX-13", "Price dedicated capacity");
    expect(merged.decisions.map((d) => [d.text, d.ids])).toEqual([["Decide whether the dedicated capacity price is a separate line or bundled, and whether it can be ready for the beta (PMX-13)", draftItems(both).map((i) => i.id)]]);
    // The re-read of older follow-ups (D2-8) reads the same items under the same IDs.
    const items = followUpItems(DRAFT, "PMX-52", NOW, { title: TITLE });
    for (const i of items) expect([i.decision?.ids ?? i.question?.ids ?? [i.id]].flat()).toContain(i.id);
    expect(new Set(items.map((i) => i.id))).toEqual(new Set(idsOf(r).flat()));
  });
});

describe("accepting the same draft again makes no follow-up twice, by its ID (FOLLOW-1)", () => {
  it("the ledger keeps each follow-up's ID with the to-do or task it became, and a second accept makes none", async () => {
    const { accept } = await mac();
    const first = await accept();
    // The same counts as PMX 0.40.3 made from this draft.
    expect(followUpText(first)).toBe(MADE);
    const todos = (await loadTodos()).items;
    const proposals = await readProposals();
    expect([todos.length, proposals.length]).toEqual([8, 3]);
    const r = read();
    const e = await ledger();
    // Each made, under each item it was read from, with what it became.
    const todo = (text: string) => todos.find((t) => t.text === text)!.id;
    const task = (title: string) => proposals.find((p) => p.title === title)!.id;
    expect(e.followUps!.map(({ id, as, todo, proposal }) => ({ id, as, ...(todo ? { todo } : {}), ...(proposal ? { proposal } : {}) }))).toEqual([
      ...r.decisions.slice(0, 5).flatMap((d) => d.ids.map((id) => ({ id, as: "decision", todo: todo(d.text) }))),
      { id: r.questions[0]!.id, as: "ask", todo: todo("Ask Northwind's procurement: Who signs the order form at Northwind, and who is the procurement contact? (PMX-52)") },
      { id: r.questions[1]!.id, as: "ask", todo: todo("Ask the customer: How many seats does the customer expect to fill in the first quarter? (PMX-52)") },
      { id: r.questions[6]!.id, as: "ask", todo: todo("Ask the security lead: Is the security review scheduled? (PMX-52)") },
      ...r.questions.slice(2, 5).map((q) => ({ id: q.id, as: "work", proposal: task(q.title) })),
    ]);
    expect(e.followUps).toHaveLength(12);
    expect(e.followUps!.every((m) => m.at === NOW.toISOString() && !m.legacy && !m.already)).toBe(true);
    // Left in the draft over the caps, by their IDs.
    expect(e.leftIds).toEqual([r.decisions[5]!.id, r.decisions[6]!.id, r.questions[5]!.id]);
    // No wording key is written any more; `made` stays an empty list, which an older PMX reading this file expects.
    expect([e.made, e.left]).toEqual([[], undefined]);

    const again = await accept();
    expect(again).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    expect(followUpText(again)).toBe(AGAIN);
    expect([(await loadTodos()).items.length, (await readProposals()).length]).toEqual([8, 3]);
    expect((await ledger()).followUps).toEqual(e.followUps);
  });

  it("after PMX's wording changes, a second accept still makes none: found by ID, where no words match", async () => {
    const { accept } = await mac();
    expect(followUpText(await accept())).toBe(MADE);
    const before = (await loadTodos()).items.map((t) => t.text);
    // Tomorrow's PMX words every follow-up differently. The to-dos are open under today's words, so no check by words
    // can know them: only the IDs do.
    sim.reword = true;
    const said = read();
    expect(said.decisions.map((d) => d.text).some((t) => before.includes(t))).toBe(false);
    const again = await accept();
    expect(again).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    expect((await loadTodos()).items.map((t) => t.text)).toEqual(before);
    expect(await readProposals()).toHaveLength(3);
    // And once the PM has done them all, still none.
    for (const t of (await loadTodos()).items) await completeTodo(t.id, NOW);
    expect(await accept()).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0 });
    expect((await loadTodos()).items.filter((t) => t.status === "open")).toEqual([]);
  });

  it("two items with the same words that are two follow-ups both become to-dos, once each", async () => {
    // A decision brief: a marked item under Options is the brief's one decision; the same item under Risks is a call of
    // its own. Two items, the same words, two IDs, two to-dos.
    const item = "- **Counter.** Whether to counter with a one-year lock. **PM decides.**";
    const brief = ["# PMX-61: Decide on the Northwind renewal", "", "## Decision", "", "Whether to accept, counter or decline Northwind's two-year price lock.", "", "## Options", "",
      "- **Accept.** Two years at today's price.", item, "", "## Recommendation", "", "Counter with a one-year lock: it keeps the account.", "", "## Risks", "", item, ""].join("\n");
    const over = { id: "lin-61", identifier: "PMX-61", title: "Decide on the Northwind renewal", category: "decision-brief" };
    const [a, b] = draftItems(brief).filter((i) => i.text === item.slice(2));
    expect(a!.id).not.toBe(b!.id);
    const { accept } = await mac();
    const first = await accept(brief, over);
    expect(first.todos.map((t) => t.text)).toEqual(["Decide whether to accept, counter or decline Northwind's two-year price lock (PMX-61)", "Decide whether to counter with a one-year lock (PMX-61)"]);
    expect((await ledger("PMX-61 outputs/spec/PMX-61.md")).followUps!.map((m) => [m.id, m.todo])).toEqual([[a!.id, first.todos[0]!.id], [b!.id, first.todos[1]!.id]]);
    // Again, and again under other words: each was made once.
    expect(await accept(brief, over)).toMatchObject({ todos: [], repeated: 2, duplicates: 0 });
    sim.reword = true;
    expect(await accept(brief, over)).toMatchObject({ todos: [], repeated: 2, duplicates: 0 });
    expect((await loadTodos()).items).toHaveLength(2);
  });

  it("the checks by words stay, as a net under the IDs: an open to-do or a waiting task with the same words is not made again", async () => {
    const { ctx, svc, accept } = await mac();
    await accept();
    const todos = (await loadTodos()).items;
    // The same follow-ups from another draft of the task (a new path, so a ledger of its own with no IDs yet): the
    // open to-dos and waiting tasks with the same words are found, counted as already on the list, and recorded. The
    // three the first accept left in its draft over the caps are new to this one, and made.
    const other = await followUpsOnAccept(ctx, svc, { task: task(), record: null, files: [{ path: "outputs/spec/PMX-52-v2.md", content: DRAFT }], citations: {} });
    expect(other).toMatchObject({ asks: [], repeated: 0, duplicates: 11, moreQuestions: 0, moreDecisions: 0 });
    expect(other.todos.map((t) => t.text)).toEqual(["Decide whether to add a second pilot site in March (PMX-52)", "Decide whether to warn admins, given the question: Does a seat change mid-term restart the billing period? (PMX-52)"]);
    expect(other.proposals.map((p) => p.title)).toEqual(["How many admins asked for seat reports this quarter?"]);
    expect((await loadTodos()).items).toHaveLength(10);
    const already = (await ledger("PMX-52 outputs/spec/PMX-52-v2.md")).followUps!.filter((m) => m.already);
    expect(already).toHaveLength(12);
    // A to-do's net names the to-do that was there.
    expect(already.filter((m) => m.as !== "work").map((m) => m.todo)).toEqual([...todos.slice(0, 4).map((t) => t.id), todos[4]!.id, todos[4]!.id, ...todos.slice(5).map((t) => t.id)]);
    expect(already.filter((m) => m.as === "work").every((m) => !m.todo && !m.proposal)).toBe(true);
  });
});

describe("a ledger PMX 0.40.3 or earlier wrote, with keys made from its wording (FOLLOW-1)", () => {
  const install = async (l: object) => {
    await mkdir(dirname(followUpsFile()), { recursive: true });
    await writeFile(followUpsFile(), JSON.stringify(l, null, 2));
  };
  const install0403 = () => install(LEDGER_0403);

  it("the frozen 0.40.3 reader still gives each item the key 0.40.3 recorded for it", async () => {
    // The keys of the ledger above, by the item each belongs to: from the frozen reader, with nothing of today's
    // wording in between.
    const old = legacyKeys(DRAFT, "PMX-52", NOW, { title: TITLE });
    const r = read();
    const keys = (f: { ids: string[] }) => [...new Set(f.ids.flatMap((id) => old.get(id) ?? []))];
    const stored = LEDGER_0403.drafts[`PMX-52 ${PATH}`]!;
    expect(r.decisions.map(keys)).toEqual([...stored.made.slice(0, 5), ...stored.left.slice(0, 2)].map((k) => [k]));
    expect(r.questions.map(keys)).toEqual(["56b2a8679fd1", "ee03662a8097", "ffc32c8a0326", "bdf2a0c7cfca", "8eee1ad2e2aa", "c37661a97e19", "b2ddede32f72"].map((k) => [k]));
    // It is frozen: the file is 0.40.3's reader under a comment that says so. An edit would change the keys it gives,
    // and this hash. If this fails, restore the file rather than the hash.
    const frozen = await readFile(src("review", "legacy", "draft-reader-0403.ts"));
    expect(createHash("sha256").update(frozen).digest("hex")).toBe("8984fff56eb42343eaf108d58098bad0f41e9d185ea45b90c7b91f2ae5342348");
    // And only the legacy key lookup reads it.
    const files = (await readdir(src(), { recursive: true })).filter((f) => f.endsWith(".ts"));
    const users = [];
    for (const f of files) if ((await readFile(src(f), "utf8")).match(/from "[^"]*draft-reader-0403\.js"/)) users.push(f);
    expect(users).toEqual([join("review", "legacy", "follow-up-keys.ts")]);
  });

  it("accepting the draft again on this PMX makes none twice, though the PM has done every to-do since", async () => {
    // Nothing on this Mac but the ledger: the to-dos are done and the tasks approved, so no check by words can help.
    const { accept } = await mac();
    await install0403();
    const again = await accept();
    expect(again).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    expect(followUpText(again)).toBe(AGAIN);
    expect([(await loadTodos()).items, await readProposals()]).toEqual([[], []]);
    // Each one found by its old key now has its fixed ID in the ledger, under every item it was read from, with the
    // old key it was found by. What it became, 0.40.3 never recorded.
    const e = await ledger();
    const r = read();
    const stored = LEDGER_0403.drafts[`PMX-52 ${PATH}`]!;
    expect(e.followUps!.map((m) => [m.id, m.as, m.legacy, m.todo ?? m.proposal ?? null])).toEqual([
      ...r.decisions.slice(0, 5).flatMap((d, i) => d.ids.map((id) => [id, "decision", stored.made[i], null])),
      [r.questions[0]!.id, "ask", "56b2a8679fd1", null], [r.questions[1]!.id, "ask", "ee03662a8097", null],
      [r.questions[2]!.id, "work", "ffc32c8a0326", null], [r.questions[3]!.id, "work", "bdf2a0c7cfca", null], [r.questions[4]!.id, "work", "8eee1ad2e2aa", null],
      [r.questions[6]!.id, "ask", "b2ddede32f72", null],
    ]);
    expect(e.leftIds).toEqual([r.decisions[5]!.id, r.decisions[6]!.id, r.questions[5]!.id]);
    // The old keys stay as 0.40.3 left them, and nothing is added to them.
    expect([e.made, e.left]).toEqual([stored.made, stored.left]);
  });

  it("and after PMX's wording changes: by the IDs it recorded, and by the old keys for a draft it hadn't seen since", async () => {
    const { accept } = await mac();
    await install0403();
    // A Mac that skipped versions: its first accept after 0.40.3 is under wording rules that have changed since. The
    // old keys still come from the frozen reader, so today's wording is no part of finding them.
    sim.reword = true;
    expect(await accept()).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    // From then on the IDs are enough: with the old keys gone from the ledger, still none.
    const file = (await readJson<{ v: number; drafts: Record<string, Entry> }>(followUpsFile()))!;
    file.drafts[`PMX-52 ${PATH}`] = { ...file.drafts[`PMX-52 ${PATH}`]!, made: [], left: undefined };
    await writeFile(followUpsFile(), JSON.stringify(file));
    expect(await accept()).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    expect([(await loadTodos()).items, await readProposals()]).toEqual([[], []]);
  });

  it("an item the old ledger doesn't have is still made, once", async () => {
    const { accept } = await mac();
    await install0403();
    const more = `${DRAFT}- **PM decides:** whether to cap the pilot at 200 seats.\n`;
    const first = await accept(more);
    // Its to-do is made (none of the five 0.40.3 made counts against this accept's five); the rest are as they were.
    expect(first.todos.map((t) => t.text)).toEqual(["Decide whether to cap the pilot at 200 seats (PMX-52)"]);
    expect(first).toMatchObject({ asks: [], proposals: [], repeated: 11, moreQuestions: 1, moreDecisions: 2 });
    expect(await accept(more)).toMatchObject({ todos: [], repeated: 12, duplicates: 0 });
    expect((await loadTodos()).items).toHaveLength(1);
    // That first accept settled the old keys, and the ledger says when.
    expect((await ledger()).bridged).toBe(NOW.toISOString());
  });

  it("keys from an older PMX's wording, which no reader gives back: the first accept makes nothing and records every ID", async () => {
    // The Mac accepted the draft on a PMX before 0.40. Four of its keys come from wording the frozen 0.40.3 reader
    // doesn't give: orphans, the proof that the wording moved since.
    const given = new Set([...legacyKeys(DRAFT, "PMX-52", NOW, { title: TITLE }).values()].flat());
    expect(Object.values(OLDER).some((k) => given.has(k))).toBe(false);
    const { accept } = await mac();
    await install(LEDGER_OLDER);
    // The PM's to-dos from then are on the list under the older words (or done), so no check by words knows them:
    // here the list is empty. Before this rule, the four were made again.
    const first = await accept();
    expect(first).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    // The PM is told as for any draft accepted again.
    expect(followUpText(first)).toBe(AGAIN);
    expect([(await loadTodos()).items, await readProposals()]).toEqual([[], []]);
    const r = read();
    const e = await ledger();
    const how = new Map(e.followUps!.map((m) => [m.id, m.legacy ?? (m.predates ? "predates" : null)]));
    // Found by its old key where the frozen reader gives it; else taken as made then, and marked so.
    expect(r.decisions.slice(0, 5).map((d) => d.ids.map((id) => how.get(id)))).toEqual([["3782ee68f705"], ["500a81b5f40b"], ["predates"], ["e3343aa76e3f"], ["c1394d6a1a7f", "c1394d6a1a7f"]]);
    expect(r.questions.map((q) => how.get(q.id) ?? "left")).toEqual(["56b2a8679fd1", "predates", "ffc32c8a0326", "bdf2a0c7cfca", "8eee1ad2e2aa", "left", "predates"]);
    expect(e.followUps!.filter((m) => m.predates).map((m) => [m.as, m.todo ?? m.proposal ?? null, m.already ?? null])).toEqual([["decision", null, null], ["ask", null, null], ["ask", null, null]]);
    // Left then, left now: the one found by its old key, and the call past that accept's five, whose old key is an orphan.
    expect(e.leftIds).toEqual([r.decisions[5]!.id, r.decisions[6]!.id, r.questions[5]!.id]);
    // Every follow-up of the draft has its ID in the ledger now, and the old keys are as they were.
    expect(new Set([...e.followUps!.map((m) => m.id), ...e.leftIds!])).toEqual(new Set(idsOf(r).flat()));
    expect([e.made, e.left, e.bridged]).toEqual([LEDGER_OLDER.drafts[`PMX-52 ${PATH}`]!.made, LEDGER_OLDER.drafts[`PMX-52 ${PATH}`]!.left, NOW.toISOString()]);
    // A second accept makes nothing, by the IDs alone, under tomorrow's wording too.
    expect(await accept()).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    sim.reword = true;
    expect(await accept()).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 2 });
    expect([(await loadTodos()).items, await readProposals(), (await ledger()).followUps]).toEqual([[], [], e.followUps]);
  });

  it("the one limit: an item added to such a draft before that first accept is taken as handled; one added after it is made", async () => {
    const { accept } = await mac();
    await install(LEDGER_OLDER);
    // With an orphan in the ledger, a new item can't be told from one made under the older words: nothing is made.
    const added = `${DRAFT}- **PM decides:** whether to cap the pilot at 200 seats.\n`;
    const first = await accept(added);
    expect(first).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, duplicates: 0, moreQuestions: 1, moreDecisions: 3 });
    expect((await ledger()).leftIds).toContain(read(added).decisions[7]!.id);
    expect(await accept(added)).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 11, moreDecisions: 3 });
    // The first accept gave every item its ID, so from then on a new item is new, and made once.
    const later = `${added}- **PM decides:** whether to add an audit log export.\n`;
    expect((await accept(later)).todos.map((t) => t.text)).toEqual(["Decide whether to add an audit log export (PMX-52)"]);
    expect(await accept(later)).toMatchObject({ todos: [], repeated: 12, moreDecisions: 3 });
    expect((await loadTodos()).items).toHaveLength(1);
  });

  /** A draft with one call the old ledger has, by a key the frozen reader gives, and one it doesn't have. */
  const TWO = ["# PMX-52: Brief the Northwind pilot terms", "", "## Implications", "",
    "- **Pilot price.** Options: $12 a seat, or $15 with onboarding. **PM decides:** whether to hold the pilot price at $12 a seat. Recommend $12, settled before Dec 8.",
    "- **PM decides:** whether to cap the pilot at 200 seats.", ""].join("\n");

  it("with every old key matched by an item, an item without one is new: made, once", async () => {
    const { accept } = await mac();
    await install({ v: 1, drafts: { [`PMX-52 ${PATH}`]: { at: "2026-11-12T16:00:00.000Z", made: ["3782ee68f705"] } } });
    const first = await accept(TWO);
    expect(first).toMatchObject({ asks: [], proposals: [], repeated: 1, duplicates: 0, moreDecisions: 0 });
    expect(first.todos.map((t) => t.text)).toEqual(["Decide whether to cap the pilot at 200 seats (PMX-52)"]);
    const [price, cap] = read(TWO).decisions;
    expect((await ledger()).followUps!.map(({ id, legacy, todo, predates }) => ({ id, legacy, todo, predates }))).toEqual([
      { id: price!.id, legacy: "3782ee68f705", todo: undefined, predates: undefined },
      { id: cap!.id, legacy: undefined, todo: first.todos[0]!.id, predates: undefined },
    ]);
    expect(await accept(TWO)).toMatchObject({ todos: [], repeated: 2, duplicates: 0 });
    expect((await loadTodos()).items).toHaveLength(1);
  });

  it("an orphan only among the keys left in the draft: the item without a key is still left, not made", async () => {
    const { accept } = await mac();
    await install({ v: 1, drafts: { [`PMX-52 ${PATH}`]: { at: "2026-11-12T16:00:00.000Z", made: ["3782ee68f705"], left: [OLDER.warnAdmins] } } });
    const first = await accept(TWO);
    expect(first).toMatchObject({ todos: [], asks: [], proposals: [], repeated: 1, duplicates: 0, moreDecisions: 1 });
    expect(followUpText(first)).toBe("1 more decision stays in the draft; 1 follow-up was already made from this draft.");
    const e = await ledger();
    expect([e.followUps!.map((m) => m.legacy), e.leftIds]).toEqual([["3782ee68f705"], [read(TWO).decisions[1]!.id]]);
    expect(await accept(TWO)).toMatchObject({ todos: [], repeated: 1, moreDecisions: 1 });
    expect((await loadTodos()).items).toEqual([]);
  });
});

describe("the re-read of older follow-ups records the same IDs (D2-8, FOLLOW-1)", () => {
  /** A follow-up as a PMX before 0.38.0 staged it: its title the question as the draft wrote it, no `checked`. */
  const staged = (title: string, where: "open" | "blocking" = "open"): Omit<Proposal, "id"> => ({
    at: "2026-11-20T10:00:00.000Z", receipt: "synthesize-20261101T100000Z", title,
    description: `${title}\n\n**Follows PMX-52:** an open question its accepted draft left, in the team repo at ${PATH}.\n\npmx:source T1`,
    category: "validation-plan", size: "S", sources: ["T1"], from: [], follows: { identifier: "PMX-52", path: PATH, url: null, where },
  });

  it("a follow-up it turns into a to-do is in the ledger under its item's ID with that to-do, so accepting the draft again makes none twice", async () => {
    const { repo, ctx, accept } = await mac();
    await mkdir(dirname(join(repo, PATH)), { recursive: true });
    await writeFile(join(repo, PATH), DRAFT);
    await stageProposals([
      staged("Who signs the order form at Northwind, and who is the procurement contact?", "blocking"),
      staged("Is the security review scheduled?"),
      staged("whether to offer a 60-day exit clause."),
    ]);
    await updateState((s) => { s.followUpRequeue = { due: true, at: null }; });
    expect(await requeueStep(ctx)).toBe("PMX turned 3 waiting follow-ups into to-dos (2 questions one person can answer and 1 call that is yours).");
    const todos = (await loadTodos()).items;
    expect(todos.map((t) => t.text)).toEqual([
      "Ask Northwind's procurement: Who signs the order form at Northwind, and who is the procurement contact? (PMX-52)",
      "Ask the security lead: Is the security review scheduled? (PMX-52)",
      "Decide whether to offer a 60-day exit clause (PMX-52)",
    ]);
    // The same IDs accepting gives these items, each with the to-do it became.
    const r = read();
    const e = await ledger();
    expect(e.followUps!.map(({ id, as, todo }) => ({ id, as, todo }))).toEqual([
      { id: r.questions[0]!.id, as: "ask", todo: todos[0]!.id },
      { id: r.questions[6]!.id, as: "ask", todo: todos[1]!.id },
      { id: r.decisions[3]!.id, as: "decision", todo: todos[2]!.id },
    ]);
    expect(e.made).toEqual([]);
    // Accepting the draft, under tomorrow's wording: those three aren't made again, and the rest are made as ever
    // (five calls for five to-dos, so one more call than before fits; two questions to ask were made already).
    sim.reword = true;
    const after = await accept();
    expect(after.repeated).toBe(3);
    expect(after.asks.map((a) => a.text)).toEqual(["Ask the customer: In other words: How many seats does the customer expect to fill in the first quarter? (PMX-52)"]);
    expect(after.todos.map((t) => t.text)).not.toContain("Make the call: decide whether to offer a 60-day exit clause (PMX-52)");
    expect(after.todos).toHaveLength(5);
    const open = (await loadTodos()).items.map((t) => t.text);
    expect(open.filter((t) => /exit clause|order form|security review/.test(t))).toEqual(todos.map((t) => t.text));
  });
});
