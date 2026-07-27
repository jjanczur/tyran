# Changelog

## 0.1.0 — unreleased

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
