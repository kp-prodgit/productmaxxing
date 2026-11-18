import { assertSchema, isVersion } from "./version.js";
import { join } from "node:path";
import { readJson, writeJson } from "./fsutil.js";
import { paths, TEAM_CONFIG_FILE } from "./paths.js";
import { SIZES, type Size } from "./types.js";

/** Team config, committed to the PMX repo as `pmx.config.json`. Changed only by reviewed PR (NEUT-2). */
export interface TeamConfig {
  version: 1;
  team: string;
  /** Fixed model for every run, so results don't depend on the runner (NEUT-1). */
  model: string;
  /**
   * Category → skill. Adding a category is one line here plus a skill folder (SKILL-2). `required` (JOB-9): every PM's
   * agent on the team takes it, and nobody can switch it off on their own, so the team's kinds of work are the same
   * everywhere. Otherwise each PM chooses in Settings.
   */
  categories: Record<string, TeamCategory>;
  sizes: Record<Size, { minutes: number; costUsd: number }>;
  tracker: { kind: "linear"; teamKey: string; projectId: string } | { kind: "none" };
  lease: "git" | "cloud";
  reviewQueueCap: number;
  /** Domains a run may reach (SEC-3). */
  egress: string[];
  /** Source kinds the team allows at all (B2, default-deny). */
  allowedSources: ("transcripts" | "slack")[];
  /** Slack channels the team approved before connector inputs (0.21.0). They now read as the Slack input's places. */
  slackChannels: string[];
  /**
   * Channel-like connectors and the places in each the team approved (INPUT-1): read by the synthesis Mac's Claude
   * collection task through the PM's own connector, never by PMX directly. Changed only by reviewed PR (NEUT-2).
   */
  inputs?: { connector: string; places: string[]; look?: string | null }[] | null;
  allowPrivateChannels: boolean;
  /** Calls are ingested only when someone outside these domains took part (B2). */
  internalDomains: string[];
  /** Q2: the agent handle that runs team synthesis on a timer. */
  synthesizer: string | null;
  caps: { perRunUsd: number; perDayUsd: number };
  autoPause: { minVerdicts: number; threshold: number; windowDays: number };
  controlPlane?: { url: string; orgId: string };
  /** Company roll-up (COMPANY-1): this repo's tracker is the company project; these are the teams it merges. */
  /**
   * The oldest pmx allowed to do shared team work (COMPAT-2), set with `pmx vendor --require`, and whether
   * every machine's background job installs the team's version by itself (COMPAT-6, `--auto-update`).
   */
  cli?: { min: string; autoUpdate?: boolean } | null;
  /**
   * The brain's settings (BRAIN-1) when the org's admin policy doesn't set them. The brain runs on one of the team's own
   * Macs, on the team's own Claude plan, and needs no licence (Q8, 0.29.0). Same shape as the admin policy's `brain`;
   * a missing field takes the "off" default. Changed only by a code owner's review, like the rest of this file.
   */
  brain?: {
    level: "off" | "recommend" | "approve" | "autopilot";
    machine?: string | null;
    everyHours?: number;
    autopilot?: { actions?: string[]; maxSize?: Size; categories?: string[]; maxRunsPerDay?: number };
  } | null;
  /**
   * Org-skill hash allowlist (JOB, tiered trust): skill name → approved 12-hex content hash, CODEOWNERS-reviewed.
   * When set, a Linear-synced ("org") skill runs only if its hash is pinned here (fail closed); dropping a hash is
   * an instant kill. Unset = synced document skills run as-is (the default tier). Team and bundled skills, which git
   * already reviews, are never gated by this.
   */
  skills?: Record<string, string> | null;
  company?: { teams: { name: string; teamKey: string; projectId: string }[]; machine: string | null } | null;
  /** The team's live board, a Claude artifact everyone opens (BOARD-1). */
  board?: { url: string } | null;
  /**
   * The product managers' page in PMX Engine (EQ-28, bridge 1 of the join; CLI-7). Every PM's Workspace links to it. The
   * head of product publishes it with /pmxe-hubs and adds its link here in a pull request. Only the link: no content.
   */
  roadmap?: { url: string } | null;
}

export interface TeamCategory { skill: string; externalFacing?: boolean; required?: boolean }

/**
 * Whether this PM's agent takes a kind of work (JOB-9): the team requires it, or the PM switched it on. One rule for
 * pulling, the board and the CLI.
 */
export function takesCategory(personal: Pick<PersonalConfig, "categories">, team: Pick<TeamConfig, "categories">, category: string): boolean {
  const c = team.categories[category];
  return !!c && (c.required === true || personal.categories.includes(category));
}

