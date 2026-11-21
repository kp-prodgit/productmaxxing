PMX is a family of calm instruments for people who decide: the PMX Workspace, the team board, PMX Engine's studio, and the briefing pages each group reads. One look, one set of parts, one voice.

The person in front of every screen is a decision maker. They arrive with a question (what needs me, what did we decide, what may I say) and should leave with a decision made. They do not operate the tool; the tool reports to them.

## Principles

Eight rules, in priority order. When two conflict, the earlier one wins.

1. **Answer first.** Every screen and every page opens with one sentence a person could repeat in a meeting. Set it in `t-title-1` (work) or `b-display` + `b-standfirst` (briefing). Detail follows, on demand.
2. **One decision at a time.** One filled button per screen (`.btn.pri`), and it is always the person's next step. Everything else is a quiet button or a link.
3. **Words carry meaning. Signs repeat it.** A dot, a colour or a glyph never stands alone. State is a word plus a colour (`.pill`). If a screen needs a legend, redraw the screen.
4. **Exceptions get the ink.** The normal case is silent; only what differs is marked. A section everyone sees shows nothing; a restricted one shows who (`.aud`). This is how a screen gets fewer words without getting harder to read.
5. **Their words, not ours.** Show the person's own content at reading size and name things the way they would. System nouns stay inside the system (see Vocabulary).
6. **Never empty, never stuck.** Every list, canvas and page has a designed empty state that says what will be here and offers the first step (`.empty`). Every wait says who has the next move.
7. **Show the comparison.** A change is argued with a table or a pair of pictures, not with adjectives: before beside now, with a total where things add up and a dated list of every item behind the claim (`.tbl.cmp`, `.rp-tbl`, `.rp-fig.pair`).
8. **Presentable by default.** Anything a reader receives states its purpose in one line, who prepared it and who it was prepared for, its date and edition, what changed, and what that changes for this reader. It can go on a shared screen or be printed and handed over as it is.

Restraint is the style. The palette adds no colour to PMX's own. Ornament that does not carry information is removed. If a part can be taken away and nothing is lost, take it away.

## The ten tests

Run these on every component, screen and page before it ships. Each is a yes or no. A no is a defect, not a preference.

| # | Test | How to check |
|---|---|---|
| 1 | **Five seconds.** Can a person say what is going on and what to do next after five seconds? | Cover everything below the answer line. |
| 2 | **One fill.** Is there exactly one filled button, and is it the next step? | Count `.btn.pri`. Zero is allowed only when nothing is asked. |
| 3 | **Greyscale.** Does every state still read with colour removed? | Desaturate. Each state must keep a word or a distinct shape. |
| 4 | **No legend.** Can a first-time reader decode every mark without help? | No "signs" dialog, no meaning that lives only in a tooltip. |
| 5 | **Silence.** Is the default case unmarked, and the exception marked? | The most common state on the screen should have the least ink. |
| 6 | **Plain names.** Is every word one the person would use out loud? | Check against Vocabulary; no file names, IDs or internal verbs. |
| 7 | **Full states.** Are empty, loading, error, read-only and busy all designed? | Each has what, why and the next step. |
| 8 | **Whose move.** At every step of a flow, is it clear who acts next and where? | Person here, person on the Mac, Claude, or a colleague. |
| 9 | **Stage.** Would you put it in front of the leadership team, or send it to a customer? | Purpose, prepared by and for, date, what changed and what it changes for the reader are all present. Every claim of change has its comparison. Light and dark, 400px and 1440px, text at 4.5:1, printed. |
| 10 | **System only.** Is every colour, size, space and radius a token, and every part a component? | No raw hex, no half-pixel sizes, no one-off padding. |

## Three registers

The same tokens are set in three registers. Choosing the wrong one is the most common mistake.

- **Work**: for doing. The Workspace, the board, the studio. `t-body` 14/20, compact rows, `control` 32px. Dense but calm.
- **Briefing**: for reading and presenting. Every page a group receives, every report, every announcement. `b-body` 17/26 on a `measure` column, `b-display` titles, one figure per idea. If it will be read by someone who did not make it, it is a briefing.

- **Report**: for presenting and sending. A paged, printable, always-light document built from `.rp` sheets: a cover with purpose and prepared-by, a running head and a "Prepared for" foot on every page, numbered sections, an overview with a summary table first, tables and figures that carry the argument, a "What this changes for you" list, and a dated appendix. Body 14/22, tables 13/18, appendix 12/16. If it will be printed, attached or shown to someone outside the team, it is a report.

