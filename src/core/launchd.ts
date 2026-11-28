import { spawn } from "node:child_process";
import { readFile, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { exec as defaultExec, realSystemGuard, type Exec } from "./exec.js";
import { writeText } from "./fsutil.js";
import { LAUNCHD_LABEL, paths, pmxHome } from "./paths.js";

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
  /** Whether a pass is running right now (UPGRADE-1 doesn't reload the job under it). */
  running?(): Promise<boolean>;
  /**
   * UPGRADE-1: installs `p` once the process `pid` has ended and no pass is running, so a pass can ask for its own job
   * to be reloaded without being stopped by it. Nothing changes until then; if the reload never happens, the job stays
   * as it was.
   */
  reloadAfter?(p: string, pid: number): Promise<void>;
}

/**
 * The reload a background pass can't do to its own job (UPGRADE-1). `launchctl bootout` stops the job's process, so a
 * pass that ran it would be killed before it could load the job again, and the job would be gone. This runs apart from
 * the pass, in its own session (launchd stops a finished job's own process group only): it waits for the pass that
 * asked (`$1`) to end and for the job to be idle, and only then puts the new job file in place and reloads it. If it
 * can't load the new file, it puts the old one back and loads that. It gives up, changing nothing, when the pass is
 * still running after half an hour. The job counts as busy in any launchd state but "not running", "waiting" or
 * "exited": right after a start it is "xpcproxy" for a moment, before "running" (rig test of #144). Arguments, in order: pid, launchd domain, label, the new job file, where the job
 * file lives, the log to say what it did in, and the launchctl to run (tests pass a stand-in).
 */
export const RELOAD_SCRIPT = `pid="$1"; domain="$2"; label="$3"; pending="$4"; dest="$5"; log="$6"; ctl="$7"
say() { printf '%s background job: %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" >> "$log" 2>/dev/null; }
n=0
while kill -0 "$pid" 2>/dev/null; do n=$((n+1)); if [ "$n" -gt 1800 ]; then exit 0; fi; sleep 1; done
n=0
busy() { s=$("$ctl" print "$domain/$label" 2>/dev/null | sed -n 's/^[[:space:]]*state = //p' | head -1); case "$s" in ''|'not running'|waiting|exited) return 1;; *) return 0;; esac; }
while busy; do n=$((n+1)); if [ "$n" -gt 1800 ]; then exit 0; fi; sleep 1; done
[ -f "$pending" ] || exit 0
cp "$dest" "$dest.pmx-old" 2>/dev/null
if ! { cp "$pending" "$dest.pmx-new" && mv "$dest.pmx-new" "$dest"; }; then say "couldn't write its new settings, so it runs as before"; exit 1; fi
"$ctl" bootout "$domain/$label" >/dev/null 2>&1
n=0
until "$ctl" bootstrap "$domain" "$dest" >/dev/null 2>&1; do
  n=$((n+1))
  if [ "$n" -ge 5 ]; then
    if [ -f "$dest.pmx-old" ]; then mv "$dest.pmx-old" "$dest"; "$ctl" bootstrap "$domain" "$dest" >/dev/null 2>&1; fi
    say "couldn't reload with this pmx, Node and Claude Code, so it runs as before"
    exit 1
  fi
  sleep 2
done
rm -f "$pending" "$dest.pmx-old"
say "reloaded with this pmx, Node and Claude Code"
`;

export interface ReloadPlan { pid: number; domain: string; label: string; pending: string; dest: string; log: string; launchctl?: string }

/** The command that runs RELOAD_SCRIPT for a plan: `/bin/sh -c <script> <name> <arguments>`. */
export function reloadCommand(p: ReloadPlan): { cmd: string; args: string[] } {
  return { cmd: "/bin/sh", args: ["-c", RELOAD_SCRIPT, "pmx-job-reload", String(p.pid), p.domain, p.label, p.pending, p.dest, p.log, p.launchctl ?? "launchctl"] };
}

/** Where a job file waits until the pass that asked for it has ended. */
export const pendingJob = () => join(pmxHome(), "launchd", "pending.plist");

/** Starts the reload apart from this process, so it outlives it. */
function reloadLater(p: ReloadPlan): void {
  // The script runs launchctl itself, past `exec`: never the real one from a test.
  if (!p.launchctl) realSystemGuard("launchctl (the background job's reload)");
  const { cmd, args } = reloadCommand(p);
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
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
    async running() {
      const r = await exec("launchctl", ["print", `${domain}/${LAUNCHD_LABEL}`]);
      // Busy in any state but idle: right after a start launchd says "xpcproxy" before "running" (rig test of #144).
      const state = r.stdout.match(/^\s*state = (.+)$/m)?.[1]?.trim();
      return r.code === 0 && !!state && !["not running", "waiting", "exited"].includes(state);
    },
    async reloadAfter(p, pid) {
      await writeText(pendingJob(), p);
      reloadLater({ pid, domain, label: LAUNCHD_LABEL, pending: pendingJob(), dest: paths.launchAgent(), log: join(paths.logs(), "tick.log") });
    },
  };
}

export function fakeLaunchd(): Launchd & { plist: string | null; later: string | null; finishRun(): void } {
  const f = {
    plist: null as string | null,
    /** The job file a pass asked for (`reloadAfter`), until `finishRun` stands in for that pass ending. */
    later: null as string | null,
    async install(p: string) { f.plist = p; },
    async uninstall() { f.plist = null; },
    async isLoaded() { return f.plist !== null; },
    async installed() { return f.plist; },
    async reloadAfter(p: string) { f.later = p; },
    finishRun() { if (f.later !== null) { f.plist = f.later; f.later = null; } },
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
