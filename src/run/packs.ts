import { hasCanary } from "../core/canary.js";
import type { Git } from "../core/git.js";
import { EVIDENCE_REFS } from "../core/paths.js";
import type { Evidence } from "./evidence.js";

/**
 * Evidence packs (RUN-5). When a PM approves a task, the Mac that suggested it writes the passages the drafting agent
 * would get there (RUN-3: the task's own cited sources, screened by the privacy rules and redacted) to the team repo,
 * so any PM's agent can draft it. A pack holds the task's identifier, when it was written, and per cited source its ID,
 * kind, date and passages. R5: its passages name no one (every person PMX finds is a placeholder, `nameSwap`), and it
 * lists the sources' outside companies as their email domains name them ("globex"), so a Mac drafting from it never
 * takes a customer for a person. Nothing else: no meeting title, no participants, no address, no other meeting, no
 * receipt.
 *
 * Each pack is one file, `<identifier>.json`, in a commit of its own at `refs/pmx/evidence/<identifier>`, the way PMX
 * keeps claims (src/lease/git-ref.ts) and the meeting ledger (src/meetings/git-ledger.ts): never on the team's main
 * branch and never reviewed, since it's data, not team settings. Built in git's store with no checkout, so the PM's own
 * work is never touched. A ref per task, not one shared branch, so removing a pack deletes it: a branch would keep
 * every removed pack in its history unless someone force-pushed it, and PMX never does. Teammates' writes never meet,
 * except two writes of the same task: a push is never forced, so the later one is refused, fetches, and builds on top.
 * Without a remote the refs are local (a team of one).
 */
export interface EvidencePack {
  v: 1;
  task: string;
  /** When it was written (ISO). A pack whose task is gone from the tracker is removed once the tracker is newer. */
  at: string;
  /**
   * R5: the name swap its passages went through (NAME_SWAP). A pack without it was written before PMX swapped the
   * names it finds, so it still names people: the Mac that wrote it rewrites it, and a reader swaps them meanwhile.
   */
  nameSwap?: number;
  /** R5: the sources' outside companies, their participants' email domains' names ("globex"). Never a person. */
  companies?: string[];
  sources: Evidence["sources"];
}

/**
 * R5: the name swap new packs' passages go through. A higher one later makes every Mac rewrite the packs it wrote.
 * 2 (R5a, R5c): every name this Mac knows, possessives, and company runs; packs from the first R5 swap are rewritten.
 * 3: a brand or an imprint written as a thing ("the Saltwind face", "two imprints, Saltwind and Juniper Lane") is no
 * one's name, and a placeholder spells its company as the sources do, never on past a sentence ("Hooli Works").
 */
export const NAME_SWAP = 3;
/** Whether a pack's passages went through today's name swap. */
export const swappedPack = (p: Partial<EvidencePack> | null | undefined): boolean => typeof p?.nameSwap === "number" && p.nameSwap >= NAME_SWAP;

/** An email domain's name, as a pack's companies are written: "globex", "acme-corp". */
const COMPANY = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A pack's companies as data (R5): domain names only, at most 20. Anyone with the team repo can write a pack. */
export function packCompanies(raw: unknown): string[] {
  const c = (raw as Partial<EvidencePack> | null)?.companies;
  return Array.isArray(c) ? [...new Set(c.filter((x): x is string => typeof x === "string" && COMPANY.test(x)))].slice(0, 20) : [];
}

const MIRROR = "refs/pmx/remote-evidence";
const ZERO = "0000000000000000000000000000000000000000";
/** A tracker identifier a pack can be kept under, like PMX-12. */
export const TASK = /^[A-Za-z][A-Za-z0-9]*-\d+$/;
const SOURCE = /^[A-Z]\d+$/;
/** The bounds taskEvidence keeps (src/run/evidence.ts), with room for its ellipsis: a pack can't carry more. */
const LIMITS = { passages: 8, passage: 701, source: 4100 };

const firstLine = (s: string) => s.trim().split("\n").map((l) => l.replace(/^(fatal|error|remote):\s*/i, "").trim()).find(Boolean)?.slice(0, 200) ?? "git failed";

/**
 * A pack's passages as data an agent may read: only the task's own source IDs, only their kind, date and passages,
 * within taskEvidence's bounds, with bracketed IDs and the end of the data block neutralized again (SEC-1). Anyone with
 * the team repo can write these refs, so what comes back is checked like any other input.
 */
