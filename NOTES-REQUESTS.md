# Open requests from the operator

Written down because they arrived mid-run and would otherwise live only in a
chat window — the exact failure this project exists to prevent. Newest first.
Delete an entry when it ships; move it to a ticket when it gets picked up.

## 1. Model fallback when a tier's limit is hit — NOT BUILT

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
- Open question for the operator: should a fallback be allowed to move work
  UP a tier (cheaper to more expensive) without asking? That spends more money
  than the routing table promised, which is exactly the property the tier table
  exists to make legible.

## 2. Config editing from the dashboard — SHIPPED 2026-08-15 (0.1.24)

`board --serve --write` → the **Settings** tab. Config *and* the autonomy
policy, every knob with a sentence of prose. See
[docs/board.md](docs/board.md#settings).

Three of the constraints recorded here were resolved differently than planned,
and the difference is worth keeping:

- **Comments are preserved after all.** The operator accepted losing them; it
  turned out not to be necessary. `scripts/yaml-patch.mjs` edits the LINE, not
  the document, and proves the result by re-parsing and comparing. So the file
  keeps the 60 comment lines that are the only place anyone is told that bare
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

## 5. Board defects found by audit, 2026-08-14 — NOT FIXED

Six findings from an audit of `board.mjs` / `board-html.mjs` / `project.mjs`,
each verified against the code rather than the page. Ordered by how badly they
break the page's own promise, which is that it never shows "all is well" when
it is not.

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

## 6. Video with hyperframes + TTS — NOT ASSESSED

`https://github.com/heygen-com/hyperframes` plus an OpenAI TTS voiceover, to
produce short explainer videos and GIFs. I have **not** evaluated the tool and
should not pretend otherwise. The README GIF (`assets/board-demo.gif`) is
recorded from the real board and covers the immediate need.

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

Ranked, still to build:

1. **`/run.json`: is the run supposed to be running?** Three chips reading
   "6 HOURS since last signal" cover four unrelated situations — an operator
   `STOP`, an overnight pause waiting on a reset, a dead resume watcher, and
   genuinely dead agents — and the board distinguishes none of them. Split by
   doctrine: `.tyran/STOP` is committed repo state so it belongs in
   `crossBoard()`'s payload; `paused-until.json` / `resume.json` / `usage.json`
   are machine-local and gitignored, so they must be SERVED, on the same
   argument `cost.json` already makes. `scheduleDecision`, `watcherAlive` and
   `humanWait` are already exported from `scripts/overnight.mjs`. **M.**
2. **Blast radius on the waiting-on-you queue.** Asks sort by age alone, so
   the question holding up six tickets sits below the one holding up nothing.
   `deps[]` is resolved forward in `boardOf` and never reversed. Build the
   reverse index, walk it transitively, sort by it in both `crossBoard()` and
   `answer.mjs renderSheet` — one queue, two renderings. Guard: `deps` is
   optional, and "blocks 0" everywhere is an absence rendered as a
   measurement. **M.**
3. **Signal is not evidence.** Agent freshness comes from `progressByAgent`,
   which is the agent's own self-report: an agent emitting `working` every few
   minutes while achieving nothing is the healthiest-looking chip on the
   board. Keep a second map fed only by events another party produced
   (`report`, `review`, `merge`, `finding`, `lease.acquired` — not `gate`,
   which is conductor-written), show both ages. **M.**
4. **A ticketless `error` event is invisible.** `fold()` collects
   `state.errors`; `crossBoard()` carries neither it nor
   `unknownErrorTickets`, so an agent logging a hard error shows nothing on the
   board that exists to say "not all is well". Needs a NEW key — `errors` in
   the board payload already means "this journal was unreadable", and one key
   with two meanings is the ADR-21 defect by name. **S.**
5. **Cards say how long they have stood still.** `boardOf()` already puts
   `since` on every card and the page never renders it. Client-side only. **S.**
6. **Escalate the tier on a failed attempt.** A ticket that comes back
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
