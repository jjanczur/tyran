# Mistakes

What has gone wrong in this repository, what caused it, and what prevents it
next time. **Newest first.** This file is prose, not a generated artefact —
edit it by hand whenever a root cause here is wrong. Nothing overwrites it.

Every entry has the same five bullets:

    ## <YYYY-MM-DD> — <one line: what broke, in a reader's words>

    - **What happened:** the observable failure, not the diagnosis.
    - **Root cause:** the mechanism. "I forgot" is not a root cause.
    - **Consequence:** what it cost — time, a rework wave, a bad merge.
    - **Prevention:** the rule that would have stopped it, imperative.
    - **Signature:** `kebab-case-slug` · initiative `<slug>` · actor `<who>` · proof `<F-n>` · status `open`

The **signature** is what makes this more than a diary. Three entries under
one signature are evidence that a rule is missing, and the count is what
earns it:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/mistakes.mjs" repeats --threshold 3

Reuse an existing signature rather than inventing a near-synonym — a synonym
resets the count to one and the lesson never graduates.

**Status moves one way and never back.** `open` → `knowledge:<id>` (the rule
now ships in every handoff that touches those paths) → `law` (a rule Tyran
wrote into this repository's `CLAUDE.md`, inside its fence, once the failure
had recurred five times). Promotion never deletes an entry: the entry is the
evidence, and deleting it destroys the count that earned the rule. Disagree
with a promoted rule by deleting its line from the fence; it does not come
back.

If this repository has a `CLAUDE.md`, one line there closes the loop for
sessions that are not conducted by Tyran at all:

    Log mistakes in MISTAKES.md (what happened, root cause, prevention).

<!-- entries below, newest first -->
