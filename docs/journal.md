# Journal reference

> **Status:** shipped — `scripts/journal.mjs` with 18 unit tests. This file
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
| `spawn` | `agent`, `role` | agent started (+ `model`, `ticket`, `worktree`) |
| `report` | `agent`, `verdict` | agent finished (+ `evidence[]: {cmd, exit, counts}`) |
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
- **Lease protocol honesty:** a `lease.released` by a non-holder does not
  free the lease — it is surfaced in `tail().mismatchedReleases`.
- **IDs never from memory:** `journal.mjs next-id <file> D` scans the file
  and returns `D-<max+1>` — duplicate ledger numbers after a compaction
  become impossible.
- **Resume surface:** `journal.mjs tail <file>` returns the latest
  `checkpoint` and all unreleased leases — exactly what the `SessionStart`
  hook re-injects.

## CLI

```bash
node scripts/journal.mjs append   <file> <ev> <init> [--actor A] [--data JSON]
node scripts/journal.mjs query    <file> [--ev E] [--init I] [--ticket T] [--limit N]
node scripts/journal.mjs validate <file>        # exit 1 on any finding
node scripts/journal.mjs next-id  <file> <prefix>
node scripts/journal.mjs tail     <file>
```
