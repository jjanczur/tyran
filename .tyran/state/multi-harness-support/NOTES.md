# NOTES — multi-harness support

Research dossier for the initiative. Gathered 2026-08-19. **Everything below
that came from a vendor's documentation is marked as such and is NOT measured**
— `hooks/HOOK-CONTRACT-MEASURED.md` is the standard this repo holds itself to,
and T-10 exists to bring these claims up to it.

Read `PLAN.md` for what to do. This file is why.

---

## 1. The finding the whole initiative rests on

**All four rival harnesses now ship a blocking `PreToolUse`-class hook** that
can return `deny` and stop a tool call before it executes.

Tyran's public position — `README.md:211` *"The only requirement is Claude Code
≥ 2.1"*, `docs/architecture.md:201` *"Native mechanisms only"* — rested on a
single load-bearing claim: that only Claude Code can give a gate teeth. That
claim expired. Everything else in the port is engineering.

## 2. Capability matrix

| | inject rules | **block a tool call** | skills | subagents | transcript |
|---|---|---|---|---|---|
| **Claude Code** | `CLAUDE.md` | 6 events | `skills/` | yes | yes + usage windows |
| **Cursor** | `.cursor/rules/*.mdc`, `AGENTS.md` | **7 blocking of ~20** | `.agents/skills/` | `.cursor/agents/` | partial; cost only via Enterprise Admin API |
| **Codex** | `AGENTS.md` | `PreToolUse` deny / exit 2 | `.agents/skills/` | `.codex/agents/*.toml` | `transcript_path` in payload |
| **Copilot** | `.github/copilot-instructions.md`, `AGENTS.md` | 14 events; **fails closed** | `.github/skills/` | `.agent.md` | `events.jsonl`, no documented token fields |
| **Antigravity** | `.agents/rules/`, `GEMINI.md` | `PreToolUse` only | `.agents/skills/` | `.agents/agents/` | `transcript.jsonl` with usage |

## 3. Per-harness detail

### Cursor — the richest surface, and the most dangerous default

- **Hooks** — https://cursor.com/docs/hooks. ~20 events. Blocking (7):
  `preToolUse`, `subagentStart`, `beforeShellExecution`, `beforeMCPExecution`,
  `beforeReadFile`, `beforeTabFileRead`, `beforeSubmitPrompt`. Observational
  (14): `sessionStart`, `sessionEnd`, `postToolUse`, `postToolUseFailure`,
  `subagentStop`, `afterShellExecution`, `afterMCPExecution`, `afterFileEdit`,
  `afterTabFileEdit`, `afterAgentResponse`, `afterAgentThought`, `preCompact`,
  `stop`, `workspaceOpen`.
- Config: `.cursor/hooks.json`, `~/.cursor/hooks.json`, plus enterprise paths
  (`/Library/Application Support/Cursor/hooks.json`, `/etc/cursor/hooks.json`,
  `C:\ProgramData\Cursor\hooks.json`).
- Per-handler keys: `command`, `type` (`command` | `prompt` — an LLM-based
  hook), `timeout`, `loop_limit`, `failClosed`, `matcher`.
- **⚠️ Default is fail-OPEN unless `failClosed: true`.** This is the single most
  important line in this file. Tyran's entire runtime (`hook-io.mjs:5`) is built
  around Claude Code failing open being a *hazard to be engineered against*;
  under Cursor the flag makes it a choice, and not setting it ships a decorative
  gate.
- `beforeReadFile` can rewrite content before it reaches the model.
  `sessionStart` can inject `env` and `additional_context`. Project hooks load
  automatically in cloud agents (command-type only).
- **Rules** — https://cursor.com/docs/context/rules. `.cursor/rules/*.mdc`,
  frontmatter `description` / `globs` / `alwaysApply`. Plain `.md` in that
  folder is **ignored**. `AGENTS.md` supported at root and in subdirectories,
  more specific wins. Precedence: Team Rules → Project Rules → User Rules; Team
  Rules can be marked "Enforce this rule" so users cannot disable them.
- **Skills** — https://cursor.com/docs/context/skills. `.agents/skills/`,
  `.cursor/skills/`, `~/.agents/skills/`, `~/.cursor/skills/`, plus legacy
  `.claude/skills/` and `.codex/skills/`. A built-in `/migrate-to-skills`
  exists. `.cursor/commands/*.md` still works but is **no longer documented** —
  treat as legacy.
