import type { PersonalConfig, TeamConfig } from "../core/config.js";

/**
 * Connector inputs (INPUT-1): any connector the PM already has in their Claude app can feed PMX. PMX never connects
 * to it. The scheduled collection task in the PM's Claude app does, following instructions PMX writes fresh on every
 * run, and saves what it reads as plain files with front matter. PMX then reads those files through the same privacy
 * filter, masking and approval as everything else. Two shapes cover every connector:
 *
 *  - **calls**: recorded conversations with people (Granola, Fireflies, Momentum, Gong…). One file per meeting, a
 *    verbatim transcript. A call reaches team tasks only with someone from outside the company in it (B2).
 *  - **channels**: conversations in places the team approved (Slack or Teams channels, a support inbox, a forum
 *    category). One file per thread. Only the places listed, never DMs or group DMs (PRIV-2), and private places only
 *    when the team allows them. Team-approved, so they change only by a reviewed proposal (NEUT-2).
 */
export type InputShape = "calls" | "channels";

/** A recorder the PM added on this Mac, beyond the built-in meeting apps (personal config). */
export interface CallInput {
  connector: string;
  /** Optional, the PM's own words: which calls to read ("only calls tagged Discovery"). */
  look?: string | null;
}

/** Places the team approved in one channel-like connector (team config, `inputs`). */
export interface ChannelInput {
  connector: string;
  /** Channels, inboxes, queues or categories, as the connector names them: "#product-feedback", "C0123ABCD". */
  places: string[];
  look?: string | null;
}

/** Connectors people pick most, so the board can suggest them. Any other connector's name works too. */
export const SUGGESTED: { connector: string; shape: InputShape; note: string }[] = [
  { connector: "Slack", shape: "channels", note: "Channels your team approves" },
  { connector: "Microsoft Teams", shape: "channels", note: "Team channels" },
  { connector: "Discord", shape: "channels", note: "Community channels" },
  { connector: "Intercom", shape: "channels", note: "Customer conversations" },
  { connector: "Zendesk", shape: "channels", note: "Support tickets in a view" },
  { connector: "Momentum", shape: "calls", note: "Recorded customer calls" },
  { connector: "Gong", shape: "calls", note: "Recorded sales calls" },
  { connector: "Sybill", shape: "calls", note: "Recorded sales calls" },
  { connector: "Avoma", shape: "calls", note: "Recorded meetings" },
  { connector: "Grain", shape: "calls", note: "Recorded meetings" },
  { connector: "Read.ai", shape: "calls", note: "Recorded meetings" },
];

/** The meeting apps PMX looks for without being told, in order: the first one connected is used (COLLECT-1). */
export const MEETING_CONNECTORS = ["Granola", "Fireflies", "Otter", "Fathom", "tl;dv", "Zoom", "Google Drive (Google Meet transcripts)"];

const BUILTIN_IDS: Record<string, string> = { "tl;dv": "tldv", "google drive (google meet transcripts)": "google-meet", "google meet": "google-meet" };

/**
 * A connector's id, as transcripts' `source:` and the PM's routes spell it: lower case, words joined by hyphens.
 * "Momentum" → momentum, "Microsoft Teams" → microsoft-teams, "Read.ai" → read-ai, "tl;dv" → tldv.
 */
export function connectorId(name: string): string {
  const k = name.trim().toLowerCase();
  return BUILTIN_IDS[k] ?? k.replace(/[^a-z]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30).replace(/-+$/, "");
}

/** Throws a message a PM can act on when a connector name or a place can't be used. */
export function checkConnector(name: unknown): string {
  if (/[\r\n\t]/.test(String(name ?? ""))) throw new Error("A connector's name is one line.");
  const v = String(name ?? "").replace(/\s+/g, " ").trim();
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .&;()'-]{0,39}$/u.test(v)) throw new Error("Give the connector's name as Claude shows it, like Momentum or Slack (up to 40 letters).");
  if (!/^[a-z][a-z-]{1,30}$/.test(connectorId(v))) throw new Error(`"${v}" needs at least two letters, starting with a letter.`);
  if (connectorId(v) === "file") throw new Error(`"${v}" is the name PMX uses for your transcript folder. Pick the connector's own name.`);
  return v;
}

