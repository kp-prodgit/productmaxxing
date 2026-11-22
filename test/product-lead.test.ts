// INSTALL-4: PMX is for every PM; PMX Engine is for the team's product lead, and the team names its product lead in its
// settings (pmx.config.json, changed only through review). PMX uses that only to decide whether to offer Engine: the
// checklist's Engine step is the lead's to do and nobody else's, `pmx status` says who it is, and the page's Settings
// sends a change to the team like every other team setting. Nothing here installs anything.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runStatus } from "../src/commands/status.js";
import { DEFAULT_TEAM, isProductLead, validateTeamConfig, type PersonalConfig, type TeamConfig } from "../src/core/config.js";
import type { Exec } from "../src/core/exec.js";
import { checkChange, describe as describeChange, isTeamChange } from "../src/flow/actions.js";
import { buildChecklist, checklistForPage, type Checklist } from "../src/setup/checklist.js";
import { FIXES, runFix } from "../src/setup/fix.js";
import { currentVersion } from "../src/core/version.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";
import { openBoard, pageText, type Ui } from "./ui-helpers.js";

const team = (productLead?: string | null): TeamConfig => ({ ...DEFAULT_TEAM, team: "acme", ...(productLead === undefined ? {} : { productLead }) } as TeamConfig);
const me = { handle: "ana", machineId: "m1", repoPath: "/r", installedAt: "2026-11-01T00:00:00Z" } as PersonalConfig;
const engineStep = (cl: Checklist) => cl.sections.find((s) => s.id === "engine")!.steps.find((s) => s.id === "engine.installed")!;
const checklist = (t: TeamConfig | null, o: { personal?: PersonalConfig | null; engine?: { version: string; checklist: unknown } | null } = {}) => buildChecklist({
  now: new Date("2026-11-21T10:00:00Z"), version: currentVersion(), personal: o.personal === undefined ? me : o.personal, team: t, checks: [{ id: "os.macos", ok: true, detail: "macOS", level: "fail" }],
  state: { lastTick: null, collectReports: [] } as any, claude: true, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null, practiceUntil: null, lastRun: null,
  setupSkill: "current", linearCron: null, engine: o.engine ?? null, extra: [],
});

describe("the product lead, a team setting (INSTALL-4)", () => {
  it("is null by default, a PMX handle (or agent handle) when set, and anything else is refused", () => {
    expect(DEFAULT_TEAM.productLead).toBeNull();
    for (const v of [null, "ana", "ana@m1", "kp-2"]) expect(validateTeamConfig(team(v)).productLead).toBe(v);
    expect(validateTeamConfig({ ...DEFAULT_TEAM, team: "acme" } as TeamConfig).productLead).toBeNull();
    for (const v of ["", "two words", "ana; rm -rf", 7]) expect(() => validateTeamConfig(team(v as any)), String(v)).toThrow(/productLead must be a PMX handle/);
    expect(isProductLead(team("ana"), me)).toBe(true);
    expect(isProductLead(team("ana@m1"), me)).toBe(true);
    expect(isProductLead(team("ana@m2"), me)).toBe(false);
    expect(isProductLead(team("bo"), me)).toBe(false);
    expect(isProductLead(team(null), me)).toBe(false);
    expect(isProductLead(team("ana"), null)).toBe(false);
  });

  it("changes only as a team change, through review like the others", () => {
    const t = team(null);
    expect(checkChange({ kind: "product-lead", value: " ana " }, t)).toEqual({ kind: "product-lead", value: "ana" });
    expect(checkChange({ kind: "product-lead", value: null }, t)).toEqual({ kind: "product-lead", value: null });
    expect(() => checkChange({ kind: "product-lead", value: "not a handle" }, t)).toThrow(/by their PMX handle/);
    expect(isTeamChange({ kind: "product-lead", value: "ana" })).toBe(true);
    expect(describeChange({ kind: "product-lead", value: "ana" })).toBe("ana is your team's product lead, so PMX offers them PMX Engine");
    expect(describeChange({ kind: "product-lead", value: null })).toBe("Your team names no product lead");
  });
});

