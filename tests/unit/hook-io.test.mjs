/**
 * Tests for the hook runtime.
 *
 * The interesting half of this file is not the happy path — it is the set of
 * tests that deliberately BREAK the runtime and assert that the result is a
 * refusal rather than silence (ADR-22 point 4). The platform fails open, so
 * every one of these, if it regressed, would turn a gate into a no-op that
 * still looks installed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { scanText } from '../../scripts/scan-control-chars.mjs';
import {
  EVENTS,
  GateOnProbeEventError,
  OUTPUT_LIMIT,
  PASS,
  canBlock,
  clampPayload,
  contextPayload,
  field,
  parseHookInput,
  readStdin,
  refusalPayload,
  resolveEvent,
  runGate,
  runProbe,
  sanitizeForOutput,
  writeFully,
} from '../../hooks/scripts/hook-io.mjs';

/** A recording stand-in for stdin/stdout/stderr/exit. */
function fakeIo(stdinText) {
  const out = [];
  const err = [];
  const codes = [];
  const exitHandlers = [];
  return {
    stdin:
      stdinText === null
        ? null
        : (async function* () {
            yield Buffer.from(stdinText, 'utf8');
          })(),
    write: (t) => out.push(t),
    warn: (t) => err.push(t),
    exit: (c) => codes.push(c),
    onExit: (cb) => {
      exitHandlers.push(cb);
      return () => {
        const i = exitHandlers.indexOf(cb);
        if (i >= 0) exitHandlers.splice(i, 1);
      };
    },
    out,
    err,
    codes,
    exitHandlers,
  };
}

const inputFor = (event, extra = {}) =>
  JSON.stringify({ hook_event_name: event, session_id: 's', cwd: '/tmp', ...extra });

function soleOutput(io) {
  assert.equal(io.out.length, 1, `expected exactly one write, got ${io.out.length}`);
  return JSON.parse(io.out[0]);
}

// ------------------------------------------------------- shapes per event

test('PreToolUse refuses through hookSpecificOutput.permissionDecision, byte for byte', () => {
  assert.deepEqual(refusalPayload('PreToolUse', 'because'), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: 'because',
    },
  });
});

test('Stop/SubagentStop/PreCompact/TaskCompleted refuse through TOP-LEVEL decision', () => {
  for (const event of ['Stop', 'SubagentStop', 'PreCompact', 'TaskCompleted', 'UserPromptSubmit']) {
    assert.deepEqual(refusalPayload(event, 'because'), { decision: 'block', reason: 'because' });
  }
});

test('the decision-shaped events never emit hookSpecificOutput', () => {
  // Measured in v2.1.116: hookSpecificOutput is a union discriminated on
  // hookEventName and it has NO variant for Stop, SubagentStop, PreCompact
  // or TaskCompleted. A hookSpecificOutput there fails the platform's schema,
  // the whole output is discarded, and the refusal silently becomes an
  // approval. This is the difference between two shapes and one shape.
  for (const event of ['Stop', 'SubagentStop', 'PreCompact', 'TaskCompleted']) {
    assert.ok(
      !('hookSpecificOutput' in refusalPayload(event, 'x')),
      `${event} must not carry hookSpecificOutput`,
    );
  }
});

test('every refusal payload serializes to valid JSON and names its own event', () => {
  for (const [event, meta] of Object.entries(EVENTS)) {
    if (!meta.canBlock) continue;
    const payload = refusalPayload(event, 'r');
    const round = JSON.parse(JSON.stringify(payload));
    if (round.hookSpecificOutput) {
      assert.equal(
        round.hookSpecificOutput.hookEventName,
        event,
        'the platform throws when hookEventName differs from the event it fired, and that throw fails open',
      );
    }
  }
});

test('context payloads exist only where the platform accepts them', () => {
  assert.deepEqual(contextPayload('SessionStart', 'hi'), {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'hi' },
  });
  // Stop has no additionalContext variant; emitting one invalidates the output.
  assert.deepEqual(contextPayload('Stop', 'hi'), {});
});

// ------------------------------------------- gate vs probe is in the type

