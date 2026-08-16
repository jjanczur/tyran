# Configuration

written by `scripts/scan-repo.mjs` · validated by
`scripts/schema.mjs`

All per-repo configuration lives in `.tyran/config.yaml` — committed, human
reviewable, written by `/tyran:setup` and editable by hand.

**Or from the board.** `npx @jjanczur/tyran board --serve --write` puts the
cost profile, the deployment autonomy, the four model tiers, the validation
commands, the shared zones and the whole `limits:` block on a screen, each with
a sentence explaining what it does, and writes your change back into this file
one line at a time with the comments intact — the autonomy policy too.
`pricing:` and `main_writable_paths:` stay hand edits. See
[the Settings tab](board.md#settings) for what it will and
will not touch, and for why loosening a boundary there takes a second press.

## `.tyran/config.yaml`

```yaml
# Every inferred field carries its provenance:
#   value · source (file/command that proved it) · confidence · needs_confirmation

profile: balanced          # eco | balanced | full  (cost mode)

autonomy: P1               # P1 branch-only · P2 staging · P3 full
                           # enforced downward by the policy gate; never INFERRED upward

tiers:                     # the ONLY place model names appear
  cheap: haiku             # recon, mechanical sweeps, bookkeeping
  work:  sonnet            # DEFAULT: implementation, ordinary review
  deep:  opus              # root-cause diagnosis, hard implementation, risky review
  top:   fable             # security review, arbitration, acceptance

validation:                # detected from package.json / Makefile / CI
  - npm run lint
  - npm run typecheck
  - npm run test

shared_zones:              # append-only files, serialized by the conductor
  - messages/*.json

main_writable_paths:       # OPTIONAL. Out-of-repo paths the MAIN thread may
  - '~/.claude/plans/**'   # write, on top of the built-ins (the memory store,
                           # ~/.claude/plans/, and the session scratchpad). A
                           # `~` expands to home; globs are the usual `*`/`**`.
                           # Never widens what a SUBAGENT may do — the gate
                           # enforces the actor split; this only lists paths.

limits:                    # OPTIONAL. Overnight mode (docs/overnight.md):
  mode: 'off'              # off | warn | pause — quoted, bare off is YAML false
  pause_at_percent: 97     # five-hour window, [50, 100]
  weekly_pause_at_percent: 97
  wait_max_hours: 5        # beyond this a pause is LONG: notify + hold
  long_wait: hold          # hold | resume
  resume_margin_minutes: 5
  keep_awake: false        # true holds the SYSTEM awake while the resume
                           # watcher waits — never the display, so the screen
                           # lock is untouched (docs/overnight.md)

pricing:                   # OPTIONAL. The spend ledger (docs/cost.md).
  rate_card: 'list-2026-08'  # free label; it travels with every amount
  models:                    # dollars per MILLION tokens; all four required
    <model-id>:              # exactly as the ledger's `By model` table spells it
      input: 15
      cache_write: 18.75
      cache_read: 1.5
      output: 75

spend:                     # OPTIONAL. Where cost.mjs looks for THIS repo's
  transcript_dirs:         # transcripts, when the derived-slug / cwd-probe
    - '~/.claude/projects/-Users-me-work-a-different-checkout'
                           # fallback lands on the wrong session (docs/cost.md
                           # #when-resolution-fails) — a conductor that ran
                           # from a working directory other than the repo it
                           # operates on. `--transcripts` on the command line
                           # outranks this block; both replace the fallback
                           # resolution entirely rather than adding to it.
```

Setup also seeds `MISTAKES.md` at the repository root, create-only. There is no
knob for it: **deleting the file is the opt-out.** What it is for and how an
entry graduates is in [self-improvement](self-improvement.md), and stated only
there.

## Cost profiles

| Profile | everyday work runs on | `top` reserved for | effort |
|---|---|---|---|
| `eco` | `work` | security review, arbitration | lowered on sweeps and bookkeeping, never on security |
| `balanced` | `work` | security, arbitration, acceptance | default per tier |
| `full` | `deep` | security, arbitration, acceptance | raised one step |

Policy is written in **role names, never model names** — a model deprecation
becomes a one-line change in `tiers:`, not a rewrite. A test asserts that no
agent or skill file contains a model alias, so the rule is enforced rather
than merely intended.

The conductor has a row of its own (`deep` under `eco`, `top` otherwise) and it
is **advisory**: no plugin can change a running session's model, so the row
records what your config says the coordinator should be running and `tiers.mjs`
prints that caveat on stderr. Everything else in the table is applied.

The full routing table, the role floors, and how the conductor overrides
either dial for a single subtask are in [the roster](agents.md#choosing-models).

## The rate card

`pricing:` is the only place dollars enter Tyran. It is **operator-written**,
never scanner-inferred — so it carries no provenance wrapper, exactly like
`limits:` — and it is optional. Absent, [the spend ledger](cost.md) reports
tokens and no money, which is the honest default: Tyran does not know what
anyone pays.

| key | required | accepted |
|---|---|---|
| `rate_card` | no | a non-empty label, free text (`'list-2026-08'`, `'enterprise-q3'`) |
| `models` | no | a mapping of model id to a rate block |
| `models.<id>.input` · `cache_write` · `cache_read` · `output` | **all four** | a finite number ≥ 0, in dollars per **million** tokens |

The model id is the string the platform reports, which is what the ledger's
`By model` table prints — copy it from there rather than from a price list, so
the key you write is the key the transcripts will match.

**All four rate keys are required, and that is the point of the block.** A
table carrying three of them would price the fourth at zero, silently; cache
reads alone were measured at roughly three quarters of a real session's cost,
so the omission would not be a rounding error, it would be the bill. A partial
rate card is a wrong number, not a partial one. The validator therefore rejects
a model missing any key, and `pricingOf` drops a model whose rates fail that
shape rather than pricing it — enforcing a value the schema rejects is how a
bad config becomes a confident wrong answer. A dropped model is not silent: it
appears in the ledger's `unpriced` list, counted in tokens and absent from
every amount.

`rate_card` is a label, not a lookup — nothing fetches anything. It exists so
that every amount can say which card produced it, because two people quoting
different cards get different money from one set of tokens.

## Explicit transcript directories

`spend:` is the other optional, operator-written block the spend ledger reads
— no provenance wrapper, exactly like `pricing:` and `limits:`. `cost.mjs`
normally locates a repo's transcripts itself: first by the directory name the
platform derives from the repo path, then, if that is absent, by opening
every project directory and matching on the `cwd` its records carry. Both
assume the conductor session ran **from the repo it operates on**, and when it
did not — Claude Code Desktop opened in a sibling folder, working the repo
through absolute paths and worktrees — neither heuristic can find it: the
transcript lives under a project directory named after the conductor's own
working directory, not the repo's.

| key | required | accepted |
|---|---|---|
| `transcript_dirs` | no | a list of non-empty directory paths, each the per-project directory holding `<session>.jsonl` and `<session>/subagents/` |

A leading `~` expands to the home directory. Given a non-empty list, `cost.mjs`
scans the union of those directories instead of running either heuristic; a
directory that does not exist is reported in the report's
`transcript_dirs_missing` rather than silently skipped. `--transcripts <dir>`
on the command line is the same override and outranks this block when both are
given. Full account of the failure this exists for, and what the board shows
when it fires, is in [the spend ledger](cost.md#when-resolution-fails).

## Autonomy classes

| Class | Tyran may | Always gated |
|---|---|---|
| `P1` | commit + push to a branch, open PRs | any merge |
| `P2` | additionally: merge/release to staging | production |
| `P3` | additionally: merge to main with auto-deploy | irreversible or user-visible operations, feature-flag flips |

The class is **detected** from your repo (branch protection, merge history,
staging presence) and **confirmed by you once**. `scan-repo` never *infers*
`P3`: no arrangement of files is evidence that a person meant to let an agent
deploy to production.

**The hook no longer blocks an agent from raising it, and this page said it
did.** `.tyran/config.yaml` is class `AUTO` in the shipped policy as of this
version — a deliberate trade, made because the same file holds the validation
commands, and a repo whose agents cannot fix a hanging test command is a repo
where the boundary gets deleted wholesale. What is left is weaker and is worth
stating exactly: nothing *infers* a raise, and every raise is a diff in a
committed file with its provenance next to it. If you want the mechanism back
rather than the convention, set the `.tyran/config.yaml` rule in
`.tyran/policies/autonomy.yaml` to `GATED` — it is a one-word edit, and
[`policy-gate`](policy-gate.md) lists what GATED does and does not guarantee.

## Self-improvement boundaries (`.tyran/policies/autonomy.yaml`)

Three artifact classes, enforced by a `PreToolUse` hook on file paths:

- **AUTO** — knowledge facts, rule tweaks, `.tyran/config.yaml`, repo-specific
  skills (with a passing activation test): the retro agent commits these itself.
- **GATED** — new/changed hooks, agent overrides, budget raises, deletion of
  safety rules: proposed, you approve.
- **KERNEL** — the enforcement hooks themselves, the rollback mechanism, and
  this very list: never touched autonomously.

You can tighten (or loosen) the classification per repo by editing the file.

## Validating your files

The schemas are executable — every file family has a validator that CI and
`/tyran:doctor` run:

```bash
node scripts/schema.mjs validate config    .tyran/config.yaml
node scripts/schema.mjs validate knowledge .tyran/knowledge/*.yaml
node scripts/schema.mjs validate policy    .tyran/policies/autonomy.yaml
```

Exit 0 means valid; exit 1 prints one finding per line with the exact path
(`entries[2].confidence: must be a number in [0, 1]`).

The policy line is one **you** run, in your own terminal. Inside a Claude Code
session the policy gate refuses any shell command that names a path under
`.tyran/policies/**`, and it makes no exception for a validator — that is the
boundary protecting itself. An agent checks the same file with
`node scripts/doctor.mjs --state --dir .tyran`, which validates everything in
`.tyran/` and names only the directory.

### YAML subset

Tyran parses a deliberately small YAML subset (zero dependencies) and
**rejects the rest loudly** rather than risk a file meaning something
different here than under a full YAML engine. Supported: mappings, block
sequences, inline flow sequences of scalars, quoted strings, comments,
`---`. Rejected with a line number: anchors/aliases, tags (`!`, `!!`) — in
keys as well as values — block scalars (`|`, `>`), flow mappings (`{}`),
nested flow sequences, tabs for indentation, duplicate keys, and multiple
documents in one file.

Numbers are parsed as decimal integers/floats only: `0x10` and `+5` stay
strings. Serializing a string containing a newline is a hard error (the
subset has no block scalars), and values containing ` #` are quoted — a
round-trip can never change what a file means.

### Knowledge entry schema

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | stable identifier (`K-1`) |
| `kind` | yes | `fact` · `convention` · `gotcha` · `command` · `decision` |
| `text` | yes | the rule, in one sentence |
| `confidence` | yes | 0–1; later retros raise or lower it |
| `provenance[]` | yes | `{source, reference}` — where it was learned |
| `used` / `helpful` / `outdated_reports` | no | counters; entries that stop earning their keep get retired |
| `applies_to[]` | no | path globs this entry is scoped to |
| `supersedes` | no | id of the entry this one replaces |

`provenance[]` entries need both `source` (where it was learned) and
`reference` (which run, file or commit proves it).

Knowledge is **read back** by `scripts/knowledge.mjs brief`, which selects
the entries whose `applies_to` globs intersect the paths a story is about to
touch, ranks them by confidence, cuts to a character budget, and prints a
block the conductor pastes verbatim into a handoff:

```bash
node scripts/knowledge.mjs brief src/lib/feed/pagination.ts 'src/app/**' \
  --kinds gotcha,convention --budget 3000
```

The budget is why entry size matters: `doctor --state` warns
(`knowledge-entry-oversized`) when a single entry's `text` exceeds 4000
characters, because one document-sized entry crowds out every other entry a
brief would have carried. Keep an entry a fact; put the essay in `docs/` and
the pointer here.

Lease files (`state/*/locks/`) are runtime, not history: `/tyran:setup` seeds
`.tyran/.gitignore` to keep them out of git, and `doctor --state` warns
(`lease-file-tracked`) if any are committed anyway.

### Policy precedence

`policies/autonomy.yaml` needs an explicit `default:` class for paths no
rule matches (`GATED` is the safe answer), and the **most specific matching
rule wins** — measured by glob length, ties resolved toward the stricter
class. `**` spans path separators, `*` does not.

Two paths **must** be classified `KERNEL` and the validator rejects any
policy that downgrades or omits them: `hooks/**` and `.tyran/policies/**`.
A system that can hand its own enforcement to the AUTO class has no
enforcement at all — so this boundary can only be tightened, never edited
away by the loop it constrains.
