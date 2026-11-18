import { describe, expect, it } from "vitest";
import { verifySkill } from "../src/core/skills.js";
import { DEFAULT_TEAM, validateTeamConfig, type TeamConfig } from "../src/core/config.js";

const org = (version: string) => ({ source: "org" as const, version });
const base = (over: Partial<TeamConfig>): TeamConfig => ({ ...DEFAULT_TEAM, team: "t", ...over }) as TeamConfig;

describe("org-skill hash allowlist (JOB, tiered trust)", () => {
  it("allows team and bundled skills regardless of the allowlist (git already reviews them)", () => {
    expect(verifySkill({ x: "aaaaaaaaaaaa" }, "x", { source: "team", version: "zzzzzzzzzzzz" })).toMatchObject({ ok: true, allowlisted: false });
    expect(verifySkill({ x: "aaaaaaaaaaaa" }, "x", { source: "bundled", version: "zzzzzzzzzzzz" }).ok).toBe(true);
  });

  it("lets a synced skill run as-is when no allowlist is set (default tier)", () => {
    expect(verifySkill(undefined, "ux-audit", org("aaaaaaaaaaaa"))).toMatchObject({ ok: true, allowlisted: false });
    expect(verifySkill(null, "ux-audit", org("aaaaaaaaaaaa"))).toMatchObject({ ok: true, allowlisted: false });
  });

  it("when an allowlist is set, a synced skill must be pinned to its exact hash (fail closed)", () => {
    expect(verifySkill({ "ux-audit": "aaaaaaaaaaaa" }, "ux-audit", org("aaaaaaaaaaaa"))).toMatchObject({ ok: true, allowlisted: true });
    const mismatch = verifySkill({ "ux-audit": "aaaaaaaaaaaa" }, "ux-audit", org("bbbbbbbbbbbb"));
    expect(mismatch.ok).toBe(false);
    expect(mismatch.reason).toMatch(/not the allowlisted/);
    const missing = verifySkill({ other: "aaaaaaaaaaaa" }, "ux-audit", org("aaaaaaaaaaaa"));
    expect(missing.ok).toBe(false);
    expect(missing.reason).toMatch(/not in the hash allowlist/);
  });

  it("validateTeamConfig accepts 12-hex hashes and rejects anything else", () => {
    expect(() => validateTeamConfig(base({ skills: { "ux-audit": "abcdef012345" } }))).not.toThrow();
    expect(() => validateTeamConfig(base({ skills: { "ux-audit": "nothex" } }))).toThrow(/12-hex/);
    expect(() => validateTeamConfig(base({ skills: { "ux-audit": "ABCDEF012345" } }))).toThrow(/12-hex/); // must be lowercase hex
  });
});
