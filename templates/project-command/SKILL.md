---
name: tyran
description: Conduct a task end to end with Tyran - interview, plan, delegate to a team of fresh-context agents, verify with evidence, merge. Use for /tyran or when asked to carry something all the way through.
---

# Tyran

Invoke the `tyran:run` skill and follow it exactly, passing through whatever
the operator said along with this command.

This file exists only so the conductor can be reached as `/tyran` instead of
`/tyran:run`. It deliberately contains no rules of its own: the playbook
lives in the plugin, so `/plugin update tyran` keeps reaching it. If you find
yourself wanting to add a rule here, add it to the plugin — or, if it is
specific to this repository, let `tyran:retro` write it into
`.tyran/knowledge/` where it belongs.
