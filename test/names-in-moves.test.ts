// D2 (PRIV-6, TODO-5, RUN-5), from a full end-to-end test on 0.38.0: "Ask Dana which Globex clients are billed through
// them…" was queued for Linear by `pmx move … product`. Every source started a sentence with Dana ("Dana on our side
// has…", "Dana knows which is which"), so the name finder never learned her, and the cue in the to-do's own words
// ("Ask Dana") wasn't read. A to-do taken back from a task without sources lost its run's receipt, a follow-up's kept
// copy of its original's quotes was read for people though its names were already swapped, and "Happy Thanksgiving"
// became a placeholder in a pack.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commands } from "../src/commands/index.js";
import { buildKnown, peopleSwap } from "../src/core/people-swap.js";
import { readReceipt } from "../src/core/receipt.js";
import { registerServices } from "../src/core/services.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { namesIn, peopleIn, trackerGuard } from "../src/core/tracker-text.js";
import { startOfDay } from "../src/meetings/ledger.js";
import { NAME_SWAP } from "../src/run/packs.js";
import { keptQuotes } from "../src/run/share.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { CHECKED, type Proposal } from "../src/synth/proposals.js";
import { recheckProposal } from "../src/synth/recheck.js";
import { moveWork } from "../src/todo/move.js";
import { addTodo, COMMITMENT, editTodo, linkTodo, loadTodos, placeTodo, refreshTodos } from "../src/todo/todo.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const NOW = new Date("2026-11-20T10:00:00Z");
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
/** The answer when a move isn't sent: it names the command that rewords the to-do (R6). */
const refused = (id: string) => `PMX didn't send it: its words name a person, which Linear never gets. Reword it with \`pmx todo edit ${id} "<new words>"\`, which keeps its meetings and due date, and move it again.`;
const idOf = (prompt: string, title: string) => prompt.match(new RegExp(`id="([A-Z]\\d+)"[^>]*title="${title}"`))![1]!;

/** A customer call where the customer's billing contact is only ever the first word of a sentence. */
const CALL = [
  "Robin Hale: Dana on our side has the billing export, so it's quick.",
  "",
  "Lee Park: Which clients are billed through partners?",
  "",
  "Robin Hale: Dana knows which is which. Some Globex clients are billed through two partners.",
  "",
  "Lee Park: Great, I'll write it up.",
].join("\n");
/** An internal meeting: the team's rules keep it from agents, so a to-do from it carries no sources. */
const INTERNAL = "Lee Park: Can you draft the Initech billing FAQ?\n\nAvery Lin: Sure, after the beta.";

async function setup(todos: { text: string; from: string }[], o: { extra?: [string, string][]; crm?: string[] } = {}) {
  const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
  const dir = await tmp("calls-");
  for (const [name, body] of o.extra ?? []) await writeTranscript(dir, name, body);
  const crm = o.crm ? join(await tmp("crm-"), "names.txt") : null;
  if (crm) await writeFile(crm, o.crm!.join("\n"));
  await writeTranscript(dir, "globex.md", `---\ntitle: Globex billing\ndate: 2026-11-19T14:00:00Z\nparticipants: Robin Hale <robin@globex.example>, Lee Park <lee@us.example>\n---\n${CALL}`);
  await writeTranscript(dir, "internal.md", `---\ntitle: Lee and Avery\ndate: 2026-11-19T16:00:00Z\nparticipants: Lee Park <lee@us.example>, Avery Lin <avery.lin@us.example>\n---\n${INTERNAL}`);
  const runtime = mockRuntime((o) => JSON.stringify({ todos: todos.map((t) => ({ text: t.text, source: idOf(o.prompt, t.from), why: "You said you would." })) }));
  const ctx = await testCtx({
    repo, runtime, now: NOW, team: { internalDomains: ["us.example"], tracker: LINEAR as any },
    personal: { handle: "lee", todosToLinear: false, identity: { names: ["Lee"], emails: ["lee@us.example"] }, sources: { transcriptDirs: [dir], slackChannel: null }, crmNamesFile: crm } as any,
  });
  const tr = memoryTracker([]);
  const move = (ref: string, to: any, opt: { kind?: string } = {}) => moveWork(ctx, async () => ({ tracker: tr }) as any, ref, to, opt);
  await refreshTodos(ctx, { since: startOfDay(NOW, 2) });
  const todo = async (start: string) => (await loadTodos()).items.find((t) => t.text.startsWith(start))!;
  return { ctx, tr, move, todo };
}

