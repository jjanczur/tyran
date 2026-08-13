# Self-improvement — how Tyran learns your repo

`agents/retro.md` · `skills/retro/SKILL.md` ·
`hooks/scripts/retro-gate.mjs`

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
| **AUTO** | knowledge facts, rule tweaks, `.tyran/config.yaml`, new repo-specific skills (written to the [`skill-writing`](../skills/skill-writing/SKILL.md) standard, including its activation test) | retro commits autonomously; ledger entry; `git revert` rolls back |
| **GATED** | new/changed hooks, agent overrides, budgets, deleting safety rules | retro proposes, you approve |
| **KERNEL** | the enforcement hooks, the rollback mechanism, this classification itself | humans only, by hand |

The classification is a file in your repo (`.tyran/policies/autonomy.yaml`)
and is enforced by a `PreToolUse` hook on write paths — the boundary does not
depend on the model behaving.

`.tyran/config.yaml` is AUTO **and it holds the deployment class**, which is
the one place that table trades safety for usability on purpose. It was GATED
until a real install showed what GATED costs there: setup had inferred
`pnpm test`, which in that repo is bare `vitest` — watch mode, never exits —
and the agent that discovered every future agent would hang could not repair
the file that said so. If that trade is wrong for your repo, set the rule back
to `GATED` (see [`policy-gate`](policy-gate.md), which also measured the same
escalation happening *under* GATED wherever `Write` is allow-listed).

Note where the line falls for skills: writing one is AUTO, and raising the
**description budget** to make room for it is GATED. That is deliberate. The
budget is the number behind the claim that this plugin stays small, and a
ceiling a retrospective could lift whenever it was inconvenient would measure
nothing at all.

Every AUTO entry carries `confidence` and usage/helpfulness counters; entries
that stop earning their keep get degraded or retired by later retros. Two
learning loops run at different speeds: fast and local (your repo), slow and
curated (pull requests to the core — reviewed by humans).

The counters are fed by a closed loop rather than by promises. Every handoff
carries a **knowledge brief** — `scripts/knowledge.mjs brief` selects the
entries whose `applies_to` globs intersect the story's predicted files, into
a character budget — and the agent's final report owes a verdict on the entry
ids it received: helped, wrong, or unused. The retrospective folds those
verdicts into `used`/`helpful`/`outdated_reports` at close, in the one place
licensed to write the store. An entry nobody reports as helpful is a
retirement candidate on evidence, not on taste.

## The one part that is not built: the update delta-review

> **Not built yet.** Everything above runs today. What does not exist is the
> **delta-review** that runs after `/plugin update`: the step that compares a
> new core version against what your repo has already learned and proposes the
> reconciliation ("the core absorbed a rule you learned locally — delete the
> local duplicate"). Until it ships, a core update leaves your `.tyran/` data
> and your local skills untouched — which is safe, and is also why a rule can
> end up stated twice after an update. Reconciling it is a manual read of the
> [changelog](../CHANGELOG.md) against `.tyran/knowledge/`.
