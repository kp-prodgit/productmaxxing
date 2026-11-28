import type { Ctx } from "../core/context.js";
import { services } from "../core/services.js";
import { decide, loadQueue, type Verdict } from "../review/queue.js";
import { approvedText, approveProposals, dropProposals, heldText, setProposalTheme } from "../synth/proposals.js";
import { startsNow } from "../core/config.js";
import { dropStopped, retryStopped } from "../pull/stopped.js";
import { applyPersonal, checkChange, describe, isTeamChange, loosens, proposeTeamChanges, saveTakes, SETTINGS_BRANCH } from "./actions.js";
import { checkNeverIngest, whatIf } from "./edit.js";
import { loadPipeline } from "./pipeline-load.js";
import { forgetTeamPr, rememberTeamPr } from "./team-prs.js";
import { localHost } from "../core/host.js";
import { digestAction } from "./digests.js";
import { startJob } from "./jobs.js";
import { addTodo, completeTodo, placeTodo } from "../todo/todo.js";
import { moveWork, PLACES, sendCommitment, type Place } from "../todo/move.js";
import { openWebServer, stopWebServer, webServerStatus } from "./web-server.js";
import type { PipelineActions } from "./pipeline-act.js";
import { macConfirm, type Confirm } from "../mcp/pair.js";
import { checklistForPage, pageWords, readHistory } from "../setup/checklist.js";
import { setTaskHours, TASK_HOURS, type TaskHours } from "../claude/tasks.js";
import { flowCapabilities, flowPageHtml, markFlowPublished } from "../claude/flow.js";
import { currentVersion } from "../core/version.js";
import { linearAccess } from "../linear/access.js";
import { mcpEntry } from "../mcp/server.js";
import { runningNow } from "./running.js";
import type { EngineSource } from "./strategy.js";

/** What `pmx flow --web` serves for the pipeline board (BOARD-3): this Mac's data, and the writes only it may make. */
/**
 * The board's handlers for a server that stays up (`pmx flow --web`): each call builds them from a fresh context, so
 * the board shows and saves the settings as they are on disk now, not as they were when the server started. A change
 * made elsewhere (the Claude app's page, `pmx todo --linear`, the collection task adding its folder) shows on the next
 * read, and the board's next save can't write an old copy back over it. The Claude app's server does the same.
 */
export async function liveHandlers(ctx: () => Promise<Ctx>, deps: HandlerDeps = {}): Promise<ReturnType<typeof pipelineHandlers>> {
  const first = pipelineHandlers(await ctx(), deps);
  return Object.fromEntries(Object.keys(first).map((k) => [k, async (...a: unknown[]) => (pipelineHandlers(await ctx(), deps) as any)[k](...a)])) as unknown as ReturnType<typeof pipelineHandlers>;
}

/**
 * What the handlers need besides the context. `confirm` asks the PM on this Mac before a setup step that changes the
 * background job or the Claude app's settings (SETUP-2); tests pass their own. `self` says which server answers.
 */
export interface HandlerDeps {
  confirm?: Confirm; self?: "mcp" | "page"; cliPath?: string;
  /**
   * BOARD-11: PMX Engine, as `pmx open` and `pmx mcp` hand it over from the bridge. Only this Mac's page (`data`) and
   * the paired page's `board` and `board_act` use it; without it, nothing about Engine shows.
   */
  engine?: EngineSource;
}

/** How old the recorded checklist may be for a fix to trust it; older, PMX works it out again first. */
const FRESH_MS = 10 * 60000;

