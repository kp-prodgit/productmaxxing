One release in progress: what is being released, where it has reached, and in one sentence whose move it is.

**Use** `.rel` on the studio home and the releases view, one per release in progress. Not for released history (a row is enough).

**You provide** a `header` with the title sentence as `h3` ("Roadmap, edition 2") and a `.sub` line, the `.track` with five stops and real status lines, and `.rel-now` with a `.msg` that starts with who acts in `b`, then exactly one action. Tone the area `.held` when it waits on a person or on another release, `.bad` when something failed.

- Ready: "Your move." and `.btn.pri` "Approve for Engineering" with the Mac icon.
- Approved: the command in `.cmd` (`code` plus Copy as the primary), to type in the Claude app.
- Sending: `.spin` and "Claude is sending it to Engineering's page. This usually takes about a minute." No button.
- Arrived: "Announce to Engineering". Waiting for sign-off: who and since when, plus "Record sign-off". Failed: what failed in plain words, plus "Try again". Blocked: "The company roadmap has to be released first." with a link to it.
- Don't show a second filled button; the screen's one fill is the current move.

**States:** ready, approved, sending, arrived, waiting for sign-off, failed, blocked.
