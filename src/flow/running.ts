import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { COLLECT_TASK, LINEAR_SYNC_TASK } from "../claude/tasks.js";
import type { Exec } from "../core/exec.js";
import type { Launchd } from "../core/launchd.js";
import { paths } from "../core/paths.js";
import { loadState } from "../core/state.js";
import { readSnapshot } from "../tracker/relay.js";
import { webServerFile, PAGE_IDLE_MS, type WebServerNote } from "./web-server.js";

/**
 * Health → Running (OBS-5): what PMX is doing on this Mac right now. The background job (installed, running a pass,
 * its last and next pass), the agent run in progress, PMX's own servers, and the last Linear sync and meeting
 * collection by the Claude app's tasks, from records PMX already keeps. Memory comes from one `ps` call, matched to
 * PMX's own processes only: this one and its children, the job's pass, PMX's servers, and `claude` runs that carry
 * PMX's run settings. Read only when the PM opens the tab, never on the page's minute-by-minute refresh.
 */
export const RUN_COST = "An agent run is one Claude Code process, usually 400–550 MB, one at a time.";

export interface PsRow { pid: number; ppid: number; rssKb: number; elapsedS: number; command: string }

/** `ps -axo pid,ppid,rss,etime,command`, one row per process. The header line and anything unreadable are skipped. */
export function parsePs(out: string): PsRow[] {
  const rows: PsRow[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:-]+)\s+(.+)$/);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), rssKb: Number(m[3]), elapsedS: etimeSeconds(m[4]!), command: m[5]!.trim() });
  }
  return rows;
}

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in seconds. */
export function etimeSeconds(s: string): number {
  const [d, rest] = s.includes("-") ? s.split("-") : ["0", s];
  const parts = rest!.split(":").map(Number).reverse();
  return Number(d) * 86400 + (parts[2] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[0] ?? 0);
}

/** The agent run in progress, as the process that started it noted it (src/run/run.ts). */
export interface AgentRunNote { task: string; title: string; startedAt: string; pid: number }
export const agentRunFile = () => join(paths.home(), "agent-run.json");

/** Notes an agent run starting in this process, and returns how to clear the note when it ends. */
export async function noteAgentRun(task: string, title: string, now: Date): Promise<() => Promise<void>> {
  const note: AgentRunNote = { task, title, startedAt: now.toISOString(), pid: process.pid };
  await writeFile(agentRunFile(), JSON.stringify(note), { mode: 0o600 }).catch(() => {});
  return async () => {
    const cur = await readAgentRun();
    if (cur?.pid === process.pid && cur.task === task) await rm(agentRunFile(), { force: true }).catch(() => {});
  };
}
const readAgentRun = () => readFile(agentRunFile(), "utf8").then((t) => JSON.parse(t) as AgentRunNote, () => null);

export interface Proc { pid: number; since: string; memoryMb: number }
export interface RunningView {
  at: string;
  job: { installed: boolean; running: boolean; lastPass: string | null; nextPass: string | null; failed: string[]; pass: Proc | null };
  agent: { task: string | null; title: string | null; since: string; memoryMb: number | null } | null;
  servers: { id: "mcp" | "page"; name: string; running: boolean; here: boolean; processes: Proc[]; note: string }[];
  claude: {
    linear: { syncedAt: string | null; lastRun: string | null } | null;
    collect: { at: string | null; saved: number | null; lastRun: string | null };
  };
  /** Every process above together. */
  memory: { totalMb: number; processes: number } | null;
  note: string;
}

export interface RunningDeps {
  exec: Exec;
  launchd: Launchd;
  now: Date;
  /** The pmx script the Claude app starts for PMX's server, when it's registered. */
  mcpCli?: string | null;
  /** Whether this Mac reaches Linear through the Claude app's sync task. */
  relay?: boolean;
  /** This process, and what it is: the Claude app's server or this Mac's page. */
  self?: { pid: number; id: "mcp" | "page" };
}