export function packSources(raw: unknown, sources: string[]): Evidence["sources"] {
  const p = raw as Partial<EvidencePack> | null;
  if (!p || p.v !== 1 || !Array.isArray(p.sources)) return [];
  const want = new Set(sources);
  const out: Evidence["sources"] = [];
  for (const s of p.sources as any[]) {
    if (!s || typeof s.id !== "string" || !SOURCE.test(s.id) || !want.has(s.id) || out.some((x) => x.id === s.id)) continue;
    if (s.kind !== "meeting" && s.kind !== "thread") continue;
    if (typeof s.at !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s.at)) continue;
    if (!Array.isArray(s.passages)) continue;
    let size = 0;
    const passages: string[] = [];
    for (const x of s.passages.slice(0, LIMITS.passages)) {
      if (typeof x !== "string" || !x.trim()) continue;
      const t = x.slice(0, LIMITS.passage).replace(/\[([A-Z]\d+)\]/g, "($1)").replaceAll("</task_data>", "[removed]");
      if (size + t.length > LIMITS.source && passages.length) break;
      size += t.length;
      passages.push(t);
    }
    if (passages.length) out.push({ id: s.id, kind: s.kind, at: s.at, passages });
  }
  return out;
}

export interface EvidenceStore {
  /** The identifiers of tasks with a pack, fetched from the team repo now: a teammate may have written one since. */
  list(): Promise<string[]>;
  read(identifier: string): Promise<EvidencePack | null>;
  /**
   * The handle of the PM whose Mac first wrote a task's pack (its first commit's `<handle>@pmx.local`), or null. That
   * Mac holds the task's synthesis run, so it's the Mac that suggested the task. Data like the pack: checked, not trusted.
   */
  writer(identifier: string): Promise<string | null>;
  /** Adds or replaces packs and removes others. Returns what changed; throws with a reason when it can't. */
  write(o: { put?: EvidencePack[]; remove?: string[] }, message: string): Promise<{ put: string[]; removed: string[] }>;
}

