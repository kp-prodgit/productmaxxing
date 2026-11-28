import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { refreshProfile, runDoctor } from "../src/commands/doctor.js";
import { runInit } from "../src/commands/init.js";
import { scriptedAsker } from "../src/core/ask.js";
import { DEFAULT_TEAM, loadTeamConfig, type TeamConfig } from "../src/core/config.js";
import { exec, type Exec } from "../src/core/exec.js";
import { memoryKeychain } from "../src/core/keychain.js";
import { fakeLaunchd } from "../src/core/launchd.js";
import { paths } from "../src/core/paths.js";
import { Git } from "../src/core/git.js";
import { cleanInvocation, envFingerprint, mergedSettings, openCheckoutToWeb, PROJECT_SETTINGS, profileChecks, webProjectSettings, writeProfile, type InvocationOpts } from "../src/core/profile.js";
import { RunLogStore } from "../src/core/runlog-store.js";
import type { RunLogEntry } from "../src/core/runlog.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { pull } from "../src/pull/pull.js";
import type { RunRecord } from "../src/run/record.js";
import { buildGuard, checkWebCall, crmCompanies, passageCompanies, sourceLineCompanies, webGuardHook } from "../src/run/web-guard.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, quietOut, testCtx, tmp } from "./helpers.js";

const WEB: Partial<TeamConfig> = { categories: { ...DEFAULT_TEAM.categories, "competitive-analysis": { skill: "pmx-competitive", web: true } } };
const team = (over: Partial<TeamConfig> = {}) => ({ ...DEFAULT_TEAM, team: "test", ...over }) as TeamConfig;
const WEB_TOOLS = ["WebSearch", "WebFetch"];
const withClaude: Exec = async (cmd, args, o) => (cmd === "claude" ? { stdout: "2.1.300 (Claude Code)", stderr: "", code: 0 } : exec(cmd, args, o));

const ANALYSIS = `# Compare SSO against Globex

## Summary

Globex includes SCIM on every plan [web: https://globex.example/pricing, 2026-11-06]. Our buyers ask for it [T1].

## Comparison

| Capability | Us | Globex | Doing nothing |
|---|---|---|---|
| SCIM | unknown | Included [web: https://globex.example/pricing, 2026-11-06] | Weekly CSV export [T1] |

## Switching bar

A buyer exporting users weekly [T1] would switch for SCIM. *Assumption:* the saving outweighs a vendor review.

## Implications

- SCIM is table stakes against Globex [web: https://globex.example/pricing, 2026-11-06]
- Whether to lead with SCIM. **PM decides**.
`;

const task = (over: Partial<Task> = {}): Task => ({
  id: "lin-1", identifier: "PMX-1", title: "Compare SSO against Globex",
  description: "Buyers compare our SSO with Globex.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n\npmx:source T1",
  url: "https://linear.app/acme/issue/PMX-1", category: "competitive-analysis", size: "S", status: "ready", priority: 1, agent: null,
  sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z", ...over,
});

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

/** What a run's Claude Code would load, seen from inside the run: its arguments, both settings files, and git's view. */
interface Seen { args: string[]; project: any; run: any; status: string; hook: { allowed: number; blocked: number } }

/** A drafting runtime that looks at what the run gets, and whose probe runs the real clean-profile checks. */
function looking(seen: Seen[], probes: { o: any; failed: string[] }[]) {
  const rt = mockRuntime(async (o: InvocationOpts) => {
    const inv = cleanInvocation(o);
    const s: Seen = {
      args: inv.args,
      project: JSON.parse(await readFile(join(o.cwd, PROJECT_SETTINGS), "utf8")),
      run: JSON.parse(await readFile(after(inv.args, "--settings"), "utf8")),
      status: await git(o.cwd, "status", "--porcelain"),
      hook: { allowed: 0, blocked: 0 },
    };
    if (o.web) for (const query of ["Globex Teams plan price per person", "Vandelay pricing"]) {
      const r = await webGuardHook(JSON.stringify({ tool_name: "WebSearch", tool_input: { query }, cwd: o.cwd }), inv.env);
      s.hook[r.code === 0 ? "allowed" : "blocked"]++;
    }
    seen.push(s);
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(o.cwd, out)), { recursive: true });
    await writeFile(join(o.cwd, out), o.web ? ANALYSIS : ANALYSIS.replace(/ ?\[web: [^\]]+\]/g, ""));
    return { text: "Drafted.", costUsd: 0.1 };
  });
  rt.probe = async (t: TeamConfig, o: any = {}) => {
    const failed = (await profileChecks(t, o)).filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
    probes.push({ o, failed });
    return { ok: !failed.length, version: "mock", problems: failed };
  };
  return rt;
}

