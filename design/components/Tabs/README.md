Tabs: views of one thing, the current one marked by an underline.

**Use** `.tabs` above a panel when the same object has several views (Sections, Changes, Who sees what). The container has `role="tablist"` and an `aria-label`; each tab is a `button role="tab"` with `aria-selected` and `aria-controls`. The selected tab takes `fg` and a 2px `fg` underline over the `line` rule. A long row scrolls inside the tab list, never the page.

**You provide** the tab names in sentence case, an optional count in `.n` (set in `fg-3`, 12px), the panel with `role="tabpanel"`, and the keyboard: arrow keys move between tabs, only the selected tab has `tabindex="0"`.

- Do give a count only where the number helps the decision ("Changes 2"). Leave it off when it would always be there.
- Don't mark a tab with a dot or a colour. If a view needs attention, say so in the panel's answer line.
- Don't use tabs to choose a setting or a display mode. That is `.seg`.
- Don't disable a tab without saying why in the panel or nearby text.

States: rest (`fg-2`), hover (`fg`), selected (underline), focus-visible (ring inset), disabled (45%). Height `control`, `touch` under 768px.
