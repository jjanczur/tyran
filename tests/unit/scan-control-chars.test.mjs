import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  DELIBERATELY_ALLOWED,
  FORBIDDEN,
  formatCodePoint,
  formatFinding,
  partitionTrackedFiles,
  scanPath,
  scanRepo,
  scanText,
} from '../../scripts/scan-control-chars.mjs';

const SCRIPT = new URL('../../scripts/scan-control-chars.mjs', import.meta.url).pathname;
const REPO_ROOT = new URL('../../', import.meta.url).pathname;

/**
 * EVERY forbidden character in this file is built, never typed. Writing one
 * literally would make this test file fail the very scan it is testing — which
 * has already happened once in this initiative. `cp()` is the only way a
 * forbidden codepoint may enter this file.
 */
const cp = (...codePoints) => String.fromCodePoint(...codePoints);

/** A throwaway git repo, because the scanner's file list comes from git. */
function gitRepo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-scan-'));
  const run = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  run('add', '-A');
  return dir;
}

const scan = (dir) => spawnSync(process.execPath, [SCRIPT, dir], { encoding: 'utf8' });

// --- the rule itself ------------------------------------------------------

test('LF, TAB and ordinary text are never findings', () => {
  assert.deepEqual(scanText('hello\tworld\nsecond line\n'), []);
  assert.deepEqual(scanText('emoji 😀 accents ąćęłńóśźż CJK 日本語\n'), []);
  assert.deepEqual(scanText(''), []);
});

test('the banned set is exactly the one ADR-19 specifies', () => {
  // Pinned independently of FORBIDDEN, because the range-walk test below
  // iterates that same list: deleting a range there would delete its own
  // coverage and stay green. This is the list, written out, from the ADR.
  //
  // The walk covers EVERY codepoint, astral planes included. It used to skip
  // them (`if (point === 0xffff) point = 0x10fffe;`) on the assumption that
  // nothing above the BMP was interesting — and that assumption is exactly
  // what hid the TAG block, the single most dangerous gap in the list
  // (ADR-19 correction 1). A test whose scope is an assumption cannot falsify
  // that assumption.
  const banned = [];
  for (let point = 0x00; point <= 0x10ffff; point++) {
    if (point >= 0xd800 && point <= 0xdfff) continue; // lone surrogates are not codepoints
    if (scanText(cp(point)).length > 0) banned.push(point);
  }
  const expected = [
    ...range(0x00, 0x08),
    ...range(0x0b, 0x1f),
    ...range(0x7f, 0x9f),
    0x00ad,
    0x061c,
    ...range(0x115f, 0x1160),
    0x180e,
    ...range(0x200b, 0x200f),
    ...range(0x202a, 0x202e),
    ...range(0x2060, 0x2064),
    ...range(0x2066, 0x2069),
    ...range(0x206a, 0x206f),
    0x3164,
    0xffa0,
    ...range(0xfff9, 0xfffb),
    0xfeff,
    ...range(0x1d173, 0x1d17a),
    ...range(0xe0000, 0xe007f),
    ...range(0xe0100, 0xe01ef),
  ].sort((a, b) => a - b);
  assert.deepEqual(banned, expected);
  // TAB and LF are legal text and must never join the set.
  assert.ok(!banned.includes(0x09) && !banned.includes(0x0a));
  // U+FE0F is a legal emoji presentation selector and appears 24 times in this
  // repo's README. Banning it would turn the gate red on a file nobody
  // touched, which is how gates get switched off (ADR-19). Deliberate gap,
  // documented in scan-control-chars.mjs.
  assert.ok(!banned.includes(0xfe0f) && !banned.includes(0xfe0e));
});

const range = (lo, hi) => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

test('a deliberately allowed range is never also forbidden', () => {
  // DELIBERATELY_ALLOWED documents a gap. If a later range quietly covers it,
  // the comment keeps promising a gap that no longer exists — and the next
  // reader trusts the comment over the code.
  for (const gap of DELIBERATELY_ALLOWED) {
    for (const point of [gap.lo, gap.hi]) {
      assert.equal(scanText(cp(point)).length, 0, `${formatCodePoint(point)} is documented as allowed`);
    }
  }
});

