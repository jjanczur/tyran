# FAQ

**Is this usable today?**
The skeleton is: install + `/tyran:hello` work and CI is green. The
conductor, state layer, and enforcement hooks are landing epic by epic — the
[roadmap](../README.md#roadmap) is honest and test-gated. Watch the repo.

**Why should I trust an autonomous agent with commits?**
You configure how much it may do (`P1` branch-only is the default, detected
conservatively), and the risky parts are designed as **hooks, not promises**
(landing with the enforcement epic): gitleaks on every commit/push,
`--no-verify` blocked, evidence required before anything is called done, and
a self-improvement loop that is physically unable to touch its own
enforcement (KERNEL class). Until those hooks ship, don't grant more
autonomy than you'd grant a bare Claude Code session.

**Does Tyran phone home / need accounts / install anything globally?**
No. Zero runtime dependencies, no build step, no external services. It never
writes into `~/.claude` beyond Claude Code's own plugin mechanism. Optional
integrations (gitleaks binary, ralph-tui for overnight runs) are detected,
never bundled.

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
contract and zero tolerance for "trust me, it works". The pharaoh on the
banner conducts; the agents build the pyramid.