Never set a briefing or a report in the work register. That is what makes a report look like a tool's printout.

## Voice

- Sentence case everywhere, including buttons, tabs and column heads. No all-capitals labels.
- A button says what happens: "Release to ELT", not "Submit" or "OK". The toast that follows says it happened: "Released to ELT".
- Short and whole. "Nothing is waiting on you." beats "Nothing". A fragment is not shorter in the reader's head.
- Numbers the way people say them: "$2.4B", "3 of 5 groups", "12 Nov".
- Say who and what a consequential act affects before it happens: "Sales and the rest of GTM will see this."
- No exclamation marks, no emoji, no apologies. Errors say what happened and what to do.
- Address the person as "you". PMX and Claude are named in the third person.

### Vocabulary

| Say | Not |
|---|---|
| page | hub |
| release | freeze, publish, ship |
| send to a group, has reached | carry, leg, travelling, written |
| who sees it, audience | aud, cut, marker |
| section | block, part |
| hold back, withdraw | hold, retract |
| the product team's names for groups, spelled out on first use | ELT, ENG, PMM, SAL, GTM alone |
| edition (kept: it is the reader-facing name of a release) | rev, version, op |

## Colour

- Grounds: `bg` for the page, `sunken` one step back, `card` for objects. Text is `fg`, then `fg-2`, then `fg-3`; nothing smaller than 12px takes `fg-3`.
- `accent` is spent once per screen on the primary action, plus focus rings and links. Do not use it to decorate.
- State colours `ok`, `warn`, `bad` and `held` always come with a word, on `bg`, `card` or their own `-soft` ground.
- Place colours `mac`, `claude`, `linear`, `repo`, `held` mean where something lives or who does it. Use them in flow diagrams and on the Claude "Proposed" chip, nowhere else.
- `today` (amber) means "changed since the last release" and nothing else. Unsaved work is shown by the field's own save mark, not by amber.
- Audiences are named in words. They have no colours.
- `--brand` is the workspace's own colour, defaulting to `accent`. It exists only inside a report (`.rp`), and only for the cover rule, the bar beside a section heading, the stat-band rule and list bullets. Never text, never a fill behind text, never in the studio or the Workspace.
- Both themes are first-class. In dark, objects separate by tone (`card` on `bg`); in light, by `line` and `shadow-1`.

## Tables and evidence

- Every table has an ink header row (`fg` ground, `bg` text, weight 600), a bold first column, and hairlines between rows. Add `.zebra` when rows are long, `.is-total` on a total row, right-align numbers with tabular numerals.
- Lead with a summary table when there are more than three things to compare; end with the full dated list as an appendix.
- Show a change as before beside now (`.tbl.cmp`): the earlier value in `fg-2`, the changed value in weight 650. Never mark a change by colour alone.
- A picture is evidence, not decoration. Its caption sits above it in bold and says what the reader is looking at. Before and after are shown as a pair, at the same size and crop.
- A stat band (`.rp-stat`) holds one large statement and the figures that support it. Use it once per section at most.
- A short bar in `--brand` may mark a report's section heading, because there it shows structure. Do not put an accent bar or rail on a card, a row or a banner.

## Type

System fonts only (`--font-sans`, `--font-mono`): the pages run offline, inside Claude and under a strict content policy, and on a Mac the system face is the best one available. Weights 400, 500, 600, 650, 700. Sizes come from the two ramps and nothing between them: 11, 12, 13, 14, 16, 20, 24 for work; 14, 17, 21, 32, 48, 56 for briefing. Use tabular numerals wherever digits align. Give headings `text-wrap: balance` and running text a `measure` of 60 to 68 characters.

## Space, shape, depth

- Space is the 4px scale `space-1` to `space-9`. Related things sit `space-2` apart, groups `space-5`, sections `space-6`. Lay out with flex or grid and `gap`.
- Radii: `r-s` for controls, `r-m` for rows and banners, `r-l` for cards and dialogs, `r-pill` for pills. Nested corners step down one size.
- Depth has three levels and no more: flat (a `line`), raised (`shadow-1`, for the object of the screen), overlay (`shadow`, for dialogs, menus, toasts). A border, a fill and a shadow each say "separate object"; use the fewest that work.
- Controls are `control` (32px) tall, `control-sm` (26px) inside dense rows, and at least `touch` (44px) under 768px.

