import type { SignalItem } from "../core/types.js";

/**
 * Email threads (TODO-8). The collection task saves a thread from an approved inbox or label like any channel's
 * (INPUT-1): one file, one "Author: message" line per message. What makes it email is the connector it came from, by
 * its ID as `source:` spells it: Gmail, Outlook, Microsoft Exchange, a mail app or a shared-inbox app.
 */
const EMAIL_SOURCE = /mail|outlook|exchange|^(superhuman|front|missive|hey)$/;

/** Whether a connector ID ("gmail", "microsoft-outlook") is an email connector's. */
export const isEmailSource = (source: string | null | undefined): boolean => !!source && EMAIL_SOURCE.test(source);

/** Whether an item is an email thread: a thread from an email connector. */
export const isEmailThread = (i: Pick<SignalItem, "kind" | "origin">): boolean => i.kind === "thread" && isEmailSource(i.origin?.source);

/** Header lines a saved email may carry that say nothing about who wrote a message. */
const HEADER = /^(to|cc|bcc|subject|date|sent|reply-to|re|fwd?|attachments?)$/i;

/**
 * Who wrote the messages of a saved thread, as the lines label them: "Dana Ruiz: Hi Lee, …", or a "From:" line's
 * value when the connector kept the headers. Quoted lines (">") and a reply's "On Nov 26, Dana wrote:" are someone's
 * earlier message, not a new one, so they name no author. A URL or a time ("https:", "10:30") gives a label that is
 * no one's, which never matters: the labels are only compared with the PM's own names and addresses.
 */
export function authorsOf(text: string): string[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^\s>:"'][^:\n]{0,79}?)\s*:\s*(.*)$/);
    if (!m) continue;
    const label = m[1]!.trim();
    if (/\bwrote$/i.test(label) || HEADER.test(label)) continue;
    out.add(/^from$/i.test(label) ? m[2]!.trim() : label);
  }
  return [...out].filter(Boolean);
}

/**
 * The PM's own addresses (TODO-8): the ones PMX knows, and the same mailbox at each of the company's other domains
 * ("ana@us.example" is also "ana@us.io" when both are the company's), since a company that owns two domains often
 * delivers one mailbox at both. An address at a domain that isn't the company's (a personal one) stays as it is.
 */
export function ownAddresses(emails: readonly string[], companyDomains: readonly string[]): string[] {
  const domains = companyDomains.map((d) => d.toLowerCase());
  const out = new Set(emails.map((e) => e.trim().toLowerCase()).filter((e) => e.includes("@")));
  for (const e of [...out]) {
    const [local, domain] = [e.slice(0, e.lastIndexOf("@")), e.slice(e.lastIndexOf("@") + 1)];
    if (local && domains.includes(domain)) for (const d of domains) out.add(`${local}@${d}`);
  }
  return [...out];
}
