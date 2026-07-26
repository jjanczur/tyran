# Doctor reference

> **Status:** shipped — `scripts/doctor.mjs --state` with 54 unit tests.
> It **diagnoses, it never repairs.** Every finding carries a severity, a
> location and a command you can paste.

The journal is append-only and the projections are generated, so most of
Tyran's state is self-consistent by construction. The gaps are the places
where a human, a crash or a second process can get in between: a hand-edited
journal, an agent that died without reporting, a `STATE.md` somebody
"fixed", a policy rule with a typo that silently protects nothing.

```bash
node scripts/doctor.mjs --state [--dir <.tyran>] [--json]
                                [--now <iso>] [--stale-hours <n>]
```

| Exit | Meaning |
|---|---|
| `0` | healthy — `info` findings are allowed and expected |
| `1` | findings: at least one `error` or `warning` |
| `2` | usage or I/O error (unknown flag, flag given twice, an explicitly named `--dir` that does not exist) |

- `--state` is **required**. It is the only mode today; `--env` and
  `--config` land with the setup epic, and a bare `doctor.mjs` that silently
  meant one of them now would silently mean something else then.
- `--dir` defaults to `.tyran`. A **missing default** is a healthy repo that
  has not run `/tyran:setup` yet (exit `0`). A **missing explicit** `--dir`
  is a typo, and a clean bill of health for a path nobody looked at is the
  one output a diagnostic must never produce (exit `2`).
- `--json` prints the same result as a machine-readable object — the shape
  the future `SessionStart` hook and the dashboard consume.
- A flag given twice is refused rather than silently resolved.

## What it checks

| Code | Severity | Finding |
|---|---|---|
| `journal-invalid` | error | per-event schema failure, timestamp regression, unknown event type, corruption **mid-file** |
| `journal-truncated` | warning | the final line is truncated — a crash mid-write; readers discard it |
| `journal-init-mismatch` | error | events carry an `init` that is not the directory name |
| `journal-cross-init-pairing` | error | a `report` from one initiative closed a `spawn` from another |
| `journal-mixed-initiatives` | warning | more than one `init` in one file (the contract is one initiative, one file) |
| `journal-missing` / `journal-not-a-file` / `journal-unreadable` | warning / error | the initiative directory has no readable journal |
| `journal-lock-present` | warning | a leftover write-lock directory: a writer is running, or died inside its critical section |
| `spawn-open` | info | the journal still believes this agent is working |
| `spawn-stale` | warning | ...and the initiative moved on without it (see the clock below) |
| `spawn-duplicate` | warning | two open spawns for one agent name — pairing is ambiguous (ADR-18) |
| `spawn-orphan-report` | warning | a `report` that closes nothing |
| `agent-name-unusable` | warning | an agent name that cannot act as a correlator; those events are excluded from pairing |
| `lease-open` | info | an open lease whose holder is still working |
| `lease-orphan` | warning | an open lease whose holder already reported — the resource is blocked by nobody |
| `lease-expired` | warning | the acquiring event carried `expires` / `expires_at` / `until`, and it has passed |
| `lease-release-by-non-holder` | warning | a release that did not free the lease |
| `projection-drift` | warning | `STATE.md` / `PROGRESS.md` no longer match the journal, byte for byte |
| `projection-missing` | info / warning | none generated yet (info) · one of the pair missing (warning — a run stopped half way) |
| `projection-blocked` | warning | the journal cannot be projected at all, so drift is not even a meaningful question |
| `config-invalid` · `knowledge-invalid` · `policy-invalid` | error | a schema validator rejected the file, with its exact field path |
| `policy-kernel-downgrade` | error | a rule that tries to lower a protected kernel path |
| `policy-rule-dead` | warning | a rule glob that can never match any path |
| `policy-rule-overruled` | warning | a rule that quietly fails to cover part of what it looks like it covers |
| `config-missing` · `policy-missing` | info | the repo has not been set up (yet) |
| `check-failed` | error | one check threw on this journal — the other checks still ran |
| `state-stray-file` · `*-not-a-directory` | warning | something in `.tyran/` is not the shape the layout expects |

## Guarantees

- **Deterministic.** The same state renders the same bytes. Nothing reads
  the wall clock, findings are sorted explicitly (severity, then code, then
  location, then message, ties keeping the order the checks produced), and
  the report contains no timestamp that is not copied from an event.
- **One implementation per rule.** Spawn/report pairing is
  `journal.pairSpawns()`, lease ownership is `journal.tail()`, projection
  freshness is `project.checkFile()`, path classification is
  `schema.classifyPath()`, file schemas are `schema.validateFile()`. Doctor
  asks those modules; it never re-derives their answers. Two implementations
  of one rule diverge at the first "optimization" — this repo has the scar
  (ADR-18).
