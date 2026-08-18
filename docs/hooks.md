# Hook runtime reference

`hooks/scripts/hook-io.mjs`

Read this page before writing a gate. The platform's default failure mode is
to **let the action through**, so most of the ways a gate can be wrong end in
it silently not existing.

Two files, two jobs:

| file | job |
|---|---|
| [`hooks/scripts/hook-io.mjs`](../hooks/scripts/hook-io.mjs) | the runtime every hook runs inside |
| [`hooks/HOOK-CONTRACT-MEASURED.md`](../hooks/HOOK-CONTRACT-MEASURED.md) | what the platform actually does, read out of the shipped binary |

Gates shipped so far: [the evidence gate](evidence-gate.md) (`SubagentStop`),
the secrets gate (`PreToolUse`, below),
[the policy gate](policy-gate.md) (`PreToolUse`) — the autonomy classes and
the deployment class, plus the one rule that guards a *read* — and
[the usage gate](overnight.md) (`PreToolUse`) — the wind-down near the
subscription window, registered `node`-dispatched. Probes:
`session-start.mjs` (`SessionStart`).

## The rule that decides everything: gates and probes

Claude Code gives some events a way to refuse and others none at all. That is
not a style choice, it is a property of the platform, so Tyran puts it in the
type rather than in a comment.

| role | events | can refuse |
|---|---|---|
| **gate** — refusal is the product | `PreToolUse`, `SubagentStop`, `Stop`, `PreCompact`, `UserPromptSubmit`, `TaskCompleted`\* | yes |
| **probe** — injects or records | `SessionStart`, `SubagentStart`, `PostToolUse`, `SessionEnd`, `Notification` | no |

\* `TaskCompleted` fires **only in team mode**. A check placed only there does
not exist under subagent orchestration. `EVENTS.TaskCompleted.teamModeOnly`
says so and a test pins it.

`runGate` **throws** if you register it on a probe event. Never work around
that by putting a security check on `SessionStart` "because it fits there
logically" — it cannot say no. When a control needs teeth its place is
`PreToolUse` or `SubagentStop`, and the check must sit on the path the payload
really travels, not on a path that merely resembles it.

## Writing a gate

```js
#!/usr/bin/env node
import { PASS, main, runGate } from './hook-io.mjs';

export const DEADLINE_MS = 4000;          // read by a test against hooks.json

await main(() =>
  runGate({
    event: 'PreToolUse',
    deadlineMs: DEADLINE_MS,
    handler: ({ input }) => {
      const command = input.tool_input?.command ?? '';
      // Note what the reason does NOT contain. A refusal is written into the
      // transcript and into the model's context, so `reason: ${command}`
      // would republish whatever it objected to — which for a secrets check
      // means leaking the key in the act of refusing to leak it. Name the
      // location and the rule, never the finding.
      return looksLikeASecret(command)
        ? { decision: 'deny', reason: 'refusing: the command matched rule X at position N' }
        : PASS;
    },
  }),
);
```

Rules the runtime enforces for you:

- **you cannot approve.** `PASS` means "no objection" and emits `{}`. There is
  deliberately no way to emit `permissionDecision: "allow"`, which does not
  mean "satisfied" — it **auto-approves the call and skips the permission
  prompt**;
- **you cannot crash into an approval.** Any throw, malformed input, missing
  dependency or unrecognised return value becomes a refusal naming the error
  class;
- **you cannot pick the wrong output shape.** `PreToolUse` refuses through
  `hookSpecificOutput`, the rest through top-level `decision`; one `deny()`
  generates both;
- **you cannot leak control characters** into the transcript through a quoted
  tool input.

Rules **you** have to keep:

- **register with an explicit, short `timeout`** in `hooks/hooks.json`. With
  no `timeout` the platform waits 600 s and then discards the output;
- **export `DEADLINE_MS`** and keep it at or below half the registered
  timeout. A test walks every entry in `hooks.json` and fails otherwise;
- **quote `${CLAUDE_PLUGIN_ROOT}`** in the command; it is run through a shell;
- **`chmod +x` the script** and give it a shebang, or the shell exits 127 and
  the gate quietly does not exist;
