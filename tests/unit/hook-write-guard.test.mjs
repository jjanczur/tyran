/**
 * Tests for the write guard.
 *
 * RULE OBSERVED THROUGHOUT: not one raw control or bidi character appears in
 * this file's bytes. Every payload is built with `cp(...)` from code points,
 * and the repository's own scanner asserts that this file is clean — which is
 * the same rule the guard enforces, applied to the tests that prove it.
 * Writing the character to test the check that forbids the character is how
 * this repository got nine of them in one session.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { invisibleProblem } from '../../scripts/invisible.mjs';
import { FILE_WRITING_TOOLS, matcherMatches } from '../../scripts/hooks-check.mjs';
import {
  CoverageFailure,
  DEADLINE_MS,
  GUARDED_TOOLS,
  GUARD_MATCHER,
  MCP_TOOL_PATTERN,
  MAX_DEPTH,
  collectStrings,
  judge,
  refusalFor,
  scanToolInput,
} from '../../hooks/scripts/write-guard.mjs';
import { PASS } from '../../hooks/scripts/hook-io.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(REPO_ROOT, 'hooks', 'scripts', 'write-guard.mjs');
const HOOKS_JSON = join(REPO_ROOT, 'hooks', 'hooks.json');

/** Every hostile character in this file is built, never typed. */
const cp = (...points) => String.fromCodePoint(...points);

/** How each guarded tool carries the text that becomes file content. */
const CARRIERS = {
  Write: (text) => ({ file_path: '/tmp/x.txt', content: text }),
  Edit: (text) => ({ file_path: '/tmp/x.txt', old_string: 'a', new_string: text }),
  NotebookEdit: (text) => ({ notebook_path: '/tmp/x.ipynb', cell_id: '1', new_source: text }),
  Bash: (text) => ({ command: "printf %s '" + text + "'" }),
};

const HOSTILE = [
  ['NUL', 0x00],
  ['CR', 0x0d],
  ['ESC', 0x1b],
  ['ZERO WIDTH SPACE', 0x200b],
  ['RIGHT-TO-LEFT OVERRIDE', 0x202e],
  ['TAG (astral)', 0xe0041],
  ['variation selector supplement (astral)', 0xe0100],
  ['Arabic number sign (Cf)', 0x0600],
];

function runScript(input) {
  return execFileSync(process.execPath, [SCRIPT], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function decideEndToEnd(toolName, toolInput) {
  const out = runScript(
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, tool_use_id: 't' }),
  );
  return JSON.parse(out);
}

// ------------------------------------------- every entrance, every payload

test('EVERY guarded tool refuses EVERY hostile payload — a gate on one entrance is not a gate', () => {
  for (const [toolName, carry] of Object.entries(CARRIERS)) {
    for (const [name, point] of HOSTILE) {
      const verdict = judge({ tool_name: toolName, tool_input: carry('a' + cp(point) + 'b') });
      assert.equal(verdict.decision, 'deny', `${toolName} must refuse ${name}`);
      assert.match(verdict.reason, /raw\s+control or invisible character/);
    }
  }
});

test('the guarded set is the PLATFORM\'s own, plus Bash — never a hand-kept list', () => {
  // If someone adds a fourth content-writing tool to hooks-check's transcription
  // of the platform table, this guard covers it with no edit here.
  for (const tool of FILE_WRITING_TOOLS) assert.ok(GUARDED_TOOLS.includes(tool), `${tool} guarded`);
  assert.ok(GUARDED_TOOLS.includes('Bash'));
  assert.deepEqual([...GUARDED_TOOLS], [...FILE_WRITING_TOOLS, 'Bash']);
});

