An icon button: one icon with no visible label, for rails, toolbars and the right edge of a row.

**Use** `.ib` (quiet, no fill) at the end of a row or in a header, and `.ib.bar` beside `.btn` on a toolbar, where its `card` fill and `line-2` border match the buttons. Use a labelled `.btn` instead whenever there is room for the word; an icon replaces a label only in a rail or toolbar.

**You provide** one `svg.i` from the sprite, an `aria-label` and a matching `title` that name the act and its object ("More actions for Vision"), and `aria-pressed` when the button toggles a view on or off. Pressed fills with `select`.

- Do name the object in the label when several rows carry the same icon.
- Do use `aria-haspopup="menu"` and `aria-expanded` when it opens a `.menu`.
- Don't put meaning in the icon alone that the label does not also say. The tooltip repeats the name; it never adds to it.
- Don't use the `line-2` border to find the quiet button. It is found by its icon and its place at the end of a row; the border on `.bar` is below 3:1 and is not relied on.

States: rest, hover (`hover`), pressed (`select`), focus-visible, disabled (45%). Size `control` square, `touch` under 768px.
