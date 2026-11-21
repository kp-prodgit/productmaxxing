The sheet a report is printed on: one US Letter page with a running header, a text column and a footer, laid on a desk.

**Use** `.rp-desk` once around every sheet of a report, and one `.rp` per page, holding `.rp-head` (not on page one), `.rp-body` and `.rp-foot`. On screen a sheet is 816 by 1056; under 880 wide it turns fluid; in print each `.rp` is one page. Not for screens people work in.

**You provide** the team and title for the header, "Prepared for" the reader and month, and the page number. A report is always light: `.rp` restates the light colour tokens, so a dark desk still holds white paper.

**Brand.** `--brand` defaults to `var(--accent)`. A workspace sets it inline on each sheet (`style="--brand: var(--ok)"`). It marks only the cover rule, heading bars, stat rule and list bullets, never text.

**Pagination.** CSS cannot flow content across fixed sheets, so the renderer does: it measures each direct child of `.rp-body` in a hidden `.rp.is-measure` and starts a new sheet when the next would overflow. A ReportTable splits only between rows, repeating its header row; a heading stays with what follows; a figure or stat band never splits.

- Do keep one accent: the brand.
- Don't put controls on a sheet; review switches live outside it.

States: sheet, first sheet (no header), fluid, print.