const mb = (kb: number) => Math.round(kb / 1024);
const proc = (r: PsRow, now: Date): Proc => ({ pid: r.pid, since: new Date(now.getTime() - r.elapsedS * 1000).toISOString(), memoryMb: mb(r.rssKb) });
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** What PMX runs on this Mac now. One `ps` call; nothing else is started or read from outside PMX's own records. */
export async function runningNow(d: RunningDeps): Promise<RunningView> {
  const now = d.now;
  const self = d.self ?? { pid: process.pid, id: "mcp" as const };
  const r = await d.exec("ps", ["-axo", "pid,ppid,rss,etime,command"], { timeoutMs: 10000 }).catch(() => null);
  const rows = r && r.code === 0 ? parsePs(r.stdout) : [];
  const byPid = new Map(rows.map((x) => [x.pid, x]));
  const kids = (pid: number): PsRow[] => {
    const out: PsRow[] = [];
    const walk = (p: number) => { for (const x of rows) if (x.ppid === p && !out.includes(x)) { out.push(x); walk(x.pid); } };
    walk(pid);
    return out;
  };
  const counted = new Set<number>();
  const tally = (xs: PsRow[]) => { for (const x of xs) counted.add(x.pid); return xs; };

  // The background job: its file, whether a pass runs now, and that pass's process (its `tick`, with the job's pmx).
  const plist = await d.launchd.installed().catch(() => null);
  const jobCli = plist?.match(/<key>ProgramArguments<\/key>\s*<array>\s*<string>[^<]*<\/string>\s*<string>([^<]*)<\/string>/)?.[1] ?? null;
  const passing = plist ? !!(await d.launchd.running?.().catch(() => false)) : false;
  const passRow = jobCli ? rows.find((x) => x.command.includes(jobCli) && /\stick\s*$/.test(x.command)) : undefined;
  const pass = passRow ? [passRow, ...kids(passRow.pid)] : [];
  tally(pass);
  const st = await loadState();
  const last = st.lastTick?.at ?? null;

  // The agent run: the note its pmx left, while that pmx is alive, and the Claude Code process under it.
  const note = await readAgentRun();
  const runNote = note && alive(note.pid) ? note : null;
  const settings = [paths.runSettings(), paths.webRunSettings()];
  // Every Claude Code process with PMX's run settings (a web run's too, RUN-6) is one of PMX's runs; the one under the noted pmx comes first.
  const claudeRuns = rows.filter((x) => settings.some((s) => x.command.includes(s)));
  const under = runNote ? kids(runNote.pid) : [];
  const runRows = [...claudeRuns.filter((x) => under.includes(x)), ...claudeRuns.filter((x) => !under.includes(x))];
  tally(runRows);
  const agent = runNote || runRows.length ? {
    task: runNote?.task ?? null, title: runNote?.title ?? null,
    since: runNote?.startedAt ?? proc(runRows[0]!, now).since,
    memoryMb: runRows.length ? mb(runRows.reduce((a, x) => a + x.rssKb, 0)) : null,
  } : null;

  // PMX's servers: the Claude app's (every `pmx mcp` of the registered pmx, and this one), and this Mac's page.
  const mcpRows = rows.filter((x) => (x.pid === self.pid && self.id === "mcp") || (!!d.mcpCli && x.command.includes(d.mcpCli) && /\smcp\s*$/.test(x.command)));
  const pageNote = await readFile(webServerFile(), "utf8").then((t) => JSON.parse(t) as WebServerNote, () => null);
  const pageRow = pageNote ? byPid.get(pageNote.pid) ?? (self.id === "page" ? byPid.get(self.pid) : undefined) : self.id === "page" ? byPid.get(self.pid) : undefined;
  const pageRows = pageRow ? [pageRow] : [];
  const serverProcs = (xs: PsRow[]) => xs.map((x) => { const own = kids(x.pid).filter((k) => !counted.has(k.pid)); tally([x, ...own]); return { ...proc(x, now), memoryMb: mb(x.rssKb + own.reduce((a, k) => a + k.rssKb, 0)) }; });
  const idleH = Math.round(PAGE_IDLE_MS / 3600000);
  const servers: RunningView["servers"] = [
    { id: "mcp", name: "PMX's server for the Claude app", running: mcpRows.length > 0, here: self.id === "mcp", processes: serverProcs(mcpRows),
      note: "The Claude app starts it when it opens and stops it when it quits. It answers this page and Claude's questions to PMX." },
    { id: "page", name: "PMX's page on this Mac", running: pageRows.length > 0, here: self.id === "page", processes: serverProcs(pageRows),
      note: `It stops by itself after ${idleH} hours with nobody using it. Open it again from Settings → Account.` },
  ];

  const total = rows.filter((x) => counted.has(x.pid));
  const relay = d.relay ? await readSnapshot().catch(() => null) : null;
  const lastCollect = st.collectReports.at(-1) ?? null;
  const runOf = (id: string) => { const t = st.taskRuns[id]; return t ? t.finishedAt ?? t.startedAt : null; };
  return {
    at: now.toISOString(),
    job: {
      installed: !!plist, running: passing || !!passRow, lastPass: last,
      nextPass: plist ? (last ? new Date(Math.max(Date.parse(last) + 30 * 60000, now.getTime())).toISOString() : null) : null,
      failed: st.lastTick?.failed ?? [], pass: passRow ? { ...proc(passRow, now), memoryMb: mb(pass.reduce((a, x) => a + x.rssKb, 0)) } : null,
    },
    agent,
    servers,
    claude: {
      linear: d.relay ? { syncedAt: relay?.syncedAt ?? null, lastRun: runOf(LINEAR_SYNC_TASK.id) } : null,
      collect: { at: lastCollect?.at ?? null, saved: lastCollect?.saved ?? null, lastRun: runOf(COLLECT_TASK.id) },
    },
    memory: rows.length ? { totalMb: mb(total.reduce((a, x) => a + x.rssKb, 0)), processes: total.length } : null,
    note: RUN_COST,
  };
}