export function evidenceStore(git: Git, o: { email?: string } = {}): EvidenceStore {
  const ident = ["-c", "user.name=pmx", "-c", `user.email=${(o.email ?? "pmx@localhost").replace(/[^\w.@-]/g, "")}`];
  let synced: Promise<string> | null = null;
  /**
   * Where the team's packs are read from: a mirror of the remote's, else the local refs. Fetched with prune once per
   * store for reads, and again for every list (N7), so a pack a teammate wrote or removed since is seen.
   */
  const base = (): Promise<string> => (synced ??= (async () => {
    if (!(await git.hasRemote())) return EVIDENCE_REFS;
    const f = await git.raw(["fetch", "--quiet", "--prune", "origin", `+${EVIDENCE_REFS}/*:${MIRROR}/*`]);
    if (f.code !== 0) throw new Error(`it couldn't reach your team's repo (${firstLine(f.stderr)})`);
    return MIRROR;
  })());
  const tip = async (ref: string) => {
    const r = await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  };
  /** The commit the team has for one task now: fetched again after a refused push. */
  const fetchOne = async (id: string): Promise<string | null> => {
    const f = await git.raw(["fetch", "--quiet", "origin", `+${EVIDENCE_REFS}/${id}:${MIRROR}/${id}`]);
    if (f.code !== 0) {
      if (!/couldn't find remote ref|no such ref|not our ref/i.test(f.stderr)) throw new Error(`it couldn't reach your team's repo (${firstLine(f.stderr)})`);
      await git.raw(["update-ref", "-d", `${MIRROR}/${id}`]);
      return null;
    }
    return tip(`${MIRROR}/${id}`);
  };
  const treeOf = async (commit: string | null) => (commit ? (await git.raw(["rev-parse", `${commit}^{tree}`])).stdout.trim() : null);

  async function put(p: EvidencePack, message: string): Promise<boolean> {
    // FLOW-3: a canary in a pack means a privacy rule let a test meeting through. Nothing of it reaches the team repo.
    if (hasCanary(JSON.stringify(p))) throw new Error("a privacy rule let PMX's test meeting through, so nothing was sent; run `pmx doctor`");
    const at = await base();
    const remote = at === MIRROR;
    const companies = packCompanies(p);
    const body = { v: 1, task: p.task, at: p.at, ...(p.nameSwap ? { nameSwap: p.nameSwap } : {}), ...(companies.length ? { companies } : {}), sources: p.sources };
    const blob = await git.ok(["hash-object", "-w", "--stdin"], { input: JSON.stringify(body, null, 2) + "\n" });
    const tree = await git.ok(["mktree"], { input: `100644 blob ${blob}\t${p.task}.json\n` });
    let cur = await tip(`${at}/${p.task}`);
    for (let attempt = 0; ; attempt++) {
      if (cur && (await treeOf(cur)) === tree) return false;
      // A change to a pack builds on the one there, so the push is a fast-forward and never needs force.
      const commit = await git.ok([...ident, "commit-tree", tree, ...(cur ? ["-p", cur] : []), "-m", message]);
      if (remote) {
        const push = await git.raw(["push", "--quiet", "--porcelain", "origin", `${commit}:${EVIDENCE_REFS}/${p.task}`]);
        if (push.code === 0) { await git.raw(["update-ref", `${MIRROR}/${p.task}`, commit]); return true; }
        const why = `${push.stdout}\n${push.stderr}`;
        if (!/rejected|non-fast-forward|fetch first|stale info|already exists/i.test(why) || attempt >= 4) throw new Error(`your team's repo didn't take it (${firstLine(push.stderr || push.stdout)})`);
        cur = await fetchOne(p.task);
        continue;
      }
      if ((await git.raw(["update-ref", `${EVIDENCE_REFS}/${p.task}`, commit, cur ?? ZERO])).code === 0) return true;
      if (attempt >= 4) throw new Error(`its record in the team repo kept changing`);
      cur = await tip(`${EVIDENCE_REFS}/${p.task}`);
    }
  }

  async function remove(id: string): Promise<boolean> {
    const at = await base();
    if (at !== MIRROR) {
      const cur = await tip(`${EVIDENCE_REFS}/${id}`);
      return !!cur && (await git.raw(["update-ref", "-d", `${EVIDENCE_REFS}/${id}`, cur])).code === 0;
    }
    if (!(await tip(`${MIRROR}/${id}`))) return false;
    const r = await git.raw(["push", "--quiet", "--porcelain", "origin", `:${EVIDENCE_REFS}/${id}`]);
    await git.raw(["update-ref", "-d", `${MIRROR}/${id}`]);
    if (r.code === 0) return true;
    // A teammate removed it first.
    if (/remote ref does not exist|unable to delete/i.test(`${r.stdout}\n${r.stderr}`)) return false;
    throw new Error(`your team's repo didn't take it (${firstLine(r.stderr || r.stdout)})`);
  }

  return {
    async list() {
      synced = null;
      const at = await base();
      return (await git.ok(["for-each-ref", "--format=%(refname)", at])).split("\n").map((r) => r.slice(at.length + 1)).filter((id) => TASK.test(id));
    },
    async read(identifier) {
      if (!TASK.test(identifier)) return null;
      const r = await git.raw(["show", `${await base()}/${identifier}:${identifier}.json`]);
      if (r.code !== 0) return null;
      try {
        const p = JSON.parse(r.stdout);
        if (!p || p.v !== 1 || typeof p.at !== "string" || !Array.isArray(p.sources)) return null;
        const companies = packCompanies(p);
        return { v: 1, task: identifier, at: p.at, ...(typeof p.nameSwap === "number" ? { nameSwap: p.nameSwap } : {}), ...(companies.length ? { companies } : {}), sources: p.sources };
      } catch {
        return null;
      }
    },
    async writer(identifier) {
      if (!TASK.test(identifier)) return null;
      const r = await git.raw(["log", "--max-parents=0", "--format=%ae", `${await base()}/${identifier}`, "--"]);
      if (r.code !== 0) return null;
      return r.stdout.trim().split("\n").at(-1)?.match(/^([A-Za-z0-9][\w.-]{0,39})@pmx\.local$/)?.[1] ?? null;
    },
    async write(w, message) {
      const done = { put: [] as string[], removed: [] as string[] };
      for (const p of (w.put ?? []).filter((x) => TASK.test(x.task))) if (await put(p, message)) done.put.push(p.task);
      for (const id of (w.remove ?? []).filter((x) => TASK.test(x))) if (await remove(id)) done.removed.push(id);
      return done;
    },
  };
}
