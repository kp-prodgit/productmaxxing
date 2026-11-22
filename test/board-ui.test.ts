// The board's controls, clicked in a simulated browser against PMX's real board server (see ui-helpers.ts):
// every switch, dropdown, add box and remove button in Settings; Save, Discard, the review sheet and its Undo;
// leaving with unsaved changes; and the to-do buttons. A save is checked where it lands: the PM's settings on disk.
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TEAM, loadPersonalConfig } from "../src/core/config.js";
import { readProposals, stageProposals } from "../src/synth/proposals.js";
import { openBoard, type Ui } from "./ui-helpers.js";

let ui: Ui | null = null;
afterEach(async () => { await ui?.close(); ui = null; });
const T = 20000;
const kinds = Object.keys(DEFAULT_TEAM.categories);

/** Save Changes, then Save (or the team variant) in the review sheet; waits for the sheet to say it saved. */
async function save(u: Ui, o: { confirm?: boolean; expect?: RegExp } = {}) {
  await u.click(u.button("Save Changes", "#savebar"));
  await u.until(() => u.$("#review"), "the review sheet");
  if (o.confirm) await u.click(u.$("#review input[type=checkbox]")!);
  await u.click(u.button(/^(Save|Send to your team|Save mine and send the team's)$/, "#review"));
  await u.until(() => !/Saving/.test(u.text("#review")) && /Saved|couldn't|Couldn't/.test(u.text("#review")), "the save to finish");
  if (o.expect) expect(u.text("#review")).toMatch(o.expect);
}
const checked = (u: Ui, label: string) => u.switchFor(label).getAttribute("aria-checked");
const takes = (u: Ui, id: string) => `Your agent takes ${u.win.document.querySelector(`[data-fk="kind-${id}"]`)?.getAttribute("aria-label")?.replace("Your agent takes ", "")}`;

describe("Settings: Kinds of work", () => {
  it("every switch flips when clicked, shows in the save bar, and Discard puts it back", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    expect(ui.bar()).toMatch(/No unsaved changes/);
    const labels = ui.all("[role=switch]").map((s) => s.getAttribute("aria-label")!);
    expect(labels).toHaveLength(kinds.length);
    for (const label of labels) {
      expect(checked(ui, label)).toBe("true");
      await ui.click(ui.switchFor(label));
      expect(checked(ui, label), label).toBe("false");
      expect(ui.bar()).toMatch(/1 unsaved change: 1 just for you/);
      expect(ui.text()).toMatch(/Not saved yet/);
      expect(ui.text()).toMatch(/Skipping/);
      await ui.click(ui.button("Discard", "#savebar"));
      expect(checked(ui, label), `${label} after Discard`).toBe("true");
      expect(ui.bar()).toMatch(/No unsaved changes/);
    }
    // Two clicks are no change at all.
    await ui.click(ui.switchFor(labels[0]!)); await ui.click(ui.switchFor(labels[0]!));
    expect(ui.bar()).toMatch(/No unsaved changes/);
  }, T);

  it("turning kinds off and back on saves to your settings and survives a reload", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    const [a, b] = [takes(ui, kinds[0]!), takes(ui, kinds[1]!)];
    await ui.click(ui.switchFor(a)); await ui.click(ui.switchFor(b));
    expect(ui.bar()).toMatch(/2 unsaved changes/);
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.text("#review")).toMatch(/Stop taking .*Stop taking/);
    await ui.click(ui.button("Save", "#review"));
    await ui.until(() => /Saved/.test(ui!.text("#review h3")), "Saved");
    expect(ui.posts.at(-1)).toEqual(["changes", { changes: [{ kind: "category", name: kinds[0], accepted: false }, { kind: "category", name: kinds[1], accepted: false }], confirmLoosening: false }]);
    expect((await loadPersonalConfig()).categories).not.toContain(kinds[0]);
    expect((await loadPersonalConfig()).categories).not.toContain(kinds[1]);
    // The page shows what was saved, with nothing left to save.
    expect(checked(ui, a)).toBe("false");
    expect(ui.bar()).toMatch(/No unsaved changes/);
    expect(ui.text()).not.toMatch(/Not saved yet/);
    await ui.click(ui.button("Done", "#review"));

    await ui.reload("settings/kinds");
    expect(checked(ui, a)).toBe("false");
    expect(checked(ui, b)).toBe("false");
    expect(checked(ui, takes(ui, kinds[2]!))).toBe("true");
    // The Agents page agrees.
    await ui.go("#agents");
    expect(ui.text(`#cat-${kinds[0]}`)).toMatch(/Your agent skips these/);

    // And back on.
    await ui.go("#settings/kinds");
    await ui.click(ui.switchFor(a));
    await save(ui, { expect: /Saved for you: Take on/ });
    expect((await loadPersonalConfig()).categories).toContain(kinds[0]);
    expect(checked(ui, a)).toBe("true");
  }, T);

  it("the review sheet's Undo drops one change and keeps the rest", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    const [a, b] = [takes(ui, kinds[0]!), takes(ui, kinds[1]!)];
    await ui.click(ui.switchFor(a)); await ui.click(ui.switchFor(b));
    await ui.click(ui.button("Save Changes", "#savebar"));
    await ui.click(ui.all("#review button").find((x) => x.getAttribute("aria-label")?.startsWith(`Undo: Stop taking`))!);
    expect(ui.all("#review .chg").filter((x) => /Stop taking/.test(x.textContent ?? ""))).toHaveLength(1);
    expect(checked(ui, a)).toBe("true");
    expect(checked(ui, b)).toBe("false");
    await ui.click(ui.button("Keep editing", "#review"));
    expect(ui.$("#review")).toBeNull();
    expect(ui.bar()).toMatch(/1 unsaved change/);
  }, T);

  it("Undo after saving offers your old settings back as changes to save", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    const a = takes(ui, kinds[0]!);
    await ui.click(ui.switchFor(a));
    await save(ui);
    await ui.click(ui.button("Undo the changes just for you", "#review"));
    expect(checked(ui, a)).toBe("true");
    expect(ui.text("#review")).toMatch(/Take on/);
    await ui.click(ui.button("Save", "#review"));
    await ui.until(() => /Saved/.test(ui!.text("#review h3")), "Saved");
    expect((await loadPersonalConfig()).categories).toContain(kinds[0]);
  }, T);

  it("its More menu opens Agents and Sizes", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    await ui.click(ui.button(/^More for /));
    await ui.click(ui.button("See it in Agents", ".menu"));
    expect(ui.win.location.hash).toBe("#work/agents");
    await ui.go("#settings/kinds");
    await ui.click(ui.button(/^More for /));
    await ui.click(ui.button("Edit its sizes", ".menu"));
    expect(ui.win.location.hash).toBe("#health/settings/sizes");
  }, T);
});

