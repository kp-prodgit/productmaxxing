import { execFile } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number },
) => Promise<ExecResult>;

/**
 * The parts of this Mac a test must never reach for real: launchd (`launchctl`, whose label is the user's own running
 * job), the keychain (`security`) and whatever `open` would start (the browser, an app). vitest.config.ts sets
 * PMX_TEST_NO_REAL_SYSTEM, and then each of these throws instead of running, so a test that gets here without its own
 * stand-in (`fakeLaunchd`, `memoryKeychain`, its own `exec`) fails loudly rather than touching the Mac it runs on.
 */
const NEVER_IN_TESTS = new Set(["launchctl", "security", "open"]);
export function realSystemGuard(what: string): void {
  if (process.env.PMX_TEST_NO_REAL_SYSTEM) throw new Error(`A test reached the real ${what}. Tests pass their own stand-in (fakeLaunchd, memoryKeychain, a fake exec); nothing under vitest may touch this Mac's launchd, keychain or browser.`);
}

/**
 * PMX runs on macOS only for now (SCOPE-3). Under PMX_TEST_NO_REAL_SYSTEM every Mac-only tool above throws and a test
 * passes its own stand-in, so the tests don't need a Mac: CI runs a pull request's tests on Linux, where this still
 * answers yes. Outside the tests it is the real platform, and nothing a person can set changes what PMX runs on a Mac.
 */
export const onMac = (): boolean => process.platform === "darwin" || !!process.env.PMX_TEST_NO_REAL_SYSTEM;

/** Runs a command without a shell. Never throws on a non-zero exit; check `code`. */
export const exec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const name = cmd.split("/").pop()!;
    if (NEVER_IN_TESTS.has(name)) realSystemGuard(`\`${name} ${args.join(" ")}\``);
    const child = execFile(
      cmd,
      args,
      { cwd: opts.cwd, env: opts.env ?? process.env, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0;
        resolve({ stdout: String(stdout), stderr: String(stderr) || (err && code !== 0 ? err.message : ""), code });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });

export async function execOk(...a: Parameters<Exec>): Promise<string> {
  const r = await exec(...a);
  if (r.code !== 0) throw new Error(`${a[0]} ${a[1].join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}
