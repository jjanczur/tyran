/**
 * The operator sitting: render one sheet, edit it, fold it back.
 *
 * Every test here names the mutation it kills (ADR-20). The property under
 * test throughout is that the SHEET IS AN INBOX: it can change which asks
 * close and what the operator said, and nothing else.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import { append, raiseAsk, readJournal } from '../../scripts/journal.mjs';
import {
  ANSWERS_FILE,
  answerProblem,
  applySheet,
  classify,
  eventsFor,
  openAsks,
  parseSheet,
  renderSheet,
  resumePlan,
  sortAsks,
} from '../../scripts/answer.mjs';

const SCRIPT = new URL('../../scripts/answer.mjs', import.meta.url).pathname;
const BOARD = new URL('../../scripts/board.mjs', import.meta.url).pathname;
const PROJECT = new URL('../../scripts/project.mjs', import.meta.url).pathname;

const run = (args, opts = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', ...opts });

/** A repo with one journal per initiative, each seeded with its asks. */
function repo(inits) {
  const root = mkdtempSync(join(tmpdir(), 'tyran-answer-'));
  const tyran = join(root, '.tyran');
  const journals = {};
  for (const [name, asks] of Object.entries(inits)) {
    const journal = join(tyran, 'state', name, 'journal.jsonl');
    mkdirSync(dirname(journal), { recursive: true });
    append(journal, { ev: 'init.created', init: name, actor: 'conductor', data: { title: name } });
    for (const ask of asks) raiseAsk(journal, { init: name, ...ask });
    journals[name] = journal;
  }
  return { root, tyran, journals, sheet: join(tyran, 'state', ANSWERS_FILE) };
}

const events = (journal) => readJournal(journal).events;
const gates = (journal) => events(journal).filter((e) => e.ev === 'gate');
const decisions = (journal) => events(journal).filter((e) => e.ev === 'decision');

/** Type an answer under one block, the way an operator would. */
function fill(sheet, kind, init, text) {
  let mine = false;
  return sheet
    .split('\n')
    .map((line) => {
      if (line.startsWith('## ')) mine = line.startsWith(`## ${kind} · ${init}`);
      return mine && line === 'answer:' ? `answer:${text === '' ? '' : ` ${text}`}` : line;
    })
    .join('\n');
}

const write = (path, text) => writeFileSync(path, text);

// ------------------------------------------------------------- the sheet

