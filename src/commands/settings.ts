import { takesCategory } from "../core/config.js";
import { companyDomains } from "../core/filter.js";
import { applyPersonal, checkChange, type Change } from "../flow/actions.js";
import type { Command } from "./index.js";
import { callInputs, channelInputs, collectsChannels, connectorId, MEETING_CONNECTORS, READ_VIA } from "../inputs/inputs.js";

/** Personal settings the pipeline board also changes (BOARD-3), for Terminal and scripts. */
export const settingsCommands: Command[] = [
  {
    name: "sources",
    summary: "Where PMX listens: your meeting apps and recorders, your team's channels, and what each may feed",
    usage: "pmx sources | pmx sources add <connector> [--only <which calls>] | pmx sources remove <connector> | pmx sources set <source> <off | mine | linear>",
    options: { only: { type: "string" } },
    async run(a) {
      const ctx = await a.ctx();
      const [op, ...rest] = a.positionals;
      if (op === "set") {
        const [source, value] = rest;
        const c = checkChange({ kind: "route", source, value }, ctx.team);
        console.log((await applyPersonal(ctx.personal, [c])).join("\n"));
        return 0;
      }
      if (op === "add" || op === "remove") {
        const c = checkChange({ kind: "call-input", op, connector: rest.join(" "), look: a.values.only }, ctx.team);
        console.log((await applyPersonal(ctx.personal, [c])).join("\n"));
        if (op === "add") console.log(`PMX's collection task in your Claude app reads it from its next run. Make sure ${c.kind === "call-input" ? READ_VIA[connectorId(c.connector)]?.via ?? c.connector : ""} is connected in the Claude app (Settings → Connectors).`);
        return 0;
      }
      if (op) throw new Error(`Unknown subcommand "${op}". Use add, remove or set.`);
      const routes = ctx.personal.sources.routes ?? {};
      const feeds = (id: string) => ({ off: "off", mine: "your to-dos only", linear: "your to-dos and team tasks" })[routes[id] ?? "linear"];
      const calls = callInputs(ctx.personal);
      const fallback = MEETING_CONNECTORS.filter((m) => !calls.some((c) => connectorId(c.connector) === connectorId(m)));
      if (fallback.length) console.log(`Meeting apps (PMX uses the first one connected): ${fallback.join(", ")}`);
      console.log(calls.length ? `Your recorders: ${calls.map((c) => `${c.connector}${READ_VIA[connectorId(c.connector)] ? ` (through ${READ_VIA[connectorId(c.connector)]!.via})` : ""}${c.look ? ` (only ${c.look})` : ""}: ${feeds(connectorId(c.connector))}`).join("; ")}` : "Your recorders: none. Add one: pmx sources add Momentum, or pmx sources add \"Google Meet\"");
      const ch = channelInputs(ctx.team);
      console.log(ch.length ? `Your team's channels: ${ch.map((c) => `${c.connector}: ${c.places.join(", ")}`).join("; ")}${collectsChannels(ctx.team, ctx.personal, ctx.agent) ? " (collected on this Mac)" : ` (collected on ${ctx.team.synthesizer ?? "the synthesis Mac"}'s Mac)`}` : "Your team's channels: none. Propose some on the board's Sources tab.");
      if (Object.keys(routes).length) console.log(`What each feeds: ${Object.keys(routes).map((k) => `${k}: ${feeds(k)}`).join(", ")}`);
      console.log("Change what one feeds: pmx sources set granola mine");
      return 0;
    },
  },
  {
    name: "domains",
    summary: "Your company's email domains: meetings with only these people are internal and never reach team tasks",
    usage: "pmx domains | pmx domains add <domain> | pmx domains remove <domain>",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const [op, value] = a.positionals;
      if (op === "add" || op === "remove") {
        console.log((await applyPersonal(ctx.personal, [checkChange({ kind: "my-domain", op, value }, ctx.team)])).join("\n"));
        if (op === "remove") console.log("People on that domain now count as customers in your runs.");
        return 0;
      }
      if (op) throw new Error(`Unknown subcommand "${op}". Use add or remove.`);
      const all = companyDomains(ctx.team.internalDomains, { companyDomains: ctx.personal.companyDomains, emails: ctx.personal.identity?.emails });
      console.log([`Team's (pmx.config.json): ${ctx.team.internalDomains.join(", ") || "none"}`, `Yours (this Mac): ${(ctx.personal.companyDomains ?? []).join(", ") || "none"}`, `In use: ${all.join(", ") || "none, so PMX holds every meeting"}`].join("\n"));
      return 0;
    },
  },
  {
    name: "categories",
    summary: "The kinds of work your agent takes on",
    usage: "pmx categories | pmx categories add <category> | pmx categories remove <category>",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const [op, name] = a.positionals;
      if (op === "add" || op === "remove") {
        console.log((await applyPersonal(ctx.personal, [checkChange({ kind: "category", name, accepted: op === "add" }, ctx.team)])).join("\n"));
        return 0;
      }
      if (op) throw new Error(`Unknown subcommand "${op}". Use add or remove.`);
      for (const c of Object.keys(ctx.team.categories)) console.log(`${takesCategory(ctx.personal, ctx.team, c) ? "✔" : "·"} ${c}${ctx.team.categories[c]?.required ? " (required by your team)" : ""}`);
      return 0;
    },
  },
];

/** `pmx never-ingest remove`: loosens privacy, so only from Terminal or this Mac's own page, never the artifact. */
export async function removeNeverIngest(a: Parameters<Command["run"]>[0]): Promise<number> {
  const ctx = await a.ctx();
  const given = (["title", "person", "channel"] as const).filter((k) => a.values[k] !== undefined);
  if (given.length !== 1) throw new Error("Give exactly one of --title, --person or --channel.");
  const c = checkChange({ kind: "never", list: given[0], op: "remove", value: a.values[given[0]!] }, ctx.team) as Change;
  console.log(`${(await applyPersonal(ctx.personal, [c])).join("\n")}. PMX may read matching meetings again from the next run.`);
  return 0;
}
