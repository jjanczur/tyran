# Hook I/O contract — measured, not assumed

Every statement here was read out of the shipped Claude Code binary — §1–§16
on **v2.1.116**, §17–§18 on **v2.1.197** — not out of documentation. It
exists because a gate built on a guess about the platform is a gate of
unknown strength (ADR-22), and because
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
| the hook is killed at its `timeout` | killed with `SIGKILL` — and the output is **not read at all**; see below, this row is the one that misleads |
| an exception escapes hook *selection* | the selector is wrapped in `try { … } catch { return [] }`, so **every hook for that event disappears** with no transcript entry |

### The timeout row, in full — because the obvious reading of it is wrong

An earlier version of this file said "measured `rc=137`, stdout empty,
proceeds". Every word of that is true and the sentence is still misleading,
because it points at the wrong cause. The problem is **not** that a killed
hook has no time to write. Measured on a live run: a `PreToolUse` hook with
`timeout: 3` wrote a complete, valid refusal through `writeSync(1, …)`,
logged that it had done so, and only then blocked for 60 s. The refusal was
**ignored and the tool ran**.

The reason is visible in the runner. The same moment that kills the process
aborts the `AbortSignal`, the `close` handler reports `aborted: true`, and
the consumer does this:

```
if (o.aborted) { …record telemetry, including o.stdout…; return }   // ← returns here
const { json, plainText, validationError } = parse(o.stdout);       // ← never reached
```

The bytes were collected. They are even stored in the telemetry record. They
are simply **never parsed**. So:

> **Writing earlier does not help.** A watchdog that emits the refusal sooner
> and lets the process keep running buys nothing at all. The only thing that
> closes this case is a mechanism that makes the process **EXIT** before the
> platform's timeout — a hard-killed child process, or a watchdog that forces
> the whole process to terminate. Anything that merely produces output while
> the process stays alive is defeated by this branch.

This is why `hook-io.mjs` enforces its budget by emitting **and exiting**,
rather than by writing early and hoping.

Two further corrections to how this file was first written, both worth
stating because the wrong mechanism leads to the wrong fix:

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

---

# Second pass (S-E3-5, 2026-07-27, still v2.1.116)

Read out of the same binary while building `scripts/hooks-check.mjs`. Nothing
below contradicts the sections above; it fills in the parts that were marked
unknown, and one of them changes what a matcher means on five events.

## 7. The matcher is not consulted at all when the event has no match query

The dispatcher builds a query per event with a `switch`, then filters:

```
let z = ($ ? T.filter(k => !k.matcher || UB5($, k.matcher)) : T)
```

The ternary is the whole story, and it has **two** consequences that are
documented nowhere:

1. On `Stop`, `UserPromptSubmit`, `TaskCreated`, `TaskCompleted` and
   `TeammateIdle` the switch assigns nothing, so `$` is `undefined` and the
   matcher list is **not filtered**. A matcher on those events is inert: the
   hook fires for every occurrence, whatever the matcher says.
2. It is also the mechanism behind the empty-`agent_type` case S-E3-2 had to
   work around. An empty string is falsy, so a `SubagentStop` carrying
   `agent_type: ""` takes the same branch and runs **every** hook registered
   for the event. It is not a special case for agents; it is one ternary.

Note also `!k.matcher` inside the filter: an absent or empty matcher always
matches, independently of `UB5`.

## 8. The match query, per event

