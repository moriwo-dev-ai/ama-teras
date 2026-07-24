---
name: docs-lookup
description: Get version-correct library documentation before writing code — resolve the installed version, read the matching docs, and distrust memorized APIs.
---

# Docs Lookup

## When to use
Using any library you haven't verified in this project; APIs that "should work" but error; anything security- or money-adjacent where a guessed signature is unacceptable.

## Instructions

1. **Resolve the installed version first** — docs without a version are folklore:
   ```
   package.json / lockfile        (JS/TS: the lockfile wins)
   pip show X / uv tree           (Python)
   go.mod, Cargo.toml, gemfiles   (etc.)
   ```
2. **Read docs for that exact version.** Changelogs/release notes between your memorized version and the installed one are the highest-value read: they list precisely what your training-era knowledge gets wrong.
3. **Trust order when sources disagree:**
   installed package's own types/source > official docs for the pinned version > migration guides > blog posts (dated!) > memory.
   The `.d.ts`/source in `node_modules` cannot be out of date for your install — read it for exact signatures.
4. **Verify by execution, not by recognition.** A snippet "looking right" proves nothing; run the smallest possible probe (one call, one import) before building on it.
5. **Search the issue tracker** when behavior contradicts docs — you're rarely the first; the workaround is usually in a closed issue.
6. **Cache what you learned** where the project will find it again (a skill via docs-to-skill, a code comment at the call site for the single-use case): version, the delta that surprised you, the working example.

## Symptoms you skipped this skill
- "Property does not exist on type" on an API you were sure about.
- Deprecation warnings at runtime.
- Two dependencies fighting over a peer version you never checked.

## Pitfalls
- Reading `latest` docs for a project pinned two majors back.
- Trusting a tutorial's version-less snippet over the lockfile.
- Fixing type errors with `any` instead of reading the actual current signature.
