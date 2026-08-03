/**
 * Tests for the hook-liveness check.
 *
 * The organising rule here is ADR-20: every guard must be SEEN RED. A test
 * that only builds a healthy plugin tree and asserts "no findings" would pass
 * just as happily over a check that returns the empty list unconditionally —
 * which is precisely the shape this whole module exists to detect in somebody
 * else's code, so it would be an embarrassing one to ship in our own.
 *
 * Each check therefore has a test that BREAKS the tree and asserts the
 * specific code, and the healthy case is asserted separately so a check that
 * fires on everything is caught too. Both directions, or neither counts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DOCTOR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'doctor.mjs');

import {
  BLOCKING_EVENTS,
  CLOSED_SUBJECTS,
  MAX_PLAUSIBLE_TIMEOUT_S,
  TOOL_ALIASES,
  entryKeyFindings,
  FILE_WRITING_TOOLS,
  MATCH_QUERY_FIELD,
  PLATFORM_EVENTS,
  aliasesOf,
  analyzeMatcher,
  checkHooks,
  declaredEvents,
  lexCommand,
  matcherBranch,
  matcherMatches,
  normalizeName,
  pluginAgentTypes,
  readPluginName,
  shebangInterpreter,
  subjectsFor,
} from '../../scripts/hooks-check.mjs';

/** Build a synthetic plugin tree. Everything about it is overridable. */
function plugin({ hooks, manifest, scripts = {}, agents = [] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tyran-hooks-check-'));
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'hooks', 'scripts'), { recursive: true });
  mkdirSync(join(root, 'agents'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify(manifest ?? { name: 'tyran' }),
  );
  if (hooks !== null) {
    writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(hooks ?? defaultHooks()));
  }
  const files = Object.keys(scripts).length > 0 ? scripts : { 'gate.mjs': '#!/usr/bin/env node\nexport const x = 1;\n' };
  for (const [name, body] of Object.entries(files)) {
    const path = join(root, 'hooks', 'scripts', name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
  }
  for (const name of agents) writeFileSync(join(root, 'agents', `${name}.md`), '---\n');
  return root;
}

function defaultHooks(matcher = 'Bash') {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher,
          hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 10 }],
        },
      ],
    },
  };
}

const codes = (result) => result.findings.map((f) => f.code);
const roots = [];
function tree(options) {
  const root = plugin(options);
  roots.push(root);
  return root;
}
test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------- the predicate itself

test('the transcribed predicate reproduces every measured platform result', () => {
  // These rows come from hooks/HOOK-CONTRACT-MEASURED.md, which recorded them
  // from a live install. If the transcription drifts from the platform, this
  // is the test that says so.
  assert.equal(matcherMatches('startup', 'startup|resume|compact'), true);
  assert.equal(matcherMatches('clear', 'startup|resume|compact'), false);
  assert.equal(matcherMatches('tyran-implementer', 'tyran-implementer'), true);
  // Unanchored regex: matches too much.
  assert.equal(matcherMatches('evil-tyran-implementer-nope', 'tyran-implementer'), true);
  // The dangerous one: looks like a list, matches nothing.
  assert.equal(matcherMatches('Write', 'Edit, Write'), false);
  assert.equal(matcherMatches('Edit', 'Edit, Write'), false);
  assert.equal(matcherMatches('Write', 'Edit|Write'), true);
  // Invalid regex is caught locally and matches nothing.
  assert.equal(matcherMatches('anything', '[unclosed'), false);
  // The equality branch is not a substring test — measured live.
  assert.equal(matcherMatches('probeplug:plug-probe', 'plug'), false);
  assert.equal(matcherMatches('probeplug:plug-probe', 'probeplug:plug-probe'), true);
  assert.equal(matcherMatches('probeplug:plug-probe', '^(probeplug|tyran):'), true);
  // Regexes are case-sensitive.
  assert.equal(matcherMatches('probeplug:plug-probe', 'PROBEPLUG:PLUG-PROBE'), false);
  // Empty and star match everything.
  assert.equal(matcherMatches('whatever', ''), true);
  assert.equal(matcherMatches('whatever', '*'), true);
});