- **Subagents** — https://cursor.com/docs/agent/subagents. `.cursor/agents/`,
  `.claude/agents/`, `.codex/agents/`. Frontmatter: `name`, `description`,
  `model` (`inherit` or e.g. `composer-2.5[fast=false,context=300k]`),
  `readonly`, `is_background`.
- **Cost** — https://cursor.com/docs/account/teams/admin-api.
  `POST /teams/filtered-usage-events` returns model, input/output/cache token
  counts and `chargedCents`; also `/teams/spend`, `/teams/daily-usage-data`,
  `/teams/audit-logs`. Basic auth, 20 req/min, **Enterprise-gated**. Locally,
  `agent_transcript_path` arrives in the `subagentStop` payload.
- **MCP** — `.cursor/mcp.json`, `mcpServers` key, stdio + SSE + Streamable HTTP.

### GitHub Copilot — the widest hook surface, and it speaks Claude

- **Hooks** — https://docs.github.com/en/copilot/reference/hooks-reference.
  Events: `sessionStart`, `sessionEnd`, `userPromptSubmitted`,
  `userPromptTransformed`, `preToolUse`, `postToolUse`, `postToolUseFailure`,
  `permissionRequest`, `preCompact`, `agentStop`, `subagentStart`,
  `subagentStop`, `errorOccurred`, `notification`.
- Config: `.github/hooks/*.json`, `~/.copilot/settings.json`,
  `.github/copilot/settings.json`, enterprise policy at
  `/etc/github-copilot/policy.d/*.json`. Handler types: `command`, `http`,
  `prompt`.
- Blocking: `{"permissionDecision": "allow"|"deny"|"ask",
  "permissionDecisionReason": "...", "modifiedArgs": {...}}`, or exit code 2.
  **`preToolUse` fails CLOSED on a non-2 non-zero exit** — the opposite posture
  to Claude Code, and the safe one.
- **⭐ VS Code hooks (Preview) natively read `.claude/settings.json` and
  `~/.claude/settings.json`** with PascalCase events and Claude matcher
  semantics — https://code.visualstudio.com/docs/copilot/customization/hooks,
  setting `chat.hookFilesLocations`. Copilot deliberately accepts Claude Code's
  hook format. This is why the Copilot adapter may be nearly free.
- **Instructions** — `.github/copilot-instructions.md`;
  `.github/instructions/*.instructions.md` (frontmatter `applyTo` glob);
  `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` all read; also
  `.claude/rules/*.instructions.md`. User scope `~/.copilot/instructions/`,
  `~/.claude/rules/`. Precedence: personal → repository → organization.
- **Prompts/skills** — `.github/prompts/*.prompt.md`
  (`chat.promptFilesLocations`); skills at `.github/skills/`, `.claude/skills/`,
  `.agents/skills/`, `~/.copilot/skills/`, `~/.claude/skills/`,
  `~/.agents/skills/` (`chat.agentSkillsLocations`).
- **Subagents** — `.chatmode.md` was **renamed to `.agent.md`**. Locations
  `.github/agents/`, `.claude/agents/`, `~/.copilot/agents/`. Frontmatter:
  `name`, `description`, `target`, `tools`, `model`, `mcp-servers`,
  `disable-model-invocation`, `user-invocable`, `metadata`. Delegation via the
  `agents` property + the `agent` tool. Org-level agents live in the org's
  `.github` repo.
  https://docs.github.com/en/copilot/reference/custom-agents-configuration
- **Transcript** — `~/.copilot/session-state/{session-id}/events.jsonl`, plus
  `session-store.db` (SQLite) and `~/.copilot/logs/`. **No documented per-token
  cost fields** — so Spend hides under Copilot.
- **MCP** — `.vscode/mcp.json` with top-level `"servers"` (not `mcpServers`);
  `~/.copilot/mcp-config.json` for the CLI.

### OpenAI Codex — Claude-shaped payloads, but hooks must be trusted

Docs moved: `developers.openai.com/codex/*` now 308-redirects to
`learn.chatgpt.com/docs/*`.

- **Hooks** — https://learn.chatgpt.com/docs/hooks. `SessionStart`,
  `SessionEnd`, `SubagentStart`, `PreToolUse`, `PermissionRequest`,
  `PostToolUse`, `PreCompact`, `PostCompact`, `UserPromptSubmit`,
  `SubagentStop`, `Stop`. Config: `~/.codex/hooks.json`,
  `<repo>/.codex/hooks.json`, or inline `[hooks]` in `config.toml`; plugins ship
  `hooks/hooks.json`.
