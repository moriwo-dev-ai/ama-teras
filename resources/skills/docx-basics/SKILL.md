---
name: docx-basics
description: Read and generate Word documents programmatically — docx as zipped XML, style-preserving edits, and clean generation from Markdown/data.
---

# DOCX Basics

## When to use
Producing reports/letters/specs as .docx deliverables; extracting content from received Word files; batch-editing document sets.

## Instructions

1. **Mental model:** a .docx is a ZIP. `word/document.xml` holds content as paragraphs (`<w:p>`) of runs (`<w:r>`); styles live in `word/styles.xml`; images under `word/media/`. When a library fails you, unzip and read the XML — it's legible.
2. **Reading (text extraction):** use a library (JS: `mammoth` for clean HTML/text; Python: `python-docx` for structure). Mammoth maps styles→semantic HTML, which beats regexing XML. Tables come out as nested lists — verify row/col counts against the original.
3. **Generating from scratch:** author content in Markdown/HTML first (easy to review), then convert (`pandoc md → docx`, or JS `docx` package for programmatic control). For corporate formatting, use `pandoc --reference-doc=template.docx` — you inherit the org's styles instead of imitating them.
4. **Style discipline:** never hand-format (font/size/bold per paragraph). Assign named styles (Heading 1, Body Text, Caption) — that's what makes the document editable by humans afterward and keeps TOC/navigation working.
5. **Editing existing documents:** load-modify-save with python-docx preserves most formatting, but: it can't create every construct it can read; test round-trip fidelity on a copy first. For find-replace across many files, operate on runs (text may be split mid-word across runs — normalize by joining runs in a paragraph before matching).
6. **The traps:**
   - Numbering/bullets live in `numbering.xml` — copying paragraphs without their numbering refs breaks lists.
   - Track changes: extracted text may include deleted (rejected) content; accept/reject revisions before extraction if fidelity matters.
   - Headers/footers are separate XML parts — body-only extraction misses them.
7. **Verify output** by opening the file (or converting to PDF/text) — a docx that Word flags "unreadable content" often still opens; fix the cause, don't ship the warning.

## Pitfalls
- Regexing `document.xml` for content edits (runs split arbitrarily; you'll match half-words).
- Recreating a template's look manually instead of using it as reference-doc.
- Assuming one paragraph = one line of visible text (soft breaks are in-run `<w:br/>`).