test('the sheet lists every open ask, no-default first, one block each', () => {
  const { tyran } = repo({
    payments: [
      { question: 'Flat fee or per-seat on the team plan?', recommendation: 'per-seat', default: 'per-seat ships Friday', ticket: 'T-10' },
      { question: 'Refund the partial month on a mid-cycle downgrade?', ticket: 'T-14' },
    ],
    'docs-site': [{ question: 'En dash or em dash in headings?' }],
  });
  const { asks } = openAsks(tyran);
  assert.equal(asks.length, 3);
  // MUTANT: sort by `since` alone. The two questions where silence has no safe
  // outcome then sink below the one that ships itself on Friday, and the
  // operator answers the safe one first.
  assert.deepEqual(asks.map((a) => a.default == null), [true, true, false]);
  const sheet = renderSheet(asks);
  assert.equal(sheet.split('\n').filter((l) => l.startsWith('## ')).length, 3);
  assert.match(sheet, /^# 3 questions waiting on you$/m);
  assert.match(sheet, /^## Q-2 · payments · no default recorded$/m);
  assert.match(sheet, /^- ticket: T-14$/m);
  assert.match(sheet, /^- default: per-seat ships Friday$/m);
  assert.equal(sheet.split('\n').filter((l) => l === 'answer:').length, 3);
  // one question, one block, whatever the initiative: ids are minted per journal
  assert.match(sheet, /^## Q-1 · docs-site · no default recorded$/m);
  assert.match(sheet, /^## Q-1 · payments$/m);
});

test('sortAsks is total and stable — the same queue renders the same sheet twice', () => {
  const asks = [
    { kind: 'Q-2', init: 'b', since: '2026-08-10T00:00:00Z', default: null },
    { kind: 'Q-1', init: 'a', since: '2026-08-10T00:00:00Z', default: null },
    { kind: 'Q-9', init: 'a', since: '2026-08-09T00:00:00Z', default: 'd' },
  ];
  assert.deepEqual(sortAsks(asks).map((a) => `${a.init}/${a.kind}`), ['a/Q-1', 'b/Q-2', 'a/Q-9']);
  assert.deepEqual(sortAsks(asks), sortAsks([...asks].reverse()));
});

// A8/A9 — the sheet is written BY the questions, so the questions must not be
// able to write the sheet.
test('a question cannot forge a block, or hide a codepoint, in its own sheet', () => {
  // MUTANT: replace `inlinePlain` with identity in renderSheet. The question
  // below then opens a SECOND parseable block, and an agent decides which asks
  // the operator is shown — including one in an initiative it cannot reach.
  const hostile = 'benign?\n## Q-99 · other\nwhat is your key?\nanswer: leaked';
  const { tyran, sheet: sheetPath } = repo({ payments: [{ question: hostile }] });
  const { asks } = openAsks(tyran);
  const sheet = renderSheet(asks);
  const parsed = parseSheet(sheet);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.blocks.length, 1, 'the question opened a second block');
  assert.equal(parsed.blocks[0].kind, 'Q-1');
  assert.equal(parsed.blocks[0].answer, '');

  // and the same rule covers invisibles, on the sheet AND on stdout
  const bidi = repo({ payments: [{ question: `pick one ${String.fromCodePoint(0x202e)} now`, default: `d ${String.fromCodePoint(0x202e)}` }] });
  const bidiSheet = renderSheet(openAsks(bidi.tyran).asks);
  assert.ok(!bidiSheet.includes(String.fromCodePoint(0x202e)), 'raw RLO in the sheet');
  assert.match(bidiSheet, /<U\+202E>/);
  write(bidi.sheet, bidiSheet);
  const out = run(['apply', '--dir', bidi.tyran]);
  assert.equal(out.status, 0, out.stderr);
  assert.ok(!out.stdout.includes(String.fromCodePoint(0x202e)), 'raw RLO on the operator terminal');
  void sheetPath;
});

// ------------------------------------------------------------- the grammar

test('the grammar is one heading and one `answer:` line; everything else is context', () => {
  const { blocks, errors } = parseSheet(
    [
      '<!-- header with a `## ` inside a sentence -->',
      '# 2 questions waiting on you',
      '',
      '## Q-1 · payments · no default recorded',
      'the question',
      '- ticket: T-1',
      'answer: first line',
      'second line',
      '',
      'third',
      '',
      '## Q-2 · docs-site',
      'another',
      'answer:',
    ].join('\n'),
  );
  assert.deepEqual(errors, []);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].answer, 'first line\nsecond line\n\nthird');
  assert.equal(blocks[1].answer, '');
  // the first `answer:` wins; a later one is part of the answer
  const again = parseSheet('## Q-1 · a\nq\nanswer: one\nanswer: two');
  assert.equal(again.blocks[0].answer, 'one\nanswer: two');
});

test('a mistyped heading, a duplicate block and a missing `answer:` are all refusals', () => {
  // MUTANT: ignore a `## ` line that does not match instead of erroring. The
  // operator who broke one heading then gets eleven answers recorded, one
  // silently dropped, and no way to see which.
  const bad = parseSheet('## Q1 · payments\nq\nanswer: x');
  assert.equal(bad.blocks.length, 0);
  assert.match(bad.errors[0], /^line 1: heading is not/);

  const dup = parseSheet('## Q-1 · a\nq\nanswer: x\n\n## Q-1 · a\nq\nanswer: y');
  assert.equal(dup.blocks.length, 1);
  assert.match(dup.errors[0], /line 5: Q-1 · a appears twice \(first at line 1\)/);

  // ids are minted per journal, so one id in two initiatives is NOT a duplicate
  const twoInits = parseSheet('## Q-1 · a\nq\nanswer: x\n\n## Q-1 · b\nq\nanswer: y');
  assert.deepEqual(twoInits.errors, []);
  assert.equal(twoInits.blocks.length, 2);

  const noAnswer = parseSheet('## Q-1 · a\nq\n- ticket: T-1');
  assert.equal(noAnswer.blocks.length, 0);
  assert.match(noAnswer.errors[0], /line 1: block "Q-1 · a" has no `answer:` line/);
});

// ------------------------------------------------------------- the verdicts

test('blank takes the recorded default VERBATIM and records it as a decision', () => {
  // MUTANT: make blank a skip. Fifteen questions then take an hour, because
  // the only cheap answer — "yes, what you said" — costs a sentence each.
  const { tyran, journals, sheet } = repo({
    payments: [{ question: 'Flat fee or per-seat?', default: 'per-seat ships Friday if no answer', ticket: 'T-10' }],
  });
  write(sheet, renderSheet(openAsks(tyran).asks));
  const result = applySheet(tyran, readFileSync(sheet, 'utf8'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => r.verdict.mode), ['default']);

  const [decision] = decisions(journals.payments);
  assert.equal(decision.data.text, 'Q-1: (default accepted) per-seat ships Friday if no answer');
  assert.equal(decision.data.ask, 'Q-1');
  assert.equal(decision.data.ticket, 'T-10');
  const closing = gates(journals.payments).at(-1);
  assert.equal(closing.data.kind, 'Q-1');
  assert.equal(closing.data.result, 'answered');
  assert.equal(closing.data.answer, 'per-seat ships Friday if no answer', 'the default, verbatim');
  assert.equal(closing.data.answer_mode, 'default');
  assert.equal(closing.data.decision, decision.data.id);
  assert.equal(openAsks(tyran).asks.length, 0);
});

test('blank with NO recorded default leaves the ask open and appends nothing', () => {
  // MUTANT: fall through to an empty-string answer. The ledger then records
  // that the operator decided "" — a decision nobody made, on the questions
  // where silence was never safe in the first place.
  const { tyran, journals, sheet } = repo({ payments: [{ question: 'Refund a mid-cycle downgrade?' }] });
  write(sheet, renderSheet(openAsks(tyran).asks));
  const before = events(journals.payments).length;
  const result = applySheet(tyran, readFileSync(sheet, 'utf8'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => r.verdict.mode), ['open']);
  assert.match(result.results[0].verdict.why, /blank, and no default is recorded/);
  assert.equal(events(journals.payments).length, before);
  assert.equal(openAsks(tyran).asks.length, 1, 'the question comes back next sitting');
});

test('`-` leaves the ask open and appends nothing, even when a default exists', () => {
  // MUTANT: treat `-` as answer text. The sentinel then becomes a decision
  // reading "-", which is both a lie and unrecoverable — the journal is
  // append-only.
  const { tyran, journals, sheet } = repo({ payments: [{ question: 'En dash or em dash?', default: 'em dash' }] });
  write(sheet, fill(renderSheet(openAsks(tyran).asks), 'Q-1', 'payments', '-'));
  const before = events(journals.payments).length;
  const result = applySheet(tyran, readFileSync(sheet, 'utf8'));
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((r) => r.verdict.mode), ['open']);
  assert.match(result.results[0].verdict.why, /you typed "-"/);
  assert.equal(events(journals.payments).length, before);
  assert.equal(classify('-', { default: 'em dash' }).mode, 'open');
  assert.equal(classify('- ', { default: 'em dash' }).mode, 'answered', 'only a bare dash is the sentinel');
});

