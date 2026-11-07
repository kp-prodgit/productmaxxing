import { exec as defaultExec, type Exec } from "./exec.js";
import { KEYCHAIN_SERVICE } from "./paths.js";

/** Secret names ProductMaxxing stores. Values live only in the macOS keychain (SEC-10). */
export type SecretName = "slack-token" | "linear-token" | "linear-oauth" | "github-token" | "machine-token" | "anthropic-api-key";

export interface Keychain {
  get(name: SecretName): Promise<string | null>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
  list(): Promise<SecretName[]>;
}

export const ALL_SECRETS: SecretName[] = ["slack-token", "linear-token", "linear-oauth", "github-token", "machine-token", "anthropic-api-key"];

/** `service` is the keychain service the items live under; only the 0.15.0 rename reads the old one (RENAME-1). */
export function macKeychain(exec: Exec = defaultExec, service: string = KEYCHAIN_SERVICE): Keychain {
  return {
    async get(name) {
      const r = await exec("security", ["find-generic-password", "-s", service, "-a", name, "-w"]);
      return r.code === 0 ? r.stdout.replace(/\n$/, "") : null;
    },
    async set(name, value) {
      // -U updates in place. The value is passed as an argument to `security`, never written to disk.
      const r = await exec("security", ["add-generic-password", "-U", "-s", service, "-a", name, "-w", value]);
      if (r.code !== 0) throw new Error(`keychain: could not store ${name}: ${r.stderr.trim()}`);
    },
    async delete(name) {
      await exec("security", ["delete-generic-password", "-s", service, "-a", name]);
    },
    async list() {
      const found: SecretName[] = [];
      for (const n of ALL_SECRETS) if ((await this.get(n)) !== null) found.push(n);
      return found;
    },
  };
}

/** In-memory keychain for tests. */
export function memoryKeychain(initial: Partial<Record<SecretName, string>> = {}): Keychain {
  const m = new Map<SecretName, string>(Object.entries(initial) as [SecretName, string][]);
  return {
    async get(n) { return m.get(n) ?? null; },
    async set(n, v) { m.set(n, v); },
    async delete(n) { m.delete(n); },
    async list() { return [...m.keys()]; },
  };
}
