// TODO-8: to-dos from the email threads the PM wrote in, under the same rules as meetings.
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, type PersonalConfig } from "../src/core/config.js";
import { filterItems } from "../src/core/filter.js";
import { paths } from "../src/core/paths.js";
import { readReceipt } from "../src/core/receipt.js";
import type { SignalItem } from "../src/core/types.js";
import { privacyRules } from "../src/digest/gather.js";
import { formatReceipt } from "../src/explain/format.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { authorsOf, isEmailSource, ownAddresses } from "../src/sources/email.js";
import { moveWork } from "../src/todo/move.js";
import { completeTodo, formatTodos, loadTodos, refreshTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-20T15:00:00Z");
const LATER = new Date("2026-11-23T15:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
const GMAIL = [{ connector: "Gmail", places: ["Customers"] }];
const SUBJECT = "Re: Beta: DPA and SOC 2 bridge letter";
const ME = { names: ["Ana Ito"], emails: ["ana@us.example"] };

const ASK = "Jane Roe: Hi Ana, ¶ Two things before the beta. Who on your side signs the data processing agreement? And could you send the SOC 2 bridge letter by Thursday Dec 3? Without it, security won't clear the beta accounts. ¶ Jane";
const PROMISE = "Ana Ito: Hi Jane, ¶ I'll find out who signs the DPA on our side and tell you by Tuesday, and I'll send the SOC 2 bridge letter by Dec 3. ¶ Ana";
const ATTACHED = "Ana Ito: Hi Jane, ¶ Attached the SOC 2 bridge letter for October to now. Still checking who signs the DPA; I'll have it by Wednesday instead. ¶ Ana";

const BRIDGE = "Send the SOC 2 bridge letter to the customer's security team";
const DPA = "Find out who signs the DPA on our side and tell the customer";

/** An email thread as the collection task saves one from an approved Gmail label (INPUT-1). */
const thread = (name: string, o: { body: string[]; participants?: string; date?: string; subject?: string; source?: string; place?: string; id?: string }) =>
  writeTranscript(paths.threads(), name, [
    "---", "kind: thread", `title: ${o.subject ?? SUBJECT}`, `date: ${o.date ?? "2026-11-19T12:40:00-06:00"}`, `place: ${o.place ?? "Customers"}`,
    `participants: ${o.participants ?? "Jane Roe <jane@acme.example>, ana@us.example"}`, `source: ${o.source ?? "gmail"}`, `source_id: ${o.id ?? "18f2a9c4d0b7e3a5"}`,
    `link: https://mail.google.example/mail/u/0/#all/${o.id ?? "18f2a9c4d0b7e3a5"}`, "owner: Ana Ito ana@us.example", "---", ...o.body,
  ].join("\n"));

const items = (prompt: string) => [...prompt.matchAll(/<item id="([A-Z]\d+)" kind="(\w+)" date="[^"]*" title="([^"]*)"/g)].map((m) => ({ id: m[1]!, kind: m[2]!, title: m[3]! }));
const earlier = (prompt: string) => [...prompt.matchAll(/^- ([EP]\d+): "([^"]*)"(.*)$/gm)].map((m) => ({ key: m[1]!, text: m[2]!, rest: m[3]! }));

/** `repo`: a later run on the same Mac reads the same team repo, whose first commit salts the thread keys (PRIV-7). */
async function setup(reply: (prompt: string, n: number) => object, o: { now?: Date; dir?: string; repo?: string; personal?: Partial<PersonalConfig> } = {}) {
  const repo = o.repo ?? (await pmxRepo({ internalDomains: ["us.example"] })).repo;
  const dir = o.dir ?? (await tmp("my-calls-"));
  let n = 0;
  const runtime = mockRuntime((x) => JSON.stringify(reply(x.prompt, ++n)));
  const ctx = await testCtx({
    repo, runtime, now: o.now ?? NOW, team: { internalDomains: ["us.example"], inputs: GMAIL, tracker: LINEAR as any },
    personal: { handle: "ana", identity: ME, sources: { transcriptDirs: [dir], slackChannel: null }, ...o.personal } as any,
  });
  return { ctx, runtime, dir, repo };
}

describe("to-dos from the email threads you wrote in (TODO-8)", () => {
  beforeEach(freshHome);

  it("a thread where you promised a date gives a to-do due that day, citing the email", async () => {
    await thread("t1.md", { body: [ASK, PROMISE] });
    const { ctx, runtime } = await setup((prompt) => {
      const c = items(prompt).find((i) => i.kind === "thread")!;
      return { commitments: [{ source: c.id, said: "I'll send the SOC 2 bridge letter by Dec 3" }], todos: [
        { text: BRIDGE, due: "2026-12-03", source: c.id, why: "You told the customer you'd send it by Dec 3." },
        { text: DPA, due: "2026-11-24", source: c.id, why: "You said you'd tell them by Tuesday." },
      ] };
    });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 7) });
    expect(r.meetings.read).toBe(1);
    expect(r.emails).toBe(1);
    expect(runtime.calls).toHaveLength(1);
    const prompt = runtime.calls[0]!.prompt;
    // The thread reaches Claude as a thread, with the skill's email rules and the PM's own words in it.
    expect(items(prompt)).toEqual([{ id: "C1", kind: "thread", title: SUBJECT }]);
    expect(prompt).toContain("## Email threads");
    expect(prompt).toContain("**The PM's own messages are where promises come from.**");
    expect(prompt).toContain("I'll send the SOC 2 bridge letter by Dec 3");
    expect(prompt).not.toContain("jane@acme.example");
    expect(r.added.map((t) => [t.text, t.due])).toEqual([[BRIDGE, "2026-12-03"], [DPA, "2026-11-24"]]);

    // The source is recorded: the email connector, the thread's ID there and its date, and the thread's own key.
    const [bridge] = (await loadTodos()).items;
    expect(bridge!.source).toMatchObject({ title: SUBJECT, at: "2026-11-19", email: { connector: "gmail", thread: "18f2a9c4d0b7e3a5" } });
    expect(bridge!.source.keys).toHaveLength(1);
    expect(bridge!.sources).toEqual(["C1"]);
    expect(formatTodos([bridge!])).toContain(`from the email "${SUBJECT}" on 2026-11-19: You told the customer you'd send it by Dec 3.`);

    // `pmx explain` shows the thread it came from, as an email thread you wrote in.
    const receipt = (await readReceipt(r.receiptId!))!;
    expect(receipt.sources).toEqual([expect.objectContaining({ kind: "thread", decision: "used", id: "C1", origin: "gmail", place: "Customers", detail: "an email thread you wrote in (gmail, Customers)" })]);
    const out = formatReceipt(receipt, []);
    expect(out).toContain("✔ used      [C1] https://mail.google.example/mail/u/0/#all/18f2a9c4d0b7e3a5: an email thread you wrote in (gmail, Customers). Processed in this run");
    expect(out).toContain(`☐ ${BRIDGE} (due 2026-12-03)  [C1]`);

    // The same thread, unchanged, is never read twice.
    const again = await refreshTodos(ctx, { since: startOfDay(NOW, 7), skipIfNothingNew: true });
    expect(again.meetings).toMatchObject({ read: 0, alreadyRead: 1 });
    expect(runtime.calls).toHaveLength(1);
  });

  it("a thread you're only copied on, or not on at all, gives nothing, and pmx explain says why", async () => {
    await thread("cc.md", { participants: "Jane Roe <jane@acme.example>, bo@us.example, ana@us.example", id: "cc1", body: [ASK, "Bo Lee: Hi Jane, I'll send the bridge letter by Dec 3."] });
    await thread("theirs.md", { participants: "Jane Roe <jane@acme.example>, bo@us.example", id: "th1", body: [ASK, "Bo Lee: Hi Jane, I'll send it Friday. Ana Ito: noted."] });
    // Older than the period: not read, like a meeting.
    await thread("old.md", { date: "2026-11-01T10:00:00Z", id: "old1", body: [ASK, PROMISE] });
    const { ctx, runtime } = await setup(() => ({ todos: [] }));
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 7) });
    expect(r.meetings).toMatchObject({ read: 0, before: 1 });
    expect(runtime.calls).toHaveLength(0);
    expect(r.added).toEqual([]);
    const receipt = (await readReceipt(r.receiptId!))!;
    const held = receipt.sources.filter((s) => s.rule === "not-attended").map((s) => s.detail);
    expect(held).toEqual([
      "it's an email thread you never wrote in (you're only copied on it), so it never feeds your own to-dos: a promise in an email is yours only in a message you wrote",
      expect.stringMatching(/^you aren't among this email thread's 2 participants, so it never feeds your own to-dos/),
    ]);
    expect(formatReceipt(receipt, [])).toContain("A meeting you weren't in, because it's an email thread you never wrote in (you're only copied on it)");
  });

  it("a promise made in a meeting and again in an email is kept once, citing both", async () => {
    const dir = await tmp("my-calls-");
    await writeTranscript(dir, "acme.md", `---\ntitle: Acme weekly\ndate: 2026-11-18T14:00:00Z\nparticipants: jane@acme.example, ana@us.example\n---\nJane: Security needs a bridge letter for the gap after the SOC 2 report.\n\nAna: I'll send the SOC 2 bridge letter by Dec 3.`);
    await thread("t1.md", { body: [ASK, PROMISE] });
    const { ctx, runtime } = await setup((prompt, n) => {
      const [item] = items(prompt);
      if (n === 1) return { todos: [{ text: BRIDGE, due: "2026-12-03", source: item!.id, why: "You said so in the weekly." }] };
      const e = earlier(prompt).find((x) => x.text === BRIDGE)!;
      return { todos: [{ text: BRIDGE, due: "2026-12-03", source: item!.id, why: "You promised it again by email.", replaces: e.key }] };
    }, { dir });
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 7), batch: 1 });
    expect(r.calls).toBe(2);
    expect(items(runtime.calls[0]!.prompt)).toEqual([{ id: "T1", kind: "transcript", title: "Acme weekly" }]);
    expect(items(runtime.calls[1]!.prompt)).toEqual([{ id: "C1", kind: "thread", title: SUBJECT }]);
    expect(earlier(runtime.calls[1]!.prompt)).toEqual([{ key: "E1", text: BRIDGE, rest: ", due 2026-12-03, from the meeting on 2026-11-18" }]);
    expect(r.added).toHaveLength(1);
    const [t] = r.added;
    expect(t!.source).toMatchObject({ title: SUBJECT, email: { connector: "gmail" } });
    expect(t!.also).toEqual([expect.objectContaining({ title: "Acme weekly", at: "2026-11-18" })]);
    expect(t!.sources).toEqual(["C1", "T1"]);
    expect(formatTodos([t!])).toContain(`from the email "${SUBJECT}" on 2026-11-19, also "Acme weekly" on 2026-11-18: You promised it again by email.`);
    const receipt = (await readReceipt(r.receiptId!))!;
    expect(receipt.todo!.reconciled).toEqual([{ text: BRIDGE, how: "merged", by: "C1" }]);
    expect(formatReceipt(receipt, [])).toContain(`said again in a later email [C1], kept once citing both: ${BRIDGE}`);
  });

  it("a later message in the same thread that shows it done ticks it, and one that changes it changes it", async () => {
    await thread("t1.md", { body: [ASK, PROMISE] });
    const first = await setup((prompt) => {
      const c = items(prompt)[0]!;
      return { todos: [
        { text: BRIDGE, due: "2026-12-03", source: c.id, why: "You told the customer you'd send it by Dec 3." },
        { text: DPA, due: "2026-11-24", source: c.id, why: "You said you'd tell them by Tuesday." },
      ] };
    });
    await refreshTodos(first.ctx, { since: startOfDay(NOW, 7) });
    const [bridge, dpa] = (await loadTodos()).items;

    // The collection task saves the thread again with your new reply.
    await thread("t1.md", { body: [ASK, PROMISE, ATTACHED] });
    const second = await setup((prompt) => {
      const c = items(prompt)[0]!;
      const e = earlier(prompt);
      return {
        done: [{ id: e.find((x) => x.text === BRIDGE)!.key, source: c.id, why: "You attached the bridge letter in the thread." }],
        todos: [{ text: DPA, due: "2026-11-25", source: c.id, why: "You moved it to Wednesday.", replaces: e.find((x) => x.text === DPA)!.key }],
      };
    }, { now: LATER, repo: first.repo, dir: first.dir });
    const r = await refreshTodos(second.ctx, { since: startOfDay(LATER, 7) });
    expect(r.calls).toBe(1);
    const prompt = second.runtime.calls[0]!.prompt;
    // The call is told the to-dos this thread gave before, and that its earlier messages still hold them.
    expect(earlier(prompt)).toEqual([
      { key: "P1", text: BRIDGE, rest: ", due 2026-12-03, from the email on 2026-11-19, read before in thread C1 below" },
      { key: "P2", text: DPA, rest: ", due 2026-11-24, from the email on 2026-11-19, read before in thread C1 below" },
    ]);
    expect(prompt).toContain("P1, P2 came from an email thread below when PMX read it before; the thread has new messages since.");
    expect(prompt).toContain('Mark one done only when a later message in the thread shows it happened ("Attached the bridge letter"');
    expect(prompt).toContain("Attached the SOC 2 bridge letter for October to now.");

    // Nothing new is added; the bridge letter is ticked with why, and the DPA to-do keeps its ID with the new date.
    expect(r.added).toEqual([]);
    expect(r.settled).toEqual([
      { id: bridge!.id, text: BRIDGE, how: "done", why: "You attached the bridge letter in the thread." },
      { id: dpa!.id, text: DPA, how: "changed" },
    ]);
    const store = (await loadTodos()).items;
    expect(store).toHaveLength(2);
    const ticked = store.find((t) => t.id === bridge!.id)!;
    expect(ticked).toMatchObject({ status: "done", doneAt: LATER.toISOString(), settled: { how: "done", by: { title: SUBJECT, at: "2026-11-19", email: true }, why: "You attached the bridge letter in the thread.", receiptId: r.receiptId } });
    expect(formatTodos([ticked])).toContain(`ticked by PMX: done in the email "${SUBJECT}" on 2026-11-19. You attached the bridge letter in the thread.`);
    expect(store.find((t) => t.id === dpa!.id)).toMatchObject({ status: "open", text: DPA, due: "2026-11-25", why: "You moved it to Wednesday.", receiptId: dpa!.receiptId });
    const receipt = (await readReceipt(r.receiptId!))!;
    expect(receipt.todo!.reconciled).toEqual([
      { text: BRIDGE, how: "done", by: "C1", why: "You attached the bridge letter in the thread.", stored: bridge!.id },
      { text: DPA, how: "merged", by: "C1", stored: dpa!.id },
    ]);
    expect(formatReceipt(receipt, [])).toContain(`done in the email "${SUBJECT}" on 2026-11-19 [C1], so PMX ticked your to-do ${bridge!.id}: ${BRIDGE}. You attached the bridge letter in the thread.`);

    // The thread as it is now was read: the next run makes no call.
    const again = await refreshTodos(second.ctx, { since: startOfDay(LATER, 7), skipIfNothingNew: true });
    expect(again.meetings).toMatchObject({ read: 0, alreadyRead: 1 });
    expect(second.runtime.calls).toHaveLength(1);
  });

  it("a re-read thread that gives its promise again keeps it once, in place, never as a duplicate", async () => {
    await thread("t1.md", { body: [ASK, PROMISE] });
    const first = await setup((prompt) => ({ todos: [{ text: BRIDGE, due: "2026-12-03", source: items(prompt)[0]!.id, why: "You said so." }] }));
    await refreshTodos(first.ctx, { since: startOfDay(NOW, 7) });
    await thread("t1.md", { body: [ASK, PROMISE, "Jane Roe: Thanks Ana, looking forward to it."] });
    const id = (await loadTodos()).items[0]!.id;
    // The call gives the same promise again, as it was or in other words, without "replaces": PMX keeps it once.
    const AGAIN = "Send the customer's security team the SOC 2 bridge letter";
    const second = await setup((prompt, n) => ({ todos: [{ text: n === 1 ? BRIDGE : AGAIN, due: "2026-12-03", source: items(prompt)[0]!.id, why: "You said so." }] }), { now: LATER, repo: first.repo, dir: first.dir });
    const r = await refreshTodos(second.ctx, { since: startOfDay(LATER, 7) });
    expect(r.added).toEqual([]);
    expect(r.settled).toEqual([]);
    expect((await loadTodos()).items.map((t) => [t.id, t.text, t.status])).toEqual([[id, BRIDGE, "open"]]);
    await thread("t1.md", { body: [ASK, PROMISE, "Jane Roe: Thanks Ana, looking forward to it.", "Jane Roe: One more thing: is the letter signed?"] });
    const third = await refreshTodos(second.ctx, { since: startOfDay(LATER, 7) });
    expect(third.added).toEqual([]);
    expect(third.settled).toEqual([{ id, text: AGAIN, how: "changed" }]);
    expect((await loadTodos()).items.map((t) => [t.id, t.text, t.status])).toEqual([[id, AGAIN, "open"]]);
  });

  it("a to-do you ticked, or moved to the team, never comes back when its thread gets a new reply", async () => {
    await thread("t1.md", { body: [ASK, PROMISE] });
    const first = await setup((prompt) => {
      const c = items(prompt)[0]!.id;
      return { todos: [{ text: BRIDGE, due: "2026-12-03", source: c, why: "You said so." }, { text: DPA, due: "2026-11-24", source: c, why: "You said so." }] };
    });
    await refreshTodos(first.ctx, { since: startOfDay(NOW, 7) });
    const [bridge, dpa] = (await loadTodos()).items;
    await completeTodo(dpa!.id, NOW);
    const tr = memoryTracker([]);
    await moveWork(first.ctx, async () => ({ tracker: tr }) as any, bridge!.id, "product", { kind: "spec" });
    expect((await loadTodos()).items.map((t) => t.id)).toEqual([dpa!.id]);

    await thread("t1.md", { body: [ASK, PROMISE, "Jane Roe: Thanks Ana! One more: can you also share the pen test summary?", "Ana Ito: Sure, I'll share the pen test summary next week."] });
    // Claude, told both, gives them again anyway, in other words, next to the new promise: only the new one is added.
    const second = await setup((prompt) => {
      const c = items(prompt)[0]!.id;
      return { todos: [
        { text: "Send the customer's security team the SOC 2 bridge letter", due: "2026-12-03", source: c, why: "Again." },
        { text: DPA, due: "2026-11-24", source: c, why: "Again." },
        { text: "Share the pen test summary with the customer", due: null, source: c, why: "You said you'd share it next week." },
      ] };
    }, { now: LATER, repo: first.repo, dir: first.dir });
    const r = await refreshTodos(second.ctx, { since: startOfDay(LATER, 7) });
    expect(earlier(second.runtime.calls[0]!.prompt).map((e) => [e.key, e.text, e.rest.replace(/^.*thread C1 below/, "")])).toEqual([
      ["P1", DPA, ", which the PM has ticked"], ["P2", BRIDGE, ", which the PM moved off their list"],
    ]);
    expect(second.runtime.calls[0]!.prompt).toContain("Never give one again as a new to-do: it is the PM's already, even one they ticked or moved off their list.");
    expect(r.added.map((t) => t.text)).toEqual(["Share the pen test summary with the customer"]);
    expect(r.settled).toEqual([]);
    expect((await loadTodos()).items.map((t) => [t.text, t.status])).toEqual([[DPA, "done"], ["Share the pen test summary with the customer", "open"]]);
  });

  it("moving an email's to-do to the team carries the thread as its source", async () => {
    await thread("t1.md", { body: [ASK, PROMISE] });
    const { ctx } = await setup((prompt) => ({ todos: [{ text: BRIDGE, due: "2026-12-03", source: items(prompt)[0]!.id, why: "You said so." }] }));
    await refreshTodos(ctx, { since: startOfDay(NOW, 7) });
    const todo = (await loadTodos()).items[0]!;
    const tr = memoryTracker([]);
    const r = await moveWork(ctx, async () => ({ tracker: tr }) as any, todo.id, "product", { kind: "spec" });
    expect(r.identifier).toBe("PMX-1");
    const made = tr.tasks.get("task-1")!;
    expect(made.sources).toEqual(["C1"]);
    expect(made.description).toContain(`**Sources:** a thread in an approved channel (Nov 19). They stay on the PM's Mac: \`pmx explain ${todo.receiptId}\` there shows them.`);
    expect(made.description).toContain("pmx:source C1");
    expect(made.description).not.toMatch(/Jane|acme|DPA/);
  });

  it("only the PM's own email threads: never Slack threads, and the do-not-read list and private topics still apply", async () => {
    await thread("slack.md", { source: "slack", place: "#feedback", id: "s1", subject: "#feedback", body: ["Jane Roe: Can you send the export?", "Ana Ito: I'll send it Friday."] });
    await thread("dnr.md", { id: "d1", participants: "Pat Doe <pat@acme.example>, ana@us.example", body: ["Pat Doe: Can you send the letter?", "Ana Ito: I'll send it Friday."] });
    await thread("t1.md", { body: [ASK, `${PROMISE} ¶ PS: I'm on sick leave after the surgery next week.`] });
    const { ctx, runtime } = await setup(() => ({ todos: [] }), { personal: { neverIngest: { people: ["pat@acme.example"], channels: [], meetingTitles: [] } } });
    ctx.team.inputs = [...GMAIL, { connector: "Slack", places: ["#feedback"] }];
    const r = await refreshTodos(ctx, { since: startOfDay(NOW, 7) });
    expect(r.meetings.read).toBe(1);
    const prompt = runtime.calls[0]!.prompt;
    expect(items(prompt).map((i) => i.title)).toEqual([SUBJECT]);
    // The health passage is cut even here, as in a 1:1; the rest of the PM's message is read.
    expect(prompt).not.toContain("sick leave");
    expect(prompt).toContain("[HELD]");
    const receipt = (await readReceipt(r.receiptId!))!;
    // A Slack thread never reaches the to-do run at all; the do-not-read person holds theirs.
    expect(receipt.sources.map((s) => [s.origin, s.decision, s.rule ?? null])).toEqual([["gmail", "left-out", "never-ingest"], ["gmail", "used", null]]);
  });
});

