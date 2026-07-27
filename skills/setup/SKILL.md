---
description: Configure Tyran for this repository. Scans the stack, the validation commands and the git history, writes .tyran/config.yaml with provenance for every inferred value, installs the bare /tyran shortcut, and asks you only about what it genuinely could not establish. Run once per repo.
---

# Setup

Configure Tyran for the repository you are in. One pass, then a short list of
questions — never an interrogation.

## 1. Scan what can be established without asking

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-repo.mjs" --dir . \
  --write .tyran/config.yaml
```

This is deterministic on purpose. It reports the package manager, the
validation commands the repo actually declares, the languages by weight, and
an autonomy class inferred from how the repository is really worked. Every
value carries the fact that produced it and a confidence, so months later
"why does this repo think it is P2" has an answer in the file itself.

**It never infers `P3`.** No arrangement of files is evidence that a person
meant to let an agent merge to main and deploy to production. That is a
decision someone makes in words, and if the operator wants it they will say
so — write it down with the date and their sentence.

## 2. Read what the humans wrote down

Send `tyran:scout` over `README`, `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING`
and the CI config, looking for what the scanner cannot see: commit
conventions, review expectations, deployment rituals, files that must never
be edited by hand, known-flaky tests. Fold the findings into the config's
`shared_zones` and into a short note for the operator.

Verify what it reports before you write it down. A convention stated in a
README that the last fifty commits ignore is not this repo's convention; say
which one you found in the code and which one the document claims.

## 3. Ask only about what is flagged

The scan returns a `questions` array. Those — and only those — go to the
operator, in ONE message, each with the evidence behind it and your
recommendation. Anything not flagged you decide yourself.

Bad: "What is your autonomy class?"
Good: "Only 2 of the last 50 commits on `main` arrived as merges, and there
is a `staging` branch with CI. That looks like P2 — I release to staging on
my own, production stays yours. Confirm, or say P1 and I only ever touch
branches."

## 4. Install the bare `/tyran` shortcut

Plugin skills are namespaced, so the conductor is `/tyran:run`. Most people
would rather type `/tyran`. Offer to write the shim:

```bash
mkdir -p .claude/skills/tyran
cp "${CLAUDE_PLUGIN_ROOT}/templates/project-command/SKILL.md" \
   .claude/skills/tyran/SKILL.md
```

It is a few lines that hand straight over to `tyran:run`, so the playbook
still lives in the plugin and updates keep reaching it. Mention that it lands
in their repo and will show up in their next commit — a file appearing in
someone's working tree unannounced is a bad way to meet a tool.

## 5. Validate and report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/schema.mjs" validate config .tyran/config.yaml
node "${CLAUDE_PLUGIN_ROOT}/scripts/tiers.mjs" --config .tyran/config.yaml
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --hooks
```

Report in five lines: what was detected, what was inferred and from what,
what you asked about, whether the shortcut was installed, and what to run
next. Paste the raw output of the three commands above — the evidence
contract binds you exactly as it binds every agent you will spawn.