test('the alias table works in BOTH directions, as the platform applies it', () => {
  // normalise is applied to the MATCHER and compared against the RAW query...
  assert.equal(normalizeName('Task'), 'Agent');
  assert.equal(matcherMatches('Agent', 'Task'), true);
  // ...while a REGEX matcher is retried against every alias OF the query.
  assert.deepEqual(aliasesOf('Agent'), ['Task']);
  assert.equal(matcherMatches('Agent', '^Task$'), true);
  // Getting this backwards would report a live gate as dead, so pin it.
  assert.equal(matcherMatches('Task', '^Agent$'), false);
});

test('matcherBranch names the branch an author thinks they are in', () => {
  assert.equal(matcherBranch(''), 'always');
  assert.equal(matcherBranch('*'), 'always');
  assert.equal(matcherBranch('Bash'), 'exact');
  assert.equal(matcherBranch('Edit|Write'), 'list');
  assert.equal(matcherBranch('^tyran:'), 'regex');
  assert.equal(matcherBranch('Edit, Write'), 'regex');
  assert.equal(matcherBranch('[unclosed'), 'invalid-regex');
});

// --------------------------------------------------------- the file checks

test('RED: a deleted hook file is an error that names the fail-open mechanism', () => {
  const root = tree({ scripts: { 'other.mjs': '#!/usr/bin/env node\n' } });
  const result = checkHooks({ root });
  assert.ok(codes(result).includes('hook-file-absent'));
  assert.equal(result.counts.error, 1);
  assert.equal(result.ok, false);
  const f = result.findings.find((x) => x.code === 'hook-file-absent');
  // The message has to explain WHY absence is dangerous, or the reader files
  // it as cosmetic. This assertion is the one that keeps the sentence honest.
  assert.match(f.message, /ACTION PROCEEDS/);
  assert.match(f.fix, /ls -l/);
});

test('GREEN: the same tree with the file present has no error at all', () => {
  const root = tree({});
  const result = checkHooks({ root });
  assert.equal(result.counts.error, 0);
  assert.equal(result.counts.warning, 0);
  assert.equal(result.ok, true);
  assert.ok(codes(result).includes('hooks-ok'));
});

test('RED: a hook file without the execute bit is an error', () => {
  const root = tree({});
  chmodSync(join(root, 'hooks', 'scripts', 'gate.mjs'), 0o644);
  const result = checkHooks({ root });
  assert.ok(codes(result).includes('hook-not-executable'));
  assert.equal(result.ok, false);
  assert.match(result.findings.find((f) => f.code === 'hook-not-executable').message, /exits 126/);
});

test('RED: a hook file with no shebang is an error', () => {
  const root = tree({ scripts: { 'gate.mjs': 'export const x = 1;\n' } });
  assert.ok(codes(checkHooks({ root })).includes('hook-no-shebang'));
});

test('RED: a shebang naming an interpreter that does not exist is an error', () => {
  const root = tree({ scripts: { 'gate.mjs': '#!/usr/bin/env nosuchinterpreter9\n' } });
  assert.ok(codes(checkHooks({ root })).includes('hook-interpreter-absent'));
});

test('a real shebang resolves through /usr/bin/env, including -S and flags', () => {
  assert.equal(shebangInterpreter('#!/usr/bin/env node'), 'node');
  assert.equal(shebangInterpreter('#!/usr/bin/env -S node --enable-source-maps'), 'node');
  assert.equal(shebangInterpreter('#!/bin/sh'), '/bin/sh');
  assert.equal(shebangInterpreter('not a shebang'), null);
  assert.equal(shebangInterpreter('#!'), null);
});

// ----------------------------------------------------------- the command

test('RED: an unquoted ${CLAUDE_PLUGIN_ROOT} is an error, because the shell splits it', () => {
  const hooks = defaultHooks();
  hooks.hooks.PreToolUse[0].hooks[0].command = '${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs';
  const root = tree({ hooks });
  const result = checkHooks({ root });
  assert.ok(codes(result).includes('hook-path-unquoted'));
  assert.match(result.findings.find((f) => f.code === 'hook-path-unquoted').message, /word-split/);
});

test('GREEN: the quoted form produces no such finding', () => {
  assert.ok(!codes(checkHooks({ root: tree({}) })).includes('hook-path-unquoted'));
});

