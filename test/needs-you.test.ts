// BOARD-10: Needs you is the page's one queue of decisions, ordered by what unblocks the most, with who acts and how
// long each card has waited. Work and Health hold the rest; Today holds the PM's own to-dos only. Old links land in the
// new places, and `pmx status` starts with the same count.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runStatus } from "../src/commands/status.js";
import type { Ctx } from "../src/core/context.js";
import { paths } from "../src/core/paths.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { needsLine, needsYou } from "../src/flow/needs.js";
import { buildChecklist, recordChecklist } from "../src/setup/checklist.js";
import { stageProposals } from "../src/synth/proposals.js";
import { relayDir } from "../src/tracker/relay.js";
import { freshHome, git, pmxRepo, testCtx } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";

const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
const H = 3600000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const node = (n: number, status: string, title: string, agent?: string) => ({
  id: `uuid-${n}`, identifier: `PMX-${n}`, title, description: "", url: `https://linear.app/acme/issue/PMX-${n}`, priority: 0,
  createdAt: ago(9 * 24 * H), comments: { nodes: [] },
  labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: "spec", parent: { name: "pmx-category" } }, { name: "S", parent: { name: "pmx-size" } }, ...(agent ? [{ name: agent, parent: { name: "pmx-agent" } }] : [])] },
});
const runEntry = (ctx: Ctx, taskId: string, ts: string, outcome: "ok" | "failed") => ({
  type: "run", taskId, ts, agent: ctx.agent, machine: "m1", category: "spec", size: "S", skill: "pmx-spec", skillVersion: "1.0.0",
  outcome, durationMs: 60000, tokens: null, costUsd: null, runtime: "claude-code",
});
const fail = (id: string, detail: string) => ({ id, ok: false, detail, level: "fail" as const });
const ok = (id: string) => ({ id, ok: true, detail: id, level: "fail" as const });

/**
 * One of everything that waits for the PM: a draft their agent made 2 hours ago (the review cap is 1, so the agent is
 * paused), a task stopped after failed runs, a proposal staged 5 days ago, this week's digest, a required setup step,
 * and a team change saved on this Mac. A fresh test Mac has fixes of its own (automatic runs are off, and so on).
 */
async function everything(ctx: Ctx) {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [
    node(7, "review", "Spec the audit log export", ctx.agent), node(19, "blocked", "Spec SCIM provisioning"), node(30, "inbox", "Pricing page copy"),
  ] }));
  const store = new RunLogStore(ctx);
  await store.record(runEntry(ctx, "PMX-7", ago(2 * H), "ok") as any);
  for (const ts of [ago(30 * H), ago(26 * H)]) await store.record(runEntry(ctx, "PMX-19", ts, "failed") as any);
  await stageProposals([{ at: ago(5 * 24 * H), receipt: "r0", title: "Export approval history to CSV", description: "Admins need a record.", category: "spec", size: "M", sources: ["T1"], from: [{ id: "T1", title: "Beta call", at: ago(5 * 24 * H).slice(0, 10), why: "asked twice" }] }]);
  await mkdir(paths.staging(), { recursive: true });
  await writeFile(join(paths.staging(), "digest-2026-W47.md"), "# Digest\n\n## Themes\n\n- Exports matter [T1]\n");
  // A settings change not merged yet (R22): one commit past the team's base.
  const sent = await git(ctx.personal.repoPath, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "Team settings from PMX");
  await git(ctx.personal.repoPath, "branch", "pmx/settings-20261120120000", sent);
  await writeFile(join(paths.home(), "settings-prs.json"), JSON.stringify([{ id: "pmx/settings-20261120120000", url: "branch:pmx/settings-20261120120000", at: ago(4 * 24 * H), changes: ["Agents wait at 4 drafts"] }]));
  await recordChecklist(buildChecklist({
    now: new Date(), version: "0.35.0", personal: ctx.personal, team: { ...DEFAULT_TEAM, tracker: LINEAR } as any,
    checks: [ok("os.macos"), ok("node"), ok("claude.installed"), ok("config.team"), ok("schedule.launchd"), fail("profile.signed-in", "PMX's Claude profile isn't signed in: run `pmx claude login`")],
    state: { lastTick: { at: new Date().toISOString(), failed: [], failStreak: 0 }, collectReports: [] } as any, claude: true, hasRemote: false, memoryFilled: true,
    proposals: 1, tasks: { pool: 1, ready: 0, blocked: 1 }, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: "0 * * * *", engine: null, extra: [],
  }));
}

const groups = (u: Ui) => u.all("main section.group").map((s) => s.getAttribute("aria-label"));
const group = (u: Ui, name: string) => u.all("main section.group").find((s) => s.getAttribute("aria-label") === name)!;
const card = (u: Ui, text: string) => u.all("main [role=listitem]").find((r) => r.textContent?.includes(text))!;

