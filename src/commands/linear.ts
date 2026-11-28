import { DEFAULT_TASK_HOURS, formatTasks, LINEAR_SYNC_TASK, outsideHours, setTaskHours, taskDue, TASK_HOURS, tasksJson, type TaskHours } from "../claude/tasks.js";
import { boardJson, checkBoard, formatBoard, renderBoard, setBoardUrl, boardUrl } from "../claude/board.js";
import { appSkillInstalled, appSkillTarget, BOARD_SKILL, installAppSkill } from "../claude/skill.js";
import { addAllowRules, claudeSettingsFile } from "../claude/permissions.js";
import { exec } from "../core/exec.js";
import { macKeychain } from "../core/keychain.js";
import { markTaskRun } from "../core/state.js";
import { choseClaudeApp, linearAccess, rememberClaudeApp } from "../linear/access.js";
import { directHealth } from "../linear/direct.js";
import { adoptKey, checkLinearKey, directFor, drainOutbox, keyHelp, KEY_QUESTION, leftoverTaskOnce, removeKey, rollupTeams } from "../linear/switch.js";
import { linearLogin, linearLogout, readGrant } from "../linear/oauth.js";
import { removePackNow, shareEvidence, unstageShares } from "../run/share.js";
import { giveBackTodos } from "../todo/move.js";
import { checkRelay, closeRelayRun, dropOps, formatOutbox, opWords, pendingIdentifier, readOutbox, readSnapshot, relayPrompt, relayRunUnderWay, relayTracker, resultsWaiting, takeResults } from "../tracker/relay.js";
import type { TickStep } from "./tick.js";
import { assertTeamVersion } from "../core/version.js";
import { markTask, tendMarks } from "../lease/marks.js";
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
  if (access === "key") return (await directHealth(ctx.team, ctx.now(), { waiting: (await readOutbox()).ops.length })).detail.replace(/^Linear with your API key: /, "with your API key (in this Mac's keychain): ");
  if (access === "signed-in") {
    const g = await readGrant(ctx.keychain);
    return `signed in to Linear${g?.user ? ` as ${g.user}` : ""}${g ? ` (renews itself; access valid to ${g.expiresAt.slice(0, 16).replace("T", " ")})` : ""}`;
  }
  if (access === "hosted") return "through the hosted app's Linear connection";
  const snap = await readSnapshot();
  const pending = (await readOutbox()).ops.length;
  return `through your Claude app: ${snap ? `last synced ${snap.syncedAt}` : "not synced yet"}, ${pending} change(s) waiting for the next sync${(await choseClaudeApp()) ? "" : ". PMX's usual way is your own Linear API key, which syncs with every background run: pmx linear key"}`;
}

/** What a Linear sync task still in the Claude app is told once this Mac has its own key: nothing to do, and safe to remove. */
export const RELAY_NOT_NEEDED = `PMX: this Mac reaches Linear with its own API key now, and syncs with every background run, so this task has nothing to do. Stop here: report "PMX syncs Linear itself now; this task is no longer needed and is safe to delete." and do nothing else. Don't use the Linear connector, and don't write any file.`;

/**
 * LINEAR-2 (0.41.0): the background run's own Linear step, on a Mac with a key. One read (what changed since the last
 * run, or the day's first whole read), which also keeps PMX's copy for its page; then anything still queued from the
 * Claude app's sync, sent directly. A key Linear rejects, or its rate limit, is thrown to the run, which says it once.
 */
export const linearStep: TickStep = async (ctx) => {
  if ((await linearAccess(ctx.team, ctx.keychain)) !== "key") return null;
  const key = await ctx.keychain.get("linear-token");
  if (!key) return null;
  const t = directFor(ctx, key);
  await t.list();
  const said: string[] = [];
  if ((await readOutbox()).ops.length && !(await relayRunUnderWay(ctx.now()))) {
    // Shared team work, like every write to the tracker (COMPAT-2).
    assertTeamVersion(ctx.team);
    said.push(...(await drainOutbox(ctx, t)).lines);
  }
  const left = await leftoverTaskOnce(ctx.now());
  if (left) said.push(left);
  return said.join(" ") || null;
};