test('registering a gate on an event that cannot refuse is an error, not a silent allow', async () => {
  const probes = Object.entries(EVENTS)
    .filter(([, m]) => !m.canBlock)
    .map(([name]) => name);
  assert.deepEqual(probes.sort(), [
    'Notification',
    'PostToolUse',
    'SessionEnd',
    'SessionStart',
    'SubagentStart',
  ]);
  for (const event of probes) {
    await assert.rejects(
      () => runGate({ event, handler: () => PASS, deadlineMs: 100, io: fakeIo('{}') }),
      GateOnProbeEventError,
      `${event} must not be registrable as a gate`,
    );
  }
});

test('an unknown event is refused as a registration, not answered', async () => {
  await assert.rejects(
    () => runGate({ event: 'NoSuchEvent', handler: () => PASS, deadlineMs: 100, io: fakeIo('{}') }),
    GateOnProbeEventError,
  );
});

test('TaskCompleted is marked as firing only in team mode', () => {
  // Measured in v2.1.116: the event is raised for the in-progress tasks of
  // the current teammate. In subagent mode it never fires, so a check placed
  // only there is an ABSENT control — the same class as a matcher that
  // silently matches nothing. It stays in the table because it can refuse
  // when it does fire; the caveat has to live in the type, not in a comment.
  assert.equal(EVENTS.TaskCompleted.canBlock, true);
  assert.equal(EVENTS.TaskCompleted.teamModeOnly, true);
  for (const event of ['PreToolUse', 'SubagentStop', 'Stop', 'PreCompact', 'UserPromptSubmit']) {
    assert.notEqual(
      EVENTS[event].teamModeOnly,
      true,
      `${event} must not be marked team-only; a gate needs somewhere that always fires`,
    );
  }
});

test('canBlock agrees with the ADR-22 table', () => {
  for (const event of ['PreToolUse', 'SubagentStop', 'Stop', 'PreCompact', 'TaskCompleted', 'UserPromptSubmit']) {
    assert.equal(canBlock(event), true, `${event} must be usable as a gate`);
  }
  for (const event of ['SessionStart', 'SubagentStart', 'PostToolUse', 'SessionEnd', 'Notification']) {
    assert.equal(canBlock(event), false, `${event} must not be usable as a gate`);
  }
});

// --------------------------------------------------- ADR-22: failure modes

test('failure mode: the handler throws -> refusal naming the error class', async () => {
  const io = fakeIo(inputFor('PreToolUse'));
  await runGate({
    event: 'PreToolUse',
    deadlineMs: 1000,
    io,
    handler: () => {
      throw new TypeError('cannot read properties of undefined');
    },
  });
  const payload = soleOutput(io);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /error class: TypeError/);
  assert.deepEqual(io.codes, [0], 'a gate must exit 0; any other code is discarded as a hook error');
});

test('failure mode: a missing dependency -> refusal, not a crash', async () => {
  const io = fakeIo(inputFor('SubagentStop'));
  await runGate({
    event: 'SubagentStop',
    deadlineMs: 1000,
    io,
    handler: async () => {
      await import('node:this-module-does-not-exist');
      return PASS;
    },
  });
  const payload = soleOutput(io);
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /error class: Error|ERR_/);
  assert.deepEqual(io.codes, [0]);
});

test('failure mode: the deadline passes -> the gate refuses on its own terms', async () => {
  const io = fakeIo(inputFor('PreToolUse'));
  await runGate({
    event: 'PreToolUse',
    deadlineMs: 15,
    io,
    handler: () => new Promise(() => {}), // never settles
  });
  const payload = soleOutput(io);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /deadline-exceeded/);
});

test('failure mode: a late handler cannot overwrite the deadline refusal', async () => {
  const io = fakeIo(inputFor('PreToolUse'));
  await runGate({
    event: 'PreToolUse',
    deadlineMs: 10,
    io,
    handler: () => new Promise((r) => setTimeout(() => r(PASS), 60)),
  });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(io.out.length, 1, 'two writes would make the platform read the second decision');
  assert.match(io.out[0], /deadline-exceeded/);
});

test('failure mode: malformed JSON on stdin -> refusal', async () => {
  const io = fakeIo('{"hook_event_name": "PreToolUse", ');
  await runGate({ event: 'PreToolUse', deadlineMs: 500, io, handler: () => PASS });
  assert.match(soleOutput(io).hookSpecificOutput.permissionDecisionReason, /malformed-json/);
});

test('failure mode: empty stdin -> refusal', async () => {
  const io = fakeIo('');
  await runGate({ event: 'Stop', deadlineMs: 500, io, handler: () => PASS });
  assert.match(soleOutput(io).reason, /empty-input/);
});