test('every forbidden range is actually caught, at both of its edges', () => {
  for (const range of FORBIDDEN) {
    for (const point of [range.lo, range.hi]) {
      const findings = scanText(`ok${cp(point)}ok`);
      assert.equal(
        findings.length,
        1,
        `${formatCodePoint(point)} (${range.what}) was not caught`,
      );
      assert.equal(findings[0].codePoint, point);
    }
  }
});

test('the characters that actually bit us are named, not just flagged', () => {
  const named = (point) => scanText(cp(point))[0];
  // The NUL that made grep return zero matches with exit 0.
  assert.equal(named(0x00).name, 'NUL');
  // The unterminated override that mirrored a generated table row.
  assert.equal(named(0x202e).name, 'RIGHT-TO-LEFT OVERRIDE');
  assert.equal(named(0x200b).name, 'ZERO WIDTH SPACE');
  assert.equal(named(0xfeff).name, 'BYTE ORDER MARK');
  // A BOM anywhere, including position 0, is a finding — not a blessed prefix.
  assert.equal(scanText(cp(0xfeff) + '# Title\n').length, 1);
});

test('the TAG block is caught, and it is measured as ONE codepoint', () => {
  // The vector, spelled out: U+E0001..U+E007E map one-to-one onto ASCII and
  // render as nothing at all. STATE.md and PROGRESS.md are read by AGENTS, and
  // the text in them arrives from subagent reports about foreign repositories,
  // so an invisible instruction in a projection is prompt injection aimed at
  // our own team — not an ugly character.
  //
  // The proof has to show WHICH unit is being measured. A TAG codepoint is a
  // surrogate PAIR in UTF-16: charCodeAt sees 0xDB40 and 0xDC01, neither of
  // which is in any forbidden range, while codePointAt sees 0xE0001. A scanner
  // walking UTF-16 units would report zero findings here and stay green.
  const tag = cp(0xe0001);
  assert.equal(tag.length, 2, 'premise: this is a surrogate pair in UTF-16');
  assert.equal(tag.charCodeAt(0), 0xdb40);
  assert.equal(tag.charCodeAt(1), 0xdc01);
  assert.equal(tag.codePointAt(0), 0xe0001);

  const findings = scanText('visible' + tag + 'text');
  assert.equal(findings.length, 1, 'the TAG codepoint was not caught');
  assert.equal(findings[0].codePoint, 0xe0001, 'a surrogate unit was reported instead of the codepoint');
  assert.equal(findings[0].byteOffset, 7, 'UTF-8 width of a TAG character is 4 bytes, and it starts after "visible"');

  // Both edges of the block, and the ASCII a TAG character stands for, because
  // "there is an invisible character here" is not a fixable finding.
  assert.equal(scanText(cp(0xe0000)).length, 1);
  assert.equal(scanText(cp(0xe007f)).length, 1);
  assert.match(formatFinding('STATE.md', scanText(cp(0xe0041))[0]), /TAG for ASCII "A"/);
});

test('CR is a finding: this repo normalizes to LF', () => {
  assert.equal(scanText('a' + cp(0x0d) + '\n').length, 1);
});

test('a finding pins down file, line, column, byte offset and codepoint', () => {
  // Line 2, after one 1-byte and one 4-byte character, so the byte offset and
  // the column MUST disagree — a scanner that conflates them fails here.
  const findings = scanText('first\n' + 'a😀' + cp(0x200b) + 'tail\n');
  assert.equal(findings.length, 1);
  const f = findings[0];
  assert.equal(f.line, 2);
  assert.equal(f.column, 3);
  assert.equal(f.byteOffset, 6 + 1 + 4);
  assert.equal(f.codePoint, 0x200b);

  const message = formatFinding('docs/example.md', f);
  assert.match(message, /docs\/example\.md/);
  assert.match(message, /:2:3/);
  assert.match(message, /byte 11/);
  assert.match(message, /U\+200B/);
});

