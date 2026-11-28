import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "ee/test/**/*.test.ts"],
    // Limits for a busy machine, not an idle one. Many tests here drive real git (hundreds of processes each) and a
    // page in jsdom: with several suites on one Mac they run five times slower, and a limit sized for an idle Mac
    // (30 seconds a test, 10 a hook) then failed dozens of tests that were only slow. A test that runs out of time
    // also doesn't stop: it goes on writing while the next test runs. A passing test takes no longer for a higher
    // limit; only a test that really hangs is reported later.
    testTimeout: 120000,
    hookTimeout: 60000,
    // Each test file gets its own copy of the folders named in `env` below (test/setup-env.ts): the ones here are per
    // run, so files running at the same time would share them. They stay as the fallback, so nothing can reach the
    // real folders even if the setup file doesn't run.
    setupFiles: ["test/setup-env.ts"],
    // PMX_CLAUDE_HOME and PMX_CLAUDE_DESKTOP_CONFIG keep tests out of the real ~/.claude and the Claude app's settings.
    // PMX_PMXE=none: a PMX Engine installed on this Mac never reaches a test; the bridge tests pin a stand-in.
    // PMX_NO_DIALOG: no test can show a dialog on the Mac; tests that need an answer pass their own `confirm`.
    // PMX_REPO_HOME_FOR_TESTS: `pmx init` looks for, clones and creates the team repo under it, never in the real ~/pmx.
    // PMX_TEST_NO_REAL_SYSTEM: the real launchctl, keychain (`security`), `open` and `claude auth login` throw instead of
    // running (src/core/exec.ts), so a test without its own stand-in fails rather than touching this Mac.
    // PMX_LAUNCH_AGENT_FOR_TESTS: the background job's file is never the one in the real ~/Library/LaunchAgents.
    // PMX_HOME: a test that forgets `freshHome()` gets a temp folder, never the real ~/.pmx.
    env: { PMX_NO_NOTIFY: "1", PMX_NO_DIALOG: "1", PMX_TEST_NO_REAL_SYSTEM: "1", PMX_HOME: join(tmpdir(), `pmx-test-home-${process.pid}`), PMX_OLD_LAUNCH_AGENT_FOR_TESTS: join(tmpdir(), `pmx-test-user-home-${process.pid}`, "Library", "LaunchAgents", "com.productgit.pmx.plist"),
      PMX_LAUNCH_AGENT_FOR_TESTS: join(tmpdir(), `pmx-test-user-home-${process.pid}`, "Library", "LaunchAgents", "com.productmaxxing.pmx.plist"), PMX_REPO_HOME_FOR_TESTS: join(tmpdir(), `pmx-test-user-home-${process.pid}`), PMX_CLAUDE_HOME: join(tmpdir(), `pmx-test-claude-${process.pid}`), PMX_CLAUDE_DESKTOP_CONFIG: join(tmpdir(), `pmx-test-claude-${process.pid}`, "claude_desktop_config.json"), PMX_PMXE: "none" },
  },
});
