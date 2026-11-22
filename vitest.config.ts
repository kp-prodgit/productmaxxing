import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "ee/test/**/*.test.ts"],
    testTimeout: 30000,
    // PMX_CLAUDE_HOME and PMX_CLAUDE_DESKTOP_CONFIG keep tests out of the real ~/.claude and the Claude app's settings.
    // PMX_PMXE=none: a PMX Engine installed on this Mac never reaches a test; the bridge tests pin a stand-in.
    // PMX_NO_DIALOG: no test can show a dialog on the Mac; tests that need an answer pass their own `confirm`.
    env: { PMX_NO_NOTIFY: "1", PMX_NO_DIALOG: "1", PMX_CLAUDE_HOME: join(tmpdir(), `pmx-test-claude-${process.pid}`), PMX_CLAUDE_DESKTOP_CONFIG: join(tmpdir(), `pmx-test-claude-${process.pid}`, "claude_desktop_config.json"), PMX_PMXE: "none" },
  },
});
