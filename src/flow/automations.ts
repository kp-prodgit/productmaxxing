import { isoWeek } from "../core/context.js";
import type { RunReceipt } from "../core/receipt.js";
import type { RunLogEntry } from "../core/runlog.js";
import type { DigestBoard } from "./digests.js";
import type { Job, RunnableStep } from "./jobs.js";

/**
 * Every point where PMX acts or waits for the PM (BOARD-5), automated or not, as one status row each: what it's for in
 * a PM's words, who does it, when it last ran and what came of it, when it runs next, and whether it's healthy. The
 * board's Automations tab lists them all; Today shows only the ones that need attention. Counts and times only, so
 * the shared page shows them too.
 */
export type AutoStatus = "ok" | "attention" | "failed" | "setup" | "off" | "waiting";
export interface Automation {
  id: string;
  group: "in" | "work" | "agents" | "upkeep";
  name: string;
  what: string;
  /** "auto": PMX does it on a schedule. "you": it waits for the PM. "both": automatic, and the PM can run it too. */
  by: "auto" | "you" | "both";
  where: string;
  cadence: string;
  last: string | null;
  next: string | null;
  status: AutoStatus;
  statusText: string;
  /** What the last run produced, in words. */
  result: string | null;
  /** The board tab where its output is. */
  tab: string | null;
  /** The step "Run now" starts on this Mac, when it can run here. */
  run: RunnableStep | null;
  /** Why it can't run from here, when it can't. */
  runNote: string | null;
  /** How to fix it when it isn't healthy: an action the board can take, or a Terminal command as a fallback. */
  fix: { text: string; action?: string; cmd?: string } | null;
}

export interface ActivityItem {
  at: string;
  kind: "collect" | "todo" | "propose" | "digest" | "agent" | "review" | "release" | "problem" | "update";
  text: string;
  tab: string | null;
  bad?: boolean;
}

export interface AutomationInputs {
  now: Date;
  agent: string;
  handle: string;
  installedAt: string;
  jobInstalled: boolean;
  lastTick: { at: string; failed: string[]; failStreak: number } | null;
  tickOk: boolean;
  schedules: { id?: string; name: string; last: string | null; next: string | null; ok: boolean; detail: string; when: string; node: string | null }[];
  collectReports: { at: string; connector: string | null; saved: number; skipped?: Record<string, number> }[];
  receipts: RunReceipt[];
  runlog: RunLogEntry[] | null;
  tracker: boolean;
  synthesizer: string | null;
  company: { machine: string | null } | null;
  lastSynthAt: string | null;
  lastRollupAt: string | null;
  lastEventSyncAt: string | null;
  analytics: boolean;
  autoUpdate: { on: boolean; state: { checkedAt: string; result: string; version: string | null } | null; version: string };
  /** `ok`/`problem`: the relay's own health, so the row agrees with Today's warning. */
  linear: { mode: "relay" | "api" | "none" | string; syncedAt: string | null; waiting: number; ok?: boolean; problem?: string };
  proposals: number;
  drafts: number;
  reviewCap: number;
  todos: number;
  paused: string[];
  digest: DigestBoard | null;
  pendingTeam: number;
  killSwitch: { on: boolean; reason: string | null };
  jobs: Job[];
}

