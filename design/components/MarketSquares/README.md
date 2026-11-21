Market size as three nested squares whose areas are to scale, labelled where they sit, beside the three key figures.

**Use** `.b-market` once in the market size chapter, when TAM, SAM and SOM are all known and share a unit. With only one or two values, use `.figs` alone; two squares tell less than two numbers.

**You provide** an inline SVG with `role="img"` and a `title` that states all three values and shares. Draw the total as `.tam` at full size; the other squares sit in its bottom left corner with side = total side × √(value ÷ total), so $610M of $2.4B is 50.4% of the side and $48M is 14.1%. Label each square inside it, value in `.tv` and name in `.tn`, using the on-colour of its ground: `.on-soft` on `.tam`, `.on-accent` on `.sam`. The smallest square is too small to hold text: label it below, on `.on-bg`, joined by a `.tick`. Then `.cap` "Areas are to scale." and three `.fig` with a basis line each.

- Do compute sides from the values. Never draw squares by eye.
- Do say each share in the basis line ("25% of the total").
- Don't add a legend. Every square carries its own name.

States: three values, narrow (figures under the picture).
