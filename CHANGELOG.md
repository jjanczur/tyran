# Changelog

## 0.1.41 — 2026-08-18

### The knowledge store can now shrink, and nothing is destroyed to do it

`.tyran/knowledge/` only ever grew. `knowledge.mjs audit` measured the damage
and said, in its own output, that nothing merges overlapping entries — true
since 0.1.35 corrected the three surfaces that had promised otherwise.

The producer everyone was waiting for turned out to be the wrong thing to
build. **`supersedes` was already in the schema, already documented, and read
by nothing.** Making `selectEntries` honour it turns a merge into an *append*:
write the entry that states the fact once, name the ones it replaces, touch
nothing else. The replaced entries stop reaching briefs immediately and keep
their bytes, their provenance and the counters they earned over months —
because no file holding them was edited.

That shape is the whole safety argument, and it is why no verifier shipped
alongside. A bad merge is not a lost history to be prevented by review; it is
one file to delete, after which every retired entry comes back whole.
Conservation checks — counters summed, provenance carried across — guard a
*lossy* merge that appending does not perform, and they cannot express the
risk that actually exists: the merged sentence dropping the important half.
Certifying the arithmetic while the meaning evaporates is the expensive kind
of false assurance.

**`supersedes` had to widen to a list first**, and that is probably why nothing
was ever built on it: as a scalar, a merged entry could retire exactly one
predecessor, so an N→1 merge — which is what consolidation *is* — could not be
written down at all. An entry may not supersede itself (the validator refuses
it; a flat suppression set would otherwise hide the entry carrying the
reference), and a mutually superseding pair hides both, so `audit` names those
rather than teaching the selector graph theory.

**No script decides which entries say the same thing.** That is a judgement and
it stays the retrospective's — text-similarity scoring was considered and cut,
because on a store this size the agent adjudicating the candidates reads them
better than a token score dominated by shared vocabulary. The line that fell
out is worth keeping: *a script may count a judgement already recorded; it may
not perform one.*

Which is what licensed the other half. `used`/`helpful`/`outdated_reports` are
report verdicts — recorded judgements — and three surfaces already instructed
an agent to retire entries on their evidence while **nothing computed it**: the
same unimplemented-promise defect as 0.1.35, one field over. `audit` now names
the candidates: reported wrong more often than helpful, or delivered three
times or more and never once helpful. An entry delivered *once* is never a
candidate; that is absence of evidence, not evidence.

The most useful line it prints is the degenerate one. The counters are
maintained only by a model hand-editing YAML at retro close, so if that fold is
not happening every entry reads `helpful: 0` and the rule would flag the entire
store — confidently, on nothing. A store with no counter evidence now reports
**that** instead, and flags nothing. Evidence is asked of the whole store
rather than the live part, or consolidating the one counter-bearing entry away
would flip the report to "the fold is not happening" — a strong claim, and
false.

Also: a duplicate entry id **across two files** went undetected, because the
validator allocates its id set per document and runs per file. It matters more
now that `supersedes` names an id — an ambiguous one retires whichever entry
the loop reached first. `loadEntries` refuses it through the channel `brief`
and `audit` already treat as loud.

That refusal is why it also earns a doctor finding, `knowledge-duplicate-id`
(error). The intent had been to add none — an overlap or staleness backlog is
a judgement queue rather than a malfunction, and would be red on every mature
store forever, which is the shape people learn to skip. A duplicate id is the
opposite: never red on a healthy store, and a genuine break. Without it doctor
reported a **healthy** repo whose every handoff got no brief at all, since
`brief` exits 1 on a store that does not validate. A gate that cannot fire is
the thing `doctor --state` exists to catch, so it could hardly be the thing it
stayed quiet about.

`doctor --state` counts live and superseded separately; pairing a
live-only reachability with an on-disk total would have printed "1 of 3 can
reach a brief; 0 cannot".

Both guard tests from 0.1.35 were **retuned, not removed**. The one banning
`/consolidat/i` from the audit was a proxy that expires the moment the step
exists, so it now asserts the property directly: the audit may describe the
mechanism only while a brief genuinely stops delivering a superseded entry —
checked by running a brief, not by grepping for a function name. The one
gating doc prose on an unimplemented feature had an escape hatch by design;
letting it fall silent would have traded a real guard for none, so it now
asserts the two self-improvement surfaces agree line for line. The original
defect was never that the claim existed — it was that one claim lived in three
places and drifted.

### A finding names the command behind it, not a sentence about one

A `finding` carried `claim` + `proof`, and `proof` is prose — so the journal
recorded *"the parser rejects block scalars"* rather than anything the parser
did. That is a claim standing where evidence should be, which is the thing the
evidence gate already refuses in an implementer's report. Findings had a pass
on the same rule.

`finding` events now take **`command`** and **`exit_code`**. Both optional,
both projected into `STATE.md`'s Findings table.

**The ask was for the raw OUTPUT, and that was the expensive framing.** Three
things changed the answer. A stored output is a snapshot that rots and can
never be re-checked, while a command can be re-run by anyone who doubts the
claim. What the ask actually wanted was proof that a command ran at all —
which is the command and its exit code, not the bytes; on a long command the
bytes are noise. And the payload-size objection that made this an S–M turned
out not to exist: the cross board already carries findings as a **count**, and
the per-initiative `board.json` carries none. **Neither byte-compared artefact
changed** — verified by the goldens, where `BOARD.md` and `board.json` came
back byte-identical and only `STATE.md` moved. A test now states that rule for
`command` too, because it is the one field somebody will be tempted to promote
onto a card.

`command` is capped at **500** codepoints, an order of magnitude tighter than
the prose keys, and the number is measured rather than picked: this repo
documents 86 shell commands, median 74 codepoints, longest 123. Wide enough
for any real pipeline; too narrow to smuggle pasted output into a committed
file. Rejected at append, never truncated, like every other capped key.