describe("web runs get the web, and only they do (RUN-6, R17, R21)", () => {
  beforeEach(freshHome);

  it("a web run's checkout gets the repo's project settings without its two web denies, and every other rule", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const repoFile = await readFile(join(repo, PROJECT_SETTINGS), "utf8");
    const template = JSON.parse(repoFile);
    expect(template.permissions.deny).toEqual(expect.arrayContaining(WEB_TOOLS));
    const crm = join(await tmp("crm-"), "names.txt");
    await writeFile(crm, "Jane Doe\nVandelay Industries Inc\n");
    const seen: Seen[] = [], probes: { o: any; failed: string[] }[] = [];
    const ctx = await testCtx({ repo, runtime: looking(seen, probes), team: WEB, personal: { crmNamesFile: crm } });
    const svc = await services(ctx, { tracker: memoryTracker([task()]) });
    expect((await pull(ctx, svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });

    // The probe judged the run's own checkout, merged with the web run's settings, and found nothing wrong.
    expect(probes).toEqual([{ o: { web: true, repo: expect.stringContaining("task-PMX-1") }, failed: [] }]);
    const s = seen[0]!;
    // Claude Code loads the checkout's project settings, then the web run's own, with the web tools.
    expect(after(s.args, "--setting-sources")).toBe("project");
    expect(after(s.args, "--settings")).toBe(paths.webRunSettings());
    expect(after(s.args, "--tools").split(",")).toEqual(expect.arrayContaining(WEB_TOOLS));
    // The checkout's project settings are the repo's, with exactly the two web denies taken out.
    expect(s.project).toEqual(webProjectSettings(template));
    expect(s.project.permissions.deny).toEqual(template.permissions.deny.filter((r: string) => !WEB_TOOLS.includes(r)));
    const rest = (x: any) => ({ ...x, permissions: { ...x.permissions, deny: undefined } });
    expect(rest(s.project)).toEqual(rest(template));
    // Merged as Claude Code merges them: both tools allowed and neither denied; every other rule of the repo's applies.
    const merged: any = mergedSettings(s.project, s.run);
    expect(merged.permissions.allow).toEqual(expect.arrayContaining(WEB_TOOLS));
    for (const t of WEB_TOOLS) expect(merged.permissions.deny).not.toContain(t);
    for (const r of template.permissions.deny.filter((x: string) => !WEB_TOOLS.includes(x))) expect(merged.permissions.deny).toContain(r);
    expect(merged.permissions.deny).toEqual(expect.arrayContaining(["Bash(curl *)", "Bash(wget *)", "Bash(gh *)", "Bash(git push *)"]));
    expect(merged.sandbox).toMatchObject({ enabled: true, allowUnsandboxedCommands: false, network: { allowedDomains: [...ctx.team.egress].sort() } });
    expect(merged.permissions).toMatchObject({ blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true, disableBypassPermissionsMode: "disable" });
    expect(merged.hooks.PreToolUse).toEqual([expect.objectContaining({ matcher: "WebSearch|WebFetch" })]);
    // The guard let the competitor search through and blocked the CRM customer.
    expect(s.hook).toEqual({ allowed: 1, blocked: 1 });
    // Git doesn't see the change: the agent's status is clean, and the draft's branch doesn't carry it.
    expect(s.status).toBe("");
    const branch = (await git(repo, "branch", "--list", "pmx/task/PMX-1-*")).replace(/^[*+ ]+/, "");
    expect(await git(repo, "diff", "--name-only", "main", branch)).not.toContain(PROJECT_SETTINGS);
    // The team repo keeps its deny for every Claude session in it.
    expect(await readFile(join(repo, PROJECT_SETTINGS), "utf8")).toBe(repoFile);

    // The run record's checks are of those merged settings, and its fingerprint is of the repo's file, put back.
    const record: RunRecord = JSON.parse(await git(repo, "show", `${branch}:.pmx/runs/PMX-1.json`));
    expect(record).toMatchObject({ web: true, webBlocked: 1, profile: { checksFailed: [] } });
    expect(record.profile.fingerprint).toBe(await envFingerprint(repo, ctx.team, { web: true }));
    // R21: the run log line says so too.
    const runs = (await new RunLogStore(ctx).entries()).filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run");
    expect(runs.at(-1)).toMatchObject({ taskId: "PMX-1", outcome: "ok", web: true, webBlocked: 1 });
  });

  it("a non-web run, on a team that opened competitive analysis to the web, still denies the web", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const seen: Seen[] = [], probes: { o: any; failed: string[] }[] = [];
    const ctx = await testCtx({ repo, runtime: looking(seen, probes), team: WEB });
    const svc = await services(ctx, { tracker: memoryTracker([task({ category: "spec", title: "Spec SCIM" })]) });
    await pull(ctx, svc, { dryRun: false });

    expect(probes).toEqual([{ o: { web: false, repo: expect.stringContaining("task-PMX-1") }, failed: [] }]);
    const s = seen[0]!;
    expect(after(s.args, "--settings")).toBe(paths.runSettings());
    expect(after(s.args, "--tools").split(",")).not.toContain("WebSearch");
    // The checkout's project settings are the repo's as they are, and both settings deny both tools.
    expect(s.project).toEqual(JSON.parse(await readFile(join(repo, PROJECT_SETTINGS), "utf8")));
    for (const t of WEB_TOOLS) {
      expect(s.project.permissions.deny).toContain(t);
      expect(s.run.permissions.deny).toContain(t);
    }
    expect(s.run.permissions.allow).toBeUndefined();
    expect(s.run.hooks).toBeUndefined();
    // R21: its run log line says nothing about the web.
    const runs = (await new RunLogStore(ctx).entries()).filter((e) => e.type === "run");
    expect(runs.at(-1)).not.toHaveProperty("web");
    expect(runs.at(-1)).not.toHaveProperty("webBlocked");
  });

  it("opening a checkout to the web hides the change from git, puts the repo's file back, and fails closed", async () => {
    const { repo } = await pmxRepo();
    const file = join(repo, PROJECT_SETTINGS);
    const original = await readFile(file, "utf8");
    const wt = new Git(repo);
    const putBack = await openCheckoutToWeb(wt);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(webProjectSettings(JSON.parse(original)));
    expect(await git(repo, "status", "--porcelain")).toBe("");
    expect(await git(repo, "ls-files", "-v", PROJECT_SETTINGS)).toMatch(/^S /);
    await putBack();
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await git(repo, "ls-files", "-v", PROJECT_SETTINGS)).toMatch(/^H /);
    // A checkout a stopped run left behind starts again from the repo's own file.
    await openCheckoutToWeb(wt);
    await (await openCheckoutToWeb(wt))();
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await git(repo, "status", "--porcelain")).toBe("");
    // A file that isn't JSON stops the run before it starts.
    await writeFile(file, "{ not json");
    await git(repo, "commit", "-qam", "broken settings");
    await expect(openCheckoutToWeb(wt)).rejects.toThrow(PROJECT_SETTINGS);
    // A repo with no project settings has nothing to take out.
    await git(repo, "rm", "-q", PROJECT_SETTINGS);
    await git(repo, "commit", "-qm", "no settings");
    await (await openCheckoutToWeb(wt))();
    expect(await git(repo, "status", "--porcelain")).toBe("");
  });

  it("the clean-profile checks judge the merged settings each run gets, and say why a web run wouldn't get the web", async () => {
    const t = team(WEB);
    const { repo } = await pmxRepo();
    await writeProfile(t);
    for (const c of [...(await profileChecks(t, { repo })), ...(await profileChecks(t, { web: true, repo }))]) expect(c, c.id).toMatchObject({ ok: true });
    expect((await profileChecks(t, { web: true, repo })).find((c) => c.id === "profile.web")!.detail)
      .toContain("the repo's project settings apply without their two web denies, every other rule kept");
    const web = async () => (await profileChecks(t, { web: true, repo })).find((c) => c.id === "profile.web")!;
    const plain = async () => (await profileChecks(t, { repo })).find((c) => c.id === "profile.web")!;
    const file = join(repo, PROJECT_SETTINGS);
    const original = JSON.parse(await readFile(file, "utf8"));

    // A narrower rule the team adds stays for the web run; a deny of a whole web tool, however written, fails it.
    await writeFile(file, JSON.stringify({ ...original, permissions: { ...original.permissions, deny: [...original.permissions.deny, "WebFetch(domain:acme.example)"] } }));
    expect((await web()).ok).toBe(true);
    await writeFile(file, JSON.stringify({ ...original, permissions: { ...original.permissions, deny: [...original.permissions.deny, "WebFetch(*)"] } }));
    expect(await web()).toMatchObject({ ok: false, detail: expect.stringContaining("WebFetch(*) still denies the web once the repo's project settings load") });
    expect((await plain()).ok).toBe(true);
    // A project file PMX can't read: the web run's check fails and names it; a non-web run's own settings still deny the web.
    await writeFile(file, "{ not json");
    expect(await web()).toMatchObject({ ok: false, detail: expect.stringContaining(`${file} isn't a JSON object`) });
    expect((await plain()).ok).toBe(true);
    // A web run's settings that deny a web tool fail, whatever the repo says; so do a non-web run's that don't.
    await writeFile(file, JSON.stringify(original));
    const runFile = JSON.parse(await readFile(paths.webRunSettings(), "utf8"));
    await writeFile(paths.webRunSettings(), JSON.stringify({ ...runFile, permissions: { ...runFile.permissions, deny: [...runFile.permissions.deny, "WebSearch"] } }));
    expect(await web()).toMatchObject({ ok: false, detail: expect.stringContaining("WebSearch still denies the web") });
    const plainFile = JSON.parse(await readFile(paths.runSettings(), "utf8"));
    await writeFile(paths.runSettings(), JSON.stringify({ ...plainFile, permissions: { ...plainFile.permissions, deny: plainFile.permissions.deny.filter((r: string) => r !== "WebSearch") } }));
    expect((await plain()).ok).toBe(false);
  });

  it("doctor checks the merged settings, and passes right after the team turns the web on", async () => {
    const root = await tmp();
    const repo = join(root, "pmx");
    const keychain = memoryKeychain(), launchd = fakeLaunchd();
    const p = await runInit({ askAll: true,
      ask: scriptedAsker({ "PMX repo checkout": repo, transcripts: join(root, "t"), "email domains": "us.example" }),
      keychain, launchd, exec: withClaude, out: quietOut(), now: () => new Date("2026-11-26T00:00:00Z"), cliPath: "/x/cli.js",
    });
    const before = await loadTeamConfig(repo);
    const on = { ...before, categories: { ...before.categories, "competitive-analysis": { skill: "pmx-competitive", web: true } } } as TeamConfig;
    const doctor = (o: { refresh?: boolean } = {}) => runDoctor({ personal: p, team: on, keychain, launchd, exec: withClaude, ...(o.refresh ? { refreshProfile } : {}) });

    // Reading only what init wrote, the web run's settings aren't there yet, and doctor says why and what writes them.
    const stale = (await doctor()).find((c) => c.id === "profile.web-run")!;
    expect(stale.ok).toBe(false);
    expect(stale.detail).toContain(`profile.settings (${paths.webRunSettings()} missing or unreadable: PMX writes it on its next command (\`pmx doctor\` and \`pmx init\` write it now))`);
    // `pmx doctor` writes the profile first, as every command that runs work does: right after the web is on, it passes.
    const checks = await doctor({ refresh: true });
    expect(checks.find((c) => c.id === "profile.web-run")).toMatchObject({ ok: true, detail: "web runs (competitive-analysis) open only WebSearch and WebFetch, with the PMX repo's other project settings" });
    expect(checks.filter((c) => !c.ok && c.level === "fail")).toEqual([]);

    // The repo's project settings count: one that would keep the web shut fails the web run's check, with the reason.
    const file = join(repo, PROJECT_SETTINGS);
    const s = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...s, permissions: { ...s.permissions, deny: [...s.permissions.deny, "WebSearch(*)"] } }));
    const shut = (await doctor({ refresh: true })).find((c) => c.id === "profile.web-run")!;
    expect(shut).toMatchObject({ ok: false, detail: expect.stringContaining("WebSearch(*) still denies the web once the repo's project settings load") });
  });
});

