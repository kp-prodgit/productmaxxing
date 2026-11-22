import { realpath, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * A command file as installed, for running it without relying on its `#!` line (CLI-6). npm links a package's command
 * to its JavaScript entry point, whose `#!/usr/bin/env node` fails wherever `node` isn't on PATH: the background job's
 * PATH, say, when Node came from nvm. Null when nothing is there. `js` is the resolved file when it is JavaScript, so
 * the caller can run it with PMX's own Node instead. Reads only where the link points and whether a file is there.
 */
export async function commandFile(path: string): Promise<{ path: string; real: string; js: string | null } | null> {
  const real = await realpath(path).catch(() => null);
  if (!real || !(await stat(real).then((s) => s.isFile(), () => false))) return null;
  return { path, real, js: /\.(c|m)?js$/.test(real) ? real : null };
}

/** Every `name` on PATH, in PATH order. */
export function onPath(name: string, PATH = process.env.PATH ?? ""): string[] {
  return [...new Set(PATH.split(delimiter).filter((d) => d.startsWith("/")).map((d) => join(d, name)))];
}
