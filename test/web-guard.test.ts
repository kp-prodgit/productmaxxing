import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { scriptedAsker } from "../src/core/ask.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import { paths } from "../src/core/paths.js";
import { cleanInvocation, envFingerprint, guardCommand, profileChecks, writeProfile } from "../src/core/profile.js";
import { services } from "../src/core/services.js";
import type { Task } from "../src/core/types.js";
import { pull } from "../src/pull/pull.js";
import type { RunRecord } from "../src/run/record.js";
import { buildGuard, checkWebCall, clearGuard, GUARD_FILE, guardBlocked, properNames, webGuardHook, writeGuard } from "../src/run/web-guard.js";
import { terminalReview } from "../src/review/tui.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp } from "./helpers.js";

const PASSAGES = [
  "Jane: Every Friday we export a CSV of our users and paste it into your admin screen.",
  "Jane: We also tried Initech and Hooli last year, and Globex is what our admins use now.",
];
const evidence = { sources: [{ id: "T1", kind: "meeting" as const, at: "2026-11-05", passages: PASSAGES }], people: ["jane@acme.example", "kp@us.example"] };
const guard = () => buildGuard({
  task: { title: "Compare SSO against Globex", description: "Buyers compare our SSO with Globex and Initech.\n\npmx:source T1" },
  evidence, people: ["Jane Doe", "Max Lee"], internalDomains: ["us.example"],
});
const search = (query: string, more: object = {}) => ["WebSearch", { query, ...more }] as const;
const fetchUrl = (url: string) => ["WebFetch", { url, prompt: "Summarize the pricing." }] as const;

