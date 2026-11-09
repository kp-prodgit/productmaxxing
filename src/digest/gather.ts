import { readFile } from "node:fs/promises";
import type { Ctx } from "../core/context.js";
import { companyDomains, filterItems, sourceOf, type FilterResult } from "../core/filter.js";
import { makeRedactor } from "../core/redact.js";
import { sourceReceipts, topicRulesHash, type RunReceipt } from "../core/receipt.js";
import type { SignalItem } from "../core/types.js";
import { readThreads, readTranscripts } from "../sources/transcripts.js";
import { channelInputs, placeApproved } from "../inputs/inputs.js";
import { paths } from "../core/paths.js";
import { collapseTwins, meetingKeys, teamSalt } from "../meetings/ledger.js";
import { runCanaries } from "../core/canary.js";

/**
 * The privacy rules for one run (B2). Team and digest runs need an outside participant and hold a meeting whole when
 * it keeps returning to a sensitive topic; private to-dos (TODO-2) may read the PM's own 1:1s and internal meetings.
 */
export function privacyRules(ctx: Pick<Ctx, "team" | "personal">, individual = false) {
  const { team, personal } = ctx;
  return {
    internalDomains: companyDomains(team.internalDomains, { companyDomains: personal.companyDomains, emails: personal.identity?.emails }),
    requireExternalParticipant: !individual, neverIngest: personal.neverIngest, allowOneOnOne: individual, wholeMeeting: !individual,
    // "off" blocks a source everywhere; "mine" lets it feed only the PM's own to-dos.
    blockedSources: Object.entries(personal.sources?.routes ?? {}).filter(([, v]) => v === "off" || (v === "mine" && !individual)).map(([k]) => k),
    // Threads only from places the team approves today (INPUT-1).
    approvedPlace: (source: string, place: string) => placeApproved(channelInputs(team), source, place),
  };
}

export interface Gathered {
  items: SignalItem[];
  held: FilterResult["held"];
  heldItems: number;
  read: number;
  /** The parts of the run receipt that gathering decides (PRIV-4). */
  receipt: Pick<RunReceipt, "window" | "rules" | "skippedSources" | "sources" | "masked" | "canaries" | "twins">;
}

/**
 * Reads allowlisted sources, screens out personal content (B2) and redacts PII (SEC-8).
 * Nothing here is written to disk: held material is dropped in memory.
 *
 * `scope` "personal" reads the PM's own folders (digest). "team" adds team-approved channels (synthesis, M3).
 * "individual" reads the PM's own folders for their private to-dos (TODO-2): internal meetings and 1:1s
 * are allowed there, because nothing it produces leaves the Mac.
 */
export async function gather(ctx: Ctx, o: { days: number; scope: "personal" | "team" | "individual" }): Promise<Gathered> {
  const { team, personal } = ctx;
  const sinceMs = ctx.now().getTime() - o.days * 86400000;
  const raw: SignalItem[] = [];
  const skippedSources: string[] = [];

  if (!team.allowedSources.includes("transcripts")) skippedSources.push("Transcripts: not allowed in team config (allowedSources)");
  else if (!personal.sources.transcriptDirs.length) skippedSources.push("Transcripts: no folder set up (run `pmx init`)");
  if (team.allowedSources.includes("transcripts") && personal.sources.transcriptDirs.length) {
    raw.push(...(await readTranscripts({ dirs: personal.sources.transcriptDirs, sinceMs, idPrefix: "T" })));
  }

  // Threads from the team's approved channels (INPUT-1), saved by the collection task through the PM's own connectors.
  // Team runs and the digest read them; private to-dos come from meetings only.
  const channels = channelInputs(team);
  if (channels.length && o.scope !== "individual") raw.push(...(await readThreads({ dir: paths.threads(), sinceMs, idPrefix: "C" })));

  // Meeting identities come from participants and IDs, so they're worked out before redaction (MEET-1).
  const salt = await teamSalt(ctx.repo);
  for (const it of raw) if (it.kind === "transcript") { it.keys = meetingKeys(it, salt); it.legacyKeys = meetingKeys(it); }
  const individual = o.scope === "individual";
  const rules = privacyRules(ctx, individual);
  // One meeting saved from two recorders is read once (INPUT-2), from a copy this run may read.
  const { items: once, twins } = collapseTwins(raw, (i) => !!rules.blockedSources?.includes(sourceOf(i)));
  const filtered = filterItems(once, rules);

  const names = personal.crmNamesFile ? (await readFile(personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : [];
  const r = makeRedactor(names);
  const items = filtered.kept.map((it) => ({ ...it, title: r.redact(it.title), text: r.redact(it.text), participants: [] }));
  // Titles of used sources are redacted with a separate redactor, so the masking counts cover only what the model saw.
  const titles = makeRedactor(names);
  return {
    items, held: filtered.held, heldItems: filtered.heldItems, read: raw.length,
    receipt: {
      window: { days: o.days, since: new Date(sinceMs).toISOString(), scope: o.scope },
      rules: {
        internalDomains: rules.internalDomains, requireExternalParticipant: !individual, ...(individual ? { allowOneOnOne: true } : {}), topicRulesHash: topicRulesHash(),
        neverIngest: { people: personal.neverIngest.people.length, channels: personal.neverIngest.channels.length, meetingTitles: personal.neverIngest.meetingTitles.length },
        folders: team.allowedSources.includes("transcripts") ? personal.sources.transcriptDirs : [],
      },
      skippedSources,
      ...(twins ? { twins } : {}),
      sources: sourceReceipts(filtered.decisions, (t) => titles.redact(t)),
      masked: { ...r.counts },
      canaries: runCanaries(rules),
    },
  };
}