export type Plan = "team" | "enterprise" | "api" | "bedrock" | "vertex" | "pro" | "max" | "free";

/** Personal config, in `~/.pmx/config.json`. Never synced, never committed. */
export interface PersonalConfig {
  version: 1;
  handle: string;
  machineId: string;
  repoPath: string;
  installedAt: string;
  plan: Plan;
  categories: string[];
  /**
   * No longer used (0.13.0): PMX works whenever the Mac is on and awake. `pmx init` still writes "always", so an
   * older pmx reading this file behaves the same; older saved hours are ignored.
   */
  workingHours?: { days: number[]; start: string; end: string };
  /**
   * `dailyUsd` null: no cap of the PM's own, only the team's (BUDGET-1). On a Claude plan the dollars are Claude
   * Code's estimate at API list prices, not a bill; 0 pauses every run.
   */
  budget: { dailyUsd: number | null; resetHour: number; overrideUsd?: number | null };
  /**
   * `routes` (BOARD-3): what each source may feed, by connector (granola, fireflies…, "file" for the folder, "slack").
   * "off" reads nothing from it, "mine" only your own to-dos, "linear" (the default) to-dos and team tasks too.
   */
  sources: {
    transcriptDirs: string[];
    slackChannel: string | null;
    routes?: Record<string, "off" | "mine" | "linear">;
    /** Recorders the PM added beyond the built-in meeting apps, like Momentum (INPUT-1). Every one is collected. */
    calls?: { connector: string; look?: string | null }[];
  };
  /** The personal never-ingest list (B2). Sensitive in itself, so it stays here. */
  neverIngest: { people: string[]; channels: string[]; meetingTitles: string[] };
  crmNamesFile: string | null;
  digest: { weekday: number; slackDmUserId: string | null };
  /** The hosted org this machine signed in to when pmx.config.json names none (PLAN-1). */
  cloud?: { url: string; orgId: string } | null;
  /** Content-free analytics events to the hosted app (PRIV-5). Off until the PM signs in and sees what's sent. */
  analytics?: { enabled: boolean; decidedAt: string } | null;
  /**
   * This PM's company email domains (B2), added to the team's `internalDomains`: a meeting with only these
   * domains is internal and never reaches the team's tracker. `pmx init` fills it in from the PM's work email.
   */
  companyDomains?: string[] | null;
  /** Who "me" is in a transcript, for individual to-dos (TODO-1). Learned from `pmx collect` or `pmx todo --me`. */
  identity?: { names: string[]; emails: string[] } | null;
  /** The board this PM published from this Mac with /pmx-board, and with which pmx (BOARD-1). */
  board?: { url: string; version: string; publishedAt: string } | null;
  /** The flow view this PM published from this Mac with /pmx-flow (FLOW-5). It reads this Mac only, so it's never a team setting. */
  flow?: { url: string; version: string; publishedAt: string } | null;
  /**
   * SIG-7 (0.25.0): whether this PM may send their own to-dos to Linear, one at a time, from the board or
   * `pmx todo linear <id>`. Off by default: to-dos come from every meeting, 1:1s included, and stay on this Mac.
   */
  todosToLinear?: boolean;
  /**
   * Phase 2 of joining PMX and PMX Engine: "hidden" keeps the Studio entry out of this Mac's PMX page. It appears only
   * where PMX Engine is installed, so a PM never sees it; `pmx open --hide-studio` / `--show-studio` set this.
   */
  studio?: "hidden";
}

export const DEFAULT_TEAM: Omit<TeamConfig, "team"> = {
  version: 1,
  model: "claude-sonnet-5-5",
  categories: {
    "problem-brief": { skill: "pmx-problem-brief" },
    "research-synthesis": { skill: "pmx-research" },
    "competitive-analysis": { skill: "pmx-competitive" },
    "build-brief": { skill: "pmx-build-brief" },
    "validation-plan": { skill: "pmx-validation-plan" },
    "validation-readout": { skill: "pmx-validation-readout" },
    spec: { skill: "pmx-spec" },
    "tracking-hygiene": { skill: "pmx-hygiene" },
  },
  sizes: {
    S: { minutes: 15, costUsd: 0.5 },
    M: { minutes: 30, costUsd: 1.5 },
    L: { minutes: 60, costUsd: 4 },
    XL: { minutes: 120, costUsd: 8 },
  },
  tracker: { kind: "none" },
  lease: "git",
  reviewQueueCap: 3,
  egress: ["api.anthropic.com", "api.linear.app", "github.com", "api.github.com"],
  allowedSources: ["transcripts"],
  slackChannels: [],
  allowPrivateChannels: false,
  internalDomains: [],
  synthesizer: null,
  caps: { perRunUsd: 3, perDayUsd: 20 },
  autoPause: { minVerdicts: 5, threshold: 0.3, windowDays: 30 },
};

