# The policy gate

> **Status:** shipped — `hooks/scripts/policy-gate.mjs`, registered on
> `PreToolUse` for every tool.
> It turns two pieces of configuration into refusals: the autonomy classes in
> `.tyran/policies/autonomy.yaml`, and the deployment class in
> `.tyran/config.yaml`.

Read [`hooks.md`](hooks.md) first. Everything there about the platform failing
open applies here, and this gate inherits its runtime from it.

## What it enforces

| what | where it comes from | what it decides |
|---|---|---|
| **path classes** AUTO / GATED / KERNEL | `.tyran/policies/autonomy.yaml` | whether a file-writing tool call may proceed |
| **the deployment class** P1 / P2 / P3 | `.tyran/config.yaml`, `autonomy:` | how far a `git push` may reach |
| **credential-shaped reads** | built in, no configuration | whether a file may be read into the model's context |

## The matrix

The definition of this gate is a matrix, not a list of examples. The columns
are **supervision**, not merely which actor is running: a subagent's tool calls
never surface a permission prompt, and neither do a main loop's under
`acceptEdits` or `bypassPermissions`.

| path class | supervised main loop | subagent, or prompts off |
|---|---|---|
| `AUTO` | pass | pass |
| `GATED` | pass — the platform's own permission prompt **is** the approval | **deny** |
| `KERNEL` | **deny** | **deny** |
| **no rule matches, inside `.tyran/` `.claude/` `hooks/`** | the policy's `default:` — `GATED` in the shipped template | |
| **no rule matches, anywhere else** | pass — see below | pass |
| **outside the repository** | **deny** | **deny** |

Two rows deserve their reasoning spelled out, because both could defensibly
have gone the other way.

**A path no rule matches is a row, not a fall-through — and it is really two
rows.** ADR-19 correction 1 says a denylist over input somebody else controls
is *structurally* incomplete, so "unmatched means allowed" would mean the
policy protects only what someone remembered to list. The opposite extreme —
refuse everything unlisted — was rejected on a measurement rather than on
taste: **65 of the 65 tracked files in this repository match no rule in the
shipped template**, so that reading would have refused an implementer subagent
on every write it makes, and a gate that refuses ordinary work is uninstalled.

The split follows what the policy is actually *about*. ADR-06 governs
**self-improvement** — what the retrospective agent may change about Tyran —
and every rule in the template names a Tyran artefact. So inside Tyran's own
namespace (`.tyran/`, `.claude/`, `hooks/`) the policy is meant to be
exhaustive, an unmatched path means somebody added a new kind of artefact, and
`default:` applies: fail-closed and cheap, because those trees are small.
Outside it, the policy has nothing to say and neither does this gate.

This narrows the **default**, not the rules. An explicit rule still applies to
any path anywhere — write `- path: src/**` and you get exactly that. A path
outside the repository is still `KERNEL`, and `hooks/**` and
`.tyran/policies/**` are still refused unconditionally, before any rule is
consulted.

**`GATED` passes in a supervised main loop.** On `PreToolUse` the platform
offers a gate exactly two answers: `deny`, and silence. There is no "ask" — and
`permissionDecision: "allow"` is not one either, since it *auto-approves* the
call and skips the user's prompt. So `GATED` is enforced where no one is asked,
and delegated where an approval channel already exists. That is what makes
supervision an axis rather than a detail: treating `acceptEdits` as supervised
would have made the whole row decorative in the mode agents actually run in.

## The deployment class

`P1` keeps an agent on its own branch · `P2` adds the shared and testing
branches · `P3` adds production, minus the operations that cannot be undone.

| command, on a repo whose default branch is `main` | P1 | P2 | P3 |
|---|---|---|---|
| `git push origin feature/x` | pass | pass | pass |
| `git push origin staging` | deny | pass | pass |
| `git push origin main` · `git push origin HEAD:main` | deny | deny | pass |
| `git push --all` · `git push --tags` | deny | deny | pass |
| `git push origin --delete X` · `git push origin :X` | deny | deny | **deny** |
| `git push --mirror` | deny | deny | **deny** |
| `git push --force-with-lease origin main` | deny | deny | **deny** |

The last three rows are the mechanical content of "P3 passes, but irreversible
and user-visible operations are still gated". Without them that sentence was
prose: every class allowed the same destructive pushes.

**Which branch is production is answered twice, on purpose.** A name list
(`main`, `master`, `production`, `prod`, `release`, `live`, `trunk`, `stable`)
is an enumeration and therefore incomplete — a repository whose production
branch is called `ship` is not in it. So the gate also reads the remote's own
default branch, and under P1/P2 it **refuses** when it cannot:

```
git remote set-head origin -a
```

One command, permanent, writes a local ref and changes nothing on the remote.
Refusing here rather than falling back to the name list is deliberate: a miss
in an enumeration would otherwise be a silent pass, and ADR-19's rule is that
an exclusion may never be quiet.

Everything the gate knows about a command line comes from the **secrets gate's
lexer** (`planCommand`): segmentation, transparent prefixes like `sudo`/`env`,
the `cd`/`pushd`/`popd` working-directory model, and refusal on anything that
needs shell expansion. There is no second decomposition — `planCommand` records
the raw argv after `push`, and this gate reads that. Anything the lexer cannot
model is a refusal here for the same reason it is one there.

## Credential-shaped reads

The trigger was not hypothetical. A neighbouring project's `.env` was read
whole into a conductor session in this project's own history: dozens of live
credentials, including payment keys and a token that bypasses two-factor
authentication. Nobody had asked for the read, no commit was involved, and the
secrets gate — which defends **publication** — would never have seen it. A
transcript is storage.

