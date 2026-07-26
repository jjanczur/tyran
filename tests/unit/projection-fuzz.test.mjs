import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EVENT_TYPES } from '../../scripts/journal.mjs';
import { STATE_FILE, PROGRESS_FILE, renderProjections } from '../../scripts/project.mjs';
import { formatCodePoint, scanText } from '../../scripts/scan-control-chars.mjs';

/**
 * Fuzzing the projection renderer against hostile journal `data`.
 *
 * This existed once as a throwaway 4000-case run pasted into a report. A
 * one-off run secures one afternoon; a contract has to be re-checked on every
 * commit, so it lives here instead — with a FIXED seed, so a failure is
 * reproducible rather than a rumour, and a bounded case count, so CI time
 * stays predictable.
 *
 * The journal is written by agents and by hand. Its `data` field is arbitrary
 * JSON from an untrusted-ish source, and the projections it feeds are rendered
 * as Markdown in GitHub and VS Code. That is the whole threat model: a value
 * that escapes its table cell can inject HTML, plant an image beacon, or flip
 * the reading order of everything after it (Trojan Source).
 */

/** mulberry32 — three lines, no dependency, identical on every platform. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x7a11ed;
const CASES = 300;

/**
 * Every forbidden character is BUILT, never typed — a literal here would make
 * this file fail the ADR-19 scan it helps enforce.
 */
const cp = (...points) => String.fromCodePoint(...points);

/** Payload fragments, each one a way a naive renderer has actually been broken. */
const HOSTILE = [
  '<script>alert(1)</script>',
  '<!-- -->',
  '-->',
  '<img src=x onerror=1>',
  '![beacon](https://evil.example/leak.png)',
  '[click](https://evil.example)',
  '](https://evil.example)',
  '| injected | columns |',
  '||||',
  '`code`',
  '```',
  'back\\slash',
  'line1\nline2',
  'tab\tsep',
  'a'.repeat(500),
  cp(0x0000),
  cp(0x001b) + '[31mred',
  cp(0x007f),
  cp(0x0085),
  cp(0x000d) + 'after CR',
  cp(0x202e) + 'reversed',
  cp(0x202d),
  cp(0x2066) + 'isolated',
  cp(0x200b),
  cp(0x200f),
  cp(0x061c),
  cp(0xfeff),
  '&amp;',
  '&#124;',
  '',
  '   ',
  '😀𝔘𝔫𝔦𝔠𝔬𝔡𝔢',
  '日本語のテキスト',
];

const SCALARS = [null, true, false, 0, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER];

function hostileString(rand) {
  const n = 1 + Math.floor(rand() * 3);
  let s = '';
  for (let i = 0; i < n; i++) s += HOSTILE[Math.floor(rand() * HOSTILE.length)];
  return s;
}

function hostileValue(rand, depth = 0) {
  const roll = rand();
  if (roll < 0.55) return hostileString(rand);
  if (roll < 0.7) return SCALARS[Math.floor(rand() * SCALARS.length)];
  if (depth >= 2) return hostileString(rand);
  if (roll < 0.85) {
    return Array.from({ length: Math.floor(rand() * 3) }, () => hostileValue(rand, depth + 1));
  }
  return { [hostileString(rand)]: hostileValue(rand, depth + 1) };
}

/** Keys the renderer actually reads, so payloads reach real code paths. */
const DATA_KEYS = [
  'id', 'title', 'text', 'agent', 'role', 'model', 'ticket', 'worktree', 'verdict',
  'kind', 'result', 'evidence', 'evidence_ref', 'resource', 'holder', 'phase',
  'next_steps', 'deps', 'by', 'sha', 'mode', 'target', 'confidence', 'class', 'detail',
];

