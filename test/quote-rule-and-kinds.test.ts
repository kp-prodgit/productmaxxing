// A test-rig run of PMX main: the quote guard skipped whole tasks for a shared phrase (N4), decision briefs were dropped
// for a team set up before them (N1), a later call merged into a waiting task left its facts on the Mac (N2), a manual
// `pmx synthesize` read only today (N3), and the draft-ready comment named a customer's contact (N5).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../src/commands/index.js";
import { runStatus } from "../src/commands/status.js";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { listReceipts, readReceipt } from "../src/core/receipt.js";
import { services } from "../src/core/services.js";
import { updateState } from "../src/core/state.js";
import { meaningful, quoteGuard } from "../src/core/tracker-text.js";
import { formatReceipt } from "../src/explain/format.js";
import { needsLine, needsYou } from "../src/flow/needs.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { pull } from "../src/pull/pull.js";
import { draftComment, sourcePeople } from "../src/run/comment.js";
import { taskEvidence } from "../src/run/evidence.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { kindLine, kindsWaiting, kindWords, nextWaiting, readHeldOver, saveHeldOver, WAIT_DAYS } from "../src/synth/held-over.js";
import { approveProposals, formatProposal, nearDuplicate, newFacts, readProposals } from "../src/synth/proposals.js";
import { kindRules, parseCandidates, synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

const SOURCES = [
  { id: "T1", text: "Lee: We export a CSV every Friday; SCIM would fix it.\nSam: Our admins keep asking for SCIM provisioning every single week, honestly." },
  {
    id: "T2", text: [
      "Sam: Decision: we write a spec for beta approve/reject and audit log export by Dec 1.",
      "- Vendor security questionnaire: 142 questions plus a data handling addendum, due Dec 1",
      "The vendor risk committee meets on December 3 ahead of beta access on December 8 and needs the questionnaire by December 1.",
    ].join("\n"),
  },
  {
    id: "C1", text: [
      "Dana: Rivals: Globex Studio, Initech Brand Kit, Umbrella and Hooli all ship brand kits with approval flows and audit trails for enterprise teams.",
      "Dana: Admins keep exporting a spreadsheet every single Friday afternoon by hand, and hate it.",
    ].join("\n"),
  },
];

describe("one quote rule: the sentence that quotes goes, a shared name or figure doesn't (N4, PRIV-6)", () => {
  const g = quoteGuard(SOURCES);

  it("lets product and feature names, figures, dates, lists and facts through", () => {
    for (const ok of [
      "Draft a spec for beta approve/reject and audit log export.",
      "Acme's vendor security questionnaire (142 questions plus a data handling addendum) is due Dec 1.",
      "Globex Studio, Initech Brand Kit, Umbrella and Hooli all ship brand kits with approval flows.",
      "Its vendor risk committee meets on December 3 ahead of beta access on December 8.",
      // A list item copied whole is a list item, not a sentence someone said.
      "Vendor security questionnaire: 142 questions plus a data handling addendum, due Dec 1.",
    ]) expect(g.match(ok), ok).toBeNull();
  });

  it("catches someone's words and a source's whole sentence, with the words and the source", () => {
    expect(g.match("We export a CSV every Friday; SCIM would fix it.")).toEqual({ words: "We export a CSV every Friday; SCIM would fix it", source: "T1", why: "sentence" });
    expect(g.match("The customer said our admins keep asking for SCIM provisioning every single week.")).toMatchObject({ source: "T1", words: "our admins keep asking for SCIM provisioning every single week" });
    expect(g.match("Admins at Acme keep exporting a spreadsheet every single Friday afternoon by hand.")).toEqual({ words: "keep exporting a spreadsheet every single Friday afternoon by hand", source: "C1", why: "speech" });
    expect(g.match("The vendor risk committee meets on December 3 ahead of beta access on December 8 and needs the questionnaire by December 1.")).toMatchObject({ source: "T2", why: "sentence" });
    // Released strategy reads as prose too.
    const strategy = quoteGuard([{ id: "S", text: "By the end of FY28, every crew that opens a road plans the job in Fieldbook first." }]);
    expect(strategy.match("So that every crew that opens a road plans the job in Fieldbook first.")).toMatchObject({ source: "S", why: "speech", words: "every crew that opens a road plans the job in Fieldbook first" });
  });

  it("leaves out only the sentence that quotes", () => {
    const r = g.clean("Admins at Acme rebuild a report by hand each week. We export a CSV every Friday; SCIM would fix it. Provisioning would remove the step.");
    expect(r.text).toBe("Admins at Acme rebuild a report by hand each week. Provisioning would remove the step.");
    expect(r.cut).toEqual([{ words: "We export a CSV every Friday; SCIM would fix it", source: "T1", why: "sentence" }]);
    expect(meaningful("Ok.")).toBe(false);
    expect(meaningful("Provisioning would remove the step.")).toBe(true);
  });

  it("synthesis keeps a task that shares a phrase, cuts a quoted sentence from another, and skips one whose title quotes", () => {
    const reply = JSON.stringify({ tasks: [
      { title: "Draft a spec for beta approve/reject and audit log export", category: "spec", size: "M", sources: ["T2"], support: { T2: "The team settled the beta scope here." },
        rationale: "An internal meeting settled the beta scope on Nov 25. Acme's vendor security questionnaire (142 questions plus a data handling addendum) is due Dec 1." },
      { title: "Automate the weekly export", category: "spec", size: "S", sources: ["T1"], support: { T1: "Admins describe the weekly export." },
        rationale: "Admins at Acme rebuild a report by hand each week. We export a CSV every Friday; SCIM would fix it. Provisioning would remove the step." },
      { title: "We export a CSV every Friday; SCIM would fix it", category: "spec", size: "S", rationale: "Provisioning would remove a weekly step.", sources: ["T1"], support: { T1: "Admins describe the weekly export." } },
      { title: "Only a quote", category: "spec", size: "S", rationale: "We export a CSV every Friday; SCIM would fix it.", sources: ["T1"], support: { T1: "Admins describe the weekly export." } },
    ] });
    const r = parseCandidates(reply, ["spec"], new Set(["T1", "T2"]), undefined, new Map(SOURCES.map((s) => [s.id, s.text])));
    expect(r.tasks.map((t) => [t.title, t.rationale])).toEqual([
      ["Draft a spec for beta approve/reject and audit log export", "An internal meeting settled the beta scope on Nov 25. Acme's vendor security questionnaire (142 questions plus a data handling addendum) is due Dec 1."],
      ["Automate the weekly export", "Admins at Acme rebuild a report by hand each week. Provisioning would remove the step."],
    ]);
    expect(r.tasks.map((t) => t.leftOut)).toEqual([undefined, { sentences: 1, why: "1 sentence that repeated a meeting word for word" }]);
    expect(r.skipped).toEqual([
      "We export a CSV every Friday; SCIM would fix it: its title repeats a meeting word for word, and the tracker gets summaries only",
      "Only a quote: its text repeats a meeting word for word, and the tracker gets summaries only",
    ]);
    expect(r.quoted).toEqual([
      { task: "Automate the weekly export", part: "description", source: "T1", words: "We export a CSV every Friday; SCIM would fix it", skipped: false },
      { task: "We export a CSV every Friday; SCIM would fix it", part: "title", source: "T1", words: "We export a CSV every Friday; SCIM would fix it", skipped: true },
      { task: "Only a quote", part: "description", source: "T1", words: "We export a CSV every Friday; SCIM would fix it", skipped: true },
    ]);
  });
});

describe("the receipt and pmx explain say what matched and where (N4)", () => {
  beforeEach(freshHome);

  it("records the shared words and the source, and the proposal never carries them", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme weekly\ndate: 2026-11-19T15:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: We export a CSV every Friday; SCIM would fix it.");
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [
      { title: "Automate the weekly export", category: "spec", size: "S", sources: ["T1"], support: { T1: "The customer describes the weekly export." },
        rationale: "Admins at Acme rebuild a user list by hand each week. We export a CSV every Friday; SCIM would fix it. Provisioning would remove the step." },
    ] }));
    const ctx = await testCtx({ repo, runtime, now: new Date("2026-11-20T12:00:00Z"), team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const r = await synthesize(ctx, await services(ctx, { tracker: memoryTracker() }), { days: 7 });
    expect(r.staged.map((p) => p.title)).toEqual(["Automate the weekly export"]);
    const [p] = await readProposals();
    expect(p!.description.split("\n")[0]).toBe("Admins at Acme rebuild a user list by hand each week. Provisioning would remove the step.");
    expect(p!.description).not.toMatch(/CSV every Friday/);
    const receipt = (await readReceipt((await listReceipts()).find((id) => id.startsWith("synthesize"))!))!;
    expect(receipt.synth!.quoted).toEqual([{ task: "Automate the weekly export", part: "description", source: "T1", words: "We export a CSV every Friday; SCIM would fix it", skipped: false }]);
    const explained = formatReceipt(receipt, []);
    expect(explained).toContain("Left out for repeating a source word for word");
    expect(explained).toContain('· Automate the weekly export, a sentence of its description: "We export a CSV every Friday; SCIM would fix it", from T1 (Acme weekly, 2026-11-19)');
  });

  it("a task that lost a sentence is printed as kept, and the terminal's explain shows the words under it", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme weekly\ndate: 2026-11-19T15:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: We export a CSV every Friday; SCIM would fix it.");
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [
      { title: "Automate the weekly export", category: "spec", size: "S", sources: ["T1"], support: { T1: "The customer describes the weekly export." },
        rationale: "Admins at Acme rebuild a user list by hand each week. We export a CSV every Friday; SCIM would fix it. Provisioning would remove the step." },
    ] }));
    const ctx = await testCtx({ repo, runtime, now: new Date("2026-11-20T12:00:00Z"), team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    await updateState((s) => (s.lastSynthAt = new Date("2026-11-19T09:00:00Z").toISOString()));
    const said: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { said.push(a.join(" ")); });
    try {
      await commands.find((c) => c.name === "synthesize")!.run({ positionals: [], values: {}, ctx: async () => ctx, ask: null as any } as any);
    } finally { vi.restoreAllMocks(); }
    expect(said.filter((l) => l.startsWith("?"))).toEqual([expect.stringMatching(/^\? \[\w+\] Automate the weekly export \(1 sentence left out\)$/)]);
    expect(said.filter((l) => l.startsWith("· skipped"))).toEqual([]);

    const receipt = (await readReceipt((await listReceipts()).find((id) => id.startsWith("synthesize"))!))!;
    expect(receipt.synth!.skipped).toEqual([]);
    expect(receipt.synth!.tasks[0]!.leftOut).toBe("1 sentence that repeated a meeting word for word");
    const lines = formatReceipt(receipt, []).split("\n");
    const at = lines.findIndex((l) => l.includes("left out of what Linear gets"));
    expect(lines.slice(at, at + 2)).toEqual([
      "      left out of what Linear gets: 1 sentence that repeated a meeting word for word",
      '         "We export a CSV every Friday; SCIM would fix it", from T1 (Acme weekly, 2026-11-19)',
    ]);
    // Under the task it belongs to.
    expect(lines.slice(0, at).filter((l) => /^   \S/.test(l)).at(-1)).toBe("   S  Automate the weekly export (spec, 1 source)");
  });
});