test('formatCodePoint pads to the conventional four hex digits', () => {
  assert.equal(formatCodePoint(0x00), 'U+0000');
  assert.equal(formatCodePoint(0x202e), 'U+202E');
});

// --- the gate over a repository -------------------------------------------

test('a clean repository scans clean, and says how much it looked at', () => {
  const dir = gitRepo({
    'README.md': '# Title\n\nA paragraph with a tab\there.\n',
    'src/app.mjs': 'export const x = 1;\n',
  });
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean \(2 tracked text files\)/);
});

test('a planted character fails the gate and locates it precisely', () => {
  const dir = gitRepo({
    'README.md': '# Title\n',
    'docs/poisoned.md': 'row one\nvalue' + cp(0x202e) + 'suffix\n',
  });
  const r = scan(dir);
  assert.equal(r.status, 1, 'the gate must fail');
  assert.match(r.stderr, /docs\/poisoned\.md:2:6/);
  assert.match(r.stderr, /U\+202E RIGHT-TO-LEFT OVERRIDE/);
  assert.match(r.stderr, /byte 13/);
  // The remedy has to be in the message, or the gate becomes an obstacle.
  assert.match(r.stderr, /String\.fromCodePoint/);
});

test('an untracked poisoned file is not the gate\'s business', () => {
  const dir = gitRepo({ 'README.md': '# Title\n' });
  writeFileSync(join(dir, 'scratch.md'), 'x' + cp(0x0000) + 'y\n');
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
});

// --- the path is part of the repository too --------------------------------

test('a poisoned file NAME fails the gate, even when its contents are clean', () => {
  // The scanner read contents only. A file whose NAME carries an override was
  // waved through with a green tick — and the name is what every tool prints:
  // `git log --stat`, `ls`, a PR diff header, and the projections an agent
  // reads. A bidi override in a name mirrors the rest of the line just as well
  // as one in a table row.
  const dir = gitRepo({ ['notes' + cp(0x202e) + 'fdp.md']: '# clean contents\n' });
  const r = scan(dir);
  assert.equal(r.status, 1, 'a poisoned name must not pass');
  assert.match(r.stderr, /U\+202E RIGHT-TO-LEFT OVERRIDE/);
  assert.match(r.stderr, /in the file NAME/, 'the message must say WHERE the character is');
});

test('a poisoned name is caught even on a file that is exempt from the content scan', () => {
  // The exemption is for a file's BYTES. Its name still reaches every tool and
  // every projection, so `binary` must not buy an exemption for the path.
  const blob = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  const dir = gitRepo({
    '.gitattributes': '*.jpg binary\n',
    ['assets/logo' + cp(0x200b) + '.jpg']: blob,
  });
  const r = scan(dir);
  assert.equal(r.status, 1, 'an exempt file still has a name');
  assert.match(r.stderr, /U\+200B ZERO WIDTH SPACE/);
  assert.match(r.stderr, /in the file NAME/);
});

test('TAB and LF are legal in contents and forbidden in a path', () => {
  // The asymmetry is the point: a tab is ordinary text and a catastrophe in a
  // filename, where it makes one path print as two columns.
  assert.deepEqual(scanText('a\tb\nc'), []);
  assert.equal(scanPath('a\tb').length, 1);
  assert.equal(scanPath('a\nb').length, 1);
  assert.equal(scanPath('docs/ordinary-name.md').length, 0);

  // End to end, because a TAB in a name also stresses the parser that reads
  // `git ls-files -s -z`: the mode is separated from the path by a TAB, so a
  // parser splitting on the LAST tab would lose half the name of exactly the
  // file it is meant to report.
  const dir = gitRepo({ ['na' + cp(0x09) + 'me.md']: '# clean\n' });
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /U\+0009 TAB — control character in a path \[in the file NAME\]/);
});

