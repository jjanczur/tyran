# Hook I/O contract — measured, not assumed

Every statement here was read out of the shipped Claude Code binary
(**v2.1.116**), not out of documentation. It exists because a gate built on a
guess about the platform is a gate of unknown strength (ADR-22), and because
four of the facts below **contradict** the documented contract in ways that
would each have produced a control that looks installed and cannot refuse.

Re-measure after a platform upgrade. The method: the binary embeds its
JavaScript, so `strings`/byte search finds the hook runner, the output schema
and the matcher predicate directly.

## 1. Failing open is the default, in more places than expected

The action proceeds — and the hook is recorded as a `non_blocking_error` —
when any of these happen:

| what happens | result |
|---|---|
| the hook file is missing or not executable | the command runs under `shell: true`, so **the shell** exits 127 / 126 with empty stdout; that lands in the "non-blocking status code" branch and the **action proceeds** |
| stdout is not JSON at all (does not start with `{`) | treated as plain text, **proceeds** |
| stdout is JSON but fails the output schema | validation error, **proceeds** |
| `hookSpecificOutput.hookEventName` differs from the fired event | the platform **throws while reading our output**, caught, **proceeds** (only when `hookSpecificOutput` is present at all — see §3) |
| the hook is killed at its `timeout` | killed with `SIGKILL`; measured `rc=137`, **stdout empty**, **proceeds** |
| an exception escapes hook *selection* | the selector is wrapped in `try { … } catch { return [] }`, so **every hook for that event disappears** with no transcript entry |

Two corrections to how this was first written, both worth stating because the
wrong mechanism leads to the wrong fix:

- a missing hook file does **not** make `spawn` throw. There is no
  pre-existence check; `shell: true` means the shell reports it. The
  conclusion for ADR-22's open question is unchanged — a deleted hook file
  disables that gate silently, and the answer cannot live inside a hook.
- an **invalid regex in a matcher is not** one of the exceptions that empties
  the selector. It is caught locally inside the matcher predicate, which
  returns `false` and logs at debug level. The gate still disappears, but
  only that one, and for a different reason (§5).

## 2. Exit codes: the documented rule is incomplete

Documented: `0` decides, `2` blocks, anything else fails open.

Measured: **stdout is parsed first, and a valid refusal on stdout is honoured
regardless of the exit code.** The exit code is only consulted when stdout
carried no usable JSON — `2` then becomes a block with stderr as the reason,
and `3`–`255` become a non-blocking error.

Consequence for us: exit 0 plus a JSON refusal is the strongest available
ending, and it is what this runtime always emits.

## 3. The output shape is a discriminated union, and it is narrow

`hookSpecificOutput` is validated as a union keyed on `hookEventName`. There
are variants for `PreToolUse`, `UserPromptSubmit`, `UserPromptExpansion`,
`SessionStart`, `Setup`, `SubagentStart`, `PostToolUse`, `PostToolUseFailure`,
`PermissionDenied`, `Notification`, `PermissionRequest`, `Elicitation`,
`ElicitationResult`, `CwdChanged`, `FileChanged`, `WorktreeCreate`.

There is **no variant for `Stop`, `SubagentStop`, `PreCompact` or
`TaskCompleted`.** Sending one there fails the schema and the whole output is
discarded. Those events refuse through top-level `decision: "block"` +
`reason`. This is why `deny()` has to know the event.

Two refinements measured after the first draft:

- the "wrong `hookEventName` throws" check runs **only if `hookSpecificOutput`
  is present at all**. Top-level `decision` + `reason` is not subject to it,
  so the decision-shaped events are safe from that failure *by construction*,
  not by our carefulness.
- `decision: "block"` on **`SubagentStop` is confirmed live**, not inferred:
  the subagent was stopped and the parent turn resumed with the reason in
  context. This is the event the evidence gate will stand on.

## 4. `permissionDecision: "allow"` is not "no objection"

