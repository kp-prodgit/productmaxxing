import type { Ctx } from "../core/context.js";
import { services } from "../core/services.js";
import { decide, loadQueue, type Verdict } from "../review/queue.js";
import { approveProposals, dropProposals, setProposalTheme } from "../synth/proposals.js";
import { applyPersonal, checkChange, describe, isTeamChange, loosens, proposeTeamChanges, saveTakes } from "./actions.js";
import { checkNeverIngest, whatIf } from "./edit.js";
import { loadPipeline } from "./pipeline-load.js";
import { rememberTeamPr } from "./team-prs.js";
import { digestAction } from "./digests.js";
import { startJob } from "./jobs.js";
import { addTodo, completeTodo, placeTodo, sendTodoToLinear } from "../todo/todo.js";
import type { PipelineActions } from "./pipeline-act.js";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { plist, stableNode } from "../core/launchd.js";
import { claudeAbsolutePath } from "../core/claude-bin.js";
import { paths, pmxHome } from "../core/paths.js";

/** What `pmx flow --web` serves for the pipeline board (BOARD-3): this Mac's data, and the writes only it may make. */
/**
 * The board's handlers for a server that stays up (`pmx flow --web`): each call builds them from a fresh context, so
 * the board shows and saves the settings as they are on disk now, not as they were when the server started. A change
 * made elsewhere (the Claude app's page, `pmx todo --linear`, the collection task adding its folder) shows on the next
 * read, and the board's next save can't write an old copy back over it. The Claude app's server does the same.
 */
export async function liveHandlers(ctx: () => Promise<Ctx>): Promise<ReturnType<typeof pipelineHandlers>> {
  const first = pipelineHandlers(await ctx());
  return Object.fromEntries(Object.keys(first).map((k) => [k, async (...a: unknown[]) => (pipelineHandlers(await ctx()) as any)[k](...a)])) as unknown as ReturnType<typeof pipelineHandlers>;
}

export function pipelineHandlers(ctx: Ctx): PipelineActions & Required<Pick<PipelineActions, "todoAdd" | "todoPlace">> {
  return {
    data: (hours: number) => loadPipeline(ctx, { level: "local", hours, keychain: ctx.keychain }),
    async proposals(action: "approve" | "drop", ids: string[]) {
      if (action === "drop") {
        const r = await dropProposals(ids, ctx.now());
        return r.dropped.length ? `Dropped ${r.dropped.map((p) => `"${p.title}"`).join(", ")}.` : "Nothing to drop.";
      }
      const r = await approveProposals(ctx, await services(ctx), ids);
      const pending = r.posted.some((p) => p.identifier.startsWith("PENDING-"));
      return [r.posted.length ? `Sent ${r.posted.map((p) => p.identifier).join(", ")} to the PMX inbox${pending ? "; it reaches Linear at the next Claude sync" : ""}.` : "", ...r.duplicates.map((d) => `Not sent: ${d}.`), ...r.unthemed.map((u) => `${u}.`)].filter(Boolean).join(" ") || "Nothing to approve.";
    },
    async proposalTheme(id: string, theme: string | null) {
      try {
        const r = await setProposalTheme(ctx.personal.repoPath, [id], theme);
        if (!r.changed.length) return { status: 404, body: { error: "That proposal is no longer waiting." } };
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
          const r = await proposeTeamChanges(ctx, team);
          await rememberTeamPr({ id: r.id, url: r.url, at: ctx.now().toISOString(), changes: team.map(describe) });
          pr = { url: r.url };
          // Whoever proposes a kind of work wants their own agent to take it once it merges (JOB-8).
          const made = team.flatMap((c) => (c.kind === "new-kind" ? [c.slug] : []));
          if (made.length) await saveTakes(ctx.personal, made);
        } catch (e: any) { prError = e.message; }
      }
      return { status: 200, body: { applied, pr, prError } };
    },
    /** A draft pull request decided from the board, as `pmx review` would. */
    async review(identifier: string, verdict: string, note: string) {
      if (!["accepted", "rejected", "redo"].includes(verdict)) return { status: 400, body: { error: "verdict is accepted, rejected or redo" } };
      const svc = await services(ctx);
      // Any teammate's draft can be decided here, as `pmx review --all` can: the board lists every task in review.
      const { items, host } = await loadQueue(ctx, svc, { all: true });
      const item = items.find((x) => x.task.identifier === identifier);
      if (!item) return { status: 404, body: { error: `${identifier} isn't waiting for review any more.` } };
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
        const r = await sendTodoToLinear(ctx, (await services(ctx)).tracker, id);
        return { status: 200, body: { message: r.already ? `Already in Linear as ${r.identifier}.` : `Sent to Linear as ${r.identifier}: ${r.text}` } };
      } catch (e: any) { return { status: 400, body: { error: e.message.replace(/`([^`]+)`/g, "$1") } }; }
    },
    /** A paused category resumed from the board, as `pmx review --unpause` does (Team plan). */
    async resume(category: string) {
      if (!(category in ctx.team.categories)) return { status: 400, body: { error: "Unknown category." } };
      const { unpauseHandler } = await import("../commands/review.js");
      if (!unpauseHandler) return { status: 409, body: { error: "Resuming a paused category comes with the Team plan." } };
      try { return { status: 200, body: { message: String(await unpauseHandler(ctx, category)).replace(/`([^`]+)`/g, "$1") } }; }
      catch (e: any) { return { status: 400, body: { error: e.message } }; }
    },
    /** One-click setup from the board. "install-job" registers the background job, as `pmx init` does when you say yes. */
    async setup(action: string) {
      if (action !== "install-job") return { status: 400, body: { error: `Unknown setup step "${action}".` } };
      try {
        await mkdir(paths.logs(), { recursive: true });
        const claude = await claudeAbsolutePath(ctx.exec);
        const cli = realpathSync(process.argv[1] ?? "");
        await ctx.launchd.install(plist({ node: await stableNode(process.execPath), cli, pmxHome: pmxHome(), claude }));
        return { status: 200, body: { message: "Automatic runs are on. PMX checks every 30 minutes while this Mac is awake." } };
      } catch (e: any) { return { status: 500, body: { error: `Couldn't turn them on: ${e.message}. In Terminal, pmx init does the same.` } }; }
    },
    whatIf(kind: string, value: string) {
      const c = checkNeverIngest(kind, value);
      return whatIf(c.kind, c.value);
    },
  };
}
