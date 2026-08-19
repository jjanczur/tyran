# Running Tyran under Cursor, Copilot, Codex and Antigravity

## Context

Tyran is built and marketed as a Claude Code plugin — `README.md:211` says
*"The only requirement is Claude Code ≥ 2.1"*, and `docs/architecture.md:201`
states the principle deliberately: *"Native mechanisms only. Built entirely on
Claude Code's plugin surface."*

That posture was correct when written. It is now costing users, because the
landscape moved: **all four rival harnesses have shipped a blocking
`PreToolUse` hook.** The one argument that ever justified the lock-in — that
only Claude Code can give a gate teeth — is no longer true.

The goal: adopt aggressively, ship what already works, and make the **board the
place that says out loud what is not working here**. A capability Tyran cannot
enforce or measure under a given harness must be visible as degraded, never
silently absent and never faked with a zero.

### What the research established

| | inject rules | **block a tool call** | skills | subagents | transcript |
|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | ✅ 6 events | `skills/` | ✅ | ✅ + usage windows |
| **Cursor** | `.cursor/rules/*.mdc`, `AGENTS.md` | ✅ **7 blocking events** (richest) | `.agents/skills/` | ✅ `.cursor/agents/` | partial; cost via Enterprise Admin API only |
| **Codex** | `AGENTS.md` | ✅ `PreToolUse` deny / exit 2 | `.agents/skills/` | ✅ `.codex/agents/*.toml` | ✅ `transcript_path` in payload |
| **Copilot** | `.github/copilot-instructions.md`, `AGENTS.md` | ✅ 14 events; **fails closed** | `.github/skills/` | ✅ `.agent.md` | ✅ `events.jsonl`, no documented token fields |
| **Antigravity** | `.agents/rules/`, `GEMINI.md` | ✅ `PreToolUse` only | `.agents/skills/` | ✅ `.agents/agents/` | ✅ `transcript.jsonl` with usage |

Four findings matter more than the table:

1. **Copilot/VS Code reads `.claude/settings.json` natively**, with PascalCase
   events and Claude matcher semantics. **Codex mirrors Claude's payload shape**
   too (`hook_event_name`, `hookSpecificOutput`, exit-2 deny). Claude Code's
   hook format is the de-facto cross-tool reference — so two of the four gate
   ports are close to free.
2. **Skills are already a shared open standard.** Anthropic's Agent Skills
   format (folder + `SKILL.md` + `description`) is read verbatim from
   `.agents/skills/` by Cursor, Copilot, Codex and Antigravity. Tyran's 14
   skills already comply.
3. **Cursor hooks default to fail-OPEN unless `failClosed: true`.** Tyran treats
   a silently-absent control as its worst defect (`hook-io.mjs:5`). Emitting a
   Cursor config without that flag ships exactly the bug the runtime exists to
   prevent.
4. **Codex requires hooks to be trusted by hash via `/hooks` before they fire.**
   A third party cannot silently install a gate. That is an onboarding step, and
   an untrusted hook is an *absent gate* — a board finding, not a footnote.

### How much already works with no code change at all

More than expected, and this is the thing to ship first.

**19 of 29 scripts carry zero Claude-specific references** — `journal.mjs`,
`project.mjs`, `board.mjs`, `board-daemon.mjs`, `board-html.mjs`,
`knowledge.mjs`, `mistakes.mjs`, `tiers.mjs`, `answer.mjs`, `stop-check.mjs`,
`yaml-*`, `invisible.mjs`, `scan-control-chars.mjs`, `cli-args.mjs` and the
rest. So do five of the nine hook handlers (`write-guard`, `secrets-gate`,
`retro-gate`, `pre-compact`, `board-refresh`).

`bin/tyran.mjs` already publishes 19 of them on npm, described in
`package.json` as *"for CI and terminals outside Claude Code"*. **Any harness
with a shell tool can drive the entire state layer today via
`npx @jjanczur/tyran …`** — journal, projections, board, doctor, knowledge,
tiers, the answer sheet, the STOP brake. That is the conductor's whole memory
and the operator's whole dashboard, working under Cursor and Codex right now,
with no adapter.