export const linearCommands: Command[] = [
  {
    name: "linear",
    summary: "How PMX reaches Linear: with your own Linear API key by default, or through your Claude app's Linear connector",
    usage: "pmx linear status | pmx linear key (paste or replace your Linear API key; it says where to create one) | pmx linear key --remove (back to the Claude app's sync) | pmx linear written [--json] | pmx linear tidy [--yes] | pmx linear withdraw <PMX-12 …> [--yes] | pmx linear outbox [drop <ID …>] | pmx linear relay --prompt | --check",
    options: { prompt: { type: "boolean" }, check: { type: "boolean" }, json: { type: "boolean" }, yes: { type: "boolean", short: "y" }, remove: { type: "boolean" } },
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
      // LINEAR-2 (0.41.0): the key is the default way to Linear. Pasted here and only here, checked before it's saved,
      // kept in the keychain; a Mac that was on the Claude app's sync is moved over with nothing lost.
      if (sub === "key") {
        const ctx = await a.ctx();
        if (ctx.team.tracker.kind !== "linear") throw new Error("Your team has no Linear project in pmx.config.json, so there's nothing for a key to reach.");
        if (a.values.remove) { console.log((await removeKey(ctx)).join("\n")); return 0; }
        const had = !!(await ctx.keychain.get("linear-token"));
        const rollup = rollupTeams(ctx.team, { handle: ctx.personal.handle, agent: ctx.agent });
        console.log(keyHelp(ctx.team, { rollup }).join("\n"));
        if (had) console.log("  A key is stored already: paste another to replace it, or press Return to keep it. To go back to the Claude app's sync: pmx linear key --remove.");
        const v = (await a.ask.secret(had ? "Linear API key (Return to keep the one stored)" : KEY_QUESTION)).trim();
        if (!v) {
          if (had) { console.log("Nothing changed: the key in the keychain stays."); return 0; }
          await rememberClaudeApp(ctx.now());
          console.log("No key saved. PMX reaches Linear through your Claude app's Linear connector, once an hour, and won't ask again. To use a key later: pmx linear key.");
          return 0;
        }
        const check = await checkLinearKey(ctx, v, { rollup });
        console.log(check.lines.join("\n"));
        if (!check.ok) return 1;
        const r = await adoptKey(ctx, v);
        console.log(r.lines.join("\n"));
        // RUN-5, PULL-14: tasks that just got their identifiers can have their quotes shared, and this Mac's steps landed.
        if (r.drained?.applied) {
          const key = await ctx.keychain.get("linear-token");
          if (key) await tendMarks(ctx, directFor(ctx, key)).catch(() => 0);
          const shared = await shareEvidence(ctx, { say: "answer" }).catch(() => null);
          for (const n of shared?.notices ?? []) console.log(n);
        }
        return 0;
      }
      // R16b: what waits for the Claude sync, what Linear refused, and dropping one before it reaches Linear.
      if (sub === "outbox") {
        if (!a.positionals[1]) {
          const c = await a.ctx().catch(() => null);
          console.log(await formatOutbox({ direct: !!c && (await linearAccess(c.team, c.keychain).catch(() => "none")) === "key" }));
          return 0;
        }
        if (a.positionals[1] !== "drop") throw new Error("Use pmx linear outbox, or pmx linear outbox drop <ID …>.");
        const ids = a.positionals.slice(2);
        if (!ids.length) throw new Error("Say which: pmx linear outbox drop <ID>, from `pmx linear outbox`.");
        const r = await dropOps(ids);
        // RUN-5: a dropped task never gets an identifier, so the share staged to wait for one goes too.
        await unstageShares(r.dropped.filter((op) => op.kind === "create-task").map((op) => pendingIdentifier(op.id)));
        for (const op of r.dropped) console.log(`- dropped ${opWords(op)}`);
        for (const m of r.missing) console.log(`· no waiting change ${m}`);
        if (r.dropped.length) console.log("Nothing of these reaches Linear.");
        // R16b: a dropped task a to-do became gives the to-do back, as it was.
        for (const t of await giveBackTodos(r.dropped)) console.log(`"${t.text}" is your private to-do again.`);
        return r.missing.length ? 1 : 0;
      }
      const ctx = await a.ctx();
      if (sub === "relay") {
        // LINEAR-2 (0.41.0): with a key this Mac syncs Linear itself. A sync task left in the Claude app does nothing:
        // its first step says so, and its last only takes in what a run that began before the key had already applied.
        if ((await linearAccess(ctx.team, ctx.keychain)) === "key" && (a.values.check || a.values.prompt)) {
          if (a.values.check && (await resultsWaiting())) {
            console.log((await takeResults(ctx.now())).out.join("\n"));
            await closeRelayRun();
            const shared = await shareEvidence(ctx, { say: "notify" }).catch(() => null);
            for (const n of shared?.notices ?? []) console.log(n);
          }
          console.log(RELAY_NOT_NEEDED);
          if (a.values.prompt) await markTaskRun(LINEAR_SYNC_TASK.id, "start", ctx.now());
          await markTaskRun(LINEAR_SYNC_TASK.id, "finish", ctx.now());
          return 0;
        }
        if (a.values.check) {
          console.log((await checkRelay(ctx.team, ctx.now())).join("\n"));
          // PULL-14: this Mac's steps the sync just applied in Linear have landed, so other Macs' copies can show them.
          if (ctx.team.tracker.kind === "linear") await tendMarks(ctx, relayTracker(ctx.team, () => {}, ctx.now)).catch(() => 0);
          // RUN-5: a task approved since the last sync now has its identifier, so its quotes can reach the team repo.
          // Nothing to say when they did; a failure is said once (and notified once).
          const shared = await shareEvidence(ctx, { say: "notify" }).catch(() => null);
          for (const n of shared?.notices ?? []) console.log(n);
          await markTaskRun(LINEAR_SYNC_TASK.id, "finish", ctx.now());
          return 0;
        }
        if (a.values.prompt) {
          // CLAUDE-6: the app starts the sync every hour; for a PM on working hours only, a run outside them stops here,
          // and counts as run.
          const due = taskDue(LINEAR_SYNC_TASK, ctx.personal.taskHours, ctx.now());
          if (!due.due) {
            console.log(outsideHours(due.why));
            await markTaskRun(LINEAR_SYNC_TASK.id, "start", ctx.now());
            await markTaskRun(LINEAR_SYNC_TASK.id, "finish", ctx.now());
            return 0;
          }
          console.log(await relayPrompt(ctx.team, ctx.now()));
          await markTaskRun(LINEAR_SYNC_TASK.id, "start", ctx.now());
          return 0;
        }
        console.log("The Claude app's Linear sync runs from a scheduled task in your Claude app, for a Mac without its own Linear API key. See which tasks this machine needs with `pmx schedule`.");
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
          for (const w of hit) {
            await svc.tracker.rewrite(w.id, { description: WITHDRAWN, cancel: true });
            // PULL-14: a Mac whose copy of Linear still shows it Ready doesn't draft it. RUN-5: canceled, so a share still
            // staged for it never goes, and its shared quotes leave the team repo now, as the clean-up would remove them.
            if (w.kind !== "meeting") {
              await markTask(ctx, svc.tracker, w.identifier, "dropped");
              await unstageShares([w.identifier]);
              await removePackNow(ctx, svc.tracker, w.identifier, "dropped");
            }
          }
        }
        console.log(svc.tracker.kind === "claude-relay" ? "Queued. The next \"PMX: sync Linear through Claude\" run applies it in Linear." : "Done in Linear.");
        return 0;
      }
      throw new Error(`Unknown subcommand "${sub}". Use status, written, tidy, withdraw, outbox, relay or key.`);
    },
  },
  {
    name: "schedule",
    summary: "The scheduled tasks PMX needs in your Claude app and whether each exists; type /pmx-schedule in the Claude app to create them",
    usage: "pmx schedule [--json] | pmx schedule --hours always|weekdays | pmx schedule --install-skill | pmx schedule --allow",
    options: { json: { type: "boolean" }, "install-skill": { type: "boolean" }, allow: { type: "boolean" }, hours: { type: "string" } },
    async run(a) {
      // CLAUDE-6: when PMX's Claude tasks do their work on this Mac: around the clock (the default from 0.41.0) or in
      // working hours only. A PMX setting from 0.36.0: each run asks PMX first.
      if (a.values.hours !== undefined) {
        const hours = String(a.values.hours).toLowerCase() as TaskHours;
        if (!TASK_HOURS.includes(hours)) throw new Error(`--hours takes ${TASK_HOURS.join(" or ")}.`);
        const ctx = await a.ctx();
        const direct = (await linearAccess(ctx.team, ctx.keychain)) === "key";
        console.log(await setTaskHours(ctx.personal, hours, { direct }));
        if (hours === "always") { if (!direct && ctx.team.tracker.kind === "linear" && !(await choseClaudeApp())) console.log("With your own Linear API key PMX syncs Linear itself with every background run, and no Claude task is in between: pmx linear key."); }
        else console.log("To go back to around the clock, PMX's usual setting: pmx schedule --hours always");
        console.log("");
        console.log(await formatTasks(ctx.team, ctx.keychain, hours));
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
      const hours = ctx?.personal.taskHours ?? DEFAULT_TASK_HOURS;
      console.log(a.values.json ? JSON.stringify(await tasksJson(ctx?.team ?? null, ctx?.keychain ?? macKeychain()), null, 2) : await formatTasks(ctx?.team ?? null, ctx?.keychain ?? macKeychain(), hours));
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