- Payload shape is **Claude-Code-compatible**: `session_id`, `transcript_path`,
  `cwd`, `hook_event_name`, `permission_mode`. Deny via
  `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision":
  "deny", "permissionDecisionReason": "..."}}` or exit 2.
- **⚠️ Trust model.** Non-managed hooks require review and are trusted **by
  hash** via `/hooks` before they run. You cannot silently drop a `hooks.json`
  into a repo and have it fire. `--dangerously-bypass-hook-trust` exists;
  managed hooks from MDM / `requirements.toml` skip review. Untrusted = absent
  gate = board finding.
- **AGENTS.md** — https://learn.chatgpt.com/docs/agent-configuration/agents-md.
  Reads `$CODEX_HOME/AGENTS.override.md` then `AGENTS.md` globally; then in
  every directory from git root down to cwd checks `AGENTS.override.md` →
  `AGENTS.md` → `project_doc_fallback_filenames`. One file per directory,
  concatenated root-first so deeper wins. Capped by `project_doc_max_bytes`.
- **config.toml** — https://learn.chatgpt.com/docs/config-file/config-reference.
  `~/.codex/config.toml`; project `.codex/config.toml` **only for trusted
  projects**. `approval_policy`: `untrusted` | `on-request` | `never`.
  `sandbox_mode`: `read-only` | `workspace-write` | `danger-full-access`, with
  `[sandbox_workspace_write]` → `writable_roots`, `network_access`.
  **Project-local config cannot override** `notify`, `profile`, `profiles`,
  `model_provider`, `model_providers`, `openai_base_url`, `chatgpt_base_url`,
  `otel` — so a repo-committed Codex config cannot install a notify hook or a
  telemetry exporter.
- **Skills** — https://learn.chatgpt.com/docs/build-skills. `.agents/skills/`
  (cwd upward to repo root), `$HOME/.agents/skills/`, `/etc/codex/skills`.
  Invoked `$skill` or `/skills`. **Custom prompts are deprecated** in favour of
  skills (legacy: `~/.codex/prompts/*.md`, `/prompts:<name>`, no subdirectories).
- **Subagents** — https://learn.chatgpt.com/docs/agent-configuration/subagents.
  TOML in `~/.codex/agents/` and `.codex/agents/`. Required `name`,
  `description`, `developer_instructions`; optional `model`,
  `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`.
  Governed by `[agents]` (`agents.enabled`,
  `agents.max_concurrent_threads_per_session`,
  `agents.default_subagent_model`). Not available in ChatGPT Work.

### Google Antigravity — the weakest target

- **Hooks** — https://antigravity.google/docs/hooks/. Only five events:
  `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`. **Only
  `PreToolUse` can block**, via `decision`: `allow` | `deny` | `ask` |
  `force_ask` | `deny_unless_prior_grant`. Config `.agents/hooks.json`,
  `~/.gemini/config/hooks.json`.
  **Consequence: no `SubagentStop`, so the evidence gate — Tyran's headline
  mechanism — cannot be enforced under Antigravity at all.**
- **Rules** — https://antigravity.google/docs/rules-workflows/. Global
  `~/.gemini/GEMINI.md`; workspace `.agents/rules/` (back-compat
  `.agent/rules`). **12,000 character limit per file.** Four activation modes
  (Manual / Always On / Model Decision / Glob) — but **the frontmatter key names
  are not documented**, so a correct rules file cannot be generated from docs
  alone.
- **AGENTS.md is not documented anywhere** on antigravity.google/docs.
- **Skills** — `.agents/skills/<name>/SKILL.md`, `~/.gemini/config/skills/`;
  explicitly cites agentskills.io.
- **Workflows** — invoked `/workflow-name`, 12,000 char limit. **On-disk
  directory not documented**; `/docs/cli/workflows/` 404s. Appears
  IDE-panel-managed, so there is no documented path to ship them as files.
- **Subagents** — https://antigravity.google/docs/subagents/.
  `.agents/agents/<name>.md` or `.agents/agents/<name>/agent.md`; global
  `~/.gemini/config/agents/`. Frontmatter `name`, `description`, `tools`,
  `model` (`inherit`/`flash`/`pro`), `commandExecutionPolicy`, `subagent`,
  `mainAgent`. Invoked via an `invoke_subagent` tool.
