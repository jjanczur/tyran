# Hook runtime reference

> **Status:** shipped — `hooks/scripts/hook-io.mjs` with 45 unit tests.
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
      return looksLikeASecret(command)
        ? { decision: 'deny', reason: `refusing: ${command}` }
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
| the handler blocks the thread and never returns | **no** — nothing on this thread can run; the platform `SIGKILL`s the process and a killed hook produces no output |

The third row has no in-process fix (Node is single-threaded), so it is a rule
for gate authors instead:

> **A gate does no unbounded synchronous work.** Size-check before
> `readFileSync`, prefer async I/O, and give any child process its own
> `timeout`.

If that ever proves insufficient the fix is a hard-killed child process or a
worker-thread watchdog claiming the write through `Atomics`. Both cost real
latency on **every** tool call, and nothing measured so far justifies it.

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

## Testing a hook

`tests/unit/hook-io.test.mjs` is the model. The half that matters is the set
of tests that break the runtime on purpose — thrown handler, exceeded
deadline, corrupt JSON, missing dependency, failed stdout write — and assert
that the result is a **refusal, not silence**. Per ADR-20, a guard is finished
only once you have shown it red by removing the mechanism it defends.