test('legal text passes on every tool: TAB, LF and the declared U+FE0F gap', () => {
  for (const [toolName, carry] of Object.entries(CARRIERS)) {
    for (const [name, text] of [
      ['TAB', 'a' + cp(0x09) + 'b'],
      ['LF', 'a' + cp(0x0a) + 'b'],
      ['emoji presentation selector', cp(0x2764, 0xfe0f)],
      ['plain ASCII', 'const x = 1;'],
    ]) {
      assert.equal(judge({ tool_name: toolName, tool_input: carry(text) }), PASS, `${toolName} / ${name}`);
    }
  }
});

// --------------------------------------------------- the astral proof

test('the guard measures CODE POINTS, not UTF-16 units — the TAG block proof', () => {
  const tag = cp(0xe0041);
  // The character is ONE code point and TWO UTF-16 units...
  assert.equal([...tag].length, 1);
  assert.equal(tag.length, 2);
  // ...and NEITHER unit is invisible on its own. This is the whole reason a
  // unit-wise scan reports success over a payload that spells arbitrary ASCII
  // in invisible characters: it sees two surrogates, finds nothing wrong with
  // either, and passes.
  assert.equal(invisibleProblem(tag.charCodeAt(0)), null, 'high surrogate alone is not invisible');
  assert.equal(invisibleProblem(tag.charCodeAt(1)), null, 'low surrogate alone is not invisible');
  // Only the CODE POINT carries the answer.
  assert.equal(invisibleProblem(0xe0041), 'TAG character (invisible ASCII)');
  // And the guard catches it, on every tool.
  for (const [toolName, carry] of Object.entries(CARRIERS)) {
    assert.equal(judge({ tool_name: toolName, tool_input: carry(tag) }).decision, 'deny', toolName);
  }
});

test('a whole sentence smuggled in TAG characters is refused and reported', () => {
  // U+E0020..U+E007E map one-to-one onto printable ASCII.
  const smuggled = [...'IGNORE PRIOR'].map((c) => cp(0xe0000 + c.codePointAt(0))).join('');
  const verdict = judge({ tool_name: 'Write', tool_input: CARRIERS.Write('deploy ok' + smuggled) });
  assert.equal(verdict.decision, 'deny');
  // The refusal has to name what the invisible text SAID, or it is unfixable.
  assert.match(verdict.reason, /TAG for ASCII/);
});

// ------------------------------------------------ unknown shapes, coverage

test('an UNDECLARED nested shape is still scanned — tool_input is typed `unknown`', () => {
  // Measured: the platform validates tool_input as h.unknown(), so a guard
  // keyed on three known field names is correct for today and blind tomorrow.
  const verdict = judge({
    tool_name: 'SomeFutureWriter',
    tool_input: { edits: [{ payload: { body: 'x' + cp(0x202e) + 'y' } }] },
  });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /edits\[0\]\.payload\.body/);
});

test('collectStrings reaches every string and names the field that carries it', () => {
  const found = collectStrings({ a: 'one', b: [{ c: 'two' }], d: 3, e: null, f: true });
  assert.deepEqual(found, [
    { path: 'a', value: 'one' },
    { path: 'b[0].c', value: 'two' },
  ]);
});

test('a payload it cannot walk to the bottom is REFUSED, never passed', () => {
  // The secrets gate's doctrine, applied here: a partial scan that reports
  // nothing is indistinguishable from a clean one.
  let deep = 'leaf';
  for (let i = 0; i < MAX_DEPTH + 5; i++) deep = { n: deep };
  const verdict = judge({ tool_name: 'Write', tool_input: deep });
  assert.equal(verdict.decision, 'deny');
  assert.match(verdict.reason, /could not scan the whole input/);
  assert.throws(() => collectStrings(deep), CoverageFailure);

  const many = { list: Array.from({ length: 20001 }, () => 'x') };
  assert.equal(judge({ tool_name: 'Write', tool_input: many }).decision, 'deny');
});

