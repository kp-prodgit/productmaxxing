import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TEAM } from "../src/core/config.js";
import { bundledSkillsDir, categoryMenu, listBundledSkills } from "../src/core/skills.js";
import { checkOutput, idsIn, parseRubric, skillMeta, skillName } from "../src/core/skillcheck.js";
import { SIZES, STAGES } from "../src/core/types.js";

/** Smoke tests for every bundled skill (SKILL-6). The live neutrality test is `pmx neutrality`. */
describe("skills pack", async () => {
  const skills = await listBundledSkills();

  it("has the core and v1 category skills (SKILL-3, SKILL-4)", () => {
    expect(skills).toEqual(expect.arrayContaining(["pmx-digest", "pmx-synthesize", "pmx-size", "pmx-pull", "pmx-research", "pmx-competitive", "pmx-hygiene", "pmx-spec"]));
    for (const { skill } of Object.values(DEFAULT_TEAM.categories)) expect(skills).toContain(skill);
  });

  for (const s of skills) {
    it(`${s}: valid frontmatter`, async () => {
      const text = await readFile(join(bundledSkillsDir(), s, "SKILL.md"), "utf8");
      expect(skillName(text)).toBe(s);
      expect(text).toMatch(/^description: .{20,}/m);
      const meta = skillMeta(text);
      if (meta.kind === "category") {
        expect(DEFAULT_TEAM.categories[meta.category!]?.skill).toBe(s);
        expect(meta.output).toBe(`outputs/${meta.category}/{id}.md`);
      }
    });

    it(`${s}: expected-output fixture passes the skill's checklist`, async () => {
      const dir = join(bundledSkillsDir(), s);
      const hasFixtures = await stat(join(dir, "fixtures")).then(() => true, () => false);
      const meta = skillMeta(await readFile(join(dir, "SKILL.md"), "utf8"));
      if (!hasFixtures) {
        expect(meta.kind).toBe("core");
        return;
      }
      const task = await readFile(join(dir, "fixtures", "sample-task.md"), "utf8");
      const expected = await readFile(join(dir, "fixtures", "expected.md"), "utf8");
      if (s === "pmx-synthesize") {
        const out = JSON.parse(expected);
        expect(out.tasks[0].sources.every((id: string) => idsIn(task).has(id))).toBe(true);
        return;
      }
      const ids = s === "pmx-digest" ? new Set(["T1"]) : idsIn(task);
      const r = checkOutput(meta, expected, ids);
      expect(r.problems).toEqual([]);
    });
  }

  it("every category skill names its lifecycle stage and has a size rubric row (CAT-2, CAT-4)", async () => {
    const rubric = parseRubric(await readFile(join(bundledSkillsDir(), "pmx-size", "SKILL.md"), "utf8"));
    for (const [category, { skill }] of Object.entries(DEFAULT_TEAM.categories)) {
      const meta = skillMeta(await readFile(join(bundledSkillsDir(), skill, "SKILL.md"), "utf8"));
      expect(STAGES, `${skill} stage`).toContain(meta.stage);
      for (const z of SIZES) expect(rubric.cells[category]?.[z], `${category} ${z}`).toBeTruthy();
    }
    expect(Object.keys(DEFAULT_TEAM.categories)).toEqual(expect.arrayContaining(["problem-brief", "build-brief", "validation-plan", "validation-readout"]));
  });

  it("product category skills share the drafting rules; validation counts only commitments (CAT-3, CAT-5)", async () => {
    for (const { skill } of Object.values(DEFAULT_TEAM.categories)) {
      if (skill === "pmx-hygiene") continue;
      const text = await readFile(join(bundledSkillsDir(), skill, "SKILL.md"), "utf8");
      expect(text, skill).toMatch(/^## Drafting rules$/m);
      expect(text, skill).toContain("What users ask for is a signal about their problem, never the requirement.");
      expect(text, skill).toContain("marked **PM decides**");
    }
    const plan = await readFile(join(bundledSkillsDir(), "pmx-validation-plan", "SKILL.md"), "utf8");
    expect(plan).toMatch(/paid pilot signed, a subscription/);
  });

  it("lists categories for the model with their descriptions, and by name when a skill is missing (CAT-2)", async () => {
    const menu = await categoryMenu("/nonexistent", { "problem-brief": { skill: "pmx-problem-brief" }, "win-loss": { skill: "pmx-win-loss" } });
    expect(menu).toMatch(/^- problem-brief: Problem brief\. States one customer problem/m);
    expect(menu).toMatch(/^- win-loss$/m);
  });

  it("checkOutput catches missing headings, thin citations and invented sources", () => {
    const r = checkOutput({ kind: "category", requiredHeadings: ["Summary", "Themes"], minCitations: 2 }, "# X\n## Summary\n- a [T9]\n", new Set(["T1"]));
    expect(r.problems).toEqual(['missing heading "Themes"', "only 1 citations, need 2", "cites unknown sources: T9"]);
  });
});
