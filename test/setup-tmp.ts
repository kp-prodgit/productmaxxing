import { afterAll } from "vitest";
import { removeTmp } from "./tmp.js";

// Runs in every test file (vitest.config.ts, setupFiles). When the file's tests have ended, passed or failed, the
// folders they made with tmp() are removed. Each file removes its own while the others still run, so the run doesn't
// end with one long removal, and a run never holds more on disk than the files running at that moment need.
// The time allowed is long on purpose: a slow disk must not turn tidying up into a failed test file.
afterAll(removeTmp, 120_000);