describe("Settings: unsaved changes", () => {
  it("survive moving between Settings sections", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    await ui.click(ui.switchFor(takes(ui, kinds[0]!)));
    await ui.click(ui.button("Sizes", "nav[aria-label='Settings sections']"));
    expect(ui.bar()).toMatch(/1 unsaved change/);
    await ui.click(ui.button("Kinds of work", "nav[aria-label='Settings sections']"));
    expect(checked(ui, takes(ui, kinds[0]!))).toBe("false");
  }, T);

  it("leaving Settings asks first: Keep editing stays, Discard and leave drops them", async () => {
    ui = await openBoard({ hash: "settings/kinds" });
    const a = takes(ui, kinds[0]!);
    await ui.click(ui.switchFor(a));
    // Another tab of Health leaves Settings too; another Settings section doesn't.
    await ui.click(ui.$("#tab-overview")!);
    await ui.until(() => /Leave without saving/.test(ui!.text(".modal")), "the leave prompt");
    await ui.click(ui.button("Keep editing", ".modal"));
    expect(ui.win.location.hash).toBe("#health/settings/kinds");
    expect(checked(ui, a)).toBe("false");
    await ui.click(ui.$('.nav [data-view="needs"]')!);
    await ui.click(ui.button("Discard and leave", ".modal"));
    expect(ui.win.location.hash).not.toMatch(/settings/);
    await ui.go("#settings/kinds");
    expect(checked(ui, a)).toBe("true");
    expect(ui.bar()).toMatch(/No unsaved changes/);
    expect((await loadPersonalConfig()).categories).toContain(kinds[0]);
  }, T);

  it("locked privacy switches can't be turned off and make no change", async () => {
    ui = await openBoard({ hash: "settings/private" });
    const locked = ui.all("[role=switch]");
    expect(locked.length).toBeGreaterThan(5);
    for (const s of locked) {
      expect(s.hasAttribute("disabled"), s.getAttribute("aria-label")!).toBe(true);
      await ui.click(s);
      expect(s.getAttribute("aria-checked")).toBe("true");
    }
    expect(ui.bar()).toMatch(/No unsaved changes/);
  }, T);
});

