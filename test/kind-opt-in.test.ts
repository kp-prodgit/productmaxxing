// From an end-to-end test with five PMs: `pmx jobs add decision-brief` turned the kind on for the sending PM's agent
// only. The other four agents skipped every decision brief and nothing told them; only `pmx pull --dry-run` said "you
// don't accept decision-brief", and nothing pointed to the Terminal command that turns it on (R7, JOB-11). And once it merged,
// `pmx doctor` failed "shared skill pmx-decision-brief" though runs used PMX's own copy and worked (R8, NEUT-2).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDoctor, runDoctor } from "../src/commands/doctor.js";
import { jobsCommands } from "../src/commands/jobs.js";
import { settingsCommands } from "../src/commands/settings.js";
import { runStatus } from "../src/commands/status.js";
import { chooseKind, DEFAULT_TEAM, kindsToChoose, loadPersonalConfig, loadTeamConfig, savePersonalConfig, takesCategory, type PersonalConfig, type TeamConfig } from "../src/core/config.js";
import type { Ctx } from "../src/core/context.js";
import { scriptedAsker } from "../src/core/ask.js";
import { runInit } from "../src/commands/init.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { bundledSkillsDir } from "../src/core/skills.js";
import { checkChange, proposeTeamChanges } from "../src/flow/actions.js";
import { needsLine } from "../src/flow/needs.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { loadPipeline } from "../src/flow/pipeline-load.js";
import { buildChecklist, type ChecklistInputs } from "../src/setup/checklist.js";
import { choiceLine } from "../src/synth/held-over.js";
import { relayDir } from "../src/tracker/relay.js";
import { freshHome, git, personal, pmxRepo, quietOut, testCtx, tmp } from "./helpers.js";
import { openBoard, type Ui } from "./ui-helpers.js";

/** Pretends Claude Code is installed; everything else runs for real. */
const withClaude: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));
const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
/** The kinds a PM chose when their team was set up, before PMX had decision briefs. */
const BEFORE = Object.keys(DEFAULT_TEAM.categories).filter((k) => k !== "decision-brief");
const LINE = "Your team has decision briefs. Your agent doesn't take them yet; 2 Ready tasks are waiting for that kind of work";
const node = (n: number, status: string, category: string, title: string) => ({
  id: `uuid-${n}`, identifier: `PMX-${n}`, title, description: "", url: `https://linear.app/team/issue/PMX-${n}`, priority: 0,
  createdAt: new Date(Date.now() - 2 * 86400000).toISOString(), comments: { nodes: [] },
  labels: { nodes: [{ name: status, parent: { name: "pmx-status" } }, { name: category, parent: { name: "pmx-category" } }, { name: "M", parent: { name: "pmx-size" } }] },
});
/** PMX's copy of Linear: two decision briefs Ready (one due in 8 days), and a spec this PM's agent already takes. */
async function readyDecisionBriefs() {
  await mkdir(relayDir(), { recursive: true });
  await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [
    node(41, "ready", "decision-brief", "Decide hybrid or per-seat pricing before the board meeting"), node(42, "ready", "decision-brief", "Decide which integration ships first"),
    node(43, "ready", "spec", "Spec the audit log export"),
  ] }));
}
const checklist = (p: PersonalConfig, team: TeamConfig, readyByKind: Record<string, number> | null) => buildChecklist({
  now: new Date(), version: "0.37.0", personal: p, team, checks: [], state: { lastTick: null, collectReports: [] } as any, claude: false, hasRemote: true, memoryFilled: true,
  proposals: 0, tasks: { pool: 0, ready: 3, blocked: 0 }, readyByKind, practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: null, extra: [],
} satisfies ChecklistInputs);
const kindsStep = (cl: ReturnType<typeof buildChecklist>) => cl.sections.flatMap((s) => s.steps).find((s) => s.id === "work.kinds")!;

/** Runs `pmx jobs …` or `pmx categories …` and returns what it printed. */
async function pmx(name: "jobs" | "categories", ctx: Ctx, positionals: string[]): Promise<string> {
  const cmd = [...jobsCommands, ...settingsCommands].find((c) => c.name === name)!;
  const logs: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  try { expect(await cmd.run({ values: {}, positionals, ask: {} as never, cliPath: "", ctx: async () => ctx } as never)).toBe(0); }
  finally { console.log = orig; }
  return logs.join("\n");
}

