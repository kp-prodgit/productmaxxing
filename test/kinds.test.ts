// A team's own kinds of work (JOB-8..10): the fill-in template, the pull request it becomes, required kinds, what
// synthesis is told, and the background pull that keeps every PM's checkout on the team's merged set.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEAM, takesCategory, type TeamConfig } from "../src/core/config.js";
import { checkKindDraft, kindTemplate, parseKindForm, renderKindFixture, renderKindSkill, upsertRubricRow } from "../src/core/kinds.js";
import { checkOutput, idsIn, parseRubric, skillMeta, validateEnv } from "../src/core/skillcheck.js";
import { bundledSkillsDir, categoryMenu, skillInventory, teamSkillPath } from "../src/core/skills.js";
import { checkChange, proposeTeamChanges, setRubricCell } from "../src/flow/actions.js";
import { splitDescription } from "../src/flow/pipeline.js";
import { selectTasks } from "../src/pull/select.js";
import { budget } from "../src/budget/provider.js";
import { teamSyncProblem, teamSyncStep } from "../src/commands/team-sync.js";
import { freshHome, git, personal, pmxRepo, testCtx, tmp } from "./helpers.js";

const team = { ...DEFAULT_TEAM, team: "t" } as TeamConfig;
const RAW = {
  name: "Stakeholder update",
  produces: "A one-page update for execs on what changed this week, what's at risk and what we need from them",
  when: "A meeting moves a date, changes scope, raises a risk or needs an exec decision",
  not: "Routine status with nothing changed",
  stage: "operate",
  sections: ["Headline", "What changed", "Risks", "Asks"],
  steps: ["Lead with the one change that matters most", "Give every risk a source", "Write each ask as a decision, marked PM decides"],
  checks: ["Nothing is promised to customers"],
  minCitations: 2,
  externalFacing: true,
  sizes: { S: "One change this week" },
};

