A flow diagram: where something goes, station by station, and who acts at each, read left to right.

**Use** it to explain how a PMX product works, or to show one thing in flight. For a release moving through its groups, use `.track`.

**You provide** a `figure.flow-fig` with a `figcaption` (the answer in `b`, one line in `span`) and an `ol.flow` of at most seven `li.station`. Each holds a `.node` with a `.place` (icon and where, in words), a title in `b` and one line in `small`. Give each station one place: `.at-mac`, `.at-claude`, `.at-linear`, `.at-repo`, `.at-reader` (the audience) or `.at-you` (a person deciding: a gate). Optional: `p.flow-note` after the node for the unhappy path; `li.lane` with a `.lane-name` and an inner `ol` to name a run of stations; `.lane.repeat` for stations that run once per group.

- Do title a gate with the decision ("You approve"): key icon for a dialog on the Mac, person icon otherwise.
- Do name the place in words in every station.
- Do keep seven stations to 960px; five fit from 720px. Under 720px it runs downwards.
- Don't add a legend; rewrite the words.
- Don't mark the normal path. Notes are for what goes differently.

**States** per station: none, `.is-done` with a `.stamp` (check and date), `.is-now` with a `.stamp` saying whose move, `.is-later`.
