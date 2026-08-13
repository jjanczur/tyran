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
  // the 17-event set's additions
  'state', 'column', 'area', 'claim', 'proof', 'next',
];

/**
 * Two of those keys are CORRELATORS rather than free text, and a hostile string
 * never matches a correlator: an Open-blockages row opens only on the exact
 * value `blocked`, and a Last-signal cell needs a `spawn` and a `progress`
 * naming ONE agent with no report in between. Drawn from `hostileValue` alone,
 * both tables were rendered only in their EMPTY shape — measured at 0 rows in
 * all 300 cases — so an unescaped `b.detail` or `signal.state` would have gone
 * unnoticed by the very fuzz that claims to cover them.
 *
 * The pools restore the reach without softening the payload: every agent name
 * here is itself a hostile fragment that `journal.agentNameProblem` accepts as
 * a correlator. One name is drawn PER CASE, not per event — a case is one
 * journal, one journal is one initiative, and drawing per event left the reach
 * to chance (measured: a spawn and a progress agreed on a name in 0 of 300
 * cases, the mulberry32 counter sampled at a near-constant stride). The
 * coverage counters below fail if the reach is ever lost again.
 */
const PROGRESS_STATES = ['blocked', 'working', 'started', 'unblocked'];
const AGENT_NAMES = [
  '| injected | columns |',
  '<script>alert(1)</script>',
  '![beacon](https://evil.example/leak.png)',
];

const pick = (rand, pool) => pool[Math.floor(rand() * pool.length)];

/**
 * The four types that correlate with EACH OTHER by agent name. Drawn uniformly
 * from all 17, a `spawn` and a `progress` land in one case (1-6 events) about
 * twice in 300 — so one event in five comes from here instead. The 12.5% below
 * keeps the unknown-event-type rate at the 10% overall it has always been.
 */
const LIFECYCLE_TYPES = ['spawn', 'progress', 'report', 'review'];

function hostileType(rand) {
  if (rand() < 0.2) return pick(rand, LIFECYCLE_TYPES);
  return rand() < 0.875 ? pick(rand, EVENT_TYPES) : hostileString(rand);
}

function hostileEvent(rand, agent = AGENT_NAMES[0]) {
  const ev = hostileType(rand);
  const data = {};
  const keys = 1 + Math.floor(rand() * 5);
  for (let i = 0; i < keys; i++) data[DATA_KEYS[Math.floor(rand() * DATA_KEYS.length)]] = hostileValue(rand);
  // The events that OPEN state get the case's agent four times in five, on the
  // key they correlate by (`data.by` for a review, `data.agent` for the rest);
  // the events that CLOSE it get it half as often, because a closed spawn
  // renders no Last-signal cell at all and a closed blockage no row. The
  // remaining draws keep the fully hostile shape, where those keys hold
  // arbitrary JSON.
  const opens = ev === 'spawn' || ev === 'progress';
  const closes = ev === 'report' || ev === 'review';
  if ((opens && rand() < 0.8) || (closes && rand() < 0.4)) {
    if (ev === 'review') data.by = agent;
    else data.agent = agent;
  }
  // `blocked` gets half the draws on its own: it is the only value that OPENS
  // an Open-blockages row, and the other three exist to close one.
  if (ev === 'progress' && rand() < 0.8) {
    data.state = rand() < 0.5 ? 'blocked' : pick(rand, PROGRESS_STATES);
  }
  return {
    ts: rand() < 0.9 ? '2026-01-01T00:00:0' + Math.floor(rand() * 10) + '.000Z' : hostileString(rand),
    ev,
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

/** The data rows of one `## <heading>` table — no header, no separator. */
function tableRows(markdown, heading) {
  const section = (markdown.split(`\n## ${heading}\n`)[1] ?? '').split('\n## ')[0];
  return section
    .split('\n')
    .filter((l) => l.startsWith('|') && !/^\|[-|]+\|$/.test(l))
    .slice(1);
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
  const reached = { blockageRow: 0, signalCell: 0, findingRow: 0, overrideStatus: 0 };
  for (let caseNo = 0; caseNo < CASES; caseNo++) {
    // one case is one journal, so one agent name (see AGENT_NAMES)
    const agent = pick(rand, AGENT_NAMES);
    const events = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => hostileEvent(rand, agent));
    const { files, warnings } = renderProjections({ events });
    checkDocument(STATE_FILE, files[STATE_FILE], caseNo, events);
    checkDocument(PROGRESS_FILE, files[PROGRESS_FILE], caseNo, events);
    checkWarnings(warnings, caseNo, events);

    const state = files[STATE_FILE];
    reached.blockageRow += tableRows(state, 'Open blockages').length;
    reached.findingRow += tableRows(state, 'Findings').length;
    // the Last signal cell is the last column of the Agents table
    reached.signalCell += tableRows(state, 'Agents').filter((r) => r.split('|').at(-2).trim() !== '&mdash;').length;
    reached.overrideStatus += tableRows(state, 'Ledger').filter((r) => r.includes('(set by ticket.status)')).length;
  }
  // COVERAGE, not decoration: a fuzz is worth exactly the branches it reaches,
  // and each of these four was rendered zero times until the generator learned
  // to produce correlators. A future edit that loses one fails HERE, loudly,
  // instead of quietly reducing this file to a test of empty tables.
  for (const [branch, hits] of Object.entries(reached)) {
    assert.ok(hits > 0, `no case rendered ${branch} — the hostile payload never reached that branch`);
  }
});

