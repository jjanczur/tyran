# The roster, and how models are chosen

`agents/` · routing in `scripts/tiers.mjs`

Four agents ship in `agents/`. The conductor (`/tyran:run`) spawns them; you
can also invoke one directly when you want just that mode of work. For what
each agent assumes before it will work, and for the fourteen skills alongside
them, see [what Tyran ships](./skills.md).

| Agent | Namespaced as | Tools | What it is for |
|---|---|---|---|
| scout | `tyran:scout` | read-only plus `Bash` | reconnaissance: what the repo does, what the data actually contains, what the docs claim |
| implementer | `tyran:implementer` | all | one story, from plan to commit or PR on its own branch |
| reviewer | `tyran:reviewer` | everything **except editing tools** | independent quality control on somebody else's diff |
| retro | `tyran:retro` | all | after an initiative closes, improves Tyran itself and nothing else |

Two of these grants are deliberate rather than incidental:

- **The reviewer has no `Edit`, `Write` or `NotebookEdit`.** A reviewer who can
  fix what they found ends up approving their own patch. This removes the easy
  path, not every path — `Bash` can still write a file — and the agent file
  says so rather than pretending otherwise.
- **The scout has `Bash`** because reconnaissance needs `git log`, `ls` and
  `command -v`. That is the entire justification; the agent is instructed to
  treat side effects as disqualifying.

## Choosing models

Model names appear in exactly one file: `.tyran/config.yaml`. Everything else
— skills, agents, policies, this document — is written in **role names**. A
model deprecation is then a one-line edit rather than a sweep through every
prompt in the repo, and a sweep through prompts is the kind of change that
reliably gets 90% done.

```yaml
tiers:
  cheap: haiku # scout, mechanical sweeps, ledger bookkeeping
  work: sonnet # DEFAULT: implementation and ordinary review
  deep: opus # root-cause diagnosis, hard implementation, risky review
  top: fable # security review, arbitration, final acceptance
```

Resolve a role to a model:

```bash
node scripts/tiers.mjs                                  # the whole map, as JSON
node scripts/tiers.mjs --role reviewer                  # -> one alias on stdout
node scripts/tiers.mjs --role reviewer --risk high      # escalate one step
node scripts/tiers.mjs --role implementer --effort xhigh # same model, think harder
node scripts/tiers.mjs --role scout --field json        # -> {tier, model, effort}
```

The conductor reads the map once at the start of an initiative and passes the
resolved values as the `model` and effort parameters at spawn.

### Two dials, not one

Model and reasoning effort are separate on purpose, because most of the time
you want one without the other. A mechanical sweep on a strong model still
does not need deep reasoning; a subtle diagnosis on the middle model very
often does. Collapsing them into a single "power" setting is what makes cost
modes blunt enough that people stop using them.

| Tier | Default effort |
|---|---|
| `cheap` | low |
| `work` | medium |
| `deep` | high |
| `top` | xhigh |

`--risk high` shifts both ladders one step; `--risk low` shifts both down.
A pinned `--tier` still lets risk move the effort, so *"use the cheap model,
but think hard about it"* is expressible — otherwise the conductor reaches
for an expensive model just to buy the reasoning.

### The conductor is expected to override this

The table is a starting point, not a prediction of the task in front of it.
The conductor may set `--tier` or `--effort` for a single subtask whenever it
can see the default does not fit — that is the intended use, not an escape
hatch. Raise effort for root-cause diagnosis, a failure nobody can reproduce,
an arbitration between two agents who disagree: anything where the first
plausible answer is probably wrong. Lower it for sweeps, bookkeeping, and
re-runs of a recipe that already worked.

Two things keep that from becoming drift. Every deviation is recorded as a
`decision` event naming the subtask, the default, what was used and why — an
override you cannot justify later is indistinguishable from a habit. And an
override **cannot** go below a role floor: `security-review` and
`arbitration` stay at `top`/`max` and `high` whatever is asked. When a floor
corrects a request, the tool says so on stderr rather than quietly handing
back something other than what was asked for, because a floor that silently
"fixed" the request would teach the conductor that its overrides take effect
when they did not.