describe("a name the sources only ever start a sentence with (D2-1, PRIV-6)", () => {
  it("is read as a person when the sources say what someone does: knows, thinks, is on our side, is from a company", () => {
    const found = peopleIn([{ participants: ["Robin Hale <robin@globex.example>", "Lee Park <lee@us.example>"], text: CALL }], ["globex", "us"]);
    expect(found).toContain("Dana");
    expect(namesIn([{ text: "Sam from Globex joined late. Avery at Initech thinks it slips." }], ["globex"]).map((n) => n.name))
      .toEqual(expect.arrayContaining(["Sam", "Avery"]));
    expect(peopleIn([{ text: "Lee Park: Noor on my team owns the export." }])).toContain("Noor");
  });

  it("never reads a company, a product, a group or an ordinary word that way", () => {
    // A company by its domain, after an article, or as a company's noun; and words for someone or a group.
    expect(peopleIn([{ text: "Globex knows its renewal date. Globex thinks the price is high." }], ["globex"])).toEqual([]);
    expect(peopleIn([{ text: "The Initech rollout slipped. Initech thinks it can wait." }])).toEqual([]);
    expect(peopleIn([{ text: "Someone knows which is which. Leadership thinks we should wait. Everybody knows it." }])).toEqual([]);
    expect(peopleIn([{ text: "Pricing from Globex came in. Feedback from Initech too." }], ["globex", "initech"])).toEqual([]);
    // A company wants, needs, asks and says as often as a person does: those verbs never count.
    expect(peopleIn([{ text: "Globex wants SSO. Initech asked for the audit log. Globex said yes." }])).toEqual([]);
  });
});

describe("the words going to Linear are read for a name themselves (D2-1, F14)", () => {
  it("a capitalized word after a cue only a person gets is a name, whatever the sources say", () => {
    const guard = trackerGuard({});
    expect(guard.problem("Ask Dana which Globex clients are billed through them.")).toBe("name");
    expect(guard.problem("Thanks, Lee.")).toBe("name");
    expect(guard.problem("Per Robin, the beta slips to Jan 15.")).toBe("name");
    expect(guard.problem("Please cc Avery on the reply.")).toBe("name");
    expect(guard.problem("@dana can you check the export?")).toBe("name");
    // A team, a product, a role, a company's noun or a numbered clause after a cue is no one.
    for (const ok of ["Ask Legal for the DPA.", "Ask the Globex team for the list.", "Ask Globex Legal for the DPA.", "Per Article 28 of the DPA, data stays in the EU.", "Ask Product to rank the asks."]) {
      expect(guard.problem(ok), ok).toBeNull();
    }
  });

  it("a company or product the sources show may follow a cue: \"Ask Globex for the list\" goes", () => {
    const guard = trackerGuard({ things: ["globex", "Initech Labs"] });
    expect(guard.problem("Ask Globex for the list of billed clients.")).toBeNull();
    expect(guard.problem("Per Initech's security review, SSO comes first.")).toBeNull();
    expect(guard.problem("Ask Dana for the list of billed clients.")).toBe("name");
  });

  it("with the sources read, someone to reach \"with\" is a name too; a tool or a known company isn't", () => {
    const known = trackerGuard({ things: ["globex"] });
    expect(known.problem("Confirm the client list with Dana.")).toBe("name");
    expect(known.problem("Follow up with Lee on the beta.")).toBe("name");
    expect(known.problem("Follow up with Globex on SSO.")).toBeNull();
    expect(known.problem("Sync the export with Linear.")).toBeNull();
    // Without the sources, a company and a person after "with" look the same: only the strong cues count.
    expect(trackerGuard({}).problem("Follow up with Acme on SSO.")).toBeNull();
  });
});