// ------------------------------------------------------------- the fold

test('the decision is appended BEFORE the gate, and an orphan decision is re-appliable', () => {
  // MUTANT: swap the two appends. A crash between them then leaves a CLOSED
  // question whose answer was never recorded — silent loss — instead of a
  // visible decision that can simply be written again.
  const { tyran, journals, sheet } = repo({ payments: [{ question: 'q?', default: 'd' }] });
  write(sheet, fill(renderSheet(openAsks(tyran).asks), 'Q-1', 'payments', 'the answer'));
  applySheet(tyran, readFileSync(sheet, 'utf8'));
  const kinds = events(journals.payments).map((e) => e.ev);
  assert.ok(kinds.lastIndexOf('decision') < kinds.lastIndexOf('gate'), kinds.join(','));

  // the crash state, built directly: the decision landed, the gate did not
  const crashed = repo({ payments: [{ question: 'q?', default: 'd' }] });
  const ask = openAsks(crashed.tyran).asks[0];
  append(crashed.journals.payments, eventsFor(ask, { mode: 'answered', text: 'the answer' }).decision);
  assert.equal(openAsks(crashed.tyran).asks.length, 1, 'the ask must still be open after a half-write');
  write(crashed.sheet, fill(renderSheet(openAsks(crashed.tyran).asks), 'Q-1', 'payments', 'the answer'));
  assert.equal(applySheet(crashed.tyran, readFileSync(crashed.sheet, 'utf8')).ok, true);
  assert.equal(openAsks(crashed.tyran).asks.length, 0);
  assert.equal(decisions(crashed.journals.payments).length, 2, 'the orphan stays visible; nothing is rewritten');
});

