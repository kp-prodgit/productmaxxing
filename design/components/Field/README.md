A field: a label, one control, a line of help or the error, and a mark that says whether the value is saved.

**Use** `.field` for every input, select and textarea. Inside, `.head` holds the `label` and, at its right, the save mark `.save`. The control is `.in`. Below it put at most one line: `.help` in `fg-2`, or `.err` in `bad` when the control has `aria-invalid="true"`. `.in` also works alone, without the wrapper, in a dense row that has another label.

**You provide** the label, the control with `id`, `aria-describedby` pointing at the help or error, and the save mark's words: "Saved" with the `i-check` icon after a save (quiet, `fg-3`), or "Not saved" in `fg-2` while an edit waits.

- Do write the error as what to do: "Enter a figure in dollars, like $2.4B."
- Do keep the label visible. The `line-2` border is below 3:1; the label above the control identifies it.
- Don't show unsaved work in amber, or with a dot. `today` means only "changed since the last release".
- Don't show "Saved" on a field nobody has edited. The normal case is silent.

States: rest, hover (`fg-3` border), focus-visible, error, disabled (`sunken`), saved, not saved. Height `control`, `touch` and 16px text under 768px.