describe("the web guard lets competitor searches through and keeps customers out (RUN-6, R18)", () => {
  const PASSAGES = [
    "Jane: Our Brand team is on the Teams plan, and the Enterprise Price was too much for the Studio.",
    "Jane: We looked at Globex Pro and Initech Pro features in the spring, and the Kit pricing too.",
  ];
  const g = () => buildGuard({
    task: {
      title: "Compare brand kits against Globex and Initech",
      description: "Design teams weigh Globex and Initech for brand kits.\n\n**Sources:** a customer call with Umbrella Health (Nov 20); 2 partner calls with Bluth (Nov 3–5); 2 threads in #launch (Nov 18–21). They stay on the PM's Mac.\n\npmx:source T1",
    },
    evidence: { sources: [{ id: "T1", kind: "meeting" as const, at: "2026-11-20", passages: PASSAGES }], people: ["jane@acme.example", "kp@us.example"] },
    people: ["Max Lee", "Vandelay Industries Inc"],
    crm: ["Max Lee", "Vandelay Industries Inc", "Initrode GmbH", "Hooli & Sons", "pied.example", "Globex Corp"],
    internalDomains: ["us.example"],
  });
  const search = (query: string) => checkWebCall("WebSearch", { query }, g());
  const page = (url: string) => checkWebCall("WebFetch", { url, prompt: "Summarize the plans." }, g());

  it("allows ordinary searches and pages about the competitors, their products and plans", () => {
    for (const q of ["Globex Teams plan price per person", "Globex Enterprise brand kit features", "Initech Pro plan price", "brand kit AI design tool comparison", "studio pricing for teams", "health brand kit templates"])
      expect(search(q), q).toEqual([]);
    for (const u of ["https://globex.example/teams/", "https://globex.example/pro/brand-kit/", "https://globex.example/enterprise/", "https://initech.example/pricing?plan=pro"])
      expect(page(u), u).toEqual([]);
  });

  it("blocks customers and partners from email domains, the sources line and the CRM list", () => {
    // An outside participant's company, by its email domain.
    expect(search("acme brand kit")).toEqual(["company"]);
    expect(page("https://www.acme.example/pricing")).toEqual(["company"]);
    // The description's sources line: the whole name and its own word, never the common one alone.
    expect(search("Umbrella Health brand guidelines")).toEqual(["company"]);
    expect(search("Umbrella design system")).toEqual(["company"]);
    expect(search("Bluth partner program")).toEqual(["company"]);
    // The CRM list's companies: a legal form, an ampersand, a domain. Its people stay people.
    expect(search("Vandelay Industries logo")).toEqual(["company"]);
    expect(search("Vandelay brand kit")).toEqual(["company"]);
    expect(search("Initrode pricing")).toEqual(["company"]);
    expect(search("Hooli brand kit")).toEqual(["company"]);
    expect(page("https://pied.example/about")).toEqual(["company"]);
    expect(search("Max Lee brand kit")).toEqual(["person"]);
    // A competitor the title names stays allowed even when the CRM lists it.
    expect(search("Globex brand kit pricing")).toEqual([]);
    // Still hashes only.
    expect(JSON.stringify(g())).not.toMatch(/umbrella|bluth|vandelay|initrode|hooli|acme|pied/i);
  });

  it("reads companies from the sources line and the CRM list", () => {
    expect(sourceLineCompanies("R\n\n**Sources:** a customer call with Umbrella Health (Nov 20); 2 partner calls with Bluth (Nov 3–5); 2 threads in #launch (Nov 18–21); an external call (Nov 3). They stay on the PM's Mac.")).toEqual(["Umbrella Health", "Bluth"]);
    expect(sourceLineCompanies("R\n\n**Based on** one meeting (2026-11-05). The sources stay on the PM's Mac.")).toEqual([]);
    expect(crmCompanies(["Jane Doe", "Max", "Vandelay Industries Inc", "Initrode GmbH", "Hooli & Sons", "pied.example", "jane@acme.example", ""])).toEqual(["Vandelay Industries Inc", "Initrode GmbH", "Hooli & Sons", "pied"]);
  });
});

