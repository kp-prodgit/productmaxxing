import { readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exec as defaultExec, type Exec } from "./exec.js";
import { writeText } from "./fsutil.js";
import { LAUNCHD_LABEL, paths } from "./paths.js";

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * One launchd job that runs `pmx tick` every 30 minutes (CLI-2). launchd doesn't read the shell
 * profile, so PATH must include ~/.local/bin, where the Claude Code installer puts `claude`. `claude` is the
 * absolute path `pmx init` found: its folder goes first on PATH (an npm install under nvm also needs that
 * folder's `node`), and PMX_CLAUDE pins it.
 */
export function plist(opts: { node: string; cli: string; intervalSeconds?: number; pmxHome: string; home?: string; claude?: string | null }): string {
  const dirs = [join(opts.home ?? homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const path = [...new Set([...(opts.claude ? [dirname(opts.claude)] : []), ...dirs])].join(":");
  const pinned = opts.claude ? `
    <key>PMX_CLAUDE</key>
    <string>${xml(opts.claude)}</string>` : "";
  const args = [opts.node, opts.cli, "tick"].map((a) => `    <string>${xml(a)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>StartInterval</key>
  <integer>${opts.intervalSeconds ?? 1800}</integer>
  <key>RunAtLoad</key>
  <false/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PMX_HOME</key>
    <string>${xml(opts.pmxHome)}</string>
    <key>PATH</key>
    <string>${xml(path)}</string>${pinned}
  </dict>
  <key>StandardOutPath</key>
  <string>${xml(join(opts.pmxHome, "logs", "tick.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(opts.pmxHome, "logs", "tick.err.log"))}</string>
</dict>
</plist>
`;
}

const unxml = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** The environment the installed job runs with, read back from its plist, and the Node it starts. */
export function jobEnv(raw: string): { PATH: string; PMX_CLAUDE: string | null; node: string | null } {
  const val = (k: string) => raw.match(new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;
  const node = raw.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/)?.[1] ?? null;
  const v = (s: string | null) => (s === null ? null : unxml(s));
  return { PATH: v(val("PATH")) ?? "", PMX_CLAUDE: v(val("PMX_CLAUDE")), node: v(node) };
}

/** A Homebrew Node path that names a version (…/Cellar/node/26.13.0_2/bin/node): `brew upgrade node` removes it. */
export const VERSIONED_NODE = /^(.*)\/Cellar\/(node(@\d+)?)\/[^/]+\/bin\/node$/;

/**
 * The path to give the job for this Node: Homebrew's stable link (…/opt/node/bin/node) instead of the versioned
 * Cellar folder, so upgrading Node doesn't stop the job. Any other path is kept as it is.
 */
export async function stableNode(p: string, exists: (f: string) => Promise<boolean> = (f) => stat(f).then(() => true, () => false)): Promise<string> {
  const m = p.match(VERSIONED_NODE);
  if (!m) return p;
  for (const c of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) if (await exists(c)) return c;
  return p;
}

export interface Launchd {
  install(p: string): Promise<void>;
  uninstall(): Promise<void>;
  isLoaded(): Promise<boolean>;
  /** The job file's text, or null when there's none. */
  installed(): Promise<string | null>;
}

export function macLaunchd(exec: Exec = defaultExec): Launchd {
  const domain = `gui/${process.getuid?.() ?? 501}`;
  return {
    async install(p) {
      await writeText(paths.launchAgent(), p);
      await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      const r = await exec("launchctl", ["bootstrap", domain, paths.launchAgent()]);
      if (r.code !== 0) throw new Error(`launchctl bootstrap failed: ${r.stderr.trim()}`);
    },
    async uninstall() {
      await exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`]);
      await rm(paths.launchAgent(), { force: true });
    },
    async isLoaded() {
      return (await exec("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`])).code === 0;
    },
    installed: () => readFile(paths.launchAgent(), "utf8").catch(() => null),
  };
}

export function fakeLaunchd(): Launchd & { plist: string | null } {
  const f = {
    plist: null as string | null,
    async install(p: string) { f.plist = p; },
    async uninstall() { f.plist = null; },
    async isLoaded() { return f.plist !== null; },
    async installed() { return f.plist; },
  };
  return f;
}

/** The background job's own logs, which launchd appends to forever. */
export const tickLogs = () => [join(paths.logs(), "tick.log"), join(paths.logs(), "tick.err.log")];

/**
 * Keeps each tick log under `maxBytes` (OBS-1): a full log moves to `<name>.1`, replacing the previous one,
 * so each log takes at most twice `maxBytes`. launchd opens a fresh file on the next run. Never throws.
 */
export async function capTickLogs(maxBytes = 1024 * 1024): Promise<void> {
  for (const f of tickLogs()) {
    const s = await stat(f).catch(() => null);
    if (s && s.size > maxBytes) await rename(f, `${f}.1`).catch(() => {});
  }
}
