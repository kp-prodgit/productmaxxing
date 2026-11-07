import { companyDomains } from "../core/filter.js";
import { applyPersonal, checkChange, type Change } from "../flow/actions.js";
import type { Command } from "./index.js";

/** Personal settings the pipeline board also changes (BOARD-3), for Terminal and scripts. */
export const settingsCommands: Command[] = [
  {
    name: "sources",
    summary: "What each source may feed: off, your to-dos only, or your to-dos and Linear tasks",
    usage: "pmx sources | pmx sources set <granola | fireflies | otter | fathom | tldv | zoom | google-meet | file | slack> <off | mine | linear>",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      if (a.positionals[0] === "set") {
        const [, source, value] = a.positionals;
        const c = checkChange({ kind: "route", source, value }, ctx.team);
        console.log((await applyPersonal(ctx.personal, [c])).join("\n"));
        return 0;
      }
      if (a.positionals[0]) throw new Error(`Unknown subcommand "${a.positionals[0]}". Use set.`);
      const routes = ctx.personal.sources.routes ?? {};
      console.log(Object.keys(routes).length
        ? Object.entries(routes).map(([k, v]) => `${k}: ${{ off: "off", mine: "your to-dos only", linear: "your to-dos and Linear tasks" }[v]}`).join("\n")
        : "Every source feeds your to-dos and, after the privacy rules and your approval, Linear tasks.");
      console.log("Change one: pmx sources set granola mine");
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
    summary: "The task categories your agent takes on",
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
      for (const c of Object.keys(ctx.team.categories)) console.log(`${ctx.personal.categories.includes(c) ? "✔" : "·"} ${c}`);
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