describe("a to-do moved to the team (D2-1, D2, TODO-5)", () => {
  beforeEach(freshHome);

  it("\"Ask Dana which Globex clients…\" is refused though the sources only start sentences with Dana; \"Ask Globex for the list\" moves", async () => {
    const { tr, move, todo } = await setup([
      { text: "Ask Dana which Globex clients are billed through them", from: "Globex billing" },
      { text: "Write up the billing split Dana knows", from: "Globex billing" },
      { text: "Ask Globex for the list of billed clients", from: "Globex billing" },
    ]);
    const askDana = await todo("Ask Dana");
    await expect(move(askDana.id, "product", { kind: "spec" })).rejects.toThrow(refused(askDana.id));
    // No cue here: only the sources show Dana is someone ("Dana knows which is which").
    const writeUp = await todo("Write up");
    await expect(move(writeUp.id, "product", { kind: "spec" })).rejects.toThrow(refused(writeUp.id));
    expect(tr.tasks.size).toBe(0);
    expect(await move((await todo("Ask Globex")).id, "product", { kind: "spec" })).toMatchObject({ to: "product", identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ title: "Ask Globex for the list of billed clients" });
    expect(tr.tasks.get("task-1")!.description).not.toMatch(/Dana|Robin|Hale/);
    // A to-do typed with no meeting behind it is still read for the cue.
    const typed = await addTodo({ text: "Ask Dana about the partner billing" }, NOW);
    await expect(move(typed.id, "product", { kind: "spec" })).rejects.toThrow(refused(typed.id));
  });

  it("keeps its receipt through product → private → product with no sources, so the move back checks the meeting's names", async () => {
    const { tr, move, todo } = await setup([{ text: "Draft the Initech billing FAQ", from: "Lee and Avery" }]);
    const first = await todo("Draft the Initech");
    expect(first.receiptId).toMatch(/^todo-/);
    await move(first.id, "product", { kind: "spec" });
    const made = tr.tasks.get("task-1")!;
    expect(made.sources).toEqual([]);
    // The task names its run's receipt, and nothing of the meeting.
    expect(made.description).toContain(`**Sources:** none agents can quote. Where it came from stays on the PM's Mac: \`pmx explain ${first.receiptId}\` there shows it.`);
    expect(made.description).not.toMatch(/Avery|\bLin\b|FAQ|pmx:source/);
    expect((await readReceipt(first.receiptId))!.todo!.moved).toEqual([{ identifier: "PMX-1", sources: [], at: NOW.toISOString() }]);

    // A teammate retitles it in Linear with the name of someone from that meeting; the PM takes it back.
    made.title = "Draft the Initech billing FAQ for Avery Lin";
    await move("PMX-1", "private");
    const back = await todo("Draft the Initech");
    expect(back).toMatchObject({ receiptId: first.receiptId, linear: null });
    expect(back).not.toHaveProperty("sources");
    // Moving it to the team again reads the meeting's people through that receipt: Avery Lin never goes.
    await expect(move(back.id, "product", { kind: "spec" })).rejects.toThrow(refused(back.id));
  });
});

