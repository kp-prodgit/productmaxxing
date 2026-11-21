A command the person must type in another app: one line saying where, the command in a well, and a Copy button.

**Use** `.cmd` wherever the next step happens outside PMX, in the Claude app or on the Mac. The plain line above says where to type it ("In the Claude app, type:"). The command is a `code` in `t-mono` on a `sunken` well. The Copy button sits at the right of the well on `card`; it is found by its word and fill, not its `line-2` border.

**You provide** the where line, the exact command, and the copy handler. After copying, add `.is-copied` to `.cmd`, change the button's word to "Copied", announce it in a polite `role="status"`, and return to rest after about two seconds.

- Do give each command its own `.cmd`. One command per well, so Copy copies one thing.
- Do say who acts next near it when it matters: "Claude replies here when it is done."
- Don't show a command without the where line. A reader cannot guess which app.
- Don't shorten or wrap the command by hand. The well wraps long commands itself.

States: rest, hover, focus-visible, copied (`ok` word with the check), disabled. Copy is `control-sm`, `touch` under 768px.
