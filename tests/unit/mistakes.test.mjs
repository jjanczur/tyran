/**
 * The mistakes ledger, and the one writer of the CLAUDE.md fence.
 *
 * Two guarantees carry this file. The first is that a COUNT is trustworthy:
 * everything downstream — a knowledge entry, a line in the operator's law —
 * is bought with a number of recorded occurrences, so a parser that miscounts
 * by one is a rule promoted on evidence that does not exist. The second is
 * that a file the OPERATOR owns is edited only between two markers, and never
 * guessed at.
 *
 * ADR-20: every guard below names the mutant it kills, in its own body.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseMistakes,
  renderEntry,
  insertEntry,
  promoteStatus,
  countSignatures,
  fenceState,
  fenceRules,
  writeRuleToFence,
  ruleLineFor,
  titleFrom,
  statusKindOf,
  MISTAKE_FIELD_MAX,
  LAW_THRESHOLD,
  FENCE_START,
  FENCE_END,
} from '../../scripts/mistakes.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/mistakes.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../../templates/MISTAKES.md', import.meta.url));
const SHIPPED = readFileSync(TEMPLATE, 'utf8');

const rootUser = typeof process.getuid === 'function' && process.getuid() === 0;

// --------------------------------------------------------------- fixtures

function repo({ seed = SHIPPED } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-mistakes-'));
  if (seed !== null) writeFileSync(join(dir, 'MISTAKES.md'), seed, 'utf8');
  return dir;
}

function cli(dir, args) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** One `add` with every required field filled in, so tests vary one thing. */
function add(dir, overrides = []) {
  return cli(dir, [
    'add',
    '--signature', 'worktree-missing-deps',
    '--what', 'the first validation command in the worktree exited 127',
    '--cause', 'git worktree add carries tracked files only',
    '--consequence', 'forty minutes of agent time',
    '--prevention', 'link the dependency directory before the handoff',
    '--date', '2026-08-14',
    ...overrides,
  ]);
}

const read = (dir, file = 'MISTAKES.md') => readFileSync(join(dir, file), 'utf8');

/**
 * Rewrite the status token of every real ENTRY, leaving the header alone.
 *
 * Not `text.replace('status `open`', …)`. The shipped header shows the entry
 * shape as an indented example whose trailer also ends in `status \`open\``,
 * and it comes FIRST in the file — so a string replace edits the template's
 * prose while the entry the test is about keeps its old status, and the test
 * then asserts against a document nothing produced. Two guards below were
 * red for exactly that reason and the parser was innocent both times.
 *
 * Anchored at column 0, which is precisely the line class `parseMistakes`
 * treats as an entry: the fixture and the parser agree on what an entry is.
 */