describe("Needs you (BOARD-10)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  for (const app of [false, true]) it(`is where the page opens: one queue, in the order that unblocks the most, counted on the badge${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ app, hash: "", team: { tracker: LINEAR as any, reviewQueueCap: 1 }, before: everything });
    await ui.until(() => group(ui!, "Team changes"), "every group");
    expect(ui.win.location.hash).toBe("#needs");
    expect(ui.text("main h1")).toBe("Needs you");
    expect(groups(ui)).toEqual(["Drafts to review", "Stopped after failed runs", "Tasks to approve", "Weekly digest", "Needs a fix", "Team changes"]);
    // The badge, and the narrow-screen header, count every card.
    const cards = ui.all("main section.group [role=listitem]").length;
    expect(cards).toBeGreaterThanOrEqual(7);
    expect(ui.$("#b-needs")!.textContent).toBe(String(cards));
    expect(ui.$("#tb-b")!.textContent).toBe(`Needs you ${cards}`);
    // The agent is paused while its drafts fill the review cap, and the drafts group says so plainly.
    expect(ui.text("#review-cap")).toBe("Your agent is paused. It takes no new work while 1 of your drafts waits for review. Review one and it starts again.");
    expect(ui.$("#b-needs")!.classList.contains("hot")).toBe(true);
    // The setup step PMX can't do without is one card, with its hint.
    expect(card(ui, "Next setup step").textContent).toMatch(/Next setup step: PMX's own Claude profile is signed in.*In the Claude app, type \/pmx-setup/);
    // Every existing action is still there.
    expect([...card(ui, "Spec the audit log export").querySelectorAll(".acts button")].map((b) => b.textContent)).toEqual(["Accept", "Redo", "Reject"]);
    expect([...card(ui, "Spec SCIM provisioning").querySelectorAll(".acts button, .acts a")].map((b) => b.textContent!.trim())).toEqual(["Try again", "Edit task", "Drop"]);
    expect([...card(ui, "Export approval history").querySelectorAll(".acts button")].map((b) => b.textContent)).toEqual(["Start now", "Later", "Drop"]);
    expect(card(ui, "Your digest for the week of").querySelector(".acts button")!.textContent).toBe("Read it");
    expect(card(ui, "Agents wait at 4 drafts").querySelector(".acts button")!.textContent).toBe("Apply now");
    // No pmx command anywhere on the page, shown or folded away (SETUP-2): fixes are buttons, slash commands or words.
    expect(ui.all("details.term")).toEqual([]);
    expect(pageText(ui)).not.toMatch(/\bpmx [a-z]/);
    expect(ui.text("body")).toMatch(/Turn on automatic runs/);
  }, 30000);

  it("says who acts and how long each card has waited, from its own time, and marks what waited over 3 days", async () => {
    ui = await openBoard({ hash: "needs", team: { tracker: LINEAR as any, reviewQueueCap: 1 }, before: everything });
    await ui.until(() => group(ui!, "Team changes"), "every group");
    const age = (text: string) => card(ui!, text).querySelector(".age");
    // The draft: since the agent's run made it (2 hours), not since the task was created (9 days).
    expect(card(ui, "Spec the audit log export").querySelector(".wf")!.textContent).toBe("You · accept it, ask for a redo or reject it");
    expect(age("Spec the audit log export")!.textContent).toBe("waiting 2 hours");
    expect(age("Spec the audit log export")!.classList.contains("over")).toBe(false);
    // Stopped: since its last failed run.
    expect(age("Spec SCIM provisioning")!.textContent).toBe("waiting 1 day");
    // The proposal was staged 5 days ago: marked.
    expect(card(ui, "Export approval history").querySelector(".wf")!.textContent).toBe("You · start it now, later or drop it");
    expect(age("Export approval history")!.textContent).toBe("waiting 5 days");
    expect(age("Export approval history")!.classList.contains("over")).toBe(true);
    expect(age("Export approval history")!.querySelector("svg")).toBeTruthy();
    // The digest: since it was built.
    expect(age("Your digest for the week of")!.textContent).toBe("waiting under an hour");
    // A team change with no remote is the PM's to apply; it was saved 4 days ago.
    expect(card(ui, "Agents wait at 4 drafts").querySelector(".wf")!.textContent).toMatch(/^You · apply it/);
    expect(age("Agents wait at 4 drafts")!.classList.contains("over")).toBe(true);
    // Fixes and the setup step carry no time of their own, so no age is made up for them.
    expect(card(ui, "Next setup step").querySelector(".wf")!.textContent).toBe("You · do this step; PMX can't do its job without it");
    expect(card(ui, "Next setup step").querySelector(".age")).toBeNull();
    for (const r of group(ui, "Needs a fix").querySelectorAll("[role=listitem]")) expect(r.querySelector(".age")).toBeNull();
  }, 30000);

  it("acts from its cards as before: Read it opens the digest, and a redo asks for a note before it's sent", async () => {
    ui = await openBoard({ hash: "needs", team: { tracker: LINEAR as any, reviewQueueCap: 1 }, before: everything });
    await ui.until(() => card(ui!, "Your digest for the week of"), "the digest card");
    await ui.click(card(ui, "Your digest for the week of").querySelector(".acts button")!);
    expect(ui.win.location.hash).toBe("#work/digest");
    await ui.until(() => ui!.$("#digest-2026-W47"), "the digest");
    expect(ui.button("Approve and share", "main")).toBeTruthy();

    await ui.go("#needs");
    await ui.click(ui.button("Redo", "main [role=list]"));
    const note = await ui.until(() => ui!.$("[data-fk='note-r:PMX-7']") as HTMLInputElement, "the redo note");
    (note.closest("form") as HTMLFormElement).requestSubmit();
    expect(ui.posts.some((p) => p[0] === "review")).toBe(false);
    await ui.type(note, "Cite the beta call");
    (note.closest("form") as HTMLFormElement).requestSubmit();
    expect(ui.text("#toast")).toMatch(/Asked the agent to redo PMX-7\./);
    await ui.until(() => ui!.posts.some((p) => p[0] === "review"), "the redo to be sent", 8000);
    expect(ui.posts.find((p) => p[0] === "review")![1]).toEqual({ identifier: "PMX-7", verdict: "redo", note: "Cite the beta call" });
    // Whatever PMX answered, the page is done with it once the card is back or gone.
    await ui.until(() => !ui!.$("[data-key='r:PMX-7'].gone"), "the redo to finish", 15000);
  }, 30000);

  it("Today holds to-dos only: drafts to review aren't there", async () => {
    ui = await openBoard({ hash: "today", team: { tracker: LINEAR as any }, before: everything });
    await ui.until(() => ui!.text("main h1") === "Today", "Today");
    expect(ui.text()).toMatch(/Your to-dos for today\. They're yours alone and never leave this Mac\./);
    expect(ui.text()).not.toMatch(/Spec the audit log export|Drafts to review|Reviews/);
    expect(ui.$("#b-today")!.textContent).toBe("");
    // Today's strip points to what waits in Needs you.
    await ui.click(ui.button(/things need you$/, "main"));
    expect(ui.win.location.hash).toBe("#needs");
    expect(card(ui, "Spec the audit log export")).toBeTruthy();
  }, 30000);
});

