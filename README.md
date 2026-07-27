<p align="center">
  <img src="assets/banner.jpg" alt="Tyran — a jackal-headed conductor driving a hall of agent workstations, each screen showing its own status: code optimization at 65%, a critical logic failure, data gathering stalled, self-improvement required" width="100%">
</p>

<p align="center">
  <a href="https://github.com/jjanczur/tyran/actions/workflows/ci.yml"><img src="https://github.com/jjanczur/tyran/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/jjanczur/tyran/actions/workflows/security.yml"><img src="https://github.com/jjanczur/tyran/actions/workflows/security.yml/badge.svg" alt="Security"></a>
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/Claude_Code-plugin-d4a017" alt="Claude Code plugin">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache-2.0"></a>
</p>

<h3 align="center">The more you use it, the better it gets.</h3>

<p align="center">
Tyran is a task conductor for Claude Code <i>(v2 — under construction, in public)</i>:
it interviews you, plans, drives a team of fresh-context agents through your work — and
<b>refuses to believe any agent that can't show raw command output as proof</b>. That
refusal is real and shipped today. The rest of the arc — a retrospective that learns
<i>your</i> repo's rules and sharpens its own playbook — is the design this is being
built toward, and is <b>not written yet</b>. The status box below draws the line.
</p>

---

## The Problem

You explain your conventions to your agent. Again. It claims *"done — all tests
pass"* — nothing was run. The context compacts mid-initiative and the
orchestration forgets where it was. You finally teach your setup something —
and the next plugin update wipes it out.

Every orchestrator we studied has the same three soft spots: **verification is
advisory**, **execution state dies with the session**, and **updates destroy
learning**. Tyran exists to make those three failures mechanically impossible —
enforced by hooks, not requested by prompts.

## The Solution

```text
        ┌──────────────────────────────────────────────────────┐
        │                      /tyran:run                      │
        │  interview → triage (S/M/L/XL × risk) → plan → gate  │
        └────────────────────────┬─────────────────────────────┘
                                 ▼
      ┌────────────┐      ┌────────────┐      ┌────────────┐
      │   scout    │      │ implementer│      │  reviewer  │
      │ (recon,RO) │ ───▶ │ (worktree) │ ───▶ │ (≠ author) │
      └────────────┘      └─────┬──────┘      └─────┬──────┘
                                │  EVIDENCE GATE ✋  │  proof or rejected
                                ▼                    ▼
        ┌──────────────────────────────────────────────────────┐
        │   append-only journal (.tyran/) — survives restarts  │
        └────────────────────────┬─────────────────────────────┘
                                 ▼
        ┌──────────────────────────────────────────────────────┐
        │  /tyran:retro — learns YOUR repo, improves itself    │
        └──────────────────────────────────────────────────────┘
```

**What compounding looks like:**

```text
Initiative 1   Tyran scans your repo, infers your validation commands,
               your commit style, your deployment policy. Asks once.
Initiative 5   It knows your shared-file hot zones, your flaky tests,
               your review taste. Its retro has already deleted two of
               its own rules that weren't earning their keep.
Initiative 20  It has written repo-specific skills for your recurring
               work, tuned its own agent prompts to your stack, and its
               cost profile routes every subtask to the cheapest model
               that can do the job. You mostly just approve gates.
```

> **Status: v2 under active construction — in public.** Built epic by epic.
> **Shipped and tested:** the plugin skeleton and CI, the `.tyran/` state
> layer (append-only journal, schema, generated projections, doctor), and the
> enforcement hooks — evidence gate, secrets gate, policy gate, write guard,
> state re-injection, and a doctor check that catches a gate which cannot
> fire. 772 tests.
> **Not built yet:** the `/tyran:run` conductor, the agent roster itself
> (`agents/` is empty — scout, implementer and reviewer are a design, not a
> file), `/tyran:setup`, cost profiles, and the self-improvement loop.
> The diagram above is the target architecture; the gates in it are real
> today, the three role boxes are not. Every capability ships with tests
> before it is claimed, and the roadmap below says which is which.

## Quick Start

> Works today (smoke test); the full conductor lands with the next epics.

```text
/plugin marketplace add jjanczur/tyran
/plugin install tyran@tyran
/tyran:hello          # verifies installation and namespacing
```