/** A team repo set up before decision-brief: no config line for it. */
async function olderTeam() {
  const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
  const cfgPath = join(repo, "pmx.config.json");
  const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
  delete cfg.categories["decision-brief"];
  await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
  await git(repo, "commit", "-qam", "older team");
  return { repo, categories: cfg.categories as typeof DEFAULT_TEAM.categories };
}

describe("a kind of work the team hasn't turned on waits instead of being dropped (N1, CAT-8)", () => {
  beforeEach(freshHome);

  it("the prompt lists only the team's kinds and says what to do with another; a team with every kind gets no such rule", () => {
    expect(kindRules([])).toBe("");
    const rules = kindRules(["decision-brief"]);
    expect(rules).toContain("Use only the category ids listed above for `category` in `tasks`. Your instructions may also describe decision-brief: your team hasn't turned it on.");
    expect(rules).toContain("When a need is clearly a decision-brief, list it in `heldOver` with that id and its sources");
    expect(kindWords("decision-brief")).toBe("decision briefs");
    expect(kindWords("decision-brief", 1)).toBe("a decision brief");
    expect(kindWords("competitive-analysis")).toBe("competitive analyses");
    expect(kindWords("tracking-hygiene")).toBe("tracking hygiene");
  });

  it("holds the suggestions on this Mac, asks in Needs you and pmx status, and brings them back once the kind is on", async () => {
    const { repo, categories } = await olderTeam();
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme pricing\ndate: 2026-11-19T15:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: We have to pick hybrid or per-seat pricing before our Dec 10 board meeting, and the integration order too.");
    const support = { T1: "The customer has to choose by a date." };
    const runtime = mockRuntime(() => JSON.stringify({
      tasks: [
        { title: "Decide hybrid or per-seat pricing for Acme", category: "decision-brief", size: "M", rationale: "Acme picks a pricing model before Dec 10.", sources: ["T1"], support },
        { title: "Spec the pricing page changes", category: "spec", size: "S", rationale: "The pricing page needs both models explained.", sources: ["T1"], support },
      ],
      heldOver: [{ title: "Decide which integration ships first", category: "decision-brief", sources: ["T1"], why: "The order has a date." }],
    }));
    const opts = { repo, runtime, now: new Date("2026-11-20T12:00:00Z"), team: { internalDomains: ["us.com"], categories }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } };
    const ctx = await testCtx(opts);
    const r = await synthesize(ctx, await services(ctx, { tracker: memoryTracker() }), { days: 7 });

    const prompt = runtime.calls[0]!.prompt;
    expect(prompt).toContain("## Kinds of work your team hasn't turned on");
    expect(prompt).not.toMatch(/^- decision-brief:/m);
    expect(r.staged.map((p) => p.title)).toEqual(["Spec the pricing page changes"]);
    expect(r.skipped.some((s) => /unknown category/.test(s))).toBe(false);
    expect(r.skipped).toContain("Decide hybrid or per-seat pricing for Acme: a decision brief isn't a kind of work your team has turned on, so it waits on this Mac until your team does (pmx jobs add decision-brief)");
    expect(r.waiting).toEqual([{ kind: "decision-brief", n: 2 }]);
    const held = (await readHeldOver())!;
    expect(held.needs).toEqual([]);
    expect(held.waiting!.map((w) => [w.title, w.category])).toEqual([["Decide hybrid or per-seat pricing for Acme", "decision-brief"], ["Decide which integration ships first", "decision-brief"]]);
    expect(JSON.stringify(held)).not.toMatch(/Jane|board meeting/);
    const receipt = (await readReceipt((await listReceipts()).find((id) => id.startsWith("synthesize"))!))!;
    expect(receipt.synth!.waiting).toHaveLength(2);
    expect(formatReceipt(receipt, [])).toContain("· Decide which integration ships first (decision-brief, 1 source): pmx jobs add decision-brief");

    // Needs you: one card, with the same team change `pmx jobs add` sends; pmx status says it too.
    expect(await kindsWaiting(ctx.team)).toEqual([{ kind: "decision-brief", n: 2 }]);
    expect(kindLine({ kind: "decision-brief", n: 2 })).toBe("Turn on decision briefs: 2 suggestions are waiting for that kind of work");
    const status = (await runStatus(ctx)).split("\n");
    expect(status[0]).toMatch(/^Needs you: .*1 kind of work to turn on/);
    expect(status).toContain("  Turn on decision briefs: 2 suggestions are waiting for that kind of work: pmx jobs add decision-brief sends it to your team for approval.");
    const base = { drafts: [], needs: { proposals: 0, drafts: 0, todos: 0 }, health: { ok: true, problems: [], items: [], facts: [] }, pendingTeam: [], rules: { reviewCap: 3 } } as any;
    const kw = { kind: "decision-brief", words: "decision briefs", n: 2, text: "x", pending: false };
    expect(needsLine(needsYou({ ...base, kindsWaiting: [kw] }))).toBe("Needs you: 1 kind of work to turn on");
    // Once the change is sent, Team changes shows it instead.
    expect(needsYou({ ...base, kindsWaiting: [{ ...kw, pending: true }] }).total).toBe(0);

    // The page's button sends the same reviewed change, and this PM takes the kind once it merges.
    const sent = await pipelineHandlers(ctx).changes([{ kind: "builtin-kind", name: "decision-brief" }], false);
    expect(sent.status).toBe(200);
    const branch = (await git(repo, "branch", "--list", "pmx/settings-*", "--format=%(refname:short)")).split("\n").filter(Boolean).pop()!;
    expect(JSON.parse(await git(repo, "show", `${branch}:pmx.config.json`)).categories["decision-brief"]).toEqual({ skill: "pmx-decision-brief" });
    expect(ctx.personal.categories).toContain("decision-brief");
    // Never applied directly: the team's config on this Mac still lacks it.
    expect(JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8")).categories["decision-brief"]).toBeUndefined();

    // Merged: the next run offers them first, and they become tasks.
    const on = mockRuntime((o) => {
      const line = o.prompt.split("\n").find((l) => l.includes("Decide hybrid or per-seat pricing"))!;
      const id = line.match(/Sources: (T\d+)\./)![1]!;
      return JSON.stringify({ tasks: [{ title: "Decide hybrid or per-seat pricing for Acme", category: "decision-brief", size: "M", rationale: "Acme picks a pricing model before Dec 10.", sources: [id], support: { [id]: "The customer has to choose by a date." } }] });
    });
    const later = await testCtx({ ...opts, runtime: on, now: new Date("2026-11-21T12:00:00Z"), team: { internalDomains: ["us.com"] } });
    const r2 = await synthesize(later, await services(later, { tracker: memoryTracker() }), { days: 7 });
    expect(on.calls[0]!.prompt).toMatch(/- H\d \(decision-brief, kept until your team turned this kind of work on\): Decide hybrid or per-seat pricing for Acme\./);
    expect(on.calls[0]!.prompt).not.toContain("## Kinds of work your team hasn't turned on");
    expect(r2.staged.map((p) => p.title)).toEqual(["Decide hybrid or per-seat pricing for Acme"]);
    expect(r2.waiting).toEqual([]);
    expect(await kindsWaiting(later.team)).toEqual([]);
  });

  it("Needs you's card sends the change for review, and Team changes shows it from then on", async () => {
    const categories = Object.fromEntries(Object.entries(DEFAULT_TEAM.categories).filter(([k]) => k !== "decision-brief"));
    const need = (title: string) => ({ title, category: "decision-brief", why: "", sources: [], rounds: 1, since: new Date().toISOString() });
    let ui: Ui | null = null;
    try {
      ui = await openBoard({ hash: "needs", team: { categories }, before: async () => saveHeldOver({ v: 1, at: new Date().toISOString(), receipt: "r0", readSince: new Date().toISOString(), needs: [], waiting: [need("Decide hybrid or per-seat pricing"), need("Decide which integration ships first")] }) });
      expect(ui.text()).toContain("Kinds of work to turn on");
      expect(ui.text()).toContain("Turn on decision briefs: 2 suggestions are waiting for that kind of work");
      await ui.click(ui.button("Send to your team", "main"));
      await ui.until(() => ui!.posts.some((p) => p[0] === "changes"), "the change to be sent", 8000);
      expect(ui.posts.find((p) => p[0] === "changes")![1]).toEqual({ changes: [{ kind: "builtin-kind", name: "decision-brief" }], confirmLoosening: false });
      await ui.until(() => !/Kinds of work to turn on/.test(ui!.text()) && /Add PMX's kind of work decision-brief/.test(ui!.text()), "Team changes to show it", 8000);
    } finally { await ui?.close(); }
  }, 30000);

  it("a suggestion waits without counting runs, and is let go after two weeks", () => {
    const need = { title: "Decide which integration ships first", category: "decision-brief", why: "", sources: [] };
    const first = nextWaiting([need], [], "2026-11-01T00:00:00Z").waiting;
    const kept = nextWaiting([], first, "2026-11-10T00:00:00Z");
    expect(kept.waiting).toEqual([expect.objectContaining({ title: need.title, since: "2026-11-01T00:00:00Z", rounds: 1 })]);
    const gone = nextWaiting([], first, `2026-11-${String(1 + WAIT_DAYS + 1).padStart(2, "0")}T00:00:00Z`);
    expect(gone.waiting).toEqual([]);
    expect(gone.dropped.map((d) => d.title)).toEqual([need.title]);
  });
});

describe("a later call merged into a waiting task changes what Linear would get (N2, INPUT-2)", () => {
  beforeEach(freshHome);

  it("adds the call's facts, its source to the Sources line and a pmx:source line its own run knows, and shows the PM what changed", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "1-acme.md", "---\ntitle: Acme pilot intro\ndate: 2026-11-19T15:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: We'd like a paid pilot in January, separate from the beta.");
    const opts = { repo, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } };
    const first = mockRuntime(() => JSON.stringify({ tasks: [{
      title: "Scope a paid proof of concept for Acme", category: "spec", size: "M", rationale: "Acme wants a paid proof of concept in January, outside the beta.",
      sources: ["T1"], support: { T1: "The customer asks for a paid pilot." }, companies: { T1: { name: "Acme", as: "customer" } },
    }] }));
    const ctx1 = await testCtx({ ...opts, runtime: first, now: new Date("2026-11-20T12:00:00Z") });
    const tracker = memoryTracker();
    await synthesize(ctx1, await services(ctx1, { tracker }), { days: 7 });
    const [waiting] = await readProposals();
    const a = waiting!.receipt;

    await writeTranscript(dir, "2-globex.md", "---\ntitle: Globex check-in\ndate: 2026-11-24T15:00:00Z\nparticipants: lee@globex.example, kp@us.com\n---\nLee: Dark mode would be nice someday.");
    await writeTranscript(dir, "3-acme.md", "---\ntitle: Acme pilot scoping\ndate: 2026-11-25T15:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: We need the scope by December 4 so it lands before our February budget cycle. Legal wants written data terms by December 11, and that decides it.");
    const second = mockRuntime((o) => {
      const id = o.prompt.match(/<item id="(T\d+)"[^>]*title="Acme pilot scoping"/)![1]!;
      return JSON.stringify({ tasks: [{
        title: "Paid proof of concept for Acme", category: "spec", size: "M", sameAs: waiting!.id, sources: [id], support: { [id]: "The customer sets the scope and legal dates." },
        companies: { [id]: { name: "Acme", as: "customer" } },
        rationale: "Acme wants a paid proof of concept in January. Scope is due Dec 4, ahead of Acme's February budget cycle. Written data terms are due Dec 11 and decide the deal.",
      }] });
    });
    const ctx2 = await testCtx({ ...opts, runtime: second, now: new Date("2026-11-26T12:00:00Z") });
    const r = await synthesize(ctx2, await services(ctx2, { tracker }), { days: 7 });
    expect(r.skipped).toContain("Paid proof of concept for Acme: the same need as a task already waiting for you, so its sources were added to it");
    const b = (await listReceipts()).find((id) => id.startsWith("synthesize") && id !== a)!;
    const newId = (await readReceipt(b))!.sources.find((s) => s.title === "Acme pilot scoping")!.id!;
    expect(newId).toBe("T3");

    const [p] = await readProposals();
    expect(p!.sources).toEqual(["T1", "T2"]);
    expect(p!.description).toBe([
      "Acme wants a paid proof of concept in January, outside the beta. Scope is due Dec 4, ahead of Acme's February budget cycle. Written data terms are due Dec 11 and decide the deal.",
      "",
      "**Why size M:** no rubric cell given",
      "**Check the size:** the model gave no reason for this size.",
      "",
      `**Sources:** 2 customer calls with Acme (Nov 19–25). They stay on the PM's Mac: \`pmx explain ${a}\` there shows them.`,
      "",
      "pmx:source T1",
      "pmx:source T2",
    ].join("\n"));
    expect(p!.description).not.toMatch(/Heard again|Jane|Legal wants/);
    // The task's own run now knows the call as T2, so explain and the drafting agent find it.
    const ra = (await readReceipt(a))!;
    expect(ra.sources.find((s) => s.id === "T2")).toMatchObject({ title: "Acme pilot scoping", addedFrom: b, decision: "used" });
    expect(formatProposal(p!, 1, true)).toMatch(/Changed since it was suggested: Nov 26, a later run added 1 more source \(T2\), and 2 sentences in the description: Scope is due Dec 4/);
    const page = await pipelineHandlers(ctx2).data(168);
    expect(page.proposals[0]!.changed).toMatch(/a later run added 1 more source \(T2\), and 2 sentences in the description/);

    await approveProposals(ctx2, await services(ctx2, { tracker }), ["1"]);
    const task = [...tracker.tasks.values()].find((t) => t.title === "Scope a paid proof of concept for Acme")!;
    expect(task.sources).toEqual(["T1", "T2"]);
    const ev = await taskEvidence(ctx2, task);
    expect(ev.missing).toEqual([]);
    expect(ev.sources.map((s) => s.id)).toEqual(["T1", "T2"]);
    expect(ev.sources[1]!.passages.join("\n")).toContain("written data terms by December 11");
  });

  it("only new facts join the description", () => {
    const d = "Acme wants a paid proof of concept in January, outside the beta.\n\n**Sources:** a customer call with Acme (Nov 19).";
    expect(newFacts(d, "Acme wants a paid proof of concept in January. Scope is due Dec 4.")).toEqual(["Scope is due Dec 4."]);
    expect(newFacts(d, "A paid proof of concept for Acme in January.")).toEqual([]);
  });

  it("a sentence the description already says in other words doesn't join it, even with a new figure", () => {
    const d = "Acme picks a pricing model for its imprints before Dec 18. The brief should frame the per-imprint price against a pooled allowance.\n\n**Sources:** a customer call with Acme (Nov 19).";
    expect(nearDuplicate("The brief should frame the per-imprint price against a pooled allowance.", "The brief should frame the per-imprint prices against the pooled allowance at about $22k a year.")).toBe(true);
    expect(nearDuplicate("The brief should frame the per-imprint price against a pooled allowance.", "Acme needs a quote by Dec 9.")).toBe(false);
    expect(newFacts(d, [
      "The brief should frame the per-imprint prices against the pooled allowance at about $22k a year each.",
      "Acme needs a quote by Dec 9 to sign before Dec 18.",
      "A rival's quote is near $14k per imprint.",
    ].join(" "))).toEqual(["Acme needs a quote by Dec 9 to sign before Dec 18.", "A rival's quote is near $14k per imprint."]);
    // Two new sentences that say the same thing: only the first.
    expect(newFacts("Acme picks a pricing model.\n\n**Sources:** a call.", "The brief should weigh hybrid against per-seat pricing for Beta Corp. The brief should weigh hybrid and per-seat pricing for Beta Corp by Friday.")).toEqual(["The brief should weigh hybrid against per-seat pricing for Beta Corp."]);
  });
});