- **Plugins** — https://antigravity.google/docs/plugins/. A single `plugin.json`
  bundling `mcp_config.json` + `hooks.json` + `skills/` + `agents/` + `rules/` +
  `sidecars/`. Workflows and commands are **not** bundleable. Manifest has only
  `$schema`, `name`, `description` — **no `version` field**, so no documented
  update semantics. Install from a local path; no marketplace. IDE and CLI docs
  **disagree** on the global plugin root (`~/.gemini/config/plugins/` vs
  `~/.gemini/antigravity-cli/plugins/`).
- **Permissions** — `~/.gemini/antigravity-cli/settings.json`,
  `{"permissions": {"allow": [], "deny": [], "ask": []}}`, precedence
  Deny > Ask > Allow, syntax `action(target)` with actions `read_file`,
  `write_file`, `read_url`, `execute_url`, `command`, `unsandboxed`, `mcp`.
  **No repo-committed permission file exists** — permissions are user-global
  only, so the only contributable gate is a plugin-bundled `hooks.json`.
- **CLI/transcript** — binary is `agy`; `agy -p` with
  `--output-format text|json|stream-json`. JSON envelope includes
  `usage{input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
  total_tokens}`. Transcripts at
  `~/.gemini/antigravity/brain/<conversationId>/.system_generated/logs/transcript.jsonl`.
  Keyed by conversation UUID, outside the repo — **no path-based project
  grouping**, unlike Claude Code's project-slug layout that `cost.mjs:393` relies
  on.
- **MCP** — `.agents/mcp_config.json`. Uses `serverUrl` for remote; **`url` and
  `httpUrl` are explicitly unsupported**, so a Claude-style `.mcp.json` does not
  port unchanged.

## 4. Cross-tool standards

- **AGENTS.md** — https://agents.md/. A convention, not a spec ("just standard
  Markdown"). Governed by the **Agentic AI Foundation under the Linux
  Foundation**, formed Dec 2025, anchored by MCP (Anthropic), goose (Block) and
  AGENTS.md (OpenAI); 150+ members, 60k+ repos. Supported by Codex, Cursor,
  VS Code/Copilot, Jules, Gemini CLI, Windsurf, Devin, Junie, Zed, Warp, Amp,
  Factory, Aider, goose, opencode, RooCode, Ona, Augment. **Not Antigravity.**
- **Agent Skills** — https://agentskills.io/. The strongest convergence.
  Anthropic-authored, released as an open standard, now community-governed.
  Folder + `SKILL.md`; frontmatter `name` (≤64 chars, lowercase/hyphens, must
  match the directory) and `description` (≤1024, required); optional `license`,
  `compatibility` (≤500), `metadata`, `allowed-tools` (experimental); optional
  `scripts/`, `references/`, `assets/`. Validator: `skills-ref validate`.
  Adopters include Cursor, Copilot, VS Code, Codex, Gemini CLI, Junie, Amp,
  goose, OpenCode, OpenHands, Kiro, Roo Code, Factory, Letta, Firebender,
  Databricks, Snowflake, Tabnine, Laravel Boost, Mistral Vibe.
  **Tyran's 14 skills already comply.**
- **`.agents/` is the emerging neutral directory.** Cursor, Copilot/VS Code,
  Codex and Antigravity all read `.agents/skills/`. Antigravity extends it to
  `.agents/rules/`, `.agents/agents/`, `.agents/hooks.json`,
  `.agents/mcp_config.json`.
- **Hooks have no formal spec, but Claude Code's format is the de-facto
  reference** — Copilot reads `.claude/settings.json` directly, Codex mirrors
  the payload. This is a strategic asset for Tyran: it was built against the
  format everyone else copied.
- **Agent Plugins spec** —
  https://github.com/agentplugins/agent-plugins-spec, v1.0.0. Bundles **only**
  Agent Skills + MCP servers; commands, hooks, agents and rules are explicitly
  "outside the v1 format". Not yet useful for Tyran, whose value is the gates.
- **MCP** — universal across all four, with four different config shapes
  (`mcpServers` for Cursor/Antigravity, `servers` for VS Code, `[mcp_servers.*]`
  TOML for Codex, and `serverUrl` vs `url` divergence).

## 5. What Tyran already has

Measured in-repo, this session.

