# Getting started

## Install

```text
/plugin marketplace add jjanczur/tyran
/plugin install tyran@tyran
/tyran:hello
```

**Or paste this into Claude Code and let it install itself.** `/plugin` is a
slash command a human has to type, so this asks for the same steps through
the `claude` CLI instead, which Claude Code can run on its own — followed by
the restart those steps require, and a walkthrough of what setup inferred
before it is trusted:

```text
Install the Tyran plugin in this repository and set it up for me.

1. Run: claude plugin marketplace add jjanczur/tyran
2. Run: claude plugin install tyran@tyran
3. Tell me to restart Claude Code, so the hooks and agents load.
4. After the restart, run /tyran:setup. It scans this repo and writes
   .tyran/config.yaml. Walk me through what it inferred - especially the
   validation commands and the deployment autonomy class - before we commit it.

Docs: https://jjanczur.github.io/tyran/getting-started/
```

`/tyran:hello` confirms three things: the plugin loaded, skills are namespaced
under `/tyran:*`, and `${CLAUDE_PLUGIN_ROOT}` resolves to the installed copy.

Requirements: Claude Code ≥ 2.1. No Node dependencies, no build step —
Tyran's scripts are plain Node ≥ 22, bundled with the plugin; you don't run
npm at any point.

## First run

```text
/tyran:setup
```

Setup scans your repo deterministically (languages, package manager,
validation commands, CI, merge history), infers your deployment autonomy
class — the safest class is always the default and `P3` is **never** inferred
— writes `.tyran/config.yaml` with every field annotated
`value · source · confidence`, and asks you **one** batch of questions, only
about fields it could not establish.

It also offers to install a `/tyran` shortcut into `.claude/skills/tyran/`,
so you can type `/tyran` instead of `/tyran:run`. That file is a few lines
that hand straight over to the plugin, so updates keep reaching the playbook.
It lands in your repo and will show up in your next commit, which is why
setup asks first.

## Your first initiative

```text
/tyran add rate limiting to the public API
```

Tyran interviews you briefly (only questions that change the plan), triages
the task (S/M/L/XL × risk), plans, and drives scout → implementer → reviewer
with an enforced evidence contract. You will be stopped only at gates:
plan acceptance, irreversible operations, product decisions.

Tyran replies in **your language**; its artifacts (code, commits, state
files) are in English.

## The other four commands

| Command | What it does |
|---|---|
| `/tyran:status` | Where the work is, read from the journal. Names the agents that have not reported yet — the most useful line and the easiest to miss. |
| `/tyran:doctor` | Whether Tyran itself is healthy here: gates that cannot fire, journal-vs-projection drift, orphaned leases, config that fails its schema. |
| `/tyran:retro` | Learn from a finished initiative. Usually you do not type this — see below. |
| `/tyran:hello` | Installation smoke test. |

## Stopping a run

```bash
echo "wrong branch — hold everything" > .tyran/STOP
```

The conductor checks before every spawn and every merge, halts, and reports
where it got to. Delete the file to resume. It needs no session, so it works
from a phone at 3am, and it is the one check in the plugin that fails
**closed**.

## The retrospective runs itself

When every ticket in an initiative is merged and no retrospective has been
recorded since the last merge, a `Stop` hook refuses **one** turn and says
which initiative is owed one. Deciding not to run one is a legitimate
answer — record it and the gate is satisfied. You are never blocked twice,
whatever you choose.

This exists because the retro is the step most easily skipped: it happens
after the work is done, after the merge, when the interesting part is over.
It is also the only mechanism by which Tyran gets better at *your* repo
rather than repeating itself.

## Uninstall / rollback

- Disable: `claude plugin disable tyran`
- Remove: `/plugin uninstall tyran@tyran`
- Your `.tyran/` directory is plain data in your repo — it survives
  uninstall/reinstall and any plugin version change.
