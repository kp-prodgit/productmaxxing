#!/usr/bin/env node
// Builds design/dist/pmx.css, the PMX family's one stylesheet, from design/tokens.json and design/parts/*.css.
// No dependencies: Node's own fs only.
//
//   node design/build.mjs           write dist/pmx.css
//   node design/build.mjs --check   fail if dist/pmx.css is not what the sources build (what CI and the tests run)
//
// dist/pmx.css has three marked parts, each between a `/* >>> name */` and a `/* <<< name */` line:
//   tokens      colour, in light and both dark selectors, in exactly the shape PMX's Workspace and board carry
//               (with the type families, the three radii and the easing PMX already keeps there)
//   scale       the non-colour tokens: type ramp, space, the pill radius, motion, layout, and --font-sans / --font-mono
//               defined from PMX's --font / --mono, so nothing redefines --font
//   components  parts/*.css in order
// PMX's pages copy the first two byte for byte (test/tokens.test.ts); PMX Engine vendors the whole file by hash.
//
// The build fails on `style=`, `url(`, `@import`, or a raw hex/rgb/hsl colour anywhere outside the tokens part.
// The only exceptions are regions a part marks with `/* >>> literal colours: why */` … `/* <<< literal colours */`:
// the print block (paper is white whatever the theme) and the report sheet (light restated so a sheet stays paper
// in dark mode). The report sheet's values must equal the light values in tokens.json.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Component parts, in cascade order: base first, print (inside briefing) last. */
export const PARTS = ["_base", "controls", "structure", "studio", "flows", "report", "briefing"];

/** The light block, line by line, as PMX's pages have carried it. A string is a comment line. */
const LIGHT = [
  ["bg", "sunken", "card", "hover", "select"],
  ["line", "line-2"],
  ["fg", "fg-2", "fg-3"],
  ["accent", "accent-soft", "accent-fg"],
  ["today", "ok", "ok-soft", "warn", "warn-soft", "bad", "bad-soft"],
  ["ic-up", "ic-any"],
  "/* The flow map: where data is (this Mac, Claude, Linear, your repo, kept private). */",
  ["mac", "mac-soft", "claude", "claude-soft", "linear", "linear-soft", "repo", "repo-soft", "held", "held-soft"],
  ["shadow"],
  ["shadow-1"],
  ["scrim", "knob", "toast-hover"],
  ["font"],
  ["mono"],
  ["r-s", "r-m", "r-l"],
  ["ease"],
];
/** The dark blocks: only the tokens whose dark value differs from light. */
const DARK = [
  ["bg", "sunken", "card", "hover", "select"],
  ["line", "line-2", "fg", "fg-2", "fg-3"],
  ["accent", "accent-soft", "accent-fg"],
  ["today", "ok", "ok-soft", "warn", "warn-soft", "bad", "bad-soft"],
  ["ic-up", "ic-any", "mac", "mac-soft", "claude", "claude-soft", "linear", "linear-soft", "repo", "repo-soft", "held", "held-soft"],
  ["scrim", "shadow-1", "shadow"],
];
/** Tokens made from other tokens rather than read from tokens.json. */
const DERIVED = [["ring", "0 0 0 2px var(--bg), 0 0 0 4px var(--accent)"]];

const LITERAL = /\/\* >>> literal colours: [^*]*\*\/[\s\S]*?\/\* <<< literal colours \*\//g;

function fail(msg) {
  throw new Error(`design/build.mjs: ${msg}`);
}

/** Every token as { name: { light, dark } } (dark is undefined when a token has one value). */
function themed(t) {
  const out = new Map();
  const put = (name, light, dark, themedKind = false) => {
    if (out.has(name)) fail(`--${name} is defined twice in tokens.json`);
    out.set(name, { light, dark, themed: themedKind });
  };
  for (const c of t.color.tokens) put(c.name, c.value.light, c.value.dark, true);
  for (const s of t.shadow.tokens) put(s.name, s.value.light, s.value.dark, true);
  put("font", t.type.families.sans);
  put("mono", t.type.families.mono);
  for (const r of t.radius.tokens) put(r.name, r.value);
  for (const m of t.timing.tokens) put(m.name, m.value);
  return out;
}

const decl = (name, value) => `--${name}: ${value};`;

function tokensPart(all) {
  const placed = new Set();
  const lightLines = LIGHT.map((line) => {
    if (typeof line === "string") return `  ${line}`;
    return "  " + line.map((n) => {
      const v = all.get(n);
      if (!v) fail(`the light block names --${n}, which tokens.json does not define`);
      placed.add(n);
      return decl(n, v.light);
    }).join(" ");
  });
  for (const [n, v] of all) {
    if (v.themed && !placed.has(n)) fail(`--${n} is a colour or shadow but has no place in the light block (add it to LIGHT)`);
  }
  const darkNames = DARK.flat();
  for (const [n, v] of all) {
    const differs = v.dark !== undefined && v.dark !== v.light;
    if (differs && !darkNames.includes(n)) fail(`--${n} changes in dark but has no place in the dark block (add it to DARK)`);
    if (!differs && darkNames.includes(n)) fail(`--${n} is in the dark block but has the same value in both themes`);
  }
  const darkBody = DARK.map((line) => "  " + line.map((n) => decl(n, all.get(n).dark)).join(" "));
  const darkEnd = (close) => [...darkBody.slice(0, -1), `${darkBody[darkBody.length - 1]} color-scheme: dark ${close}`];
  return [
    ":root {",
    ...lightLines,
    "  color-scheme: light;",
    "}",
    '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {',
    ...darkEnd("} }"),
    ':root[data-theme="dark"] {',
    ...darkEnd("}"),
  ].join("\n");
}

