// R5 (founder decision 2026-11-26): no people's names in the team repo. An end-to-end test with no CRM list found a
// task's evidence pack naming a customer's VP 16 times and its legal contact 12 times, and both spec drafts naming
// people, since only four of nine drafting skills said not to. Now every drafting skill writes roles, PMX swaps every
// person it finds in a pack's sources for one placeholder each (keeping their company), packs shared before are
// written again, and setup suggests a CRM name list.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { crmNames, doctorJson, type DoctorCheck } from "../src/commands/doctor.js";
import { DEFAULT_TEAM, type PersonalConfig } from "../src/core/config.js";
import { execOk } from "../src/core/exec.js";
import { Git } from "../src/core/git.js";
import { checkKindDraft, NO_NAMES_RULE, renderKindSkill } from "../src/core/kinds.js";
import { buildKnown, peopleSwap } from "../src/core/people-swap.js";
import { services } from "../src/core/services.js";
import { bundledSkillsDir, listBundledSkills } from "../src/core/skills.js";
import { skillMeta } from "../src/core/skillcheck.js";
import { loadState, updateState, type State } from "../src/core/state.js";
import { namesIn, trackerGuard } from "../src/core/tracker-text.js";
import { AUTO_STEPS } from "../src/core/upgrade.js";
import { pull } from "../src/pull/pull.js";
import { sourcePeople } from "../src/run/comment.js";
import { runInstructions } from "../src/run/environments.js";
import { pickPassages, runEvidence } from "../src/run/evidence.js";
import { evidenceStore, NAME_SWAP, swappedPack, type EvidencePack } from "../src/run/packs.js";
import { knownPeople } from "../src/run/known-people.js";
import { backfillEvidence, evidenceStep } from "../src/run/share.js";
import { mockRuntime } from "../src/runtime/mock.js";
import { buildChecklist, checklistForPage, type ChecklistInputs } from "../src/setup/checklist.js";
import { approveProposals, readProposals } from "../src/synth/proposals.js";
import { synthesize } from "../src/synth/synthesize.js";
import { memoryTracker } from "../src/tracker/types.js";
import { freshHome, git, pmxRepo, testCtx, tmp, writeTranscript } from "./helpers.js";

/** A customer call naming its contacts every way a file does: attendees, speaker labels, running text, an address, a handle. */
const CALL = [
  "---", "title: Globex SSO review", "participants: Dana Ruiz <dana.ruiz@globex.example>, sam@us.com", "---",
  "Dana Ruiz: Every Friday we export a CSV of our users for lack of SCIM and paste it into your admin screen.",
  "",
  "Sam: How long does that take, and who signs off on SCIM?",
  "",
  "Dana: About two hours. SCIM provisioning would fix it. Lee Park in Globex legal has the security questionnaire; ask Lee for it, or write to lee.park@globex.example.",
  "",
  "Sam: Thanks, dana. I'll loop in @dana.ruiz on the SCIM thread.",
].join("\n");
const NAMES = /Dana|Ruiz|\bLee\b|Park|\bSam\b|dana\.ruiz|lee\.park|sam@/i;

const team = { internalDomains: ["us.com"], tracker: { kind: "linear" as const, teamKey: "PMX", projectId: "pmx-1" } };

const SPEC = (id: string) => `# Spec SCIM provisioning\n\n## Problem\n\nAdmins copy users by hand every week [${id}].\n\n## Evidence\n\n- A weekly CSV export [${id}]\n\n## Validated by\n\nNot yet.\n\n## Proposal\n\nSCIM.\n\n## Success metrics\n\n- No weekly export.\n\n## Open questions\n\n- Which identity providers first?\n`;