Coming next: `/tyran:setup` — scans your repo (stack, validation commands,
git history, deployment style), writes `.tyran/config.yaml`, and asks you
only what it couldn't infer.

## What makes Tyran different

- 🧾 **Proof-or-it-didn't-happen.** Agent reports without raw command output
  (exit codes, `X passed / Y failed`) are rejected *mechanically* at the
  `SubagentStop` hook — not by asking nicely in a prompt. **This gate blocks
  SILENCE, not FORGERY:** an agent that invents the text `232 passed / 0
  failed` walks straight through it. The gate raises the price of a lie — it
  has to be deliberately fabricated rather than simply waved away — and it does
  not remove it. Nor is the criterion "raw command output" — mechanically it is
  *"a digit next to one of seven test-runner keywords"*, so a build log without
  an exit code is refused and a sentence containing `6 / 6 passed` is not.
  Measured on 55 real reports from this project's own agents: 53 pass, and both
  misses turned out not to be reports at all. Details, numbers in both
  directions, and limits in [the evidence gate](docs/evidence-gate.md).
- 🎯 **It will learn *your* workflow — autonomously.** *(designed, not built —
  no code yet.)* After every initiative a retrospective agent is to distill
  your repo's rules, write repo-specific skills, and tune Tyran's own
  playbook — through a hard anti-bloat filter whose default answer is
  *"change nothing"*, and which prefers deleting rules over adding them.
- 🔁 **Survives restarts and compaction.** Execution state lives in an
  append-only journal in your repo; a session hook re-injects it after every
  compaction or resume. The team forgets nothing.
- 🎯 **Update-safe evolution.** *(designed, not built.)* Three layers:
  immutable core plugin · your repo's data (`.tyran/`) · locally evolved
  skills. The layout is real — `.tyran/` exists and is never written by the
  plugin's own files — but the delta-review agent that reconciles a new core
  version with what your repo has learned does not exist yet.
- 🎯 **Enforced cost modes.** *(designed, not built.)* `eco` / `balanced` /
  `full` are to route each role to a model *and* effort level via agent
  frontmatter — policy written in role names, never model names. There is no
  routing today, because there are no agent files to carry the frontmatter.
- 🔒 **Autonomy with a gate on the irreversible step.** Every commit and push
  is scanned for secrets before it happens — the gate assembles the payload
  itself and verifies the scanner covered all of it, so a `.gitattributes`
  line cannot hide anything from it. `--no-verify` (and its abbreviations) and
  force-pushes are refused; a push to your production branch is refused at the
  strictest autonomy class, including through `HEAD`, `@`, a shell variable or
  a `git -c` alias. **What it does not do is stop an agent from raising the
  class itself:** the config file holding it is GATED, not KERNEL, so an agent
  with a broad allow-list can edit it in the main loop — measured, not
  supposed. Autonomy classes are a convention the gate enforces downward, not
  a lock. Not a firewall, and
  [docs/hooks.md](docs/hooks.md) says exactly where it stops — including the
  scanner's own measured false-negative rate.

## How it compares

Verified against competitors' **code and public issue trackers** (July 2026),
not their READMEs. ✅ shipped/enforced · ⚠️ partial or prompt-only · ❌ absent
or broken · — not applicable · 🎯 **committed in the v2 design, ships
test-gated** (flips to ✅ only when the tests exist and pass).

| Capability | **Tyran v2** | oh-my-claudecode | metaswarm | pilotfish | pro-workflow |
|---|:---:|:---:|:---:|:---:|:---:|
| Evidence contract that **blocks**: no raw command output → report rejected | ✅ | ⚠️ advisory¹ | ⚠️ prompt | ⚠️ prompt | ❌ |
| Learns **your repo's** rules, with an anti-bloat curator + decision ledger | 🎯 | ⚠️ | ⚠️ | ❌ by design | ⚠️ regex-based |
| Execution state survives restart & compaction (journal + re-inject) | ✅ | ⚠️ | ❌² | ❌ | ⚠️ |
| Plugin update **never** destroys local learning (3 layers + delta agent) | 🎯 | ❌³ | — | — | ⚠️ |
| Cost modes enforced per repo (`eco`/`balanced`/`full`, role-based routing) | 🎯 | ⚠️ docs-only | ❌ | ⚠️ global-only | ❌ |
| Secret gate on commit/push with verified scan coverage, no `--no-verify` escape | ✅ | ❌ | ❌ | ❌ | ⚠️ |
| Independent reviewer that never grades its own homework — **enforced** | 🎯 | ⚠️ | ⚠️ prompt | ⚠️ | ❌ |
| Small curated core — no context tax | 🎯 | ❌⁴ | ⚠️ | ✅ | ❌ |
| Safe parallelism: worktree per agent, leases, sequential merge | 🎯 | ⚠️ | ❌ | — | ❌⁵ |
| Clean install: 2 commands, **never writes into your `~/.claude`** | ✅ | ❌³ | ⚠️ | ❌ | ⚠️ |
| OSS hygiene: license, changelog, CI validation, pressure tests | ✅ | ⚠️ | ⚠️ | ✅ | ❌⁶ |