### The routing table

Roles down the side, cost profile across the top:

| Role | `eco` | `balanced` (default) | `full` |
|---|---|---|---|
| scout | cheap | cheap | work |
| implementer | work | work | deep |
| reviewer | work | work | deep |
| security review | **top** | **top** | **top** |
| arbitration | **top** | **top** | **top** |
| acceptance | deep | top | top |
| retro | work | work | deep |
| bookkeeping | cheap | cheap | cheap |
| conductor (**advisory**) | deep | top | top |

`conductor` is the one row nothing can enforce: the conductor is your own
session, and no plugin can change a running session's model. The row records
the choice in the one file where model names may live, and `tiers.mjs` says so
on stderr when you resolve it.

Read the table as a claim about **where model strength changes the outcome**.
A scout reports what a file says; a stronger model does not make the file say
something else. A security reviewer decides whether a hole is real, and a miss
there survives every downstream check, because everything downstream trusts
it. That asymmetry, not the price list, is what the table encodes.

`--risk high` shifts one tier up, `--risk low` one tier down, and both clamp
at the ends. **Security review and arbitration have a floor**: they resolve to
`top` under every profile and every risk level. Without it, `--profile eco
--risk low` would be a one-flag downgrade of the two judgements the whole
design leans on. The floor is applied last, after the shift, so it cannot be
shifted out of. `conductor` has a `deep` floor for the same reason, advisory
or not: one weak coordinator spends a whole team's budget on the wrong plan.

Implementers and reviewers may raise an **operator ask** rather than stopping
— `node scripts/journal.mjs ask <journal> <init> --question '...' --default
'...' [--ticket T-n]` — and must NOT set `ticket.status` on the asked ticket:
the ask already lanes it `waiting-operator`, and an override on top hides the
question.

### The failure this design is actually guarding against

`resolveModel` **throws** when a tier has no alias. It would be easy to return
`undefined` and let the spawn fall back to the session default — and that is
precisely the bad outcome, because routing that silently does nothing is
indistinguishable from routing that works. You would read `profile: eco` in
your config, watch every agent run on whatever the session happened to be
using, and have no signal at all. A test pins this.

The same reasoning covers a missing config: `tiers.mjs` falls back to the
plugin's shipped template so a repo that has not run setup still works, but it
says so **loudly on stderr**. A silent fallback would let a repo believe it had
adopted a policy it never wrote.

## The brake

An operator can halt a running initiative without killing the session:

```bash
echo "wrong branch — hold everything" > .tyran/STOP
```

The conductor and the implementer check `scripts/stop-check.mjs` before every
spawn, before every merge, and before any long unattended stretch. Exit 1 means
stop and report where you got to. Delete the file and work resumes.

The value is that it needs no session. Someone who sees an overnight run going
wrong can stop it from a phone with a one-line commit, and does not have to
kill a process and lose the state that would explain what happened. (The idea
is borrowed from pro-workflow's file kill-switch; the code and the semantics
here are our own.)

`stop-check` **fails closed**. Everything else in this codebase fails open, on
the principle that a broken gate must not block ordinary work — but a brake
that releases itself when damaged is not a brake. An unreadable STOP file, a
STOP that is a directory, an empty STOP: all of them stop.

`.tyran/STOP` is classified **KERNEL** in the shipped policy, so the write
guard refuses an agent that tries to delete it through a writing tool. The
policy gate's own documented limits still apply — a shell command that removes
the directory without naming the file is one of them. This stops a loop that
is misbehaving; it does not stop one that is trying to escape.

## Overriding an agent in your own repo

Copy the file into `.claude/agents/` and edit it. Your copy wins. Note the
trade-off the shipped policy already flags: an override **freezes that agent
at the version you copied**, so plugin updates stop reaching it. That is why
`.claude/agents/**` is classified GATED rather than AUTO — it is a decision
worth making on purpose.