The prompts had already got ahead of the schema — `agents/implementer.md`
tells an implementer to journal each dead hypothesis *"with the command output
that killed it"*, and `tyran:verifier`'s entire report is `command · exit code
· counts`. There was nowhere structured for either to land, so it went into
`proof` as prose. Now it has a home, and the implementer, verifier, scout,
reviewer and conductor prompts say so in one sentence each.

**What this does NOT do.** It does not tell a real command from an invented
one. A recorded command is still the agent's word — the same limit the
evidence gate prints about itself: *it blocks silence, not forgery.* What
changes is that the word is now specific and re-runnable instead of prose.
Verifying a command against the platform's own transcript is designed and
deliberately unbuilt; `NOTES-REQUESTS.md` §12.3 records the mechanism so it is
not re-derived.

Doctor gains **`finding-no-command`** (info): findings whose proof is prose
alone, counted and named. Info and not warning because every finding written
before this release predates the keys, and a check that goes red on upgrade
day is one people learn to skip. It is never a refusal — `journal.mjs` still
requires only `area` + `claim`, and a finding from reading code legitimately
has no command.

## 0.1.40 — 2026-08-17

### Every session pays for these sentences, so they got shorter

Fifteen of the nineteen descriptions — ten skills, five agents — rewritten to
carry only what routes: what it does, when it fires, the one distinguishing
mechanism. The justifications live in the bodies, which load only when the
skill fires. Skill total: **4352 → 3868 of 5000** (measured by the same CI
guard that enforces the cap); the agent descriptions, which the Agent tool
loads into every session the same way, shed a similar fraction.

Nothing lost its trigger — `prompt-tuning` GAINED one (it was the only
description with no "use when" clause), and `run`'s now names the kanban it
drives the team from, which 0.1.39 made true.

## 0.1.39 — 2026-08-17

### A fifth agent, and the conductor plans from the board it shows you

The operator challenged all three of 0.1.38's "deliberately NOT added" calls.
Two survived the challenge with their reasons intact; one did not, and the
verifier is the result.

**`tyran:verifier`** — mechanical validation on the cheapest tier. It runs
exactly the commands it is handed, reports exit codes and counts verbatim,
compares them against the last green baseline, and never edits, fixes or
theorizes. A red suite is its product, not its failure. The routing table
already priced this mode (`bookkeeping` at cheap in every profile); nothing
ran on it. Now the conductor's merge-time validation is delegated like
everything else — a full suite bills the same tokens whoever runs it, and
running it in the conductor's context spends the plan's own memory on
watching a progress bar. The evidence gate binds it hardest of all
(`enforce`): a verifier report without raw output is a verifier that
verified nothing. A guard test pins the empty tool grant, and the prompt
owns the absence in a sentence a future "helpful" edit would have to delete.

**The conductor now plans FROM the kanban, moves tickets on it, and knows
the operator is watching the same one.** It wrote the board and never read
it: the `ready` lane IS the schedulable set (a ticket lands there only when
every dependency is merged), `blocked` and `changes-requested` are the
re-route queue, and distributing work from memory is how two agents get one
story. Moving a ticket is appending an event — the lifecycle moves the
working lanes on its own, `ticket.status` (with a reason) parks, blocks or
hands to the operator, a newer override replaces an older one, and the next
lifecycle event clears it. And there is only ONE board: the dashboard the
session autostarts runs the same fold over the same journals, so a moved
ticket is on the operator's screen within one refresh — narrating board
state in chat that the journal does not hold reads as either a stale
conductor or a broken board.

**Cards say who is on them RIGHT NOW.** The card face showed the historical
name list — "who ever touched this" — while the operator's question on a
large ticket is "who is doing what". Live agents join onto cards by
initiative AND ticket (two initiatives' T-3s never claim each other's
workers), state-coloured, with BLOCKED said out loud; the historical list
survives only when nobody is on it now, and the run-by-run record stays in
the detail panel's execution table.

The other two challenges, answered rather than deflected: no new skill —
the CI cap can indeed be raised, but the barrier was never the cap, it is
that no repeated need has graduated yet (the verifier is an agent precisely
because its protocol is its prompt); and no peer-to-peer evidence channel —
teams mode already gives peer NOTIFICATION, and evidence stays in the
journal because a teammate message dies with the session while the journal
survives compaction.

Surfaces corrected on the way: README's pitch and both agents-page tables
still carried the pre-forfeit reviewer ("no editing tools"), wrapped across
a line break where the earlier grep missed it.

## 0.1.38 — 2026-08-17

### The conductor is a project manager, and the prompts now argue it

A full review of all five prompts against one standard: one coordinator
talking to the stakeholder, everything else delegated, agents collaborating
like an engineering team. Seven changes, each at a measured gap; nothing
tuned to any one repo.

- **The conductor's header** opens "a project manager, not a pair of hands"
  and states the reason: its context is the one place the whole plan lives —
  measured once on Tyran's own development, 55% of every token spent was the
  conductor's context — and what the operator buys is knowing what is done,
  running and stuck. A conductor buried in a diff knows none of it.
- **M-sized work defaults to one implementer.** "Yourself or one implementer"
  was a coin flip; now doing it yourself requires the diff to be plainly
  smaller than the handoff that would describe it, recorded as a `decision`.
  S stays do-it-yourself: spawning an agent for a two-line fix is the cost
  the "principal engineer on a grep" line argues against.
- **Escalation has a rule on both sides.** Implementer: two refuted
  root-cause hypotheses is the timebox — signal `blocked`, journal the
  ruled-out list as a `finding` with the output that killed each hypothesis,
  hand back; handing back early with evidence is not failing the story.
  Conductor: BLOCKED after a real root-cause attempt, or `changes-requested`
  twice, re-routes UP (effort first, tier when the ladder allows —
  `tiers.mjs --journal --ticket` has counted attempts since 0.1.27; no
  prompt ever said when to use it) with the ruled-out list in the new
  handoff, so the stronger agent starts past the wall.
- **The reviewer can now load the skills it is ordered to follow.** Its
  allowlist had no `Skill` tool, so "follow the code-review skill" meant
  reconstructing it from memory. A skill recalled from memory is not
  followed.
- **The reviewer's signal instruction matches the 0.1.36 measurement.** It
  still demanded a `started` emission; the implementer's list was cut to
  blocked-only on one progress event across 388 journals, and the same
  argument governs both — the lease IS started, the review event IS
  completion.
- **Teams mode gets a peer protocol.** When Agent Teams are available,
  teammates coordinate directly — implementer asks the scout for a map,
  adjacent stories settle a shared seam — but anything worth keeping still
  goes through the journal: a teammate message dies with the session, and
  the board shows only what the journal holds.
- **Three surfaces lied about the reviewer.** README and both FAQ pages still
  said "no editing tools — it cannot patch what it is grading"; that stopped
  being true when `Edit` was granted behind the forfeit rule (touch the diff
  and APPROVE is unavailable). docs/skills was updated then; README and FAQ
  were missed. The §10 audit row records that the code moved past the video,
  and that the video's sentence stays true of the APPROVE path: what it
  approves, it did not edit.

Deliberately NOT added: new agent types (a new agent needs a different MODE;
security-review and arbitration are already roles routing to stronger tiers),
new skills (the description budget is CI-enforced and the graduation path is
evidence, not speculation), and any peer-to-peer evidence channel (journals
stay the medium of record even in teams mode — that is the thesis, not a
limitation).

## 0.1.37 — 2026-08-17

### `--help` reaches the subcommand-style commands too

0.1.36 gave the nine flag-taking commands a `--help` that answers on stdout
with exit 0. The four that dispatch on a VERB rather than a flag still reached
their usage text through the unknown-subcommand path, so `--help` was reported
as a mistake instead of answered — `mistakes --help` opened with *"unknown
subcommand"* before printing anything useful.

`schema`, `knowledge` and `mistakes` now answer it properly. **`journal` does
not yet**, and the reason is worth recording: its usage text is built inside
the error handler as a multi-line expression that also documents every event
and its required `--data` keys. Extracting it mechanically produced a syntax
error, so it is `NOTES-REQUESTS.md` §12.5 rather than a rushed edit here.

One thing this did NOT change, having measured it first. `doctor --state`
exiting 1 and `answer render` exiting 1 on a healthy fresh repo look like
success reported as failure, and they are neither. `answer.mjs`'s header
documents *"Exit: 0 ok · 1 nothing is waiting on you"*, and doctor's codes are
pinned by a test named for them. Both are deliberate `grep`-style "no results"
codes, and no caller in the repo reads them as failure.

## 0.1.36 — 2026-08-17

Four fixes, three of them found by installing Tyran into a clean repo and
walking through what a new user actually gets, rather than by reading the code.

### The first sentence a new install reads was wrong

A brand-new user's opening message ended *"Run `/tyran` to resume, or read
`.tyran/state/<init>/STATE.md` in full."* There is nothing to resume, and
`.tyran/state/<init>/` is not a directory — at that point `.tyran/state/` holds
only `board-server.json`.

A regression from 0.1.34. `renderContext` returned `''` when there was no
initiative and no pause, so that line was unreachable from an empty repo;
autostart added `board` to the guard, `board` is non-null in every adopted
repo, and the whole scaffold began rendering for repos with no state at all.
Checked: a repo that never adopted Tyran still injects `{}`.

The closing line now branches, and names the initiative when there is exactly
one instead of sending the reader to look up `<init>`. The README's dashboard
section was stale the same way — it opened with `--serve`, a command setup made
unnecessary, and taught `--write` as an opt-in flag that setup now writes by
default.

### A board that failed to start deleted the record of the one running

With a board already up, a second `--serve` loses the bind, prints *"port 4173
is already in use"*, and exits — running the `clear` handler `board.mjs`
registers on `process.exit` unconditionally. That deleted the RUNNING board's
record. Measured after: `curl` still answering on 4173, `.tyran/state/` empty,
`--stop` reporting *"no board server is recorded"*. A server serving with
nothing naming it — invisible to `--status`, unreachable by `--stop`, killable
only with `lsof`.

`removeServerRecord` now refuses to unlink a record naming another pid. The
guard is in the module, not at the call site: ownership enforced by whoever
remembers to check is caller discipline, which `journal.mjs` and `doctor.mjs`
both reject by name. `stopServer` passes `owner: null` and has earned it.

Same session, same cause: `--detach --write --transcripts <dir>` against a
running board printed *"already serving"*, exit 0, and applied nothing.
`--transcripts` is the remedy the Spend tab itself prints, so the product
recommended a command that reported success and fixed nothing. The inert flags
are now named, with how to apply them. A plain re-run stays silent — autostart
runs it every session.

### The chip printed spawn time under the words "last signal"

`NOTES-REQUESTS` §11 recorded that four shipped features rest on a `progress`
event that fires once in 388 journals, and that the measurement to decide what
to do had not been made. It has now. Folding **420 real journals**: 72 running
agents on boards, `last_signal === since` for **72 of 72**, never once an actual
signal, with `detail`, `next` and `state: "blocked"` at zero.

`last_signal` fell back to the spawn time, so this was not an empty field — it
was spawn time published under a label saying *"when it last spoke"*, in the
chip, the `BOARD.md` column and the cross-repo line. A blank reads as an
absence; a number reads as a measurement.

The age was worth keeping, so this is a relabelling: the chip measures from
`since` and says *"since it started"*, `BOARD.md` gains a **Started** column,
and a real signal gets its own line when there is one. The golden fixture
missed it because its one agent does signal — the case that is universal in the
wild was the one no fixture covered.

`agents/implementer.md` now asks for **one** `progress` emission, at the first
blockage, instead of four. Three of the four were reconstructable from events
another party writes; a blockage is the exception, because nothing else says an
agent is stuck or why. Deleting `progress` outright was rejected for that
reason — `spawn-blocked` and the `blocked` lane stay.

### Four commands silently ignored a flag they did not understand

Swept every command `bin/tyran.mjs` dispatches, against a repo where setup had
just run:

| | |
|---|---:|
| `--help` answered as help | **0 of 14** |
| silently ignored an unknown flag | **4** |

`tiers`, `scan-repo`, `stop-check` and `desc-budget` parse by looking up the
flags they know, so a flag they do not know is never rejected — it is never
seen. `tiers --rol reviewer` exited **0** and printed the entire routing table:
a different answer to a different question, given without a word about the
typo. One character later, `tiers --role revieweer` was refused by name with
the list of valid roles — the value was checked and the flag was not. Worse,
`scan-repo --wrte .tyran/config.yaml` scanned, printed JSON and exited 0, a
swallowed typo in the one flag that decides whether the command writes.

`scripts/cli-args.mjs` is now the single implementation of both rules, and it
is not a new convention: `board`, `doctor`, `answer`, `cost` and `migrate`
already refused unknown flags, so this is the majority one made importable so
the count of spellings stops rising (ADR-21).

**`--help` is now answered, on stdout, exit 0, by all nine flag-taking
commands.** `cost` needed a second fix on the way: its `main` is handed an
already-sliced argv, so an added `argv.slice(2)` dropped the first two
arguments and `--help` fell through to the parser. The four subcommand-style
commands (`journal`, `schema`, `knowledge`, `mistakes`) still print usage with
exit 2; recorded in `NOTES-REQUESTS.md` rather than fixed here.

### Exercise cloud access, and never ask for a secret's value

Both from `NOTES-REQUESTS` §12.4. STEP 0 already spawns a throwaway teammate
rather than infer that Agent Teams work; cloud access had no such rule, and a
missing permission surfaces at deploy — after the work. It is now exercised
with a read-only call per service the plan names.

And a gate must never ask for a credential's VALUE: `journal.mjs ask` writes
the question into the journal and `answer.mjs apply` folds the reply back as a
`decision`, both into a committed file. Ask where it lives — the SSM parameter
name, the secrets-manager key, the vault path.

## 0.1.35 — 2026-08-17

### Three surfaces promised a consolidation step that nobody implements

`knowledge.mjs audit` printed, in its own output, *"/tyran:retro
consolidates, writing a NEW file for review"*. Both doc surfaces said the same.
Grep `skills/retro/SKILL.md` and `agents/retro.md`: there is no consolidation
step in either, and no such file has ever been written.

A tool that names a downstream step BY NAME is the last place a reader will
doubt it, which is how this survived on three surfaces at once — worse than
ADR-21's three spellings of one answer, because it is three spellings of a
NON-answer.

What the retrospective really does to `.tyran/knowledge/` is counter upkeep:
it folds each report's knowledge-brief verdicts into the entries' counters,
retires an entry the counters have written off, and splits one `doctor --state`
flags as `knowledge-entry-oversized`. **Merging two overlapping entries is
still yours**, and all three surfaces now say so.

Two tests, because correcting one surface was never going to be enough: the
audit's own output makes no such claim, and either doc growing it back fails
while `scripts/` has no consolidation — stepping aside automatically if
someone builds it, so the test blocks the false promise without blocking the
feature. It stays specced in `NOTES-REQUESTS.md` §12.2.

## 0.1.34 — 2026-08-17

### The dashboard starts itself

The board was reachable only by a human typing a command that never returns.
On every install where nobody typed it, each projection Tyran writes was
generated and read by no one.

`board.mjs --serve` blocks forever, which is right for an operator at a prompt
and fatal for everything else. Setup's "turn the dashboard on" step handed an
**agent** that command: measured, still listening three seconds after spawn
with nothing to return — so the tool call sat until the platform's timeout and
setup's remaining steps (validate, report, ask for the `.tyran/` commit)
silently never ran.

```bash
node scripts/board.mjs --dir .tyran --detach --write   # returns; prints the URL
node scripts/board.mjs --dir .tyran --status           # where is it?
node scripts/board.mjs --dir .tyran --stop
```

`--detach` is the same server, waited on only until it answers. A new `board:`
block in `.tyran/config.yaml` defaults `autostart: true`, so every session
brings the board up if it is not already running and prints the URL in its
opening summary. `limits:` defaults off because off is *inert*; a board that
never starts is not.

**Liveness is an HTTP question, never a recorded pid.** `/health.json` names
the `.tyran` directory it serves, and a caller believes it only if that
directory is its own. Both halves are load-bearing: a pid written by one
process and read by another is dead before it is read and, once the OS
recycles the number, names a stranger — while probing only the *port* finds a
**different repository's** board (same program, same route) and concludes this
one is already up, so it never starts. Ports walk 4173–4182, so several repos
each get their own.

`TYRAN_NO_BOARD=1` turns it off machine-wide, for CI: an automated run clones a
repository whose committed config says `autostart: true`, has no browser and no
operator, and a detached server started by a build outlives the build.

### The commit, the reviewer and the model reach the card

Measured across **387 real journals and 1799 lane cards**: 1243 carried a merge
sha and 1074 a review verdict that no surface displayed.

Nothing looked broken because the **lane encoded them** — `done` means merged,
`changes-requested` means a non-approving review. The board was right, and
could not show its work. Selecting a card now shows the commit, the reviewer
and when, plus an **Execution** table: agent, model, start, verdict. That last
column is the half of "what did this cost me" the Spend tab cannot answer —
Spend gives dollars per ticket, this gives what was spawned to earn them.

The worst real `board.json` grows 57 KiB → 84 KiB. `BOARD.md` is byte-unchanged.

**Upgrading: one expected `--check` drift**, the same shape as 0.1.33's. Cards
gain `review`, `merge` and `execution`, so a `board.json` committed by an
earlier version no longer matches. Clear it with one regenerate:

```bash
node scripts/board.mjs --dir .tyran   # then commit the three artefacts
```

`doctor --state` is silent about it; the only surface is an explicit `--check`.

### A feature deliberately not shipped, and the measurement that killed it

While specifying a `spawn-silent` doctor finding — an open agent that has
never said anything — the count came first. Across 388 real journals the
`progress` event appears **once**, against an instruction in
`agents/implementer.md` asking for four per story (roughly 6000 expected
against 1532 spawns).

So `spawn-silent` would fire on 100% of open spawns: the always-on warning
`SEVERITY_BY_CODE` already refuses by name. It is not shipped.

Agents are not ignoring the journal — 5302 gates and 4585 decisions — and not
ignoring that file: the `lease.acquired` instruction one bullet above produced
434 events. Four shipped features rest on the dead event and are inert on every
real install: `spawn-blocked`, the `blocked` lane, the agent chip's state, and
the signal half of "signal is not evidence". `NOTES-REQUESTS.md` §11 records
three options and the measurement that would decide between them.

## 0.1.33 — 2026-08-17

### The board was hiding what its own journal already knew

Three directory slugs and one blended percentage. The journal has carried a
written title since it existed — "The kanban board: one screen that answers
what is going on" — and `crossBoard` summed every initiative's progress before
throwing the parts away, so an operator reading "47%" across three slugs could
not tell which was nearly done from which had not started.

Each initiative now has its own row: title, progress, and how many questions
it is waiting on. The payload reads no clock — it ships `last_ts` and the page
ages it — so `board.mjs --check` stays byte-exact.

**This replaced an archive feature, on measurement.** Across 63 distinct real
journals only 6 were finished-and-archivable while **43 were waiting on a
question nobody had answered**. The board was never cluttered with completed
work; it was full of ABANDONED work. Archiving would have touched under 10% of
initiatives, left the 64-initiative ceiling exactly where it is, and — since
archivable means 100% merged — pulled the headline percentage DOWN.

**Upgrading: one expected `--check` drift.** The payload gains a top-level
`initiatives` key, so a `board.json` committed by an earlier version no longer
matches what this one generates. Measured: `board.mjs --check` exits 1 once on
an upgraded install and 0 after a single regenerate —

```bash
node scripts/board.mjs --dir .tyran   # then commit the three artefacts
```

`doctor --state` is silent about it either way; the only surface is an
explicit `--check`, which matters if you run one in CI. The board `schema`
stays 1 because nothing about the existing keys changed, the same call made
when `errors_logged` was added.

### Two more things that had never worked and said nothing

- **`/run.json` never carried a reset time.** `pickWindow` tested
  `typeof resets_at === 'string'` while every writer produces epoch SECONDS,
  so it returned null for every real payload it was ever given: the run panel
  could say a pause was in force but never when it would end. Live since the
  feature shipped.
- **The closing checkpoint had no producer.** The projection has closed every
  still-open spawn on `checkpoint phase=closed` since 0.1.31, and nothing ever
  emitted one — 9 of 63 real journals had one. So an agent that finished weeks
  ago still read as live work. The conductor is now told to write it, including
  when an initiative ends because it was ABANDONED, and the test executes the
  command rather than grepping for it.

`runState` also reports `limits_mode`: "the gate cannot see" and "the feature
was never switched on" are different facts with the same symptom.

### An ask offers its recommendation as one click

It was shown as text, and the only way to accept it was to retype it into the
box beneath it. For an operator who is not an engineer, that gap was most of
the difficulty of the page. The button fills the box rather than submitting,
so the wording stays editable and the answer stays deliberate.

### Findings are pointed at, not copied

Measured across 63 distinct journals: 3 carry any finding, 49 in total, and
none names a ticket — so they cannot enrich a card. Median claim is 429
characters and `STATE.md` already renders the full table. The initiative row
carries a count when it is non-zero and nothing else; a test forbids `claim`
or `proof` reaching the byte-compared payload.

## 0.1.32 — 2026-08-17

### Overnight mode could never fire, on any install

The pause depended on `.tyran/state/usage.json`; only the statusline writes
it; the statusline writes only when the platform payload carries
`rate_limits`; and that block is not always sent. Measured on an install
running `limits: mode: 'pause'` — **no sidecar had ever been written anywhere
on the machine**, so the configured pause had never once been able to fire.
The gate fails open, which is why nothing ever said so.

The gate now falls back to the platform's own cache in `~/.claude.json`, which
also removes the one onboarding step no script can perform: registering a
statusline means writing the operator's settings file, and the plugin is
refused there by design.

**A stale reading is acted on, deliberately.** That cache is refreshed on the
platform's schedule — measured 83 minutes old during continuous heavy use — so
under the gate's ten-minute freshness rule it would be discarded every time.
It is sound because usage inside a window only ever goes UP: a reading taken
inside the window that is still running is a LOWER BOUND on usage now. If it
already says 97%, the truth is at least that and pausing is correct; if it
says less, the gate may fail to pause, which is exactly today's behaviour and
the safe direction. A reading whose own `resets_at` has passed is discarded —
that check is what makes the rest safe. Pauses derived this way record
`lower_bound: true`, because "at least 97%" is a reason to stop and never a
reason to start.

Verified against live telemetry: at the shipped 97% nothing trips (the account
was at 32%/68%); at a 30% test threshold the weekly window trips with the
correct resume time.

`SIDECAR_RELPATH` had three spellings and `SIDECAR_FRESH_MS` two, across the
writer, the scheduler and the gate. Nothing fails while they agree, and when
they stop agreeing the symptom is a pause that silently never fires — the bug
above. They collapse into `scripts/usage-source.mjs`.

Only the two usage windows are read from that file. It also holds the account
uuid and the email address; a test asserts neither reaches the output.

### Three lifecycle leaks, each measured on real journals first

- **`lease-expired` was dead code that looked alive.** It read
  `expires`/`expires_at`/`until`; across every journal on a real machine agents
  wrote **`expiry` 33 times against `expires` 3**, so 33 of 36 recorded
  expiries were invisible.
- **The schema flagged the field that would have made it work.** No expiry
  spelling was in `DATA_KNOWN`, so recording one tripped `journal-key-unread`
  — the ledger reporting an agent's own diligence back as an anomaly. Same for
  the descriptions agents attach: `purpose` 28, `story` 21, `text` 21.
- **Worktrees accumulate and nothing had ever looked.** No removal path exists
  in any skill, agent or script, and the journal has no event that can
  represent one being destroyed. Measured: **26 worktrees in one repository,
  33 GB under another's `.worktrees/`**. New `worktree-accumulating` warning
  above a ceiling of 8 — a handful is the parallel model working as designed.

  It **reports and does not remove**. Most of those worktrees hold work that
  never CONCLUDED rather than work that finished, so removing the merged ones
  would clear almost nothing while being able to delete something wanted.

### Spend answers "how much", with no configuration

The Spend tab could say how many tokens and never how much: `pricing:` was
hand-authored, the scanner never writes one, so absent was every install.

The published list prices now ship as `list-2026-08`. Cache rates are
published as fixed multiples of base input (1.25x, 2x, 0.1x), so only input
and output are written down and a test checks all fifteen rows against an
independently transcribed table. Overriding is per MODEL, not all-or-nothing.

This reverses an earlier rule — "Tyran does not know what anyone pays" — which
conflated two quantities. A subscriber's marginal cost is zero and unknowable;
what the tokens would list-price at on the API is published and fixed. The
reversal is conditional on the figure never claiming to be the other, so
`rate_card` still travels with every amount.

**Cache writes are billed at two rates and were counted as one.** A 1-hour
write costs 2x base input against a 5-minute write's 1.25x, and the transcripts
carry the split. Reading both the aggregate and the split would double-count,
so exactly one is read — verified across 1168 consecutive live records where
the two summed to the aggregate every time. Measured on 1.8 B real tokens: the
1-hour line is $175 against the 5-minute line's $70.

**A window you choose, because a plan is billed monthly.** `--window
30d|period|all`, and three buttons on the tab. `30d` is the default since it
needs nothing from the account; `period` runs from the subscription
anniversary and is offered only when that date is readable. The anniversary
arithmetic clamps short months — a subscription created on the 31st has no
31st in February, and naive maths yields a period that has not begun.

The plan price sits beside the API figure, and the multiple is shown only
under a month-shaped window: measured, an all-time total read as "6.9x what
you pay" where the honest monthly figure was about 11x.

**A per-day series**, which this page never had — every other view is a
snapshot, so nothing could answer "am I getting cheaper". It shows the full
history whatever window is selected, since a chart that shrank with the window
could not show you that last month was worse.

### The reviewer can fix what it finds

The property worth protecting was never "a reviewer cannot type" — it is that
nobody approves their own code, and those come apart. The reviewer holds
`Edit`, and the verdict is three-valued: a diff it touched can only come back
`REVISED`, which still owes a second read, and that read is cheap because the
fix is already written. No `Write` or `NotebookEdit`: authoring files is
designing, not reviewing.

An open operator ask now goes in the verdict LINE. Field-measured: a reviewer
raised a gate inside the body of an APPROVE, the conductor read the first
word, merged, and the question sat unanswered for thirty minutes.

**Subagents could not reach MCP at all.** `tools:` is an exhaustive allowlist,
so naming six built-ins silently stripped every `mcp__*` tool from the scout
and the reviewer — the scout's own description promises reconnaissance over
"its data", which was unreachable. Grants stay gated: write-guard's matcher
already carries `mcp__.*`.

### Two gate refusals that were wrong

- A backslash-escaped separator started a new segment, so `grep -nE 'A\|B' f`
  split in two and an ordinary read was refused. `\<sep>` is never an operator
  in any shell quoting context — verified against `/bin/sh` with a side-effect
  oracle over 34 join constructions, zero divergences. The lexer stays
  quote-BLIND on purpose: a naive quote tracker is broken by one apostrophe,
  which swallows a `;` and makes a `git push` invisible to the deployment
  check.
- `^id_[a-z0-9]+$` was really "any identifier starting with id_", and these
  rules run over every literal WORD of a command — so `ID_ISSUED` and
  `ID_TOKEN` were refused as ssh private keys. Now anchored on OpenSSH's own
  key-type names, keeping hardware keys and per-host suffixes. Declared cost: a
  key with an invented stem is no longer matched by name, though `.ssh/` still
  catches it and so does gitleaks at push.

### Setup asks one question, in words a non-engineer can answer

Sales and marketing people run this now, and four entries shaped
`field: source` is where they stop. The scan carries a `plain` object: one
question, its evidence restated without jargon, at most two options, and a
list of what the repository already answered. P3 is not offered — a menu makes
every item look like a normal choice, and it stays something a person says in
their own words.

### Installation reaches the dashboard now

Install was four steps, a restart, and then a board nobody opened. Every one
of those is a place to stop, and the last one mattered most: `--serve` printed
a URL to a terminal and **nothing ever launched a browser**, so the screen
where Tyran becomes legible was the one thing installation never reached.

`install.sh` does everything a machine can:

```bash
curl -fsSL https://raw.githubusercontent.com/jjanczur/tyran/main/install.sh | sh
```

Node version check first, because every hook shells out to `node` and an old
one does not fail at install time — it fails later as a gate that cannot run,
which is the hardest thing for a non-technical operator to read. Then the
plugin, then the pinned scanner, then the prompt to paste after the restart.

The restart is the one step that stays manual and it is not a shortcut not
taken: Claude Code loads plugins at startup and nothing inside a session can
make the app reload itself. So it is stated plainly and put last.

`board.mjs --serve --open` launches the browser, best-effort and never fatal —
a headless machine or an SSH session leaves the server running and the URL
printed, exactly where things were before. `--open` without `--serve` is a
usage error, like `--write`.

Setup gained two steps: install the scanner before anything needs it, and
**look for pre-existing secrets before the operator hits them**. A repository
whose history already holds a key is common, and the gate handles it badly by
surprise — nothing is scanned until someone edits that file, and then every
commit touching it is refused, permanently, for a reason years old. Setup now
says what is there and explains the choice, including the part that is easy to
leave out: a tracked baseline makes the tool quiet, it does not make the key
safe, and if the repo is public that key is already burned.

### The knowledge store was write-only, and nothing said so

Measured on a real install: `knowledge.mjs brief '**'` returned **1 of 31
entries**. The other thirty were dropped by the 4000-codepoint budget, and
104,178 codepoints of hard-won detail — migration-number races, TEST/PROD
schema drift, a deploy gate that silently blocks on the commit author — had
been accumulating for months and reaching nobody.

That is the opposite of the failure people expect from a growing store. It is
not expensive to read; it is **unread**, while growing without bound.

Every piece of the machinery was already correct and none of it added up. The
budget is deliberately the pressure that keeps entries scoped. Each brief
already names what it omitted. `doctor` already warned per oversized entry —
five times on that install. What nobody had was the total, and five local
tidy-up notes are not the same message as "your knowledge store is 97%
unread". Only the second one gets acted on.

`knowledge.mjs audit` reports it: how many entries could reach ONE brief, how
many could not, and — the diagnostic that matters most — which entries are so
wide they cannot appear **even alone**, where no budget any caller passes will
ever reach them. Eight of that install's thirty-one are in that state; the
widest is 10,210 codepoints, two and a half times the whole budget.
`doctor --state` carries the same number as `knowledge-store-unreachable`
(`info` — a store outgrows the budget in the ordinary course of being useful).

It measures and never edits. Which of two overlapping entries is the true one
is a judgement, and a script that guessed would delete exactly the detail the
store exists to hold — so consolidation is a retrospective step that writes a
**new** file for review and leaves the original untouched.

### The prerequisite that blocked day one

The secrets gate refuses every commit and push until `gitleaks` exists, and
it refuses rather than warning for a reason that has not changed. What had
been left with the operator is the *installing*: some people adopting Tyran
have no Homebrew, no admin rights, or are on Windows, and their realistic
answer to "install it and re-run" is not a safer repository — it is switching
the hook off. A gate nobody can satisfy protects nothing, which is the same
argument that made `.tyran/config.yaml` AUTO.

`scripts/ensure-gitleaks.mjs` fetches it: pinned version **and** pinned
SHA-256 per platform, taken from the release's own checksums, which is the
thing `ci.yml` has always done moved to where a user can reach it. A mismatch
deletes the download and installs nothing — this writes an executable that
something else later runs, and a scanner that has been replaced reports clean
on everything.

It installs to `~/.tyran/bin/`. The first version of this put it under
`<repo>/.tyran/bin/`, which is worse in a way worth recording: a path inside
the repository travels with a clone, so a planted binary reporting clean on
everything would arrive **with the checkout** — the attack the tracked-only
rule for `.gitleaksignore` already prevents, reopened through a file that is
not even in a diff. Under HOME the scanner is the operator's machine, exactly
like PATH, and one install serves every repository on it. PATH is still
consulted first: a gitleaks you installed yourself is never silently
displaced by whatever version this repo pins.

### Writing a prompt is now a top-tier job

`retro` was routed at `work` and reached `deep` only under `--profile full`,
so the agent that writes skills, agents and prompts — the text every later
session obeys — ran on the middle model, and `--profile eco` kept it there.

A new `authoring` role sits at `top` at every profile, with `top` and `max`
floors under it. Separated from `retro` rather than raising the whole of it,
because retro does two unlike things with one agent: folding a ledger, which
the middle model does fine, and authoring. The argument is `security-review`'s
in a stronger form — a bad security verdict costs one merge, while a bad
prompt misroutes every run that reads it for as long as it ships, and it is
the one output nothing downstream checks, because a skill that reads plausibly
passes review.

### A duplicate ledger id is refused

Measured in the field: two implementers running in parallel each worked out an
id for themselves, both were honoured, and the ledger kept two `F-7`s. History
is append-only, so "see F-7" stays ambiguous forever and nothing detects it
later.

`append` now refuses a caller-supplied `id` that is **already used for that
event type**. Deliberately not the broader fix of refusing every explicit id:
that removes a documented capability — an explicit id still wins, and a test
pins it — to prevent a failure that only occurs on collision. A fresh explicit
id still passes, `ticket.created` is unaffected because its ids come from the
plan, and the check runs under the write lock so two concurrent writers cannot
both pass it.

### Refusals you can paste

The multi-remote push refusal is correct — excluding commits present on ANY
remote let a key held on a private upstream reach a public origin unscanned —
but it was reported twice, from two installs, as a false positive, and both
reporters routed around it instead of satisfying it. The old text handed over
`git push <remote> <branch>`, a shape to translate rather than a line to run.

Everything needed to write the real command was already in hand, so it is
written: one runnable line per remote, with the branch filled in.

### Reviewers stop retyping evidence

`tyran:reviewer` has no MCP tools, so a database row or an API response
someone else fetched reaches it as text in a handoff — and text in a handoff
gets retyped. Measured on a production run: **1.6% of hand-copied values were
silently wrong**, which makes a reviewer that mistranscribes evidence worse
than no reviewer, because the verdict carries authority the numbers do not.

The roster is unchanged, because it cannot express the fix: `tools:` is a
static list shipped in the plugin and MCP tool names differ on every install.
The prompt closes it instead — require the raw bytes on disk and `Read` them,
rather than reasoning about a retyped copy. A value read from a file is
evidence; a value pasted into a sentence is a claim about evidence.

## 0.1.31 — 2026-08-17

Seven things the journal had recorded and nothing was reading. The theme is
one defect wearing different clothes: an answer that was available, a
consumer that never asked for it, and a surface that reported confidence
instead of the gap.

### Four things the fold recorded and threw away

Each of these was a question an operator asked the board, got a confident
answer to, and the answer was wrong in the same direction: everything looked
fine.

**An agent the initiative moved on without now reads `stale`, not `running`.**
Nothing in the projection ever downgraded a spawn, so an agent that never
reported stayed `running` in every artefact for as long as the journal
survived, and the board's header counted week-old ghosts as live work. Doctor
had been calling those same spawns abandoned the whole time, from the same
events — two answers to one question, which is the defect ADR-21 is named
after and which `pairSpawns` had already been through once for the adjacent
question of who is still working.

There is now one predicate, `journal.spawnStaleness`, and both consumers call
it; doctor's copy is gone rather than kept in sync. It could not live in
doctor, which imports the projection, so it sits in `journal.mjs` beside
`pairSpawns` where both already reach.

The threshold is journal time — measured against the initiative's own latest
event, never the wall clock. That is what `spawn-stale` has always meant, and
it is the only version that keeps `board.json` byte-exact under `--check`.
`blocked` still outranks `stale`, because that is the agent's own account of
why it stopped. The `age-fresh/warm/cold/dead` colours on the page are a
different question and keep their own vocabulary: an agent can be quiet for
hours without being stale, and stale while chattering every minute.

**A closing checkpoint closes the spawns it leaves open.** No event type
closed an initiative, so one could be explicitly wound up with three agents
that never reported still running forever. `checkpoint` with `phase: closed`
— the one reserved value in an otherwise free-text field — now closes that
initiative's still-open spawns at fold time, and only the ones folded before
it, so an agent spawned afterwards keeps its own lifecycle. They are closed,
never reported: no verdict is invented for an agent that never filed one, and
each is named in the warnings rather than tidied away.

**A gate that passes after refusing no longer erases the refusal.** Results
are keyed by `kind`, so a re-run won the slot, and *"security denied this,
then someone re-ran it green"* rendered identically to *"security has only
ever passed"*. The event count always survived, so the volume was never lost
— only the verdict. The last refusal is kept beside the current result and
gets its own column in `STATE.md`. A refusal is a named set (`deny`, `fail`,
`rejected`, …) rather than "anything that is not a pass": the first draft was
the latter, and the demo fixture caught it at once, marking every `open` gate
as carrying a permanent objection it had never raised.

**A report carries what the agent said, not only its verdict.** `decision`
folds its `text` and `gate` folds its `evidence`; `report` was the one carrier
of description that wrote to nowhere, so a `changes-needed` card reached the
board with the reason it came back discarded at fold time. One field reads
`text`, then `note`, then `evidence`, because agents improvise the key.

The board header now says *open* rather than *running* and names the stale
count beside it — the agents are still counted and still in the strip, but an
open spawn and live work are not the same fact and the tile was asserting the
second from the first.

### The two findings doctor could only ever report

`state-legacy-initiatives-dir` shipped with a remedy that read "relocate the
contents by hand, one initiative directory at a time". That is advice, not a
remedy, and the installs carrying the finding are by definition the ones
nobody has touched since 0.1.8. `scripts/migrate.mjs` does the move.

It is explicit and never automatic, because it MOVES an append-only history
rather than seeding a file that does not exist yet — the same reason it is not
a step inside setup. It previews by default and does nothing until asked twice.
It never overwrites: a name that already exists under `state/` is a conflict,
reported and skipped and left untouched on **both** sides, because merging two
directories that share a name is a decision only the operator can make and
making it silently would destroy the evidence needed to make it correctly. It
never deletes anything it did not itself empty. It is idempotent, and it exits
1 while any conflict stands, so an automated caller can tell "done" from "done
except for the part that mattered".

**`mistakes-file-missing`** (`info`) splits an absence that used to be one
thing. Deleting `MISTAKES.md` is the documented opt-out and still produces no
finding at all — a tool that nags about a file you deliberately removed is a
tool you switch off, and that would cost the gates sitting next to it. But an
install created before the ledger existed never declined anything; nobody
offered. Git is the only witness that can tell those apart, so the finding
fires only where git can answer AND has never seen the file. Where there is no
repository, or no git, it says nothing rather than guessing — a guess there
nags precisely the operator who already opted out.

Neither is an alarm, but for different reasons.
`state-legacy-initiatives-dir` stays a `warning` — a legacy layout genuinely
hides initiative files from every mechanical consumer — and what changed is
that it finally has a remedy rather than a paragraph of advice.
`mistakes-file-missing` is `info` because nothing is broken at all: it is an
offer, and the only absence it will ever break silence about is the one
nobody chose.

### Accept-then-ignore, ended without nagging

`append` accepts any key inside `data` and always will: *"data may always
carry extra keys"* is a promise the envelope makes, the evidence gate relies
on it for four of its own, and turning it into a rule would fail every journal
ever written the moment they were re-validated. So this is a report, never a
refusal — and it is deliberately not the whole report.

Measured on one real install: **130 distinct (event, key) pairs across 39
initiatives**, and the long tail of that is deliberate annotation —
`init.created.hardware`, `retro.entry.proposed_as_diffs`, `spawn.stories`.
Naming all of it as findings would report the extension mechanism working as
designed, on every healthy repo, and doctor's own severity notes already argue
where that ends: a check that is red during normal operation is a check people
learn to skip — and this one sits next to the gates.

The defect hiding in that tail is narrower and worth a warning each.
**`journal-key-near-miss`** reports a key one edit from the key consumers
actually read: `next_step` for `next_steps` is accepted, never read, and never
reported, so the resume surface is empty while the agent that wrote it
believes it recorded something. Distance one and nothing looser — at two,
`note` matches `next` and the check starts inventing typos in correct
journals. Keys of three characters or fewer are exempt for the same reason.

**`journal-key-unread`** (`info`) counts and names the rest, so nothing is
dropped (ADR-19 correction 1) and "recorded" stays distinguishable from
"recorded AND read" — without turning a documented contract into 130 rows of
alarm.

`DATA_KNOWN` in `journal.mjs` is the map of what each event type's consumers
read, and it sits next to `DATA_REQUIRED` because both answer "what is in
`data`". It is descriptive: an incomplete entry can only under-report, never
invent a finding.

## 0.1.30 — 2026-08-17

The first release built on an outside contribution. It fixes a spend ledger
that was confidently reporting the wrong session, and it is also the release
where the "change both surfaces" rule caught itself being broken.

### Spend, when the conductor ran from somewhere else

Measured on a real run: a Claude Code Desktop session operated on a repo
through absolute paths and worktrees, but was itself started in a sibling
folder. `cost.mjs` derives a transcript directory from the repo path and falls
back to scanning every project directory for a `cwd` match — both assume the
conductor ran *from* the repo, and neither one held here. A different,
unrelated `claude` run had once been started inside the repo (for the trust
dialog), so the direct lookup found a directory and stopped there. The board's
Spend tab rendered that unrelated session — 17 requests, one model, "0 agents
attributed", conductor overhead 100% — as if it were the whole initiative,
with nothing on the page saying that ~66 agent transcripts and 2 300 requests
were sitting elsewhere.

Two operator-named overrides, both resolved by `cost.mjs` itself so
`board.mjs --serve` gets them for free: a repeatable `--transcripts <dir>` on
the command line, and `spend.transcript_dirs` in `.tyran/config.yaml`. Either
replaces the derived-slug / cwd-probe resolution outright; a given directory
that does not exist is reported in the new `transcript_dirs_missing` field
rather than dropped. The Spend tab now shows a hint — pointing at both
overrides — whenever it finds zero agent transcripts while the board itself
lists running agents, which is the shape this failure actually has: a tab that
renders, with honest numbers about the wrong session.

Contributed by [@FreddyFormosa](https://github.com/FreddyFormosa) in
[#66](https://github.com/jjanczur/tyran/pull/66), found on a 14-ticket
production run — the failure above is his measurement, not a constructed one.

### The half of "change both, always" that got left out

That contribution updated `docs/board.md`, `docs/configuration.md` and
`docs/cost.md` and left `board.mdx`, `configuration.mdx` and `cost.mdx`
untouched, which is precisely the divergence `CLAUDE.md` names — "docs/*.md
and site/src/content/docs/*.mdx publish the same claims. Change both, always."
All three pages are now mirrored, cross-links rewritten relative
(`../cost/#when-resolution-fails`) so the Pages build keeps its `/tyran` base
prefix.