test('a symlink whose TARGET carries a control character fails the gate', () => {
  // A symlink's payload IS its target string, and git tracks it as such. The
  // old scanner called readFileSync on the link, which follows it: a target
  // outside the repo got its CONTENTS scanned instead (a file we do not own),
  // and a dangling link was filed as "tracked but missing" and quietly skipped
  // — with its poisoned target never looked at.
  const dir = mkdtempSync(join(tmpdir(), 'tyran-scan-link-'));
  const run = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  };
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# Title\n');
  symlinkSync('docs/target' + cp(0x202e) + 'gpj.md', join(dir, 'link.md'));
  run('add', '-A');

  const part = partitionTrackedFiles(dir);
  assert.deepEqual(part.links.map((l) => l.file), ['link.md'], 'the symlink must be scanned as a link');
  assert.ok(!part.scan.includes('link.md'), 'a symlink must not be read as a file');
  assert.deepEqual(part.exempt.map((e) => e.file), [], 'a dangling link is not an excuse to skip it');

  const r = scan(dir);
  assert.equal(r.status, 1, 'a poisoned link target must not pass');
  assert.match(r.stderr, /link\.md/);
  assert.match(r.stderr, /U\+202E RIGHT-TO-LEFT OVERRIDE/);
  assert.match(r.stderr, /in the symlink TARGET/);
});

test('a clean symlink is counted as scanned, not as an exemption', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-scan-link-ok-'));
  const run = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.invalid');
  run('config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# Title\n');
  symlinkSync('README.md', join(dir, 'alias.md'));
  run('add', '-A');
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean \(2 tracked text files\)/, 'the link must be counted');
});

// --- binary exclusion, the way that actually works ------------------------

test('an UNDECLARED binary is refused, and declaring it resolves the refusal', () => {
  // A JPEG-ish blob. `git check-attr binary` answers "unspecified" for it —
  // as it does for the real assets/banner.jpg — so nothing marks it, and it
  // cannot be waved through on its bytes alone (that is the B1 hole).
  //
  // The full loop is the point: refused with an actionable message, then one
  // line of .gitattributes clears it. The exemption is real, and it is a
  // reviewable diff rather than a silent property of the file's contents.
  const blob = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x00, 0x01, 0x00, 0x00]);
  const dir = gitRepo({ 'README.md': '# Title\n', 'assets/blob.jpg': blob });

  const before = partitionTrackedFiles(dir);
  assert.ok(!before.scan.includes('assets/blob.jpg'), 'a binary must never be scanned as text');
  assert.deepEqual(before.refused.map((r) => r.file), ['assets/blob.jpg']);
  const red = scan(dir);
  assert.equal(red.status, 1, 'an undeclared binary must not pass silently');
  assert.match(red.stderr, /assets\/blob\.jpg binary/, 'the message must state the remedy');

  writeFileSync(join(dir, '.gitattributes'), '*.jpg binary\n');
  spawnSync('git', ['add', '-A'], { cwd: dir });

  const after = partitionTrackedFiles(dir);
  assert.deepEqual(after.refused.map((r) => r.file), []);
  assert.deepEqual(after.exempt.map((e) => e.file), ['assets/blob.jpg']);
  const green = scan(dir);
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /not scanned: assets\/blob\.jpg/);
});