- **No false alarm on a healthy repo.** No `.tyran/`, an empty journal, no
  projections yet, no config: all exit `0`. A tool that cries wolf on a
  fresh checkout is uninstalled before it ever finds anything.
- **Nothing passes silently.** An unreadable file, a directory where a file
  belongs, a `knowledge/` that is not a directory, a journal shape that
  throws inside a reader — each becomes a finding naming the errno. A check
  that cannot run says so; it never reports "clean" for something it skipped.
- **Every fix command runs.** Agent names go into `close-spawn` commands raw
  (shell-quoted): a name that reached an open spawn has provably passed
  `agentNameProblem`, so it carries no control characters. Free-form values
  such as lease resource names go into `--data` as JSON with every
  non-ASCII codepoint written as `\uXXXX` — an escape, not a sanitization,
  so `JSON.parse` still returns the exact original.
- **Untrusted journal values cannot rewrite the report.** Every value read
  out of a journal is passed through `project.inline()` before it is
  printed, in the text report and in `--json` alike. In a plugin, `data` is
  written by agents processing someone else's repository; without this an
  agent name carrying an unterminated right-to-left override would mirror
  every following line of the diagnosis a human is reading.

## The clock

Staleness needs a "now", and a wall clock would make the output
non-deterministic. Doctor uses **the journal's own last event** as the
reference time, so `spawn-stale` means:

> this agent has been open for N hours **of journal time** — the initiative
> kept moving and left it behind.

That is the signal worth acting on, and it has a useful property: when the
spawn *is* the last event, its age is zero, so an agent that is simply
working long never trips the check. It also means a completely idle journal
cannot report staleness — pass the real clock when you want that:

```bash
node scripts/doctor.mjs --state --now "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

`--stale-hours` moves the threshold (default 4).

## Dead policy rules

A rule that matches nothing is worse than a missing rule: the file *looks*
like the boundary is defined, `schema.mjs validate policy` passes, and
nobody is protected.

Doctor does not enumerate possible repo paths — that set is unbounded and
would only ever prove a rule *live*, never dead. It uses the one thing that
is decidable: **every path a rule ever meets has been normalized first**
(repo-relative, POSIX separators, no `.` or `..` segments, no leading
slash). Each glob is instantiated into witness paths (`**` becomes real
segments, `*` becomes one segment) and each witness is pushed through
`normalizePath`. If normalization rejects or rewrites *every* witness, the
literal parts of the glob contain exactly the characters normalization
removes — and those parts must appear verbatim in any match. The rule is
dead, and the corrected glob is printed:

| Rule | Verdict |
|---|---|
| `./hooks/**`, `/hooks/**`, `hooks\x`, `a/./b`, `foo/../bar`, `.`, `..` | **dead** — the report suggests the normalized spelling |
| `*`, `**`, `.*`, `src/**`, `(hooks)/**`, `*/policy-gate.mjs` | live — they do match real paths |

One witness surviving unchanged is enough to call a rule live, so the check
is conservative by construction: a false "dead" alarm on a working security
rule would be worse than the miss it exists to prevent.

`policy-rule-overruled` closes a gap from the other side. `validatePolicy`
already rejects rules that downgrade `hooks/**` or `.tyran/policies/**`, but
its heuristic fills the rule's wildcards with filler segments, so a rule
like `*/policy-gate.mjs` validates clean while quietly failing to cover
`hooks/policy-gate.mjs` — `classifyPath` returns `KERNEL` there before any
rule is consulted. Doctor instantiates the rule's wildcards with segments of
the *protected* path instead, which means the rule matches the candidate by
construction and no second glob matcher is involved.

Rule analysis runs **only on a policy that validates**. Findings derived
from a document the schema already rejected are noise stacked on top of the
real problem.

## Module API

```js
import { runStateChecks, renderText, renderJson } from './scripts/doctor.mjs';

const result = runStateChecks({ dir: '.tyran', now: null, staleHours: 4 });
// { ok, dir, checked: string[], counts: {error, warning, info}, findings }
// finding: { severity, code, where, message, fix }
process.stdout.write(renderText(result));
```

`deadRules(policy, repoRoot)` and `overruledRules(policy, repoRoot)` are
exported separately so the future policy gate can reuse them without
scanning a state directory.

## Known limits

- A directory name containing control characters can put them in a printed
  fix command. Creating such a directory needs write access to the repo
  already; paths are used raw so the commands stay runnable.
- `lease-expired` only sees an expiry that the acquiring event recorded in
  its `data`. `lease.acquired` requires `resource` and `holder`; an expiry
  field is a convention, not a schema rule.
- Doctor reads; it does not take the journal write lock. On a journal being
  appended to right now, a finding can describe a state that is one event
  old. `journal-lock-present` is how you find out that this happened.
