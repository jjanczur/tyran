# Tyran

**A task conductor for Claude Code. It runs your work the way a disciplined
engineering team would — and it has receipts.**

Tyran is a multi-agent orchestrator plugin: you describe what you need in
chat, it interviews you (briefly), triages the task, plans, delegates to
fresh-context agents in parallel worktrees, reviews independently, merges
sequentially — and **refuses to believe any agent that can't show raw command
output as proof**. Then it learns how *your* repo works and gets better at it
with every initiative.

> **Status: v2 under active design.** The concepts below are design
> commitments backed by an audit of a battle-tested v1 (five shipped
> multi-day initiatives) and a code-level analysis of the competition.
> Each capability lands with tests before we claim it as done.
> Follow the repo to watch it happen.

---

## Why another orchestrator?

Because in every system we studied — including the most popular ones — the
three things that matter most are soft:

1. **Verification is advisory.** The leading orchestrator's own deliverable
   check states in code that it "never prevents the agent from stopping."
   An agent saying `done` is treated as evidence. It isn't.
2. **State dies with the session.** Knowledge bases survive; the *execution
   loop* doesn't. Crash mid-initiative and the orchestration forgets where
   it was.
3. **Updates destroy learning.** The #1 competitor's two currently-open
   issues are both "update deleted my files."

Tyran's entire design exists to make these three failures **mechanically
impossible** — not discouraged by prompts. Enforced by hooks.

## What makes it different

- 🧾 **Proof-or-it-didn't-happen.** Agent reports without raw command output
  (exit codes, `X passed / Y failed`) are rejected *mechanically* at the
  platform hook level — not by asking nicely in a prompt.
- 🧠 **Learns your repo, not generic tricks.** A retrospective agent runs
  after every initiative and distills *this repo's* rules — commit style,
  validation commands, deployment policy, known traps — through a hard
  anti-bloat filter whose default answer is "change nothing."
- 🔁 **Survives restarts and context compaction.** Execution state lives in
  an append-only journal in your repo; a session hook re-injects it after
  every compaction or resume. The team forgets nothing.
- 🧬 **Three-layer design: update without losing what it learned.**
  Immutable core plugin · your repo's data layer (`.tyran/`) · a local
  evolution layer for repo-specific skills. `plugin update` never touches
  your layers, and a delta-review agent reconciles new core versions with
  local adaptations.
- 💸 **Cost modes that are actually enforced.** `eco` / `balanced` / `full`
  profiles route roles to models via agent frontmatter — policy written in
  role names, never model names, so a model deprecation is a no-op.
- 🔒 **Autonomy with a firewall.** gitleaks gate on every commit/push,
  `--no-verify` and force-push blocked, deployment policy classes
  (branch-only → staging → full autonomy) detected from your repo and never
  self-escalated.
- 🎯 **Small, curated core.** No 40-skill context tax. The
  self-improvement loop prefers *deleting* rules over adding them.

## How it compares

Verified against competitors' **code and public issue trackers** (July 2026),
not their READMEs. ✅ shipped/enforced · ⚠️ partial or prompt-only · ❌ absent
or broken · — not applicable.

| Capability | **Tyran v2** | oh-my-claudecode | metaswarm | pilotfish | pro-workflow |
|---|:---:|:---:|:---:|:---:|:---:|
| Evidence contract that **blocks**: no raw command output → report rejected | ✅ | ⚠️ advisory¹ | ⚠️ prompt | ⚠️ prompt | ❌ |
| Learns **your repo's** rules, with an anti-bloat curator + decision ledger | ✅ | ⚠️ | ⚠️ | ❌ by design | ⚠️ regex-based |
| Execution state survives restart & compaction (journal + re-inject) | ✅ | ⚠️ | ❌² | ❌ | ⚠️ |
| Plugin update **never** destroys local learning (3 layers + delta agent) | ✅ | ❌³ | — | — | ⚠️ |
| Cost modes enforced per repo (`eco`/`balanced`/`full`, role-based routing) | ✅ | ⚠️ docs-only | ❌ | ⚠️ global-only | ❌ |
| Secret-leak firewall for autonomous commits (gitleaks gate, no `--no-verify` escape) | ✅ | ❌ | ❌ | ❌ | ⚠️ |
| Independent reviewer that never grades its own homework — **enforced** | ✅ | ⚠️ | ⚠️ prompt | ⚠️ | ❌ |
| Small curated core — no context tax | ✅ | ❌⁴ | ⚠️ | ✅ | ❌ |
| Safe parallelism: worktree per agent, leases, sequential merge | ✅ | ⚠️ | ❌ | — | ❌⁵ |
| Clean install: 2 commands, **never writes into your `~/.claude`** | ✅ | ❌³ | ⚠️ | ❌ | ⚠️ |
| OSS hygiene: license, changelog, CI validation, pressure tests | ✅ | ⚠️ | ⚠️ | ✅ | ❌⁶ |

<sub>¹ Their deliverable check is explicitly non-blocking ("never prevents
the agent from stopping"). ² Their own issues #32/#33/#36: crash loses loop
state. ³ Open issues #3535/#3536: update deletes user files from
`~/.claude`; historically #40/#2143. ⁴ Their issue #2943: "50+ skills
exceeding context description budget." ⁵ Their issues #73/#74: worktree
hook broke isolated spawns. ⁶ "MIT" badge links to a LICENSE file that does
not exist in the repo.</sub>

## Strategic principles

These are load-bearing decisions, not vibes. The full decision log (ADRs)
ships with the repo.

1. **Native mechanisms only.** Built entirely on Claude Code's plugin
   surface: agent frontmatter, hooks, skills-dir plugins. No custom runtime.
   When the platform absorbs a capability, Tyran drops a layer instead of
   competing with the vendor.
2. **Enforcement over prompts.** A rule that matters becomes a hook or a
   script. Prose is for judgment, mechanisms are for discipline.
3. **Evidence over claims.** From agent reports to our own README table:
   nothing is asserted without receipts.
4. **The repo is the memory.** All state, knowledge, and learned rules live
   in *your* repository as reviewable text files — append-only journal for
   execution, YAML for knowledge, generated Markdown for humans. No hidden
   databases, no build step, no silent degradation.
5. **Local evolution, curated upstream.** Tyran adapts to each repo locally;
   generalizable improvements travel to the core as pull requests — two
   learning loops at different speeds.
6. **Autonomy earns trust in layers.** Deployment policy classes are
   detected, confirmed with you once, and never self-escalated.

## Install

> Coming with the first release:
>
> ```
> /plugin marketplace add jjanczur/tyran
> /plugin install tyran@tyran
> /tyran:setup     # analyzes your repo, proposes config, asks only what it can't infer
> ```

## Roadmap

- [ ] Core plugin: conductor skill, agent roster, evidence-contract hooks
- [ ] `.tyran/` state layer: journal, knowledge schema, generated projections
- [ ] `tyran:setup` repo scanner + `tyran:doctor`
- [ ] Cost profiles (`eco`/`balanced`/`full`) with benchmark receipts
- [ ] Self-improvement loop (`tyran:retro`) with anti-bloat filter
- [ ] Update delta-review agent
- [ ] Read-only dashboard (phase C)

## License

[Apache-2.0](./LICENSE)
