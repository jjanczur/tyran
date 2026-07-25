# Contributing to Tyran

## Development loop

No build step, no npm dependencies. Core scripts are plain Node ≥ 22
(the test-runner glob form below requires it; CI pins Node 22).

```bash
git clone https://github.com/jjanczur/tyran.git
cd tyran

# Load your working copy directly into a Claude Code session:
claude --plugin-dir .

# Inside the session:
#   /tyran:hello        → smoke test (plugin loaded, namespace, root path)
#   /reload-plugins     → pick up your changes without restarting
```

A locally loaded `--plugin-dir` copy takes precedence over an installed
`tyran` plugin of the same name for that session — you can develop against
a repo that has Tyran installed without uninstalling it.

## Tests

```bash
node --test "tests/**/*.test.mjs"       # unit + hook tests
node scripts/desc-budget.mjs .          # skill description context budget
claude plugin validate .                # manifest validation
```

CI runs all three on every PR. A PR that grows the total skill-description
budget past the limit fails — trim descriptions or remove a skill; the
always-loaded context surface is a guarded resource.

## Rules that are enforced, not suggested

- **No runtime dependencies, no build step.** Scripts must run on plain
  Node. If it needs `npm install` to work, it does not belong in the core.
- **Critical gates fail loudly.** An enforcement hook that cannot do its
  job must deny with an explanation — never silently allow.
- **Evidence over claims.** Changes to policies or economy profiles come
  with benchmark receipts (`benchmarks/*/results.json`).
- **English everywhere** in code, skills, agents, and docs.

## Commits and versioning

- Conventional-ish commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
- `version` in `.claude-plugin/plugin.json` is explicit semver. Users only
  receive updates when it is bumped — bump it in the release PR together
  with a `CHANGELOG.md` entry.