test('the lexer separates quoted from unquoted expansion, which is the whole point', () => {
  assert.deepEqual(lexCommand('"${A}/x.mjs"').unquotedVars, []);
  assert.deepEqual(lexCommand('${A}/x.mjs').unquotedVars, ['A']);
  assert.deepEqual(lexCommand("'${A}/x.mjs'").unquotedVars, []);
  // Arguments survive, because a hook may legitimately carry one.
  assert.deepEqual(lexCommand('"${A}/x.mjs" SubagentStop').argv, ['${A}/x.mjs', 'SubagentStop']);
  assert.equal(lexCommand('"unterminated').unterminatedQuote, true);
});

test('a command that is a shell PROGRAM is declined rather than checked wrongly', () => {
  const hooks = defaultHooks();
  hooks.hooks.PreToolUse[0].hooks[0].command = 'cat x | "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"';
  const result = checkHooks({ root: tree({ hooks }) });
  assert.ok(codes(result).includes('hook-command-not-modellable'));
  // And it must NOT then also claim the file is missing: a check that guesses
  // which file runs and reports on the wrong one is worse than one that says
  // it does not know.
  assert.ok(!codes(result).includes('hook-file-absent'));
});

test('RED: a hook with no timeout warns, naming the 600 s default', () => {
  const hooks = defaultHooks();
  delete hooks.hooks.PreToolUse[0].hooks[0].timeout;
  const result = checkHooks({ root: tree({ hooks }) });
  assert.ok(codes(result).includes('hook-no-timeout'));
  assert.match(result.findings.find((f) => f.code === 'hook-no-timeout').message, /600 seconds/);
});

test('RED: the same command twice on one event warns — the platform deduplicates', () => {
  const hooks = defaultHooks();
  const entry = hooks.hooks.PreToolUse[0].hooks[0];
  hooks.hooks.PreToolUse.push({ matcher: 'Write', hooks: [{ ...entry }] });
  const result = checkHooks({ root: tree({ hooks }) });
  assert.ok(codes(result).includes('hook-duplicate-command'));
  assert.match(
    result.findings.find((f) => f.code === 'hook-duplicate-command').message,
    /deduplicates matched hooks by \(pluginRoot, command\)/,
  );
});

// ------------------------------------------------------------ the events

test('RED: an unknown event key is an error, because the block is never dispatched', () => {
  const hooks = defaultHooks();
  hooks.hooks.PreToolUSe = hooks.hooks.PreToolUse; // the one-character typo
  delete hooks.hooks.PreToolUse;
  const result = checkHooks({ root: tree({ hooks }) });
  assert.ok(codes(result).includes('hook-event-unknown'));
});

test('every event in the match-query table is an event the platform dispatches', () => {
  // Two tables transcribed from the same binary; if one drifts, this fires.
  for (const event of Object.keys(MATCH_QUERY_FIELD)) {
    assert.ok(PLATFORM_EVENTS.includes(event), `${event} is a dispatched event`);
  }
  for (const event of Object.keys(CLOSED_SUBJECTS)) {
    assert.ok(Object.hasOwn(MATCH_QUERY_FIELD, event), `${event} has a match query`);
  }
});

test('RED: a matcher on an event with no match query is reported as inert', () => {
  const hooks = { hooks: { Stop: [{ matcher: 'something', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 5 }] }] } };
  const result = checkHooks({ root: tree({ hooks }) });
  assert.ok(codes(result).includes('matcher-ignored-by-event'));
  assert.match(
    result.findings.find((f) => f.code === 'matcher-ignored-by-event').message,
    /fires for EVERY occurrence/,
  );
});

test('GREEN: the same event with no matcher is silent about matching', () => {
  const hooks = { hooks: { Stop: [{ hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 5 }] }] } };
  const result = checkHooks({ root: tree({ hooks }) });
  assert.ok(!codes(result).includes('matcher-ignored-by-event'));
  assert.equal(result.ok, true);
});

// ----------------------------------------------------------- the matchers

test('RED: the comma matcher is an ERROR and its fix is the alternation', () => {
  const result = checkHooks({ root: tree({ hooks: defaultHooks('Edit, Write') }) });
  const f = result.findings.find((x) => x.code === 'matcher-comma-separated');
  assert.ok(f, 'the comma matcher is detected');
  assert.equal(f.severity, 'error');
  assert.equal(f.fix, 'write it as an alternation instead: "Edit|Write"');
});

