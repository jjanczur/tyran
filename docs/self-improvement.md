# Self-improvement — how Tyran learns your repo

> **Status:** shipped. `agents/retro.md` carries the curator and its filter,
> `skills/retro/SKILL.md` runs it, and a `Stop` gate
> (`hooks/scripts/retro-gate.mjs`) refuses one turn when an initiative ends
> without a retrospective. Still outstanding: the update delta-review that
> reconciles a new core version with what your repo has learned.

This is Tyran's centerpiece: **you bring the harness, it does the
improving.** The more initiatives you run, the better it fits your repo and
your style.

## The loop

After every closed initiative, the `tyran-retro` agent reads the initiative's
journal, decision ledger, and agent reports — the densest source of signal —
plus the git history of the work itself. Then it may improve **Tyran**
(never your product code):

- distill a repo rule ("full test suite, not just touched files — a
  regression slipped in sideways once"),
- write a repo-specific skill for recurring work,
- tune an agent prompt variant,
- **or delete/weaken one of its own earlier rules** — the loop
  self-corrects downward, too.

## The anti-bloat filter (default answer: change nothing)

Every candidate change must pass all of:

1. **Will it recur** — in another initiative, another domain? One-off
   circumstances don't qualify.
2. **Was the cost real and measured** — a lost agent cycle, a rework wave?
   Hypothetical discomfort doesn't qualify.
3. **Is it already covered** by an existing rule? Then the problem is
   enforcement, not documentation — don't add words to a rule that was
   ignored; build a mechanism or do nothing.
4. **Can it be a one-sentence edit** instead of a new section? Then only
   that is allowed.

Plus the extraction curator (adapted from the best pattern we found in the
wild): *is it non-googleable? specific to THIS repo? earned through real
debugging?* Generic programming knowledge is never extracted.

A retro that changes **nothing** is a correct, common outcome. Rejected
candidates are logged — they protect future retros from re-litigating.

## Guardrails (designed to be enforced, not promised)

| Class | Examples | Who decides |
|---|---|---|
| **AUTO** | knowledge facts, rule tweaks, new repo-specific skills (must pass an activation test) | retro commits autonomously; ledger entry; `git revert` rolls back |
| **GATED** | new/changed hooks, autonomy class, budgets, deleting safety rules | retro proposes, you approve |
| **KERNEL** | the enforcement hooks, the rollback mechanism, this classification itself | humans only, by hand |

The classification is a file in your repo (`.tyran/policies/autonomy.yaml`)
and is enforced by a `PreToolUse` hook on write paths — the boundary does not
depend on the model behaving.

Every AUTO entry carries `confidence` and usage/helpfulness counters; entries
that stop earning their keep get degraded or retired by later retros. Two
learning loops run at different speeds: fast and local (your repo), slow and
curated (pull requests to the core — reviewed by humans).