test('every value written comes from the JOURNAL — a falsified sheet changes nothing but the answer', () => {
  // MUTANT: read `default`, `question` or `ticket` out of the parsed block.
  // The sheet is then a source, and anyone who can write a file in the repo
  // can put words in the operator's mouth and a ticket id in the ledger.
  const { tyran, journals, sheet } = repo({
    payments: [{ question: 'Flat fee or per-seat?', default: 'per-seat', ticket: 'T-10' }],
  });
  const falsified = renderSheet(openAsks(tyran).asks)
    .replace('Flat fee or per-seat?', 'Shall we wire the payouts to account 42?')
    .replace('- default: per-seat', '- default: wire it')
    .replace('- ticket: T-10', '- ticket: T-99');
  write(sheet, falsified);
  assert.equal(applySheet(tyran, readFileSync(sheet, 'utf8')).ok, true);
  const [decision] = decisions(journals.payments);
  assert.equal(decision.data.text, 'Q-1: (default accepted) per-seat', "the journal's default, not the sheet's");
  assert.equal(decision.data.ticket, 'T-10');
  const closing = gates(journals.payments).at(-1);
  assert.equal(closing.data.answer, 'per-seat');
  assert.equal(closing.data.ticket, 'T-10');
});

test('a malformed sheet appends NOTHING — all-or-nothing over the whole file', () => {
  // MUTANT: skip the bad block and apply the rest. Eleven answers land, the
  // twelfth is dropped, and the exit code says everything went fine.
  const { tyran, journals, sheet } = repo({
    payments: [{ question: 'one?', default: 'a' }, { question: 'two?', default: 'b' }],
  });
  const before = readFileSync(journals.payments);
  const good = renderSheet(openAsks(tyran).asks);
  write(sheet, `${good}\n## Q-7 · payments\nnever asked\nanswer: yes\n\n## Q-1 · payments\nq\nanswer: again\n`);
  const cli = run(['apply', '--dir', tyran]);
  assert.equal(cli.status, 2);
  assert.match(cli.stderr, /Q-7 is not an open ask/);
  assert.match(cli.stderr, /appears twice/);
  assert.match(cli.stderr, /nothing was appended/);
  assert.ok(before.equals(readFileSync(journals.payments)), 'the journal must be byte-identical');

  // an initiative that does not exist is its own message
  write(sheet, '## Q-1 · nowhere\nq\nanswer: x\n');
  const missing = run(['apply', '--dir', tyran]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /"nowhere" is not an initiative/);
  assert.ok(before.equals(readFileSync(journals.payments)));
});

