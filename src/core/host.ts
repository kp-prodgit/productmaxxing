import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Fetch } from "../sources/slack.js";
import type { Exec } from "./exec.js";
import type { Git } from "./git.js";
import type { Keychain } from "./keychain.js";

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
 * R24: a team repo that isn't on GitHub shares its base branch through origin, so an accept made here goes there too:
 * a plain push, fast-forward only, never forced. When origin has newer work or can't be reached, the accept stands on
 * this Mac and the sentence says so, once. A repo with no origin has nowhere to push.
 */
async function pushBase(git: Git, base: string, what: string): Promise<{ unpushed?: string }> {
  if (!(await git.hasRemote())) return {};
  const r = await git.raw(["push", "--quiet", "origin", `refs/heads/${base}:refs/heads/${base}`]);
  if (r.code === 0) return {};
  const why = /rejected|non-fast-forward|fetch first|stale info/i.test(r.stderr)
    ? "your team's repo has newer work, so PMX didn't push over it"
    : "PMX couldn't reach your team's repo";
  return { unpushed: `The ${what} is only on this Mac until you run git push in your team repo: ${why}.` };
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
          return pushBase(git, base, what);
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
      return files.length ? pushBase(git, base, what) : {};
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
