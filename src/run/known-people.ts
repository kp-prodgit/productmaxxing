import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ctx } from "../core/context.js";
import { buildKnown, type KnownPeople } from "../core/people-swap.js";
import { EVIDENCE_REFS, paths, RUNLOG_BRANCH, TASK_STATE_REFS } from "../core/paths.js";
import type { SignalItem } from "../core/types.js";
import { privacyRules } from "../digest/gather.js";
import { channelInputs } from "../inputs/inputs.js";
import { speakerLabel } from "../core/tracker-text.js";
import { readThreads, readTranscripts } from "../sources/transcripts.js";
import { crmCompanies } from "./web-guard.js";

/**
 * R5a: everyone this Mac knows by name, for the name swap (`peopleSwap`'s `known`), so a person a task's own sources
 * name only in passing ("Lee at Globex said…", "Avery's legal question", "w/ Sean") is still swapped: the participants,
 * speakers and names of every meeting and thread in the PM's allowlisted folders, the CRM and do-not-read lists, and the
 * team's own people (the team's settings, its code owners, who wrote its run log and its packs, and this PM). Read for
 * redaction only: in memory, never written, never shown.
 */
export async function knownPeople(ctx: Ctx): Promise<KnownPeople> {
  const c = cache.get(ctx);
  if (c && Date.now() - c.at < FRESH_MS) return c.p;
  const p = read(ctx).catch(() => ({ people: [], strong: [] }));
  cache.set(ctx, { at: Date.now(), p });
  return p;
}

/**
 * R6 (D2-1, rig test of #122): the companies this Mac knows, for the tracker guard's `known`: the CRM list's companies
 * (a legal form, an "&" or a domain: "Vandelay & Sons", "Initrode GmbH") and every company and product its collected
 * meetings and threads show (`knownPeople`'s `things`). So "Ask Hart & Stone for the order form", typed with no meeting
 * behind it, still goes. In memory only.
 */
export async function knownThings(ctx: Ctx): Promise<string[]> {
  const crm = ctx.personal.crmNamesFile ? (await readFile(ctx.personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : [];
  return [...new Set([...crmCompanies(crm), ...((await knownPeople(ctx)).things ?? [])])];
}

/** One background run or agent run reads it once; a long-lived process reads it again after a few minutes. */
const FRESH_MS = 5 * 60000;
const cache = new WeakMap<object, { at: number; p: Promise<KnownPeople> }>();
/** The newest files are read whole; older ones give their participants and speakers, so a long history stays quick. */
const WHOLE = 400;
/** Handles that are PMX's or a template's, never a person's. */
const NOT_PEOPLE = new Set(["pmx", "test", "localhost", "noreply", "no-reply", "bot", "ci", "github-actions"]);

async function read(ctx: Ctx): Promise<KnownPeople> {
  const { team, personal } = ctx;
  const items: SignalItem[] = [];
  if (team.allowedSources.includes("transcripts") && personal.sources.transcriptDirs.length)
    items.push(...(await readTranscripts({ dirs: personal.sources.transcriptDirs, sinceMs: 0 }).catch(() => [])));
  if (channelInputs(team).length) items.push(...(await readThreads({ dir: paths.threads(), sinceMs: 0 }).catch(() => [])));
  items.sort((a, b) => b.at.localeCompare(a.at));
  const sources = items.map((it, i) => ({
    participants: it.participants ?? [],
    text: i < WHOLE ? it.text : it.text.split("\n").filter((l) => speakerLabel(l)).join("\n"),
  }));
  const listed = [
    ...(personal.crmNamesFile ? (await readFile(personal.crmNamesFile, "utf8").catch(() => "")).split("\n") : []),
    ...(personal.neverIngest?.people ?? []),
  ].map((n) => n.trim()).filter((n) => n.length >= 3);
  return buildKnown({ items: sources, listed, team: await teamPeople(ctx), internalDomains: privacyRules(ctx).internalDomains });
}

/** The team's own people, as handles, names or addresses: never a template's placeholder or PMX itself. */
async function teamPeople(ctx: Ctx): Promise<string[]> {
  const { team, personal, repo } = ctx;
  const handle = (s: string) => s.replace(/@.*$/, "").trim();
  const out = [
    personal.handle, ...(personal.identity?.names ?? []), ...(personal.identity?.emails ?? []),
    ...[team.synthesizer, team.productLead].filter((x): x is string => !!x).map(handle),
  ];
  // Code owners: "@lee-park", "lee@us.example"; not a team ("@org/pms") or a placeholder ("@HEAD-OF-PRODUCT").
  for (const f of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    const text = await readFile(join(personal.repoPath, f), "utf8").catch(() => "");
    for (const line of text.split("\n")) {
      if (/^\s*#/.test(line)) continue;
      for (const m of line.matchAll(/(?:^|\s)@([A-Za-z0-9][\w.-]*)(?=\s|$)/g)) if (!/^[A-Z0-9_-]+$/.test(m[1]!)) out.push(m[1]!);
      for (const m of line.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) out.push(m[0]);
    }
  }
  // Who wrote the run log, the packs and the task marks: each PM's `<handle>@<machine>` or `<handle>@pmx.local`.
  const authors = async (args: string[]) => (await repo.raw(args).catch(() => ({ code: 1, stdout: "" }))).stdout.split("\n");
  for (const ref of [RUNLOG_BRANCH, `origin/${RUNLOG_BRANCH}`]) out.push(...(await authors(["log", "--format=%ae", "-n", "2000", ref, "--"])).map(handle));
  out.push(...(await authors(["for-each-ref", "--format=%(authoremail)", EVIDENCE_REFS, TASK_STATE_REFS, "refs/pmx/remote-evidence"])).map((e) => handle(e.replace(/^<|>$/g, ""))));
  return [...new Set(out.map((x) => x.trim()).filter((x) => x && !NOT_PEOPLE.has(x.toLowerCase())))];
}