test('a NUL-poisoned source file is CAUGHT, even though git calls it binary', () => {
  // The hole that nearly shipped with this gate, and the reason the binary
  // test is byte-validity rather than git's own sniffing.
  //
  // Git classifies a file as binary when it finds a NUL in the first 8000
  // bytes. So a source file poisoned with ONE stray NUL becomes "binary" the
  // moment it is damaged — and a scanner that excludes what git calls binary
  // skips it for precisely the reason it should have been flagged. This is
  // not hypothetical: tests/unit/projection-fuzz.test.mjs in this repo picked
  // up a raw NUL, git reclassified it, and the scan reported the whole tree
  // clean over a poisoned tracked file.
  const dir = gitRepo({
    'src/poisoned.mjs': 'export const sep = "' + cp(0x0000) + '";\n',
  });

  // Confirm the premise: git really does consider this file binary.
  const eol = spawnSync('git', ['ls-files', '--eol', 'src/poisoned.mjs'], { cwd: dir, encoding: 'utf8' });
  assert.match(eol.stdout, /-text/, 'premise changed: git no longer calls this binary');

  assert.ok(partitionTrackedFiles(dir).scan.includes('src/poisoned.mjs'), 'the poisoned file must stay in scope');
  const r = scan(dir);
  assert.equal(r.status, 1, 'a poisoned file must fail the gate, binary-looking or not');
  assert.match(r.stderr, /src\/poisoned\.mjs/);
  assert.match(r.stderr, /U\+0000 NUL/);
});

test('goldens are scanned: `-text` protects bytes, it does not buy an exemption', () => {
  // tests/fixtures/** is `-text` in this repo so byte-exact goldens survive
  // checkout. Those goldens are GENERATED STATE.md files — exactly where the
  // bidi bug behind ADR-19 landed. Treating `-text` as "binary" would point
  // the gate away from its own motivating case.
  const dir = gitRepo({
    '.gitattributes': 'fixtures/** -text\n',
    'fixtures/golden/STATE.md': '| Agent | Status |\n|---|---|\n| a' + cp(0x202e) + ' | ok |\n',
  });
  assert.ok(partitionTrackedFiles(dir).scan.includes('fixtures/golden/STATE.md'));
  const r = scan(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fixtures\/golden\/STATE\.md/);
});

test('an explicit `binary` attribute excludes a file whose bytes look like text', () => {
  // The other half of the rule: an author saying "this is binary" is honoured
  // even when git's content sniffing would disagree.
  const dir = gitRepo({
    '.gitattributes': 'fixtures/raw.dat binary\n',
    'README.md': '# Title\n',
    'fixtures/raw.dat': 'looks like text but holds' + cp(0x200e) + 'a mark\n',
  });
  const { scan: scanned, exempt } = partitionTrackedFiles(dir);
  assert.ok(!scanned.includes('fixtures/raw.dat'), `marked file was scanned: ${scanned.join(', ')}`);
  assert.ok(scanned.includes('README.md'), 'ordinary files must still be scanned');
  assert.deepEqual(exempt.map((e) => e.file), ['fixtures/raw.dat']);
  assert.equal(scan(dir).status, 0);
});

test('exclusion is by git, not by extension: a poisoned .jpg of real text still fails', () => {
  // The whitelist trap, inverted. A text file merely NAMED .jpg has nothing
  // marking it binary and no binary content, so it must be scanned.
  const dir = gitRepo({ 'notes.jpg': 'plain text with' + cp(0x200b) + 'a zero width space\n' });
  const r = scan(dir);
  assert.equal(r.status, 1, 'an extension must not buy an exemption');
  assert.match(r.stderr, /notes\.jpg/);
});

// --- no false positives on the repository we actually ship ----------------

// --- no file leaves the scan quietly (review blockers B1 and B2) ----------

test('one non-UTF-8 byte cannot smuggle a poisoned file out of the gate', () => {
  // B1. The first exclusion criterion (git's binary sniffing) was circular:
  // the poison itself bought the exemption. Valid-UTF-8 only weakened the
  // loop — appending ONE 0xFF byte to a poisoned README makes it undecodable
  // and the bidi override inside sails through under a green tick.
  //
  // The answer is not a fourth content test, since any content-derived
  // exemption can be manufactured by editing content. It is that leaving the
  // scan is never silent, and an UNDECLARED undecodable file is an error.
  const poisoned = 'row\nvalue' + cp(0x202e) + 'suffix\n';
  const dir = gitRepo({ 'README.md': poisoned });

  // Baseline: caught.
  assert.equal(scan(dir).status, 1);

  // Now buy the exemption with one stray byte.
  writeFileSync(join(dir, 'README.md'), Buffer.concat([Buffer.from(poisoned, 'utf8'), Buffer.from([0xff])]));
  spawnSync('git', ['add', '-A'], { cwd: dir });

  const { refused } = partitionTrackedFiles(dir);
  assert.deepEqual(refused.map((r) => r.file), ['README.md'], 'the file must not be silently dropped');

  const r = scan(dir);
  assert.equal(r.status, 1, 'a stray byte must not turn the gate green');
  assert.match(r.stderr, /README\.md/);
  assert.match(r.stderr, /not valid UTF-8 and not declared/);
  // The remedy has to be stated, or the next person just deletes the file.
  assert.match(r.stderr, /README\.md binary/);
});