export function pipelineHandlers(ctx: Ctx, deps: HandlerDeps = {}): PipelineActions & Required<Pick<PipelineActions, "todoAdd" | "todoPlace">> {
  const confirm = deps.confirm ?? macConfirm;
  /**
   * SETUP-2: one checklist step PMX can do itself, by its ID, from the allowlist in src/setup/fix.ts. Answers with the
   * checklist worked out again, the way the background job does, so the page shows where the Mac stands now.
   */
  const checklistFix = async (step: string): Promise<{ status: number; body: unknown }> => {
    const [{ checklistFor }, { runFix, pagePrompt }] = await Promise.all([import("../commands/index.js"), import("../setup/fix.js")]);
    const last = (await readHistory())?.last ?? null;
    // The recorded checklist when it's recent and this pmx's own (an older one's has no fixes); else worked out now.
    const current = last && last.version === currentVersion() && Math.abs(Date.now() - Date.parse(last.at)) < FRESH_MS ? last : await checklistFor(ctx).catch(() => last);
    const r = await runFix(step, current, { ctx, confirm: (what) => confirm(pagePrompt(what)), cliPath: deps.cliPath });
    const after = r.done ? await checklistFor(ctx).catch(() => current) : current;
    const setup = checklistForPage(after);
    return r.status < 400 ? { status: r.status, body: { message: pageWords(r.message) || "Done.", setup } } : { status: r.status, body: { error: pageWords(r.message) || "PMX couldn't do that.", setup } };
  };
  return {
    data: (hours: number) => loadPipeline(ctx, { level: "local", hours, keychain: ctx.keychain, engine: deps.engine }),
    async proposals(action: "approve" | "start" | "drop", ids: string[], reason?: string) {
      if (action === "drop") {
        // R6: the PM's reason, when the page's Drop gave one, goes with the drop in its run's receipt.
        const r = await dropProposals(ids, ctx.now(), reason);
        return r.dropped.length ? `Dropped ${r.dropped.map((p) => `"${p.title}"`).join(", ")}${reason?.trim() ? `: ${reason.trim()}` : ""}.` : "Nothing to drop.";
      }
      // APPROVE-3: Start now is the PM's approval plus Ready; Later (approve) sends the task to the pool, as before.
      const start = action === "start";
      const r = await approveProposals(ctx, await services(ctx), ids, { start });
      // R16: a task that gave an open task its sources is said in `checked`; that task stays where it is.
      return [approvedText(r.posted.filter((p) => !p.filled), { start, startNow: startsNow(ctx.team) }), ...r.checked.map((c) => `${c}.`), ...r.duplicates.map((d) => `Not sent: ${d}.`), ...r.held.map((h) => `Not sent: ${heldText(h)}.`), ...r.unthemed.map((u) => `${u}.`), ...r.notShared].filter(Boolean).join(" ") || "Nothing to approve.";
    },
    async proposalTheme(id: string, theme: string | null) {
      try {
        const r = await setProposalTheme(ctx.personal.repoPath, [id], theme);
        if (!r.changed.length) return { status: 404, body: { error: "That task is no longer waiting." } };
        return { status: 200, body: { message: r.theme ? `Theme: ${r.theme}.` : "No theme.", theme: r.theme } };
      } catch (e: any) {
        return { status: 400, body: { error: e.message } };
      }
    },
    async changes(raw: unknown[], confirmLoosening: boolean) {
      let list;
      try { list = raw.map((c) => checkChange(c, ctx.team)); } catch (e: any) { return { status: 400, body: { error: e.message } }; }
      const loose = list.filter((c) => loosens(c, ctx.personal, ctx.team));
      if (loose.length && !confirmLoosening) return { status: 409, body: { error: "Some changes let more of your meetings through. Confirm them first.", loosening: loose.map(describe) } };
      const applied = await applyPersonal(ctx.personal, list.filter((c) => !isTeamChange(c)));
      const team = list.filter(isTeamChange);
      // Personal changes are already saved by now, so a failed pull request is reported next to them, not as a failure.
      let pr: { url: string } | null = null, prError: string | null = null;
      if (team.length) {
        try {
          const r = await proposeTeamChanges(ctx, team, { from: "board" });
          await rememberTeamPr({ id: r.id, url: r.url, at: ctx.now().toISOString(), changes: team.map(describe) });
          pr = { url: r.url };
          // Whoever proposes a kind of work wants their own agent to take it once it merges (JOB-8).
          // So does whoever turns on one of PMX's own (CAT-8, N1), as `pmx jobs add` does.
          const made = team.flatMap((c) => (c.kind === "new-kind" ? [c.slug] : c.kind === "builtin-kind" ? [c.name] : []));
          if (made.length) await saveTakes(ctx.personal, made);
        } catch (e: any) { prError = e.message; }
      }
      return { status: 200, body: { applied, pr, prError } };
    },
    /**
     * BOARD-9 (#16): a team repo with no remote can't open a pull request, so team settings from the board stay a local
     * branch. Applying it merges it into the PM's checkout, as accepting a pull request would.
     */
    async teamApply(branch: string) {
      if (!SETTINGS_BRANCH.test(branch)) return { status: 400, body: { error: "That isn't a team settings branch from PMX." } };
      if (await ctx.repo.hasRemote()) return { status: 409, body: { error: "Your team repo has a remote, so this is a pull request: a teammate approves and merges it there." } };
      try {
        await localHost(ctx.repo).accept(branch);
        await forgetTeamPr(branch);
        return { status: 200, body: { message: "Applied your team's settings. They take effect from PMX's next run." } };
      } catch (e: any) { return { status: 500, body: { error: e.message } }; }
    },
    /** A draft pull request decided from the board, as `pmx review` would. */
    async review(identifier: string, verdict: string, note: string) {
      if (!["accepted", "rejected", "redo"].includes(verdict)) return { status: 400, body: { error: "verdict is accepted, rejected or redo" } };
      const svc = await services(ctx);
      // Any teammate's draft can be decided here, as `pmx review --all` can: the board lists every task in review.
      const { items, host, decided } = await loadQueue(ctx, svc, { all: true });
      const item = items.find((x) => x.task.identifier === identifier);
      // R13: decided on another Mac since this Mac's last Linear sync: it says so, and nothing is decided twice.
      if (!item) return { status: 404, body: { error: decided.find((d) => d.identifier === identifier)?.text ?? `${identifier} isn't waiting for review any more.` } };
      try { return { status: 200, body: { message: await decide(ctx, svc, host, item, verdict as Verdict, { note }) } }; }
      catch (e: any) { return { status: 400, body: { error: e.message } }; }
    },
    /** The weekly digest: save an edit, approve it (pull request and Slack DM) or reject it (BOARD-5). */
    digest(action: string, week: string, markdown?: string) {
      return digestAction(ctx, action, week, markdown);
    },
    /** "Run now": one background step, run here (BOARD-5). */
    run(step: string) {
      return Promise.resolve(startJob(ctx, step));
    },
    /** A private to-do marked done from the board, as `pmx todo done` does. */
    async todoDone(id: string) {
      if (typeof id !== "string" || !/^[\w-]{3,64}$/.test(id)) return { status: 400, body: { error: "Unknown to-do." } };
      try { const t = await completeTodo(id, ctx.now()); return { status: 200, body: { message: `Done: ${t.text}` } }; }
      catch (e: any) { return { status: 404, body: { error: e.message.replace(/`([^`]+)`/g, "$1") } }; }
    },
    /** A to-do the PM typed on the board (BOARD-6). */
    async todoAdd(input: { text: unknown; due?: unknown; when?: unknown }) {
      try { const t = await addTodo(input, ctx.now()); return { status: 200, body: { message: `Added: ${t.text}`, todo: { id: t.id } } }; }
      catch (e: any) { return { status: 400, body: { error: e.message } }; }
    },
    /** A to-do moved to Today, This Evening, Someday or a date, or reopened after an undo. */
    async todoPlace(id: string, p: { due?: unknown; when?: unknown; reopen?: boolean }) {
      if (typeof id !== "string" || !/^[\w-]{3,64}$/.test(id)) return { status: 400, body: { error: "Unknown to-do." } };
      try { const t = await placeTodo(id, p); return { status: 200, body: { message: p.reopen ? `Reopened: ${t.text}` : `Moved: ${t.text}` } }; }
      catch (e: any) { return { status: 400, body: { error: e.message.replace(/`([^`]+)`/g, "$1") } }; }
    },
    /** SIG-7: one to-do sent to Linear, only when the PM turned that on in Settings. */
    async todoLinear(id: string) {
      if (typeof id !== "string" || !/^[\w-]{3,64}$/.test(id)) return { status: 400, body: { error: "Unknown to-do." } };
      try {
        // R7 (SIG-7): checked like every other Linear text before it goes; a refusal is the action's answer.
        const r = await sendCommitment(ctx, (await services(ctx)).tracker, id);
        return { status: 200, body: { message: r.already ? `Already in Linear as ${r.identifier}.` : `Sent to Linear as ${r.identifier}: ${r.text}` } };
      } catch (e: any) { return { status: 400, body: { error: e.message.replace(/`([^`]+)`/g, "$1") } }; }
    },
    /** TODO-5: a to-do, a proposal or a team task moved to private, to-do or product, as `pmx move` does. */
    async move(input: { ref: string; to: string; kind?: string; size?: string }) {
      if (!/^[\w-]{3,64}$/.test(input.ref) || !(PLACES as readonly string[]).includes(input.to)) return { status: 400, body: { error: "Unknown move." } };
      try {
        const r = await moveWork(ctx, () => services(ctx), input.ref, input.to as Place, { kind: input.kind, size: input.size });
        return { status: 200, body: { message: r.message + (r.identifier?.startsWith("PENDING-") ? " It reaches Linear at the next Claude sync." : ""), moved: r } };
      } catch (e: any) { return { status: 400, body: { error: e.message.replace(/ \(--kind\)/, "").replace(/`([^`]+)`/g, "$1") } }; }
    },
    /** PULL-12: a task PMX stopped after failed runs, tried again or dropped, as `pmx review --retry` and `--drop` do. */
    async stopped(identifier: string, action: string) {
      if (action !== "retry" && action !== "drop") return { status: 400, body: { error: "Try again or drop the task." } };
      try {
        const svc = await services(ctx);
        return { status: 200, body: { message: await (action === "retry" ? retryStopped : dropStopped)(ctx, svc, identifier) } };
      } catch (e: any) { return { status: 400, body: { error: e.message } }; }
    },
    /** A paused category resumed from the board, as `pmx review --unpause` does (Team plan). */
    async resume(category: string) {
      if (!(category in ctx.team.categories)) return { status: 400, body: { error: "Unknown category." } };
      const { unpauseHandler } = await import("../commands/review.js");
      if (!unpauseHandler) return { status: 409, body: { error: "Resuming a paused category comes with the Team plan." } };
      try { return { status: 200, body: { message: String(await unpauseHandler(ctx, category)).replace(/`([^`]+)`/g, "$1") } }; }
      catch (e: any) { return { status: 400, body: { error: e.message } }; }
    },
    /**
     * BOARD-8: this Mac's own page, from the Claude app's page. "open" starts it if it isn't running and opens it in the
     * PM's browser, as `pmx open` does; "stop" stops it. The page's link never leaves this Mac.
     */
    async localPage(action: string) {
      if (action !== "open" && action !== "stop") return { status: 400, body: { error: `Unknown action "${action}".` } };
      try {
        if (action === "open") {
          const r = await openWebServer(ctx.exec);
          return { status: 200, body: { message: r.started ? "Started PMX's page on this Mac and opened it in your browser." : "Opened PMX's page on this Mac in your browser.", localPage: await webServerStatus() } };
        }
        const stopped = await stopWebServer();
        return { status: 200, body: { message: stopped ? "Stopped PMX's page on this Mac." : "PMX's page on this Mac wasn't running.", localPage: await webServerStatus() } };
      } catch (e: any) { return { status: 500, body: { error: e.message } }; }
    },
    /**
     * One-click setup from a board before 0.36.0: "install-job" registers the background job. It's the checklist's
     * job.installed fix now, so it asks on the Mac first like every fix that changes the job.
     */
    async setup(action: string) {
      if (action !== "install-job") return { status: 400, body: { error: `Unknown setup step "${action}".` } };
      return checklistFix("job.installed");
    },
    /**
     * SETUP-2: one checklist step PMX can do itself, by its ID, from the allowlist in src/setup/fix.ts. Answers with the
     * checklist worked out again, the way the background job does, so the page shows where the Mac stands now.
     */
    checklistFix: (step: string) => checklistFix(step),
    /** CLAUDE-6: the PM's working hours for PMX's Claude tasks. A PMX setting: nothing changes in the Claude app. */
    async taskHours(hours: string) {
      if (!(TASK_HOURS as readonly string[]).includes(hours)) return { status: 400, body: { error: "hours is weekdays or always" } };
      // LINEAR-2 (0.41.0): with a Linear API key the hours are meeting collection's only, and the answer says so.
      const direct = (await linearAccess(ctx.team, ctx.keychain).catch(() => "none" as const)) === "key";
      return { status: 200, body: { message: await setTaskHours(ctx.personal, hours as TaskHours, { direct }), taskHours: hours } };
    },
    /** FLOW-8: exactly the page `pmx flow --publish-json` would have Claude publish, for the page to publish itself. */
    async pageHtml() {
      return { status: 200, body: { html: await flowPageHtml(ctx.team), version: currentVersion(), capabilities: flowCapabilities() } };
    },
    /** FLOW-8: the page in Claude now runs `version`; recorded like `pmx flow --set-url`, keeping its link. */
    async pagePublished(version: string) {
      const r = await markFlowPublished(ctx.personal, version, ctx.now());
      return r.recorded ? { status: 200, body: { message: `PMX's page in Claude is now pmx ${version}.` } } : { status: 409, body: { error: `Not recorded: ${r.why}.` } };
    },
    /** OBS-5: what PMX is doing on this Mac right now, for Health → Running. One `ps` call. */
    async running() {
      const access = await linearAccess(ctx.team, ctx.keychain).catch(() => "none" as const);
      const entry = await mcpEntry().catch(() => null);
      const view = await runningNow({ exec: ctx.exec, launchd: ctx.launchd, now: ctx.now(), mcpCli: entry?.args[0] ?? null, relay: access === "relay", self: { pid: process.pid, id: deps.self ?? "mcp" } });
      return { status: 200, body: { running: view } };
    },
    /**
     * BOARD-11: "Open in the studio": PMX Engine's studio at one of its places, in this Mac's browser, which the page in
     * the Claude app can't open itself. Approving, signing off and holding stay in the studio, which asks on the Mac.
     */
    async engineOpen(place: string) {
      if (!deps.engine || ctx.personal.studio === "hidden") return { status: 404, body: { error: "PMX Engine isn't on this Mac." } };
      return deps.engine.open(place);
    },
    whatIf(kind: string, value: string) {
      const c = checkNeverIngest(kind, value);
      return whatIf(c.kind, c.value);
    },
  };
}
