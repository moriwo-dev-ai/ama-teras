---
name: theme-factory
description: Produce a coherent, reusable theme (colors + type + spacing tokens) for a site, app, or document set — and apply it consistently everywhere.
---

# Theme Factory

## When to use
The user wants "a look" applied across multiple pages/components/slides, or asks to restyle an existing artifact coherently.

## Instructions

1. **Extract intent.** Ask (or infer from the subject): industry, audience, one emotional keyword ("trustworthy", "playful", "premium"). The theme must be derivable from the answer — if any palette would fit, you haven't decided yet.
2. **Build the token sheet** (this is the deliverable, before any styling):
   ```
   --bg / --surface / --text / --text-muted     (neutrals, hue-biased toward accent)
   --accent / --accent-contrast                  (one accent + its readable pair)
   --ok / --warn / --danger                      (semantic, distinct from accent)
   --font-display / --font-body                  (two faces max)
   --radius / --space-1..6 / --shadow            (one geometry language)
   ```
   Give every token a concrete value and a one-line rationale.
3. **Dark theme is a second palette, not an inversion.** Re-pick neutrals and re-test the accent's contrast on the dark ground.
4. **Apply only through tokens.** When styling, any hardcoded hex/px outside the sheet is a bug — add a token or reuse one.
5. **Prove coherence** with a sample sheet: one heading, body paragraph, button trio (primary/secondary/disabled), one card, one table row — all from tokens. If something looks off here, fix the token, not the sample.
6. **Document usage rules** in 5 lines: where the accent may appear (links, primary buttons, active states — and nowhere else), heading scale mapping, spacing rhythm.

## Pitfalls
- Two accents "because both were nice" — pick one, demote the other to a data-viz-only color.
- Radius/shadow inconsistency: 4px cards next to 16px modals reads as two products.
