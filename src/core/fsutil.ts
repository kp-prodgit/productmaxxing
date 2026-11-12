import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (e: any) {
    if (e.code === "ENOENT") return null;
    throw new Error(`${path}: ${e.message}`);
  }
}

/** Atomic write: temp file then rename, so a crash never leaves half a config. */
export async function writeJson(path: string, value: unknown, mode = 0o600): Promise<void> {
  await writeText(path, JSON.stringify(value, null, 2) + "\n", mode);
}

export async function writeText(path: string, text: string, mode = 0o644): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, text, { mode });
  await rename(tmp, path);
}

export async function exists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (e: any) {
    return e.code === "EISDIR";
  }
}

/** Creates a directory readable only by this user (0700), tightening it if it already exists. */
export async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

/**
 * Runs `fn` while holding `<path>.lock`, so two PMX processes (the background job, the board's server, the Claude
 * app's `pmx mcp`) never read-modify-write the same store at once and lose each other's change. A lock older than
 * `staleMs` is from a process that died and is taken over.
 */
export async function withLock<T>(path: string, fn: () => Promise<T>, o: { waitMs?: number; staleMs?: number } = {}): Promise<T> {
  const { rm, stat } = await import("node:fs/promises");
  const lock = `${path}.lock`;
  const deadline = Date.now() + (o.waitMs ?? 15000);
  await mkdir(dirname(path), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch (e: any) {
      if (e.code !== "EEXIST") throw e;
      const age = await stat(lock).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > (o.staleMs ?? 60000)) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error(`${path} is busy: another PMX process is writing it. Try again in a moment.`);
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
