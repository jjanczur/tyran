<!--
This repository holds its own agents to an evidence contract: a report with
no raw command output is refused by a hook, mechanically, before anyone reads
it. The same standard applies to pull requests, and for the same reason —
"tests pass" is cheaper to write than to earn.
-->

## What changed, and why

<!-- The failure or the gap, then the change. One paragraph is usually right. -->

## Evidence

<!--
Paste the real output, including the exit code. Not a summary of it.

    node --test "tests/**/*.test.mjs"
    # tests N / # pass N / # fail 0
-->

```text

```

## Checklist

- [ ] Full test suite run, output pasted above — the whole suite, not the tests near the change. Regressions arrive through a guard nobody was looking at.
- [ ] A rule that matters became a mechanism (hook, script, schema, test), not a sentence in a document.
- [ ] Both documentation surfaces updated if either was: `docs/*.md` **and** `site/src/content/docs/*.mdx`. They have drifted apart before, silently.
- [ ] No secrets, tokens or internal hostnames in the diff or in the pasted output.
- [ ] Any new numeric claim in prose has something checking it, or is not in prose.
