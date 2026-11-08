import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { cleanDomain } from "../core/filter.js";
import { writeFileIn } from "../core/git.js";
import { outputHost } from "../core/host.js";
import { paths, TEAM_CONFIG_FILE } from "../core/paths.js";
import { loadSkill, teamSkillPath } from "../core/skills.js";
import { SIZES, type Size } from "../core/types.js";
import { addNeverIngest, checkNeverIngest, type NeverIngestKind } from "./edit.js";

/**
 * What the pipeline board's Rules tab can change (BOARD-3). Personal settings apply on this Mac at once; team settings
 * (pmx.config.json and the team's size rubric) go into one pull request a code owner reviews. Only this Mac's local page
 * may send them; the Claude artifact can only add to the do-not-read list (FLOW-6).
 */
export type Change =
  | { kind: "route"; source: string; value: "off" | "mine" | "linear" }
  | { kind: "my-domain"; op: "add" | "remove"; value: string }
  | { kind: "never"; list: NeverIngestKind; op: "add" | "remove"; value: string }
  | { kind: "budget"; value: number | null }
  | { kind: "category"; name: string; accepted: boolean }
  | { kind: "team-domain"; op: "add" | "remove"; value: string }
  | { kind: "size"; size: Size; minutes?: number; usd?: number }
  | { kind: "rubric"; category: string; size: Size; text: string }
  | { kind: "review-cap"; value: number }
  | { kind: "digest-day"; value: number }
  | { kind: "digest-dm"; value: string | null };

const RANK = { off: 0, mine: 1, linear: 2 } as const;
const FIELD = { title: "meetingTitles", person: "people", channel: "channels" } as const;
export const isTeamChange = (c: Change) => c.kind === "team-domain" || c.kind === "size" || c.kind === "rubric" || c.kind === "review-cap";

/** A change that lets more through: the board asks once more before it, and only the local page may send it. */
export function loosens(c: Change, p: PersonalConfig): boolean {
  if (c.kind === "route") return RANK[c.value] > RANK[p.sources.routes?.[c.source] ?? "linear"];
  return (c.kind === "my-domain" || c.kind === "never" || c.kind === "team-domain") && c.op === "remove";
}

