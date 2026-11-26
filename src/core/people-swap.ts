import { domainLabel, domainOf as domainIn } from "./filter.js";
import { nameKey, namesIn, PERSON_CUES, personForm, personKey, speakerLabel } from "./tracker-text.js";

/**
 * R5 (founder decision 2026-11-26): no people's names in the team repo. Before, PMX swapped a name for `[PERSON-n]`
 * only when it was on the CRM list, so a task's evidence pack named a customer's VP 16 times. Now every name PMX finds
 * in a task's sources (`namesIn`: participants, speakers and names in the text), the CRM list's, and the people's
 * email addresses and @handles become one placeholder per person, numbered as they first appear in the task's sources.
 * R5a: and everyone else this Mac knows by name (`known`, from `buildKnown`: every meeting and thread it has, the CRM
 * list, the team's own people), wherever their name is in the task's sources, so "Lee at Globex said…" or "Avery's
 * legal question" is swapped though the task's own sources never introduce them.
 *
 * - **One person, one number.** A full name and its words ("Dana Ruiz", "Dana", "Ruiz"), a participant's display name,
 *   address and its local part ("Dana Ruiz <dana.ruiz@globex.example>"), a speaker label ("Dana:"), a handle
 *   ("@dana.ruiz") are the same person. A word is first someone's in the task's own sources, then someone's this Mac
 *   knows from elsewhere. A word two people share there ("Dana" with Dana Ruiz and Dana Cole) can't say which, so it
 *   becomes `[PERSON]`, never the wrong number.
 * - **What's kept:** the person's company, from their email's domain, so the agent can write roles ("Globex's brand
 *   lead"): `[PERSON-2, Globex]`, or `[PERSON-3, our company]` for the company's own domains and the team's own people.
 *   Never anything else about them: no initials, no part of the address, no guess from the name. A free or personal
 *   mail domain says no company (R5d), and nor does a domain made of the person's own name ("danaruiz.example").
 * - **When a word is swapped:** a full name written as a name (capitalized), or in any case when it's on the CRM list
 *   or every word of it is a name on its own; one word of a name when it's capitalized ("Dana", "Avery's"), or after a
 *   word only a person gets ("thanks dana", "w/ sean"); a name or surname that is also an ordinary word ("Mark",
 *   "Max", "Grant", which `namesIn` never takes alone) only as a speaker label, in a full name, after such a word, with
 *   a possessive ("Grant's") or doing what a person does mid-sentence ("as Grant said"), so "the Max plan" stays.
 * - **Companies stay** (the tracker rules allow them): an email domain's name, and the companies the caller knows (the
 *   task's own text, a pack's list), though never over a participant's name: an attendee is a person by the meeting's
 *   own record. A label that starts with a company ("Globex Hotels:") is the company's (R5c).
 *
 * Same input, same output (NEUT-1). The names stay in memory for the run's guards; nothing here is written.
 */
export interface PeopleSwapInput {
  /** The task's sources, in order: who took part (as their files list them) and their text. */
  items: { participants?: string[]; text: string }[];
  /** The team's CRM list: full names, swapped wherever they are, in any case. */
  listed?: string[];
  /** The company's own email domains: their people are "our company". */
  internalDomains?: string[];
  /** Companies the text never names a person by (the task's own text, a pack's companies), and how they're spelled. */
  companies?: string[];
  /** R5a: everyone this Mac knows by name, from all its meetings, threads, lists and team (`buildKnown`). */
  known?: KnownPeople;
  /** The last `[PERSON-n]` number already in the text: numbers go on from it. */
  from?: number;
}

export interface PeopleSwap {
  /** Text with every person swapped for their placeholder. Call it on the sources in order: numbers follow it. */
  swap(text: string): string;
  /** The names and addresses it swaps, for the tracker and web guards only: never shown to an agent or written. */
  names: string[];
  /** The outside companies the participants' email domains give ("globex"): never an address or a name. */
  companies: string[];
}

