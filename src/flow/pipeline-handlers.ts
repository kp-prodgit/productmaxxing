import type { Ctx } from "../core/context.js";
import { services } from "../core/services.js";
import { decide, loadQueue, type Verdict } from "../review/queue.js";
import { approveProposals, dropProposals } from "../synth/proposals.js";
import { applyPersonal, checkChange, describe, isTeamChange, loosens, proposeTeamChanges } from "./actions.js";
import { checkNeverIngest, whatIf } from "./edit.js";
import { loadPipeline } from "./pipeline-load.js";
import { rememberTeamPr } from "./team-prs.js";
import { digestAction } from "./digests.js";
import { startJob } from "./jobs.js";
import { completeTodo } from "../todo/todo.js";
import { mkdir } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { plist, stableNode } from "../core/launchd.js";
import { claudeAbsolutePath } from "../core/claude-bin.js";
import { paths, pmxHome } from "../core/paths.js";

/** What `pmx flow --web` serves for the pipeline board (BOARD-3): this Mac's data, and the writes only it may make. */
export function pipelineHandlers(ctx: Ctx) {
  return {
    data: (hours: number) => loadPipeline(ctx, { level: "local", hours, keychain: ctx.keychain }),
    async proposals(action: "approve" | "drop", ids: string[]) {
      if (action === "drop") {
        const r = await dropProposals(ids, ctx.now());
        return r.dropped.length ? `Dropped ${r.dropped.map((p) => `"${p.title}"`).join(", ")}.` : "Nothing to drop.";
      }
      const r = await approveProposals(ctx, await services(ctx), ids);
      const pending = r.posted.some((p) => p.identifier.startsWith("PENDING-"));
      return [r.posted.length ? `Sent ${r.posted.map((p) => p.identifier).join(", ")} to the PMX inbox${pending ? "; it reaches Linear at the next Claude sync" : ""}.` : "", ...r.duplicates.map((d) => `Not sent: ${d}.`)].filter(Boolean).join(" ") || "Nothing to approve.";
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
