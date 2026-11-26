// Bridge 4 of joining PMX and PMX Engine (EQ-38): open roadmap theme names as Linear labels. The themes come only from
// memory/engine/themes.json in the team's repo; synthesis may suggest one, the PM keeps, changes or clears it, and it
// becomes a pmx-theme label only if the theme is still open when the PM approves.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { runDoctor } from "../src/commands/doctor.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { services } from "../src/core/services.js";
import { pipelineAct } from "../src/flow/pipeline-act.js";
import { pipelineHandlers } from "../src/flow/pipeline-handlers.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { approveProposals, CHECKED, formatProposals, readProposals, setProposalTheme, stageProposals } from "../src/synth/proposals.js";
import { parseCandidates, synthesize } from "../src/synth/synthesize.js";
import { readThemes, themeBlock, themeNamed } from "../src/synth/themes.js";
import { relayDir, readOutbox, relayTracker } from "../src/tracker/relay.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

const THEMES = { format: 1, themes: [{ id: "b-rth1", name: "Foundational technology" }, { id: "b-rth3", name: "Field capture" }] };

async function withThemes(repo: string, file: unknown = THEMES): Promise<void> {
  await mkdir(join(repo, "memory", "engine"), { recursive: true });
  await writeFile(join(repo, "memory", "engine", "themes.json"), typeof file === "string" ? file : JSON.stringify(file));
}

const proposal = (title: string, theme?: string) => ({
  at: "2026-11-18T09:00:00Z", receipt: "synthesize-none", title, description: "d", category: "spec", size: "S" as const, sources: ["T1"], from: [], checked: CHECKED, ...(theme ? { theme } : {}),
});