/**
 * R5a: the people a Mac knows by name, in memory only: each as `nameKey` writes their name ("lee park", "theo"), with
 * the addresses known for them and whether they're the team's own; and the one-word names `namesIn` takes on their own
 * ("lee", "theo", not "mark"), which are swapped wherever they're capitalized.
 */
export interface KnownPeople {
  people: { key: string; emails: string[]; ours?: boolean }[];
  strong: string[];
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** R5d: mail domains anyone can sign up with, and personal mailboxes: they say nothing about a person's company. */
const PUBLIC_MAIL = new Set(("gmail googlemail outlook hotmail live msn yahoo ymail icloud me mac aol proton protonmail pm gmx fastmail hey " +
  "zoho yandex mail email inbox mailbox webmail posteo tutanota tuta").split(" "));
const CUE = new RegExp(`(?:^|[^\\p{L}\\p{N}])(?:thank you|w/|${[...PERSON_CUES].join("|")})[ \\t]*,?[ \\t]*$`, "iu");
/** R5a: what a person does after their name: "as Grant said", "Mark thinks". */
const SAYS = /^[ \t]+(?:said|says|asked|asks|thinks|thought|wants|wanted|wrote|writes|mentioned|suggested|agreed|noted|told|replied|confirmed|owns|signs|signed|approved|prefers|needs|flagged|raised)\b/i;
/** Before a word that starts a sentence, a line or a list item. */
const STARTS = /(?:^|[.!?:;>•*\-–—(\[]|\n)[ \t"“'‘]*$/;
/** A name's words as a pattern over decomposed text: any case and any accent ("José Núñez" for "jose nunez"). */
const pattern = (key: string) => key.split(" ").map((w) => [...w].map((c) => `${c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\p{M}*`).join("")).join("[ \\t\\u00a0'’.-]+");
const title = (key: string) => key.split(" ").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
const handleKey = (h: string) => h.normalize("NFC").toLowerCase();
const localOf = (e: string) => e.split("@")[0]!.replace(/[._+-]+/g, " ");
/** An address's domain, as the privacy filter reads it ("Name <addr>" too). */
const domainOf = (e: string) => domainIn(e) ?? "";
const displayOf = (p: string) => p.replace(/<?[\w.+-]+@[\w-]+(\.[\w-]+)+>?/g, " ").replace(/["'()]/g, " ").trim();
/** What a placeholder says about someone on the company's own domains, or one of the team's own people. */
const OURS = "our company";
/** The highest `[PERSON-n]` number a text already has. */
export const lastPerson = (text: string): number => Math.max(0, ...[...text.matchAll(/\[PERSON-(\d+)\b/g)].map((m) => Number(m[1])));
/** Whether a mail domain names no company: one anyone can sign up with, or a personal mailbox's (R5d). */
export const freeMail = (domain: string): boolean => PUBLIC_MAIL.has(domainLabel(domain));

/**
 * R5a: everyone a Mac knows by name, for `peopleSwap`'s `known`: every participant and speaker of `items` (all its
 * meetings and threads) and every name `namesIn` finds in them, the CRM list (`listed`), and the team's own people
 * (`team`: handles, names or addresses, from the team's settings, its code owners, its run log and this PM's own).
 */
export function buildKnown(o: { items: { participants?: string[]; text: string }[]; listed?: string[]; team?: string[]; internalDomains?: string[] }): KnownPeople {
  const internal = (o.internalDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ""));
  const team = (o.team ?? []).map((t) => t.trim()).filter(Boolean);
  const emails = [...o.items.flatMap((i) => [...(i.participants ?? []), i.text].flatMap((x) => x.match(EMAIL) ?? [])), ...team.flatMap((t) => t.match(EMAIL) ?? [])].map((e) => e.toLowerCase());
  const domains = [...new Set([...emails.map(domainOf), ...internal].map(domainLabel).filter(Boolean))];
  const people = new Map<string, { key: string; emails: string[]; ours?: boolean }>();
  const add = (key: string | null, email?: string, ours = false) => {
    if (!key) return;
    const id = `${key}|${email ?? ""}|${ours}`;
    if (!people.has(id)) people.set(id, { key, emails: email ? [email] : [], ...(ours ? { ours: true } : {}) });
  };
  // A handle's separators are spaces ("mei-lin" is Mei Lin); an address stays whole.
  const handles = team.map((t) => (t.match(EMAIL) ? t : t.replace(/[._-]+/g, " ")));
  const things = new Set<string>();
  const found = namesIn([...o.items, { participants: [...handles, ...(o.listed ?? [])] }], domains, { things });
  const person = (p: string, ours = false) => {
    const email = p.match(EMAIL)?.[0]?.toLowerCase();
    const display = displayOf(p);
    if (display && (ours || personForm(display, email, things))) add(personKey(display.replace(/[._-]+/g, " "), domains), email, ours);
    if (email) add(personKey(localOf(email), domains), email, ours);
  };
  for (const it of o.items) {
    for (const p of it.participants ?? []) person(p);
    for (const e of it.text.match(EMAIL) ?? []) add(personKey(localOf(e), domains), e.toLowerCase());
    for (const line of it.text.split("\n")) { const l = speakerLabel(line.normalize("NFC")); if (l) add(personKey(l.label, domains, { label: true })); }
  }
  for (const t of team) person(t, true);
  for (const n of o.listed ?? []) { const k = nameKey(n); if (k.length >= 3) add(k); }
  for (const f of found) add(nameKey(f.name));
  return { people: [...people.values()], strong: [...new Set(found.map((f) => nameKey(f.name)).filter((k) => k && !k.includes(" ")))] };
}

type Kind = "listed" | "full" | "strong" | "weak";

export function peopleSwap(o: PeopleSwapInput): PeopleSwap {
  const items = o.items;
  const internal = (o.internalDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ""));
  const isInternal = (d: string) => internal.some((i) => d === i || d.endsWith(`.${i}`));
  const participantEmails = items.flatMap((i) => (i.participants ?? []).flatMap((p) => p.match(EMAIL) ?? [])).map((e) => e.toLowerCase());
  const textEmails = items.flatMap((i) => i.text.match(EMAIL) ?? []).map((e) => e.toLowerCase());
  // Companies: the email domains' names, and the ones the caller knows (the task's own text, a pack's list). The second
  // only for what the text says: a participant is a person by the meeting's own record, whatever a task once called them.
  const domains = [...new Set([...[...participantEmails, ...textEmails].map(domainOf), ...internal].map(domainLabel).filter(Boolean))];
  const exclude = [...new Set([...domains, ...(o.companies ?? [])].filter(Boolean))];
  const things = new Set<string>();
  const inText = namesIn(items, exclude, { things });
  // The participants again with only the domains as companies; never a mailbox's or a brand's one-word name.
  const notPeople = new Set(items.flatMap((i) => i.participants ?? []).filter((p) => displayOf(p) && !personForm(displayOf(p), p.match(EMAIL)?.[0], things)).map((p) => nameKey(displayOf(p))));
  const found = [...inText, ...namesIn(items.map((i) => ({ participants: i.participants ?? [] })), domains).filter((f) => !notPeople.has(nameKey(f.name)))];
  const labelKey = (raw: string) => personKey(raw, exclude, { label: true });
  const attendee = (raw: string) => personKey(raw, domains);
  // R5a: only the people this Mac knows whose name has a word the sources have, so the patterns stay few.
  const words = new Set(items.flatMap((i) => nameKey(i.text).split(" ")));

  // People: a union of the keys known to be one person (a full name "n:…", an address "e:…", a participant "p:…", a
  // one-word name "w:…"). Each node says whether the task's own sources gave it, and whether it's the team's own.
  const parent = new Map<string, string>();
  const root = (k: string): string => { let r = k; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; if (!parent.has(r)) parent.set(r, r); parent.set(k, r); return r; };
  const join = (a: string, b: string) => { const x = root(a), y = root(b); if (x !== y) parent.set(y, x); };
  const local = new Set<string>(), ours = new Set<string>();
  const node = (n: string, here: boolean, team = false) => { root(n); if (here) local.add(n); if (team) ours.add(n); return n; };
  /** Single words tied to one node: a participant's one-word name, an address's one-word local part. */
  const ties = new Map<string, Set<string>>();
  const singles = new Map<string, { here: boolean; team: boolean }>();
  const strong = new Set<string>();
  const listed = new Set<string>();
  const handles = new Map<string, string>();
  const name = (k: string, at?: string, here = true, team = false) => {
    if (k.includes(" ")) { node(`n:${k}`, here, team); if (at) join(at, `n:${k}`); return; }
    if (at) { ties.set(k, (ties.get(k) ?? new Set()).add(at)); return; }
    const s = singles.get(k);
    singles.set(k, { here: here || !!s?.here, team: team || !!s?.team });
  };

  items.forEach((it, i) => (it.participants ?? []).forEach((p, j) => {
    const email = p.match(EMAIL)?.[0]?.toLowerCase();
    const display = displayOf(p);
    const ks = [display && personForm(display, email, things) ? attendee(display) : null, email ? attendee(localOf(email)) : null].filter((k): k is string => !!k);
    if (!ks.length) return;
    const at = node(email ? `e:${email}` : `p:${i}.${j}`, true);
    for (const k of ks) name(k, at);
  }));
  for (const e of textEmails) { const k = attendee(localOf(e)); if (k) name(k, node(`e:${e}`, true)); }
  for (const it of items) {
    for (const line of it.text.split("\n")) { const l = speakerLabel(line.normalize("NFC")); const k = l && labelKey(l.label); if (k) name(k); }
    for (const m of it.text.matchAll(/(?:^|[\s(,;])@([\p{L}\d][\p{L}\p{M}\p{N}._-]*)/gu)) { const k = attendee(m[1]!.replace(/[._+-]+/g, " ")); if (k) { handles.set(handleKey(m[1]!), k); name(k); } }
  }
  for (const f of found) { const k = nameKey(f.name); if (!k) continue; name(k); if (!k.includes(" ")) strong.add(k); }
  // The CRM list isn't the task's own sources: a word it shares with a participant is the participant's.
  for (const n of o.listed ?? []) { const k = nameKey(n); if (k.length < 3) continue; listed.add(k); name(k, undefined, false); }
  for (const p of o.known?.people ?? []) {
    if (!p.key.split(" ").some((w) => words.has(w)) || exclude.some((x) => nameKey(x) === p.key)) continue;
    const at = p.emails.length ? node(`e:${p.emails[0]}`, false, !!p.ours) : undefined;
    for (const e of p.emails.slice(1)) join(at!, node(`e:${e}`, false, !!p.ours));
    if (p.key.includes(" ")) node(`n:${p.key}`, false, !!p.ours);
    name(p.key, at, false, !!p.ours);
  }
  for (const w of o.known?.strong ?? []) if (words.has(w)) strong.add(w);

  // The groups as they stand: their full names, addresses (with whether the task's sources gave each), and whether the
  // task's own sources or the team gave them.
  const groups = () => {
    const by = new Map<string, { fulls: Set<string>; emails: Map<string, boolean>; here: boolean; team: boolean }>();
    for (const k of parent.keys()) {
      const r = root(k);
      const g = by.get(r) ?? { fulls: new Set(), emails: new Map(), here: false, team: false };
      if (k.startsWith("n:")) g.fulls.add(k.slice(2));
      if (k.startsWith("e:")) g.emails.set(k.slice(2), local.has(k));
      g.here ||= local.has(k);
      g.team ||= ours.has(k);
      by.set(r, g);
    }
    return by;
  };
  let by = groups();
  const containing = (w: string) => [...by].filter(([, g]) => [...g.fulls].some((f) => f.split(" ").includes(w))).map(([r]) => r);
  /** The people a word can be, the task's own sources' first. */
  const first = (rs: string[]) => { const u = [...new Set(rs)]; const h = u.filter((r) => by.get(r)?.here); return h.length ? h : u; };
  // A participant known only by one word ("Dana <dana@globex.example>") is the one full name with that word, if one.
  for (const [w, nodes] of ties) {
    const tied = [...new Set([...nodes].map(root))];
    const c = first(containing(w));
    if (tied.length === 1 && !by.get(tied[0]!)!.fulls.size && c.length === 1) join(c[0]!, tied[0]!);
  }
  by = groups();
  // Each single word's person, or null when it can belong to more than one. A word no full name has is its own person.
  const owner = new Map<string, string | null>();
  for (const w of new Set([...ties.keys(), ...singles.keys(), ...strong])) {
    const all = first([...[...(ties.get(w) ?? [])].map(root), ...containing(w)]);
    if (all.length > 1) owner.set(w, null);
    else if (all.length === 1) owner.set(w, all[0]!);
    // Known by this one word only ("Sam:", "ask Sam"): a person of their own, never a full name, so "sam" in lower case stays.
    else owner.set(w, node(`w:${w}`, singles.get(w)?.here ?? true, singles.get(w)?.team ?? false));
  }
  by = groups();

  // What each person keeps: one company from their addresses' domains (the task's own sources' first), or none.
  const fullsOf = [...by.values()].flatMap((g) => [...g.fulls]);
  const vanity = (label: string) => {
    const l = label.replace(/-/g, "");
    return [...fullsOf, ...owner.keys()].some((f) => {
      const ws = f.split(" ").filter((w) => w.length >= 2);
      return ws.some((w) => w.length >= 3 && l === w) || ws.some((a, i) => ws.some((b, j) => i !== j && (l.includes(a + b) || l === a[0] + b || l === a + b[0])));
    });
  };
  const outside = (d: string) => { const l = domainLabel(d); return !isInternal(d) && !!l && !freeMail(d) && !vanity(l) ? l : null; };
  const texts = items.map((i) => i.text.normalize("NFC")).join("\n");
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // R5c: as the task's own text names the company ("Globex Hotels" for globex.example), else as the sources write it.
  const spell = (label: string) => {
    const flat = label.replace(/-/g, "");
    const named = (o.companies ?? []).filter((c) => /^\p{Lu}/u.test(c.trim()));
    const said = [...texts.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${esc(label)}(?![\\p{L}\\p{N}])`, "giu"))].map((m) => m[0]).find((m) => /^\p{Lu}/u.test(m));
    // A capitalized run whose words, without spaces, "&" or "and", are the label: "Hart & Stone", "Hart and Stone".
    const run = [...texts.matchAll(/(?<![\p{L}\p{N}])\p{Lu}[\p{L}\p{M}'’.-]*(?:[ \t]+(?:&[ \t]+|and[ \t]+)?\p{Lu}[\p{L}\p{M}'’.-]*){1,3}/gu)]
      .map((m) => m[0].replace(/['’]s?$/, "")).find((m) => { const w = nameKey(m).split(" "); return w.join("") === flat || w.filter((x) => x !== "and").join("") === flat; });
    return named.find((c) => nameKey(c).replace(/ /g, "") === flat) ?? named.find((c) => nameKey(c).split(" ")[0] === flat) ?? run ?? said ?? label.charAt(0).toUpperCase() + label.slice(1);
  };
  const company = new Map<string, string | null>();
  for (const [r, g] of by) {
    const here = [...g.emails].filter(([, h]) => h).map(([e]) => e);
    const addresses = here.length ? here : [...g.emails.keys()];
    const said = [...new Set(addresses.map((e) => (isInternal(domainOf(e)) ? OURS : outside(domainOf(e)))).filter((x): x is string => !!x))];
    // Two companies for one person (a personal and a work address at two firms) say neither.
    company.set(r, said.length > 1 ? null : said[0] === OURS || (!said.length && g.team) ? OURS : said[0] ? spell(said[0]) : null);
  }

  // Every way a person is written, longest first, so a full name wins over its words.
  const variants = new Map<string, { kind: Kind; who: string | null }>();
  const put = (k: string, kind: Kind, who: string | null) => { const v = variants.get(k); if (!v) variants.set(k, { kind, who }); else if (v.who !== who) v.who = null; };
  for (const [r, g] of by) for (const f of g.fulls) put(f, listed.has(f) ? "listed" : "full", r);
  for (const [w, r] of owner) put(w, listed.has(w) ? "listed" : strong.has(w) ? "strong" : "weak", r);
  for (const g of by.values()) for (const f of g.fulls) for (const w of f.split(" ")) {
    if (w.length < 3 || variants.has(w) || domains.some((x) => nameKey(x) === w)) continue;
    const c = first(containing(w));
    variants.set(w, { kind: strong.has(w) ? "strong" : "weak", who: c.length === 1 ? c[0]! : null });
  }

  let n = o.from ?? 0;
  const numbers = new Map<string, number>();
  const tag = (who: string | null) => {
    if (who === null) return "[PERSON]";
    if (!numbers.has(who)) numbers.set(who, ++n);
    const c = company.get(who);
    return `[PERSON-${numbers.get(who)}${c ? `, ${c}` : ""}]`;
  };
  const byEmail = new Map<string, string>();
  for (const [r, g] of by) for (const e of g.emails.keys()) byEmail.set(e, r);
  const ownerOf = (k: string): string | null | undefined => (k.includes(" ") ? root(`n:${k}`) : owner.get(k));
  const keys = [...variants.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const re = new RegExp([
    `([\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+)`,
    `(^|[\\s(,;])@([\\p{L}\\d][\\p{L}\\p{M}\\p{N}._-]*)`,
    // Always a fourth group, so the replacer's arguments keep their places; with no names it never matches.
    keys.length ? `(?<![\\p{L}\\p{M}\\p{N}])(${keys.map(pattern).join("|")})(?![\\p{L}\\p{M}\\p{N}])` : "((?!))",
  ].join("|"), "giu");
  const body = (s: string) => s.normalize("NFD").replace(re, (m: string, email?: string, pre?: string, handle?: string, word?: string, at?: number, whole?: string) => {
    if (email) { const r = byEmail.get(email.toLowerCase()); return r ? tag(r) : m; }
    if (handle !== undefined) { const k = handles.get(handleKey(handle)); const r = k ? ownerOf(k) : undefined; return r === undefined ? m : `${pre}${tag(r)}`; }
    if (!word) return m;
    const key = nameKey(word);
    const v = variants.get(key);
    if (!v) return m;
    const cued = () => CUE.test(whole!.slice(Math.max(0, at! - 24), at!));
    const capital = /^\p{Lu}/u.test(word);
    // A full name in any case only when each of its words is a name on its own: "we will price it" stays.
    // R5a: "Grant's skeleton variant" or "as Grant said" for Theo Grant, mid-sentence: the person, not the word.
    const person = () => capital && (/^['’]s\b/.test(whole!.slice(at! + word.length)) || (SAYS.test(whole!.slice(at! + word.length)) && !STARTS.test(whole!.slice(Math.max(0, at! - 4), at!))));
    const swap = v.kind === "listed"
      || (v.kind === "full" && (word.normalize("NFC").split(/[ \t '’.-]+/).every((p) => /^\p{Lu}/u.test(p)) || key.split(" ").every((w) => strong.has(w)) || cued()))
      || (v.kind === "strong" && (capital || cued()))
      || (v.kind === "weak" && (cued() || person()));
    return swap ? tag(v.who) : m;
  }).normalize("NFC");

  const names = [...new Set([...fullsOf.map(title), ...[...owner.keys()].map(title), ...byEmail.keys()])];
  const companies = [...new Set(participantEmails.map((e) => outside(domainOf(e))).filter((x): x is string => !!x))];
  return {
    names,
    companies,
    swap(text) {
      return text.split("\n").map((raw) => {
        const line = raw.normalize("NFC");
        const l = speakerLabel(line);
        const k = l ? labelKey(l.label) : null;
        const who = k ? ownerOf(k) : undefined;
        if (!l || who === undefined) return body(line);
        return `${line.slice(0, l.start)}${tag(who)}${body(line.slice(l.end))}`;
      }).join("\n");
    },
  };
}