What genuinely needs building is narrow:

| Coupling | Where |
|---|---|
| hook wire protocol (events, field names, output shapes, exit codes) | `hooks/scripts/hook-io.mjs` — **one file** |
| registration format + `${CLAUDE_PLUGIN_ROOT}` | `hooks/hooks.json`; 53 refs, 6 of 14 skills |
| tool-name tables (`WRITE_TOOLS`, `READ_TOOLS`, `PATH_FIELDS`, `=== 'Bash'`) | `policy-gate.mjs:134-144`, `usage-gate.mjs:101`, `write-guard.mjs:101-298`, `hooks-check.mjs:178-236` |
| CC's matcher predicate, transcribed from the binary | `hooks-check.mjs:210`, pinned to `PLATFORM_VERSION` |
| transcript + usage formats | `cost.mjs`, `usage-source.mjs`, `statusline.mjs` |
| `claude -p --resume` | `overnight.mjs:143-147` |
| the `CLAUDE.md` rules fence | `mistakes.mjs:65,391,844` |
| manifests and asset frontmatter | `.claude-plugin/`, `agents/*.md`, `skills/*/SKILL.md` |

## The design

Three pieces, in dependency order.

### 1. `scripts/harness.mjs` — the only place a harness-specific name may appear

A new zero-dependency module holding one frozen descriptor per harness. This
mirrors a rule the repo already enforces for model names: `tiers:` is the only
place `haiku`/`sonnet`/`opus` may appear, pinned by
`tests/unit/agents.test.mjs`. Apply the same discipline — **a harness name or
harness-specific field name outside `harness.mjs` is a test failure.**

Each descriptor carries `events` (canonical → `{nativeName, canBlock,
refusalShape, context}`), `wire` (input field map + output shapes), `tools`
(alias map to canonical verbs `write`/`read`/`shell`/`mcp`, replacing four
scattered tables), `paths`, `failPosture` and the flag that forces it closed,
`install` (registry location and the env var standing in for
`${CLAUDE_PLUGIN_ROOT}`), and `capabilities`.

### 2. A canonical hook payload

`normalizeInput(harness, raw)` → frozen `{event, verb, tool, paths[], command,
cwd, actor, supervised, sessionId, transcriptPath}`. Gates then read canonical
fields and stop knowing the word `Bash`. `hook-io.mjs`'s contract — never throw
outward, hold its own deadline, never let `PASS` become `allow` — is unchanged;
only the tables it consults become parameterised.

### 3. The capability manifest, and the board panel that publishes it

`capabilities` per harness, consumed by doctor, the session banner and — the
part the user asked for — **a first-class board surface**.

| capability | Claude | Cursor | Codex | Copilot | Antigravity |
|---|---|---|---|---|---|
| `block.preTool` (policy + secrets gates) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `block.subagentStop` (the evidence gate) | ✅ | ✅ | ✅ | ✅ | ❌ |
| `block.stop` (the retro gate) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `block.preCompact` | ✅ | observe only | ✅ | ✅ | ❌ |
| `spend.tokens` | ✅ | ❌ Enterprise API | ✅ | ❌ | ✅ |
| `spend.subscriptionWindow` (overnight wind-down) | ✅ | ❌ | ❌ | ❌ | ❌ |
| `session.resume` (overnight) | ✅ | `cursor-agent -p` | `codex exec` | ✅ | `agy -p` |

**The board's Harness panel** — new tab in `board-html.mjs`, and the same
content as text in `BOARD.md` so the agent and git surfaces carry it too. One
row per capability, in exactly three states, each naming its consequence and the
operator's next step:

- **ENFORCED** — the mechanism is live and has been seen to refuse.
- **ADVISORY** — the rule exists only as prose in this harness. States plainly
  that a model can ignore it. *"The evidence contract is not enforced under
  Antigravity: a report with no raw output will not be refused."*