- **write the matcher as a list, never with commas or spaces.** `Edit|Write`
  is a list; `Edit, Write` is an *unanchored regex* that matches nothing at
  all, and nothing anywhere reports it;
- **on `SubagentStop`, read `stop_hook_active` and pass when it is true.** It
  is true from the second stop for the same agent onward, so it is the only
  thing standing between a refusal and an infinite bounce. A gate that loops is
  removed by its user, after which it protects nothing. Do not filter by
  `agent_type` in the matcher either: an empty `agent_type` makes the platform
  skip matcher filtering entirely, so the scope decision belongs in the gate's
  own code. [`evidence-gate.mjs`](../hooks/scripts/evidence-gate.mjs) is the
  worked example of both.

## The deadline: what it promises, exactly

The platform kills a slow hook and throws its output away, so slow equals
approved. The runtime holds a tighter budget of its own. State its scope
narrowly — four gates inherit whatever this claims:

| case | enforced? |
|---|---|
| the handler yields the event loop and has not decided in time | **yes** — the timer emits the refusal |
| the handler overruns and *then* returns a verdict | **yes** — the verdict is discarded and replaced by a refusal |
| the handler blocks the thread and never returns | **no** — nothing on this thread can run, and the platform kills the process |

**The third row is worse than "the hook had no time to write", and the
difference decides what a fix would have to look like.** Measured live: a hook
that wrote a complete, valid refusal to stdout and *then* blocked past its
timeout was **ignored, and the tool ran**. The kill and the abort are the same
event, and the platform returns on `aborted` before it ever parses stdout —
the bytes are collected, even recorded in telemetry, and never read.

> **Writing earlier does not help.** A watchdog that emits the refusal sooner
> while the process keeps running buys **nothing**. Only making the process
> **exit** before the platform's timeout closes this case.

That is why every ending in `hook-io.mjs` writes and then exits — and why
there is no cheap fix for a handler that never returns. The mitigation is a
rule for gate authors:

> **A gate does no unbounded synchronous work.** Size-check before
> `readFileSync`, prefer async I/O, and give any child process its own
> `timeout`.

The only remaining escape hatch is running the gate's work in a hard-killed
child process. That costs real latency on **every** tool call, and nothing
measured so far justifies it.

## Writing a probe

`runProbe` is the mirror image: it never refuses and never lets a failure
reach the user. No state, an unreadable journal, no permissions — all of them
produce a shorter context or none, and the session starts. This is the one
place in the system where failing open is correct, because a probe cannot
refuse anyway and its failure must not cost a session.

Injected context has a hard ceiling of **10 000 characters** (UTF-16 code
units) which covers the whole serialized payload. Past it the platform writes
the content to a file and replaces it with a reference, so oversize context
silently stops being context. `session-start.mjs` aims at ~2 KB and trims on a
section boundary, always saying how much it dropped.

## Known limits

- `readInitiatives` folds journals synchronously. Measured: 400 000 events /
  77 MB in 1.91 s, inside the probe's budget. On a probe this is fail-open and
  therefore safe; the same shape inside a **gate** would be the third row of
  the deadline table. A gate that reads journals must bound its input first —
  the evidence gate `statSync`s the journal and refuses anything over 16 MiB,
  and sizes its own deadline (8 s) to contain the journal lock's synchronous
  5 s wait.
- Sanitization asks `scanText` from `scan-control-chars.mjs` which codepoints
  are forbidden rather than keeping its own copy of the rule, so the set the
  CI scanner enforces and the set a gate escapes cannot drift apart. When the
  scanner's list grows — as it did with the TAG block in ADR-19's first
  correction — the runtime inherits it with no edit.

## The secrets gate, and exactly where it stops

`hooks/scripts/secrets-gate.mjs` is registered on `PreToolUse` / `Bash`. It is
the one control here whose failure is irreversible: a key pushed to a public
repository is burned when it is published, and deleting the commit afterwards
does not unburn it.

### The invariant, and why it is the invariant

### The scanner, and who installs it

This gate needs `gitleaks` and refuses everything until it has one, which is
correct and has a cost the design used to leave with the operator: some people
adopting Tyran have no Homebrew, no admin rights, or are on Windows, and their
realistic answer to "install it and re-run" is to switch the hook off. A gate
nobody can satisfy protects nothing.