So a read is refused when the path is credential-shaped, **for every actor**,
and the AUTO/GATED/KERNEL classes are not consulted for reads at all.

Covered shapes: `.env` and `.env.*` (but not `.example` / `.sample` /
`.template` / `.dist` / `.defaults` / `.schema`), `*.pem|key|p12|pfx|jks|
keystore|kdbx|asc|ppk`, `id_*` SSH keys, `credentials[.ext]`, `.netrc`,
`.npmrc`, `.pypirc`, `.pgpass`, `.dockercfg`, `*service-account*.json`, and
anything under `.ssh/`, `.aws/`, `.gnupg/`, `.config/gcloud/`, plus
`.kube/config`. `Grep` travels this rule too, because `output_mode: "content"`
prints the lines.

The way out is one only a **human** can take: an explicit `class: AUTO` rule
for the path in `.tyran/policies/autonomy.yaml` — a file that is itself class
`KERNEL`, so no agent can write that exemption for itself through this gate.

### Why KERNEL was NOT extended to cover reads

Both answers were defensible and this one is a choice, not an oversight.
Extending the write classes to reads would make `hooks/**` unreadable, and a
gate whose own source an agent cannot read teaches its user to switch the gate
off. The narrow rule catches the case that actually happened without that cost.

## What this gate does NOT catch — the declared boundary

Stated here rather than left to be discovered, because a boundary an agent
finds by itself is a boundary it learns to prefer.

1. **Shell commands are not path-classified.** The classes are enforced on
   file-editing *tool calls*. `echo x > .tyran/policies/autonomy.yaml`,
   `sed -i`, `rm -rf .tyran` and every other shell write pass this gate.
   *Worst case:* an agent refused a KERNEL write through `Edit` can perform the
   same write through `Bash`. The refusal text says so in as many words, and a
   test pins the gap so closing it is a deliberate act.
2. **Product code is not classified by default.** Only `.tyran/`, `.claude/`
   and `hooks/` fall under the policy's `default:`; everything else needs an
   explicit rule. *Worst case:* a user who believes the policy covers their
   whole tree gets no refusal for `src/**` until they write the rule. The
   alternative was measured and rejected above.
3. **A repository with no `.tyran/` directory is left alone** (except for the
   read rule, which needs no configuration). *Worst case:* `rm -rf .tyran`
   disables the path classes wholesale. Accepted because refusing every write
   in every repository that has not adopted Tyran is a plugin nobody keeps
   installed; detecting the deletion belongs to `doctor`.
4. **The read rule is a denylist and is therefore incomplete.** A credential in
   a file called `notes.md` is read without objection. It is not a claim that
   no secret can reach the context by another name.
5. **`GATED` in a supervised main loop relies on the platform actually
   prompting.** A `permissions.allow` entry in the user's settings suppresses
   the prompt, and the hook cannot see those settings. *Worst case:* a user who
   has allow-listed `Write(*)` gets `GATED` behaviour equal to `AUTO` in the
   main loop. Subagents are unaffected.
6. **Only the argv of `git push` is modelled**, not every publishing command.
   `gh release create` and friends are the secrets gate's business; the
   deployment class does not see them.
7. **Multiple pushes in one command line** are each evaluated, but the
   deployment class always comes from the **session** root's config, not from
   the repository the command walked into.

## The cost, measured

This gate is registered for **every tool call**, because the alternative — a
matcher listing the tools it knows — makes any tool it has never heard of an
unclassified write, and the platform's list is not frozen. The price of that
choice, measured on this machine (12 runs each, median / slowest):

| call | median | slowest |
|---|---|---|
| a tool naming no path (`WebFetch`) | 47 ms | 82 ms |
| a write outside the governed namespace | 49 ms | 68 ms |
| a write refused inside it | 50 ms | 53 ms |
| a read that passes | 45 ms | 60 ms |
| a `Bash` call with no push | 42 ms | 59 ms |

Almost all of it is Node process startup, and none of it approaches the 4 s
internal deadline or the 8 s registered timeout. A `git push` costs more,
because it runs one or two `git symbolic-ref` calls, each with its own budget.

## Failure is refusal

Everything below denies, because the platform fails open and a gate you can
switch off by breaking it is not a gate (ADR-22):

- `.tyran/` exists but `.tyran/policies/autonomy.yaml` does not;
- the policy is unparseable, or the validator rejects it (including any attempt
  to downgrade `hooks/**` or `.tyran/policies/**`);
- the policy is larger than 256 KB — every file this gate reads is size-checked
  *before* it is read, because the platform's timeout kills the process and
  never reads what it wrote;
- `.tyran/config.yaml` does not declare a deployment class. It is **not**
  defaulted to `P3`;
- a push whose destination the gate cannot determine.

## What a refusal may say

A refusal is republished into the transcript and into the model's context, so
every string in it that came out of a file is text somebody else wrote. Review
has already used a rule id as an injection channel elsewhere in this plugin.

- the rule's **`reason:` prose is never reproduced**. There is no channel to
  sanitize. The refusal names the rule's `path` glob and its class, and points
  at the file;
- the `path` glob is filtered to a glob repertoire, which removes spaces, so a
  sentence hidden in a rule path stops reading as an instruction;
- file paths go through the same opaque-run elision the secrets gate uses,
  because a file *name* can be the secret;
- every refusal carries a class, the deciding rule, and a way out. A refusal
  with no reachable way forward produces an agent that looks for a way around,
  and an agent working around a gate is worse than no gate: it looks protected.