describe("never chosen is told from turned off (JOB-11)", () => {
  it("asks about a team kind the PM never chose, never about one they turned off or one the team requires", () => {
    const team = { categories: DEFAULT_TEAM.categories };
    const p: Pick<PersonalConfig, "categories" | "categoriesOff"> = { categories: [...BEFORE] };
    // A config from before the off list: every team kind its agent doesn't take is asked about.
    expect(kindsToChoose(p, team)).toEqual(["decision-brief"]);
    expect(kindsToChoose(p, { categories: { ...team.categories, "decision-brief": { skill: "pmx-decision-brief", required: true } } })).toEqual([]);
    chooseKind(p, "decision-brief", false);
    expect(p).toEqual({ categories: BEFORE, categoriesOff: ["decision-brief"] });
    expect(kindsToChoose(p, team)).toEqual([]);
    expect(takesCategory(p, team, "decision-brief")).toBe(false);
    chooseKind(p, "decision-brief", true);
    expect(p).toEqual({ categories: [...BEFORE, "decision-brief"], categoriesOff: [] });
    expect(takesCategory(p, team, "decision-brief")).toBe(true);
    // A kind the team adds later is asked about too, whoever added it.
    expect(kindsToChoose(p, { categories: { ...team.categories, "launch-note": { skill: "launch-note" } } })).toEqual(["launch-note"]);
  });

  it("says it in the PM's words, with the Ready tasks waiting for it", () => {
    expect(choiceLine({ kind: "decision-brief", ready: 2 })).toBe(LINE);
    expect(choiceLine({ kind: "tracking-hygiene", ready: 1 })).toBe("Your team has tracking hygiene. Your agent doesn't take it yet; 1 Ready task is waiting for that kind of work");
    expect(choiceLine({ kind: "spec", ready: 0 })).toBe("Your team has specs. Your agent doesn't take them yet");
  });
});

