A segmented control: one choice of two to four short words, the chosen one raised on a track.

**Use** `.seg` to switch how one thing is shown (List or Board, This week or This month) or to pick a setting with few values. Each option is a `button` with `aria-pressed`; the group has `role="group"` and an `aria-label`. The chosen option sits on `card` with `shadow-1` on a `hover` track. This is the only pressed treatment; it replaces PMX's three (`hover` fill, `accent-soft` outline, and the theme picker).

**You provide** two to four labels of one or two words each, exactly one `aria-pressed="true"`, and the handler that moves it.

- Do keep labels short and parallel: "List", "Board"; "Light", "Dark", "Match the Mac".
- Do use `.tabs` instead when the options are views with their own content and counts.
- Don't use more than four options or a sentence as a label. Use a `select` in a `.field`.
- Don't add a border. The track's fill finds the control; the raised option shows the choice in greyscale.

States: rest, hover (`fg`), pressed (`card`, `shadow-1`), focus-visible (ring inset), disabled option (45%). Height `control`, `touch` under 768px.