describe("a manual pmx synthesize reads what the background run would (N3)", () => {
  beforeEach(freshHome);
  afterEach(() => vi.restoreAllMocks());

  it("reads from a day before the last run, and --since still picks the start", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme evening call\ndate: 2026-11-25T23:00:00Z\nparticipants: jane@acme.com, kp@us.com\n---\nJane: The pilot needs a written scope next week.");
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [] }));
    const ctx = await testCtx({ repo, runtime, now: new Date(2026, 10, 26, 10), team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    await updateState((s) => (s.lastSynthAt = new Date(2026, 10, 25, 9).toISOString()));
    const cmd = commands.find((c) => c.name === "synthesize")!;
    const said: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { said.push(a.join(" ")); });
    const run = (values: Record<string, unknown>) => cmd.run({ positionals: [], values: { "dry-run": true, ...values }, ctx: async () => ctx, ask: null as any } as any);

    await run({ since: "today" });
    expect(said.find((l) => l.startsWith("Meetings since"))).toBe(`Meetings since ${new Date(2026, 10, 26).toDateString()}: 0 processed now (recorded in your PMX repo, not Linear), 0 already processed by the team, 0 being processed on another machine.`);
    said.length = 0;
    await run({});
    expect(said.find((l) => l.startsWith("Meetings since"))).toBe(`Meetings since ${new Date(2026, 10, 24).toDateString()}: 0 processed now (recorded in your PMX repo, not Linear), 0 already processed by the team, 0 being processed on another machine.`);
    expect(runtime.calls.at(-1)!.prompt).toContain("The pilot needs a written scope next week.");
    expect(cmd.usage).toMatch(/by default it reads what the background job would/);
  });
});

