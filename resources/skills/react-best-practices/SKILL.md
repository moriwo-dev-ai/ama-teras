---
name: react-best-practices
description: Performance and correctness rules for React/Next.js code — rendering discipline, state placement, effect hygiene, and bundle awareness.
---

# React Best Practices

## When to use
Writing or reviewing React/Next.js components, or diagnosing "why is this page slow / re-rendering / flickering".

## Instructions

### State & rendering
1. **Put state where it's used.** Lift only when two siblings truly share it; global stores are for global facts. Every level a state climbs, a subtree re-renders.
2. **Derive, don't duplicate.** If a value can be computed from props/state, compute it in render (memoize only when measured to matter). Copied state desyncs.
3. **Keys are identity.** Never use array index as key for reorderable/deletable lists — state will stick to the wrong row.
4. **Don't create components inside render.** A component defined in a parent's body remounts (loses state, refetches) every parent render.

### Effects
5. **Effects are for synchronizing with external systems** (subscriptions, DOM, network), not for reacting to state you own. "Set state in an effect when another state changes" is usually a derived value in disguise.
6. **Every effect needs a cleanup story.** Subscriptions unsubscribed, timers cleared, in-flight fetches aborted (AbortController) — or you'll set state on unmounted components.
7. **Empty dependency arrays are a claim**, not a wish. If the linter disagrees, the code is wrong, not the linter.

### Data & bundle (Next.js)
8. Fetch on the server when the data is needed for first paint; client-fetch only user-interaction data.
9. Dynamic-import heavy, below-the-fold, or rarely-used components (`next/dynamic`). Check what a page ships before optimizing what it runs.
10. Use `next/image` for anything above the fold; explicit width/height everywhere to avoid layout shift.

### Review checklist
- Any `useMemo`/`useCallback` without a measured reason? Remove (they cost readability and sometimes memory).
- Any prop drilled ≥3 levels? Consider composition (children) before context.
- Loading/error/empty states present for every async boundary?
