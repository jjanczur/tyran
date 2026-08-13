# Changelog

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
