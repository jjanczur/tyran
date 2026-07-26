# The evidence gate

> **Status:** shipped — `hooks/scripts/evidence-gate.mjs`, registered on
> `SubagentStop`. Read [`docs/hooks.md`](./hooks.md) first for the runtime it
> sits inside.

An agent finishes and reports *"tests are green, everything works"*. Under v1
that went through, because the evidence contract was a sentence in prose and
prose does not stop anything. This gate refuses that specific ending, and
names what to add.

## What it blocks, and what it does not

**This gate blocks SILENCE, not FORGERY.** An agent that invents the text
`232 passed / 0 failed` walks straight through it. The gate raises the price of
a lie — it has to be deliberately fabricated rather than simply waved away —
and it does not remove it.

That paragraph is here, and in the README, on purpose. A gate advertised as
"enforces real evidence" would be a false guarantee in documentation, which is
the one defect class this project treats as blocking — and being wrong about it
in a public README is that defect with a larger audience.

## The criterion

A report passes when it contains at least one **raw output pattern**. Every
pattern requires a DIGIT next to a keyword, because that is the shape of
machine output and it is not the shape of a summary.

| signal | matches |
|---|---|
| `exit-code` | `EXIT=0`, `exit code 0`, `exit status 137` |
| `test-count` | `12 passed`, `0 failed`, `3 skipped` |
| `tap-count` | `# pass 343`, `# fail 0`, `# tests 343` |
| `tap-line` | `ok 7 - name`, `not ok 3 - name` |
| `labelled-count` | `Tests: 28`, `Suites = 4` |
| `ratio` | `6 / 6 passed`, `18/20 passing` |
| `evidence-block` | a line starting `EVIDENCE:` with content after it |

*"All tests pass"* does not match. *"12 passed"* does. That line is the whole
point, and it has to be drawable by a regex or it is not enforceable.

### Why the criterion is wide rather than strict

Measured against 128 real subagent final messages recovered from Claude Code
transcripts — the same string the platform hands this hook as
`last_assistant_message`:

| agent type | reports | carry evidence |
|---|---:|---:|
| `tyran-implementer` (enforced) | 33 | 32 |
| `tyran-reviewer` (enforced) | 22 | 21 |
| `tyran-scout` (exempt) | 15 | 2 |
| `Explore` (out of scope) | 20 | 1 |
| `general-purpose` (out of scope) | 16 | 0 |

Both enforced-role misses were read by hand and neither is a report: one is a
system-prompt fragment that leaked into a text block, the other is the
platform's *"you've hit your weekly limit"* notice. On the 53 messages that are
actually reports the criterion is 53/53.

The exempt rows are the other half of the argument. Enforcing this criterion on
a scout would bounce correct work eight times out of ten, and **a gate that
bounces correct work is switched off within a week** — after which it protects
nothing at all.

## Who it binds

Scope comes from `agent_type`, a field the PLATFORM writes. It never comes from
the report, because a criterion derived from content can be defeated by
content: if *"I am only a scout"* exempted an agent, every agent would write it.

| `agent_type` | treatment |
|---|---|
| `tyran:implementer`, `tyran:reviewer` (and the `tyran-` spellings) | **enforced** |
| `tyran:scout`, `tyran:retro` | **exempt**, and the exemption is recorded |
| anything else, including the empty string | **out of scope**, no record |

`out-of-scope` is not a quieter exemption. An exempt agent is one of ours that
the contract deliberately releases, so it is counted. An agent that was never
bound — `Explore`, another plugin's agent, the empty `agent_type` the platform
is documented to be able to send — has nothing to be released from, and one
`gate` event per `Explore` call would bury the exemptions that mean something.

Matching is on exact strings. An unanchored match on `implementer` would also
bind an agent called `evil-tyran-implementer-nope`, which is precisely how the
platform's own matcher behaves and precisely what not to copy.

## The escape hatch

An agent that honestly had nothing to measure writes, on a line of its own:

```text
EVIDENCE: none-required <why there was nothing to run>
```

The reason is mandatory (10 characters minimum) and the gate **records every
use in the initiative journal**. An exemption nobody can count is a silent
exclusion, which ADR-19 forbids by name — so this is the one exemption that is
refused when it cannot be recorded.

## What lands in the journal

One `gate` event per decision, in `.tyran/state/<initiative>/journal.jsonl`:

```json
{"ev":"gate","init":"demo","actor":"evidence-gate",
 "data":{"kind":"evidence","result":"deny","agent_type":"tyran-implementer",
         "agent_id":"a85559cb424fa7ddd","signals":[],"code":"no-evidence"}}
```

