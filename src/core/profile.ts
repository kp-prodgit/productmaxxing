import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stableNode } from "./launchd.js";
import { WEB_KIND, webOn, type TeamConfig } from "./config.js";
import { readJson, writeJson } from "./fsutil.js";
import type { Git } from "./git.js";
import { paths } from "./paths.js";

/**
 * The clean run profile (B1). Every Claude Code run ProductMaxxing starts goes through
 * `cleanInvocation`, so personal memory, instructions, skills, plugins, hooks, MCP servers
 * and claude.ai connectors never load (PRIV-1, NEUT-1).
 */

/** RUN-6: the only tools a web run adds. Everything else about the run stays as it is. */
export const WEB_TOOLS = ["WebSearch", "WebFetch"] as const;
const DENY = ["WebFetch", "WebSearch", "Bash(git push *)", "Bash(gh *)", "Bash(curl *)", "Bash(wget *)"];

/** RUN-6: the hook command as the fingerprint sees it, so it's the same whichever Mac or folder pmx is installed in. */
export const GUARD_PLACEHOLDER = "pmx hook web-guard";
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
/** RUN-6: the web guard's command, with the Node and pmx this Mac pins, quoted for the shell Claude Code runs it in. */
export const guardCommand = (node: string, cli: string) => `${sq(node)} ${sq(cli)} hook web-guard`;
const GUARD_SHAPE = /^'((?:[^']|'\\'')+)' '((?:[^']|'\\'')+)' hook web-guard$/;
const unq = (s: string) => s.replace(/'\\''/g, "'");

/** This Mac's guard command: its stable Node and the pmx running now. */
export async function localGuard(cli: string = process.argv[1] ?? ""): Promise<string> {
  return guardCommand(await stableNode(process.execPath), await realpath(cli).catch(() => cli));
}

/**
 * Settings passed with `--settings`. With `--setting-sources project`, user settings never load. `web` (RUN-6): the
 * settings for one run of a kind the team opened to the web. They differ from every other run's in two ways only:
 * WebSearch and WebFetch are allowed instead of denied, and a PreToolUse hook on both runs PMX's web guard (`guard`, the
 * command; the placeholder for the fingerprint), which blocks any call that carries the task's evidence. Shell commands
 * keep the sandbox and the team's egress list, and curl, wget, gh and git push stay denied, so the web is reached
 * through those two tools alone. These settings load on top of the checkout's project settings, which for a web run
 * are the repo's without its two web denies (`webProjectSettings`, R17).
 */
export function runSettings(team: Pick<TeamConfig, "egress" | "model">, o: { web?: boolean; guard?: string } = {}): Record<string, unknown> {
  const web = o.web === true;
  return {
    model: team.model,
    autoMemoryEnabled: false,
    disableClaudeAiConnectors: true,
    syncClaudeAiSkills: false,
    syncClaudeAiPlugins: false,
    enableAllProjectMcpServers: false,
    permissions: {
      defaultMode: "dontAsk",
      disableBypassPermissionsMode: "disable",
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
      ...(web ? { allow: [...WEB_TOOLS] } : {}),
      deny: web ? DENY.filter((t) => !(WEB_TOOLS as readonly string[]).includes(t)) : [...DENY],
    },
    sandbox: {
      enabled: true,
      allowUnsandboxedCommands: false,
      network: { allowedDomains: [...team.egress].sort() },
    },
    env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    ...(web ? { hooks: { PreToolUse: [{ matcher: WEB_TOOLS.join("|"), hooks: [{ type: "command", command: o.guard ?? GUARD_PLACEHOLDER, timeout: 30 }] }] } } : {}),
  };
}

/** No MCP servers by default: the agent in a run gets no tracker or source tools (P3, SEC-1). */
export const EMPTY_MCP = { mcpServers: {} };

/** The project settings Claude Code reads from a run's checkout (`--setting-sources project`). */
export const PROJECT_SETTINGS = ".claude/settings.json";

/** A checkout's project settings: null when it has none. Throws when the file isn't JSON. */
export async function readProjectSettings(repo: string): Promise<Record<string, unknown> | null> {
  const s = await readJson<unknown>(join(repo, PROJECT_SETTINGS));
  if (s !== null && (typeof s !== "object" || Array.isArray(s))) throw new Error(`${join(repo, PROJECT_SETTINGS)}: not a JSON object`);
  return s as Record<string, unknown> | null;
}

/**
 * RUN-6 (R17): the team repo's project settings as a web run gets them. The repo denies WebSearch and WebFetch to every
 * Claude session in it (`permissions.deny` in the template every `pmx init` writes), and Claude Code applies a deny from
 * any settings source over an allow from any other: the web run's own settings (`--settings`) can't open the two tools
 * while the project's deny loads. Leaving project settings out (`--setting-sources` without `project`) would also drop
 * the team's CLAUDE.md and its memory, which Claude Code loads only with them. So a web run's checkout, PMX's own
 * worktree for that run, gets this file in place of the repo's for the run only: the same settings, with exactly the
 * two bare denies "WebSearch" and "WebFetch" taken out. Every other key and rule stays as the repo has it.
 */
export function webProjectSettings(project: Record<string, unknown>): Record<string, unknown> {
  const s = structuredClone(project) as any;
  if (Array.isArray(s?.permissions?.deny)) s.permissions.deny = s.permissions.deny.filter((r: unknown) => !(WEB_TOOLS as readonly unknown[]).includes(r));
  return s;
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);

/**
 * What Claude Code applies when two settings sources load, `low` (the checkout's project settings) under `high` (the
 * run's `--settings`): objects merge key by key, lists (permission rules, hooks, domains) add up without repeats, and
 * any other value of `high` wins.
 */
export function mergedSettings(low: unknown, high: unknown): unknown {
  if (Array.isArray(low) && Array.isArray(high)) {
    const seen = new Set<string>();
    return [...low, ...high].filter((x) => { const k = JSON.stringify(x); return seen.has(k) ? false : (seen.add(k), true); });
  }
  if (isObject(low) && isObject(high)) {
    const out: Record<string, unknown> = { ...low };
    for (const [k, v] of Object.entries(high)) out[k] = k in low ? mergedSettings(low[k], v) : v;
    return out;
  }
  return high === undefined ? low : high;
}

/**
 * RUN-6 (R17): gives a web run's checkout the project settings `webProjectSettings` makes from its own, for that run
 * only, and returns what puts the repo's file back. Git doesn't see the change (skip-worktree), so neither the agent's
 * `git status` nor the draft's commit carries it. Fails closed: a file that isn't JSON, or one that doesn't read back
 * exactly as written, throws and no run starts.
 */
export async function openCheckoutToWeb(wt: Git): Promise<() => Promise<void>> {
  const file = join(wt.cwd, PROJECT_SETTINGS);
  // A checkout a stopped web run left behind may still have its file: start from the repo's own.
  await wt.raw(["update-index", "--no-skip-worktree", PROJECT_SETTINGS]);
  await wt.raw(["checkout", "--", PROJECT_SETTINGS]);
  const original = await readFile(file, "utf8").catch((e: any) => (e?.code === "ENOENT" ? null : Promise.reject(e)));
  // A repo without project settings denies nothing: the web run's own settings are all a run loads.
  if (original === null) return async () => {};
  const project = await readProjectSettings(wt.cwd);
  const want = webProjectSettings(project!);
  if (JSON.stringify(want) === JSON.stringify(project)) return async () => {};
  await writeFile(file, JSON.stringify(want, null, 2) + "\n");
  const back = async () => {
    await writeFile(file, original);
    await wt.raw(["update-index", "--no-skip-worktree", PROJECT_SETTINGS]);
  };
  if (JSON.stringify(await readProjectSettings(wt.cwd).catch(() => null)) !== JSON.stringify(want)) {
    await back();
    throw new Error(`the web run's project settings didn't read back as written (${file}), so the run didn't start`);
  }
  await wt.raw(["update-index", "--skip-worktree", PROJECT_SETTINGS]);
  return back;
}

/** RUN-6: whether this team has opened any kind of work to the web. */
export const webKinds = (team: Partial<Pick<TeamConfig, "categories">>): string[] => (team.categories && webOn({ categories: team.categories }, WEB_KIND) ? [WEB_KIND] : []);

/** `guard` (RUN-6): the web guard's command; this Mac's own (`localGuard`) unless given. */
export async function writeProfile(team: Pick<TeamConfig, "egress" | "model"> & Partial<Pick<TeamConfig, "categories">>, o: { guard?: string } = {}): Promise<void> {
  await mkdir(paths.claudeProfile(), { recursive: true, mode: 0o700 });
  await writeJson(paths.runSettings(), runSettings(team), 0o600);
  // RUN-6: the web run's settings exist only while the team has a kind of work open to the web.
  if (webKinds(team).length) await writeJson(paths.webRunSettings(), runSettings(team, { web: true, guard: o.guard ?? (await localGuard()) }), 0o600);
  else await rm(paths.webRunSettings(), { force: true });
  await writeJson(paths.mcpConfig(), EMPTY_MCP, 0o600);
}

export interface InvocationOpts {
  team: Pick<TeamConfig, "egress" | "model" | "caps">;
  cwd: string;
  prompt: string;
  /** Built-in tools. `[]` means none at all (synthesis and digest, SEC-1). */
  tools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  appendSystemPrompt?: string;
  /** RUN-6: this run is of a kind the team opened to the web, so it uses the web run's settings. */
  web?: boolean;
  /** RUN-6: the run's folder, where PMX wrote what its web guard checks (`PMX_WEB_GUARD_DIR` for the hook). */
  guard?: string;
}

export interface Invocation {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** Environment keys from the PM's shell that could pull personal setup into a run. */
const STRIP_ENV = [/^CLAUDE_/, /^ANTHROPIC_MODEL$/, /^ANTHROPIC_DEFAULT_/, /^MCP_/, /^ENABLE_CLAUDEAI/];

export function cleanEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (!STRIP_ENV.some((r) => r.test(k))) env[k] = v;
  env.CLAUDE_CONFIG_DIR = paths.claudeProfile();
  env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  env.ENABLE_CLAUDEAI_MCP_SERVERS = "false";
  env.CLAUDE_CODE_SKIP_PROMPT_HISTORY = "1";
  return env;
}

export function cleanInvocation(o: InvocationOpts): Invocation {
  const args = [
    "-p",
    o.prompt,
    "--output-format",
    "json",
    "--setting-sources",
    "project",
    "--settings",
    o.web ? paths.webRunSettings() : paths.runSettings(),
    "--strict-mcp-config",
    "--mcp-config",
    paths.mcpConfig(),
    "--model",
    o.team.model,
    "--permission-mode",
    "dontAsk",
    "--tools",
    o.tools.join(","),
    "--no-session-persistence",
    "--max-budget-usd",
    String(Math.min(o.maxBudgetUsd ?? o.team.caps.perRunUsd, o.team.caps.perRunUsd)),
  ];
  if (o.tools.length) args.push("--allowedTools", o.tools.join(","));
  if (o.maxTurns) args.push("--max-turns", String(o.maxTurns));
  if (o.appendSystemPrompt) args.push("--append-system-prompt", o.appendSystemPrompt);
  const env = cleanEnv();
  // RUN-6: the web guard reads what to check from the run's folder; Claude Code passes its environment to the hook.
  if (o.web && o.guard) env.PMX_WEB_GUARD_DIR = o.guard;
  return { cmd: "claude", args, env, cwd: o.cwd };
}

export interface Check {
  id: string;
  ok: boolean;
  detail: string;
}

/**
 * Every clean-profile check. `pmx doctor` fails if any is false (CLI-3). `web` (RUN-6) checks the settings a web run
 * uses instead: the same checks, and `profile.web` proves they open nothing but WebSearch and WebFetch, and only for a
 * team that opened a kind of work to the web. For every other run `profile.web` proves both are denied.
 *
 * `repo` (R17): the checkout the run starts in, whose `.claude/settings.json` Claude Code loads under the run's own
 * settings. `profile.web` then judges what the run really gets once the two merge: for a web run, the repo's settings
 * without their two web denies (`webProjectSettings`) under the web run's, which must allow both tools, deny neither,
 * and keep every other rule of the repo's (its denies, the sandbox, reads and writes kept to the checkout); for every
 * other run, the repo's settings as they are, under settings that deny both.
 */
export async function profileChecks(team: Pick<TeamConfig, "egress" | "model" | "caps"> & Partial<Pick<TeamConfig, "categories">>, o: { web?: boolean; repo?: string } = {}): Promise<Check[]> {
  const checks: Check[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const web = o.web === true;
  const file = web ? paths.webRunSettings() : paths.runSettings();

  let dirOk = false;
  try {
    const s = await stat(paths.claudeProfile());
    dirOk = s.isDirectory() && (s.mode & 0o077) === 0;
  } catch {}
  add("profile.dir", dirOk, `${paths.claudeProfile()} exists and is private (0700)`);

  const s = await readJson<any>(file).catch(() => null);
  add("profile.settings", !!s, s ? `${file} present`
    : web && !webKinds(team).length ? `${file} missing: it exists only while your team's pmx.config.json opens ${WEB_KIND} to the web`
    : `${file} missing or unreadable: PMX writes it on its next command (\`pmx doctor\` and \`pmx init\` write it now)`);
  add("profile.model", s?.model === team.model, `model fixed to team model ${team.model}`);
  add("profile.memory-off", s?.autoMemoryEnabled === false && s?.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1", "auto memory off");
  add("profile.connectors-off", s?.disableClaudeAiConnectors === true && s?.syncClaudeAiSkills === false && s?.syncClaudeAiPlugins === false, "claude.ai connectors, skills and plugin sync off");
  add("profile.no-bypass", s?.permissions?.defaultMode === "dontAsk" && s?.permissions?.disableBypassPermissionsMode === "disable", "permissions never skipped (dontAsk, bypass disabled)");
  add("profile.reads-limited", s?.permissions?.blockReadsOutsideWorkingDirectories === true && s?.permissions?.blockWritesOutsideWorkingDirectories === true, "reads and writes limited to the repo checkout");
  add("profile.sandbox", s?.sandbox?.enabled === true && s?.sandbox?.allowUnsandboxedCommands === false, "sandbox on, no unsandboxed retries");
  const egressOk = JSON.stringify(s?.sandbox?.network?.allowedDomains ?? null) === JSON.stringify([...team.egress].sort());
  add("profile.egress", egressOk, `egress limited to ${team.egress.join(", ")}${web ? " for shell commands; WebSearch and WebFetch reach the web for this run" : ""}`);
  const deny: string[] = Array.isArray(s?.permissions?.deny) ? s.permissions.deny : [];
  const allow: string[] = Array.isArray(s?.permissions?.allow) ? s.permissions.allow : [];
  const isWeb = (t: string) => (WEB_TOOLS as readonly string[]).includes(t.replace(/\(.*$/, ""));
  // R17: what the run gets once Claude Code loads the checkout's project settings under the run's own.
  const projectFile = o.repo ? join(o.repo, PROJECT_SETTINGS) : null;
  let project: Record<string, unknown> | null = null;
  let unreadable = false;
  if (o.repo) try { project = await readProjectSettings(o.repo); } catch { unreadable = true; }
  const merged: any = mergedSettings((project && web ? webProjectSettings(project) : project) ?? {}, s ?? {});
  const list = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
  const mergedDeny = list(merged?.permissions?.deny), mergedAllow = list(merged?.permissions?.allow);
  if (web) {
    // Exactly what PMX writes for a web run: nothing but the two web tools and their guard differs from every other
    // run's settings, and the guard is PMX's own command, with a Node and a pmx that are there.
    const hooks = s?.hooks?.PreToolUse;
    const command: string = Array.isArray(hooks) && hooks.length === 1 ? hooks[0]?.hooks?.[0]?.command ?? "" : "";
    const m = command.match(GUARD_SHAPE);
    const there = async (f: string) => stat(f).then((x) => x.isFile(), () => false);
    const guarded = !!m && (await there(unq(m[1]!))) && (await there(unq(m[2]!)));
    const exact = guarded && JSON.stringify(s) === JSON.stringify(runSettings(team, { web: true, guard: command }));
    const why: string[] = [];
    if (!webKinds(team).length) why.push(`your team's pmx.config.json doesn't open ${WEB_KIND} to the web`);
    if (!s) why.push(`${file} is missing`);
    else if (!guarded) why.push("PMX's web guard isn't the hook on both tools, or the Node or PMX install it runs is gone");
    else if (!exact) why.push(`${file} differs from what PMX writes: it may open more than WebSearch and WebFetch`);
    if (unreadable) why.push(`${projectFile} isn't a JSON object, so PMX can't tell what a web run gets`);
    if (s && !unreadable) {
      // A deny of the whole tool, however written, shuts it; a narrower one the team added ("WebFetch(domain:…)") doesn't.
      const shuts = (r: unknown) => typeof r === "string" && WEB_TOOLS.some((t) => [t, `${t}(*)`, `${t}(**)`, `${t}(domain:*)`].includes(r));
      const denied = mergedDeny.filter(shuts);
      if (denied.length) why.push(`${denied.join(", ")} still ${denied.length === 1 ? "denies" : "deny"} the web once the repo's project settings load`);
      const shut = WEB_TOOLS.filter((t) => !mergedAllow.includes(t));
      if (shut.length) why.push(`${shut.join(" and ")} aren't allowed`);
      const lost = list((project as any)?.permissions?.deny).filter((r) => !(WEB_TOOLS as readonly unknown[]).includes(r) && !mergedDeny.includes(r));
      if (lost.length) why.push(`the repo's own rules would be lost: ${lost.join(", ")}`);
      if (merged?.sandbox?.enabled !== true || merged?.sandbox?.allowUnsandboxedCommands !== false) why.push("the sandbox would be off");
      if (merged?.permissions?.blockReadsOutsideWorkingDirectories !== true || merged?.permissions?.blockWritesOutsideWorkingDirectories !== true) why.push("reads and writes wouldn't stay in the checkout");
    }
    add("profile.web", !why.length, why.length ? `a web run wouldn't get the web as it should: ${why.join("; ")}`
      : `only WebSearch and WebFetch are allowed beyond the usual run, for your team's ${WEB_KIND} kind, and PMX's web guard checks every call${projectFile ? `; the repo's project settings apply without their two web denies, every other rule kept` : ""}`);
  } else add("profile.web", WEB_TOOLS.every((t) => deny.includes(t) && mergedDeny.includes(t)) && !allow.some(isWeb) && !s?.hooks, "no web access (WebSearch and WebFetch denied)");

  const mcp = await readJson<any>(paths.mcpConfig());
  add("profile.strict-mcp", !!mcp && Object.keys(mcp.mcpServers ?? {}).length === 0, "strict MCP config with no servers");

  const inv = cleanInvocation({ team, cwd: ".", prompt: "", tools: [], web });
  const a = inv.args.join(" ");
  add(
    "profile.invocation",
    a.includes("--setting-sources project") && a.includes("--strict-mcp-config") && !a.includes("dangerously") && a.includes(`--settings ${file}`) &&
      inv.env.CLAUDE_CONFIG_DIR === paths.claudeProfile() && inv.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1",
    "runs use project-only settings and the separate profile",
  );
  return checks;
}

/** Reads a repo file by relative path, or null if missing. */
export type RepoReader = (rel: string) => Promise<string | Buffer | null>;

export const fsReader = (repoPath: string): RepoReader => (rel) => readFile(join(repoPath, rel)).catch(() => null);

/**
 * A fingerprint of everything that shapes a run, for the run record (B5) and the neutrality test (B6):
 * the clean-profile settings, the MCP config, the project CLAUDE.md and the project settings.
 * CI recomputes it from the repo at the run's base commit. A web run's project settings are made from the repo's by
 * `webProjectSettings` alone, so the repo's file stands for them, read after the run puts it back.
 */
export async function envFingerprint(read: RepoReader | string, team: Pick<TeamConfig, "egress" | "model">, o: { web?: boolean } = {}): Promise<string> {
  const reader = typeof read === "string" ? fsReader(read) : read;
  const h = createHash("sha256");
  h.update(JSON.stringify(runSettings(team, o)));
  h.update(JSON.stringify(EMPTY_MCP));
  for (const f of ["CLAUDE.md", ".claude/settings.json"]) h.update((await reader(f)) ?? `missing:${f}`);
  return h.digest("hex");
}
