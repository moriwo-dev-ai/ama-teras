---
name: skill-creator
description: Turn a repeatable workflow into a well-formed SKILL.md — scoping, structure, and quality checks for writing skills that agents can actually follow.
---

# Skill Creator

## When to use
You (or the user) keep re-explaining the same procedure to an agent, or want to package expertise for reuse across agents that support the SKILL.md standard.

## Instructions

1. **Pick a skill-sized scope.** A good skill is one decision-dense procedure ("how we write commits"), not a whole domain ("programming"). Test: can an agent finish reading it and immediately act differently? If not, split it.
2. **File layout:**
   ```
   <skill-name>/
     SKILL.md          (required)
     templates/…       (optional: files the skill references)
     scripts/…         (optional: runnable helpers)
   ```
   Folder name: lowercase, hyphens, matches frontmatter `name`.
3. **Frontmatter** (this is what agents see before deciding to load the body — write it for the *deciding* moment):
   ```yaml
   ---
   name: skill-name
   description: What it does + when to reach for it, one sentence, concrete trigger words.
   ---
   ```
4. **Body structure that works:**
   - `## When to use` — 2–3 concrete situations (and, if ambiguous, when NOT to).
   - `## Instructions` — numbered, imperative, decision points explicit ("if X, do A; else B"). Include exact commands/formats, not vibes.
   - `## Pitfalls` — the 3–5 mistakes practitioners actually make.
5. **Write from evidence.** Base steps on what actually worked in past sessions; delete any step you can't justify with a failure it prevents.
6. **Keep it under ~150 lines.** Skills load into a busy context; every paragraph must earn its tokens. Move long reference material to bundled files and point to them.
7. **Test the skill:** give it to a fresh agent session with a realistic task and watch where it stumbles — that stumble is your next edit. Repeat until a cold read produces correct behavior.

## Pitfalls
- Descriptions that describe the topic ("About testing") instead of the action ("Write flake-resistant Playwright tests").
- Encoding preferences as laws — mark "we prefer" vs "never do".
- Skills that only work with your directory layout; state assumptions explicitly at the top.
