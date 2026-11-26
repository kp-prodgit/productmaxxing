/**
 * R23: Linear turns an issue identifier in a description or comment into a mention, and its connector hands it back as
 * markup: "**Follows PMX-34:** … outputs/problem-brief/PMX-34.md" comes back as
 * `**Follows** <issue id="…" label="PMX-34" href="…" />**:** … outputs/problem-brief/<issue … />.md`. PMX reads
 * Linear's text with the mention as the identifier it stands for, so every line PMX parses reads the same either way.
 */
const MENTION = /<issue\b[^>]*?\blabel="([A-Za-z][A-Za-z0-9]*-\d+)"[^>]*?(?:\/>|>[^<]*<\/issue>)/g;

/** Linear's text with each issue mention as its identifier: `<issue … label="PMX-34" … />` reads as PMX-34. */
export function plainMentions(text: string): string {
  return text.includes("<issue") ? text.replace(MENTION, "$1") : text;
}

/**
 * A follow-up's original task, as its description names it (FOLLOW-1): "**Follows PMX-12:**", or as Linear gives it
 * back, "**Follows** <issue … label="PMX-12" … />**:**".
 */
export function followsIn(description: string): string | null {
  return plainMentions(description).match(/^\*\*Follows(?:\*\*)? ([A-Za-z][A-Za-z0-9]*-\d+)(?:\*\*)?:/m)?.[1] ?? null;
}