/** Checks one change's shape and values, from the page or a script. Throws a message a PM can act on. */
export function checkChange(c: any, team: TeamConfig): Change {
  const fail = (m: string): never => { throw new Error(m); };
  switch (c?.kind) {
    case "route":
      if (typeof c.source !== "string" || !/^[a-z][a-z-]{1,30}$/.test(c.source)) fail("Unknown source.");
      if (!(c.value in RANK)) fail("A source can be off, mine or linear.");
      return { kind: "route", source: c.source, value: c.value };
    case "my-domain": case "team-domain": {
      const d = cleanDomain(String(c.value ?? ""));
      if (!d) fail(`"${c.value}" isn't an email domain like acme.com.`);
      if (c.op !== "add" && c.op !== "remove") fail("Add or remove a domain.");
      return { kind: c.kind, op: c.op, value: d! };
    }
    case "never": {
      const { kind, value } = checkNeverIngest(String(c.list), c.value);
      if (c.op !== "add" && c.op !== "remove") fail("Add or remove an entry.");
      return { kind: "never", list: kind, op: c.op, value };
    }
    case "budget":
      if (c.value !== null && (!Number.isFinite(c.value) || c.value < 0 || c.value > team.caps.perDayUsd)) fail(`A cap is 0 to ${team.caps.perDayUsd} dollars, or none.`);
      return { kind: "budget", value: c.value === null ? null : Number(c.value) };
    case "category":
      if (!(c.name in team.categories)) fail(`Unknown category ${c.name}.`);
      return { kind: "category", name: c.name, accepted: !!c.accepted };
    case "size":
      if (!SIZES.includes(c.size)) fail("Unknown size.");
      if (c.minutes !== undefined && !(Number.isInteger(c.minutes) && c.minutes >= 5 && c.minutes <= 480)) fail("Run time is 5 to 480 minutes.");
      if (c.usd !== undefined && !(Number.isFinite(c.usd) && c.usd >= 0 && c.usd <= 50)) fail("A size's estimate is 0 to 50 dollars.");
      return { kind: "size", size: c.size, ...(c.minutes !== undefined ? { minutes: c.minutes } : {}), ...(c.usd !== undefined ? { usd: c.usd } : {}) };
    case "rubric": {
      const text = String(c.text ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      if (!(c.category in team.categories) || !SIZES.includes(c.size)) fail("Unknown category or size.");
      if (text.length < 3 || text.length > 120) fail("A rubric cell is 3 to 120 characters.");
      return { kind: "rubric", category: c.category, size: c.size, text };
    }
    case "review-cap":
      if (!(Number.isInteger(c.value) && c.value >= 1 && c.value <= 10)) fail("The review cap is 1 to 10.");
      return { kind: "review-cap", value: c.value };
    case "digest-day":
      if (!(Number.isInteger(c.value) && c.value >= 0 && c.value <= 6)) fail("The digest day is a day of the week.");
      return { kind: "digest-day", value: c.value };
    case "digest-dm": {
      const v = c.value === null || c.value === "" ? null : String(c.value).trim().toUpperCase();
      if (v !== null && !/^[UW][A-Z0-9]{6,14}$/.test(v)) fail("A Slack member ID looks like U0123ABCD. In Slack, open your profile, click ⋮ and copy member ID.");
      return { kind: "digest-dm", value: v };
    }
  }
  return fail(`Unknown change "${c?.kind}".`);
}

/** Applies personal changes on this Mac. Returns one line per change. */
export async function applyPersonal(personal: PersonalConfig, changes: Change[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of changes) {
    if (c.kind === "never" && c.op === "add") {
      const r = await addNeverIngest(personal, c.list, c.value, "flow");
      out.push(r.added ? `Never read ${c.list} "${c.value}"` : `"${c.value}" was already on the list`);
      continue;
    }
    if (c.kind === "never") personal.neverIngest[FIELD[c.list]] = personal.neverIngest[FIELD[c.list]].filter((x) => x.toLowerCase() !== c.value.toLowerCase());
    else if (c.kind === "route") personal.sources = { ...personal.sources, routes: { ...(personal.sources.routes ?? {}), [c.source]: c.value } };
    else if (c.kind === "my-domain") {
      const cur = personal.companyDomains ?? [];
      personal.companyDomains = c.op === "add" ? [...new Set([...cur, c.value])] : cur.filter((d) => d !== c.value);
    } else if (c.kind === "budget") personal.budget = { ...personal.budget, dailyUsd: c.value };
    else if (c.kind === "category") personal.categories = c.accepted ? [...new Set([...personal.categories, c.name])] : personal.categories.filter((x) => x !== c.name);
    else if (c.kind === "digest-day") personal.digest = { ...personal.digest, weekday: c.value };
    else if (c.kind === "digest-dm") personal.digest = { ...personal.digest, slackDmUserId: c.value };
    else continue;
    out.push(describe(c));
  }
  await savePersonalConfig(personal);
  return out;
}

export function describe(c: Change): string {
  switch (c.kind) {
    case "route": return `${c.source}: ${{ off: "off", mine: "my to-dos only", linear: "my to-dos and Linear tasks" }[c.value]}`;
    case "my-domain": return `${c.op === "add" ? "Add" : "Remove"} your company domain ${c.value}`;
    case "team-domain": return `${c.op === "add" ? "Add" : "Remove"} the team's company domain ${c.value}`;
    case "never": return `${c.op === "add" ? "Never read" : "Read again"} ${c.list} "${c.value}"`;
    case "budget": return c.value === null ? "No daily cap of your own" : c.value === 0 ? "Pause PMX" : `Daily cap $${c.value}`;
    case "category": return `${c.accepted ? "Take on" : "Stop taking"} ${c.name}`;
    case "size": return `Size ${c.size}: ${[c.minutes !== undefined ? `${c.minutes} min` : "", c.usd !== undefined ? `~$${c.usd}` : ""].filter(Boolean).join(", ")}`;
    case "rubric": return `${c.category} ${c.size}: "${c.text}"`;
    case "review-cap": return `Stop pulling at ${c.value} drafts waiting for review`;
    case "digest-day": return `Build the digest on ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][c.value]}s`;
    case "digest-dm": return c.value ? `Send the approved digest to Slack member ${c.value}` : "Don't send the digest to Slack";
  }
}

/** One cell of the per-category table in the pmx-size skill, replaced. Throws if the row isn't there. */
export function setRubricCell(skill: string, category: string, size: Size, text: string): string {
  const lines = skill.split("\n");
  const head = lines.findIndex((l) => /^\|\s*Category\s*\|/i.test(l));
  const cols = head >= 0 ? lines[head]!.split("|").slice(1, -1).map((c) => c.trim()) : [];
  const col = cols.indexOf(size);
  const row = lines.findIndex((l, i) => i > head && l.split("|")[1]?.trim() === category);
  if (head < 0 || col < 0 || row < 0) throw new Error(`The size rubric has no ${category} row with a ${size} column.`);
  const cells = lines[row]!.split("|");
  cells[col + 1] = ` ${text} `;
  lines[row] = cells.join("|");
  return lines.join("\n");
}

/**
 * Team settings as one pull request to the PMX repo (BOARD-3): a branch off the default branch in a worktree, so the
 * PM's own checkout is never touched. Nothing changes for anyone until a code owner merges it.
 */
export async function proposeTeamChanges(ctx: Ctx, changes: Change[]): Promise<{ id: string; url: string; branch: string }> {
  const team = changes.filter(isTeamChange);
  if (!team.length) throw new Error("No team changes to propose.");
  const base = await ctx.repo.defaultBranch();
  const remote = await ctx.repo.hasRemote();
  if (remote) await ctx.repo.ok(["fetch", "--quiet", "origin", base]);
  const branch = `pmx/settings-${ctx.now().toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const dir = join(paths.worktrees(), branch.replace("/", "-"));
  const wt = await ctx.repo.worktree(dir, branch, remote ? `origin/${base}` : base);
  try {
    const cfgPath = join(wt.cwd, TEAM_CONFIG_FILE);
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    let rubric: string | null = null;
    for (const c of team) {
      if (c.kind === "team-domain") cfg.internalDomains = c.op === "add" ? [...new Set([...(cfg.internalDomains ?? []), c.value])] : (cfg.internalDomains ?? []).filter((d: string) => d !== c.value);
      else if (c.kind === "size") {
        cfg.sizes = { ...ctx.team.sizes, ...(cfg.sizes ?? {}) };
        cfg.sizes[c.size] = { ...cfg.sizes[c.size], ...(c.minutes !== undefined ? { minutes: c.minutes } : {}), ...(c.usd !== undefined ? { costUsd: c.usd } : {}) };
      } else if (c.kind === "review-cap") cfg.reviewQueueCap = c.value;
      else if (c.kind === "rubric") rubric = setRubricCell(rubric ?? (await loadSkill(wt.cwd, "pmx-size")).text, c.category, c.size, c.text);
    }
    await writeFileIn(wt.cwd, TEAM_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
    if (rubric !== null) await writeFileIn(wt.cwd, teamSkillPath("", "pmx-size").replace(/^\//, ""), rubric);
    const lines = team.map((c) => `- ${describe(c)}`);
    const sha = await wt.commitAll(`Team settings from the PMX board\n\n${lines.join("\n")}`);
    if (!sha) throw new Error("Those team settings are already in place.");
    const host = await outputHost(ctx.repo, ctx.keychain, ctx.exec, ctx.fetch);
    const pr = await host.openPr({ branch, base, title: "Team settings from the PMX board", body: `Proposed from the PMX pipeline board on ${ctx.agent}.\n\n${lines.join("\n")}\n\nNothing changes for anyone until this merges.` });
    return { id: pr.id, url: pr.url, branch };
  } finally {
    await ctx.repo.removeWorktree(dir).catch(() => {});
  }
}
