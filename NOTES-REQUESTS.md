# Open requests from the operator

Written down because they arrived mid-run and would otherwise live only in a
chat window — the exact failure this project exists to prevent. Newest first.
Delete an entry when it ships; move it to a ticket when it gets picked up.

## 1. Model fallback when a tier's limit is hit — SHIPPED 2026-08-15 (0.1.26)

**Observed live, 2026-08-14:** the `fable` tier hit its limit and subagents
**failed** instead of dropping to `opus` and respawning. The weekly window was
still available, so the work could have continued.

What is wanted: when the model behind a tier is exhausted, the spawn falls back
to the next available model rather than dying.

Notes before anyone builds this:

- `scripts/tiers.mjs` resolves a role to a tier to a model name from
  `.tyran/config.yaml`. It resolves; it does not retry. There is no fallback
  chain anywhere today.
- The failure surfaces INSIDE a subagent's API call, not in a hook, so the
  conductor sees a dead agent rather than a typed "limit" signal. Whatever is
  built has to distinguish "limit reached on this model" from every other
  failure, or it will silently re-run genuine errors on a more expensive model.
- Overnight mode already handles the SUBSCRIPTION window (pause, checkpoint,
  resume at reset). This is a different case: one tier is exhausted while the
  account still has budget, so the right move is substitution, not a pause.
- The open question — may a fallback move work UP a tier without asking? — is
  ANSWERED, in the safe direction: it may not. `tiers.mjs --unavailable <alias>`
  walks DOWN the ladder only, never above a role floor, never lowering the
  effort, and exits 2 rather than substituting when every tier a role may use
  is gone. A fallback therefore never spends more than the routing table
  promised, which was the property that made the question worth asking.
- What is still NOT built is the DETECTION. The failure surfaces inside a
  subagent's API call, so the conductor still has to notice a dead agent and
  decide the cause; `--unavailable` is the substitution it reaches for once it
  has. Wiring a typed limit signal into that decision is the remaining half.

## 2. Config editing from the dashboard — SHIPPED 2026-08-15 (0.1.24)

