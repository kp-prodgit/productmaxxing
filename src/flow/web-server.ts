import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { join } from "node:path";
import type { Exec } from "../core/exec.js";
import { paths } from "../core/paths.js";
import { currentVersion } from "../core/version.js";

/**
 * `pmx flow --web` used to start a new server, with a new link, every time, so links from earlier runs said "link has
 * expired". It now records the running one here (BOARD-3), and a second `pmx flow --web` opens that one instead.
 * The link carries the page's token, so the file is private to the PM (0600, in ~/.pmx).
 */
export interface WebServerNote { pid: number; url: string; version: string; startedAt: string }
export const webServerFile = () => join(paths.home(), "flow-web.json");

/**
 * OBS-5: this Mac's page stops by itself after this long with no request, so a page started in the background and
 * forgotten doesn't run for days. A page left open in the browser asks every minute while it's visible, which keeps it
 * up. `PMX_PAGE_IDLE_MS` overrides it (tests). The Claude app's page then shows it as not running (BOARD-8).
 */
export const PAGE_IDLE_MS = Number(process.env.PMX_PAGE_IDLE_MS) > 0 ? Number(process.env.PMX_PAGE_IDLE_MS) : 4 * 3600000;

/**
 * Keeps this Mac's page up until Ctrl+C, a stop from the page in Claude (SIGTERM), or `idleMs` with no request; then
 * closes it and removes its note. Resolves with why it stopped.
 */
export function serveUntilStopped(s: { server: Server; close(): Promise<void> }, unnote: () => Promise<void>, o: { idleMs?: number; log?: (line: string) => void; signals?: boolean } = {}): Promise<"idle" | "signal"> {
  const idleMs = o.idleMs ?? PAGE_IDLE_MS;
  return new Promise((resolve) => {
    let done = false;
    const stop = (why: "idle" | "signal") => {
      if (done) return;
      done = true; unwatch();
      if (o.signals !== false) { process.off("SIGINT", onSig); process.off("SIGTERM", onSig); }
      void s.close().then(unnote).then(() => resolve(why), () => resolve(why));
    };
    const onSig = () => stop("signal");
    const unwatch = watchIdle(s.server, () => { o.log?.(`${new Date().toISOString()} No one used this page for ${Math.round(idleMs / 60000)} minutes, so it stopped.`); stop("idle"); }, idleMs);
    if (o.signals !== false) { process.on("SIGINT", onSig); process.on("SIGTERM", onSig); }
  });
}

/** Calls `onIdle` once `server` has had no request for `idleMs`. Returns how to stop watching. */
export function watchIdle(server: Server, onIdle: () => void, idleMs = PAGE_IDLE_MS): () => void {
  let last = Date.now();
  const seen = () => { last = Date.now(); };
  server.on("request", seen);
  const t = setInterval(() => { if (Date.now() - last >= idleMs) { stop(); onIdle(); } }, Math.max(20, Math.min(60000, Math.floor(idleMs / 4))));
  t.unref?.();
  const stop = () => { clearInterval(t); server.off("request", seen); };
  return stop;
}

export async function noteWebServer(url: string, now = new Date()): Promise<() => Promise<void>> {
  const note: WebServerNote = { pid: process.pid, url, version: currentVersion(), startedAt: now.toISOString() };
  await writeFile(webServerFile(), JSON.stringify(note), { mode: 0o600 });
  return async () => {
    const cur = await readNote();
    if (cur?.pid === process.pid) await rm(webServerFile(), { force: true });
  };
}

const readNote = () => readFile(webServerFile(), "utf8").then((t) => JSON.parse(t) as WebServerNote, () => null);

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * The server a previous `pmx flow --web` left running, if it still answers with its token and runs this pmx. One left
 * from an older pmx is stopped, so the board never shows old code; a note from a server that's gone is removed.
 */
