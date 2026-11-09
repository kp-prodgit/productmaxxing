import type { RunReceipt } from "../core/receipt.js";
import type { State } from "../core/state.js";
import { callInputs, channelInputs, connectorId, MEETING_CONNECTORS, SUGGESTED, type InputShape } from "./inputs.js";
import type { PersonalConfig, TeamConfig } from "../core/config.js";

export type InputStatus = "reading" | "not-connected" | "failed" | "waiting" | "elsewhere";

export interface InputRow {
  id: string;
  connector: string;
  shape: InputShape;
  /** Whose it is: the PM's own recorder, a built-in meeting app, or the team's approved channels. */
  owner: "you" | "built-in" | "team";
  /** Channels: the approved places. Only on this Mac's own page; the shared page gets the count. */
  places: string[];
  placesN: number;
  look: string | null;
  status: InputStatus;
  /** Calls or threads saved from it in the window. */
  n: number;
  last: string | null;
}

/** The Sources tab (INPUT-1, INPUT-2): every connector PMX reads through, how it's doing, and what was caught twice. */
export interface InputsBoard {
  rows: InputRow[];
  /** The built-in meeting apps, in the order PMX tries them, and which one the last run used. */
  meetingApps: { id: string; label: string }[];
  usedApp: string | null;
  /** Whether this Mac collects the team's channels; only the synthesis Mac does. */
  channelsHere: boolean;
  synthesizer: string | null;
  /** This Mac's PMX handle, so the page can offer to make it the synthesis Mac. Local only. */
  me: string | null;
  lastCollect: string | null;
  allowPrivate: boolean;
  /** Duplicates caught in the window: one meeting saved twice, needs heard again on open tasks or waiting proposals. */
  dedup: { twins: number; again: { identifier: string; n: number; last: string }[]; merged: number };
  suggested: typeof SUGGESTED;
}

const LABEL: Record<string, string> = { "google-meet": "Google Meet", tldv: "tl;dv" };

export function buildInputsBoard(i: {
  team: TeamConfig; personal: PersonalConfig; agent: string; state: Pick<State, "collectReports">; receipts: RunReceipt[]; now: Date; hours: number; local: boolean;
}): InputsBoard {
  const since = new Date(i.now.getTime() - i.hours * 3600000).toISOString();
  const reports = i.state.collectReports.filter((r) => r.at >= since).sort((a, b) => a.at.localeCompare(b.at));
  const stats = (id: string) => {
    let n = 0, last: string | null = null, status: InputStatus | null = null;
    for (const r of reports) {
      const x = r.inputs?.find((y) => y.id === id) ?? (r.connector === id ? { status: "used" as const, saved: r.saved } : null);
      if (!x) continue;
      n += x.saved;
      if (x.saved) last = r.at;
      status = x.status === "not-connected" ? "not-connected" : x.status === "failed" ? "failed" : "reading";
    }
    return { n, last, status };
  };
  const here = !!i.team.synthesizer && (i.team.synthesizer === i.personal.handle || i.team.synthesizer === i.agent);
  const rows: InputRow[] = [];
  for (const c of callInputs(i.personal)) {
    const s = stats(connectorId(c.connector));
    rows.push({ id: connectorId(c.connector), connector: c.connector, shape: "calls", owner: "you", places: [], placesN: 0, look: i.local ? c.look ?? null : null, status: s.status ?? "waiting", n: s.n, last: s.last });
  }
  for (const c of channelInputs(i.team)) {
    const s = stats(connectorId(c.connector));
    rows.push({
      id: connectorId(c.connector), connector: c.connector, shape: "channels", owner: "team", places: i.local ? c.places : [], placesN: c.places.length, look: i.local ? c.look ?? null : null,
      status: !here ? "elsewhere" : s.status ?? "waiting", n: s.n, last: s.last,
    });
  }
  const usedApp = [...reports].reverse().map((r) => r.inputs?.find((x) => x.shape === "calls" && x.status === "used" && MEETING_CONNECTORS.some((m) => connectorId(m) === x.id))?.id ?? r.connector).find(Boolean) ?? null;

  // Duplicates, from the run receipts: counts and the open task's ID, never what was said.
  const inWin = i.receipts.filter((r) => r.at >= since);
  const twins = inWin.reduce((a, r) => a + (r.twins ?? 0), 0);
  const again = new Map<string, { n: number; last: string }>();
  let merged = 0;
  for (const r of inWin) for (const t of r.synth?.tasks ?? []) {
    const p = t.posted;
    if (p && "mergedInto" in p) merged++;
    if (p && "duplicateOf" in p) {
      const cur = again.get(p.duplicateOf) ?? { n: 0, last: r.at };
      again.set(p.duplicateOf, { n: cur.n + t.sources.length, last: r.at > cur.last ? r.at : cur.last });
    }
  }
  return {
    rows,
    meetingApps: MEETING_CONNECTORS.map((m) => ({ id: connectorId(m), label: LABEL[connectorId(m)] ?? m })),
    usedApp, channelsHere: here, synthesizer: i.team.synthesizer, me: i.local ? i.personal.handle : null, lastCollect: [...i.state.collectReports].sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.at ?? null, allowPrivate: i.team.allowPrivateChannels,
    dedup: { twins, again: [...again].map(([identifier, v]) => ({ identifier, ...v })).sort((a, b) => b.last.localeCompare(a.last)), merged },
    suggested: SUGGESTED,
  };
}
