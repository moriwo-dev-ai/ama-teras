---
name: frontend-design
description: Build interfaces with a committed visual direction — deliberate type, color, and spacing systems instead of the generic "AI default" look.
---

# Frontend Design

## When to use
Creating or restyling any user-facing page, component, landing page, or app shell.

## Instructions

1. **Commit to one direction before writing code.** Write three lines: subject ("what world does this UI live in?"), mood (2–3 adjectives), and the single boldest visual move you'll make. Every later choice must serve these lines.
2. **Type system first.** Pick two faces max (display + body), define a scale (e.g. 12/14/16/20/28/40) and stick to it. Body text 60–75 characters per line. Headings get `text-wrap: balance`; all-caps labels get letter-spacing.
3. **Color as a system, not per-element.** Define tokens: 1 accent, 2–4 neutrals *biased toward the accent's hue*, semantic colors (success/warn/danger) separate from the accent. Never introduce a color at the call site that isn't a token.
4. **Space on a grid.** One spacing scale (4/8/12/16/24/32/48). Sibling gaps via flex/grid `gap`, not stacked margins.
5. **Avoid the default look** unless explicitly requested: cream background + serif + terracotta; near-black + single neon accent; purple-to-blue gradient hero; emoji as section bullets; everything center-aligned; rounded-xl on every box. If your draft resembles these, revise the weakest part.
6. **States are design too.** Hover, focus (visible!), disabled, empty, loading, error — design them at the same time as the happy path, in both light and dark themes.
7. **Motion: one orchestrated moment** (page load or key transition) beats ten scattered hovers. Respect `prefers-reduced-motion`.
8. **Ship-check:** no horizontal page scroll (wide content scrolls in its own container), touch targets ≥ 40px, contrast ≥ 4.5:1 for body text, keyboard path works.

## Pitfalls
- Adding a second accent color "just for this button" — that's how systems die.
- Polishing the hero while the empty state is unstyled; users meet the empty state first.
