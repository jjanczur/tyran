/**
 * Tests for the PreCompact gate.
 *
 * Two things are being proved, and the second one is the one that kills gates:
 * the DECISION (write the checkpoint, pass; refuse only where refusing is
 * better than passing) and the SHAPE (top-level `decision` + `reason`, because
 * PreCompact has no `hookSpecificOutput` variant and emitting one discards the
 * whole output — turning a refusal into an approval).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEADLINE_MS, checkpointEvent, decide, isManual } from '../../hooks/scripts/pre-compact.mjs';
import { PASS } from '../../hooks/scripts/hook-io.mjs';
import { EVENT_TYPES, validateEvent } from '../../scripts/journal.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'hooks', 'scripts', 'pre-compact.mjs');
const HOOKS_JSON = join(REPO_ROOT, 'hooks', 'hooks.json');

function tyranRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-pre-compact-'));
  mkdirSync(join(dir, '.tyran', 'state', 'demo'), { recursive: true });
  return dir;
}

const found = (file, init = 'demo') => ({ file, init });
const throwing = () => {
  throw new Error('EACCES: permission denied');
};

// --------------------------------------------------------- the decision

test('the normal path WRITES a checkpoint and passes — persist, do not forbid', () => {
  const written = [];
  const verdict = decide(
    { trigger: 'manual', cwd: '/x' },
    { locate: () => found('/x/.tyran/state/demo/journal.jsonl'), write: (f, e) => written.push([f, e]) },
  );
  assert.equal(verdict, PASS);
  assert.equal(written.length, 1);
  assert.equal(written[0][1].ev, 'checkpoint');
});

test('an AUTOMATIC compaction is NEVER refused, even when the checkpoint fails', () => {
  // The argument, as a test: an auto compaction fires because the context is
  // full. Refusing it does not buy time to save state — it removes the only
  // mechanism that lets the session continue, and the user's way out is to
  // uninstall the plugin.
  const notes = [];
  const verdict = decide(
    { trigger: 'auto', cwd: '/x' },
    { locate: () => found('/x/j.jsonl'), write: throwing, warn: (t) => notes.push(t) },
  );
  assert.equal(verdict, PASS);
  // Passing must not be silent, or the operator believes state was saved.
  assert.equal(notes.length, 1);
  assert.match(notes[0], /could not write a checkpoint/);
  assert.match(notes[0], /EACCES/);
});

test('a MANUAL compaction whose checkpoint failed IS refused, with a reachable remedy', () => {
  const verdict = decide(
    { trigger: 'manual', cwd: '/x' },
    { locate: () => found('/x/j.jsonl'), write: throwing },
  );
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /EACCES/);
  assert.match(verdict.reason, /journal\.mjs validate/);
  // It must explain why the asymmetry exists, or it reads as inconsistency.
  assert.match(verdict.reason, /AUTOMATIC compaction is never refused/);
});

test('an unknown or absent trigger is treated as AUTOMATIC — the direction that cannot wedge', () => {
  assert.equal(isManual('manual'), true);
  assert.equal(isManual('auto'), false);
  assert.equal(isManual(undefined), false);
  assert.equal(isManual('MANUAL'), false);
  for (const trigger of [undefined, 'something-new']) {
    const verdict = decide({ trigger, cwd: '/x' }, { locate: () => found('/x/j.jsonl'), write: throwing });
    assert.equal(verdict, PASS, `trigger=${trigger} must not block`);
  }
});

test('no journal to write to means silence, not a refusal', () => {
  // A gate that fires in repositories it has no business in is a gate that
  // gets switched off before it ever matters.
  for (const why of ['no-repo-root', 'no-state-dir', 'no-initiative', 'journal-too-large']) {
    assert.equal(decide({ trigger: 'manual' }, { locate: () => ({ file: null, why }), write: throwing }), PASS, why);
  }
});

// ------------------------------------------------------------- the event

test('the checkpoint is a member of the CLOSED event set and validates', () => {
  // No new event type is invented here. Inventing one would be an escalation,
  // not a decision a hook gets to make.
  const event = checkpointEvent('demo', 'manual', null);
  assert.ok(EVENT_TYPES.includes(event.ev));
  assert.deepEqual(validateEvent({ ...event, ts: '2026-07-27T10:00:00.000Z' }), []);
});

test('foreign text reaching the journal is bounded and escaped at the source', () => {
  // `custom_instructions` is free text a USER typed into /compact, and the
  // trigger comes from the platform. Both are foreign text on their way into
  // our own state file.
  const cp = (...p) => String.fromCodePoint(...p);
  const event = checkpointEvent('demo', 'manual', 'do the thing' + cp(0x202e) + 'evil');
  assert.doesNotMatch(event.data.custom_instructions, new RegExp(cp(0x202e)));
  assert.match(event.data.custom_instructions, /U\+202E/);
  const long = checkpointEvent('demo', 'manual', 'x'.repeat(5000));
  assert.ok(long.data.custom_instructions.length < 5000, 'bounded, not copied whole');
});

test('an absent custom_instructions does not add an empty key', () => {
  assert.ok(!('custom_instructions' in checkpointEvent('demo', 'auto', null).data));
  assert.ok(!('custom_instructions' in checkpointEvent('demo', 'auto', '').data));
});

// ------------------------------------------------- the shape on the wire

function runScript(input, extraEnv = {}) {
  return execFileSync(process.execPath, [SCRIPT], {
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
}

test('end to end: a refusal uses TOP-LEVEL decision, never hookSpecificOutput', () => {
  // The measured killer (K-1): the output union is keyed on hookEventName and
  // has NO member for PreCompact. A hookSpecificOutput here fails the schema,
  // the whole output is discarded, and the refusal silently becomes approval.
  const dir = tyranRepo();
  // A REAL write failure, with nothing stubbed. A journal.jsonl that is a
  // directory does not work here and the reason is worth recording:
  // `locateJournal` skips any candidate that is not a file, so the gate finds
  // no target at all and correctly passes. The failure has to happen at the
  // WRITE, so the file is real and its directory is not writable — which is
  // where `append` takes its lock.
  const initDir = join(dir, '.tyran', 'state', 'demo');
  writeFileSync(join(initDir, 'journal.jsonl'), '');
  chmodSync(initDir, 0o500);
  let out;
  try {
    out = runScript(
      JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null, cwd: dir }),
    );
  } finally {
    chmodSync(initDir, 0o700);
  }
  const parsed = JSON.parse(out);
  assert.equal(parsed.decision, 'block');
  assert.equal(typeof parsed.reason, 'string');
  assert.equal(parsed.hookSpecificOutput, undefined, 'a hookSpecificOutput here would discard the whole output');
});

test('end to end: the happy path writes a real checkpoint and answers with silence', () => {
  const dir = tyranRepo();
  const out = runScript(
    JSON.stringify({ hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: null, cwd: dir }),
  );
  assert.deepEqual(JSON.parse(out), {});
  const journal = readFileSync(join(dir, '.tyran', 'state', 'demo', 'journal.jsonl'), 'utf8').trim();
  const event = JSON.parse(journal);
  assert.equal(event.ev, 'checkpoint');
  assert.equal(event.data.trigger, 'auto');
  assert.equal(event.actor, 'pre-compact-hook');
});

test('end to end: garbage on stdin refuses in the shape this event accepts', () => {
  for (const raw of ['', 'not json', '[1,2,3]']) {
    const parsed = JSON.parse(runScript(raw));
    assert.equal(parsed.decision, 'block', `raw=${JSON.stringify(raw)}`);
    assert.equal(parsed.hookSpecificOutput, undefined);
  }
});

// ------------------------------------------------------- the registration

test('the registration matches the CLOSED trigger set and leaves the gate room to answer', () => {
  const doc = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const group = doc.hooks.PreCompact.find((g) => g.hooks.some((h) => h.command.includes('pre-compact.mjs')));
  assert.ok(group, 'registered for PreCompact');
  // `trigger` is h.enum(["manual","auto"]) — the matcher must cover both, or
  // one kind of compaction silently skips the checkpoint.
  assert.deepEqual(group.matcher.split('|').sort(), ['auto', 'manual']);
  assert.match(group.matcher, /^[a-zA-Z0-9_|]+$/, 'stays in the equality branch');

  const hook = group.hooks.find((h) => h.command.includes('pre-compact.mjs'));
  assert.match(hook.command, /^"\$\{CLAUDE_PLUGIN_ROOT\}/);
  // The platform kills at `timeout` and then does not read stdout at all, so
  // the gate's own deadline has to be strictly shorter or it can only be killed.
  assert.ok(hook.timeout * 1000 > DEADLINE_MS, `${hook.timeout}s must exceed ${DEADLINE_MS}ms`);
});

test('lock CONTENTION and journal DAMAGE get opposite advice (mutant M36)', () => {
  // Round 2. The advice was corrected and nothing pinned it, so a mutant that
  // reverted the diagnosis survived — the fix was in the code and the test was
  // next to it, not on it.
  //
  // The two cases need opposite remedies and the wrong one is actively false:
  // under contention the journal is HEALTHY and the answer is to retry, so
  // "validate the journal" sends the user to repair a file that is fine. A
  // refusal with no reachable way forward is the ADR-19 failure.
  const contended = decide(
    { trigger: 'manual', cwd: '/x' },
    {
      locate: () => found('/x/j.jsonl'),
      write: () => { throw new Error('journal lock timeout (held by a live writer?): /x/j.jsonl.lock'); },
    },
  );
  assert.equal(contended.decision, 'deny', 'state would still be lost, so it still refuses');
  assert.match(contended.reason, /HEALTHY/);
  assert.match(contended.reason, /Wait a moment/);
  assert.doesNotMatch(contended.reason, /journal\.mjs validate/);

  // Damage keeps the repair advice.
  const damaged = decide(
    { trigger: 'manual', cwd: '/x' },
    { locate: () => found('/x/j.jsonl'), write: throwing },
  );
  assert.match(damaged.reason, /journal\.mjs validate/);
  assert.doesNotMatch(damaged.reason, /Wait a moment/);
});
