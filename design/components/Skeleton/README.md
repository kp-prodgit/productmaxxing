The shape of what is loading, drawn where it will appear.

**Use** `.skel` shapes in place of rows, cards and figures while their content loads and the wait is longer than a moment. For a wait on a person or the Mac, say who has the move instead; a skeleton means only that the content is on its way.

**You provide** the real heading of the place, then shapes in the layout of the content: `.skel.line` for a line of `t-body` text, `.skel.line.sm` for a meta line, `.mid` and `.short` for shorter lines, `.skel.dot` for a leading icon, `.skel.ctl` for a button, and bare `.skel` for a block. Mark the region `aria-busy="true"`, hide the shapes with `aria-hidden="true"`, and add an `.sr-only` status that says what is loading.

- Do keep the heading real; only the content is missing.
- Do match the shapes to the row and card heights, so nothing jumps when content arrives.
- Don't show a skeleton for less than about 300ms. Show nothing instead.
- Don't use it for an empty state. Empty is `.empty`.

States: loading, with a slow shimmer on `hover` that stops under reduced motion and leaves a still `hover` fill.
