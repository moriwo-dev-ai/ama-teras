---
name: pdf-extract
description: Get reliable text, tables, and structure out of PDFs — tool choice by PDF type, extraction verification, and when to fall back to OCR.
---

# PDF Extract

## When to use
Any task consuming PDF content: summarizing reports, pulling tables into data, searching contracts, splitting/merging documents.

## Instructions

1. **Diagnose the PDF type first** — it decides everything:
   - Extract a sample page's text. Real sentences? → *digital* PDF (text layer exists).
   - Garbage/empty output but visible content? → *scanned* (images) → OCR path.
   - Mixed documents exist; check a few pages, not one.
2. **Digital PDFs (JS/TS environment):** `pdfjs-dist` for text+positions, or a CLI like `pdftotext -layout` (poppler) when available. Python: `pypdf` for text/split/merge, `pdfplumber` when you need coordinates.
3. **Tables need position-aware tools.** Plain text extraction shreds columns. Use pdfplumber (Python) or pdfjs text items grouped by y-coordinate; reconstruct rows by clustering y positions, columns by x gaps. Always eyeball 2–3 reconstructed rows against the rendered page.
4. **Scanned PDFs:** rasterize pages (e.g. 300 DPI), then OCR (tesseract). OCR output is *probabilistic* — treat numbers as suspect; if the task involves totals, cross-check sums.
5. **Verify extraction before use** (non-negotiable):
   - Page count matches expectations; no silently skipped pages.
   - Spot-check: pick a distinctive phrase visible in the PDF and confirm it appears in the extraction.
   - Character coverage: high ratio of replacement chars (�) or mojibake means a font/encoding problem — try another extractor before "fixing" the text.
6. **Preserve provenance.** When quoting or aggregating, carry page numbers with every extracted fact; downstream users will need to verify against the source.
7. **Writing/assembling PDFs:** generate HTML/Markdown and print-to-PDF (headless browser) for reports; use pypdf/pdf-lib for page-level ops (merge, split, rotate, stamp). Don't hand-build PDF syntax.

## Pitfalls
- Trusting layout order = reading order (multi-column pages extract interleaved; use position data).
- OCRing a digital PDF (slow, lossy) because step 1 was skipped.
- Extracting once and never spot-checking — silent truncation at some page is common.