describe("a follow-up's kept copy of its original's quotes (RUN-5, R5)", () => {
  beforeEach(freshHome);
  // Swapped passages: what still reads like a name there is a product ("Copper Lantern"), never a person.
  const quotes = [{ id: "T1", kind: "meeting" as const, at: "2026-11-05", passages: ["[PERSON-1, Globex]: Copper Lantern ships Friday, and the import is the ask."] }];
  const followUp = (o: Partial<Proposal> = {}): Proposal => ({
    id: "pabc123", at: "2026-11-05T10:00:00Z", receipt: "", title: "Spec the import the Friday release needs", category: "spec", size: "S", sources: ["T1"], from: [], checked: CHECKED,
    description: "Spec the Copper Lantern import for Globex before Friday. The release needs it.\n\n**Follows PMX-14:** an open question its accepted draft left, in the team repo at outputs/PMX-14.md.\n\npmx:source T1",
    follows: { identifier: "PMX-14", path: "outputs/PMX-14.md", where: "open" }, quotes, ...o,
  });

  it("records the swap its passages went through, when it's read from the team's pack", () => {
    expect(keptQuotes({ sources: quotes, from: "team", swapped: true })).toEqual({ quotes, quotesSwap: NAME_SWAP });
    expect(keptQuotes({ sources: quotes, from: "here", swapped: true })).toEqual({});
  });

  it("isn't read for people once swapped, so a good sentence isn't cut for a false person", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.example"] });
    const ctx = await testCtx({ repo, team: { internalDomains: ["us.example"] } });
    const swapped = await recheckProposal(ctx, followUp({ quotesSwap: NAME_SWAP }));
    expect(swapped).toMatchObject({ held: null, leftOut: null, unread: null });
    expect(swapped.description).toBe(followUp().description);
    // A copy kept before PMX recorded its swap is read as it was: "Copper Lantern" reads as someone's full name there.
    expect((await recheckProposal(ctx, followUp())).leftOut).toBe("1 sentence that named a person");
  });
});

describe("a greeting or a holiday is never a name (D2-9, R5)", () => {
  const text = [
    "Lee Park: Happy Thanksgiving to the three of us. Merry Christmas and Happy New Year too.",
    "Robin Hale: Happy Holidays! Labor Day and Memorial Day are off, and Lunar New Year too. Eid Mubarak to the Initech folks.",
    "Lee Park: Happy to help with the Globex export.",
  ].join("\n");

  it("isn't found as a name in the sources, nor known as one", () => {
    expect(peopleIn([{ text }]).sort()).toEqual(["Hale", "Lee", "Lee Park", "Park", "Robin", "Robin Hale"]);
    const known = buildKnown({ items: [{ text }] });
    for (const w of ["happy", "thanksgiving", "merry", "christmas", "holidays", "labor", "memorial", "lunar", "eid", "mubarak"]) expect(known.strong, w).not.toContain(w);
  });

  it("isn't swapped for a placeholder in a pack", () => {
    const out = peopleSwap({ items: [{ text }], known: buildKnown({ items: [{ text }] }) }).swap(text);
    expect(out).toContain("Happy Thanksgiving to the three of us. Merry Christmas and Happy New Year too.");
    expect(out).toContain("Happy Holidays! Labor Day and Memorial Day are off, and Lunar New Year too. Eid Mubarak to the Initech folks.");
    expect(out).toContain("Happy to help with the Globex export.");
    expect(out.match(/\[PERSON-\d+\]/g)).toEqual(["[PERSON-1]", "[PERSON-2]", "[PERSON-1]"]);
  });
});

