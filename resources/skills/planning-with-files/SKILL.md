---
name: planning-with-files
description: Keep plans and progress in files, not in conversation memory — so work survives crashes, restarts, and context loss.
---

# Planning with Files

## When to use
Multi-step work that spans more than one session, or any task where losing the conversation would lose the plan.

## Instructions

1. **Create `PLAN.md` at the workspace root** before starting. Structure:
   ```markdown
   # Goal
   One sentence, testable.
   # Steps
   - [ ] 1. ...
   - [ ] 2. ...
   # Decisions
   - 2026-01-01: chose X over Y because ...
   # Known issues
   ```
2. **Update the file at every state change** — check off steps, add decisions with dates, record failures under Known issues. The file is the source of truth; the conversation is just commentary.
3. **On resume** (new session, after crash): read `PLAN.md` first, trust it over your memory, and continue from the first unchecked step. Verify the last checked step actually holds (its test passes, its file exists) before moving on — a crash may have happened mid-step.
4. **Record *why*, not just *what*.** "Chose SQLite because no server available" prevents a future session from re-litigating the decision.
5. **Keep it short.** If PLAN.md exceeds ~100 lines, move finished sections to `PLAN-archive.md`. A plan nobody can skim is a plan nobody follows.
6. **Never store secrets** in plan files — they get committed.

## Pitfalls
- Updating the plan only at the end (defeats the crash-safety purpose).
- Two plans (one in the file, one in your head) that drift apart — the file wins, always.
- Deleting failed attempts instead of recording them; the next session will repeat the same failure.
