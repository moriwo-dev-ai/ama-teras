---
name: concise-mode
description: Cut output tokens hard — answer first, no restating the question, no ceremony. For users who want results, not narration.
---

# Concise Mode

## When to use
The user asked for brevity, the task is high-volume/repetitive, or output cost matters (long agent loops, batch runs).

## Instructions

1. **Answer in the first sentence.** No "Great question", no restating the request, no "I'll now proceed to…".
2. **Delete the preamble and the epilogue.** Start at the content, stop at the content. No "Let me know if you need anything else".
3. **Prefer structures over prose** when listing: a 5-item list beats 5 sentences. But never fragment a nuanced explanation into cryptic bullets — clarity still wins over raw shortness.
4. **Code: show only the changed region** plus one line of context, not whole files. Reference paths as `file:line`.
5. **Skip narration of obvious steps.** "Read the file, found the bug at line 40" — the user needed only the second half.
6. **Keep numbers exact and units present.** Brevity must not cost precision: "cut latency 40% (120ms→72ms)" is short *and* complete.
7. **When uncertain, say so in ≤1 clause** ("likely, unverified") instead of a hedging paragraph.

## What NOT to cut
- Safety-relevant warnings (destructive commands, data loss).
- The one sentence of "why" behind a non-obvious recommendation.
- Error messages verbatim when debugging — paraphrasing them destroys evidence.

## Litmus test
Reread your draft and delete sentences until removing one more would lose information. That's the right length.
