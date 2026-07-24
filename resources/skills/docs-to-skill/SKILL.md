---
name: docs-to-skill
description: Distill a documentation site, README, or codebase into a reusable skill — extraction workflow from raw docs to a tested SKILL.md.
---

# Docs to Skill

## When to use
A library/tool has docs the agent keeps re-reading (or misremembering), and you want a compact, always-loaded-on-demand skill instead.

## Instructions

1. **Define the consumer task first.** "Use library X to do Y" — the skill serves that task, not the whole manual. One skill per task family.
2. **Harvest with intent.** From the docs, extract only:
   - Setup that differs from the obvious (`init` flags, env vars, version constraints)
   - The 5–10 API calls that cover 90% of the task
   - Non-obvious semantics (what's async, what mutates, what silently no-ops)
   - Error messages and their actual causes (docs' troubleshooting + issue tracker)
   - Version pitfalls ("since v3, X replaced Y")
3. **Verify before writing.** Run the extracted examples against the current version. Docs drift; your skill must not inherit the drift. Anything you couldn't run, mark `(unverified)`.
4. **Compress into the skill shape:** frontmatter, When to use, a minimal working example (complete and runnable, not fragments), the API table, pitfalls. Target ≤120 lines; link/point to the source docs for the long tail.
5. **Anchor versions.** State the library version the skill was verified against at the top; a skill that silently assumes an old API is worse than no skill.
6. **Retest quarterly or on major-version news** — re-run the example, update the pitfalls section with anything new the community hit.

## Pitfalls
- Copying doc prose wholesale — you want the *deltas from intuition*, not the tutorial. (Also: respect licenses; summarize in your own words.)
- Skipping the "run the examples" step; unverified skills confidently reproduce dead APIs.
- One mega-skill per library. Split by task (auth / queries / migrations), or nobody finds anything.
