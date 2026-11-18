import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveEnv, skillMeta, validateEnv, type EnvDef } from "./skillcheck.js";
import { paths } from "./paths.js";

/** Root of the installed package: <root>/src/core or <root>/dist/src/core. */
export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.includes(join("dist", "src")) ? join(here, "..", "..", "..") : join(here, "..", "..");
}

/** Skills bundled with the CLI. Teams copy them into their PMX repo at init (NEUT-2). */
export function bundledSkillsDir(): string {
  return process.env.PMX_SKILLS_DIR ?? join(packageRoot(), "skills");
}

/** Team skills live in the PMX repo at `.claude/skills/<name>/SKILL.md`, changed only by PR. */
export function teamSkillPath(repoPath: string, skill: string): string {
  return join(repoPath, ".claude", "skills", skill, "SKILL.md");
}

/** Where a skill a run loaded came from. Org skills are synced from Linear into a per-machine cache (JOB). */
export type SkillSource = "team" | "org" | "bundled";

/** Org skills synced from Linear sit in a per-machine cache, between team (PR-reviewed) and bundled (tiered trust). */
export function orgSkillPath(skill: string): string {
  return join(paths.orgSkills(), skill, "SKILL.md");
}

export async function loadSkill(repoPath: string, skill: string): Promise<{ text: string; version: string; source: SkillSource }> {
  for (const [path, source] of [
    [teamSkillPath(repoPath, skill), "team"],
    [orgSkillPath(skill), "org"],
    [join(bundledSkillsDir(), skill, "SKILL.md"), "bundled"],
  ] as const) {
    try {
      const text = await readFile(path, "utf8");
      return { text, version: createHash("sha256").update(text).digest("hex").slice(0, 12), source };
    } catch {}
  }
  throw new Error(`Skill ${skill} not found in ${join(repoPath, ".claude", "skills")}, the org cache, or the bundled skills.`);
}

export interface SkillVerdict {
  ok: boolean;
  reason?: string;
  /** True only when an org skill matched a hash in the allowlist (for provenance). */
  allowlisted: boolean;
}

/**
 * Tiered trust at run time (JOB): team/bundled skills are git-reviewed and always allowed. A Linear-synced
 * ("org") skill is allowed as-is when no allowlist is set; when `allow` (pmx.config.json `skills`) is set, the
 * skill must be pinned to its exact content hash or the run is refused (fail closed). Dropping a hash kills it.
 */
export function verifySkill(allow: Record<string, string> | null | undefined, name: string, loaded: { source: SkillSource; version: string }): SkillVerdict {
  if (loaded.source !== "org") return { ok: true, allowlisted: false };
  if (!allow) return { ok: true, allowlisted: false };
  const pinned = allow[name];
  if (pinned === undefined) return { ok: false, reason: `org skill "${name}" is not in the hash allowlist (add it to pmx.config.json \`skills\`, via a reviewed PR)`, allowlisted: false };
  if (pinned !== loaded.version) return { ok: false, reason: `org skill "${name}" hash ${loaded.version} is not the allowlisted ${pinned}`, allowlisted: false };
  return { ok: true, allowlisted: true };
}

