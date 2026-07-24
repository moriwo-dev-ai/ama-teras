---
name: session-memory
description: Persist what matters across agent sessions — what to save, what to skip, and how to recall without polluting context.
---

# Session Memory

## When to use
Long-running projects with repeated sessions; recurring user corrections ("I told you last time…"); any environment quirk that took >10 minutes to figure out.

## Instructions

1. **Save facts, not transcripts.** One memory = one atomic, durable fact with the *why* attached. "Deploys need `--legacy-peer-deps` because of the pinned React 17" — not a log of the session that discovered it.
2. **Worth saving:**
   - User preferences and corrections (style, tone, review strictness) — with the trigger context
   - Environment quirks (paths, ports, flags, broken defaults) that cost real time
   - Decisions and their rationale ("chose X over Y because…") so they aren't re-litigated
   - Project state that code/git doesn't record (external accounts, pending approvals)
3. **Not worth saving:** anything derivable from the repo (structure, history, configs), one-off task details, secrets (never — memory files get synced/committed).
4. **Format for recall:** an index file (one line per memory: title + hook) that loads every session, pointing to per-fact files. The index is a menu, not a meal — keep bodies out of it.
5. **Recall discipline:** memories are point-in-time observations. Before acting on one that names a file/flag/version, verify it still holds. Stale memory asserted confidently is worse than no memory.
6. **Maintain on write:** before adding, search for an existing memory it duplicates or contradicts — update or delete rather than accumulate. Date entries; convert "yesterday/next week" to absolute dates at write time.
7. **Review monthly** (or when the index exceeds ~30 lines): merge near-duplicates, delete anything the project has outgrown.

## Pitfalls
- Saving so much that recall becomes noise — memory quality is measured at read time, not write time.
- Recording *what* without *why*; future sessions will "fix" the workaround.
- Trusting memory over the current codebase when they disagree — the codebase wins, then update the memory.