const MIN = 60000;
const latest = (xs: (string | null | undefined)[]) => xs.filter((x): x is string => !!x).sort().at(-1) ?? null;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isoWeekOf = (at: string) => isoWeek(new Date(at));
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-W45" → "Nov 2": the Monday its ISO week starts on. */
export function weekLabel(week: string): string {
  const m = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!m) return week;
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const mon = new Date(jan4.getTime() + (-((jan4.getUTCDay() + 6) % 7) + (Number(m[2]) - 1) * 7) * 86400000);
  return `${MONTHS[mon.getUTCMonth()]} ${mon.getUTCDate()}`;
}
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function buildAutomations(i: AutomationInputs): Automation[] {
  const nextPass = i.jobInstalled && i.lastTick ? new Date(Math.max(Date.parse(i.lastTick.at) + 30 * MIN, i.now.getTime())).toISOString() : null;
  const failedStep = (name: string) => i.lastTick?.failed.find((l) => l.startsWith(`${name}: failed: `))?.replace(`${name}: failed: `, "") ?? null;
  const viaJob = (name: string): Pick<Automation, "status" | "statusText" | "fix"> | null => {
    if (i.killSwitch.on) return { status: "off", statusText: "Stopped by your team", fix: null };
    // One row says automatic runs are off, with the button; the steps that depend on it just say they're waiting.
    if (!i.jobInstalled) return { status: "off", statusText: "Waits for automatic runs", fix: null };
    const f = failedStep(name);
    if (f) return { status: "failed", statusText: "Failed last time", fix: { text: f.slice(0, 240) } };
    return null;
  };
  const ok = (statusText = "Running normally"): Pick<Automation, "status" | "statusText" | "fix"> => ({ status: "ok", statusText, fix: null });
  const isMe = (m: string | null) => !!m && (m === i.agent || m === i.handle);
  const runs = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "run" }> => e.type === "run" && e.agent === i.agent);
  const lastRun = runs.sort((a, b) => a.ts.localeCompare(b.ts)).at(-1) ?? null;
  const releases = (i.runlog ?? []).filter((e): e is Extract<RunLogEntry, { type: "release" }> => e.type === "release" && e.agent === i.agent);
  const lastRelease = releases.sort((a, b) => a.ts.localeCompare(b.ts)).at(-1) ?? null;
  const todoR = i.receipts.filter((r) => r.type === "todo" && !r.dryRun).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const synthR = i.receipts.filter((r) => r.type === "synthesize" && !r.dryRun).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const collect = [...i.collectReports].sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null;
  const dry = i.now.getTime() - Date.parse(i.installedAt) < 7 * 86400000;
  const dryUntil = new Date(Date.parse(i.installedAt) + 7 * 86400000).toISOString();
  const sched = (re: RegExp) => i.schedules.find((s) => re.test(s.name)) ?? null;
  const out: Automation[] = [];

  // ---- Bring meetings in ----
  const c = sched(/collect/i);
  const skipped = collect?.skipped ? Object.values(collect.skipped).reduce((a, n) => a + n, 0) : 0;
  out.push({
    id: "collect", group: "in", name: "Collect your meetings", by: "auto", where: "Claude app", tab: "flow",
    what: "Claude copies new transcripts from your meeting app into a private folder on this Mac. Nothing leaves the Mac here.",
    cadence: c?.when ?? "weekdays at 12:30 and 17:30", last: c?.last ?? collect?.at ?? null, next: c?.next ?? null,
    ...(!c ? { status: "setup", statusText: "Not set up", fix: { text: "Type /pmx-schedule in the Claude app to set up the collection task.", cmd: "/pmx-schedule" } }
      : c.ok ? ok("On schedule") : { status: c.detail === "not set up" ? "setup" : "attention", statusText: c.detail === "not set up" ? "Not set up" : "Needs a look", fix: { text: c.detail === "not set up" ? "Type /pmx-schedule in the Claude app." : `It ${c.detail}. Open the Claude app and check its Scheduled tasks.`, cmd: "/pmx-schedule" } }),
    result: collect ? `${plural(collect.saved, "meeting")} saved${skipped ? `, ${skipped} skipped` : ""}` : null,
    run: null, runNote: "Runs inside the Claude app, which reads your meeting app for PMX. Open Claude and run it from Scheduled if you can't wait.",
  });

  // ---- Turn meetings into work ----
  out.push({
    id: "todo", group: "work", name: "Find your to-dos", by: "both", where: "This Mac and Claude", tab: "today",
    what: "Claude reads your own meetings, 1:1s included, with private details removed, and lists what you said you'd do. The list never leaves this Mac.",
    cadence: "every 30 minutes, when there's a new meeting", last: todoR?.at ?? null, next: nextPass,
    ...(viaJob("todo") ?? ok()), result: todoR?.todo ? `${plural(todoR.todo.added.length, "new to-do")}${i.todos ? ` · ${i.todos} open` : ""}` : i.todos ? `${i.todos} open` : null,
    run: i.killSwitch.on ? null : "todo", runNote: null,
  });
  const synthHere = isMe(i.synthesizer);
  out.push({
    id: "synthesize", group: "work", name: "Propose tasks from customer calls", by: "auto", where: synthHere ? "This Mac and Claude" : "The team's synthesis Mac",
    what: "Claude reads customer calls and approved Slack threads, with private details removed, and proposes sized tasks. Nothing goes to Linear until you approve.",
    cadence: "every 30 minutes for new calls; Slack every 6 hours", last: synthHere ? latest([i.lastSynthAt, synthR?.at]) : synthR?.at ?? null, next: synthHere ? nextPass : null, tab: "today",
    ...(!i.tracker ? { status: "off" as const, statusText: "No task tracker set up", fix: null } : !i.synthesizer ? { status: "setup" as const, statusText: "No synthesis Mac chosen", fix: { text: "Your team picks one Mac to read customer calls and propose tasks for everyone. Ask whoever set up PMX for your team to choose it (the synthesizer setting)." } } : synthHere ? (viaJob("synthesize") ?? ok()) : ok("Runs on another Mac")),
    result: synthR?.synth ? `${plural(synthR.synth.tasks.length, "task")} proposed from ${plural(synthR.sources.filter((s) => s.decision === "used").length, "source")}` : null,
    run: synthHere && i.tracker && !i.killSwitch.on ? "synthesize" : null, runNote: synthHere ? null : `Runs on ${i.synthesizer ?? "the team's synthesis Mac"}, so every call is read once for the whole team.`,
  });
  out.push({
    id: "approve", group: "work", name: "You approve proposed tasks", by: "you", where: "You, on this page", tab: "today",
    what: "Every proposed task waits for you. Approving sends it to Linear's inbox; dropping sends nothing.",
    cadence: "whenever tasks are proposed", last: null, next: null,
    status: i.proposals ? "waiting" : "ok", statusText: i.proposals ? `${i.proposals} waiting for you` : "Nothing waiting", fix: null,
    result: null, run: null, runNote: null,
  });
  out.push({
    id: "linear", group: "work", name: "Keep Linear in sync", by: "auto", where: i.linear.mode === "relay" ? "Claude app" : "Linear",
    what: i.linear.mode === "relay" ? "Claude reads your PMX project in Linear and applies the changes PMX queued: new tasks, labels and comments. PMX itself holds no Linear key." : i.linear.mode === "none" ? "PMX isn't connected to Linear." : "PMX reads and updates your PMX project in Linear directly, as it works.",
    cadence: i.linear.mode === "relay" ? (sched(/linear/i)?.when ?? "hourly on weekdays, 8:00–18:00") : "as PMX works", last: i.linear.syncedAt, next: sched(/linear/i)?.next ?? null, tab: "flow",
    ...(i.linear.mode === "none" ? { status: "setup" as const, statusText: "Not connected", fix: { text: "Connect Linear so approved tasks have somewhere to go.", cmd: "pmx linear login" } }
      : i.linear.mode === "relay" && !sched(/linear/i) ? { status: "setup" as const, statusText: "Not set up", fix: { text: "Type /pmx-schedule in the Claude app to set up the Linear sync.", cmd: "/pmx-schedule" } }
      : i.linear.mode === "relay" && !sched(/linear/i)!.ok ? { status: "attention" as const, statusText: "Behind", fix: { text: `It ${sched(/linear/i)!.detail}. Open the Claude app and check its Scheduled tasks.`, cmd: "/pmx-schedule" } }
      : i.linear.mode === "relay" && i.linear.ok === false ? { status: "attention" as const, statusText: i.linear.syncedAt ? `Last synced ${Math.round((i.now.getTime() - Date.parse(i.linear.syncedAt)) / 3600000)} h ago` : "Not synced yet", fix: { text: i.linear.problem ?? "The Linear sync is behind. Open the Claude app and check its Scheduled tasks.", cmd: "/pmx-schedule" } }
      : ok(i.linear.mode === "relay" ? "On schedule" : "Connected")),
    result: i.linear.mode === "relay" ? (i.linear.waiting ? `${plural(i.linear.waiting, "change")} waiting for the next sync` : "Nothing waiting to send") : null,
    run: null, runNote: i.linear.mode === "relay" ? "Runs inside the Claude app, which reaches Linear for PMX." : null,
  });
  // ---- Digest ----
  const d = i.digest;
  const lastDigest = d?.history[0] ?? null;
  const waitingAt = d?.waiting.map((w) => w.at).filter((x): x is string => !!x).sort().at(-1) ?? null;
  out.push({
    id: "digest", group: "work", name: "Weekly digest", by: "both", where: "This Mac and Claude", tab: "digest",
    what: "Every week Claude sums up what customers said: top themes, quotes and follow-ups, each cited. You read it first; nothing is shared until you approve it.",
    cadence: d ? `every ${DAYS[d.weekday]}` : "weekly", last: latest([lastDigest?.at, waitingAt]), next: d?.next ?? null,
    ...(d?.waiting.length ? { status: "waiting" as const, statusText: `${plural(d.waiting.length, "digest")} to read`, fix: null } : viaJob("digest") ?? ok()),
    result: waitingAt && (!lastDigest || waitingAt >= lastDigest.at) ? "Built and waiting for you" : lastDigest ? { waiting: "Waiting for you", approved: "Approved and shared", rejected: "You rejected it", "no-signal": "No customer calls that week", failed: "The build failed", expired: "Replaced by a newer build" }[lastDigest.status] : null,
    run: i.killSwitch.on ? null : "digest", runNote: null,
  });

  // ---- Agents ----
  const pull = viaJob("pull");
  out.push({
    id: "pull", group: "agents", name: "Your agent picks up Ready work", by: "both", where: "This Mac and Claude", tab: "work",
    what: "When a teammate moves a task to Ready in Linear, your agent takes one per pass, drafts it with that kind of work's instructions, and opens it for your review. It stays within your budget and review limit.",
    cadence: "every 30 minutes, one task at a time", last: lastRun?.ts ?? null, next: nextPass,
    ...(!i.tracker ? { status: "off" as const, statusText: "No task tracker set up", fix: null }
      : pull ?? (dry ? { status: "attention" as const, statusText: "Practice mode", fix: { text: `For your first week your agent only says what it would pick, without running. Real runs start ${new Date(dryUntil).toDateString()}.` } }
        : i.drafts >= i.reviewCap ? { status: "waiting" as const, statusText: "Paused for your reviews", fix: { text: `${plural(i.drafts, "draft")} are waiting for review; your agent waits at ${i.reviewCap}. Review one to let it continue.` } } : ok())),
    result: lastRun ? `${lastRun.taskId} (${lastRun.category}): ${{ ok: "drafted", failed: "failed", capped: "stopped at the size's limit", refused: "refused" }[lastRun.outcome]}` : null,
    run: i.tracker && !i.killSwitch.on ? "pull" : null, runNote: null,
  });
  out.push({
    id: "review", group: "agents", name: "You review agent drafts", by: "you", where: "You, on this page", tab: "today",
    what: "Accept a draft to keep it for the team, ask for a redo with a note, or reject it. Your verdicts set each kind of work's accept rate.",
    cadence: "whenever a draft is ready", last: null, next: null,
    status: i.drafts ? "waiting" : "ok", statusText: i.drafts ? `${i.drafts} waiting for you` : "Nothing waiting", fix: null, result: null, run: null, runNote: null,
  });
  out.push({
    id: "autopause", group: "agents", name: "Pause weak categories", by: "auto", where: "This Mac", tab: "work",
    what: "If too few drafts in a category are accepted, agents stop taking that kind of work until someone resumes it.",
    cadence: "checked before every pick-up", last: null, next: null,
    status: i.paused.length ? "attention" : "ok", statusText: i.paused.length ? `${plural(i.paused.length, "category", "categories")} paused` : "None paused",
    fix: i.paused.length ? { text: `Paused: ${i.paused.join(", ")}. See why under Agent work.` } : null, result: null, run: null, runNote: null,
  });
  out.push({
    id: "release", group: "agents", name: "Free stuck tasks", by: "auto", where: "This Mac", tab: null,
    what: "If an agent took a task and stopped answering, PMX hands the task back to Ready so another agent can take it.",
    cadence: "every 30 minutes", last: lastRelease?.ts ?? null, next: i.tracker ? nextPass : null,
    ...(!i.tracker ? { status: "off" as const, statusText: "No task tracker set up", fix: null } : viaJob("release") ?? ok()),
    result: lastRelease ? `${lastRelease.taskId} back to Ready` : "Nothing stuck",
    run: i.tracker && !i.killSwitch.on ? "release" : null, runNote: null,
  });
  if (i.company) {
    const here = isMe(i.company.machine ?? i.synthesizer);
    out.push({
      id: "company", group: "work", name: "Company roll-up", by: "auto", where: here ? "This Mac and Claude" : "The company Mac",
      what: "Once a day, themes that show up across several teams' work are posted to the company project.",
      cadence: "once a day", last: i.lastRollupAt, next: here && i.lastRollupAt ? new Date(Date.parse(i.lastRollupAt) + 86400000).toISOString() : null, tab: null,
      ...(here ? viaJob("company") ?? ok() : ok("Runs on another Mac")), result: null,
      run: here && !i.killSwitch.on ? "company" : null, runNote: here ? null : "Runs on the Mac your team chose for the company roll-up.",
    });
  }

  // ---- Upkeep ----
  out.push({
    id: "job", group: "upkeep", name: "Automatic runs on this Mac", by: "auto", where: "This Mac",
    what: "The background pass that does everything above on time. It runs every 30 minutes while this Mac is awake.",
    cadence: "every 30 minutes while awake", last: i.lastTick?.at ?? null, next: nextPass, tab: null,
    ...(i.killSwitch.on ? { status: "off" as const, statusText: "Stopped by your team", fix: { text: `Your team turned on the emergency stop${i.killSwitch.reason ? `: ${i.killSwitch.reason}` : ""}. Nothing runs until they turn it off.` } }
      : !i.jobInstalled ? { status: "setup" as const, statusText: "Off", fix: { text: "PMX only works while you have it open. Turn on automatic runs and it checks every 30 minutes on its own.", action: "install-job", cmd: "pmx init" } }
      : !i.tickOk ? { status: "failed" as const, statusText: `Failing (${plural(i.lastTick?.failStreak ?? 0, "pass", "passes")} in a row)`, fix: { text: (i.lastTick?.failed[0] ?? "").slice(0, 240) } }
      : i.lastTick?.failed.length ? { status: "attention" as const, statusText: "One step failed last time", fix: { text: (i.lastTick.failed[0] ?? "").slice(0, 240) } }
      : !i.lastTick ? { status: "attention" as const, statusText: "Hasn't run yet", fix: null } : ok()),
    result: i.lastTick ? (i.lastTick.failed.length ? plural(i.lastTick.failed.length, "step") + " failed" : "Every step ran") : null,
    run: i.killSwitch.on ? null : "tick", runNote: null,
  });
  out.push({
    id: "update", group: "upkeep", name: "Keep PMX up to date", by: "both", where: "This Mac",
    what: i.autoUpdate.on ? "PMX installs the version your team requires, at most once an hour, and tells you what's new." : "Your team hasn't turned on automatic updates. PMX tells you when your team requires a newer version.",
    cadence: i.autoUpdate.on ? "hourly" : "off", last: i.autoUpdate.state?.checkedAt ?? null,
    next: i.autoUpdate.on && nextPass ? new Date(Math.max(Date.parse(nextPass), i.autoUpdate.state ? Date.parse(i.autoUpdate.state.checkedAt) + 60 * MIN : 0)).toISOString() : null, tab: null,
    ...(i.autoUpdate.on && !i.jobInstalled ? { status: "off" as const, statusText: "Waits for automatic runs", fix: null } : i.autoUpdate.state && ["needs-sudo", "failed"].includes(i.autoUpdate.state.result) ? { status: "attention" as const, statusText: "Update waiting", fix: { text: `Your team is on pmx ${i.autoUpdate.state.version ?? "a newer version"}, but it couldn't install on its own.`, cmd: "pmx update" } } : ok(i.autoUpdate.on ? "On" : "Off")),
    result: `You have pmx ${i.autoUpdate.version}`, run: "update", runNote: null,
  });
  out.push({
    id: "events", group: "upkeep", name: "Usage analytics", by: "auto", where: "This Mac",
    what: "Counts with no meeting content (how many meetings were read, tasks proposed, drafts accepted) go to your team's PMX account, if you signed in and left analytics on.",
    cadence: i.analytics ? "every 30 minutes" : "off", last: i.lastEventSyncAt, next: i.analytics ? nextPass : null, tab: null,
    ...(i.analytics ? viaJob("events") ?? ok("On") : { status: "off" as const, statusText: "Off", fix: null }), result: null,
    run: i.analytics && !i.killSwitch.on ? "events" : null, runNote: null,
  });
  out.push({
    id: "team-changes", group: "upkeep", name: "Team settings in review", by: "you", where: "Your team's repo",
    what: "Changes to team settings you proposed from this page. A teammate who owns the settings approves them; nothing changes until then.",
    cadence: "when you propose one", last: null, next: null, tab: "settings",
    status: i.pendingTeam ? "waiting" : "ok", statusText: i.pendingTeam ? `${plural(i.pendingTeam, "change")} in review` : "None open", fix: null, result: null, run: null, runNote: null,
  });

  // Anything running from the board right now, or just finished, says so instead of the stored status.
  for (const a of out) {
    const j = i.jobs.find((x) => x.step === a.run);
    if (j && !j.finishedAt) { a.status = "waiting"; a.statusText = "Running now…"; }
  }
  return out;
}