- **UNAVAILABLE** — no data source. The dependent surface is not rendered at
  all, and the panel says why. *"Spend is hidden: Cursor exposes token counts
  only through the Enterprise Admin API."*

Three rules govern it:

- **Absent data hides the surface, it never zeroes it.** This extends
  `cost.mjs:29`'s existing law — *"Gaps are reported, never zeroed"* — from
  rows to whole features.
- **Absent enforcement is stated everywhere**, not only in docs: board panel,
  `BOARD.md`, session banner, `doctor`.
- **Configured-but-unenforceable is an ERROR.** `limits: mode: pause` on a
  harness with no `spend.subscriptionWindow` fails doctor. This is precisely the
  bug `usage-source.mjs:5-13` was written to fix once already — *"overnight mode
  was silently inert"*.

## Phasing — adopt first, measure alongside

### Phase 1 — Ship what already works (no hook adapter)

The largest win for the least code, and it stands alone.

- `npx @jjanczur/tyran init --harness <name>` lays down: skills copied to
  `.agents/skills/` (only `${CLAUDE_PLUGIN_ROOT}` → `${TYRAN_ROOT}` substituted,
  6 of 14 files), agents generated from the single `agents/*.md` source into the
  harness's dialect, and the rules fence written to `AGENTS.md` instead of
  `CLAUDE.md`.
- `scan-repo.mjs` detects the harness from repo markers and records `harness:`
  in `config.yaml` with provenance, as it already does for every inferred value.
- `mistakes.mjs` resolves its fence target through the descriptor.
- Board Harness panel ships in this phase, with every gate row reading
  **ADVISORY** — which is true, and is the point.

At the end of Phase 1, Tyran's conductor, board, journal, projections, knowledge
and doctor run under Cursor, Codex and Copilot. Gates do not yet, and the board
says so on every screen.

### Phase 2 — The seam, with no behaviour change

Introduce `harness.mjs` and `normalizeInput`; rewire `hook-io.mjs` and the nine
handlers onto canonical fields. Claude stays the only registered adapter. Every
existing test passes unchanged and projections stay byte-identical under
`--check`. Verifiable with no other tool installed, and worth landing on its own
merits — it deletes four duplicate tool tables.

**Constraint: `hooks/**` is KERNEL in this repo.** An agent session cannot edit
`hook-io.mjs` or any gate; these go through an anchored apply-script the human
runs, verified against copies first.

### Phase 3 — Gates, cheapest first, then Cursor

- **Copilot and Codex opportunistically first** — both already speak Claude's
  hook shape, so the adapter may be a registry emitter and little else. Take the
  free wins before the expensive one.
- **Cursor is the proving target** for the seam, because its 7 blocking events
  are the richest surface and will find the design's gaps. Map `preToolUse` +
  `beforeShellExecution` + `beforeMCPExecution` → policy and secrets gates,
  `beforeReadFile` → the secret-read rule, `subagentStop` → evidence gate,
  `stop` → retro gate, `sessionStart` → the probe. Emit **`failClosed: true` on
  every gate**, and have doctor verify the flag — without it the gate is
  decoration.
- Each gate flips its board row from ADVISORY to ENFORCED only once it has been
  *seen refusing*, not once it has been registered.

### Phase 4 — Measured contracts and the long tail

Run continuously alongside Phases 1–3 rather than blocking them. The research is
documentation-derived; `hooks/HOOK-CONTRACT-MEASURED.md` (429 lines
disassembled out of the CC binary) is the standard this repo holds itself to.
Build one echo-hook, register it in each tool, drive deny/allow/ask through it,
and write `hooks/contracts/<harness>.md` in the existing format with every
unverified cell marked UNMEASURED. A capability may only read ENFORCED on the
board once its contract file says measured.

Then Antigravity, last and least certain: no `SubagentStop` or `PreCompact`
gate, undocumented rules frontmatter keys, an undocumented workflows path, and a
plugin manifest with **no `version` field** — which breaks the update path
`CLAUDE.md` calls the most expensive mistake in this repo. If the evidence
contract cannot be enforced there, the board says so and that is a legitimate
shipped state.

