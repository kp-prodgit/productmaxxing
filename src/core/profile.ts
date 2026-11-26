import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { stableNode } from "./launchd.js";
import { WEB_KIND, webOn, type TeamConfig } from "./config.js";
import { readJson, writeJson } from "./fsutil.js";
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
 * through those two tools alone.
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
 */
export async function profileChecks(team: Pick<TeamConfig, "egress" | "model" | "caps"> & Partial<Pick<TeamConfig, "categories">>, o: { web?: boolean } = {}): Promise<Check[]> {
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
  add("profile.settings", !!s, `${file} present`);
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
  if (web) {
    // Exactly what PMX writes for a web run: nothing but the two web tools and their guard differs from every other
    // run's settings, and the guard is PMX's own command, with a Node and a pmx that are there.
    const hooks = s?.hooks?.PreToolUse;
    const command: string = Array.isArray(hooks) && hooks.length === 1 ? hooks[0]?.hooks?.[0]?.command ?? "" : "";
    const m = command.match(GUARD_SHAPE);
    const there = async (f: string) => stat(f).then((x) => x.isFile(), () => false);
    const guarded = !!m && (await there(unq(m[1]!))) && (await there(unq(m[2]!)));
    const exact = guarded && JSON.stringify(s) === JSON.stringify(runSettings(team, { web: true, guard: command }));
    add("profile.web", exact && webKinds(team).length > 0, `only WebSearch and WebFetch are allowed beyond the usual run, for your team's ${WEB_KIND} kind, and PMX's web guard checks every call`);
  } else add("profile.web", WEB_TOOLS.every((t) => deny.includes(t)) && !allow.some(isWeb) && !s?.hooks, "no web access (WebSearch and WebFetch denied)");

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
 * CI recomputes it from the repo at the run's base commit.
 */
export async function envFingerprint(read: RepoReader | string, team: Pick<TeamConfig, "egress" | "model">, o: { web?: boolean } = {}): Promise<string> {
  const reader = typeof read === "string" ? fsReader(read) : read;
  const h = createHash("sha256");
  h.update(JSON.stringify(runSettings(team, o)));
  h.update(JSON.stringify(EMPTY_MCP));
  for (const f of ["CLAUDE.md", ".claude/settings.json"]) h.update((await reader(f)) ?? `missing:${f}`);
  return h.digest("hex");
}