test('RED: an invalid regex matcher is an error and stops further matcher analysis', () => {
  const result = checkHooks({ root: tree({ hooks: defaultHooks('[unclosed') }) });
  assert.ok(codes(result).includes('matcher-invalid-regex'));
  // Reporting "also unanchored" about an expression that cannot compile would
  // be noise stacked on the real problem.
  assert.ok(!codes(result).includes('matcher-unanchored'));
});

test('RED: a closed subject set makes an impossible matcher an ERROR, not a warning', () => {
  const hooks = { hooks: { PreCompact: [{ matcher: 'startup', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 5 }] }] } };
  const result = checkHooks({ root: tree({ hooks }) });
  const f = result.findings.find((x) => x.code === 'matcher-matches-nothing-closed');
  assert.ok(f);
  assert.equal(f.severity, 'error');
  assert.match(f.message, /"manual", "auto"/);
});

test('RED: an OPEN subject set can only ever warn, and says why', () => {
  const result = checkHooks({ root: tree({ hooks: defaultHooks('NoSuchTool') }) });
  const f = result.findings.find((x) => x.code === 'matcher-matches-nothing-known');
  assert.equal(f.severity, 'warning');
  assert.match(f.message, /set is OPEN/);
  assert.equal(result.counts.error, 0);
});

test('RED: the equality trap — "implementer" can never match "tyran:implementer"', () => {
  const hooks = {
    hooks: {
      SubagentStop: [
        { matcher: 'implementer', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 5 }] },
      ],
    },
  };
  const result = checkHooks({ root: tree({ hooks, agents: ['implementer'] }) });
  const f = result.findings.find((x) => x.code === 'matcher-matches-nothing-known');
  assert.ok(f, 'the dead matcher is found');
  // The finding must NAME the value it cannot match, or the reader cannot act.
  assert.match(f.message, /tyran:implementer/);
  assert.match(f.message, /EQUALITY branch/);
});

test('the namespace comes from the manifest, so a rename changes the subjects', () => {
  const root = tree({ manifest: { name: 'renamed' }, agents: ['implementer'] });
  assert.equal(readPluginName(root), 'renamed');
  assert.deepEqual(pluginAgentTypes(root), ['renamed:implementer']);
  // ...which is exactly how renaming a plugin silently disarms its matchers.
  assert.equal(matcherMatches('renamed:implementer', '^tyran:implementer$'), false);
});

test('a wildcard written the long way is INFO, not an unanchored-regex warning', () => {
  // `.+|^$` is how the evidence gate deliberately catches every agent_type
  // including the measured empty one. Reporting it as a mistake is the kind
  // of noise that gets a check switched off.
  const findings = analyzeMatcher('SubagentStop', '.+|^$', 'x', { subjects: ['tyran:implementer'], closed: false });
  assert.deepEqual(findings.map((f) => f.code), ['matcher-matches-everything']);
  assert.equal(findings[0].severity, 'info');
});

test('RED: an unanchored regex that is NOT a wildcard still warns', () => {
  const findings = analyzeMatcher('SubagentStop', 'tyran:implementer', 'x', {
    subjects: ['tyran:implementer'],
    closed: false,
  });
  assert.ok(findings.some((f) => f.code === 'matcher-unanchored'));
  // And the suggested fix must not be a broken expression when the matcher
  // already contains an alternation.
  const alt = analyzeMatcher('SubagentStop', 'a:x|b:y', 'x', { subjects: ['a:x'], closed: false });
  assert.match(alt.find((f) => f.code === 'matcher-unanchored').fix, /anchor EACH alternative/);
});

// ------------------------------------------------- the manifest and file

test('RED: no hooks field AND no standard hooks.json is an error', () => {
  // With the standard hooks/hooks.json auto-loaded, a missing manifest field is
  // fine; the error is only when there is no hooks file anywhere.
  const result = checkHooks({ root: tree({ hooks: null, manifest: { name: 'tyran' } }) });
  assert.ok(codes(result).includes('hooks-manifest-no-hooks'));
});

test('a missing manifest field is HEALTHY when the standard hooks.json exists (auto-loaded)', () => {
  const result = checkHooks({ root: tree({ manifest: { name: 'tyran' } }) });
  assert.equal(result.counts.error, 0, JSON.stringify(result.findings, null, 2));
});