| event | field used as the match query |
|---|---|
| `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `PermissionDenied` | `tool_name` |
| `SessionStart`, `ConfigChange` | `source` |
| `Setup`, `PreCompact`, `PostCompact` | `trigger` |
| `SubagentStart`, `SubagentStop` | `agent_type` |
| `UserPromptExpansion` | `command_name` |
| `Notification` | `notification_type` |
| `SessionEnd` | `reason` |
| `StopFailure` | `error` |
| `Elicitation`, `ElicitationResult` | `mcp_server_name` |
| `InstructionsLoaded` | `load_reason` |
| `FileChanged` | `basename(file_path)` |
| `Stop`, `UserPromptSubmit`, `TaskCreated`, `TaskCompleted`, `TeammateIdle` | **none — see §7** |

## 9. Input schemas that S-E3-5 needed

- **`PreCompact`**: `{ hook_event_name, trigger: "manual" | "auto",
  custom_instructions: string | null }`. The trigger is a closed enum, which
  is what lets `doctor --hooks` call a matcher on this event dead rather than
  merely unrecognised. `PostCompact` adds `compact_summary`.
- **`SubagentStart`**: `{ hook_event_name, agent_id, agent_type }` — both
  strings, both required.
- **`SubagentStop`**: `{ hook_event_name, stop_hook_active, agent_id,
  agent_transcript_path, agent_type, last_assistant_message? }`.
- **`PreToolUse`**: `{ hook_event_name, tool_name, tool_input, tool_use_id }`,
  where `tool_input` is typed **`h.unknown()`**. The platform does not validate
  its shape at all, so a hook that reads three known field names out of it is
  correct for exactly today's tools. This is why `write-guard.mjs` walks every
  string in the payload instead.

## 10. The tools that write file content, as the platform enumerates them

For its own diff statistics the binary keeps a set of the tools whose input
ADDS content, and reads a different field from each:

```
if (tool === Edit)         return { added: count(q.new_string), removed: count(q.old_string) }
if (tool === Write)        return { added: count(q.content),    removed: 0 }
if (tool === NotebookEdit) return { added: count(q.new_source), removed: 0 }
```

with the three constants resolving to `"Edit"`, `"Write"` and
`"NotebookEdit"`. That set — **not a judgement call, and not a list we
maintain** — is `FILE_WRITING_TOOLS` in `scripts/hooks-check.mjs`.

`MultiEdit` survives only in a legacy display-name table next to
`FileWriteTool` and `FileEditTool`; it is not a live tool in this build.

Related: `filePatternTools` is `["Read","Write","Edit","Glob","NotebookRead",
"NotebookEdit"]` and `bashPrefixTools` is `["Bash"]`.

## 11. The tool alias table, and which way it is applied

```
aliases = { Task: "Agent", KillShell: "TaskStop",
            AgentOutputTool: "TaskOutput", BashOutputTool: "TaskOutput" }
```

`normalise` is applied to the **matcher** and compared against the **raw
query**, so a `hooks.json` written against the old name `Task` still fires for
a query of `Agent`. In the regex branch the expression is additionally retried
against every alias **of the query**. Getting the direction backwards makes a
check report a live gate as dead, so both directions are pinned by a test.

## 12. Deduplication is by (pluginRoot, command)

Two entries carrying the identical command string on one event run **once** —
including the second entry's matcher, which is what usually makes this a
mistake rather than a harmless redundancy.

## 13. Keys on a hook ENTRY that disarm a gate (S-E3-5 round 2)

The entry schema, transcribed:

```
h.object({
  type: h.literal("command"),
  command: h.string(),
  if: <condition>,
  shell: h.enum(["bash","powershell"]).optional(),   // default bash
  timeout: h.number().positive().optional(),          // SECONDS
  statusMessage: h.string().optional(),
  once: h.boolean().optional(),        // "runs once and is removed after execution"
  async: h.boolean().optional(),       // "runs in background without blocking"
  asyncRewake: h.boolean().optional(), // "…wakes the model on exit code 2. Implies async."
  rewakeMessage: h.string().min(1).optional(),
})
```

Verified live, same payload, one key changed each time, on a BLOCKING event:

| entry | result |
|---|---|
| bare | refused; the file was never written |
| `+ "async": true` | **passed** — raw TAG characters landed on disk |
| `+ "if": "Bash(git *)"` | **passed** |
| `+ "shell": "powershell"` | **passed** |

In every case a logger registered on the same matcher fired normally, so this
is neither a matcher nor a dispatch failure — it is the entry. Every other
liveness property (file present, executable, shebang, matcher correct, event
real) still holds, which is what makes this the hardest variant to see.

## 14. Correction to §11 — the alias table has FIVE rows, not four

```
{ Task: "Agent", KillShell: "TaskStop", AgentOutputTool: "TaskOutput",
  BashOutputTool: "TaskOutput", ...(BRIEF_TOOL_NAME ? { Brief: BRIEF_TOOL_NAME } : {}) }