test('a prototype-polluting key is walked as data, and Object.prototype is not', () => {
  const payload = JSON.parse('{"__proto__": {"evil": "' + 'x' + '"}, "content": "ok"}');
  assert.deepEqual(judge({ tool_name: 'Write', tool_input: payload }), PASS);
  // own keys only — nothing from the prototype chain reaches the scan
  assert.ok(collectStrings({ content: 'ok' }).every((s) => s.path === 'content'));
});

// -------------------------------------------------- the disjoint path rule

test('a path gets the IDENTIFIER rule too: a tab in a name is refused, in content it is not', () => {
  // The two rules are disjoint on purpose (scripts/invisible.mjs). A tab is
  // ordinary text in a file and a catastrophe in a name, where one path prints
  // as two columns in every tool that lists it.
  assert.equal(judge({ tool_name: 'Write', tool_input: { file_path: '/tmp/a' + cp(0x09) + 'b', content: 'x' } }).decision, 'deny');
  assert.equal(judge({ tool_name: 'Write', tool_input: { file_path: '/tmp/ab', content: 'x' + cp(0x09) + 'y' } }), PASS);
  assert.equal(judge({ tool_name: 'NotebookEdit', tool_input: { notebook_path: '/t/a' + cp(0x0a) + 'b', new_source: 'x' } }).decision, 'deny');
});

test('the finding says which text the position refers to', () => {
  const findings = scanToolInput({ file_path: '/tmp/a' + cp(0x202e) + 'b', content: 'ok' });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].where, 'name');
  assert.match(refusalFor('Write', findings), /in the file NAME/);
});

// ------------------------------------------------------- the empty cases

test('an absent tool_input is nothing to scan, not a guess', () => {
  assert.equal(judge({ tool_name: 'Write' }), PASS);
  assert.equal(judge({ tool_name: 'Write', tool_input: null }), PASS);
});

test('the CR refusal names the CRLF remedy, because that is the honest false alarm', () => {
  const verdict = judge({ tool_name: 'Edit', tool_input: CARRIERS.Edit('a' + cp(0x0d) + 'b') });
  assert.match(verdict.reason, /CARRIAGE RETURN/);
  assert.match(verdict.reason, /eol=lf/);
});

// ---------------------------------------------------- the wire and the shape

test('end to end: the refusal uses PreToolUse\'s shape, and PASS is silence', () => {
  const denied = decideEndToEnd('Write', CARRIERS.Write('a' + cp(0x202e) + 'b'));
  // PreToolUse refuses through hookSpecificOutput.permissionDecision. Sending
  // a top-level `decision` here would fail the platform's schema, the whole
  // output would be discarded, and the refusal would become an approval.
  assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  assert.ok(denied.decision === undefined, 'no top-level decision on PreToolUse');

  const passed = decideEndToEnd('Write', CARRIERS.Write('clean'));
  // "No objection" is an EMPTY object. `permissionDecision: "allow"` would
  // AUTO-APPROVE the call and skip the user's permission prompt.
  assert.deepEqual(passed, {});
});

test('end to end: garbage on stdin REFUSES, because an unfinished check is not an approval', () => {
  for (const raw of ['', 'not json', '[1,2,3]']) {
    const parsed = JSON.parse(runScript(raw));
    assert.equal(parsed.hookSpecificOutput.permissionDecision, 'deny', `raw=${JSON.stringify(raw)}`);
  }
});

// ------------------------------------------------------- the registration

