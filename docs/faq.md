# FAQ

**Is this usable today?**
Yes, for real work. `/tyran:run` conducts an initiative end to end with the
four-agent roster; the state layer and the enforcement hooks are shipped and
tested. What is still missing is the automatic learning loop and
`/tyran:setup` — see the [roadmap](../README.md#roadmap), which is honest and
test-gated.

**Why should I trust an autonomous agent with commits?**
You configure how much it may do (`P1` branch-only is the default, detected
conservatively), and the risky parts are **hooks, not promises**: gitleaks on
every commit and push with the scan coverage verified, `--no-verify` and
force-pushes blocked, evidence required before anything is called done, and
the enforcement files themselves classified KERNEL so the loop cannot edit
its own boundary. Read [the policy gate](policy-gate.md) for where each of
those stops — including the one place the autonomy class itself is not
protected as strongly as it reads.

**How do I stop it mid-run?**
`echo "reason" > .tyran/STOP`. The conductor checks before every spawn and
every merge, halts, and reports where it got to. Delete the file to resume.
It needs no session, so it works from a phone at 3am.

**How do I control which models it uses?**
One file. `.tyran/config.yaml` maps four tiers to model aliases; every skill,
agent and policy is written in role names. `node scripts/tiers.mjs` prints
the resolved map. See [the roster](agents.md).

**Does Tyran phone home / need accounts / install anything globally?**
No. Zero runtime dependencies, no build step, no external services. It never
writes into `~/.claude` beyond Claude Code's own plugin mechanism. The one
optional integration (the gitleaks binary) is detected, never bundled.
Overnight runs are native — see [overnight mode](overnight.md).

**What happens to what Tyran learned when I update the plugin?**
Nothing — that's the point of the three-layer design. Your `.tyran/` data and
locally evolved skills live in *your* repo; updates touch only the core. A
delta-review step reconciles new core versions with local learning.

**Will it work in my language?**
Tyran replies in the language you use with it. Its artifacts (code, state
files, commits) are in English.

**How is this different from oh-my-claudecode / metaswarm / pilotfish /
pro-workflow?**
See the [comparison table](../README.md#how-it-compares) — every cell is
verified against their code and public issues, with footnoted receipts. The
one-line answer: their verification is advisory and their state dies with
the session; Tyran's whole design is making those failures impossible.

**Why "Tyran"?**
Polish for "tyrant". It conducts a team of agents with an iron evidence
contract and zero tolerance for "trust me, it works". The figure on the
banner conducts; every worker's screen shows what it is actually doing,
including the ones that are stalled or failing. That is the whole idea:
the state is on the wall, not in someone's summary.