`board --serve --write` → the **Settings** tab. Config *and* the autonomy
policy, every knob with a sentence of prose. See
[docs/board.md](docs/board.md#settings).

Three of the constraints recorded here were resolved differently than planned,
and the difference is worth keeping:

- **Comments are preserved after all.** The operator accepted losing them; it
  turned out not to be necessary. `scripts/yaml-patch.mjs` edits the LINE, not
  the document, and proves the result by re-parsing and comparing. So the file
  keeps the 63 comment lines that are the only place anyone is told that bare
  `off` is the YAML boolean false — and the screen carries the prose too.
- **`.tyran/policies/**` is editable, and its own protection is not.** Keeping
  the policy file out entirely would have removed the most useful thing on the
  screen (tightening `.tyran/config.yaml` back to GATED is the case the
  template's own comment invites). What stays out is the ability to lower
  `hooks/**` or `.tyran/policies/**` — refused by name and again by
  `validatePolicy`.
- **No journal event.** A config change is repo-wide and journals are
  per-initiative, so there is no correct journal to append to. The record is
  the terminal line the server prints plus `git diff`, which is where a
  reviewer looks anyway.

What was ADDED beyond the request, because a review found the gap: loosening
any class, or raising `autonomy`, takes a second deliberate confirmation
naming the exact new value. Without it, `.claude/settings.json` — whose own
reason reads "anything that can edit it can switch every gate off" — was one
click from AUTO.

Still not built from this item: **default agent settings, default models per
role, per-role tier overrides.** The four `tiers:` are editable; a per-role
override table is not, and there is no such key in the schema yet.

## 3. One dashboard per repo — NOT BUILT

When agents run in several repos, show one board per repo (a switcher beside
the tabs). `--serve` would take several `.tyran` directories.

Note: `cost.mjs` is per-repo by construction — the transcript directory is
derived from the repo path — so spend has to be computed per repo and summed,
not read once.

## 4. Ship regularly, do not leave dangling PRs

Standing instruction from the operator: merge to `main` over PRs proactively;
work parked in an open PR is wasted work. Check open PRs before finishing a
session.

## 5. Board defects found by audit, 2026-08-14 — ALL SIX FIXED

Six findings from an audit of `board.mjs` / `board-html.mjs` / `project.mjs`,
each verified against the code rather than the page. Ordered by how badly they
break the page's own promise, which is that it never shows "all is well" when
it is not.

**All six were closed across 0.1.24–0.1.27**, and re-verified against the code
on 2026-08-15 rather than trusted: `warnings(state)` is called and rendered
(`board.mjs`, the `warned` list); the "needs a human" tile is counted
server-side from the lanes *and* the blocked agents; the strip is sorted
stalest-first on evidence and the agent's `next` is rendered; the drill-down
lists `INITIATIVE_FILES` that `existsSync` confirms; a cost failure shows the
server's own sentence via `costError`; and the over-cap `UsageError` is caught
by the request handler, which answers 200 with a readable page — the meta
refresh that turned a 500 into a re-fetch loop is gone as well.

This header said NOT FIXED for a day after the last of them shipped. Prose in
this repo is checkable on purpose and this line was not checkable by anything.

1. **A partially corrupt journal renders as healthy.** `board.mjs` guards only
   total loss (`total === 0`); three readable tickets plus one unparseable line
   produce `errors: []` and a clean board. `warnings()` in `project.mjs`
   produces exactly the text that is missing, and `board.mjs` never calls it.
2. **The "needs a human" tile counts lanes, not humans.** It sums `blocked` +
   `changes-requested`. A ticket parked by a `ticket.status` override whose
   agent is `blocked` lands in neither, so the tile reads 0 while an agent chip
   on the same screen says "blocked" — the override is tested before the
   blockage in `boardOf`.
3. **Staleness is shown but never escalated.** Three colour buckets, the last
   of which is "30 minutes or six hours". Agents render in spawn order, not
   staleness order, so the stalest chip can be last; nothing counts them and no
   tab badge carries them. The agent's own `next` field is folded into
   `board.json` and never rendered.
4. **The drill-down shows no files.** Five rows: lane, initiative, agents,
   note, spend. `board.mjs` already resolves each initiative's journal path —
   whose directory holds `PLAN.md`, `NOTES.md`, `RETRO.md` — and discards it.
   Listing only what `existsSync` confirms satisfies "do not invent files".
   Note `--serve` routes exactly three paths, so a file link needs a route.
5. **A cost failure is indistinguishable from `file://`.** The client maps any
   non-OK response to null and returns silently; the error text `board.mjs`
   builds for the 503 is never displayed. A broken rate card, a crashed reader
   and an unserved page all look the same.
6. **Sixty-five initiatives is a 500 loop.** Over the cap, `renderAll` throws
   inside the request handler and the page becomes plain-text 500 — re-fetched
   every 30 s by its own meta refresh. Below the cap there is no filter, search
   or grouping, so 64 initiatives is one flat pile.

Also: empty state and idle state are byte-identical in shape (`0% · 0 of 0
merged` for both a fresh initiative and a fully stalled one), and no card for a
finished ticket names the agents that did it — `state.tickets[].agents` is
folded and dropped.

## 6. Video with hyperframes + TTS — SHIPPED 2026-08-16

`https://github.com/heygen-com/hyperframes` — HTML in, deterministic MP4 out —
plus a Gemini TTS voiceover. Five cuts: a 3:20 explainer, a 3:53 first-session
tutorial, and three vertical shorts (the mistake, the board, the retro), each
with burned-in captions and an `.srt` sidecar. Catalogue and guidance on which
to send when: [`docs/videos.md`](docs/videos.md).

Published 2026-08-16 — [explainer](https://youtu.be/ThulYtbYNXI),
[onboarding](https://youtu.be/vr49hKk9G8g), and the shorts
[board](https://www.youtube.com/shorts/HKePDLkYDqA),
[mistake](https://www.youtube.com/shorts/2EgRBR0fVRo),
[retro](https://www.youtube.com/shorts/EMcPJj7c0mk). The IDs live in exactly
one file, `site/src/data/videos.json`.

Sources are tracked in `video/`; the renders are **not**. They come to roughly
430 MB, and this repository is what `/plugin marketplace add jjanczur/tyran`
clones, so committing them would put marketing video into every install of the
plugin. The cuts live on YouTube; `assets/video/` carries 1.1 MB of poster
frames and the caption sidecars, which is everything the README and the docs
page actually reference.

Tyran's own secrets gate refused the first attempt at this commit: the payload
was past the 4 MiB it can scan inside its budget, and it refuses rather than
scanning a prefix. That is the gate behaving exactly as designed, and it is
what forced the question of which bytes really needed to be in the tree.

Voice findings, the packing rules and the gotchas that cost a cycle are in
`video/README.md`. The claims the videos make, checked against what actually
ships, are §10 — including the two that need work.

## 7. Feature plan from the munder-difflin study, 2026-08-15

Researched at the operator's request: [munderdiffl.in](https://munderdiffl.in/#how)
and [chaitanyagiri/munder-difflin](https://github.com/chaitanyagiri/munder-difflin)
(v0.4.3, MIT). An Electron desktop app that wraps ten agent CLIs as a "hive":
a GOD orchestrator prompt routing work through atomic-file mailboxes, a
markdown-first semantic memory, per-agent git worktrees, a Pixi.js office
floor, and a Command Center with kanban, fleet, budgets and a Monaco IDE.
Read in full: the repo's `hive.ts` / `hooks.ts` / `config.ts` / renderer, plus
eighteen of its blog posts.

**What does not transfer, and why:** almost all of its surface is a
consequence of being an Electron app with a live main process — a hook socket
server, in-process timers, PTY streams, SQLite, a rendered office. Tyran is a
plugin with no process of its own. Its architectural choices we already share
(append-only log, atomic rename, identity from the path, hooks that exit 0)
are convergent rather than borrowable.

Four lenses proposed 27 ideas against the real code; a synthesis pass verified
each against the repo and killed thirteen. Two of the survivors were shipped
immediately because they were defects rather than features, both found by
this study and both confirmed by reproduction:

- the Settings tab would lower `.claude/settings.json`, `.tyran/STOP` and the
  policy `default` in one click — now behind a confirmation (0.1.24);
- `board.mjs --dir .tyran` crashed with ENOENT on a repo that had been set up
  and never run, and a scanned config carried no `limits:` block at all, so
  the whole Overnight section of the new Settings tab was dead text on every
  fresh install (0.1.24).

**All six are now shipped** — 0.1.25 (STOP, ticketless errors, card ages),
0.1.26 (the tier fallback) and 0.1.27 (`/run.json`, blast radius,
signal-vs-evidence, escalation on a failed attempt). What remains of item 1 is
not routing but DETECTION: the limit surfaces inside a subagent's API call
where no hook can see it, so the conductor still has to notice a dead agent and
write `error {class: 'model-unavailable', model}` before `tiers.mjs` can act on
it. That convention is the seam; closing it needs a platform signal Tyran does
not have.

The original list, for the record:

1. ~~**`/run.json`: the machine-local half of "is the run supposed to be running"**~~ SHIPPED 0.1.27. Three chips reading
   "6 HOURS since last signal" cover four unrelated situations — an operator
   `STOP`, an overnight pause waiting on a reset, a dead resume watcher, and
   genuinely dead agents — and the board distinguishes none of them. Split by
   doctrine, and the committed half is done: `.tyran/STOP` now travels in
   `crossBoard()`'s payload. `paused-until.json` / `resume.json` /
   `usage.json` are machine-local and gitignored, so they must be SERVED, on
   the same argument `cost.json` already makes. `scheduleDecision`, `watcherAlive` and
   `humanWait` are already exported from `scripts/overnight.mjs`. **M.**
2. ~~**Blast radius on the waiting-on-you queue.**~~ SHIPPED 0.1.27. Asks sort by age alone, so
   the question holding up six tickets sits below the one holding up nothing.
   `deps[]` is resolved forward in `boardOf` and never reversed. Build the
   reverse index, walk it transitively, sort by it in both `crossBoard()` and
   `answer.mjs renderSheet` — one queue, two renderings. Guard: `deps` is
   optional, and "blocks 0" everywhere is an absence rendered as a
   measurement. **M.**
3. ~~**Signal is not evidence.**~~ SHIPPED 0.1.27. Agent freshness comes from `progressByAgent`,
   which is the agent's own self-report: an agent emitting `working` every few
   minutes while achieving nothing is the healthiest-looking chip on the
   board. Keep a second map fed only by events another party produced
   (`report`, `review`, `merge`, `finding`, `lease.acquired` — not `gate`,
   which is conductor-written), show both ages. **M.**
4. ~~**A ticketless `error` event is invisible.**~~ SHIPPED 0.1.25. `fold()` collects
   `state.errors`; `crossBoard()` carries neither it nor
   `unknownErrorTickets`, so an agent logging a hard error shows nothing on the
   board that exists to say "not all is well". Needs a NEW key — `errors` in
   the board payload already means "this journal was unreadable", and one key
   with two meanings is the ADR-21 defect by name. **S.**
5. ~~**Cards say how long they have stood still.**~~ SHIPPED 0.1.25. `boardOf()` already puts
   `since` on every card and the page never renders it. Client-side only. **S.**
6. ~~**Escalate the tier on a failed attempt.**~~ SHIPPED 0.1.27. A ticket that comes back
   `changes-requested` is re-spawned at the same tier and fails the same way,
   because the escalation rule lives in the conductor's memory — which iron
   rule 7 already names the least reliable store in the system. `tiers.mjs`
   gains `--journal --ticket`, counts prior failed attempts, shifts up the
   order with a ceiling. Note the honest weakness: "failed attempt" would be a
   regex over verdict strings, and `APPROVING_RE` was written for lane
   assignment, not for spend decisions. **S.**

Rejected with reasons, so nobody re-proposes them: a rolling `recent[]` event
feed inside the byte-compared `board.json` (unbounded growth in a committed
artefact); spend bucketed by hour (bumps the incremental cache schema that
makes the 30-second refresh affordable); a nonce on the write route (the
`application/json` requirement already forces a preflight the server answers
for no origin — the insider path is not a header's problem); journalling a
`decision` per settings write (no correct per-initiative journal exists for a
repo-wide file); a `missions:` scheduler (a new subsystem contending for the
2 KB session-start budget); making `/tyran:hello` a second spelling of
`doctor`; and bending the 64-initiative ceiling before anyone has crossed it —
the measured install is at 31.

One piece of dead weight the study found on the way: `budget:` in
`scripts/schema.mjs`'s `known` list is validated, documented by its own
validation, and read by nothing. It should be deleted.

## 8. `budget:` in the config schema — left in place deliberately

The munder-difflin study flagged `budget:` in `scripts/schema.mjs`'s `known`
list as dead weight: validated, documented only by its own validation, read by
nothing. That is accurate, and it is still there on purpose.

Removing a key from `known` turns any config that carries it INVALID, and an
invalid config makes the policy gate refuse every write in that repo. So the
cost of the tidy-up lands on whoever set the key, and the benefit is a shorter
array. It stays accepted and inert until there is a reason to migrate.

## 9. Dependency and staleness sweep, 2026-08-15

Requested: update the libraries, fix Dependabot, refresh the docs and the
README, clean up technical debt. What it found, and what it left.

**Fixed.** `npm audit` in `site/` reported five vulnerabilities, three of them
high, all transitive — nanoid, js-yaml, fast-uri, dompurify, mermaid. Now
zero, with astro at 7.2.2, starlight at 0.41.7 and playwright at 1.62.1, and
no range in `package.json` moved. Verified on the built site rather than
asserted: `astro check` clean, 18 pages built, 488/488 root-absolute URLs
carrying the base prefix, 0 broken links, worst mermaid contrast 5.68:1.

Three claims had gone stale, and the pattern in all three is the same — a
number or a count that no gate was watching:

- the README said **1314 unit tests**; the suite had 1405. The docs surfaces
  are pinned by `docs-claims.test.mjs`, but its `CLAIM` regex only scans
  `docs/` and `site/`, and each claim it checks is about one test file. The
  README's is about the whole suite, which no unit test can count without
  running the suite from inside itself. CI now compares it against the run it
  already performs, so the check costs nothing.
- the README said the board has **four tabs**; it has had five since 0.1.24,
  and `docs/board.md` said five the whole time. One surface moved, the other
  did not — the exact failure the two-surfaces rule exists to prevent, on the
  one surface that rule does not name.
- `check-browser.mjs` carried a hand-written list of 14 slugs against a site
  of 17 pages. It now reads the content directory.

**Still open, and small.** `assets/board-demo.gif` was recorded at 0.1.22 and
moves through four tabs, so it predates Settings. The alt text no longer
claims it shows the whole page, but a re-record against the current board is
the honest fix — it needs a live board with data and a screen recorder, which
is an operator job, not a scripted one. **Not** with hyperframes: see §6.

**Deliberately not done.** TypeScript stays on 6. `@astrojs/check` is at its
newest release, 0.9.10, and still declares `typescript: ^5.0.0 || ^6.0.0` —
and `astro check` is what the Pages workflow runs, so TS 7 breaks the deploy
rather than a test. Dependabot now ignores that major with the reason written
beside it, and drops it the day the peer range widens.

Nothing else surfaced: no TODO/FIXME/HACK markers in any tracked file, no
orphaned script, every script covered by a test, every doc pair identical in
heading structure, no broken relative link, and the three version files agree.

## 10. Explainer-video claims audited against the code, 2026-08-16

Every spoken claim in the 3:20 explainer was checked against what ships. Nine
are exact — several are near-verbatim quotes of the mechanism's own
documentation — and two need work. Recording the result here because the video
is now the widest-reach description of Tyran, and a video cannot be patched
after someone has watched it.

### Confirmed, mechanism matches the words

| claim | where it is true |
|---|---|
| "batches of at most four, each with his recommendation" | `skills/run/SKILL.md` — "Batch questions — at most 4 at once, each with your recommendation" |
| "the reviewer grades the diff and cannot edit it" | `agents/reviewer.md` grants no `Edit`/`Write`, and says why in its own body |
| "security review always gets the strongest tier — no flag or cost setting can lower it" | `scripts/tiers.mjs` `ROLE_FLOOR`, applied last, after both the risk shift and the override; the CLI announces a floored override rather than correcting it silently |
| "a commit carrying a secret is refused, even inside a markdown file" | the secrets gate scans blobs and is not evaded by `*.pem binary` or even `* binary` in `.gitattributes` — **stronger** than the video claims |
| "it blocks silence, not forgery" | `docs/evidence-gate.md` — "the gate raises the cost of an empty report; it does not measure whether the work happened" |
| "you try to close the session. It refuses. Once." | the retro gate short-circuits on `stop_hook_active`; its own test asserts a session cannot "be blocked twice" |
| "the same failure three times becomes knowledge. Five times, a rule in your repo" | `mistakes.mjs repeats --threshold 3` → `promote --status knowledge`, then five open-or-promoted → `promote --law` into the `tyran:rules` fence |

### Gap 1 — "cheap tier, read only" is a prompt, not a mechanism

The scout is granted `Bash` (`agents/scout.md`: `tools: Read, Grep, Glob, Bash,
WebFetch, WebSearch`). "You change nothing" is the first line of its
instructions — which is exactly the kind of guarantee this project refuses to
accept anywhere else. The video says it twice, and the onboarding cut says
"cheap tier, read only, fresh context".

The reviewer shows the pattern that would fix it: withhold the tools and state
the reason in the file. The scout cannot have `Bash` withheld outright — it
needs `git log`, `rg`, `wc` — so the mechanism has to be a classifier rather
than a tool grant.

**Fill:** give the policy gate a read-only agent class, so a scout's `Bash`
write is refused at `PreToolUse` the way a protected path already is. Until
that ships, the phrase in any NEW script is "changes nothing", not "read only".

### Gap 2 — "this is not an estimate, it is the bill" is said over sample data

The three spend figures are exactly what the sandbox board shows — 404
requests, 4.53M tokens, 54.9% conductor — and they are laid out by the real
rollup (`site/scripts/build-sandbox.mjs` imports `costJson`/`rollup` from
`scripts/cost.mjs`). But the usage rows feeding it are hand-authored, and the
board honestly labels the models `sample-large` and `sample-small` on screen.

So the *mechanism* claim is true — Tyran rolls up the tokens the platform
itself reported — while the *footage* claim is not: that particular bill was
never paid. The line is the one place the slate asserts something the screen
contradicts.

**Fill, in order of cost:**

1. Cheapest and honest — the line becomes "not a guess: the tokens the platform
   itself reported", which is a claim about the mechanism and survives sample
   data. One VO line, one re-render of the explainer.
2. Better — publish a real `cost.json` from an actual initiative into the
   sandbox, so the Spend tab stops saying `sample-large` and the original line
   becomes literally true. This is the one worth doing: it also makes the
   sandbox a stronger artefact than any video.

### Not a gap, but worth knowing

"55% of those tokens were the manager's own context" reads as a cost
*complaint* on first hearing. It is the opposite — it is the argument for
delegation, since that context is what the subagents never have to carry. The
video says "the manager gets its own row, so nothing hides inside the total",
which is the right frame; the shorts drop the second half.

## 11. The `progress` event is dead, and four features rest on it — 2026-08-17

Found while specifying a `spawn-silent` doctor finding. Measured over **388
real journals** under `~/vscode/*/.tyran/state/`:

| event | occurrences | who is told to write it |
|---|---:|---|
| `spawn` | 1532 | the conductor |
| `lease.acquired` | 434 | `agents/implementer.md`, bullet 1 |
| `finding` | 34 | `agents/implementer.md` |
| **`progress`** | **1** | `agents/implementer.md`, bullet 2 |
| `ticket.status` | 0 | the conductor, for three lanes only |

`agents/implementer.md` says *"Signal at four points, no more … Four emissions
per story; this is a closed list, not a diary."* Against 1532 spawns that
predicts roughly 6000 events. There is **one**.

It is not that agents ignore the journal — they wrote 5302 gates and 4585
decisions. It is not that they ignore *this file*: the `lease.acquired`
instruction is the bullet **immediately above**, and it produced 434 events.
This specific instruction does not take.

**What rests on it, and is therefore inert on every real install:**

- `spawn-blocked` (doctor) — reads `progress.state === 'blocked'`. Cannot fire.
- the `blocked` lane — `boardOf` derives it from an open blockage, which is a
  `progress` event. A ticket is only ever `blocked` via an `error`.
- the agent chip's `state` — falls through to `running`/`stale` always.
- "signal is not evidence" (0.1.27, item 7.3) — built a second map so the two
  ages could be compared. The signal half has no input, so the feature reduces
  to the evidence half it was meant to be contrasted with.

**Do NOT ship the `spawn-silent` finding that prompted this.** With 100% of
open spawns silent it would fire on every one — the always-on warning this
repo already refuses by name (see `SEVERITY_BY_CODE`'s comment on `spawn-open`).

**DECIDED 2026-08-17 (0.1.36): options 1 and 2, together.** The measurement
below was made and it settles the mechanism half without waiting for the
compliance experiment. Folding 420 real journals through `boardOf`: **72
running agents on boards, `last_signal === since` for 72 of 72** — never once
an actual signal — with `detail`, `next` and `state: 'blocked'` at zero across
the same set.

So `last_signal` was not merely empty, it was *spawn time under a label saying
"when it last spoke"*, published in three places: the agent chip
(*"N min since last signal"*), the `BOARD.md` column, and the cross-repo line.
A wrong number reads as a measurement; a blank does not. The fallback is gone,
the age the chip shows is now measured from `since` and says *"since it
started"*, and the golden fixture's blind spot is named: its one agent DOES
signal, so the case that is universal in the wild was the case no fixture
covered.

Option 2 shipped with it — `agents/implementer.md` now asks for ONE emission,
at the first blockage. Three of the four were reconstructable from events
another party writes (the lease IS `started`, the report IS the end of
`working`), and a self-report that only its author can contradict is worth less
than one somebody else produces. A blockage is the exception: nothing else in
the journal says an agent is stuck, or why.

Option 3 was rejected: it would delete the one emission carrying information
nothing else can reconstruct. `spawn-blocked` and the `blocked` lane stay, now
fed by an instruction with a plausible chance of being followed. Whether it IS
followed is still unmeasured — revisit with a count of `progress` events after
a few real initiatives under the new wording.

The original three options, for the record:

1. **Derive freshness from what agents actually write.** `lease.acquired`
   (434) is already the `started` signal, and it is emitted at the same moment
   bullet 2 asks for one. `evidenceByAgent` already folds it. Delete the
   `signal` half rather than the `evidence` half.
2. **Cut the instruction to ONE emission**, `blocked`, at the first blockage —
   the only one of the four that carries information a later event cannot
   reconstruct. Four asks yielded 1; one ask might yield some.
3. **Delete `progress` entirely**, with the four features above. Smallest
   system, and honest about what is measured rather than what was designed.

The measurement that decides between them has not been made: nobody has run a
team with a corrected instruction to see whether compliance is an instruction
problem or a mechanism problem.

## 12. Still unbuilt, 2026-08-17 — with what each one needs

Recorded because the list has only ever lived in a conversation.

1. **Messages stream, KNOW vs DECIDE** (Piotr's board). The queue already
   splits `decision · a default is recorded` from `blocking · no safe
   default`; a message is the third kind — something to KNOW, with nothing to
   answer. Needs a new event or a `decision` with no gate, plus dismissible
   and restorable state, which is per-operator and therefore machine-local
   (`localStorage`, like `moved`) rather than journalled. **M.**
2. **Knowledge consolidation.** `scripts/knowledge.mjs` has `auditEntries`;
   nothing emits a consolidated file. The retro step is the producer that does
   not exist. **M.**
3. **Findings carrying the output of the command that produced them.** A
   `finding` has `claim` + `proof`; `proof` is prose. Measured: 34 findings in
   388 journals, median proof length short. The ask is for the raw command
   output, which is a payload-size question the byte-compared projection makes
   non-trivial. **S–M.**
4. ~~**STEP-0 live cloud probe** and **the credential-gate template asking for
   the SSM parameter NAME**.~~ SHIPPED 0.1.36. Both landed in
   `skills/run/SKILL.md`: cloud access is exercised rather than inferred, on
   the same argument STEP 0 already makes about Agent Teams; and a gate must
   never ask for a secret's VALUE, because `journal.mjs ask` writes the
   question and `answer.mjs apply` folds the reply back as a `decision`, both
   into a committed file.
5. **`--help` on `journal`.** Three of the four subcommand-style commands
   (`schema`, `knowledge`, `mistakes`) were fixed in 0.1.37. `journal` is
   left because its usage text is BUILT inside the `UsageError` handler —
   a multi-line expression ending in `.join('\n')` that also lists every
   event and its required `--data` keys. Hoisting it to a constant is the
   fix and it needs care: an attempt to do it mechanically produced a
   syntax error, which is why this is a separate item rather than a
   footnote. **S.**
6. **The third policy-gate false positive** — a word ending `.key`/`.pem`
   refused as a file. Deliberately unfixed: the safe direction is refusing,
   and the obvious fix kills the whole credential family.

Archiving stays dropped (§ measured: 6 of 63 journals archivable, 43 blocked
on an open gate). Skill retirement stays dropped: nothing is retirable today.
