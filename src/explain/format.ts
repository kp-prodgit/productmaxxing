import { homedir } from "node:os";
import { HOLD_LABELS } from "../core/filter.js";
import type { OpenUpdated, RunReceipt, SourceReceipt } from "../core/receipt.js";
import type { RedactionKind } from "../core/redact.js";
import type { SkillInfo } from "../core/skills.js";
import { FLAG_TEXT } from "../synth/synthesize.js";
import { unlocated, type LiveCut, type LiveSource } from "./resolve.js";

const MASK_NAMES: Record<RedactionKind, [string, string]> = {
  email: ["email address", "email addresses"],
  phone: ["phone number", "phone numbers"],
  card: ["card number", "card numbers"],
  id: ["ID number", "ID numbers"],
  person: ["customer name", "customer names"],
};

/** Where a meeting stood in the meeting ledger (MEET-2) or the PM's to-do record (TODO-3). */
export const LEDGER: Record<NonNullable<RunReceipt["sources"][number]["ledger"]>["state"], string> = {
  "processed-now": "Processed in this run",
  "would-process": "Would be processed (dry run)",
  "already-processed": "Skipped: already processed",
  "in-progress-elsewhere": "Skipped: another machine is processing it",
  "before-window": "Skipped: before this run's start date",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tilde = (p: string) => p.replace(homedir(), "~");
const money = (n: number | null) => (n === null ? "cost unknown" : `$${n.toFixed(2)}`);

/** Which source a quote came from (N4): a used source by its ID, title and date, or the released strategy's file. */
export function quoteSource(id: string, sources: SourceReceipt[]): string {
  const s = sources.find((x) => x.decision === "used" && x.id === id);
  return s ? `${id} (${s.title ?? s.file ?? "a source"}${s.at ? `, ${s.at.slice(0, 10)}` : ""})` : id;
}

export function maskedText(m: RunReceipt["masked"]): string {
  const parts = (Object.entries(m) as [RedactionKind, number][]).filter(([, n]) => n).map(([k, n]) => plural(n, ...MASK_NAMES[k]));
  return parts.length ? parts.join(", ") : "nothing";
}

/**
 * One cut in plain words: a whole turn ("cut line 7"), some sentences of a turn whose rest was used, or a reply
 * cut with the passage before it. Never the text itself.
 */
export function cutText(c: LiveCut): string {
  const why = `${HOLD_LABELS[c.rule]}${c.matched ? ` (matched "${c.matched}")` : ""}`;
  if (c.followUp) return `cut ${c.line ? `line ${c.line}` : "a passage"}: ${why}, as a direct reply to the passage cut before it`;
  if (c.part) return `cut ${c.part.cut} of ${c.part.of} sentences ${c.line ? `at line ${c.line}` : "in a passage"} and used the rest of that turn: ${why}`;
  return `cut ${c.line ? `line ${c.line}` : "a passage"}: ${why}`;
}

/** The two lines `pmx digest` prints, so the PM sees counts in plain words and where to look. */
export function receiptSummary(r: RunReceipt): string {
  const used = r.sources.filter((s) => s.decision === "used").length;
  const cut = r.sources.reduce((n, s) => n + s.passagesCut.length, 0);
  const parts = [
    `Found ${plural(r.sources.length, "conversation")}`,
    `used ${used}`,
    `left out ${r.sources.length - used}`,
    `cut ${plural(cut, "passage")}`,
    `masked ${maskedText(r.masked)}`,
  ];
  if (r.model) parts.push(money(r.model.costUsd));
  return `${parts.join(" · ")}\nSee how each one was decided: pmx explain (or pmx explain --web)`;
}

/**
 * What a later meeting did to a to-do an earlier batch found (TODO-6). Only "done" and "overtaken" drop one, naming
 * the meeting that shows it (its title and date, from the run's sources) and why; a to-do said again, changed or the
 * same ask as another is kept once, citing both meetings. The explain page (page.ts) says the same.
 */
export function reconciledText(x: NonNullable<NonNullable<RunReceipt["todo"]>["reconciled"]>[number], sources: SourceReceipt[] = []): string {
  const by = x.by ? ` [${x.by}]` : "";
  const m = x.by ? sources.find((s) => s.id === x.by) : undefined;
  // TODO-8: an email thread is named as one; a to-do already on the list that a later message settled is ticked.
  const email = m?.kind === "thread";
  const later = email ? "a later email" : "a later meeting";
  const where = m?.title ? `in ${email ? "the email " : ""}"${m.title}"${m.at ? ` on ${m.at.slice(0, 10)}` : ""}` : `in ${later}`;
  const why = x.why ? `. ${x.why}` : "";
  const gone = x.stored ? `so PMX ticked your to-do ${x.stored}` : "so dropped";
  if (x.how === "done") return `done ${where}${by}, ${gone}: ${x.text}${why}`;
  if (x.how === "overtaken") return `overtaken ${where}${by}, ${gone}: ${x.text}${why}`;
  if (x.how === "same-ask") return `the same ask as "${x.into}"${by}, kept once citing both: ${x.text}`;
  if (x.how === "merged") return `said again in ${later}${by}, kept once citing both: ${x.text}`;
  return `changed in ${later}${by}, kept once citing both: ${x.text}`;
}

/** The full receipt for the terminal: every source, the rule that decided it, what Claude got. */
export function formatReceipt(r: RunReceipt, live: LiveSource[]): string {
  const when = new Date(r.at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  const title = r.type === "digest" ? "Digest" : r.type === "todo" ? `Your to-dos${r.dryRun ? " (dry run)" : ""}` : r.dryRun ? "Suggested tasks (dry run)" : "Suggested tasks";
  const out = [`${title} · ${when} · ${r.outcome}`, ""];
  const where = r.rules.folders.length ? r.rules.folders.map(tilde).join(", ") : "your sources";
  out.push(`1. Found ${plural(r.sources.length, "conversation")} in ${where} from the last ${r.window.days} days`);
  for (const s of r.skippedSources) out.push(`   - skipped: ${s}`);
  out.push("", "2. Privacy rules decided what Claude may read");
  if (r.rules.allowOneOnOne) out.push("   Your own to-dos: internal meetings, 1:1s, fundraising and your team's confidential contacts are allowed, because the result stays on this Mac. Health, pay and performance passages are still cut.");
  if (r.rules.confidentialDomains?.length) out.push(`   Held from team work: meetings with someone from your team's confidential domains (${r.rules.confidentialDomains.join(", ")}), and their names.`);
  if (r.rules.meetingSeries?.length) out.push(`   Internal meetings in your team's approved series are used for team work, with every other rule: ${r.rules.meetingSeries.join(", ")}.`);
  r.sources.forEach((s, i) => {
    const l = live[i];
    const name = s.file ?? l?.file ?? (s.kind !== "transcript" ? `a thread${s.place ? ` in ${s.place}` : ""}` : "a file that's no longer in your folder");
    if (s.decision === "used") out.push(`   ✔ used      [${s.id}] ${name}: ${s.detail}${s.ledger ? `. ${LEDGER[s.ledger.state]}${s.ledger.entry ? ` (${s.ledger.entry})` : ""}` : ""}`);
    else out.push(`   ✘ left out  ${name}: ${HOLD_LABELS[s.rule!]}, because ${s.detail}`);
    (l?.cuts ?? s.passagesCut.map(unlocated)).forEach((c) => out.push(`               ${cutText(c)}`));
  });
  out.push("", `3. Masked before Claude saw it: ${maskedText(r.masked)}`);
  if (r.model) {
    const skills = r.skills.map((k) => `${k.name} (${k.source === "team" ? "team copy" : k.source === "org" ? "org copy (synced)" : "built-in copy"}, version ${k.version})`).join(" + ");
    out.push("", `4. Claude wrote the draft: ${r.model.name} using ${skills}`, `   Tools: ${r.model.tools}`, `   ${money(r.model.costUsd)} · ${(r.model.durationMs / 1000).toFixed(1)}s`);
  }
  if (r.digest) {
    out.push("", `5. Citation check: ${plural(r.digest.cited.length, "source")} cited, ${plural(r.digest.removedClaims, "claim")} removed for missing a citation`);
    out.push("", `6. Draft: ${tilde(r.digest.staged)}. Only on your Mac until you approve it with \`pmx digest --review\`.`);
  }
  if (r.synth) {
    out.push("", `5. ${plural(r.synth.tasks.length, "suggested task")}, each sized with the pmx-size rubric:`);
    for (const t of r.synth.tasks) {
      out.push(`   ${t.size.padEnd(2)} ${t.title} (${t.category}, ${plural(t.sources.length, "source")})`);
      if (t.sizing) {
        out.push(`      why: ${t.sizing.cell ?? "no rubric cell given"}${t.sizing.why ? `. ${t.sizing.why}` : ""}`);
        for (const f of t.sizing.flags) out.push(`      check: ${FLAG_TEXT[f]}`);
      }
      // N4: what Linear doesn't get, with the words that matched, as the page shows them. Your own sources' words, on this Mac.
      if (t.leftOut) {
        out.push(`      left out of what Linear gets: ${t.leftOut}`);
        for (const q of (r.synth.quoted ?? []).filter((x) => x.task === t.title && x.part === "description" && !x.skipped)) out.push(`         "${q.words}", from ${quoteSource(q.source, r.sources)}`);
      }
      // R6: a task the PM dropped, with the reason they gave (`pmx proposals drop … --reason`).
      if (t.posted && "dropped" in t.posted) out.push(`      you dropped it${t.posted.reason ? `: ${t.posted.reason}` : ""}`);
      // INPUT-2: an open task it was heard again for, which took this run's newer facts.
      if (t.posted && "duplicateOf" in t.posted && t.posted.updated) out.push(`      ${updatedText(t.posted.duplicateOf, t.posted.updated)}`);
    }
    // INPUT-2: open tasks a newer figure from this run's other work went to, matched to no task of it.
    for (const u of r.synth.updated ?? []) out.push(`   ${updatedText(u.identifier, u)}`);
    for (const s of r.synth.skipped) out.push(`   skipped: ${s}`);
    // N4: what repeated a source word for word, with the words and which source. Your own sources' words, on this Mac.
    if (r.synth.quoted?.length) {
      out.push("", "   Left out for repeating a source word for word (Linear gets summaries only). The words are from your own sources and stay on this Mac:");
      for (const q of r.synth.quoted) out.push(`   · ${q.task}, ${q.part === "title" ? "its title" : "a sentence of its description"}${q.skipped ? " (so the task was skipped)" : ""}: "${q.words}", from ${quoteSource(q.source, r.sources)}`);
    }
    // N1: suggestions of a kind of work your team hasn't turned on, waiting on this Mac until it does.
    if (r.synth.waiting?.length) {
      out.push("", "   Waiting for a kind of work your team hasn't turned on (they come back in the next run once it's on):");
      for (const w of r.synth.waiting) out.push(`   · ${w.title} (${w.category}, ${plural(w.sources.length, "source")}): pmx jobs add ${w.category}`);
    }
    // SIG-9: needs past the team's task limit, kept on this Mac for the next run.
    if (r.synth.heldOver?.length) {
      out.push("", `   Held over for the next run (past your team's task limit, synthesis.maxTasks):`);
      for (const h of r.synth.heldOver) out.push(`   · ${h.title} (${h.category}, ${plural(h.sources.length, "source")}${h.rounds > 1 ? `, held ${h.rounds} runs in a row` : ""})`);
    }
  }
  if (r.todo) {
    out.push("", `5. ${plural(r.todo.added.length, "new to-do")}${r.todo.duplicates ? `, ${r.todo.duplicates} already on your list` : ""}. They stay on this Mac (\`pmx todo\`):`);
    for (const t of r.todo.added) out.push(`   ☐ ${t.text}${t.due ? ` (due ${t.due})` : ""}  [${[t.source, ...(t.also ?? [])].join(", ")}]`);
    if ((r.todo.batches ?? 1) > 1) out.push(`   read oldest first, a few meetings per call: ${plural(r.todo.batches!, "call")}`);
    for (const x of r.todo.reconciled ?? []) out.push(`   ${reconciledText(x, r.sources)}`);
    for (const d of r.todo.dropped) out.push(`   dropped: ${d}`);
  }
  if (r.error) out.push("", `The run failed: ${r.error}`);
  out.push("", "Left-out text is never stored. File names and lines above were found just now in your own folders.");
  return out.join("\n");
}

/**
 * INPUT-2: "updated PMX-46: GPU cost is now 22% over budget (was 18%). (1 new source)", or "commented on PMX-46: …
 * (its draft is in review, so its description stays; 1 new source)".
 */
export function updatedText(identifier: string, u: OpenUpdated): string {
  const n = `${u.figure ? "a newer figure from " : ""}${u.sources} new ${u.sources === 1 ? "source" : "sources"}`;
  const why = u.how === "description" ? `${n}${u.queued ? "; in Linear at the next Claude sync" : ""}${u.noComment ? "; no comment, since one couldn't be said within the tracker rules" : ""}` : `${u.why ?? "it was being drafted"}, so its description stays; ${n}`;
  return `${u.how === "description" ? "updated" : "commented on"} ${identifier}: ${u.changes.join(" ")} (${why})`;
}

export function formatSkills(skills: SkillInfo[]): string {
  const out = [
    "Claude skills PMX can use. Runs load them from your team folder first, then from the copy built into pmx.",
    "They run in ProductMaxxing's own Claude profile (~/.pmx/claude), never in your personal Claude Code.",
    '"differs from built-in" means your team edited its copy, or this pmx ships a newer one.',
    "",
  ];
  for (const s of skills) {
    out.push(`${s.name}  ·  ${s.status}  ·  version ${s.version}`);
    out.push(`   ${s.description}`);
    out.push(`   When: ${s.usedBy}`);
    out.push(`   Env: ${s.env.kind} · tools ${s.env.tools.join(", ")} · output ${s.env.output.kind}${s.envProblems.length ? `  ⚠️ ${s.envProblems.join("; ")}` : ""}`);
    out.push(`   File: ${tilde(s.path)}`, "");
  }
  return out.join("\n").trimEnd();
}