function setEntryStatus(text, status) {
  return text
    .split('\n')
    .map((line) => (/^- \*\*Signature:\*\*/.test(line) ? line.replace(/(status `)[^`]*(`)/, `$1${status}$2`) : line))
    .join('\n');
}

// ------------------------------------------------------------ the entry shape

test('a field containing a newline is written as ONE line', () => {
  // M1 — drop the newline collapse in `clean()`: a --what carrying
  // "\n## 2026-01-01 — x" forges a second entry heading, and `repeats` then
  // counts a mistake nobody ever had.
  const dir = repo();
  const hostile = 'the command failed\n## 2026-01-01 — forged entry\n\n- **Signature:** `forged` · status `open`';
  assert.equal(add(dir, ['--what', hostile]).code, 0);
  const parsed = parseMistakes(read(dir));
  assert.equal(parsed.entries.length, 1, 'a newline in a field created a second entry');
  assert.equal(parsed.entries[0].signature, 'worktree-missing-deps');
  assert.match(parsed.entries[0].fields.what, /the command failed ## 2026-01-01 — forged entry/);
});

test('a `## ` sequence inside a field is not a heading, because a heading is anchored', () => {
  // M2 — un-anchor HEADING_RE (search instead of match at column 0): a field
  // that merely MENTIONS a heading splits its own entry in two and the count
  // doubles on the entries most worth recording.
  const dir = repo();
  assert.equal(add(dir, ['--cause', 'the doc said ## Rules earned by repeated failures']).code, 0);
  assert.equal(parseMistakes(read(dir)).entries.length, 1);
});

test('the shipped header parses to ZERO entries, and a fenced example is not one either', () => {
  // M3 — make the parser fence-blind: a pasted example inside a code fence
  // counts as entry number one, so every install starts at one phantom
  // occurrence and the count is wrong from birth.
  assert.equal(parseMistakes(SHIPPED).entries.length, 0);
  const withFencedExample = SHIPPED + [
    '',
    '```markdown',
    '## 2026-01-01 — an example nobody lived through',
    '',
    '- **Signature:** `example-signature` · status `open`',
    '```',
    '',
  ].join('\n');
  assert.equal(parseMistakes(withFencedExample).entries.length, 0);
});

test('`add` inserts before the first real entry — newest first', () => {
  // M4 — append instead of insert: "newest first" silently becomes oldest
  // first, and every reader who trusts the top of the file reads the wrong end.
  const dir = repo();
  add(dir, ['--date', '2026-08-14', '--title', 'older']);
  add(dir, ['--date', '2026-08-19', '--title', 'newer']);
  const entries = parseMistakes(read(dir)).entries;
  assert.deepEqual(entries.map((e) => e.heading), ['2026-08-19 — newer', '2026-08-14 — older']);
});

test('`add` on a file with no entry yet lands AFTER the header', () => {
  // M5 — reuse the insert path unconditionally (splice at index 0 when there
  // is no heading): the first entry lands above the header and the seed text
  // ends up inside entry one, where the parser reads it as its fields.
  const dir = repo();
  add(dir);
  const text = read(dir);
  assert.ok(text.startsWith('# Mistakes\n'), 'the header stopped being the first thing in the file');
  assert.ok(text.indexOf('<!-- entries below, newest first -->') < text.indexOf('## 2026-08-14'));
});

test('a field over the cap is REJECTED, never truncated', () => {
  // M6 — truncate instead of rejecting: the record silently loses the half of
  // a root cause that mattered, and nothing anywhere says a cut happened.
  const dir = repo();
  const before = read(dir);
  const result = add(dir, ['--cause', 'x'.repeat(MISTAKE_FIELD_MAX + 1)]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /over the 1000 cap|codepoints, over/);
  assert.match(result.stderr, /NOT truncated/);
  assert.equal(read(dir), before, 'a rejected add still wrote to the file');
  // and exactly at the cap is accepted, so the boundary is a cap and not a fear
  assert.equal(add(dir, ['--cause', 'x'.repeat(MISTAKE_FIELD_MAX)]).code, 0);
});

test('an invisible codepoint is ESCAPED, not stripped', () => {
  // M7 — call String.replace(/\p{Cf}/gu, '') instead of escapeInvisible: a
  // poisoned entry and a clean one render identically, which is ADR-19's
  // measured failure reproduced in a file agents read.
  const dir = repo();
  const zwsp = String.fromCodePoint(0x200b);
  const bidi = String.fromCodePoint(0x202e);
  assert.equal(add(dir, ['--consequence', `cost${zwsp}${bidi}nothing`]).code, 0);
  const text = read(dir);
  assert.ok(text.includes('<U+200B>'), 'a zero-width space vanished instead of being shown');
  assert.ok(text.includes('<U+202E>'), 'a bidi override vanished instead of being shown');
  assert.ok(!text.includes(zwsp) && !text.includes(bidi));
});

test('a backtick in a trailer field is a usage error, not a broken trailer', () => {
  // M8 — accept it: the backtick closes the span early, the parser reads the
  // rest of the value as structure, and `status` can be forged from an --actor.
  const dir = repo();
  const result = add(dir, ['--actor', 'a` · status `law']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /--actor must not contain a backtick/);
});

test('an invalid signature is a usage error that names the offending value', () => {
  const dir = repo();
  for (const bad of ['Worktree Missing', 'has_underscore', 'trailing-', '', 'a'.repeat(61)]) {
    const result = add(dir, ['--signature', bad]);
    assert.equal(result.code, 2, `accepted ${JSON.stringify(bad)}`);
    assert.match(result.stderr, /is not a signature/);
  }
  assert.equal(parseMistakes(read(dir)).entries.length, 0);
});

test('the same flags produce the same bytes', () => {
  const a = repo();
  const b = repo();
  add(a);
  add(b);
  assert.equal(read(a), read(b));
});

// ------------------------------------------------------------------ counting

test('`repeats` counts only `open` at the knowledge threshold', () => {
  // M9 — count every status: a promoted signature is promoted again on every
  // retro, forever, and the knowledge store fills with duplicates of one rule.
  const dir = repo();
  for (const date of ['2026-08-14', '2026-08-19', '2026-09-02']) add(dir, ['--date', date]);
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--status', 'knowledge:K-7']).code, 0);
  const result = cli(dir, ['repeats', '--threshold', '3']);
  assert.equal(result.code, 1, 'a fully promoted signature still reached the knowledge threshold');
  assert.ok(!result.stdout.includes('promote to .tyran/knowledge/'));
});

test('`repeats` counts open PLUS promoted at the law threshold', () => {
  // M10 — count `open` only at the law threshold: a signature promoted at 3
  // can never reach 5, and law becomes unreachable by construction — the
  // opposite of the design, where reaching 5 AFTER a knowledge entry shipped
  // is the strongest argument for law there is.
  const dir = repo();
  const dates = ['2026-08-14', '2026-08-19', '2026-09-02', '2026-09-10', '2026-09-21'];
  for (const date of dates) add(dir, ['--date', date]);
  cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--status', 'knowledge:K-7']);
  const rows = countSignatures(parseMistakes(read(dir)).entries);
  assert.equal(rows[0].open, 0);
  assert.equal(rows[0].knowledge, 5);
  assert.equal(rows[0].lawCount, LAW_THRESHOLD);
  const result = cli(dir, ['repeats', '--threshold', '3']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /5 open\+promoted/);
  assert.match(result.stdout, /promote to CLAUDE\.md law/);
});

test('entries with no signature are reported in the trailing line, never dropped', () => {
  // M11 — skip them silently: the file reads as smaller than it is and nobody
  // ever learns that the one thing a script cannot do was forgotten.
  const dir = repo();
  add(dir);
  writeFileSync(
    join(dir, 'MISTAKES.md'),
    read(dir) + '\n## 2026-08-20 — an entry somebody wrote by hand\n\n- **What happened:** it broke\n',
    'utf8',
  );
  const parsed = parseMistakes(read(dir));
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.withoutSignature, 1);
  const result = cli(dir, ['repeats', '--threshold', '1']);
  assert.match(result.stdout, /1 without a signature/);
});

test('an unrecognised status is parsed and reported, never dropped', () => {
  // M12 — treat an unknown status as absent (or as `open`): a typo removes an
  // entry from the count with no trace, or adds one to it with no evidence.
  assert.equal(statusKindOf('opne'), 'unknown');
  assert.equal(statusKindOf('knowledge:K-7'), 'knowledge');
  assert.equal(statusKindOf(null), 'missing');
  const dir = repo();
  add(dir);
  writeFileSync(join(dir, 'MISTAKES.md'), setEntryStatus(read(dir), 'opne'), 'utf8');
  const parsed = parseMistakes(read(dir));
  assert.equal(parsed.unknownStatus, 1);
  assert.equal(parsed.entries[0].status, 'opne');
  const result = cli(dir, ['repeats', '--threshold', '1']);
  assert.match(result.stdout, /1 with an unrecognised status/);
});

// ----------------------------------------------------------------- promotion

test('`promote` rewrites ONLY the status token', () => {
  // M13 — re-render the trailer from the parsed parts: initiative, actor and
  // proof are normalised away on exactly the entries that mattered enough to
  // be promoted, and a hand-annotated trailer is lost.
  const dir = repo();
  add(dir, ['--initiative', 'add-billing-export', '--actor', 'impl-t3', '--proof', 'F-12']);
  const before = read(dir);
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--status', 'knowledge:K-7']).code, 0);
  const after = read(dir);
  assert.equal(after, setEntryStatus(before, 'knowledge:K-7'));
  const entry = parseMistakes(after).entries[0];
  assert.equal(entry.initiative, 'add-billing-export');
  assert.equal(entry.actor, 'impl-t3');
  assert.equal(entry.proof, 'F-12');
});

test('`promote` that matches nothing exits 1 and writes nothing', () => {
  // M14 — exit 0 on zero changes: a retrospective reports a promotion it did
  // not make, and the knowledge entry it wrote now cites evidence that never
  // moved.
  const dir = repo();
  add(dir);
  const before = read(dir);
  const result = cli(dir, ['promote', '--signature', 'never-happened', '--status', 'knowledge:K-1']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /nothing written/);
  assert.equal(read(dir), before);
});

test('`--status law` is refused: law is written by --law, in the same run as the rule', () => {
  // M15 — allow it: a trailer can then say `law` while no rule exists in any
  // CLAUDE.md, which is the one inconsistent state nothing downstream detects
  // (the status filter then refuses to ever produce the missing rule).
  const dir = repo();
  add(dir);
  const result = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--status', 'law']);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /written by --law/);
});

test('`--status wontfix` is the demotion, and reaches an entry at law', () => {
  const dir = repo();
  add(dir);
  // Same trap as the two above: without the column-0 anchor this rewrote the
  // header's example and the entry stayed `open`, so the test passed while
  // proving nothing about reaching an entry at `law`.
  writeFileSync(join(dir, 'MISTAKES.md'), setEntryStatus(read(dir), 'law'), 'utf8');
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--status', 'wontfix']).code, 0);
  assert.equal(parseMistakes(read(dir)).entries[0].status, 'wontfix');
});

test('`add` writes through a temp file and a rename, not in place', () => {
  // M16 — write in place: a crash mid-write costs the repository its whole
  // incident history, and the file that records what went wrong is the one
  // file with no second copy anywhere.
  //
  // The probe is a read-only TARGET in a writable directory: rename(2) needs
  // permission on the directory, writeFileSync needs it on the file. Only the
  // atomic path can still succeed here.
  if (rootUser) return;
  const dir = repo();
  add(dir);
  chmodSync(join(dir, 'MISTAKES.md'), 0o444);
  const result = add(dir, ['--date', '2026-08-19', '--title', 'second']);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(parseMistakes(read(dir)).entries.length, 2);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith('.tmp')), [], 'a temp file was left behind');
});

