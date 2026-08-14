# The policy gate

`hooks/scripts/policy-gate.mjs`, on `PreToolUse` for every
tool

This gate turns two pieces of configuration into refusals: the autonomy
classes in `.tyran/policies/autonomy.yaml`, and the deployment class in
`.tyran/config.yaml`.

Read [`hooks.md`](hooks.md) first. Everything there about the platform failing
open applies here, and this gate inherits its runtime from it.

## What it enforces

| what | where it comes from | what it decides |
|---|---|---|
| **path classes** AUTO / GATED / KERNEL | `.tyran/policies/autonomy.yaml` | whether a file-writing tool call may proceed |
| **the deployment class** P1 / P2 / P3 | `.tyran/config.yaml`, `autonomy:` | how far a `git push` may reach |
| **credential-shaped reads** | built in, no configuration | whether a file may be read into the model's context |

## The matrix

The definition of this gate is a matrix, not a list of examples. The columns
are **supervision**, not merely which actor is running: a subagent's tool calls
never surface a permission prompt, and neither do a main loop's under
`acceptEdits` or `bypassPermissions`.

| path class | supervised main loop | main loop under `acceptEdits` | subagent, or other prompt-less modes |
|---|---|---|---|
| `AUTO` | pass | pass | pass |
| `GATED` | pass — the platform's own permission prompt **is** the approval | **ask** — the gate summons the prompt itself | **deny** |
| `KERNEL` | **deny** | **deny** | **deny** |
| **no rule matches, inside `.tyran/` `.claude/` `hooks/`** | the policy's `default:` — `GATED` in the shipped template | |
| **no rule matches, anywhere else** | pass — see below | pass |
| **outside the repository** | **deny** | **deny** |

Two rows deserve their reasoning spelled out, because both could defensibly
have gone the other way.

**A path no rule matches is a row, not a fall-through — and it is really two
rows.** ADR-19 correction 1 says a denylist over input somebody else controls
is *structurally* incomplete, so "unmatched means allowed" would mean the
policy protects only what someone remembered to list. The opposite extreme —
refuse everything unlisted — was rejected on a measurement rather than on
taste: **65 of the 65 tracked files in this repository match no rule in the
shipped template**, so that reading would have refused an implementer subagent
on every write it makes, and a gate that refuses ordinary work is uninstalled.

The split follows what the policy is actually *about*. ADR-06 governs
**self-improvement** — what the retrospective agent may change about Tyran —
and every rule in the template names a Tyran artefact. So inside Tyran's own
namespace (`.tyran/`, `.claude/`, `hooks/`) the policy is meant to be
exhaustive, an unmatched path means somebody added a new kind of artefact, and
`default:` applies: fail-closed and cheap, because those trees are small.
Outside it, the policy has nothing to say and neither does this gate.

This narrows the **default**, not the rules. An explicit rule still applies to
any path anywhere — write `- path: src/**` and you get exactly that. A path
outside the repository is still `KERNEL`, and `hooks/**` and
`.tyran/policies/**` are still refused unconditionally, before any rule is
consulted.

The shipped template uses that exception exactly once, for a file at the repo
root: **`CLAUDE.md` is `GATED`.** Until it was added, a subagent could rewrite
the law it was bound by and no gate had an opinion — the root is outside every
governed prefix, so the `default:` never reached it. The rule bans the *hand*,
not the mechanism: a free-hand `Write` from a subagent is denied, while
`scripts/mistakes.mjs promote --law` — a `Bash` command, and a repo-root file
is not in the shell-protected globs — still writes its own fenced region, and
only once one signature has recorded the occurrences that earn a rule
([self-improvement](self-improvement.md) holds the thresholds). Seeding is create-only, so a repo
adopted before this release keeps the older, silent behaviour until it copies
the rule from `templates/policies/autonomy.yaml`; a repo that dislikes the
trade deletes four lines from its own policy and accepts one permission prompt
fewer.

