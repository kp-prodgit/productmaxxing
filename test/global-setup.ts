import { mkdirSync, readdirSync, rmdirSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { TestProject } from "vitest/node";

/**
 * A test run's temp folder: made before the first test, removed after the last, whether the tests passed or failed.
 *
 * vitest.config.ts points TMPDIR at it for every test. `os.tmpdir()` reads TMPDIR, so the folders the tests make
 * (`tmp()` in test/tmp.ts), the ones PMX's own code makes with `mkdtemp`, and whatever a command a test starts
 * puts in the temp folder all land under this one. Nothing removed them before, and a full run left about 2,200
 * folders and 550 MB in the Mac's temp folder.
 *
 * Most of it is gone before the end: each test file removes what it made with `tmp()` as it ends (test/setup-tmp.ts).
 * What is left for the end is what `tmp()` didn't make, and anything a test file couldn't remove.
 *
 * A run that is killed can't remove its folder, and one that is interrupted may not manage to: its test processes go
 * on writing for a moment after it. So every run's folder is pmx-test-runs/<the run's process ID>, and a run removes
 * the folders of runs whose process is gone, as it starts and again as it ends. What a killed run leaves lasts until
 * the next run.
 */
export default function setup(project: TestProject): () => Promise<void> {
  const dir = project.config.env.TMPDIR;
  const runs = dir ? dirname(dir) : "";
  // Only ever the folders vitest.config.ts named: a run started with some other TMPDIR removes nothing.
  if (!dir || basename(runs) !== "pmx-test-runs" || basename(dir) !== String(process.pid)) throw new Error(`vitest.config.ts should point TMPDIR at the run's own folder, pmx-test-runs/<pid>; it is ${dir ?? "not set"}`);
  const gone = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };
  /** Removes the folders of runs whose process is gone. One that can't be removed now is left for the next run. */
  const removeDeadRuns = async (): Promise<void> => {
    try {
      const dead = readdirSync(runs).filter((name) => /^\d+$/.test(name) && !alive(Number(name)));
      await Promise.all(dead.map((name) => rm(join(runs, name), gone)));
    } catch {
      // Never the tests' result: tidying up after another run must not fail this one.
    }
  };
  mkdirSync(runs, { recursive: true });
  // Not waited for here, so a killed run's 500 MB don't hold up this run's first test.
  const atStart = removeDeadRuns();
  mkdirSync(dir, { recursive: true });
  const last = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
      // The folder that holds the runs' folders goes too, unless another run is using it: then it isn't empty.
      rmdirSync(runs);
    } catch {
      // A test process is still writing, or another run is under way. The next run removes what this one couldn't.
    }
  };
  // When vitest ends without the teardown below (an interrupt), and for anything written after the teardown.
  process.once("exit", last);
  return async () => {
    await rm(dir, gone).catch(() => {});
    // Killed runs' folders again: their test processes can go on for a while and write more after the first pass.
    // Waited for 5 seconds at most, well inside the 10 that vitest allows for closing; the next run does the rest.
    await Promise.race([atStart.then(removeDeadRuns), new Promise((done) => setTimeout(done, 5000).unref())]);
    last();
  };
}

/** Whether a process has this ID. A run's folder is removed only when none does: its run can't be going on. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: there is such a process, and it is someone else's.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
