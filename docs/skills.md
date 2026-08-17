# What Tyran ships: fourteen skills and five agents

`skills/` · `agents/`

Tyran is usually described as a conductor, which undersells it. Installing the
plugin also installs **fourteen skills** and **five agents** — and the skills are
not the conductor's private plumbing. Most of them are things *you* type. There
is no orchestration involved in `/tyran:doctor`; it is a diagnostic you run
because you want to know whether your gates can fire.

Eight of the fourteen are not about Tyran at all. They are working protocols
for problems that have nothing to do with agent orchestration — reviewing a
diff, debugging a failure, driving a browser, cleaning up code, answering a
reviewer, building against a mockup, tuning a prompt, writing a skill — and
they are the clearest case for reading this page. Each of them exists because a
rule written as prose was demonstrably not enough: either it had been
compressed until the step that does the work fell out, or it was named by the
conductor as a requirement and never defined anywhere, so it meant whatever the
agent doing it decided that afternoon.

That is also the admission rule. **A protocol becomes a skill here only when
something already asks for it by name**, which is why the number is fourteen
rather than forty. Every description is loaded into every session whether the
skill fires or not, so the combined length is capped and the cap is checked in
CI on every push.

```mermaid
flowchart TB
  HUMAN(["you"])

  subgraph ENTRY["Skills you type"]
    S1["/tyran:setup"]
    S2["/tyran:run"]
    S3["/tyran:status · /tyran:doctor"]
    S4["/tyran:retro · /tyran:hello"]
  end

  subgraph PROTO["Protocol skills — invoked by whoever does the work"]
    S5["/tyran:code-review · /tyran:root-cause"]
    S6["/tyran:browser-check · /tyran:deslop"]
    S7["/tyran:pr-feedback · /tyran:fidelity-gate"]
    S8["/tyran:prompt-tuning · /tyran:skill-writing"]
  end

  COND(["the conductor"])

  subgraph ROSTER["Agents the conductor spawns"]
    A1["tyran:scout"]
    A2["tyran:implementer"]
    A3["tyran:reviewer"]
    A4["tyran:verifier"]
    A5["tyran:retro"]
  end

  subgraph GATES["Hooks that refuse"]
    G1["evidence gate"]
    G2["policy gate"]
    G3["retro gate"]
  end

  HUMAN --> ENTRY
  HUMAN --> PROTO
  S2 --> COND
  COND --> ROSTER
  COND --> PROTO
  A2 --> PROTO
  A3 --> PROTO
  A4 --> PROTO
  ROSTER -- "reports" --> G1
  ROSTER -- "tool calls" --> G2
  COND --> G3
  G1 -. "rejects a report with no raw output" .-> ROSTER
```

## The fourteen skills

Every skill is invoked as `/tyran:<name>`. "Who" says whether the caller is
normally a person, the conductor, or either.

| Skill | Role — why it exists | Assumes | Who |
|---|---|---|---|
| [`run`](../skills/run/SKILL.md) | Carry a task from a one-line fix to a multi-day programme: classify it S/M/L/XL, route each role to a cost tier, drive the agents, stop only at real decisions. | A repo it may work in, and an operator reachable for the few genuine decisions. Does **not** assume `.tyran/` exists — it can size and run work before setup. | Human |
| [`setup`](../skills/setup/SKILL.md) | Configure Tyran for this repository once: scan the stack, the validation commands and the git history, write `.tyran/config.yaml` with provenance on every inferred value. | The repo's own declarations are the evidence — `package.json`, `Makefile`, CI files, merge history. Where it cannot establish a value it asks rather than guesses, and it never infers `P3`. | Human |
| [`status`](../skills/status/SKILL.md) | Answer "where is the work" from the journal rather than from memory. Read-only. | An initiative with a journal exists. The answer comes from `journal.jsonl`; anything remembered instead is not an answer. | Either |
| [`doctor`](../skills/doctor/SKILL.md) | Diagnose Tyran itself in this repo: gates that cannot fire, journal-vs-projection drift, orphaned leases, dead policy rules, config that fails its schema. Never repairs. | That a dead gate and a healthy gate look identical from inside a session — which is the whole reason it exists. Hooks fail **open**. | Either |
| [`retro`](../skills/retro/SKILL.md) | Close an initiative by learning from it: spawn the retrospector over the ledger, the notes and the agents' reports, and record what changed and what was rejected. | A **closed** initiative with a journal and agent reports to read. With no initiative behind it there is no signal, only opinion. | Either — normally the `Stop` gate asks for it |
| [`hello`](../skills/hello/SKILL.md) | Installation smoke test: confirm the plugin loaded, that skills are namespaced `/tyran:*`, and where `${CLAUDE_PLUGIN_ROOT}` resolves. | Nothing. It is the one skill that must work before anything else does — and it is the only one marked `disable-model-invocation`, so it runs when you ask and never on a hunch. | Human |
| [`code-review`](../skills/code-review/SKILL.md) | The depth half of a review: the dimensions a diff is read against, and the rule that you try to refute a finding before you report it. | A diff and the acceptance criteria it claims to satisfy. It does **not** own the verdict — that stays with `tyran:reviewer`, so the two never define "reviewed" twice. | Either |
| [`root-cause`](../skills/root-cause/SKILL.md) | Work a failure down to its mechanism instead of patching the symptom: reproduce, one variable per experiment, bisect, name the mechanism. | That the failure can be made to happen at least sometimes. Everything downstream depends on a reproduction; without one, a fix cannot be shown to have worked. | Either |
| [`browser-check`](../skills/browser-check/SKILL.md) | Drive a real browser and return counts — pages, links, console errors, failed responses, computed styles — rather than an impression. | A browser (chromium) and a server that is actually serving the build you mean. It measures; it does not judge whether the design is right. | Either |
| [`deslop`](../skills/deslop/SKILL.md) | The optimization pass, defined: delete before you add, one smell class per pass, behaviour pinned by a test. Also lints a `SKILL.md` and prose. | A test that ran **before** the edit. Without a green run from beforehand, a green run afterwards proves nothing about what you changed. | Either |
| [`pr-feedback`](../skills/pr-feedback/SKILL.md) | Work a reviewer's comments to the end: all three of GitHub's comment surfaces, a disposition for every comment, push before you reply. | A pull request and `gh` authenticated against it. Assumes the reviewer is a person whose disagreement is worth a written answer, not a queue to clear. | Either |
| [`fidelity-gate`](../skills/fidelity-gate/SKILL.md) | Build a UI against a frozen visual reference without drift. | A reference that is **frozen and in the repo** — a mockup, a spec, a screenshot — and that the reference, not the ticket prose, is the source of visual truth. | Either |
| [`prompt-tuning`](../skills/prompt-tuning/SKILL.md) | Iterate on a prompt, or on anything whose quality is a model's output, without chasing noise. | That the measured quantity is **non-deterministic**. Every rule follows from that one premise; on a deterministic metric the protocol is overkill. | Either |
| [`skill-writing`](../skills/skill-writing/SKILL.md) | What a skill has to earn before it ships here, and how one is written so it actually fires. | That the library is a shared, costed resource: every description is loaded into every session. A skill nothing already asks for is a library entry, not a skill. | Either — normally `retro` |