describe("Settings: sources, customers and the do-not-read list", () => {
  it("a source's dropdown saves; widening it again needs the privacy box ticked", async () => {
    ui = await openBoard({ hash: "settings/sources" });
    const sel = ui.all("select").find((s) => /^What .* may feed$/.test(s.getAttribute("aria-label") ?? "")) as HTMLSelectElement;
    expect(sel).toBeTruthy();
    const source = sel.getAttribute("data-fk")!.replace("route-", "");
    await ui.pick(sel, "off");
    expect(ui.bar()).toMatch(/1 unsaved change/);
    await save(ui);
    expect((await loadPersonalConfig()).sources.routes?.[source]).toBe("off");
    await ui.click(ui.button("Done", "#review"));

    await ui.pick(ui.$(`[data-fk=route-${source}]`) as HTMLSelectElement, "linear");
    expect(ui.bar()).toMatch(/loosens privacy/);
    await ui.click(ui.button("Save Changes", "#savebar"));
    const go = ui.button("Save", "#review");
    expect(go.disabled).toBe(true);
    await ui.click(ui.$("#review input[type=checkbox]")!);
    expect(ui.button("Save", "#review").disabled).toBe(false);
    await ui.click(ui.button("Save", "#review"));
    await ui.until(() => /Saved/.test(ui!.text("#review h3")), "Saved");
    expect((await loadPersonalConfig()).sources.routes?.[source]).toBe("linear");
  }, T);

  it("your own domains: a bad one is refused, a good one saves, removing it asks to confirm", async () => {
    ui = await openBoard({ hash: "settings/customers" });
    const box = "#add-myDomains";
    await ui.type(box, "not a domain");
    (ui.$(box)!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /isn't a domain/.test(ui!.text()), "the domain error");
    expect(ui.bar()).toMatch(/No unsaved changes/);
    await ui.type(box, "acme-partner.com");
    (ui.$(box)!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /1 unsaved change/.test(ui!.bar()), "the added domain");
    await save(ui);
    expect((await loadPersonalConfig()).companyDomains).toEqual(["acme-partner.com"]);
    await ui.click(ui.button("Done", "#review"));
    await ui.click(ui.button("Remove acme-partner.com"));
    expect(ui.bar()).toMatch(/loosens privacy/);
    await save(ui, { confirm: true });
    expect((await loadPersonalConfig()).companyDomains ?? []).toEqual([]);
  }, T);

  it("do-not-read list: add a person, a title and a channel, then remove one", async () => {
    ui = await openBoard({ hash: "settings/dnr" });
    for (const [key, v] of [["people", "Dana Smith"], ["titles", "Board prep"], ["channels", "#exec"]] as const) {
      await ui.type(`#add-${key}`, v);
      (ui.$(`#add-${key}`)!.closest("form") as HTMLFormElement).requestSubmit();
      await ui.until(() => ui!.text().includes(v), v);
    }
    await ui.type("#add-people", "Al");
    (ui.$("#add-people")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /at least 3 characters/.test(ui!.text()), "the short-entry error");
    expect(ui.bar()).toMatch(/3 unsaved changes/);
    await save(ui);
    const ni = (await loadPersonalConfig()).neverIngest;
    expect([ni.people, ni.meetingTitles, ni.channels]).toEqual([["Dana Smith"], ["Board prep"], ["#exec"]]);
    await ui.click(ui.button("Done", "#review"));
    await ui.click(ui.button("Remove Board prep"));
    await save(ui, { confirm: true });
    expect((await loadPersonalConfig()).neverIngest.meetingTitles).toEqual([]);
  }, T);
});

describe("Settings: Linear, digest and limits", () => {
  it("sending your own to-dos to Linear is off, needs the privacy box to turn on, and saves", async () => {
    ui = await openBoard({ hash: "settings/linear", team: { tracker: { kind: "linear", teamKey: "PRO", projectId: "p1" } as any } });
    const label = "Let me send my own to-dos to Linear";
    expect(checked(ui, label)).toBe("false");
    await ui.click(ui.switchFor(label));
    expect(checked(ui, label)).toBe("true");
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.button("Save", "#review").disabled).toBe(true);
    await ui.click(ui.$("#review input[type=checkbox]")!);
    await ui.click(ui.button("Save", "#review"));
    await ui.until(() => /Saved/.test(ui!.text("#review h3")), "Saved");
    expect((await loadPersonalConfig()).todosToLinear).toBe(true);
    await ui.click(ui.button("Done", "#review"));
    await ui.click(ui.switchFor(label));
    await save(ui);
    expect((await loadPersonalConfig()).todosToLinear).toBe(false);
  }, T);

  it("digest day and Slack member ID save; a bad ID is refused", async () => {
    ui = await openBoard({ hash: "settings/digestset" });
    await ui.pick("[data-fk=digest-day]", "2");
    await ui.type("#add-dm", "not-an-id");
    (ui.$("#add-dm")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /isn't a member ID/.test(ui!.text()), "the member ID error");
    await ui.type("#add-dm", "U0123ABCD");
    (ui.$("#add-dm")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => /2 unsaved changes/.test(ui!.bar()), "both changes");
    await save(ui);
    const p = await loadPersonalConfig();
    expect([p.digest.weekday, p.digest.slackDmUserId]).toEqual([2, "U0123ABCD"]);
    await ui.click(ui.button("Done", "#review"));
    await ui.click(ui.button("Stop sending to Slack"));
    await save(ui);
    expect((await loadPersonalConfig()).digest.slackDmUserId).toBeNull();
  }, T);

  it("budget: a value out of range blocks Save; pausing saves; the review limit goes to the team", async () => {
    ui = await openBoard({ hash: "settings/limits" });
    await ui.pick("[data-fk=budget-mode]", "set");
    await ui.type("#budget", "99999");
    expect(ui.bar()).toMatch(/Fix the highlighted value first/);
    expect(ui.button("Save Changes", "#savebar").disabled).toBe(true);
    await ui.click(ui.button("Discard", "#savebar"));
    expect(ui.bar()).toMatch(/No unsaved changes/);
    expect((ui.$("[data-fk=budget-mode]") as HTMLSelectElement).value).toBe("set");

    await ui.pick("[data-fk=budget-mode]", "pause");
    await save(ui);
    expect((await loadPersonalConfig()).budget.dailyUsd).toBe(0);
    await ui.click(ui.button("Done", "#review"));

    // A team setting goes out for a teammate's approval, not into effect: the page keeps showing the team's value.
    const before = (ui.$("#revcap") as HTMLInputElement).value;
    await ui.type("#revcap", before === "4" ? "5" : "4");
    expect(ui.bar()).toMatch(/1 for your team to approve/);
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.button("Send to your team", "#review")).toBeTruthy();
    await ui.click(ui.button("Send to your team", "#review"));
    // BOARD-9: this test repo has no remote, so the change stays a local branch the PM applies.
    await ui.until(() => /Saved your team's changes on this Mac|couldn't be sent/.test(ui!.text("#review")), "the proposal");
    expect(ui.text("#review")).toMatch(/Saved your team's changes on this Mac\. Your team repo has no remote, so no teammate reviews them/);
    await ui.click(ui.button("Done", "#review"));
    expect((ui.$("#revcap") as HTMLInputElement).value).toBe(before);
    expect(ui.text()).toMatch(/1 team change is saved on this Mac: your team repo has no remote/);
    expect(ui.bar()).toMatch(/No unsaved changes/);

    // BOARD-9 (#16): with no remote, nobody merges it: the PM applies it, and it's the team's setting from then on.
    const { git } = await import("./helpers.js");
    const repo = ui.ctx.personal.repoPath;
    await ui.click(ui.button("Apply now", "main"));
    await ui.until(() => /Applied your team's settings/.test(ui!.text("#toast")), "the change to apply");
    expect(ui.posts.filter((p) => p[0] === "team-apply")).toEqual([["team-apply", { branch: expect.stringMatching(/^pmx\/settings-\d{14}$/) }]]);
    expect(JSON.parse(await git(repo, "show", "main:pmx.config.json")).reviewQueueCap).toBe(Number(before === "4" ? "5" : "4"));
    expect(await git(repo, "branch", "--list", "pmx/settings-*")).toBe("");
    await ui.until(() => !/team change is saved on this Mac/.test(ui!.text()), "the waiting note to go");
  }, T);
});

describe("To-dos", () => {
  it("New to-do adds one, and Mark done sends it after the undo window", async () => {
    ui = await openBoard({ hash: "anytime" });
    await ui.click(ui.$("#fab")!);
    await ui.until(() => ui!.$("#qe-in"), "the new to-do box");
    await ui.type("#qe-in", "Send Dana the pricing sheet");
    (ui.$("#qe-in")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.until(() => ui!.text().includes("Send Dana the pricing sheet"), "the new to-do");
    expect(ui.posts.find((p) => p[0] === "todo-add")?.[1]).toMatchObject({ text: "Send Dana the pricing sheet" });
    const { loadTodos } = await import("../src/todo/todo.js");
    const t = (await loadTodos()).items.find((x) => x.text === "Send Dana the pricing sheet")!;
    expect(t.status).toBe("open");
    await ui.click(ui.button("Mark done: Send Dana the pricing sheet"));
    await ui.until(() => ui!.posts.some((p) => p[0] === "todo"), "Mark done to be sent", 8000);
    for (let i = 0; i < 100 && (await loadTodos()).items.find((x) => x.id === t.id)?.status !== "done"; i++) await new Promise((r) => setTimeout(r, 30));
    expect((await loadTodos()).items.find((x) => x.id === t.id)?.status).toBe("done");
    // The page reloads after the save and drops the finished to-do from Anytime.
    await ui.until(() => !ui!.all("main [role=listitem]").some((x) => x.textContent?.includes("Send Dana the pricing sheet")), "the done to-do to leave the list");
  }, T);

  it("the period picker defaults to the last 7 days and is remembered", async () => {
    ui = await openBoard({ hash: "anytime" });
    const sel = () => ui!.$("select[aria-label='Show to-dos from meetings in']") as HTMLSelectElement;
    expect(sel().value).toBe("7");
    await ui.pick(sel(), "30");
    expect(sel().value).toBe("30");
    expect(ui.win.localStorage.getItem("pmx-todo-days")).toBe("30");
    await ui.go("#today");
    expect(sel().value).toBe("30");
  }, T);
});

// The same page as the Claude app shows it (/pmx-flow), saving through PMX's server for the Claude app.
describe("In the Claude app: Settings save through PMX's server", () => {
  it("kinds of work: each switch flips and Discard puts it back", async () => {
    ui = await openBoard({ app: true, hash: "settings/kinds" });
    const labels = ui.all("[role=switch]").map((s) => s.getAttribute("aria-label")!);
    expect(labels).toHaveLength(kinds.length);
    for (const label of labels) {
      await ui.click(ui.switchFor(label));
      expect(checked(ui, label), label).toBe("false");
      expect(ui.bar()).toMatch(/1 unsaved change/);
      await ui.click(ui.button("Discard", "#savebar"));
      expect(checked(ui, label)).toBe("true");
    }
  }, T);

  it("kinds of work: off and back on, saved on the Mac and still shown after a reload", async () => {
    ui = await openBoard({ app: true, hash: "settings/kinds" });
    const a = takes(ui, kinds[3]!);
    await ui.click(ui.switchFor(a));
    await save(ui, { expect: /Saved for you: Stop taking/ });
    expect(ui.posts.at(-1)).toEqual(["changes", { changes: [{ kind: "category", name: kinds[3], accepted: false }], confirmLoosening: false }]);
    expect((await loadPersonalConfig()).categories).not.toContain(kinds[3]);
    expect(checked(ui, a)).toBe("false");
    expect(ui.bar()).toMatch(/No unsaved changes/);
    await ui.click(ui.button("Done", "#review"));
    await ui.reload("settings/kinds");
    expect(checked(ui, a)).toBe("false");
    await ui.click(ui.switchFor(a));
    await save(ui, { expect: /Saved for you: Take on/ });
    expect((await loadPersonalConfig()).categories).toContain(kinds[3]);
    expect(checked(ui, a)).toBe("true");
  }, T);

  it("other settings save the same way: a source, a domain, the digest day and the budget", async () => {
    ui = await openBoard({ app: true, hash: "settings/sources" });
    const sel = ui.all("select").find((s) => /^What .* may feed$/.test(s.getAttribute("aria-label") ?? "")) as HTMLSelectElement;
    const source = sel.getAttribute("data-fk")!.replace("route-", "");
    await ui.pick(sel, "off");
    await ui.click(ui.button("Who counts as a customer", "nav[aria-label='Settings sections']"));
    await ui.type("#add-myDomains", "acme-partner.com");
    (ui.$("#add-myDomains")!.closest("form") as HTMLFormElement).requestSubmit();
    await ui.click(ui.button("Digest", "nav[aria-label='Settings sections']"));
    await ui.pick("[data-fk=digest-day]", "3");
    await ui.click(ui.button("Budget and limits", "nav[aria-label='Settings sections']"));
    await ui.pick("[data-fk=budget-mode]", "pause");
    expect(ui.bar()).toMatch(/4 unsaved changes: 4 just for you/);
    await save(ui);
    const p = await loadPersonalConfig();
    expect([p.sources.routes?.[source], p.companyDomains, p.digest.weekday, p.budget.dailyUsd]).toEqual(["off", ["acme-partner.com"], 3, 0]);
    expect(ui.bar()).toMatch(/No unsaved changes/);
  }, T);
});

// 0.25.1: `pmx flow --web` kept the settings it read at start for as long as it ran (days, since 0.25.0 reuses it).
// A change made elsewhere didn't show on its page, and its next save wrote the old copy back over it.
describe("The board on this Mac reads your settings as they are now", () => {
  const elsewhere = async (f: (p: any) => void) => {
    const { savePersonalConfig } = await import("../src/core/config.js");
    const p = await loadPersonalConfig(); f(p); await savePersonalConfig(p);
  };
  for (const staleServer of [false, true]) {
    it(staleServer ? "(the old wiring fails this)" : "a change made elsewhere shows on the next load, and a save here keeps it", async () => {
      ui = await openBoard({ hash: "settings/kinds", staleServer });
      // Elsewhere: the Claude app's page turns a kind off, and the collection task adds its folder.
      await elsewhere((p) => { p.categories = p.categories.filter((c: string) => c !== kinds[0]); p.sources.transcriptDirs = [...p.sources.transcriptDirs, "/tmp/pmx-collected"]; });
      const ok = async () => {
        await ui!.reload("settings/kinds");
        if (checked(ui!, takes(ui!, kinds[0]!)) !== "false") return false;
        // Here: turn another kind off and save.
        await ui!.click(ui!.switchFor(takes(ui!, kinds[1]!)));
        await save(ui!);
        const p = await loadPersonalConfig();
        return !p.categories.includes(kinds[0]!) && !p.categories.includes(kinds[1]!) && p.sources.transcriptDirs.includes("/tmp/pmx-collected");
      };
      expect(await ok()).toBe(!staleServer);
    }, T);
  }
});

describe("Needs you: new tasks to approve (old #inbox links land there)", () => {
  const seed = async () => {
    const at = new Date().toISOString(), day = at.slice(0, 10);
    await stageProposals([
      { at, receipt: "r0", title: "Export approval history to CSV", description: "Admins need a record of who approved each request.", category: "spec", size: "M", sources: ["T1"], from: [{ id: "T1", title: "Beta call", at: day, why: "asked twice" }] },
      { at, receipt: "r0", title: "Fix the wrong project name in emails", description: "Emails show the first project's name.", category: "spec", size: "S", sources: ["T2"], from: [{ id: "T2", title: "Pilot call", at: day, why: "a bug report" }] },
    ]);
  };
  const row = (u: Ui, title: string) => u.all("main [role=listitem]").find((x) => x.textContent?.includes(title));
  const waitSent = (u: Ui, n: number) => u.until(() => u.posts.filter((p) => p[0] === "proposals").length >= n, "the action to be sent", 8000);

  it("Why? opens and closes a task's reasons", async () => {
    ui = await openBoard({ hash: "inbox", before: seed });
    const why = () => ui!.all("main button").find((b) => /^(Why\?|Hide why)$/.test(b.textContent?.trim() ?? ""))!;
    expect(why().getAttribute("aria-expanded")).toBe("false");
    await ui.click(why());
    expect(why().textContent).toBe("Hide why");
    expect(ui.text()).toMatch(/What Linear would get: Admins need a record/);
    await ui.click(why());
    expect(why().getAttribute("aria-expanded")).toBe("false");
  }, T);

  // Through Claude's Linear sync (LINEAR-2), so what PMX would write is in the outbox, exactly as the sync gets it.
  const LINEAR = { kind: "linear" as const, teamKey: "PRO", projectId: "proj-1" };
  const relaySeed = async () => {
    const { relayDir } = await import("../src/tracker/relay.js");
    const { mkdir, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    await mkdir(relayDir(), { recursive: true });
    await writeFile(join(relayDir(), "snapshot.json"), JSON.stringify({ v: 1, syncedAt: new Date().toISOString(), projectId: "proj-1", issues: [] }));
    await seed();
  };
  const created = async () => (await (await import("../src/tracker/relay.js")).readOutbox()).ops.filter((o) => o.kind === "create-task") as any[];

  it("Start now sends a task to Linear as Ready for agents and takes it off the list (APPROVE-3)", async () => {
    ui = await openBoard({ hash: "inbox", team: { tracker: LINEAR as any }, before: relaySeed });
    expect(ui.text()).toMatch(/Start now makes a task Ready for agents, and Later puts it in your team's backlog/);
    expect(ui.text()).toMatch(/Start now sends a task as Ready for agents at the next Linear sync/);
    const first = row(ui, "Export approval history to CSV")!;
    expect([...first.querySelectorAll(".acts button")].map((b) => b.textContent)).toEqual(["Start now", "Later", "Drop"]);
    await ui.click(ui.button("Start now", "main [role=list]"));
    expect(ui.text("#toast")).toMatch(/Started "Export approval history to CSV"\. It becomes Ready for agents in Linear at the next Linear sync/);
    await waitSent(ui, 1);
    expect(ui.posts.find((p) => p[0] === "proposals")![1]).toMatchObject({ action: "start" });
    await ui.until(() => !row(ui!, "Export approval history to CSV"), "the started task to leave the list");
    expect((await readProposals()).map((p) => p.title)).toEqual(["Fix the wrong project name in emails"]);
    expect(await created()).toEqual([expect.objectContaining({ title: "Export approval history to CSV", status: "ready" })]);
  }, T);

  it("Later sends a task to the backlog, as Approve did", async () => {
    ui = await openBoard({ hash: "inbox", team: { tracker: LINEAR as any }, before: relaySeed });
    await ui.click(row(ui, "Fix the wrong project name in emails")!.querySelector(".acts button:nth-child(2)")!);
    expect(ui.text("#toast")).toMatch(/Approved "Fix the wrong project name in emails" for later\. It waits in your team's backlog in Linear at the next Linear sync/);
    await waitSent(ui, 1);
    expect(ui.posts.find((p) => p[0] === "proposals")![1]).toMatchObject({ action: "approve" });
    await ui.until(() => !row(ui!, "Fix the wrong project name in emails"), "the approved task to leave the list");
    const ops = await created();
    expect(ops).toHaveLength(1);
    expect(ops[0]).not.toHaveProperty("status");
  }, T);

  it("a team that has a teammate decide what agents take sees Approve and Drop only, and PMX refuses a start", async () => {
    ui = await openBoard({ hash: "inbox", team: { approve: { startNow: false } }, before: seed });
    expect(ui.text()).not.toMatch(/Start now|Start all/);
    expect(ui.text()).toMatch(/an approved task waits in the team's backlog until a teammate moves it to Ready/);
    expect([...row(ui, "Export approval history to CSV")!.querySelectorAll(".acts button")].map((b) => b.textContent)).toEqual(["Approve", "Drop"]);
    expect(ui.button("Approve all 2")).toBeTruthy();
    await ui.click(ui.button("Approve", "main [role=list]"));
    await waitSent(ui, 1);
    expect(ui.posts.find((p) => p[0] === "proposals")![1]).toMatchObject({ action: "approve" });
    await ui.until(() => !row(ui!, "Export approval history to CSV"), "the approved task to leave the list");
    // Even sent by hand, a start is refused: the setting is checked where the task is written, not only on the page.
    const { approveProposals, START_OFF } = await import("../src/synth/proposals.js");
    const { services } = await import("../src/core/services.js");
    await expect(approveProposals(ui.ctx, await services(ui.ctx), ["all"], { start: true })).rejects.toThrow(START_OFF);
    expect((await readProposals()).map((p) => p.title)).toEqual(["Fix the wrong project name in emails"]);
  }, T);

  it("Start all starts every task at once", async () => {
    ui = await openBoard({ hash: "inbox", team: { tracker: LINEAR as any }, before: relaySeed });
    await ui.click(ui.button(/^Start all 2$/));
    await ui.until(() => ui!.posts.some((p) => p[0] === "proposals"), "start all", 8000);
    for (let i = 0; i < 100 && (await readProposals()).length; i++) await new Promise((r) => setTimeout(r, 30));
    expect(await readProposals()).toEqual([]);
    expect((await created()).map((o) => o.status)).toEqual(["ready", "ready"]);
    await ui.until(() => !row(ui!, "Export approval history") && !row(ui!, "Fix the wrong"), "both to leave the list");
  }, T);

  it("Drop's Undo sends nothing; Drop without Undo drops it", async () => {
    ui = await openBoard({ hash: "inbox", before: seed });
    await ui.click(ui.all("main [role=listitem]").find((x) => x.textContent?.includes("Fix the wrong"))!.querySelector("button.sa")!);
    await ui.click(ui.button("Undo"));
    await new Promise((r) => setTimeout(r, 4400));
    expect(ui.posts).toEqual([]);
    expect(row(ui, "Fix the wrong project name in emails")).toBeTruthy();
    expect(await readProposals()).toHaveLength(2);

    await ui.click(ui.all("main [role=listitem]").find((x) => x.textContent?.includes("Fix the wrong"))!.querySelector("button.sa")!);
    await waitSent(ui, 1);
    expect(ui.posts[0]![1]).toMatchObject({ action: "drop" });
    await ui.until(() => !row(ui!, "Fix the wrong project name in emails"), "the dropped task to leave the list");
    expect((await readProposals()).map((p) => p.title)).toEqual(["Export approval history to CSV"]);
  }, T);

});

describe("Settings: your team's own kinds of work (JOB-8, JOB-9)", () => {
  const SU = { skill: "stakeholder-update", required: true };
  const withKind = async (ctx: any) => {
    const { checkKindDraft, renderKindSkill } = await import("../src/core/kinds.js");
    const { writeFileIn } = await import("../src/core/git.js");
    const { draft } = checkKindDraft({ name: "Stakeholder update", produces: "A one-page update for execs on what changed", when: "A meeting moves a date or raises a risk", stage: "operate", sections: ["Headline", "Risks"], steps: ["Lead with the change"] }, { categories: DEFAULT_TEAM.categories });
    await writeFileIn(ctx.personal.repoPath, ".claude/skills/stakeholder-update/SKILL.md", renderKindSkill("stakeholder-update", draft));
  };
  const branchFile = async (u: Ui, path: string) => {
    const { git } = await import("./helpers.js");
    const repo = u.ctx.personal.repoPath;
    const b = (await git(repo, "branch", "--list", "pmx/settings-*", "--format=%(refname:short)")).split("\n").filter(Boolean).pop()!;
    return git(repo, "show", `${b}:${path}`);
  };

  it("a team-made kind shows what it is and when it's proposed; a required one is locked on; requiring one is a team change", async () => {
    ui = await openBoard({ hash: "settings/kinds", team: { categories: { ...DEFAULT_TEAM.categories, "stakeholder-update": SU } }, personal: { categories: ["spec"] }, before: withKind });
    const row = ui.all(".sr").find((r) => r.textContent?.includes("Stakeholder update"))!;
    expect(row.textContent).toMatch(/Your team's/);
    expect(row.textContent).toMatch(/A one-page update for execs on what changed/);
    expect(row.textContent).toMatch(/Keep the work tidy · Suggested when: A meeting moves a date or raises a risk/);
    expect(row.textContent).toMatch(/Required by your team/);
    expect(row.querySelector("[role=switch]")).toBeNull();
    expect(row.textContent).toMatch(/Taking work/);

    await ui.click(ui.button("More for Spec drafting"));
    await ui.click(ui.button("Require it for everyone on the team"));
    expect(ui.bar()).toMatch(/1 for your team to approve/);
    await ui.click(ui.button("Save Changes", "#savebar"));
    expect(ui.text("#review")).toMatch(/Require Spec drafting for everyone on the team/);
    await ui.click(ui.button("Send to your team", "#review"));
    // BOARD-9: this test repo has no remote, so the change stays a local branch the PM applies.
    await ui.until(() => /Saved your team's changes on this Mac|couldn't be sent/.test(ui!.text("#review")), "the proposal");
    expect(ui.text("#review")).toMatch(/Saved your team's changes on this Mac\. Your team repo has no remote, so no teammate reviews them/);
    expect(JSON.parse(await branchFile(ui, "pmx.config.json")).categories.spec).toEqual({ skill: "pmx-spec", required: true });
    // Nothing changes until it merges: the PM's own setting is untouched.
    expect((await loadPersonalConfig()).categories).toEqual(["spec"]);
  }, T);

  it("when the team stops requiring a kind, the switch shows the PM's own choice; sending a new kind keeps other unsaved edits", async () => {
    ui = await openBoard({ hash: "settings/kinds", team: { categories: { ...DEFAULT_TEAM.categories, "stakeholder-update": SU } }, personal: { categories: ["spec"] }, before: withKind });
    await ui.click(ui.button("More for Stakeholder update"));
    await ui.click(ui.button("Stop requiring it for everyone"));
    // This PM never switched it on, so once it's no longer required their agent would skip it, and the page says so.
    expect(ui.switchFor("Your agent takes Stakeholder update").getAttribute("aria-checked")).toBe("false");
    // An unsaved personal edit, then a new kind of work sent from its own form.
    await ui.click(ui.switchFor("Your agent takes Spec drafting"));
    expect(ui.bar()).toMatch(/2 unsaved changes/);
    await ui.go("#settings/newkind");
    await ui.type("#kf-name", "Prototype brief");
    await ui.type("#kf-produces", "A short brief for a clickable prototype and what users should try");
    await ui.type("#kf-when", "A customer asks to see how something would work");
    await ui.type("#kf-steps", "Name the one user and moment it's for");
    await ui.click(ui.button("Send to your team for approval"));
    await ui.until(() => /Saved "Prototype brief"|couldn't be sent/.test(ui!.text()), "the proposal");
    expect(ui.text()).toMatch(/Saved "Prototype brief" on this Mac/);
    expect(ui.bar()).toMatch(/2 unsaved changes/);
  }, T);

  for (const app of [false, true]) it(`New kind of work: the form checks what's missing, then sends one pull request and turns it on for its author${app ? " (Claude app)" : ""}`, async () => {
    ui = await openBoard({ hash: "settings/kinds", app, personal: { categories: ["spec"] } });
    await ui.click(ui.button("New kind of work", "main"));
    await ui.until(() => ui!.$("#kf-name"), "the form");
    await ui.click(ui.button("Send to your team for approval"));
    expect(ui.text()).toMatch(/Fill in a name, what it produces, when to suggest it, at least one step first/);
    expect(ui.posts.some((p) => p[0] === "changes")).toBe(false);

    await ui.type("#kf-name", "Stakeholder update");
    expect(ui.text()).toMatch(/Its id: stakeholder-update/);
    await ui.type("#kf-produces", "A one-page update for execs on what changed this week");
    await ui.type("#kf-when", "A meeting moves a date, changes scope or raises a risk");
    await ui.pick("[data-fk=kf-stage]", "operate");
    await ui.type("#kf-sections", "Headline\nWhat changed\nRisks");
    await ui.type("#kf-steps", "Lead with the change that matters most\nGive every risk a source");
    await ui.click(ui.switchFor("It goes outside the team"));
    await ui.click(ui.button("Send to your team for approval"));
    await ui.until(() => /Saved "Stakeholder update" on this Mac|couldn't be sent/.test(ui!.text()), "the proposal");
    expect(ui.text()).toMatch(/Saved "Stakeholder update" on this Mac\. Your team repo has no remote, so no teammate reviews it: apply it in Needs you/);
    const sent = ui.posts.find((p) => p[0] === "changes")![1].changes[0];
    expect(sent).toMatchObject({ kind: "new-kind", draft: { name: "Stakeholder update", stage: "operate", sections: ["Headline", "What changed", "Risks"], externalFacing: true, required: false } });
    expect(JSON.parse(await branchFile(ui, "pmx.config.json")).categories["stakeholder-update"]).toEqual({ skill: "stakeholder-update", externalFacing: true });
    expect(await branchFile(ui, ".claude/skills/stakeholder-update/SKILL.md")).toMatch(/^description: "Stakeholder update\. A one-page update for execs/m);
    expect((await loadPersonalConfig()).categories).toEqual(["spec", "stakeholder-update"]);
    // The form is empty again, and the pull request shows as waiting.
    expect((ui.$("#kf-name") as HTMLInputElement).value).toBe("");
    expect(ui.text()).toMatch(/1 team change is saved on this Mac/);
  }, T);
});
