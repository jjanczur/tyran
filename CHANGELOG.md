# Changelog

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
