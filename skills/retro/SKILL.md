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

Write what a competent newcomer would get wrong, not what the code already
says. "The test suite takes 9 minutes, so do not run it per file" is worth an
entry. "This is a Next.js app" is not: the next agent can see that.

## 4. Report

Five lines: candidates considered, implemented, rejected and why, what was
deleted or merged, what is left for next time. Rejections are as valuable as
changes — they stop the next retrospective relitigating the same idea.
