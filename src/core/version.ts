import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec } from "./exec.js";
import { packageRoot } from "./skills.js";

/**
 * The newest schema of each file PMX writes (COMPAT-3). A reader refuses a file with a higher number,
 * so an old CLI never misreads or overwrites what a newer one wrote. Raise a number only for a change
 * old readers would get wrong; adding an optional field never needs it.
 */
export const SCHEMA = { teamConfig: 1, personalConfig: 1, receipt: 1, todos: 1 } as const;

/** Thrown when this CLI is too old for the team or for a file. Commands print it as-is. */
export class CompatError extends Error {
  readonly name = "CompatError";
}

let cached: string | null = null;
/** This CLI's version (synchronous, read once). */
export function currentVersion(): string {
  cached ??= JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")).version as string;
  return cached;
}

interface Parsed { core: [number, number, number]; pre: string[] | null }

// A test build is a version with a suffix: 0.41.0-next.2 (the `next` channel). Build metadata (+…) never counts.
// A number written with a leading zero (0.041.0, 0.41.0-next.01) isn't a version: semantic versioning says so, and npm
// refuses to publish one, so nothing here may take it for the version it resembles. The whole text has to be the
// version (a leading v and spaces around it aside): 0.41.0.1, 0.41 and "0.41.0 or so" aren't 0.41.0.
const NUM = "(0|[1-9]\\d*)";
const WORDS = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
const SHAPE = new RegExp(`^v?${NUM}\\.${NUM}\\.${NUM}(?:-(${WORDS}))?(?:\\+${WORDS})?$`);
const parse = (v: string): Parsed | null => {
  const m = v.trim().match(SHAPE);
  if (!m) return null;
  const pre = m[4] ? m[4].split(".") : null;
  if (pre?.some((part) => /^0\d+$/.test(part))) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre };
};

export const isVersion = (v: unknown): v is string => typeof v === "string" && parse(v) !== null;

/** A test build of a release that isn't out yet (0.41.0-next.2), never a release itself. */
export const isPrerelease = (v: unknown): v is string => typeof v === "string" && !!parse(v)?.pre;

/** Two suffixes, as semantic versioning orders them: part by part, numbers by value and before words, the shorter first. */
function comparePre(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) < Number(y) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * -1, 0 or 1 by major, minor, patch, then the suffix; null if either isn't a version. A test build comes before the
 * release it tests and after every release before that: 0.40.3 < 0.41.0-next.1 < 0.41.0-next.2 < 0.41.0. So a team
 * minimum of 0.41.0 isn't met by a test build of it, a team package at 0.41.0 replaces one, and an upgrade step
 * `since: "0.41.0"` is due on a Mac that reaches 0.41.0-next.N from 0.40.3 (and on one that moves between test builds).
 */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! < y.core[i]! ? -1 : 1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  return comparePre(x.pre, y.pre);
}

/** Whether `v` meets `min`. A minimum that isn't a version is never met: the team's settings refuse one before this is asked. */
export const atLeast = (v: string, min: string) => (compareVersions(v, min) ?? -1) >= 0;

export const UPDATE_HINT = "Run `pmx update` to install your team's version.";

/** COMPAT-3: refuses a file written with a newer schema than this CLI knows. */
export function assertSchema(kind: keyof typeof SCHEMA, v: unknown, where: string): void {
  if (typeof v === "number" && v > SCHEMA[kind])
    throw new CompatError(`${where} was written by a newer pmx (format ${v}; pmx ${currentVersion()} reads up to ${SCHEMA[kind]}). ${UPDATE_HINT}`);
}

/**
 * COMPAT-2: work that writes shared team state (tracker, leases, the meeting ledger, the brain, the
 * company roll-up) needs at least the team's minimum CLI version. Personal work never checks this.
 */
export function assertTeamVersion(team: { cli?: { min: string } | null }, version = currentVersion()): void {
  const min = team.cli?.min;
  if (min && !atLeast(version, min))
    throw new CompatError(`This machine runs pmx ${version}, and your team needs ${min} or newer for shared work. Your digest, to-dos and explain still work. ${UPDATE_HINT}`);
}

/** The version of the CLI package stored in the PMX repo, read from inside the .tgz. */
export async function vendoredVersion(tgz: string, exec: Exec): Promise<string | null> {
  const r = await exec("tar", ["-xOzf", tgz, "package/package.json"], { timeoutMs: 20000 });
  if (r.code !== 0) return null;
  try {
    const v = JSON.parse(r.stdout).version;
    return isVersion(v) ? v : null;
  } catch {
    return null;
  }
}
