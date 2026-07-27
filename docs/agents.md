# The roster, and how models are chosen

Four agents ship in `agents/`. The conductor (`/tyran:run`) spawns them; you
can also invoke one directly when you want just that mode of work.

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
node scripts/tiers.mjs                              # the whole map, as JSON
node scripts/tiers.mjs --role reviewer              # -> one alias on stdout
node scripts/tiers.mjs --role reviewer --risk high  # escalate one tier
```

The conductor reads the map once at the start of an initiative and passes the
resolved alias as the `model` parameter at spawn.

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
shifted out of.

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