test('RED: a manifest that re-declares the auto-loaded hooks.json is the load-killing duplicate', () => {
  // The MUST-FAIL case for the inverted check: Claude Code auto-loads the
  // standard file, so naming it in the manifest too is the fatal duplicate that
  // shipped in 0.1.4 and gated nothing.
  const root = tree({ manifest: { name: 'tyran', hooks: './hooks/hooks.json' } });
  assert.ok(codes(checkHooks({ root })).includes('hooks-manifest-duplicates-standard'));
});

test('RED: a hooks file that is not valid JSON is an error, not a crash', () => {
  const root = tree({});
  writeFileSync(join(root, 'hooks', 'hooks.json'), '{ not json');
  const result = checkHooks({ root });
  assert.ok(codes(result).includes('hooks-file-invalid'));
});

test('RED: a manifest pointing at an ADDITIONAL hooks file that does not exist is an error', () => {
  // A non-standard file the manifest names but that is not on disk.
  const root = tree({ hooks: null, manifest: { name: 'tyran', hooks: './hooks/extra.json' } });
  assert.ok(codes(checkHooks({ root })).includes('hooks-file-missing'));
});

test('RED: the declared-event cross-check catches a script registered under the wrong key', () => {
  const hooks = defaultHooks();
  const script = '#!/usr/bin/env node\nawait runGate({ event: \'SubagentStop\', handler });\n';
  const result = checkHooks({ root: tree({ hooks, scripts: { 'gate.mjs': script } }) });
  const f = result.findings.find((x) => x.code === 'hook-event-declaration-mismatch');
  assert.ok(f);
  // It must admit what it is, because a heuristic sold as a proof is the
  // failure this repo names in its own review rules.
  assert.match(f.message, /TEXTUAL heuristic/);
});

test('declaredEvents ignores words that are not platform events', () => {
  assert.deepEqual(declaredEvents("event: 'SubagentStop'"), ['SubagentStop']);
  assert.deepEqual(declaredEvents("event: 'NotAnEvent'"), []);
  assert.deepEqual(declaredEvents('nothing here'), []);
});

// -------------------------------------------------------------- the facts

test('the file-writing tool set is the platform\'s own, and the guard shares it', () => {
  assert.deepEqual([...FILE_WRITING_TOOLS], ['Write', 'Edit', 'NotebookEdit']);
});

test('subjectsFor keeps closed sets closed and open sets open', () => {
  assert.equal(subjectsFor('PreCompact', tree({})).closed, true);
  assert.deepEqual(subjectsFor('PreCompact', tree({})).subjects, ['manual', 'auto']);
  assert.equal(subjectsFor('PreToolUse', tree({})).closed, false);
  assert.equal(subjectsFor('Stop', tree({})).subjects.length, 0);
});

// ------------------------------------------------- mutants that survived

/**
 * Round 2. Four mutants survived the first campaign and NONE of them was
 * equivalent — each was invisible only because a test aimed next to the sink
 * that carries the answer, which is the failure ADR-20 correction 1 names.
 * The cases below aim at the sink.
 */

test('the LIST branch is equality, not a substring test (mutant M3)', () => {
  // The measured table used "Write" against "Edit|Write", which a substring
  // implementation also satisfies — so it could not tell the two apart. These
  // can: with equality all three are false, with `query.includes(k)` the first
  // two become true.
  assert.equal(matcherMatches('Writer', 'Edit|Write'), false);
  assert.equal(matcherMatches('PreWrite', 'Edit|Write'), false);
  assert.equal(matcherMatches('Write', 'Wri|Xyz'), false);
  // ...and the single-alternative branch alongside it, which shares the bug.
  assert.equal(matcherMatches('Writer', 'Write'), false);
});

test('the same equality holds through analyzeMatcher, not only in the predicate', () => {
  // Sink discipline (ADR-20 correction, point 4): matcherMatches is consumed
  // in three places — this test, the `hits` filter and the wildcard `probes`
  // filter. Killing the mutant in the predicate alone would leave the two
  // consumers unproven.
  const findings = analyzeMatcher('PreToolUse', 'Writ', 'x', { subjects: ['Write', 'Edit'], closed: false });
  assert.ok(
    findings.some((f) => f.code === 'matcher-matches-nothing-known'),
    'a prefix of a real tool name matches nothing, and the check must say so',
  );
});

