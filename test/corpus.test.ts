// The golden corpus: a fixed set of real-shaped lines that runs on every pull request (founder decision, 2026-11-27).
// Each fix to the privacy filter's wording rules used to open another edge case; now every line anyone has cared
// about is written down once, with what must happen to it, and a rule change that flips one fails here by name.
//
// test/corpus/filter/*.jsonl: one line of JSON per entry (see `CorpusEntry` in corpus-run.ts, and README.md,
// "Adding a line to the corpus"). Adding a line needs no code.
// test/corpus/follow-ups/*.md with expected.json: draft fixtures and the follow-ups they must give (kind, wording,
// fixed ID), so a wording change shows as a diff of that one file. Rewrite it with `CORPUS_UPDATE=1 npx vitest run
// test/corpus.test.ts` and review the diff.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { draftItems, readFollowUps } from "../src/review/draft-reader.js";
import { askTodo } from "../src/review/followups.js";
import { runFilterEntry, type CorpusEntry } from "./corpus-run.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "corpus");
const FILTER = join(ROOT, "filter");
const FOLLOW = join(ROOT, "follow-ups");

interface Loaded extends CorpusEntry { at: string }

/** Every entry of every file, with where it is ("bonus.jsonl:12"). A line that starts with // or # is a note. */
function load(): Loaded[] {
  const out: Loaded[] = [];
  for (const f of readdirSync(FILTER).filter((x) => x.endsWith(".jsonl")).sort()) {
    readFileSync(join(FILTER, f), "utf8").split("\n").forEach((line, i) => {
      if (!line.trim() || /^\s*(\/\/|#)/.test(line)) return;
      let e: CorpusEntry;
      try { e = JSON.parse(line); } catch (err: any) { throw new Error(`test/corpus/filter/${f}:${i + 1} isn't one line of JSON: ${err.message}`); }
      out.push({ ...e, at: `test/corpus/filter/${f}:${i + 1}` });
    });
  }
  return out;
}

const show = (result: string, topic: string | null) => (result === "kept" || result === "cut" ? `${result}${topic ? ` (${topic})` : ""}` : `${JSON.stringify(result)}${topic ? ` (${topic})` : ""}`);
/** One entry, as a failure shows it: readable without opening the code. */
const about = (e: Loaded, lines: string[]) => [
  `${e.at}  [${e.family}]`,
  `  text:     ${JSON.stringify(e.text)}`,
  ...(e.context ? [`  context:  ${JSON.stringify(e.context)}`] : []),
  ...lines,
  `  why:      ${e.why}`,
].join("\n");

const entries = load();

/** One entry through the filter: null when it does what the corpus says, else the failure, readable by itself. */
function judge(e: Loaded): string | null {
  const a = runFilterEntry(e);
  // A known gap that now does what's wanted: the fix must flip the entry on purpose.
  if (e.known_gap && a.result === e.known_gap.want)
    return about(e, [
      `  today:    ${show(a.result, a.topic)}, which is what this known gap wants`,
      `  fix:      PMX no longer has this gap. Set "expect" to ${JSON.stringify(e.known_gap.want)}, "topic" to ${JSON.stringify(a.topic)}, and remove "known_gap".`,
    ]);
  return a.result !== e.expect || a.topic !== e.topic ? about(e, [`  expected: ${show(e.expect, e.topic)}`, `  actual:   ${show(a.result, a.topic)}`]) : null;
}

describe("the golden corpus: real-shaped lines through the privacy filter", () => {
  it("every entry says what it is", () => {
    const bad: string[] = [];
    const seen = new Map<string, string>();
    for (const e of entries) {
      const problems = [
        typeof e.family === "string" && /^[a-z][a-z0-9-]*$/.test(e.family) ? null : "family must be a lower-case word like \"bonus\"",
        typeof e.text === "string" && e.text.trim() ? null : "text is missing",
        typeof e.expect === "string" && e.expect ? null : "expect must be \"kept\", \"cut\" or the exact text left",
        e.topic === null || typeof e.topic === "string" ? null : "topic must be the rule that cuts it, or null",
        e.expect === "kept" && e.topic !== null ? "a line kept whole has topic null" : null,
        e.expect !== "kept" && e.topic === null ? "a line that is cut names the rule in topic" : null,
        typeof e.why === "string" && e.why.trim().length >= 8 ? null : "why must say why this is right",
        e.known_gap && !(typeof e.known_gap.want === "string" && e.known_gap.want && typeof e.known_gap.why === "string" && e.known_gap.why.trim()) ? "known_gap needs want and why" : null,
        e.known_gap && e.known_gap.want === e.expect ? "known_gap.want is what expect already says" : null,
      ].filter(Boolean);
      const key = JSON.stringify([e.text, e.context ?? null]);
      if (seen.has(key)) problems.push(`the same text and context as ${seen.get(key)}`);
      seen.set(key, e.at);
      if (problems.length) bad.push(about(e, problems.map((p) => `  problem:  ${p}`)));
    }
    expect(bad, `\n${bad.join("\n\n")}\n`).toEqual([]);
  });

  it("covers every family, with at least 250 entries", () => {
    const families = new Map<string, number>();
    for (const e of entries) families.set(e.family, (families.get(e.family) ?? 0) + 1);
    expect(entries.length).toBeGreaterThanOrEqual(250);
    for (const f of ["bonus", "commission", "salary-equity", "health", "hiring", "performance", "one-on-one", "fundraising", "confidential", "product"])
      expect(families.get(f) ?? 0, `family ${f}`).toBeGreaterThanOrEqual(5);
  });

  it("the filter does to every entry what the corpus says", () => {
    const failures = entries.map(judge).filter((x): x is string => x !== null);
    // The gaps PMX has today, said on every run so they stay in view.
    const gaps = entries.filter((e) => e.known_gap);
    if (gaps.length) process.stdout.write(`${[`Known gaps in the privacy filter (${gaps.length}), from test/corpus/filter:`, ...gaps.map((e) => `- ${JSON.stringify(e.text)} is ${show(e.expect, e.topic)} today; wanted: ${show(e.known_gap!.want, null)}. ${e.known_gap!.why}  (${e.at})`)].join("\n")}\n`);
    expect(failures.length, `\n${failures.length} of ${entries.length} corpus entries came out differently:\n\n${failures.join("\n\n")}\n`).toBe(0);
  });

  it("a failure shows the entry, what was expected and what happened", () => {
    const wrong: Loaded = { family: "bonus", text: "My bonus is late.", expect: "kept", topic: null, why: "Deliberately wrong.", at: "test/corpus/filter/example.jsonl:1" };
    expect(judge(wrong)).toBe('test/corpus/filter/example.jsonl:1  [bonus]\n  text:     "My bonus is late."\n  expected: kept\n  actual:   cut (compensation)\n  why:      Deliberately wrong.');
    expect(judge({ ...wrong, expect: "cut", topic: "compensation" })).toBeNull();
    // Context is shown too, and a part cut as the exact text left.
    expect(judge({ ...wrong, text: "I'm out Thursday (doctor). The pricing section is my component.", expect: "cut", topic: "health", context: { speaker: "inside" } })).toBe(
      'test/corpus/filter/example.jsonl:1  [bonus]\n  text:     "I\'m out Thursday (doctor). The pricing section is my component."\n  context:  {"speaker":"inside"}\n  expected: cut (health)\n  actual:   "[HELD] The pricing section is my component." (health)\n  why:      Deliberately wrong.',
    );
  });

  it("a known gap holds today's result, and fails once PMX does what's wanted until the flag is removed", () => {
    const gap: Loaded = { family: "bonus", text: "Resellers get a 5% bonus on every renewal.", expect: "cut", topic: "compensation", why: "Today.", known_gap: { want: "kept", why: "A partner term." }, at: "test/corpus/filter/example.jsonl:2" };
    expect(judge(gap)).toBeNull();
    // A line PMX already gets right, still flagged as a gap that wants exactly that: the corpus must be updated on purpose.
    const fixed = judge({ ...gap, text: "Resellers get a partner bonus of 10% of first-year revenue." });
    expect(fixed).toContain("today:    kept, which is what this known gap wants");
    expect(fixed).toContain('fix:      PMX no longer has this gap. Set "expect" to "kept", "topic" to null, and remove "known_gap".');
    // A known gap whose result today changed to something else is an ordinary failure.
    expect(judge({ ...gap, expect: "kept", topic: null, known_gap: { want: "[HELD]", why: "x" } })).toContain("expected: kept\n  actual:   cut (compensation)");
  });
});

interface FollowUp { id: string; kind: "decision" | "action" | "ask" | "work"; wording: string; due?: string }
interface Fixture { identifier: string; title: string; now: string; follow_ups: FollowUp[] }

/** The follow-ups PMX reads from a draft, as an accept would word them: calls, things to do, questions to ask, work. */
function followUps(markdown: string, f: Pick<Fixture, "identifier" | "title" | "now">): FollowUp[] {
  const { decisions, questions } = readFollowUps(markdown, f.identifier, new Date(`${f.now}T10:00:00`), { title: f.title });
  return [
    ...decisions.map((d): FollowUp => ({ id: d.id, kind: d.action ? "action" : "decision", wording: d.text, ...(d.due ? { due: d.due } : {}) })),
    ...questions.map((q): FollowUp => (q.ask ? { id: q.id, kind: "ask", wording: askTodo(q, f.identifier, () => true).text } : { id: q.id, kind: "work", wording: q.title })),
  ];
}

describe("the golden corpus: drafts and the follow-ups they give", () => {
  const file = join(FOLLOW, "expected.json");
  const expected = JSON.parse(readFileSync(file, "utf8")) as Record<string, Fixture>;
  const drafts = readdirSync(FOLLOW).filter((x) => x.endsWith(".md")).sort();

  it("every draft fixture has its expected follow-ups, and nothing else is listed", () => {
    expect(Object.keys(expected).sort()).toEqual(drafts);
  });

  it("each draft gives exactly the follow-ups written down: kind, wording and fixed ID", () => {
    const now: Record<string, Fixture> = {};
    const failures: string[] = [];
    for (const name of drafts) {
      const f = expected[name]!;
      const md = readFileSync(join(FOLLOW, name), "utf8");
      const got = followUps(md, f);
      now[name] = { identifier: f.identifier, title: f.title, now: f.now, follow_ups: got };
      // Every ID is an item of the draft, whatever the wording rules made of it.
      const ids = new Set(draftItems(md).map((i) => i.id));
      for (const g of got) if (!ids.has(g.id)) failures.push(`test/corpus/follow-ups/${name}\n  problem:  ${JSON.stringify(g.wording)} has the ID ${g.id}, which is no item of the draft`);
      const line = (x: FollowUp) => `${x.id}  ${x.kind.padEnd(8)}  ${x.wording}${x.due ? `  (due ${x.due})` : ""}`;
      const want = f.follow_ups.map(line);
      const have = got.map(line);
      if (JSON.stringify(want) !== JSON.stringify(have))
        failures.push([`test/corpus/follow-ups/${name}  (${f.identifier}: ${f.title})`, "  expected:", ...want.map((l) => `    ${l}`), "  actual:", ...have.map((l) => `    ${l}`),
          "  If the new wording is right, run `CORPUS_UPDATE=1 npx vitest run test/corpus.test.ts` and review the diff of test/corpus/follow-ups/expected.json."].join("\n"));
    }
    if (process.env.CORPUS_UPDATE) {
      writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
      return;
    }
    expect(failures.length, `\n${failures.join("\n\n")}\n`).toBe(0);
  });
});