test('an absent MISTAKES.md is the opt-out: `add` refuses rather than recreating it', () => {
  // M17 — recreate it on demand: deleting the file stops being an opt-out,
  // because the next retrospective silently puts it back.
  const dir = repo({ seed: null });
  const result = add(dir);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /opt-out/);
  assert.equal(existsSync(join(dir, 'MISTAKES.md')), false);
});

// --------------------------------------------------------------- the fence

/** Five occurrences of one signature — the evidence the law step demands. */
function earnLaw(dir, signature = 'worktree-missing-deps') {
  for (const date of ['2026-08-14', '2026-08-19', '2026-09-02', '2026-09-10', '2026-09-21']) {
    add(dir, ['--signature', signature, '--date', date]);
  }
}

const RULE = 'Link the main checkout dependency directory into every new worktree before the handoff.';

test('the fence is APPENDED once, at the end, and no byte of the prose moves', () => {
  // M18 — insert the fence anywhere else, or re-render the document: the
  // operator's own CLAUDE.md is reflowed by a tool they asked for one added
  // line, and the diff they must review is the whole file.
  const dir = repo();
  earnLaw(dir);
  const prose = '# Repo\n\nSome operator prose.\n\n## A section\n\nMore prose.\n';
  writeFileSync(join(dir, 'CLAUDE.md'), prose, 'utf8');
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]).code, 0);
  const after = read(dir, 'CLAUDE.md');
  assert.ok(after.startsWith(prose.trimEnd()), 'existing prose was rewritten');
  const state = fenceState(after);
  assert.equal(state.problem, null);
  assert.equal(fenceRules(after).length, 1);
});

