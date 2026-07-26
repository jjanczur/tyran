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
node scripts/scan-control-chars.mjs .   # raw control / bidi characters (ADR-19)
claude plugin validate .                # manifest validation
```

CI runs all four on every PR. A PR that grows the total skill-description
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
- **No raw control or bidi characters in tracked files** (ADR-19). Write
  the escape notation, or build the character with `String.fromCodePoint()`.
  `scripts/scan-control-chars.mjs` enforces this in CI and names the file,
  line, column, byte offset and codepoint of every hit. A binary asset must
  be declared `binary` in `.gitattributes`; the scanner refuses a tracked
  file it cannot decode and has not been told about, and prints every
  exemption on every run. Both rules exist because the alternatives —
  inferring "this is binary" from a file's own contents — can be defeated by
  editing those contents, which is how a poisoned file bought its way out of
  this gate twice during development.
  The scan covers a file's **name** and a symlink's **target** as well as its
  contents — both reach the reader through tool output and through the
  projections an agent reads, and an exemption granted to a file's bytes never
  covers its name. TAB and LF are legal inside a file and forbidden in a path.
  Two gaps are deliberate and documented in the scanner rather than hidden:
  `U+FE00`-`U+FE0F` stay legal because `U+FE0F` is emoji presentation and this
  repo's README uses it 24 times, and the list is a denylist, so it is
  structurally incomplete by construction (ADR-19 correction 1).
- **A test for a guarantee is finished only once you have watched it fail**
  (ADR-20) — see below.

### ADR-20: show the dead mutant

A test that defends a non-trivial guarantee is not done when it passes. It is
done when the author has deliberately broken the mechanism it guards, watched
the test go red, restored the mechanism, and watched it go green again — and
has put that sequence in the PR or the work report.

This is "evidence over claims" pointed at our tests instead of at our prose. A
passing test is a claim: *this code is protected*. The dead mutant is the
evidence. Without it we have only established that the test passes against the
code as written, which is also true of a test that asserts nothing.

The empirical case is local, not borrowed. In one story, six of nine review
blockers were tests that passed over broken code. In another, five separate
mutations survived a full green suite of 36 tests — one of them downgrading a
security gate to a heuristic while every test stayed green.

**Scope: guarantees, not assertions.** Apply it where the documentation makes
a promise to a reader — atomicity, mutual exclusion, corruption tolerance, a
gate that cannot be forged, a rule that must survive concurrency. Do not apply
it to ordinary assertions about ordinary behaviour; a rule that covers
everything is a ritual, and rituals get performed rather than thought about.
The question that settles it: *does something we wrote promise this?*

Mutation is manual and one-off — a mutation-testing runner would mean a
dependency and a much slower CI, so it stays a candidate for later rather than
a condition now.

## Commits and versioning

- Conventional-ish commits: `feat:`, `fix:`, `docs:`, `chore:`, `test:`.
- `version` in `.claude-plugin/plugin.json` is explicit semver. Users only
  receive updates when it is bumped — bump it in the release PR together
  with a `CHANGELOG.md` entry.
