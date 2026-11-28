import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The tests' temp folders. This imports nothing of PMX's, so test/setup-tmp.ts can load it in every test file without
// loading a module that a test goes on to replace with vi.mock.

/** The folders tmp() has made for the test file that is running, until removeTmp() takes them away. */
const made: string[] = [];

/** A fresh temp folder for a test. It is removed when the test file ends (test/setup-tmp.ts), so no test removes its own. */
export async function tmp(prefix = "pmx-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/**
 * Removes every folder tmp() made for this test file. A folder that can't be removed yet (something a test started
 * is still writing to it) is left for the end of the run, which removes the whole run's folder (test/global-setup.ts).
 */
export async function removeTmp(): Promise<void> {
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {})));
}