test('a promoted line carries the signature, the count and a pointer to the entries', () => {
  const dir = repo();
  earnLaw(dir);
  writeFileSync(join(dir, 'CLAUDE.md'), '# Repo\n', 'utf8');
  cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
  const [line] = fenceRules(read(dir, 'CLAUDE.md'));
  assert.match(line, /^- Link the main checkout/);
  assert.match(line, /`worktree-missing-deps`/);
  assert.match(line, /5 occurrences/);
  assert.match(line, /MISTAKES\.md entries 2026-08-14, 2026-08-19, 2026-09-02, 2026-09-10, 2026-09-21/);
});

test('an absent CLAUDE.md is created with the fence and nothing else', () => {
  const dir = repo();
  earnLaw(dir);
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]).code, 0);
  const text = read(dir, 'CLAUDE.md');
  assert.ok(text.startsWith('## Rules earned by repeated failures'));
  assert.equal(fenceRules(text).length, 1);
});

test('a malformed fence is REFUSED, naming the problem, with nothing written', () => {
  // M19 — guess at the intended shape (take the first start marker, or the
  // last end marker): the tool writes into prose whose structure it does not
  // understand, in the one file the operator was promised it would not touch.
  const shapes = [
    ['an end before a start', `# Repo\n\n${FENCE_END}\n${FENCE_START}\n`, /end marker comes before/],
    ['a start with no end', `# Repo\n\n${FENCE_START}\n`, /start marker with no end/],
    ['an end with no start', `# Repo\n\n${FENCE_END}\n`, /end marker with no start/],
    ['two starts', `# Repo\n\n${FENCE_START}\n${FENCE_START}\n${FENCE_END}\n`, /2 start markers/],
    ['two ends', `# Repo\n\n${FENCE_START}\n${FENCE_END}\n${FENCE_END}\n`, /2 end markers/],
  ];
  for (const [label, claude, expected] of shapes) {
    const dir = repo();
    earnLaw(dir);
    writeFileSync(join(dir, 'CLAUDE.md'), claude, 'utf8');
    const result = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
    assert.equal(result.code, 2, `${label} was not refused`);
    assert.match(result.stderr, expected, label);
    assert.equal(read(dir, 'CLAUDE.md'), claude, `${label}: CLAUDE.md was written anyway`);
    assert.equal(parseMistakes(read(dir)).entries.every((e) => e.status === 'open'), true, `${label}: statuses moved`);
  }
});