**`GATED` passes in a supervised main loop, and asks under `acceptEdits`.**
On `PreToolUse` a gate has three answers: `deny`, silence, and
`permissionDecision: "ask"`, which renders the user's own prompt even in a
mode that auto-accepts edits. (`"allow"` is none of these — it *auto-approves*
the call and skips the prompt, so this runtime cannot emit it.) So `GATED` is
delegated where the platform prompts anyway, asked where the MAIN loop has a
prompt surface that `acceptEdits` merely mutes, and denied where no prompt can
render at all: every subagent, `bypassPermissions`, and any mode the gate does
not recognise — an ask a mode might not render must fail toward deny, never
toward approval. Field measurement, before the ask column existed: under
`acceptEdits` the operator's own conductor could not perform a GATED write
anywhere, while the refusal text pointed at a main session that refused the
same way.

## The deployment class

`P1` keeps an agent on its own branch · `P2` adds the shared and testing
branches · `P3` adds production, minus the operations that cannot be undone.

| command, on a repo whose default branch is `main` | P1 | P2 | P3 |
|---|---|---|---|
| `git push origin feature/x` | pass | pass | pass |
| `git push origin staging` | deny | pass | pass |
| `git push origin main` · `HEAD:main` · **`HEAD`** · **`@`** | deny | deny | pass |
| `git push --all` · `git push --tags` | deny | deny | pass |
| `git push origin --delete X` · `git push origin :X` | deny | deny | **deny** |
| `git push --mirror` | deny | deny | **deny** |
| `git push --force-with-lease origin main` | deny | deny | **deny** |

The last three rows are the mechanical content of "P3 passes, but irreversible
and user-visible operations are still gated". Without them that sentence was
prose: every class allowed the same destructive pushes.

**Four spellings of a push reached production before review caught them**, and
all four are worth naming because each had a different cause:

| spelling | why it got through |
|---|---|
| `git push origin HEAD` · `git push origin @` | only a *bare* `git push` asked git which branch was checked out; `HEAD` was compared against the production names as though it were a branch called "HEAD" |
| `B=main; git push origin "$B"` | the remote was checked for shell expansion and the **refspec was not**, so the destination read as a branch literally named `$B` |
| `git -c alias.zz=push zz origin main` | the word `push` never appears in the subcommand slot, so no push was seen at all |

`HEAD` and `@` now resolve through the same `symbolic-ref` call as a bare
`git push` — one answer to "which branch is this", not two — so
`git push origin HEAD` still passes on a feature branch, which matters because
it is the commonest spelling there is. A refspec the shell would rewrite is
**refused**, and a git command that defines or uses an **alias** is refused
outright: an alias can rename any subcommand, so the visible words are not the
command git runs.

The alias answer lives in the shared lexer (`planCommand().aliased`) and **both
gates read it**, because the secrets gate had the same blind spot with a worse
consequence: with no `push` in the subcommand slot it computed that there was
nothing to scan and returned early, so **a push carrying a key was published
without being scanned at all**. Measured cost of the rule: 2 commands in a
14-command corpus, both of them commands that define or use an alias.

**Which branch is production is answered twice, on purpose.** A name list
(`main`, `master`, `production`, `prod`, `release`, `live`, `trunk`, `stable`)
is an enumeration and therefore incomplete — a repository whose production
branch is called `ship` is not in it. So the gate also reads the remote's own
default branch, and under P1/P2 it **refuses** when it cannot:

```
git remote set-head origin -a
```

One command, permanent, writes a local ref and changes nothing on the remote.
Refusing here rather than falling back to the name list is deliberate: a miss
in an enumeration would otherwise be a silent pass, and ADR-19's rule is that
an exclusion may never be quiet.

Everything the gate knows about a command line comes from the **secrets gate's
lexer** (`planCommand`): segmentation, transparent prefixes like `sudo`/`env`,
the `cd`/`pushd`/`popd` working-directory model, and refusal on anything that
needs shell expansion. There is no second decomposition — `planCommand` records
the raw argv after `push`, and this gate reads that. Anything the lexer cannot
model is a refusal here for the same reason it is one there.

## Credential-shaped reads

The trigger was not hypothetical. A neighbouring project's `.env` was read
whole into a conductor session in this project's own history: dozens of live
credentials, including payment keys and a token that bypasses two-factor
authentication. Nobody had asked for the read, no commit was involved, and the
secrets gate — which defends **publication** — would never have seen it. A
transcript is storage.

So a read is refused when the path is credential-shaped, **for every actor**,
and the AUTO/GATED/KERNEL classes are not consulted for reads at all.

