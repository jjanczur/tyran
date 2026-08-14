<p align="center">
  <img src="assets/banner.jpg" alt="Tyran — a jackal-headed conductor driving a hall of agent workstations, each screen showing its own status: code optimization at 65%, a critical logic failure, data gathering stalled, self-improvement required" width="100%">
</p>

<p align="center">
  <a href="https://github.com/jjanczur/tyran/actions/workflows/ci.yml"><img src="https://github.com/jjanczur/tyran/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/jjanczur/tyran/actions/workflows/security.yml"><img src="https://github.com/jjanczur/tyran/actions/workflows/security.yml/badge.svg" alt="Security"></a>
  <img src="https://img.shields.io/badge/dependencies-0-success" alt="Zero dependencies">
  <img src="https://img.shields.io/badge/Claude_Code-plugin-d4a017" alt="Claude Code plugin">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License: Apache-2.0"></a>
  <a href="https://www.npmjs.com/package/@jjanczur/tyran"><img src="https://img.shields.io/npm/v/@jjanczur/tyran?color=d4a017&label=version" alt="Latest version"></a>
</p>

<p align="center">
  <b><a href="https://jjanczur.github.io/tyran/">📖 Documentation</a></b> ·
  <a href="https://jjanczur.github.io/tyran/getting-started/">Getting started</a> ·
  <a href="https://jjanczur.github.io/tyran/architecture/">Architecture</a> ·
  <a href="https://github.com/jjanczur/tyran/releases/latest">Releases</a>
</p>

<h3 align="center">The more you use it, the better it gets.</h3>

## What Tyran is

Tyran is a Claude Code plugin that runs a task as a **team of agents instead of
one long chat**. You describe the work; it interviews you briefly, plans, and
drives fresh-context subagents through it. Execution state lives in an
append-only journal committed to your repo rather than in the session window, so
a restart, a compaction and a colleague on another branch read the same thing.
Zero runtime dependencies, no build step, Node ≥ 22.

![The Tyran dashboard, recorded live: the waiting-on-you queue scrolling past, the strip of running agents with the time since each one last signalled, the kanban lanes with every ticket in one, and the Spend tab toggling between tokens and cost](assets/board-demo.gif)

## What it gives you

- **A model tier per role, resolved from one config file.** Model names appear
  in exactly one place; skills, agents and policies are written in role names.
  The expensive tier is kept for security review, arbitration and final
  acceptance, and the first two sit on a floor no profile or risk flag crosses.
- **Fresh context for every subagent.** Handoffs are self-contained, so the
  conductor holds the plan and never accumulates its agents' transcripts.
- **Reports that carry evidence, or are refused.** A `SubagentStop` hook
  rejects a report with no raw command output — measured on 55 real reports
  from this project's own agents: 53 pass, and both misses were not reports. It
  blocks silence, not forgery; [the evidence gate](docs/evidence-gate.md) is
  precise about the difference.
- **State you can read without a session.** The journal is the single source of
  truth; `STATE.md`, `PROGRESS.md`, `BOARD.md`, `board.json` and `board.html`
  are generated projections of it.
- **A retrospective after every initiative.** It writes durable facts about
  your repo into `.tyran/knowledge/`, and repeated failures graduate out of
  `MISTAKES.md` into rules.
- **A spend ledger.** `npx @jjanczur/tyran cost` reports what the work cost, in
  the tokens the platform itself reported, per model, per agent type and per
  ticket — read out of the transcripts Claude Code already writes. Money
  appears only under a rate card you write: Tyran does not know what you pay.

## Tyran compared

The axis, not the winner. These rows compare against an ordinary agent session
— a comparison that can be made without guessing at another tool's internals.

| | An ordinary agent session | Tyran |
|---|---|---|
| Where execution state lives | the chat window, and it ends with the window | an append-only journal committed to your repo, with every human-readable file generated from it |
| What makes a report trustworthy | you read the claim | a hook refuses a report with no raw command output |
| Which model does which job | one model for the whole session | four tiers resolved from `.tyran/config.yaml`, per role, with a floor under the judgements everything downstream trusts |
| What happens after the work | nothing | a retrospective writes what this repo taught it back into this repo |
| What it adds to your install | — | zero runtime dependencies, no build step |
| Skills · agents it ships | — | 14 · 4 |