export async function runningWebServer(o: { fetch?: typeof fetch; stop?: (pid: number) => void } = {}): Promise<WebServerNote | null> {
  const note = await readNote();
  if (!note) return null;
  if (!alive(note.pid)) { await rm(webServerFile(), { force: true }); return null; }
  if (note.version !== currentVersion()) {
    (o.stop ?? ((pid) => process.kill(pid, "SIGTERM")))(note.pid);
    await rm(webServerFile(), { force: true });
    return null;
  }
  return (await answers(note, o.fetch, 3000)) ? note : null;
}

/** Whether the server in a note answers with its token. */
async function answers(note: WebServerNote, f: typeof fetch = fetch, ms: number): Promise<boolean> {
  const u = new URL(note.url);
  const token = new URLSearchParams(u.hash.slice(1)).get("t") ?? "";
  return f(`${u.origin}/api/pipeline?hours=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ms) }).then((r) => r.ok, () => false);
}

/** This Mac's page as the Claude app's page sees it (BOARD-8): whether it runs and since when. Never its link or token. */
export interface LocalPage { running: boolean; since: string | null }

/** Whether this Mac's page is running now. Read-only: unlike `runningWebServer`, it never stops an older server. */
export async function webServerStatus(o: { fetch?: typeof fetch } = {}): Promise<LocalPage> {
  const note = await readNote();
  if (!note || !alive(note.pid)) return { running: false, since: null };
  return (await answers(note, o.fetch, 1500)) ? { running: true, since: note.startedAt } : { running: false, since: null };
}

/** The log of a page started in the background, which has no Terminal window to print to. */
export const webServerLog = () => join(paths.logs(), "flow-web.log");

/**
 * Starts `pmx open --no-open` on its own, outside the Claude app's process group, so the page keeps running after the
 * app quits. Its output goes to ~/.pmx/logs/flow-web.log.
 */
export async function launchWebServer(o: { node?: string; cli?: string } = {}): Promise<void> {
  await mkdir(paths.logs(), { recursive: true });
  const log = openSync(webServerLog(), "a", 0o600);
  const child = spawn(o.node ?? process.execPath, [o.cli ?? process.argv[1] ?? "", "open", "--no-open"], { detached: true, stdio: ["ignore", log, log] });
  child.on("error", () => {});
  child.unref();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Opens this Mac's page in the PM's browser, starting it first when it isn't running (BOARD-8). PMX runs `open` itself,
 * so the link and its token stay on this Mac: the caller learns only whether the page had to be started.
 */
export async function openWebServer(exec: Exec, o: { launch?: () => Promise<void>; running?: () => Promise<WebServerNote | null>; waitMs?: number; stepMs?: number } = {}): Promise<{ started: boolean }> {
  const running = o.running ?? (() => runningWebServer());
  let s = await running();
  const started = !s;
  if (!s) {
    await (o.launch ?? (() => launchWebServer()))();
    const end = Date.now() + (o.waitMs ?? 15000);
    while (!s && Date.now() < end) {
      await sleep(o.stepMs ?? 250);
      s = await running();
    }
    if (!s) throw new Error("PMX's page on this Mac didn't start. Run pmx open in Terminal to see why; its log is ~/.pmx/logs/flow-web.log.");
  }
  await exec("open", [s.url]);
  return { started };
}

/**
 * Stops this Mac's page, wherever it was started. Not the server answering this very call: that one is this page
 * itself, stopped with Ctrl+C where it runs.
 */
export async function stopWebServer(o: { kill?: (pid: number) => void; waitMs?: number } = {}): Promise<boolean> {
  const note = await readNote();
  if (!note || !alive(note.pid)) return false;
  if (note.pid === process.pid) throw new Error("This is the page on this Mac itself. Stop it with Ctrl+C in the Terminal window that runs it.");
  (o.kill ?? ((pid) => process.kill(pid, "SIGTERM")))(note.pid);
  const end = Date.now() + (o.waitMs ?? 3000);
  while (alive(note.pid) && Date.now() < end) await sleep(100);
  if (!alive(note.pid)) await rm(webServerFile(), { force: true });
  return true;
}
