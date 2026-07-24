---
name: commit-craft
description: Write commits that explain themselves — atomic scope, behavior-first messages, and clean history that reviewers and future debuggers can actually use.
---

# Commit Craft

## When to use
Every time you commit. Especially before pushing a branch someone else will review or bisect.

## Instructions

1. **One logical change per commit.** If the diff mixes a bug fix with a rename, split it (`git add -p`). Test: can you write the message without the word "and"?
2. **Message format:**
   ```
   <area>: <what changed, as behavior, imperative mood>

   <why it changed — the problem, not the code>
   <anything surprising a reviewer would ask about>
   ```
   - Subject ≤ 72 chars, no trailing period.
   - The body answers "why", the diff already answers "how".
3. **Behavior over mechanics.** "auth: reject expired refresh tokens" beats "add check in validateToken". A message that restates the diff is noise.
4. **Never commit broken states** on shared branches — every commit should build and pass tests, so `git bisect` stays useful.
5. **Reference issues/tickets** at the end of the body (`Fixes #123`), not in the subject.
6. **Before pushing, reread `git log --oneline -10`** as a stranger: does the sequence tell a story? Squash fixup noise ("typo", "oops") locally first.

## Changelog derivation
Good commits make changelogs mechanical: group subjects by area, drop internal-only entries, rewrite the remainder in user-visible terms ("You can now…" / "Fixed a crash when…").

## Pitfalls
- Giant "WIP" commits at day end — commit at each green test instead.
- Messages written for yourself today instead of a debugger in six months.
