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

**It writes two files, and the second one is why this command is not
optional.** Before the config, it installs `.tyran/policies/autonomy.yaml`
from the shipped template. The policy gate is silent in a repository with no
`.tyran/` directory and refuses every write in a repository that has one
without a policy under it — so creating the config alone moves the repo from
"unmanaged" to "refuses everything", including the write that would have
fixed it. Setup did exactly that once, and the session ended with a `mkdir`
and a `cp` handed to the operator.

Installing it is bootstrap, not an agent granting itself permission: it only
ever creates, never overwrites, and what it writes is the strictest template
Tyran ships. Editing that file afterwards is human-only and stays so — the
gate refuses `Write`, `Edit`, and any shell command that names the path.

It also seeds `MISTAKES.md` at the repository root: the durable record of what
has gone wrong here, which `/tyran:retro` appends to at close and reads before
it proposes anything. Create-only like the policy — and deleting it is the
whole opt-out, so a repository that does not want one simply removes it. Say
in your report that it appeared; a file landing in someone's working tree
unannounced is a bad way to meet a tool.

If you find a repository already in the broken state — `.tyran/` present, no
policy — this repairs it without touching anything else:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/scan-repo.mjs" --dir . --ensure-policy
```

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

One flagged question is the `CLAUDE.md` pointer, and it is a question rather
than an edit on purpose. Tyran writes `CLAUDE.md` only inside its own
`tyran:rules` fence, and only through `mistakes.mjs promote --law`, which
demands five recorded occurrences of one signature; this line lives outside
that fence, so it is theirs to paste:

```
Log mistakes in MISTAKES.md (what happened, root cause, prevention).
```

That single line is what makes ordinary sessions — the ones Tyran does not
conduct at all — contribute evidence. Do not write it yourself.

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
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --state --dir .tyran
```

The `--state` run is the one that answers "is this repo actually usable now",
and it is also how you validate the policy. Do **not** reach for
`schema.mjs validate policy .tyran/policies/autonomy.yaml`: the gate refuses
any shell command that names a path under `.tyran/policies/**`, including
that one. `doctor --state` validates the same file and names only `.tyran`.
A `policy-missing` finding there is an **error**, not a note — it means every
write in the repo is being refused.

Report in six lines: what was detected, what was inferred and from what, what
you asked about, that both `.tyran/` files are in place and validate, whether
the shortcut was installed, and what to run next. Paste the raw output of the
commands above — the evidence contract binds you exactly as it binds every
agent you will spawn.

## 6. Tell the operator to commit `.tyran/`, and say why

End by asking for one commit of `.tyran/`. This is not tidiness, and the
reason is the one failure mode of this whole setup that is **silent**:

```bash
git add .tyran
git add MISTAKES.md 2>/dev/null || true   # absent if they took the opt-out
git commit -m "chore: adopt Tyran"
```

Two `git add` calls, not one: `git add` is atomic on an unmatched pathspec, so
naming a deleted `MISTAKES.md` alongside `.tyran` aborts the whole staging and
`&&` then eats the commit — the silent failure this step exists to prevent.

The scan also seeded `.tyran/.gitignore` (excluding `state/*/locks/`), so this
`git add` stays clean: lease files record who holds a resource RIGHT NOW, and a
committed lease conflicts on every parallel merge. Commit the `.gitignore`
with the rest.

`git worktree add` does not carry untracked files. Tyran's parallel model is
worktrees, so an uncommitted `.tyran/` means every worktree the conductor
creates has no config and no policy — and a repo with no `.tyran/` is a repo
the policy gate deliberately says nothing about. The agents running in those
worktrees then have no autonomy class and no path classes at all. Nothing
fails; the boundary is simply not there, in exactly the place the most agents
run. Measured on a real install: four worktrees, four ungated implementers.

Until it is committed there is a second hazard worth naming in your report: an
agent that runs `git add -A` on a story branch sweeps the untracked `.tyran/`
into that branch, and a four-way parallel run ends with four conflicting
copies of the config. Stage explicit paths until this commit exists.

## 7. Offer overnight mode — and say plainly what the operator must do

Overnight mode (https://jjanczur.github.io/tyran/overnight/) pauses autonomous work near the
subscription usage limit and resumes after the window resets. It is OFF by
default because its telemetry is a statusline the plugin cannot install:
`.claude/settings.json` in user scope is the operator's file, and the policy
gate refuses agents writing the in-repo one — so print the snippet with the
plugin path RESOLVED and let the human paste it:

```json
{ "statusLine": { "type": "command",
  "command": "node <resolved-plugin-root>/scripts/statusline.mjs" } }
```

Then show the `limits:` block to enable (`mode: 'pause'` — quoted, bare
`off`/`on` are YAML booleans) and note that `doctor --state` reports
`limit-telemetry-missing` if the pause is configured while the statusline is
not installed. Do not attempt the settings write yourself; the refusal is
the boundary working.