test('hooks-ok is NEVER printed next to an error (mutant M13)', () => {
  // A clean bill of health rendered beside a finding is the single output a
  // diagnostic must not produce — the whole doctrine of doctor.mjs, applied
  // to its newest mode.
  const broken = checkHooks({ root: tree({ scripts: { 'other.mjs': '#!/usr/bin/env node\n' } }) });
  assert.ok(broken.counts.error > 0);
  assert.ok(!codes(broken).includes('hooks-ok'), 'no healthy line beside an error');

  const warned = checkHooks({ root: tree({ hooks: defaultHooks('NoSuchTool') }) });
  assert.ok(warned.counts.warning > 0);
  assert.ok(!codes(warned).includes('hooks-ok'), 'no healthy line beside a warning either');
});

test('RED: a DIRECTORY where the hook file should be is an error (mutant M24)', () => {
  // Not exotic: an interrupted install, or a `cp -R` that copied a directory
  // over a file, leaves exactly this. The shell cannot execute it, so the
  // gate is absent in the usual silent way.
  const root = tree({ scripts: { 'other.mjs': '#!/usr/bin/env node\n' } });
  mkdirSync(join(root, 'hooks', 'scripts', 'gate.mjs'), { recursive: true });
  const result = checkHooks({ root });
  assert.ok(codes(result).includes('hook-file-not-a-file'));
  assert.equal(result.ok, false);
  // And it must not ALSO claim the file is absent: two findings for one fact
  // send the reader to fix the wrong thing first.
  assert.ok(!codes(result).includes('hook-file-absent'));
});

// ============================================================ round 2

/**
 * The fifth failure variant, and the worst: every earlier check passes. The
 * file exists, is executable, has a shebang, the matcher is right, the event
 * is real — and one key on the ENTRY turns the gate into decoration while
 * `doctor --hooks` prints "healthy". Measured live by review, same payload,
 * one key changed at a time.
 */
function withEntryKey(patch) {
  const hooks = defaultHooks();
  Object.assign(hooks.hooks.PreToolUse[0].hooks[0], patch);
  return checkHooks({ root: tree({ hooks }) });
}

test('RED: "async" on a blocking event is an ERROR — a backgrounded gate cannot refuse', () => {
  const result = withEntryKey({ async: true });
  const f = result.findings.find((x) => x.code === 'hook-async-on-gate');
  assert.ok(f, 'async is detected');
  assert.equal(f.severity, 'error');
  assert.equal(result.ok, false);
  assert.match(f.message, /background without blocking/);
});

test('RED: "asyncRewake" implies async and is the same error', () => {
  assert.equal(withEntryKey({ asyncRewake: true }).findings.some((f) => f.code === 'hook-async-on-gate'), true);
});

test('RED: "once" on a gate is an ERROR — it guards the first call and nothing after', () => {
  const f = withEntryKey({ once: true }).findings.find((x) => x.code === 'hook-once-on-gate');
  assert.equal(f.severity, 'error');
});

test('RED: "if" on a gate is an ERROR — coverage becomes unknown', () => {
  const f = withEntryKey({ if: 'Bash(git *)' }).findings.find((x) => x.code === 'hook-conditional-gate');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /UNKNOWN/);
});

test('RED: a foreign "shell" on a gate is an ERROR', () => {
  const f = withEntryKey({ shell: 'powershell' }).findings.find((x) => x.code === 'hook-foreign-shell');
  assert.equal(f.severity, 'error');
  assert.equal(withEntryKey({ shell: 'bash' }).findings.some((x) => x.code === 'hook-foreign-shell'), false);
});

test('the SAME keys on a PROBE event are not errors — severity is a property of the pair', () => {
  // A probe that runs in the background, once, or conditionally is a
  // legitimate design. Flagging it would be the crying-wolf failure.
  for (const patch of [{ async: true }, { once: true }, { if: 'x' }, { shell: 'powershell' }]) {
    assert.deepEqual(entryKeyFindings('SessionStart', patch, 'x'), [], JSON.stringify(patch));
    assert.ok(entryKeyFindings('PreToolUse', patch, 'x').length > 0, JSON.stringify(patch));
  }
});