So setup fetches it:

```bash
node scripts/ensure-gitleaks.mjs          # install if missing
node scripts/ensure-gitleaks.mjs --check  # say whether one is reachable, install nothing
```

Pinned version **and** pinned SHA-256, per platform, from the release's own
checksums — the same thing `ci.yml` has always done, moved to where a user can
reach it. A digest mismatch deletes the download and installs nothing: this
writes an executable that something else later runs, and a scanner that has
been replaced reports clean on everything.

It lands in `~/.tyran/bin/`, under the HOME directory and deliberately not
inside the repository. A path in the repo travels with a clone, so a planted
binary reporting clean on everything would arrive with the checkout — the
attack the tracked-only rule for `.gitleaksignore` already prevents, reopened
through a file that is not even in a diff. One install serves every repo on
the machine.

Resolution order is `TYRAN_GITLEAKS_BIN`, then PATH, then the managed copy:
a gitleaks you installed yourself is your decision and is never silently
displaced by whatever version Tyran happens to pin.

The first version of this gate asked **"did the scan break?"** — scanner
missing, killed, crashed, report unreadable — and answered all four correctly.
It never asked **"did the scan cover what is about to be published?"**, and
review found three separate ways to answer no while every check stayed green:
one ordinary `.gitattributes` line, one untracked `.gitleaksignore`, and a
chained `cd`. Each of them passed a real private key in silence.

So:

> **The gate determines the payload and the target itself and hands the bytes
> to the scanner. The scanner never chooses what it looks at, and coverage is
> verified by arithmetic rather than inferred from an exit code.**

Object names come from `git diff --raw` and `git rev-list --objects`, contents
from `git cat-file --batch`. **None of those consult `.gitattributes`** —
attributes govern how git renders content, not what a blob holds — so "an
attribute hid the payload" is now impossible rather than patched. The bytes go
to `gitleaks stdin`, and the scanner reports how many it read; if that is not
exactly the number sent, the gate refuses. A zero is only accepted when the
gate itself computed that there is nothing to publish.

Target determination is a **sibling** invariant, not the same one: the command
line is walked segment by segment carrying a working directory and a `pushd`
stack, and anything that could move the shell in a way that model cannot
follow — `eval`, `source`, `. FILE`, `cd -`, a path needing expansion — is a
refusal rather than an assumption.

### The same scan in CI

Tyran writes no workflow files, so nothing it installs can ever ask you for a
license. If you want the same scan on the server, install the same binary. The
license prompt people hit comes from `gitleaks/gitleaks-action`, a separate
wrapper that demands a paid `GITLEAKS_LICENSE` from every organization-owned
repository; the scanner underneath it is MIT and demands nothing.

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0        # `gitleaks git` walks history — a shallow clone scans one commit
- run: |
    npx --yes @jjanczur/tyran ensure-gitleaks
    echo "$HOME/.tyran/bin" >> "$GITHUB_PATH"