function scalePart(t, inTokens) {
  const line = (pairs) => "  " + pairs.map(([n, v]) => decl(n, v)).join(" ");
  const type = t.type.groups.flatMap((g) => g.styles.map((s) => {
    const family = g.family === "mono" ? "var(--font-mono)" : "var(--font-sans)";
    const pairs = [[s.name, `${s.fontWeight} ${s.fontSize}/${s.lineHeight} ${family}`]];
    if (s.letterSpacing) pairs.push([`${s.name}-tracking`, s.letterSpacing]);
    return line(pairs);
  }));
  const tokens = (list) => list.filter((x) => !inTokens.has(x.name)).map((x) => [x.name, x.value]);
  return [
    ":root {",
    "  /* The family names PMX Engine's parts use, drawn from the Workspace's own. */",
    line([["font-sans", "var(--font)"], ["font-mono", "var(--mono)"]]),
    "  /* Type: weight size/line-height family, for `font:`; -tracking is its letter-spacing. */",
    ...type,
    line(tokens(t.spacing.tokens)),
    line(tokens(t.radius.tokens)),
    line(tokens(t.timing.tokens)),
    line(tokens(t.layout.tokens)),
    line(DERIVED),
    "}",
  ].join("\n");
}

function componentsPart() {
  return PARTS.map((p, i) => {
    const text = readFileSync(join(here, "parts", `${p}.css`), "utf8").replace(/\s+$/, "");
    return i === 0 ? text : `\n/* ===== ${p} ===== */\n${text}`;
  }).join("\n");
}

/** What the tokens part rules out everywhere else. Returns a list of problems. */
export function lint(name, text, light) {
  const problems = [];
  const where = (i) => `${name}:${text.slice(0, i).split("\n").length}`;
  for (const m of text.matchAll(LITERAL)) {
    // A restated light value must be the light value.
    for (const d of m[0].matchAll(/--([a-z0-9-]+):\s*([^;!]+?)\s*;/g)) {
      const want = light.get(d[1]);
      if (want !== undefined && /report/.test(m[0].slice(0, 60)) && want !== d[2]) {
        problems.push(`${where(m.index + d.index)}: the report sheet restates --${d[1]} as ${d[2]}, but its light value is ${want}`);
      }
    }
  }
  const open = (text.match(/>>> literal colours/g) || []).length;
  const close = (text.match(/<<< literal colours/g) || []).length;
  if (open !== close) problems.push(`${name}: a literal colours region is not closed`);
  const rest = text.replace(LITERAL, (r) => r.replace(/[^\n]/g, " "));
  const rules = [
    [/style\s*=/g, "a style attribute (the pages' CSP forbids them)"],
    [/url\(/gi, "url( (the CSP loads nothing from CSS)"],
    [/@import/gi, "@import (the CSP loads nothing from CSS)"],
    [/#[0-9a-f]{3,8}\b/gi, "a raw hex colour (use a token)"],
    [/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/gi, "a raw colour function (use a token)"],
    [/@font-face/gi, "a web font (system fonts only)"],
    [/--(font|mono)\s*:/g, "a redefinition of PMX's --font or --mono (they live in the tokens part)"],
  ];
  for (const [re, what] of rules) for (const m of rest.matchAll(re)) problems.push(`${where(m.index)}: ${what}: ${m[0]}`);
  return problems;
}

/** The whole stylesheet, and each part on its own. Throws if a source breaks a rule. */
export function build() {
  const t = JSON.parse(readFileSync(join(here, "tokens.json"), "utf8"));
  const all = themed(t);
  const tokens = tokensPart(all);
  const scale = scalePart(t, new Set(LIGHT.flat()));
  const components = componentsPart();
  const light = new Map([...all].map(([n, v]) => [n, v.light]));
  const problems = [
    ...lint("scale part", scale, light),
    ...PARTS.flatMap((p) => lint(`parts/${p}.css`, readFileSync(join(here, "parts", `${p}.css`), "utf8"), light)),
  ];
  // Every var(--x) without a fallback must be defined somewhere in the file.
  const css = [
    "/* PMX design system. Generated by design/build.mjs from design/tokens.json and design/parts/*.css; do not edit by hand. */",
    "/* >>> tokens */", tokens, "/* <<< tokens */",
    "/* >>> scale */", scale, "/* <<< scale */",
    "/* >>> components */", components, "/* <<< components */",
    "",
  ].join("\n");
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  for (const m of css.matchAll(/var\((--[a-z0-9-]+)\s*\)/gi)) {
    if (!defined.has(m[1])) problems.push(`var(${m[1]}) is used but never defined`);
  }
  if (problems.length) fail(`\n  ${[...new Set(problems)].join("\n  ")}`);
  return { css, tokens, scale, components };
}

/** The lines between `/* >>> name *\/` and `/* <<< name *\/`, as test/tokens.test.ts reads them. */
export function part(text, name) {
  const lines = text.split("\n");
  const a = lines.indexOf(`/* >>> ${name} */`);
  const b = lines.indexOf(`/* <<< ${name} */`);
  if (a < 0 || b < a) throw new Error(`no ${name} part`);
  return lines.slice(a + 1, b).join("\n");
}

export const DIST = join(here, "dist", "pmx.css");

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { css } = build();
    if (process.argv.includes("--check")) {
      let have = "";
      try { have = readFileSync(DIST, "utf8"); } catch {}
      if (have !== css) {
        console.error("design/dist/pmx.css is not what the sources build. Run: node design/build.mjs");
        process.exit(1);
      }
      console.log("design/dist/pmx.css is up to date.");
    } else {
      mkdirSync(dirname(DIST), { recursive: true });
      writeFileSync(DIST, css);
      console.log(`Wrote design/dist/pmx.css (${css.length} bytes).`);
    }
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
