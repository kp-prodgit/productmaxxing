import { isProductLead, startsNow } from "../core/config.js";
import type { Ctx } from "../core/context.js";
import { killSwitchOn } from "../core/killswitch.js";
import { RunLogStore } from "../core/runlog-store.js";
import { loadState } from "../core/state.js";
import { tickHealth } from "./tick.js";
import { budget, usageLine } from "../budget/provider.js";
import { linearAccess } from "../linear/access.js";
import { relayHealth } from "../tracker/relay.js";
import { syncDueCron } from "../claude/tasks.js";
import { join } from "node:path";
import { VENDORED_CLI } from "../core/vendor.js";
import { compareVersions, currentVersion, vendoredVersion } from "../core/version.js";
import { readHistory } from "../setup/checklist.js";
import { practiceUntil } from "../setup/gather.js";
import { loadPipeline } from "../flow/pipeline-load.js";
import { needsLine, needsYou } from "../flow/needs.js";
import { heldOverLine } from "../synth/held-over.js";
import { synthesisLine } from "../synth/status.js";
import type { EngineSource } from "../flow/strategy.js";

/** `engine` (BOARD-11): PMX Engine as `pmx status` hands it over, so its moves that are yours count too. */
export async function runStatus(ctx: Ctx, extra: string[] = [], o: { engine?: EngineSource } = {}): Promise<string> {
  const lines: string[] = [];
  const { team, personal } = ctx;
  // BOARD-10: the same count as the Needs you cards on PMX's page, from the same data.
  try {
    const board = await loadPipeline(ctx, { level: "local", hours: 168, keychain: ctx.keychain, engine: o.engine });
    lines.push(needsLine(board.needsYou ?? needsYou(board)));
    // SIG-9: needs past the team's task limit aren't lost; one line says they come back.
    const more = heldOverLine(board.needs.heldOver ?? 0);
    if (more) lines.push(`  ${more}`);
    // N1: suggestions of one of PMX's kinds of work your team hasn't turned on wait on this Mac until it does.
    for (const k of board.kindsWaiting ?? []) lines.push(`  ${k.text}${k.pending ? ": the change waits for a teammate's approval" : `: pmx jobs add ${k.kind} sends it to your team for approval`}.`);
  } catch (e) {
    lines.push(`Needs you: couldn't count (${e instanceof Error ? e.message : String(e)})`);
  }
  lines.push(`Team ${team.team} · agent ${ctx.agent} · model ${team.model}`);
  lines.push(`PMX repo: ${personal.repoPath}`);
  // INPUT-3, COLLECT-4: where team tasks come from, and whether anything reads the team's channels.
  const synth = synthesisLine(team, personal, ctx.agent);
  if (synth) lines.push(synth);
  // INSTALL-4: who the team named its product lead, the one person PMX offers PMX Engine to.
  if (team.productLead) lines.push(`Product lead: ${team.productLead}${isProductLead(team, personal) ? " (you)" : ""}`);
  const ks = await killSwitchOn(ctx.repo).catch(() => ({ on: false, reason: null }));
  lines.push(ks.on ? `Kill switch: ON (${ks.reason})` : "Kill switch: off");

  const state = await loadState();
  const b = budget(personal, team, state, ctx.now());
  lines.push(usageLine(b, personal.plan));
  lines.push(`Last digest: ${state.lastDigestWeek ?? "never"}`);
  const tick = tickHealth(state.lastTick, 3, ctx.now());
  lines.push(tick ? `Background job: ${tick.ok ? "" : "✘ "}${tick.detail.replace(/^background job('s)? /, "")}` : "Background job: no run recorded yet");
  // How current PMX's copy of Linear is: through the Claude relay, agents work from the last sync (CLAUDE-5).
  const access = await linearAccess(team, ctx.keychain).catch(() => "none" as const);
  if (access === "relay") {
    const h = await relayHealth(team, ctx.now(), { cron: await syncDueCron(ctx.personal.taskHours) }).catch(() => null);
    if (h) lines.push(`Linear: ${h.ok ? "" : "✘ "}${h.detail.replace(/^Linear through Claude: /, "through Claude, ")}`);
  } else if (access !== "none") lines.push(`Linear: direct (${access === "key" ? "API key" : access})`);

  // PULL-9 (#14): the first week only says what an agent would take.
  const practice = practiceUntil(personal, ctx.now());
  lines.push(practice ? `Agents: practice mode until ${practice.slice(0, 10)}: your agent says which task it would take, without running it (pmx pull --live runs one now)` : "Agents: run Ready tasks for real");
  // APPROVE-3: the team setting that decides whether approving can make a task Ready.
  if (team.tracker.kind !== "none") lines.push(startsNow(team) ? "Approving: Start now is on (pmx proposals start makes a task Ready for agents; approve sends it to the backlog)" : "Approving: Start now is off for your team: approved tasks wait in the backlog until a teammate moves them to Todo in Linear");
  // COMPAT-2 (#19): what teammates install from the team repo, when it isn't this Mac's version.
  const vendored = await vendoredVersion(join(personal.repoPath, VENDORED_CLI), ctx.exec).catch(() => null);
  if (vendored && vendored !== currentVersion()) lines.push(`Team package: pmx ${vendored} in the team repo, this Mac runs ${currentVersion()}${(compareVersions(vendored, currentVersion()) ?? 0) < 0 ? ": teammates who run pmx update get the older one (team lead: pmx vendor --require)" : ": run pmx update"}`);
  const store = new RunLogStore(ctx);
  if (await store.exists()) {
    const entries = (await store.entries()).filter((e) => e.agent === ctx.agent);
    const last = entries.at(-1);
    lines.push(`Run log: ${entries.length} entries from this agent${last ? `, last ${last.type} at ${last.ts}` : ""}`);
  } else lines.push("Run log: no entries yet");
  lines.push(...extra);
  // SETUP-1: where this Mac stands, as of the background job's last checklist.
  const cl = (await readHistory())?.last;
  if (cl) lines.push(`Setup: ${cl.counts.done} steps done, ${cl.counts.todo + cl.counts.warn} to look at${cl.next ? `. Next: ${cl.next.title}` : ""} (pmx checklist)`);
  return lines.join("\n");
}
