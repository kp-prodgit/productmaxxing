Facts in rows and columns, for reading across, and the matrix that shows coverage by scope.

**Use** `.tbl` around a `table` when the reader compares values: editions, prices, dates. Use `.tbl.matrix` for a coverage grid with items down the side and scopes across the top, such as which group sees each section. Use List when there is only one thing per row worth reading.

**You provide** a `table` labelled by its heading, `th scope="col"` heads in sentence case, a `th scope="row"` for each row's name, and class `.n` on numeric heads and cells so they align right in tabular figures. In a matrix, a cell holds a `.pill` for an exception, or is `td.nil` with its word in `.sr-only` for the usual state, which draws a quiet en dash.

- Do say above a matrix what is marked: "Marked only where a group does not".
- Do write numbers as people say them: "1 of 5", "12 Nov 2026".
- Don't fill every matrix cell with a pill. If most cells are marked, mark the other state.
- Don't let a wide table scroll the page; the wrapper scrolls, and in a matrix the row names stay put.

States: rest, row hover, empty (replace with `.empty`), loading (Skeleton lines in cells).

**Header and totals.** Every table has an ink header row (`fg` ground, `bg` text), the same in work, briefing and report. Put `.is-total` on a total row, `.zebra` on the wrapper when rows are long, and use `.cmp` with `td.was` and `td.now.is-changed` to show before beside now; the changed value is marked by weight, never by colour alone.
