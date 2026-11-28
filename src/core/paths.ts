import { homedir } from "node:os";
import { join } from "node:path";

/** Root of everything personal to this machine. Never synced (PRIV-1). */
export function pmxHome(): string {
  return process.env.PMX_HOME ?? join(homedir(), ".pmx");
}

export const paths = {
  home: () => pmxHome(),
  config: () => join(pmxHome(), "config.json"),
  state: () => join(pmxHome(), "state.json"),
  /** What the background run's model steps last read, so an unchanged input costs no model call (src/core/gates.ts). */
  gates: () => join(pmxHome(), "gates.json"),
  policy: () => join(pmxHome(), "policy.json"),
  license: () => join(pmxHome(), "license.jwt"),
  /** The clean Claude Code profile (B1). */
  claudeProfile: () => join(pmxHome(), "claude"),
  runSettings: () => join(pmxHome(), "claude", "pmx-run-settings.json"),
  /** RUN-6: the settings for a run of a kind of work the team opened to the web (competitive analysis only). */
  webRunSettings: () => join(pmxHome(), "claude", "pmx-run-settings-web.json"),
  mcpConfig: () => join(pmxHome(), "claude", "pmx-mcp.json"),
  staging: () => join(pmxHome(), "staging"),
  /** Run receipts for `pmx explain` (PRIV-4): private, local, never synced. */
  receipts: () => join(pmxHome(), "receipts"),
  /** The brain's assessments and approval queue (BRAIN-4): private, local, never synced. */
  brain: () => join(pmxHome(), "brain"),
  transcripts: () => join(pmxHome(), "transcripts"),
  /** Threads from the team's approved channels (INPUT-1), one file each: private, local, never synced. */
  threads: () => join(pmxHome(), "threads"),
  /** Individual to-dos (TODO-1): private, local, never synced. */
  todos: () => join(pmxHome(), "todos.json"),
  worktrees: () => join(pmxHome(), "worktrees"),
  /** Org skills synced from Linear (JOB, tiered trust): a per-machine cache, never the git repo. */
  orgSkills: () => join(pmxHome(), "org-skills"),
  /** Raw skill docs the Linear sync task exports for `pmx skills sync` to validate and materialize. */
  orgSkillsExport: () => join(pmxHome(), "linear", "skills"),
  logs: () => join(pmxHome(), "logs"),
  /** The background job's file. Tests point PMX_LAUNCH_AGENT_FOR_TESTS elsewhere, so none can write the user's own job file. */
  launchAgent: () => process.env.PMX_LAUNCH_AGENT_FOR_TESTS ?? join(homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
};

export const LAUNCHD_LABEL = "com.productmaxxing.pmx";
export const KEYCHAIN_SERVICE = "productmaxxing";
export const TEAM_CONFIG_FILE = "pmx.config.json";
export const KILL_SWITCH_FILE = "pmx.stop";
export const RUNLOG_BRANCH = "pmx/runlog";
/** RUN-5: where the team repo keeps approved tasks' evidence packs: `refs/pmx/evidence/<task>`, one `<task>.json` each. Never main. */
export const EVIDENCE_REFS = "refs/pmx/evidence";
/** PULL-14: each task's last PMX step (a draft in review, done, rejected, dropped, back to Ready): `refs/pmx/task-state/<task>`. Never main. */
export const TASK_STATE_REFS = "refs/pmx/task-state";
