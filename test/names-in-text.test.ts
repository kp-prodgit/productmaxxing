// R4, from a real evidence pack: the tracker guard knew every speaker but not a customer's security lead, who was named
// only in running text ("questionnaire in from Dana Ruiz"), so "Ask Dana for the questionnaire." reached Linear.
// `namesIn` now reads the passages' text too, and keeps products, features, companies, dates and places out.
import { describe, expect, it } from "vitest";
import { namesIn, peopleIn, thingsIn, trackerGuard } from "../src/core/tracker-text.js";
import { draftComment, sourceCompanies, sourcePeople } from "../src/run/comment.js";

const names = (text: string, exclude: string[] = []) => peopleIn([{ text }], exclude);

describe("names in the sources' text never reach the tracker (R4, PRIV-6)", () => {
  it("catches a customer's contact the text names, not only the speakers", () => {
    const evidence = {
      sources: [{ passages: [
        "Lee Park: We got the security questionnaire in from Dana Ruiz on Tuesday.\nSam Ortiz: Globex wants it back before the Dec 8 beta.",
      ] }],
      people: ["lee.park@us.example"],
    };
    const people = sourcePeople(evidence, ["us.example"]);
    expect(people).toEqual(expect.arrayContaining(["Lee Park", "Sam Ortiz", "Dana Ruiz", "Dana", "Ruiz"]));
    const guard = trackerGuard({ people });
    expect(guard.problem("Ask Dana for the questionnaire.")).toBe("name");
    expect(guard.problem("Dana Ruiz sent the questionnaire.")).toBe("name");
    // The company, the deal stage and the date still go.
    expect(guard.problem("Globex's security questionnaire is due before its Dec 8 beta.")).toBeNull();
    const md = "# Answer the security questionnaire\n\n## Summary\n\nAsk Dana for the questionnaire. Globex needs the answers before its Dec 8 beta.\n";
    const said = draftComment({ title: "Answer the security questionnaire", markdown: md, prUrl: "branch:x", path: "outputs/spec/PMX-1.md", agent: "ana@m1", people });
    expect(said).toContain("Globex needs the answers before its Dec 8 beta.");
    expect(said).not.toMatch(/Dana|Ruiz/);
  });

  it("says how it found each name, so a later step can swap them for placeholders", () => {
    const found = namesIn([
      { participants: ["Robin Hale <robin.hale@globex.example>"], text: "Sam Ortiz: The questionnaire came from Dana Ruiz.\nSam Ortiz: Robin agreed." },
    ], ["globex"]);
    expect(found).toEqual(expect.arrayContaining([
      { name: "Robin Hale", how: "participant" },
      { name: "Robin", how: "participant", of: "Robin Hale" },
      { name: "Sam Ortiz", how: "speaker" },
      { name: "Sam", how: "speaker", of: "Sam Ortiz" },
      { name: "Dana Ruiz", how: "text" },
      { name: "Dana", how: "text", of: "Dana Ruiz" },
      { name: "Ruiz", how: "text", of: "Dana Ruiz" },
    ]));
    // A name found two ways keeps the first: Robin is a participant, though the text names Robin too.
    expect(found.filter((n) => n.name === "Robin")).toHaveLength(1);
    expect(found.map((n) => n.name)).not.toContain("Globex");
    // peopleIn is the same names, for the callers that only need them.
    expect(peopleIn([{ participants: ["Robin Hale <robin.hale@globex.example>"], text: "Sam Ortiz: The questionnaire came from Dana Ruiz." }], ["globex"]))
      .toEqual(expect.arrayContaining(["Robin Hale", "Sam Ortiz", "Dana Ruiz", "Dana"]));
  });

  it("finds one name after a cue only a person gets", () => {
    expect(names("thanks Avery for the notes.")).toContain("Avery");
    expect(names("I asked Mina about SCIM.")).toContain("Mina");
    expect(names("Told Noor the beta slips.")).toContain("Noor");
    expect(names("Please cc Robin on the reply.")).toContain("Robin");
    expect(names("Per Dana, the questionnaire is due Friday.")).toContain("Dana");
    expect(names("Thanks, Casey! Thank you Jamie.")).toEqual(expect.arrayContaining(["Casey", "Jamie"]));
    expect(names("Okay Mina, can you send it?")).toContain("Mina");
    expect(names("@sam.ortiz can you check the export?")).toEqual(expect.arrayContaining(["Sam Ortiz", "Sam", "Ortiz"]));
    expect(names("Looping in @Avery for the import errors.")).toContain("Avery");
    expect(names("From: Dana Ruiz\nCc: Robin\nSubject: Questionnaire")).toEqual(expect.arrayContaining(["Dana Ruiz", "Robin"]));
  });

  it("finds a full name after any cue, and the other names in a list with one", () => {
    for (const s of ["A note from Dana Ruiz.", "The call with Sam Ortiz ran long.", "Signed by Lee Park on Monday.", "Ask Robin Hale first."]) {
      expect(names(s).filter((n) => n.includes(" ")), s).toHaveLength(1);
    }
    expect(names("Thanks Dana Ruiz, Sam and Avery for joining.")).toEqual(expect.arrayContaining(["Dana Ruiz", "Sam", "Avery"]));
    expect(names("Sam: Hi.\nAvery: Hello.\nDana Ruiz, Sam and Avery joined the call.")).toEqual(expect.arrayContaining(["Dana Ruiz", "Sam", "Avery"]));
    expect(names("Sam Ortiz and Lee are on it.")).toEqual(expect.arrayContaining(["Sam Ortiz", "Lee"]));
    expect(names("Thanks Lee and Noor for the fix.")).toEqual(expect.arrayContaining(["Lee", "Noor"]));
    // "from", "with" and "by" go before a company as often: one word after them needs the sources to show it's a person.
    expect(names("Approved by Casey. The deal with Globex closes in Q1.")).toEqual([]);
    expect(names("Approved by Casey. Casey Lin owns the rollout.")).toEqual(expect.arrayContaining(["Casey Lin", "Casey"]));
  });

  it("never takes a product, a feature, a company, a date, a place or a sentence's first word for a name", () => {
    const text = [
      "Lee Park: The Brand Kit ships with the beta, and Audit Log export is the ask.",
      "Single Sign-On is the blocker for Globex.",
      "Q4 Planning moved to Monday.",
      "Pricing moves to per-seat in Q1. Pricing came up again on Tuesday.",
      "Brand Kit: approvals first",
      "Pricing: $20 a seat",
      "Product Lead: Sam will confirm.",
      "The renewal with Globex is due Jan 15. Thanks Globex team for the patience.",
      "The Customer Advisory Board meets in San Francisco, then the Hong Kong office.",
      "The SSO and SCIM work lands in March.",
    ].join("\n");
    const found = names(text);
    expect(found.sort()).toEqual(["Lee", "Lee Park", "Park"]);
    const guard = trackerGuard({ people: found });
    for (const ok of [
      "The Brand Kit and Audit Log ship before Q4 Planning on Monday.",
      "Pricing moves to per-seat for Globex in Q1.",
      "Single Sign-On blocks Globex's rollout.",
      "The Customer Advisory Board meets in San Francisco in March.",
    ]) expect(guard.problem(ok), ok).toBeNull();
  });

  it("reads a word the sources write in lower case, or as a company, as a word", () => {
    // "Copper Lantern" looks like a name until the sources write "lantern" and "copper" as words.
    expect(names("Copper Lantern ships Friday. The lantern view is slow, and copper is the default theme.")).toEqual([]);
    // "the Initech team" says Initech is a company, so "Initech Fieldbook" is its product, not a person.
    expect(names("The Initech team uses Initech Fieldbook every day.")).toEqual([]);
    // A company the task's Sources line names is never a person, even after a cue.
    const description = "Spec the export.\n\n**Sources:** a customer call with Initech (Nov 20); 2 partner calls with Globex Labs (Nov 19–25). They stay on the PM's Mac.";
    expect(sourceCompanies(description)).toEqual(["Initech", "Globex Labs"]);
    const evidence = { sources: [{ passages: ["Sam Ortiz: Thanks Initech for the patience. Ask Globex Labs for the logs."] }] };
    const people = sourcePeople(evidence, [], sourceCompanies(description));
    expect(people).toEqual(expect.arrayContaining(["Sam Ortiz"]));
    for (const company of ["Initech", "Globex", "Globex Labs"]) expect(people).not.toContain(company);
  });

  it("reads a product's two-word name as a product, before a product word or in a list of products (R4a)", () => {
    const pack = [
      "Lee Park: The questionnaire came in from Dana Ruiz.",
      "• *Globex Slides add-on*: no design partner has asked",
      "Globex Slides keeps coming up, and the Initech Sheets plugin too.",
    ].join("\n");
    const found = names(pack);
    expect(found).toEqual(expect.arrayContaining(["Dana Ruiz", "Dana"]));
    for (const product of ["Globex Slides", "Globex", "Slides", "Initech Sheets", "Initech", "Sheets"]) expect(found, product).not.toContain(product);
    const guard = trackerGuard({ people: found });
    expect(guard.problem("The launch pair is decided Dec 3, from four options (Pagecraft, Globex Slides, Mailbloom), and two slots.")).toBeNull();
    expect(guard.problem("Ask Dana for the questionnaire.")).toBe("name");
    // A list of three or more whose one-word items no source shows as people is a list of products or companies.
    expect(names("The shortlist (Pagecraft, Globex Slides, Mailbloom and Inkwell) is set.")).toEqual([]);
    expect(names("Options (design-tool names: Pagecraft, Initech Docs, Mailbloom).")).toEqual([]);
    // A person's verb isn't a product word: "plans" and "pilots" follow people.
    expect(names("Lee Park plans to send it. Sam Ortiz pilots the beta.")).toEqual(expect.arrayContaining(["Lee Park", "Sam Ortiz"]));
  });

  it("on a teammate's Mac, a company the task's own text names is never a person (R4b)", () => {
    // An evidence pack carries no participants, so nothing says "Globex" is a company but the task itself.
    const evidence = { sources: [{ passages: [
      "• *Globex Beauty* (Lee + Dana, Mon): exact colour match on every asset.",
      "Lee Park: The brand file came in from Dana Ruiz.",
    ] }] };
    const title = "Keep Globex's restricted terms out of generated copy";
    // A task written before R4 may still name someone; a name after a cue only a person gets stays a person.
    const description = "Globex needs restricted terms never generated and disclosures inserted verbatim. Ask Dana for the brand file.\n\n**Sources:** an external call (Nov 24). They stay on the PM's Mac: `pmx explain synthesize-20261126T120000Z` there shows them.\n\npmx:source T1";
    expect(sourcePeople(evidence, ["us.example"])).toContain("Globex");
    const people = sourcePeople(evidence, ["us.example"], sourceCompanies(description, title));
    expect(people).not.toContain("Globex");
    expect(people).toEqual(expect.arrayContaining(["Lee Park", "Dana Ruiz", "Dana"]));
    const guard = trackerGuard({ people });
    expect(guard.problem("Globex needs restricted terms never generated and disclosures inserted verbatim.")).toBeNull();
    expect(guard.problem("Ask Dana for the brand file.")).toBe("name");
    // What the task's text vouches for: single words it uses as things. Never a full name, a cued name, a machine line
    // or the quoted line of a task from before PRIV-6.
    expect(thingsIn("Globex needs it. Acme's Dec 8 beta. Ask Dana first. Reply to Sam. Confirm with Avery Lin.\npmx:source T1\n- [T1] Lee: we need it").sort())
      .toEqual(["Acme", "Globex"]);
  });

  it("never reads an email header or a heading as a speaker", () => {
    const found = names("From: Lee Park\nTo: Sam\nNext steps: send the questionnaire\nBrand Kit: approvals first");
    expect(found).not.toContain("From");
    expect(found).not.toContain("Brand Kit");
    expect(found).not.toContain("Brand");
    expect(found).toEqual(expect.arrayContaining(["Lee Park", "Sam"]));
  });
});
