A menu: a short list of acts on one thing, opened from a button and closed when one is chosen.

**Use** `.menu` with `role="menu"` for the acts that do not earn a button of their own (Rename, Copy link, Hold back, Withdraw). Open it from an `.ib` or `.btn` with `aria-haspopup="menu"` and `aria-expanded`. Add `.pop` to place it under its button, inside a parent with `position: relative`. It sits on `card` with `shadow`.

**You provide** the items as `button role="menuitem"`, each with an optional `svg.i` and a label; a `span` wrapping the label and a `small` gives one hint line that says the consequence. Put a `.sep` with `role="separator"` before the destructive group, and `.danger` on an act that removes or withdraws. Wire arrow keys, Escape and return of focus to the button.

- Do write the hint as who is affected: "Every group goes back to edition 1."
- Do keep the danger item last, after a separator.
- Don't nest menus or put more than eight items in one.
- Don't put the person's next step in a menu. It belongs on a button.

States: rest, hover and focus (`hover`), danger hover (`bad-soft`), disabled (`aria-disabled`, 45%, with its reason as the hint). Item height `control`, `touch` under 768px.
