// INSTALL-3, INSTALL-4: `pmx install`, the one command that puts PMX on a Mac, runnable before PMX is installed as
// `npx --yes productmaxxing@latest install`. npm exec runs the package's command: both of its bins (`pmx` and
// `productmaxxing`) are the same file, which npm takes as one command (and `productmaxxing` matches the package's name
// besides), so `npx productmaxxing install` runs this. It checks the Mac, installs PMX where npm can write without sudo,
// puts its folder on PATH when a new Terminal window wouldn't find `pmx`, and, for the team's product lead only, offers
// PMX Engine. In a terminal on a Mac not set up yet it then goes straight on to `pmx init` (INSTALL-3), so installing and
// setting up are one command. Everything it runs or writes goes through `InstallDeps`, so tests install nothing.
import { access, constants, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import type { Asker } from "../core/ask.js";
import { isProductLead, type PersonalConfig, type TeamConfig } from "../core/config.js";
import type { Exec } from "../core/exec.js";
import { nodeSupported } from "../core/claude-bin.js";
import { stableNode } from "../core/launchd.js";
import { VENDORED_CLI } from "../core/vendor.js";
import { compareVersions, vendoredVersion } from "../core/version.js";

export const PMX_PACKAGE = "productmaxxing";
export const ENGINE_PACKAGE = "pmx-engine";

/** Where npm put a package installed with `npm install -g --prefix <prefix>`: `<prefix>/lib/node_modules/<name>`. */
export const packageDir = (prefix: string, name: string) => join(prefix, "lib", "node_modules", name);

/** `<prefix>` for a path inside `<prefix>/lib/node_modules/<name>/…`, the layout a global npm install leaves; else null. */
export function prefixOf(path: string, name: string): string | null {
  const at = path.indexOf(`${sep}lib${sep}node_modules${sep}${name}`);
  if (at < 0) return null;
  const rest = path.slice(at + `${sep}lib${sep}node_modules${sep}${name}`.length);
  return rest === "" || rest.startsWith(sep) ? path.slice(0, at) || sep : null;
}

const exists = (f: string) => stat(f).then(() => true, () => false);

/** Whether this user can create files under `dir`: the nearest folder that exists is writable. Never asks for sudo. */
export async function canWrite(dir: string): Promise<boolean> {
  for (let d = dir; ; d = dirname(d)) {
    if (await exists(d)) return access(d, constants.W_OK).then(() => true, () => false);
    if (dirname(d) === d) return false;
  }
}

/** The version of `name` installed under `prefix`, and whether it's a source checkout (`npm link`), or null. */
async function installedAt(prefix: string, name: string): Promise<{ version: string; dev: boolean } | null> {
  const dir = packageDir(prefix, name);
  const pkg = await readFile(join(dir, "package.json"), "utf8").then((t) => JSON.parse(t) as { version?: unknown }, () => null);
  if (!pkg || typeof pkg.version !== "string") return null;
  const real = await realpath(dir).catch(() => dir);
  return { version: pkg.version, dev: await exists(join(real, ".git")) };
}

/**
 * The source checkout a pmx command runs from (`npm link`, or a link to a clone's dist/src/cli.js), with its version, or
 * null. Like `pmx update`, install never replaces one.
 */
async function checkoutOf(cli: string): Promise<{ root: string; version: string } | null> {
  const root = dirname(dirname(dirname(cli)));
  if (basename(cli) !== "cli.js" || !(await exists(join(root, ".git")))) return null;
  const pkg = await readFile(join(root, "package.json"), "utf8").then((t) => JSON.parse(t) as { name?: unknown; version?: unknown }, () => null);
  return pkg && (pkg.name === PMX_PACKAGE || pkg.name === "productgit") && typeof pkg.version === "string" ? { root, version: pkg.version } : null;
}

/** The shell startup file PMX may add PATH to: zsh's ~/.zshrc, bash's ~/.bash_profile (a new Terminal window reads both). */
export function rcFile(shell: string, home: string): string | null {
  const name = basename(shell || "/bin/zsh");
  return name === "zsh" ? join(home, ".zshrc") : name === "bash" ? join(home, ".bash_profile") : null;
}

export const BLOCK_START = "# >>> PMX: put PMX's commands on PATH (added by pmx install) >>>";
export const BLOCK_END = "# <<< PMX <<<";

/** The one line that puts `bin` on PATH, as a person would type it: `$HOME/…` for a folder in their home. */
export function pathLine(bin: string, home: string): string {
  const dir = bin === home || bin.startsWith(`${home}/`) ? `$HOME${bin.slice(home.length)}` : bin.replace(/(["\\`])/g, "\\$1");
  return `export PATH="${dir}:$PATH"`;
}

/**
 * Adds PMX's marked block to `rc`, or brings an earlier one up to date. Running it again changes nothing: "current".
 * Everything else in the file stays as it was.
 */
export async function writePathBlock(rc: string, bin: string, home: string): Promise<"added" | "updated" | "current"> {
  const block = `${BLOCK_START}\n${pathLine(bin, home)}\n${BLOCK_END}\n`;
  const have = await readFile(rc, "utf8").catch(() => null);
  const start = have?.indexOf(BLOCK_START) ?? -1;
  const end = start >= 0 ? have!.indexOf(BLOCK_END, start) : -1;
  if (have !== null && start >= 0 && end > start) {
    const stop = end + BLOCK_END.length + (have[end + BLOCK_END.length] === "\n" ? 1 : 0);
    if (have.slice(start, stop) === block) return "current";
    await writeFile(rc, have.slice(0, start) + block + have.slice(stop));
    return "updated";
  }
  await mkdir(dirname(rc), { recursive: true });
  const before = have === null || have === "" ? "" : have.endsWith("\n") ? `${have}\n` : `${have}\n\n`;
  await writeFile(rc, before + block, have === null ? { mode: 0o644 } : undefined);
  return "added";
}

/**
 * What a new Terminal window finds for `name`: the person's shell, started as Terminal starts it (a login shell, with
 * its startup files and macOS's default PATH, not this process's PATH, which under npx has npx's own copy of pmx).
 * Null when it finds nothing; undefined when the shell didn't answer, so PMX can't tell.
 */
export async function shellFinds(exec: Exec, shell: string, home: string, name: string): Promise<string | null | undefined> {
  const sh = shell || "/bin/zsh";
  const env: NodeJS.ProcessEnv = { HOME: home, SHELL: sh, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TERM: "dumb", LANG: process.env.LANG ?? "en_US.UTF-8", USER: process.env.USER, LOGNAME: process.env.LOGNAME ?? process.env.USER };
  const r = await exec(sh, ["-ilc", `printf '\\n__PMX_FOUND__%s\\n' "$(command -v ${name})"`], { env, timeoutMs: 20000, input: "" });
  const m = r.stdout.match(/^__PMX_FOUND__(.*)$/m);
  return m ? m[1]!.trim() || null : undefined;
}

const same = async (a: string, b: string) => a === b || (await realpath(a).catch(() => a)) === (await realpath(b).catch(() => b));

/** npm's own global folder, or null when npm doesn't say. */
export async function npmGlobalPrefix(exec: Exec): Promise<string | null> {
  const r = await exec("npm", ["prefix", "-g"], { timeoutMs: 30000 });
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

/**
 * The folder a new global install goes in: npm's own, when this user can write to it, else ~/.local (whose bin folder
 * Claude Code's installer also uses). Never one that needs sudo.
 */
export async function newPrefix(o: { global: string | null; home: string; writable: (dir: string) => Promise<boolean> }): Promise<string> {
  if (o.global && (await o.writable(join(o.global, "lib", "node_modules"))) && (await o.writable(join(o.global, "bin")))) return o.global;
  return join(o.home, ".local");
}

/** `npm install -g`, with `--prefix` only for a folder that isn't npm's own (as `pmx update` does). Never sudo. */
export async function npmInstallGlobal(exec: Exec, spec: string, prefix: string, global: string | null): Promise<{ ok: true } | { ok: false; error: string; denied: boolean }> {
  const own = !!global && (await same(prefix, global));
  const r = await exec("npm", ["install", "-g", ...(own ? [] : ["--prefix", prefix]), spec], { timeoutMs: 300000 });
  if (r.code === 0) return { ok: true };
  return { ok: false, denied: /EACCES|permission denied/i.test(r.stderr), error: r.stderr.trim().split("\n").filter(Boolean).slice(-2).join(" ") || `npm stopped with exit code ${r.code}` };
}

/**
 * INSTALL-4: PMX Engine, installed the way PMX is: into the folder PMX itself is installed under (`pmxPrefix`), or by
 * the same rule as a new install. Used by `pmx install --engine` and the checklist's Install PMX Engine button.
 */
export async function installEnginePackage(o: { exec: Exec; home: string; pmxPrefix: string | null; writable?: (dir: string) => Promise<boolean> }): Promise<{ ok: true; prefix: string } | { ok: false; prefix: string; error: string; denied: boolean }> {
  const global = await npmGlobalPrefix(o.exec);
  const prefix = o.pmxPrefix ?? (await newPrefix({ global, home: o.home, writable: o.writable ?? canWrite }));
  const r = await npmInstallGlobal(o.exec, `${ENGINE_PACKAGE}@latest`, prefix, global);
  return r.ok ? { ok: true, prefix } : { ...r, prefix };
}

export interface InstallDeps {
  exec: Exec;
  ask: Asker;
  /** `--yes`: add PATH without asking. It never means Engine. */
  yes: boolean;
  /** Whether a person can answer here (stdin is a terminal). */
  tty: boolean;
  /** `--engine`: install PMX Engine too, whoever runs it (a team changing product lead, say). */
  engine: boolean;
  home: string;
  /** The person's login shell, `$SHELL`. */
  shell: string;
  platform: string;
  node: { version: string; path: string };
  /** The pmx running this (from npx, the version npx fetched). */
  version: string;
  /** Where the running pmx's package is. */
  root: string;
  personal: PersonalConfig | null;
  team: TeamConfig | null;
  writable(dir: string): Promise<boolean>;
  say(line: string): void;
  /** PMX Engine through the bridge, which only commands reach (src/engine/bridge.ts): its version, and its next step. */
  pmxe: { find(bin?: string): Promise<{ version: string } | null>; next(bin?: string): Promise<string | null> };
  /** Adds /pmx-setup to the Claude app where the app is on this Mac; false where it isn't. */
  setupSkill(): Promise<boolean>;
  /** After updating an installed PMX: the version it came from, so the new one says what's new (NEW-1). */
  updatedFrom?(version: string): Promise<void>;
  /**
   * INSTALL-3: runs `pmx init` with the pmx just installed (`pmx`, its full path; never the copy npx fetched), in this
   * terminal, and resolves with its exit code. Used only where a person can answer (`tty`) on a Mac not set up yet.
   */
  init?(pmx: string, args: string[]): Promise<number>;
  /** `--repo <folder or git URL>`: the team's PMX repo, handed to `pmx init` so it doesn't ask. */
  repo?: string;
}

const tilde = (p: string, home: string) => (p === home || p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

/** Exit codes: 0 PMX is installed and a new Terminal window finds it; 1 it couldn't be installed; 3 it's installed but not found yet. */
export async function runInstall(d: InstallDeps): Promise<number> {
  const t = (p: string) => tilde(p, d.home);
  // `changed`: anything at all; `updated`: PMX itself was installed or replaced.
  let changed = false, updated = false;

  // ---- The Mac
  if (d.platform !== "darwin") { d.say("✘ PMX runs on macOS only for now."); return 1; }
  if (!nodeSupported(d.node.version)) {
    d.say(`✘ PMX needs Node 22.12 or later (24 recommended). This is Node ${d.node.version}, at ${d.node.path}.`);
    d.say("  Install Node 24 with Homebrew (brew install node), open a new Terminal window, and run this again.");
    return 1;
  }
  const node = await stableNode(d.node.path);
  d.say(`✔ macOS, with Node ${d.node.version} at ${t(node)}`);
  if (/\/\.(nvm|fnm|volta|asdf)\/|\/n\/versions\//.test(node))
    d.say(`! This Node comes from a version manager. PMX's background job keeps its path, so switching or removing that version stops the job. Homebrew's Node (brew install node) stays put.`);

  // ---- Which PMX: the team's version where this Mac knows its team repo, else the one running now.
  const tgz = d.personal ? join(d.personal.repoPath, VENDORED_CLI) : null;
  const teamVersion = tgz && (await exists(tgz)) ? await vendoredVersion(tgz, d.exec) : null;
  const want = teamVersion ? { spec: tgz!, version: teamVersion, what: ", your team's version" } : { spec: `${PMX_PACKAGE}@${d.version}`, version: d.version, what: "" };

  // ---- Where: wherever PMX already is (keeping the --prefix it was installed with), else npm's folder or ~/.local.
  const global = await npmGlobalPrefix(d.exec);
  let found = await shellFinds(d.exec, d.shell, d.home, "pmx");
  const foundReal = found ? await realpath(found).catch(() => found!) : null;
  // The running package's own folder, the pmx a new Terminal window finds (its folder's parent, then through its link),
  // npm's own folder, then ~/.local: the first that has PMX installed is where it stays, by the name it was given.
  const candidates = [
    prefixOf(d.root, PMX_PACKAGE), prefixOf(await realpath(d.root).catch(() => d.root), PMX_PACKAGE),
    found && basename(dirname(found)) === "bin" ? dirname(dirname(found)) : null, foundReal ? prefixOf(foundReal, PMX_PACKAGE) : null,
    global, join(d.home, ".local"),
  ];
  let prefix: string | null = null;
  let have: { version: string; dev: boolean } | null = null;
  for (const c of candidates) {
    if (!c) continue;
    const at = await installedAt(c, PMX_PACKAGE);
    if (at) { prefix = c; have = at; break; }
  }
  // A pmx that runs from a source checkout (a developer's Mac) stays: `pmx update` never replaces one either.
  const checkout = !have && foundReal ? await checkoutOf(foundReal) : null;
  let bin = checkout ? dirname(found!) : prefix ? join(prefix, "bin") : "";
  if (checkout) d.say(`✔ PMX ${checkout.version} runs from a source checkout (${t(checkout.root)}), so it isn't replaced`);
  else if (have?.dev) d.say(`✔ PMX ${have.version} runs from a source checkout here, so it isn't replaced`);
  else if (have && (compareVersions(have.version, want.version) ?? 0) >= 0) d.say(`✔ PMX ${have.version} is installed in ${t(bin)}`);
  else {
    prefix ??= await newPrefix({ global, home: d.home, writable: d.writable });
    if (global && prefix !== global && !have) d.say(`  npm's own folder (${global}) needs sudo, which PMX never uses, so PMX goes in ${t(prefix)}.`);
    d.say(`  Installing PMX ${want.version}${want.what}${have ? ` (this Mac has ${have.version})` : ""}…`);
    const r = await npmInstallGlobal(d.exec, want.spec, prefix, global);
    if (!r.ok) {
      d.say(`✘ npm couldn't install PMX: ${r.error}`);
      if (r.denied) d.say(`  npm can't write to ${prefix}. Install Node with Homebrew (brew install node), open a new Terminal window, and run this again. Don't use sudo.`);
      return 1;
    }
    if (have && d.updatedFrom) await d.updatedFrom(have.version).catch(() => {});
    bin = join(prefix, "bin");
    d.say(`✔ Installed PMX ${want.version} in ${t(bin)}`);
    changed = updated = true;
  }

  // ---- PATH: a new Terminal window must find this pmx. One marked block in the shell's startup file, asked for first.
  const ours = async (f: string | null | undefined) => !!f && (await same(f, join(bin, "pmx")));
  if (changed || !(await ours(found))) found = await shellFinds(d.exec, d.shell, d.home, "pmx");
  let pathAdded = false;
  if (!(await ours(found))) {
    const rc = rcFile(d.shell, d.home);
    const line = pathLine(bin, d.home);
    if (found) d.say(`! A new Terminal window finds another pmx first, at ${t(found)}.`);
    if (!rc) d.say(`  Your shell (${basename(d.shell)}) isn't one PMX changes. Add this line to its startup file, then open a new Terminal window:\n    ${line}`);
    else if (!d.yes && !d.tty) d.say(`  To finish, add this line to ${t(rc)}, then open a new Terminal window:\n    ${line}`);
    else if (d.yes || (await d.ask.confirm(`Add ${t(bin)} to your PATH in ${t(rc)}?`, true))) {
      const w = await writePathBlock(rc, bin, d.home);
      if (w !== "current") { d.say(`✔ ${w === "added" ? "Added" : "Updated"} ${t(bin)} on your PATH in ${t(rc)}`); changed = true; pathAdded = true; }
      found = await shellFinds(d.exec, d.shell, d.home, "pmx");
    } else d.say(`  Your PATH is as it was. To use pmx, add this line to ${t(rc)}:\n    ${line}`);
  }
  const ok = await ours(found);
  if (ok) d.say(`✔ A new Terminal window finds pmx${pathAdded ? "" : ` (${t(found!)})`}`);
  else d.say(found === undefined ? "✘ PMX couldn't start a new shell to check that it finds pmx." : "✘ A new Terminal window doesn't find pmx yet.");

  // ---- PMX Engine: only for the team's product lead, or on purpose with --engine. Everyone else is never asked.
  const lead = isProductLead(d.team, d.personal);
  const engineHere = d.engine || lead ? await d.pmxe.find(bin).catch(() => null) : null;
  let engine = d.engine;
  if (!engine && lead && !engineHere) {
    if (d.tty && !d.yes) engine = await d.ask.confirm("Your team names you its product lead. Install PMX Engine too?", false);
    else d.say("  Your team names you its product lead. To install PMX Engine too, run this again with --engine.");
  }
  if (engine && engineHere) d.say(`✔ PMX Engine ${engineHere.version} is installed`);
  else if (engine) {
    d.say("  Installing PMX Engine…");
    const r = await installEnginePackage({ exec: d.exec, home: d.home, pmxPrefix: prefix, writable: d.writable });
    if (!r.ok) d.say(`✘ npm couldn't install PMX Engine: ${r.error}. PMX itself is installed; run this again with --engine to retry.`);
    else {
      changed = true;
      const now = await d.pmxe.find(join(r.prefix, "bin")).catch(() => null);
      const next = now ? await d.pmxe.next(join(r.prefix, "bin")).catch(() => null) : null;
      d.say(`✔ Installed PMX Engine${now ? ` ${now.version}` : ""} in ${t(join(r.prefix, "bin"))}`);
      d.say(`  PMX Engine's next step: ${next ? next.replace(/\.$/, "") : "pmxe checklist says what it is"}. pmxe checklist lists every step, and pmxe guide takes Claude through them.`);
    }
  }

  // ---- What's next, in one or two lines.
  if (!ok) {
    d.say("");
    d.say(pathAdded ? `Next: open a new Terminal window, check that pmx --version answers, then run ${d.personal ? "pmx checklist" : "pmx init"}.`
      : `Next: put ${t(bin)} on your PATH as above, open a new Terminal window, then run ${d.personal ? "pmx checklist" : "pmx init"}.`);
    return 3;
  }
  const setup = d.personal ? false : await d.setupSkill().catch(() => false);
  d.say("");
  // INSTALL-3: one command. In a terminal, on a Mac not set up yet, setup follows at once, run by the pmx that was just
  // installed (by its full path, so a PATH this window doesn't have yet is no obstacle). Its questions need a person,
  // so without a terminal (Claude running this, a script) the next step is said instead.
  if (!d.personal && d.tty && d.init) {
    d.say("Now setting PMX up on this Mac (pmx init): a few questions, then one yes for everything it changes.");
    d.say("");
    const code = await d.init(join(bin, "pmx"), d.repo ? ["--repo", d.repo] : []).catch(() => 1);
    if (code !== 0) d.say(`\nPMX is installed, but setup stopped before it finished. ${pathAdded ? "Open a new Terminal window and run" : "Run"} pmx init to go on: it's safe to run again.`);
    else if (pathAdded) d.say("\nOpen a new Terminal window before you type pmx yourself: this one was open before PMX's folder was on your PATH.");
    return 0;
  }
  if (!d.personal) d.say(`Next: ${pathAdded ? "open a new Terminal window, then " : ""}run pmx init${d.repo ? ` --repo ${d.repo}` : ""}${setup ? ", or in the Claude app type /pmx-setup and Claude sets PMX up with you" : ""}.`);
  else if (updated) d.say(`PMX is set up on this Mac. ${pathAdded ? "Open a new Terminal window: the" : "The"} next pmx command finishes the update, and pmx checklist shows what's left.`);
  else if (changed) d.say(`PMX is set up on this Mac: nothing else to do${pathAdded ? " but open a new Terminal window" : ""}.`);
  else d.say("Nothing changed: PMX is installed and set up on this Mac.");
  return 0;
}
