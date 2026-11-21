A release moving through its groups, in order. Each stop has a name and a line that says where it stands.

**Use** it wherever a release in progress is shown. One track per release. Under 600px it turns into a vertical list.

**You provide** an ordered list of stops. Each has a `.node` (the step number, or the check icon when done), the group's full name in `b`, and one status line in `small`. State classes: `.is-done` (has it, with the date), `.is-now` (the person's move), `.is-held` (waits on someone else or a gate: say who), `.is-bad` (failed: say what), none for later stops. Put the one action for the current stop directly under the track.

- Do write the status line as words a person would say: "Has it · 12 Nov", "Waiting on you", "Claude is sending it", "Needs sign-off from Priya".
- Do keep exactly one `.is-now`.
- Don't leave any stop without a status line. An unlabelled circle is a riddle.
- Don't show more than seven stops; group the rest.