describe("roadmap themes from the team's repo (EQ-38)", () => {
  beforeEach(freshHome);

  it("reads only themes.json at a format it knows, and only short plain names", async () => {
    const { repo } = await pmxRepo();
    expect(await readThemes(repo)).toEqual({ themes: [], format: null });
    await withThemes(repo, { format: 1, themes: [
      ...THEMES.themes,
      { id: "b-rth9", name: "field capture" },
      { id: "b-long", name: "x".repeat(61) },
      { id: "nope", name: "Bad ID" },
      { id: "b-rth8", name: "Two\nlines" },
      { id: "b-rth7", name: " Padded " },
    ] });
    expect((await readThemes(repo)).themes).toEqual(THEMES.themes);
    await withThemes(repo, { format: 2, themes: THEMES.themes });
    expect(await readThemes(repo)).toEqual({ themes: [], format: 2 });
    await withThemes(repo, "not json");
    expect(await readThemes(repo)).toEqual({ themes: [], format: 0 });

    expect(themeNamed("FIELD CAPTURE", THEMES.themes)).toBe("Field capture");
    expect(themeNamed("Field", THEMES.themes)).toBeNull();
    expect(themeBlock([])).toBe("");
    expect(themeBlock(THEMES.themes)).toMatch(/## Roadmap themes[\s\S]*- Foundational technology\n- Field capture$/);
  });

  it("keeps a suggested theme only when it is open, spelled as the theme spells it", () => {
    const reply = JSON.stringify({ tasks: [
      { title: "Offline photo capture", category: "spec", size: "M", rationale: "Crews lose photos without signal.", sources: ["T1"], support: { T1: "The customer loses photos offline." }, theme: "field capture" },
      { title: "Risk scores", category: "spec", size: "M", rationale: "Owners want a risk view.", sources: ["T1"], support: { T1: "The customer asks for risk views." }, theme: "Asset risk insights" },
      { title: "CSV export", category: "spec", size: "S", rationale: "Admins export by hand.", sources: ["T1"], support: { T1: "The customer exports weekly." } },
    ] });
    const r = parseCandidates(reply, ["spec"], new Set(["T1"]), undefined, new Map(), { themes: THEMES.themes });
    expect(r.tasks.map((t) => [t.title, t.theme ?? null])).toEqual([["Offline photo capture", "Field capture"], ["Risk scores", null], ["CSV export", null]]);
    expect(r.skipped).toEqual(["Risk scores: kept without a theme, because its theme isn't one of your team's open roadmap themes"]);
    expect(parseCandidates(reply, ["spec"], new Set(["T1"])).tasks.every((t) => !t.theme)).toBe(true);
  });

  async function synthOnce(themes: boolean) {
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    if (themes) await withThemes(repo);
    const dir = await tmp("t-");
    await writeTranscript(dir, "acme.md", "---\ntitle: Acme\nparticipants: jane@acme.com, kp@us.com\n---\nJane: Our crews lose site photos when there is no signal.");
    const runtime = mockRuntime(() => JSON.stringify({ tasks: [{ title: "Offline photo capture", category: "spec", size: "M", rationale: "Crews lose photos where there is no signal.", sources: ["T1"], support: { T1: "The customer loses photos offline." }, theme: "Field capture" }] }));
    const ctx = await testCtx({ repo, runtime, team: { internalDomains: ["us.com"] }, personal: { sources: { transcriptDirs: [dir], slackChannel: null } } });
    await synthesize(ctx, await services(ctx, { tracker: memoryTracker([]) }), { days: 7 });
    return { prompt: runtime.calls[0]!.prompt, proposals: await readProposals() };
  }

  it("synthesis offers no themes when the team has none, and the prompt is as before", async () => {
    const r = await synthOnce(false);
    expect(r.prompt).not.toContain("Roadmap themes");
    expect(r.proposals.map((p) => p.theme ?? null)).toEqual([null]);
  });

  it("synthesis offers the team's open themes, and stages the one it suggests", async () => {
    const r = await synthOnce(true);
    expect(r.prompt).toContain("## Roadmap themes");
    expect(r.prompt).toContain("- Field capture");
    expect(r.proposals[0]!.theme).toBe("Field capture");
    expect(formatProposals(r.proposals)).toContain("labels pmx-status: inbox, pmx-category, pmx-size, pmx-theme: Field capture");
  });

  it("the PM sets, changes or clears a theme, and only an open one", async () => {
    const { repo } = await pmxRepo();
    await withThemes(repo);
    await stageProposals([proposal("Offline photo capture", "Field capture"), proposal("CSV export")]);
    expect((await setProposalTheme(repo, ["2"], "foundational technology")).theme).toBe("Foundational technology");
    await setProposalTheme(repo, ["1"], null);
    expect((await readProposals()).map((p) => p.theme ?? null)).toEqual([null, "Foundational technology"]);
    await expect(setProposalTheme(repo, ["1"], "Asset risk insights")).rejects.toThrow(/isn't one of your team's open roadmap themes: Foundational technology, Field capture/);
    expect((await setProposalTheme(repo, ["9"], "Field capture")).missing).toEqual(["9"]);
  });

  it("an approved theme becomes a pmx-theme label, unless it stopped being open", async () => {
    const { repo } = await pmxRepo();
    await withThemes(repo);
    await stageProposals([proposal("Offline photo capture", "Field capture"), proposal("Shared asset record", "Foundational technology"), proposal("CSV export")]);
    const tracker = memoryTracker([]);
    const ctx = await testCtx({ repo });
    const svc = await services(ctx, { tracker });
    // The head of product held "Foundational technology" since synthesis suggested it.
    await withThemes(repo, { format: 1, themes: [THEMES.themes[1]] });
    const r = await approveProposals(ctx, svc, ["all"]);
    expect(r.posted.map((p) => [p.title, p.theme ?? null])).toEqual([["Offline photo capture", "Field capture"], ["Shared asset record", null], ["CSV export", null]]);
    expect(r.unthemed).toEqual(['Shared asset record: "Foundational technology" is no longer an open roadmap theme, so it went without one']);
    expect([...tracker.tasks.values()].map((t) => t.theme ?? null)).toEqual(["Field capture", null, null]);
  });

  it("the Workspace page shows the themes and changes one through the same door", async () => {
    const { repo } = await pmxRepo();
    await withThemes(repo);
    await stageProposals([proposal("Offline photo capture")]);
    const ctx = await testCtx({ repo });
    const handlers = pipelineHandlers(ctx);
    const [p] = await readProposals();
    expect(await pipelineAct(handlers, "proposal-theme", { id: p!.id, theme: "Field capture" })).toEqual([200, { message: "Theme: Field capture.", theme: "Field capture" }]);
    expect((await pipelineAct(handlers, "proposal-theme", { id: p!.id, theme: "Made up" }))[0]).toBe(400);
    expect((await pipelineAct(handlers, "proposal-theme", { id: p!.id, theme: 3 }))[0]).toBe(400);
    expect((await pipelineAct(handlers, "proposal-theme", { id: "pnothere", theme: null }))[0]).toBe(404);
    const data = await handlers.data(24);
    expect(data.themes).toEqual(["Foundational technology", "Field capture"]);
    expect(data.proposals.map((x) => x.theme)).toEqual(["Field capture"]);
  });

  it("through the Claude relay, the theme rides on a set-label every relay task already applies", async () => {
    const team = { ...DEFAULT_TEAM, team: "t", tracker: { kind: "linear", teamKey: "PMX", projectId: "proj-1" } } as TeamConfig;
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [] }));
    const t = relayTracker(team);
    const created = await t.createInbox({ title: "Offline photo capture", description: "d", category: "spec", size: "M", sources: [], theme: "Field capture" });
    const ops = (await readOutbox()).ops;
    expect(ops.map((o) => o.kind)).toEqual(["create-task", "set-label"]);
    expect(ops[1]).toMatchObject({ target: `ref:${ops[0]!.id}`, group: "pmx-theme", value: "Field capture" });
    expect(created.theme).toBe("Field capture");
  });

  it("pmx doctor says when themes.json is at a format this pmx can't read", async () => {
    const { repo } = await pmxRepo();
    const ctx = await testCtx({ repo });
    const doctor = async () => (await runDoctor({ personal: ctx.personal, team: ctx.team, keychain: memoryKeychain(), launchd: fakeLaunchd(), exec, engine: async () => [] })).find((c) => c.id === "repo.engine-themes");
    expect(await doctor()).toBeUndefined();
    await withThemes(repo);
    expect(await doctor()).toBeUndefined();
    await withThemes(repo, { format: 2, themes: [] });
    expect(await doctor()).toMatchObject({ ok: false, level: "warn", detail: expect.stringMatching(/format this pmx can't read \(2\)/) });
  });
});