describe("the kind-of-work template (JOB-8)", () => {
  it("checks a filled-in template and names it", () => {
    const { slug, draft } = checkKindDraft(RAW, team);
    expect(slug).toBe("stakeholder-update");
    expect(draft).toMatchObject({ stage: "operate", minCitations: 2, externalFacing: true, required: false, sizes: { S: "One change this week", M: expect.any(String) } });
    expect(() => checkKindDraft({ ...RAW, name: "PMX helper" }, team)).toThrow(/kept for PMX's own skills/);
    expect(() => checkKindDraft({ ...RAW, name: "Spec" }, team)).toThrow(/already has a kind of work called spec/);
    expect(() => checkKindDraft({ ...RAW, name: "Update. Now" }, team)).toThrow(/plain words/);
    expect(() => checkKindDraft({ ...RAW, steps: [] }, team)).toThrow(/at least one step/);
    expect(() => checkKindDraft({ ...RAW, sections: [] }, team)).toThrow(/at least one section/);
    expect(() => checkKindDraft({ ...RAW, stage: "launch" }, team)).toThrow(/stage is one of/);
    expect(() => checkKindDraft({ ...RAW, minCitations: 40 }, team)).toThrow(/0 to 10/);
    // Plain words only: nothing that would break a skill's frontmatter, a table or a heading.
    for (const name of ["*Weekly brief", "Brief: weekly", "[draft] brief", "日本語 brief", "Update #2"]) expect(() => checkKindDraft({ ...RAW, name }, team), name).toThrow(/plain words/);
    expect(checkKindDraft({ ...RAW, name: "Go/no-go review" }, team).slug).toBe("go-no-go-review");
    expect(checkKindDraft({ ...RAW, name: "Launch & GTM plan" }, team).slug).toBe("launch-gtm-plan");
    // A name that is already some kind's skill would replace that skill for it.
    expect(() => checkKindDraft({ ...RAW, name: "Acme launch" }, { categories: { ...team.categories, "launch-plan": { skill: "acme-launch" } } })).toThrow(/already has a skill called acme-launch/);
    // Names that only exist on Object.prototype aren't kinds of work.
    for (const name of ["constructor", "toString"]) {
      expect(() => checkChange({ kind: "kind-required", name, value: true }, team)).toThrow(/Unknown kind of work/);
      expect(() => checkChange({ kind: "rubric", category: name, size: "S", text: "abc" }, team)).toThrow(/Unknown category/);
      expect(() => checkChange({ kind: "category", name, accepted: true }, team)).toThrow(/Unknown category/);
    }
  });

  it("becomes a skill shaped like PMX's own: a document job whose checklist, stage and propose rules PMX reads", () => {
    const { slug, draft } = checkKindDraft(RAW, team);
    const text = renderKindSkill(slug, draft);
    const meta = skillMeta(text) as any;
    expect(meta).toMatchObject({ kind: "category", category: slug, stage: "operate", output: "outputs/stakeholder-update/{id}.md", requiredHeadings: ["Headline", "What changed", "Risks", "Asks"], minCitations: 2, propose: { when: RAW.when, not: RAW.not } });
    expect(validateEnv(meta.env)).toEqual([]);
    // The description is double-quoted, so ": " and " #" in what a PM typed stay valid YAML, and PMX reads it back.
    const tricky = renderKindSkill(slug, { ...draft, produces: "For execs: what changed, what's at risk #weekly \"quoted\"" });
    expect(tricky).toMatch(/^description: "Stakeholder update\. For execs: what changed, what's at risk #weekly \\"quoted\\"\."$/m);
    expect(splitDescription(slug, JSON.parse(text.match(/^description: (.*)$/m)![1]!))).toEqual({ name: "Stakeholder update", produces: `${RAW.produces}.` });
    expect(text).toMatch(/## Steps\n\n1\. Lead with the one change that matters most\.\n2\./);
    expect(text).toMatch(/Never send, post or publish anything/);
    expect(text).toMatch(/- \[ \] Nothing is promised to customers\./);
    // A draft written to the skill's own checklist passes it, with the sample task's sources.
    const fixture = renderKindFixture(slug, draft);
    const out = "# x\n\n## Headline\nA [T1]\n\n## What changed\nB [T2]\n\n## Risks\nC\n\n## Asks\nD\n";
    expect(checkOutput(meta, out, idsIn(fixture)).ok).toBe(true);
    expect(checkOutput(meta, "# x\n\n## Headline\nA\n", idsIn(fixture)).problems).toEqual(expect.arrayContaining([expect.stringMatching(/missing heading "Risks"/), expect.stringMatching(/only 0 citations/)]));
  });

  it("the fill-in file reads back into the same kind of work", () => {
    const filled = kindTemplate()
      .replace("## Name\n> Two to five words, like \"Stakeholder update\" or \"Prototype brief\".\n", "## Name\n> help\nStakeholder update\n")
      .replace("## What it produces\n> One or two sentences: what a finished draft is and who it's for.\n", `## What it produces\n${RAW.produces}\n`)
      .replace("## Propose it when\n> What in a meeting or channel should make PMX suggest this work.\n", `## Propose it when\n${RAW.when}\n`)
      .replace("identify\n", "operate\n")
      .replace("- Summary\n", RAW.sections.map((s) => `- ${s}`).join("\n") + "\n")
      .replace("## Steps the agent follows\n> One per line, in order.\n-\n", `## Steps the agent follows\n${RAW.steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}\n`)
      .replace("## Goes outside the team\n> yes or no. Yes means a person always sends it; agents never do.\nno", "## Goes outside the team\nyes")
      .replace("S:\n", "S: One change this week\n");
    const { slug, draft } = checkKindDraft(parseKindForm(filled), team);
    expect(slug).toBe("stakeholder-update");
    expect(draft).toMatchObject({ stage: "operate", sections: RAW.sections, steps: RAW.steps, externalFacing: true, required: false, minCitations: 1, sizes: { S: "One change this week" } });
    // The blank template doesn't pass: it asks for a name first.
    expect(() => checkKindDraft(parseKindForm(kindTemplate()), team)).toThrow(/The name is 3 to 40 characters/);
  });

  it("adds a size rubric row PMX reads, and a missing row no longer breaks editing a size", () => {
    const rubric = "## Per category\n\n| Category | S | M | L | XL |\n|---|---|---|---|---|\n| spec | a | b | c | d |\n\nWhen unsure, pick the larger.";
    const withRow = upsertRubricRow(rubric, "stakeholder-update", { S: "One change", M: "A week", L: "A launch", XL: "A program" });
    expect(parseRubric(withRow).cells["stakeholder-update"]).toEqual({ S: "One change", M: "A week", L: "A launch", XL: "A program" });
    expect(withRow).toMatch(/\| stakeholder-update \| One change \| A week \| A launch \| A program \|\n\nWhen unsure/);
    expect(parseRubric(setRubricCell(rubric, "win-loss", "M", "Five deals")).cells["win-loss"]!.M).toBe("Five deals");
  });
});

describe("a new kind of work goes to the team as one pull request (JOB-8)", () => {
  it("writes the skill, its sample task, the rubric row and the config line on a branch; the PM's checkout is untouched", async () => {
    await freshHome();
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const before = await ctx.repo.head();
    const change = checkChange({ kind: "new-kind", draft: { ...RAW, required: true } }, ctx.team);
    const r = await proposeTeamChanges(ctx, [change]);
    expect(await ctx.repo.head()).toBe(before);
    const show = (p: string) => ctx.repo.ok(["show", `${r.branch}:${p}`]);
    const cfg = JSON.parse(await show("pmx.config.json"));
    expect(cfg.categories["stakeholder-update"]).toEqual({ skill: "stakeholder-update", externalFacing: true, required: true });
    expect(Object.keys(cfg.categories)).toEqual(expect.arrayContaining(Object.keys(DEFAULT_TEAM.categories)));
    expect(skillMeta(await show(".claude/skills/stakeholder-update/SKILL.md"))).toMatchObject({ category: "stakeholder-update" });
    expect(await show(".claude/skills/stakeholder-update/fixtures/sample-task.md")).toMatch(/\[T2\]/);
    expect(await show(".claude/skills/pmx-size/SKILL.md")).toMatch(/\| stakeholder-update \| One change this week \|/);
    expect(await ctx.repo.ok(["log", "-1", "--format=%s", r.branch])).toBe("New kind of work: Stakeholder update");

    // Once it merges, PMX loads it like any team kind of work: the board's model, synthesis's menu and the inventory.
    await git(repo, "merge", "-q", r.branch);
    const merged = { ...ctx.team, categories: cfg.categories };
    const inv = await skillInventory(repo, merged.categories);
    const info = inv.find((s) => s.name === "stakeholder-update")!;
    expect(info).toMatchObject({ runs: "team", status: "team only", envProblems: [], propose: { when: RAW.when, not: RAW.not } });
    expect(splitDescription("stakeholder-update", info.description)).toEqual({ name: "Stakeholder update", produces: `${RAW.produces}.` });
    const menu = await categoryMenu(repo, merged.categories);
    expect(menu).toMatch(/- stakeholder-update: Stakeholder update\. A one-page update/);
    expect(menu).toMatch(/  Propose it when: A meeting moves a date/);
    expect(menu).toMatch(/  Don't propose it when: Routine status/);

    // A second one with the same name is refused against the branch's config, not only this Mac's.
    await expect(proposeTeamChanges({ ...ctx, team: merged } as any, [{ kind: "new-kind", slug: "stakeholder-update", draft: checkKindDraft(RAW, team).draft }])).rejects.toThrow(/already has a kind of work called stakeholder-update/);
  });

  it("requiring a kind of work is a team change too, and can be undone", async () => {
    await freshHome();
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const r = await proposeTeamChanges(ctx, [checkChange({ kind: "kind-required", name: "spec", value: true }, ctx.team)]);
    expect(JSON.parse(await ctx.repo.ok(["show", `${r.branch}:pmx.config.json`])).categories.spec).toEqual({ skill: "pmx-spec", required: true });
    expect(() => checkChange({ kind: "kind-required", name: "nope", value: true }, ctx.team)).toThrow(/Unknown kind of work/);
  });
});

describe("required kinds of work are the same for every PM (JOB-9)", () => {
  it("an agent takes a required kind even if its PM never switched it on", () => {
    const t = { ...team, categories: { ...team.categories, "stakeholder-update": { skill: "stakeholder-update", required: true } } } as TeamConfig;
    const p = personal("/r", { categories: ["spec"] });
    expect(takesCategory(p, t, "stakeholder-update")).toBe(true);
    expect(takesCategory(p, t, "competitive-analysis")).toBe(false);
    expect(takesCategory(p, t, "gone")).toBe(false);
    const now = new Date(2026, 10, 4, 10, 0);
    const task = (id: string, category: string) => ({ id, identifier: id, title: id, description: "", url: "", category, size: "S" as const, status: "ready" as const, priority: 2, agent: null, sources: [], prUrl: null, createdAt: "2026-11-01T00:00:00Z" });
    const s = selectTasks({
      tasks: [task("A", "stakeholder-update"), task("B", "competitive-analysis")], agent: "a@m", personal: p, team: t, now,
      budget: budget(p, t, { ledger: {}, lastDigestWeek: null, lastSynthAt: null, eeTrialStartedAt: null, lastEventSyncAt: null } as any, now),
      inReview: 0, pausedCategories: new Map(), leasedTaskIds: new Set(),
    });
    expect(s.candidates.map((x) => x.id)).toEqual(["A"]);
  });
});

describe("every PM's checkout follows the team's repo (JOB-10)", () => {
  it("fast-forwards a clean checkout on the default branch and names the new kinds of work; never touches other branches", async () => {
    await freshHome();
    const { repo, origin } = await pmxRepo({}, { remote: true });
    const ctx = await testCtx({ repo });
    // A teammate merges a new kind of work.
    const other = await tmp("pmx-teammate-");
    await git(other, "clone", "-q", origin!, ".");
    await git(other, "config", "user.email", "t@example.com");
    await git(other, "config", "user.name", "T");
    const cfgPath = join(other, "pmx.config.json");
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    cfg.categories = { ...(cfg.categories ?? DEFAULT_TEAM.categories), "win-loss": { skill: "win-loss" } };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await git(other, "commit", "-qam", "Add win-loss");
    await git(other, "push", "-q", "origin", "main");

    expect(await teamSyncStep(ctx)).toBe("team repo: pulled the latest main; new kinds of work from your team: win-loss");
    expect(JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8")).categories["win-loss"]).toEqual({ skill: "win-loss" });
    // At most every ten minutes.
    expect(await teamSyncStep(ctx)).toBeNull();

    // A file Finder leaves behind doesn't stop it.
    await writeFile(join(repo, ".DS_Store"), "x");
    cfg.categories["exec-brief"] = { skill: "exec-brief" };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await git(other, "commit", "-qam", "Add exec-brief");
    await git(other, "push", "-q", "origin", "main");
    const t2 = await testCtx({ repo, now: new Date("2026-11-06T10:20:00Z") });
    expect(await teamSyncStep(t2)).toMatch(/new kinds of work from your team: .*exec-brief/);

    // A merged config this pmx can't load is never taken: the checkout keeps the one that works, and says why.
    cfg.categories["Bad Name"] = { skill: "x" };
    await writeFile(cfgPath, JSON.stringify(cfg, null, 2));
    await git(other, "commit", "-qam", "Break the config");
    await git(other, "push", "-q", "origin", "main");
    const t3 = await testCtx({ repo, now: new Date("2026-11-06T10:40:00Z") });
    expect(await teamSyncStep(t3)).toMatch(/not taking the latest main, its pmx\.config\.json doesn't load \(pmx\.config\.json: category Bad Name/);
    expect(JSON.parse(await readFile(join(repo, "pmx.config.json"), "utf8")).categories["Bad Name"]).toBeUndefined();
    const { loadState: ls } = await import("../src/core/state.js");
    expect(teamSyncProblem(await ls(), new Date("2026-11-06T12:00:00Z"))).toBeNull();
    expect(teamSyncProblem(await ls(), new Date("2026-11-08T12:00:00Z"))).toMatch(/hasn't picked up your team's merged changes since 2026-11-06 10:20 \(refused:/);

    // On a branch of the PM's own, it leaves the checkout alone.
    const later = await testCtx({ repo, now: new Date("2026-11-06T11:30:00Z") });
    await git(repo, "checkout", "-q", "-b", "my-edit");
    expect(await teamSyncStep(later)).toBeNull();
    const { loadState } = await import("../src/core/state.js");
    expect((await loadState()).teamSync?.result).toMatch(/skipped: on branch my-edit/);
  });
});

describe("company kinds of work never ship in the package", () => {
  it("every skill bundled with pmx is PMX's own (pmx- prefix)", async () => {
    const names = (await readdir(bundledSkillsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n) => !n.startsWith("pmx-"))).toEqual([]);
    expect(teamSkillPath("/repo", "stakeholder-update")).toBe("/repo/.claude/skills/stakeholder-update/SKILL.md");
  });
});