Worth naming because of *how* it was caught: not by review, but by CI going
red on a different claim entirely. The README said 1405 unit tests and the
suite had 1417, and that check lives in the workflow rather than in the suite
— no test inside the suite can run the suite — so `node --test` reported green
locally right up to the point the pull request was opened. The number is now
1417, measured rather than typed. The .mdx gap was found while fixing it.

## 0.1.29 — 2026-08-16

Tyran has videos. Five cuts, and a page that says which one to send.

### The slate

A 3:20 explainer, a 3:53 first-session tutorial, and three vertical shorts —
the mistake, the board, the retrospective. Built with Hyperframes (HTML in,
deterministic MP4 out) and a Gemini voiceover, with burned-in captions and an
`.srt` sidecar each.

They are not five lengths of one video, which is the point of
[`docs/videos.md`](docs/videos.md): each answers a different question, and the
shorts and the tutorial fail at each other's jobs. The explainer argues, the
tutorial instructs, the board short shows rather than argues, and the retro
short is the only one whose subject is restraint.

### The written surfaces now say what the video says

The README and the landing hero were accurate and abstract where the explainer
is concrete. Both now open on the same sentence it does — your most expensive
model renaming a variable in the same chat it judged an authentication
boundary — and carry the manager framing through to the board, the bill and the
retro. Two descriptions of one product drifting apart is the defect this repo
calls ADR-21, and the video is now the widest-reach description of Tyran, so it
is the one the prose should agree with.

### The claims in the explainer, checked against the code

Every spoken claim was audited (`NOTES-REQUESTS.md` §10). Nine are exact, and
several turn out to be near-verbatim quotes of the mechanism's own
documentation: the four-question interview batch, the reviewer that ships with
no editing tools, the role floor applied after both the risk shift and the
override, and the three-to-knowledge / five-to-law ladder.

Two are not, and are recorded rather than quietly left:

- **"cheap tier, read only"** — the scout is granted `Bash`. *"You change
  nothing"* is the first line of its instructions, which is the one form of
  guarantee this project refuses to accept anywhere else. The fix is a
  read-only agent class in the policy gate, not a rewording.
- **"this is not an estimate, it is the bill"** — the figures are exactly what
  the sandbox board shows (404 requests, 4.53M tokens, 54.9% conductor) and the
  rollup computing them is the real one, but the usage feeding it is authored,
  and the board honestly labels those models `sample-large` / `sample-small`.
  Publishing a real `cost.json` into the sandbox makes the line true and makes
  the sandbox a better artefact than the video.

### What is in the repository, and what is not

The video *sources* are tracked — compositions, the voiceover pipeline, the
scripts, the storyboards — because they are text and they are how a cut gets
rebuilt. The renders are not. They come to roughly 430 MB, and this repository
is what `/plugin marketplace add jjanczur/tyran` clones, so committing them
would put marketing video into every install of the plugin. Git LFS was
considered and rejected on the same ground: a clone without `git-lfs` gets
pointer files, which breaks both the Pages build and the install.

`assets/video/` carries 1.1 MB of poster frames and caption sidecars, which is
everything the README and the docs page actually reference. The cuts live on
YouTube, and their IDs live in exactly one file,
`site/src/data/videos.json`.

Tyran's own secrets gate refused the first attempt at that commit — the payload
was past the 4 MiB it can scan inside its budget, and it refuses rather than
scanning a prefix, because a partial scan that reports nothing looks exactly
like a clean one. That is the gate behaving as designed, and it is what forced
the question of which bytes really needed to be in the tree. Two MP4s turned
out to be referenced by nothing.

## 0.1.28 — 2026-08-15

A maintenance release: the documentation site's dependencies, and three
numbers in the prose that had gone stale because nothing was watching them.

### Five vulnerabilities, now zero

`npm audit` in `site/` reported five, three of them high, all transitive:
nanoid's infinite loop on a zero size, js-yaml, fast-uri, dompurify, and
mermaid's prototype pollution. `npm update` and `npm audit fix` clear all five
and carry astro 7.1.4 to 7.2.2, starlight 0.41.4 to 0.41.7 and playwright
1.62.0 to 1.62.1. Lockfile only — no range in `package.json` moved, and the
plugin itself still has zero runtime dependencies, which is the property that
keeps this whole section confined to `site/`.

Verified against the built site rather than asserted: `astro check` reports 0
errors over 27 files, the build produces 18 pages, 488 of 488 root-absolute
URLs carry the `/tyran` base prefix, the browser pass finds 0 broken links and
0 console errors across every page, and the worst mermaid contrast is 5.68:1
against a floor of 3.

**TypeScript stays on 6.** `@astrojs/check` is at its newest release, 0.9.10,
and still declares `typescript: ^5.0.0 || ^6.0.0` — and `astro check` is what
the Pages workflow runs, so accepting TS 7 breaks the deploy rather than a
test. Dependabot now ignores that major with the reason written beside it.

The four Dependabot PRs this closes had been open for ten days. They were
*security* updates, which arrive ungrouped and without the seven-day cooldown,
so four one-line lockfile changes became four review cycles nobody ran. Both
tracks are grouped now: one chore a month instead of a queue.

### Three numbers that were wrong

The house rule is that a number in the prose is a claim, verified against the
thing it describes. These three were claims nothing verified.

- The README said **1314 unit tests**; the suite has 1405.
  `docs-claims.test.mjs` pins every such claim on the docs surfaces, but each
  of those is about ONE test file and is counted by running it. The README's
  is about the whole suite, which no unit test can count without running the
  suite from inside itself. CI now compares it against the full run it already
  performs for the skipped-test check, so the guard costs nothing.
- The README said the board has **four tabs**. It has had five since 0.1.24,
  and `docs/board.md` said five throughout. One surface moved, the other did
  not — the failure the two-surfaces rule exists to prevent, on the one
  surface that rule does not name.