function hostileEvent(rand) {
  const data = {};
  const keys = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < keys; i++) {
    data[DATA_KEYS[Math.floor(rand() * DATA_KEYS.length)]] = hostileValue(rand);
  }
  return {
    ts: rand() < 0.9 ? '2026-01-01T00:00:0' + Math.floor(rand() * 10) + '.000Z' : hostileString(rand),
    ev: rand() < 0.9 ? EVENT_TYPES[Math.floor(rand() * EVENT_TYPES.length)] : hostileString(rand),
    init: rand() < 0.5 ? 'demo' : hostileString(rand),
    actor: hostileString(rand),
    data,
  };
}

const HEADER_LINES = 2;

/**
 * Every Markdown table row carries exactly as many columns as its header.
 * A single unescaped pipe silently shifts every cell after it — the reader
 * then sees a verdict under the wrong agent, which is a lie, not a glitch.
 */
function tableColumnProblems(markdown) {
  const lines = markdown.split('\n');
  const problems = [];
  let expected = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) {
      expected = null;
      continue;
    }
    const columns = line.split('|').length;
    if (/^\|[-|]+\|$/.test(line)) continue; // separator row
    if (expected === null) expected = columns;
    else if (columns !== expected) {
      problems.push(`line ${i + 1}: ${columns - 2} columns, header had ${expected - 2}: ${line}`);
    }
  }
  return problems;
}

function checkDocument(name, markdown, caseNo, events) {
  const context = () => `case ${caseNo} (seed ${SEED}) ${name}\nevents: ${JSON.stringify(events)}`;

  // 1. No raw control, bidi or zero-width characters survive into the output.
  const control = scanText(markdown);
  assert.deepEqual(
    control.map((f) => `${f.line}:${f.column} ${formatCodePoint(f.codePoint)}`),
    [],
    `raw control/bidi character reached the projection — ${context()}`,
  );

  // 2. No angle brackets outside the generated header, which owns the only
  //    legitimate `<!-- ... -->` in the document.
  const body = markdown.split('\n').slice(HEADER_LINES).join('\n');
  assert.ok(!body.includes('<'), `unescaped "<" in the body — ${context()}`);
  assert.ok(!body.includes('>'), `unescaped ">" in the body — ${context()}`);

  // 3. No Markdown link or image syntax: both are remote-fetch primitives, and
  //    an image renders without a click (read beacon + exfiltration channel).
  assert.ok(!/!\[/.test(body), `image syntax in the body — ${context()}`);
  assert.ok(!/\]\(/.test(body), `link syntax in the body — ${context()}`);

  // 4. Table integrity.
  assert.deepEqual(tableColumnProblems(markdown), [], `ragged table — ${context()}`);
}

test(`fuzz: hostile journal data cannot break the projections (seed ${SEED}, ${CASES} cases)`, () => {
  const rand = rng(SEED);
  for (let caseNo = 0; caseNo < CASES; caseNo++) {
    const events = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => hostileEvent(rand));
    const { files } = renderProjections({ events });
    checkDocument(STATE_FILE, files[STATE_FILE], caseNo, events);
    checkDocument(PROGRESS_FILE, files[PROGRESS_FILE], caseNo, events);
  }
});

test(`fuzz: the same seed renders the same bytes twice (determinism)`, () => {
  const render = () => {
    const rand = rng(SEED);
    const out = [];
    for (let i = 0; i < 50; i++) {
      const events = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => hostileEvent(rand));
      const { files } = renderProjections({ events });
      out.push(files[STATE_FILE], files[PROGRESS_FILE]);
    }
    return out.join('|');
  };
  assert.equal(render(), render());
});

test('fuzz: non-object and malformed lines are counted, never rendered', () => {
  const rand = rng(SEED + 1);
  const events = [
    null,
    'a string line',
    42,
    ['an', 'array'],
    hostileEvent(rand),
  ];
  const { files, state } = renderProjections({ events, badLines: [3], truncatedTail: true });
  assert.equal(state.malformed, 4);
  checkDocument(STATE_FILE, files[STATE_FILE], 'malformed', events);
  checkDocument(PROGRESS_FILE, files[PROGRESS_FILE], 'malformed', events);
});