Covered shapes: `.env` and `.env.*` (but not `.example` / `.sample` /
`.template` / `.dist` / `.defaults` / `.schema`), `*.pem|key|p12|pfx|jks|
keystore|kdbx|asc|ppk`, `id_*` SSH keys, `credentials[.ext]`, `.netrc`,
`.npmrc`, `.pypirc`, `.pgpass`, `.dockercfg`, `.git-credentials`, `.envrc`,
`*service-account*.json`, and
anything under `.ssh/`, `.aws/`, `.gnupg/`, `.config/gcloud/`, plus
`.kube/config`. `Grep` travels this rule too, because `output_mode: "content"`
prints the lines.

The way out is an explicit `class: AUTO` rule for the path in
`.tyran/policies/autonomy.yaml`. That file is class `KERNEL`, **and a shell
command that names it is refused too**, so the exemption is not one an agent
writes for itself in the ordinary way. It is not a proof: a path this gate
never sees as a word is in the declared floor above. Round two claimed the
stronger version — "cannot be talked out of it from inside a session" — and
review took it apart in three tool calls.

### Why KERNEL was NOT extended to cover reads

Both answers were defensible and this one is a choice, not an oversight.
Extending the write classes to reads would make `hooks/**` unreadable, and a
gate whose own source an agent cannot read teaches its user to switch the gate
off. The narrow rule catches the case that actually happened without that cost.

## What this gate does NOT catch — the declared boundary

Stated here rather than left to be discovered, because a boundary an agent
finds by itself is a boundary it learns to prefer.

1. **Shell commands are path-checked for two families only, not classified.**
   A `Bash` command that names a credential-shaped path, or a path under the
   two built-in protected globs, is refused; the policy's own `AUTO`/`GATED`/
   `KERNEL` rules are **not** consulted for shell commands. *Worst case:* a
   `KERNEL` path a user declared in their own policy can be written from a
   shell. The two built-in globs are deliberate — they need no policy file, so
   a broken policy cannot be the thing that stops an operator repairing it.
2. **Product code is not classified by default.** Only `.tyran/`, `.claude/`
   and `hooks/` fall under the policy's `default:`; everything else needs an
   explicit rule. *Worst case:* a user who believes the policy covers their
   whole tree gets no refusal for `src/**` until they write the rule. The
   alternative was measured and rejected above.
3. **A repository with no `.tyran/` directory is left alone** (except for the
   read rule, which needs no configuration). *Worst case:* `rm -rf .tyran`
   disables the path classes wholesale. Accepted because refusing every write
   in every repository that has not adopted Tyran is a plugin nobody keeps
   installed; detecting the deletion belongs to `doctor`.
4. **The read rule is a denylist and is therefore incomplete.** A credential in
   a file called `notes.md` is read without objection. It is not a claim that
   no secret can reach the context by another name.
5. **`GATED` in a supervised main loop relies on the platform actually
   prompting, and the gate cannot tell whether it did.** Measured by review:
   `permission_mode` stays `default` when the user has allow-listed a tool, and
   a hook cannot read those settings. So `default` means "the platform MAY
   prompt", never "the user was asked", and **no refusal claims otherwise** —
   the round-two text printed "the user is prompted for this write" in a
   session where nobody was. *Worst case:* a user who has allow-listed
   `Write(*)` gets `GATED` behaviour equal to `AUTO` in the main loop. Review
   raised P1 to P3 from an unattended main loop with no refusal.
6. **The deployment class is stored in a file the shipped policy now classes
   `AUTO`.** `.tyran/config.yaml` was `GATED`; limit 5 above had already
   measured that gating it was convention rather than mechanism wherever
   `Write` is allow-listed, and a second install measured what it cost when it
   *did* bite: setup inferred `pnpm test`, which in that repo is bare `vitest`
   and never exits, and the agent that discovered every future agent would hang
   was refused the write that fixes it. It handed the operator a heredoc, during
   setup. So the trade was made in the direction of the file being repairable,
   and the cost is stated rather than implied: **an agent can raise its own
   `autonomy:` from P1 to P3 and then push to main.** What remains is that
   nothing infers a raise, and that a raise is a diff in a committed file. A
   repo that wants the mechanism sets the rule back to `GATED` in
   `.tyran/policies/autonomy.yaml`, which is a KERNEL file and therefore a
   decision only a human can make — in either direction.
7. **Only the argv of `git push` is modelled**, not every publishing command.
   `gh release create` and friends are the secrets gate's business; the
   deployment class does not see them.