// R6, rig test of #122: "Ask Initech Partners for the list…" was refused, since the guard knew the company only as its
// email domain's name ("initechpartners"); a to-do refused had no way to be reworded; a round trip lost its due date;
// and "Feliz Navidad" read as a name.
describe("a company of more than one word, and companies this Mac knows (R6, D2-1)", () => {
  beforeEach(freshHome);
  const INITECH = `---\ntitle: Initech Partners billing\ndate: 2026-11-19T15:00:00Z\nparticipants: Sam Ortiz <sam@initechpartners.example>, Lee Park <lee@us.example>\n---\nSam Ortiz: We bill most clients ourselves.\n\nLee Park: Can you send the list?`;
  /** An older call, outside the to-do run's days: only this Mac's collected sources have it. */
  const HART = `---\ntitle: Renewal call\ndate: 2026-11-10T15:00:00Z\nparticipants: Noor Shah <noor@hartstone.example>, Lee Park <lee@us.example>\n---\nNoor Shah: Our order form is with legal.`;

  it("may follow a cue as its email domain or the sources write it; a word alone or a domain made of a name never does", () => {
    const byDomain = trackerGuard({ things: ["initechpartners", "hartstone"] });
    for (const ok of ["Ask Initech Partners for the list of billed clients.", "Ask Hart & Stone for the signed order form.", "Thanks, Hart and Stone, for the renewal date.", "Ask Initech for the list."]) {
      expect(byDomain.problem(ok), ok).toBeNull();
    }
    expect(trackerGuard({ things: ["Hart & Stone", "Initech Partners"] }).problem("Ask Hart & Stone for the signed order form.")).toBeNull();
    // "Hart" of "Hart & Stone" may be someone; so may Dana of danaruiz.example; and a name before a company isn't it.
    expect(trackerGuard({ things: ["Hart & Stone"] }).problem("Ask Hart for the signed order form.")).toBe("name");
    expect(trackerGuard({ things: ["danaruiz"] }).problem("Ask Dana for the list.")).toBe("name");
    expect(byDomain.problem("Ask Dana Hart for the list.")).toBe("name");
    // Companies known from elsewhere never make "with" a cue: only the task's own sources can tell.
    expect(trackerGuard({ known: ["hartstone"] }).problem("Follow up with Lee on the renewal.")).toBeNull();
  });

  it("\"Ask Initech Partners for the list…\" moves when its meeting's domain is initechpartners", async () => {
    const { tr, move, todo } = await setup([{ text: "Ask Initech Partners for the list of billed clients", from: "Initech Partners billing" }], { extra: [["initech.md", INITECH]] });
    expect(await move((await todo("Ask Initech")).id, "product", { kind: "spec" })).toMatchObject({ to: "product", identifier: "PMX-1" });
    expect(tr.tasks.get("task-1")).toMatchObject({ title: "Ask Initech Partners for the list of billed clients" });
  });

  it("a to-do typed with no meeting behind it knows the companies this Mac's sources and CRM list show, and no one else", async () => {
    const { tr, move } = await setup([], { extra: [["hart.md", HART]], crm: ["Dana Ruiz", "Initrode GmbH"] });
    for (const text of ["Ask Hart & Stone for the signed order form", "Ask Initrode for the renewal date"]) {
      const t = await addTodo({ text }, NOW);
      expect(await move(t.id, "product", { kind: "spec" }), text).toMatchObject({ to: "product" });
    }
    expect([...tr.tasks.values()].map((t) => t.title)).toEqual(["Ask Hart & Stone for the signed order form", "Ask Initrode for the renewal date"]);
    // Someone this Mac met is still someone: Noor is in that call, and nothing says she's a company.
    for (const text of ["Thanks Noor for the order form", "Ask Dana about the partner billing"]) {
      const t = await addTodo({ text }, NOW);
      await expect(move(t.id, "product", { kind: "spec" }), text).rejects.toThrow(refused(t.id));
    }
    expect(tr.tasks.size).toBe(2);
  });
});

