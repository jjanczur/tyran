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

### If they are not an engineer, ask the ONE question instead

Sales and marketing people run this now. `questions` is written for someone
who knows what an autonomy class is, and four entries shaped `field: source`
is where a non-expert stops. The same scan carries a `plain` object built for
them — **one** question, its evidence in ordinary words, two options at most,
and a `derived` list of what Tyran settled for itself.

Use it whenever the operator has given you any sign they are not an engineer,
and when you are unsure. It costs a fluent reader nothing: everything in
`questions` is still in the config with its provenance, and `plain.evidence`
keeps the raw git sentence for anyone who wants the numbers.

Read `plain.question`, `plain.because`, then the options with
`plain.recommended` marked. Then read the `derived` lines out as decisions,
not as questions — those are the things the repository already answered, and
re-asking them is what makes setup feel like an interrogation. Close with
`plain.note`, which says how the one class Tyran will never infer is actually
reached, and that the dashboard can change all of it later.

The three questions you are NOT asking them are deliberate: the package
manager is a fact, the validation commands are a fact or an honest gap, and
the `CLAUDE.md` line is a paste they can see. A question someone cannot
answer is not a safeguard; it is a place to give up.

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

## 4b. Make the secrets gate satisfiable, and say what it found

The gate refuses every commit and push until `gitleaks` exists. Install it
before anything needs it, rather than letting the first commit fail with a
prerequisite the operator may not be able to meet:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure-gitleaks.mjs"
```

Pinned and checksummed, into `~/.tyran/bin/`; it is a no-op when the machine
already has one, and PATH still wins.

**Then look, before they hit it.** A repository whose history already contains
a secret is common and the gate handles it badly by surprise: nothing is
scanned until someone EDITS the file that holds it, and then every commit
touching that file is refused, permanently, with no hint that the cause is
years old. Run a scan and say plainly what is there.

If there are pre-existing findings, explain the choice in the operator's
words, and do not make it for them:

- a tracked `.gitleaks-baseline.json` tells the gate "these exact findings are
  known" — new secrets are still caught, and because it is tracked the
  suppression appears in a diff instead of being an invisible local file;
- **but a baseline makes the tool quiet, it does not make the key safe.** If
  the repository is public, that key is already burned and the real fix is
  rotating it. Say this once, here, rather than letting them discover it after
  they have relied on the baseline.

## 4c. Turn the dashboard on

Setup is not finished until they have SEEN something. Everything above is
files on disk; the board is where any of it becomes legible, and it was the
one thing installation never actually reached.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" --dir .tyran --serve --write --open
```

`--open` launches their browser; `--write` is what makes the **Settings** tab
able to edit `config.yaml` and the autonomy policy from the page. Tell them
that tab exists and what it covers — profile, autonomy class, tiers,
validation commands, shared zones, overnight limits — because for someone who
would rather not hand-edit YAML in their own repository, that tab is the
entire configuration story and they will not guess it is there.

It holds the terminal while it serves. Say so, and say that Ctrl-C stops it
and the board is still there next time.

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
