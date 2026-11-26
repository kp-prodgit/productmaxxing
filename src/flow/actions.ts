import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chooseKind, DEFAULT_TEAM, PRODUCT_LEAD, savePersonalConfig, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { checkKindDraft, GENERIC_SIZES, renderKindFixture, renderKindSkill, upsertRubricRow, type KindDraft } from "../core/kinds.js";
import type { Ctx } from "../core/context.js";
import { cleanDomain, companyDomains, publicMail } from "../core/filter.js";
import { writeFileIn } from "../core/git.js";
import { outputHost } from "../core/host.js";
import { paths, TEAM_CONFIG_FILE } from "../core/paths.js";
import { bundledSkillsDir, loadSkill, orgSkillPath, teamSkillPath } from "../core/skills.js";
import { parseRubric } from "../core/skillcheck.js";
import { SIZES, type Size } from "../core/types.js";
import { addNeverIngest, checkNeverIngest, type NeverIngestKind } from "./edit.js";
import { channelInputs, checkConnector, checkLook, checkPlace, checkSeries, connectorId, MAX_SERIES, meetingSeries } from "../inputs/inputs.js";

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
  /** F5: an investor's or another confidential contact's email domain, held from team work. A team setting. */
  | { kind: "confidential-domain"; op: "add" | "remove"; value: string }
  | { kind: "size"; size: Size; minutes?: number; usd?: number }
  | { kind: "rubric"; category: string; size: Size; text: string }
  | { kind: "review-cap"; value: number }
  /** APPROVE-3: whether the PM's approval can make a task Ready at once (Start now). A team setting. */
  | { kind: "start-now"; value: boolean }
  | { kind: "digest-day"; value: number }
  | { kind: "digest-dm"; value: string | null }
  /** A recorder of the PM's own, like Momentum (INPUT-1). Applies on this Mac. */
  | { kind: "call-input"; op: "add" | "remove"; connector: string; look?: string | null }
  /** The places the team approves in one channel connector, as a whole list; empty stops reading it (INPUT-1). */
  | { kind: "team-input"; connector: string; places: string[]; look?: string | null }
  /**
   * F3 (INPUT-4): the recurring internal meetings the team approves for team work, by title pattern, as a whole list;
   * empty approves none. A team setting, like the channels.
   */
  | { kind: "meeting-series"; patterns: string[] }
  /** Whose Mac proposes team tasks and reads the team's channels (Q2), by PMX handle. */
  | { kind: "synthesizer"; value: string }
  /** INSTALL-4: who the team's product lead is, by PMX handle, or nobody (null). PMX offers PMX Engine only to them. */
  | { kind: "product-lead"; value: string | null }
  /** SIG-7 (0.25.0): the PM may send their own to-dos to Linear, one at a time. Off by default. */
  | { kind: "todos-linear"; value: boolean }
  /** A kind of work the team defines with the template (JOB-8): its skill, sample task, size row and config line. */
  | { kind: "new-kind"; slug: string; draft: KindDraft }
  /** Whether every PM's agent on the team must take a kind of work (JOB-9). */
  | { kind: "kind-required"; name: string; value: boolean }
  /** CAT-8: one of PMX's own kinds of work a team doesn't have yet (a newer one, like decision-brief): its config line and size row. */
  | { kind: "builtin-kind"; name: string }
  /**
   * CAT-8: the team's copy of one of PMX's own skills replaced by this pmx's (`pmx skills update`). A team keeps its copy
   * until it asks, so a newer built-in never overwrites a team's edits unseen; the pull request's diff shows them. The
   * size rubric keeps every row the team has and gains PMX's new ones.
   */
  | { kind: "skill-update"; name: string };