export async function listBundledSkills(): Promise<string[]> {
  return (await readdir(bundledSkillsDir(), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/**
 * The categories a model may choose from, each with its skill's description, so Claude chooses by what the work is
 * and not by the name alone (CAT-2). A category whose skill is missing is listed by name only.
 */
export async function categoryMenu(repoPath: string, categories: Record<string, { skill: string }>): Promise<string> {
  const lines = await Promise.all(Object.entries(categories).map(async ([id, c]) => {
    const text = await loadSkill(repoPath, c.skill).then((s) => s.text, () => "");
    const d = text ? frontmatter(text).description ?? "" : "";
    if (!d) return `- ${id}`;
    // A team's own kind of work says when to propose it (JOB-8); those rules are what make it get proposed.
    let p: ReturnType<typeof proposeOf> = null;
    try { p = proposeOf(skillMeta(text)); } catch {}
    return [`- ${id}: ${d}`, p ? `  Propose it when: ${p.when}` : null, p?.not ? `  Don't propose it when: ${p.not}` : null].filter(Boolean).join("\n");
  }));
  return ["Categories you may use (the id before the colon is the value for `category`):", ...lines].join("\n");
}

/** A skill's `pmx.propose` rules, when they're well formed. */
export function proposeOf(meta: { propose?: unknown }): { when: string; not?: string } | null {
  const p = meta.propose as { when?: unknown; not?: unknown } | undefined;
  if (!p || typeof p.when !== "string" || !p.when.trim()) return null;
  const one = (v: string) => v.replace(/\s+/g, " ").trim().slice(0, 300);
  return { when: one(p.when), ...(typeof p.not === "string" && p.not.trim() ? { not: one(p.not) } : {}) };
}

/** Strips YAML frontmatter, leaving the instructions. */
export function skillBody(text: string): string {
  return text.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
}

/** Which command runs which skill. Commands import their skill names from here, so this can't drift. */
export const SKILL_USES = {
  digest: ["pmx-digest"],
  synthesize: ["pmx-synthesize", "pmx-size"],
  brain: ["pmx-brain", "pmx-size"],
} as const;

const USED_BY: Record<string, string> = {
  "pmx-digest": "`pmx digest`: writes your weekly digest from your calls",
  "pmx-synthesize": "`pmx synthesize`: turns team signals into suggested tasks",
  "pmx-size": "`pmx synthesize`: the rubric it sizes each task with (S, M, L, XL)",
  "pmx-todo": "`pmx todo --refresh`: finds your own to-dos in your meetings; they stay on your Mac",
  "pmx-rollup": "`pmx company`: merges teams' tasks into company-level themes",
  "pmx-brain": "`pmx brain` (Team plan): assesses the board and proposes next actions; fixed rules decide what happens",
  "pmx-pull": "Not used by PMX runs. Helps you steer the queue from your own Claude Code session if you install the plugin",
};

export interface SkillInfo {
  name: string;
  description: string;
  kind: "core" | "category";
  category: string | null;
  usedBy: string;
  /** Precedence: a "team" copy (PR-reviewed) wins over an "org" copy (synced from Linear), which wins over "bundled". */
  runs: SkillSource;
  version: string;
  /** "differs from built-in" means the team edited it, or this pmx has a newer built-in copy. "org …" is a Linear-synced skill. */
  status: "same as built-in" | "differs from built-in" | "team only" | "built-in only" | "org only" | "org shadows built-in";
  path: string;
  /** A category skill's checklist from its `pmx:` frontmatter: the file a run must write and what it must contain. */
  check?: { output: string | null; sections: string[]; minCitations: number; stage: string | null };
  /** The job's resolved environment (JOB-1): how it runs — kind, tool allowlist, output shape. */
  env: EnvDef;
  /** Problems with the authored env (empty = valid). A job with problems is rejected at run time. */
  envProblems: string[];
  /** When synthesis should propose this kind of work (JOB-8), from `pmx.propose`. */
  propose?: { when: string; not?: string };
}

const hash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);

/** Every skill a PMX run can load, with what it does and when it runs (`pmx skills`, `pmx explain`). */
export async function skillInventory(repoPath: string, categories: Record<string, { skill: string }>): Promise<SkillInfo[]> {
  const dirNames = (d: string) => readdir(d, { withFileTypes: true }).then((es) => es.filter((e) => e.isDirectory()).map((e) => e.name), () => [] as string[]);
  const teamNames = await dirNames(join(repoPath, ".claude", "skills"));
  const orgNames = await dirNames(paths.orgSkills());
  const names = [...new Set([...(await listBundledSkills()), ...teamNames, ...orgNames])].sort();
  const read = (p: string) => readFile(p, "utf8").catch(() => null);
  const out: SkillInfo[] = [];
  for (const name of names) {
    const team = await read(teamSkillPath(repoPath, name));
    const org = await read(orgSkillPath(name));
    const bundled = await read(join(bundledSkillsDir(), name, "SKILL.md"));
    const text = (team ?? org ?? bundled)!;
    const meta = frontmatter(text);
    const category = Object.entries(categories).find(([, c]) => c.skill === name)?.[0] ?? null;
    const pmx = meta.pmx ? (JSON.parse(meta.pmx) as { kind?: "core" | "category"; category?: string; stage?: string; output?: string; requiredHeadings?: string[]; minCitations?: number }) : {};
    const fullMeta = skillMeta(text);
    const env = resolveEnv(fullMeta, category ?? pmx.category ?? null);
    const envProblems = validateEnv(fullMeta.env);
    out.push({
      name,
      description: meta.description ?? "",
      kind: pmx.kind ?? "core",
      category: category ?? pmx.category ?? null,
      usedBy: USED_BY[name] ?? (category ? `\`pmx pull\`: drafts ${category} tasks` : "Not used by this team's config"),
      runs: team ? "team" : org ? "org" : "bundled",
      version: hash(text),
      status: team
        ? !bundled ? "team only" : hash(team) === hash(bundled) ? "same as built-in" : "differs from built-in"
        : org
          ? !bundled ? "org only" : hash(org) === hash(bundled) ? "same as built-in" : "org shadows built-in"
          : "built-in only",
      path: team ? teamSkillPath(repoPath, name) : org ? orgSkillPath(name) : join(bundledSkillsDir(), name, "SKILL.md"),
      env,
      envProblems,
      ...(proposeOf(fullMeta) ? { propose: proposeOf(fullMeta)! } : {}),
      ...(pmx.kind === "category" ? { check: { output: pmx.output ?? null, sections: pmx.requiredHeadings ?? [], minCitations: pmx.minCitations ?? 0, stage: pmx.stage ?? null } } : {}),
    });
  }
  return out;
}

function frontmatter(text: string): Record<string, string> {
  const fm = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
  // A double-quoted value (as the kind-of-work template writes `description`, so ": " and " #" stay valid YAML) is unquoted.
  const unquote = (v: string) => { if (/^".*"$/.test(v)) { try { return String(JSON.parse(v)); } catch {} } return v; };
  return Object.fromEntries(fm.split("\n").map((l) => l.match(/^(\w+):\s*(.*)$/)).filter((m): m is RegExpMatchArray => !!m).map((m) => [m[1]!, unquote(m[2]!)]));
}
