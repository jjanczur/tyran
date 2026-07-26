# Journal reference

> **Status:** shipped — `scripts/journal.mjs` with 36 unit tests. This file
> is the schema contract; extending the event set is a reviewed core change.

The journal is the append-only source of truth for an initiative:
`.tyran/state/<initiative>/journal.jsonl`, one JSON event per line.

## Event envelope

```json
{"ts": "2026-07-26T10:00:00.000Z", "ev": "report", "init": "rate-limiting",
 "actor": "tyran-implementer", "data": { "...": "..." }}
```

| Field | Type | Rule |
|---|---|---|
| `ts` | ISO-8601 string | stamped on append when absent; must be non-decreasing across the file |
| `ev` | enum | one of the closed set below — unknown types are rejected |
| `init` | string | initiative slug |
| `actor` | string | who wrote the event (agent name or `conductor`) |
| `data` | object | free-form, but each type's required keys are enforced |

## Closed event set (14)

| `ev` | Required `data` keys | Meaning |
|---|---|---|
| `init.created` | — | initiative opened |
| `plan.accepted` | — | plan gate passed; routing snapshot frozen |
| `ticket.created` | `id` | unit of work (+ `deps[]`, `files_predicted[]`) |
| `spawn` | `agent`, `role` | agent started (+ `model`, `ticket`, `worktree`); `agent` must have no open spawn — see below |
| `report` | `agent`, `verdict` | agent finished (+ `evidence[]: {cmd, exit, counts}`); closes that agent's open spawn |
| `gate` | `kind`, `result` | quality gate outcome (+ `evidence_ref`) |
| `review` | `ticket`, `verdict`, `by` | independent review verdict |
| `merge` | `ticket`, `sha` | merged (+ `mode`) |
| `decision` | `id`, `text` | ledger entry (IDs issued via `next-id`) |
| `lease.acquired` | `resource`, `holder` | worktree / heavy-slot lease taken |
| `lease.released` | `resource`, `holder` | lease returned |
| `checkpoint` | `phase`, `next_steps` | resume surface (re-injected after compaction) |
| `retro.entry` | `kind`, `target` | self-improvement ledger (+ `confidence`) |
| `error` | `class` | failure record (+ `detail`) |

## Guarantees

- **Crash-safe reads:** a truncated final line (crash mid-write) is discarded
  and flagged (`truncatedTail`); corruption anywhere else is a loud
  validation error, never silent loss.
- **Concurrency-safe stamping:** appends take a cross-process lock (atomic
  `mkdir`; stale locks stolen after 10 s) and auto-stamped timestamps are
  clamped to the journal's last event — concurrent writers cannot produce a
  timestamp regression *by construction*. An explicitly provided `ts` is
  caller-owned; `validate` flags regressions after the fact.
- **One open spawn per agent name** (ADR-18): `append` refuses a `spawn`
  whose agent already has a `spawn` with no `report` — see below.
- **Lease protocol honesty:** a `lease.released` by a non-holder does not
  free the lease — it is surfaced in `tail().mismatchedReleases`.
- **IDs never from memory:** `journal.mjs next-id <file> D` scans the file
  and returns `D-<max+1>` — duplicate ledger numbers after a compaction
  become impossible.
- **Resume surface:** `journal.mjs tail <file>` returns the latest
  `checkpoint` and all unreleased leases — exactly what the `SessionStart`
  hook re-injects.

## Spawn ↔ report: one open spawn per agent name

There is no `spawn_id`. A `report` is matched to a `spawn` **by agent name,
in file order: it closes the oldest still-open spawn of that name.** For that
rule to be exact rather than a guess, the ambiguous state is not allowed to
exist in the first place (ADR-18):

**`append` rejects a `spawn` whose agent name already has an open spawn in
that journal** (open = a `spawn` with no matching `report` yet). The check
runs under the same lock and on the same read as the write, so two
simultaneous writers cannot both pass it — 12 concurrent processes appending
the same name produce exactly one event and 11 loud failures.

Consequences you will meet in practice:

- **Two agents that run at the same time need two names.** `impl-1` /
  `impl-2`, not `implementer` twice. The name is the correlator; it is also
  how the platform addresses an agent, so two live agents sharing one name
  are already ambiguous outside the journal.
- **Agent names are refused on write when they are not canonical:** empty,
  non-string, not Unicode-NFC, padded with whitespace, or carrying control /
  zero-width characters. `worker` and `worker␠` would otherwise look
  identical and silently defeat the guard. Case *is* significant — `Worker`
  and `worker` are different agents, exactly as they are to the platform.
- **A `report` that closes nothing is still written** (it is a fact that
  happened) but `validate` reports it as an orphan.
- The rule is per journal file — one initiative, one file.

### Getting unstuck

An agent that dies without reporting leaves its name blocked. Close it
explicitly — this is an ordinary `report` event written through the ordinary
path, not a bypass, and it demands a reason so a forced closure is always
attributable:

```bash
node scripts/journal.mjs open-spawns .tyran/state/demo/journal.jsonl
node scripts/journal.mjs close-spawn .tyran/state/demo/journal.jsonl demo impl-1 \
  --reason "agent killed by turn limit"      # → report, verdict "abandoned"
```

There is no `--force` and no flag that skips the guard: the only way to open
a name again is to record what happened to the previous spawn.

### Journals written before the guard

History is append-only and is never rewritten. A journal that already
contains two open spawns for one name still **reads** normally
(`readJournal`, `query`, `tail` are unchanged) and `validate` still exits 0 —
but it lists the finding in `warnings[]`, because a projection built on such
a file cannot say who is still working. Warnings also cover orphan reports
and unusable agent names. `ok` and the exit code remain driven by `errors[]`
alone.

The guard binds writes through `append`. Hand-editing `journal.jsonl` can
still create a duplicate; `validate` warnings are how you find out.

## CLI

```bash
node scripts/journal.mjs append      <file> <ev> <init> [--actor A] [--data JSON]
node scripts/journal.mjs query       <file> [--ev E] [--init I] [--ticket T] [--limit N]
node scripts/journal.mjs validate    <file>        # exit 1 on errors; warnings do not fail
node scripts/journal.mjs next-id     <file> <prefix>
node scripts/journal.mjs tail        <file>
node scripts/journal.mjs open-spawns <file>        # agents with no report yet
node scripts/journal.mjs close-spawn <file> <init> <agent> --reason R [--verdict V] [--actor A]
```