## Motion

One easing, `ease`. `dur-1` for feedback under the pointer, `dur-2` for things appearing, `dur-3` for surfaces and steps. Motion shows where something went. Nothing loops except a spinner, and everything stops under `prefers-reduced-motion`.

## Icons

One set: 24px grid, drawn at 16px, 1.7px stroke, round caps and joins, `currentColor`, no fills. An icon accompanies a label; it replaces one only in a rail or toolbar, and then it carries an accessible name and a tooltip. The Mac mark (a laptop outline) sits on any button whose act is confirmed in a dialog on the person's Mac.

## Flow diagrams

A flow is drawn left to right as stations on one line. A station is a rounded node in a place colour (`mac-soft` ground with `mac` text, and so on) holding two lines: who or where, then what happens. A human gate is a station with a `held` outline and the word of the decision ("You approve"). The current station is filled `accent`; done stations carry a check and the date; later ones are outlined in `line-2`. Arrows are 1.5px `line-2` with a small head. Seven stations at most; a longer flow is two diagrams.

## Accessibility

Text meets 4.5:1 on the grounds its token names, in both themes; marks and control borders that carry meaning meet 3:1. Focus is a solid 2px `accent` ring, offset 2px, on every interactive element. Everything works from the keyboard, in order. Nothing is said by colour, hover or tooltip alone.

## Source, build and how PMX Engine vendors it

`design/` in this repo is the one source for the PMX family's look. Everything else copies from it.

- **Sources:** `tokens.json` (every token, with its use) and `parts/*.css` (the components, tokens only). `components/<Name>/` holds each component's notes and a preview page; previews are documentation, not shipped (the npm package leaves them out).
- **Build:** `node design/build.mjs` writes `design/dist/pmx.css`; `node design/build.mjs --check` fails if the committed file is not what the sources build. No dependencies. The file has three marked parts, each between `/* >>> name */` and `/* <<< name */` lines:
  - `tokens`: colour (and shadows, which carry colour) for light and both dark selectors, in the shape PMX's pages have always carried, with the type families, `r-s`/`r-m`/`r-l` and `ease` PMX keeps there.
  - `scale`: the non-colour tokens: the type ramp (`--t-*`, `--b-*` as `font` shorthands, with `-tracking`), `space-*`, `r-pill`, `dur-*`, layout measures and `--ring`. `--font-sans` and `--font-mono` are defined from PMX's `--font` and `--mono`, so nothing redefines `--font`.
  - `components`: `parts/*.css` in cascade order (`_base`, `controls`, `structure`, `studio`, `flows`, `report`, `briefing`; print last).
- **Rules the build enforces:** no `style=`, `url(`, `@import`, web font, or raw hex/rgb/hsl colour outside the tokens part, and no redefinition of `--font` or `--mono`. The two exceptions are regions marked `/* >>> literal colours: … */` … `/* <<< literal colours */`: the print block, and the report sheet's restated light values, which must equal the light values in `tokens.json`. Every `var(--x)` without a fallback must be defined.
- **PMX's own pages** (`app-skills/pmx-flow/pipeline.html`, `app-skills/pmx-board/board.html`) carry the tokens and scale parts byte for byte; `test/tokens.test.ts` holds both to a fresh build. They do not take the components part: PMX's own components keep their styles until they are moved over on purpose.

### Vendoring into PMX Engine

PMX Engine has no dependency on this package; it copies `design/dist/pmx.css` and records where it came from.

1. Pick a commit of this repo on `main` (or a branch under review) and copy `design/dist/pmx.css` from it into Engine.
2. Record in Engine's `VENDORED.md` the commit, and the SHA-256 of the whole file and of its `tokens` part (the lines between the marks, joined with `\n`, as `scripts/check-pmx-tokens.mjs` reads them).
3. Engine's tests hold its copy to those hashes, so a change there is always deliberate; its `check-pmx-tokens` script and weekly job compare the tokens part with PMX's pages and the latest npm package.
4. To take a newer version, repeat from step 1 and look at the studio and a hub page in light and dark.

Change the look here, never in a copy: edit `tokens.json` or a part, run `node design/build.mjs`, and commit the sources with `dist/pmx.css`.
