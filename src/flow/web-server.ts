import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { paths } from "../core/paths.js";
import { currentVersion } from "../core/version.js";

/**
 * `pmx flow --web` used to start a new server, with a new link, every time, so links from earlier runs said "link has
 * expired". It now records the running one here (BOARD-3), and a second `pmx flow --web` opens that one instead.
 * The link carries the page's token, so the file is private to the PM (0600, in ~/.pmx).
 */
export interface WebServerNote { pid: number; url: string; version: string; startedAt: string }
export const webServerFile = () => join(paths.home(), "flow-web.json");

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
  const u = new URL(note.url);
  const token = new URLSearchParams(u.hash.slice(1)).get("t") ?? "";
  const ok = await (o.fetch ?? fetch)(`${u.origin}/api/pipeline?hours=1`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) })
    .then((r) => r.ok, () => false);
  return ok ? note : null;
}
