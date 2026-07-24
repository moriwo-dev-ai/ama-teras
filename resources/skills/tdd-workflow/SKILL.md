---
name: tdd-workflow
description: Plan → spec → failing test → minimal code → refactor. A discipline loop that stops the agent from writing code before it knows what "done" means.
---

# TDD Workflow

## When to use
Any non-trivial implementation task: new features, bug fixes with unclear cause, refactors that must not change behavior.

## Instructions

1. **Restate the goal as observable behavior.** One sentence: "When X happens, the system does Y." If you cannot write this sentence, ask the user or read more code — do not start coding.
2. **Break the goal into atomic steps** that each fit in one commit. Order them so every intermediate state compiles and passes tests.
3. **Write the failing test first.** It must fail for the *right reason* — run it and read the failure message before writing any implementation. A test that fails with "module not found" proves nothing about behavior.
4. **Write the minimal code to pass.** Resist generalizing. If you typed an abstraction the test does not force, delete it.
5. **Run the whole suite**, not just the new test. A green new test with a red suite is a regression, not progress.
6. **Refactor only on green.** Rename, extract, dedupe — then run the suite again.
7. **Commit per atomic step** with a message that states behavior, not mechanics ("reject empty names" not "add if statement").

## Bug-fix variant
Reproduce first: write the test that fails because of the bug, confirm it fails on current code, then fix. A bug fix without a pinning test will regress silently.

## Pitfalls
- Writing 10 tests up front → write one, make it pass, repeat.
- Mocking so much the test only proves the mocks talk to each other.
- "I'll add tests after" — after never comes; the test-first order is the whole point.
