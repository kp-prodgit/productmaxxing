// LINEAR-2 (0.41.0, Founder 2026-11-27): a personal Linear API key is how PMX reaches Linear by default; the
// Claude app's task is the fallback. This file is the key's own path: what setup tells the PM to create, the check a
// pasted key gets before it's saved, and the move of a working Mac from the Claude app's sync to the key without losing
// anything that was queued. The key is read from the PM's prompt, checked, and stored in the keychain. It is never
// printed, logged, written to a file or put in an error (SEC-10).
import { LINEAR_SYNC_TASK, taskState } from "../claude/tasks.js";
import type { TeamConfig } from "../core/config.js";
import type { Keychain } from "../core/keychain.js";
import type { Fetch } from "../sources/slack.js";
import { assertTeamVersion } from "../core/version.js";
import { LinearError, linearTracker, type LinearDirect } from "../tracker/linear.js";
import { closeRelayRun, dropQueued, opWords, pendingIdentifier, pmxLabels, readOutbox, readResolved, readSnapshot, recordResolved, relayRunUnderWay, saveOutbox, type RelayOp } from "../tracker/relay.js";
import { forgetLinearChoice, rememberClaudeApp } from "./access.js";
import { linearWatch, projectCopy, readDirect, updateDirect } from "./direct.js";

export interface KeyDeps {
  team: TeamConfig;
  keychain: Keychain;
  fetch: Fetch;
  now: () => Date;
}

/** The teams a company roll-up on this Mac reads beside its own (COMPANY-1), or none when this Mac isn't the roll-up's. */
export function rollupTeams(team: TeamConfig, me: { handle: string; agent?: string }): { name: string; teamKey: string }[] {
  const c = team.company;
  if (!c?.teams.length || team.tracker.kind !== "linear") return [];
  const machine = c.machine ?? team.synthesizer;
  if (machine !== me.handle && machine !== me.agent) return [];
  const own = team.tracker.teamKey.toUpperCase();
  return c.teams.filter((t) => t.teamKey.toUpperCase() !== own).map((t) => ({ name: t.name, teamKey: t.teamKey }));
}

/** Where a key is created in Linear, in Linear's own menu names. */
export const KEY_PLACE = "Settings → Account → Security & access → Personal API keys → New API key";

/** What setup says before it asks for the key: where to create it and the least it must be allowed (LINEAR-2). */
export function keyHelp(team: TeamConfig, o: { rollup?: { name: string; teamKey: string }[] } = {}): string[] {
  if (team.tracker.kind !== "linear") return [];
  const key = team.tracker.teamKey;
  return [
    "Linear: PMX reaches your team's Linear with your own API key, so what you approve gets there within the half hour and PMX sees your team's changes as soon.",
    `  Create it in Linear: ${KEY_PLACE}.`,
    "  Permissions: Read and Write. Not Admin, and not Full access: PMX changes no workspace or team setting. \"Create issues\" and \"Create comments\" alone aren't enough, because PMX also labels and moves its own tasks.",
    `  Team access: only ${key}, the team that holds your PMX project.`,
    ...(o.rollup?.length ? [`  This Mac also runs your company's roll-up, which reads other teams' PMX projects: give the key Read on ${o.rollup.map((t) => `${t.name} (${t.teamKey})`).join(", ")} too.`] : []),
    "  PMX keeps the key in this Mac's keychain and nowhere else, and it works until you revoke it in Linear.",
    "  Can't create one (a workspace's admins can turn member keys off), or would rather not? Press Return: PMX then goes through your Claude app's Linear connector, which syncs once an hour.",
  ];
}

export const KEY_QUESTION = "Linear API key (Return to use the Claude app instead)";

export interface KeyCheck {
  ok: boolean;
  /** What PMX found, one line and then what's missing or worth knowing. Never the key. */
  lines: string[];
  who?: string;
}

const tracker = (team: TeamConfig) => team.tracker as Extract<TeamConfig["tracker"], { kind: "linear" }>;

/** The direct tracker as the background run and every command use it: PMX's own copy, and its memory of refusals. */
export function directFor(d: Pick<KeyDeps, "team" | "fetch" | "now">, token: string): LinearDirect {
  const t = tracker(d.team);
  return linearTracker({ token, teamKey: t.teamKey, projectId: t.projectId, fetch: d.fetch, copy: projectCopy(d.team), watch: linearWatch(d.now), now: d.now });
}

