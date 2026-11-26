import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { SignalItem } from "../core/types.js";

/** Text transcripts only. Audio recordings are never ingested (SEC-8: recording ingestion off). */
const TEXT_EXT = new Set([".md", ".txt", ".vtt", ".srt"]);

export interface ParsedTranscript {
  title: string;
  date: string | null;
  participants: string[];
  body: string;
  /** Set by `pmx collect` front matter (COLLECT-1). */
  source: string | null;
  sourceId: string | null;
  owner: string | null;
  /** "thread" for a channel conversation (INPUT-1); null for a meeting. */
  kind: string | null;
  /** Threads: the approved place, as the team listed it, and the thread's link. */
  place: string | null;
  link: string | null;
  /** The code of the `pmx collect` run that wrote the file (COLLECT-3). */
  run: string | null;
  /** "team" when the synthesis Mac collected it for the team, not only the PM's own (COLLECT-4). */
  scope: string | null;
}

const splitList = (s: string) =>
  s.replace(/^\[|\]$/g, "").split(/[,;]/).map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);

export function parseTranscript(raw: string, fallbackTitle: string): ParsedTranscript {
  let title = fallbackTitle;
  let date: string | null = null;
  let participants: string[] = [];
  let body = raw.replace(/^﻿/, "");

  const fm = body.match(/^---\n([\s\S]*?)\n---\n?/);
  const header = fm ? fm[1]! : body.split(/\n\s*\n/, 1)[0] ?? "";
  const fields = new Map<string, string>();
  for (const line of header.split("\n")) {
    const m = line.match(/^\s*(title|date|participants|attendees|source|source_id|owner|kind|place|link|run|scope)\s*:\s*(.+)$/i);
    if (m) fields.set(m[1]!.toLowerCase(), m[2]!.trim());
  }
  if (fields.size) {
    title = fields.get("title") ?? title;
    date = fields.get("date") ?? null;
    participants = splitList(fields.get("participants") ?? fields.get("attendees") ?? "");
    body = fm ? body.slice(fm[0].length) : body.slice(header.length);
  }
  // WebVTT/SRT cue numbers and timestamps carry no meaning for synthesis.
  body = body
    .replace(/^WEBVTT.*$/m, "")
    .replace(/^\d+\s*$/gm, "")
    .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3} --> .*$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const clean = (v: string | undefined) => (v ? v.replace(/^["']|["']$/g, "").trim() || null : null);
  return {
    title: title.replace(/^["']|["']$/g, ""), date, participants, body,
    source: clean(fields.get("source"))?.toLowerCase() ?? null, sourceId: clean(fields.get("source_id")), owner: clean(fields.get("owner")),
    kind: clean(fields.get("kind"))?.toLowerCase() ?? null, place: clean(fields.get("place")), link: clean(fields.get("link")),
    run: clean(fields.get("run")), scope: clean(fields.get("scope"))?.toLowerCase() ?? null,
  };
}

export interface TranscriptOpts {
  dirs: string[];
  sinceMs: number;
  idPrefix?: string;
}

/** Reads transcript files from the PM's allowlisted folders only (SIG-1, B2). No recursion into other folders. */
export async function readTranscripts(o: TranscriptOpts): Promise<SignalItem[]> {
  const items: SignalItem[] = [];
  let n = 0;
  for (const dir of o.dirs.map((d) => resolve(d))) {
    let names: string[] = [];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      if (!TEXT_EXT.has(extname(name).toLowerCase()) || name.startsWith(".")) continue;
      const path = join(dir, name);
      const s = await stat(path);
      if (!s.isFile() || s.mtimeMs < o.sinceMs) continue;
      const p = parseTranscript(await readFile(path, "utf8"), basename(name, extname(name)));
      if (p.kind === "thread") continue; // threads are read from their own folder, against the team's approved places
      items.push({
        id: `${o.idPrefix ?? "T"}${++n}`,
        kind: "transcript",
        ref: path,
        title: p.title,
        at: p.date ?? new Date(s.mtimeMs).toISOString().slice(0, 10),
        participants: p.participants,
        text: p.body,
        ...(p.source ? { origin: { source: p.source, sourceId: p.sourceId } } : {}),
        ...(p.scope === "team" ? { forTeam: { owner: p.owner } } : p.owner ? { owner: p.owner } : {}),
      });
    }
  }
  return items;
}

export interface ThreadOpts {
  dir: string;
  sinceMs: number;
  idPrefix?: string;
}

/** Threads the collection task saved from approved channels (INPUT-1). Whether each place is still approved is the filter's call. */
export async function readThreads(o: ThreadOpts): Promise<SignalItem[]> {
  const dir = resolve(o.dir);
  const names = (await readdir(dir).catch(() => [] as string[])).sort();
  const items: SignalItem[] = [];
  for (const name of names) {
    if (extname(name).toLowerCase() !== ".md" || name.startsWith(".")) continue;
    const path = join(dir, name);
    const s = await stat(path);
    if (!s.isFile() || s.mtimeMs < o.sinceMs) continue;
    const p = parseTranscript(await readFile(path, "utf8"), basename(name, ".md"));
    if (p.kind !== "thread" || !p.source || !p.place || !p.body) continue;
    items.push({
      id: `${o.idPrefix ?? "C"}${items.length + 1}`,
      kind: "thread",
      // The thread's own link when the connector gave one, so a citation opens it; otherwise the file.
      ref: p.link && /^https:\/\//.test(p.link) ? p.link : path,
      title: p.title || p.place,
      at: p.date ?? new Date(s.mtimeMs).toISOString(),
      participants: p.participants,
      text: p.body,
      origin: { source: p.source, sourceId: p.sourceId },
      place: p.place,
    });
  }
  return items;
}
