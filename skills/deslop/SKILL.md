---
description: The optimization pass, defined - delete before you add, one smell class per pass, behaviour pinned by a test that ran BEFORE the edit. Lints a SKILL.md and prose by the same instinct. Use for the per-story optimization pass or when code has grown noisy without growing capable.
---

# Deslop — the pass that removes rather than adds

> Every story here owes an optimization pass, and until this file existed the
> pass was whatever the agent felt like that afternoon. This is what one is.

**The default action is deletion.** A pass that ends with more lines than it
started with was a refactor, and a refactor is a different piece of work with a
different risk profile. **"Started with" means the state immediately before
THIS pass, not the branch point** — a story that adds a feature adds lines, and
judging the pass by the whole branch diff condemns it in advance. That number
is then invisible to everyone but you, so make it recomputable: commit the
story's work, then commit the pass separately. Measured: an author counting
honestly from its own uncommitted draft and a reviewer counting from the branch
point produced a blocking CHANGES-REQUESTED and an arbitration, with neither
agent wrong on its own terms. If you cannot delete anything, say so and stop —
that is a complete and respectable outcome.

## The order, and why it is an order

1. **Pin the behaviour BEFORE you touch anything.** Run the relevant tests and
   keep the output. A green run *after* an edit proves nothing on its own: you
   do not know it was green before. If no test covers the area, write the
   narrowest one that does, and it must go red when you break the behaviour on
   purpose — otherwise it is not a net, it is decoration.
2. **One smell class per pass**, verified between passes. Dead code, then
   duplication, then naming and error handling, then tests. Bundling them
   produces a diff nobody can review and a bisect that cannot isolate the
   change that broke something.
3. **Re-read the diff as the reviewer will.** Anything in it that is not the
   smell you set out to remove comes back out.

## What counts as slop

- **Dead code** — unreachable branches, unused exports, stale flags, debugging
  left in place, backwards-compatibility shims for something nothing calls.
  Verify it is unused before deleting; "I could not find a caller" and "there is
  no caller" are different statements and only one of them is a fact.
- **Duplication that has diverged.** Two copies that agree are a cost; two
  copies that quietly disagree are a defect.
- **Pass-through wrappers and single-use helpers.** Indirection that costs a
  jump and buys nothing. **Three similar lines beat a premature abstraction** —
  the abstraction commits you to a shape you have seen once.
- **Defensive handling for states that cannot occur** on a trusted internal
  path. It reads as care and works as camouflage: the `catch` that cannot fire
  today is the one that swallows the real error next year.
- **Casts that exist to silence a type error** rather than to state a truth the
  compiler cannot see.
- **Work nobody asked for** — an improvement, a rename, a docstring, a
  reformat on code the story never touched. It inflates the diff, hides the real
  change, and puts an unreviewed decision in someone else's file.
- **Comments restating the line below them.** Keep the comment that explains
  WHY, delete the one that narrates WHAT.

## What is not slop, and stays

Behaviour. A guard on genuinely untrusted input. A comment carrying a reason.
An abstraction with three real callers. A test that looks redundant but pins a
past bug — check the history before deleting a test; the second time a bug is
fixed, the deleted test is the reason.

**Keep behaviour unchanged unless you are fixing a defect you can name.** If the
pass uncovers a real bug, that is a finding for the report and usually a
separate change, not something to quietly correct inside a cleanup. The same
goes for a slow data path — a query in a loop, awaits that could run together:
that is `code-review`'s data-access dimension, its fix usually adds lines, and
it belongs in the self-review before this pass, not inside it.

## Skill-file mode

The same instinct, applied to a `SKILL.md`. Run it before promoting a skill:

- **Stale lines** — guidance written for a version of the skill that no longer
  exists. Cut it.
- **Bloat** — detail that belongs in the caller, in a reference, or nowhere.
- **Dead sentences** — a line that changes nothing if deleted.
- **Duplication** — the same rule stated in two files, which will drift.
- **Premature stop** — the method ends before the work does: it asks the
  question but never records the answer, cleans but never verifies.
- **Weak anchor** — no single idea the skill turns on.
- **A missing assumption** — the skill does not say what has to be true for it
  to apply. See `skill-writing`.

## Prose mode

For a README, a report, an error message or a commit body:

- **Lead with the outcome.** The first sentence is the line a reader would ask
  for if they said "just tell me".
- **Name the number, the file, the command.** "Faster" is weaker than "40s to
  9s". "Fixed the config bug" is weaker than the path.
- **Cut the filler** — *just*, *simply*, *basically*, *it is worth noting*. If
  a sentence changes nothing when removed, remove it.
- **No dead-end error messages.** Every failure names what happened and what to
  do next.
- Do not achieve brevity by compressing sentences into fragments. Achieve it by
  dropping what the reader does not need.

## The report

Files touched, what class of slop came out of each, the test output from before
and after, the two line counts with the commit range a reviewer can recompute
them from, and one line on what you deliberately left. The last part matters: a
cleanup that silently declined to touch the worst file in the area looks
identical to one that found nothing there.