- `templates/config.yaml` keeps **63** comment lines out of 90, not 60.

`assets/board-demo.gif` was recorded at 0.1.22 and moves through four tabs, so
it predates the Settings tab. Its alt text no longer claims to show the whole
page; the re-record needs a live board and a screen recorder, so it is written
down as an open item rather than quietly left wrong.

### The browser check had been shrinking

`site/scripts/check-browser.mjs` carried a hand-written list of 14 slugs while
the site had grown to 17 pages. The three it missed — board, overnight, cost —
were the three newest, which is to say the likeliest to carry a relative link
nobody had clicked. It reads the content directory now, so the list cannot
fall behind again. All 17 pass, 18 internal links, 0 broken. A check whose
coverage silently shrinks as the thing it checks grows is worse than no check,
because it still prints OK.

Astro 7's `preview` daemonizes and returns, so the `npm run preview -- &` in
both check-script headers no longer described what happens: the server
outlives the shell that started it and needs `astro preview stop`.

## 0.1.27 — 2026-08-15

The last four items of the munder-difflin plan, and the half of the model
fallback that was still missing. `NOTES-REQUESTS.md` §7 is now closed.

### The board says whether the run is supposed to be running

Three agent chips reading "6 HOURS since last signal — likely dead" covered
four unrelated situations, and 0.1.25 could only tell you about one of them:
an operator `STOP`. That one is committed repo state and travels in the
artefact. The rest is machine-local and gitignored — the pause marker, the
resume watcher's pid, the usage sidecar — so `--serve` answers it at
**`/run.json`**, on exactly the argument spend already makes.

The page turns it into one banner above the tiles when any of three things is
true: a usage-limit pause is live, a pause was due to resume and has not, or
the resume watcher is not running. A damaged or missing file reads as absent —
this answers a question *about* the run and must never be the reason nobody can
see the board.

### The queue knows what each question is holding up

Nine open questions sorted by age alone put the one gating six tickets wherever
it happened to fall. `deps` is resolved FORWARD everywhere else — a ticket is
`ready` when its dependencies are merged — and the reverse direction was never
computed at all.

Each ask now carries `blocks: {count, ids}`, walked transitively and skipping
merged tickets. The board sorts by it and **so does the answer sheet**, because
those are two renderings of one queue. Two deliberate limits:
no-recorded-default still sorts first (the only questions where saying nothing
has no safe outcome), and an initiative that declares no dependencies reports
`null` rather than `0` on every ask — an absence rendered as a measurement is
worse than saying nothing.

### Signal is not evidence

The agent strip aged on `progress`, which an agent emits at will. An agent
looping without achieving anything therefore had the freshest chip on the
board — and, because the strip is stalest-first, sorted to the bottom.

Agents now carry both times: **`last_signal`** is what it said,
**`last_evidence`** is what it showed (a `report` with its `evidence[]`, a
`finding` with its proof, a `review` verdict). The strip sorts on evidence, and
an agent that has shown nothing ages from its **spawn** rather than from the
last thing it said — otherwise the chatty agent still outranks one that
produced something twenty minutes ago, which is the exact inversion this split
exists to correct.

No doctor finding for it, deliberately. The threshold separating "quiet because
the work is hard" from "quiet because nothing is happening" is not one this
project can pick for every repo, and a warning that fires on healthy agents is
one people learn to scroll past.

### A ticket that failed twice is re-tried a tier higher

The escalation rule lived in the conductor's memory, which iron rule 7 already
names the least reliable store in the system: after a compaction, the ticket is
re-spawned at the tier that failed both times.

```bash
node scripts/tiers.mjs --role implementer \
  --journal .tyran/state/<init>/journal.jsonl --ticket T-3 --field json
# tiers: ESCALATED work -> deep after 2 failed attempt(s) on T-3 (ceiling deep).
```

Capped twice over — two steps, and a ceiling of `deep`. A ticket that has
failed five times does not need the most expensive model in the table; it needs
a human, and the `changes-requested` lane already shows that. The same read
picks up any model an `error` event recorded as `model-unavailable` and feeds
it to the fallback, so **the exclusion is durable in the ledger** rather than
in a session that will be compacted. Escalation happens first and the fallback
second: a re-try asks for a stronger model, then discovers whether it is
available.

The weakness, stated rather than left to be found: "did this attempt fail" is
`APPROVING_RE`, written for lane assignment — "approved with nits" escalates
nothing and "looks fine" escalates. And a journal that cannot be read routes as
a first attempt, loudly, because routing must never depend on a readable
journal.

**Detection is still not automatic.** The limit surfaces inside a subagent's
API call where no hook can see it, so something still has to notice and write
the `error` event down. That seam is recorded in `NOTES-REQUESTS.md` rather
than papered over.

### Left alone on purpose

`budget:` in the config schema is dead weight — validated, read by nothing —
and it stays. Removing a key from the `known` list makes every config that
carries it invalid, and an invalid config makes the policy gate refuse every
write in that repo. The cost lands on whoever set the key; the benefit is a
shorter array.

## 0.1.26 — 2026-08-15

### Answer a question from the board

The last context switch in the operator loop is gone. Every question in the
**Waiting on you** tab now carries a box: type an answer and press **Answer**,
or press **Take the default** on a question that records one. The three
`answer render / edit / apply` commands still work and stay printed on the tab —
the box is a convenience, and a board opened over `file://` or without
`--write` has to leave you somewhere to go.

The request carries exactly two things: **which** ask, and your words. The
question, the recorded default, the ticket and the gate id are all read back
out of the journal by the server — the same guarantee the answer sheet makes,
for the same reason. The append is `answerOne`, the function `answer apply`
already calls, unwrapped: both routes produce byte-identical events, the gate
is re-checked INSIDE the journal's write lock so a question closed in a
terminal thirty seconds ago cannot be closed twice, and the decision is written
before the gate.

Each card also says which kind of question it is, and that costs no new event
type: **decision · a default is recorded** means saying nothing has a safe
outcome; **blocking · no safe default** means it waits for you. It is the same
distinction that already makes the answer sheet sort no-default-first.

### A tier that runs out of capacity falls to the next one down

Measured on a real run: the strongest tier hit its limit and the subagents
**failed** rather than finishing on the tier below, which had capacity the
whole time.

```bash
node scripts/tiers.mjs --role acceptance --unavailable fable --field json
# tiers: FELL BACK top -> deep because the top model is unavailable.
```

**Down the ladder, never up** — which is the answer to the question this was
blocked on. Climbing would spend more than the routing table promised,
silently, at exactly the moment nobody is watching. Three things the fall does
not do: it does not lower the **effort** (that judgement did not change because
a model ran out of capacity), it does not cross a **role floor** (a security
review on the cheapest model is not a security review), and it does not
**pretend** — the substitution is announced, and `fell_from` records it. When
every tier a role may use is unavailable, it exits 2 rather than returning the
bottom of the ladder: that is a pause, not a substitution, and overnight mode
is what knows how to wait.

### Twelve confirmed findings from an adversarial review of 0.1.24 and 0.1.25

Five lenses attacked the shipped code and each finding was re-attacked
independently. Two were serious:

- **A config with no `limits:` block killed the whole Settings tab.** That
  block is optional and every install set up before 0.1.24 has none, so
  `resolvePath` returned null, `readAt` tried to iterate it, and the tab
  rendered "the board server did not answer" while the server answered every
  request. Every write on such a repo was an HTTP 500 in the terminal the docs
  designate as the audit trail.
- **The page could reload under a half-typed value.** A `meta http-equiv=refresh`
  is scheduled by the browser when it parses the tag, and REMOVING THE NODE
  DOES NOT CANCEL IT — the code sincerely believed otherwise, in a comment. The
  page now carries an inert marker only its own script reads, so the single
  reload path is a timer it can actually stop.

And:

- **An unreadable journal wrote an absolute path** — a home directory and a
  username — into `board.json`, which is committed and compared byte for byte,
  so it also failed `--check` on every other machine. Now the error code and a
  repo-relative path.
- **An initiative whose directory could not be read vanished** from the board
  with nothing said; the totals just went down by one. `existsSync` cannot tell
  "there is no journal here" from "I cannot tell whether there is one".
- **`--dir` pointed at the repo root silently succeeded**, creating a `state/`
  directory in the wrong place and reporting that all was well about a repo
  whose real journals sat one level down.
- **The settings write had no compare-and-swap.** Two boards on one directory,
  or a board and a terminal, could discard each other's change with both
  reporting success.
- Plus a wrong number in the CHANGELOG, an overclaim in `docs/configuration.md`
  (`pricing:` and `main_writable_paths:` have no knob), a lane emptied by the
  filter showing no placeholder, a stale "Four tabs" comment, one of ten lanes
  unaccounted for in the stalled-card prose, and two unverifiable claims about
  the sandbox.

### yaml-lite: the writer and the reader disagreed about numbers

`formatScalar` required a digit before the decimal point and `parseScalar` did
not, so the **string** `.5` was written unquoted and read back as the **number**
0.5. Both now use the reader's two patterns. This was found by `yaml-patch`'s
round-trip proof — the guard whose comment claimed no input was known to reach
it. That claim is now corrected rather than repeated.

A leading **BOM** is also handled: `trimStart` counts it as whitespace, so it
read as one column of indentation and the parser rejected the whole file with a
complaint about a line the operator could see nothing wrong with.

Three more in the patcher, each of which wrote or refused the wrong thing: a
key was located with `indexOf(':')` rather than the parser's own rule (so `a`
landed on the `a:b` line), a path ending in an integer dropped the list item's
dash, and replacing a list that is the FIRST key of a sequence item deleted the
item's sibling keys.

### The backtick guard

The whole browser client is one template literal, so a backtick anywhere inside
it — including in a comment — ends the literal and the page stops loading. It
happened four times in one sitting. The parse test caught it every time and
could never say so: it reports whatever identifier followed the stray backtick.
A new guard reads the source as text, imports nothing, and names the line.

## 0.1.25 — 2026-08-15

### The sandbox is now Tyran building Tyran

The published sample board was two invented initiatives about someone else's
payment system. It showed what the dashboard looked like and nothing about what
it is like to work this way, which is half of what a reader opens it for.

It now carries **three initiatives that actually built the board you are
looking at** — the lanes, overnight mode, and the Settings tab — written as
journals from the real work. Every finding on it is a finding that was made:
the artefact must never read a clock or `--check` can never pass twice; the
page must build DOM with `textContent` only, because journal values reach the
browser verbatim; the hook payload does not carry `rate_limits` and a plugin
cannot install a statusline. Every logged error is one that happened, including
the backtick in a comment that terminated the client's template literal.

All ten lanes are populated, five agents run at ages from about twenty minutes
to three hours, two questions wait on the operator, and the banner's counts are read
from the payload rather than typed — it said "two invented initiatives" for a
release after a third was added.

### Three findings while writing those journals, all in shipped code

- **Every reviewer on the published sandbox rendered as still running, for
  ever.** A `review` closes its spawn by `data.by`; the sandbox journals said
  `data.agent`, so no review ever closed anything and the headline agent count
  was wrong on the one page whose job is to show what the product looks like.
- **The test that was supposed to catch that validated nothing.**
  `validateJournal` takes a file PATH and the test handed it an array of
  events, so it read an empty journal and returned `ok` — it was asserting
  that nothing had no errors. The replacement journals tripped it thirteen
  times on the first honest run.
- **An `error` event that named a ticket produced two rows on the board**, one
  from `state.errors` and one from `unknownErrorTickets`. The ticket now
  travels on the error itself, where a consumer that wants both can have both
  without joining two lists by timestamp.

### The board answers "is this supposed to be running?"

Three chips reading "6 HOURS since last signal — likely dead" covered four
unrelated situations and the board could tell them apart in none of them.

- **A STOP is on the board**, above everything else, carrying the first line of
  `.tyran/STOP` as its reason. It is committed repo state, identical in every
  clone, so it travels in the artefact — as `{stopped, reason}` and
  deliberately not the path, which would make two clones disagree and fail
  `--check`.
- **An error with no ticket is finally visible.** The fold has collected
  `state.errors` since errors existed and the board carried neither it nor the
  unknown-ticket list, so an agent logging a hard failure showed nothing at all
  on the page that exists to say "not all is well". The key is
  `errors_logged`, not `errors`: that name already means "this journal could
  not be read", and one key with two meanings is the defect ADR-21 is named
  after. Capped at 20 newest-first with the true count beside it, because this
  artefact is committed.
- **Cards say how long they have stood still.** The board would tell you an
  agent had been quiet for three hours and refuse to tell you a ticket had been
  blocked for four days — the timestamp was in `board.json` all along. Only on
  the lanes where standing still IS the defect: `backlog` and `ready` are
  excluded, because an unstarted ticket is waiting its turn, and marking every
  one of them stale makes the mark worthless where it means something.

All three use one staleness vocabulary, shared with the agent strip. Three
renderings of "how long ago" would let the same gap read as fine in one place
and alarming in another.

## 0.1.24 — 2026-08-15

### Settings: the board can now change what Tyran does

`board --serve --write` turns the dashboard's new **Settings** tab into an
editor for the two operator-owned files — `.tyran/config.yaml` and
`.tyran/policies/autonomy.yaml`. Every knob carries a sentence saying what
turning it actually does, and every policy rule shows its own recorded reason.
Until now the answer to "where do I change this?" was an editor and a memory
of what each key meant.

**Writes are off by default and per-invocation.** Without `--write` the tab
renders with every control disabled and the command that turns it on. A board
someone left running is reachable by anything on the machine, and the
difference between reading that and editing the autonomy policy through it is
the difference the flag exists to make.

**One line moves, and the comments stay.** The plan of record said the
comments were expendable because the screen could carry the explanations. That
turned out not to be necessary: `scripts/yaml-patch.mjs` rewrites the line
that owns a value rather than round-tripping the document through a
serializer, so `templates/config.yaml` keeps all 63 of its comment lines — the
only place anyone is told that bare `off` is the YAML boolean false, which is
also the value that would have silently changed meaning had this been done the
obvious way.

**The edit is proved, not trusted.** Every patch is applied, parsed back, and
compared against the document that was intended: the target holds the new
value and every other path holds exactly what it held before. Then the whole
result goes through the same `validateConfig` / `validatePolicy` that
`schema.mjs validate` runs. A locator bug cannot ship a wrong file — it can
only fail loudly, and a refused write leaves the file byte-identical.

### Loosening a boundary is not the same click as tightening one

Found by an independent review of the above, before it shipped, and it was
worse than the review guessed. `validatePolicy` defends exactly two globs —
`hooks/**` and `.tyran/policies/**` — so the first version of this screen
would take `.claude/settings.json` from KERNEL to AUTO in one press, on a rule
whose own stated reason is *"anything that can edit it can switch every gate
off"*. So would `.tyran/STOP` (*"a loop that can clear its own stop signal has
none"*), and so would the policy `default`, and `autonomy: P1 → P3` sat in an
ordinary dropdown next to the cost profile.

Loosening now takes a second, deliberate act: the first request is refused
with the rule's own reason quoted back and a confirmation token, and the token
is **the new value itself** rather than a boolean, so nothing widens a
boundary by sending a truthy flag beside whatever value it liked. Tightening
still applies on the first click — friction on making a boundary stricter is
how you teach someone to stop making boundaries stricter.

What guards the route, stated exactly: the `Host` pin, an `Origin` check and a
required `application/json` content type close the browser paths. They do not
stop another process on the machine that can already reach loopback; nothing
served on localhost does. The flag is the control that matters there, and the
kernel invariant is what holds even when the flag is on. `docs/board.md` says
this in those words rather than claiming a sandbox.

### Two things a fresh install could not do

Both found by the same study, both reproduced before being believed.

- **`board --dir .tyran` crashed on a repo that had been set up and never
  run** — `ENOENT`, naming a temp file nobody had heard of, on the one command
  the README leads with. `.tyran/state/` is created by the first initiative;
  `writeAllAtomic` staged into it and never made it.
- **A scanned config carried no `limits:` block at all**, so the entire
  Overnight section of the new Settings tab was seven lines of dead text on
  every fresh install — the editor deliberately refuses to invent keys. It is
  now written out in full at the shipped defaults, with the feature off, which
  is the same inert state as omitting it. `doctor`'s `limit-telemetry-missing`
  could never fire before this either, for the same reason.

### Four findings from the independent review, fixed before merge

- **The editor only worked on two-space indentation.** `yaml-lite` recurses
  with whatever indent the next line has, so a four-space `config.yaml` is
  entirely legal and `validateConfig` accepts it — but the patcher assumed a
  step of 2, so on such a file eleven of the fifteen controls rendered
  **enabled and populated** (the page reads the parsed document) and then
  failed on click with *"is not in this file"*, which was false, and whose
  paired advice told the operator to add a key that was already there. The
  step is now read from the file. The one step that stays fixed is a sequence
  item's siblings at dash + 2, because `- ` is two characters wide and that is
  what `yaml-lite` itself does.
- **A value the subset cannot spell returned 500.** `formatScalar` throws for
  a newline or an invisible codepoint — ordinary rejected input, someone
  pasting a model name with a stray newline — and it escaped as a server
  fault, complete with a `settings write failed` line in the terminal the docs
  designate as the audit trail. Now a 400, quietly.
- **The round-trip proof had no test that failed when it was deleted.** The
  reviewer neutered the comparison and the suite stayed green; 2772 fuzzed
  triples fired it zero times, because every wrong case is refused earlier by
  the locator, the comment guard or `formatScalar`. `sameValue` is now
  exported and tested directly — it is the mutable logic the guarantee rests
  on — and the module says plainly that the proof is defence in depth with no
  known reachable input. Two bare `assert.throws` calls gained an error class;
  the missing one is what let the 500 above through.
- **A wrong number in three places.** `templates/config.yaml` is 90 lines of
  which 63 are comments, not 60 of 91.

Also from the review, unprompted: a failure inside the settings renderer was
being reported as "the board server did not answer", sending the operator to
restart something that was answering perfectly well.

### The sandbox has a Settings tab too

`site/scripts/build-sandbox.mjs` runs the real `readSettings` over the shipped
templates, so the published sample board shows the real defaults, laid out by
the code an operator's own board runs, read-only and saying which flag would
make it otherwise.

