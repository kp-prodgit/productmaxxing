A picture that proves a point, with its caption above it: a full-width slot with a hairline border, alone or as a before and after pair.

**Use** `.rp-fig` inside `.rp` when seeing it settles what words would argue: a screen then and now, the market squares, the roadmap board. Use `.pair` to stack two figures, the earlier one first. A figure never splits across sheets.

**You provide** a `figcaption.cap` saying what the picture shows and when, then `.slot` holding any one child: an `img`, or one of our figures (a `.b-market` squares drawing, a `.b-road` board). Add `.wide` for a fixed 16:9 slot; otherwise it takes the child's height. An optional `.note` under the slot gives scale or source. With nothing to show, `.slot.is-empty` says which picture belongs there.

- Do date both halves of a before and after pair in their captions.
- Do say in the empty slot exactly what to capture ("Add a screenshot of the plan view").
- Don't caption below the picture; the reader should know what to look for first.
- Don't use a picture as decoration.

States: holding a figure, empty, before and after pair.
