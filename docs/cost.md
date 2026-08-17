# The spend ledger

What the work cost, in tokens the platform itself reported — per model, per
agent type and per ticket.

```bash
node scripts/cost.mjs --dir .tyran
```

Claude Code already writes every number this needs. Each assistant record in a
session transcript carries `message.usage` (input, cache write, cache read,
output) and `message.model`; each subagent gets its own transcript under
`<session>/subagents/`, beside a `.meta.json` naming its agent type and the
description the conductor gave it. So the ledger **reads, it never
instruments**: no hook, no probe, no new event type, and nothing to keep in
sync. A number that has to be written twice is a number that will eventually
disagree with itself.

## Not a projection, and deliberately so

Every other generated artefact here is a projection of the journal: rendered
from committed bytes, byte-compared by `--check`, identical in every clone.
Spend is not, and cannot be. Its inputs live under `~/.claude/projects/`,
belong to the operator's machine, and differ per clone — two people with the
same journal have different transcripts, and one of them may have none at all.

So `cost.json` is never byte-compared, never committed (it joins the runtime
files `.tyran/.gitignore` excludes), and never enters `board.json`. Putting
spend into a committed, byte-checked artefact would make two people with one
journal disagree, and the disagreement would be reported as drift.
[Projections](projections.md) states the same boundary from the other side.

## Tokens are facts, money is an opinion

Only tokens are counted. Money is derived at the very end from a rate card
**you** write, and the card's name travels with every amount the report prints
— two people quoting different cards get different money from one set of
tokens, and a figure that cannot say which card produced it is not a
measurement.

With no `pricing:` block the report uses the **published list prices**, which
ship with the plugin under the label `list-2026-08`. So money appears on a
fresh install with no configuration at all, and it answers one specific
question — what these tokens would have cost through the API. On a
subscription your marginal cost per token is zero, which is why the board puts
your monthly plan price beside the figure rather than presenting it alone.

Cache writes are priced at two rates, not one: the API bills a 1-hour cache
write at 2x base input against a 5-minute write's 1.25x, and the transcripts
carry the split. A long agent run caches for an hour, so the distinction is
not a corner — measured on 1.8 B tokens of real transcripts, the 1-hour line
was $175 against the 5-minute line's $70.

## The period a total describes

A plan is billed **monthly**, so a total summed over every transcript on the
machine has nothing to compare against. `--window` picks the period, and the
board offers the same three as buttons:

| window | what it covers |
|---|---|
| `30d` | the last 30 days, inclusive of today. The board's DEFAULT — it needs nothing from the account, so it means the same thing on every machine. |
| `period` | the current billing period, from the most recent anniversary of the subscription start. Offered only when that date is readable; a period guessed from an assumed anniversary is wrong for almost everyone. |
| `all` | everything, and the only window under which no multiple against the plan price is shown. |

The window is printed on the line under the total, and the board states it
beside the figure, for the same reason the rate card travels with every
amount: a number that cannot say what period it covers is not a measurement.

Transcripts whose records carry no usable timestamp cannot be placed in a
window. They are counted and named — `N transcript(s) with no dates omitted`
— rather than folded into whichever window happens to be showing.

Under a month-shaped window the board also shows the plan price beside the
API-equivalent. Under `all` it does not: measured on real data, an all-time
total read as "6.9x what you pay" where the honest monthly figure was about
11x, and a comparison off by however long the machine has been running is
worse than no comparison.

The **By day** chart on the Spend tab is the same daily buckets drawn as a
series, and it deliberately shows the FULL history whatever window is chosen
— a chart that shrank with the window could not show you that last month was
worse, which is the comparison worth having. Days are UTC, so two machines in
different time zones attribute the same request to the same day.

