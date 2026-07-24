---
name: plan-interview
description: Interrogate a plan before executing it — surface hidden assumptions, missing constraints, and untested risks by asking the hard questions first.
---

# Plan Interview

## When to use
Before committing to any plan that will take more than a few minutes to execute, or whenever the user presents a plan/spec and asks "does this look right?".

## Instructions

Interview the plan (or its author) with these question groups. Write the answers down; unanswered questions are risks, not details.

1. **Goal integrity**
   - What does "done" look like, concretely? Who checks it, and how?
   - If this plan succeeds perfectly, what problem still remains?
2. **Hidden assumptions**
   - What must already be true for step 1 to work (auth, data present, service up, versions)?
   - Which steps assume something another step produces? What if it produces something slightly different?
3. **Failure modes**
   - Which single step, if it fails, wastes the most prior work? Can it run earlier?
   - What is irreversible here? What is the undo for each destructive step?
4. **Scope pressure**
   - What is deliberately out of scope? Say it out loud so it doesn't creep back in.
   - Which step is really three steps wearing a coat?
5. **Evidence**
   - For each claim in the plan ("X is fast", "Y is unused"), is there a measurement or citation? Mark bare claims as TO-VERIFY.

## Output format
Produce a short verdict: `PROCEED` / `PROCEED WITH CHANGES` / `STOP`, followed by the list of changed steps and the open questions that must be answered by a human.

## Pitfalls
- Interviewing forever — cap at one round of questions, then decide.
- Softening the questions to be polite. The plan's feelings don't matter; production does.
