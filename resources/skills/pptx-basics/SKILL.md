---
name: pptx-basics
description: Generate presentation decks programmatically — outline-first workflow, layout/placeholder discipline, and slides people can actually edit afterward.
---

# PPTX Basics

## When to use
Producing .pptx deliverables from content (reports→decks, data→slide sets); batch-updating decks; extracting text from received presentations.

## Instructions

1. **Outline before slides.** Write the full deck as a Markdown outline first (title + bullets + speaker notes per slide) and get it reviewed — content changes cost minutes in Markdown and hours in a generated deck. One idea per slide; if a slide needs a paragraph, it's speaker notes, not slide text.
2. **Use layouts and placeholders, not floating text boxes.** Every generator (python-pptx, JS pptxgenjs) can either fill a layout's placeholders or scatter absolute-positioned boxes. Placeholders inherit the template's fonts/positions and stay editable; floating boxes make a deck nobody can restyle. Pick the layout per slide type (title / title+content / two-content / section header).
3. **Start from the org's template** when one exists (`Presentation('template.pptx')`): you inherit masters, colors, and logo placement. Build slides by adding to it — don't recreate brand styling by hand.
4. **Text discipline:** max ~6 bullets, ~8 words each. Set overflow behavior deliberately (shrink-to-fit is a smell — cut words instead). Speaker notes carry the narration; put them in the notes placeholder, not tiny slide text.
5. **Charts and tables:** prefer native charts (data embedded, recolorable) over pasted images when the library supports the chart type; fall back to generated SVG→PNG at 2x resolution for exotic visuals. Tables: header row styled once via table style, not per-cell.
6. **Images:** compute aspect ratio from the source and set one dimension — stretching to fill a box is the most common generated-deck giveaway. Keep decks light: resize images to display size before embedding (a 10-slide deck should not be 80 MB).
7. **Verify the deck:** open it (or render first/last slides to images) and check: no text overflow, fonts resolved (missing fonts silently substitute), slide count matches outline, notes present. Extracting all text back out and diffing against the outline catches dropped content mechanically.

## Reading decks
Text lives in shape trees per slide; iterate shapes recursively (group shapes nest). Slide order comes from the presentation part, not file order. Notes are separate parts — include them or you miss half the meaning.

## Pitfalls
- Building slides before the content is agreed (the expensive rewrite).
- Absolute-positioning everything — one template change and nothing aligns.
- Hardcoding fonts the target machine lacks; stick to the template's theme fonts.
