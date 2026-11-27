import { describe, expect, it } from "vitest";
import { COMMENT_MAX, draftComment, draftCounts, draftSummary } from "../src/run/comment.js";

const BRIEF = `# Light users don't pay for accuracy

## Summary

Light users buy speed, not accuracy [T2, T5]. Brand leads may pay for accuracy, but no source shows it yet [T7]. The switching bar is high for both.

## Comparison

| Capability | Us | Doing nothing |
|---|---|---|
| Speed | unknown | fast [T2] |

## Open questions

1. Do brand leads pay for accuracy? **PM decides** whether to test it.
2. Is a light tier worth it? **PM decides**.
   - A nested note, not a question.
3. Which segment first?

## Blocking questions

- The side-by-side test [T3].
`;

const base = { title: "Competitive analysis for light users", prUrl: "branch:pmx/task/PMX-5-x", path: "outputs/competitive-analysis/PMX-5.md", agent: "ana@m1" };

describe("the comment PMX writes when a draft is ready (TASK-10)", () => {
  it("says what the draft is, what it leaves open and where to read it, without a pull request", () => {
    // The two questions marked PM decides are calls, as accepting reads them (R2e): each becomes the PM's to-do, never a
    // task. The blocking item is a statement, not a question, so it stays in the draft and isn't counted (R2c).
    expect(draftComment({ ...base, markdown: BRIEF })).toBe([
      "Draft ready for review: Light users don't pay for accuracy.",
      "Light users buy speed, not accuracy. Brand leads may pay for accuracy, but no source shows it yet.",
      "It leaves 1 open question and 2 calls marked PM decides.",
      "Read it in the team repo at outputs/competitive-analysis/PMX-5.md, on ana@m1's Mac until it's accepted.",
    ].join("\n"));
  });

  it("points at the pull request when there is one", () => {
    const text = draftComment({ ...base, markdown: BRIEF, prUrl: "https://github.com/acme/pmx/pull/9" });
    expect(text.split("\n").at(-1)).toBe("Read it in the pull request: https://github.com/acme/pmx/pull/9");
  });

  it("reads the first section when there's no Summary, and says nothing about questions it doesn't have", () => {
    const md = "# Fonts drift on export\n\n## Problem\n\nExported files lose the brand's fonts [T1]. Teams fix them by hand.\n\n## Evidence\n\n- Seen twice [T1]\n";
    expect(draftComment({ ...base, markdown: md })).toBe([
      "Draft ready for review: Fonts drift on export.",
      "Exported files lose the brand's fonts. Teams fix them by hand.",
      "Read it in the team repo at outputs/competitive-analysis/PMX-5.md, on ana@m1's Mac until it's accepted.",
    ].join("\n"));
    expect(draftCounts(md)).toEqual({ open: 0, blocking: 0, pmDecides: 0, actions: 0 });
  });

  it("reads a draft with no sections at all, and falls back to the task's title", () => {
    expect(draftComment({ ...base, markdown: "Just one paragraph of findings. And a second sentence here." })).toBe([
      "Draft ready for review: Competitive analysis for light users.",
      "Just one paragraph of findings. And a second sentence here.",
      "Read it in the team repo at outputs/competitive-analysis/PMX-5.md, on ana@m1's Mac until it's accepted.",
    ].join("\n"));
  });

  it("cuts a long first paragraph only between sentences, and stays short", () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} explains one more part of what the evidence shows about the segment.`).join(" ");
    const text = draftComment({ ...base, markdown: `# Title\n\n## Summary\n\n${long}\n` });
    expect(text.length).toBeLessThanOrEqual(COMMENT_MAX);
    const summary = text.split("\n")[1]!;
    expect(summary).toMatch(/^Sentence number 1 .*\.$/);
    expect(long).toContain(summary);
    expect(summary.split(/(?<=\.) /).every((s) => /^Sentence number \d+ .*segment\.$/.test(s))).toBe(true);
    // A single sentence too long to fit is left out rather than cut.
    const one = `${"word ".repeat(120).trim()}.`;
    expect(draftSummary(`## Summary\n\n${one}\n`)).toBe("");
  });

  it("never repeats a quote, a name, a placeholder or contact details", () => {
    const md = `# Title\n\n## Summary\n\nThe buyer said "we'd pay double" on the call [T1]. Jordan Lee wants it soon. [PERSON-2] asked twice. Write to sam@buyer.example for more. Speed matters more than accuracy.\n`;
    expect(draftSummary(md, ["Jordan Lee"])).toBe("Speed matters more than accuracy.");
    expect(draftComment({ ...base, markdown: md, names: ["Jordan Lee"] })).not.toMatch(/pay double|Jordan|PERSON|sam@/);
  });

  it("for a prototype, says where it is without a summary", () => {
    expect(draftComment({ ...base, noun: "Prototype", markdown: null, path: "https://preview.example/p/5" })).toBe([
      "Prototype ready for review: Competitive analysis for light users.",
      "Open it at https://preview.example/p/5; it's on ana@m1's Mac until it's accepted.",
    ].join("\n"));
  });
});