const RANK = { off: 0, mine: 1, linear: 2 } as const;
const own = (o: object, k: unknown) => typeof k === "string" && Object.prototype.hasOwnProperty.call(o, k);
const FIELD = { title: "meetingTitles", person: "people", channel: "channels" } as const;
export const isTeamChange = (c: Change) => c.kind === "team-domain" || c.kind === "confidential-domain" || c.kind === "size" || c.kind === "rubric" || c.kind === "review-cap" || c.kind === "start-now" || c.kind === "team-input" || c.kind === "meeting-series" || c.kind === "synthesizer" || c.kind === "product-lead" || c.kind === "new-kind" || c.kind === "kind-required" || c.kind === "builtin-kind" || c.kind === "skill-update";

/** A change that lets more through: the board asks once more before it, and only the local page may send it. */
export function loosens(c: Change, p: PersonalConfig, team?: TeamConfig): boolean {
  if (c.kind === "route") return RANK[c.value] > RANK[p.sources.routes?.[c.source] ?? "linear"];
  // A new recorder or a new place means PMX reads more.
  // A new recorder, a new place, or a changed "only read…" note means PMX may read more.
  if (c.kind === "call-input") {
    const cur = (p.sources.calls ?? []).find((x) => connectorId(x.connector) === connectorId(c.connector));
    return c.op === "add" && (!cur || (cur.look ?? null) !== (c.look ?? null));
  }
  if (c.kind === "team-input") {
    const cur = team ? channelInputs(team).find((x) => connectorId(x.connector) === connectorId(c.connector)) : undefined;
    return c.places.some((x) => !(cur?.places ?? []).some((y) => y.toLowerCase() === x.toLowerCase())) || (!!c.places.length && !!cur && (cur.look ?? null) !== (c.look ?? null));
  }
  // A new meeting series lets internal meetings through to team work.
  if (c.kind === "meeting-series") {
    const cur = team ? meetingSeries(team).map((x) => x.toLowerCase()) : [];
    return c.patterns.some((x) => !cur.includes(x.toLowerCase()));
  }
  // Turning on "send my to-dos to Linear" lets the PM's own commitments leave this Mac.
  if (c.kind === "todos-linear") return c.value && !p.todosToLinear;
  return (c.kind === "my-domain" || c.kind === "never" || c.kind === "team-domain" || c.kind === "confidential-domain") && c.op === "remove";
}

