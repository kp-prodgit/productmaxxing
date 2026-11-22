import { formatTasks, LINEAR_SYNC_TASK, outsideHours, setTaskHours, taskDue, TASK_HOURS, tasksJson, type TaskHours } from "../claude/tasks.js";
import { boardJson, checkBoard, formatBoard, renderBoard, setBoardUrl, boardUrl } from "../claude/board.js";
import { appSkillInstalled, appSkillTarget, BOARD_SKILL, installAppSkill } from "../claude/skill.js";
import { addAllowRules, claudeSettingsFile } from "../claude/permissions.js";
import { exec } from "../core/exec.js";
import { macKeychain } from "../core/keychain.js";
import { markTaskRun } from "../core/state.js";
import { linearAccess } from "../linear/access.js";
import { linearLogin, linearLogout, readGrant } from "../linear/oauth.js";
import { checkRelay, readOutbox, readSnapshot, relayPrompt } from "../tracker/relay.js";
import type { Command } from "./index.js";
import { services } from "../core/services.js";
import { WITHDRAWN, writtenByPmx } from "../tracker/tidy.js";

async function openUrl(url: string) {
  await exec("open", [url]);
  console.log(`If your browser didn't open, go to:\n${url}`);
}

/** How this machine reaches Linear, in words (LINEAR-1, LINEAR-2). */
export async function linearMode(ctx: import("../core/context.js").Ctx): Promise<string> {
  const access = await linearAccess(ctx.team, ctx.keychain);
  if (access === "none") return "no Linear project in pmx.config.json";
  if (access === "key") return "Linear API key in the keychain";
  if (access === "signed-in") {
    const g = await readGrant(ctx.keychain);
    return `signed in to Linear${g?.user ? ` as ${g.user}` : ""}${g ? ` (renews itself; access valid to ${g.expiresAt.slice(0, 16).replace("T", " ")})` : ""}`;
  }
  if (access === "hosted") return "through the hosted app's Linear connection";
  const snap = await readSnapshot();
  const pending = (await readOutbox()).ops.length;
  return `through your Claude app: ${snap ? `last synced ${snap.syncedAt}` : "not synced yet"}, ${pending} change(s) waiting for the next sync`;
}