## 0.1.23 — 2026-08-15

### The sandbox Spend tab shows spend

The published sample board met a reader with an error where the feature should
have been: no `cost.json` is served beside a static page, and the tab said so
honestly and uselessly. It now ships one, generated by **`rollup()` itself** —
the same function the board server calls — from invented transcripts. A
hand-written payload would render today and drift silently the first time a
field moved, on the one page whose whole job is to show what the product looks
like.

The numbers are invented and the page says so: the rate card is labelled
`sample-rates (invented)` and the models are `sample-large` / `sample-small`,
because **Tyran does not know what anyone pays** and a demo that reads like a
price list teaches the opposite. A test fails if a real model name appears
there — the rule that model names live only under `tiers:` has no sandbox
exemption.

What a reader now sees: 4.5 M tokens over 404 requests, 16.97 under that
invented rate card, a **55% conductor share**, the composition bar at 91%
cache read, and all three ranked charts with the tokens/cost toggle live.

## 0.1.22 — 2026-08-15

### A sandbox board you can click, published with the docs

A screenshot cannot be clicked and a GIF cannot be paused, so the docs now
publish the **real page** at
[jjanczur.github.io/tyran/sandbox/](https://jjanczur.github.io/tyran/sandbox/)
— rendered by the same `scripts/board.mjs` an operator runs, from two invented
initiatives committed under `site/sandbox/`. Click the tabs, filter the lanes,
select a card.

Two things a static copy has to solve, and both are solved in the generator
rather than by hand. **Ages**: the agent strip is aged in the reader's browser
against event timestamps, so a frozen page would read as a graveyard within a
month — every timestamp is shifted at build time so the newest event lands six
minutes before the build, with the original spacing intact. **Honesty**: the
30-second refresh is stripped (it would also snap a reader back to the first
tab mid-click) and a banner says what the page is. Both replacements throw if
their anchor moves, because a silent no-op there publishes a page that claims
to be someone's live board.

### The board, for someone who left it running overnight

- **The queue count is in the browser tab title.** The page is meant to be left
  open while agents work; a background tab was saying nothing at all, because
  the count existed only on a tab you had to be looking at.
- **"Changed since you marked seen."** The board is a snapshot and the journal
  is a timeline: coming back to ten lanes meant re-reading all of them to find
  the two that moved. Press **Mark seen** and the next visit names how many
  tickets changed lane, badges each one, and says in the detail panel which
  lane it came from. The baseline moves only on that press — never on load,
  because the page reloads itself every 30 seconds and an auto-updating
  baseline would make "since you last looked" mean "in the last half minute",
  which is the same as showing nothing.
- **A filter over the lanes**, matching ticket id, title and initiative. Ten
  lanes across dozens of initiatives is a pile; the lane headings keep their
  counts as `n of N`, so a filtered zero still reads as a fact rather than an
  absence.
- **A merged ticket names who did it.** The card's agent list empties the
  moment an agent reports, so every `done` card showed nobody — and "who
  touched this" is a question asked about finished work, not running work. The
  fold has kept the list since spawns learned to name a ticket; only the board
  dropped it. `worked_by` is deduplicated and naturally ordered, because
  `board.json` is compared byte for byte and spawn order is not an order.
- **Nothing-started no longer looks like nothing-finished.** A fresh
  initiative and a fully stalled one both rendered `0% · 0 of 0 merged`.
- **A 404 on spend is an answer, not a failure.** No such route means the page
  is not being served by the board server — a copy on a docs site, a file
  behind some other host — and it now says so calmly, while a 503 stays loud.

### The client script is now proved to parse

Every other assertion about the page matches strings in the rendered HTML,
which a page that cannot run would satisfy just as well. The whole client is
one template literal, so a backtick inside a **comment** terminates it and the
module stops loading — which is exactly how this was found, by a comment that
quoted an identifier. The suite now compiles the emitted script.

### Documentation

The GIF is larger (1180px), and under it, in the README and on both doc
surfaces, a link to the sandbox. `docs/board.md`'s **Opening it** section is
the one place that says how to open the dashboard: the serve command and the
URL it prints, the `open`/`xdg-open`/`start` line for the file, what differs
between them, and that `/tyran:status` does it for you inside a session.

`CLAUDE.md` now specifies `npm run build` for the site rather than
`npx astro build` — the sandbox is generated first, and calling astro directly
publishes a site whose sandbox link 404s.

## 0.1.21 — 2026-08-14

### The board said "all is well" in five different ways it should not have

An audit read the page against its own promise — that it never shows a healthy
board over an unhealthy repo — and it failed that promise five times.

**A partially damaged journal rendered as a healthy initiative.** The existing
guard fires only when NOTHING was readable. Three good tickets plus one
unparseable line folded to a board with `errors: []` on it, and the lost line
left no mark anywhere. `project.mjs` has produced exactly the right sentences
for this since the projection layer existed — `board.mjs` had simply never
asked for them. It asks now, and the page carries a **Warnings** section
naming the initiative and what could not be accounted for: a skipped line, a
lease released by a non-holder, an override for a ticket that does not exist.
The likelier damage is the partial kind, because a crash mid-write takes the
tail, not the file.

**"Needs a human" counted lanes, not humans.** A ticket parked by a
`ticket.status` override leaves no card in the `blocked` lane — `boardOf`
resolves the override before the blockage — so an agent could sit blocked on
that ticket while the tile read **0**. Measured on the shipped fixture: the
tile now reads 2 where it read 0, and both are agents rather than lanes. It
counts from both sources, on the server, and the sub-label breaks out which is
which.

**Staleness was shown and never escalated.** Agents rendered in the order the
journals spawned them, so the one that had said nothing longest could be last.
They are now sorted stalest-first, said so above the strip, and three hours of
silence gets its own bucket and its own red — "468 HOURS since last signal —
likely dead" is not the same event as thirty minutes, and the two used to
share a colour. Each chip also carries **what the agent said it would do
next**, which has been in `board.json` since the fold learned to read
`progress` events and had never been rendered.

**A spend failure was indistinguishable from having no server.** A crashed
reader, an unparseable rate card and a page opened over `file://` all ended as
the same silently missing section — and the server had already built the
sentence that tells them apart, for a 503 nothing displayed. Each now says
which it was; `file://` still says nothing, because there it is not a failure.

**Over the initiative ceiling, the served page was a plain-text 500 that the
page's own 30-second refresh re-fetched twice a minute.** It is now a readable
page that names the cause and does not reload itself. The CLI still refuses
loudly with exit 2 — that is right when a human is reading exit codes.

### The drill-down reaches the files an initiative actually has

Selecting a card now lists that initiative's `PLAN.md`, `NOTES.md`, `RETRO.md`,
`STATE.md` and `PROGRESS.md` — **the ones that exist**, checked with
`existsSync`, never a list of what a well-run initiative ought to contain and
never created to satisfy a link.

The recorded path is repo-relative, and that is not cosmetic. `board.json` is
committed and compared byte for byte, so an absolute path would make two
clones of one journal disagree and fail `--check` on any machine whose home
directory is spelled differently — the same reason spend is served rather than
embedded. It was nearly shipped absolute; there is now a test that fails on
any `"path"` starting at the filesystem root.

Nothing is served: `--serve` still answers exactly three URLs and derives a
filesystem path from none of them, which is worth more than a clickable link.

### How to open the dashboard, said once, plainly

`docs/board.md` gains an **Opening it** section, mirrored on the site: the
serve command and the URL it prints, the `open`/`xdg-open`/`start` line for
the file, what the difference between them is (spend, and only spend), and the
fact that inside a session you type neither, because `/tyran:status`
regenerates the board and tells you where it is. The README says the same in
three lines instead of implying it.

Verified in a browser against a two-initiative tree, one of whose journals was
deliberately corrupted: 0 console errors, 0 failed requests, the tile at 2,
three warnings listed, the file rows repo-relative.

## 0.1.20 — 2026-08-14

### `.tyran/` was tracked, and an entire initiative inside it was not

`untrackedTyranDir` was all-or-nothing: one tracked file anywhere under
`.tyran/` and the whole directory reported healthy. Measured on a real install
whose `.tyran/` had been tracked for weeks — one initiative directory of six
files, its plan and the gate event recording two production database migrations
among them, had NEVER been committed, and a second was 33 events behind its
committed copy. Both passed. `journal.mjs append` writes the working tree and
nothing else, so an initiative nobody committed is one `git clean -fd` from
having never happened.

`doctor --state` now reads each initiative's ledger separately, in three states
rather than two:

- `initiative-untracked` (**warning**) — git has never seen it.
- `initiative-ignored` (**warning**) — a `.gitignore` rule covers it. Split out
  because `git add` on an ignored path exits 0 and stages nothing, so the
  untracked fix would have read as success while changing nothing.
- `initiative-uncommitted` (**info**, never fails the check) — tracked with
  local changes, which is what an initiative in flight looks like ten seconds
  after any append. It earns its keep at a merge boundary.

Two git invocations for the whole tree, not two per initiative: both listings
are read once and classified by path prefix in JS, so a repo with forty
initiatives costs the same three subprocesses as one with a single initiative
— and a test counts them, because that regression passes every behavioural
test there is. Under a wholly untracked `.tyran/` the directory-level finding
still reports alone rather than repeating itself once per initiative with
narrower advice each time.

### Four things the conductor skill was letting agents rediscover

- **Interactive shell aliases hang an agent until the tool timeout.** An
  agent's shell starts from the user's profile, so `alias cp='cp -i'` asks a
  question nobody answers. The symptom is a timeout, which points at the
  machine rather than at the alias, so it gets rediscovered every time: three
  agents in one session, then again in a later one that had already read the
  file it is now written in. STEP 0 probes for it.
- **A `Test timed out` measured under concurrency is not evidence.** The
  hardware ceiling bounds agent count, not concurrent heavy phases. Re-run
  serially and report the serial result. One overnight test failed exactly
  that way inside the full suite while this release was being verified, and
  passed alone.
- **An agent that dies on a terminal API error is resumed, not respawned** —
  its context, its corrected premises and its uncommitted diff all survive.
- **Gitignored env files are absent from a fresh worktree too, and fail
  quieter than dependencies**: 127 is loud, a skipped gated spec is not, so the
  worktree reports a *cleaner* baseline than the repo has.

### The README says what Tyran is, and the docs it links are the published ones

- **"What Tyran is" rewritten** to open on the failure a reader recognises — a
  full context window, a plan somewhere in the scrollback, "the tests pass" as
  a sentence rather than a result — before naming the mechanism that answers
  it.
- **The named comparison is back on the front page.** Five rows of the eleven
  in the FAQ, copied verbatim, plus a test that fails if a verdict moves in one
  and not the other. The `Skills · agents it ships` row and the guard pinning
  it were deleted rather than updated: the table under it and the sentence
  under that already carry the same count, and three spellings of one answer is
  the defect this repo calls ADR-21 — a test can hold one in place as easily as
  prose can.
- **Every documentation link now points at the published site** rather than at
  a markdown file: twenty in the README, three inside skills, and four in
  `doctor`'s own fix lines — which reach repos that have no `docs/` directory
  at all, where `see docs/journal.md` was a dead reference.
- **The Node version is stated once, where it applies.** It sat in the lede and
  in the install section, neither of which runs Node: the scripts ship with the
  plugin and Claude Code runs them. It now sits beside the one command that
  needs it, `npx @jjanczur/tyran board`.
- **The dashboard GIF runs at 4 fps instead of 8.3** — the same recording, at a
  speed a tab can actually be read at.

### The dist-tag is earned, not inherited from the last run

Creating GitHub Releases for sixteen historical tags in one batch fired
`npm-publish.yml` sixteen times. The workflow's safety argument was that npm
refuses a version that already exists — true, and too small: **npm refusing a
DUPLICATE version is not npm refusing an OLD one.** Four of those versions had
never reached npm, so they published cleanly and each took the `latest`
dist-tag on the way past. For roughly a minute `npm i @jjanczur/tyran` served
**0.1.2**. Found within two minutes, by checking the registry rather than the
sixteen green workflow runs, and self-corrected when 0.1.20's own publish
landed last.

The workflow now asks the registry which version is highest and publishes
`--tag latest` only when the version in hand IS that one; anything older
gets `--tag historical` and moves nothing. The comparison is `sort -V`, not
string order — `0.1.9` sorts above `0.1.10` alphabetically, which would have
mis-tagged every 0.1.x release past the ninth.

Side effect, kept: 0.1.1, 0.1.2, 0.1.15 and 0.1.16 are now on npm, so the
registry finally carries every released version.

## 0.1.19 — 2026-08-14

### The board answered four questions on one scroll

`board.html` is now four tabs. **Overview** — what is waiting on you, agents
running, progress, tickets that need a human, then the agent strip. **Board** —
the kanban lanes, where every card is a button that opens a detail panel
carrying its lane, initiative, agents, note and, once spend has loaded, that
ticket's tokens and cost. **Waiting on you** — the queue, with the three
commands that answer it printed above the questions, and its open count in the
tab label so a pending decision survives being on another tab. **Spend** —
unchanged in substance, still FETCHED rather than embedded, so `board.json` and
`board.html` keep their byte-exact `--check` contract.

The palette is pulled back. The first version filled whole bars and whole cards
at full saturation, which reads as an alarm rather than as information. The
roles are unchanged — one warm accent for the operator's call to action, a cool
one for the agent strip, red for refusal, green for the ledger's `+` — but
saturation is now spent on text, edges and 3px rails, and every large fill is a
muted tone of the same hue. The tokens are `--brass`, `--steel`, `--clay`,
`--sage`.

### The README explained the problem before it explained the product

Rebuilt, 491 lines to 204: what Tyran is, a recorded demo of the board, what it
gives you, a comparison, install, use, the dashboard. Everything cut was first
given a home on BOTH doc surfaces — nine sections that lived nowhere else were
moved rather than deleted, and four inbound links that pointed at README
anchors now resolve inside `docs/`.

The version badge read GitHub Releases, where the newest was 0.1.3 while
sixteen versions had shipped by tag and by npm. It now reads npm, which the
release itself maintains and which cannot go stale.

**Upgrading: regenerate your board.** `board.html` changed again, so
`board.mjs --check` reports drift until you run
`node scripts/board.mjs --dir .tyran` and commit. `board.json` and `BOARD.md`
are unchanged.

## 0.1.18 — 2026-08-14

### The spend ledger: nobody could say what a run cost

`node scripts/cost.mjs` reports what the work cost, in tokens the platform
itself reported, per model, per agent type and per ticket. It **reads, it never
instruments**: every number comes from the `message.usage` records Claude Code
already writes under `~/.claude/projects/`, so there is no hook, no probe, no
new event type and nothing to keep in sync.

It is deliberately **not a projection**, and that is the decision the rest
follows from. Its inputs are machine-local and differ per clone, so two people
with the same journal legitimately get different numbers — which is exactly
what a byte-exact `--check` would report as drift. `cost.json` is therefore
never committed (it joins the runtime files `.tyran/.gitignore` excludes),
never byte-compared, and never merged into `board.json`.

**Tokens are facts; money is an opinion.** Only tokens are counted. Money comes
from an operator-written `pricing:` block, and the card's name travels with
every amount — a figure that cannot say which card produced it is not a
measurement. Absent pricing gives tokens and no money, which is the honest
default: Tyran does not know what anyone pays. All four rate keys are required
per model, because a table carrying three would price the fourth at zero,
silently, and cache reads alone were measured at roughly three quarters of a
real session's cost.

Gaps are reported rather than zeroed: `unpriced` models are counted in tokens
and absent from every amount, `unattributed` agents are the ones whose task
description carried no ticket id, `unreadable` transcripts are named. A model
that billed zero tokens is not reported as unpriced — that would be a permanent
false warning about something that cannot cost anything. And partial pricing is
a partial sum: an amount is blank only when nothing in the row is priced at
all, because a real rate card always misses something and nulling the grand
total over one absent row would leave every figure blank forever.

The conductor is its own row. Its context is not attributable to any ticket and
was measured between 44% and 86% of a tree's tokens, so a per-ticket table that
omitted it would present a fraction of the bill as the cost of the work. That
share is reported in tokens, never dollars: a partial rate card prices only some
models, so a dollar share is a ratio over whichever subset happened to be
priced — the same tree read 86% by tokens and 99% by dollars.

Ticket attribution cost nothing to add. The conductor already puts the ticket id
at the head of a `Task` description; the reader takes it back out of the agent's
`.meta.json`. No journal change, no event-set change, and an agent whose
description omits the id lands in a visible `unattributed` bucket rather than
being guessed at.

`board.html` gains a **Spend** section, and it **fetches `cost.json` rather than
embedding it** — a deliberate amendment to the page's "self-contained, no
network" description. It is still zero external hosts and zero CDNs; what it
makes is one same-origin request to loopback. Over `file://` there is no server,
the request fails, and the section never appears, so `board.json` and
`board.html` keep their byte-exact `--check` contract and carry no machine-local
data. The `/cost.json` route is covered by the existing `Host` pin (a foreign
`Host` gets 403, verified) and returns 503 rather than taking the board down if
the cost read fails.

Transcripts reach tens of megabytes and the page refreshes every 30 seconds, so
the reader streams in chunks and caches per source file keyed on `(path, mtime,
size)`. A finished agent's transcript never changes, so only the running
session's file is re-read. Measured cold: a 226-transcript tree totalling 6.86
billion tokens scans in 1.7 s.

Also reachable as `npx @jjanczur/tyran cost`. Exit 0 ok · 2 usage, I/O, or no
transcripts found — spend is read, and nothing here estimates it.

**Upgrading: regenerate your board.** `board.html` gained the Spend section, so
its BYTES changed even though its contract did not. A repo that committed a
board rendered by an earlier version will see `board.mjs --check` report drift —
and `doctor --state` report `projection-drift` — until you run
`node scripts/board.mjs --dir .tyran` and commit the result. `board.json` and
`BOARD.md` are byte-identical to 0.1.17.

## 0.1.17 — 2026-08-14

### A race test that picked a winner

`two apply runs at once cannot both close one ask` accepted only two of the
three exits its own race can produce. On a runner slow enough to serialise
the two spawns, the first closes the queue and the second finds it empty and
exits 1 — correct behaviour, asserted as a failure. It passed locally and in
the PR checks and failed in the publish job, which is where a timing
assumption usually surfaces, and it kept 0.1.15 and 0.1.16 off npm although
both are merged and tagged.

All three exits are now accepted, and the guarantee is asserted where it
holds regardless of who won: no ask closed twice and no question closed by
two gates, checked while the racing runs are the only writers, then
completeness after one sequential settling run. Dropping the sitting lock
still fails the test.

## 0.1.16 — 2026-08-14

### `cat hooks/…` was refused while `Read` handed you the same bytes

Measured on the shipped 0.1.15 gate, on one file under `hooks/**`: `Read` passes,
and `cat`, `grep -n`, `wc -l` and `node --check` on that same file all **deny**.
The bytes were one tool call away in every case, so the refusal protected
nothing — and it was not consistent with itself either: `git log --oneline --
hooks/` passed all along, because a bare directory token names no file to
classify, while `wc -l` on a file inside it did not. The cost was four
interrupted tool calls in one session for the author, every one of them while
reading the gate being worked on.

The rule this release encodes instead: **the shell must not become a second
route to something the `Read` tool already refuses.** For `.env` that symmetry
is load-bearing and is untouched — `Read` denies *and* `grep` denies, because
the measured incident behind that rule is a refused `Read .env` followed by
`Bash: grep` in the very next tool call. Where `Read` is allowed, refusing the
shell buys nothing.

So on `hooks/**` and `.tyran/policies/**` — and only there — a read-only shell
command now passes. "Read-only" is matched on the **program and its flags**,
never on the program alone, because read-shaped programs have write-shaped
modes: `node --check FILE` passes and `node FILE` denies; `git log` passes and
`git log --output=FILE` denies, which was a real hole found in an earlier review
of this gate; `tail -n 5` passes and `tail -f` does not. An unrecognised flag
refuses, so the enumeration's incompleteness costs a false refusal and never a
pass. `sed` and `awk` are not on the list at all: their script argument is a
program with its own write commands, and reading it would need a second parser.
The raw command may contain none of ``< > $ ` ( ) { } &``, which is every
redirection spelling, command substitution, subshell and `&&` at once — checked
on the raw text, because the shared lexer *consumes* those characters as
separators and by the time a token exists the `>` is gone. `|` and `;` are fine,
since each composed segment still has to be an allowed reader.

What did not change: every credential shape denies for reads and writes alike;
`.claude/settings.json` and `.claude/settings.local.json` stay refused from a
shell in every mode, which is a deliberate narrowing rather than a consequence —
`Read` passes on the registry too, so the principle alone would have admitted it,
and it is the one file from which every gate is switched off at once. One line
naming a readable path *and* a secret is still refused for the secret.

That last sentence needed a second check to stay true, and review found it out.
The exemption was decided on the **finding list**, which is computed from a
*stripped* copy of the command: `stripMessageArguments` removes a message-bearing
flag together with its argument, and non-literal tokens are dropped after that.
`-t` is `git commit --template` *and* a legal flag of `diff` and `cat`, so
`diff -t .env hooks/scripts/policy-gate.mjs` left a finding list naming only the
readable path, read as "read-only command on a readable path", and was exempted —
really publishing the file. Four shapes were measured deny-on-0.1.15 →
pass-before-the-fix: `diff -t SECRET FILE`, `grep --file=SECRET FILE`,
`grep -m SECRET FILE`, and `diff ~/SECRET FILE`, the last because a leading `~`
makes the token non-literal and it is dropped entirely. The exemption is now
refused when any word of the **raw** command is credential-shaped, tested with
the same `SECRET_READ_RULES` the findings use, and the refusal names that word
rather than offering a rewrite that cannot help. This is the invariant being
repaired, not a new capability: `diff -t .env src/app.js` publishes the same
bytes and always did, because it names no protected path at all. One false
refusal comes with it, in the safe direction — `git log --grep=.env -- FILE`
loses the exemption over a word in a search pattern.

The residual floor is stated in the refusal text and in `docs/policy-gate.md`
rather than implied: matching flags bounds what a command *says*, not what the
program *does*. An allowed reader can still be pointed at another program by
configuration this gate never reads — a `diff.external` driver or a pager in git
config, a `NODE_OPTIONS` carrying `--require`, a shell function shadowing `cat`.
That is the fifth entry in `SHELL_DECLARED_MISSES`. The sixth is one step
earlier: the program table is keyed on the **basename**, which is what makes
`/bin/cat` and `cat` one entry and also makes a repo-writable `src/cat` an
allowed reader. It is declared rather than closed, because closing it would
close nothing — a script with the path already inside it needs no allowed name
at all, which is the third entry.

## 0.1.15 — 2026-08-14

### Fifteen questions, ten minutes, and the swarm moves

An agent that hits a product decision no longer stops and waits for you. It
raises the question — `journal.mjs ask`, one command, which mints the id under
the journal's write lock so two agents asking at the same moment get two
questions rather than one — states what it recommends and what should ship if
nobody ever answers, and takes the next ticket. The question is a `gate` whose
`kind` IS its id, `Q-<n>`: the closed event set stays at 17, the board's
waiting-on-you queue already rendered it, and `answered` was already a pass
result. What was missing was an identity and a way in.

The way in is a text file. `tyran answer render` writes `.tyran/state/ANSWERS.md`
— every open question across every initiative, the ones with no recorded default
first, because those are the only ones where saying nothing has no safe outcome.
You type under `answer:`. **Blank accepts the recorded default**, verbatim, and
still records it as a decision; `-` leaves it for next time; anything else is your
answer in your own words. `tyran answer apply` folds them back as `decision` +
`gate result: answered` pairs — decision first, so a crash leaves a visible orphan
decision rather than a closed question whose answer was never written down — then
re-renders every projection and the board. It reads the question, the default and
the ticket back out of the journal, never out of the sheet, and it is
all-or-nothing: one unparseable block and nothing at all is appended, with the
line number.

Answering a question no longer needs the conductor to be awake. `SessionStart`
records the session id in `.tyran/state/conductor.json`, so `apply --resume` can
put the swarm back on it — and refuses while that session is still alive, because
two conductors on one journal is a hazard this repo has already paid for once.

One correction found while building it. Parking an asked ticket **hid** it: the
board checks a `ticket.status` override before the ask, so our own demo fixture
showed `waiting-operator (0)` with a question open — the fixture is corrected and
the skill now forbids the override.

Also: `question`, `recommendation`, `default` and `answer` are capped at 2000
codepoints (rejected, never truncated — historical oversizes stay warnings);
`STATE.md`'s open-gates table and the SessionStart probe now carry the question
text, so a resumed conductor sees *what* it asked and not merely that it is
waiting; doctor gains `ask-open` (info) and `ask-stale` (warning, 72 h); the gate
pass set has one spelling again, exported from `project.mjs` and imported by
`overnight.mjs` instead of hand-copied; `tiers` gains an advisory `conductor`
role with a `deep` floor, so the coordinator's model is named in the one file
where model names may live — and says on stderr that no plugin can change your
own session's model.

## 0.1.14 — 2026-08-14

### The repository remembers what went wrong — and eventually writes it into law

Tyran had three places a lesson could land and not one of them answered *how
often*. A journal `finding` dies with its initiative, correctly: it is that
run's discovery. A `.tyran/knowledge/` entry says what an agent must know
before touching a path. `CLAUDE.md` is law. Recurrence was counted nowhere, so
"this has burned us three times" was something a human had to remember, and on
the fourth time it was argued from scratch.

`MISTAKES.md` at your repository root is the store that was missing: what
happened, the root cause, the consequence, the prevention — newest first, plain
prose, yours to edit. The retrospective is its only writer, and it writes an
entry only for a breakage the initiative actually paid for. Every entry carries
a **signature**, and the signature is the whole point: the model decides
whether two failures are the *same* failure, and `scripts/mistakes.mjs`
(`add` · `repeats` · `promote`) does the counting.

**Three open entries under one signature** graduate the lesson into
`.tyran/knowledge/`, where every handoff touching those paths already delivers
it. **Five, still recurring after the knowledge entry shipped**, is evidence
the delivered rule was not enough — the strongest argument for law there is —
and at five `mistakes.mjs promote --law` **writes the rule into your
`CLAUDE.md`**. Not a proposal, not a queue: an autonomous write, between
`<!-- tyran:rules start -->` and `<!-- tyran:rules end -->` and never a byte
outside those markers. The line names the rule, its signature and the dated
entries that earned it; a `decision` event records the act; `--dry-run` prints
the line and writes nothing. You say no by deleting the line — the entries are
already at status `law`, so nothing puts it back. A fence that is absent is
appended once at the end, with its heading, and existing prose is never
reflowed; a fence that is malformed is refused by name, with nothing written.

The safety story is a boundary rather than a sentence. The shipped policy now
classes `CLAUDE.md` as **GATED**, which bans the hand and not the mechanism: a
subagent's free-hand `Write` is denied, while the script that demands five
recorded occurrences passes. Until this rule, the gate was silent on repo-root
files — its governed namespace is `.tyran/`, `.claude/` and the enforcement
scripts — so a subagent could rewrite the law it was bound by and nothing had
an opinion. An explicit rule outranks that namespace test, which is why one
line is enough. Seeding has always been create-only, so existing installs keep
their own policy untouched.

Seeding `MISTAKES.md` is create-only too, and **deleting the file is the whole
opt-out** — no knob for a file you can remove. `doctor --state` grew three
codes, 54 → **57**: `mistakes-repeat-unpromoted` (info — a lesson has earned
promotion), `mistakes-unreadable` (warning), and `claude-md-fence-missing`
(info — entries claim `law` but no fence exists to hold the rule). An absent
ledger is never a finding.

Stated rather than discovered: `MISTAKES.md` is **authored, not a byte-checked
projection**. A projection would report a hand edit as drift and destroy it on
the next render, and a human correcting a wrong root cause is the most valuable
edit this file will ever get. The cost is that nothing compares it to the
journal, so it can drift. Every entry cites its initiative and the event id
that proves it, which makes drift auditable by a human and **not** enforced by
a gate — a weaker guarantee than the projections carry, and both docs surfaces
say so instead of leaving you to assume parity.

This repository ships its own `MISTAKES.md`, five entries, one of them earned
during this release: the control-character write-guard refused an edit twice
because the editing tool turns `\uXXXX` escape text into the character itself,
so a regex class typed as escapes reached disk as raw C0 and bidi codepoints.
The guard was working; the author was the attacker.

### Keep the machine awake while the watcher waits

The overnight resume watcher's whole job is to be asleep for hours, which is
exactly the interval a laptop chooses to suspend in — and a suspended machine
takes the watcher and the network with it. `limits.keep_awake` (a real boolean,
default `false`) wraps the wait in a system-sleep inhibitor: `caffeinate -is`
on macOS, `systemd-inhibit --what=idle:sleep` on Linux. **Never `caffeinate
-d`**: that blocks the display sleep and with it the screen lock, and a machine
left running overnight that never locks is a security regression. The inhibitor
is released on every exit path including `SIGINT` and `SIGTERM`, an unsupported
platform degrades to a no-op instead of refusing to wait, and
`overnight.mjs schedule` tells you which way the knob is set — as a warning,
never a refusal.

### Measured

`node --test "tests/**/*.test.mjs"`: **1133 unit tests, 0 failures** — 34 of
them new in `tests/unit/mistakes.test.mjs` (the entry format, the counting
thresholds, the fence, and every refusal), 11 in `keepawake.test.mjs`.
`scan-control-chars`: clean over 185 tracked text files. The skill description
budget is unchanged at **4352 / 5000** — this release adds no skill and no
agent.

## 0.1.13 — 2026-08-13

### Six concurrent decisions, two ids

`append` took the write lock; issuing the `D-<n>` or `F-<n>` a caller omitted
happened before it, in the CLI. Issuing an id is read-compute-write, so every
concurrent writer read the same journal, computed the same next number, and
then serialized on the lock to write it. Measured on a fresh journal, seven
runs of six simultaneous `decision` appends: **1 to 4 distinct ids for 6
events**, and in the worst run all six carried the same id. Ids are how the
ledger references itself — "see D-2" —
in a file that is never rewritten, so every collision is ambiguous
permanently: neither `validate` nor the projections can say which `D-2` a
later event meant, and the premise of the whole design is many agents writing
one ledger at once.

The id is now issued inside the lock, from the snapshot that call has already
read for the timestamp clamp and the spawn guard — no second read per append,
which a long journal would pay for on every event. The contract is unchanged:
an explicit `data.id` still wins, `"id":""` is still treated as absent, and
only `decision` and `finding` are issued one. The same six-process race now
measures 6 distinct ids for 6 events, and eight genuinely concurrent
processes pin it in the suite.

The exported `append()` moved with the CLI, not behind it: before this release
a `decision` without `data.id` was rejected outright — `invalid event: data.id
is required for ev "decision"` — so every programmatic caller had to compute an
id first and then carry it across exactly the gap this release closes. Omitting
`data.id` is now the safe call rather than an error.

What is atomic is exactly the ids `append` ISSUES — `decision` and `finding`,
where `data.id` was omitted or empty: two of those, concurrent, can no longer
be handed one number. Nothing else moved. `next-id` previews a value while
holding nothing, so an id read there and appended later still loses to any
writer that appended in between — both journal doc surfaces say so, and a
caller that can let `append` issue the id should. An explicit `data.id` is
written verbatim and stays the caller's to keep unique: a journal whose three
`decision` events all carry `D-2` validates `ok`. `ticket.created` is
deliberately outside the issued set — a ticket id comes from the plan, which
numbers its own stories — so there is no atomic path for a `T-` id at all, and
`skills/run/SKILL.md` now says the conductor is the single writer for ticket
creation. And an id at or past 2^53 saturates `max+1`: seeded with
`D-9007199254740992`, `append` issues that same number to every decision after
it, and a 400-digit id yields `D-Infinity` — arithmetic byte-identical to the
previous release, named here rather than changed here.
## 0.1.12 — 2026-08-13

### The board: every ticket in a lane, every question in front of you

The read-only dashboard the roadmap promised, built the only way this state
layer allows: as a projection. `BOARD.md`/`board.json` render next to every
journal with the other projections; `scripts/board.mjs` folds every
initiative into one `.tyran/state/BOARD.md`, `board.json` (schema 1) and
`board.html` — a self-contained page in the landing page's own stone/gold/
glow palette that refreshes itself, puts the waiting-on-you queue first
(question, recommendation, default), lights the agent strip with each
agent's own last signal, and computes ages in the browser so the artefact
itself stays clock-free and byte-checkable. `--serve` adds a loopback-only
always-fresh viewer.

Lanes derive strongest-verdict-first from events that already exist —
`merge`, reviews, reports, running spawns, dep satisfaction (an unknown dep
refuses to schedule), blockages, `ticket.status` overrides, operator asks
(`WAITING_ON_OPERATOR` gates; `answered` joins the pass set), and the
overnight pause. A `SubagentStop` probe re-renders after every agent, with
the CLI's own damaged-journal refusal mirrored so an empty render never
clobbers good state; doctor gains `board-absent` (info) and drift coverage
for the new pair; an unreadable initiative is a visible UNREADABLE entry.

## 0.1.11 — 2026-08-13

### The journal learns what agents are doing, finding, and waiting on

The closed event set grows 14 → 17 — the reviewed core change the journal
page names. `progress` is the agent's own mid-run signal (`started` ·
`working` · `blocked` · `unblocked`, a closed list emitted at four named
points, never part of spawn↔report pairing); `finding` is a claim about a named
area plus the proof for it, queryable by other agents (`F-<n>` ids issued
by `append`);
`ticket.status` is the conductor's lane override for exactly the three
states no lifecycle event can derive (`blocked` · `waiting-operator` ·
`parked`), cleared automatically by the next report, review or merge and
never counted as progress. Both new value sets are closed and rejected at
append naming the whole set; the free-text keys `detail`/`claim`/`proof`
cap at 2 000 codepoints — rejected, never truncated.

STATE.md gains `Open blockages` and `Findings` sections and a per-agent
`Last signal` column; doctor gains `spawn-blocked` (an agent whose own last
signal says blocked, past a threshold); the agent contracts gain the
emission points, the anti-duplication grep, and the implementer's "what you
did NOT do" report section; operator questions and mid-run ticket intake
now land as journal events, so the coming board can render them.

## 0.1.10 — 2026-08-13

### Overnight mode: the usage cliff becomes a wind-down

Both subscription windows were hit live while this was being built — a
five-hour wall at 12:15 and the weekly wall at 15:30, each killing a
four-agent review fleet mid-flight — which is the exact failure this
feature removes. A new `PreToolUse` usage gate reads the telemetry sidecar
that an operator-installed statusline helper (`scripts/statusline.mjs`)
maintains, and near the threshold refuses everything except a closed
wind-down set; the refusal text is the checkpoint checklist itself.
Measured on 2.1.197 and recorded in the hook contract: the hook payload
carries NO rate-limit data, so the statusline is the only telemetry source,
and every unknown fails open — no telemetry, stale telemetry, a malformed
config or a supervised operator can never produce a false pause.

Time-until-reset decides what happens next (`limits.wait_max_hours`,
default 5). Within it, `scripts/overnight.mjs` spawns a detached watcher
that sleeps to the reset and resumes the paused session with
`claude -p --resume`, then babysits it — a resumed headless session has no
statusline, so success is judged by journal movement, never exit codes.
Beyond it — the weekly shape — the pause is LONG: the operator is notified
(desktop notification, session-start banner, doctor) and by default nothing
resumes without them (`limits.long_wait: hold`). The `.tyran/STOP` brake
outranks the watcher; four new doctor codes surface active, stale, dead-
watcher and telemetry-missing states; the overnight runtime files are
name-exempt from the stray-file check and seeded into `.tyran/.gitignore` —
on an install whose gitignore predates them, re-running `scan-repo.mjs`
(`--write` or `--ensure-policy`) appends the missing lines.

The gate registers `node`-dispatched because the policy gate (correctly)
refuses agent-run `chmod` on hook paths; `hooks-check` learned to model
interpreter dispatch.

## 0.1.9 — 2026-08-13

### One layout for an initiative's files

The core disagreed with itself about where an initiative's files live:
`agents/retro.md` read `PLAN.md`/`NOTES.md` and wrote `RETRO.md` under
`.tyran/initiatives/<slug>/`, and iron rule 7 put leases there too — while
every mechanical consumer (journal, projections, doctor, the hooks) reads
`.tyran/state/<slug>/`, which is also where real installs put those files.
Everything now names `state/`; leases move to `.tyran/state/<slug>/locks/`,
already covered by the `.tyran/state/**` AUTO rule. The template keeps the
`.tyran/initiatives/*/locks/**` rule as a dated legacy alias for installs
adopted at ≤ 0.1.8, and `doctor --state` reports a leftover legacy directory
(`state-legacy-initiatives-dir`).

Because `state/` is committed and leases must not be, `scan-repo` (and so
`/tyran:setup`) now seeds a create-only `.tyran/.gitignore` excluding
`state/*/locks/`, and doctor warns when lease files are tracked anyway
(`lease-file-tracked`).

### The knowledge store gets its missing reader

`.tyran/knowledge/` had a writer (the retrospective), a schema, and no
reader — the loop was write-only, and the measured cost was a 137 KB store
nothing consumed. `scripts/knowledge.mjs brief` (also `npx @jjanczur/tyran
knowledge brief`) selects entries whose `applies_to` globs intersect a
story's predicted files, ranks by confidence, cuts to a character budget
with an explicit omission line, and prints a block the conductor pastes
verbatim into a handoff — item (8) of the handoff contract. Reports owe a
verdict on the entry ids they received; the retrospective folds the verdicts
into the `used`/`helpful`/`outdated_reports` counters at close. Oversized
entries (over 4 000 characters) now draw a `knowledge-entry-oversized`
doctor warning, because one document-sized entry crowds out every other
entry a budgeted brief would have carried.

## 0.1.8 — 2026-08-08

### The secrets gate scanned everything except what the command published

A publishing `gh` command recorded its push with no remote and no refspecs,
so the payload estimate fell back to `--all --not --remotes=<target>` —
every unpushed commit on every local branch, none of which `gh pr create`
publishes. In a checkout with many parallel worktrees that range is
permanently over the 4 MiB ceiling (field-measured five times on one
install, latest: 308 objects / 5.4 MB scanned for a command publishing
196 KB), so PR creation was simply unavailable and agents fell back to
manual gitleaks + REST publishes outside the gate. `gh pr create` now
resolves its head positionally and hands it to `pushRange` as the refspec;
everything not positively readable — quoted spans, expansion-bearing
values, flag clusters, a bare `--head` — keeps the wide range, and a union
with an explicit `--all` never narrows. (#36)

### A journal entry describing a filename is not a command publishing it

`journal.mjs append` carries its payload as `--data '{...}'` — the same
prose shape as `-m`, but missing from `MESSAGE_FLAGS`, so a ledger entry
merely naming a dotenv-shaped path was refused as if it published the
file. `--data` is now exempted as prose in both the flag list and
`stripMessageArguments`; a credential-shaped path OUTSIDE the quoted blob
still refuses. Known residuals (apostrophe `sq()` chains and ANSI-C
`$'…'` payloads still unstripped) are documented in the PR for a
follow-up. (#37)

### Rule 7 binds the conductor too

The parallelism discipline read as a rule about spawned agents, leaving
the conductor's own commits in a shared checkout implicitly exempt —
measured cost: three commits on another window's branch and an `--amend`
that welded two windows' work together. A new first bullet under rule 7
makes the worktree the rule from the conductor's FIRST commit, with the
S/M triage entries cross-referencing it. (#38)

## 0.1.7 — 2026-08-07

### The lease protocol nobody could follow

Iron rule 7 says a handoff BEGINS by taking a lease file — and the shipped
policy template had no rule for `.tyran/initiatives/<slug>/locks/`, so the
path fell to `default: GATED`, which denies every subagent unconditionally.
Measured twice in one adopted repo: implementers correctly refused to route
around the gate, and each occurrence cost a full dispatch round-trip before
the conductor took over lease-keeping by hand — exactly the relocation of
state into the lead's memory that the rule exists to prevent. The template now
carries a `locks/**` AUTO rule (gitignored, never history, blast radius one
stale file), a MATRIX test row pins it so a template edit cannot silently
reintroduce the gap, and the run skill names the journal-event fallback for
installs whose repo-local policy predates the rule.

### GATED said "the prompt is the approval" — and then there was no prompt

Under `acceptEdits` — the mode agents actually run in — the main loop counts
as unsupervised, so a GATED write was denied with a message pointing at a main
session that refused the same way. The gate's docstring claimed the platform
offers only `deny` and silence; that claim is outdated. hook-io can now emit
the platform's third answer, an "ask", which renders the user's own permission
prompt even under `acceptEdits`, so GATED means what ADR-06 says wherever a
prompt can render. `bypassPermissions`, unknown modes, and every subagent
keep the hard deny: an ask a mode might not render must fail toward deny,
never toward approval.

### Reviewers that never stop working, and ledger ids nothing can reference

A reviewer never files a `report` about itself — its verdict IS its
completion — so every reviewer spawned per iron rule 3 stayed in the "still
working" set until someone hand-ran `close-spawn` (measured: six-day-old
ghosts in a session-start probe). A `review` now closes its reviewer's
spawn, FIFO like a report, but only a spawn whose role is `reviewer`: the
review's `by` is a free string, and the first review round of this very
release proved a name collision could otherwise mark a working implementer as
reported with a verdict it never earned. `append` also issues a decision id
for an explicit `"id":""` now — a conductor recovering from `next-id`'s
usage error wrote three permanently blank ledger ids, with nothing objecting.

### A gate that blocks reading its own subject

The hooks-path rule fired on ANY token containing the config key, so the
read-only query run mid-incident — to find out WHICH hook had just refused a
push — was itself refused. The same rule, one layer up, then refused the very
commit that fixed it, because the commit MESSAGE quoted the key. Only override
forms deny now, and the review of this release found and closed the bypass the
first narrowing opened: git stores a dash-prefixed value verbatim, so
`-evildir` was a value, not a flag. The code-review skill also gained the
"trace at least one test through the real producer" clause, paid for by a
three-state flag collapse that survived two full review rounds behind
hand-built fixtures.

## 0.1.6 — 2026-08-06

### A browser pass must follow the value to what got STORED

A column-mapping override shipped with a perfect `browser-check` measurement —
15/15 columns visible, 0 console errors, the mapping visibly changed by hand —
and was completely inert. The server re-derived the source type from the
uploaded bytes, discarded the client's mapping, and answered `201` either way.
Nothing in the browser pass could have caught it, because it never inspected
what the server persisted; a reviewer reading the route did.

`browser-check` now says so: when the UI claims to change something the SERVER
acts on, a clean console and a `2xx` are not proof it arrived. Capture the
request body you actually sent, or read the value back with a second request or
a reload, and assert on THAT. The evidence contract already pinned the
execution MODE (dev server vs production build); it said nothing about
following a value past the response into storage.

### A reviewer must never restore an uncommitted tree with git

Breaking the fix to watch its test fail is the right way to prove a guard is
real. The restore is the foot-gun: the work under review is UNCOMMITTED, so
`git checkout -- <file>`, `git restore` and `git stash` all revert to HEAD and
destroy the very thing the reviewer was sent to review. Measured in the field —
a reviewer did exactly this, caught it by re-diffing, and recovered only
because it had taken a backup first. Without the backup the author's work is
gone with no record of what was in it.

`agents/reviewer.md` now carries the procedure: copy to a scratch path, restore
from the copy, prove the restore with `diff`, then disclose the mutation in the
report. The agent already knew it had no edit tools "on purpose" and that
`Bash` can still write — what it lacked was the one sequence where its own
correct technique destroys the subject.


## 0.1.5 — 2026-08-03

### The plugin loads again (0.1.4 did not)

On Claude Code 2.1.197 the plugin failed to load outright — `Duplicate hooks
file detected: ./hooks/hooks.json` — because the manifest declared
`"hooks": "./hooks/hooks.json"` while the harness now auto-loads that standard
path, and the duplicate is fatal. With the hooks unloaded there was no gate at
all: an out-of-repo write the gate exists to refuse went straight through.
Every other plugin ships `hooks/hooks.json` with no manifest reference — the
key is removed. The standard location is auto-discovered on every recent
version, so this is also cross-version safe.

### The main thread may write its own working files

The gate refuses writes outside the repository as KERNEL — correct for a
fanned-out subagent, wrong for Claude Code's own bookkeeping. Adopting Tyran
made the harness unable to write to its memory store or plan files: "outside
this repository". (0.1.4 shipped the memory half of this fix but never loaded,
so users meet it here first.)

The **main thread** — never a subagent — may now write three built-in
out-of-repo locations: the memory store (`<config>/projects/<slug>/memory/`),
the plans directory (`<config>/plans/`), and the per-session scratchpad
(`<tmp>/claude-*/`). For anything else, `.tyran/config.yaml` gains an optional
**`main_writable_paths`** list (globs, `~` expanded) the operator opts into.
Both are actor-scoped: a subagent still falls through to KERNEL, so a parallel
run stays contained. Everything else outside the repo is still refused.

### Retrospectives applied

Four field reports across two initiatives, folded into the conductor and its
tools:

- **`scan-repo`** now recognises `format:check` as a validation command — the
  CHECK name only, because a bare `format` rewrites the working tree. A repo
  that ran it in CI but was missing it from this list shipped two unformatted
  files to main.
- **`run` rule 7** — worktrees must live OUTSIDE the directories Tyran governs
  (`.claude/`, `.tyran/`). One placed inside has every file, `src/**` included,
  fall through to `default: GATED`, and a subagent cannot edit anything.
- **`run` rule 2 (evidence contract)** — measure a fix in the EXECUTION MODE
  the defect appeared in (a `next dev` pass was inert under `next start`), and a
  guard or regression test is proven only by a run in which it FAILS without the
  change: one that matches nothing passes exactly like one that works.
- **`deslop`** — "started with" is the state immediately before THIS pass, not
  the branch point; make the count recomputable by committing the story's work
  and the pass separately.

## 0.1.4 — 2026-08-01

### The gate stopped refusing Claude Code's own memory

Adopting Tyran in a repo made the policy gate refuse the harness's OWN writes:
`Write` to `~/.claude/projects/<slug>/memory/*.md` came back "outside this
repository, class KERNEL". The memory store and the per-session scratchpad are
genuinely outside every repository, so `repoRelative` returned null and the
write matrix answered KERNEL — the same branch that correctly refuses writing
into somebody else's repo. The cost was that the assistant could no longer
persist what it learned while working in a Tyran repo, and a boundary that
blocks the tool's own bookkeeping is one its user turns off.

The gate now exempts exactly two locations, and only for the `main` thread:
`<config>/projects/<slug>/memory/` and `<tmp>/claude-<id>/`. Everything else
outside the repo is still KERNEL; the rest of the config dir — including
`settings.json`, which registers these very hooks — stays untouchable; and a
subagent is never exempted, because it has no business writing outside its
worktree. Bash never hit this: an out-of-repo token yields no finding, so
`echo > scratch` was already allowed — the refusal lived only on the
file-writing tools, which is the asymmetry a user actually meets.

### npm publishes on a pushed tag

`npm-publish.yml` now also triggers on a pushed `v*` tag, not only on a
published GitHub release. npm served 0.1.0 while the marketplace was three
releases ahead, because the manual release step was skipped for 0.1.1, 0.1.2
and 0.1.3; a release step a human has to remember is one that drifts. The
version-must-match-the-tag guard runs for both triggers, and npm refuses a
duplicate version, so the two are idempotent.

## 0.1.3 — 2026-07-29

From two independent field reports on complete initiatives — one M, one L —
run on 0.1.1 and 0.1.2. Five of the reported items are fixed; the rest are
recorded here as open, with the reason.

### A git worktree is the same repository

Two reports described **opposite** failures with one cause: the policy gate
read "the repository" as "this directory tree", and a worktree is neither
inside it nor a different repository.

- **Silent.** A session running *in* a worktree found no `.tyran/` there — the
  directory is committed data and `git worktree add` gives a fresh checkout —
  so the gate concluded Tyran had not been adopted and said nothing. Four
  worktrees, four implementers with no autonomy class and no path classes, and
  `git push origin main` passing at every deployment class.
- **Loud.** A session in the main checkout writing *into* a worktree got
  `normalizePath → null → KERNEL`: every `Edit` refused as "outside this
  repository", while `skills/run/SKILL.md` rule 7 *requires* a worktree per
  agent. Five agents hit it in one initiative and all rerouted through `Bash`
  heredocs — a channel the gate does not class at all. A refusal that moves
  work somewhere less visible is worse than no refusal, and this one was the
  plugin contradicting itself.

The gate now asks which repository a path belongs to. Detection is pure
filesystem — a linked worktree's `.git` is a *file* holding `gitdir:` — so the
write path still runs no child processes. Policy and config are inherited from
the main checkout, and the test is **identity, not proximity**: both sides must
resolve to the same main checkout, so a path in a different repository is still
KERNEL. Three mutants were installed and killed, including one that survived
the first version of the push test — it refused for the wrong reason and the
assertion could not tell.

### `git stash push` was read as `git push`

`words.has('push')` was true when the word appeared anywhere in the segment, so
`git stash push --staged -m "conductor: ..."` — purely local — was classified as
a publish. The remote was then read as the token after the word: `conductor` out
of the message, or `2` out of a `2>&1`. The refusal told the operator to run
`git remote set-head conductor -a`, which cannot succeed, about a repository
whose default branch was recorded all along.

The cost was not one bad refusal: rule 7 *requires* addressed stashes to protect
other windows' work, so the gate refused the safe half of a workflow the plugin
mandates and pushed agents toward the deprecated positional form. `git remote
add` and `git worktree add` had the same shape against the `add` rule — and
`worktree add` is what rule 7 tells every parallel agent to run.

Classification now resolves the **subcommand slot**. It is not a pure narrowing:
`git subtree push` publishes for real and its verb is the second word, so
namespace subcommands forward their verb. Dropping that would have traded a
false positive for a false negative on a genuine push.

### `journal.mjs append` issues the id it used to demand

`skills/run/SKILL.md` says IDs never come from memory, because after a
compaction memory hands out the same number twice — and `append` then *rejected*
a missing `data.id`, leaving the conductor to remember a separate `next-id`
call. Measured: 12 decision IDs hand-assigned from memory in one initiative,
the exact failure the rule names, with nothing objecting. Both reports raised
it independently. An explicit id still wins.

Two errors that could only be answered by grepping the plugin's source now
answer themselves: a rejected `ev` lists the closed set, and a missing `data`
key names the whole contract for that event rather than the first key checked.
`--help` prints the per-event table.

### Worktrees, in the conductor's own words

Rule 7 said "a git worktree per agent" and stopped. A fresh worktree has no
dependencies, so every validation command exits 127 and the evidence contract
cannot be satisfied by construction. The rule now says to link the main
checkout's dependency directory — safe precisely because the manifest and
lockfile are already a shared zone nobody may edit — and notes that
`.tyran/state/**` exists only in the main checkout.

Also: the conductor is told it is notified when a subagent finishes and should
not poll. On a real run most polled checkpoints fired after the agent had
already reported, and the operator watched the conductor disown dozens of stale
notifications.

### Open, and why

- **No lease on the checkout.** Two agents in one checkout is the failure rule 7
  exists to prevent, and nothing enforces it; leases cover the heavy slot and
  not the working tree. The reporting retro reached the same conclusion and
  refused to patch it locally, correctly — the only real fix is a hook, and
  `hooks/**` is KERNEL, so no session can build one. It needs a design pass,
  not a hurried one.
- **The gate matches command TEXT**, so `ls -1 .npmrc` is refused as a
  credential read though it reads nothing, and the scratch directory a `GATED`
  refusal tells an agent to write its diff into is refused as outside the repo.
  The second is self-defeating and should be fixed; both are refusal semantics.
- **`doctor` does not enumerate worktrees or cross-check `RELEASED` leases**
  against resources that still exist. A field run lost a validation baseline to
  32,243 phantom lint errors from leftover worktrees.
- **Forge detection.** Tyran assumes GitHub; on Bitbucket the default terminal
  step of the default autonomy class has no defined path, and two agents each
  rediscovered that.

## 0.1.2 — 2026-07-29

From a field report on a real 0.1.1 install. Every item below is a failure
somebody hit, not one anybody predicted.

### The worktree with no boundary

**`git worktree add` carries tracked files only, and the policy gate is
deliberately silent in a repo with no `.tyran/`.** Put those together and an
uncommitted `.tyran/` means every worktree the conductor creates has no config
and no policy — so the agents there run with **no autonomy class and no path
classes at all**. Nothing is refused, nothing fails, and `git push origin main`
returns `PASS` on line 1213 of the gate. Measured: four worktrees, four ungated
implementers, and no way for the operator to see it.

This is the worst kind of defect this project can have, because Tyran's whole
argument is that the boundary is a mechanism rather than a promise — and here
it was absent precisely where the most agents run.

Three changes, none of which touch the gate:

- `doctor --state` gains **`tyran-dir-untracked`** (warning): git is asked
  whether anything under `.tyran/` is tracked. It returns *no answer* outside a
  work tree rather than inventing one, the same discipline the lockfile rule
  below uses;
- `/tyran:setup` now ends by asking for the commit, **with the reason**, rather
  than leaving `.tyran/` sitting untracked;
- the conductor treats a worktree without `.tyran/` as a precondition failure,
  and is told to fix it by committing on the main checkout — not by copying the
  file in, which just makes four divergent configs one layer down.

### Two inferences that produced a broken gate

**A validation command that watches does not fail an agent, it hangs it.**
Setup wrote `pnpm test` into a repo whose `test` script is bare `vitest` —
watch mode, no output, no timeout, a session that simply stops. `detectValidation`
now reroutes to a run-once variant (`test:run`, `test:ci`, `test:once`) and, if
there is none, **leaves the command out** and flags the config rather than
writing a booby trap. The rule is deliberately narrow — `jest` runs once by
default and is not treated as a watcher — because a false positive here silently
drops a real test command.

**A lockfile on disk is not evidence that it is the repo's lockfile.** The same
install had `pnpm-lock.yaml` gitignored and untracked alongside the tracked
`package-lock.json` that its deploy actually builds from, and `.gitignore` said
so in words. Picking by disk order chose pnpm, and then every single validation
command was wrong. `detectPackageManager` now asks git which lockfiles are
tracked and says which one it rejected. An empty `git ls-files` means git could
not answer and changes nothing — "not a git repo" is not evidence that a file is
ignored.

Both replay clean against the repository that produced them.

### Errors that named the wrong cause

`yaml-lite` answered every unbalanced quote with *"quote the whole value if it
contains an apostrophe"*. An operator writing a long `source:` as a multi-line
double-quoted string was sent hunting an apostrophe that did not exist, three
times. A value that opens a quote and never closes it now says exactly that,
and says the subset has no multi-line scalars. The apostrophe advice survives
only on the case it is actually about.

`doctor.mjs` with no flag printed *"--state is the only mode today"* long after
`--hooks` shipped, sending readers to look for a flag they already had.

The generated `config.yaml` header now states the YAML subset and asks for the
commit, since both traps are sprung by hand-editing a file whose constraints
were documented somewhere else.

### Still open, deliberately

The report also found that the gate matches on command TEXT, so `ls -1 .npmrc`
is refused as a credential read though it reads nothing, and that a `GATED`
refusal tells an agent to write a diff for the operator while `outside this
repository is never autonomous` refuses the scratch directory that is the
obvious place to put it. That second one is self-defeating and worth fixing.
Both are changes to refusal semantics in a KERNEL file and are not being made
in the same pass as everything above.

## 0.1.1 — 2026-07-29

Both entries below come from one install of 0.1.0 on a real repository. The
version is bumped rather than folded into 0.1.0 because `claude plugin update`
compares **versions**, not commits: with the manifest left at 0.1.0 it reports
"already at the latest version" and users never receive the fix.

### `.tyran/config.yaml` is AUTO, and what that costs is written down

**The file that says how to validate this repo was one an agent could not
fix.** Measured on the same install as below: setup inferred `pnpm test`,
which in that repo is bare `vitest` — watch mode, it never exits, and it would
have hung every agent handed to it. The session that *discovered* that could
not repair the file that said it. It produced a diff, then a heredoc for the
operator to paste, then explained why it would not route around its own gate.
It was right not to. The gate was wrong.

So the shipped policy classes `.tyran/config.yaml` `AUTO`. It is mostly a
description of the repository — package manager, validation commands, shared
zones — and the agent that finds it wrong is what is best placed to correct it.

The cost is real and is now stated in all four places a user might read
(`templates/policies/autonomy.yaml`, `docs/configuration.md`,
`docs/policy-gate.md`, `docs/self-improvement.md`), because an unstated cost is
a false guarantee: **`autonomy:` lives in this file too, so an agent can raise
its own deployment class from P1 to P3 and then push to main.** What remains is
weaker and is said as such — nothing *infers* a raise, and a raise is a diff in
a committed file with its provenance beside it. Note that `docs/policy-gate.md`
had already measured this exact escalation happening *under* GATED, in an
unattended main loop, wherever `Write` is allow-listed; GATED was buying less
here than it looked like it was buying.

The push gate's own refusal named the old class too, and naming a class there
was the underlying mistake rather than naming the wrong one: the text is
per-repo configuration, so any class it prints goes stale the moment somebody
reclassifies the file. It now says the policy decides and names nothing, and
the test asserts the *absence* of a class claim instead of pinning a string
that has already been wrong once.

Two claims that had gone false are corrected rather than left standing:
`README.md`'s "the config file holding it is GATED, not KERNEL" and
`docs/configuration.md`'s "Tyran never raises it on its own — that path is
blocked by the policy hook". A test now pins the class *and* pins that the
template still spells out what it gives up, because flipping it back is a
one-word edit nobody would notice in review.

### Setup no longer locks the repository it is setting up

**`/tyran:setup` created `.tyran/config.yaml` and stopped, and that one
missing file made the repository unwritable.** The policy gate is silent in a
repo with no `.tyran/` directory and refuses every write in a repo that has
one without `.tyran/policies/autonomy.yaml` under it. Both halves are right;
their seam was not. Setup's own first command moved a fresh repo from
"unmanaged" to "refuses everything" — including the write that would have
installed the missing policy. Measured on a real install: the session ended
with the operator being handed a `mkdir` and a `cp` to run by hand, in the
middle of a one-command setup.

`scan-repo.mjs` now installs the policy from the shipped template **before**
it writes the config, and removes what it created if it cannot, so a failed
bootstrap cannot leave behind the exact state it exists to prevent. A repo
from before this change is repaired with `--ensure-policy`, which touches
nothing else.

That is bootstrap, not a loop authorizing itself, and the difference is
mechanical rather than a matter of intent: it only ever creates — an existing
policy is never read, merged or overwritten — and what it writes is the
shipped template byte for byte, the strictest default Tyran has. No input
makes it emit something weaker. Editing the file afterwards is human-only,
enforced exactly as before. Three tests pin the properties that make that
sentence true rather than aspirational: byte-identity with the template, an
untouched hand-written policy across setup and repair, and no `.tyran/` left
on disk when the install fails.

Two smaller things the same incident exposed. `doctor`'s `policy-missing`
finding was severity `info` — a repository where every tool call is denied,
reported as a note — and its suggested fix was a `cp` naming the policy path,
which the gate refuses when an agent runs it; it is now an `error` carrying a
command that works. And the documented `schema.mjs validate policy
.tyran/policies/…` line is one a **human** runs: inside a session it names a
path under `.tyran/policies/**` and is refused like any other. `doctor --state
--dir .tyran` validates the same file and names only the directory. The docs
say so now, and `/tyran:setup` runs the latter.

## 0.1.0 — 2026-07-27

### Six protocol skills, and the budget raised once to pay for them

**The conductor was ordering work it had never defined.** Rule 3 required a
browser pass "navigation, clickability, a clean console" and an "optimization
pass per story"; `fidelity-gate` step 4 required computed styles dumped to
JSON; rule 4 made a human-reviewed PR the default ending. Not one of those had
a protocol behind it, so each meant whatever the agent doing it decided that
afternoon. Six skills now carry them — `browser-check`, `deslop`,
`code-review`, `root-cause`, `pr-feedback`, `skill-writing` — and each is
wired into the caller that was already asking for it. **A protocol is admitted
here only when something names it**, which is the rule that keeps the number
at fourteen rather than forty.

Two are worth calling out. `pr-feedback` exists because GitHub keeps pull
request feedback in three separate resources and the inline-comments endpoint
does not contain a review's body: measured on `cli/cli` PR #13944, which has
one review carrying written feedback and **zero** inline comments. An agent
reading one surface there reports "all feedback addressed" — true about what
it read, false about what it claims. And `skill-writing` exists because the
retrospective may commit a new skill without asking (AUTO class); that is only
safe against a standard, and it now has one, including an activation test that
proves the skill fires from a cold session.

**The description budget moved from 4000 to 5000, once, deliberately.** Every
description is loaded into every session whether its skill fires or not, which
is the context tax the README's "small curated core" row is about — and
oh-my-claudecode's issue #2943 describes a budget that was *exceeded*, not one
that was moved. So the raise came with the mechanics that make the difference
real: `DEFAULT_BUDGET` is exported and pinned by a test; `.github/workflows/
ci.yml` no longer carries its own `--budget 4000` copy, because the number
living in two places meant raising one left the other enforcing a ceiling that
existed nowhere in the repo; and raising it stays **GATED** in the autonomy
policy — a retrospective may propose a raise and may not perform one. Current
total: 4340 of 5000, and a test now fails if the README's quoted figures and
the script ever disagree.

**Two more guards, both for claims that decay silently.** The inventory test
now catches a spelled-out count ("fourteen skills and four agents") that has
gone stale, which the digit-anchored check could not see — deliberately
matching only the two phrasings that are claims about what ships, so the
footnote's historical "the first eight skills" stays correct. `agents/scout.md`
gained an output contract for mapping unfamiliar code, so recon comes back as
a one-screen map with entry points, flow and hidden coupling instead of a
directory listing.

### The loop closes: setup, four commands, a bare `/tyran`, and a retro that fires itself

**The retrospective no longer depends on anyone remembering it.** A new `Stop`
gate refuses exactly one turn when an initiative has all its tickets merged
and nothing recorded since the last merge. It anchors on the LAST MERGE
rather than on "any retro ever", so one old retrospective cannot silence
every future initiative in a repo. It short-circuits on `stop_hook_active`
before touching the filesystem, so the worst case is one extra turn and never
a held-open session. It fails open on everything — no journal, corrupt
journal, unreadable initiative — because being unable to prove a retro is
owed is not evidence that one is owed. And declining is a complete answer:
record a `retro.entry` with `kind: skipped` and it is satisfied.

**`/tyran:setup` configures a repo from what is true about it.** The
deterministic half is `scripts/scan-repo.mjs`: package manager from
lockfiles, validation commands from the scripts the repo actually declares,
languages by weight, and an autonomy class inferred from merge history.
Everything carries provenance — value, source, confidence — so "why does this
repo think it is P2" has an answer in the file. Two refusals are deliberate:
it **never infers `P3`**, because no arrangement of files is evidence that a
person meant to let an agent deploy to production; and it returns an EMPTY
validation list rather than guessing `npm test`, because a guessed command
fails for an unrelated reason and teaches the operator that the gate is noise.

**`/tyran` without the colon.** Plugin skills are namespaced, so the
conductor is `/tyran:run`. Setup offers to install a short shim into
`.claude/skills/tyran/` that hands straight over to it — the playbook stays
in the plugin, so updates keep reaching it. Setup asks first, because a file
appearing in someone's working tree unannounced is a bad way to meet a tool.

**Reasoning effort is now a dial of its own**, alongside the model. Most
adjustments want one and not the other: a mechanical sweep on a strong model
still needs no deep reasoning, and a subtle diagnosis on the middle model
usually does. The conductor is explicitly expected to override either for a
single subtask — that is the intended use, not an escape — with every
deviation recorded as a `decision` event. What it cannot do is go under a
role floor, and when a floor corrects a request the tool says so instead of
quietly returning something else.

Also: `/tyran:status`, `/tyran:doctor`, `/tyran:retro`.

The doctor caught a defect in this very change: the platform builds no match
query for `Stop`, so the matcher first written on that entry was decorative.
It is gone, and the registry is clean.

### The conductor and its roster ship: `/tyran:run` plus four agents

`agents/` is no longer empty. `scout`, `implementer`, `reviewer` and `retro`
are real files, carrying the playbook that has been conducting this project's
own initiatives for months — the evidence contract, the lease protocol, the
seven-point handoff, the delta rule for numeric gates, the explicit "NO
INDEPENDENT REVIEW" stamp when review had to be skipped, and the anti-bloat
filter whose correct answer is often *"I changed nothing"*. Two tool grants
are load-bearing rather than incidental: the reviewer gets no editing tools,
so it cannot patch what it is grading, and the scout is read-only apart from
the `Bash` reconnaissance needs. Neither is presented as airtight — `Bash` can
write, and the agent files say so.

`scripts/tiers.mjs` makes model choice a one-line decision. Model names now
appear in exactly ONE file; skills, agents and policies are written in role
names, so a deprecation is an edit rather than a sweep. Four tiers replace
three, because "expensive" was never one thing: `deep` buys harder reasoning,
`top` is for calls where being wrong is both costly and hard to notice. The
default routes everyday work to the middle tier. **Security review and
arbitration carry a floor** that no profile and no risk flag can push them
below — without it, `--profile eco --risk low` would have been a one-flag
downgrade of the two judgements everything downstream trusts. A missing alias
throws instead of falling back to the session default, because routing that
silently does nothing is indistinguishable from routing that works.

`scripts/stop-check.mjs` gives the operator a brake that needs no session:
`echo reason > .tyran/STOP` and the conductor halts before its next spawn or
merge. It is the one reader in this codebase that **fails closed** — an
unreadable STOP, a STOP that is a directory, an empty STOP all stop — because
a brake that releases itself when damaged is not a brake. `.tyran/STOP` is
KERNEL in the shipped policy, and the docs name the hole that leaves. The idea
is adapted from pro-workflow's file kill-switch; the code and semantics are
ours.

The README stops under-claiming in three places and over-claiming in one: the
principle that read *"autonomy … never self-escalated"* now says what was
measured instead.

### The enforcement epic is complete: five hooks, and a doctor that catches a dead one

`policy-gate.mjs` turns the autonomy classes into a refusal: path classes
(AUTO/GATED/KERNEL), a deployment class for `git push`, and one narrow rule on
READS. The read rule exists because a neighbouring project's `.env` was pulled
into a session here in full, unasked — the secrets gate defends PUBLICATION,
and that leak arrived by a READ.

`write-guard.mjs` keeps a control character out of a file on every writing
tool, MCP servers included, and decodes shell escapes so `printf '\U000E0041'`
stops being the way around it. `hooks-check.mjs` answers the question the
plugin could not answer about itself: is a declared gate actually able to fire?
It reports a missing file, a lost execute bit, a matcher that matches nothing,
and — measured from the platform's own entry schema — the four keys that
silently disarm a gate while everything else still looks healthy.

Named honestly: the doctor DETECTS, it does not ENFORCE. It cannot refuse
anything.

### Banner replaced

The hero image is now the code-forging hall: a conductor and a floor of agent
workstations, each screen showing its own state — 65% done, a critical logic
failure, data gathering stalled, self-improvement required. It says what the
product is about better than the pyramid did: the state is on the wall, not in
somebody's summary.

### README: claims narrowed to what exists

Three bullets described a retrospective agent, a delta-review agent and
role-based cost routing in the present tense. None of them has any code, and
`agents/` is empty — scout, implementer and reviewer are a design, not a file.
They are marked as designed-not-built now. The status box lists shipped versus
unbuilt, the roadmap ticks the two epics that are done, and the comparison
table flips three rows from committed to shipped.

One claim was not merely early but false, and the review disproved it by
measurement: *"deployment autonomy classes are never self-escalated."* The file
holding the class is GATED, not KERNEL, so an agent with a broad allow-list can
raise it in the main loop. The README says that now.

### The evidence contract is now a gate, not a request

`hooks/scripts/evidence-gate.mjs` runs on `SubagentStop` and refuses a report
from an implementer or a reviewer that carries no raw command output. The
refusal names what to add and reaches the agent's context, which takes another
turn.

**It blocks SILENCE, not FORGERY** — an invented `232 passed / 0 failed` walks
through it. See [`docs/evidence-gate.md`](docs/evidence-gate.md) for the
criterion, the roles it binds, the recorded `EVIDENCE: none-required` escape
hatch, and the measurements behind all three (53 of 55 real reports from this
project's own agents pass; both misses were not reports).

Every decision, including every exemption, is written to the initiative journal
as a `gate` event, so "how often did someone opt out" is a question with an
answer. `stop_hook_active` caps the cost at one extra turn per agent.

### Behaviour change: invisible characters are SHOWN, not deleted

Projections used to delete invisible codepoints (bidi overrides, zero-width
marks, TAG characters) from journal values. They now render them as escape
notation — `<U+202E>` — because deleting them made a poisoned value and a
clean one look identical, and **ADR-19** requires that an exclusion never be
silent.

**Do you need to regenerate `STATE.md` / `PROGRESS.md`?** Measured, both ways:

- A journal that never contained an invisible character produces
  **byte-identical** projections before and after. `project.mjs --check`
  stays green; nothing to do.
- A journal that *did* contain one drifts, and `--check` exits 1. That drift
  is the point: the projection on disk was hiding characters that were in the
  journal. Regenerate it with the command `--check` already prints:
  `node scripts/project.mjs <journal.jsonl> --out-dir <dir>`.

The same rule now covers every operator-facing channel, not just the two
documents: `project.mjs` warnings on stderr, every `journal.mjs` subcommand
(as JSON `\uXXXX`, so the output still parses back identically), the
`doctor.mjs` report, the session-start context injection, `schema.mjs` and
`desc-budget.mjs`. `yaml-lite.stringify` refuses to serialize such a value at
all, since this YAML subset has no escape that survives a round trip.

- Plugin skeleton: manifest, single-plugin marketplace, directory layout.
- `/tyran:hello` installation smoke-test skill.
- CI: unit tests (`node --test`), skill description budget guard
  (`scripts/desc-budget.mjs`), plugin manifest validation, gitleaks scan.
- Contributor guide with the zero-dependency / no-build-step core rule.
- Secrets gate (`hooks/scripts/secrets-gate.mjs`, `PreToolUse` / `Bash`). The
  gate assembles the payload itself — objects from `git diff --raw` /
  `git rev-list --objects`, contents from `git cat-file --batch`, none of
  which consult `.gitattributes` — pipes it to `gitleaks stdin`, and refuses
  unless the scanner reports reading exactly the bytes it was sent. It models
  the shell's working directory across `cd`/`pushd`/`popd` and refuses any
  movement it cannot follow rather than guessing. A push is measured against
  the remote it targets, not against every remote. `gh release`/`gist` uploads
  are read from disk. `--no-verify` and its abbreviations, `core.hooksPath`
  overrides, `--force` pushes (not `--force-with-lease`) and `kill -9` (all
  spellings, including `kill -n 9`) are refused without scanning. Suppression
  files are honoured only when git tracks them. A refusal never carries the
  scanner's match, elides long opaque runs in paths, and filters rule ids
  through an allowlist. Declared limits, false-alarm rates and the scanner's
  own measured false negatives are in `docs/hooks.md`.
- CI installs gitleaks (pinned by version and sha256) and fails if any test
  was skipped, so the gate's real-binary test cannot silently not run.

### docs (0.1.0, pre-release)

- Brand identity: hero banner (pharaoh conductor, agents building a pyramid),
  README v2 with honest status labels and a receipts-footnoted comparison.
- docs/: getting-started, configuration, architecture, self-improvement, FAQ.
- Security workflow: gitleaks + semgrep (p/ci); all Actions pinned to commit
  SHAs, semgrep container pinned to image digest.