test('the blocking-event list agrees with the runtime that has to answer on them', async () => {
  // Two models of the platform, kept separate on purpose. If they disagree,
  // one of them is wrong and the disagreement must not be silent.
  const { EVENTS } = await import('../../hooks/scripts/hook-io.mjs');
  for (const [name, meta] of Object.entries(EVENTS)) {
    if (meta.canBlock) assert.ok(BLOCKING_EVENTS.includes(name), `${name} blocks in hook-io`);
    else assert.ok(!BLOCKING_EVENTS.includes(name), `${name} is a probe in hook-io`);
  }
});

test('RED: a timeout that is plainly milliseconds is reported, not just absence', () => {
  const f = withEntryKey({ timeout: 10000 }).findings.find((x) => x.code === 'hook-timeout-implausible');
  assert.ok(f, 'an implausible timeout is detected');
  assert.match(f.message, /day\(s\)/);
  assert.match(f.fix, /10\b/);
  // ...and a sane one is silent.
  assert.equal(withEntryKey({ timeout: MAX_PLAUSIBLE_TIMEOUT_S }).findings.some((x) => x.code === 'hook-timeout-implausible'), false);
});

/**
 * Reviewer counterexample R9, adopted verbatim as a MUST-PASS.
 *
 * `ok: counts.error === 0 && counts.warning === 0` -> `ok: counts.error === 0`
 * left the entire 596-test suite green. It is not equivalent: `ok` drives
 * doctor's EXIT CODE, and the tree it mislabels is the commonest dead gate
 * there is — a typo in a tool name, which is a warning because the tool set
 * is open. Every existing test pinned ok===false for ERRORS; the
 * warning/healthy boundary was pinned by nothing.
 */
test('R9 MUST-PASS: a WARNING-only tree is not healthy, and doctor exits 1', () => {
  const hooks = defaultHooks('Wrte'); // the typo'd tool name
  const root = tree({ hooks });
  const result = checkHooks({ root });
  assert.equal(result.counts.error, 0, 'no errors in this tree');
  assert.equal(result.counts.warning, 1, 'exactly one warning');
  assert.equal(result.ok, false, 'a warning-only tree is NOT ok');

  let rc = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [DOCTOR, '--hooks', '--plugin-root', root], { encoding: 'utf8' });
  } catch (err) {
    rc = err.status;
    out = err.stdout ?? '';
  }
  assert.equal(rc, 1, 'doctor --hooks exits 1 on a warning-only tree');
  assert.match(out, /action needed/);
  assert.doesNotMatch(out, /healthy/);
});

test('the alias table has all FIVE entries the platform ships', () => {
  // A missing row made this check report a LIVE gate as dead — the direction
  // the module header calls inadmissible — in the one file whose only value
  // is fidelity of transcription.
  assert.deepEqual(Object.keys(TOOL_ALIASES).sort(), [
    'AgentOutputTool', 'BashOutputTool', 'Brief', 'KillShell', 'Task',
  ]);
  assert.equal(TOOL_ALIASES.Brief, 'SendUserMessage');
  // The consequence, through the predicate: a matcher of "Brief" fires.
  assert.equal(matcherMatches('SendUserMessage', 'Brief'), true);
  assert.deepEqual(aliasesOf('SendUserMessage'), ['Brief']);
});

test('RED: a matcher spelling a namespace the manifest does not use is an error', () => {
  // The check the header promised and the first pass never emitted. A
  // declared severity with no code behind it is a line no mutant can kill.
  const hooks = {
    hooks: {
      SubagentStop: [
        { matcher: '^oldname:implementer$', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 5 }] },
      ],
    },
  };
  const result = checkHooks({ root: tree({ hooks, agents: ['implementer'] }) });
  const f = result.findings.find((x) => x.code === 'hook-namespace-drift');
  assert.ok(f, 'the drift is detected');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /"oldname:"/);
  assert.match(f.message, /"tyran"/);

  // GREEN: the correct namespace is silent.
  const ok = checkHooks({
    root: tree({
      hooks: { hooks: { SubagentStop: [{ matcher: '^tyran:implementer$', hooks: [{ type: 'command', command: '"${CLAUDE_PLUGIN_ROOT}/hooks/scripts/gate.mjs"', timeout: 5 }] }] } },
      agents: ['implementer'],
    }),
  });
  assert.ok(!codes(ok).includes('hook-namespace-drift'));
});