test('failure mode: stdin that is not an object -> refusal', async () => {
  for (const raw of ['[1,2,3]', '42', '"hello"', 'null']) {
    const io = fakeIo(raw);
    await runGate({ event: 'Stop', deadlineMs: 500, io, handler: () => PASS });
    assert.match(soleOutput(io).reason, /not-an-object|empty-input/, `raw=${raw}`);
  }
});

test('failure mode: oversized stdin is refused rather than buffered', async () => {
  const io = {
    ...fakeIo('{}'),
    stdin: (async function* () {
      for (let i = 0; i < 40; i++) yield Buffer.alloc(64 * 1024, 0x61);
    })(),
  };
  const out = [];
  const codes = [];
  io.write = (t) => out.push(t);
  io.exit = (c) => codes.push(c);
  await runGate({ event: 'PreToolUse', deadlineMs: 2000, io, handler: () => PASS });
  assert.equal(out.length, 1);
  assert.match(JSON.parse(out[0]).hookSpecificOutput.permissionDecisionReason, /input-too-large/);
});

test('failure mode: the handler returns something unrecognised -> refusal', async () => {
  for (const verdict of [undefined, null, 'allow', 42, { decision: 'allow' }, {}]) {
    const io = fakeIo(inputFor('PreToolUse'));
    await runGate({ event: 'PreToolUse', deadlineMs: 500, io, handler: () => verdict });
    const payload = soleOutput(io);
    assert.equal(
      payload.hookSpecificOutput.permissionDecision,
      'deny',
      `a handler returning ${JSON.stringify(verdict)} must not mean approval`,
    );
  }
});

test('failure mode: the platform fired a different event than we registered for', async () => {
  const io = fakeIo(inputFor('SubagentStop'));
  await runGate({ event: 'PreToolUse', deadlineMs: 500, io, handler: () => PASS });
  const payload = soleOutput(io);
  // Answered in the shape of the event that actually fired, because the
  // platform validates hookEventName against ITS event, not against ours.
  assert.equal(payload.decision, 'block');
  assert.match(payload.reason, /event-mismatch/);
});

