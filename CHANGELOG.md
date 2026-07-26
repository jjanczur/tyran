# Changelog

## 0.1.0 — unreleased

### Behaviour change: invisible characters are SHOWN, not deleted

Projections used to delete invisible codepoints (bidi overrides, zero-width
marks, TAG characters) from journal values. They now render them as escape
notation — `<U+202E>` — because deleting them made a poisoned value and a
clean one look identical, and **ADR-19** requires that an exclusion never be
silent.

**Do you need to regenerate `STATE.md` / `PROGRESS.md`?** Measured, both ways:

- A journal that never contained an invisible character produces
  **byte-identical** projections before and after. `project.mjs --check`
  stays green; nothing to do.
- A journal that *did* contain one drifts, and `--check` exits 1. That drift
  is the point: the projection on disk was hiding characters that were in the
  journal. Regenerate it with the command `--check` already prints:
  `node scripts/project.mjs <journal.jsonl> --out-dir <dir>`.

The same rule now covers every operator-facing channel, not just the two
documents: `project.mjs` warnings on stderr, every `journal.mjs` subcommand
(as JSON `\uXXXX`, so the output still parses back identically), the
`doctor.mjs` report, the session-start context injection, `schema.mjs` and
`desc-budget.mjs`. `yaml-lite.stringify` refuses to serialize such a value at
all, since this YAML subset has no escape that survives a round trip.

- Plugin skeleton: manifest, single-plugin marketplace, directory layout.
- `/tyran:hello` installation smoke-test skill.
- CI: unit tests (`node --test`), skill description budget guard
  (`scripts/desc-budget.mjs`), plugin manifest validation, gitleaks scan.
- Contributor guide with the zero-dependency / no-build-step core rule.

### docs (0.1.0, pre-release)

- Brand identity: hero banner (pharaoh conductor, agents building a pyramid),
  README v2 with honest status labels and a receipts-footnoted comparison.
- docs/: getting-started, configuration, architecture, self-improvement, FAQ.
- Security workflow: gitleaks + semgrep (p/ci); all Actions pinned to commit
  SHAs, semgrep container pinned to image digest.
