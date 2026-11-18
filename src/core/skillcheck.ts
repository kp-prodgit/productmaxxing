import { citedIds } from "./citations.js";
import { SIZES, type Size, type Stage } from "./types.js";

export interface SkillMeta {
  kind: "core" | "category";
  category?: string;
  /** Where in the product lifecycle the category's work sits (CAT-2). */
  stage?: Stage;
  output?: string;
  requiredHeadings?: string[];
  minCitations?: number;
  /** How a job runs — the environment binding (JOB-1). See resolveEnv/validateEnv. */
  env?: RawEnv;
  /** When synthesis should propose this kind of work (JOB-8): what in the evidence calls for it, and what doesn't. */
  propose?: { when?: string; not?: string };
}

export function skillMeta(skillText: string): SkillMeta {
  const fm = skillText.match(/^---\n([\s\S]*?)\n---/);
  const line = fm?.[1]?.split("\n").find((l) => l.startsWith("pmx:"));
  if (!line) return { kind: "core" };
  return JSON.parse(line.slice(4).trim()) as SkillMeta;
}

/**
 * The "environment" a job runs in (JOB-1): the runner binding an org can define per job.
 * Slice 0 only HONORS `kind: "document"` at run time; "brief"/"prototype" are reserved and a
 * run against them fails closed. `tools`/`output`/`maxTurns` for the document path default to
 * today's exact behavior, so existing jobs are unchanged. Secrets and egress never live here
 * (SKILL.md is the public export) — allowed domains stay in CODEOWNERS'd pmx.config.json.
 */
export type EnvKind = "document" | "brief" | "prototype";
export const ENV_KINDS: EnvKind[] = ["document", "brief", "prototype"];
export type OutputKind = "file" | "repo" | "url";
export const OUTPUT_KINDS: OutputKind[] = ["file", "repo", "url"];
/** The sealed tool allowlist a `document` job runs with today (P3). */
export const DEFAULT_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep"] as const;
/** Tools a job's env may name at all; document jobs are further restricted to DEFAULT_TOOLS. */
export const KNOWN_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash", "WebFetch", "WebSearch", "NotebookEdit"];

/** env as authored in the `pmx:` block — every field optional. */
export interface RawEnv {
  kind?: EnvKind;
  tools?: string[];
  template?: string | null;
  runtime?: string | null;
  output?: { kind?: OutputKind; path?: string };
  maxTurns?: number | null;
}

/** env with every field filled, as the runner and UI consume it. */
export interface EnvDef {
  kind: EnvKind;
  tools: string[];
  template: string | null;
  runtime: string | null;
  output: { kind: OutputKind; path: string };
  maxTurns: number | null;
}

/** The default output path for a kind, when a job doesn't name one. `file` keeps today's exact path. */
function defaultOutputPath(kind: OutputKind, category: string): string {
  if (kind === "repo") return `prototypes/${category}/{id}`;
  if (kind === "url") return `prototypes/${category}/{id}/PREVIEW.url`;
  return `outputs/${category}/{id}.md`;
}

/** Fill a job's authored env with defaults equal to today's behavior. */
export function resolveEnv(meta: SkillMeta, category?: string | null): EnvDef {
  const e = meta.env ?? {};
  const outKind: OutputKind = e.output?.kind ?? "file";
  return {
    kind: e.kind ?? "document",
    tools: e.tools && e.tools.length ? e.tools : [...DEFAULT_TOOLS],
    template: e.template ?? null,
    runtime: e.runtime ?? null,
    output: {
      kind: outKind,
      path: e.output?.path ?? defaultOutputPath(outKind, category ?? "{category}"),
    },
    maxTurns: e.maxTurns ?? null,
  };
}

/** Resolve a job's output path for one task: substitutes {category} and {id}. */
export function materializeOutput(env: EnvDef, category: string, id: string): string {
  return env.output.path.replaceAll("{category}", category).replaceAll("{id}", id);
}

/**
 * Validate an authored env (JOB-1), fail closed. A `document` job may not widen tools beyond the
 * sealed default set or change its output kind — widening needs a non-document environment, which
 * only a reviewed PR (CODEOWNERS) can introduce. Returns a list of problems (empty = valid).
 */
