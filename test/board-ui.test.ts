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
  await u.click(u.button(/^(Save|Propose to your team|Save mine and propose the team's)$/, "#review"));
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
    expect(ui.win.location.hash).toBe("#agents");
    await ui.go("#settings/kinds");
    await ui.click(ui.button(/^More for /));
    await ui.click(ui.button("Edit its sizes", ".menu"));
    expect(ui.win.location.hash).toBe("#settings/sizes");
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
    await ui.click(ui.button("Back"));
    await ui.until(() => /Leave without saving/.test(ui!.text(".modal")), "the leave prompt");
    await ui.click(ui.button("Keep editing", ".modal"));
    expect(ui.win.location.hash).toBe("#settings/kinds");
    expect(checked(ui, a)).toBe("false");
    await ui.click(ui.button("Back"));
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
    expect(ui.button("Propose to your team", "#review")).toBeTruthy();
    await ui.click(ui.button("Propose to your team", "#review"));
    await ui.until(() => /Sent your team's changes for approval|couldn't be sent/.test(ui!.text("#review")), "the proposal");
    expect(ui.text("#review")).toMatch(/Sent your team's changes for approval/);
    await ui.click(ui.button("Done", "#review"));
    expect((ui.$("#revcap") as HTMLInputElement).value).toBe(before);
    expect(ui.text()).toMatch(/1 team change is waiting for a teammate's approval/);
    expect(ui.bar()).toMatch(/No unsaved changes/);
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

describe("Inbox: proposed tasks", () => {
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

  it("Approve sends a task to the PMX inbox and takes it off the list", async () => {
    ui = await openBoard({ hash: "inbox", before: seed });
    await ui.click(ui.button("Approve", "main [role=list]"));
    await waitSent(ui, 1);
    expect(ui.posts.find((p) => p[0] === "proposals")![1]).toMatchObject({ action: "approve" });
    await ui.until(() => !row(ui!, "Export approval history to CSV"), "the approved task to leave the list");
    expect((await readProposals()).map((p) => p.title)).toEqual(["Fix the wrong project name in emails"]);
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

  it("Approve all approves every task at once", async () => {
    ui = await openBoard({ hash: "inbox", before: seed });
    await ui.click(ui.button(/^Approve all/));
    await ui.until(() => ui!.posts.some((p) => p[0] === "proposals"), "approve all", 8000);
    for (let i = 0; i < 100 && (await readProposals()).length; i++) await new Promise((r) => setTimeout(r, 30));
    expect(await readProposals()).toEqual([]);
    await ui.until(() => !row(ui!, "Export approval history") && !row(ui!, "Fix the wrong"), "both to leave the list");
  }, T);
});