/**
 * Checks a key the PM just pasted, before anything is saved (LINEAR-2). One read with it: whose it is, and whether it
 * sees the team and its PMX project (and, on the roll-up's Mac, the other teams). Then PMX makes sure its own labels
 * exist in the team, which is a change only where one is missing, and so the one place a key without Write shows
 * before it's kept. A key that fails is refused with what's missing. `rollup`: the other teams this Mac's roll-up reads.
 */
export async function checkLinearKey(d: Pick<KeyDeps, "team" | "fetch" | "now">, token: string, o: { rollup?: { name: string; teamKey: string }[] } = {}): Promise<KeyCheck> {
  const t = tracker(d.team);
  if (/\s/.test(token) || !token.startsWith("lin_api_")) return { ok: false, lines: ["That isn't a Linear API key: one starts with lin_api_ and has no spaces. Nothing was saved."] };
  const keys = [t.teamKey, ...(o.rollup ?? []).map((x) => x.teamKey)];
  const ask = async (query: string, variables: Record<string, unknown>) => {
    const res = await d.fetch("https://api.linear.app/graphql", { method: "POST", headers: { authorization: token, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
    const body: any = await res.json().catch(() => null);
    const errors: any[] = Array.isArray(body?.errors) ? body.errors : [];
    const codes = errors.map((e) => String(e?.extensions?.code ?? e?.extensions?.type ?? "").toUpperCase());
    return { status: res.status, data: errors.length ? null : body?.data ?? null, rejected: res.status === 401 || codes.some((c) => c.includes("AUTHENTICATION")), limited: res.status === 429 || codes.some((c) => c.includes("RATELIMIT")) };
  };
  const WHO = "viewer { id name } teams(filter: { key: { in: $keys } }) { nodes { id key name } }";
  let all: Awaited<ReturnType<typeof ask>>;
  try {
    all = await ask(`query($keys: [String!], $id: String!) { ${WHO} project(id: $id) { id name } }`, { keys, id: t.projectId });
    // An answer without the project is Linear saying it can't be seen: ask once more for the rest, to say what's missing.
    if (!all.data && !all.rejected && !all.limited) {
      const rest = await ask(`query($keys: [String!]) { ${WHO} }`, { keys });
      all = { ...rest, data: rest.data ? { ...rest.data, project: null } : null };
    }
  } catch (e: any) {
    return { ok: false, lines: [`PMX couldn't reach Linear to check the key (${String(e?.message ?? e).slice(0, 120)}). Nothing was saved; try again when this Mac is online.`] };
  }
  if (all.rejected) return { ok: false, lines: ["Linear didn't accept that key: it's mistyped, cut short, or already revoked. Nothing was saved."] };
  if (all.limited) return { ok: false, lines: ["Linear asked PMX to slow down before it could check the key. Nothing was saved; try again in a few minutes."] };
  if (!all.data?.viewer) return { ok: false, lines: [`Linear didn't answer PMX's check of the key (HTTP ${all.status}). Nothing was saved; try again in a few minutes.`] };
  const who = String(all.data.viewer.name ?? "you");
  const teams: { key: string; name: string }[] = all.data.teams?.nodes ?? [];
  const own = teams.find((x) => String(x.key).toUpperCase() === t.teamKey.toUpperCase());
  const anew = `Create a key that has it (${KEY_PLACE}) and paste that. Nothing was saved.`;
  if (!own) return { ok: false, who, lines: [`Linear key for ${who}: it can't see team ${t.teamKey}, which holds your PMX project. The key's team access must include ${t.teamKey}, with Read and Write. ${anew}`] };
  if (!all.data.project) return { ok: false, who, lines: [`Linear key for ${who}: it sees team ${own.name} but not its PMX project (${t.projectId}). Either the key's team access leaves out a team that project belongs to, or pmx.config.json names another project. ${anew}`] };
  // PMX's labels: created where missing, as the Claude app's sync does at its first run. The one change made here.
  let made: string[];
  try {
    made = await linearTracker({ token, teamKey: t.teamKey, projectId: t.projectId, fetch: d.fetch, now: d.now }).ensureLabels(pmxLabels(d.team));
  } catch (e: any) {
    if (e instanceof LinearError && e.failure === "forbidden")
      return { ok: false, who, lines: [`Linear key for ${who}: can read ${own.name}'s PMX project but not change it${e.detail ? ` (Linear said: ${e.detail})` : ""}. PMX needs Read and Write on ${t.teamKey}. ${anew}`] };
    return { ok: false, who, lines: [`Linear key for ${who}: can read ${own.name}'s PMX project, but PMX couldn't check its labels there (${String(e?.message ?? e).slice(0, 160)}). Nothing was saved; try again in a few minutes.`] };
  }
  const lines = [made.length
    ? `Linear key for ${who}: can read and write ${own.name}'s PMX project (PMX added the ${made.length} label${made.length === 1 ? "" : "s"} of its own that ${made.length === 1 ? "was" : "were"} missing there).`
    : `Linear key for ${who}: can read ${own.name}'s PMX project. PMX's labels are all there, so it had nothing to change yet: its first change shows whether the key may write (it needs Read and Write).`];
  const unseen = (o.rollup ?? []).filter((r) => !teams.some((x) => String(x.key).toUpperCase() === r.teamKey.toUpperCase()));
  if (o.rollup?.length) lines.push(unseen.length
    ? `It can't see ${unseen.map((r) => `${r.name} (${r.teamKey})`).join(", ")}, so the company roll-up leaves ${unseen.length === 1 ? "that team" : "those teams"} out: the roll-up needs a key with Read on ${unseen.length === 1 ? "it" : "them"} too.`
    : `It also sees the ${o.rollup.length} other team${o.rollup.length === 1 ? "" : "s"} your company roll-up reads.`);
  return { ok: true, who, lines };
}

const TEXT_FIELDS = ["body", "line", "comment", "description"] as const;
/**
 * Whether Linear (or one of PMX's own rules) turned this one change down, as against PMX not reaching Linear at all:
 * only a refusal counts toward the three after which a change is dropped. An outage keeps everything queued.
 */
const refusedChange = (e: any): boolean => (e instanceof LinearError ? e.failure === "forbidden" : /^Linear: (?!HTTP \d)/.test(String(e?.message ?? "")) || /^Refusing |isn't in Linear|canary/i.test(String(e?.message ?? "")));
/** Queued changes the direct path doesn't carry: a shared skill travels as a Linear document, which only the Claude app's sync writes. */
const STAYS_QUEUED: RelayOp["kind"][] = ["upsert-skill-doc"];

export interface Drained {
  applied: number;
  /** Still in the outbox: refused by Linear (to try again), or a kind only the Claude app's sync carries. */
  waiting: number;
  lines: string[];
}

/**
 * Applies what was queued for the Claude app's sync, directly, in order, exactly as it was written (LINEAR-2): the
 * switch from the relay to a key loses nothing. Each change leaves the outbox only once Linear took it, and a new
 * issue's real identifier is recorded before its change leaves (as the sync's own check does), so a quote share or a
 * to-do parked under its PENDING-… finds the task. A change Linear refuses stays, is tried again by the next
 * background run, and is dropped after three refusals, with every change to an issue that then never exists. A rejected
 * key or a rate limit stops the pass where it is; nothing is lost.
 */
export async function drainOutbox(d: Pick<KeyDeps, "now">, t: LinearDirect): Promise<Drained> {
  const first = await readOutbox();
  const todo = first.ops.filter((op) => !STAYS_QUEUED.includes(op.kind));
  const lines: string[] = [];
  if (!todo.length) return { applied: 0, waiting: first.ops.length, lines };
  const resolved = await readResolved();
  const real = new Map<string, string>(Object.entries(resolved).map(([k, v]) => [k, v.identifier]));
  // Issue ids by identifier, from PMX's copy: Linear's API takes either, the copy saves it a lookup.
  const ids = new Map<string, string>(((await readSnapshot().catch(() => null))?.issues ?? []).map((n: any) => [String(n.identifier), String(n.id)]));
  const made = new Map<string, string>();
  const swap = (s: string) => s.replace(/PENDING-[0-9A-F]{6}/g, (m) => real.get(m) ?? m);
  /** An identifier's issue id: from the copy, else asked of Linear once (it takes an identifier), else the identifier itself. */
  const idFor = async (identifier: string): Promise<string> => {
    const known = ids.get(identifier);
    if (known) return known;
    const id = (await t.get(identifier).catch((e) => { if (e instanceof LinearError) throw e; return null; }))?.id ?? identifier;
    ids.set(identifier, id);
    return id;
  };
  /** The issue a queued change is for: null while the change that creates it hasn't reached Linear. */
  const issueOf = async (target: string): Promise<string | null> => {
    if (target.startsWith("ref:") && made.has(target.slice(4))) return made.get(target.slice(4))!;
    const identifier = target.startsWith("ref:") ? real.get(pendingIdentifier(target.slice(4))) : target.startsWith("PENDING-") ? real.get(target) : target;
    return identifier ? idFor(identifier) : null;
  };
  let applied = 0;
  const gaveUp = new Set<string>();
  for (const queued of todo) {
    const op = structuredClone(queued) as any;
    for (const k of TEXT_FIELDS) if (typeof op[k] === "string") op[k] = swap(op[k]);
    if (Array.isArray(op.lines)) op.lines = op.lines.map(swap);
    const id = "target" in op ? await issueOf(op.target) : null;
    // Its issue isn't in Linear yet (its creation was refused this pass): it waits with it.
    if ("target" in op && !id) continue;
    try {
      let created: { id: string; identifier: string } | null = null;
      if (op.kind === "create-task") created = await t.createInbox({ title: op.title, description: op.description, category: op.category, size: op.size, sources: [], ...(op.status === "ready" ? { ready: true } : {}) });
      else if (op.kind === "lodge-meeting") created = await t.lodgeAs({ title: op.title, description: op.description, agent: op.agent });
      else if (op.kind === "set-label") await t.setGroupLabel(id!, op.group, op.value);
      else if (op.kind === "set-status") await t.setStatus(id!, op.value);
      else if (op.kind === "set-agent") await t.setAgent(id!, op.value);
      else if (op.kind === "follow-state") await t.follow(id!, { from: op.from, to: op.to, type: op.type, comment: op.comment });
      else if (op.kind === "align-state") await t.align(id!, op.value, { type: op.type, recorded: op.recorded ?? null });
      else if (op.kind === "set-priority") await t.setPriority(id!, op.priority);
      else if (op.kind === "comment") await t.comment(id!, op.body);
      else if (op.kind === "append-description") await t.appendLine(id!, op.line);
      else if (op.kind === "finish-meeting") await t.finishMeeting(id!, { status: op.status, tasks: (op.lines as string[]).map((l) => l.replace(/^pmx:task\s+/, "")), note: op.comment });
      else if (op.kind === "rewrite") await t.rewrite(id!, { ...(op.title ? { title: op.title } : {}), ...(op.description !== undefined ? { description: op.description } : {}), ...(op.cancel ? { cancel: true } : {}) });
      if (created) {
        made.set(queued.id, created.id);
        ids.set(created.identifier, created.id);
        real.set(pendingIdentifier(queued.id), created.identifier);
        // Recorded before the change leaves the outbox (RUN-5).
        await recordResolved([{ pending: pendingIdentifier(queued.id), identifier: created.identifier }], d.now());
      }
      applied++;
      // One change at a time, so a pass that stops halfway never sends a change twice.
      const now = await readOutbox();
      await saveOutbox({ v: 1, ops: now.ops.filter((x) => x.id !== queued.id) });
    } catch (e: any) {
      // The key, the rate limit or the network, not this change: stop here, with everything not yet sent still queued.
      if (!refusedChange(e)) {
        const left = (await readOutbox()).ops.length;
        if (applied) lines.push(`Sent ${applied} change(s) that were waiting for the Claude app's sync; ${left} still wait.`);
        throw e;
      }
      const why = String(e?.message ?? e).slice(0, 300);
      const failures = (queued.failures ?? 0) + 1;
      if (failures >= 3) {
        gaveUp.add(queued.id);
        lines.push(`✘ gave up on ${opWords(queued)} after Linear refused it 3 times: ${why}. It's dropped; nothing more of it goes to Linear.`);
      } else {
        if (failures === 1) lines.push(`✘ Linear refused ${opWords(queued)}: ${why}. PMX tries again at the next background run, up to 3 times. To drop it now: pmx linear outbox drop ${queued.id.slice(0, 8)}`);
        const now = await readOutbox();
        await saveOutbox({ v: 1, ops: now.ops.map((x) => (x.id === queued.id ? { ...x, failures, lastError: why } : x)) });
      }
    }
  }
  // A change given up on goes with every change to the issue it would have created (R16b).
  if (gaveUp.size) await dropQueued((op) => gaveUp.has(op.id));
  const left = (await readOutbox()).ops;
  const docs = left.filter((op) => STAYS_QUEUED.includes(op.kind)).length;
  if (applied) lines.unshift(`Sent ${applied} change(s) that were waiting for the Claude app's sync straight to Linear${left.length - docs ? `; ${left.length - docs} still wait` : ""}.`);
  return { applied, waiting: left.length, lines };
}

/** The line about a Linear sync task left in the Claude app from before the key: safe to remove, never a problem. */
export const LEFTOVER_TASK = `The "${LINEAR_SYNC_TASK.title}" task in your Claude app isn't needed any more: with your key PMX syncs Linear itself. If it still runs it does nothing. Delete it when you like: Claude app, Code tab → Scheduled → the task → Delete.`;

/** Says the leftover task once (the key's first save, or the first background run that finds it), and remembers it did. */
export async function leftoverTaskOnce(now: Date): Promise<string | null> {
  if ((await taskState(LINEAR_SYNC_TASK).catch(() => "missing")) === "missing") return null;
  if ((await readDirect()).leftoverTold) return null;
  await updateDirect((r) => { r.leftoverTold = now.toISOString(); });
  return LEFTOVER_TASK;
}

/**
 * Saves a checked key and moves this Mac onto it (LINEAR-2). The key goes to the keychain; PMX reads the project once,
 * so its page has PMX's own copy from this minute on; and everything still queued for the Claude app's sync is sent
 * directly. Where a Claude sync is running right now, its changes are left to it (its last step hands PMX what it
 * applied) and the background run sends the rest. Returns what to tell the PM. A first read that fails leaves the key
 * saved: the next background run does the same again.
 */
export async function adoptKey(d: KeyDeps, token: string): Promise<{ lines: string[]; drained: Drained | null }> {
  await d.keychain.set("linear-token", token);
  await forgetLinearChoice();
  // A new key starts clean: whatever Linear refused the old one is forgotten.
  await updateDirect((r) => { r.problem = null; });
  const lines: string[] = ["Saved the key in this Mac's keychain. PMX now reads and writes Linear itself, with every background run (every 30 minutes while this Mac is awake)."];
  let drained: Drained | null = null;
  try {
    const t = directFor(d, token);
    await t.list();
    // What's queued is shared team work, like every write: a pmx older than the team's minimum sends none of it (COMPAT-2).
    assertTeamVersion(d.team);
    if (await relayRunUnderWay(d.now())) {
      if ((await readOutbox()).ops.length) lines.push("A Linear sync is running in your Claude app right now, so PMX leaves the changes it's applying to it, and sends whatever it doesn't with the next background run.");
    } else {
      await closeRelayRun();
      drained = await drainOutbox(d, t);
      lines.push(...drained.lines);
    }
  } catch (e: any) {
    lines.push(`PMX couldn't finish its first read of Linear with the key (${String(e?.message ?? e).slice(0, 200)}). The key is saved; the next background run reads Linear and sends anything still waiting.`);
  }
  const docs = (await readOutbox()).ops.filter((op) => STAYS_QUEUED.includes(op.kind)).length;
  if (docs) lines.push(`${docs} shared skill document(s) still wait: sharing a skill through Linear goes through the Claude app's sync only. \`pmx linear outbox\` lists them; \`pmx linear outbox drop <ID>\` drops one.`);
  const left = await leftoverTaskOnce(d.now());
  if (left) lines.push(left);
  return { lines, drained };
}

/** `pmx linear key --remove`: back to the Claude app's sync. The key leaves the keychain; revoking it is done in Linear. */
export async function removeKey(d: Pick<KeyDeps, "keychain" | "now">): Promise<string[]> {
  if (!(await d.keychain.get("linear-token"))) return ["No Linear API key is stored on this Mac."];
  await d.keychain.delete("linear-token");
  await rememberClaudeApp(d.now());
  await closeRelayRun();
  // The copy stays for the page until the Claude app's first sync replaces it; PMX itself no longer builds on it.
  await updateDirect((r) => { r.problem = null; r.projectId = null; r.fullAt = null; r.through = null; r.leftoverTold = null; });
  return [
    "Removed the Linear API key from this Mac's keychain. PMX now reaches Linear through your Claude app's Linear connector, once an hour.",
    `Type /pmx-schedule in the Claude app (Code tab) so it has the "${LINEAR_SYNC_TASK.title}" task; until its first run PMX works from its copy of Linear as of now.`,
    `The key itself still works until you revoke it in Linear: ${KEY_PLACE.replace(/ → New API key$/, "")}.`,
  ];
}