export function validateEnv(env: RawEnv | undefined): string[] {
  if (!env) return [];
  const problems: string[] = [];
  const kind = env.kind ?? "document";
  if (!ENV_KINDS.includes(kind)) problems.push(`env.kind must be one of ${ENV_KINDS.join(", ")}`);
  if (env.tools !== undefined) {
    if (!Array.isArray(env.tools) || env.tools.some((t) => typeof t !== "string")) problems.push("env.tools must be a list of tool names");
    else if (env.tools.length === 0) problems.push("env.tools must not be empty");
    else {
      const unknown = env.tools.filter((t) => !KNOWN_TOOLS.includes(t));
      if (unknown.length) problems.push(`env.tools has unknown tools: ${unknown.join(", ")}`);
      if (kind === "document") {
        const widened = env.tools.filter((t) => !(DEFAULT_TOOLS as readonly string[]).includes(t));
        if (widened.length) problems.push(`a "document" job may not use ${widened.join(", ")}; widening tools needs a non-document environment (reviewed via PR)`);
      }
    }
  }
  if (env.output?.kind !== undefined && !OUTPUT_KINDS.includes(env.output.kind)) problems.push(`env.output.kind must be one of ${OUTPUT_KINDS.join(", ")}`);
  if (kind === "document" && env.output?.kind && env.output.kind !== "file") problems.push(`a "document" job must have env.output.kind "file"`);
  if (env.maxTurns !== undefined && env.maxTurns !== null && (!Number.isInteger(env.maxTurns) || env.maxTurns <= 0 || env.maxTurns > 200)) problems.push("env.maxTurns must be a positive integer ≤ 200");
  if ((env as Record<string, unknown>).egress !== undefined) problems.push("env must not define egress; set allowed domains in pmx.config.json `egress` (CODEOWNERS-reviewed)");
  return problems;
}

export function skillName(skillText: string): string | null {
  return skillText.match(/^---\n[\s\S]*?^name:\s*(\S+)/m)?.[1] ?? null;
}

export interface OutputCheck {
  ok: boolean;
  problems: string[];
  citations: number;
}

/**
 * Checks a draft against the skill's machine-readable checklist: required headings, a minimum
 * number of citations, and no citation to a source the task didn't provide. Used by the smoke
 * test (SKILL-6), the neutrality test (B6) and every run before its PR opens.
 */
export function checkOutput(meta: SkillMeta, output: string, validIds?: Set<string>): OutputCheck {
  const problems: string[] = [];
  const headings = new Set([...output.matchAll(/^#{1,3}\s+(.+?)\s*$/gm)].map((m) => m[1]!.toLowerCase()));
  for (const h of meta.requiredHeadings ?? []) if (!headings.has(h.toLowerCase())) problems.push(`missing heading "${h}"`);
  const ids = output.split("\n").flatMap(citedIds);
  if (ids.length < (meta.minCitations ?? 0)) problems.push(`only ${ids.length} citations, need ${meta.minCitations}`);
  if (validIds) {
    const bad = [...new Set(ids.filter((i) => !validIds.has(i)))];
    if (bad.length) problems.push(`cites unknown sources: ${bad.join(", ")}`);
  }
  return { ok: problems.length === 0, problems, citations: ids.length };
}

/** Source IDs present in a task snapshot or fixture, e.g. `[T1]`, `id="S4"`. */
export function idsIn(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/\[([A-Z]\d+)\]|id="([A-Z]\d+)"/g)) ids.add((m[1] ?? m[2])!);
  return ids;
}

export interface SizeRubric {
  /** The per-category table: category → size → the cell's text. */
  cells: Record<string, Record<Size, string>>;
  /** Source-count ranges where a category's cells are countable: [min, max or null]. */
  ranges: Record<string, Partial<Record<Size, [number, number | null]>>>;
  /** The general rule per size, from the first table. */
  general: Record<Size, { run: string; rule: string }>;
}

/** Reads the `pmx-size` rubric, so sizes can be checked and explained (`pmx explain`). */
export function parseRubric(skillText: string): SizeRubric {
  const parts = skillText.split(/^## /m);
  const rows = (part = "") =>
    part.split("\n").filter((l) => l.startsWith("|") && !/^\|\s*-/.test(l)).slice(1).map((l) => l.split("|").slice(1, -1).map((c) => c.trim()));
  const cells: SizeRubric["cells"] = {};
  for (const r of rows(parts.find((p) => p.startsWith("Per category")))) if (r.length === 5) cells[r[0]!] = Object.fromEntries(SIZES.map((s, i) => [s, r[i + 1]!])) as Record<Size, string>;
  const general = {} as SizeRubric["general"];
  for (const r of rows(parts[0])) if (r.length === 3 && (SIZES as readonly string[]).includes(r[0]!)) general[r[0] as Size] = { run: r[1]!, rule: r[2]! };
  const meta = skillMeta(skillText) as SkillMeta & { sourceRanges?: SizeRubric["ranges"] };
  return { cells, ranges: meta.sourceRanges ?? {}, general };
}