describe("a kind of work a teammate added reaches every PM (R7, JOB-11)", () => {
  beforeEach(freshHome);

  it("shows in Needs you, pmx status and the checklist until the PM chooses; keeping it off clears it for good", async () => {
    const { repo } = await pmxRepo({ tracker: LINEAR });
    // The team merged decision-brief; this PM chose their kinds before it existed.
    const ctx = await testCtx({ repo, team: { tracker: LINEAR }, personal: { categories: [...BEFORE] } });
    await savePersonalConfig(ctx.personal);
    await readyDecisionBriefs();

    const board = await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain });
    expect(board.kindsToChoose).toEqual([{ kind: "decision-brief", words: "decision briefs", ready: 2, text: LINE }]);
    expect(board.needsYou).toMatchObject({ choices: 1 });
    expect(needsLine(board.needsYou!)).toMatch(/1 kind of work to choose for your agent/);
    expect(board.rules.categories.find((c) => c.name === "decision-brief")).toEqual({ name: "decision-brief", accepted: false, required: false, toChoose: true });
    expect(board.rules.categories.find((c) => c.name === "spec")).toEqual({ name: "spec", accepted: true, required: false });
    // The shared level never carries it: it's this PM's own.
    expect((await loadPipeline(ctx, { level: "shared", hours: 168, keychain: ctx.keychain })).kindsToChoose).toBeUndefined();

    const status = (await runStatus(ctx)).split("\n");
    expect(status[0]).toMatch(/^Needs you: .*1 kind of work to choose for your agent/);
    expect(status).toContain(`  ${LINE}. Turn it on for your agent: pmx categories add decision-brief (or keep it off: pmx categories remove decision-brief).`);

    const step = kindsStep(checklist(ctx.personal, ctx.team, { "decision-brief": 2, spec: 1 }));
    expect(step).toMatchObject({ status: "todo", required: false, who: "you", how: "page", do: "pmx categories add decision-brief (or pmx categories remove decision-brief to keep it off)", fix: { kind: "page", to: "tab:needs" } });
    expect(step.detail).toBe("your team has decision briefs, and you haven't chosen whether your agent takes them, so it skips them; 2 Ready tasks are waiting for that kind of work");
    expect(step.page).toBe("Turn it on, or keep it off, in Needs you.");

    // Keep off: the same change Settings → Kinds of work saves.
    const r = await pipelineHandlers(ctx).changes([{ kind: "category", name: "decision-brief", accepted: false }], false);
    expect(r).toMatchObject({ status: 200, body: { applied: ["Stop taking decision-brief"] } });
    const saved = await loadPersonalConfig();
    expect(saved.categoriesOff).toEqual(["decision-brief"]);
    expect(takesCategory(saved, ctx.team, "decision-brief")).toBe(false);
    expect(ctx.personal.categoriesOff).toEqual(["decision-brief"]);
    const after = await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain });
    expect(after.kindsToChoose).toBeUndefined();
    expect(after.needsYou).toMatchObject({ choices: 0 });
    expect(after.rules.categories.find((c) => c.name === "decision-brief")).toEqual({ name: "decision-brief", accepted: false, required: false });
    expect(await runStatus(ctx)).not.toMatch(/decision brief|pmx categories add/);
    expect(kindsStep(checklist(saved, ctx.team, { "decision-brief": 2 }))).toMatchObject({ status: "done", detail: "your agent takes 8 of your team's 9 kinds of work" });
  });

  it("a PM who leaves a kind out at setup has chosen; nobody is asked about a required kind", async () => {
    const root = await tmp();
    const p = await runInit({
      ask: scriptedAsker({ "PMX repo checkout": join(root, "pmx"), "Team name": "acme", handle: "ana", "Linear team key": "", transcripts: join(root, "t"), "email domains": "acme.com", "Categories your agent accepts": "spec, problem-brief" }),
      keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, out: quietOut(), now: () => new Date("2026-11-26T00:00:00Z"), cliPath: "/x/cli.js",
    });
    const team = await loadTeamConfig(p.repoPath);
    const saved = await loadPersonalConfig();
    expect(saved.categories).toEqual(["spec", "problem-brief"]);
    expect(saved.categoriesOff).toEqual(Object.keys(team.categories).filter((k) => k !== "spec" && k !== "problem-brief"));
    expect(kindsToChoose(saved, team)).toEqual([]);
    expect(kindsStep(checklist(saved, team, null))).toMatchObject({ status: "done", detail: "your agent takes 2 of your team's 9 kinds of work" });
    // A kind the team adds after setup is asked about; one it requires never is.
    const added = { ...team, categories: { ...team.categories, "launch-note": { skill: "launch-note" } } } as TeamConfig;
    expect(kindsStep(checklist(saved, added, null))).toMatchObject({ status: "todo", detail: "your team has launch notes, and you haven't chosen whether your agent takes them, so it skips them" });
    const two = { ...added, categories: { ...added.categories, "tracking-hygiene": { skill: "pmx-hygiene" }, "stakeholder-update": { skill: "stakeholder-update" } } } as TeamConfig;
    const rest = { ...saved, categoriesOff: saved.categoriesOff!.filter((k) => k !== "tracking-hygiene") };
    expect(kindsStep(checklist(rest, two, { "tracking-hygiene": 1 })).detail).toBe("your team has tracking hygiene, launch notes or stakeholder updates, and you haven't chosen whether your agent takes them, so it skips them; 1 Ready task is waiting for those kinds of work");
    const req = { ...team, categories: { ...team.categories, "launch-note": { skill: "launch-note", required: true } } } as TeamConfig;
    expect(kindsStep(checklist(saved, req, null))).toMatchObject({ status: "done" });
  });

  it("pmx jobs add sends PMX's skill with the kind: the sender takes it, and every other PM is asked once it merges", async () => {
    const { repo } = await pmxRepo();
    // A team repo set up before decision briefs: no config line, and no copy of the skill.
    const cfgPath = join(repo, "pmx.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    delete cfg.categories["decision-brief"];
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await rm(join(repo, ".claude", "skills", "pmx-decision-brief"), { recursive: true });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "older team");
    const sender = await testCtx({ repo, team: { categories: cfg.categories }, personal: { categories: [...BEFORE] } });
    await savePersonalConfig(sender.personal);

    const out = await pmx("jobs", sender, ["add", "decision-brief"]);
    expect(out).toContain("PMX's skill for it (pmx-decision-brief) goes with it into your team's .claude/skills, unless your team has a copy already, so every Mac drafts it from the same reviewed text.");
    expect(out).toContain("Each teammate's Needs you and pmx status then ask whether their agent takes it (pmx categories add decision-brief, or Settings → Kinds of work).");
    const branch = (await git(repo, "branch", "--list", "pmx/settings-*", "--format=%(refname:short)")).split("\n").filter(Boolean).pop()!;
    expect(await git(repo, "show", `${branch}:.claude/skills/pmx-decision-brief/SKILL.md`)).toBe((await readFile(join(bundledSkillsDir(), "pmx-decision-brief", "SKILL.md"), "utf8")).trimEnd());
    expect(await git(repo, "show", `${branch}:.claude/skills/pmx-decision-brief/fixtures/sample-task.md`)).toBeTruthy();
    const merged = { ...sender.team, categories: JSON.parse(await git(repo, "show", `${branch}:pmx.config.json`)).categories } as TeamConfig;
    expect(merged.categories["decision-brief"]).toEqual({ skill: "pmx-decision-brief" });

    // Once it merges: the sender's agent takes it; a teammate who chose before it existed is asked.
    expect(kindsToChoose(await loadPersonalConfig(), merged)).toEqual([]);
    expect(takesCategory(await loadPersonalConfig(), merged, "decision-brief")).toBe(true);
    expect(kindsToChoose(personal(repo, { handle: "sam", categories: [...BEFORE] }), merged)).toEqual(["decision-brief"]);
  });
});

