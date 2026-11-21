A switch: a setting that is on or off and takes effect at once.

**Use** `.sw` for settings that apply as soon as they change ("Email me when a group has a new edition"). Use a `.cb` when the choice is saved with a form, and a `.seg` when there are more than two values. The track is `fg-3` when off and `accent` when on, with the `knob` sliding right; the knob's position shows the state in greyscale.

**You provide** a `label.swl` that holds the `button.sw` (`role="switch"`, `aria-checked`) and the setting written as what is true when it is on. The label is always present: it names the switch and makes the whole line the target (24px, `touch` under 768px).

- Do write the label as a statement, not a question: "Ask me before anything reaches Sales".
- Do say why when it is disabled, in the label or the line next to it.
- Don't put "On" and "Off" beside it. The label and the knob say it.
- Don't use a switch for an act that needs confirming. That is a button.

States: off (`fg-3`), on (`accent`), hover, focus-visible, disabled (45%). Visual 34 by 20px.