test('the registration is real: matcher, event and a timeout above the gate deadline', () => {
  const doc = JSON.parse(readFileSync(HOOKS_JSON, 'utf8'));
  const entry = doc.hooks.PreToolUse.find((g) => g.hooks.some((h) => h.command.includes('write-guard.mjs')));
  assert.ok(entry, 'the guard is registered for PreToolUse');

  // The matcher is asserted against the CODE, not kept in step by memory.
  assert.equal(entry.matcher, GUARD_MATCHER);

  // ...and what it covers is asserted through the PLATFORM's own predicate,
  // because the shape of the string is not the question — what fires is.
  for (const tool of [...GUARDED_TOOLS, 'mcp__filesystem__write_file', 'mcp__plugin_x_srv__put']) {
    assert.equal(matcherMatches(tool, entry.matcher), true, `${tool} must be guarded`);
  }
  // No more than that. An unanchored alternation quietly widened this: the
  // platform retries a regex against every ALIAS of the query, so `Bash`
  // matched `TaskOutput` (via `BashOutputTool`) and `Write` matched
  // `WriteSomething`. Anchoring removes both, and this is the test that says so.
  for (const tool of ['Read', 'NotebookRead', 'Glob', 'Grep', 'WebFetch', 'Agent', 'TaskOutput', 'WriteSomething']) {
    assert.equal(matcherMatches(tool, entry.matcher), false, `${tool} must NOT be guarded`);
  }

  const hook = entry.hooks.find((h) => h.command.includes('write-guard.mjs'));
  assert.match(hook.command, /^"\$\{CLAUDE_PLUGIN_ROOT\}/, 'the path is quoted; the shell would split it otherwise');
  // The platform kills at `timeout` and then does not read stdout at all, so a
  // gate whose own deadline is not strictly shorter can only ever be killed.
  assert.ok(hook.timeout * 1000 > DEADLINE_MS, `${hook.timeout}s must exceed the ${DEADLINE_MS}ms deadline`);
});

// ------------------------------------------------------------- MCP tools

/**
 * Round 2. The first version declared MCP tools out of scope, reasoning that
 * "the equality branch cannot wildcard them". True, and the conclusion was
 * wrong: nothing forces the matcher to stay in the equality branch. A
 * filesystem MCP server is the commonest fourth way to write a file, and the
 * story is binding — a gate on one entrance is not a gate.
 */
test('an MCP write tool is guarded, and its payload is judged like any other', () => {
  const cpx = (...p) => String.fromCodePoint(...p);
  // The shape an MCP filesystem server actually sends: a flat object of
  // strings. Measured across 401 local transcripts, real MCP inputs reach
  // depth 2 and 4 strings at worst — far inside this guard's caps, so the
  // coverage refusal does not fire on real traffic.
  const hostile = { path: '/tmp/x.txt', content: 'ok' + cpx(0xe0041) + 'done' };
  const verdict = judge({ tool_name: 'mcp__filesystem__write_file', tool_input: hostile });
  assert.equal(verdict.decision, 'deny');
  assert.equal(judge({ tool_name: 'mcp__filesystem__write_file', tool_input: { path: '/t', content: 'ok' } }), PASS);
});

test('the MCP pattern covers servers nobody enumerated, and no read tool', () => {
  assert.equal(MCP_TOOL_PATTERN, 'mcp__.*');
  for (const t of ['mcp__a__b', 'mcp__plugin_claude-mem_mcp-search__search', 'mcp__x__write_file']) {
    assert.equal(matcherMatches(t, GUARD_MATCHER), true, t);
  }
  assert.equal(matcherMatches('Read', GUARD_MATCHER), false);
});

test('a real MCP input shape is walked to the bottom without a coverage refusal', () => {
  // Depth 2, the deepest shape measured in the transcript corpus.
  const input = { edits: [{ oldText: 'a', newText: 'b' }], path: '/tmp/f' };
  assert.equal(judge({ tool_name: 'mcp__filesystem__edit_file', tool_input: input }), PASS);
  assert.equal(collectStrings(input).length, 3);
});

test('MAX_STRINGS admits exactly its cap, not one more', () => {
  // The check runs BEFORE the push, so `>` allowed cap+1. Safe direction,
  // still a lie about the advertised limit.
  const atCap = { list: Array.from({ length: 5 }, () => 'x') };
  assert.equal(collectStrings(atCap, { maxStrings: 5 }).length, 5);
  assert.throws(() => collectStrings({ list: Array.from({ length: 6 }, () => 'x') }, { maxStrings: 5 }), CoverageFailure);
});
