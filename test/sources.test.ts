import { utimes } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseTranscript, readTranscripts } from "../src/sources/transcripts.js";
import { tmp, writeTranscript } from "./helpers.js";

describe("transcripts (SIG-1)", () => {
  it("parses frontmatter and header styles and strips VTT cues", () => {
    const a = parseTranscript("---\ntitle: Acme call\ndate: 2026-11-02\nparticipants: [jane@acme.com, kp@us.com]\n---\nJane: hi", "f");
    expect(a).toMatchObject({ title: "Acme call", date: "2026-11-02", participants: ["jane@acme.com", "kp@us.com"], body: "Jane: hi" });
    const b = parseTranscript("Title: Globex\nAttendees: a@g.com; b@us.com\n\nWEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nA: hello", "f");
    expect(b).toMatchObject({ title: "Globex", participants: ["a@g.com", "b@us.com"], body: "A: hello" });
    expect(parseTranscript("just text", "fallback").title).toBe("fallback");
  });

  it("reads only text files in allowlisted folders, newer than the window, never audio", async () => {
    const d = await tmp();
    await writeTranscript(d, "a.md", "Title: A\n\nx");
    await writeTranscript(d, "b.m4a", "audio");
    const old = await writeTranscript(d, "old.txt", "Title: Old\n\ny");
    await utimes(old, new Date("2020-01-01"), new Date("2020-01-01"));
    await writeTranscript(join(d, "sub"), "nested.md", "Title: N\n\nz");
    const items = await readTranscripts({ dirs: [d], sinceMs: Date.now() - 86400000 });
    expect(items.map((i) => i.title)).toEqual(["A"]);
    expect(items[0]!.id).toBe("T1");
  });
});