test('failure mode: the process ends before a verdict -> refusal, not empty stdout', async () => {
  // The shape of a real regression: the deadline timer used to be unref'd,
  // so a handler awaiting something that did not hold the event loop let
  // Node exit cleanly with empty stdout — which the platform reads as
  // "the hook is fine, proceed".
  const io = fakeIo(inputFor('PreToolUse'));
  const pending = runGate({
    event: 'PreToolUse',
    deadlineMs: 50,
    io,
    handler: () => new Promise(() => {}),
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(io.exitHandlers.length, 1, 'the gate must arm a silent-exit guard');
  io.exitHandlers[0]();
  const payload = soleOutput(io);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /exited-without-decision/);
  await pending; // lets the deadline fire and clear its timer
  assert.equal(io.out.length, 1, 'the deadline must not write a second decision after the guard');
});

test('MUST-PASS 1: synchronous work past the deadline must refuse, not approve', async () => {
  // Review round 2, blocker 1. A timer callback is a MACROtask; a handler
  // that returns after blocking the thread resolves its promise in a
  // MICROtask, so `emit(PASS)` wins the race and the deadline callback finds
  // the decision already made. The gate overran its budget fifteenfold and
  // approved. Whatever the deadline promises, it cannot promise less than
  // "a verdict produced after the budget is not a verdict".
  const io = fakeIo(inputFor('PreToolUse'));
  await runGate({
    event: 'PreToolUse',
    deadlineMs: 20,
    io,
    handler: () => {
      const t = Date.now();
      while (Date.now() - t < 300) {
        /* CPU-bound, yields nothing */
      }
      return PASS;
    },
  });
  const payload = soleOutput(io);
  assert.equal(payload.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(payload.hookSpecificOutput.permissionDecisionReason, /deadline-exceeded/);
});

test('MUST-PASS 2: a failed stdout write must end loudly, not with a silent exit 0', async () => {
  // Review round 2, blocker 2. `done = true` used to be set BEFORE the write.
  // A throwing write then left the catch clause calling a refusal that
  // returned immediately, the exit guard likewise — and the process ended
  // with exit 0, no stdout and no stderr. That is the quietest possible
  // approval, produced by the ordering of two statements.
  const io = fakeIo(inputFor('PreToolUse'));
  io.write = () => {
    throw Object.assign(new Error('EBADF: bad file descriptor, write'), { code: 'EBADF' });
  };
  await runGate({
    event: 'PreToolUse',
    deadlineMs: 500,
    io,
    handler: () => ({ decision: 'deny', reason: 'secret in the command' }),
  });
  assert.deepEqual(io.codes, [2], 'exit 2 is the only ending left that still blocks');
  assert.match(io.err.join(''), /secret in the command/, 'stderr becomes the blocking reason');
});

test('a gate never exits non-zero: only exit 0 carries a decision', async () => {
  const cases = ['', 'not json', '[]', inputFor('PreToolUse')];
  for (const raw of cases) {
    const io = fakeIo(raw);
    await runGate({
      event: 'PreToolUse',
      deadlineMs: 500,
      io,
      handler: () => {
        throw new Error('boom');
      },
    });
    assert.deepEqual(io.codes, [0], `raw=${JSON.stringify(raw)}`);
  }
});

// ------------------------------------------------------------ pass is not allow

test('no objection is silence, never permissionDecision:"allow"', async () => {
  const io = fakeIo(inputFor('PreToolUse'));
  await runGate({ event: 'PreToolUse', deadlineMs: 500, io, handler: () => PASS });
  assert.deepEqual(soleOutput(io), {});
});

test('nothing this runtime can emit ever auto-approves a tool call', async () => {
  // `allow` is not "the gate is satisfied", it is "skip the permission
  // prompt". A secrets gate that emitted it would be silently approving
  // every command it did not object to.
  const seen = [];
  for (const verdict of [PASS, { decision: 'pass' }, { decision: 'deny', reason: 'no' }]) {
    const io = fakeIo(inputFor('PreToolUse'));
    await runGate({ event: 'PreToolUse', deadlineMs: 500, io, handler: () => verdict });
    seen.push(io.out[0]);
  }
  for (const raw of seen) assert.doesNotMatch(raw, /"allow"/);
});

test('the deadline discards a LATE verdict, whichever way the handler was late', async () => {
  // The async twin of MUST-PASS 1: a handler that yields but finishes past
  // the budget must not have its answer used either.
  const io = fakeIo(inputFor('SubagentStop'));
  await runGate({
    event: 'SubagentStop',
    deadlineMs: 25,
    io,
    handler: () => new Promise((r) => setTimeout(() => r(PASS), 5)),
  });
  assert.deepEqual(soleOutput(io), {}, 'a handler inside its budget still passes');

  const late = fakeIo(inputFor('SubagentStop'));
  await runGate({
    event: 'SubagentStop',
    deadlineMs: 5000,
    io: late,
    handler: async () => {
      await new Promise((r) => setTimeout(r, 30));
      const t = Date.now();
      while (Date.now() - t < 60) {
        /* blocks past a budget the timer cannot enforce */
      }
      return PASS;
    },
  });
  assert.deepEqual(soleOutput(late), {}, 'inside a generous budget the same handler passes');
});

test('an event this runtime does not model ends loudly rather than in a shape the platform rejects', async () => {
  const io = fakeIo(inputFor('SomeFutureEvent'));
  await runGate({ event: 'PreToolUse', deadlineMs: 500, io, handler: () => PASS });
  assert.deepEqual(io.codes, [2]);
  assert.equal(io.out.length, 0, 'guessing a hookEventName is what fails open');
  assert.match(io.err.join(''), /does not model/);
});

test('writeFully keeps writing until the whole decision is out', () => {
  // writeSync may take fewer bytes than it is given. Ignoring its return
  // value produces truncated JSON, which fails the platform's schema, which
  // discards the output — a refusal cut in half is an approval.
  const chunks = [];
  const written = writeFully('{"decision":"block"}\n', (buf, off) => {
    chunks.push(buf[off]);
    return 1; // one byte at a time, the worst honest sink
  });
  assert.equal(written, 21);
  assert.equal(Buffer.from(chunks).toString('utf8'), '{"decision":"block"}\n');
});

test('writeFully retries back-pressure but refuses to spin forever on a dead sink', () => {
  let calls = 0;
  const out = [];
  writeFully('abc', (buf, off, len) => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error('EAGAIN'), { code: 'EAGAIN' });
    out.push(buf.subarray(off, off + len).toString('utf8'));
    return len;
  });
  assert.equal(out.join(''), 'abc', 'a momentarily full pipe is back-pressure, not failure');

  assert.throws(
    () => writeFully('abc', () => 0),
    /stalled/,
    'a sink that never makes progress must throw, not hang the session',
  );
});