Overriding the shipped card, its shape, the accepted ranges and the rule that
all four base rate keys are required are in
[the configuration reference](configuration.md#the-rate-card).

## Ticket attribution costs nothing

A subagent's spend reaches a ticket through a convention that already exists:
the conductor puts the ticket id at the head of the `Task` description, and
`cost.mjs` reads it back out of the agent's `.meta.json`. No journal change, no
event-set change, no second place for the answer to live.

An agent whose description omits the id lands in a visible `unattributed`
bucket rather than being guessed at, and the count of those is on screen next
to every per-ticket figure. A guess would be indistinguishable from a
measurement, which is the one thing a spend number must never be.

## The conductor is its own row

The conductor's own context is not attributable to any ticket, and it is not
small: measured between 44% and 86% of a tree's tokens on real runs. A
per-ticket table that omitted it would present a fraction of the bill as the
cost of the work, so it appears as its own row in the agent-type and ticket
tables, and the rows sum to the total.

The share is reported in **tokens, never dollars**. A partial rate card prices
only some models, so a dollar share is a ratio over whichever subset happened
to be priced — the same tree read 86% by tokens and 99% by dollars while one
model lacked a rate. Tokens are always complete, so the number never moves for
a reason that has nothing to do with the work.

## Gaps are reported, never zeroed

An operator uses these numbers to decide where to spend the next agent. A total
that is low by an unknown amount produces confident wrong routing, which is
worse than no number at all. So every hole is named:

| gap | what it means |
|---|---|
| `unpriced` | models the rate card does not cover — counted in tokens, absent from every amount |
| `unattributed` | agent transcripts whose task description carried no ticket id |
| `unreadable` | transcripts that could not be opened at all |
| `malformed` | records whose JSON would not parse — a transcript appended to while it is read ends in a partial one |
| `skipped_lines` | single records over the 8 MB line cap, abandoned rather than accumulated |

Two refinements that stop the warnings becoming noise or becoming lies:

- **A model that billed zero tokens is not reported as unpriced.** The platform
  emits `<synthetic>` records carrying no tokens; a permanent warning about a
  model that cannot cost anything is how operators learn to ignore the line.
- **Partial pricing is a partial sum.** An amount is `—` only when *nothing* in
  that row is priced at all. One missing rate does not blank the grand total:
  a real rate card always misses something, and nulling every figure over one
  absent row would be honest and useless, where a partial sum plus a named
  `unpriced` list is honest and usable.

## CLI

```bash
node scripts/cost.mjs [--dir <.tyran>] [--session <id>] [--projects <dir>] [--transcripts <dir>]... [--json]
```

- `--dir` is the `.tyran` directory (default `.tyran`); the repository it
  belongs to is its parent, and that is what the transcripts are matched
  against.
- `--session <id>` narrows the report to one session and its agents.
- `--projects <dir>` overrides where the transcripts are looked for; the
  default is `~/.claude/projects`.
- `--transcripts <dir>` names a transcript directory explicitly — the per-project
  directory holding `<session>.jsonl` and `<session>/subagents/`. Repeatable;
  sources are the union over every directory given. A leading `~` expands to
  the home directory; anything else resolves against the process's current
  working directory, so a relative path is only as reliable as the directory
  the command happens to be run from — prefer absolute or `~`. See
  [When resolution fails](#when-resolution-fails) below.
- `--json` writes `.tyran/state/cost.json` atomically and prints its path
  instead of the table.
- Exit `0` ok · `2` usage or I/O error, including *no transcripts found for
  this repo* — spend is read, and nothing here estimates it, so an empty answer
  is a failure rather than a zero.

Also reachable without a Claude Code session:

```bash
npx @jjanczur/tyran cost --dir .tyran
```

The transcript directory name is the repository path with separators replaced
by dashes. That rule is read off the filesystem rather than out of
documentation, so it is verified rather than trusted: if the computed directory
is absent, every project directory is opened and matched on the `cwd` its
records carry.

## When resolution fails

Both heuristics above assume the conductor session ran **from the repo it is
working on**. When it did not — a Claude Code Desktop session opened in a
sibling folder, operating on the repo through absolute paths and worktrees —
neither one finds it: the computed slug is derived from the conductor's own
working directory, not the repo path, and every record in that transcript
carries the conductor's cwd too, never the repo's.

Measured: a `claude` run once started inside the repo (for the trust dialog)
left a directory the direct lookup matched and stopped at, while ~66 agent
transcripts and 2 300 requests sat under the conductor's real project
directory with nothing on the report pointing at them — the ledger showed one
session, one model, `unattributed` agents, and a conductor overhead reading
100%, as if that were the whole initiative.

Two overrides, highest priority first, both resolved by `cost.mjs` itself so
`board.mjs --serve` gets them too with no extra plumbing:

1. `--transcripts <dir>` on the command line, repeatable — sources are the
   union over every directory given.
2. `spend.transcript_dirs` in `.tyran/config.yaml` — see
   [the configuration reference](configuration.md#explicit-transcript-directories).

Either one replaces the derived-slug / cwd-probe resolution entirely rather
than adding to it. A given directory that does not exist is reported in
`transcript_dirs_missing` on the report, never silently dropped — the same
"gaps are reported, never zeroed" rule that governs every other hole in this
file.

## What the dashboard shows

`board.html` renders a **Spend** section: total tokens and requests, the amount
under the named rate card, the conductor's share, the attributed-agent count,
a composition bar across input / cache write / cache read / output, and three
ranked charts — by model, by agent type, by ticket — with a tokens/cost toggle.
A row whose models have no rate draws no bar at all, because "not priced" and
"cost nothing" must not look the same.

Zero agent transcripts while the board itself lists running agents is a sign
worth surfacing rather than a quiet empty table: the tab shows a hint pointing
at [the two overrides above](#when-resolution-fails) whenever that shape
appears, and lists any `--transcripts` / `spend.transcript_dirs` entry that
was given but not found.

The section is **fetched, not embedded**, which is a deliberate amendment to
the board's "self-contained, no network" description — see
[the board](board.md#spend).

## `cost.json`, schema 1

The sidecar `--json` writes is also the reader's cache, which is why it holds
more than the report: a `sources[]` entry per transcript, keyed on path, mtime
and size. Consumers check `schema === 1`; the dashboard renders nothing rather
than garbage on a mismatch. Invisible characters are escaped as `\uXXXX` and
never removed, exactly as in `board.json`.

`transcript_dirs` names the directory (or directories) the report actually
scanned, and `transcript_dirs_missing` names any `--transcripts` /
`spend.transcript_dirs` entry that was given but does not exist on this
machine — both present whichever resolution path produced the report.

That cache is what makes a page refreshing every 30 seconds affordable.
Transcripts reach tens of megabytes, so the reader streams them in chunks
rather than holding them in memory, and reuses the previous run's numbers for
any file whose `(path, mtime, size)` is unchanged. A finished agent's
transcript never changes again, so in practice only the running session's own
file is ever re-read. Measured cold, with nothing cached: a 226-transcript tree
totalling 6.86 billion tokens scans in 1.7 s.

Like the overnight runtime files, `cost.json` is exempt **by name** from
doctor's stray-file check and is seeded into `.tyran/.gitignore` at adoption.
An install that adopted Tyran before this feature should re-run the scanner
once (`node scripts/scan-repo.mjs --ensure-policy`) so the newer entry exists —
otherwise the first run offers you a machine-local file to commit.

**Any** run writes that cache, not only `--json`: a plain `cost.mjs` invocation
does, and so does every `GET /cost.json` the served board makes, which is what
makes a page refreshing every thirty seconds affordable. It is the one thing
`board.mjs --serve` writes, and it is a gitignored runtime artefact — no
journal, no projection, nothing committed.

Three ceilings are refusals rather than crashes: a transcript over 512 MB is
refused by name, a single line over 8 MB is abandoned and counted instead of
accumulated, and a record whose JSON will not parse is counted as malformed.
One pathological record must not turn a read-only report into an
out-of-memory crash on the operator's machine.

## Limits of this measurement

Stated plainly, because a spend figure invites more trust than it has earned:

1. **It is machine-local.** The numbers describe the transcripts on *this*
   machine. A colleague who ran half the work has half the ledger, and neither
   of you is wrong.
2. **Money needs your rate card.** Without `pricing:` there are tokens and no
   money; with a partial card there are tokens and a partial sum. Neither is a
   bug, and the `unpriced` list says which models were left out.
3. **Attribution depends on a convention.** A ticket reaches a row because the
   conductor wrote its id at the head of the task description. Agents spawned
   by hand, or by an older conductor, land in `unattributed` — a visible
   bucket, never a silent redistribution.
4. **A resumed headless session still counts.** [Overnight mode](overnight.md)
   resumes a session with `claude -p --resume`, and that session appends to the
   same transcript. Its tokens are in the total, as they should be — but they
   are conductor tokens, not ticket tokens, and they land on the conductor row.
5. **Requests are deduplicated by `requestId`, not summed.** The platform
   writes one record per content block and every record repeats that request's
   *cumulative* usage, so the first record of each request wins. Counting them
   all would inflate every number on the page.
