// The one place PMX talks to PMX Engine (Q16; phase 2 of pmx-engine/docs/07-join-with-pmx.md).
// It runs the `pmxe` command and reads only its versioned JSON: checks and release notes, never content. It never
// reads Engine's files, and nothing that answers a Claude chat (pmx mcp, the /pmx-flow artifact) imports it. A test
// holds both rules (test/engine-bridge.test.ts).
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Exec } from "../core/exec.js";

/** The JSON format PMX understands from `pmxe doctor --json` and `pmxe whats-new --json`. */
export const ENGINE_FORMAT = 1;

/** Where `npm install -g pmx-engine` usually puts the command, for a shell or job whose PATH lacks it. */
export const pmxeCandidates = (home = homedir()) => ["/opt/homebrew/bin/pmxe", "/usr/local/bin/pmxe", join(home, ".local/bin/pmxe"), join(home, ".npm-global/bin/pmxe")];

export interface Pmxe {
  cmd: string;
  version: string;
}

/**
 * Finds PMX Engine's command. Null when Engine isn't installed, as on every PM's Mac: then nothing in PMX changes.
 * PMX_PMXE pins the command (tests), and PMX_PMXE=none turns Engine off for PMX.
 */
export async function findPmxe(exec: Exec): Promise<Pmxe | null> {
  const pinned = process.env.PMX_PMXE;
  if (pinned === "none") return null;
  for (const cmd of pinned ? [pinned] : ["pmxe", ...pmxeCandidates()]) {
    const r = await exec(cmd, ["--version"], { timeoutMs: 10000 });
    const v = r.code === 0 ? r.stdout.trim() : "";
    if (/^\d+\.\d+\.\d+$/.test(v)) return { cmd, version: v };
  }
  return null;
}

/** A `pmxe … --json` answer, only at a format PMX knows. */
async function readJson(exec: Exec, p: Pmxe, args: string[]): Promise<Record<string, unknown> | null> {
  const r = await exec(p.cmd, args, { timeoutMs: 30000 });
  try {
    const j = JSON.parse(r.stdout) as unknown;
    return j && typeof j === "object" && (j as Record<string, unknown>).format === ENGINE_FORMAT ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface EngineCheck {
  id: string;
  ok: boolean;
  detail: string;
  /** Engine's problems never fail `pmx doctor`: PMX's own work doesn't wait on them. */
  level: "warn";
}

/** Engine's part of `pmx doctor`: one line, then each problem `pmxe doctor` found. Empty without Engine. */
export async function engineChecks(exec: Exec): Promise<EngineCheck[]> {
  const p = await findPmxe(exec);
  if (!p) return [];
  const j = await readJson(exec, p, ["doctor", "--json"]);
  if (!j) return [{ id: "engine", ok: false, level: "warn", detail: `PMX Engine ${p.version} is installed, but this pmx can't read its checks. Run pmxe doctor.` }];
  const checks = Array.isArray(j.checks) ? (j.checks as { level?: unknown; text?: unknown }[]) : [];
  const problems = checks.filter((c) => c.level === "warn" || c.level === "fail");
  const ws = typeof j.workspace === "string" ? j.workspace.replace(homedir(), "~") : null;
  return [
    { id: "engine", ok: true, level: "warn", detail: `PMX Engine ${p.version}${ws ? `, workspace folder ${ws}` : ""}: ${problems.length ? `${problems.length} to look at (pmxe doctor)` : "every check passes"}` },
    ...problems.map((c, i) => ({ id: `engine.${i + 1}`, ok: false, level: "warn" as const, detail: `PMX Engine: ${String(c.text ?? "")}` })),
  ];
}

export interface EngineNotes {
  version: string;
  since: string | null;
  notes: { version: string; title: string }[];
}

/**
 * Engine's release notes this Mac hasn't seen, for `pmx whats-new`. Reading them marks them seen in Engine too, so
 * the head of product is told once, wherever they look. Null without Engine or at a format PMX doesn't know.
 */
export async function engineNotes(exec: Exec): Promise<EngineNotes | null> {
  const p = await findPmxe(exec);
  if (!p) return null;
  const j = await readJson(exec, p, ["whats-new", "--json"]);
  if (!j) return null;
  const notes = Array.isArray(j.notes) ? (j.notes as { version?: unknown; title?: unknown }[]).map((n) => ({ version: String(n.version ?? ""), title: String(n.title ?? "") })) : [];
  return { version: p.version, since: typeof j.since === "string" ? j.since : null, notes };
}

/** How `pmx whats-new` shows Engine's notes. Empty when there are none. */
export function formatEngineNotes(e: EngineNotes | null): string {
  if (!e || !e.notes.length) return "";
  return [`PMX Engine ${e.version}`, ...e.notes.map((n) => `  ${n.version}${n.title ? `: ${n.title}` : ""}`), `  The details: pmxe whats-new${e.since ? ` --since ${e.since}` : ""}`].join("\n");
}

/** Starts the studio, which opens in its own browser tab on this Mac. A studio already running is reused. */
export function openStudio(p: Pmxe): void {
  const child = spawn(p.cmd, ["studio"], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

/**
 * SETUP-1: PMX Engine's own checklist, in one line for PMX's: where the head of product stands and Engine's next
 * step. Reads only `pmxe checklist --json` (format 1), never Engine's files. Null without Engine, or an Engine too old
 * to have a checklist (then PMX says only its version).
 */
export async function engineChecklist(exec: Exec): Promise<{ version: string; where: string; next: string | null } | null> {
  const p = await findPmxe(exec);
  if (!p) return null;
  const j = await readJson(exec, p, ["checklist", "--json"]);
  if (!j || j.tool !== "pmxe") return { version: p.version, where: "an older PMX Engine with no checklist; pmxe doctor shows its checks", next: null };
  const next = j.next && typeof j.next === "object" ? String((j.next as Record<string, unknown>).title ?? "") || null : null;
  return { version: p.version, where: String(j.where ?? ""), next };
}