describe("the checklist's PMX Engine step (INSTALL-4)", () => {
  it("is a todo with a button for the product lead without Engine", () => {
    for (const lead of ["ana", "ana@m1"]) {
      const s = engineStep(checklist(team(lead)));
      expect(s).toMatchObject({ title: "Install PMX Engine", status: "todo", required: false, who: "you", how: "terminal", do: "pmx install --engine",
        fix: { kind: "pmx", label: "Install PMX Engine", asks: true } });
      expect(Object.keys(FIXES)).toContain(s.id);
      expect(s.page).not.toMatch(/\bpmx [a-z]/);
    }
    const cl = checklist(team("ana"));
    expect(cl.sections.find((s) => s.id === "engine")!.title).toBe("PMX and PMX Engine");
    expect(checklistForPage(cl)!.sections.find((s) => s.id === "engine")!.steps.map((s) => [s.title, s.fix?.label])).toContainEqual(["Install PMX Engine", "Install PMX Engine"]);
  });

  it("never applies to anyone else, says why, and stays off the page", () => {
    const other = engineStep(checklist(team("bo")));
    expect(other).toMatchObject({ title: "PMX Engine", status: "skip", detail: "PMX Engine is your product lead's tool." });
    expect(other.fix).toBeUndefined();
    expect(engineStep(checklist(team(null)))).toMatchObject({ status: "skip", detail: "Your team hasn't named its product lead." });
    expect(engineStep(checklist(team(undefined)))).toMatchObject({ status: "skip", detail: "Your team hasn't named its product lead." });
    expect(engineStep(checklist(null, { personal: null }))).toMatchObject({ status: "skip", detail: "after pmx init" });
    for (const t of [team("bo"), team(null)]) {
      const cl = checklist(t);
      expect(cl.sections.find((x) => x.id === "engine")!.steps.filter((x) => x.status === "todo" || x.status === "warn")).toEqual([]);
      expect(JSON.stringify(checklistForPage(cl))).not.toMatch(/PMX Engine is your|hasn't named/);
    }
  });

  it("where Engine is installed, the steps as before apply, for the lead and anyone else", () => {
    for (const t of [team("ana"), team("bo"), team(null)])
      expect(engineStep(checklist(t, { engine: { version: "0.12.0", checklist: { sections: [] } } }))).toMatchObject({ status: "done", detail: "PMX Engine 0.12.0 is on this Mac; its own steps follow PMX's" });
  });

  it("its button installs pmx-engine where PMX is installed, asking on the Mac first, and only for the lead", async () => {
    await freshHome();
    const { repo } = await pmxRepo();
    // PMX as `npm install -g --prefix <prefix>` leaves it.
    const prefix = await tmp("pmx-prefix-");
    process.env.PMX_INSTALL_ROOT_FOR_TESTS = join(prefix, "lib", "node_modules", "productmaxxing");
    await mkdir(process.env.PMX_INSTALL_ROOT_FOR_TESTS, { recursive: true });
    try {
      const calls: string[][] = [];
      const exec: Exec = async (cmd, args) => { calls.push([cmd, ...args]); return cmd === "npm" && args[0] === "prefix" ? { code: 0, stdout: "/usr/local\n", stderr: "" } : { code: 0, stdout: "", stderr: "" }; };
      const ctx = { ...(await testCtx({ repo, personal: { handle: "ana" } })), exec };
      const asked: string[] = [];
      const deps = { ctx, confirm: async (w: string) => { asked.push(w); return true; }, home: await tmp("home-") };
      const lead = await runFix("engine.installed", checklist(team("ana"), { personal: ctx.personal }), deps);
      expect(lead).toEqual({ status: 200, message: "PMX Engine is installed. Its own steps now follow PMX's here in Setup.", done: true });
      expect(asked).toEqual(["install PMX Engine, your team's product lead's tool, on this Mac"]);
      expect(calls.filter((c) => c[1] === "install")).toEqual([["npm", "install", "-g", "--prefix", prefix, "pmx-engine@latest"]]);

      // Not the lead: the step doesn't apply, so nothing runs and nothing is asked.
      calls.length = 0; asked.length = 0;
      expect(await runFix("engine.installed", checklist(team("bo"), { personal: ctx.personal }), deps)).toMatchObject({ status: 409 });
      expect(calls).toEqual([]);
      expect(asked).toEqual([]);
      // Don't Allow on the Mac: nothing runs.
      expect(await runFix("engine.installed", checklist(team("ana"), { personal: ctx.personal }), { ...deps, confirm: async () => false })).toMatchObject({ status: 409 });
      expect(calls.filter((c) => c[1] === "install")).toEqual([]);
    } finally { delete process.env.PMX_INSTALL_ROOT_FOR_TESTS; }
  });
});

describe("pmx status names the product lead", () => {
  beforeEach(freshHome);

  it("in one line when the team set one, marked when it's you", async () => {
    const { repo } = await pmxRepo();
    const line = async (productLead: string | null) => (await runStatus(await testCtx({ repo, team: { productLead }, personal: { handle: "ana" } }))).split("\n").filter((l) => l.startsWith("Product lead"));
    expect(await line("ana")).toEqual(["Product lead: ana (you)"]);
    expect(await line("bo")).toEqual(["Product lead: bo"]);
    expect(await line(null)).toEqual([]);
  }, 30000);
});

describe("the product lead in the page's Settings (INSTALL-4)", () => {
  let ui: Ui | null = null;
  afterEach(async () => { await ui?.close(); ui = null; });

  it("shows nobody yet, and naming someone is one change for the team to approve", async () => {
    ui = await openBoard({ hash: "settings/account" });
    await ui.until(() => ui!.$("#s-lead"), "the product lead row");
    expect(ui.text("#s-lead")).toMatch(/Nobody yet\. Name them by their PMX handle\./);
    await ui.type("#add-lead", "not a handle!");
    (ui.$("#add-lead")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /only letters, numbers/.test(ui!.text("#s-lead")), "the handle error");
    await ui.type("#add-lead", "bo");
    (ui.$("#add-lead")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /1 for your team to approve/.test(ui!.bar()), "the team change");
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.text("#review")).toMatch(/bo is your team's product lead, so PMX offers them PMX Engine/);
    await ui.click(ui.button("Send to your team", "#review"));
    await ui.until(() => /Saved your team's changes on this Mac|couldn't be sent/.test(ui!.text("#review")), "the change");
    const repo = ui.ctx.personal.repoPath;
    const b = (await git(repo, "branch", "--list", "pmx/settings-*", "--format=%(refname:short)")).split("\n").filter(Boolean).pop()!;
    expect(JSON.parse(await git(repo, "show", `${b}:pmx.config.json`)).productLead).toBe("bo");
    expect(pageText(ui)).not.toMatch(/\bpmx [a-z]/);
  }, 30000);

  it("says when it's you", async () => {
    ui = await openBoard({ hash: "settings/account", team: { productLead: "ana" } });
    await ui.until(() => ui!.$("#s-lead"), "the product lead row");
    expect(ui.text("#s-lead")).toMatch(/ana \(you\): PMX offers you PMX Engine\./);
  }, 30000);
});
