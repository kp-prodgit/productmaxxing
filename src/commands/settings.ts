import { DEFAULT_TEAM, kindsToChoose, takesCategory, type PersonalConfig, type TeamConfig } from "../core/config.js";
import { companyDomains, confidentialDomains } from "../core/filter.js";
import { applyPersonal, checkChange, describe, proposeTeamChanges, type Change } from "../flow/actions.js";
import { rememberTeamPr } from "../flow/team-prs.js";
import type { Command } from "./index.js";
import { callInputs, channelInputs, collectsChannels, connectorId, MEETING_CONNECTORS, meetingSeries, READ_VIA } from "../inputs/inputs.js";

/** JOB-11: whether this PM's agent takes a kind of work, in words, for `pmx categories` and `pmx jobs`. */
export function takeWords(personal: Pick<PersonalConfig, "categories" | "categoriesOff">, team: Pick<TeamConfig, "categories">, kind: string): string {
  if (team.categories[kind]?.required) return "✔ required by your team";
  if (takesCategory(personal, team, kind)) return "✔ your agent takes it";
  return kindsToChoose(personal, team).includes(kind) ? "· not chosen yet: your agent skips it until you choose" : "· off: you turned it off";
}

/**
 * JOB-11: `pmx categories add|remove <kind>`, this PM's choice, exactly as Settings → Kinds of work on PMX's page saves
 * it (a personal "category" change, applied on this Mac at once). Remove is a choice too: PMX doesn't ask again.
 * Returns what to print.
 */
export async function setTake(personal: PersonalConfig, team: TeamConfig, kind: string | undefined, on: boolean): Promise<string> {
  const op = on ? "add" : "remove";
  const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
  if (!kind) throw new Error(`Say which kind of work: pmx categories ${op} ${kindsToChoose(personal, team)[0] ?? Object.keys(team.categories)[0] ?? "spec"}. Your team's are: ${Object.keys(team.categories).join(", ")}.`);
  // One of PMX's own the team hasn't added is the team's to add first (CAT-8).
  if (!has(team.categories, kind) && has(DEFAULT_TEAM.categories, kind)) throw new Error(`Your team doesn't have ${kind} yet, so no agent takes it. Send it to your team for approval: pmx jobs add ${kind}`);
  if (!has(team.categories, kind)) throw new Error(`Your team has no kind of work called ${kind}. Its kinds of work are: ${Object.keys(team.categories).join(", ")}.`);
  await applyPersonal(personal, [checkChange({ kind: "category", name: kind, accepted: on }, team)]);
  const required = !!team.categories[kind]?.required;
  if (on) return `Your agent takes ${kind} from its next run.${required ? " (Your team requires it, so it did already.)" : ""}`;
  return required
    ? `Saved: ${kind} off for you. Your team requires it, so your agent still takes it; your choice counts if your team stops requiring it.`
    : `Your agent won't take ${kind}, and PMX won't ask about it again. Turn it on any time: pmx categories add ${kind}`;
}

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
      const series = meetingSeries(ctx.team);
      console.log(series.length ? `Your team's internal meeting series (read for team tasks, filtered like every meeting): ${series.join(", ")}` : "Your team's internal meeting series: none. Propose some on the page's Settings → Sources.");
      if (Object.keys(routes).length) console.log(`What each feeds: ${Object.keys(routes).map((k) => `${k}: ${feeds(k)}`).join(", ")}`);
      console.log("Change what one feeds: pmx sources set granola mine");
      return 0;
    },
  },
  {
    name: "domains",
    summary: "Your company's email domains (meetings with only these people are internal and never reach team tasks), and your team's investors' and other confidential contacts'",
    usage: "pmx domains | pmx domains add <domain> | pmx domains remove <domain> | pmx domains confidential add <domain> | pmx domains confidential remove <domain>",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const [op, value] = a.positionals;
      // F5: the team's confidential contacts, a team setting: one pull request a teammate approves.
      if (op === "confidential") {
        const [, how, domain] = a.positionals;
        if (how !== "add" && how !== "remove") throw new Error("Say add or remove: pmx domains confidential add initech-ventures.example");
        const change = checkChange({ kind: "confidential-domain", op: how, value: domain }, ctx.team);
        const pr = await proposeTeamChanges(ctx, [change], { from: "terminal" });
        await rememberTeamPr({ id: pr.id, url: pr.url, at: ctx.now().toISOString(), changes: [describe(change)] });
        console.log([`Sent to your team for approval: ${pr.url}`, how === "add"
          ? "When a teammate merges it, meetings, emails and threads with someone from it are held from team work on every Mac, and its company's name never reaches Linear. Your own to-dos may still come from them."
          : "When a teammate merges it, meetings with people from it count as calls with an outside company again."].join("\n"));
        return 0;
      }
      if (op === "add" || op === "remove") {
        console.log((await applyPersonal(ctx.personal, [checkChange({ kind: "my-domain", op, value }, ctx.team)])).join("\n"));
        if (op === "remove") console.log("People on that domain now count as customers in your runs.");
        return 0;
      }
      if (op) throw new Error(`Unknown subcommand "${op}". Use add, remove or confidential.`);
      const all = companyDomains(ctx.team.internalDomains, { companyDomains: ctx.personal.companyDomains, emails: ctx.personal.identity?.emails });
      console.log([`Team's (pmx.config.json): ${ctx.team.internalDomains.join(", ") || "none"}`, `Yours (this Mac): ${(ctx.personal.companyDomains ?? []).join(", ") || "none"}`, `In use: ${all.join(", ") || "none, so PMX holds every meeting"}`,
        `Investors and other confidential contacts (pmx.config.json, held from team work): ${confidentialDomains(ctx.team.confidentialDomains).join(", ") || "none. Add one: pmx domains confidential add <domain>"}`].join("\n"));
      return 0;
    },
  },
  {
    name: "categories",
    summary: "The kinds of work your agent takes on: turn one on (add) or off (remove), as Settings → Kinds of work does",
    usage: "pmx categories | pmx categories add <kind of work> | pmx categories remove <kind of work>",
    options: {},
    async run(a) {
      const ctx = await a.ctx();
      const [op, name] = a.positionals;
      if (op === "add" || op === "remove") {
        console.log(await setTake(ctx.personal, ctx.team, name, op === "add"));
        return 0;
      }
      if (op) throw new Error(`Unknown subcommand "${op}". Use add or remove.`);
      for (const c of Object.keys(ctx.team.categories)) console.log(`${c}  ${takeWords(ctx.personal, ctx.team, c)}`);
      // JOB-11: kinds this PM never chose about; the agent skips their Ready tasks until the PM does.
      const choose = kindsToChoose(ctx.personal, ctx.team);
      if (choose.length) console.log(`\nYou haven't chosen about ${choose.join(", ")}, so your agent skips ${choose.length === 1 ? "it" : "them"}. Turn one on: pmx categories add ${choose[0]}, or keep it off: pmx categories remove ${choose[0]}`);
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
