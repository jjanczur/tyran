# CLAUDE.md

Tyran is a Claude Code plugin: skills, agents, `PreToolUse` hooks, and
zero-dependency Node scripts. No build step, no runtime deps, Node ≥ 22.

Read [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, the test commands and
the enforced rules — they are not repeated here. This file is the rest: the
places where the obvious move is the wrong one, and the procedures that have
already cost someone a wasted release.

**The house rule that shapes everything else: one answer lives in one place.**
Before adding a paragraph, look for where the answer already is and link to it.
Three spellings of one rule is the defect this repo names ADR-21, and it has
been found here more than once.

## Two surfaces for every document

`docs/*.md` (GitHub) and `site/src/content/docs/*.mdx` (the docs site) publish
the same claims. **Change both, always.** They were migrated from each other
once and immediately diverged, because nobody re-reads a page they already
reviewed. `tests/unit/docs-claims.test.mjs` checks both surfaces.

Prose in this repo is checkable on purpose:

- **numbers are claims.** "47 unit tests" in a doc is verified against the
  actual count. Do not write a number you have not just measured.
- **`docs/doctor.md`'s severity table must equal `SEVERITY_BY_CODE`** in
  `scripts/doctor.mjs`, in both directions. Add a finding code, add the row.
- **no model name outside `tiers:`** — `tests/unit/agents.test.mjs` fails if
  `haiku`/`sonnet`/`opus`/`fable` appears in any agent or skill file.

## Releasing — the version, not the commit

`claude plugin update` compares the **`version` field**, not the commit. A fix
merged to `main` without a bump reports *"already at the latest version"* and
reaches nobody. This has happened; it is the reason this section exists.

Bump all three in one commit — they are cross-checked by different tools:

| file | checked by |
|---|---|
| `.claude-plugin/plugin.json` | what `claude plugin update` reads |
| `.claude-plugin/marketplace.json` | `claude plugin tag` fails if it disagrees with plugin.json |
| `package.json` | `npm-publish.yml` fails if it disagrees with the release tag |

Then `claude plugin tag .` (creates `tyran--v<version>`), plus a `v<version>`
tag — **both**, because they serve different consumers and neither covers the
other: `npm-publish.yml` computes `${GITHUB_REF_NAME#v}`, which `tyran--v0.1.1`
does not satisfy.

Publishing to npm happens when a `v<version>` tag is pushed **or** a GitHub
release is published — `npm-publish.yml` triggers on both (a pushed tag was
added in 0.1.4, after the manual release step was skipped for three consecutive
versions and npm drifted three releases behind the marketplace). npm refuses a
duplicate version, so if both fire the second fails loudly rather than shipping
something different under the same number. Publishing is irreversible — a
version, once on npm, cannot be replaced.

## The gate runs on you too

`hooks/scripts/policy-gate.mjs` is live in any session working inside a repo
that has adopted Tyran. Two consequences that look like tool failures:

- **A `Bash` command whose text names `hooks/**` or `.tyran/policies/**` is
  refused** — including a validator. So
  `schema.mjs validate policy .tyran/policies/autonomy.yaml` is a command a
  *human* runs in a terminal; an agent uses
  `node scripts/doctor.mjs --state --dir .tyran`, which validates the same file
  and names only the directory.
- `Read` is not refused for those paths. Reach for it instead of `cat`.

**This repository has no `.tyran/` directory**, so the path classes do not
apply to Tyran's own source — the shell rule above still does, since it needs
no policy. Do not conclude from an allowed `Edit hooks/…` here that the same
edit is allowed in a user's repo.

## The YAML subset is small, and it bites

`scripts/yaml-lite.mjs` rejects block scalars (`>-`, `|`), anchors, tags, flow
mappings and tabs — loudly, with a line number. Hand-writing a long `source:`
in a `.tyran/config.yaml` as `>-` produces a file the policy gate cannot parse,
which makes it refuse **every write in that repo**. Keep long values on one
single-quoted line. `stringify()` already does; humans and agents editing by
hand are the risk.

## The docs site

- **Cross-links must be relative** (`../policy-gate/`). The site is served from
  `jjanczur.github.io/tyran`, and `site/scripts/check-base-prefix.mjs` fails the
  Pages build on any root-absolute URL missing the base prefix.
- Building it locally needs `npx playwright install chromium-headless-shell` —
  the build renders og-images in a browser. Without it the build dies with a
  stack trace that says nothing about Playwright until you scroll.

```bash
cd site && npm ci && GITHUB_PAGES=true npm run build && node scripts/check-base-prefix.mjs
```

`npm run build`, not `npx astro build`: the build first generates the clickable
sandbox board into `public/sandbox/` from the journals in `site/sandbox/`,
shifting their timestamps so the agent ages stay fresh. Call `astro` directly
and you publish a site whose sandbox link 404s.

## Small things that waste a cycle

- `node --test tests/unit/` fails with `MODULE_NOT_FOUND`. The runner wants the
  quoted glob: `node --test "tests/**/*.test.mjs"`.
- `scan-repo.mjs --write .tyran/config.yaml` also installs the autonomy policy,
  before the config, on purpose — see the comment on `ensureAutonomyPolicy`.
  `--ensure-policy` is the repair-only path.
- Skill descriptions are summed into a context budget CI enforces. A new skill
  costs every session, whether it fires or not.
- **When a change ADDS a file, `git add` before running the suite.** The
  control-char scan builds its file list from `git ls-files`, so an untracked
  file is invisible to it: the suite passes locally and CI — which only ever
  sees committed files — is the first thing to look at the real set. Two
  separate cycles have been lost to this.
- **When a change adds or removes TESTS, update the README's count.** It is
  verified by a CI step, not by the suite, so `node --test` stays green and
  the push is the first thing that disagrees. `grep -n 'unit tests' README.md`
  against the run's own `tests N`. Two cycles lost to this in one session,
  which is the same shape as the entry above: a check the local loop cannot
  see.
- **A field added to `cost.mjs`'s scan needs two more edits or it is silently
  null forever.** `report.sources` is a WHITELIST projection, and `COST_SCHEMA`
  is what discards caches written before the field existed. Missing either, an
  unchanged transcript keeps its old record and the field reads null on every
  later run — which produced a reported span of ONE day where the truth was
  nineteen. A wrong number, not a missing one.