`result` is one of `pass`, `deny`, `exempt-role`, `exempt-interrupted`,
`exempt-hatch`, `fuse`. So *"how many times did someone opt out of the evidence
contract in this initiative"* has an answer, and so does *"how often did an
agent need a second turn, and did the second turn fix it"* (`would_be`).

**It writes `gate`, not `report`.** `report` is half of the spawn-report
pairing (ADR-18) and its only correlator is the agent NAME the conductor chose
at spawn time. A hook knows `agent_id` and `agent_type` and cannot know that
name, so writing `report` would orphan an event on every subagent stop — or, on
a name collision, close a spawn the conductor was still tracking.

When a repository holds several initiatives the gate cannot know which one an
agent belonged to. It picks the most recently written journal and **says so in
the event** (`initiative_inferred_from: <n>`), because a guess that hides
itself is worse than a guess.

## The anti-loop fuse

`stop_hook_active` is true from the second `SubagentStop` for the same agent
onward. The gate reads it and passes unconditionally. **A gate that can bounce
an agent forever is worse than no gate**: the user kills the run, and then
removes the gate. It also covers cases nobody controls — an agent stopped by
another hook, or one that hit a rate limit and whose next report will be
identical.

The fuse overrides the verdict and only the verdict: the report is still
assessed, and the answer is recorded as `would_be`. Releasing an agent and
forgetting what it did are two different things.

## Failure modes, and one asymmetry that is a product decision

Unreadable input, the wrong event, or an internal error all end as a refusal
naming the error class — that is the runtime's job, described in
[`docs/hooks.md`](./hooks.md).

The interesting question is narrower: **should a broken journal bounce a
correct report?** The two failures are not symmetrical.

- Refusing a report that HAS evidence because the bookkeeping failed costs the
  agent a turn for something it did not cause and cannot fix. The evidence is
  already in the transcript; the journal line is an audit convenience.
- Granting an exemption that could not be recorded costs the system its only
  trace of it, and the loss is invisible afterwards.

So the record gates **the exemption an agent claims for itself**, and nothing
else:

| situation | journal broken or absent |
|---|---|
| report carries evidence | passes |
| role exemption (scout, retro) | passes |
| interrupted agent | passes |
| `EVIDENCE: none-required` | **refused** |

The cost of the last row is bounded at one extra turn, because the fuse
releases the second stop.

### Bounded before it is read

`journal.append` reads the whole file to clamp its timestamp, so the gate
`statSync`s it first and refuses anything over 16 MiB, and refuses to search a
`.tyran/state` with more than 64 initiatives. This is not tidiness: a gate that
blocks the thread is the one failure the runtime cannot rescue, because the
platform kills the process and never reads the refusal it had already written
(ADR-22 correction 2).

The gate's internal deadline is 8 s against a 20 s platform timeout —
deliberately larger than the session-start probe's, because the journal's
cross-process mutex waits up to 5 s for a contended lock and waits
*synchronously*.

## Measured live

One end-to-end run on v2.1.116, project agent `tyran-implementer`, task
designed to produce an evidence-free report:

```text
[assistant] Zrobione, testy zielone, wszystko dziala.
[user]      Stop hook feedback:
            REFUSED by the tyran evidence gate: this report carries no raw
            command output. ...
[assistant] EVIDENCE: none-required The working directory contains only hidden
            configuration folders (.claude, .tyran) with no actual repository
            to check.
```

and the journal that run produced:

```text
{"ev":"gate",...,"data":{"kind":"evidence","result":"deny","agent_id":"a85559cb424fa7ddd","signals":[],"code":"no-evidence"}}
{"ev":"gate",...,"data":{"kind":"evidence","result":"fuse","agent_id":"a85559cb424fa7ddd",...}}
```

The refusal reached the agent's context, the agent changed its behaviour, and
the fuse released the second stop.

## Known limits

- **Forgery is out of reach.** Stated at the top and repeated here, because it
  is the limit a reader will otherwise assume away.
- **A quoted counter counts.** Evidence inside a code block citing someone
  else's run is indistinguishable from a produced one without re-running the
  commands ourselves.
- **An empty `agent_type` is a way past the gate.** The platform can send one,
  and when it does it also skips matcher filtering entirely. Enforcing on an
  unknown type would mean applying the implementer contract to every agent in
  the system, which is the worse of the two failures. This is an evidence
  contract, not a security boundary.
- **Invisible characters inside an evidence block make it stop counting.**
  `12 pass<ZWSP>ed` renders as evidence and is not evidence, so the gate
  refuses. That direction is deliberate: refusing is safe, accepting is not.
- **The gate cannot see work that produced no report.** An agent killed before
  it spoke passes, by design — see the interrupted row above.