describe("rewording a to-do PMX didn't send, and its due date (R6, TODO-5)", () => {
  beforeEach(freshHome);

  it("`pmx todo edit` gives it new words and keeps its meetings and due date, so it then moves with them", async () => {
    const { ctx, tr, move, todo } = await setup([{ text: "Ask Dana which Globex clients are billed through them", from: "Globex billing" }]);
    const t = await todo("Ask Dana");
    await placeTodo(t.id, { due: "2026-11-30" });
    await expect(move(t.id, "product", { kind: "spec" })).rejects.toThrow(refused(t.id));
    const run = (positionals: string[]) => commands.find((c) => c.name === "todo")!.run({ positionals, values: {}, ctx: async () => ctx, ask: null as any } as any);
    expect(await run(["edit", t.id, "Ask the billing lead which Globex clients are billed through partners"])).toBe(0);
    const edited = await todo("Ask the billing lead");
    expect(edited).toMatchObject({ id: t.id, receiptId: t.receiptId, sources: t.sources, due: "2026-11-30" });
    expect((await move(t.id, "product", { kind: "spec" })).message).toContain("with the meeting it came from as its sources");
    expect(tr.tasks.get("task-1")).toMatchObject({ title: "Ask the billing lead which Globex clients are billed through partners", sources: t.sources });
    expect(tr.tasks.get("task-1")!.description).toMatch(/^A task lee moved here from their own to-dos, due 2026-11-30\./);
    await expect(editTodo(t.id, "x")).rejects.toThrow(/No to-do/);
  });

  it("a to-do in Linear as the PM's own comes back first, and the answer says so", async () => {
    const { ctx, tr, move } = await setup([]);
    ctx.personal.todosToLinear = true;
    // A commitment an older PMX sent, before its words were checked (R7).
    const t = await addTodo({ text: "Ask Dana about the partner billing" }, NOW);
    const made = await tr.createInbox({ title: t.text, description: "A commitment lee made, sent to Linear by them to track it here.\n\nPMX sent only these words: no meeting title, transcript, attendees or quotes. Agents don't pick up commitments.", category: COMMITMENT, size: "S", sources: [] });
    await linkTodo(t.id, made.identifier);
    await expect(move(t.id, "product", { kind: "spec" })).rejects.toThrow(`PMX didn't send it: its words name a person, which Linear never gets. Move it back first (\`pmx move ${t.id} private\`), reword it with \`pmx todo edit ${t.id} "<new words>"\`, which keeps its meetings and due date, and move it again.`);
    await expect(editTodo(t.id, "Ask the billing lead about partner billing")).rejects.toThrow(/is in Linear as PMX-1, your own to-do, where its words are its title\. Move it back first/);
    await expect(editTodo(t.id, "  ")).rejects.toThrow(/Give the to-do its new words/);
  });

  it("keeps its due date through product → private and product → to-do", async () => {
    const { move } = await setup([]);
    const t = await addTodo({ text: "Spec the partner billing export", due: "2026-11-30" }, NOW);
    await move(t.id, "product", { kind: "spec" });
    await move("PMX-1", "private");
    const back = (await loadTodos()).items[0]!;
    expect(back).toMatchObject({ text: "Spec the partner billing export", due: "2026-11-30" });
    await move(back.id, "product", { kind: "spec" });
    await move("PMX-2", "todo");
    expect((await loadTodos()).items[0]).toMatchObject({ text: "Spec the partner billing export", due: "2026-11-30", linear: "PMX-2" });
  });
});

describe("a holiday in another language is never a name (R6, D2-9)", () => {
  const text = [
    "Lee Park: Feliz Navidad and Feliz Año Nuevo! Joyeux Noël, Bonne Année, Frohe Weihnachten and Buon Natale to the Initech folks.",
    "Robin Hale: Happy Diwali, Eid Mubarak, Happy Hanukkah and a good Lunar New Year. Chinese New Year is the week after Ramadan ends, then Passover and Easter.",
  ].join("\n");

  it("isn't found, known or swapped as a name", () => {
    expect(peopleIn([{ text }]).sort()).toEqual(["Hale", "Lee", "Lee Park", "Park", "Robin", "Robin Hale"]);
    const out = peopleSwap({ items: [{ text }], known: buildKnown({ items: [{ text }] }) }).swap(text);
    for (const phrase of ["Feliz Navidad", "Feliz Año Nuevo", "Joyeux Noël", "Bonne Année", "Frohe Weihnachten", "Buon Natale", "Eid Mubarak", "Lunar New Year", "Chinese New Year"]) {
      expect(out, phrase).toContain(phrase);
    }
    expect(out.match(/\[PERSON-\d+\]/g)).toEqual(["[PERSON-1]", "[PERSON-2]"]);
    expect(trackerGuard({}).problem("Feliz Navidad to the Initech team: the beta ships Dec 8.")).toBeNull();
  });
});