describe("pmx categories add and remove, and what pmx jobs says (JOB-11)", () => {
  beforeEach(freshHome);

  it("turns a kind on or off for this PM's agent exactly as Settings → Kinds of work does; pmx jobs lists which it takes and points there", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo, personal: { categories: [...BEFORE] } });
    await savePersonalConfig(ctx.personal);

    const list = await pmx("jobs", ctx, []);
    expect(list).toContain("Turn one on or off for your agent: pmx categories add <kind>, pmx categories remove <kind> (the same as Settings → Kinds of work on PMX's page).");
    expect(list).toMatch(/^decision-brief {2}· {2}· not chosen yet: your agent skips it until you choose {2}· {2}skill pmx-decision-brief/m);
    expect(list).toMatch(/^spec {2}· {2}✔ your agent takes it {2}· {2}skill pmx-spec/m);
    expect(list).toContain("You haven't chosen about decision-brief, so your agent skips it. Turn one on: pmx categories add decision-brief, or keep it off: pmx categories remove decision-brief");
    expect(await pmx("categories", ctx, [])).toContain("decision-brief  · not chosen yet: your agent skips it until you choose");

    expect(await pmx("categories", ctx, ["add", "decision-brief"])).toBe("Your agent takes decision-brief from its next run.");
    expect(await loadPersonalConfig()).toMatchObject({ categories: [...BEFORE, "decision-brief"], categoriesOff: [] });
    expect(await pmx("categories", ctx, ["remove", "spec"])).toBe("Your agent won't take spec, and PMX won't ask about it again. Turn it on any time: pmx categories add spec");
    const saved = await loadPersonalConfig();
    expect(saved.categories).not.toContain("spec");
    expect(saved.categoriesOff).toEqual(["spec"]);
    const after = await pmx("jobs", ctx, []);
    expect(after).toMatch(/^spec {2}· {2}· off: you turned it off/m);
    expect(after).toMatch(/^decision-brief {2}· {2}✔ your agent takes it/m);
    expect(after).not.toContain("You haven't chosen");
    expect(await pmx("categories", ctx, [])).toMatch(/^spec {2}· off: you turned it off$/m);

    // The page's switch saves the very same file.
    await freshHome();
    const page = await testCtx({ repo, personal: { categories: [...BEFORE] } });
    await savePersonalConfig(page.personal);
    await pipelineHandlers(page).changes([{ kind: "category", name: "decision-brief", accepted: true }, { kind: "category", name: "spec", accepted: false }], false);
    const fromPage = await loadPersonalConfig();
    expect({ categories: fromPage.categories, categoriesOff: fromPage.categoriesOff }).toEqual({ categories: saved.categories, categoriesOff: saved.categoriesOff });
  });

  it("says which kind, refuses a kind the team doesn't have, notes a required one, and pmx jobs on points to it", async () => {
    const { repo } = await pmxRepo();
    const categories = { ...Object.fromEntries(Object.entries(DEFAULT_TEAM.categories).filter(([k]) => k !== "decision-brief")), spec: { skill: "pmx-spec", required: true } };
    const ctx = await testCtx({ repo, team: { categories }, personal: { categories: BEFORE.filter((k) => k !== "spec") } });
    await savePersonalConfig(ctx.personal);
    const run = (name: string, p: string[]) => [...jobsCommands, ...settingsCommands].find((c) => c.name === name)!.run({ values: {}, positionals: p, ask: {} as never, cliPath: "", ctx: async () => ctx } as never);
    await expect(run("categories", ["add"])).rejects.toThrow(/^Say which kind of work: pmx categories add problem-brief\. Your team's are: /);
    await expect(run("categories", ["add", "decision-brief"])).rejects.toThrow("Your team doesn't have decision-brief yet, so no agent takes it. Send it to your team for approval: pmx jobs add decision-brief");
    await expect(run("categories", ["remove", "astrology"])).rejects.toThrow(/^Your team has no kind of work called astrology\. Its kinds of work are: problem-brief/);
    expect(await pmx("categories", ctx, ["remove", "spec"])).toBe("Saved: spec off for you. Your team requires it, so your agent still takes it; your choice counts if your team stops requiring it.");
    expect(takesCategory(await loadPersonalConfig(), ctx.team, "spec")).toBe(true);
    // One way to do it: `pmx jobs` has no on or off of its own, and says where it is.
    await expect(run("jobs", ["on", "build-brief"])).rejects.toThrow('Unknown subcommand "on". Use list, add, template or new. To turn a kind of work on or off for your agent: pmx categories add build-brief');
  });
});