describe("the web guard finds the customers internal threads name (RUN-6, R18)", () => {
  // A competitive analysis fed by the team's own threads and a CRM record: every participant is inside the company,
  // the sources line names no company, and there's no CRM list.
  const THREADS = [
    "Dana: Hooli Hotels asked again whether we can match Globex on brand kits.\nSam: Initrode's procurement wants the Globex Enterprise quote beaten by Friday.",
    "Lee: Vandelay & Kramer are trialing Initech and want its indemnity terms.",
    "Dana: Our Brand team is on the Teams plan, and the Enterprise Price was too much for the Studio.\nSam: We looked at Globex Pro and Initech Pro features in the spring, and the Kit pricing too.",
    "Opportunity: Hooli Hotels — Teams Expansion\nStage: Negotiation\nNext step: send Globex's Magic Resize comparison",
  ];
  const g = () => buildGuard({
    task: {
      title: "Compare brand kits against Globex and Initech",
      description: "Design teams weigh Globex and Initech for brand kits.\n\n**Sources:** 3 threads in #competitive-intel (Nov 18–21); a thread in Opportunities (Nov 20). They stay on the PM's Mac.\n\npmx:source S1",
    },
    evidence: { sources: THREADS.map((t, i) => ({ id: `S${i + 1}`, kind: "slack" as const, at: "2026-11-20", passages: [t] })), people: ["dana@us.example", "sam@us.example", "lee@us.example"] },
    people: [],
    internalDomains: ["us.example"],
  });
  const search = (query: string) => checkWebCall("WebSearch", { query }, g());

  it("blocks the customers the threads name, with no sources-line company and no CRM list", () => {
    expect(search("Hooli Hotels Globex")).toEqual(["company"]);
    expect(search("Initrode Globex Enterprise quote")).toEqual(["company"]);
    expect(search("Vandelay & Kramer Initech indemnity")).toEqual(["company"]);
    expect(search("Vandelay indemnity terms")).toEqual(["company"]);
    expect(checkWebCall("WebFetch", { url: "https://search.example/?q=hooli+hotels+brand+kit" }, g())).toEqual(["company"]);
    expect(JSON.stringify(g())).not.toMatch(/hooli|initrode|vandelay|kramer/i);
  });

  it("still lets the competitors, their products and plans, and ordinary words through", () => {
    for (const q of ["Globex Teams plan price per person", "Globex Enterprise brand kit features", "Initech Pro plan price", "brand kit AI design tool comparison", "Globex Magic Resize pricing", "studio pricing for teams", "enterprise indemnity terms comparison"])
      expect(search(q), q).toEqual([]);
    for (const u of ["https://globex.example/teams/", "https://globex.example/pro/brand-kit/", "https://globex.example/enterprise/"])
      expect(checkWebCall("WebFetch", { url: u, prompt: "Summarize the plans." }, g()), u).toEqual([]);
  });

  it("takes a company from strong signals only", () => {
    const found = (text: string) => passageCompanies([text], (w) => ["globex", "initech"].includes(w)).map((c) => `${c.words.join(" ")}:${c.hold}`);
    // Possessives, customer and deal words, a CRM record's label and title, and an ampersand: the name and its words.
    expect(found("Initrode's legal team pushed back.")).toEqual(["initrode:all"]);
    expect(found("We lost the Bluth deal to Globex.")).toEqual(["bluth:all"]);
    expect(found("Our client Dunder Mifflin wants SSO.")).toEqual(["dunder mifflin:all"]);
    expect(found("Account: Initrode")).toEqual(["initrode:all"]);
    expect(found("Wernham Hogg — Renewal notes")).toEqual(["wernham hogg:all"]);
    expect(found("Vandelay & Kramer asked for terms.")).toEqual(["vandelay kramer:all"]);
    // "with", "at", "for" or "from": the name alone, and never a tool the threads integrate with.
    expect(found("A pilot with Wernham starts Monday.")).toEqual(["wernham:name"]);
    expect(found("We sync with Initrode through the Initrode integration.")).toEqual([]);
    // A run of capitalized words: the whole name only.
    expect(found("Hooli Hotels asked again.")).toEqual(["hooli hotels:name"]);
    // No signal, a competitor's product or plan, a product or feature, ordinary words: none.
    expect(found("We also tried Hooli last year.")).toEqual([]);
    expect(found("Globex's Magic Resize beat Initech Pro, and Globex Teams costs less.")).toEqual([]);
    expect(found("Magic Resize feature requests keep coming; people love magic resize.")).toEqual([]);
    expect(found("Our Brand Kit and Single Sign-On flow, the Enterprise Price, Every Friday, Next Steps — send it.")).toEqual([]);
    expect(found("The Customer's request came in. Let's go. Today's call moved.")).toEqual([]);
  });
});
