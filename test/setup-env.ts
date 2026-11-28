// Runs in every test file's own process before the file does (vitest.config.ts, setupFiles). It gives the file its own
// stand-ins for the PM's folders: PMX's home, the home folder a team repo is cloned into, the background job's file,
// and the Claude app's folder and settings. vitest.config.ts names one set per run, which every file running at the
// same time would share: one file's skills, job file or settings would then show in another file's checks, depending
// on which ran first. Nothing is created here; a test that writes there makes the folder, as on a PM's Mac.
// `freshHome()` (helpers.ts) and a test's own folders still replace these per test.
import { join } from "node:path";
import { tmp } from "./tmp.js";

// Made with tmp(), so it is removed with the file's other temp folders when its tests end (test/setup-tmp.ts). A
// handler for the process's "exit" doesn't do it: vitest stops a test file's process with a signal, which skips those.
const base = await tmp("pmx-test-");
const userHome = join(base, "user-home");
const claude = join(base, "claude");
Object.assign(process.env, {
  PMX_HOME: join(base, "home"),
  PMX_REPO_HOME_FOR_TESTS: userHome,
  PMX_LAUNCH_AGENT_FOR_TESTS: join(userHome, "Library", "LaunchAgents", "com.productmaxxing.pmx.plist"),
  PMX_OLD_LAUNCH_AGENT_FOR_TESTS: join(userHome, "Library", "LaunchAgents", "com.productgit.pmx.plist"),
  PMX_CLAUDE_HOME: claude,
  PMX_CLAUDE_DESKTOP_CONFIG: join(claude, "claude_desktop_config.json"),
});