test('exemptions are printed on EVERY run, including a clean one', () => {
  // B2. The `binary` escape hatch has to exist — without it an undecodable
  // asset jams CI forever. What must not exist is using it invisibly: the
  // same commit could add a poisoned file and the line that excuses it.
  const dir = gitRepo({
    '.gitattributes': 'secret.md binary\n',
    'README.md': '# Title\n',
    'secret.md': 'hidden' + cp(0x202e) + 'payload\n',
  });
  const r = scan(dir);
  assert.equal(r.status, 0, 'a declared exemption is still allowed');
  assert.match(r.stdout, /not scanned: secret\.md — declared `binary` in \.gitattributes/);
  assert.match(r.stdout, /1 file\(s\) exempt, 2 scanned/);
});

test('a gate that scanned nothing is never a pass', () => {
  // B2. `* binary` in .gitattributes silences the scanner completely. Exit 0
  // over zero files is a green tick meaning "we looked at nothing".
  const dir = gitRepo({
    '.gitattributes': '* binary\n',
    'poisoned.md': 'x' + cp(0x0000) + 'y\n',
  });
  const { scan: scanned } = partitionTrackedFiles(dir);
  assert.equal(scanned.length, 0, 'premise: everything is excused');

  const r = scan(dir);
  assert.equal(r.status, 2, 'zero scanned files must fail, not pass');
  assert.match(r.stderr, /refusing to pass — 0 files were scanned/);
});

test('the self-run guard survives an argv[1] that cannot be canonicalized', () => {
  // Third copy of the guard, third dead mutant. Duplication is a choice here,
  // so each copy carries its own proof rather than borrowing journal.mjs's.
  const base = mkdtempSync(join(tmpdir(), 'tyran-argv-'));
  const harness = join(base, 'harness.mjs');
  writeFileSync(
    harness,
    "process.argv[1] = '/nonexistent-dir-" +
      "e2s6/entry.mjs';\n" +
      `await import(${JSON.stringify(SCRIPT)});\n` +
      "console.log('SURVIVED');\n",
  );
  const r = spawnSync(process.execPath, [harness], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'SURVIVED');
});

test('THIS repository scans clean end to end', () => {
  // The canary for the whole gate: if the scanner is over-eager, or the binary
  // exclusion regresses, CI goes red on files nobody touched and someone turns
  // the gate off. That failure mode is the reason this test exists.
  const { scanned, results, exempt, refused } = scanRepo(REPO_ROOT);
  assert.deepEqual(
    results.map((r) => `${r.file}: ${formatFinding(r.file, r.findings[0])}`),
    [],
  );
  assert.deepEqual(refused.map((r) => r.file), [], 'every binary here must be declared');
  // Pinned, not a floor. A loose `scanned > 20` let the count drop 45 -> 44
  // while a file quietly left the scan. Any change to either number now has
  // to be made on purpose, in this file, where a reviewer will see it.
  // 45 -> 48: scripts/doctor.mjs, tests/unit/doctor.test.mjs, docs/doctor.md.
  assert.equal(scanned, 48, 'file count changed — confirm nothing left the scan by accident');
  assert.deepEqual(exempt.map((e) => e.file), ['assets/banner.jpg']);
});