describe("the page asks, and Keep off clears it (JOB-11)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("Needs you has the card with Turn on and Keep off, Settings says Not chosen yet, and Keep off saves the choice", async () => {
    ui = await openBoard({ hash: "needs", team: { tracker: LINEAR as any }, personal: { categories: [...BEFORE] }, before: readyDecisionBriefs });
    await ui.until(() => /Kinds of work to choose/.test(ui!.text("main")), "the card");
    const card = ui.all("main [role=listitem]").find((r) => r.textContent?.includes(LINE))!;
    expect(card).toBeTruthy();
    expect([...card.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Turn on", "Keep off"]);
    expect(ui.$("#b-needs")!.textContent).toBe(String(ui.all("main section.group [role=listitem]").length));

    await ui.go("#health/settings/kinds");
    await ui.until(() => /Not chosen yet/.test(ui!.text("main")), "Settings to say so");

    await ui.go("#needs");
    await ui.until(() => /Kinds of work to choose/.test(ui!.text("main")), "the card again");
    await ui.click(ui.button("Keep off", "main"));
    await ui.until(() => ui!.posts.some((p) => p[0] === "changes"), "the choice to be sent", 8000);
    expect(ui.posts.find((p) => p[0] === "changes")![1]).toEqual({ changes: [{ kind: "category", name: "decision-brief", accepted: false }], confirmLoosening: false });
    await ui.until(() => !/Kinds of work to choose/.test(ui!.text("main")), "the card to go", 8000);
    expect(await loadPersonalConfig()).toMatchObject({ categories: BEFORE, categoriesOff: ["decision-brief"] });
    // For good: a reload doesn't bring it back.
    await ui.reload("needs");
    await ui.until(() => ui!.$("main h1"), "the page");
    expect(ui.text("main")).not.toContain("Kinds of work to choose");
  }, 60000);
});

describe("doctor and a kind whose skill only PMX ships (R8, NEUT-2)", () => {
  beforeEach(freshHome);

  it("warns and names pmx skills update when the team has no copy, and fails only when neither the team nor PMX has it", async () => {
    const { repo } = await pmxRepo();
    await rm(join(repo, ".claude", "skills", "pmx-decision-brief"), { recursive: true });
    await git(repo, "add", "-A");
    await git(repo, "commit", "-qm", "a team copy that never had it");
    const team = { ...(await loadTeamConfig(repo)), categories: { ...DEFAULT_TEAM.categories, "launch-note": { skill: "launch-note" } } } as TeamConfig;
    const checks = await runDoctor({ personal: personal(repo), team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, engine: async () => [] });
    const by = (id: string) => checks.find((c) => c.id === id)!;
    expect(by("skill.pmx-spec")).toMatchObject({ ok: true, detail: "shared skill pmx-spec for spec in .claude/skills (NEUT-2)" });
    expect(by("skill.pmx-decision-brief")).toMatchObject({ ok: false, level: "warn" });
    expect(by("skill.pmx-decision-brief").detail).toBe("decision-brief runs PMX's built-in pmx-decision-brief: your team has no copy in .claude/skills, so each Mac uses the one its own PMX ships. Send it to your team so every Mac drafts from the same copy: `pmx skills update pmx-decision-brief` (NEUT-2)");
    expect(by("skill.launch-note")).toMatchObject({ ok: false, level: "fail" });
    expect(by("skill.launch-note").detail).toMatch(/^no skill launch-note for launch-note: it isn't in your team's \.claude\/skills or in PMX/);
    const lines = formatDoctor(checks).text.split("\n");
    expect(lines.find((l) => l.includes("PMX's built-in pmx-decision-brief"))).toMatch(/^\u001b\[33m!/);
    expect(lines.find((l) => l.includes("no skill launch-note"))).toMatch(/^\u001b\[31m✘/);

    // The suggested command sends PMX's copy to the team, and then the check passes.
    const ctx = await testCtx({ repo, team });
    const pr = await proposeTeamChanges(ctx, [checkChange({ kind: "skill-update", name: "pmx-decision-brief" }, ctx.team)]);
    await git(repo, "merge", "-q", "--ff-only", pr.branch);
    const again = await runDoctor({ personal: personal(repo), team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec: withClaude, engine: async () => [] });
    expect(again.find((c) => c.id === "skill.pmx-decision-brief")).toMatchObject({ ok: true });
  });
});