/** What happened, newest first: counts and task IDs only, never meeting titles or text. */
export function buildActivity(i: { now: Date; hours: number; agent: string; receipts: RunReceipt[]; runlog: RunLogEntry[] | null; collectReports: AutomationInputs["collectReports"]; lastTick: AutomationInputs["lastTick"] }): ActivityItem[] {
  const since = new Date(i.now.getTime() - i.hours * 3600000).toISOString();
  const out: ActivityItem[] = [];
  for (const c of i.collectReports) if (c.at >= since && (c.saved || Object.values(c.skipped ?? {}).some(Boolean))) {
    const sk = (c.skipped?.["never-ingest-title"] ?? 0) + (c.skipped?.["never-ingest-person"] ?? 0);
    out.push({ at: c.at, kind: "collect", text: `Collected ${plural(c.saved, "meeting")}${c.connector ? ` from ${c.connector}` : ""}${sk ? `; ${sk} skipped by your do-not-read list` : ""}`, tab: "flow" });
  }
  for (const r of i.receipts) {
    if (r.at < since || r.dryRun) continue;
    const used = r.sources.filter((s) => s.decision === "used").length, held = r.sources.filter((s) => s.decision === "left-out").length;
    if (r.type === "todo" && r.todo?.added.length) out.push({ at: r.at, kind: "todo", text: `Found ${plural(r.todo.added.length, "to-do")} in your meetings`, tab: "today" });
    if (r.type === "synthesize" && (used || held)) out.push({ at: r.at, kind: "propose", text: `Read ${plural(used, "customer source")}${held ? `, kept ${held} private` : ""}; proposed ${plural(r.synth?.tasks.length ?? 0, "task")}`, tab: "today" });
    if (r.type === "digest") out.push({ at: r.at, kind: "digest", text: r.outcome === "staged" ? `Your digest for the week of ${weekLabel(isoWeekOf(r.at))} was built: ${plural(used, "source")} cited` : r.outcome === "no-signal" ? "No customer calls to digest this week" : "The weekly digest failed", tab: "digest", bad: r.outcome === "failed" });
  }
  for (const e of i.runlog ?? []) {
    if (e.ts < since) continue;
    if (e.type === "run" && e.agent === i.agent) out.push({ at: e.ts, kind: "agent", text: e.outcome === "ok" ? `Your agent drafted ${e.taskId} (${e.category})` : `Your agent couldn't finish ${e.taskId}: ${e.outcome}`, tab: e.outcome === "ok" ? "today" : "work", bad: e.outcome !== "ok" });
    if (e.type === "verdict") out.push({ at: e.ts, kind: "review", text: `${e.taskId} ${{ accepted: "accepted and merged", redo: "sent back for a redo", rejected: "rejected" }[e.verdict]}${e.agent === i.agent ? "" : " by a teammate"}`, tab: "work" });
    if (e.type === "release" && e.agent === i.agent) out.push({ at: e.ts, kind: "release", text: `${e.taskId} went back to Ready (${{ stale: "its agent stopped answering", manual: "released by hand", redo: "redo", failed: "the run failed", brain: "the brain moved it" }[e.reason]})`, tab: null });
    if (e.type === "digest" && e.agent === i.agent && e.outcome !== "staged") {
      const wk = weekLabel(e.week ?? isoWeekOf(e.ts));
      out.push({ at: e.ts, kind: "digest", text: e.outcome === "approved" ? `You approved the digest for the week of ${wk}` : `You discarded the digest for the week of ${wk}`, tab: "digest" });
    }
  }
  if (i.lastTick?.failed.length && i.lastTick.at >= since) out.push({ at: i.lastTick.at, kind: "problem", text: `${plural(i.lastTick.failed.length, "step")} of the background pass failed`, tab: "automations", bad: true });
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);
}