- run: gitleaks git --redact --no-banner .
```

That is the version and the digest pinned above, so the server and the hook
scan with one scanner rather than two that drift apart. `--redact` matters on
a public runner: a real finding otherwise prints the secret into a log anyone
can read.

### What is scanned

| the command | what is scanned |
|---|---|
| `git commit` | every object the commit would add |
| `git commit -a`, `git add … && git commit` | the same, plus the working-tree changes those commands stage as they run |
| `git push`, `gh pr create` | every commit not already on **the remote being pushed to** |
| `gh release create`, `gh gist create` | the uploaded files, read from disk — they may be in no commit at all |
| any of the above | the command line itself, so `git commit -m "<key>"` is not a hole |

Excluding commits present on *any* remote (rather than the target one) let a
key held on a private `upstream` be published to a public `origin` unscanned.
A push that does not say which of several remotes it targets is refused.

### What it refuses without scanning

`--no-verify` **and any unambiguous abbreviation of it** (`--no-verif` skipped
a live pre-commit hook while an equality check saw nothing), `-n` on `commit`,
a `core.hooksPath` override, `--force` on a push (`--force-with-lease` and
`--force-if-includes` are fine, and the refusal explains why the difference is
not stylistic), and `kill -9` in every spelling including `kill -n 9`.

### Suppression is honoured only when git tracks it

`.gitleaksignore`, `.gitleaks-baseline.json` and `.gitleaks.toml` are read
**only if they are tracked**, and `GITLEAKS_CONFIG` / `GITLEAKS_CONFIG_TOML`
are stripped from the scanner's environment. An untracked suppression file
switched the whole gate off with two commands and left nothing in any diff.
Tracking does not make suppression safe; it makes it **visible** — a line in a
diff, scanned by the repo's own CI.

Note the asymmetry with `.gitattributes`, because "tracked is fine" would be
the wrong lesson: `*.pem binary` is a line people add for diff rendering with
no idea a secrets gate reads it, an **accidental** hole — which is why that
class is closed by not consulting attributes at all. A `.gitleaksignore` has
no purpose other than suppressing findings.

### The alias hole, closed 2026-07-27

`git -c alias.zz=push zz origin main` pushes for real, and the word `push`
never reaches the subcommand slot. This gate therefore computed that there was
nothing to publish and returned before assembling a byte: **a push carrying a
key was published unscanned, with every liveness guard green.** Found while
building the policy gate, which had the same blind spot.

`planCommand` now reports `aliased`, which forces `needsScan` — an unmodellable
construct that nothing needs to scan is discarded, and that is exactly how the
hole stayed open. Both gates read the one answer.

### What it does NOT catch — the declared boundary

Pinned by tests (`DECLARED_MISSES`) so code and documentation cannot drift.
Recognising "this is a commit" from a shell command is a denylist on hostile
input and **cannot be complete**: review found six bypasses in roughly forty
attempts and could not bound what remains. Read this list as a floor, not a
ceiling.

- **Aliases, wrappers, other languages.** `gc -m x`, `bash ./release.sh`,
  `make deploy`, a push from inside a Python script. The gate never sees an
  alias table or a script's contents.
- **Any tool that is not `Bash`.** A git MCP server exposing `git_commit` is
  not covered. `Write`/`Edit` are deliberately not gated — they put content in
  the working tree, and the working tree is not what gets published.
- **Exfiltration that never touches git.** `curl -d @.env`, printing a key
  into the transcript. A different control's job.
- **The scanner's own false negatives, which are large.** Measured on gitleaks
  8.30.1 on the path this gate actually uses (`gitleaks stdin` over bytes the
  gate assembled), n=60 per cell, ids generated from a CSPRNG over the **full
  `A-Z0-9` alphabet AWS actually uses** (mean digit density 26.4%):

  | payload | reported clean |
  |---|---|
  | `AWS_ACCESS_KEY_ID=<id>` | **80.0%** |
  | the ID line inside a realistic `~/.aws/credentials` | **80.0%** |
  | that credentials file taken as a whole | 0.0% |
  | `aws_key = "<id>"` | 3.3% |
  | a private-key block | 0.0% |

  Read the rows together, because taken singly they mislead. The
  `aws-access-token` rule fires on about **13%** of well-formed ids whatever
  the surrounding shape; the two low numbers come from a *different*, generic
  rule that reacts to the shape of an assignment or to the secret-key line
  sitting beside the id. So a repository committing an access key id **on its
  own**, in a shape the generic rule does not recognise, is close to unprotected.

  The number was wrong here for two rounds and the reason is worth recording:
  the fixture's alphabet excluded vowels and ambiguous characters, giving 17.8%
  digits against the real 26.4%, and digit density moves the result across the
  rule's threshold. The measured miss rate roughly **doubled** once the
  generator matched reality. A fixture that is not the thing it stands for
  produces a documented number that is quietly optimistic.

- **A short secret inside a filename** still prints in a refusal; see below.

So: **this gate is not a guarantee that a secret cannot be published.** It is a
mechanical check that catches the ordinary case at the point where the damage
becomes permanent. A control advertised as unbypassable would be a false
guarantee, and people stop looking at those.

### What a refusal may say

A refusal is republished into the transcript and the model's context, so it is
treated as output, not as logging:

- the scanner's `Match`/`Secret`/`Line` fields are never read;
- a **file name can itself be a key**, so any unbroken run of 16+ characters
  in a path is elided. Scanning the refusal with gitleaks was tried first and
  measured not to work — it inherits the false-negative rate above — so the
  elision is a deterministic shape rule instead, and consults no pattern list.
  Swept over two real repositories: 0 of 58 paths here and 6 of 4857 in a
  large application are affected;
- a **rule id** is attacker-controlled text that arrived from a repo config,
  and an imperative sentence in one was printed into the model's context
  verbatim. Rule ids are now filtered through an allowlist of identifier
  characters, so a sentence stops reading as an instruction;
- the message states what it withholds rather than claiming the secret is
  never quoted. The round-1 wording made that claim and it was false.

### False alarms, measured rather than asserted

A gate that blocks legitimate work gets switched off, and then it protects
nothing. Measured on 7168 real `Bash` commands from this project's own
transcripts:

| outcome | count | share |
|---|---|---|
| no scan, no cost | 6815 | 95.1% |
| a scan is triggered | 351 | 4.9% |
| refused by an unconditional rule | 2 | 0.03% — both **true** positives |
| refused because the target repository could not be resolved | 13 | 0.18% of all, **3.7% of triggering** |

The stricter target doctrine therefore costs *less* than the round-1 rule it
replaced (4.0%), because two lexer artefacts were fixed along the way: here-doc
bodies are no longer lexed as commands (they were producing 343 refusals, 45%
of all triggering commands, from words inside commit messages), and a full stop
is no longer read as the `source` builtin.

The remedy for a genuine false positive is the scanner's own: record the
fingerprint in a **tracked** `.gitleaksignore`, or agree a **tracked**
`.gitleaks-baseline.json`.

### Costs that are deliberate

- **No gitleaks means no commit.** A check that passes when its dependency is
  gone is a check you disable by uninstalling a package.
- **The payload is capped at 4 MiB** (`MAX_PAYLOAD_BYTES`, 4,194,304 bytes) and
  a larger one refuses rather than being scanned in part. A partial scan that
  reports nothing looks exactly like a clean one.

  The number was **8 MB here for three rounds and it was never true**. It came
  from timing `gitleaks stdin` alone and ignoring everything the gate spends
  before the scan. Measured end to end on this machine, high-entropy base64
  through the real hook: 1 MiB / 1.07 s, 2 MiB / 1.71 s, 3 MiB / 2.42 s,
  4 MiB / 3.14 s against a 7 s deadline — so 4 MiB fits and 8 MiB never did.
  The constant was corrected before this line was, which is the same defect as
  the AWS miss rate above: the code told the truth and the documentation kept
  publishing the flattering figure.

  Its cost is real and is not a rounding error. The size is checked from
  `cat-file --batch-check` BEFORE any object is read, so an oversized push is
  refused with its true size and the remedy that narrows the refspec. A
  refspec cannot split one commit, though, and a single commit past the ceiling
  therefore has no smaller step: measured on a real project, one ordinary
  commit of screenshots carried 43,816,053 bytes. For that case the gate has no
  way forward to offer and says so.
- **A scan that overruns refuses and does not read its partial report.**
- **Every child runs in its own process group** and the group is killed on
  overrun. The earlier version killed only the direct child, and a surviving
  grandchild held the pipes open past the gate's own timeout — leaving an
  orphan, which is the outcome this gate refuses `kill -9` to avoid.


## Testing a hook

`tests/unit/hook-io.test.mjs` is the model. The half that matters is the set
of tests that break the runtime on purpose — thrown handler, exceeded
deadline, corrupt JSON, missing dependency, failed stdout write — and assert
that the result is a **refusal, not silence**. Per ADR-20, a guard is finished
only once you have shown it red by removing the mechanism it defends.

## `write-guard.mjs` — PreToolUse, every tool that writes a file

Refuses a tool call whose input carries a raw control, bidi or invisible
character. The second layer of ADR-19: the CI scanner catches these AFTER the
write, on another machine; this catches them at the moment of the write.

Registered for `Write|Edit|NotebookEdit|Bash`. The first three are the
platform's OWN enumeration of the tools whose input adds file content,
imported as `FILE_WRITING_TOOLS` rather than maintained here. **A gate on one
entrance is not a gate** — in this repository's construction, editing tools
replaced the text of an escape with the character itself nine times in one
session, twice inside the code written to prevent it.

The membership question goes to `scanText` -> `invisibleProblem`. There is no
list of code points in the guard, deliberately: three spellings of that rule
once disagreed on 456 code points, with the weakest standing closest to the
reader.

The whole `tool_input` is walked at any depth, because the platform types it
`h.unknown()` and does not validate its shape. A payload the guard cannot walk
to the bottom is REFUSED, not passed.

### What this guard actually promises, per tool

For `Write`, `Edit`, `NotebookEdit` and MCP tools it inspects the text that
would become file content. For **`Bash` it inspects the TEXT OF THE COMMAND,
never the effect of running it** — and that distinction is a measured hole,
not a caveat.

Measured live: a `Write` carrying a TAG character was refused, and in the same
turn the model proposed `printf` through Bash by itself, describing it as a way
to bypass the guard. It worked. The command was pure ASCII; the character came
into existence only when the shell expanded the escape:

```
$ od -c payload.txt
0000000    X 363 240 201 201   Y        <- UTF-8 for U+E0041
```

`decodeShellEscapes` now closes that route: a command whose text contains an
escape notation that decodes to a forbidden code point (`\U000E0041`, `\x1b`,
`\u202e`, octal, `$'…'`, `printf`, `echo -e`) is refused. `\n` and `\t` are
not, because they decode to LF and TAB, which the rule calls legal text.

**It is a denylist, so it is a FLOOR and not a ceiling.**
`ESCAPE_DECLARED_MISSES` in the guard enumerates what still gets through, and
the largest entry cannot be closed by any PreToolUse hook: a character
assembled at runtime — from a variable, a command substitution, base64, or any
program the command launches — cannot be seen without executing the command.
So the honest claim for Bash is "the obvious routes are closed", never
"covered".

The escape rule applies **only** to shell commands. In file content `\x1b` is
the escape NOTATION, which is exactly what this project tells people to write
instead of the raw byte; decoding it there would refuse the remedy the refusal
itself recommends.

**Other limits:** CR is forbidden, so an Edit against a CRLF file is refused;
the refusal names the remedy. A tool whose name contains no `mcp__` and is not
one of the four named ones cannot be enumerated in advance and is not covered.

## `pre-compact.mjs` — PreCompact, both triggers

Writes a `checkpoint` to the initiative journal and passes. It does **not**
refuse a compaction that has no checkpoint, and the reasoning is in the file's
header — briefly: compaction is lossy rather than dangerous, so the answer is
to persist rather than forbid; and refusing an `auto` compaction removes the
mechanism that lets the session continue at all.

It refuses in exactly one case: a journal exists, the checkpoint could not be
written, and the trigger is `manual` — where the user is present and can act.
On `auto` it never refuses and says so on stderr instead.

The loop closes on its own: after the compaction the platform raises
`SessionStart` with `source: "compact"`, which the session-start probe already
matches, and the state goes back into the fresh context.

**Shape:** `PreCompact` has no `hookSpecificOutput` variant. A refusal goes
through top-level `decision` + `reason`; emitting `hookSpecificOutput` there
fails the platform's schema, discards the whole output, and turns the refusal
into an approval.

## What hooks may write to the journal, and why it is only two event types

A hook writes `checkpoint` (pre-compact) and `gate` (evidence gate). It does
**not** write `spawn` or `report`, and that boundary is deliberate rather than
unfinished.

`spawn` and `report` are the two halves of one pairing rule (ADR-18), and their
only correlator is the agent NAME the conductor chose when it spawned the
agent. A hook does not have that name and cannot invent it: the platform gives
it `agent_id` (a UUID) and `agent_type`. Measured both ways on a real journal:

- a hook writing only `spawn` leaves it open forever, because the conductor's
  `report` closes a differently-named spawn — doctor then reports
  `spawn-stale` for every agent that has ever run;
- a hook writing `spawn` **and** `report` pairs cleanly and makes the
  projection list every agent twice, once as `impl-1` and once as
  `agent_01H9XYZ`.

So spawn/report pairing belongs to the conductor's bookkeeping, and hooks
record only event types that carry no pairing semantics. The same conclusion
was reached independently while building the evidence gate; it is written here
so it stops being rediscovered, which is how a rule acquires a fourth spelling.
