# Changelog

## 0.1.0 — unreleased

- Plugin skeleton: manifest, single-plugin marketplace, directory layout.
- `/tyran:hello` installation smoke-test skill.
- CI: unit tests (`node --test`), skill description budget guard
  (`scripts/desc-budget.mjs`), plugin manifest validation, gitleaks scan.
- Contributor guide with the zero-dependency / no-build-step core rule.
- Secrets gate (`hooks/scripts/secrets-gate.mjs`, `PreToolUse` / `Bash`):
  scans the staged index before a commit and every unpushed commit before a
  push or a `gh` publish, delegating the ruleset to gitleaks; refuses
  `--no-verify`, `core.hooksPath` overrides, `--force` pushes (not
  `--force-with-lease`) and `kill -9` without scanning. A missing, killed or
  crashed scanner is a refusal, never a warning. The refusal names file, line
  and rule and never the secret. Declared limits, false-alarm rates and the
  scanner's own false negatives are in `docs/hooks.md`.
- CI installs gitleaks (pinned by version and sha256) and fails if any test
  was skipped, so the gate's real-binary test cannot silently not run.

### docs (0.1.0, pre-release)

- Brand identity: hero banner (pharaoh conductor, agents building a pyramid),
  README v2 with honest status labels and a receipts-footnoted comparison.
- docs/: getting-started, configuration, architecture, self-improvement, FAQ.
- Security workflow: gitleaks + semgrep (p/ci); all Actions pinned to commit
  SHAs, semgrep container pinned to image digest.
