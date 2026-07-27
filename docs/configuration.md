# Configuration

✅ **shipped** · written by `scripts/scan-repo.mjs` · validated by
`scripts/schema.mjs`

All per-repo configuration lives in `.tyran/config.yaml` — committed, human
reviewable, written by `/tyran:setup` and editable by hand.

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
```

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

The full routing table, the role floors, and how the conductor overrides
either dial for a single subtask are in [the roster](agents.md#choosing-models).

## Autonomy classes

| Class | Tyran may | Always gated |
|---|---|---|
| `P1` | commit + push to a branch, open PRs | any merge |
| `P2` | additionally: merge/release to staging | production |
| `P3` | additionally: merge to main with auto-deploy | irreversible or user-visible operations, feature-flag flips |

The class is **detected** from your repo (branch protection, merge history,
staging presence) and **confirmed by you once**. Tyran never raises it on
its own — that path is blocked by the policy hook, not by good intentions.

## Self-improvement boundaries (`.tyran/policies/autonomy.yaml`)

Three artifact classes, enforced by a `PreToolUse` hook on file paths:

- **AUTO** — knowledge facts, rule tweaks, repo-specific skills (with a
  passing activation test): the retro agent commits these itself.
- **GATED** — new/changed hooks, autonomy class changes, budget raises,
  deletion of safety rules: proposed, you approve.
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