<sub>¹ Their deliverable check is explicitly non-blocking ("never prevents the
agent from stopping"). ² Their issues #32/#33/#36: crash loses loop state.
³ Open issues #3535/#3536: update deletes user files from `~/.claude`.
⁴ Their issue #2943: "50+ skills exceeding context description budget."
⁵ Their issues #73/#74: worktree hook broke isolated spawns. ⁶ "MIT" badge
links to a LICENSE file that does not exist in the repo.</sub>

## Documentation

- 📖 [Getting started](docs/getting-started.md)
- ⚙️ [Configuration](docs/configuration.md) — `.tyran/config.yaml`, cost profiles, autonomy classes
- 🏛️ [Architecture](docs/architecture.md) — the three layers, the journal, the hooks
- 📜 [Journal reference](docs/journal.md) — the append-only event schema (shipped)
- 🧾 [Projections](docs/projections.md) — generated `STATE.md` / `PROGRESS.md` and `--check` (shipped)
- 🩺 [Doctor](docs/doctor.md) — `--state` consistency check: drift, orphan leases, dead policy rules (shipped)
- 🪝 [Hook runtime](docs/hooks.md) — gates vs probes, why hooks fail open, and what the deadline really promises (shipped)
- 🧾 [Evidence gate](docs/evidence-gate.md) — the criterion, who it binds, the recorded escape hatch, and the line between silence and forgery (shipped)
- 🛡️ [Policy gate](docs/policy-gate.md) — path classes, the deployment class, the one rule on reads, and where each stops (shipped)
- 🧠 [Self-improvement](docs/self-improvement.md) — how Tyran learns your repo, and its guardrails
- ❓ [FAQ](docs/faq.md)
- 🤝 [Contributing](CONTRIBUTING.md)

## Strategic principles

1. **Native mechanisms only.** Built entirely on Claude Code's plugin surface:
   agent frontmatter, hooks, skills-dir plugins. No custom runtime. When the
   platform absorbs a capability, Tyran drops a layer instead of competing
   with the vendor.
2. **Enforcement over prompts.** A rule that matters becomes a hook or a
   script. Prose is for judgment; mechanisms are for discipline.
3. **Evidence over claims.** From agent reports to this README's comparison
   table: nothing is asserted without receipts.
4. **The repo is the memory.** All state and learned rules live in *your*
   repository as reviewable text files. No hidden databases, no build step,
   no silent degradation.
5. **Local evolution, curated upstream.** Tyran adapts to each repo locally;
   generalizable improvements travel to the core as pull requests.
6. **Autonomy earns trust in layers.** Detected once, confirmed with you,
   never self-escalated.

## Roadmap

- [x] Plugin skeleton, marketplace, CI (validate ×2, tests, description
      budget, gitleaks, semgrep)
- [x] `.tyran/` state layer: append-only journal, knowledge schema, generated
      human-readable projections, `doctor --state`
- [x] Enforcement hooks: evidence gate, secrets gate, policy gate, write
      guard, state re-inject, and `doctor --hooks` — which catches a gate
      that is installed but cannot fire
- [ ] `/tyran:run` conductor + agent roster + cost profiles (with benchmark
      receipts) — **`agents/` is still empty**
- [ ] `/tyran:setup` repo scanner + a `/tyran:doctor` command (the doctor
      itself ships as `scripts/doctor.mjs`; the slash command does not)
- [ ] Self-improvement loop (`/tyran:retro`) + update delta-review
- [ ] Overnight mode (ralph-tui integration)
- [ ] Read-only dashboard (phase C)

## License

[Apache-2.0](./LICENSE)
