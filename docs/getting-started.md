# Getting started

> **Status:** Tyran v2 is under active construction. This page documents what
> works **today** and clearly marks what is coming. Nothing here is
> aspirational without a label.

## Install (works today)

```text
/plugin marketplace add jjanczur/tyran
/plugin install tyran@tyran
/tyran:hello
```

`/tyran:hello` confirms three things: the plugin loaded, skills are namespaced
under `/tyran:*`, and `${CLAUDE_PLUGIN_ROOT}` resolves to the installed copy.

Requirements: Claude Code ≥ 2.1. No Node dependencies, no build step —
Tyran's scripts are plain Node ≥ 22, bundled with the plugin; you don't run
npm at any point.

## First run (coming with the setup epic)

```text
/tyran:setup
```

Setup will: scan your repo deterministically (languages, package manager,
validation commands, CI, branch protection, merge history), infer your
deployment autonomy class (safest class is always the default), write
`.tyran/config.yaml` with every field annotated `value · source · confidence`,
and ask you **one** batch of questions — only the fields it could not infer.

## Your first initiative (coming with the conductor epic)

```text
/tyran:run add rate limiting to the public API
```

Tyran interviews you briefly (only questions that change the plan), triages
the task (S/M/L/XL × risk), plans, and drives scout → implementer → reviewer
with an enforced evidence contract. You will be stopped only at gates:
plan acceptance, irreversible operations, product decisions.

Tyran replies in **your language**; its artifacts (code, commits, state
files) are in English.

## Uninstall / rollback

- Disable: `claude plugin disable tyran`
- Remove: `/plugin uninstall tyran@tyran`
- Your `.tyran/` directory is plain data in your repo — it survives
  uninstall/reinstall and any plugin version change.
