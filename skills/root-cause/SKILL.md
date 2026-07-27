---
description: Find the mechanism behind a failure instead of patching its symptom. Reproduce first, change one variable per experiment with the prediction written before the run, bisect rather than re-read, and exit by naming the mechanism and pinning it with a failing test. Use for a bug, an unexplained red test, or a failure that will not reproduce.
---

# Root cause — working a failure down to its mechanism

> This is the situation the conductor is told to spend its most expensive
> reasoning on: a diagnosis, a failure nobody can reproduce, two agents who
> disagree. Spending more thinking on an undisciplined search just produces a
> more confident wrong answer, so here is the discipline.

## Reproduce first. Everything else is downstream of this

**A fix for a bug you cannot reproduce is a guess with a diff attached.** You
cannot tell whether it worked, and neither can the reviewer — the bug's absence
after the change is indistinguishable from the bug's absence before it.

Get to the smallest reliable reproduction you can, and write down the exact
command, input and environment. If it reproduces only sometimes, capture the
rate — "3 of 20 runs" is a fact you can measure against later, "it is flaky" is
not. If it will not reproduce at all, that is now the task: what does the
failing environment have that yours does not — version, data, timezone,
concurrency, permissions, a warm cache?

## Read the whole error

The first line names where it surfaced, not where it went wrong. Read the full
stack, the frames from your own code in particular, and everything logged in the
seconds before. The answer is stated outright more often than anyone expects,
which is why "I read the error" and "I read the first line of the error" have to
be different sentences.

## One variable, and write the prediction first

Change ONE thing per experiment, and **write down what you expect to happen
before you run it.** An experiment whose outcome you did not predict teaches
almost nothing: whatever comes back, it confirms something you already believed.
A prediction that turns out wrong is the single most informative event available
to you, and you only get it by committing first.

Two changes at once and you have learned nothing about either.

## Halve the surface

Do not re-read the code hoping to spot it. **Bisect.**

- Over time: `git bisect` against a command that exits non-zero on the failure.
  A scriptable check turns an afternoon into a few minutes.
- Over the input: cut it in half, keep the half that still fails, repeat.
- Over the system: disable, stub or bypass half the pipeline. Where does the
  value stop being correct? Instrument at the boundary between two components
  before you go inside either.

## It is your code before it is the library

The base rate favours the code changed most recently by the fewest people —
yours. Suspect the dependency only after the evidence points there, and then
**read the installed version's source**, not your memory of the API and not the
documentation for a version you might not have. `node_modules` is on disk; the
answer is a `grep` away, and a remembered signature has already sent people
down a day of the wrong road.

## When three hypotheses have died

The wrong assumption is one you have not written down. Stop testing and list
what you believe is true about the system — which file is loaded, which branch
is running, which build is deployed, which database you are pointed at, that the
change you made is even in the process you are running. Then test the cheapest
item on that list.

Almost every long debugging session ends here: something everyone was certain
of was not true. `prompt-tuning` has the sibling rule for non-deterministic
work — after three failed attempts at the same defect, name it a known
limitation and hand it to a person rather than taking a fourth blind swing.

## Exiting

1. **Name the MECHANISM, not the symptom.** "The cache key omits the locale, so
   the second request serves the first request's body" is a root cause. "The
   page showed the wrong language" is the symptom you started with.
2. **Pin it with a failing test before the fix.** Written after the fix, a test
   only proves the code's current behaviour; written before, it proves the bug
   existed and is gone. This is also what the reviewer will ask for.
3. **Check for siblings.** The same mechanism usually has other victims —
   another cache key, another unhandled path. Find them now, while you
   understand it.
4. **Report the mechanism, the evidence, the fix and the blast radius**, plus
   the hypotheses you killed. Those save the next person from re-running your
   dead ends, and they are the part everyone omits.
