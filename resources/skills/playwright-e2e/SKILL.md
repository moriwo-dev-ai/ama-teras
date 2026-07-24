---
name: playwright-e2e
description: Write reliable Playwright end-to-end tests — auto-waiting locators, isolated tests, and flake-resistant patterns.
---

# Playwright E2E

## When to use
Writing automated browser tests (E2E/integration) for a web app, or fixing flaky ones.

## Instructions

1. **Structure:** one spec file per user flow. Each test independent — its own context/page, no ordering assumptions, no shared mutable fixtures. `test.describe` groups a flow; `beforeEach` sets a clean state (seed via API, not via UI clicks).
2. **Locators, in order of preference:**
   ```ts
   page.getByRole('button', { name: 'Save' })   // best: semantics
   page.getByLabel('Email')                      // forms
   page.getByText('Welcome back')                // visible copy
   page.getByTestId('row-42')                    // last resort, add to source
   ```
   Never chain positional CSS (`.list div:nth-child(3) span`).
3. **Trust auto-waiting.** `await expect(locator).toBeVisible()` retries until timeout — so remove every `waitForTimeout`. If you feel you need a sleep, you're waiting for the wrong condition; find the observable one (URL change, request finished, element state).
4. **Assert outcomes, not implementation:** URL after redirect, toast text, row count, disabled state. Use web-first assertions (`toHaveText`, `toHaveURL`, `toBeEnabled`) — they retry; bare `expect(x).toBe(y)` doesn't.
5. **Network control:** stub third-party/nondeterministic calls with `page.route()`; let your own backend run for real in E2E. Wait on responses with `page.waitForResponse` keyed by URL+status when an assertion depends on data arriving.
6. **Auth once, reuse:** log in via API or a setup project, save `storageState`, and start tests already authenticated. Logging in through the UI in every test is slow and multiplies flake.
7. **Debugging flakes:** run with `--trace on` and open the trace viewer; check for races (assertion before navigation settles), animation overlap (disable CSS animations in test config), and test cross-talk (run the failing test alone vs in suite).
8. **CI hygiene:** retries ≤ 1 (retries hide real bugs), workers sized to backend capacity, artifacts (trace/screenshot/video) kept on failure only.

## Pitfalls
- `first()`/`nth()` to dodge ambiguous locators — make the locator unambiguous instead.
- Asserting on text that comes from a clock or random data; freeze time / seed data.