describe("Work and Health (BOARD-10)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("the nav has Needs you, Work, Health, then My to-dos; Strategy waits hidden for PMX Engine", async () => {
    ui = await openBoard({ hash: "needs" });
    const nav = ui.all(".nav > button.ni[data-view], .nav > h6").map((x) => x.tagName === "H6" ? `[${x.textContent}]` : x.getAttribute("data-view"));
    expect(nav).toEqual(["needs", "work", "strategy", "health", "[My to-dos]", "today", "upcoming", "anytime", "logbook"]);
    // BOARD-11: Strategy is PMX Engine; without it on this Mac, as on every PM's, it stays hidden.
    expect((ui.$("#nav-strategy") as HTMLButtonElement).hidden).toBe(true);
    expect(ui.text("#nav-strategy")).toBe("Strategy");
  }, 30000);

  it("Work shows the team's tasks by state, each with its history from what the page already has", async () => {
    ui = await openBoard({ hash: "work", team: { tracker: LINEAR as any }, before: everything });
    await ui.until(() => ui!.$("#tab-tasks[aria-selected=true]"), "Work's Tasks tab");
    expect(groups(ui)).toEqual(["To approve", "In the backlog", "To review", "Blocked or stopped", "By kind of work"]);
    expect(ui.text("main section.group[aria-label='To approve']")).toMatch(/1 new task waits for you/);
    expect(card(ui, "Spec the audit log export").querySelector(".hist")!.textContent).toMatch(/^History: drafted \w{3} \d+$/);
    expect(card(ui, "Spec SCIM provisioning").querySelector(".hist")!.textContent).toMatch(/a run failed .* stopped after 2 failed runs/);
    await ui.click(ui.button("Open Needs you", "main"));
    expect(ui.win.location.hash).toBe("#needs");
  }, 30000);

  const ROUTES: [string, string, string | null][] = [
    ["inbox", "#needs", null], ["plan", "#work", "tasks"], ["agents", "#work/agents", "agents"], ["digest", "#work/digest", "digest"],
    ["work", "#work", "tasks"], ["categories", "#work/agents", "agents"], ["skills", "#work/agents", "agents"],
    ["status", "#health", "overview"], ["status/setup", "#health/setup", "setup"], ["status/flow", "#health/steps", "steps"], ["status/activity", "#health/activity", "activity"],
    ["automations", "#health", "overview"], ["privacy/checks", "#health", "overview"], ["flow", "#health/flow", "flow"], ["connections", "#health/flow", "flow"],
    ["settings/kinds", "#health/settings/kinds", "settings"], ["settings/review-cap", "#health/settings/limits", "settings"], ["privacy", "#health/settings/dnr", "settings"],
    ["rules/domains", "#health/settings/customers", "settings"], ["sources", "#health/settings/sources", "settings"], ["schedules", "#health/settings/schedule", "settings"],
    ["today", "#today", null], ["search", "#today", null], ["health/settings/sizes", "#health/settings/sizes", "settings"], ["work/digest", "#work/digest", "digest"],
  ];
  for (const app of [false, true]) it(`every link from before lands in its new place${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ app, hash: "needs" });
    for (const [from, to, tab] of ROUTES) {
      await ui.go(`#${from}`);
      await ui.until(() => ui!.win.location.hash === to, `#${from} to land on ${to}`);
      expect(ui.$(".nav [aria-current=page]")!.getAttribute("data-view"), from).toBe(to.slice(1).split("/")[0]);
      if (tab) expect(ui.$("[role=tab][aria-selected=true]")!.id, from).toBe(`tab-${tab}`);
    }
    // A Settings section is still in the page's own Settings, with its save bar.
    await ui.go("#settings/limits");
    await ui.until(() => ui!.$("#savebar"), "Settings");
    expect(ui.$("[data-fk=pref-limits]")!.getAttribute("aria-current")).toBe("page");
  }, 60000);

  it("the Status setup card's See every step opens Health's Setup tab", async () => {
    ui = await openBoard({ hash: "status", before: everything });
    await ui.until(() => ui!.$("#setup-summary"), "the setup summary");
    await ui.click(ui.button("See every step", "#setup-summary"));
    expect(ui.win.location.hash).toBe("#health/setup");
    await ui.until(() => ui!.$("#setup-work"), "every step");
  }, 30000);
});