/** Checks one change's shape and values, from the page or a script. Throws a message a PM can act on. */
export function checkChange(c: any, team: TeamConfig): Change {
  const fail = (m: string): never => { throw new Error(m); };
  switch (c?.kind) {
    case "route":
      if (typeof c.source !== "string" || !/^[a-z][a-z-]{1,30}$/.test(c.source)) fail("Unknown source.");
      if (!(c.value in RANK)) fail("A source can be off, mine or linear.");
      return { kind: "route", source: c.source, value: c.value };
    case "my-domain": case "team-domain": case "confidential-domain": {
      const d = cleanDomain(String(c.value ?? ""));
      if (!d) fail(`"${c.value}" isn't an email domain like acme.com.`);
      if (c.op !== "add" && c.op !== "remove") fail("Add or remove a domain.");
      // F5: a confidential contact is someone outside the company, on a domain that names one company.
      if (c.kind === "confidential-domain" && c.op === "add") {
        if (publicMail(d!)) fail(`${d} is a mail provider anyone can sign up with, so it can't stand for an investor or other confidential contact.`);
        if (companyDomains(team.internalDomains).includes(d!)) fail(`${d} is one of your company's own domains, so it can't be a confidential contact's too.`);
      }
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
      if (!own(team.categories, c.name)) fail(`Unknown category ${c.name}.`);
      return { kind: "category", name: c.name, accepted: !!c.accepted };
    case "size":
      if (!SIZES.includes(c.size)) fail("Unknown size.");
      if (c.minutes !== undefined && !(Number.isInteger(c.minutes) && c.minutes >= 5 && c.minutes <= 480)) fail("Run time is 5 to 480 minutes.");
      if (c.usd !== undefined && !(Number.isFinite(c.usd) && c.usd >= 0 && c.usd <= 50)) fail("A size's estimate is 0 to 50 dollars.");
      return { kind: "size", size: c.size, ...(c.minutes !== undefined ? { minutes: c.minutes } : {}), ...(c.usd !== undefined ? { usd: c.usd } : {}) };
    case "rubric": {
      const text = String(c.text ?? "").replace(/[|\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      if (!own(team.categories, c.category) || !SIZES.includes(c.size)) fail("Unknown category or size.");
      if (text.length < 3 || text.length > 120) fail("A rubric cell is 3 to 120 characters.");
      return { kind: "rubric", category: c.category, size: c.size, text };
    }
    case "review-cap":
      if (!(Number.isInteger(c.value) && c.value >= 1 && c.value <= 10)) fail("The review cap is 1 to 10.");
      return { kind: "review-cap", value: c.value };
    case "start-now":
      if (typeof c.value !== "boolean") fail("Turn Start now on or off.");
      return { kind: "start-now", value: c.value };
    case "digest-day":
      if (!(Number.isInteger(c.value) && c.value >= 0 && c.value <= 6)) fail("The digest day is a day of the week.");
      return { kind: "digest-day", value: c.value };
    case "digest-dm": {
      const v = c.value === null || c.value === "" ? null : String(c.value).trim().toUpperCase();
      if (v !== null && !/^[UW][A-Z0-9]{6,14}$/.test(v)) fail("A Slack member ID looks like U0123ABCD. In Slack, open your profile, click ⋮ and copy member ID.");
      return { kind: "digest-dm", value: v };
    }
    case "call-input": {
      if (c.op !== "add" && c.op !== "remove") fail("Add or remove a recorder.");
      const connector = checkConnector(c.connector);
      return { kind: "call-input", op: c.op, connector, ...(c.op === "add" ? { look: checkLook(c.look) } : {}) };
    }
    case "todos-linear":
      if (typeof c.value !== "boolean") fail("Turn sending your to-dos to Linear on or off.");
      if (c.value && team.tracker.kind === "none") fail("Your team has no task tracker, so there's nowhere to send to-dos.");
      return { kind: "todos-linear", value: c.value };
    case "synthesizer":
      if (typeof c.value !== "string" || !/^[\w.@-]{1,64}$/.test(c.value)) fail("Name the teammate by their PMX handle.");
      return { kind: "synthesizer", value: c.value };
    case "product-lead": {
      const v = c.value === null || c.value === "" ? null : typeof c.value === "string" ? c.value.trim() : c.value;
      if (v !== null && (typeof v !== "string" || !PRODUCT_LEAD.test(v))) fail("Name your product lead by their PMX handle, like ana.");
      return { kind: "product-lead", value: v };
    }
    case "new-kind": {
      const { slug, draft } = checkKindDraft(c.draft, team);
      return { kind: "new-kind", slug, draft };
    }
    case "skill-update":
      if (typeof c.name !== "string" || !/^pmx-[a-z][a-z0-9-]{1,40}$/.test(c.name)) fail(`Name one of PMX's own skills, like pmx-synthesize, not ${JSON.stringify(c.name)}.`);
      return { kind: "skill-update", name: c.name };
    case "builtin-kind":
      if (!own(DEFAULT_TEAM.categories, c.name)) fail(`PMX has no kind of work called ${String(c.name)}. Its own are: ${Object.keys(DEFAULT_TEAM.categories).join(", ")}.`);
      if (own(team.categories, c.name)) fail(`Your team already has ${c.name}.`);
      return { kind: "builtin-kind", name: c.name };
    case "kind-required":
      if (!own(team.categories, c.name)) fail(`Unknown kind of work ${c.name}.`);
      if (typeof c.value !== "boolean") fail("Require a kind of work for everyone, or stop requiring it.");
      return { kind: "kind-required", name: c.name, value: c.value };
    case "meeting-series": {
      if (!Array.isArray(c.patterns)) fail("Give the team's meeting series as a list.");
      const seen = new Set<string>();
      const patterns = (c.patterns as unknown[]).map(checkSeries).filter((p) => !seen.has(p.toLowerCase()) && !!seen.add(p.toLowerCase()));
      if (patterns.length > MAX_SERIES) fail(`Up to ${MAX_SERIES} meeting series.`);
      return { kind: "meeting-series", patterns };
    }
    case "team-input": {
      const connector = checkConnector(c.connector);
      const places: string[] = [...new Set((Array.isArray(c.places) ? (c.places as unknown[]) : []).map(checkPlace))];
      if (places.length > 20) fail("Up to 20 places per connector.");
      return { kind: "team-input", connector, places, look: checkLook(c.look) };
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
    // JOB-11: an off is recorded too, so PMX never asks about that kind again.
    else if (c.kind === "category") chooseKind(personal, c.name, c.accepted);
    else if (c.kind === "digest-day") personal.digest = { ...personal.digest, weekday: c.value };
    else if (c.kind === "digest-dm") personal.digest = { ...personal.digest, slackDmUserId: c.value };
    else if (c.kind === "todos-linear") personal.todosToLinear = c.value;
    else if (c.kind === "call-input") {
      const rest = (personal.sources.calls ?? []).filter((x) => connectorId(x.connector) !== connectorId(c.connector));
      if (c.op === "add" && rest.length >= 8) throw new Error("Up to 8 recorders of your own.");
      personal.sources = { ...personal.sources, calls: c.op === "add" ? [...rest, { connector: c.connector, ...(c.look ? { look: c.look } : {}) }] : rest };
    }
    else continue;
    out.push(describe(c));
  }
  await savePersonalConfig(personal);
  return out;
}

/** Switches kinds of work on for this PM (the author of a new one), ahead of the merge that adds them for the team. */
export async function saveTakes(personal: PersonalConfig, categories: string[]): Promise<void> {
  for (const c of categories) chooseKind(personal, c, true);
  await savePersonalConfig(personal);
}

export function describe(c: Change): string {
  switch (c.kind) {
    case "route": return `${c.source}: ${{ off: "off", mine: "my to-dos only", linear: "my to-dos and Linear tasks" }[c.value]}`;
    case "my-domain": return `${c.op === "add" ? "Add" : "Remove"} your company domain ${c.value}`;
    case "team-domain": return `${c.op === "add" ? "Add" : "Remove"} the team's company domain ${c.value}`;
    case "confidential-domain": return c.op === "add" ? `Hold meetings with ${c.value} from team work: an investor or other confidential contact` : `Stop holding meetings with ${c.value} from team work`;
    case "never": return `${c.op === "add" ? "Never read" : "Read again"} ${c.list} "${c.value}"`;
    case "budget": return c.value === null ? "No daily cap of your own" : c.value === 0 ? "Pause PMX" : `Daily cap $${c.value}`;
    case "category": return `${c.accepted ? "Take on" : "Stop taking"} ${c.name}`;
    case "size": return `Size ${c.size}: ${[c.minutes !== undefined ? `${c.minutes} min` : "", c.usd !== undefined ? `~$${c.usd}` : ""].filter(Boolean).join(", ")}`;
    case "rubric": return `${c.category} ${c.size}: "${c.text}"`;
    case "review-cap": return `Stop pulling at ${c.value} drafts waiting for review`;
    case "start-now": return c.value ? "Offer Start now: a PM's approval can make a task Ready for agents at once" : "No Start now: approved tasks wait in the backlog until a teammate moves them to Todo in Linear";
    case "digest-day": return `Build the digest on ${["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][c.value]}s`;
    case "digest-dm": return c.value ? `Send the approved digest to Slack member ${c.value}` : "Don't send the digest to Slack";
    case "call-input": return c.op === "add" ? `Collect calls from ${c.connector}${c.look ? ` (only ${c.look})` : ""}` : `Stop collecting calls from ${c.connector}`;
    case "todos-linear": return c.value ? "Let me send my own to-dos to Linear, one at a time" : "Keep all my to-dos on this Mac";
    case "synthesizer": return `${c.value}'s Mac suggests team tasks and reads the team's channels`;
    case "product-lead": return c.value ? `${c.value} is your team's product lead, so PMX offers them PMX Engine` : "Your team names no product lead";
    case "new-kind": return `Add the kind of work "${c.draft.name}" (${c.slug})${c.draft.required ? ", required for everyone on the team" : ""}`;
    case "kind-required": return `${c.value ? "Require" : "Stop requiring"} ${c.name} for everyone on the team`;
    case "builtin-kind": return `Add PMX's kind of work ${c.name}; each PM chooses whether their agent takes it`;
    case "skill-update": return `Use this PMX's ${c.name} instead of your team's copy${c.name === "pmx-size" ? ", keeping your team's rows" : ""}`;
    case "meeting-series": return c.patterns.length ? `Read the team's internal meeting series for team work: ${c.patterns.join(", ")}` : "Read no internal meeting series for team work";
    case "team-input": return c.places.length ? `Read ${c.connector}: ${c.places.join(", ")}${c.look ? ` (only ${c.look})` : ""}` : `Stop reading ${c.connector}`;
  }
}

/** One of PMX's own skill folders (its SKILL.md and fixtures) written into a worktree at `rel`, as `pmx init` copies it. */
async function copySkill(from: string, cwd: string, rel: string): Promise<void> {
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (e.isDirectory()) await copySkill(join(from, e.name), cwd, join(rel, e.name));
    else if (e.isFile()) await writeFileIn(cwd, join(rel, e.name), await readFile(join(from, e.name), "utf8"));
  }
}

/** One cell of the per-category table in the pmx-size skill, replaced. A missing row is added with general wording. */
export function setRubricCell(skill: string, category: string, size: Size, text: string): string {
  const lines = skill.split("\n");
  const head = lines.findIndex((l) => /^\|\s*Category\s*\|/i.test(l));
  const cols = head >= 0 ? lines[head]!.split("|").slice(1, -1).map((c) => c.trim()) : [];
  const col = cols.indexOf(size);
  const row = lines.findIndex((l, i) => i > head && l.split("|")[1]?.trim() === category);
  if (head < 0 || col < 0) throw new Error(`The size rubric has no per-category table with a ${size} column.`);
  // A kind of work made before it had a row (by hand, or before JOB-8) gets one, so its sizes can be worded.
  if (row < 0) return setRubricCell(upsertRubricRow(skill, category, GENERIC_SIZES), category, size, text);
  const cells = lines[row]!.split("|");
  cells[col + 1] = ` ${text} `;
  lines[row] = cells.join("|");
  return lines.join("\n");
}

/** A team settings branch PMX made: the time it was sent, to the second, and `-2`, `-3`… for a later one that second. */
export const SETTINGS_BRANCH = /^pmx\/settings-\d{14}(?:-\d+)?$/;

/**
 * A settings branch no send has used yet (R9): named for the time to the second, with `-2`, `-3`… when that name is
 * taken on this Mac, in the team repo or by a worktree. So a second send in the same second (`pmx skills update`, then
 * `pmx jobs add`) never commits or pushes onto the first one's branch, and each gets a pull request of its own.
 */
async function freshSettingsBranch(git: Ctx["repo"], now: Date, remote: boolean): Promise<string> {
  const stem = `pmx/settings-${now.toISOString().replace(/\D/g, "").slice(0, 14)}`;
  const names = (s: string) => s.split("\n").map((l) => l.trim().replace(/^\S+\trefs\/heads\//, "")).filter(Boolean);
  const taken = new Set([
    ...names(await git.ok(["for-each-ref", "--format=%(refname:lstrip=2)", `refs/heads/${stem}*`])),
    ...names(await git.ok(["for-each-ref", "--format=%(refname:lstrip=3)", `refs/remotes/origin/${stem}*`])),
    ...(remote ? names((await git.raw(["ls-remote", "--heads", "origin", `refs/heads/${stem}*`])).stdout) : []),
  ]);
  for (let n = 1; ; n++) {
    const branch = n === 1 ? stem : `${stem}-${n}`;
    if (!taken.has(branch) && !(await stat(join(paths.worktrees(), branch.replace("/", "-"))).then(() => true, () => false))) return branch;
  }
}

/**
 * Team settings as one pull request to the PMX repo (BOARD-3): a branch off the default branch in a worktree, so the
 * PM's own checkout is never touched. Nothing changes for anyone until a code owner merges it. `from`: where the PM
 * sent it, for the pull request's title when it holds more than kinds of work or skills.
 */
export async function proposeTeamChanges(ctx: Ctx, changes: Change[], o: { from?: "board" | "terminal" } = {}): Promise<{ id: string; url: string; branch: string }> {
  const team = changes.filter(isTeamChange);
  if (!team.length) throw new Error("No team changes to send.");
  const base = await ctx.repo.defaultBranch();
  const remote = await ctx.repo.hasRemote();
  if (remote) await ctx.repo.ok(["fetch", "--quiet", "origin", base]);
  const branch = await freshSettingsBranch(ctx.repo, ctx.now(), remote);
  const dir = join(paths.worktrees(), branch.replace("/", "-"));
  const wt = await ctx.repo.worktree(dir, branch, remote ? `origin/${base}` : base);
  try {
    const cfgPath = join(wt.cwd, TEAM_CONFIG_FILE);
    const cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    let rubric: string | null = null;
    const kinds: Extract<Change, { kind: "new-kind" }>[] = [];
    for (const c of team) {
      if (c.kind === "team-domain") cfg.internalDomains = c.op === "add" ? [...new Set([...(cfg.internalDomains ?? []), c.value])] : (cfg.internalDomains ?? []).filter((d: string) => d !== c.value);
      else if (c.kind === "confidential-domain") cfg.confidentialDomains = c.op === "add" ? [...new Set([...(cfg.confidentialDomains ?? []), c.value])] : (cfg.confidentialDomains ?? []).filter((d: string) => d !== c.value);
      else if (c.kind === "size") {
        cfg.sizes = { ...ctx.team.sizes, ...(cfg.sizes ?? {}) };
        cfg.sizes[c.size] = { ...cfg.sizes[c.size], ...(c.minutes !== undefined ? { minutes: c.minutes } : {}), ...(c.usd !== undefined ? { costUsd: c.usd } : {}) };
      } else if (c.kind === "review-cap") cfg.reviewQueueCap = c.value;
      else if (c.kind === "start-now") cfg.approve = { ...(cfg.approve ?? {}), startNow: c.value };
      else if (c.kind === "rubric") rubric = setRubricCell(rubric ?? (await loadSkill(wt.cwd, "pmx-size")).text, c.category, c.size, c.text);
      else if (c.kind === "synthesizer") cfg.synthesizer = c.value;
      else if (c.kind === "product-lead") cfg.productLead = c.value;
      else if (c.kind === "new-kind") {
        // Checked again against the team's config as it is on the default branch now, not as this Mac last pulled it.
        cfg.categories = { ...(cfg.categories ?? DEFAULT_TEAM.categories) };
        if (own(cfg.categories, c.slug)) throw new Error(`Your team already has a kind of work called ${c.slug}.`);
        if (Object.values(cfg.categories as Record<string, { skill?: string }>).some((x) => x?.skill === c.slug) || (await readFile(orgSkillPath(c.slug), "utf8").then(() => true, () => false)))
          throw new Error(`Your team already has a skill called ${c.slug}. Pick another name.`);
        const dir = teamSkillPath("", c.slug).replace(/^\//, "").replace(/\/SKILL\.md$/, "");
        if (await readFile(join(wt.cwd, dir, "SKILL.md"), "utf8").then(() => true, () => false)) throw new Error(`Your team's repo already has a skill called ${c.slug}.`);
        cfg.categories[c.slug] = { skill: c.slug, ...(c.draft.externalFacing ? { externalFacing: true } : {}), ...(c.draft.required ? { required: true } : {}) };
        await writeFileIn(wt.cwd, join(dir, "SKILL.md"), renderKindSkill(c.slug, c.draft));
        await writeFileIn(wt.cwd, join(dir, "fixtures", "sample-task.md"), renderKindFixture(c.slug, c.draft));
        rubric = upsertRubricRow(rubric ?? (await loadSkill(wt.cwd, "pmx-size")).text, c.slug, c.draft.sizes);
        kinds.push(c);
      } else if (c.kind === "skill-update") {
        const fresh = await readFile(join(bundledSkillsDir(), c.name, "SKILL.md"), "utf8").catch(() => null);
        if (!fresh) throw new Error(`PMX has no skill called ${c.name}.`);
        const rel = teamSkillPath("", c.name).replace(/^\//, "");
        if (c.name === "pmx-size") {
          // The team's own rows (its kinds of work, its wording) stay; PMX's new rows come in.
          const before: string = rubric ?? (await readFile(join(wt.cwd, rel), "utf8").catch(() => fresh));
          const ours: Record<string, Record<Size, string>> = parseRubric(before).cells;
          rubric = Object.entries(ours).reduce((t: string, [cat, cells]) => upsertRubricRow(t, cat, cells), fresh);
        } else await writeFileIn(wt.cwd, rel, fresh);
      } else if (c.kind === "builtin-kind") {
        // A kind of work PMX added after this team's repo was set up (CAT-8): the team adds its line, its size row where
        // the team keeps its own copy of the rubric, and PMX's skill for it (R8, NEUT-2). A new team's repo starts with a
        // copy of every one of PMX's skills, so every Mac drafts from the same reviewed text whichever PMX version it runs; a kind
        // added later arrives the same way. A copy the team already has stays: `pmx skills update` replaces it.
        cfg.categories = { ...(cfg.categories ?? DEFAULT_TEAM.categories) };
        if (own(cfg.categories, c.name)) throw new Error(`Your team already has ${c.name}.`);
        cfg.categories[c.name] = { ...DEFAULT_TEAM.categories[c.name]! };
        const skill = DEFAULT_TEAM.categories[c.name]!.skill;
        const dir = dirname(teamSkillPath("", skill).replace(/^\//, ""));
        if (!(await readFile(join(wt.cwd, dir, "SKILL.md"), "utf8").then(() => true, () => false))) await copySkill(join(bundledSkillsDir(), skill), wt.cwd, dir);
        const current = rubric ?? (await loadSkill(wt.cwd, "pmx-size")).text;
        const row = parseRubric(await readFile(join(bundledSkillsDir(), "pmx-size", "SKILL.md"), "utf8")).cells[c.name];
        if (row && !parseRubric(current).cells[c.name]) rubric = upsertRubricRow(current, c.name, row);
      } else if (c.kind === "kind-required") {
        cfg.categories = { ...(cfg.categories ?? DEFAULT_TEAM.categories) };
        const cur = own(cfg.categories, c.name) ? cfg.categories[c.name] : null;
        if (!cur) throw new Error(`Your team no longer has a kind of work called ${c.name}.`);
        const { required: _, ...rest } = cur;
        cfg.categories[c.name] = c.value ? { ...rest, required: true } : rest;
      }
      else if (c.kind === "team-input") {
        // Slack channels approved the old way move into `inputs`, so there's one list to read and change.
        const list = channelInputs({ inputs: cfg.inputs, slackChannels: cfg.slackChannels ?? [], allowedSources: cfg.allowedSources ?? [] })
          .filter((x) => connectorId(x.connector) !== connectorId(c.connector));
        if (c.places.length) list.push({ connector: c.connector, places: c.places, ...(c.look ? { look: c.look } : {}) });
        cfg.inputs = list;
        // The old Slack list now lives in `inputs`; leaving it would make Slack impossible to turn off the old way.
        cfg.slackChannels = [];
      }
      else if (c.kind === "meeting-series") {
        if (c.patterns.length) cfg.meetingSeries = c.patterns;
        else delete cfg.meetingSeries;
      }
    }
    await writeFileIn(wt.cwd, TEAM_CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`);
    if (rubric !== null) await writeFileIn(wt.cwd, teamSkillPath("", "pmx-size").replace(/^\//, ""), rubric);
    const lines = team.map((c) => `- ${describe(c)}`);
    const updates = team.filter((c): c is Extract<Change, { kind: "skill-update" }> => c.kind === "skill-update");
    // R9: titled by what it does; "from the PMX board" only when it came from the board.
    const named = team.flatMap((c) => (c.kind === "new-kind" ? [c.draft.name] : c.kind === "builtin-kind" ? [c.name] : []));
    const confidential = team.filter((c): c is Extract<Change, { kind: "confidential-domain" }> => c.kind === "confidential-domain");
    const title = named.length && named.length === team.length ? (named.length === 1 ? `New kind of work: ${named[0]}` : `New kinds of work: ${named.join(", ")}`)
      : named.length ? "New kinds of work and team settings from PMX"
      : updates.length === team.length ? `PMX's newer skills: ${updates.map((u) => u.name).join(", ")}`
      // F5: a confidential domain is titled by what it does, as R9 titles the rest.
      : confidential.length === team.length ? confidential.map((c) => `${c.op === "add" ? "Confidential domain" : "Remove confidential domain"}: ${c.value}`).join("; ")
      : o.from === "board" ? "Team settings from the PMX board" : "Team settings from PMX";
    const sha = await wt.commitAll(`${title}\n\n${lines.join("\n")}`);
    if (!sha) throw new Error("Those team settings are already in place.");
    const host = await outputHost(ctx.repo, ctx.keychain, ctx.exec, ctx.fetch);
    // A reviewer sees what each new kind of work is for and when PMX will propose it, not only a file list.
    const about = kinds.map(({ slug, draft: d }) => [
      `### ${d.name} (\`${slug}\`, ${d.stage})`, "", `- **Produces:** ${d.produces}`, `- **Suggest it when:** ${d.when}`, d.not ? `- **Don't suggest it when:** ${d.not}` : null,
      `- **Sections:** ${d.sections.join(", ")} · cites at least ${d.minCitations}`, d.externalFacing ? "- **Goes outside the team:** a person always sends it." : null,
      d.required ? "- **Required:** every PM's agent on the team takes it." : "- Each PM chooses whether their agent takes it.",
      "", `Files: \`.claude/skills/${slug}/SKILL.md\` (edit the steps there if they need work), its sample task, the size rubric row and \`pmx.config.json\`.`,
    ].filter((x) => x !== null).join("\n"));
    // Typed text never @-mentions anyone on GitHub.
    const body = [`Sent from PMX on ${ctx.agent}.`, "", lines.join("\n"), ...(about.length ? ["", ...about] : []), "", "Nothing changes for anyone until this merges."].join("\n").replace(/@(?=\w)/g, "@\u200b");
    const pr = await host.openPr({ branch, base, title, body });
    return { id: pr.id, url: pr.url, branch };
  } finally {
    await ctx.repo.removeWorktree(dir).catch(() => {});
  }
}