**19 of 29 scripts carry zero Claude-specific references:** `journal.mjs`,
`project.mjs`, `board.mjs`, `board-daemon.mjs`, `board-html.mjs`,
`knowledge.mjs`, `mistakes.mjs`, `migrate.mjs`, `tiers.mjs`, `answer.mjs`,
`stop-check.mjs`, `yaml-lite.mjs`, `yaml-patch.mjs`, `invisible.mjs`,
`scan-control-chars.mjs`, `cli-args.mjs`, `desc-budget.mjs`, `keepawake.mjs`,
`ensure-gitleaks.mjs`.

**5 of the 9 hook handlers do too:** `write-guard`, `secrets-gate`,
`retro-gate`, `pre-compact`, `board-refresh`. Every gate already exports a
*pure* decision function taking a plain object — `policy-gate.decide({input})`,
`evidence-gate.judge(input)`, `write-guard.judge(input, options)` — so only the
runtime under them is coupled.

**`bin/tyran.mjs` already ships 19 subcommands on npm**, delegating verbatim to
`scripts/` with the exit code preserved. `package.json` says it plainly: *"for
CI and terminals outside Claude Code."* Any harness with a shell tool can drive
the whole state layer today.

### Env-var coupling, counted

| var | uses | what it really means |
|---|---|---|
| `CLAUDE_PLUGIN_ROOT` | 53 | "where the plugin lives" — trivially remappable to `TYRAN_ROOT` |
| `CLAUDE_PROJECT_DIR` | 6 | repo root |
| `CLAUDE_MD_FILE` / `CLAUDE_MD_PATH` | 11 | the rules-fence target |
| `CLAUDE_CONFIG_DIR` / `CLAUDE_CONFIG_RELPATH` | 7 | `~/.claude.json`, usage + plan |

### The real coupling list

| Coupling | Where |
|---|---|
| hook wire protocol | `hooks/scripts/hook-io.mjs` — one file |
| registration + `${CLAUDE_PLUGIN_ROOT}` | `hooks/hooks.json`; 6 of 14 skills |
| four duplicated tool-name tables | `policy-gate.mjs:134-144`, `usage-gate.mjs:101`, `write-guard.mjs:101-298`, `hooks-check.mjs:178-236` |
| the matcher predicate, transcribed from the CC binary | `hooks-check.mjs:210`, pinned to `PLATFORM_VERSION` |
| transcript + usage formats | `cost.mjs:393,512,926`, `usage-source.mjs`, `statusline.mjs` |
| `claude -p --resume` | `overnight.mjs:143-147` |
| the `CLAUDE.md` rules fence | `mistakes.mjs:65,391,844` |
| manifests + asset frontmatter | `.claude-plugin/`, `agents/*.md`, `skills/*/SKILL.md` |

`cost.mjs` already accepts `--transcripts <dir>` and `--projects <dir>`, so it
is closer to portable than it looks.

## 6. Open questions — do not build on these

Reported by the research pass as **not confirmable from official documentation**.
T-10 resolves them by measurement.

- **Antigravity**: AGENTS.md support; rules frontmatter key names; the workflows
  directory; plugin versioning/update semantics; whether the global root is
  `~/.gemini/config/` or `~/.gemini/antigravity-cli/` (docs contradict).
- **Codex**: official documentation of `~/.codex/sessions/**/rollout-*.jsonl`
  (community-reported only; `/rollout` prints it at runtime).
- **Cursor**: whether `--output-format stream-json` carries token/cost fields;
  the current official page for `.cursor/commands/`.
- **Copilot**: per-token cost fields inside `events.jsonl`; organization-level
  skill paths.

## 7. Constraints carried from this repo

- **`hooks/**` is KERNEL here** (adopted 0.1.41). An agent session cannot edit
  the runtime or the gates — T-5 must be a human-applied, anchored patch,
  verified against copies first. This was demonstrated live during the research:
  the policy gate refused four `cat`/`grep` commands for merely *naming* those
  paths.
- **Two documentation surfaces**, always: `docs/*.md` and
  `site/src/content/docs/*.mdx`. Site cross-links must be relative.
- **Numbers are claims.** The README's unit-test count is checked by a CI step,
  not by the suite; `docs/doctor.md`'s severity table must equal
  `SEVERITY_BY_CODE` in both directions.
- **`git add` before running the suite** when a change adds files — the
  control-char scan builds its list from `git ls-files`.
- **A field added to `cost.mjs`'s scan needs two more edits** (`report.sources`
  whitelist and `COST_SCHEMA`) or it reads null forever. Relevant to T-9.