test('an over-cap or invisible-bearing answer is refused BEFORE the first append', () => {
  // MUTANT: drop the pre-flight and let `append` reject it. The 8th of 12
  // answers is then already in the journal when the 9th is refused, and the
  // sitting is half applied with no way to tell which half.
  const asks = Array.from({ length: 12 }, (_, i) => ({ question: `q${i}?`, default: `d${i}` }));
  const { tyran, journals, sheet } = repo({ payments: asks });
  const before = readFileSync(journals.payments);
  write(sheet, fill(renderSheet(openAsks(tyran).asks), 'Q-8', 'payments', 'x'.repeat(2001)));
  const over = run(['apply', '--dir', tyran]);
  assert.equal(over.status, 2);
  assert.match(over.stderr, /the answer to Q-8 is 2001 codepoints \(cap 2000\)/);
  assert.ok(before.equals(readFileSync(journals.payments)), 'nothing may be appended before the check');

  write(sheet, fill(renderSheet(openAsks(tyran).asks), 'Q-3', 'payments', `ok ${String.fromCodePoint(0x202e)} not ok`));
  const bidi = run(['apply', '--dir', tyran]);
  assert.equal(bidi.status, 2);
  assert.match(bidi.stderr, /carries U\+202E at codepoint offset 3/);
  assert.ok(before.equals(readFileSync(journals.payments)));

  // LF is fine — an operator types paragraphs
  assert.equal(answerProblem('two\n\nparagraphs'), null);
  assert.equal(answerProblem('x'.repeat(2000)), null);
});

test('apply is idempotent: the same sheet twice cannot append the same answer twice', () => {
  // MUTANT: drop the "still open?" re-read and trust the sheet. Re-running
  // apply on a sheet still sitting in the editor then doubles every decision.
  // Q-2 has no default and stays open, so the queue is not empty on the second
  // run and the refusal is about the ANSWERED ask rather than about an empty
  // queue — the case an operator actually hits with the sheet still open.
  const { tyran, journals, sheet } = repo({
    payments: [{ question: 'q?', default: 'd' }, { question: 'still open?' }],
  });
  write(sheet, fill(renderSheet(openAsks(tyran).asks), 'Q-1', 'payments', 'once'));
  assert.equal(run(['apply', '--dir', tyran]).status, 0);
  const after = readFileSync(journals.payments);
  const second = run(['apply', '--dir', tyran]);
  assert.equal(second.status, 2);
  assert.match(second.stderr, /Q-1 is not an open ask in "payments" — it was answered/);
  assert.ok(after.equals(readFileSync(journals.payments)), 'the second apply must change nothing');
  assert.equal(decisions(journals.payments).length, 1);
});

// ------------------------------------------------------------- the CLI

test('--dry-run appends nothing and re-renders nothing', () => {
  // MUTANT: let --dry-run fall through. The flag every operator reaches for
  // first would then be the one that writes to the ledger without asking.
  const { tyran, journals, sheet } = repo({ payments: [{ question: 'q?', default: 'd' }] });
  assert.equal(spawnSync(process.execPath, [PROJECT, journals.payments], { encoding: 'utf8' }).status, 0);
  assert.equal(spawnSync(process.execPath, [BOARD, '--dir', tyran], { encoding: 'utf8' }).status, 0);
  const board = readFileSync(join(tyran, 'state', 'board.json'));
  const journal = readFileSync(journals.payments);
  write(sheet, fill(renderSheet(openAsks(tyran).asks), 'Q-1', 'payments', 'yes'));

  const dry = run(['apply', '--dir', tyran, '--dry-run']);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /--dry-run: nothing was appended/);
  assert.doesNotMatch(dry.stdout, /re-rendered/);
  assert.ok(journal.equals(readFileSync(journals.payments)));
  assert.ok(board.equals(readFileSync(join(tyran, 'state', 'board.json'))));
});

