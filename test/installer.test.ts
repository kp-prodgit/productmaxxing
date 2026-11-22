// INSTALL-3, INSTALL-4: `pmx install` (and `npx --yes productmaxxing@latest install`, before PMX is installed). Nothing
// here installs anything or touches the real ~/.zshrc: npm, tar and the login shell are stand-ins over a temp home and
// temp prefixes, and PMX Engine is a stand-in that appears once its fake npm install ran.
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Asker } from "../src/core/ask.js";
import { DEFAULT_TEAM, type TeamConfig } from "../src/core/config.js";
import type { Exec } from "../src/core/exec.js";
import { BLOCK_START, pathLine, prefixOf, rcFile, runInstall, writePathBlock, type InstallDeps } from "../src/setup/install.js";
import { freshHome, personal, tmp } from "./helpers.js";

const V = "0.36.0";

/** As npm leaves a global install: the package's command in `<prefix>/bin`, a link to its JavaScript. */
async function link(prefix: string, name: string): Promise<void> {
  const cli = join(prefix, "lib", "node_modules", name, "dist", "src", "cli.js");
  await mkdir(join(cli, ".."), { recursive: true });
  await writeFile(cli, "#!/usr/bin/env node\n");
  await mkdir(join(prefix, "bin"), { recursive: true });
  await symlink(join("..", "lib", "node_modules", name, "dist", "src", "cli.js"), join(prefix, "bin", name === "pmx-engine" ? "pmxe" : "pmx")).catch(() => {});
}

