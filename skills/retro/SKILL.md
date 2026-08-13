---
description: Close an initiative by learning from it. Spawns the retrospective agent over the ledger, the notes and the agents reports, records what it changed and what it rejected, and writes durable facts about this repo into .tyran/knowledge/. Runs automatically at the end of an initiative; also available as /tyran:retro.
---

# Retro

The only loop through which Tyran gets better at *this* repo instead of
repeating the same mistake every initiative.

**You normally do not have to invoke this.** The `Stop` gate refuses one turn
when an initiative has all its tickets merged and no retrospective recorded
since the last merge. This skill is what you run when it does — or when you
want one early.

## 1. Spawn the retrospector

Spawn `tyran:retro` at the tier `node "${CLAUDE_PLUGIN_ROOT}/scripts/tiers.mjs"
--role retro` resolves, over the initiative's `PLAN.md`, `NOTES.md`, the
agents' reports, and the initiative's git log.

Do not do this work yourself in the conducting session. The retrospector's
value comes from reading the record cold; a conductor reviewing its own
initiative rates its own decisions, and rates them well.

## 2. Record the outcome — including "nothing"

Every retro ends with a journal entry, whatever it concluded:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/journal.mjs" append "$J" retro.entry "$INIT" \
  --actor retro --data '{"kind":"skill","target":"skills/run/SKILL.md","confidence":"medium"}'
```

`kind` is `skill`, `agent`, `script`, `doc`, `knowledge` — or **`skipped`**
with the reason, when the judgement is that this initiative has nothing worth
changing. That is a correct outcome and it settles the gate exactly like any
other. A retro that always finds something is not learning, it is padding.

**When `kind` is `skill`, follow `skill-writing`.** New skills are AUTO class —
you may commit one without asking — and that is only safe against a standard.
It carries the admission test (a skill nothing already points at is a library
entry), the description budget you are spending on every future session, and
the activation test that proves the thing fires at all. A skill that never
triggers costs its description on every turn and returns nothing.

## 3. Write down what is true about THIS repo

Durable facts go to `.tyran/knowledge/<topic>.yaml`, which is AUTO class —
the retrospector may write it without asking:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/schema.mjs" validate knowledge .tyran/knowledge/<topic>.yaml
```

An entry is a fact, convention, gotcha, command or decision, with a
confidence, its provenance, and the paths it applies to. The counters
(`used`, `helpful`, `outdated_reports`) exist so a later retrospective can
retire an entry that stopped earning its keep — knowledge that only ever
grows is a context tax with a good story attached.

**Fold the counters from the agents' reports.** Every handoff carried a
knowledge brief with entry ids, and every report owes a verdict on them.
Increment `used` for each id that was handed off, `helpful` for the ids
reported as having helped, `outdated_reports` for the ids reported wrong —
here, at close, in the one place licensed to write these files. Keep entries
under the size `doctor --state` warns about (`knowledge-entry-oversized`,
4 000 codepoints); an oversized entry crowds every brief it matches.

Write what a competent newcomer would get wrong, not what the code already
says. "The test suite takes 9 minutes, so do not run it per file" is worth an
entry. "This is a Next.js app" is not: the next agent can see that.

## 4. Fold what BROKE into `MISTAKES.md`, and promote what recurred

`.tyran/knowledge/` holds what an agent should know before touching a path;
`MISTAKES.md` at the repo root holds what has gone wrong here and **how often**.
Not two spellings of one store: the first is delivered into every handoff by
the knowledge brief, the second is the evidence that decides what deserves
delivering at all.

One entry per breakage this initiative genuinely paid for — a wasted agent
cycle, a bad merge, a rework wave. Not per discovery, and not per `finding`
event: most findings are good news.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistakes.mjs" add \
  --signature worktree-missing-deps \
  --what '...' --cause '...' --consequence '...' --prevention '...' \
  --initiative "$INIT" --actor impl-t3 --proof F-12
```

**The signature is the judgement, and the one part a script cannot do.** Reuse
the signature an earlier entry already used for the same failure; a
near-synonym resets the count to one and the lesson never graduates. Search the
file before you invent one. Then let the counting be mechanical:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/mistakes.mjs" repeats --threshold 3
```

- **Three open entries under one signature** — write the rule into
  `.tyran/knowledge/<topic>.yaml` with
  `provenance: [{source: MISTAKES.md, reference: '<sig> x3'}]`, scope it with
  `applies_to` so it reaches only the agents it helps, then
  `mistakes.mjs promote --signature <sig> --status knowledge:<id>`. Grep
  `.tyran/knowledge/` for the signature first: an entry already carrying it
  means this was promoted before and the status trailers were hand-edited away.
- **Five open-or-promoted — it kept happening after the knowledge entry
  shipped.** That is evidence the delivered rule was not enough, which is the
  strongest case for law there is. Write it:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/mistakes.mjs" promote --signature <sig> \
    --law --rule 'One imperative sentence.' --journal "$J" --init "$INIT"
  ```

  That edits the host `CLAUDE.md` between `<!-- tyran:rules start -->` and
  `<!-- tyran:rules end -->` and no byte outside it, appends a `decision` event
  naming the rule, the signature and the count, and refuses below five
  occurrences or on a fence it cannot parse. `--dry-run` prints the line and
  writes nothing. You do not wait for an approval: the operator meets the
  change in the journal, the board and the diff, and says no by deleting the
  line — a deleted rule does not come back.

Promotion never deletes an entry; it rewrites one status token. The entry is
the evidence that earned the rule. Nothing to add is a correct outcome here
too, and a common one: most initiatives break nothing that recurs.

## 5. Report

Five lines: candidates considered, implemented, rejected and why, what was
deleted or merged, what is left for next time. Rejections are as valuable as
changes — they stop the next retrospective relitigating the same idea.
