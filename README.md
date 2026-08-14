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

Every long Claude Code session ends the same way. The context fills up, the
plan is somewhere in the scrollback, and *"the tests pass"* is a sentence
rather than something you can check. Start a new session and you start
explaining from the beginning.

Tyran is a plugin that moves the work off the chat window. You describe a task;
it interviews you until the goal is unambiguous, sizes it, and drives
**fresh-context subagents** through it — a scout that only reads, an
implementer per story on its own branch, a reviewer holding no editing tools so
it cannot patch what it is grading. Every decision, spawn, report, merge and
open question is appended to a journal **committed to your repo**, and every
file you read afterwards is generated from that journal. A restart, a
compaction and a colleague on another branch all read the same thing.

Two rules are what make that worth the trouble. A report containing no raw
command output is **rejected by a hook**, not by good intentions. And every
write is classified against a policy file you own **before it happens**, so
*autonomous* is a setting with a blast radius rather than a promise.

![The Tyran dashboard, recorded live, moving through its four tabs: Overview with what is waiting on you and the strip of running agents each showing the time since it last signalled; Board, where selecting a ticket opens its initiative, agents and spend; Waiting on you, the open questions above the commands that answer them; and Spend, toggling the same split between tokens and cost](assets/board-demo.gif)

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
  blocks silence, not forgery; [the evidence gate](https://jjanczur.github.io/tyran/evidence-gate/) is
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
- **It can run overnight, because the usage limit is a wind-down and not a
  crash.** The platform's own behaviour at the limit is a cliff: calls start
  failing mid-flight and agents die between a write and its commit. Near the
  threshold Tyran instead checkpoints, commits the state files, schedules a
  resume and stops — then a watcher wakes at the window reset and continues the
  same session. Leave it working and read the board in the morning. Both
  windows were hit live while the feature was being built; the protocol that
  survived them is what shipped. See [overnight mode](https://jjanczur.github.io/tyran/overnight/).

## Tyran vs. an ordinary session

The axis, not the winner — a comparison that can be made without guessing at
anyone's internals.

| | An ordinary agent session | Tyran |
|---|---|---|
| Where execution state lives | the chat window, and it ends with the window | an append-only journal committed to your repo, with every human-readable file generated from it |
| What makes a report trustworthy | you read the claim | a hook refuses a report with no raw command output |
| Which model does which job | one model for the whole session | four tiers resolved from `.tyran/config.yaml`, per role, with a floor under the judgements everything downstream trusts |
| What happens after the work | nothing | a retrospective writes what this repo taught it back into this repo |
| What it adds to your install | — | zero runtime dependencies, no build step |

## Tyran vs. other Claude Code orchestrators

Five rows of eleven, verified against those projects' **code and public issue
trackers** (July 2026) rather than their READMEs. ✅ shipped and enforced ·
⚠️ partial or prompt-only · ❌ absent or broken · 🎯 committed in the design,
ships test-gated.

| Capability | **Tyran** | oh-my-claudecode | metaswarm | pilotfish | pro-workflow |
|---|:---:|:---:|:---:|:---:|:---:|
| Evidence contract that **blocks**: no raw command output → report rejected | ✅ | ⚠️ advisory¹ | ⚠️ prompt | ⚠️ prompt | ❌ |
| Execution state survives restart & compaction (journal + re-inject) | ✅ | ⚠️ | ❌² | ❌ | ⚠️ |
| Plugin update **never** destroys local learning (3 layers + delta agent) | 🎯 | ❌³ | — | — | ⚠️ |
| Secret gate on commit/push with verified scan coverage, no `--no-verify` escape | ✅ | ❌ | ❌ | ❌ | ⚠️ |
| Clean install: 2 commands, **never writes into your `~/.claude`** | ✅ | ❌³ | ⚠️ | ❌ | ⚠️ |

¹ Their deliverable check is explicitly non-blocking. ² Their issues
#32/#33/#36: a crash loses loop state. ³ Open issues #3535/#3536: an update
deletes user files from `~/.claude`. The other six rows — repo-specific
learning, cost tiers, independent review, context budget, safe parallelism, OSS
hygiene — and every footnote in full are in
[the FAQ](https://jjanczur.github.io/tyran/faq/#how-tyran-compares-to-other-claude-code-orchestrators).

Worth knowing before tuning anything: cache reads were measured at roughly
three quarters of a real session's cost, and the conductor's own context at
between 44% and 86% of a tree's tokens — so the lever is context size and turn
count, not the price of a model.

## Install

Inside Claude Code:

```text
/plugin marketplace add jjanczur/tyran
/plugin install tyran@tyran
/tyran:hello
```

Restart Claude Code afterwards — hooks and agents are read when a session
starts, so an install you have not restarted into is an install you are not
running. `/tyran:hello` is the smoke test. The only requirement is **Claude
Code ≥ 2.1**: the scripts ship with the plugin and Claude Code runs them, so
there is nothing to install and no version of anything else to match.
`/plugin` is a slash command a human has to type — the prompt that has Claude
Code install itself, the npm package for a shell or a CI job, updating and
uninstalling are all in
[getting started](https://jjanczur.github.io/tyran/getting-started/).

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

A read-only board on loopback, re-rendered on every request. That command is
the one place a Node version matters — `npx` runs the scripts outside Claude
Code, and they need **Node ≥ 22**. Four tabs, because the page answers four
questions:

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
and absent over `file://` — [the board](https://jjanczur.github.io/tyran/board/) says why.

## What ships

Fourteen skills and four agents. Six of the skills are the conductor's own
machinery, though commands rather than internals — `/tyran:doctor` runs on any
repo, initiative or not — and the other eight are standalone protocols.

| Skill | What it does |
|---|---|
| `run` | the conductor — interviews, sizes, plans, delegates, merges |
| `setup` | reads the repo and writes `.tyran/config.yaml`, provenance per value |
| `status` | where an initiative got to, from the journal rather than from memory |
| `doctor` | is any gate installed but unable to fire; is the state self-consistent |
| `retro` | the anti-bloat curator that changes Tyran, never your product code |
| `hello` | proves the plugin is installed and its paths resolve |
| `code-review` | the dimensions a diff is read against, and the rule that you refute a finding before reporting it |
| `root-cause` | reproduce first, one variable per experiment, exit by naming the mechanism |
| `browser-check` | a UI pass that returns counts — console errors, failed responses, computed styles |
| `deslop` | the optimization pass: delete before you add, behaviour pinned by a test that ran first |
| `pr-feedback` | all three of GitHub's comment surfaces, a disposition for every comment |
| `fidelity-gate` | build 1:1 against a frozen mockup, measured rather than eyeballed |
| `prompt-tuning` | tune a non-deterministic output without chasing noise — noise baseline first |
| `skill-writing` | what a skill has to earn before it ships, and the test that proves it fires |

Agents: `tyran:scout` (recon, read-only), `tyran:implementer` (one story, own
branch), `tyran:reviewer` (no editing tools — it cannot patch what it is
grading), `tyran:retro`. A skill is admitted only when something already asks
for the protocol by name, and every description is loaded into every session
whether the skill fires or not — so the combined length is capped and CI
enforces the cap (4352 of 5000 characters). What each one assumes, when it
fires and who invokes it, is in
[skills and agents](https://jjanczur.github.io/tyran/skills/); the prompts
themselves are in [`skills/`](skills/) and [`agents/`](agents/). Behind all of
it: 1297 unit tests, run with `node --test "tests/**/*.test.mjs"`.

## Documentation

Everything below also reads as a site, with search and rendered diagrams:
[jjanczur.github.io/tyran](https://jjanczur.github.io/tyran/).

| | |
|---|---|
| [Getting started](https://jjanczur.github.io/tyran/getting-started/) | install, first run, the command line, updating |
| [Architecture](https://jjanczur.github.io/tyran/architecture/) | the four failures, the three layers, the hooks, the principles, the roadmap |
| [Skills and agents](https://jjanczur.github.io/tyran/skills/) · [the roster](https://jjanczur.github.io/tyran/agents/) | what each one assumes and who invokes it; the tier and effort table, the `.tyran/STOP` brake |
| [Configuration](https://jjanczur.github.io/tyran/configuration/) | `.tyran/config.yaml`, cost profiles, the rate card, autonomy classes |
| [Self-improvement](https://jjanczur.github.io/tyran/self-improvement/) | how Tyran learns your repo, and its guardrails |
| [Journal](https://jjanczur.github.io/tyran/journal/) · [projections](https://jjanczur.github.io/tyran/projections/) | the append-only event schema, and what is generated from it |
| [The board](https://jjanczur.github.io/tyran/board/) · [the spend ledger](https://jjanczur.github.io/tyran/cost/) | lanes, answering a question, and what a run cost |
| [Overnight mode](https://jjanczur.github.io/tyran/overnight/) · [doctor](https://jjanczur.github.io/tyran/doctor/) | usage-limit pause and scheduled resume; the `--state` and `--hooks` checks |
| [Hook runtime](https://jjanczur.github.io/tyran/hooks/) · [evidence gate](https://jjanczur.github.io/tyran/evidence-gate/) · [policy gate](https://jjanczur.github.io/tyran/policy-gate/) | gates versus probes and why hooks fail open; the criterion and its limits; path classes and where each stops |
| [FAQ](https://jjanczur.github.io/tyran/faq/) | short answers, the comparison table, and where this came from |
| [Contributing](CONTRIBUTING.md) | the dev loop, the test commands, the enforced rules |

## License

[Apache-2.0](./LICENSE)

---

<p align="center">
From Berlin with <b>&hearts;</b> by two buddies &mdash;
<a href="https://janczura.com">Jacek</a> and Piotr.
</p>
