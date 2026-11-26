import { readFile } from "node:fs/promises";
import { writeJson } from "../core/fsutil.js";
import type { Ctx } from "../core/context.js";
import { Git } from "../core/git.js";
import { RunLogStore } from "../core/runlog-store.js";
import { services, type Services } from "../core/services.js";
import { loadState } from "../core/state.js";
import { claim, isDryRunDefault, pull, releaseStale } from "../pull/pull.js";
import { compareReports, neutralityRun, type NeutralityReport } from "../run/neutrality.js";
import { runTask } from "../run/run.js";
import { verifyPr } from "../run/verify.js";
import { synthesize } from "../synth/synthesize.js";
import { heldOverLine, kindLine } from "../synth/held-over.js";
import { evidenceOf } from "../synth/evidence.js";
import { approvedText, approveProposals, dropProposals, formatProposals, readProposals, setProposalTheme } from "../synth/proposals.js";
import { startsNow } from "../core/config.js";
import { startOfDay } from "../meetings/ledger.js";
import { formatSynthStatus, recentReceipts, synthesizesHere, synthStatus, synthWindow } from "../synth/status.js";
import type { Command } from "./index.js";
import type { TickStep } from "./tick.js";
import { evidenceStep } from "../run/share.js";
import { tendMarks } from "../lease/marks.js";
import { followMoves } from "../tracker/follow.js";

async function findTask(svc: Services, ref: string) {
  const all = await svc.tracker.list();
  const t = all.find((x) => x.id === ref || x.identifier.toLowerCase() === ref.toLowerCase());
  if (!t) throw new Error(`No task ${ref} in the PMX project.`);
  return t;
}

