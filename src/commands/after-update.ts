import type { Ctx } from "../core/context.js";
import { notify } from "../core/notify.js";
import { loadState, updateState } from "../core/state.js";
import { currentVersion } from "../core/version.js";
import { RELEASE_NOTES } from "../core/whats-new.js";
import type { Checklist } from "../setup/checklist.js";

/** PMX Engine's newest version as its own updater reports it (src/engine/bridge.ts, `engineLatest`). */
export interface EngineOut { current: string; latest: string; newer: boolean; busy: boolean }

export interface AfterUpdateDeps {
  /** The checklist, worked out now. Asked for after Engine's answer is recorded, so it can say a newer Engine is out. */
  checklist: () => Promise<Checklist>;
  /**
   * Whether a newer PMX Engine is out, asked of Engine's own updater without installing anything; null where Engine
   * isn't on this Mac. Only commands reach Engine (src/engine/bridge.ts), so the command hands it in.
   */
  engine: () => Promise<EngineOut | null>;
  /** Tests record what the PM would be told. */
  notify?: (title: string, message: string) => Promise<void>;
}

/** What the notification says: the version, what's new in a few words, and the one line about what's left. */
export function updatedMessage(o: { version: string; headline?: string | null; left: string }): string {
  return `pmx ${o.version} is installed${o.headline ? `: ${o.headline.replace(/\.$/, "")}` : ""}. ${o.left}`;
}

/**
 * UPGRADE-1 (0.41.0): one line after an update. The background run's first pass on a new version, after that version's
 * own update steps ran (src/cli.ts), works out what the update still needs from a person and says it once, in the
 * job's log and in a notification: "Nothing to do." when PMX needs nobody, otherwise only the steps a person has to do.
 * A PM who updated by hand saw the same line from `pmx migrate`, which `pmx update` runs, and isn't told again.
 *
 * COMPAT-7: where PMX Engine is on this Mac, this is also when PMX asks Engine's own updater whether a newer Engine is
 * out. It never installs it; a newer one is one of the steps left ("PMX Engine 0.x is out: run pmxe update").
 */
export async function afterUpdate(_ctx: Ctx, d: AfterUpdateDeps): Promise<string | null> {
  const v = currentVersion();
  const st = await loadState();
  const rec = st.upgrade ?? null;
  // Only a Mac that came to this version from another one, and only once.
  if (!rec || rec.at === null || rec.lastVersion !== v || rec.from === v || st.updateTold === v) return null;
  const eng = await d.engine().catch(() => null);
  if (eng) await updateState((s) => { s.engineUpdate = { latest: eng.latest, current: eng.current, at: new Date().toISOString(), ...(eng.busy ? { busy: true } : {}) }; });
  const left = await d.checklist().then((cl) => cl.upgrade?.left ?? null, () => null);
  await updateState((s) => { s.updateTold = v; });
  const headline = RELEASE_NOTES.find((n) => n.version === v)?.headline ?? null;
  // A checklist PMX couldn't work out is never "nothing to do": it says where to look.
  const line = left ?? "PMX couldn't work out what's left: pmx checklist shows it.";
  await (d.notify ?? notify)("ProductMaxxing updated", updatedMessage({ version: v, headline, left: line })).catch(() => {});
  return `pmx ${v} is set up on this Mac${rec.from ? `, updated from ${rec.from}` : ""}. ${line}`;
}
