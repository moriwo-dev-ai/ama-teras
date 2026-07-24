---
name: webapp-testing
description: Verify a web app by actually driving it — real navigation, real clicks, real assertions on rendered state, instead of trusting that "the code looks right".
---

# Webapp Testing

## When to use
After implementing or changing any user-facing web behavior; before claiming "it works"; when a bug report says "clicking X does nothing".

## Instructions

1. **Test the running app, not the source.** Start the dev server, open the real page. Reading code confirms intent; only the browser confirms behavior.
2. **Walk the user's path, not the DOM's.** Script the scenario as a user story: load page → see login → type credentials → land on dashboard. Assert on *visible outcomes* (text, URL, element states), not internal variables.
3. **Selector discipline:** prefer stable semantics — roles, labels, visible text (`role=button[name="Save"]`) — over brittle CSS chains (`div > div:nth-child(3)`). If nothing stable exists, add a `data-testid` to the source.
4. **Wait for conditions, never for time.** `waitFor(element/URL/network-idle)` instead of `sleep(3000)` — timed waits are the #1 source of flakes.
5. **Check the console and network tabs** during the walk: a page can look right while logging errors or 500s. Zero unexpected console errors is part of "passing".
6. **Cover the unhappy paths** that users actually hit: wrong password, empty form submit, double-click on submit, back button after success, refresh mid-flow.
7. **Verify state persistence:** after the action, reload the page. Did the change survive? Many "works" bugs are UI-only state that vanishes on refresh.
8. **Screenshot on failure** and at key checkpoints; a picture of the wrong state beats a stack trace for UI bugs.
9. **Report precisely:** scenario, step where reality diverged, expected vs observed, console/network evidence, screenshot. "It's broken" is not a report.

## Pitfalls
- Testing only in a huge viewport — check a narrow one (mobile) at least once.
- Asserting "no error thrown" instead of "the right thing rendered".
- Leaving the dev server dirty: reset test data between scenarios or they contaminate each other.