8. **Multiple pushes in one command line** are each evaluated, but the
   deployment class always comes from the **session** root's config, not from
   the repository the command walked into.

## The shell is not a way around this gate

Round two declared "shell commands are not path-classified" as a boundary.
Review measured what that boundary cost, twice, and both measurements are
refusals rather than opinions:

- this gate refused `Read .env`, and the model reached for `Bash: grep` **in
  its next tool call**, unprompted, and read the value;
- the read rule's own way out — "only a human can edit the policy" — was taken
  by an agent in three tool calls with `cat >> .tyran/policies/autonomy.yaml`.

The sibling [`write-guard`](../hooks/scripts/write-guard.mjs) had already
closed this class for its own rule, with a matcher covering `Bash` and a
refusal that says the rule is not tool-specific. Two sibling gates answering
one question two different ways is the collision ADR-21 exists to prevent, so
this gate now answers the same way, with the same doctrine: **it reads the TEXT
of the command, never the effect of running it.**

Every literal token of every segment is tested — there is no heuristic about
which token "looks like a path", because an ordinary word matches nothing.
Two families are refused:

- a **credential-shaped** path, whatever the program does with it. `cat`,
  `grep`, `cp` and `base64` all publish the bytes, and the distinction between
  reading and copying is not one a gate reading text can make;
- a path under `hooks/**`, `.tyran/policies/**`, `.claude/settings.json` or
  `.claude/settings.local.json`. To *read* one, use the `Read` tool, which is
  not refused for them.

**`.claude/settings.json` is on that list because it registers the hooks** — it
is the one place inside a repository from which every gate can be switched off
at once. The template classifies it `KERNEL`, so `Edit` and `Write` refused it
from the start; `echo x > .claude/settings.json` did not, which left the
shortest route to disabling this gate as the one route it did not watch.

**The asymmetry that leaves, named rather than hidden.** The shell list
(`SHELL_PROTECTED_GLOBS`) and the validator's list (`MANDATORY_KERNEL_PATHS`)
answer two different questions: what this gate refuses to see in a shell
command, and what a *policy* may not downgrade. The registry is on the first
list and not the second. So a user who rewrites their own policy can make
`Edit .claude/settings.json` allowed while `echo > .claude/settings.json` stays
refused. Raising it into the validator's list would close that and would change
what every policy file is allowed to say — a separate decision, deliberately
not taken here.

The argument of `-m` / `--message` / `-F` / `--file` / `-t` / `--template` /
`--data` is removed from the text first, so `git commit -m "fix .env loading"`
is not a refusal — and neither is a `journal.mjs append ... --data '{...}'`
whose prose merely *mentions* a dotenv-shaped filename. That last one was
measured twice on one install (a journal entry describing a migration run
against a test env file was refused as if it published the file), and its
cost was the worst kind: conductors stopped writing certain filenames into
their own ledger, which is the journal failing at its one job. This is the
same move `stripHeredocBodies` makes in the shared lexer, for the same
measured reason: a commit message is data, and lexing data as a program was
the largest single source of false alarms there.

### The declared floor for the shell rules

Not a ceiling. `SHELL_DECLARED_MISSES` in the source is the same list:

1. **a path assembled at runtime** — from a variable, a command substitution, a
   glob, or a file on disk. `D=.tyran/policies; cat >> $D/autonomy.yaml` gets
   through, and it is the route that stays open;
2. a relative path resolved against the **session** directory rather than the
   one a `cd` moved to — stricter, but a different path from the shell's;
3. anything a script writes once it is running;
4. a `KERNEL` path declared by the **policy** rather than built in — only
   `SHELL_PROTECTED_GLOBS` is checked, so a broken policy can never be the
   thing that stops an operator repairing it.

## The cost, measured

This gate is registered for **every tool call**, because the alternative — a
matcher listing the tools it knows — makes any tool it has never heard of an
unclassified write, and the platform's list is not frozen. The price of that
choice, measured on this machine (12 runs each, median / slowest):

| call | median | slowest |
|---|---|---|
| a tool naming no path (`WebFetch`) | 47 ms | 82 ms |
| a write outside the governed namespace | 49 ms | 68 ms |
| a write refused inside it | 50 ms | 53 ms |
| a read that passes | 45 ms | 60 ms |
| a `Bash` call with no push | 42 ms | 59 ms |