## The two that are worth a second sentence

These two are the argument of this page, because both were once a rule in prose
and both lost something in that form.

**`fidelity-gate`** splits the work the way the failure demanded: *appearance is
read by a machine, intent is described in words.* Text, typography, colour,
geometry and icons are extracted from the reference mechanically into an
inventory — one row per element — **before the first line of code**, because
every restatement of a design into prose is a lossy copy (`22px/700/#0a2540`
has one interpretation; "large bold dark-blue heading" has hundreds). The
verdict at the end is the filled-in checklist, not a sentence: *"looks
consistent"* is rejected on sight. When this was compressed into three
sentences of general guidance it kept the sentiment and dropped the inventory
step — which is the step that does the work.

**`prompt-tuning`** starts before the first edit, with a **noise baseline**:
same prompt, same inputs, at least two runs, recording the spread. A change
smaller than that spread is noise. Comparisons are medians over **three or more
runs per input**. The rule with the widest reach is that a rule *in* a prompt
is only a request — enforcement is a mechanism that runs **after** generation,
a gate plus a targeted regeneration. Kept as a bare principle, it survived and
everything it was distilled from did not, which is why the measured costs are
still attached to each rule here.

## The five agents

Each is spawned as `tyran:<name>`. The conductor spawns them on L/XL work; you
can also address one directly when you want exactly that mode of work. The
[roster page](./agents.md) covers tool grants and model routing.

| Agent | Role — why it exists | Assumes | Who |
|---|---|---|---|
| [`scout`](../agents/scout.md) | Fast, cheap reconnaissance over a repo, its data or external sources. Changes nothing. | That a finding is a claim **plus its proof** — every line comes back as `finding -> path:line` or a URL. "I did not find it" is a valid answer; a guess is not. | Conductor, and you |
| [`implementer`](../agents/implementer.md) | Take one self-contained story from plan to commit or PR on its own branch, with tests and a self-review. | A story that is genuinely self-contained, a directory it owns (a worktree when the team runs in parallel), and that the handoff's premises may be **wrong** — it verifies them in the code and reports corrections. | Conductor |
| [`reviewer`](../agents/reviewer.md) | Independent quality control on **another** agent's diff: its own verification run, not the author's report. Returns APPROVE, REVISED or CHANGES-REQUESTED with executable counterexamples. | That it never reviews its own code — and that fixing forfeits approving. It holds `Edit`, because re-deriving a one-line fix from a paragraph is slow, but **a diff it touched can only come back REVISED**, which still owes a second read. No `Write` or `NotebookEdit`: authoring files is designing, not reviewing. | Conductor |
| [`verifier`](../agents/verifier.md) | Mechanical validation on the cheapest tier: runs exactly the commands it is handed, reports exit codes and counts verbatim, compares against the last green baseline. | That it never edits, fixes or theorizes — a red suite is its product, not its failure. Model strength does not change what `node --test` prints, which is why it is cheap at every profile and has no escalation. | Conductor |
| [`retro`](../agents/retro.md) | After an initiative closes, improve **Tyran itself** — the conductor skill, the roster, new skills, scripts, docs. Never product code. | A closed initiative with a ledger and reports, and an anti-bloat filter whose **default answer is to change nothing**. A retro that changes nothing is a correct outcome. | Conductor |

## Where the source is

Every skill is one `SKILL.md` under [`skills/`](../skills) and every agent one
markdown file under [`agents/`](../agents) — no build step, no code generation.
The tables above deliberately do not restate them: a second copy of a
description is a second place for it to drift.
