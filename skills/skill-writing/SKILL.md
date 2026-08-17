---
description: How a skill earns its place here and how it is written so it fires - a three-question admission test, one protocol per skill, the description priced against the CI budget, and an activation test from a cold session. Use when the retrospective proposes a new skill or rewrites one.
---

# Writing a skill for this plugin

> The retrospective may commit a new skill without asking — it is AUTO class.
> That is only safe if there is a standard for what a skill is. This is the
> standard, and the first rule is the one that keeps the library small.

**Every description is loaded into EVERY session, whether the skill fires or
not.** That is the price, it is paid by every user on every turn, and it is the
one cost a skill cannot avoid by being well written. `scripts/desc-budget.mjs`
enforces the ceiling in CI. Read that number before you write anything.

## The admission test — all three, or it is not a skill

1. **Is there a dangling reference?** Does the conductor, an agent or another
   skill already *demand* this protocol without carrying it? A skill nothing
   points at is a library entry, and nobody reads a library.
2. **Was it paid for?** If a competent engineer would find it in five minutes
   of searching, it is documentation. Skills encode what a failure taught:
   decisions, constraints, the trap that is not obvious until it costs a day.
3. **Is it portable and does it belong to us?** No foreign runtime, no path
   from another tool, no agent this repo does not ship, and **no model name** —
   routing has exactly one source, and a test fails the build on a model name
   anywhere in `skills/` or `agents/`.

Failing any one of them is not a reason to write it shorter. It is a reason to
put the content where it belongs: a rule in the caller, a fact in
`.tyran/knowledge/`, or nowhere.

## The rules that follow from the budget

- **Price the description first.** Write it, count it, check the remaining
  budget, and only then write the body. Discovering at the end that the library
  is over budget produces a description trimmed to fit rather than one written
  to trigger.
- **The budget is an owner decision. An agent PROPOSES a raise; it does not
  perform one.** Raising a ceiling because the run went over is changing the
  measurement to fit the answer — the same move `fidelity-gate` forbids when a
  tolerance is loosened until a comparison goes green.
- **A repo's own learned skills stack on top of this budget** in the reader's
  context. The plugin's core stays lean so the user's repo has room to teach it
  something.

## One protocol, nameable in one word

A skill the reader can name — *fidelity*, *evidence*, *deslop* — triggers and
executes in fewer tokens than one that has to be described. If you cannot say
what the skill is about in one word, it is two skills, or none.

Split by *what it decides*, never by *who runs it*. Two skills that both decide
whether a change is good will drift apart, and the drift is invisible until they
disagree in front of a user.

## What goes in the file

- **Frontmatter is `description:` only.** No `name:` — in this repo the
  directory IS the name. (Agents are the opposite: `agents/*.md` need both, and
  the name must match the filename. A test enforces each.)
- **The description says WHEN, not what.** It is read by a model deciding
  whether to open the file, so it carries the trigger conditions, the shape of
  the answer, and the phrases a user would actually type. A description that
  only names the topic never fires.
- **State the assumption the skill rests on.** `retro` needs a closed
  initiative; `fidelity-gate` needs a frozen reference; `prompt-tuning` needs
  the measured quantity to be non-deterministic. A skill whose assumption you
  cannot write down has not been thought through, and the published skills page
  has a column for it that will otherwise be filled with a guess.
- **Never restate a mechanism a hook already enforces.** The evidence contract
  is a gate; a skill repeating it in prose adds context and changes nothing.
  Point at the mechanism instead.
- **Rules carry their reason.** A rule with the failure attached survives
  editing; a bare imperative gets softened by the next person who finds it
  inconvenient. Do not invent the failure — if there is no story, state the
  mechanism that makes the rule true instead.

## Before it ships

1. **Lint it.** Run `deslop` in skill-file mode: stale lines, bloat, dead
   sentences, duplication, a premature stop, a weak anchor.
2. **Activation test — the one people skip.** Start a session that has never
   seen the skill, give it the situation in the user's own words, and check the
   skill fires without being named. A skill that never triggers is pure context
   tax: it costs its description on every turn and returns nothing. If it does
   not fire, the description is wrong — fix that, not the body.
3. **Run the budget gate**, and read the total rather than the exit code.
4. **A rewrite is a CANDIDATE.** When you change an existing skill, it has to
   be better on the cases that made you change it — name them, and check the
   new text against each. Otherwise a skill only ever grows, one correction at
   a time, until nobody reads it.

## Retiring one

A skill that has not fired, or whose protocol moved into a mechanism, is
deleted — not left in place because deleting feels like losing work. The
description budget is a shared resource, and the strongest argument for
admitting the next skill is that the last dead one was removed.