describe("the web guard: nothing from the task's evidence in a search (RUN-6)", () => {
  beforeEach(freshHome);

  it("blocks 5 words from the sources, people, and customers or partners that aren't the task's competitors", () => {
    const g = guard();
    const check = ([tool, input]: readonly [string, object]) => checkWebCall(tool, input, g);
    // Competitors and public topics pass.
    expect(check(search("Globex SSO pricing per seat"))).toEqual([]);
    expect(check(search("Initech SCIM provisioning plans"))).toEqual([]);
    expect(check(fetchUrl("https://globex.example/pricing?plan=team"))).toEqual([]);
    // Five words in a row from a passage, in a query or a URL's query string.
    expect(check(search("why export a CSV of our users"))).toEqual(["quote"]);
    expect(check(fetchUrl("https://search.example/?q=every+friday+we+export+a+csv"))).toEqual(["quote"]);
    // People: speakers, participants (name or email), the CRM and do-not-read lists.
    expect(check(search("Jane SSO opinions"))).toEqual(["person"]);
    expect(check(search("jane@acme.example"))).toContain("person");
    expect(check(search("max lee product manager"))).toEqual(["person"]);
    expect(check(fetchUrl("https://globex.example/search?q=Jane%20Doe"))).toEqual(["person"]);
    // Customers and partners: an outside participant's company. A name the passages only mention isn't one (R18).
    expect(check(search("acme admin tools"))).toEqual(["company"]);
    expect(check(search("Hooli identity provider"))).toEqual([]);
    expect(check(fetchUrl("https://www.acme.example/about"))).toEqual(["company"]);
    expect(check(search("SSO pricing", { allowed_domains: ["acme.example"] }))).toEqual(["company"]);
    // The guard holds salted hashes only: the agent, which can read it, learns no name.
    expect(JSON.stringify(g)).not.toMatch(/jane|acme|hooli|max|export/i);
  });

  it("a customer named in the task's description isn't a competitor unless the title names it", () => {
    const g = buildGuard({ task: { title: "Compare SSO against Globex", description: "Acme compares our SSO with Globex." }, evidence, people: [], internalDomains: ["us.example"] });
    expect(checkWebCall("WebSearch", { query: "Acme SSO" }, g)).toEqual(["company"]);
    const named = buildGuard({ task: { title: "Acme vs Globex: SSO", description: "" }, evidence, people: [], internalDomains: ["us.example"] });
    expect(checkWebCall("WebSearch", { query: "Acme SSO" }, named)).toEqual([]);
    // On a Mac drafting from the team's pack there are no participants: the description's sources line names the customer.
    const packed = buildGuard({
      task: { title: "Compare SSO against Globex", description: "Buyers weigh Initech and Globex.\n\n**Sources:** a customer call with Umbrella (Nov 20); 2 threads in #launch (Nov 18–21). They stay on the PM's Mac.\n\npmx:source T1" },
      evidence: { sources: evidence.sources }, people: [], internalDomains: ["us.example"],
    });
    expect(checkWebCall("WebSearch", { query: "Umbrella identity provider" }, packed)).toEqual(["company"]);
    expect(checkWebCall("WebSearch", { query: "Initech SSO pricing in November" }, packed)).toEqual([]);
    expect(properNames("Every Friday we use Okta and SCIM, said Hooli Inc.")).toEqual(["okta", "hooli"]);
  });

  it("as Claude Code's hook: exit 0 allows, exit 2 blocks with the reason on stderr and the decision as JSON, and a changed guard blocks everything", async () => {
    const dir = await tmp("run-");
    await writeGuard(dir, guard());
    const call = (tool: string, tool_input: object, env: NodeJS.ProcessEnv = { PMX_WEB_GUARD_DIR: dir }) =>
      webGuardHook(JSON.stringify({ hook_event_name: "PreToolUse", tool_name: tool, tool_input, cwd: dir }), env);

    expect(await call("WebSearch", { query: "Globex SSO pricing" })).toEqual({ code: 0, stdout: "", stderr: "" });
    const no = await call("WebSearch", { query: "Acme and Jane" });
    expect(no.code).toBe(2);
    expect(no.stderr).toMatch(/^PMX blocked this search: it names a person from the task's sources, and it names a customer or partner from the task's sources\. /);
    const json = JSON.parse(no.stdout);
    expect(json).toMatchObject({ decision: "block", hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" } });
    expect(json.reason).toBe(no.stderr.trim());
    // Without the environment variable it finds the run's folder from the call itself.
    expect((await call("WebFetch", { url: "https://acme.example/" }, {})).code).toBe(2);
    // Counted by rule only, outside the worktree, for the run record.
    expect(await guardBlocked(dir)).toEqual({ count: 2, rules: ["person", "company"] });
    expect(await readFile(join(paths.claudeProfile(), "web-guard", (await readdir(join(paths.claudeProfile(), "web-guard"))).find((f) => f.endsWith(".blocked"))!), "utf8")).not.toMatch(/Hooli|Jane|acme/i);

    // The agent edits the guard: every call is blocked, as when it's missing or the input can't be read.
    await writeFile(join(dir, GUARD_FILE), JSON.stringify({ ...guard(), companies: [], people: [] }));
    expect((await call("WebSearch", { query: "Globex SSO pricing" })).stderr).toMatch(/PMX's web guard for this run is missing or was changed/);
    expect((await webGuardHook("not json", {})).code).toBe(2);
    await clearGuard(dir);
    expect(existsSync(join(dir, GUARD_FILE))).toBe(false);
    expect((await call("WebSearch", { query: "Globex SSO pricing" })).code).toBe(2);
  });

  it("web runs' settings carry the hook, and the checks fail without it or with someone else's command", async () => {
    const t = { ...DEFAULT_TEAM, team: "test", categories: { ...DEFAULT_TEAM.categories, "competitive-analysis": { skill: "pmx-competitive", web: true } } } as TeamConfig;
    const cli = join(await tmp("cli-"), "cli.js");
    await writeFile(cli, "");
    await writeProfile(t, { guard: guardCommand(process.execPath, cli) });
    const file = JSON.parse(await readFile(paths.webRunSettings(), "utf8"));
    expect(file.hooks.PreToolUse[0].hooks[0].command).toBe(`'${process.execPath}' '${cli}' hook web-guard`);
    expect((await profileChecks(t, { web: true })).every((c) => c.ok)).toBe(true);
    // Where pmx is installed doesn't change the fingerprint CI recomputes.
    expect(await envFingerprint(paths.home(), t, { web: true })).toBe(await envFingerprint(paths.home(), t, { web: true }));

    const web = (await profileChecks(t, { web: true })).find((c) => c.id === "profile.web")!;
    expect(web.detail).toMatch(/PMX's web guard checks every call/);
    for (const change of [(f: any) => { delete f.hooks; }, (f: any) => { f.hooks.PreToolUse[0].hooks[0].command = "'/bin/sh' '-c' 'true'"; }, (f: any) => { f.hooks.PreToolUse[0].hooks[0].command = guardCommand(process.execPath, join(dirname(cli), "gone.js")); }, (f: any) => { f.hooks.PreToolUse[0].matcher = "WebSearch"; }]) {
      const f = structuredClone(file);
      change(f);
      await writeFile(paths.webRunSettings(), JSON.stringify(f));
      expect((await profileChecks(t, { web: true })).find((c) => c.id === "profile.web")!.ok).toBe(false);
    }
  });

  it("a web run writes the guard, the hook sees it, and blocked calls reach the run record and the review screen", async () => {
    const { repo } = await pmxRepo({}, { remote: true });
    const analysis = ["# Compare SSO against Globex", "", "## Summary", "", "Globex includes SCIM [T1].", "", "## Comparison", "", "| | Us | Globex |", "|---|---|---|", "| SCIM | unknown | Included [T1] |", "", "## Switching bar", "", "Unknown.", "", "## Implications", "", "- SCIM matters [T1]", ""].join("\n");
    const crm = join(await tmp("crm-"), "names.txt");
    await writeFile(crm, "Jane Doe\n");
    const rt = mockRuntime(async (o) => {
      // What Claude Code does before a WebSearch: run the hook in the run's environment.
      const env = cleanInvocation(o).env;
      expect(env.PMX_WEB_GUARD_DIR).toBe(o.cwd);
      const tried = await webGuardHook(JSON.stringify({ tool_name: "WebSearch", tool_input: { query: "what Jane Doe thinks of SSO" }, cwd: o.cwd }), env);
      expect(tried.code).toBe(2);
      const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
      await mkdir(dirname(join(o.cwd, out)), { recursive: true });
      await writeFile(join(o.cwd, out), analysis);
      return { text: "Drafted.", costUsd: 0.1 };
    });
    const ctx = await testCtx({ repo, runtime: rt, team: { categories: { ...DEFAULT_TEAM.categories, "competitive-analysis": { skill: "pmx-competitive", web: true } } }, personal: { crmNamesFile: crm } });
    const task: Task = {
      id: "lin-1", identifier: "PMX-1", title: "Compare SSO against Globex",
      description: "Buyers compare our SSO with Globex.\n\n**Sources**\n\n- [T1] Acme call: we export a CSV every Friday\n\npmx:source T1",
      url: "https://linear.app/acme/issue/PMX-1", category: "competitive-analysis", size: "S", status: "ready", priority: 1, agent: null,
      sources: ["T1"], prUrl: null, createdAt: "2026-11-01T00:00:00Z",
    };
    const svc = await services(ctx, { tracker: memoryTracker([task]) });
    expect((await pull(ctx, svc, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const branch = (await git(repo, "branch", "--list", "pmx/task/PMX-1-*")).replace(/^[*+ ]+/, "");
    const record: RunRecord = JSON.parse(await git(repo, "show", `${branch}:.pmx/runs/PMX-1.json`));
    expect(record).toMatchObject({ web: true, webBlocked: 1 });
    expect(await git(repo, "ls-tree", "-r", "--name-only", branch)).not.toContain("web-guard");
    expect(await readdir(join(paths.claudeProfile(), "web-guard")).catch(() => [])).toEqual([]);
    await terminalReview(ctx, svc, scriptedAsker({ Decision: "quit" }));
    expect(ctx.out.lines.join("\n")).toContain("PMX's web guard blocked 1 call that carried the task's evidence");
  });
});