Worth knowing before tuning anything: cache reads were measured at roughly
three quarters of a real session's cost, and the conductor's own context at
between 44% and 86% of a tree's tokens — so the lever is context size and turn
count, not the price of a model. A cell-by-cell comparison against four other
Claude Code orchestrators, verified against their code and public issue
trackers, is in
[the FAQ](docs/faq.md#how-tyran-compares-to-other-claude-code-orchestrators).

## Install

Inside Claude Code:

```text
/plugin marketplace add jjanczur/tyran
/plugin install tyran@tyran
/tyran:hello
```

Restart Claude Code afterwards — hooks and agents are read when a session
starts, so an install you have not restarted into is an install you are not
running. `/tyran:hello` is the smoke test. Requirements: Claude Code ≥ 2.1;
Tyran's scripts are plain Node ≥ 22 and ship with the plugin, so you never run
npm. `/plugin` is a slash command a human has to type — the prompt that has
Claude Code install itself, the npm package for a shell or a CI job, updating
and uninstalling are all in [getting started](docs/getting-started.md).

## Use it

```text
/tyran:setup          # once per repo: scans it, writes .tyran/, installs /tyran
/tyran                # then describe what you want done
```

Setup infers your stack, your validation commands and your deployment autonomy
class from how the repo is actually worked, annotates every value with the fact
that produced it, and asks only about what it could not establish. `/tyran`
then interviews you, sizes the work, and either does it itself or drives the
roster — `tyran:scout`, `tyran:implementer`, `tyran:reviewer`, `tyran:retro` —
through it, stopping only at genuine decisions. Also `/tyran:status`,
`/tyran:doctor`, `/tyran:retro`.

Hit the brake at any time, from anywhere, without killing the session:

```bash
echo "wrong branch — hold everything" > .tyran/STOP
```

## The dashboard

```bash
npx @jjanczur/tyran board --dir .tyran --serve
```

A read-only board on loopback, re-rendered on every request. Four tabs, because
the page answers four questions:

- **Overview** — what is waiting on you, agents running, progress, tickets that
  need a human; then the agent strip, each chip carrying the time since that
  agent last signalled.
- **Board** — every ticket in exactly one of ten kanban lanes, strongest verdict
  first. Click a card for its initiative, agents, note and spend.
- **Waiting on you** — the open questions with their recommendations and
  recorded defaults, above the commands that answer them. The count sits in the
  tab label, so a pending question survives being on another tab.
- **Spend** — tokens, the amount under your rate card, the conductor's share, a
  composition bar across input / cache write / cache read / output, and three
  ranked charts (by model, agent type, ticket) with a tokens/cost toggle.

The same page is written to `.tyran/state/board.html` and refreshed after every
agent, so you can also just open the file. Spend is served rather than embedded
and absent over `file://` — [the board](docs/board.md) says why.

## What ships

Fourteen skills and four agents. Six of the skills are the conductor's own
machinery, though commands rather than internals — `/tyran:doctor` runs on any
repo, initiative or not — and the other eight are standalone protocols.

| Skill | What it does |
|---|---|
| [`run`](skills/run/SKILL.md) | the conductor — interviews, sizes, plans, delegates, merges |
| [`setup`](skills/setup/SKILL.md) | reads the repo and writes `.tyran/config.yaml`, provenance per value |
| [`status`](skills/status/SKILL.md) | where an initiative got to, from the journal rather than from memory |
| [`doctor`](skills/doctor/SKILL.md) | is any gate installed but unable to fire; is the state self-consistent |
| [`retro`](skills/retro/SKILL.md) | the anti-bloat curator that changes Tyran, never your product code |
| [`hello`](skills/hello/SKILL.md) | proves the plugin is installed and its paths resolve |
| [`code-review`](skills/code-review/SKILL.md) | the dimensions a diff is read against, and the rule that you refute a finding before reporting it |
| [`root-cause`](skills/root-cause/SKILL.md) | reproduce first, one variable per experiment, exit by naming the mechanism |
| [`browser-check`](skills/browser-check/SKILL.md) | a UI pass that returns counts — console errors, failed responses, computed styles |
| [`deslop`](skills/deslop/SKILL.md) | the optimization pass: delete before you add, behaviour pinned by a test that ran first |
| [`pr-feedback`](skills/pr-feedback/SKILL.md) | all three of GitHub's comment surfaces, a disposition for every comment |
| [`fidelity-gate`](skills/fidelity-gate/SKILL.md) | build 1:1 against a frozen mockup, measured rather than eyeballed |
| [`prompt-tuning`](skills/prompt-tuning/SKILL.md) | tune a non-deterministic output without chasing noise — noise baseline first |
| [`skill-writing`](skills/skill-writing/SKILL.md) | what a skill has to earn before it ships, and the test that proves it fires |

Agents: `tyran:scout` (recon, read-only), `tyran:implementer` (one story, own
branch), `tyran:reviewer` (no editing tools — it cannot patch what it is
grading), `tyran:retro`. A skill is admitted only when something already asks
for the protocol by name, and every description is loaded into every session
whether the skill fires or not — so the combined length is capped and CI
enforces the cap (4352 of 5000 characters). What each one assumes, and who
invokes it, is in [skills and agents](docs/skills.md). Behind all of it: 1289
unit tests, run with `node --test "tests/**/*.test.mjs"`.

## Documentation

Everything below also reads as a site, with search and rendered diagrams:
[jjanczur.github.io/tyran](https://jjanczur.github.io/tyran/).

| | |
|---|---|
| [Getting started](docs/getting-started.md) | install, first run, the command line, updating |
| [Architecture](docs/architecture.md) | the four failures, the three layers, the hooks, the principles, the roadmap |
| [Skills and agents](docs/skills.md) · [the roster](docs/agents.md) | what each one assumes and who invokes it; the tier and effort table, the `.tyran/STOP` brake |
| [Configuration](docs/configuration.md) | `.tyran/config.yaml`, cost profiles, the rate card, autonomy classes |
| [Self-improvement](docs/self-improvement.md) | how Tyran learns your repo, and its guardrails |
| [Journal](docs/journal.md) · [projections](docs/projections.md) | the append-only event schema, and what is generated from it |
| [The board](docs/board.md) · [the spend ledger](docs/cost.md) | lanes, answering a question, and what a run cost |
| [Overnight mode](docs/overnight.md) · [doctor](docs/doctor.md) | usage-limit pause and scheduled resume; the `--state` and `--hooks` checks |
| [Hook runtime](docs/hooks.md) · [evidence gate](docs/evidence-gate.md) · [policy gate](docs/policy-gate.md) | gates versus probes and why hooks fail open; the criterion and its limits; path classes and where each stops |
| [FAQ](docs/faq.md) | short answers, the comparison table, and where this came from |
| [Contributing](CONTRIBUTING.md) | the dev loop, the test commands, the enforced rules |

## License

[Apache-2.0](./LICENSE)

---

<p align="center">
From Berlin with <b>&hearts;</b> by two buddies &mdash;
<a href="https://janczura.com">Jacek</a> and Piotr.
</p>