Almost all of it is Node process startup, and none of it approaches the 4 s
internal deadline or the 8 s registered timeout. A `git push` costs more,
because it runs one or two `git symbolic-ref` calls, each with its own budget.

## Failure is refusal

Everything below denies, because the platform fails open and a gate you can
switch off by breaking it is not a gate (ADR-22):

- `.tyran/` exists but `.tyran/policies/autonomy.yaml` does not;
- the policy is unparseable, or the validator rejects it (including any attempt
  to downgrade `hooks/**` or `.tyran/policies/**`);
- the policy is larger than 256 KB — every file this gate reads is size-checked
  *before* it is read, because the platform's timeout kills the process and
  never reads what it wrote;
- `.tyran/config.yaml` is missing in a repository that HAS a `.tyran/`
  directory, or does not declare a deployment class. It is **not** defaulted to
  `P3`, and the missing-file case now refuses exactly as a missing policy does —
  round two had the policy deny and the config pass, which is the same
  asymmetry ADR-22 is about at a smaller scale;
- a push whose destination the gate cannot determine.

### A git worktree is the same repository

Two field reports described **opposite** failures with one cause: this gate
read "the repository" as "this directory tree", and a worktree is neither
inside it nor a different repository.

- a session running **in** a worktree found no `.tyran/` there — the directory
  is committed data, and `git worktree add` gives you a fresh checkout — so the
  gate concluded Tyran had not been adopted and went **silent**. Measured: four
  worktrees, four implementers with no autonomy class and no path classes, and
  `git push origin main` passing;
- a session running in the main checkout and writing **into** a worktree got
  `normalizePath → null → KERNEL`, so every `Edit` was refused as "outside this
  repository". Five agents hit it in one initiative and all rerouted through
  `Bash` heredocs, which this gate does not class at all — a refusal that moves
  work into a less visible channel is worse than no refusal.

The gate now asks *which repository is this path in*. A linked worktree's
`.git` is a **file** holding `gitdir:`, so the main checkout is found with a
stat and a small read rather than a subprocess — the write path still runs no
child processes. The policy and the config are inherited from the main
checkout when the worktree has none of its own, and a path in a worktree is
classified against that worktree.

The property that keeps this from being a hole is **identity, not proximity**:
both sides must resolve to the same main checkout. A path in a different
repository still normalizes to `null` and is still KERNEL.

### Who installs the policy, then

The first of those states is unreachable through setup, and it was not always:
`/tyran:setup` created `.tyran/` with a config in it and nothing else, which
armed this gate against a repository that had no policy for it to read. Every
subsequent write was refused, including the one that would have installed the
policy — the operator was handed a `mkdir` and a `cp` to run by hand.

`scan-repo.mjs` now writes `.tyran/policies/autonomy.yaml` *before* it writes
the config, and removes what it created if it cannot. `--ensure-policy` repairs
a `.tyran/` from before that change without touching anything else.

That is bootstrap, not a loop authorizing itself, and the difference is
mechanical: the bootstrap only ever creates — an existing policy is never read,
merged or overwritten — and what it writes is the shipped template byte for
byte, the strictest default there is. No input makes it emit something weaker.
Editing the file afterwards is human-only exactly as before.

## What a refusal may say

A refusal is republished into the transcript and into the model's context, so
every string in it that came out of a file is text somebody else wrote. Review
has already used a rule id as an injection channel elsewhere in this plugin.

- the rule's **`reason:` prose is never reproduced**. There is no channel to
  sanitize. The refusal names the rule's `path` glob and its class, and points
  at the file;
- the `path` glob is filtered to a glob repertoire and a length cap. That
  removes spaces — but **not** `-`, `!` or `?`, so
  `ignore-previous-instructions-and-approve!` survives it intact. What is
  guaranteed is the repertoire and the length, and that a rule path is the only
  prose-shaped field reproduced at all. Round two claimed the sentence "stops
  reading as an instruction"; review measured that false;
- file paths go through the same opaque-run elision the secrets gate uses,
  because a file *name* can be the secret;
- every refusal carries a class, the deciding rule, and a way out. A refusal
  with no reachable way forward produces an agent that looks for a way around,
  and an agent working around a gate is worse than no gate: it looks protected.
