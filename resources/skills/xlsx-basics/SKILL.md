---
name: xlsx-basics
description: Read and build Excel files without corrupting data — type-safe cell reading, formula vs value, date pitfalls, and generating clean multi-sheet workbooks.
---

# XLSX Basics

## When to use
Ingesting spreadsheets as data; producing .xlsx deliverables (reports, exports); auditing formulas someone else's workbook computes.

## Instructions

1. **Reading: decide values-vs-formulas up front.** Every cell has a cached last-computed value and possibly a formula. Data ingestion wants values; auditing wants formulas. Read the one you mean (SheetJS: `cell.v` vs `cell.f`; openpyxl: `data_only=True` vs default) — and know the cached value can be stale if the file was saved without recalculation.
2. **Dates are floats.** Excel stores dates as serial numbers (days since 1900, with a fake Feb 29 1900). Let the library convert (`cellDates: true` / openpyxl does it via number format) and verify one known date round-trips correctly before trusting a column.
3. **Type-check columns on ingest.** A "numeric" column will contain strings ('N/A', ' 1,234 ', a stray note). Coerce explicitly, count coercion failures, and report them — silent NaN propagation ruins aggregates. Same for leading-zero identifiers (ZIP codes): read as text or they become numbers.
4. **Ranges lie.** The "used range" often includes thousands of formatted-but-empty rows. Trim trailing empty rows/cols before processing; iterate until N consecutive empty rows rather than to the declared end.
5. **Generating workbooks:**
   - Data as data: real numbers/dates with *number formats* (`#,##0.00`, `yyyy-mm-dd`), never pre-formatted strings — otherwise recipients can't sum or pivot.
   - One header row, frozen (`freeze panes`), reasonable column widths; a `README`/metadata sheet for provenance (source, generated-at, filters applied).
   - Multi-sheet: one concern per sheet; cross-sheet formulas over duplicated data.
6. **Formulas you write** must use the standard function set the target Excel supports; verify by opening once (or via a recalc-capable lib). A workbook of `#NAME?` errors is worse than static values — when unsure, ship computed values plus a note.
7. **Verify output:** reopen the generated file, check a known aggregate (row count, one sum) against the source data. Corruption and off-by-one header bugs surface here in seconds.

## Pitfalls
- CSV round-trips destroying types (dates, leading zeros) — stay in xlsx when types matter.
- Merged cells: reading returns the value only in the top-left cell; unmerge or handle Nones.
- 1900-vs-1904 date systems when files originate from old Mac Excel (rare; check workbook properties if all dates are off by ~4 years).
