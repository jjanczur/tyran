# Mistakes

What has gone wrong in this repository, what caused it, and what prevents it
next time. **Newest first.** This file is prose, not a generated artefact —
edit it by hand whenever a root cause here is wrong. Nothing overwrites it.

Every entry has the same five bullets:

    ## <YYYY-MM-DD> — <one line: what broke, in a reader's words>

    - **What happened:** the observable failure, not the diagnosis.
    - **Root cause:** the mechanism. "I forgot" is not a root cause.
    - **Consequence:** what it cost — time, a rework wave, a bad merge.
    - **Prevention:** the rule that would have stopped it, imperative.
    - **Signature:** `kebab-case-slug` · initiative `<slug>` · actor `<who>` · proof `<F-n>` · status `open`

The **signature** is what makes this more than a diary. Repeated entries under
one signature are evidence that a rule is missing, and the count is what earns
it — `repeats` prints the signatures that have crossed a graduation threshold
and what each has earned (the thresholds, and why they are where they are, live
in `docs/self-improvement.md`):

    node scripts/mistakes.mjs repeats

Reuse an existing signature rather than inventing a near-synonym — a synonym
resets the count to one and the lesson never graduates.

**Status moves one way and never back.** `open` → `knowledge:<id>` (the rule
now ships in every handoff that touches those paths) → `law` (a rule in
`CLAUDE.md`). Promotion never deletes an entry: the entry is the evidence, and
deleting it destroys the count that earned the rule.

<!-- entries below, newest first -->

## 2026-08-14 — the write-guard refused an edit twice over control characters nobody typed

- **What happened:** two consecutive edits to scripts/board-html.mjs were refused by the control-character guard, reporting raw C0 and bidi codepoints in a regex character class the author had written as \uXXXX escape text.
- **Root cause:** the editing tool materialises \uXXXX escape text in its input into the character itself before the bytes reach disk, so a class typed as escapes lands as the raw codepoints — and scripts/scan-control-chars.mjs is right to refuse them; the guard was working and the author was the attacker.
- **Consequence:** two refused writes and a re-derivation of the same character class, on an edit that was otherwise finished.
- **Prevention:** never type an invisible codepoint into source: build such a character class from FORBIDDEN in scripts/invisible.mjs, which is the one place that answers what is invisible, or emit the escapes programmatically at build time.
- **Signature:** `raw-control-chars-in-source` · initiative `phase-5-mistakes` · actor `conductor` · proof `-` · status `open`

## 2026-08-13 — a new tracked file makes the control-character canary fail until it is staged

- **What happened:** a file added at the repository root left `node --test "tests/**/*.test.mjs"` red, with the canary reporting a path missing from its pinned list, and the first three attempts to fix it edited the wrong thing.
- **Root cause:** `scanRepo` enumerates through `git ls-files`, so an unstaged file is invisible to the scan, while `tests/unit/scan-control-chars.test.mjs` pins the exact sorted list of scanned paths — the file must be BOTH staged and added to the pinned array, and doing only one of the two fails in two different ways that read alike.
- **Consequence:** a red suite on a change that was correct, and time spent looking for a defect in the scanner.
- **Prevention:** when adding a tracked file, `git add` it and add its path to the pinned `scannedPaths` array in the same edit, before running the suite.
- **Signature:** `canary-needs-staged-file` · initiative `phase-5-mistakes` · actor `conductor` · proof `-` · status `open`

## 2026-08-13 — a bare `off` in a .tyran YAML file is the boolean false, not the string

- **What happened:** `limits.mode: off` parsed as `false` and the config failed validation with a message about an enum that plainly contained the value the author had written.
- **Root cause:** `scripts/yaml-lite.mjs` maps the bare scalars `true`/`false`/`yes`/`no`/`on`/`off` to booleans, exactly as YAML 1.1 does. A value that is meant to be the STRING `off` has to be quoted, and the error message names the enum rather than the type, so it reads as a validator bug.
- **Consequence:** a debugging round on a config that was one apostrophe pair from correct, twice.
- **Prevention:** quote every enum value in a `.tyran` YAML file whose spelling collides with a YAML boolean — `mode: 'off'` — and prefer a real boolean where the field is genuinely a switch.
- **Signature:** `yaml-bare-off-is-false` · initiative `phase-5-mistakes` · actor `conductor` · proof `-` · status `open`

## 2026-08-13 — a `${VAR}` in a command is unreadable to the shell allowlists

- **What happened:** a command that was expected to match an allowlist entry did not, and the refusal named a token nobody had written.
- **Root cause:** the shared shell lexer splits on braces, so an unexpanded `${CLAUDE_PLUGIN_ROOT}` prefix does not survive as one token with the path after it — an allowlist or a path check written against the expanded spelling cannot see the unexpanded one. The two spellings of the same command are not interchangeable to anything that reads the command as text.
- **Consequence:** a gate that looked broken and was not, and a workaround attempted before the cause was found.
- **Prevention:** when a command's text has to match a rule, write the path in the spelling the rule reads — expand it, or resolve it into a variable before the line the gate inspects — and never assume `${VAR}` and its expansion are the same token.
- **Signature:** `shell-lexer-splits-braces` · initiative `phase-5-mistakes` · actor `conductor` · proof `-` · status `open`

## 2026-08-13 — the policy gate refuses a Bash command whose TEXT names a kernel path

- **What happened:** a read-only `grep` naming two files under the enforcement-script directory was refused mid-investigation, and the refusal read as a tool failure rather than as a boundary.
- **Root cause:** the enforcement scripts and the policy directory are `MANDATORY_KERNEL_PATHS`, and the gate matches the Bash command's TEXT, not just a write target — a validator, a `grep` and a `cat` are all refused alike. This is the boundary working: a command naming the mechanism is the shape an attempt to disable it takes.
- **Consequence:** an investigation stalled until the tool was switched; on an earlier occasion, a schema validator handed to an operator to run by hand.
- **Prevention:** reach for `Read` on those files, and name only the directory in a shell command — `node scripts/doctor.mjs --state --dir .tyran` validates the policy without naming it.
- **Signature:** `gate-refuses-kernel-path-in-bash` · initiative `phase-5-mistakes` · actor `conductor` · proof `-` · status `open`
