---
description: Build a UI against a frozen visual reference without drift. An inventory extracted from the reference before any code, a relics list for what exists but should not, and a gate that MEASURES rather than judges - computed styles on a fixture carrying the reference's own data. Use when a mockup, design spec or screenshot is the contract.
---

# Fidelity gate — building against a frozen visual reference

> Drift that goes uncaught on the first screen multiplies onto every screen
> after it. Measured on one initiative that skipped this: four waves of
> rework plus a reconciliation audit, because "looks right" had been accepted
> as a verdict fourteen times.

## The division of labour, which is the whole idea

**Appearance is read by a MACHINE. Intent is described in WORDS.**

Text, typography, colour, geometry and icons are extracted from the
reference *mechanically*. Never let a model retype them into prose: every
restatement is a **lossy copy**, and the source is more precise than any
description of it — `22px/700/#0a2540` has exactly one interpretation, and
"large bold dark-blue heading" has hundreds.

Words describe only what a static reference cannot contain: which content is
an example and which is binding, where the data comes from, visibility
conditions, the empty state, and the states that do not render (hover, focus,
error).

## The overriding rule

**The reference is the only source of visual truth.** Handoffs, tickets and
prose describe BEHAVIOUR; appearance is settled by the reference alone. When
prose disagrees with the reference about how something looks, **the reference
wins**, you decide without asking, and you record the divergence.

- An element **not** in the reference **does not exist**. Relics of older
  code are not carried over without an owner's decision.
- An element **in** the reference **must be built** — if necessary as an
  honest-empty version in the reference's own geometry.

## Step 0 — the reference lives in the repo, verified

Pull it into the repo and check it is whole before trusting it: size, the
file actually ends where it should, and it renders. Work only from the
in-repo copy. An incomplete reference is a STOP and a report, not something
to work around — half a contract silently becomes "use your judgement".

## Step 1 — the inventory, before the first line of code

Extract a machine-readable checklist from the reference. One row per element:

| # | Element | Literal text (with capitalisation) | Typography | Colours | Geometry | Icon | States and conditions |

Hard requirements, each of which has been violated at real cost:

- **Literal text**, including format, capitalisation and separators. A 1px
  rule between two phrases is an element and gets a row.
- **Icons are carried over VERBATIM** — the reference's own markup or asset.
  Substituting an icon library because a glyph "looks the same" is
  forbidden. A similar icon is not that icon.
- **Every surface with a specific colour, and every line with its extent** —
  where it starts and where it stops.
- **Conditional elements carry the condition** in the row.

If the repo has a comparator, it GENERATES the inventory and you only add the
states column. Write it by hand only where no tool exists yet.

The conductor spot-checks five rows against the rendered reference before the
work starts. A wrong inventory produces a confidently wrong screen.

## Step 2 — the diff, when the view already exists

Before writing code, every inventory row gets **MATCHES / DRIFT / MISSING**,
and every element present in the code but absent from the reference goes on a
**RELICS** list with a disposition: remove (the default) or an owner gate when
it is load-bearing.

"Apply the differences" without a list of the differences is forbidden. That
list *is* the plan for the work.

## Step 3 — implement the inventory, and only the inventory

If the reference uses a token, the code uses **that** token. If the reference
defines a token and never uses it, the code does not use it either. A
deviation from the reference is only ever a recorded owner decision, never an
implementer's taste.

## Step 4 — the gate is a MEASUREMENT, not an opinion

1. **A fixture carrying the reference's own data.** Same entity, same period,
   same numbers. Then every difference in a screenshot is a difference of
   appearance, not of content — which is the entire reason this step exists.
2. **Side-by-side captures** at the reference's own widths.
3. **Computed styles dumped to JSON** for the inventory's selectors and
   compared against the inventory's values. A disagreement about whether
   something is 9px or 10.5px is settled by the dump, never by looking.
4. **The verdict is the filled-in checklist**, row by row, attached to the
   report. A narrative verdict — *"looks consistent"*, *"differences are
   data-only"* — is REJECTED without it. This is the single rule that decides
   whether the gate stays a gate.
5. Failures are fixed in the same piece of work. It does not merge with
   failures unless the owner says so.

Three things that turn this gate back into an opinion, all observed:

- **A deliberate skip is not a match.** Every deviation carries a reason and
  lands in an explicit **debt** section of the report.
- **Raising a tolerance until the run goes green** is forbidden. That is
  changing the measurement to fit the answer.
- **A structural selector without a text assertion** silently measures the
  wrong element when the markup is renumbered. Anchor by an explicit
  attribute where you can, and always assert the text — a renumbering must
  produce a loud MISSING, never a quiet wrong reading.

Warm the routes up before a batch run. A cold compile produces failures that
have nothing to do with fidelity, and chasing them costs a round.

## Step 5 — when the data cannot fill the design

- The element **stays**, honest-empty, in the reference's geometry and style.
  Hiding a whole section because data is missing needs an **owner decision** —
  a hidden section is indistinguishable from drift.
- Missing data is a backend item raised in the report. "Pretty" versus raw
  values is also a data question; the front end must not hardcode a mask over
  it without a decision.

## Step 6 — owner acceptance

At the phase gate the owner sees paired captures of full views. The checklist
catches what is measurable; the owner catches the rest. Neither replaces the
other, and offering only one of them is how a gate becomes a formality.
