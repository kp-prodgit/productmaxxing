import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paths } from "./paths.js";
import { listBundledSkills, orgSkillPath } from "./skills.js";
import { resolveEnv, skillMeta, skillName, validateEnv } from "./skillcheck.js";

/** A skill body larger than this is treated as corrupt/truncated and refused (JOB, Linear distribution). */
export const MAX_SKILL_BYTES = 64 * 1024;

export interface OrgSyncReport {
  from: string;
  adopted: string[];
  rejected: { name: string; reasons: string[] }[];
}

/**
 * Shared tiered-trust validation for an org skill, used by both the consume side (`pmx skills sync`) and the
 * publish side (`pmx skills publish`). Returns the parsed name and the reasons it cannot be a runnable org
 * skill (empty = valid). Only a valid **document** job that doesn't collide with or shadow built-ins passes;
 * anything that widens tools or defines a non-document environment must go through a reviewed git PR instead.
 */
export async function validateOrgSkill(text: string, expectedName: string): Promise<{ name: string | null; reasons: string[] }> {
  const reasons: string[] = [];
  const bundled = new Set(await listBundledSkills());
  if (Buffer.byteLength(text, "utf8") > MAX_SKILL_BYTES) reasons.push(`larger than ${MAX_SKILL_BYTES / 1024}KB (possibly truncated)`);
  const name = skillName(text);
  if (!name) reasons.push("no `name:` in the frontmatter");
  else {
    if (name !== expectedName) reasons.push(`name "${name}" doesn't match "${expectedName}"`);
    if (name.startsWith("pmx-")) reasons.push(`"${name}" uses the reserved pmx- prefix`);
    if (bundled.has(name)) reasons.push(`"${name}" would shadow a built-in skill; org skills must be namespaced`);
  }
  let meta;
  try {
    meta = skillMeta(text);
  } catch {
    reasons.push("the `pmx:` frontmatter is not valid JSON");
  }
  if (meta) {
    reasons.push(...validateEnv(meta.env));
    const env = resolveEnv(meta, meta.category ?? name ?? undefined);
    if (env.kind !== "document") reasons.push(`environment kind "${env.kind}" must be reviewed via a git PR, not shared through Linear (tiered trust)`);
  }
  return { name, reasons };
}

/**
 * Validate and materialize org skills exported from Linear into the per-machine cache (`~/.pmx/org-skills`),
 * where runs pick them up with precedence team > org > bundled. Only valid document jobs are adopted (tiered
 * trust). Reject-and-keep-prior: a refused skill never overwrites or removes the cached copy. An absent export
 * is a no-op (offline/empty).
 */
export async function syncOrgSkills(opts: { fromDir?: string } = {}): Promise<OrgSyncReport> {
  const from = opts.fromDir ?? paths.orgSkillsExport();
  const adopted: string[] = [];
  const rejected: { name: string; reasons: string[] }[] = [];

  let files: string[];
  try {
    files = (await readdir(from, { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => e.name).sort();
  } catch {
    return { from, adopted, rejected }; // nothing exported yet
  }

  for (const file of files) {
    const stem = file.replace(/\.md$/, "");
    const text = await readFile(join(from, file), "utf8").catch(() => null);
    if (text === null) {
      rejected.push({ name: stem, reasons: ["could not read the exported file"] });
      continue;
    }
    const { name, reasons } = await validateOrgSkill(text, stem);
    if (reasons.length) {
      rejected.push({ name: name ?? stem, reasons });
      continue;
    }
    const dest = orgSkillPath(name!);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, text, "utf8");
    adopted.push(name!);
  }
  return { from, adopted, rejected };
}
