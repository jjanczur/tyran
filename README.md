<p align="center">
  <img src="assets/banner.jpg" alt="Tyran — a pharaoh conductor overseeing agent workers building a pyramid of code" width="100%">
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
<b>refuses to believe any agent that can't show raw command output as proof</b>. Then it
runs a retrospective on itself, learns <i>your</i> repo's rules and <i>your</i> style,
and autonomously sharpens its own playbook and skills. You bring the harness; it does
the improving.
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

> **Status: v2 under active construction — in public.** The conductor core is
> being built epic by epic (skeleton + CI are done; state layer and
> enforcement hooks are next). Every capability below ships with tests before
> we claim it. Watch the repo to follow along.

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
  `SubagentStop` hook — not by asking nicely in a prompt.
- 🧠 **It learns *your* workflow — autonomously.** After every initiative a
  retrospective agent distills your repo's rules, writes repo-specific
  skills, and tunes Tyran's own playbook — through a hard anti-bloat filter
  whose default answer is *"change nothing"*, and which prefers deleting
  rules over adding them.
- 🔁 **Survives restarts and compaction.** Execution state lives in an
  append-only journal in your repo; a session hook re-injects it after every
  compaction or resume. The team forgets nothing.
- 🧬 **Update-safe evolution.** Three layers: immutable core plugin · your
  repo's data (`.tyran/`) · locally evolved skills. `plugin update` never
  touches your layers; a delta-review agent reconciles new core versions
  with what your repo has learned.
- 💸 **Enforced cost modes.** `eco` / `balanced` / `full` route each role to
  a model *and* effort level via agent frontmatter — policy written in role
  names, never model names.
- 🔒 **Autonomy with a firewall.** gitleaks gate on every commit/push,
  `--no-verify` and force-push blocked, deployment autonomy classes detected
  from your repo and never self-escalated.

## How it compares

Verified against competitors' **code and public issue trackers** (July 2026),
not their READMEs. ✅ shipped/enforced · ⚠️ partial or prompt-only · ❌ absent
or broken · — not applicable · 🎯 **committed in the v2 design, ships
test-gated** (flips to ✅ only when the tests exist and pass).

| Capability | **Tyran v2** | oh-my-claudecode | metaswarm | pilotfish | pro-workflow |
|---|:---:|:---:|:---:|:---:|:---:|
| Evidence contract that **blocks**: no raw command output → report rejected | 🎯 | ⚠️ advisory¹ | ⚠️ prompt | ⚠️ prompt | ❌ |
| Learns **your repo's** rules, with an anti-bloat curator + decision ledger | 🎯 | ⚠️ | ⚠️ | ❌ by design | ⚠️ regex-based |
| Execution state survives restart & compaction (journal + re-inject) | 🎯 | ⚠️ | ❌² | ❌ | ⚠️ |
| Plugin update **never** destroys local learning (3 layers + delta agent) | 🎯 | ❌³ | — | — | ⚠️ |
| Cost modes enforced per repo (`eco`/`balanced`/`full`, role-based routing) | 🎯 | ⚠️ docs-only | ❌ | ⚠️ global-only | ❌ |
| Secret-leak firewall for autonomous commits (gitleaks gate, no `--no-verify` escape) | 🎯 | ❌ | ❌ | ❌ | ⚠️ |
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
- [ ] `.tyran/` state layer: append-only journal, knowledge schema, generated
      human-readable projections
- [ ] Enforcement hooks: evidence gate, secrets gate, policy gate, state
      re-inject
- [ ] `/tyran:run` conductor + agent roster + cost profiles (with benchmark
      receipts)
- [ ] `/tyran:setup` repo scanner + `/tyran:doctor`
- [ ] Self-improvement loop (`/tyran:retro`) + update delta-review
- [ ] Overnight mode (ralph-tui integration)
- [ ] Read-only dashboard (phase C)

## License

[Apache-2.0](./LICENSE)
