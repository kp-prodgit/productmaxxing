import { gitRefLease } from "../lease/git-ref.js";
import { gitMeetingLedger, type MeetingLedger } from "../meetings/git-ledger.js";
import type { LeaseProvider } from "../lease/types.js";
import { linearTracker } from "../tracker/linear.js";
import { relayTracker } from "../tracker/relay.js";
import { linearAccessToken } from "../linear/oauth.js";
import { directFor } from "../linear/switch.js";
import { linearWatch } from "../linear/direct.js";
import { memoryTracker, type Tracker } from "../tracker/types.js";
import type { Ctx } from "./context.js";
import type { PersonalConfig, TeamConfig } from "./config.js";
import { assertTeamVersion } from "./version.js";

export interface Services {
  tracker: Tracker;
  lease: LeaseProvider;
  /** The team's record of processed meetings, in the PMX repo (MEET-2, PRIV-7). */
  meetings: MeetingLedger;
  /** Categories blocked by admin policy or auto-paused, with the reason. */
  paused(): Promise<Map<string, string>>;
}

type Factory<T> = (ctx: Ctx) => Promise<T | null>;

export type TeamTransform = (team: TeamConfig, personal: PersonalConfig) => Promise<{ team: TeamConfig; blockRuns: string | null }>;
const transforms: TeamTransform[] = [];

/** ee/ registers admin policy here. It narrows team config before any command uses it. */
export function registerTeamTransform(t: TeamTransform): void {
  transforms.push(t);
}

export async function effectiveTeam(team: TeamConfig, personal: PersonalConfig): Promise<{ team: TeamConfig; blockRuns: string | null }> {
  let cur = team;
  let blockRuns: string | null = null;
  for (const t of transforms) {
    const r = await t(cur, personal);
    cur = r.team;
    blockRuns ??= r.blockRuns;
  }
  return { team: cur, blockRuns };
}

export type ProjectRef = { teamKey: string; projectId: string };
type ProjectFactory = (ctx: Ctx, p: ProjectRef) => Promise<Tracker | null>;

/** ee/ registers the cloud lease, the brokered Linear token, policy and auto-pause here. */
const overrides: { tracker?: Factory<Tracker>; lease?: Factory<LeaseProvider>; paused?: ((ctx: Ctx) => Promise<Map<string, string>>)[]; project?: ProjectFactory } = { paused: [] };

export function registerServices(o: { tracker?: Factory<Tracker>; lease?: Factory<LeaseProvider>; paused?: (ctx: Ctx) => Promise<Map<string, string>>; project?: ProjectFactory }): void {
  if (o.tracker) overrides.tracker = o.tracker;
  if (o.project) overrides.project = o.project;
  if (o.lease) overrides.lease = o.lease;
  if (o.paused) overrides.paused!.push(o.paused);
}

/** Categories blocked by admin policy or auto-paused (REV-3), with the reason. Empty without ee/. */
export async function pausedCategories(ctx: Ctx): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  for (const f of overrides.paused ?? []) for (const [k, v] of await f(ctx)) m.set(k, v);
  return m;
}

export async function services(ctx: Ctx, test?: Partial<Services>): Promise<Services> {
  // Everything that reaches the tracker or leases is shared team work (COMPAT-2).
  assertTeamVersion(ctx.team);
  const tracker = test?.tracker ?? (await overrides.tracker?.(ctx)) ?? (await defaultTracker(ctx));
  const lease = test?.lease ?? (await overrides.lease?.(ctx)) ?? gitRefLease(ctx.repo, ctx.now);
  return {
    tracker,
    lease,
    meetings: test?.meetings ?? gitMeetingLedger(ctx.repo),
    paused: test?.paused ?? (() => pausedCategories(ctx)),
  };
}

/** A read-mostly tracker for another team's PMX project (COMPANY-1). Same token as this team's. */
export async function projectTracker(ctx: Ctx, p: ProjectRef): Promise<Tracker> {
  const viaEe = await overrides.project?.(ctx, p);
  if (viaEe) return viaEe;
  const token = (await ctx.keychain.get("linear-token")) ?? (await linearAccessToken(ctx.keychain, ctx.fetch, ctx.now()));
  if (!token) throw new Error("The company roll-up reads several Linear projects, which the Claude app's sync doesn't cover. Store a Linear API key with Read on those teams on the roll-up's Mac: pmx linear key.");
  // No copy of another team's project is kept: the roll-up reads each once a day. A rejected key is remembered all the same.
  return linearTracker({ token, teamKey: p.teamKey, projectId: p.projectId, fetch: ctx.fetch, watch: linearWatch(ctx.now), now: ctx.now });
}

async function defaultTracker(ctx: Ctx): Promise<Tracker> {
  const t = ctx.team.tracker;
  if (t.kind !== "linear") {
    ctx.out.warn("No tracker configured in pmx.config.json; using an empty in-memory queue.");
    return memoryTracker();
  }
  // LINEAR-1, LINEAR-2: an API key (the default from 0.41.0), else the PM's Linear sign-in, else Claude relays through
  // its connector. With a key PMX keeps its own copy of the project, reads only what changed, and remembers a refusal.
  // The relay is never a silent fallback for a key Linear rejects: that is said, and the PM chooses.
  const key = await ctx.keychain.get("linear-token");
  if (key) return directFor(ctx, key);
  const token = await linearAccessToken(ctx.keychain, ctx.fetch, ctx.now());
  if (token) return linearTracker({ token, teamKey: t.teamKey, projectId: t.projectId, fetch: ctx.fetch });
  return relayTracker(ctx.team, (m) => ctx.out.warn(m), ctx.now);
}