/** A Mac: npm's global folder (writable or not), a home, a shell whose PATH comes from its startup file, and Engine. */
async function mac(o: { globalWritable?: boolean; vendored?: string | null; npm?: { code: number; stderr: string }; basePath?: string[]; shell?: string } = {}) {
  const home = await tmp("install-home-");
  const global = await tmp("npm-global-");
  const calls: string[][] = [];
  const shell = o.shell ?? "/bin/zsh";
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === "npm" && args[0] === "prefix") return { code: 0, stdout: `${global}\n`, stderr: "" };
    if (cmd === "tar") return o.vendored ? { code: 0, stdout: JSON.stringify({ version: o.vendored }), stderr: "" } : { code: 1, stdout: "", stderr: "no file" };
    if (cmd === "npm" && args[0] === "install") {
      if (o.npm) return { code: o.npm.code, stdout: "", stderr: o.npm.stderr };
      const i = args.indexOf("--prefix");
      const prefix = i >= 0 ? args[i + 1]! : global;
      const spec = args.at(-1)!;
      const name = spec.startsWith("pmx-engine") ? "pmx-engine" : "productmaxxing";
      const version = name === "pmx-engine" ? "0.12.0" : spec.endsWith(".tgz") ? o.vendored! : spec.split("@")[1]!;
      await mkdir(join(prefix, "lib", "node_modules", name), { recursive: true });
      await writeFile(join(prefix, "lib", "node_modules", name, "package.json"), JSON.stringify({ name, version }));
      await link(prefix, name);
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === shell && args[0] === "-ilc") {
      // A login shell: macOS's default PATH, then what its startup file adds, which a new Terminal window reads too.
      const rc = rcFile(shell, home);
      const text = rc ? await readFile(rc, "utf8").catch(() => "") : "";
      const added = [...text.matchAll(/^export PATH="([^"]+):\$PATH"$/gm)].map((m) => m[1]!.replace("$HOME", home));
      const dirs = [...added, ...(o.basePath ?? []), "/usr/bin", "/bin"];
      let hit = "";
      for (const d of dirs) if (await readFile(join(d, "pmx"), "utf8").then(() => true, () => false)) { hit = join(d, "pmx"); break; }
      return { code: 0, stdout: `Last login: Fri\n__PMX_FOUND__${hit}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `${cmd}: not faked` };
  };
  const asked: string[] = [];
  const answers: Record<string, boolean> = {};
  const ask: Asker = {
    async text(_q, def = "") { return def; },
    async secret() { return ""; },
    async confirm(q, def = true) { asked.push(q); const k = Object.keys(answers).find((x) => q.includes(x)); return k ? answers[k]! : def; },
    async choose(_q, _o, def) { return def; },
  };
  const lines: string[] = [];
  const engineAt = () => [join(home, ".local", "bin"), join(global, "bin")];
  const findEngine = async (bin?: string) => {
    for (const d of [...(bin ? [bin] : []), ...engineAt()]) if (await readFile(join(d, "pmxe"), "utf8").then(() => true, () => false)) return { version: "0.12.0" };
    return null;
  };
  const deps = (over: Partial<InstallDeps> = {}): InstallDeps => ({
    exec, ask, yes: false, tty: true, engine: false, home, shell, platform: "darwin", node: { version: "24.1.0", path: "/opt/homebrew/opt/node/bin/node" },
    version: V, root: join(home, ".npm", "_npx", "3f2a", "node_modules", "productmaxxing"), personal: null, team: null,
    writable: async (dir) => (dir.startsWith(global) ? o.globalWritable ?? true : true),
    say: (l) => lines.push(l),
    pmxe: { find: findEngine, next: async () => "Create your workspace" },
    setupSkill: async () => true,
    ...over,
  });
  const npmInstalls = () => calls.filter((c) => c[0] === "npm" && c[1] === "install");
  return { home, global, exec, calls, npmInstalls, asked, answers, lines, out: () => lines.join("\n"), deps };
}

describe("pmx install (INSTALL-3)", () => {
  beforeEach(freshHome);

  it("installs into npm's own folder when it's writable, and needs no PATH change where the shell already finds it", async () => {
    const m = await mac();
    const bin = join(m.global, "bin");
    const code = await runInstall(m.deps());
    expect(m.npmInstalls()).toEqual([["npm", "install", "-g", `productmaxxing@${V}`]]);
    // Not on the login shell's PATH: the one marked block, asked first, and found after.
    expect(m.asked).toEqual([`Add ${bin} to your PATH in ~/.zshrc?`]);
    expect(code).toBe(0);
    const rc = await readFile(join(m.home, ".zshrc"), "utf8");
    expect(rc).toBe(`${BLOCK_START}\nexport PATH="${bin}:$PATH"\n# <<< PMX <<<\n`);
    expect(m.out()).toMatch(/✔ A new Terminal window finds pmx/);
    expect(m.lines.at(-1)).toBe("Next: open a new Terminal window, then run pmx init, or in the Claude app type /pmx-setup and Claude sets PMX up with you.");

    // Already on PATH (Homebrew's folder, say): nothing to add, nothing asked.
    const h = await mac({ basePath: [] });
    const hb = join(h.global, "bin");
    const d = h.deps();
    await runInstall({ ...d, exec: async (cmd, args, x) => (cmd === "/bin/zsh" ? { code: 0, stdout: `__PMX_FOUND__${await readFile(join(hb, "pmx"), "utf8").then(() => join(hb, "pmx"), () => "")}\n`, stderr: "" } : h.exec(cmd, args, x)) });
    expect(h.asked).toEqual([]);
    expect(await readFile(join(h.home, ".zshrc"), "utf8").catch(() => null)).toBeNull();
    expect(h.lines.at(-1)).toBe("Next: run pmx init, or in the Claude app type /pmx-setup and Claude sets PMX up with you.");
  });

  it("uses ~/.local when npm's own folder needs sudo, and never runs sudo", async () => {
    const m = await mac({ globalWritable: false });
    const code = await runInstall(m.deps({ yes: true }));
    expect(code).toBe(0);
    expect(m.npmInstalls()).toEqual([["npm", "install", "-g", "--prefix", join(m.home, ".local"), `productmaxxing@${V}`]]);
    expect(m.calls.some((c) => c.includes("sudo"))).toBe(false);
    expect(m.out()).toContain(`npm's own folder (${m.global}) needs sudo, which PMX never uses, so PMX goes in ~/.local.`);
    // --yes adds PATH without asking, as $HOME/.local/bin.
    expect(m.asked).toEqual([]);
    expect(await readFile(join(m.home, ".zshrc"), "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it("adds the PATH block once: running it again on a set-up Mac changes nothing and says so", async () => {
    const m = await mac({ globalWritable: false });
    await writeFile(join(m.home, ".zshrc"), "export EDITOR=vim");
    expect(await runInstall(m.deps({ yes: true }))).toBe(0);
    const repo = await tmp("team-repo-");
    const setUp = { personal: personal(repo), team: { ...DEFAULT_TEAM, team: "acme" } as TeamConfig };
    const before = await readFile(join(m.home, ".zshrc"), "utf8");
    expect(before).toBe(`export EDITOR=vim\n\n${BLOCK_START}\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< PMX <<<\n`);
    m.lines.length = 0;
    expect(await runInstall(m.deps({ yes: true, ...setUp }))).toBe(0);
    expect(m.npmInstalls()).toHaveLength(1);
    expect(await readFile(join(m.home, ".zshrc"), "utf8")).toBe(before);
    expect(m.out()).toMatch(new RegExp(`✔ PMX ${V.replace(/\./g, "\\.")} is installed in ~/\\.local/bin`));
    expect(m.lines.at(-1)).toBe("Nothing changed: PMX is installed and set up on this Mac.");
    // And the block itself: the same again is "current"; a different folder replaces it in place.
    const rc = join(m.home, ".zshrc");
    expect(await writePathBlock(rc, join(m.home, ".local", "bin"), m.home)).toBe("current");
    expect(await writePathBlock(rc, "/opt/tools/bin", m.home)).toBe("updated");
    const after = await readFile(rc, "utf8");
    expect(after.split(BLOCK_START)).toHaveLength(2);
    expect(after).toContain('export PATH="/opt/tools/bin:$PATH"');
    expect(after.startsWith("export EDITOR=vim\n")).toBe(true);
  });

  it("asks in a terminal, prints the line without one, and says plainly when pmx isn't found", async () => {
    // A person says no: nothing changes, and the exit code says pmx isn't found yet.
    const no = await mac({ globalWritable: false });
    no.answers["to your PATH"] = false;
    expect(await runInstall(no.deps())).toBe(3);
    expect(no.asked).toEqual(["Add ~/.local/bin to your PATH in ~/.zshrc?"]);
    expect(await readFile(join(no.home, ".zshrc"), "utf8").catch(() => null)).toBeNull();
    expect(no.out()).toContain('add this line to ~/.zshrc:\n    export PATH="$HOME/.local/bin:$PATH"');
    expect(no.out()).toMatch(/✘ A new Terminal window doesn't find pmx yet\./);
    expect(no.lines.at(-1)).toBe("Next: put ~/.local/bin on your PATH as above, open a new Terminal window, then run pmx init.");

    // No terminal and no --yes: the one line to add, never an edit, never a question.
    const ci = await mac({ globalWritable: false });
    expect(await runInstall(ci.deps({ tty: false }))).toBe(3);
    expect(ci.asked).toEqual([]);
    expect(await readFile(join(ci.home, ".zshrc"), "utf8").catch(() => null)).toBeNull();
    expect(ci.out()).toContain('To finish, add this line to ~/.zshrc, then open a new Terminal window:\n    export PATH="$HOME/.local/bin:$PATH"');

    // bash's file is ~/.bash_profile; another shell gets the line to add itself.
    const bash = await mac({ globalWritable: false, shell: "/bin/bash" });
    expect(await runInstall(bash.deps({ yes: true }))).toBe(0);
    expect(await readFile(join(bash.home, ".bash_profile"), "utf8")).toContain('export PATH="$HOME/.local/bin:$PATH"');
    const fish = await mac({ globalWritable: false, shell: "/opt/homebrew/bin/fish" });
    expect(await runInstall(fish.deps({ yes: true }))).toBe(3);
    expect(fish.out()).toContain("Your shell (fish) isn't one PMX changes. Add this line to its startup file");
  });

  it("installs your team's version where the team repo is known, and keeps the --prefix PMX was installed with", async () => {
    const m = await mac({ vendored: "0.35.2" });
    const repo = await tmp("team-repo-");
    await mkdir(join(repo, ".pmx", "cli"), { recursive: true });
    await writeFile(join(repo, ".pmx", "cli", "productmaxxing.tgz"), "");
    // An older PMX in its own folder (as `npm install -g --prefix /opt/homebrew` leaves it), found by the login shell.
    const old = await tmp("homebrew-");
    await mkdir(join(old, "lib", "node_modules", "productmaxxing"), { recursive: true });
    await writeFile(join(old, "lib", "node_modules", "productmaxxing", "package.json"), JSON.stringify({ version: "0.30.0" }));
    await link(old, "productmaxxing");
    const from: string[] = [];
    const setUp = { yes: true, personal: personal(repo), team: { ...DEFAULT_TEAM, team: "acme" } as TeamConfig, updatedFrom: async (v: string) => { from.push(v); } };
    const shellFindsOld: Exec = async (c, a, x) => (c === "/bin/zsh" ? { code: 0, stdout: `__PMX_FOUND__${join(old, "bin", "pmx")}\n`, stderr: "" } : m.exec(c, a, x));
    const c1 = await runInstall({ ...m.deps(setUp), exec: shellFindsOld });
    expect(c1, m.out()).toBe(0);
    expect(m.npmInstalls()).toEqual([["npm", "install", "-g", "--prefix", old, join(repo, ".pmx", "cli", "productmaxxing.tgz")]]);
    expect(from).toEqual(["0.30.0"]);
    expect(m.out()).toContain("Installing PMX 0.35.2, your team's version (this Mac has 0.30.0)…");
    expect(m.lines.at(-1)).toBe("PMX is set up on this Mac. The next pmx command finishes the update, and pmx checklist shows what's left.");

    // Never downgrades: a newer PMX already there stays as it is.
    await writeFile(join(old, "lib", "node_modules", "productmaxxing", "package.json"), JSON.stringify({ version: "0.40.0" }));
    m.lines.length = 0;
    expect(await runInstall({ ...m.deps(setUp), exec: shellFindsOld })).toBe(0);
    expect(m.npmInstalls()).toHaveLength(1);
    expect(m.lines.at(-1)).toBe("Nothing changed: PMX is installed and set up on this Mac.");
    expect(prefixOf(join(old, "lib", "node_modules", "productmaxxing", "dist", "src", "cli.js"), "productmaxxing")).toBe(old);
    expect(prefixOf(join(old, "lib", "node_modules", "productmaxxing-old"), "productmaxxing")).toBeNull();
  });

  it("never replaces a pmx that runs from a source checkout, as pmx update never does", async () => {
    const m = await mac();
    const clone = await tmp("clone-");
    await mkdir(join(clone, ".git"), { recursive: true });
    await mkdir(join(clone, "dist", "src"), { recursive: true });
    await writeFile(join(clone, "dist", "src", "cli.js"), "");
    await writeFile(join(clone, "package.json"), JSON.stringify({ name: "productmaxxing", version: "0.35.0" }));
    const bin = await tmp("bin-");
    await symlink(join(clone, "dist", "src", "cli.js"), join(bin, "pmx"));
    const d = m.deps();
    const code = await runInstall({ ...d, exec: async (c, a, x) => (c === "/bin/zsh" ? { code: 0, stdout: `__PMX_FOUND__${join(bin, "pmx")}\n`, stderr: "" } : m.exec(c, a, x)) });
    expect(code).toBe(0);
    expect(m.npmInstalls()).toEqual([]);
    expect(m.out()).toMatch(/✔ PMX 0\.35\.0 runs from a source checkout \(.*clone-.*\), so it isn't replaced/);
    expect(m.asked).toEqual([]);
  });

  it("stops on a Mac that isn't macOS, on an old Node, and when npm fails", async () => {
    const m = await mac();
    expect(await runInstall(m.deps({ platform: "linux" }))).toBe(1);
    expect(m.out()).toContain("PMX runs on macOS only for now.");
    expect(await runInstall(m.deps({ node: { version: "20.11.0", path: "/usr/local/bin/node" } }))).toBe(1);
    expect(m.out()).toContain("PMX needs Node 22.12 or later (24 recommended). This is Node 20.11.0");
    expect(m.npmInstalls()).toEqual([]);
    const nvm = await mac();
    await runInstall(nvm.deps({ yes: true, node: { version: "24.1.0", path: join(nvm.home, ".nvm/versions/node/v24.1.0/bin/node") } }));
    expect(nvm.out()).toMatch(/This Node comes from a version manager/);
    const denied = await mac({ npm: { code: 243, stderr: "npm ERR! code EACCES" } });
    expect(await runInstall(denied.deps({ yes: true }))).toBe(1);
    expect(denied.out()).toMatch(/npm can't write to .*Don't use sudo\./);
  });
});

describe("PMX Engine only for the product lead (INSTALL-4)", () => {
  beforeEach(freshHome);
  const team = (productLead: string | null): TeamConfig => ({ ...DEFAULT_TEAM, team: "acme", productLead } as TeamConfig);

  it("asks the named product lead, default no; nobody else ever sees an Engine question", async () => {
    const repo = await tmp("team-repo-");
    const lead = await mac();
    await runInstall(lead.deps({ yes: false, personal: personal(repo, { handle: "ana" }), team: team("ana") }));
    expect(lead.asked).toContain("Your team names you its product lead. Install PMX Engine too?");
    // The default is no: nothing installed.
    expect(lead.npmInstalls().filter((c) => c.at(-1)!.startsWith("pmx-engine"))).toEqual([]);

    // The agent handle names the lead too.
    const agent = await mac();
    agent.answers["product lead"] = true;
    await runInstall(agent.deps({ personal: personal(repo, { handle: "ana", machineId: "m1" }), team: team("ana@m1") }));
    expect(agent.npmInstalls().at(-1)).toEqual(["npm", "install", "-g", "pmx-engine@latest"]);
    expect(agent.out()).toContain("PMX Engine's next step: Create your workspace. pmxe checklist lists every step, and pmxe guide takes Claude through them.");

    for (const [who, t] of [["a teammate", team("bo")], ["a team with no product lead", team(null)], ["a Mac not set up yet", null]] as const) {
      const pm = await mac();
      let looked = false;
      const d = pm.deps({ personal: t ? personal(repo, { handle: "ana" }) : null, team: t });
      await runInstall({ ...d, pmxe: { find: async () => { looked = true; return null; }, next: async () => null } });
      expect(pm.asked.filter((q) => /Engine/.test(q)), who).toEqual([]);
      expect(pm.out(), who).not.toMatch(/Engine/);
      expect(looked, who).toBe(false);
    }
  });

  it("--yes never means Engine: the lead is told how instead", async () => {
    const repo = await tmp("team-repo-");
    const m = await mac();
    await runInstall(m.deps({ yes: true, personal: personal(repo, { handle: "ana" }), team: team("ana") }));
    expect(m.asked).toEqual([]);
    expect(m.npmInstalls().map((c) => c.at(-1))).toEqual([`productmaxxing@${V}`]);
    expect(m.out()).toContain("Your team names you its product lead. To install PMX Engine too, run this again with --engine.");
  });

  it("--engine installs PMX Engine the same way, for anyone, and not twice", async () => {
    const m = await mac({ globalWritable: false });
    expect(await runInstall(m.deps({ yes: true, engine: true }))).toBe(0);
    expect(m.npmInstalls()).toEqual([
      ["npm", "install", "-g", "--prefix", join(m.home, ".local"), `productmaxxing@${V}`],
      ["npm", "install", "-g", "--prefix", join(m.home, ".local"), "pmx-engine@latest"],
    ]);
    expect(m.out()).toContain("✔ Installed PMX Engine 0.12.0 in ~/.local/bin");
    m.lines.length = 0;
    await runInstall(m.deps({ yes: true, engine: true }));
    expect(m.npmInstalls()).toHaveLength(2);
    expect(m.out()).toContain("✔ PMX Engine 0.12.0 is installed");
    // An Engine that npm couldn't install doesn't undo PMX: PMX is installed and found.
    const f = await mac();
    const d = f.deps({ yes: true, engine: true });
    const failing: Exec = async (cmd, args, x) => (cmd === "npm" && args.at(-1) === "pmx-engine@latest" ? { code: 1, stdout: "", stderr: "npm ERR! 404 Not Found" } : f.exec(cmd, args, x));
    expect(await runInstall({ ...d, exec: failing })).toBe(0);
    expect(f.out()).toContain("✘ npm couldn't install PMX Engine: npm ERR! 404 Not Found. PMX itself is installed; run this again with --engine to retry.");
  });

  it("is runnable as npx productmaxxing install: both of the package's commands are the same file", async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, "..", "package.json"), "utf8"));
    // npm exec runs a package's one command, or its aliases of one file, or the one named like the package.
    expect(new Set(Object.values(pkg.bin)).size).toBe(1);
    expect(pkg.bin.productmaxxing).toBe(pkg.bin.pmx);
    expect(pathLine("/Users/x/.local/bin", "/Users/x")).toBe('export PATH="$HOME/.local/bin:$PATH"');
    // INSTALL.md's main path is this command, then pmx init; the manual install stays as the fallback, and the product
    // lead's section has --engine.
    const guide = await readFile(join(import.meta.dirname, "..", "INSTALL.md"), "utf8");
    const step2 = guide.indexOf("### Step 2: install PMX");
    expect(guide.indexOf("npx --yes productmaxxing@latest install", step2)).toBeGreaterThan(step2);
    expect(guide.indexOf("## Installing by hand")).toBeGreaterThan(step2);
    expect(guide.slice(guide.indexOf("## For your product lead"), guide.indexOf("## Installing by hand"))).toContain("npx --yes productmaxxing@latest install --engine");
  });
});
