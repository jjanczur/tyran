/**
 * retro-gate — the retrospective stops depending on anyone remembering.
 *
 * Two properties carry the whole design and both are tested here first:
 *
 *   1. It CANNOT loop. One extra turn, ever. A gate able to hold a session
 *      open would be switched off, taking the other five with it.
 *   2. It FAILS OPEN on every uncertainty. Being unable to prove a retro is
 *      owed is not evidence that one is owed, and a false refusal on a
 *      finished initiative is far more expensive than a missed nudge.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, judgeRetro, buildReason, DEADLINE_MS, MAX_INITIATIVES_CONSIDERED } from '../../hooks/scripts/retro-gate.mjs';

const T = (n) => `2026-07-2${n}T10:00:00.000Z`;

const ev = (init, ev_, data, ts = T(1)) => ({ ts, ev: ev_, init, actor: 'conductor', data });

function closedInitiative(init = 'demo') {
  return [
    ev(init, 'ticket.created', { id: 'T-1' }, T(1)),
    ev(init, 'ticket.created', { id: 'T-2' }, T(1)),
    ev(init, 'merge', { ticket: 'T-1', sha: 'aaa' }, T(2)),
    ev(init, 'merge', { ticket: 'T-2', sha: 'bbb' }, T(3)),
  ];
}

// --- the judgement ---------------------------------------------------------

test('a fully merged initiative with no retrospective owes one', () => {
  const v = judgeRetro(closedInitiative());
  assert.equal(v.owed, true);
  assert.equal(v.init, 'demo');
  assert.equal(v.tickets, 2);
});

test('an initiative still in flight owes nothing', () => {
  const events = closedInitiative().slice(0, 3); // T-2 never merged
  assert.equal(judgeRetro(events).owed, false);
});

test('an initiative with no tickets owes nothing', () => {
  // A conversation is not a body of work worth retrospecting.
  assert.equal(judgeRetro([ev('chat', 'checkpoint', { phase: 'x', next_steps: [] })]).owed, false);
});

test('a retrospective recorded AFTER the last merge settles the debt', () => {
  const events = [...closedInitiative(), ev('demo', 'retro.entry', { kind: 'skill', target: 'run' }, T(4))];
  assert.equal(judgeRetro(events).owed, false);
});

test('a retrospective recorded BEFORE the last merge does NOT settle it', () => {
  // Anchoring on "any retro ever" would let one old retrospective silence
  // every future initiative in the repo — the exact failure that makes a
  // reminder worthless after a month.
  const events = [
    ev('demo', 'ticket.created', { id: 'T-1' }, T(1)),
    ev('demo', 'retro.entry', { kind: 'skill', target: 'run' }, T(2)),
    ev('demo', 'merge', { ticket: 'T-1', sha: 'aaa' }, T(3)),
  ];
  assert.equal(judgeRetro(events).owed, true);
});

test('a DECLINED retrospective settles the debt like any other', () => {
  // The refusal text promises this. If a recorded decision not to run one did
  // not silence the gate, the documented way out would be a lie.
  const events = [...closedInitiative(), ev('demo', 'retro.entry', { kind: 'skipped', target: 'demo' }, T(5))];
  assert.equal(judgeRetro(events).owed, false);
});

test('initiatives are independent — one closed does not speak for another', () => {
  const events = [
    ...closedInitiative('alpha'),
    ev('alpha', 'retro.entry', { kind: 'skill', target: 'run' }, T(4)),
    ...closedInitiative('beta'),
  ];
  const v = judgeRetro(events);
  assert.equal(v.owed, true);
  assert.equal(v.init, 'beta');
});

test('the most recently merged owed initiative is the one named', () => {
  const older = closedInitiative('older');
  const newer = [
    ev('newer', 'ticket.created', { id: 'T-9' }, T(5)),
    ev('newer', 'merge', { ticket: 'T-9', sha: 'ccc' }, T(6)),
  ];
  assert.equal(judgeRetro([...older, ...newer]).init, 'newer');
});

test('a flood of initiatives declines to judge rather than scanning them all', () => {
  const many = [];
  for (let i = 0; i < MAX_INITIATIVES_CONSIDERED + 5; i++) many.push(ev(`i-${i}`, 'ticket.created', { id: 'T-1' }));
  const v = judgeRetro(many);
  assert.equal(v.owed, false);
  assert.equal(v.why, 'too-many-initiatives');
});

test('malformed events are skipped, not crashed on', () => {
  const events = [null, 42, { ev: 'merge' }, { init: 'x' }, ...closedInitiative()];
  assert.equal(judgeRetro(events).owed, true);
});

// --- the gate --------------------------------------------------------------

function repoWithJournal(events, init = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-retro-'));
  mkdirSync(join(dir, '.tyran', 'state', init), { recursive: true });
  writeFileSync(join(dir, '.tyran', 'state', init, 'journal.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return dir;
}

test('the gate refuses a stop when a retrospective is owed', () => {
  const dir = repoWithJournal(closedInitiative());
  const out = apply({ cwd: dir, stop_hook_active: false });
  assert.equal(out.decision, 'deny');
  assert.match(out.reason, /tyran:retro/);
  assert.match(out.reason, /"demo"/);
});

test('stop_hook_active short-circuits BEFORE any filesystem work — it cannot loop', () => {
  const dir = repoWithJournal(closedInitiative());
  let located = 0;
  const out = apply(
    { cwd: dir, stop_hook_active: true },
    {
      locate: () => {
        located++;
        return { file: 'x' };
      },
    },
  );
  assert.deepEqual(out, { decision: 'pass' });
  assert.equal(located, 0, 'the loop guard must come first, whatever else is true');
});

test('no journal, no repo root, no state dir — all pass', () => {
  assert.deepEqual(apply({ cwd: mkdtempSync(join(tmpdir(), 'tyran-empty-')) }), { decision: 'pass' });
  assert.deepEqual(apply({}), { decision: 'pass' });
  assert.deepEqual(apply({ cwd: '/nonexistent/path/that/is/not/there' }), { decision: 'pass' });
});

test('every failure mode inside the gate FAILS OPEN', () => {
  const dir = repoWithJournal(closedInitiative());
  const boom = () => {
    throw new Error('injected');
  };
  assert.deepEqual(apply({ cwd: dir }, { locate: boom }), { decision: 'pass' }, 'locate threw');
  assert.deepEqual(apply({ cwd: dir }, { read: boom }), { decision: 'pass' }, 'read threw');
  assert.deepEqual(
    apply({ cwd: dir }, { locate: () => ({ file: null, why: 'no-initiative' }) }),
    { decision: 'pass' },
    'no journal located',
  );
});

test('a corrupt journal passes rather than nagging on a guess', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tyran-corrupt-'));
  mkdirSync(join(dir, '.tyran', 'state', 'demo'), { recursive: true });
  writeFileSync(join(dir, '.tyran', 'state', 'demo', 'journal.jsonl'), 'not json at all\n{ broken\n');
  assert.deepEqual(apply({ cwd: dir }), { decision: 'pass' });
});

test('the refusal names the way OUT, not only the obligation', () => {
  // A gate that says "do this" without saying "or record why not" is a wall.
  const reason = buildReason({ init: 'demo', tickets: 3 });
  assert.match(reason, /retro\.entry/);
  assert.match(reason, /skipped/);
  assert.match(reason, /correct outcome/);
  assert.match(reason, /not be blocked twice/);
});

test('an initiative name cannot smuggle control characters into the refusal', () => {
  const nasty = `de${String.fromCharCode(0x1b)}mo`;
  const events = [
    ev(nasty, 'ticket.created', { id: 'T-1' }),
    ev(nasty, 'merge', { ticket: 'T-1', sha: 'aaa' }, T(2)),
  ];
  const dir = repoWithJournal(events, 'demo');
  writeFileSync(
    join(dir, '.tyran', 'state', 'demo', 'journal.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );
  const out = apply({ cwd: dir });
  assert.equal(out.decision, 'deny');
  assert.ok(!out.reason.includes(String.fromCharCode(0x1b)), 'the refusal must not carry a raw control character');
});

test('the gate deadline stays under the timeout declared in hooks.json', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const registry = JSON.parse(readFileSync(fileURLToPath(new URL('../../hooks/hooks.json', import.meta.url)), 'utf8'));
  const entry = registry.hooks.Stop?.flatMap((g) => g.hooks).find((h) => h.command.includes('retro-gate'));
  assert.ok(entry, 'retro-gate must be registered on Stop');
  assert.ok(
    DEADLINE_MS < entry.timeout * 1000,
    `own deadline ${DEADLINE_MS}ms must be under the declared ${entry.timeout}s — a killed hook has its output discarded`,
  );
});