// --------------------------------------------------------------- truncation

test('the platform limit is pinned to the number the platform actually uses', () => {
  // Measured as `text.length <= 10000` (UTF-16 code units). Pinned as a
  // literal because every truncation test uses samples far from the bound,
  // so a limit ten times too large would otherwise survive them all.
  assert.equal(OUTPUT_LIMIT, 10000);
  const justOver = 'q'.repeat(OUTPUT_LIMIT + 40);
  const { omitted } = clampPayload((r) => refusalPayload('Stop', r), justOver);
  assert.ok(omitted > 0, 'a payload just past the limit must still be cut');
});

test('output over the platform limit is cut deterministically and says so', () => {
  const long = 'x'.repeat(40000);
  const a = clampPayload((r) => refusalPayload('PreToolUse', r), long);
  const b = clampPayload((r) => refusalPayload('PreToolUse', r), long);
  assert.deepEqual(a.payload, b.payload, 'the same input must cut at the same place');
  const serialized = JSON.stringify(a.payload);
  assert.ok(serialized.length <= OUTPUT_LIMIT, `serialized ${serialized.length} > ${OUTPUT_LIMIT}`);
  assert.ok(a.omitted > 0);
  assert.match(a.payload.hookSpecificOutput.permissionDecisionReason, /output truncated/);
  assert.match(
    a.payload.hookSpecificOutput.permissionDecisionReason,
    new RegExp(`${a.omitted} of 40000 characters omitted`),
    'a silently shortened message is the same defect as a silently skipped file',
  );
});

test('truncation measures the SERIALIZED payload, not the raw string', () => {
  // Every character here becomes six in JSON, so a limit applied before
  // encoding would let ~6x the budget through and the platform would discard
  // the whole output — a refusal that reads as an approval.
  const quotes = '"'.repeat(5000);
  const { payload } = clampPayload((r) => refusalPayload('Stop', r), quotes);
  assert.ok(JSON.stringify(payload).length <= OUTPUT_LIMIT);
});

test('truncation never splits a surrogate pair', () => {
  const emoji = String.fromCodePoint(0x1f600).repeat(9000);
  const { payload } = clampPayload((r) => refusalPayload('Stop', r), emoji);
  const text = payload.reason;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      assert.ok(next >= 0xdc00 && next <= 0xdfff, `lone high surrogate at ${i}`);
      i++;
    } else {
      assert.ok(!(code >= 0xdc00 && code <= 0xdfff), `lone low surrogate at ${i}`);
    }
  }
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(payload)));
});

test('output that already fits is left untouched', () => {
  const { payload, omitted } = clampPayload((r) => refusalPayload('Stop', r), 'short');
  assert.equal(omitted, 0);
  assert.deepEqual(payload, { decision: 'block', reason: 'short' });
});

// ------------------------------------------------------------ sanitization

test('the sanitizer and the CI scanner enforce ONE list, not two', () => {
  // The point of importing FORBIDDEN instead of restating it: when the
  // scanner's list grows (ADR-19 correction 1), this grows with it. The test
  // proves agreement rather than trusting the import.
  const points = [];
  for (let cp = 0; cp <= 0x30ff; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // lone surrogates are not codepoints
    points.push(cp);
  }
  // Sampled explicitly because they lie outside the sweep above, and every one
  // of them was added to the scanner AFTER this runtime was written — which is
  // the whole point of not keeping a second copy of the list.
  for (const cp of [0x3164, 0xffa0, 0xfeff, 0xfff9, 0x1d173, 0x1f600, 0xe0001, 0xe0041, 0xe0100, 0x10fffe]) {
    points.push(cp);
  }
  const sample = points.map((cp) => String.fromCodePoint(cp)).join('|');
  const cleaned = sanitizeForOutput(sample);
  assert.deepEqual(
    scanText(cleaned),
    [],
    'the sanitizer left something the repo-wide scanner forbids',
  );
});

