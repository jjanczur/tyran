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
| the hook file is missing or not executable | spawn throws, caught, **action proceeds** |
| stdout is not JSON at all (does not start with `{`) | treated as plain text, **proceeds** |
| stdout is JSON but fails the output schema | validation error, **proceeds** |
| `hookSpecificOutput.hookEventName` differs from the fired event | the platform **throws while reading our output**, caught, **proceeds** |
| the hook is killed at its `timeout` | output discarded, **proceeds** |
| an exception is thrown while *selecting* which hooks to run | selection returns `[]`, so **every hook silently disappears** |

The last row answers one of ADR-22's open questions: yes, a missing hook file
disables that gate silently. It is a real attack surface on the plugin
itself, and the answer is not inside a hook.

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

## 4. `permissionDecision: "allow"` is not "no objection"

It sets the permission behaviour to *allow*, i.e. it **auto-approves the tool
call and skips the permission prompt**. A gate emitting it for everything it
did not object to would be quietly approving the whole session. `deny` from
any hook wins over `allow` from another, but that is no comfort when ours is
the only hook.

This runtime has no way to emit it. "No objection" is `{}`.

## 5. Matcher syntax — one predicate for every event

```
if (!matcher || matcher === "*") return true;
if (/^[a-zA-Z0-9_|]+$/.test(matcher))
    return matcher.includes("|") ? matcher.split("|").includes(query)
                                 : query === matcher;
try { return new RegExp(matcher).test(query) } catch { return false }
```

Three consequences the documented table does not state:

1. **`SessionStart` accepts alternation.** `startup|resume|compact` is a
   single valid entry; three separate entries are unnecessary.
2. The exact-list character class is `[a-zA-Z0-9_|]` — **no spaces, hyphens
   or commas.** `Edit, Write` or `my-tool` fall through to the *regex*
   branch, which is unanchored and matches far more than it looks like.
3. An invalid regex matches **nothing** and only writes a debug line. A typo
   in a matcher removes the gate without any visible failure.

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
