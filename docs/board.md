# The board

One screen that answers "what is going on": every ticket in a lane, every
running agent with its own last signal, and — first, always — the questions
waiting on you. Measured before it existed: answering that question on a real
install meant opening 31 files.

**Moving a ticket IS appending an event.** The board is a projection of the
journal, exactly like `STATE.md`: hand-editing it is drift, `--check` catches
drift byte-for-byte, and the one hand-set state that exists —
`ticket.status` — is itself an event, restricted to the three lanes no
lifecycle event can derive and cleared automatically by the next stronger
one. There is no second source of truth to disagree with the first.

## The artefacts

| file | scope | written by |
|---|---|---|
| `.tyran/state/<init>/BOARD.md` · `board.json` | one initiative | `scripts/project.mjs`, with the other projections |
| `.tyran/state/BOARD.md` · `board.json` · `board.html` | every initiative | `scripts/board.mjs` |

All are GENERATED; all live under `.tyran/state/**`, which the shipped policy
already classes AUTO — no policy change on any install. Freshness has three
layers: the conductor regenerates at every merge (iron rule 1), a
`SubagentStop` probe re-renders after every agent (a probe — a render failure
can never refuse a report), and `doctor --state` reports drift and absence
(`board-absent` is info: every pre-board install has neither file, and a
check that fails on upgrade day gets deleted).

## Lanes, strongest verdict first

A ticket is in exactly one lane:

| lane | derived from |
|---|---|
| `done` | `merge` |
| `parked` · `waiting-operator` · `blocked` | a `ticket.status` override (the closed three-lane set) |
| `waiting-operator` | an open `gate` whose result matches `waiting[-_]on[-_](operator\|owner\|human)`, carrying `question`, `recommendation`, `default` |
| `blocked` | an open blockage (`progress` `state: blocked`) or an `error` naming the ticket |
| `paused-limit` | an open `usage-limit` gate while the ticket has running agents ([overnight mode](overnight.md)) |
| `changes-requested` | the latest `review` verdict is not an approval |
| `in-review` | a `report` with no `review` yet; an approving review awaiting `merge` is annotated |
| `in-progress` | a running agent on the ticket |
| `ready` | declared, every `deps[]` entry merged — an UNKNOWN dep counts unmet, because a typo must refuse to schedule |
| `backlog` | everything else declared |

An ask is raised by one command, which mints its id under the journal's write
lock: `node scripts/journal.mjs ask <journal> <init> --question '...'
--recommendation '...' --default '...' [--ticket T-n]`. The id IS the gate
`kind`, `Q-<n>`. **Do not park an asked ticket** — the override is checked
before the ask, so it overrules the lane and hides the question's own ticket.

## Answering

```bash
tyran answer render --dir .tyran     # writes .tyran/state/ANSWERS.md
$EDITOR .tyran/state/ANSWERS.md      # fill the `answer:` lines
tyran answer apply  --dir .tyran     # closes what you answered, re-renders everything
```

Three words do all the work. **Blank** takes the recorded default, verbatim,
and still records it as a decision — a default accepted is a decision, and the
ledger says which it was. **`-`** leaves the question open for next time.
**Anything else** is your answer, in your words, down to the next `## `.

Questions with no recorded default come first, because those are the only ones
where saying nothing has no safe outcome.

`apply` reads every value it writes — the question, the default, the ticket,
the id — back out of the journal. The sheet is an inbox, not a source: editing
anything except an answer changes nothing. It is all-or-nothing: one
unparseable block and nothing at all is appended, with the line number.

Each answer becomes two events, decision first: a `decision` in your words,
then the closing `gate` with `result: answered`. Decision first is deliberate
— a crash between them leaves a visible orphan decision, never a closed
question whose answer was never written down.

`ANSWERS.md` is generated and then hand-edited, so it is deliberately NOT in
the byte-exact `--check` set: byte-equality is not a property a file you type
into can have. Re-render it at the start of each sitting rather than reusing
the last one — every block in an applied sheet names an ask that is now
closed, and `apply` refuses the whole file rather than appending a duplicate.

## board.html

The page an operator leaves open overnight: self-contained (inline CSS/JS,
no network, works over `file://`), refreshes itself every 30 seconds, and
renders the waiting-on-you queue first, then the agent strip with
signal-freshness colours computed in the browser (the artefact itself never
reads a clock — "as of" is the newest event timestamp, which keeps
`--check` valid for the HTML too). The styling is the landing page's own
stone/gold/glow palette and system font stacks: gold marks the one call to
action (your queue), the glow lights the agent strip, red is refusal (the
PAUSED banner, the blocked lane), green is the ledger's `+` (done).

Hostile journal values cannot break the page: `board.json` is
invisible-escaped, the embedded copy additionally escapes `<`, and the
client builds DOM with `createElement`/`textContent` only.

```bash
node scripts/board.mjs --dir .tyran            # render all three artefacts
node scripts/board.mjs --dir .tyran --check    # byte-exact drift check, exit 1
node scripts/board.mjs --dir .tyran --serve    # localhost viewer, always fresh
```

`--serve` binds `127.0.0.1` only, re-renders per request, and never derives a
filesystem path from a URL. The initiative ceiling is 64, refused loudly —
archive closed initiatives rather than boarding them. An unreadable journal
renders as a visible **UNREADABLE** entry: a board that omits a broken
initiative would read as "all is well" exactly when it is not.

## board.json, schema 1

Fixed key order (`schema`, `as_of`, `totals`, `paused`, `asks`, `agents`,
`lanes`, `errors`); timestamps copied verbatim from events; invisibles
escaped as `\uXXXX`, never removed; byte-identical reruns. Consumers check
`schema === 1` — the HTML shows "regenerate with a newer Tyran" on a
mismatch instead of rendering garbage.