test('promoting the same signature twice does not duplicate the line', () => {
  // M20 — drop the status filter on the law step: every retrospective adds the
  // same rule again, and the operator's law grows one identical line per run.
  const dir = repo();
  earnLaw(dir);
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]).code, 0);
  const after = read(dir, 'CLAUDE.md');
  const second = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
  assert.equal(second.code, 1);
  assert.equal(read(dir, 'CLAUDE.md'), after);
  assert.equal(fenceRules(after).length, 1);
});

test('a rule the operator DELETED from the fence does not come back', () => {
  // M21 — decide re-promotion from the fence's contents instead of from the
  // entries' status: deleting a line stops being how an operator says no,
  // because the next retrospective reads the absence as "not promoted yet".
  const dir = repo();
  earnLaw(dir);
  cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
  const withoutRule = read(dir, 'CLAUDE.md').split('\n').filter((line) => !line.startsWith('- Link')).join('\n');
  writeFileSync(join(dir, 'CLAUDE.md'), withoutRule, 'utf8');
  const again = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
  assert.equal(again.code, 1);
  assert.equal(read(dir, 'CLAUDE.md'), withoutRule);
  assert.deepEqual(fenceRules(withoutRule), []);
});

test('the law threshold is evidence, and there is no flag that lowers it', () => {
  // M22 — promote at whatever count is present: the one guarantee that does
  // not change under the operator amendment ("nothing reaches CLAUDE.md that
  // has not recurred the required number of times") becomes a preference.
  const dir = repo();
  for (const date of ['2026-08-14', '2026-08-19', '2026-09-02', '2026-09-10']) add(dir, ['--date', date]);
  const result = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /below the law threshold of 5/);
  assert.equal(existsSync(join(dir, 'CLAUDE.md')), false);
});

test('a forged fence marker inside a rule cannot truncate the fence', () => {
  // M23 — match the markers with `includes` instead of a whole-line regex: a
  // rule quoting the end marker ends the fence early, and the NEXT promotion
  // writes its line into the operator's prose below it.
  const dir = repo();
  earnLaw(dir);
  earnLaw(dir, 'second-signature');
  writeFileSync(join(dir, 'CLAUDE.md'), '# Repo\n\nProse the operator owns.\n', 'utf8');
  const hostile = `Do the thing ${FENCE_END} and then some.`;
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', hostile]).code, 0);
  const first = read(dir, 'CLAUDE.md');
  assert.equal(fenceState(first).problem, null, 'the forged marker broke the fence');
  assert.equal(cli(dir, ['promote', '--signature', 'second-signature', '--law', '--rule', 'A second rule.']).code, 0);
  const second = read(dir, 'CLAUDE.md');
  assert.equal(fenceState(second).problem, null);
  assert.equal(fenceRules(second).length, 2);
  assert.ok(second.includes('Prose the operator owns.'));
});