test('the sanitizer escapes rather than deletes, so a poisoned string looks poisoned', () => {
  const bidi = String.fromCodePoint(0x202e);
  const out = sanitizeForOutput(`path${bidi}gpj.exe`);
  assert.equal(out, 'path<U+202E>gpj.exe');
});

test('the sanitizer leaves ordinary text, tabs and newlines alone', () => {
  const text = `line one\n\tindented — ${String.fromCodePoint(0x1f600)} zażółć`;
  assert.equal(sanitizeForOutput(text), text);
});

test('a refusal reason cannot smuggle control characters into the transcript', async () => {
  const nul = String.fromCodePoint(0x00);
  const io = fakeIo(inputFor('PreToolUse'));
  await runGate({
    event: 'PreToolUse',
    deadlineMs: 500,
    io,
    handler: () => ({ decision: 'deny', reason: `secret${nul}${String.fromCodePoint(0x2066)}found` }),
  });
  const reason = soleOutput(io).hookSpecificOutput.permissionDecisionReason;
  assert.deepEqual(scanText(reason), []);
  assert.match(reason, /secret<U\+0000><U\+2066>found/);
});

// ----------------------------------------------------------- input handling

test('field() reads own properties only', () => {
  const parsed = parseHookInput('{"hook_event_name":"Stop"}');
  assert.equal(field(parsed, 'hook_event_name'), 'Stop');
  assert.equal(field(parsed, 'toString'), undefined, 'a prototype member is not hook input');
  assert.equal(field(parsed, 'constructor'), undefined);
  assert.equal(field(null, 'x'), undefined);
});

test('readStdin returns empty for an absent stream instead of hanging', async () => {
  assert.equal(await readStdin(null), '');
  assert.equal(await readStdin(undefined), '');
});

test('resolveEvent prefers the event the platform says it fired', () => {
  assert.equal(resolveEvent('PreToolUse', 'SubagentStop', { mustBlock: true }), 'SubagentStop');
  assert.equal(resolveEvent('PreToolUse', 'garbage', { mustBlock: true }), 'PreToolUse');
  assert.equal(resolveEvent('PreToolUse', undefined, { mustBlock: true }), 'PreToolUse');
  // A gate must answer in a shape that can refuse, so a probe name loses.
  assert.equal(resolveEvent('PreToolUse', 'SessionStart', { mustBlock: true }), 'PreToolUse');
  assert.equal(resolveEvent('SessionStart', 'SubagentStart', { mustBlock: false }), 'SubagentStart');
});

// ----------------------------------------------------------------- probes

test('a probe that throws still lets the session start', async () => {
  const io = fakeIo(inputFor('SessionStart'));
  await runProbe({
    event: 'SessionStart',
    deadlineMs: 500,
    io,
    handler: () => {
      throw new Error('journal is a directory');
    },
  });
  assert.deepEqual(soleOutput(io), {});
  assert.deepEqual(io.codes, [0]);
  assert.match(io.err.join(''), /journal is a directory/);
});

test('a probe fed garbage still lets the session start', async () => {
  for (const raw of ['', 'not json', '[]']) {
    const io = fakeIo(raw);
    await runProbe({ event: 'SessionStart', deadlineMs: 500, io, handler: () => 'ctx' });
    assert.deepEqual(soleOutput(io), {}, `raw=${raw}`);
    assert.deepEqual(io.codes, [0]);
  }
});

test('a probe that overruns its deadline yields an empty context, not an error', async () => {
  const io = fakeIo(inputFor('SessionStart'));
  await runProbe({
    event: 'SessionStart',
    deadlineMs: 15,
    io,
    handler: () => new Promise(() => {}),
  });
  assert.deepEqual(soleOutput(io), {});
  assert.match(io.err.join(''), /gave up after 15 ms/);
});

test('a probe clamps its injection to the platform limit and reports the cut', async () => {
  const io = fakeIo(inputFor('SessionStart'));
  await runProbe({
    event: 'SessionStart',
    deadlineMs: 500,
    io,
    handler: () => 'y'.repeat(50000),
  });
  const payload = soleOutput(io);
  assert.ok(io.out[0].length <= OUTPUT_LIMIT + 1, 'the newline is ours, the rest is the budget');
  assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(payload.hookSpecificOutput.additionalContext, /output truncated/);
  assert.match(io.err.join(''), /injected context truncated/);
});