```

`BRIEF_TOOL_NAME` is an imported constant equal to `"SendUserMessage"`, not a
runtime flag, so the spread is always active. The first transcription dropped
the row, and the consequence ran in the dangerous direction: a matcher of
`Brief` fires on the live platform while a check built on the four-row table
called it dead. **A live gate reported as dead** — in a file whose only value
is fidelity.

## 15. The regex branch retries against the query's ALIASES, and it widens matchers

Because of the `for (const alias of aliasesOf(query))` retry, an UNANCHORED
alternation matches more than it reads as. Measured: `Write|Edit|NotebookEdit|Bash|mcp__.*`
also matches `TaskOutput` — whose alias `BashOutputTool` contains `Bash` — and
`WriteSomething`. Anchoring the whole alternation, `^(…)$`, removes both at no
cost. Any matcher meant to be exact should be anchored even when it looks like
a plain list, because one non-alphanumeric character anywhere in it moves the
whole string into this branch.

## 16. A refused tool call teaches the model the next route (S-E3-5 round 3)

Not a platform fact, but a behavioural one measured on the live product, and
it changes how a gate has to be scoped.

A `PreToolUse` refusal on `Write` was followed, **in the same turn and with no
prompting**, by the model offering:

> "Would you like me to: 1. Use Bash (`printf` or `echo`) to write the file
> instead, which would bypass this guard?"

That route was then measured and it worked, because the command text was pure
ASCII and the forbidden character only existed after the shell expanded the
escape (`od -c` showed `363 240 201 201`, UTF-8 for U+E0041).

Two consequences worth carrying into every later gate:

1. **The first thing tried after a refusal is another entrance.** Scoping a
   gate to one tool is not a partial control; it is an advertisement.
2. **The text of a command is not the effect of a command.** Any gate reading
   `Bash` input is reading a program, and a program's output cannot be known
   without running it. Escape decoding closes the obvious spelling; the class
   stays open by construction and must be declared, not implied.

## 17. The PreToolUse payload carries NO usage telemetry (measured 2.1.197)

Measured 2026-08-13 with a dump hook (`cat > file`) registered in a scratch
repository, one live tool call. The complete PreToolUse stdin payload:

```
session_id · transcript_path · cwd · prompt_id · permission_mode ·
effort.level · hook_event_name · tool_name · tool_input · tool_use_id
```

**No `rate_limits` field, in any shape.** The statusline JSON is therefore
the only programmatic source of subscription-window telemetry, and a plugin
cannot register a statusline — the operator does. Every consumer of usage
data in this plugin (the usage gate, doctor, the overnight scheduler) reads
the sidecar `scripts/statusline.mjs` writes, and treats its absence as
UNKNOWN, which fails open. If a later platform version adds `rate_limits`
to hook stdin, re-measure and prefer it — stdin beats a sidecar on
freshness by construction.

Two adjacent facts measured the same day, same version:

- `claude -p --resume <session-id> "<prompt>"` was measured resuming a
  session **created by a previous `-p` run**, context intact, session id
  unchanged. The direction the overnight watcher actually relies on —
  resuming an INTERACTIVE session headlessly — is assumed to behave the
  same and has **not** been measured. The compensating control is that the
  watcher never trusts the resume: it judges success by journal movement
  (`resumeTook` in `scripts/overnight.mjs` — events after minus events
  before), retries on a finite backoff ladder, and reports a resume that
  exited cleanly having appended nothing as failed, loudly. A resume that
  silently does nothing is therefore detected, never trusted.
- Statuslines do not run under `claude -p`, so a RESUMED headless session
  has no fresh telemetry and its usage gate fails open by design. The
  overnight watcher compensates by babysitting the resumed process and
  judging success by journal movement, never by exit code.

## 18. Both windows, hit live, while this section was being written

The five-hour window (12:15) and then the weekly window (15:30) killed two
four-agent review fleets on 2026-08-13. Observed behaviour, confirming the
docs: the parent session SURVIVES — only new subagent work fails, with the
platform's own message naming the window and its reset time. The main loop
retained enough headroom to wind down in order: commit, checkpoint, notify
the operator, schedule the resume. That ordering is exactly the wind-down
checklist the usage gate prints, rehearsed by hand before it was shipped.