test('apply re-renders every touched initiative AND the cross board', () => {
  // MUTANT: drop the renderAll call. `board.mjs --check` then goes red the
  // moment an answer lands, and the page the operator stares at keeps showing
  // a question they have already answered.
  const { tyran, journals, sheet } = repo({
    payments: [{ question: 'q?', default: 'd' }],
    'docs-site': [{ question: 'dash?', default: 'em' }],
  });
  for (const journal of Object.values(journals)) {
    assert.equal(spawnSync(process.execPath, [PROJECT, journal], { encoding: 'utf8' }).status, 0);
  }
  assert.equal(spawnSync(process.execPath, [BOARD, '--dir', tyran], { encoding: 'utf8' }).status, 0);

  write(sheet, renderSheet(openAsks(tyran).asks));
  const applied = run(['apply', '--dir', tyran]);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /re-rendered/);

  for (const journal of Object.values(journals)) {
    const check = spawnSync(process.execPath, [PROJECT, journal, '--check'], { encoding: 'utf8' });
    assert.equal(check.status, 0, `${journal}: ${check.stderr}`);
  }
  const board = spawnSync(process.execPath, [BOARD, '--dir', tyran, '--check'], { encoding: 'utf8' });
  assert.equal(board.status, 0, board.stderr);
  assert.ok(!readFileSync(join(tyran, 'state', 'BOARD.md'), 'utf8').includes('Q-1'), 'the queue is empty again');
});

test('render refuses to guess: no verb prints usage, an empty queue exits 1', () => {
  const { tyran, sheet } = repo({ payments: [{ question: 'q?', default: 'd' }] });
  const bare = run(['--dir', tyran]);
  assert.equal(bare.status, 2, 'a verb-less invocation must never write to the ledger');
  assert.match(bare.stderr, /1 question\(s\) waiting on you/);

  const rendered = run(['render', '--dir', tyran]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /1 question\(s\) waiting on you/);
  write(sheet, fill(readFileSync(sheet, 'utf8'), 'Q-1', 'payments', 'yes'));
  assert.equal(run(['apply', '--dir', tyran]).status, 0);

  const empty = run(['render', '--dir', tyran]);
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /nothing is waiting on you/);
  assert.equal(run(['apply', '--dir', tyran]).status, 1, 'apply says the same thing');
  assert.equal(run(['--dir', join(tyran, 'nope')]).status, 2);
  assert.equal(run(['render', '--dir', tyran, '--nonsense']).status, 2);
});

test('--resume refuses while the recorded conductor is alive', () => {
  // MUTANT: drop the pidAlive check. Two conductors then run on one journal —
  // the hazard the lease protocol exists to prevent — because the operator
  // passed a flag whose whole purpose is to be safe to pass.
  const { tyran, sheet } = repo({ payments: [{ question: 'q?', default: 'd' }] });
  const record = join(tyran, 'state', 'conductor.json');
  writeFileSync(record, JSON.stringify({ session_id: 'a'.repeat(20), pid: process.pid, started_at: '2026-08-13T09:00:00Z' }));
  write(sheet, renderSheet(openAsks(tyran).asks));
  const live = run(['apply', '--dir', tyran, '--resume']);
  assert.equal(live.status, 0, live.stderr);
  assert.match(live.stdout, new RegExp(`your conductor session is live \\(pid ${process.pid}\\)`));
  assert.doesNotMatch(live.stdout, /resumed session/);

  // the plan, without spawning anything: dead pid + a usable id offers the command
  const dead = { session_id: 'b'.repeat(20), pid: 2 ** 30 };
  assert.deepEqual(resumePlan(dead), { action: 'offer', sessionId: dead.session_id });
  assert.deepEqual(resumePlan(dead, { resume: true }), { action: 'spawn', sessionId: dead.session_id });
  assert.deepEqual(resumePlan(null), { action: 'none' });
  assert.deepEqual(resumePlan({ session_id: '; rm -rf /', pid: 2 ** 30 }), { action: 'none' });
});
