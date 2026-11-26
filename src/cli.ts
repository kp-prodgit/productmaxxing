#!/usr/bin/env node
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ttyAsker } from "./core/ask.js";
import { afterUpdateNote } from "./mcp/handoff.js";
import { loadPersonalConfig, loadTeamConfig, type PersonalConfig, type TeamConfig } from "./core/config.js";
import { consoleOut, makeCtx, type Ctx } from "./core/context.js";
import { exec } from "./core/exec.js";
import { macKeychain } from "./core/keychain.js";
import { macLaunchd } from "./core/launchd.js";
import { packageRoot } from "./core/skills.js";
import { claudeCode } from "./runtime/claude-code.js";
import { refusingRuntime } from "./runtime/refusing.js";
import { effectiveTeam } from "./core/services.js";
import { localGuard, writeProfile } from "./core/profile.js";
import { paths } from "./core/paths.js";
import { announceOnce, markSeen, QUIET_COMMANDS } from "./core/whats-new.js";
import { migrateFromProductGit } from "./core/rename.js";
import { markFreshInstall, upgradeOnStart } from "./core/upgrade.js";
import { commands as core } from "./commands/index.js";
import { registerEe } from "../ee/src/index.js";

const commands = [...core, ...registerEe()];

const HELP = `pmx: ProductMaxxing

Usage: pmx <command> [options]

Commands:
${commands.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n")}

Run \`pmx <command> --help\` for options. Docs: https://productmaxxing.ai`;

export async function realCtx(): Promise<Ctx> {
  const personal: PersonalConfig = await loadPersonalConfig();
  const eff = await effectiveTeam(await loadTeamConfig(personal.repoPath), personal);
  const team: TeamConfig = eff.team;
  // Keep the clean profile in step with team config and admin policy (model, egress).
  // RUN-6: a web run's guard runs this very pmx, with the Node it pins.
  await writeProfile(team, { guard: await localGuard(fileURLToPath(import.meta.url)) });
  return makeCtx({
    team, personal, runtime: eff.blockRuns ? refusingRuntime(eff.blockRuns) : claudeCode(), keychain: macKeychain(), launchd: macLaunchd(),
    fetch, exec, now: () => new Date(), out: consoleOut,
  });
}

async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h" || name === "help") {
    console.log(HELP);
    return 0;
  }
  if (name === "--version" || name === "-v") {
    const pkg = JSON.parse(await readFile(`${packageRoot()}/package.json`, "utf8"));
    console.log(pkg.version);
    return 0;
  }
  const cmd = commands.find((c) => c.name === name);
  if (!cmd) {
    console.error(`Unknown command "${name}".\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parseArgs({ args: rest, options: { ...cmd.options, help: { type: "boolean", short: "h" } }, allowPositionals: true, strict: true });
  if (values.help) {
    console.log(`pmx ${cmd.name}: ${cmd.summary}\n\n${cmd.usage ?? ""}`);
    return 0;
  }
  // RENAME-1: a Mac still on the ProductGit names moves over first. When the old package was swapped out, the new
  // pmx already ran this command, so its exit code is the answer. `install` (INSTALL-3) skips this and the update steps:
  // it may run from npx's copy of PMX, which must never become what the background job or the Claude app runs.
  if (cmd.name !== "mcp" && cmd.name !== "uninstall" && cmd.name !== "install" && cmd.name !== "hook") {
    const handed = await migrateFromProductGit({ exec, launchd: macLaunchd(), cli: fileURLToPath(import.meta.url), argv, say: (s) => process.stderr.write(`${s}\n`) });
    if (handed !== null) return handed;
    // UPGRADE-1: after an update, what this Mac needs from the new version, once (the background job reloads itself
    // only from a command someone runs). Never stops the command: a step that fails waits for the next one.
    const up = await upgradeOnStart({ exec, launchd: macLaunchd(), cliPath: fileURLToPath(import.meta.url), interactive: cmd.name !== "tick" }).catch(() => null);
    if (up?.did.some((x) => x.did !== "nothing to do") && cmd.name !== "tick" && cmd.name !== "migrate" && !QUIET_COMMANDS.has(cmd.name))
      process.stderr.write(`Updated this Mac for pmx ${up.to}: ${up.did.filter((x) => x.did !== "nothing to do").map((x) => x.did).join("; ")}. What's left: pmx checklist\n`);
  }
  // NEW-1: after an update, the first command says what's new, once, on stderr.
  const fresh = cmd.name === "init" && !(await stat(paths.config()).then(() => true, () => false));
  if (!QUIET_COMMANDS.has(cmd.name)) {
    const personal = await loadPersonalConfig().catch(() => null);
    const pages = async () => personal && afterUpdateNote(await loadTeamConfig(personal.repoPath).catch(() => null), personal, exec);
    await announceOnce((s) => process.stderr.write(`${s}\n`), { installedAt: personal?.installedAt ?? null, pages });
  }
  const code = await cmd.run({
    values: values as Record<string, any>,
    positionals,
    ask: ttyAsker((values as Record<string, unknown>).yes === true ? true : undefined),
    ctx: realCtx,
    cliPath: fileURLToPath(import.meta.url),
    tty: !!process.stdin.isTTY,
  });
  // A fresh install starts up to date.
  if (fresh && code === 0) {
    await markSeen();
    await markFreshInstall();
  }
  return code;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(`pmx: ${e?.message ?? e}`);
    process.exit(1);
  },
);