## Critical files

| File | Change |
|---|---|
| `scripts/harness.mjs` | **new** — descriptors, capabilities, `normalizeInput` |
| `hooks/scripts/hook-io.mjs` | `EVENTS`/payload builders read the descriptor (KERNEL, human-applied) |
| `hooks/scripts/{policy,secrets,usage,write,evidence,retro,pre-compact}*.mjs` | canonical fields; drop local tool tables (KERNEL) |
| `scripts/board-html.mjs` + `scripts/board.mjs` | **Harness panel**; hide tabs with no data source |
| `scripts/project.mjs` | the same three-state table as text in `BOARD.md` |
| `scripts/doctor.mjs` + `docs/doctor.md` | `--harness` mode, new codes, severity table **both directions** |
| `scripts/scan-repo.mjs` | detect harness; record with provenance |
| `scripts/schema.mjs` | `harness:` key + validator; `normalizePath` root via descriptor |
| `scripts/hooks-check.mjs` | per-harness registry check; `PLATFORM_VERSION` per harness |
| `scripts/cost.mjs` | per-harness transcript reader; unavailable ≠ zero |
| `scripts/{usage-source,overnight,statusline}.mjs` | capability-gated; refuse to be silently inert |
| `scripts/mistakes.mjs` | rules-fence target resolved per harness |
| `adapters/<harness>/` | **new** — registry emitters, asset generators |
| `bin/tyran.mjs` | `init --harness <name>` subcommand |
| `docs/*.md` + `site/src/content/docs/*.mdx` | both surfaces, always |
| `README.md` | requirement line; unit-test count (CI-checked, not suite-checked) |

Reuse rather than rebuild: `classifyPath`/`globMatches`/`validatePolicy`
(`schema.mjs:634-799`), `fold`/`boardOf`/`renderProjections` (`project.mjs`),
`tiers.mjs`'s role→model indirection, and `buildRoleScope`
(`evidence-gate.mjs:241`), which already abstracts agent naming through the
plugin manifest rather than hardcoding it.

## Verification

1. **Phase 1 works end to end under Cursor.** In a scratch repo: run
   `npx @jjanczur/tyran init --harness cursor`, start a Cursor agent, have it
   create an initiative, append journal events and open the board. The board
   renders, and its Harness panel shows every gate as ADVISORY.
2. **Phase 2 is a no-op proof.** `node --test "tests/**/*.test.mjs"` green with
   no expectation changes; `board.mjs --check` and `project.mjs --check`
   byte-identical. A behaviour change here is a bug, not progress.
3. **Gate teeth, measured not assumed.** Per harness: ask the agent to edit a
   KERNEL path and confirm the refusal text appears; commit a planted fake
   secret and confirm the refusal; return a subagent report with no raw output
   and confirm the evidence gate blocks. **A gate that cannot be shown refusing
   does not get an ENFORCED row.**
4. **Fail-closed is real.** Break a hook deliberately (exit 1; hang past the
   timeout) under each harness and confirm the call is refused, not allowed. The
   check most likely to fail, given Cursor's documented fail-open default.
5. **Degradation is honest.** On Cursor, confirm the Spend tab is absent rather
   than empty, that `limits: mode: pause` produces a doctor ERROR, and that
   `BOARD.md` carries the same three-state table as the HTML page.
6. **Repo hygiene** (`CLAUDE.md`): `git add` new files before running the suite
   (the control-char scan reads `git ls-files`); update the README's test count;
   change `docs/` and `site/` together; bump all three version fields in one
   commit.

## Honest sizing

XL — a programme, not a task. But it is front-loaded in the user's favour:
**Phase 1 delivers most of Tyran to three more tools without touching a single
gate**, because the state layer was already harness-free and the skills already
comply with an open standard. Phases 2–3 buy back the enforcement. Phase 4 is
open-ended and should not block the rest.