export const teamCommands: Command[] = [
  {
    // Bridge 2 of joining PMX and PMX Engine: counts only, to standard output. The head of product pipes them on.
    name: "evidence",
    summary: "Counts of approved tasks per kind of work and roadmap theme, for PMX Engine's studio: no titles, quotes or meetings",
    usage: "pmx evidence --json | pmxe propose -",
    options: { json: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const e = evidenceOf(await (await services(ctx)).tracker.list(), ctx.team.team, ctx.now());
      if (a.values.json) { console.log(JSON.stringify(e, null, 2)); return 0; }
      if (!e.rows.length) console.log("No approved tasks yet.");
      for (const r of e.rows) console.log(`${r.by === "theme" ? "theme" : "category"}  ${r.label}: ${r.tasks} tasks, ${r.sources} sources, ${r.first} to ${r.last}`);
      if (e.rows.length) console.log("\nTo bring these into PMX Engine's studio, where you map each to a roadmap theme: pmx evidence --json | pmxe propose -");
      return 0;
    },
  },
  {
    name: "synthesize",
    summary: "Turn customer calls into new tasks; you approve each one before it reaches Linear (`pmx proposals`)",
    usage: "pmx synthesize [--since today | YYYY-MM-DD] [--days N] [--dry-run]  (by default it reads what the background job would: since a day before the last run, or 14 days the first time)",
    options: { days: { type: "string" }, since: { type: "string" }, "dry-run": { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      // N3: by hand, the same window as the background job (MEET-3, SIG-6); `--since` still picks one.
      const w = a.values.since === undefined ? synthWindow((await loadState()).lastSynthAt, ctx.now()) : null;
      const since = w?.since ?? sinceDate(a.values.since, ctx.now());
      const days = Math.max(Number(a.values.days ?? 1), w?.days ?? 0, Math.ceil((ctx.now().getTime() - since.getTime()) / 86400000) + 1);
      const r = await synthesize(ctx, await services(ctx), { days, since, dryRun: a.values["dry-run"] });
      // A kept task that lost a sentence is kept, and says so; `pmx explain` shows the sentence's words.
      const cut = (n?: number) => (n ? ` (${n} ${n === 1 ? "sentence" : "sentences"} left out)` : "");
      for (const p of r.posted) console.log(`+ ${p.identifier} ${p.title}${cut(p.leftOut)}`);
      for (const p of r.staged) console.log(`? [${p.id}] ${p.title}${cut(p.leftOut)}`);
      for (const s of r.skipped) console.log(`· skipped ${s}`);
      const m = r.meetings;
      console.log(`Meetings since ${since.toDateString()}: ${m.processed.length} processed now (recorded in your PMX repo, not Linear), ${m.already} already processed by the team, ${m.busy} being processed on another machine.`);
      console.log(a.values["dry-run"]
        ? `Dry run: ${r.posted.length} task(s) would be suggested; nothing was. ${r.held} item(s) or passage(s) left out or cut.`
        : `${r.staged.length} new task(s) waiting for you; nothing was written to Linear. ${r.held} item(s) or passage(s) left out or cut.\nSee exactly what Linear would get, then approve or drop each: pmx proposals`);
      // SIG-9: needs past the team's task limit wait on this Mac for the next run.
      const more = heldOverLine(r.heldOver);
      if (more) console.log(a.values["dry-run"] ? `${more.replace(/ back in the next run\.$/, " back in the next run")} (a real run would keep them; synthesis.maxTasks is ${ctx.team.synthesis?.maxTasks ?? 15}).` : `${more} Your team's limit is ${ctx.team.synthesis?.maxTasks ?? 15} tasks a run (synthesis.maxTasks).`);
      // N1: suggestions of one of PMX's kinds your team hasn't turned on wait on this Mac until it does.
      for (const k of r.waiting ?? []) console.log(`${kindLine(k)}. They wait on this Mac until your team turns it on, then come back in the next run. Send it to your team for approval: pmx jobs add ${k.kind}`);
      console.log("See why each was suggested and sized: pmx explain (or pmx explain --web)");
      return 0;
    },
  },
  {
    name: "proposals",
    summary: "Tasks PMX suggested from your calls, exactly as Linear would get them: start, approve or drop each (nothing reaches Linear before you do)",
    usage: "pmx proposals [--brief] [--json] | pmx proposals start <number or ID …> | --all | pmx proposals approve <number or ID …> | --all | pmx proposals drop <number or ID …> | --all | pmx proposals theme <number or ID> \"<roadmap theme>\" | none",
    options: { all: { type: "boolean" }, brief: { type: "boolean" }, json: { type: "boolean" } },
    async run(a) {
      const sub = a.positionals[0] ?? "list";
      const refs = [...a.positionals.slice(1), ...(a.values.all ? ["all"] : [])];
      if (sub === "list") {
        const list = await readProposals();
        if (!list.length && !a.values.json) {
          // SIG-6: say why nothing is waiting, not just that nothing is.
          const ctx = await a.ctx();
          const st = await synthStatus(ctx, { local: true, receipts: await recentReceipts(), automatic: !!(await ctx.launchd.installed().catch(() => null)), lastSynthAt: (await loadState()).lastSynthAt });
          console.log(formatSynthStatus(st, ctx.now()));
          return 0;
        }
        console.log(a.values.json ? JSON.stringify(list, null, 2) : formatProposals(list, !a.values.brief, startsNow((await a.ctx()).team)));
        return 0;
      }
      if (sub === "theme") {
        // EQ-38: the PM sets, changes or clears the roadmap theme a task will carry as a pmx-theme label.
        const [ref, ...name] = a.positionals.slice(1);
        if (!ref || !name.length) throw new Error('Say which task and which theme: pmx proposals theme 1 "Field capture", or none to clear it.');
        const ctx = await a.ctx();
        const wanted = name.join(" ");
        const r = await setProposalTheme(ctx.personal.repoPath, [ref], /^none$/i.test(wanted) ? null : wanted);
        for (const p of r.changed) console.log(r.theme ? `${p.title}: theme ${r.theme}` : `${p.title}: no theme`);
        for (const m of r.missing) console.log(`· no waiting task ${m}`);
        return r.missing.length ? 1 : 0;
      }
      if (sub !== "approve" && sub !== "start" && sub !== "drop") throw new Error(`Unknown subcommand "${sub}". Use start, approve, drop or theme.`);
      if (!refs.length) throw new Error(`Say which: pmx proposals ${sub} 1 2, an ID like p1a2b3c, or --all.`);
      const ctx = await a.ctx();
      if (sub === "drop") {
        const r = await dropProposals(refs, ctx.now());
        for (const p of r.dropped) console.log(`- dropped ${p.title}`);
        for (const m of r.missing) console.log(`· no waiting task ${m}`);
        return r.missing.length ? 1 : 0;
      }
      const start = sub === "start";
      const r = await approveProposals(ctx, await services(ctx), refs, { start });
      for (const p of r.posted) console.log(`+ ${p.identifier} ${p.title}${p.theme ? ` (theme ${p.theme})` : ""}`);
      for (const d of r.duplicates) console.log(`· not posted: ${d}`);
      for (const u of r.unthemed) console.log(`· ${u}`);
      for (const m of r.missing) console.log(`· no waiting task ${m}`);
      // APPROVE-1, APPROVE-3: say when the task reaches agents: now (Start now), or once someone moves it to Ready.
      if (r.posted.length) console.log(approvedText(r.posted, { start, startNow: startsNow(ctx.team) }));
      // RUN-5: nothing to say when the quotes reached the team; once, when they couldn't.
      for (const n of r.notShared) console.log(n);
      return r.missing.length ? 1 : 0;
    },
  },
  {
    name: "pull",
    summary: "Claim and run the highest-value ready task that fits (dry run the first week)",
    usage: "pmx pull [--dry-run | --live]",
    options: { "dry-run": { type: "boolean" }, live: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const dryRun = a.values["dry-run"] ?? (a.values.live ? false : isDryRunDefault(ctx));
      if (dryRun && !a.values["dry-run"]) console.log("First week after install: dry run. Use --live to run for real.\n");
      console.log((await pull(ctx, await services(ctx), { dryRun })).text);
      return 0;
    },
  },
  {
    name: "claim",
    summary: "Claim a specific ready task for your agent and run it",
    usage: "pmx claim <task id> [--no-run]",
    options: { "no-run": { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const svc = await services(ctx);
      const task = await findTask(svc, a.positionals[0] ?? "");
      if (task.status !== "ready") throw new Error(`${task.identifier} is ${task.status}; only ready tasks can be claimed (TASK-5).`);
      const got = await claim(ctx, svc, task);
      if (!got.ok) throw new Error(`${task.identifier} is held by ${got.holder}.`);
      if (a.values["no-run"]) {
        console.log(`Claimed ${task.identifier} until ${got.lease.expiresAt}.`);
        return 0;
      }
      console.log((await runTask(ctx, svc, task, got.lease)).message);
      return 0;
    },
  },
  {
    name: "release",
    summary: "Give a claim back, or release stale claims (--stale)",
    usage: "pmx release <task id> | pmx release --stale",
    options: { stale: { type: "boolean" } },
    async run(a) {
      const ctx = await a.ctx();
      const svc = await services(ctx);
      if (a.values.stale) {
        const r = await releaseStale(ctx, svc);
        console.log(r.length ? r.join("\n") : "No stale claims.");
        return 0;
      }
      const task = await findTask(svc, a.positionals[0] ?? "");
      if (!(await svc.lease.release(task.id, ctx.agent))) throw new Error(`${task.identifier} is not claimed by you.`);
      if (task.status === "claimed") {
        await svc.tracker.setAgent(task.id, null);
        await svc.tracker.setStatus(task.id, "ready");
      }
      await new RunLogStore(ctx).record({ type: "release", agent: ctx.agent, machine: ctx.personal.machineId, taskId: task.identifier, reason: "manual" });
      console.log(`Released ${task.identifier}.`);
      return 0;
    },
  },
  {
    name: "verify-record",
    summary: "CI check: every output in this PR has a clean run record (B5)",
    usage: "pmx verify-record [--base origin/main] [--repo .]",
    options: { base: { type: "string" }, repo: { type: "string" } },
    async run(a) {
      const r = await verifyPr(new Git(a.values.repo ?? process.cwd()), a.values.base ?? "origin/main");
      console.log(r.lines.join("\n"));
      return r.ok ? 0 : 1;
    },
  },
  {
    name: "neutrality",
    summary: "Run skill fixtures in a clean profile; compare reports from two machines (B6)",
    usage: "pmx neutrality [--out report.json] | pmx neutrality --compare a.json b.json",
    options: { out: { type: "string" }, compare: { type: "boolean" } },
    async run(a) {
      if (a.values.compare) {
        const [x, y] = await Promise.all(a.positionals.slice(0, 2).map(async (p) => JSON.parse(await readFile(p, "utf8")) as NeutralityReport));
        const r = compareReports(x!, y!);
        console.log(r.lines.join("\n"));
        return r.ok ? 0 : 1;
      }
      const report = await neutralityRun(await a.ctx());
      const out = a.values.out ?? `neutrality-${report.agent.replace(/[^\w.-]/g, "_")}.json`;
      await writeJson(out, report, 0o644);
      for (const e of report.entries) console.log(`${e.checklistOk ? "✔" : "✘"} ${e.skill}@${e.skillVersion} ${e.problems.join("; ")}`);
      console.log(`Report written to ${out}. Run the same on a second machine, then: pmx neutrality --compare a.json b.json`);
      return report.entries.every((e) => e.checklistOk) ? 0 : 1;
    },
  },
];

/** Tick steps for team mode: stale releases, synthesis on the designated machine, then one pull. */
export const releaseStep: TickStep = async (ctx) => {
  if (ctx.team.tracker.kind === "none") return null;
  const r = await releaseStale(ctx, await services(ctx));
  return r.length ? r.join("; ") : null;
};

/** `--since today` or a date: the first day whose meetings count as unprocessed (MEET-3). */
function sinceDate(v: string | undefined, now: Date): Date {
  if (!v || v === "today") return startOfDay(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`--since takes "today" or a date like 2026-11-05, not "${v}".`);
  return new Date(`${v}T00:00:00`);
}

/**
 * Polls every tick on the synthesizer machine (MEET-3): today's meetings not yet in the team's ledger
 * are processed at once. With nothing new it makes no model call. Slack still runs every 6 hours.
 */
export const synthStep: TickStep = async (ctx: Ctx) => {
  if (!synthesizesHere(ctx.team, ctx.personal, ctx.agent)) return null;
  const s = await loadState();
  const slackDue = !s.lastSynthAt || ctx.now().getTime() - new Date(s.lastSynthAt).getTime() >= 6 * 3600000;
  const w = synthWindow(s.lastSynthAt, ctx.now());
  const r = await synthesize(ctx, await services(ctx), { ...w, skipIfNothingNew: !slackDue });
  if (!r.meetings.processed.length && !r.staged.length) return null;
  return `${r.meetings.processed.length} meeting(s) processed, ${r.staged.length} new task(s) waiting for your approval (pmx proposals)${r.heldOver ? `; ${heldOverLine(r.heldOver)!.replace(/\.$/, "")}` : ""}${(r.waiting ?? []).map((k) => `; ${kindLine(k)} (pmx jobs add ${k.kind})`).join("")}`;
};

/** RUN-5: approved tasks' quotes shared with the team, and the quotes of finished tasks removed. */
export const evidenceTickStep: TickStep = (ctx) => evidenceStep(ctx, () => services(ctx));

export const pullStep: TickStep = async (ctx) => {
  if (ctx.team.tracker.kind === "none") return null;
  const svc = await services(ctx);
  // TASK-8: Linear agrees with the moves PMX follows before the pull reads the queue. Bookkeeping, not an agent run,
  // so it happens in practice mode too. A tracker PMX can't read yet fails the pull below with the reason.
  const followed = await followMoves(svc.tracker).catch(() => [] as string[]);
  // PULL-14: this Mac's steps its last sync applied have landed; marks older than a week go. Bookkeeping, quietly.
  await tendMarks(ctx, svc.tracker).catch(() => 0);
  const r = await pull(ctx, svc, { dryRun: isDryRunDefault(ctx) });
  const said = r.ran ? r.ran.message : r.dryRun ? `dry run: ${r.selection?.candidates[0]?.identifier ?? "nothing"} would be pulled` : null;
  return [...followed, ...(said ? [said] : [])].join("; ") || null;
};