/**
 * A place that is a direct or group message, never read (PRIV-2): a Slack DM ID (D and 8 to 10 capitals and digits,
 * at least one digit), or a name that says so. Ordinary names like "Development" or "dmarc" are channels.
 */
export const isDmPlace = (p: string) => /^D(?=[A-Z0-9]*\d)[A-Z0-9]{8,10}$/.test(p.trim()) || /^(dm|im|mpim)([:\s-]|$)|\bdirect messages?\b|\bgroup dms?\b/i.test(p.trim());

export function checkPlace(p: unknown): string {
  const v = String(p ?? "").replace(/\s+/g, " ").trim();
  if (v.length < 2 || v.length > 80 || /[|`<>"\n]/.test(v)) throw new Error(`"${v}" isn't a place PMX can name. Give a channel like #product-feedback, an ID like C0123ABCD, or an inbox name.`);
  if (isDmPlace(v)) throw new Error(`"${v}" looks like a direct message. PMX never reads those; name channels only.`);
  return v;
}

/** Whether a config entry is usable as written: a hand-edited pmx.config.json is checked the same way as the board's changes. */
const valid = (f: () => unknown) => { try { f(); return true; } catch { return false; } };

export function checkLook(l: unknown): string | null {
  const v = String(l ?? "").replace(/[\s`]+/g, " ").trim();
  if (!v) return null;
  if (v.length > 200) throw new Error("Keep the note on what to read under 200 characters.");
  return v;
}

/** The recorders this PM added (Momentum…), skipping any the team's built-in list already covers. */
export function callInputs(personal: Pick<PersonalConfig, "sources">): CallInput[] {
  const builtin = new Set(MEETING_CONNECTORS.map(connectorId));
  return (personal.sources.calls ?? []).filter((c) => valid(() => (checkConnector(c.connector), checkLook(c.look))) && !builtin.has(connectorId(c.connector)));
}

/**
 * The places the team approved, by connector. Teams that approved Slack channels before connector inputs
 * (`slackChannels`, with "slack" in `allowedSources`) keep them: they read as Slack's places.
 */
export function channelInputs(team: Pick<TeamConfig, "inputs" | "slackChannels" | "allowedSources">): ChannelInput[] {
  const placeOk = (p: string) => valid(() => checkPlace(p));
  const out = (team.inputs ?? [])
    .filter((x) => x?.connector && Array.isArray(x.places) && valid(() => (checkConnector(x.connector), checkLook(x.look))))
    .map((x) => ({ ...x, places: [...new Set(x.places.filter(placeOk))] }))
    .filter((x) => x.places.length);
  const legacy = (team.allowedSources?.includes("slack") ? team.slackChannels ?? [] : []).filter(placeOk);
  if (legacy.length) {
    const slack = out.find((x) => connectorId(x.connector) === "slack");
    if (slack) slack.places = [...new Set([...slack.places, ...legacy])];
    else out.push({ connector: "Slack", places: [...legacy] });
  }
  return out;
}

/**
 * Whether this Mac collects the team's channels. Only the team's synthesis Mac does: team channels feed team tasks,
 * which only it makes, and one Mac reading them means each thread is read once.
 */
export const collectsChannels = (team: Pick<TeamConfig, "synthesizer">, personal: Pick<PersonalConfig, "handle">, agent: string) =>
  !!team.synthesizer && (team.synthesizer === personal.handle || team.synthesizer === agent);

/** Whether `place` (as a saved thread names it) is one of the approved places for `source`. */
export function placeApproved(inputs: ChannelInput[], source: string, place: string): boolean {
  if (isDmPlace(place)) return false;
  const norm = (s: string) => s.trim().toLowerCase().replace(/^#/, "");
  return inputs.some((x) => connectorId(x.connector) === source && x.places.some((p) => norm(p) === norm(place)));
}