describe("pmx status starts with what needs you (BOARD-10)", () => {
  const base = { drafts: [], needs: { proposals: 0, drafts: 0, todos: 0 }, health: { ok: true, problems: [], items: [], facts: [] }, pendingTeam: [], rules: { reviewCap: 3 } } as any;

  it("counts the same cards the page shows, in the same order", () => {
    expect(needsLine(needsYou(base))).toBe("Needs you: nothing");
    const d = {
      ...base, drafts: [1, 2, 3].map((n) => ({ identifier: `PMX-${n}`, title: "t", url: null, since: null, mine: true })), needs: { proposals: 25, drafts: 3, todos: 0 },
      stopped: [{ identifier: "PMX-9", title: "t", url: null, category: null, runs: 2, reason: null, at: null }], digest: { waiting: [{ week: "2026-W47" }] },
      health: { ok: false, problems: ["a", "b"], items: [{ text: "a" }, { text: "b" }], facts: [] }, setup: { next: { title: "x", page: "y", required: true } },
      pendingTeam: [{ url: "branch:x", at: "", changes: [] }],
    };
    const n = needsYou(d);
    expect(n).toMatchObject({ drafts: 3, paused: true, stopped: 1, proposals: 25, digest: 1, fixes: 2, setup: 1, team: 1, total: 34 });
    expect(needsLine(n)).toBe("Needs you: 3 drafts to review (your agent is paused until you review one), 1 task stopped after failed runs, 25 tasks to approve, the weekly digest, 2 things to fix, the next setup step, 1 team settings change waiting");
    // Teammates' drafts don't count toward this PM's review cap, and a step PMX can do without isn't a card.
    expect(needsYou({ ...d, drafts: d.drafts.map((x: any) => ({ ...x, mine: false })), setup: { next: { title: "x", page: "y", required: false } } })).toMatchObject({ paused: false, setup: 0 });
  });

  it("is the first line of pmx status, from the data the page reads", async () => {
    await freshHome();
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    await stageProposals([
      { at: new Date().toISOString(), receipt: "r0", title: "One", description: "d", category: "spec", size: "S", sources: ["T1"], from: [] },
      { at: new Date().toISOString(), receipt: "r0", title: "Two", description: "d", category: "spec", size: "S", sources: ["T2"], from: [] },
    ] as any);
    const first = (await runStatus(ctx)).split("\n")[0]!;
    expect(first).toMatch(/^Needs you: .*2 tasks to approve/);
    const { loadPipeline } = await import("../src/flow/pipeline-load.js");
    expect(first).toBe(needsLine((await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain })).needsYou!));
  });
});
