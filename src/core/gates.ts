import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { writeJson } from "./fsutil.js";
import { paths } from "./paths.js";

/**
 * What the background run's model steps last read (MEET-3, COMPANY-1, BRAIN-4), in `~/.pmx/gates.json`: private,
 * local, never synced. A step whose inputs are the same as the last time it called the model makes no call, and says
 * so in the job's log. Hashes only, except the roll-up's last answer, which is about tasks already in Linear.
 *
 * It only ever saves a call. A file that's missing, unreadable or shaped differently reads as nothing remembered, so
 * the step runs; a write that fails is ignored, so the step runs again next time.
 */
export interface Gates {
  /** Synthesis: each channel or email thread as it was the last time the model read it (`threadPrint` → when). */
  synth?: { at: string; threads: Record<string, string> };
  /** The company roll-up: its inputs' hash and the model's answer to them. */
  rollup?: { at: string; key: string; answer: string };
  /** The brain: its inputs' hash at its last pass. */
  brain?: { at: string; key: string };
}

/** One hash of several parts, where no part can run into the next. */
export const gateKey = (...parts: string[]): string => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** What's remembered. Never throws: nothing remembered means every step runs. */
export async function loadGates(): Promise<Gates> {
  try {
    const raw = JSON.parse(await readFile(paths.gates(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Gates) : {};
  } catch {
    return {};
  }
}

/** Remembers one step's inputs. Never throws: a step that ran has done its work whether or not this is saved. */
export async function saveGate<K extends keyof Gates>(step: K, value: NonNullable<Gates[K]>): Promise<void> {
  try {
    await writeJson(paths.gates(), { ...(await loadGates()), [step]: value });
  } catch {}
}

/** "2026-11-27 04:00 UTC", as the job's log writes a time. */
export const gateTime = (iso: string): string => `${iso.slice(0, 16).replace("T", " ")} UTC`;