export async function loadTeamConfig(repoPath: string): Promise<TeamConfig> {
  const raw = await readJson<Partial<TeamConfig>>(join(repoPath, TEAM_CONFIG_FILE));
  if (!raw) throw new Error(`No ${TEAM_CONFIG_FILE} in ${repoPath}. Run \`pmx init\` or check the PMX repo path.`);
  return validateTeamConfig({ ...DEFAULT_TEAM, team: "team", ...raw } as TeamConfig);
}

/**
 * A Linear team key or project ID from what someone pasted: a link like linear.app/acme/team/PMX/… becomes "PMX",
 * and linear.app/acme/project/pmx-5f2a91c0d3e4/overview becomes "pmx-5f2a91c0d3e4". The connector takes no links.
 */
export function linearRef(kind: "team" | "project", v: string): string {
  const m = v.trim().match(new RegExp(`linear\\.app/[^/]+/${kind}/([^/?#\\s]+)`, "i"));
  return m ? decodeURIComponent(m[1]!) : v.trim();
}

export function validateTeamConfig(c: TeamConfig): TeamConfig {
  assertSchema("teamConfig", c.version, TEAM_CONFIG_FILE);
  if (c.tracker?.kind === "linear") c.tracker = { ...c.tracker, teamKey: linearRef("team", c.tracker.teamKey), projectId: linearRef("project", c.tracker.projectId) };
  if (c.company?.teams) c.company = { ...c.company, teams: c.company.teams.map((t) => ({ ...t, teamKey: linearRef("team", t.teamKey), projectId: linearRef("project", t.projectId) })) };
  const problems: string[] = [];
  if (c.cli && !isVersion(c.cli.min)) problems.push(`cli.min must be a version like 0.5.0, not "${c.cli.min}"`);
  if (c.brain && !["off", "recommend", "approve", "autopilot"].includes(c.brain.level)) problems.push(`brain.level must be off, recommend, approve or autopilot, not "${c.brain.level}"`);
  if (c.brain?.everyHours !== undefined && !(Number.isFinite(c.brain.everyHours) && c.brain.everyHours >= 1)) problems.push("brain.everyHours must be a number of hours, 1 or more");
  if (c.board && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+\/?$/.test(c.board.url ?? "")) problems.push("board.url must be a Claude artifact link (https://claude.ai/artifact/…)");
  if (c.roadmap && !/^https:\/\/claude\.ai\/(code\/)?artifact\/[A-Za-z0-9_-]+\/?$/.test(c.roadmap.url ?? "")) problems.push("roadmap.url must be a Claude artifact link (https://claude.ai/artifact/…)");
  if (!c.model) problems.push("model must be set (NEUT-1)");
  for (const s of SIZES) if (!c.sizes?.[s]) problems.push(`sizes.${s} missing`);
  for (const [cat, v] of Object.entries(c.categories ?? {}))
    if (!/^[a-z][a-z0-9-]*$/.test(cat) || !v?.skill) problems.push(`category ${cat} needs a kebab-case name and a skill`);
    else if (v.required !== undefined && typeof v.required !== "boolean") problems.push(`categories.${cat}.required must be true or false`);
  if (c.reviewQueueCap < 1) problems.push("reviewQueueCap must be at least 1");
  for (const [n, h] of Object.entries(c.skills ?? {})) if (!/^[0-9a-f]{12}$/.test(h)) problems.push(`skills.${n} must be a 12-hex skill hash, not "${h}"`);
  if (problems.length) throw new Error(`pmx.config.json: ${problems.join("; ")}`);
  return c;
}

export async function loadPersonalConfig(): Promise<PersonalConfig> {
  const c = await readJson<PersonalConfig>(paths.config());
  if (!c) throw new Error("Not set up on this machine. Run `pmx init`.");
  assertSchema("personalConfig", c.version, paths.config());
  return c;
}

export async function savePersonalConfig(c: PersonalConfig): Promise<void> {
  await writeJson(paths.config(), c, 0o600);
}

/** Agent handle used for leases and the run log: an ID, not a name. */
export function agentHandle(p: Pick<PersonalConfig, "handle" | "machineId">): string {
  return `${p.handle}@${p.machineId}`;
}