function runtime() {
  const seen: string[] = [];
  const rt = mockRuntime(async (o) => {
    if (!o.tools.length) {
      const items = [...o.prompt.matchAll(/<item id="([A-Z]\d+)"[^>]*>\n([\s\S]*?)<\/item>/g)];
      const id = items.find((m) => m[2]!.includes("SCIM"))![1]!;
      return JSON.stringify({ tasks: [{ title: "Spec SCIM provisioning", category: "spec", size: "M", rationale: "Admins keep user lists in sync by hand.", sources: [id], support: { [id]: "The customer exports users weekly." } }] });
    }
    const task = await readFile(join(o.cwd, ".pmx/tmp/task.md"), "utf8");
    seen.push(task);
    const id = task.match(/### \[([A-Z]\d+)\]/)?.[1] ?? "T1";
    const out = o.prompt.match(/Write the output to (\S+?\.md)/)![1]!;
    await mkdir(dirname(join(o.cwd, out)), { recursive: true });
    await writeFile(join(o.cwd, out), SPEC(id));
    return { text: "Drafted.", costUsd: 0.1 };
  });
  return Object.assign(rt, { seen });
}

async function suggestingMac(call = CALL) {
  const { repo, origin } = await pmxRepo({ internalDomains: ["us.com"] }, { remote: true });
  const dir = await tmp("t-");
  await writeTranscript(dir, "globex.md", call);
  const rt = runtime();
  const personal = { sources: { transcriptDirs: [dir], slackChannel: null } };
  const ctx = await testCtx({ repo, runtime: rt, team, personal });
  const tracker = memoryTracker();
  const svc = await services(ctx, { tracker });
  await synthesize(ctx, svc, { days: 7 });
  return { repo, origin: origin!, dir, rt, ctx, tracker, svc, personal, home: process.env.PMX_HOME! };
}

const packIn = async (gitDir: string, id: string): Promise<any> => JSON.parse(await execOk("git", ["--git-dir", gitDir, "show", `refs/pmx/evidence/${id}:${id}.json`]));
const passagesOf = (p: { sources: { passages: string[] }[] }) => p.sources.flatMap((s) => s.passages).join("\n");

async function clone(origin: string, name: string): Promise<string> {
  const repo = join(await tmp(`${name}-`), "pmx");
  await execOk("git", ["clone", "-q", origin, repo]);
  await git(repo, "config", "user.name", "Test");
  await git(repo, "config", "user.email", "test@example.com");
  return repo;
}

describe("a task's evidence pack names no one (R5)", () => {
  beforeEach(freshHome);

  it("swaps the customer's contacts in speakers, attendees and text for one placeholder each, and keeps the companies", async () => {
    const a = await suggestingMac();
    await approveProposals(a.ctx, a.svc, ["1"], { start: true });
    const pack = await packIn(a.origin, "PMX-1");
    const text = passagesOf(pack);
    expect(text).toContain("SCIM provisioning would fix it");
    // No name, address or handle, however the call wrote it.
    expect(JSON.stringify(pack)).not.toMatch(NAMES);
    // One number a person, across a speaker label, a full name, a first name, a lower-case reply and a handle.
    expect(text).toContain("[PERSON-1, Globex]: Every Friday we export a CSV");
    expect(text).toContain("[PERSON-1, Globex]: About two hours.");
    expect(text).toContain("Thanks, [PERSON-1, Globex]. I'll loop in [PERSON-1, Globex] on the SCIM thread.");
    // The PM, by their company's domain; the legal contact, from the address in the text.
    expect(text).toContain("[PERSON-2, our company]: How long does that take");
    expect(text).toContain("[PERSON-3, Globex] in Globex legal has the security questionnaire; ask [PERSON-3, Globex] for it, or write to [PERSON-3, Globex].");
    // The company stays, and the pack says which outside companies its sources are with.
    expect(pack).toMatchObject({ nameSwap: 2, companies: ["globex"] });

    // On this Mac the agent is shown the same, so a draft written here names no one either.
    const task = [...a.tracker.tasks.values()][0]!;
    const here = await runEvidence(a.ctx, task);
    expect(here.from).toBe("here");
    expect(here.sources).toEqual(pack.sources);
    // The real names stay in memory for the guards only.
    expect(here.people).toEqual(expect.arrayContaining(["Dana Ruiz", "Lee Park"]));
    expect(sourcePeople(here, ["us.com"])).toEqual(expect.arrayContaining(["Dana Ruiz", "Dana", "Lee Park"]));

    // A teammate's agent drafts from the pack, and its tracker guard knows Globex is a company, not a person.
    await freshHome();
    const b = await testCtx({ repo: await clone(a.origin, "mac-b"), runtime: a.rt, team, personal: { handle: "ben", machineId: "m2" } });
    const svcB = await services(b, { tracker: a.tracker });
    const there = await runEvidence(b, task);
    expect(there).toMatchObject({ from: "team", companies: ["globex"], swapped: true });
    expect(sourcePeople(there, [], there.companies)).not.toContain("Globex");
    expect((await pull(b, svcB, { dryRun: false })).ran).toMatchObject({ outcome: "ok" });
    const shown = a.rt.seen.at(-1)!;
    expect(shown.slice(shown.indexOf("<task_data>"), shown.indexOf("</task_data>"))).not.toMatch(NAMES);
    // Every run is told to write roles, whatever the team's copy of the skill says.
    expect(a.rt.calls.at(-1)!.prompt).toContain("Write no person's name in anything you write");
  });

  it("keeps the CRM list's names out too, under the same numbering, in any case", async () => {
    const call = CALL.replace("Every Friday", "Robin Hale wants it fixed. Every Friday").replace("About two hours.", "About two hours, says ROBIN HALE.");
    const a = await suggestingMac(call);
    const crm = join(await tmp("crm-"), "names.txt");
    await writeFile(crm, "Robin Hale\n");
    const ctx = await testCtx({ repo: a.repo, runtime: a.rt, team, personal: { ...a.personal, crmNamesFile: crm } });
    const [p] = await readProposals();
    const task = { identifier: "PMX-9", title: p!.title, description: p!.description, sources: p!.sources };
    const text = passagesOf(await runEvidence(ctx, task));
    expect(text).not.toMatch(/Robin|Hale/i);
    expect(text).toContain("[PERSON-1, Globex]: [PERSON-2] wants it fixed.");
    expect(text).toContain("About two hours, says [PERSON-2].");
  });
});

describe("the name swap (R5)", () => {
  it("never guesses: a word two people share, a free mail or vanity domain, an ordinary word that is also a name", () => {
    const s = peopleSwap({
      items: [{
        participants: ["Dana Ruiz <dana@danaruiz.example>", "Dana Cole <dcole@gmail.com>", "Max Weber <max@initech.example>", "lee@us.com"],
        text: "Dana Ruiz: The Max plan is too dear.\nDana Cole: Agreed. Ask Dana about the renewal.\nMax: Thanks Max, I mean Lee.\nLee: Pricing moves to per-seat for Initech in March.",
      }],
      internalDomains: ["us.com"],
    });
    expect(s.swap("Dana Ruiz: The Max plan is too dear.")).toBe("[PERSON-1]: The Max plan is too dear.");
    expect(s.swap("Dana Cole: Agreed. Ask Dana about the renewal.")).toBe("[PERSON-2]: Agreed. Ask [PERSON] about the renewal.");
    expect(s.swap("Max: Thanks Max, I mean Lee.")).toBe("[PERSON-3, Initech]: Thanks [PERSON-3, Initech], I mean [PERSON-4, our company].");
    expect(s.swap("Lee: Pricing moves to per-seat for Initech in March.")).toBe("[PERSON-4, our company]: Pricing moves to per-seat for Initech in March.");
    expect(s.companies).toEqual(["initech"]);
  });

  it("goes on from the numbers a text already has", () => {
    const s = peopleSwap({ items: [{ text: "[PERSON-3] asked for SSO.\nSam Ortiz: We need it by Jan 15." }], from: 3 });
    expect(s.swap("Sam Ortiz: We need it by Jan 15.")).toBe("[PERSON-4]: We need it by Jan 15.");
  });

  it("the tracker guard knows a placeholder with a company", () => {
    expect(trackerGuard().problem("[PERSON-2, Globex] needs SSO by Jan 15.")).toBe("placeholder");
    expect(trackerGuard().problem("Globex needs SSO by Jan 15.")).toBeNull();
  });
});

describe("packs from the first name swap (R5a)", () => {
  it("are swapped again: a pack marked nameSwap 1 doesn't count as swapped", () => {
    expect(swappedPack({ nameSwap: 1 })).toBe(false);
    expect(swappedPack({ nameSwap: 2 })).toBe(true);
    expect(swappedPack({})).toBe(false);
  });
});

describe("packs shared before the name swap (R5)", () => {
  beforeEach(freshHome);

  /** The pack as PMX 0.37.0 wrote it: names everywhere, no `nameSwap`, no companies. */
  async function oldPack(a: Awaited<ReturnType<typeof suggestingMac>>) {
    const task = [...a.tracker.tasks.values()][0]!;
    const old: EvidencePack = { v: 1, task: task.identifier, at: "2026-11-25T10:00:00.000Z", sources: [{ id: task.sources[0]!, kind: "meeting", at: "2026-11-24", passages: [
      "Dana Ruiz: Every Friday we export a CSV of our users for lack of SCIM and paste it into your admin screen.",
      "Dana: About two hours. SCIM provisioning would fix it. Lee Park in Globex legal has the security questionnaire; ask Lee for it.",
    ] }] };
    await evidenceStore(new Git(a.repo)).write({ put: [old] }, `evidence: quotes for ${task.identifier}`);
    return { task, old };
  }

  it("the update makes the next background run write this Mac's again, with no name left in the ref's history", async () => {
    const a = await suggestingMac();
    await a.tracker.createInbox({ ...(await readProposals())[0]!, ready: true });
    const { task, old } = await oldPack(a);
    expect(passagesOf(await packIn(a.origin, task.identifier))).toMatch(/Dana Ruiz/);

    // R5e: keyed to the name swap, so a bump rewrites again even after an earlier swap's step ran on this Mac.
    const step = AUTO_STEPS.find((s) => s.id === `evidence-names-${NAME_SWAP}`)!;
    expect(step).toMatchObject({ since: null, title: "The quotes this Mac shared name no one" });
    await updateState((s) => { s.evidenceNameSwap = NAME_SWAP - 1; s.evidenceBackfill = { at: a.ctx.now().toISOString(), due: false }; });
    expect(await step.run({} as any)).toMatch(/^the next background run writes the quotes this Mac shared/);
    expect(await loadState()).toMatchObject({ evidenceNameSwap: NAME_SWAP, evidenceBackfill: { due: true } });
    // Once per swap: the next update with the same swap does nothing.
    expect(await step.run({} as any)).toBeNull();
    expect(await evidenceStep(a.ctx, async () => a.svc)).toBe(`took the names out of the shared quotes of ${task.identifier}`);

    const pack = await packIn(a.origin, task.identifier);
    expect(JSON.stringify(pack)).not.toMatch(NAMES);
    expect(pack).toMatchObject({ nameSwap: 2, companies: ["globex"], at: old.at });
    expect(passagesOf(pack)).toContain("[PERSON-1, Globex]: Every Friday we export a CSV");
    // Removed and written afresh: one commit, so the old one with the names is in no ref's history.
    expect(await git(a.origin, "rev-list", "--count", `refs/pmx/evidence/${task.identifier}`)).toBe("1");
    expect(await evidenceStore(new Git(a.repo)).writer(task.identifier)).toBe("ana");
    // Done once: the next look changes nothing.
    expect(await backfillEvidence(a.ctx, a.svc)).toEqual({ shared: [], notices: [], more: 0, failed: 0 });
  });

  it("without the sources any more, the pack's own passages are swapped; and a teammate's agent never sees an old pack's names", async () => {
    const a = await suggestingMac();
    await a.tracker.createInbox({ ...(await readProposals())[0]!, ready: true });
    const { task } = await oldPack(a);

    // Sam's Mac reads the old pack before Ana's Mac has written it again: its agent gets the names swapped.
    const homeA = a.home;
    await freshHome();
    const b = await testCtx({ repo: await clone(a.origin, "mac-b"), runtime: a.rt, team, personal: { handle: "sam", machineId: "m2" } });
    const there = await runEvidence(b, task);
    expect(there.from).toBe("team");
    expect(passagesOf(there)).not.toMatch(NAMES);
    expect(passagesOf(there)).toContain("[PERSON-1]: Every Friday");
    expect(there.people).toEqual(expect.arrayContaining(["Dana Ruiz", "Lee Park"]));
    // Sam's Mac never rewrites a teammate's pack.
    expect((await backfillEvidence(b, await services(b, { tracker: a.tracker }))).rewritten).toBeUndefined();

    // Ana's call is gone from her folders: her Mac swaps the names in the pack's own passages.
    process.env.PMX_HOME = homeA;
    await rm(join(a.dir, "globex.md"));
    const r = await backfillEvidence(a.ctx, a.svc);
    expect(r.rewritten).toEqual([task.identifier]);
    const pack = await packIn(a.origin, task.identifier);
    expect(JSON.stringify(pack)).not.toMatch(NAMES);
    expect(pack.nameSwap).toBe(2);
    expect(passagesOf(pack)).toContain("[PERSON-2] in Globex legal has the security questionnaire; ask [PERSON-2] for it.");
  });
});

describe("every drafting skill writes roles, not names (R5)", () => {
  const DRAFTING = ["pmx-build-brief", "pmx-competitive", "pmx-decision-brief", "pmx-hygiene", "pmx-problem-brief", "pmx-research", "pmx-spec", "pmx-validation-plan", "pmx-validation-readout"];

  it("PMX's nine drafting skills say so in their drafting rules and their checklist", async () => {
    // The drafting skills are the kinds of work: each writes a draft to outputs/ in the team repo.
    const kinds: string[] = [];
    for (const s of await listBundledSkills()) if ((skillMeta(await readFile(join(bundledSkillsDir(), s, "SKILL.md"), "utf8")) as any).kind === "category") kinds.push(s);
    expect(kinds.sort()).toEqual(DRAFTING);
    for (const s of DRAFTING) {
      const text = await readFile(join(bundledSkillsDir(), s, "SKILL.md"), "utf8");
      const rules = text.slice(text.indexOf("## Drafting rules"), text.indexOf("## Quality checklist"));
      const checks = text.slice(text.indexOf("## Quality checklist"));
      expect(rules, s).toContain(s === "pmx-hygiene" ? "- No names other than redaction placeholders. Write each person as their role and team" : `- ${NO_NAMES_RULE}`);
      expect(checks, s).toMatch(/^- \[ \] No names other than redaction placeholders: people appear as their role( and company)?, never by name\./m);
    }
    expect(NO_NAMES_RULE).toContain("\"Globex's brand lead\", \"our head of product\"");
  });

  it("the digest, which goes to the team repo once approved, too; the private to-dos and the tracker's skills keep their own rules", async () => {
    const read = (s: string) => readFile(join(bundledSkillsDir(), s, "SKILL.md"), "utf8");
    expect(await read("pmx-digest")).toMatch(/- No people's names, in a theme, a bullet or a quote: an approved digest goes to your team's repo\. Write each person as their role and company/);
    expect(await read("pmx-synthesize")).toMatch(/Never include people's names/);
  });

  it("a kind of work a team defines says so, and so does every run's instructions", () => {
    const { slug, draft } = checkKindDraft({ name: "Stakeholder update", produces: "A weekly update for execs on what changed.", when: "A launch date moves or a risk appears.", not: null, stage: "operate", sections: ["Headline", "Risks"], steps: ["Read the sources.", "Write the update."], checks: [], minCitations: 1, externalFacing: false, required: false, sizes: {}, example: null }, { categories: DEFAULT_TEAM.categories });
    const text = renderKindSkill(slug, draft);
    expect(text).toContain(`- ${NO_NAMES_RULE}`);
    expect(text).toContain("- [ ] No names other than redaction placeholders: people appear as their role and company, never by name.");
    const env = { kind: "document", output: { kind: "file" }, tools: [] } as any;
    expect(runInstructions(env, "outputs/spec/PMX-1.md", "PMX-1")).toContain("write their role and company (\"Globex's brand lead\", \"our head of product\")");
  });
});

describe("setup suggests a CRM name list (R5)", () => {
  beforeEach(freshHome);

  it("doctor warns without one, and never fails for it", async () => {
    const none = await crmNames(null);
    expect(none.ok).toBe(false);
    expect(none.detail).toMatch(/^no customer name list\. PMX swaps the people it finds/);
    expect(none.detail).toContain("set \"crmNamesFile\" to the file's full path in ~/.pmx/config.json");
    const file = join(await tmp("crm-"), "names.txt");
    expect((await crmNames(file)).detail).toMatch(/can't read your customer name list/);
    await writeFile(file, "Dana Ruiz\nLee Park\n\n");
    expect(await crmNames(file)).toEqual({ ok: true, detail: "customer name list: 2 names, swapped for placeholders wherever they appear" });
    const check: DoctorCheck = { id: "privacy.crm-names", ok: false, detail: none.detail, level: "warn" };
    expect(doctorJson([check])).toMatchObject({ ok: true, failed: [], warnings: ["privacy.crm-names"] });
  });

  it("the checklist shows it as an optional step, with how to add one", () => {
    const i: ChecklistInputs = {
      now: new Date("2026-11-26T12:00:00Z"), version: "0.38.0",
      personal: { handle: "kp", repoPath: "/tmp/pmx", installedAt: "2026-11-20T07:00:00Z", taskHours: "always" } as unknown as PersonalConfig,
      team: { ...DEFAULT_TEAM, tracker: { kind: "linear", teamKey: "PMX", projectId: "p" } } as any,
      checks: [{ id: "privacy.crm-names", ok: false, detail: "no customer name list", level: "warn" }],
      state: { collectReports: [], tickGaps: [] } as unknown as State, claude: false, hasRemote: true, memoryFilled: true, proposals: 0, tasks: null,
      practiceUntil: null, lastRun: null, setupSkill: "current", linearCron: null, engine: null, extra: [],
    };
    const cl = buildChecklist(i);
    const s = cl.sections.flatMap((x) => x.steps).find((x) => x.id === "setup.names")!;
    expect(s).toMatchObject({ title: "PMX knows your customers' names", status: "warn", required: false, who: "you", fix: { kind: "claude", command: "/pmx-setup" } });
    expect(s.do).toMatch(/^Optional: save your customers' contacts in a text file, one full name per line/);
    expect(checklistForPage(cl)!.sections.flatMap((x) => x.steps).find((x) => x.id === "setup.names")!.page).toMatch(/^Optional: give PMX a list of your customers' names/);
    // With a list, it's done; before setup, it doesn't apply.
    const done = buildChecklist({ ...i, checks: [{ id: "privacy.crm-names", ok: true, detail: "customer name list: 2 names", level: "warn" }] });
    expect(done.sections.flatMap((x) => x.steps).find((x) => x.id === "setup.names")).toMatchObject({ status: "done" });
    expect(buildChecklist({ ...i, checks: [] }).sections.flatMap((x) => x.steps).find((x) => x.id === "setup.names")).toMatchObject({ status: "skip" });
  });
});

describe("a participant is a person whatever the task's text calls them (R5)", () => {
  it("a name a task from before R4 used as a thing is still swapped where a participant has it", () => {
    const s = peopleSwap({ items: [{ participants: ["dana.ruiz@globex.example"], text: "Dana Ruiz: We need SSO.\nGlobex: the renewal is due Jan 15. Dana said so." }], companies: ["Dana", "Globex"] });
    expect(s.swap("Dana Ruiz: We need SSO.")).toBe("[PERSON-1, Globex]: We need SSO.");
    expect(s.swap("Globex: the renewal is due Jan 15. Dana said so.")).toBe("Globex: the renewal is due Jan 15. [PERSON-1, Globex] said so.");
  });
});

describe("a long passage keeps its placeholders whole (R5)", () => {
  it("is cut before a placeholder, never inside one", () => {
    const text = `${"We export a CSV every Friday and it takes hours. ".repeat(14)}Dana Ruiz signs.`;
    const passages = pickPassages(peopleSwap({ items: [{ participants: ["dana.ruiz@globex.example"], text }] }).swap(text), "CSV export");
    expect(passages[0]!.length).toBeLessThanOrEqual(701);
    expect(passages[0]).not.toMatch(/\[[^\]]*$/);
  });
});

describe("everyone this Mac knows is swapped, not only who the task's sources introduce (R5a)", () => {
  // Other meetings and threads on this Mac, and the team's own people (handles, an address), as `knownPeople` reads them.
  const known = buildKnown({
    items: [
      { participants: ["lee.park@globex.example", "avery.stone@initech.example"], text: "Theo: the pilot starts Monday." },
      { participants: [], text: "Thanks Sean for the notes." },
    ],
    team: ["ben", "mei-lin", "sam.ortiz@us.com", "will-grant"], internalDomains: ["us.com"],
  });
  const text = "Dana Ruiz: Lee at Globex said yes. Dana asked whether Theo says ok. Avery's legal question is open; Ben's seen the cost side; Mei's files and Sam's compliance list are in. Met w/ Sean. Will we ship? I met w/ Will.";

  it("bare first names, possessives and \"w/\", each the one person this Mac knows by that name, with their company", () => {
    const s = peopleSwap({ items: [{ participants: ["dana.ruiz@globex.example"], text }], internalDomains: ["us.com"], known });
    expect(s.swap(text)).toBe("[PERSON-1, Globex]: [PERSON-2, Globex] at Globex said yes. [PERSON-1, Globex] asked whether [PERSON-3] says ok. [PERSON-4, Initech]'s legal question is open; [PERSON-5, our company]'s seen the cost side; [PERSON-6, our company]'s files and [PERSON-7, our company]'s compliance list are in. Met w/ [PERSON-8]. Will we ship? I met w/ [PERSON-9, our company].");
  });

  it("a name the task's own sources give wins over someone else this Mac knows by the same first name", () => {
    const more = buildKnown({ items: [{ participants: ["dana.cole@initech.example"], text: "" }] });
    const s = peopleSwap({ items: [{ participants: ["dana.ruiz@globex.example"], text: "Dana Ruiz: hi.\nDana asked for SSO." }], known: more });
    expect(s.swap("Dana asked for SSO.")).toBe("[PERSON-1, Globex] asked for SSO.");
  });

  it("this Mac's meetings, threads, lists and team are what it knows", async () => {
    await freshHome();
    const { repo } = await pmxRepo({ internalDomains: ["us.com"] });
    const dir = await tmp("t-");
    await writeTranscript(dir, "older.md", ["---", "title: Initech intro", "participants: avery.stone@initech.example, kp@us.com", "---", "Avery Stone: We use a spreadsheet."].join("\n"));
    await writeFile(join(repo, "CODEOWNERS"), "/memory/ @HEAD-OF-PRODUCT @mei-lin @org/pms\n");
    const crm = join(await tmp("crm-"), "names.txt");
    await writeFile(crm, "Robin Hale\n");
    const ctx = await testCtx({ repo, team: { internalDomains: ["us.com"], productLead: "ben" }, personal: { sources: { transcriptDirs: [dir], slackChannel: null }, crmNamesFile: crm } as any });
    const k = await knownPeople(ctx);
    const keys = k.people.map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["avery stone", "mei lin", "ben", "robin hale"]));
    expect(keys).not.toEqual(expect.arrayContaining(["head of product"]));
    expect(k.people.find((p) => p.key === "mei lin")).toMatchObject({ ours: true });
    expect(k.strong).toEqual(expect.arrayContaining(["avery", "mei", "ben"]));
  });
});

describe("a company's own words are the company's (R5c)", () => {
  it("a notes label or a run that starts with a known company is no one's name, possessive included", () => {
    const sentence = "Globex Hotels' 14-property expansion closed lost on Nov 23, so the renewal is at risk.";
    for (const passage of ["Globex Hotels: 14-property expansion closed lost on Nov 23.", "[PERSON-1, Globex]: Globex Hotels' 14-property expansion closed lost."]) {
      const people = sourcePeople({ sources: [{ passages: [passage] }] }, [], ["globex"]);
      expect(people, passage).not.toEqual(expect.arrayContaining(["Hotels"]));
      expect(trackerGuard({ people }).problem(sentence), passage).toBeNull();
    }
    const s = peopleSwap({ items: [{ participants: ["dana@globex.example"], text: "Globex Hotels: 14-property expansion closed lost.\nDana: Globex Hotels' renewal is at risk." }], companies: ["Globex Hotels"] });
    expect(s.swap("Globex Hotels: 14-property expansion closed lost.")).toBe("Globex Hotels: 14-property expansion closed lost.");
    // The placeholder spells the company as the task does.
    expect(s.swap("Dana: Globex Hotels' renewal is at risk.")).toBe("[PERSON-1, Globex Hotels]: Globex Hotels' renewal is at risk.");
  });
});

describe("a personal mailbox says no company (R5d)", () => {
  it("free and personal mail domains give a placeholder without a company, and no pack company", () => {
    const s = peopleSwap({ items: [{ participants: ["dana@inbox.example", "lee@hey.com", "sam@zoho.com", "avery@mail.example", "theo@globex.example"], text: "Dana: hi\nLee: hi\nSam: hi\nAvery: hi\nTheo: hi" }] });
    expect(s.swap("Dana: hi\nLee: hi\nSam: hi\nAvery: hi\nTheo: hi")).toBe("[PERSON-1]: hi\n[PERSON-2]: hi\n[PERSON-3]: hi\n[PERSON-4]: hi\n[PERSON-5, Globex]: hi");
    expect(s.companies).toEqual(["globex"]);
  });
});

describe("names mentioned only in passing, by role or by surname (R5a)", () => {
  it("a name in parentheses after a role, before \", my <role>\" or after \"our <role>,\" is a person's", () => {
    const text = "Her VP (Robin) wants SSO first. The publisher (Inez) agreed. Noor, my VP, signs off. Our head of product, Tamsin, owns pricing. The plan (Pro) stays. Our partner, Globex, resells it.";
    const found = namesIn([{ text }]).map((n) => n.name);
    expect(found).toEqual(expect.arrayContaining(["Robin", "Inez", "Noor", "Tamsin"]));
    expect(found).not.toEqual(expect.arrayContaining(["Pro"]));
    expect(found).not.toEqual(expect.arrayContaining(["Globex"]));
    expect(peopleSwap({ items: [{ text }] }).swap(text)).toBe("Her VP ([PERSON-1]) wants SSO first. The publisher ([PERSON-2]) agreed. [PERSON-3], my VP, signs off. Our head of product, [PERSON-4], owns pricing. The plan (Pro) stays. Our partner, Globex, resells it.");
  });

  it("a known person's surname that is also a word: with a possessive, or doing what a person does mid-sentence", () => {
    const known = buildKnown({ items: [{ participants: ["Theo Grant <theo.grant@initech.example>"], text: "" }] });
    const text = "Grant's skeleton variant ships first, as Grant said. The grant's terms are fixed. Grant access to the admin first.";
    expect(peopleSwap({ items: [{ text }], known }).swap(text)).toBe("[PERSON-1, Initech]'s skeleton variant ships first, as [PERSON-1, Initech] said. The grant's terms are fixed. Grant access to the admin first.");
  });
});

describe("a swapped pack's passages name no one, so the guard reads no people from them (R5c)", () => {
  const passages = ["[Stage Proposal → Closed Lost] on Nov 23.", "Initech: by hand is OK for now.", "Teach Acme your brand", "[PERSON-1, Globex]: Globex Hotels' 14-property expansion closed lost."];

  it("not a stage, a company's label or a screen's words, and its people are only the ones this Mac's memory has", () => {
    expect(sourcePeople({ sources: [{ passages }], swapped: true }, [], ["globex"])).toEqual([]);
    expect(sourcePeople({ sources: [{ passages }], swapped: true, people: ["Dana Ruiz"] })).toEqual(expect.arrayContaining(["Dana Ruiz", "Dana"]));
    const guard = trackerGuard({ people: sourcePeople({ sources: [{ passages }], swapped: true }, [], ["globex"]) });
    for (const s of ["Initech runs integrations.", "Globex Hotels' 14-property expansion closed lost on Nov 23, so the renewal is at risk.", "Acme wants the brand step first."]) expect(guard.problem(s), s).toBeNull();
  });

  it("text that wasn't swapped never gives names from a stage line or a quoted screen string", () => {
    const found = namesIn([{ text: "[Stage Proposal → Closed Lost] on Nov 23.\nThe first card says \"Teach Acme your brand\" today." }]).map((n) => n.name);
    expect(found).not.toEqual(expect.arrayContaining(["Closed Lost"]));
    expect(found).not.toEqual(expect.arrayContaining(["Teach Acme"]));
    expect(found).toEqual([]);
  });
});

describe("what a placeholder keeps, spelled as the sources do; no brand taken for a person (R5)", () => {
  it("the company as the sources write it, \"&\" included", () => {
    const s = peopleSwap({ items: [{ participants: ["Dana Ruiz <dana@hartstone.example>"], text: "Dana Ruiz: Hart & Stone's imprint ships in March." }] });
    expect(s.swap("Dana Ruiz: Hart & Stone's imprint ships in March.")).toBe("[PERSON-1, Hart & Stone]: Hart & Stone's imprint ships in March.");
  });

  it("a one-word display name that is a shared mailbox's or a brand's is no one's", () => {
    const items = [{ participants: ["Bluefin <news@imprint.example>", "Kestrel", "dana.ruiz@globex.example"], text: "Dana Ruiz: the Kestrel team sent the proofs. Bluefin ships the reprint." }];
    const known = buildKnown({ items });
    expect(known.people.map((p) => p.key)).not.toEqual(expect.arrayContaining(["bluefin"]));
    expect(known.people.map((p) => p.key)).not.toEqual(expect.arrayContaining(["kestrel"]));
    expect(peopleSwap({ items }).swap(items[0]!.text)).toBe("[PERSON-1, Globex]: the Kestrel team sent the proofs. Bluefin ships the reprint.");
  });
});