It sets the permission behaviour to *allow*, i.e. it **auto-approves the tool
call and skips the permission prompt**. A gate emitting it for everything it
did not object to would be quietly approving the whole session. `deny` from
any hook wins over `allow` from another, but that is no comfort when ours is
the only hook.

This runtime has no way to emit it. "No objection" is `{}`.

## 5. Matcher syntax — one predicate for every event

Transcribed in full, including the alias normalisation an earlier draft of
this file dropped. `normalise` is a lookup in the tool-alias table (identity
for anything that is not an aliased tool name), and `aliasesOf` is its
reverse, so a regex matcher is tried against the query *and* against every
name that aliases to it:

```
if (!matcher || matcher === "*") return true;
if (/^[a-zA-Z0-9_|]+$/.test(matcher))
    return matcher.includes("|")
        ? matcher.split("|").map(k => normalise(k.trim())).includes(query)
        : query === normalise(matcher);
try {
    const re = new RegExp(matcher);                 // NOT anchored
    if (re.test(query)) return true;
    for (const alias of aliasesOf(query)) if (re.test(alias)) return true;
    return false;
} catch { return false }
```

Consequences the documented table does not state:

1. **`SessionStart` accepts alternation.** `startup|resume|compact` is a
   single valid entry; three separate entries are unnecessary.
2. The exact-list character class is `[a-zA-Z0-9_|]` — **no spaces, hyphens
   or commas.** Anything containing them silently becomes a *regex*, and that
   produces **two opposite failure modes**, not one. Measured:

   | matcher | query | result | |
   |---|---|---|---|
   | `tyran-implementer` | `evil-tyran-implementer-nope` | `true` | matches **too much** — regexes are unanchored |
   | `Edit, Write` | `Write` | `false` | matches **nothing at all** |
   | `Edit, Write` | `Edit` | `false` | matches **nothing at all** |
   | `Edit\|Write` | `Write` | `true` | the list syntax, which is what was meant |
   | `[unclosed` | anything | `false` | invalid regex, caught locally |

   The second mode is the dangerous one and it is the one that looks
   harmless: a comma-and-space list is valid JSON, reads like a list, appears
   in the manifest, validates — and **never fires**. A gate that silently
   matches nothing is indistinguishable from a gate that is installed.
3. An invalid regex matches **nothing** and only writes a debug line. It does
   not disable other hooks; the failure is local to that matcher. A typo
   removes exactly one gate, invisibly.

## 5a. Which events actually fire, and when

- **`TaskCompleted` fires only in TEAM mode.** The platform raises it for the
  in-progress tasks of the current teammate. Under plain subagent
  orchestration it never fires, so a check placed only there is an **absent**
  control, not a weak one. `hook-io.mjs` marks it `teamModeOnly: true` in
  `EVENTS` and a test pins the flag; it stays available because it does
  refuse when it does fire.
- **`SubagentStop` with an empty `agent_type` bypasses matcher filtering
  entirely** and runs every hook registered for the event. A matcher there is
  a narrowing that cannot be relied on — treat it as a hint, and re-check the
  agent identity inside the gate.

## 6. Sizes, timeouts, execution

- The 10 000-character cap is applied as `text.length` — **UTF-16 code
  units**. It covers hook stdout, `additionalContext`, `systemMessage` and
  `initialUserMessage`. Oversize content is not rejected: it is written to a
  file and replaced by a reference, so injected context silently stops being
  context.
- `timeout` in `hooks.json` is in **seconds**; the default when it is absent
  is **600 s** (`SessionEnd` is the exception, 1.5 s).
- The command is spawned with `shell: true`, so the substituted
  `${CLAUDE_PLUGIN_ROOT}` **must be quoted** or a path with a space breaks
  the invocation. Input arrives on stdin as one JSON object followed by a
  newline.
- Hooks matched to one event run **in parallel**, deduplicated by
  `(pluginRoot, command)`. No hook may assume another has already written
  anything.
- `permissionDecision: "defer"` is print-mode only; in an interactive session
  it is ignored with a warning.
