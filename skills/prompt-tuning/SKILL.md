---
description: Iterate on a prompt, or on anything whose quality is measured by non-deterministic model output, without chasing noise. A noise baseline before the first edit, medians over repeated runs, enforcement AFTER generation rather than in the wording, and detectors that surface candidates rather than defects.
---

# Prompt tuning — working with non-deterministic output

> Every rule here has a measured cost behind it. The first one alone accounts
> for three tuning rounds spent moving a number that had never moved.

## Measure before you change anything

**1. Take a noise baseline BEFORE the first edit.** Same prompt, same inputs,
at least two runs; record the spread of every metric you care about. A delta
smaller than the spread is noise, not the effect of your change. To compare
two versions, run each at least three times per input and compare **medians**.

Measured: ±20% output length and a jumping paragraph count **with no change
to the prompt at all**. Three rounds of tuning were spent chasing that before
anyone ran the same prompt twice.

**2. Measure conversion factors between representations; never assume them.**
One initiative assumed a 1.15× expansion between two languages and measured
1.3–1.4×. The assumption would have invalidated the entire budget built on
it. When a factor's spread is wider than your target band, no source-side
budget can guarantee the target — catch the tail with a gate **after** the
transformation instead of tightening the budget before it.

**3. After three failed rewordings of the same defect on the same case, name
it a KNOWN LIMITATION** and hand it to a human. A fourth blind iteration is
chasing noise with extra steps.

## Writing the prompt

**4. Every numeric example becomes a quota; every template phrase becomes a
verbatim anchor.** Describe the CRITERION, not the illustration. "Two threads
means two paragraphs" produced two-paragraph output in six samples out of
six, where an example of a two-paragraph answer had not. State criteria in
**both directions** — a one-sided formulation works only in the direction you
named.

**5. A rule in a prompt is a request. Enforcement is a mechanism that runs
AFTER generation** — a gate plus regeneration with a targeted nudge.
Confirmed on four separate properties: length ceiling, presence of figures,
language of a recommendation, and post-translation condensation.

Put a safety catch on the source side: when the source genuinely lacks the
property you are demanding, do not demand it. A gate that requires figures
from a source containing none is an instruction to fabricate.

**6. Volume minimums are SOFT (log them), ceilings are hard.** Regenerating
because output was "too short" produces padding, reliably.

**7. The target quoted to the model sits below the threshold the gate
enforces.** A sample two characters over the ceiling cost two paid
regenerations. Both numbers come from ONE constants module — every hand-copy
of a constant into a script, a prompt, a test or a message to the model is a
future lie, and it will be discovered by the number that did not get updated.

## Building the gate

**8. On fail-open, return the BEST candidate — not the last one, and not the
current one.** Rank by *weighted* severity: regulatory beats content beats
length, ties broken by length. Counting violations without weights is a fake
ranking, and it has a predictable failure: text with no figures is shorter,
so it wins. The accepted sample must be exactly what reaches the payload
**and** the cache; watch for "last one wins" when steps are written, or you
poison the cache with a candidate you rejected.

**9. Measure the gate's own cost before wiring it in.** A regex reading a
whole source was a hot path at 835 ms; fixing its quantifiers took it to
0.2 ms. Add a performance test with a threshold, or the next one will not be
noticed either.

**10. A prompt in a database plus code with placeholders forces a deployment
ORDER**: the code that supplies the variables ships first, the prompt second.
Add a version guard so the gate is inert until the prompt reaches the version
that feeds it, and log any placeholder the build did not supply.

## Judging output, and detectors

**11. A detector finds CANDIDATES, not defects.** Especially across languages
or formats. Confront every hit with the source before reporting it, or you
will report your own regex's shortcomings as the product's. Three false
alarms were avoided exactly this way. Choose the direction of the check with
the lower false-positive background: for translations, look for *invented*
content rather than *lost* content.

**12. Judge against the SOURCE, not against world knowledge.** "Correcting" a
fact to match what you know is a grounding violation, not a fix. One
fabrication charge collapsed when the source turned out to use the disputed
name 63 times.

**13. Audit samples with the strongest tier available.** A cheap tier
produced false negatives and demanded content the prompt explicitly forbade.
And remember the audit is itself non-deterministic: a borderline rejection is
a signal for a HUMAN auditor, not a trigger for another prompt iteration.

**14. Sweep for residue by CLASS, not by known spellings.** Search for the
value — the old ceiling `35` — not for the wording of a label. Check also
whether a test is PINNING an incorrect label into place. Pin a reviewer's
counterexamples as MUST-PASS tests: one such test caught a fix that was only
half done, before it came back around.
