import type { TeamConfig } from "../core/config.js";
import type { Keychain } from "../core/keychain.js";
import { loadState, updateState } from "../core/state.js";

/**
 * How this machine reaches Linear, in the order PMX tries them (LINEAR-1, LINEAR-2). From 0.41.0 (Founder 2026-11-27)
 * a personal API key is the default: setup asks for one, and with it PMX reads and writes Linear itself on every
 * background run. The Claude relay is the fallback, for a PM who can't or won't create a key: no key or sign-in, but
 * changes wait for the Claude app's hourly task. Linear sign-in stays for the few who already signed in, but isn't
 * offered while ProductMaxxing's Linear app isn't registered.
 */
export type LinearAccess = "none" | "key" | "signed-in" | "hosted" | "relay";

export async function linearAccess(team: TeamConfig | null, keychain: Keychain): Promise<LinearAccess> {
  if (team?.tracker.kind !== "linear") return "none";
  if (await keychain.get("linear-token")) return "key";
  if (await keychain.get("linear-oauth")) return "signed-in";
  if (team.controlPlane) return "hosted";
  return "relay";
}

/**
 * Whether this PM was asked for a key and chose the Claude app instead (Return at the question). Remembered in
 * ~/.pmx/state.json, never in the settings file, so setup doesn't ask again and nothing nags; `pmx linear key` changes it.
 */
export async function choseClaudeApp(): Promise<boolean> {
  return (await loadState()).linearChoice?.via === "claude-app";
}

export async function rememberClaudeApp(now: Date): Promise<void> {
  await updateState((s) => { s.linearChoice = { via: "claude-app", at: now.toISOString() }; });
}

export async function forgetLinearChoice(): Promise<void> {
  if ((await loadState()).linearChoice) await updateState((s) => { s.linearChoice = null; });
}
