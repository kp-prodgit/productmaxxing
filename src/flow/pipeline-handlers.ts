import type { Ctx } from "../core/context.js";
import { services } from "../core/services.js";
import { decide, loadQueue, type Verdict } from "../review/queue.js";
import { approveProposals, dropProposals } from "../synth/proposals.js";
import { applyPersonal, checkChange, describe, isTeamChange, loosens, proposeTeamChanges } from "./actions.js";
import { checkNeverIngest, whatIf } from "./edit.js";
import { loadPipeline } from "./pipeline-load.js";
import { rememberTeamPr } from "./team-prs.js";

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
      const loose = list.filter((c) => loosens(c, ctx.personal));
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
      const { items, host } = await loadQueue(ctx, svc);
      const item = items.find((x) => x.task.identifier === identifier);
      if (!item) return { status: 404, body: { error: `${identifier} isn't waiting for review any more.` } };
      try { return { status: 200, body: { message: await decide(ctx, svc, host, item, verdict as Verdict, { note }) } }; }
      catch (e: any) { return { status: 400, body: { error: e.message } }; }
    },
    whatIf(kind: string, value: string) {
      const c = checkNeverIngest(kind, value);
      return whatIf(c.kind, c.value);
    },
  };
}