describe("who wrote in an email thread (TODO-8)", () => {
  const me = { names: ["Ana Ito"], emails: ["ana@us.example"] };
  const team = { ...DEFAULT_TEAM, internalDomains: ["us.example", "us.io"], inputs: GMAIL } as any;
  const personal = { handle: "ana", neverIngest: { people: [], channels: [], meetingTitles: [] }, sources: { transcriptDirs: [], slackChannel: null }, identity: me } as unknown as PersonalConfig;
  const t = (participants: string[], text: string, extra: Partial<SignalItem> = {}): SignalItem => ({
    id: "C1", kind: "thread", ref: "https://mail.google.example/1", title: SUBJECT, at: "2026-11-19", participants, text, origin: { source: "gmail", sourceId: "1" }, place: "Customers", ...extra,
  });
  const decide = (x: SignalItem, p = personal) => filterItems([x], privacyRules({ team, personal: p }, true)).decisions[0]!;

  it("reads each message's author, a From line too, never a quote or a reply's header", () => {
    expect(authorsOf(["Jane Roe: Hi Ana, could you send it by 10:30?", "> Ana Ito: I'll send it", "On Nov 19, Ana Ito wrote:", "To: ana@us.example", "From: Bo Lee <bo@us.example>", "Bo Lee: sure"].join("\n")))
      .toEqual(["Jane Roe", "Bo Lee <bo@us.example>", "Bo Lee"]);
    expect(["gmail", "google-mail", "microsoft-outlook", "outlook", "fastmail", "front", "superhuman"].every(isEmailSource)).toBe(true);
    expect(["slack", "microsoft-teams", "intercom", "zendesk", "granola", ""].some(isEmailSource)).toBe(false);
    // The PM's mailbox at each of the company's domains; a personal address stays as it is.
    expect(ownAddresses(["Ana@us.example", "ana.ito@gmail.com"], ["us.example", "us.io"])).toEqual(["ana@us.example", "ana.ito@gmail.com", "ana@us.io"]);
  });

  it("keeps a thread the PM is on and wrote in, by email, name or the company's other domain", () => {
    expect(decide(t(["jane@acme.example", "ana@us.example"], "Jane: Hi\nAna Ito: I'll send it.")).decision).toBe("kept");
    expect(decide(t(["jane@acme.example", "ana@us.io"], "Jane: Hi\nana@us.example: I'll send it.")).decision).toBe("kept");
    expect(decide(t(["jane@acme.example", "Ana Ito"], "Jane: Hi\nFrom: Ana Ito <ana@us.io>\nI'll send it.")).decision).toBe("kept");
    // Copied, or not on it: held. Team runs never check.
    expect(decide(t(["jane@acme.example", "ana@us.example"], "Jane: Hi\n> Ana Ito: I'll send it.\nOn Nov 19, Ana Ito wrote:"))).toMatchObject({ decision: "held", rule: "not-attended" });
    expect(decide(t(["jane@acme.example", "bo@us.example"], "Jane: Hi\nAna Ito: I'll send it."))).toMatchObject({ decision: "held", rule: "not-attended" });
    expect(filterItems([t(["jane@acme.example", "bo@us.example"], "Jane: Hi")], privacyRules({ team, personal })).kept).toHaveLength(1);
    // Until PMX knows who the PM is, no thread is read: Claude couldn't tell whose messages are theirs. The file's owner
    // line then adds an address the PM writes from.
    const nobody = { ...personal, identity: null } as unknown as PersonalConfig;
    for (const extra of [{}, { owner: "Ana Ito ana@us.example" }])
      expect(decide(t(["jane@acme.example", "ana@us.example"], "Ana Ito: I'll send it.", extra), nobody)).toMatchObject({ decision: "held", detail: expect.stringMatching(/^PMX doesn't know your name or email yet/) });
    expect(decide(t(["jane@acme.example", "ana.ito@gmail.com"], "ana.ito@gmail.com: I'll send it.", { owner: "Ana Ito ana.ito@gmail.com" })).decision).toBe("kept");
    // A place the team no longer approves is held for that first, as before.
    expect(decide(t(["ana@us.example"], "Ana Ito: hi", { place: "Sales" }))).toMatchObject({ rule: "place-not-approved" });
  });
});
