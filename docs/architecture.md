# Architecture

✅ **shipped** · the state layer, the enforcement hooks, the conductor and the
agent roster, all with tests behind them

This is the design contract for v2. Everything in the tables below exists in
code unless the row says otherwise: a row that is still design carries an
explicit marker, and there is no unmarked aspiration on this page. The
[roadmap](../README.md#roadmap) is where the outstanding work is tracked.

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

```mermaid
flowchart TB
    subgraph L1["Layer 1 — CORE (the plugin)"]
        direction LR
        C1["skills/ · agents/<br/>hooks/ · scripts/"]
    end
    subgraph L2["Layer 2 — REPO DATA (.tyran/, committed)"]
        direction LR
        C2["config.yaml · knowledge/*.yaml<br/>policies/*.yaml · state/&lt;initiative&gt;/"]
    end
    subgraph L3["Layer 3 — LOCAL EVOLUTION (.claude/skills/tyran-local/)"]
        direction LR
        C3["repo-specific skills<br/>agent variants · extra hooks"]
    end

    UPD(["/plugin update"]) -->|"replaces wholesale"| L1
    L1 -->|"reads as an override layer"| L2
    RETRO(["tyran:retro"]) -->|"writes"| L2
    RETRO -->|"writes"| L3
    L1 -.->|"never writes"| L2
    L1 -.->|"never writes"| L3

    classDef core fill:#1f2937,stroke:#d4a017,stroke-width:2px,color:#f9fafb
    classDef data fill:#064e3b,stroke:#34d399,stroke-width:2px,color:#ecfdf5
    classDef local fill:#3b0764,stroke:#c084fc,stroke-width:2px,color:#faf5ff
    class C1 core
    class C2 data
    class C3 local
```

**Read the dotted arrows first.** The core never writes into layers 2 and 3,
which is the entire reason a plugin update cannot destroy what your repo has
learned: the update replaces layer 1 wholesale, and layer 1 owns nothing your
repo produced.

After a core update, a delta-review agent compares the new version's
changelog against layers 2–3 and proposes reconciliation (e.g. "the core
absorbed a rule your repo learned locally — delete the local duplicate").
🎯 **Designed, not built** — the layout is real and the layers are separate
today; the reconciling agent does not exist yet.

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

An initiative, end to end — every arrow below is an event in that journal:

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant C as Conductor<br/>(/tyran)
    participant J as journal.jsonl
    participant A as implementer
    participant R as reviewer

    Op->>C: describes the work
    C->>J: init.created · plan.accepted
    Note over C,J: the plan gate is the last<br/>question until something breaks
    C->>J: ticket.created ×N
    C->>A: spawn (worktree + lease)
    C->>J: spawn · lease.acquired
    A-->>C: report with RAW command output
    Note right of A: SubagentStop gate REFUSES<br/>a report with no evidence
    C->>J: report · lease.released
    C->>R: spawn (never the author)
    R-->>C: APPROVE / CHANGES-REQUESTED
    C->>J: review
    C->>J: merge
    Note over C,J: Stop gate REFUSES to end<br/>an initiative with no retrospective
    C->>J: retro.entry
```

## Enforcement: the hooks

| Event | What Tyran does | Blocking |
|---|---|---|
| `SessionStart` (startup/resume/**compact**) | re-injects the initiative checkpoint into context | no |
| `SubagentStop` | evidence gate: implementer/reviewer reports must contain raw command output — otherwise the report is rejected with a reason | **yes** |
| `PreToolUse` (Bash) | secrets gate: staged diff through gitleaks before commit/push; `--no-verify`, bare force-push blocked | **yes** |
| `PreToolUse` (Write/Edit/Bash) | policy gate: autonomy classes (P1/P2/P3) and self-improvement path classes (AUTO/GATED/KERNEL) | **yes** |
| `Stop` | retro gate: an initiative whose tickets are all merged and which has no retrospective recorded since the last merge refuses ONE turn | **yes** |
| `PreCompact` | writes a checkpoint before compaction — and refuses a **manual** `/compact` it could not write. An **automatic** compaction is never refused, because refusing one would end the session | **manual only** |
| `TaskCompleted` | **🎯 DESIGNED, NOT REGISTERED.** The runtime in `hook-io.mjs` knows the event and would let a gate block on it, but `hooks.json` registers nothing there, so nothing runs. Listed here because the type scaffolding exists and misreads as shipped otherwise. | — |

```mermaid
flowchart LR
    subgraph P["Claude Code emits"]
        E1["SessionStart"]
        E2["PreToolUse<br/>Bash"]
        E3["PreToolUse<br/>Write · Edit · MCP"]
        E4["SubagentStop"]
        E5["Stop"]
        E6["PreCompact"]
    end

    E1 --> H1["session-start<br/>re-inject checkpoint"]
    E2 --> H2["secrets-gate"]
    E3 --> H3["write-guard"]
    E2 & E3 --> H4["policy-gate"]
    E4 --> H5["evidence-gate"]
    E5 --> H6["retro-gate"]
    E6 --> H7["pre-compact<br/>archive checkpoint"]

    H2 --> B{{"BLOCKS"}}
    H3 --> B
    H4 --> B
    H5 --> B
    H6 --> B
    H1 --> N{{"reports only"}}
    H7 --> N

    classDef blocks fill:#7f1d1d,stroke:#f87171,stroke-width:2px,color:#fef2f2
    classDef probe fill:#1e3a5f,stroke:#60a5fa,stroke-width:2px,color:#eff6ff
    class B blocks
    class N probe
```

Design rule: **critical gates fail loudly.** If a gate itself breaks, it
denies with an explanation — it never silently allows.

The exception, stated because it is the one that matters: hooks **fail open**
at the platform level. A gate whose file is missing or whose matcher can
never match does not become a weaker check — the action simply proceeds, with
nothing printed anywhere. That is why `tyran doctor --hooks` exists, and why
a dead gate and a healthy gate are indistinguishable from inside a session
without it.

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