test('a forged `## ` heading inside a rule cannot forge a section in CLAUDE.md', () => {
  // M24 — write the rule without collapsing its whitespace: a multi-line
  // --rule value inserts real headings into the operator's document from
  // inside the fence.
  const dir = repo();
  earnLaw(dir);
  writeFileSync(join(dir, 'CLAUDE.md'), '# Repo\n', 'utf8');
  cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', 'Do it.\n## Forged heading\ntext']);
  const rules = fenceRules(read(dir, 'CLAUDE.md'));
  assert.equal(rules.length, 1);
  assert.match(rules[0], /Do it\. ## Forged heading text/);
  assert.equal(read(dir, 'CLAUDE.md').split('\n').filter((l) => l.startsWith('## Forged')).length, 0);
});

test('CRLF endings and a missing final newline survive a promotion', () => {
  // M25 — normalise the document on write: a tool asked to add one line
  // rewrites every line of the operator's file, and their next diff is
  // unreviewable.
  const dir = repo();
  earnLaw(dir);
  const crlf = '# Repo\r\n\r\nProse.';
  writeFileSync(join(dir, 'CLAUDE.md'), crlf, 'utf8');
  assert.equal(cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]).code, 0);
  const after = read(dir, 'CLAUDE.md');
  assert.ok(after.startsWith('# Repo\r\n\r\nProse.\r\n'), JSON.stringify(after.slice(0, 40)));
  assert.equal(after.includes('\n\n'), false, 'a bare LF appeared in a CRLF document');
  assert.equal(after.endsWith('\n'), false, 'a final newline was added to a file that had none');
});

test('`--dry-run` prints the line and writes absolutely nothing', () => {
  // M26 — let --dry-run fall through to the writes: the flag that exists so a
  // cautious operator can inspect the loop's judgement becomes the loop acting.
  const dir = repo();
  earnLaw(dir);
  writeFileSync(join(dir, 'CLAUDE.md'), '# Repo\n', 'utf8');
  const before = read(dir);
  const result = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE, '--dry-run']);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^- Link the main checkout.*5 occurrences/m);
  assert.equal(read(dir, 'CLAUDE.md'), '# Repo\n');
  assert.equal(read(dir), before);
});

test('the promotion is recorded as a `decision` event when a journal is named', () => {
  // M27 — drop the journal append: an autonomous edit of the operator's law
  // leaves no record anywhere, and the board's ledger — the place they were
  // told to look — never mentions it.
  const dir = repo();
  earnLaw(dir);
  const journal = join(dir, 'state', 'demo', 'journal.jsonl');
  mkdirSync(join(dir, 'state', 'demo'), { recursive: true });
  writeFileSync(journal, '', 'utf8');
  const result = cli(dir, [
    'promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE,
    '--journal', journal, '--init', 'demo',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const events = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].ev, 'decision');
  assert.equal(events[0].data.signature, 'worktree-missing-deps');
  assert.equal(events[0].data.occurrences, 5);
  assert.match(events[0].data.text, /promoted a rule into CLAUDE\.md/);
});

test('a promotion with no journal says so rather than passing quietly', () => {
  const dir = repo();
  earnLaw(dir);
  const result = cli(dir, ['promote', '--signature', 'worktree-missing-deps', '--law', '--rule', RULE]);
  assert.equal(result.code, 0);
  assert.match(result.stderr, /no initiative's record/);
});

// ------------------------------------------------------------ pure helpers

test('the exported helpers are pure and composable', () => {
  const rendered = renderEntry({
    date: '2026-08-14',
    title: 'a title',
    what: 'w',
    cause: 'c',
    consequence: 'q',
    prevention: 'p',
    signature: 'sig',
  });
  assert.match(rendered, /^## 2026-08-14 — a title\n\n- \*\*What happened:\*\* w\n/);
  assert.match(rendered, /status `open`$/);

  const inserted = insertEntry('# Head\n', rendered);
  assert.equal(parseMistakes(inserted).entries.length, 1);

  const { text, changed } = promoteStatus(inserted, 'sig', 'wontfix', ['open']);
  assert.equal(changed, 1);
  assert.equal(parseMistakes(text).entries[0].status, 'wontfix');

  assert.equal(titleFrom('One sentence. A second one.'), 'One sentence.');
  assert.equal(Array.from(titleFrom('x'.repeat(200))).length, 100);

  assert.equal(
    ruleLineFor({ rule: 'Do it.', signature: 'sig', count: 5, dates: ['2026-01-01'] }),
    '- Do it. (`sig`, 5 occurrences — MISTAKES.md entries 2026-01-01)',
  );

  const created = writeRuleToFence('', '- rule');
  assert.deepEqual(fenceRules(created), ['- rule']);
  assert.ok(created.includes(FENCE_START) && created.includes(FENCE_END));
});
