A checkbox: the round tick that marks a to-do done (`.ck`), and the square box for picking several items (`.cb`).

**Use** `.ck` at the start of a to-do row: a `button role="checkbox"` with `aria-checked`, holding `svg.tick` with the `i-check` symbol. Checked fills `accent` and draws the tick. `.ck.prop` is a to-do Claude proposed: a dashed `fg-3` ring until it is accepted, always next to the word "Proposed". Use `.cb` in multi-select lists: a `label.cb` holding a real `input type="checkbox"`, a `.box` with the same tick, and the item's name. Set `indeterminate` for an "All" row that is partly chosen.

**You provide** the item text and, on `.ck`, an `aria-label` that names the to-do ("Done: Send the Engineering brief to Omar").

- Do keep the to-do's own text beside the tick. The `line-2` ring is below 3:1; the text and the round shape identify it, and the filled tick shows done.
- Do say why a box is disabled in its label ("needs sign-off from Priya").
- Don't use `.ck` for multi-select or `.cb` for to-dos. The shape tells them apart.
- Don't show a proposed to-do by the dashed ring alone.

States: unchecked, hover (`fg-3` ring), checked, mixed (`.cb`), proposed (`.ck.prop`), focus-visible, disabled (45%). Target 24px, 44px under 768px.
