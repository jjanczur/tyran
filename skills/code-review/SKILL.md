---
description: The depth half of a review - the dimensions a diff is read against (correctness, boundaries, concurrency, failure paths, secrets, data access, structure, test quality) and the rule that a finding is refuted before it is reported. The verdict stays with the reviewer agent. Use when reviewing a diff or a pull request, or when asked about N+1 queries or wasted round trips.
---

# Code review — reading depth

> This is HOW a diff is read. WHAT the verdict looks like belongs to
> `tyran:reviewer` — APPROVE, REVISED or CHANGES-REQUESTED, numbered executable
> counterexamples, a re-review that first checks the previous round's findings
> are pinned as tests, and a section naming what was not checked. Do not
> restate any of that here; two definitions of "reviewed" drift apart, and the
> drift only shows up when they disagree in front of someone.

## Read the diff twice, for different things

**First pass — does it do what the story says?** Against the acceptance
criteria, not against your idea of the feature. A correct implementation of the
wrong thing is the most expensive defect on this list, and it is the one a
dimension sweep never catches.

**Second pass — the sweep below.** Every dimension gets looked at explicitly.
Skipping one is a decision that belongs in the "did not check" section, not a
gap nobody notices.

## The dimensions

- **Correctness at the edges.** Empty, one, many. Zero, negative, overflow. The
  first and last iteration. Null versus absent versus empty-string — three
  different states that most code conflates and most tests exercise as one.
- **Boundaries and shared zones.** Does the change reach outside its story's
  scope? An API shape, a schema, a shared file, a generated artefact, a
  published type. Those are the conductor's to authorise, and a review that
  waves one through has spent authority it does not have.
- **Concurrency and ordering.** Two of these running at once: what is read
  after being written elsewhere, what assumes it is alone, what holds a lock
  and what forgot to release one on the failure path.
- **Failure paths.** Follow every error to where it is handled. An error that
  is caught and logged is not handled; an error swallowed to keep a pipeline
  green is a silent failure with a good story. Check the *partial* failure —
  the write that succeeded before the one that did not.
- **Secrets and untrusted input.** Anything reaching a shell, a query, a path,
  a template or a rendered page. Values from the environment or a fixture that
  look like real credentials. This dimension has a floor: it is reviewed
  properly or the review is not finished.
- **Test quality, not test count.** Does each new test fail when the behaviour
  is broken? Delete a line of the implementation in your head and ask which
  test goes red — if the answer is none, the test asserts nothing. Watch for a
  test that pins the CURRENT output rather than the CORRECT one, which converts
  a bug into a requirement. And watch what the test's OWN inputs are made of:
  a fixture that hand-builds a value another function normally derives (a
  mapper, a parser, a coercion) exercises only the consumer of that value,
  never the step that derives it, and can pin THAT step's defect as correct
  without ever calling it. A three-state flag silently collapsed to two states
  survived two review rounds this way — every guard test hand-built the
  post-coercion object, and the only two tests that called the real producer
  were themselves asserting the coerced, wrong value. Trace at least one test
  through the real producer, not a stand-in for its output.
- **Resource lifecycle.** What is opened, started, spawned or leased, and where
  it is closed — including on the path where an exception is thrown.
- **Data access and wasted work.** Count the round trips one request makes
  and how the count moves with the rows. A query, fetch or RPC inside a loop
  or an awaited per-item `map` is 1 + N; one query over the set (a join, an
  `IN`, a loader) is the shape. Awaits with no data dependency between them
  run together, fan-out bounded — unbounded over a pool or a rate limit, a
  slow request becomes a failed one. The same pure computation over the same
  inputs runs once per request. A cache comes AFTER those, never instead: a
  cache over a query that should not have run is a defect with a warm cache,
  and one the diff adds or touches must say what invalidates it and why the
  TTL is that number — a TTL is the staleness the product agreed to, and a
  number with no reason is the first stale read filed in advance. None of this
  shows in the diff alone: a helper that runs one query is correct where it is
  written and N+1 where a loop calls it, so follow the new call up to the
  request that triggers it. Rank by the path — a query on every page load is
  a finding, a nightly job over twelve rows is a `NOTES.md` line. The finding
  is a count, "N+1 queries for N rows, expected 1": an input and an expected
  result, so it pins as a test against the query log.
- **Structure.** A thousand-line file is built one reasonable addition at a
  time, so the question is about THIS addition: does it give a module a second
  reason to change, or grow the largest file in its area? A new concern is a
  new module, and the simplest change that meets the criteria is the bar — a
  layer, an option or a generic helper introduced for the one caller the story
  has is the opposite failure, not the cure; `deslop` already names it as
  slop. This finding is a location, not a counterexample: the file, the two
  responsibilities it now carries, the seam between them. It is the story's
  finding only when the story made the tangle; a giant the story merely
  touched is a `NOTES.md` debt, and splitting it here is the work nobody asked
  for.
- **The gate itself.** If the change touches a check, ask what that check can
  no longer see. A loosened tolerance, a narrowed selector, a broadened
  try/catch and a skipped test all keep the run green while removing its
  meaning.

## Refute before you report

**Try to kill your own finding first.** Re-read the surrounding code, look for
the guard you may have missed, and where it is cheap, run the case. Report what
survives that attempt.

This is not politeness, it is arithmetic: a review that reports six findings of
which two are wrong costs more than one that reports four, because every wrong
finding is a round trip plus an argument, and it trains the conductor to
discount the other four.

- **A finding you cannot state as an input and an expected result is not
  ready.** That form is what makes it pinnable as a test, and what the
  reviewer's verdict requires.
- **Rank by severity, not by reading order.** Wrong behaviour, then a boundary
  crossed, then a missing test, then everything else. A list in the order you
  happened to notice things makes the reader do the triage you were asked to do.
- **Say plainly when you found nothing.** Manufacturing a finding to look
  thorough is the cheapest way to become ignorable.

## Before you fix N things, ask whether they are one thing

Several findings that all point at the same wrong baseline, the same missing
guard or the same misread contract are ONE finding. Fixing them individually
leaves the cause in place, and the next change re-derives them. Say so
explicitly when it happens — the conductor is deciding how to schedule the
work, and "six issues" and "one cause with six symptoms" are different plans.
