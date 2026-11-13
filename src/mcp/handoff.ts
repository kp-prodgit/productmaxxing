import { spawn } from "node:child_process";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { installedVersion, pagesNote, stalePages } from "../claude/pages.js";
import type { PersonalConfig, TeamConfig } from "../core/config.js";
import type { Exec } from "../core/exec.js";
import { paths } from "../core/paths.js";
import { packageRoot } from "../core/skills.js";
import { currentVersion } from "../core/version.js";

/**
 * The Claude app starts `pmx mcp` once and keeps it running while the app is open. An update (`pmx update`, auto-update
 * or `npm install -g`) replaces the package under it, so the running server would keep answering with the old code, and
 * would load half of the new code the first time it imports a file lazily. From 0.24.1 it hands off instead: before each
 * message it checks the pmx installed on disk, and when that's a different version it starts the new `pmx mcp` once and
 * passes every message to it from then on. Servers from before 0.24.1 can't, so the Claude app has to be quit and
 * opened again once; `oldServers` finds them for `pmx doctor` and the update's output.
 */
export interface Next {
  send(line: string): void;
  close(): void;
}

/** Starts the installed `pmx mcp` and passes each line it answers to `write`. `onExit` runs if it stops. */
export function startNext(write: (line: string) => void, onExit: () => void): Next {
  const child = spawn(process.execPath, [process.argv[1]!, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });
  rl.on("line", (l) => { if (l.trim()) write(l); });
  child.on("exit", onExit);
  child.on("error", onExit);
  return { send: (l) => child.stdin!.write(`${l}\n`), close: () => child.stdin!.end() };
}

/** The tool list changed: the Claude app asks for it again, so a newer pmx's tools reach the page. */
export const LIST_CHANGED = JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

export interface HandoffDeps {
  running?: string;
  installed?: () => string;
  start?: typeof startNext;
}

/**
 * Decides, per message, whether this server answers it or the newer one does. `route(line)` returns true when the line
 * was passed on. Once handed off it stays handed off; if the newer server stops, the next message starts it again.
 */
export function handoff(write: (line: string) => void, d: HandoffDeps = {}) {
  const running = d.running ?? currentVersion();
  const installed = d.installed ?? installedVersion;
  const start = d.start ?? startNext;
  let next: Next | null = null;
  return {
    route(line: string): boolean {
      if (!next) {
        if (installed() === running) return false;
        next = start(write, () => { next = null; });
        write(LIST_CHANGED);
      }
      next.send(line);
      return true;
    },
    close() { next?.close(); },
    get handedOff() { return next !== null; },
  };
}

/**
 * Where each running server leaves a note, so PMX can tell its own servers that hand off from older ones that can't.
 * One file per process, removed when it exits.
 */
export const serversDir = () => join(paths.home(), "mcp-servers");

export async function noteServer(pid = process.pid, now = new Date()): Promise<() => Promise<void>> {
  const f = join(serversDir(), `${pid}.json`);
  await mkdir(serversDir(), { recursive: true, mode: 0o700 }).catch(() => {});
  await writeFile(f, JSON.stringify({ pid, version: currentVersion(), startedAt: now.toISOString(), handsOff: true }), { mode: 0o600 }).catch(() => {});
  return () => rm(f, { force: true }).catch(() => {});
}

export interface OldServer { pid: number; startedAt: string }

/**
 * `pmx mcp` processes started before the installed pmx was put in place and that left no note: servers from before
 * 0.24.1, still running the old code because the Claude app hasn't been restarted.
 */
export async function oldServers(exec: Exec, o: { installedAt?: Date | null } = {}): Promise<OldServer[]> {
  const r = await exec("ps", ["-Ao", "pid=,lstart=,command="], { timeoutMs: 10000 }).catch(() => null);
  if (!r || r.code !== 0) return [];
  const installedAt = o.installedAt ?? (await stat(join(packageRoot(), "package.json")).then((s) => s.mtime, () => null));
  if (!installedAt) return [];
  const noted = new Set((await readdir(serversDir()).catch(() => [] as string[])).map((f) => Number(f.replace(/\.json$/, ""))));
  const out: OldServer[] = [];
  for (const line of r.stdout.split("\n")) {
    // "  4321 Thu Nov 12 09:15:02 2026     /opt/homebrew/bin/node /opt/homebrew/lib/node_modules/productmaxxing/dist/src/cli.js mcp"
    const m = line.match(/^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
    if (!m || !/(productmaxxing|productgit)\/dist\/src\/cli\.js mcp\s*$/.test(m[3]!)) continue;
    const pid = Number(m[1]), started = new Date(m[2]!);
    if (pid === process.pid || noted.has(pid) || Number.isNaN(started.getTime())) continue;
    if (started < installedAt) out.push({ pid, startedAt: started.toISOString() });
  }
  return out;
}

/** What to tell the PM, and Claude, when an older server is still running. */
export function oldServerNote(n: number): string | null {
  if (!n) return null;
  return `The Claude app is still running PMX's server from the older pmx (${n === 1 ? "1 process" : `${n} processes`}), so your PMX page in Claude talks to the old code. Quit the Claude app completely (⌘Q, not just closing its window) and open it again. It then starts the new server; from now on PMX's server switches to a newly installed pmx by itself.`;
}

/**
 * Everything to do in the Claude app after an update, in order: restart the app if it still runs an old server, then
 * publish the pages again. Printed by `pmx update`, `pmx whats-new` and the first command after an npm install.
 */
export async function afterUpdateNote(team: Pick<TeamConfig, "board"> | null, personal: Pick<PersonalConfig, "flow" | "board"> | null, exec: Exec, version?: string): Promise<string | null> {
  const servers = await oldServers(exec);
  const parts = [oldServerNote(servers.length), pagesNote(stalePages(team, personal, version))].filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}
