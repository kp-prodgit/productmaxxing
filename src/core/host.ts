import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Fetch } from "../sources/slack.js";
import type { Exec } from "./exec.js";
import type { Git } from "./git.js";
import type { Keychain } from "./keychain.js";
import { updateState } from "./state.js";

/**
 * Where outputs land as pull requests (OUT-2). GitHub when the PMX repo has a GitHub remote,
 * otherwise local branches (single-player, no remote).
 */
export interface OutputHost {
  readonly kind: "github" | "local";
  openPr(o: { branch: string; base: string; title: string; body: string; labels?: string[] }): Promise<{ id: string; url: string }>;
  /**
   * Merges the draft. `unpushed` (R24, local host only) says, in a sentence for the PM, that the accept stands on this
   * Mac but didn't reach the team's repo.
   */
  accept(id: string): Promise<{ unpushed?: string } | void>;
  reject(id: string, comment: string): Promise<void>;
  comment(id: string, body: string): Promise<void>;
  /** Changed files with their content at the PR head, for the review queue. */
  files(id: string): Promise<{ path: string; content: string }[]>;
  isOpen(id: string): Promise<boolean>;
}

export function parseGitHubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export async function githubToken(keychain: Keychain, exec: Exec): Promise<string | null> {
  const k = await keychain.get("github-token");
  if (k) return k;
  const r = await exec("gh", ["auth", "token"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

export function githubHost(o: { owner: string; repo: string; token: string; fetch: Fetch; git: Git }): OutputHost {
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await o.fetch(`https://api.github.com/repos/${o.owner}/${o.repo}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${await res.text()}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    kind: "github",
    async openPr(p) {
      await o.git.ok(["push", "-u", "origin", p.branch]);
      const pr: any = await api("POST", "/pulls", { title: p.title, head: p.branch, base: p.base, body: p.body });
      if (p.labels?.length) await api("POST", `/issues/${pr.number}/labels`, { labels: p.labels }).catch(() => {});
      return { id: String(pr.number), url: pr.html_url };
    },
    async accept(id) {
      await api("PUT", `/pulls/${id}/merge`, { merge_method: "squash" });
    },
    async reject(id, comment) {
      await api("POST", `/issues/${id}/comments`, { body: comment });
      await api("PATCH", `/pulls/${id}`, { state: "closed" });
    },
    async comment(id, body) {
      await api("POST", `/issues/${id}/comments`, { body });
    },
    async files(id) {
      const pr: any = await api("GET", `/pulls/${id}`);
      const files: any[] = (await api("GET", `/pulls/${id}/files?per_page=100`)) as any[];
      const out: { path: string; content: string }[] = [];
      for (const f of files.filter((x) => x.status !== "removed").slice(0, 30)) {
        const c: any = await api("GET", `/contents/${encodeURI(f.filename)}?ref=${pr.head.sha}`);
        out.push({ path: f.filename, content: Buffer.from(c.content ?? "", "base64").toString("utf8") });
      }
      return out;
    },
    async isOpen(id) {
      const pr: any = await api("GET", `/pulls/${id}`);
      return pr.state === "open";
    },
  };
}

/** How a local draft is named to a PM: the task it drafts, or the team settings it holds. Never its branch. */
function draftWords(branch: string): { name: string; verb: string; it: string } {
  const task = branch.match(/^pmx\/task\/([A-Za-z][A-Za-z0-9]*-\d+)/)?.[1];
  if (task) return { name: task, verb: "accept", it: "this draft also changes" };
  if (/^pmx\/settings-/.test(branch)) return { name: "your team's settings", verb: "apply", it: "these settings also change" };
  return { name: "this draft", verb: "accept", it: "it also changes" };
}

const fileList = (xs: string[]) => (xs.length <= 3 ? xs.join(xs.length === 2 ? " and " : ", ").replace(/, ([^,]*)$/, ", and $1") : `${xs.slice(0, 2).join(", ")} and ${xs.length - 2} more files`);

/**
 * How PMX's own commits on a team repo's base are told from a PM's (D2-2). An accept, or a settings apply, is one commit
 * with one parent whose whole message is `Accept pmx/<branch>`: every PMX since the first wrote it so, through
 * `commit-tree` or `merge --squash` and `commit`. Its author is the PM's own git name, so the author can't tell. The
 * merge PMX makes when accepts don't rebase cleanly has two parents and its own message. Anything else is the PM's.
 */
const PMX_ACCEPT = /^Accept pmx\/\S+$/;
const PMX_MERGE = /^Merge your team's \S+ under accepted drafts \(PMX\)$/;
const mergeMessage = (base: string) => `Merge your team's ${base} under accepted drafts (PMX)`;
const NET_MS = 60000;
const lastLine = (t: string) => t.trim().split("\n").filter(Boolean).pop() || "git failed";

/** Why work on this Mac's base isn't in the team's repo (D2-2). */
export type Unshared = "unreachable" | "busy" | "clash" | "own" | "failed";

/** What a share left on this Mac only: PMX's accepts, the PM's own commits (short hash and subject), and why. */
export interface LeftHere {
  why: Unshared;
  accepts: number;
  own: string[];
  detail?: string;
}

export interface Shared {
  /** PMX's accepts that reached the team's repo now. */
  pushed: number;
  /** This Mac's base took the team's newer work with them. */
  pulled: boolean;
  left: LeftHere | null;
}

/** The commits this Mac's base has that origin's doesn't, as of the last fetch, leaving out any whose change origin already has. */
async function aheadOf(git: Git, base: string): Promise<{ accepts: number; own: string[]; commits: number } | null> {
  const range = [`refs/remotes/origin/${base}...refs/heads/${base}`];
  const all = await git.raw(["rev-list", "--count", `refs/remotes/origin/${base}..refs/heads/${base}`]);
  if (all.code !== 0) return null;
  const r = await git.raw(["log", "--right-only", "--cherry-pick", "--format=%H%x1f%P%x1f%B%x1e", ...range]);
  if (r.code !== 0) return null;
  let accepts = 0;
  const own: string[] = [];
  for (const rec of r.stdout.split("\x1e").map((x) => x.trim()).filter(Boolean)) {
    const [sha = "", parents = "", msg = ""] = rec.split("\x1f");
    const n = parents.split(" ").filter(Boolean).length, text = msg.trim();
    if (n === 1 && PMX_ACCEPT.test(text)) accepts++;
    else if (!(n === 2 && PMX_MERGE.test(text))) own.push(`${sha.slice(0, 7)} "${(text.split("\n")[0] ?? "").slice(0, 60)}"`);
  }
  return { accepts, own, commits: Number(all.stdout.trim()) || 0 };
}

/**
 * The team's newer work with this Mac's accepts on top, built in a worktree of its own so the PM's checkout isn't
 * touched: a rebase, or a merge when the accepts don't replay cleanly one by one. A clash aborts either, so nothing
 * changes anywhere.
 */
async function onTop(git: Git, old: string, theirs: string, base: string): Promise<{ sha: string } | { clash: true } | { failed: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pmx-share-"));
  const wt = join(dir, base.replace(/\W+/g, "-"));
  const ident = (await git.raw(["var", "GIT_COMMITTER_IDENT"])).code === 0 ? [] : ["-c", "user.name=pmx", "-c", "user.email=pmx@localhost"];
  try {
    const add = await git.raw(["worktree", "add", "--quiet", "--detach", wt, old]);
    if (add.code !== 0) return { failed: lastLine(add.stderr) };
    const tip = async () => ({ sha: await git.ok(["rev-parse", "HEAD"], { cwd: wt }) });
    const rb = await git.raw([...ident, "-c", "core.editor=true", "rebase", "--quiet", theirs], { cwd: wt });
    if (rb.code === 0) return tip();
    const clashed = (await git.raw(["diff", "--name-only", "--diff-filter=U"], { cwd: wt })).stdout.trim() !== "";
    await git.raw(["rebase", "--abort"], { cwd: wt });
    if (!clashed) return { failed: lastLine(rb.stderr || rb.stdout) };
    await git.raw(["checkout", "--quiet", "--detach", old], { cwd: wt });
    const mg = await git.raw([...ident, "merge", "--quiet", "--no-ff", "--no-edit", "-m", mergeMessage(base), theirs], { cwd: wt });
    if (mg.code === 0) return tip();
    await git.raw(["merge", "--abort"], { cwd: wt });
    return { clash: true };
  } finally {
    await git.raw(["worktree", "remove", "--force", wt]);
    await rm(dir, { recursive: true, force: true });
    await git.raw(["worktree", "prune"]);
  }
}

/**
 * Moves this Mac's base from `old` to `next`. Where it's checked out, `reset --keep` brings only the files that differ
 * up to date and refuses, changing nothing, when the PM has edits to one of them or a file of theirs is in the way.
 */
async function moveBase(git: Git, base: string, old: string, next: string): Promise<boolean> {
  const where = await checkedOutAt(git, base);
  if (where === null) return (await git.raw(["update-ref", "-m", "pmx: accepted drafts on top of the team's work", `refs/heads/${base}`, next, old])).code === 0;
  if ((await git.raw(["rev-parse", "--verify", `refs/heads/${base}`])).stdout.trim() !== old) return false;
  return (await git.raw(["reset", "--quiet", "--keep", next], { cwd: where })).code === 0;
}

/**
 * D2-2: puts this Mac's accepts in the team's repo when it isn't on GitHub. It fetches origin's base, and when origin
 * moved, rebases the accepts onto it (or merges, when a rebase isn't clean), then pushes: fast-forward only, never
 * forced. Only PMX's own commits go automatically (see PMX_ACCEPT): with a commit of the PM's on the base, nothing is
 * pushed, since a push sends every commit the base has. This Mac's base then takes the team's newer work, unless
 * `takeTheirs` is false (its config doesn't load, JOB-10) or the PM has edits in the way. A clash, an origin out of
 * reach or a git that fails leaves everything as it was, and `left` says why.
 */
export async function shareBase(git: Git, base: string, o: { fetched?: boolean; takeTheirs?: boolean } = {}): Promise<Shared> {
  const none: Shared = { pushed: 0, pulled: false, left: null };
  if (!(await git.hasRemote())) return none;
  const theirs = `refs/remotes/origin/${base}`, mine = `refs/heads/${base}`;
  const leave = async (why: Unshared, detail?: string): Promise<Shared> => {
    const a = await aheadOf(git, base);
    return a && (a.accepts || a.own.length) ? { ...none, left: { why, accepts: a.accepts, own: a.own, ...(detail ? { detail } : {}) } } : none;
  };
  for (let attempt = 0; ; attempt++) {
    if (!o.fetched || attempt > 0) {
      const f = await git.raw(["fetch", "--quiet", "origin", `+refs/heads/${base}:${theirs}`], { timeoutMs: NET_MS });
      if (f.code !== 0) return leave("unreachable", lastLine(f.stderr));
    }
    const ahead = await aheadOf(git, base);
    if (!ahead || !ahead.commits) return none;
    if (ahead.own.length) return { ...none, left: { why: "own", accepts: ahead.accepts, own: ahead.own } };
    const old = await git.ok(["rev-parse", "--verify", mine]);
    const at = await git.ok(["rev-parse", "--verify", theirs]);
    let next = old;
    if ((await git.raw(["merge-base", "--is-ancestor", theirs, mine])).code !== 0) {
      const built = await onTop(git, old, theirs, base);
      if ("clash" in built) return leave("clash");
      if ("failed" in built) return leave("failed", built.failed);
      next = built.sha;
    }
    if (next !== at) {
      const p = await git.raw(["push", "--quiet", "origin", `${next}:refs/heads/${base}`], { timeoutMs: NET_MS });
      if (p.code !== 0) {
        const newer = /rejected|non-fast-forward|fetch first|stale info/i.test(p.stderr);
        // Origin moved again since the fetch: once more from the top.
        if (newer && attempt === 0) continue;
        return leave(newer ? "busy" : "unreachable", lastLine(p.stderr));
      }
      await git.raw(["update-ref", theirs, next]);
    }
    const pulled = next !== old && o.takeTheirs !== false && (await moveBase(git, base, old, next));
    return { pushed: ahead.accepts, pulled, left: null };
  }
}

/** Saves how the last share went, for `pmx status`, Needs you and `pmx doctor` (D2-2). Never throws. */
export async function noteShared(git: Git, s: Shared, at = new Date().toISOString()): Promise<void> {
  if (!(await git.hasRemote())) return;
  await updateState((st) => { st.teamPush = { at, why: s.left?.why ?? null, detail: s.left?.detail ?? null }; }).catch(() => {});
}

const accepted = (n: number) => `${n} accepted draft${n === 1 ? "" : "s"}`;
const quote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

/** The commands that share this Mac's base with the team's repo by hand, every commit it has. */
async function byHand(git: Git, base: string): Promise<{ pull: string; push: string; both: string }> {
  const q = quote(git.cwd);
  const on = (await git.raw(["branch", "--show-current"])).stdout.trim() === base;
  const pull = `${on ? "" : `git -C ${q} switch ${base} && `}git -C ${q} pull --rebase origin ${base}`;
  const push = `git -C ${q} push origin ${base}`;
  return { pull, push, both: `${pull} && ${push}` };
}

/** The sentence an accept answers with when it stays on this Mac (R24, D2-2). */
async function leftNote(git: Git, base: string, what: string, left: LeftHere): Promise<string> {
  const cmd = await byHand(git, base);
  const only = `The ${what} is only on this Mac`;
  switch (left.why) {
    case "unreachable": return `${only} for now: PMX couldn't reach your team's repo. PMX's next background run tries again.`;
    case "busy": return `${only} for now: your team's repo kept changing while PMX pushed. PMX's next background run tries again.`;
    case "clash": return `${only}: it clashes with newer work in your team's repo, so PMX left both as they were. To share it, run ${cmd.pull} in Terminal, settle the clash as git says, then run ${cmd.push}.`;
    case "own": return `${only}: your ${base} there also has commits of your own (${left.own.slice(0, 2).join(", ")}${left.own.length > 2 ? ` and ${left.own.length - 2} more` : ""}), and PMX never pushes those for you. To push everything ${base} has, run ${cmd.both} in Terminal.`;
    default: return `${only}: PMX couldn't put it on top of your team's newer work (${left.detail ?? "git failed"}). To share it, run ${cmd.both} in Terminal.`;
  }
}

/**
 * D2-2: what this Mac's base has that the team's repo doesn't (not on GitHub), in words with exactly what to run, for
 * `pmx status`, Needs you and `pmx doctor`. `needsYou` when PMX can't do it itself. Null when there's nothing.
 */
export async function unsharedWork(git: Git, last: { why: Unshared | null; detail?: string | null } | null | undefined): Promise<{ text: string; needsYou: boolean } | null> {
  const url = await git.remoteUrl();
  if (!url || parseGitHubRemote(url)) return null;
  const base = await git.defaultBranch();
  const a = await aheadOf(git, base);
  if (!a || (!a.accepts && !a.own.length)) return null;
  const cmd = await byHand(git, base);
  const one = a.accepts === 1, n = accepted(a.accepts), are = one ? "is" : "are", them = one ? "it" : "them";
  if (a.own.length) {
    const mine = `${a.own.length} commit${a.own.length === 1 ? "" : "s"} of your own (${a.own.slice(0, 2).join(", ")}${a.own.length > 2 ? ` and ${a.own.length - 2} more` : ""})`;
    return { needsYou: true, text: `Your ${base} on this Mac has ${mine}${a.accepts ? ` and ${n}` : ""} that your team's repo doesn't, and PMX never pushes your own commits for you: a push sends every commit ${base} has. To push them all, run: ${cmd.both}` };
  }
  const why = last?.why ?? null;
  const detail = last?.detail ? ` (${last.detail})` : "";
  if (why === "clash") return { needsYou: true, text: `${n} ${are} only on this Mac: ${one ? "it clashes" : "they clash"} with newer work in your team's repo, so PMX left ${them} as ${one ? "it was" : "they were"}. Run ${cmd.pull}, settle the clash as git says, then run ${cmd.push}` };
  if (why === "unreachable") return { needsYou: true, text: `${n} ${are} only on this Mac: PMX couldn't reach your team's repo${detail}. PMX tries again on each background run; to push ${them} yourself, run: ${cmd.both}` };
  if (why === "failed") return { needsYou: true, text: `${n} ${are} only on this Mac: PMX couldn't put ${them} on top of your team's newer work${detail}. Run: ${cmd.both}` };
  return { needsYou: false, text: `${n} ${are} only on this Mac until PMX's next background run pushes ${them} to your team's repo (or run: ${cmd.both})` };
}

/**
 * R24, D2-2: an accept on a team repo that isn't on GitHub goes to the team's repo at once, on top of any newer work
 * there; when it can't, the accept stands on this Mac and one sentence says why and what to run. No origin: nothing.
 */
async function share(git: Git, base: string, what: string): Promise<{ unpushed?: string }> {
  const s = await shareBase(git, base);
  await noteShared(git, s);
  return s.left ? { unpushed: await leftNote(git, base, what, s.left) } : {};
}

/** The folder where `branch` is checked out, in the PM's checkout or any other worktree; null when nowhere. */
async function checkedOutAt(git: Git, branch: string): Promise<string | null> {
  await git.raw(["worktree", "prune"]);
  let at: string | null = null;
  for (const line of (await git.ok(["worktree", "list", "--porcelain"])).split("\n")) {
    if (line.startsWith("worktree ")) at = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && at) return at;
  }
  return null;
}

/** Every path with the person's own changes in a checkout: edited, staged, deleted, renamed or new. */
async function ownChanges(git: Git, cwd: string): Promise<Set<string>> {
  const out = new Set<string>();
  // Not trimmed: each entry starts with a two-letter status, often a space.
  const r = await git.raw(["status", "--porcelain", "-z", "--untracked-files=all"], { cwd });
  if (r.code !== 0) throw new Error(`git status: ${r.stderr.trim()}`);
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    out.add(e.slice(3));
    // A rename or copy carries its old path in the next entry.
    if (/^[RC]/.test(e)) out.add(parts[++i] ?? "");
  }
  return out;
}

/**
 * Local branches stand in for PRs. Accepting squashes a draft onto the team's base branch without touching the
 * person's own work (REV-4): the commit is built in git's store from the base and the draft alone, so nothing the
 * person edited or staged is swept into it. Where the base is checked out, only the draft's own files are brought up
 * to date there, and a draft that changes a file the person is still editing waits until they save or undo it. With
 * something else checked out, the working files aren't touched at all.
 */
export function localHost(git: Git): OutputHost {
  return {
    kind: "local",
    async openPr(p) {
      return { id: p.branch, url: `branch:${p.branch}` };
    },
    async accept(branch) {
      const d = draftWords(branch);
      const what = d.verb === "apply" ? "applied settings change" : "accepted draft";
      const base = await git.defaultBranch();
      const old = await git.ok(["rev-parse", "--verify", `refs/heads/${base}^{commit}`]);
      if ((await git.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code !== 0) throw new Error(`PMX can't ${d.verb} ${d.name}: it isn't on this Mac any more.`);
      const where = await checkedOutAt(git, base);
      const m = await git.raw(["merge-tree", "--write-tree", "--no-messages", old, branch]);
      if (m.code === 1) throw new Error(`PMX can't ${d.verb} ${d.name}: it changes part of a file that has also changed since it was drafted. Ask for a redo, and the agent drafts it again from the latest.`);
      if (m.code !== 0 && !(m.code === 129 || /usage|unknown option/i.test(m.stderr))) throw new Error(`PMX can't ${d.verb} ${d.name}: saving it failed (${m.stderr.trim().split("\n")[0] || `code ${m.code}`}).`);
      if (m.code !== 0) {
        // A git older than 2.38 can't build the result on the side: the old way still works with nothing else open.
        if (where !== null && (await git.ok(["status", "--porcelain", "--untracked-files=no"], { cwd: where })) === "") {
          await git.ok(["merge", "--squash", branch], { cwd: where });
          await git.ok(["commit", "-q", "-m", `Accept ${branch}`], { cwd: where });
          await git.raw(["branch", "-D", branch]);
          return share(git, base, what);
        }
        throw new Error(`PMX can't ${d.verb} ${d.name} on this Mac while other work is open: its developer tools are too old. Update them (in Terminal: xcode-select --install), then ${d.verb} again.`);
      }
      const tree = m.stdout.split("\n")[0]!.trim();
      const changed = (await git.ok(["diff", "--name-status", "-z", "--no-renames", old, tree])).split("\0").filter(Boolean);
      const files: { status: string; path: string }[] = [];
      for (let i = 0; i + 1 < changed.length; i += 2) files.push({ status: changed[i]!, path: changed[i + 1]! });
      if (where !== null) {
        const mine = await ownChanges(git, where);
        // A file the draft adds that's already on disk (new, or one git ignores) is the person's too.
        const onDisk = async (f: { status: string; path: string }) => f.status === "A" && (await stat(join(where, f.path)).then(() => true, () => false));
        const clash: string[] = [];
        for (const f of files) if (mine.has(f.path) || (await onDisk(f))) clash.push(f.path);
        if (clash.length) throw new Error(`PMX can't ${d.verb} ${d.name} yet: you have unsaved edits to ${fileList(clash)}, which ${d.it}. Save or undo them, then ${d.verb} again.`);
      }
      if (files.length) {
        const ident = (await git.raw(["var", "GIT_COMMITTER_IDENT"])).code === 0 ? [] : ["-c", "user.name=pmx", "-c", "user.email=pmx@localhost"];
        const commit = await git.ok([...ident, "commit-tree", tree, "-p", old, "-m", `Accept ${branch}`]);
        // Guarded by the base as PMX read it: if anything moved it meanwhile, nothing changes and the PM can try again.
        const moved = await git.raw(["update-ref", "-m", `pmx: accept ${branch}`, `refs/heads/${base}`, commit, old]);
        if (moved.code !== 0) throw new Error(`PMX can't ${d.verb} ${d.name} right now: your team's work changed while it was saving. Try again in a moment.`);
        if (where !== null) {
          const keep = files.filter((f) => f.status !== "D").map((f) => f.path), gone = files.filter((f) => f.status === "D").map((f) => f.path);
          if (keep.length) await git.ok(["checkout", commit, "--", ...keep], { cwd: where });
          if (gone.length) await git.ok(["rm", "-q", "-f", "--ignore-unmatch", "--", ...gone], { cwd: where });
        }
      }
      await git.raw(["branch", "-D", branch]);
      return files.length ? share(git, base, what) : {};
    },
    async reject(branch) {
      await git.raw(["branch", "-D", branch]);
    },
    async comment() {},
    async files(branch) {
      const base = await git.defaultBranch();
      const names = (await git.ok(["diff", "--name-only", "--diff-filter=d", `${base}...${branch}`])).split("\n").filter(Boolean);
      const out: { path: string; content: string }[] = [];
      for (const n of names) out.push({ path: n, content: await git.ok(["show", `${branch}:${n}`]) });
      return out;
    },
    async isOpen(branch) {
      if ((await git.raw(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code !== 0) return false;
      // R22: a branch a teammate already merged into the team's base (origin's, or this repo's own without a remote)
      // isn't waiting any more, though its local copy is still here.
      const base = await git.defaultBranch();
      const into = (await git.hasRemote()) ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
      return (await git.raw(["merge-base", "--is-ancestor", `refs/heads/${branch}`, into])).code !== 0;
    },
  };
}

export async function outputHost(git: Git, keychain: Keychain, exec: Exec, f: Fetch): Promise<OutputHost> {
  const url = await git.remoteUrl();
  const gh = url ? parseGitHubRemote(url) : null;
  if (gh) {
    const token = await githubToken(keychain, exec);
    if (!token) throw new Error("The PMX repo is on GitHub but no GitHub token was found. Run `pmx init` or `gh auth login`.");
    return githubHost({ ...gh, token, fetch: f, git });
  }
  return localHost(git);
}
