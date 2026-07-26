# Architecture

> **Status:** this page is the design contract for v2 — schemas and hook
> behavior are final, but the state layer, hooks, and agents land with their
> epics (see the [roadmap](../README.md#roadmap)). Today the repo ships the
> plugin skeleton and CI. Present tense below describes the target design.

## The three layers

```text
Layer 1 — CORE (this repo, installed as a plugin; immutable locally)
  skills/ · agents/ · hooks/ · scripts/ · tests/
  Updated via /plugin update. Never edited in your repo.

Layer 2 — REPO DATA (.tyran/ in YOUR repo; committed)
  config.yaml · knowledge/*.yaml · policies/*.yaml · state/<initiative>/
  Pure data. The core loads it as an override layer. This is where Tyran's
  learning about YOUR repo lives — and why updates can't destroy it.

Layer 3 — LOCAL EVOLUTION (.claude/skills/tyran-local/ in YOUR repo)
  A companion skills-dir plugin maintained by the retro agent: repo-specific
  skills, agent variants, extra hooks. Physically separate from both the
  core and the data layer. Loaded natively by Claude Code.
```

After a core update, a delta-review agent compares the new version's
changelog against layers 2–3 and proposes reconciliation (e.g. "the core
absorbed a rule your repo learned locally — delete the local duplicate").

## State: the journal

The source of truth for every initiative is an **append-only JSONL journal**
(`.tyran/state/<initiative>/journal.jsonl`). One line = one event, from a
closed, validated set: `init.created`, `plan.accepted`, `ticket.created`,
`spawn`, `report` (with raw evidence), `gate`, `review`, `merge`, `decision`,
`lease.acquired/released`, `checkpoint`, `retro.entry`, `error`.

Humans never read JSONL: `STATE.md` and `PROGRESS.md` are **generated
projections** with a `GENERATED — do not edit` header (see
[projections.md](./projections.md)). Append-only means a
crash mid-write can at worst produce one truncated final line, which the
reader discards. No database, no build step, git-friendly diffs.

## Enforcement: the hooks

| Event | What Tyran does | Blocking |
|---|---|---|
| `SessionStart` (startup/resume/**compact**) | re-injects the initiative checkpoint into context | no |
| `SubagentStop` | evidence gate: implementer/reviewer reports must contain raw command output — otherwise the report is rejected with a reason | **yes** |
| `PreToolUse` (Bash) | secrets gate: staged diff through gitleaks before commit/push; `--no-verify`, bare force-push blocked | **yes** |
| `PreToolUse` (Write/Edit/Bash) | policy gate: autonomy classes (P1/P2/P3) and self-improvement path classes (AUTO/GATED/KERNEL) | **yes** |
| `TaskCompleted` | no completion without a matching evidence event in the journal | **yes** |
| `SubagentStart` / `PreCompact` | telemetry events; checkpoint archive before compaction | no |

Design rule: **critical gates fail loudly.** If a gate itself breaks, it
denies with an explanation — it never silently allows.

## Agents

| Agent | Constraints (frontmatter, enforced by the platform) |
|---|---|
| `tyran-scout` | read-only tool allowlist; cannot spawn agents |
| `tyran-implementer` | `isolation: worktree`; turn limit; cannot spawn agents |
| `tyran-reviewer` | never reviews its own code; verdict CONFIRMED/REFUTED — a verifier that fixes work stops being independent |
| `tyran-retro` | writes only to AUTO-classified paths |

## Why no custom runtime?

Everything above uses Claude Code's native surfaces: plugin manifests, agent
frontmatter (`model`, `effort`, `maxTurns`, `tools`, `isolation`), hooks, and
skills-dir plugins. That's deliberate: when the platform absorbs a
capability, Tyran drops a layer instead of competing with the vendor — and
nothing here requires trusting our code with more than your repo.