describe("the draft-ready comment names no one from the task's sources (N5, TASK-10)", () => {
  beforeEach(freshHome);

  it("leaves out participants and speakers, inside and outside the company; a role may stay", () => {
    const people = sourcePeople({
      sources: [{ passages: ["Dana Reyes: We'd pay about $360,000 if approvals ship.\nPat Moss: Agreed, Dec 8 works."] }],
      people: ["Robin Hale <robin.hale@acme.example>", "sam.ortiz@us.example"],
    }, ["us.example"]);
    expect(people).toEqual(expect.arrayContaining(["Robin Hale", "Robin", "Hale", "Sam Ortiz", "Sam", "Ortiz", "Dana Reyes", "Dana", "Reyes", "Pat Moss", "Moss"]));
    expect(people).not.toContain("Acme");
    const md = "# Spec approvals\n\n## Summary\n\nAcme (VP Brand Robin Hale's team) will pay about $360,000 for approvals. Acme (the VP of Brand's team) needs approvals before its Dec 8 beta. Sam owns the rollout plan.\n";
    const said = draftComment({ title: "Spec approvals", markdown: md, prUrl: "branch:x", path: "outputs/spec/PMX-1.md", agent: "ana@m1", people });
    expect(said).toContain("Acme (the VP of Brand's team) needs approvals before its Dec 8 beta.");
    expect(said).not.toMatch(/Robin|Hale|Sam|\$360,000/);
  });

  it("a run on the Mac that suggested the task passes its sources' people to the comment", async () => {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] }, { remote: true });
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme approvals\nparticipants: Robin Hale <robin.hale@acme.com>, kp@us.com\n---\nRobin: Every Friday we export a CSV of our users and paste it into your admin screen. SCIM provisioning would fix it.");
    const draft = [
      "# Spec SCIM provisioning", "", "## Problem", "",
      "Acme (VP Brand Robin Hale's team) copies users in by hand every week [T1]. Acme (the VP of Brand's team) needs SCIM before its Dec 8 beta [T1].", "",
      "## Evidence", "", "- A weekly CSV export [T1]", "", "## Validated by", "", "Not yet.", "", "## Proposal", "", "SCIM 2.0 provisioning.", "",
      "## Success metrics", "", "- No weekly export.", "", "## Open questions", "", "- Which identity providers first?", "",
    ].join("\n");
    const rt = mockRuntime(async (o) => {
      if (!o.tools.length) return JSON.stringify({ tasks: [{ title: "Spec SCIM provisioning", category: "spec", size: "M", rationale: "Admins keep user lists in sync by hand.", sources: ["T1"], support: { T1: "The customer exports users weekly." } }] });
      const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), draft);
      return { text: "Drafted.", costUsd: 0.1 };
    });
    const ctx = await testCtx({ repo, runtime: rt, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    const tracker = memoryTracker();
    const svc = await services(ctx, { tracker });
    await synthesize(ctx, svc, { days: 7 });
    await approveProposals(ctx, svc, ["1"]);
    const task = [...tracker.tasks.values()][0]!;
    await tracker.setStatus(task.id, "ready");
    expect((await pull(ctx, svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const comment = tracker.comments.get(task.id)!.at(-1)!;
    expect(comment).toContain("Acme (the VP of Brand's team) needs SCIM before its Dec 8 beta.");
    expect(comment).not.toMatch(/Robin|Hale/);
  });
});
