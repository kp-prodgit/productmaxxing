import { RunLogStore } from "../core/runlog-store.js";
import { services } from "../core/services.js";
import { dropStopped, listStopped, retryStopped } from "../pull/stopped.js";
import { acceptStats, formatStats } from "../review/queue.js";
import { startReviewServer } from "../review/server.js";
import { NO_TERMINAL, scriptedReview, terminalReview } from "../review/tui.js";
import { exec } from "../core/exec.js";
import type { Command } from "./index.js";

/** Set by ee/ when team features are registered. */
export let unpauseHandler: ((ctx: any, category: string) => Promise<string>) | null = null;
export function setUnpauseHandler(h: typeof unpauseHandler): void {
  unpauseHandler = h;
}

export const reviewCommand: Command = {
  name: "review",
  summary: "Review drafts: accept, reject or redo with a note (terminal, --web for a local page, or --accept, --redo, --reject without a terminal); try again or drop tasks stopped after failed runs",
  usage: [
    "pmx review [--web] [--all]",
    "pmx review --accept <PMX-12 …> | --redo <PMX-12> --note \"…\" | --reject <PMX-12> --note \"…\"",
    "pmx review --stats [--days 30] | pmx review --unpause <category>",
    "pmx review --stopped | --retry <PMX-12> | --drop <PMX-12>",
    "",
    "  --accept   accept one or more drafts by their task id, without a terminal (a script, a scheduled task)",
    "  --redo     ask the agent to draft one task again; --note says what to change",
    "  --reject   reject one draft; --note says why",
    "  Each records what the terminal review records. Accepting adds the draft's follow-ups: its PM decides calls",
    "  to your to-dos, and its open questions as tasks waiting for your approval (unless your team turned that off).",
    "  Without a terminal and without these, pmx review decides nothing and exits with an error.",
  ].join("\n"),
  options: {
    web: { type: "boolean" }, all: { type: "boolean" }, stats: { type: "boolean" }, days: { type: "string" }, unpause: { type: "string" }, stopped: { type: "boolean" }, retry: { type: "string" }, drop: { type: "string" },
    accept: { type: "string", multiple: true }, redo: { type: "string" }, reject: { type: "string" }, note: { type: "string" },
  },
  async run(a) {
    const ctx = await a.ctx();
    // PULL-12: tasks PMX stopped after failed runs in a row, and what to do about each.
    if (a.values.stopped || a.values.retry || a.values.drop) {
      const svc = await services(ctx);
      if (a.values.retry) { console.log(await retryStopped(ctx, svc, a.values.retry)); return 0; }
      if (a.values.drop) { console.log(await dropStopped(ctx, svc, a.values.drop)); return 0; }
      const list = await listStopped(ctx, svc);
      if (!list.length) { console.log("No task is stopped after failed runs."); return 0; }
      console.log(`${list.length} task(s) stopped after failed runs in a row; no agent takes them until you act:`);
      for (const t of list) console.log(`  ${t.identifier} ${t.title}: ${t.runs} failed runs${t.reason ? `. ${t.reason}` : ""}${t.url ? `\n    Edit it: ${t.url}` : ""}`);
      console.log("Try one again (back to Ready, its count starts over): pmx review --retry <PMX-12> · Drop one for good: pmx review --drop <PMX-12>");
      return 0;
    }
    if (a.values.stats) {
      const store = new RunLogStore(ctx);
      const entries = (await store.exists()) ? await store.entries() : [];
      console.log(formatStats(acceptStats(entries, ctx.now(), Number(a.values.days ?? ctx.team.autoPause.windowDays))));
      return 0;
    }
    if (a.values.unpause) {
      if (!unpauseHandler) throw new Error("Auto-pause is a team feature (ee/).");
      console.log(await unpauseHandler(ctx, a.values.unpause));
      return 0;
    }
    const svc = await services(ctx);
    if (a.values.web) {
      const s = await startReviewServer(ctx, svc, { all: a.values.all });
      console.log(`Review page: ${s.url}\nPress Ctrl+C to stop.`);
      await exec("open", [s.url]);
      await new Promise<void>((resolve) => process.on("SIGINT", () => s.close().then(resolve)));
      return 0;
    }
    // F21: decisions by task id, for a script or a scheduled task. `pmx review --accept PMX-12 PMX-13` takes both.
    if (a.values.accept || a.values.redo || a.values.reject || a.values.note !== undefined) {
      const accept = a.values.accept ? [...(a.values.accept as string[]), ...a.positionals] : undefined;
      const r = await scriptedReview(ctx, svc, { accept, redo: a.values.redo, reject: a.values.reject, note: a.values.note });
      (r.code ? console.error : console.log)(r.text);
      return r.code;
    }
    // Without a terminal every prompt would take its default, "skip", and nothing would be decided.
    if (!(a.tty ?? !!process.stdin.isTTY)) {
      console.error(NO_TERMINAL);
      return 1;
    }
    console.log(await terminalReview(ctx, svc, a.ask, { all: a.values.all }));
    return 0;
  },
};
