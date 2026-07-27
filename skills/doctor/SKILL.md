---
description: Check that Tyran itself is healthy in this repo - gates that cannot fire, journal and projection drift, orphaned leases, dead policy rules, config that fails its schema. Reports findings with the fix for each. Use for /tyran:doctor or when a gate seems not to be working.
---

# Doctor

Three checks, in this order. Run all three even if the first is clean — they
fail independently.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --hooks
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs" --state
node "${CLAUDE_PLUGIN_ROOT}/scripts/schema.mjs" validate config .tyran/config.yaml
```

**`--hooks` is the one that matters most**, and it is worth saying why. Hooks
fail OPEN: a gate whose file is missing, whose execute bit was lost, or whose
matcher can never match does not degrade into a weaker check — the action it
was meant to stop simply proceeds, with nothing printed anywhere. A dead gate
and a healthy gate look identical from inside a session. This check is the
only thing that can tell them apart.

**`--state` compares the journal against its projections** and finds drift,
leases held by agents that have long since reported, and policy rules that
match no path in the repo.

## Reporting

Paste the raw output. For each finding give the fix the tool named, and say
plainly which findings are errors and which are informational — a report that
blurs the two trains the operator to skim the next one.

If everything is clean, say so in one line with the counts, and resist adding
advice. A clean doctor run that arrives with a list of suggestions reads as a
failed one.