/**
 * The two cells whose content the random corpus cannot make hostile.
 *
 * A blockage row exists only while `data.state` is exactly `blocked`, and the
 * Last-signal cell renders the state of the LAST progress event — so the fuzz
 * reaches both branches (the counters above prove it) but fills the state cell
 * with a correlator every time. Rendering `signal.state` raw therefore survived
 * all 300 cases. Directed and deterministic, like the malformed-lines case:
 * one agent blocked with a hostile detail, one agent whose latest signal IS a
 * hostile payload, and every field around them hostile too.
 */
test('directed: hostile payloads inside a blockage row and a Last-signal cell', () => {
  const [blockedAgent, movingAgent] = AGENT_NAMES;
  for (const payload of HOSTILE) {
    const label = `directed ${JSON.stringify(payload)}`;
    const events = [
      { ts: '2026-01-01T00:00:00.000Z', ev: 'spawn', init: payload, actor: payload,
        data: { agent: blockedAgent, role: payload, model: payload, ticket: payload, worktree: payload } },
      { ts: '2026-01-01T00:00:01.000Z', ev: 'spawn', init: 'demo', actor: payload,
        data: { agent: movingAgent, role: payload } },
      { ts: '2026-01-01T00:00:02.000Z', ev: 'progress', init: 'demo', actor: payload,
        data: { agent: blockedAgent, state: 'blocked', ticket: payload, detail: payload, next: payload } },
      { ts: payload, ev: 'progress', init: 'demo', actor: payload,
        data: { agent: movingAgent, state: payload, detail: payload } },
    ];
    const { files, warnings } = renderProjections({ events });
    const state = files[STATE_FILE];
    assert.equal(tableRows(state, 'Open blockages').length, 1, `no blockage row — ${label}`);
    const signals = tableRows(state, 'Agents').map((r) => r.split('|').at(-2).trim());
    assert.equal(signals.filter((s) => s !== '&mdash;').length, 2, `no Last-signal cell — ${label}`);
    checkDocument(STATE_FILE, state, label, events);
    checkDocument(PROGRESS_FILE, files[PROGRESS_FILE], label, events);
    checkWarnings(warnings, label, events);
  }
});

/**
 * STDERR is an output channel and this fuzz did not sweep it — which is
 * precisely why it leaked. A security review built a journal whose `init` and
 * `ev` carried a right-to-left override and 18 TAG characters, and got 37
 * invisible codepoints onto the operator's terminal with a reconstructable
 * "DELETE THE JOURNAL" inside them, while these 300 cases stayed green.
 *
 * A fuzz is worth exactly the channels it enumerates. Table integrity and
 * angle brackets do not apply to a log line, but "nothing invisible reaches a
 * reader" and "one warning is one line" both do.
 */
function checkWarnings(list, caseNo, events) {
  const context = () => `case ${caseNo} (seed ${SEED}) warnings\nevents: ${JSON.stringify(events)}`;
  for (const w of list) {
    assert.deepEqual(
      scanText(w).map((f) => `${formatCodePoint(f.codePoint)}`),
      [],
      `raw control/bidi character reached a WARNING — ${context()}`,
    );
    assert.ok(!w.includes('\n'), `a warning spans two lines, so half of it will look like tool output — ${context()}`);
  }
}

test(`fuzz: the same seed renders the same bytes twice (determinism)`, () => {
  const render = () => {
    const rand = rng(SEED);
    const out = [];
    for (let i = 0; i < 50; i++) {
      const events = Array.from({ length: 1 + Math.floor(rand() * 6) }, () => hostileEvent(rand, pick(rand, AGENT_NAMES)));
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
  const { files, state, warnings } = renderProjections({ events, badLines: [3], truncatedTail: true });
  assert.equal(state.malformed, 4);
  checkDocument(STATE_FILE, files[STATE_FILE], 'malformed', events);
  checkDocument(PROGRESS_FILE, files[PROGRESS_FILE], 'malformed', events);
  checkWarnings(warnings, 'malformed', events);
});
