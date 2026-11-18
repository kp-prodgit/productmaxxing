import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { syncOrgSkills } from "../src/core/org-skills.js";
import { loadSkill, orgSkillPath, skillInventory, teamSkillPath } from "../src/core/skills.js";
import { paths } from "../src/core/paths.js";
import { freshHome } from "./helpers.js";

async function writeExport(file: string, pmx: Record<string, unknown>, opts: { name?: string; body?: string } = {}): Promise<void> {
  const dir = paths.orgSkillsExport();
  await mkdir(dir, { recursive: true });
  const name = opts.name ?? file;
  const body = opts.body ?? `# ${name}\n\n## Summary\n\nx\n`;
  await writeFile(join(dir, `${file}.md`), `---\nname: ${name}\ndescription: ${name} is an org skill for tests, long enough to pass.\npmx: ${JSON.stringify(pmx)}\n---\n${body}`);
}
const doc = (category: string, extra: Record<string, unknown> = {}) => ({ kind: "category", category, stage: "identify", output: `outputs/${category}/{id}.md`, env: { kind: "document", ...extra } });

describe("org skills synced from Linear (JOB, tiered trust)", () => {
  beforeEach(freshHome);

  it("adopts a valid document skill into the cache; loadSkill then sees it as 'org'", async () => {
    await writeExport("ux-audit", doc("ux-audit"));
    const r = await syncOrgSkills();
    expect(r.adopted).toEqual(["ux-audit"]);
    expect(r.rejected).toEqual([]);
    const s = await loadSkill("/nonexistent", "ux-audit");
    expect(s.source).toBe("org");
  });

  it("loader precedence is team > org > bundled", async () => {
    await writeExport("ux-audit", doc("ux-audit"));
    await syncOrgSkills();
    // org beats bundled (ux-audit has no team copy here):
    expect((await loadSkill("/nonexistent", "ux-audit")).source).toBe("org");
    // a team copy (PR-reviewed) beats the org copy:
    const repo = join(paths.home(), "fake-repo");
    const teamPath = teamSkillPath(repo, "ux-audit");
    await mkdir(dirname(teamPath), { recursive: true });
    await writeFile(teamPath, `---\nname: ux-audit\ndescription: the team's reviewed copy, long enough to pass.\npmx: ${JSON.stringify(doc("ux-audit"))}\n---\n# team\n`);
    expect((await loadSkill(repo, "ux-audit")).source).toBe("team");
  });

  it("skillInventory lists an org skill as 'org only' with its env", async () => {
    await writeExport("ux-audit", doc("ux-audit"));
    await syncOrgSkills();
    const inv = await skillInventory("/nonexistent", { "ux-audit": { skill: "ux-audit" } });
    const s = inv.find((x) => x.name === "ux-audit")!;
    expect(s.runs).toBe("org");
    expect(s.status).toBe("org only");
    expect(s.env.kind).toBe("document");
    expect(s.envProblems).toEqual([]);
  });

  it("refuses non-document, tool-widening, reserved, built-in-shadowing and mismatched skills (tiered trust)", async () => {
    await writeExport("proto-maker", doc("proto-maker", { kind: "prototype", tools: ["Read", "Bash"] }));
    await writeExport("bad-tools", doc("bad-tools", { tools: ["Read", "Bash"] }));
    await writeExport("pmx-evil", doc("pmx-evil"), { name: "pmx-evil" });
    await writeExport("pmx-spec", doc("pmx-spec"), { name: "pmx-spec" });
    await writeExport("mismatch", doc("other-name"), { name: "other-name" });
    const r = await syncOrgSkills();
    expect(r.adopted).toEqual([]);
    const names = r.rejected.map((x) => x.name);
    expect(names).toEqual(expect.arrayContaining(["proto-maker", "bad-tools", "pmx-evil", "pmx-spec", "other-name"]));
    await expect(loadSkill("/nonexistent", "proto-maker")).rejects.toThrow();
  });

  it("reject-and-keep-prior: a later invalid export never overwrites the adopted copy", async () => {
    await writeExport("keeper", doc("keeper"));
    expect((await syncOrgSkills()).adopted).toContain("keeper");
    await writeExport("keeper", doc("keeper", { tools: ["Bash"] })); // now invalid (document widening)
    const r2 = await syncOrgSkills();
    expect(r2.adopted).not.toContain("keeper");
    expect(r2.rejected.map((x) => x.name)).toContain("keeper");
    expect((await loadSkill("/nonexistent", "keeper")).source).toBe("org"); // prior copy survives
  });

  it("an absent export is a no-op (offline/empty)", async () => {
    const r = await syncOrgSkills();
    expect(r).toMatchObject({ adopted: [], rejected: [] });
    expect(r.from).toBe(paths.orgSkillsExport());
  });

  it("refuses an oversized (possibly truncated) skill", async () => {
    await writeExport("huge", doc("huge"), { body: `# huge\n\n## Summary\n\n${"x".repeat(70 * 1024)}\n` });
    const r = await syncOrgSkills();
    expect(r.adopted).toEqual([]);
    expect(r.rejected[0]!.reasons.join(" ")).toMatch(/truncated|larger than/);
  });
});
