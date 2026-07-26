# Changelog

## 0.1.0 — unreleased

- Plugin skeleton: manifest, single-plugin marketplace, directory layout.
- `/tyran:hello` installation smoke-test skill.
- CI: unit tests (`node --test`), skill description budget guard
  (`scripts/desc-budget.mjs`), plugin manifest validation, gitleaks scan.
- Contributor guide with the zero-dependency / no-build-step core rule.
- Secrets gate (`hooks/scripts/secrets-gate.mjs`, `PreToolUse` / `Bash`). The
  gate assembles the payload itself — objects from `git diff --raw` /
  `git rev-list --objects`, contents from `git cat-file --batch`, none of
  which consult `.gitattributes` — pipes it to `gitleaks stdin`, and refuses
  unless the scanner reports reading exactly the bytes it was sent. It models
  the shell's working directory across `cd`/`pushd`/`popd` and refuses any
  movement it cannot follow rather than guessing. A push is measured against
  the remote it targets, not against every remote. `gh release`/`gist` uploads
  are read from disk. `--no-verify` and its abbreviations, `core.hooksPath`
  overrides, `--force` pushes (not `--force-with-lease`) and `kill -9` (all
  spellings, including `kill -n 9`) are refused without scanning. Suppression
  files are honoured only when git tracks them. A refusal never carries the
  scanner's match, elides long opaque runs in paths, and filters rule ids
  through an allowlist. Declared limits, false-alarm rates and the scanner's
  own measured false negatives are in `docs/hooks.md`.
- CI installs gitleaks (pinned by version and sha256) and fails if any test
  was skipped, so the gate's real-binary test cannot silently not run.

### docs (0.1.0, pre-release)

- Brand identity: hero banner (pharaoh conductor, agents building a pyramid),
  README v2 with honest status labels and a receipts-footnoted comparison.
- docs/: getting-started, configuration, architecture, self-improvement, FAQ.
- Security workflow: gitleaks + semgrep (p/ci); all Actions pinned to commit
  SHAs, semgrep container pinned to image digest.