// R7 (SIG-7, founder decision 2026-11-26): a to-do sent to Linear as the PM's own commitment is checked like every other
// Linear text: before, `pmx todo linear`, the page's Send to Linear and `pmx move <id> todo` sent its words unchecked.
describe("a to-do sent to Linear as the PM's own (R7, SIG-7)", () => {
  beforeEach(freshHome);
  let injected: ReturnType<typeof memoryTracker> | null = null;
  // The page's handlers build their own services, as PMX's page does; this hands them the test's tracker.
  registerServices({ tracker: async () => injected as any });
  const notSent = (id: string, why: string, again: string) => `PMX didn't send it: ${why}. Reword it with \`pmx todo edit ${id} "<new words>"\`, which keeps its meetings and due date, and ${again}.`;
  const PERSON = "its words name a person, which Linear never gets";

  async function mine() {
    const s = await setup([
      { text: "Write up the billing split Dana knows", from: "Globex billing" },
      { text: "Some Globex clients are billed through two partners", from: "Globex billing" },
      { text: "Send finance the partner billing list", from: "Globex billing" },
    ]);
    s.ctx.personal.todosToLinear = true;
    injected = s.tr;
    const cli = (id: string) => commands.find((c) => c.name === "todo")!.run({ positionals: ["linear", id], values: {}, ctx: async () => s.ctx, ask: null as any } as any);
    return { ...s, cli };
  }

  it("isn't sent from Terminal when its words name someone its meeting does, or repeat the meeting; a clean one is", async () => {
    const { tr, todo, cli } = await mine();
    const named = await todo("Write up"), quoted = await todo("Some Globex");
    await expect(cli(named.id)).rejects.toThrow(notSent(named.id, PERSON, "send it again"));
    await expect(cli(quoted.id)).rejects.toThrow(notSent(quoted.id, "its words repeat a meeting word for word, and Linear gets summaries only", "send it again"));
    // A to-do typed with no meeting behind it gets the cue rule.
    const typed = await addTodo({ text: "Ask Dana about the partner billing" }, NOW);
    await expect(cli(typed.id)).rejects.toThrow(notSent(typed.id, PERSON, "send it again"));
    // Nothing was queued, and each stays a private to-do.
    expect(tr.tasks.size).toBe(0);
    expect((await loadTodos()).items.filter((t) => t.linear)).toEqual([]);
    expect(await cli((await todo("Send finance")).id)).toBe(0);
    expect([...tr.tasks.values()].map((t) => [t.title, t.category])).toEqual([["Send finance the partner billing list", "commitment"]]);
  });

  it("isn't sent from the page either, which answers with the same line; nor by moving it to a to-do in Linear", async () => {
    const { ctx, tr, todo, move } = await mine();
    const named = await todo("Write up");
    const r = await pipelineHandlers(ctx).todoLinear!(named.id);
    expect(r).toEqual({ status: 400, body: { error: notSent(named.id, PERSON, "send it again").replace(/`([^`]+)`/g, "$1") } });
    await expect(move(named.id, "todo")).rejects.toThrow(notSent(named.id, PERSON, "move it again"));
    expect(tr.tasks.size).toBe(0);
    const clean = await todo("Send finance");
    expect(await pipelineHandlers(ctx).todoLinear!(clean.id)).toEqual({ status: 200, body: { message: "Sent to Linear as PMX-1: Send finance the partner billing list" } });
    expect((await loadTodos()).items.find((t) => t.id === clean.id)?.linear).toBe("PMX-1");
  });
});
