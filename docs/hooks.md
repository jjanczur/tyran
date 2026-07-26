# Hook runtime reference

> **Status:** shipped — `hooks/scripts/hook-io.mjs`.
> Read this before writing a gate. The platform's default failure mode is to
> **let the action through**, so most of the ways a gate can be wrong end in
> it silently not existing.

Two files, two jobs:

| file | job |
|---|---|
| [`hooks/scripts/hook-io.mjs`](../hooks/scripts/hook-io.mjs) | the runtime every hook runs inside |
| [`hooks/HOOK-CONTRACT-MEASURED.md`](../hooks/HOOK-CONTRACT-MEASURED.md) | what the platform actually does, read out of the shipped binary |

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
  all, and nothing anywhere reports it.

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
  the deadline table. A gate that reads journals must bound its input first.
- Sanitization asks `scanText` from `scan-control-chars.mjs` which codepoints
  are forbidden rather than keeping its own copy of the rule, so the set the
  CI scanner enforces and the set a gate escapes cannot drift apart. When the
  scanner's list grows — as it did with the TAG block in ADR-19's first
  correction — the runtime inherits it with no edit.

## The secrets gate, and exactly where it stops

`hooks/scripts/secrets-gate.mjs` is registered on `PreToolUse` / `Bash`. It is
the one control here whose failure is irreversible: a key pushed to a public
repository is burned when it is published, and deleting the commit afterwards
does not unburn it. Everything about it — including the parts that look
paranoid — comes from that.

### What it checks, and why it is placed where it is

A `PreToolUse` hook sees the state **before** the command runs, so it can only
check content that already exists. That decides the architecture:

| the command | what is scanned | effective? |
|---|---|---|
| `git commit` | the staged index | yes — the early warning |
| `git push`, `gh pr create`, `gh release create`, `gh repo create` | every local commit not reachable from any remote | yes — **this is the real boundary** |
| `git am`, `git apply`, `git cherry-pick`, `git rebase`, a commit made through the GitHub API, a commit made before the gate was installed | nothing, at that moment | no — and it does not need to be |

The last row is the point rather than the gap. Content arriving from a patch
or another branch does not exist in a scannable form when the gate runs, so
the gate does not pretend to check it; it is caught at the **push**, because
publication is the irreversible act and every path converges there.

The command line itself is scanned as data too, through the same ruleset.
Without that, `git commit -m "<key>"` puts a secret in history without it ever
being a staged file — a hole shaped exactly like a commit message.

### What it refuses without scanning anything

`--no-verify` (and `-n` on `commit`, which is the same flag), a `core.hooksPath`
override, `--force` on a push (`--force-with-lease` and `--force-if-includes`
are fine and the refusal explains why the difference is not stylistic), and
`kill -9`. Each of these is a way of switching a control off rather than a way
of doing work, and each refusal carries the thing to do instead — a refusal
with no way forward produces an agent that looks for a way around it.

### What it does NOT catch — the declared boundary

This section is the honest half, and it is pinned by tests (`DECLARED_MISSES`
in `tests/unit/hook-secrets-gate.test.mjs`) so it cannot quietly become a lie.
Recognising "this is a commit" from a shell command is a denylist on hostile
input and is **structurally incapable of being complete** (ADR-19 correction
1): an enumeration moves the hole, it does not close it.

- **Aliases and wrappers.** `gc -m x`, an aliased `g`, `bash ./release.sh`,
  `make deploy`. The gate never sees the alias table or the script's contents.
- **A subcommand assembled at run time.** `c=commit; git $c -m x`,
  `git $(printf commit) -m x`. The gate does not expand anything, on purpose —
  that is what keeps hostile input out of a shell.
- **Any tool that is not `Bash`.** A git MCP server exposing `git_commit`, or
  a future tool that commits directly, is not covered. `Write` and `Edit` are
  deliberately not gated: they put content in the working tree, and the
  working tree is not published — the index and the push are, and both are
  checked whichever tool wrote the file.
- **Exfiltration that never touches git.** `curl -d @.env`, `gh gist create`,
  printing a key into the transcript. Those are a different control's job.
- **The scanner's own false negatives, which are not small.** Measured on
  gitleaks 8.30.1: of 60 randomly generated, correctly formatted AWS access
  key IDs written as `AWS_ACCESS_KEY_ID=<key>`, **24 were reported clean**; in
  the `aws_key = "<key>"` shape, 5 of 60 were still missed. A private-key
  block was detected 10 times out of 10. This gate is exactly as good as the
  ruleset it delegates to, and that ruleset misses things.

So: **this gate is not a guarantee that a secret cannot be committed.** It is
a mechanical check that catches the ordinary case at the point where the
damage becomes permanent. A control advertised as unbypassable would be a
false guarantee, and a false guarantee is worse than a stated limit because
people stop looking.

### False alarms, measured rather than asserted

A gate that blocks legitimate work gets switched off, and then it protects
nothing. Measured on 7168 real `Bash` commands from this project's own
transcripts:

| outcome | count | share |
|---|---|---|
| no scan, no cost | 6815 | 95.1% |
| a scan is triggered (34 ms staged, 187 ms for a 133-commit range) | 352 | 4.9% |
| refused by an unconditional rule | 1 | 0.014% — and it was a **true** positive, a real `git commit --no-verify` |
| refused because a directory was named through a variable | 14 | 0.20% of all commands, 4.0% of the ones that trigger |

On content: over the full history of a 2151-commit repository, gitleaks flags
30 commits (1.4%). Over this repository's own 52 commits it flags none.

The remedy for a false positive is the scanner's own: record the finding's
fingerprint in `.gitleaksignore`, or agree a baseline at
`.gitleaks-baseline.json` (or point `TYRAN_GITLEAKS_BASELINE` at one). Working
around the gate is not on the list.

### Costs that are deliberate

- **No gitleaks means no commit.** A missing scanner is a refusal with install
  instructions, not a warning. A check that passes when its dependency is gone
  is a check you disable by uninstalling a package.
- **The push scan is bounded to `--all --not --remotes`.** Measured: scanning
  the full history of a 2151-commit repository takes 18.8 s, which is past
  every hook budget — an unbounded scan is a gate that always times out, and a
  gate that always refuses is switched off within a day.
- **A scan that overruns refuses and does not read its partial report.** A
  killed scan can leave a well-formed empty report on disk, and "nothing
  found" must never be confusable with "never looked".

## Testing a hook

`tests/unit/hook-io.test.mjs` is the model. The half that matters is the set
of tests that break the runtime on purpose — thrown handler, exceeded
deadline, corrupt JSON, missing dependency, failed stdout write — and assert
that the result is a **refusal, not silence**. Per ADR-20, a guard is finished
only once you have shown it red by removing the mechanism it defends.