export const linearCommands: Command[] = [
  {
    name: "linear",
    summary: "How PMX reaches Linear: through your Claude app's Linear connector (no key or sign-in) by default",
    usage: "pmx linear status | pmx linear written [--json] | pmx linear tidy [--yes] | pmx linear withdraw <PMX-12 …> [--yes] | pmx linear relay --prompt | --check | pmx linear key (advanced: store a Linear API key)",
    options: { prompt: { type: "boolean" }, check: { type: "boolean" }, json: { type: "boolean" }, yes: { type: "boolean", short: "y" } },
    async run(a) {
      const sub = a.positionals[0] ?? "status";
      if (sub === "login") {
        const g = await linearLogin({ keychain: macKeychain(), open: openUrl });
        console.log(`Signed in to Linear${g.user ? ` as ${g.user}` : ""}. PMX now talks to Linear directly; access renews itself.`);
        return 0;
      }
      if (sub === "logout") {
        console.log((await linearLogout(macKeychain())) ? "Signed out of Linear and revoked PMX's access." : "Not signed in to Linear.");
        return 0;
      }
      if (sub === "key") {
        const v = (await a.ask.secret("Linear API key with access to the PMX project (blank to cancel)")).trim();
        if (!v) return 0;
        await macKeychain().set("linear-token", v);
        console.log("Saved the Linear API key in the keychain. PMX now talks to Linear directly; the Claude sync task is no longer needed on this Mac.");
        return 0;
      }
      const ctx = await a.ctx();
      if (sub === "relay") {
        if (a.values.check) {
          console.log((await checkRelay(ctx.team, ctx.now())).join("\n"));
          await markTaskRun(LINEAR_SYNC_TASK.id, "finish", ctx.now());
          return 0;
        }
        if (a.values.prompt) {
          // CLAUDE-6: the app starts the sync every hour; outside the PM's hours its run stops here, and counts as run.
          const due = taskDue(LINEAR_SYNC_TASK, ctx.personal.taskHours, ctx.now());
          if (!due.due) {
            console.log(outsideHours(due.why));
            await markTaskRun(LINEAR_SYNC_TASK.id, "start", ctx.now());
            await markTaskRun(LINEAR_SYNC_TASK.id, "finish", ctx.now());
            return 0;
          }
          console.log(await relayPrompt(ctx.team));
          await markTaskRun(LINEAR_SYNC_TASK.id, "start", ctx.now());
          return 0;
        }
        console.log("The Claude relay runs from a scheduled task in your Claude app. See which tasks this machine needs with `pmx schedule`.");
        return 0;
      }
      if (sub === "status") {
        console.log(`Linear: ${await linearMode(ctx)}`);
        return 0;
      }
      // TIDY-1: what PMX wrote, and taking it back. Never deletes; the PM confirms each batch.
      if (sub === "written" || sub === "tidy" || sub === "withdraw") {
        const svc = await services(ctx);
        const all = await writtenByPmx(svc.tracker);
        if (sub === "written") {
          if (a.values.json) console.log(JSON.stringify(all.map(({ fix: _f, ...w }) => w), null, 2));
          else {
            console.log(all.length ? `PMX wrote ${all.length} item(s) in the PMX project:` : "PMX hasn't written anything to the PMX project.");
            for (const w of all) console.log(`${w.problems.length ? "!" : "·"} ${w.identifier} ${w.kind === "meeting" ? "(processed-meeting marker) " : ""}${w.title}${w.problems.length ? `: ${w.problems.join("; ")}` : ""}`);
            if (all.some((w) => w.problems.length)) console.log("\nRewrite the flagged ones to what PMX writes now: pmx linear tidy. Take a task back entirely: pmx linear withdraw <identifier>.");
          }
          return 0;
        }
        if (sub === "tidy") {
          const todo = all.filter((w) => w.fix);
          if (!todo.length) { console.log("Nothing to tidy: everything PMX wrote is in today's form."); return 0; }
          console.log(`PMX will rewrite ${todo.length} item(s): task descriptions lose their meeting excerpts, and processed-meeting markers get an opaque title and no meeting details.`);
          for (const w of todo) console.log(`  ${w.identifier} ${w.title}${w.fix!.title ? ` → ${w.fix!.title}` : ""}`);
          if (!a.values.yes && !(await a.ask.confirm("Rewrite them?", false))) { console.log("Nothing changed."); return 0; }
          for (const w of todo) await svc.tracker.rewrite(w.id, w.fix!);
        } else {
          const refs = a.positionals.slice(1).map((r) => r.toUpperCase());
          if (!refs.length) throw new Error("Say which tasks: pmx linear withdraw PMX-12 PMX-13.");
          const hit = all.filter((w) => refs.includes(w.identifier.toUpperCase()));
          const missing = refs.filter((r) => !hit.some((w) => w.identifier.toUpperCase() === r));
          if (missing.length) throw new Error(`Not something PMX wrote in the PMX project: ${missing.join(", ")}. See them with \`pmx linear written\`.`);
          console.log(`PMX will move ${hit.map((w) => w.identifier).join(", ")} to canceled and replace each description with a short note. Nothing is deleted.`);
          if (!a.values.yes && !(await a.ask.confirm("Withdraw them?", false))) { console.log("Nothing changed."); return 0; }
          for (const w of hit) await svc.tracker.rewrite(w.id, { description: WITHDRAWN, cancel: true });
        }
        console.log(svc.tracker.kind === "claude-relay" ? "Queued. The next \"PMX: sync Linear through Claude\" run applies it in Linear." : "Done in Linear.");
        return 0;
      }
      throw new Error(`Unknown subcommand "${sub}". Use status, written, tidy, withdraw, relay or key.`);
    },
  },
  {
    name: "schedule",
    summary: "The scheduled tasks PMX needs in your Claude app and whether each exists; type /pmx-schedule in the Claude app to create them",
    usage: "pmx schedule [--json] | pmx schedule --hours weekdays|always | pmx schedule --install-skill | pmx schedule --allow",
    options: { json: { type: "boolean" }, "install-skill": { type: "boolean" }, allow: { type: "boolean" }, hours: { type: "string" } },
    async run(a) {
      // CLAUDE-6: when PMX's Claude tasks do their work on this Mac. A PMX setting from 0.36.0: each run asks PMX first.
      if (a.values.hours !== undefined) {
        const hours = String(a.values.hours).toLowerCase() as TaskHours;
        if (!TASK_HOURS.includes(hours)) throw new Error(`--hours takes ${TASK_HOURS.join(" or ")}.`);
        const ctx = await a.ctx();
        console.log(await setTaskHours(ctx.personal, hours));
        if (hours === "always") console.log("For agents that run unattended, `pmx linear key` lets PMX reach Linear directly, with no Claude task in between.");
        console.log("");
        console.log(await formatTasks(ctx.team, macKeychain(), hours));
        return 0;
      }
      if (a.values.allow) {
        const r = await addAllowRules();
        if (r.error) throw new Error(r.error);
        console.log(r.added.length
          ? `Added to ${claudeSettingsFile()}: ${r.added.join(", ")}. PMX's scheduled runs no longer stop to ask before running pmx or touching ~/.pmx.`
          : `${claudeSettingsFile()} already allows PMX's command and folder.`);
        return 0;
      }
      if (a.values["install-skill"]) {
        const r = await installAppSkill();
        console.log(r === "kept-yours"
          ? `${appSkillTarget()} exists and wasn't written by PMX, so it was left alone.`
          : `${r === "current" ? "Already up to date" : r === "updated" ? "Updated" : "Installed"}: type /pmx-schedule in the Claude app to create PMX's scheduled tasks.`);
        return r === "kept-yours" ? 1 : 0;
      }
      const ctx = await a.ctx().catch(() => null);
      const hours = ctx?.personal.taskHours ?? "weekdays";
      console.log(a.values.json ? JSON.stringify(await tasksJson(ctx?.team ?? null, macKeychain()), null, 2) : await formatTasks(ctx?.team ?? null, macKeychain(), hours));
      return 0;
    },
  },
  {
    name: "board",
    summary: "The team board as a live Claude artifact, read through each viewer's Linear connector; type /pmx-board in the Claude app to publish it",
    usage: "pmx board [--open] | pmx board --json | pmx board --html | pmx board --set-url <link> | pmx board --install-skill",
    options: { json: { type: "boolean" }, html: { type: "boolean" }, open: { type: "boolean" }, "set-url": { type: "string" }, "install-skill": { type: "boolean" } },
    async run(a) {
      if (a.values["install-skill"]) {
        const r = await installAppSkill(BOARD_SKILL);
        console.log(r === "kept-yours"
          ? `${appSkillTarget(BOARD_SKILL)} exists and wasn't written by PMX, so it was left alone.`
          : `${r === "current" ? "Already up to date" : r === "updated" ? "Updated" : "Installed"}: type /pmx-board in the Claude app to publish the team board.`);
        return r === "kept-yours" ? 1 : 0;
      }
      const ctx = await a.ctx();
      if (a.values.json) {
        console.log(JSON.stringify(await boardJson(ctx.team, ctx.personal), null, 2));
        return 0;
      }
      if (a.values["set-url"]) {
        await setBoardUrl(ctx.personal, String(a.values["set-url"]), ctx.now());
        console.log(`Saved. \`pmx board --open\` and \`pmx canvas\` now open ${ctx.personal.board!.url}.`);
        return 0;
      }
      const e = await checkBoard(ctx.team);
      if (a.values.html) {
        if (!e.ok) throw new Error(e.reason);
        console.log(await renderBoard(ctx.team));
        return 0;
      }
      const existing = boardUrl(ctx.team, ctx.personal);
      if (a.values.open && existing) {
        await openUrl(existing.url);
        return 0;
      }
      console.log(formatBoard(ctx.team, ctx.personal, e, await appSkillInstalled(BOARD_SKILL)));
      return 0;
    },
  },
];
