#!/usr/bin/env node
/**
 * retro-gate — the self-improvement loop stops depending on anyone remembering.
 *
 * The retrospective is the only mechanism by which Tyran gets better at YOUR
 * repo instead of repeating the same mistake every initiative. It is also,
 * for exactly that reason, the step most likely to be skipped: it happens
 * after the work is done, after the merge, when the interesting part is over
 * and the operator has already read the final report. A rule in prose saying
 * "close an initiative by running the retro" is precisely the shape of rule
 * this project exists because it distrusts.
 *
 * So this gate makes the ending mechanical. On `Stop`, if the journal shows
 * an initiative whose tickets are ALL merged and no retrospective has been
 * recorded since the last merge, the stop is refused once, with a reason that
 * names the initiative and what to run.
 *
 * ## Why this cannot loop
 *
 * The platform sets `stop_hook_active` when a Stop hook has already caused
 * the model to continue. This gate returns PASS the moment it sees that flag,
 * so the worst case is exactly ONE extra turn. An agent that declines to run
 * the retro stops normally on the next attempt. A gate that could hold a
 * session open indefinitely would be worse than the problem it solves — and
 * it would be switched off, taking the other five gates with it.
 *
 * ## Why it is a nudge and not a wall
 *
 * It FAILS OPEN on everything: no journal, an unreadable journal, a corrupt
 * line, an initiative it cannot interpret. Being unable to prove a retro is
 * owed is not evidence that one is owed. The cost matrix is lopsided: a
 * missed nudge costs one deferred retrospective, while a false refusal
 * blocks a completed initiative from ending and teaches the operator to
 * distrust every gate in the plugin.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readJournal } from '../../scripts/journal.mjs';
import { escapeInvisible } from '../../scripts/invisible.mjs';
import { locateJournal, resolveRepoRoot, forJournal } from './evidence-gate.mjs';
import { PASS, field, main, runGate } from './hook-io.mjs';

/**
 * Well under the 10s declared in hooks.json. The gate reads one bounded file
 * and folds it; anything slower than this means the journal is not the shape
 * we think it is, and a late verdict is discarded anyway (ADR-22).
 */
export const DEADLINE_MS = 4000;

/**
 * Ceiling on how many initiatives are examined.
 *
 * A repo with hundreds of closed initiatives must not turn every `Stop` into
 * a linear scan of all of them. Past this count the gate declines to judge —
 * failing open, like every other uncertainty here.
 */
export const MAX_INITIATIVES_CONSIDERED = 50;

/**
 * Decide whether a retrospective is owed, from journal events alone.
 *
 * Returns `{owed: false, why}` or `{owed: true, init, tickets, lastMerge}`.
 *
 * An initiative owes a retro when ALL of these hold:
 *  - at least one ticket was created (an initiative with no tickets is a
 *    conversation, not a body of work worth retrospecting);
 *  - every created ticket has a `merge` event (the work is actually done —
 *    an abandoned initiative must not nag);
 *  - no `retro.entry` was recorded at or after the last merge. Anchoring on
 *    the LAST MERGE rather than on "any retro ever" is what makes this work
 *    for a repo that runs many initiatives: an old retrospective must not
 *    satisfy a new initiative.
 */
export function judgeRetro(events) {
  if (!Array.isArray(events) || events.length === 0) return { owed: false, why: 'no-events' };

  const byInit = new Map();
  for (const e of events) {
    if (typeof e?.init !== 'string' || e.init.length === 0) continue;
    if (!byInit.has(e.init)) {
      if (byInit.size >= MAX_INITIATIVES_CONSIDERED) return { owed: false, why: 'too-many-initiatives' };
      byInit.set(e.init, { created: new Set(), merged: new Set(), lastMerge: null, lastRetro: null });
    }
    const bucket = byInit.get(e.init);
    const ts = typeof e.ts === 'string' ? e.ts : null;
    if (e.ev === 'ticket.created' && typeof e.data?.id === 'string') bucket.created.add(e.data.id);
    else if (e.ev === 'merge' && typeof e.data?.ticket === 'string') {
      bucket.merged.add(e.data.ticket);
      if (ts !== null && (bucket.lastMerge === null || ts > bucket.lastMerge)) bucket.lastMerge = ts;
    } else if (e.ev === 'retro.entry' && ts !== null && (bucket.lastRetro === null || ts > bucket.lastRetro)) {
      bucket.lastRetro = ts;
    }
  }

  // Most recently merged initiative first: if several are owed, nagging about
  // the freshest one is the only ordering that is not arbitrary.
  const candidates = [...byInit.entries()]
    .filter(([, b]) => b.created.size > 0 && b.lastMerge !== null)
    .filter(([, b]) => [...b.created].every((id) => b.merged.has(id)))
    .filter(([, b]) => b.lastRetro === null || b.lastRetro < b.lastMerge)
    .sort((a, b) => (a[1].lastMerge < b[1].lastMerge ? 1 : -1));

  if (candidates.length === 0) return { owed: false, why: 'nothing-owed' };
  const [init, bucket] = candidates[0];
  return { owed: true, init, tickets: bucket.created.size, lastMerge: bucket.lastMerge };
}

/** The refusal text. Names the initiative, the run, and how to decline. */
export function buildReason({ init, tickets }) {
  return (
    `tyran: initiative "${escapeInvisible(init)}" has all ${tickets} of its tickets merged and no ` +
    'retrospective recorded since the last merge.\n' +
    '\n' +
    'Run it before you finish: spawn the `tyran:retro` agent over this ' +
    'initiative. It reads the ledger, the notes and the agents reports, and ' +
    'improves Tyran itself — never product code.\n' +
    '\n' +
    'This is the only loop through which Tyran learns from an initiative ' +
    'instead of repeating it, and it is the step most easily skipped, which ' +
    'is why it is a gate rather than a sentence in a skill.\n' +
    '\n' +
    'Deciding NOT to run one is a legitimate answer — a retro that finds ' +
    'nothing worth changing is a correct outcome, and so is judging the work ' +
    'too small to be worth one. Record that decision in the journal as a ' +
    '`retro.entry` with kind "skipped" and the reason, and this will not ask ' +
    'again. You will not be blocked twice either way.'
  );
}

export function apply(input, { locate = locateJournal, read = readJournal } = {}) {
  // The loop guard comes FIRST, before any filesystem work: whatever else is
  // true, a second consecutive block is not allowed to happen.
  if (field(input, 'stop_hook_active') === true) return PASS;

  const repoRoot = resolveRepoRoot(input);
  if (repoRoot === null) return PASS;

  let journal;
  try {
    journal = locate(repoRoot);
  } catch {
    return PASS;
  }
  if (journal?.file === null || journal?.file === undefined) return PASS;

  let events;
  try {
    events = read(journal.file);
  } catch {
    return PASS;
  }
  // `readJournal` returns a report object in this codebase, not a bare array.
  const list = Array.isArray(events) ? events : (events?.events ?? []);

  let verdict;
  try {
    verdict = judgeRetro(list);
  } catch {
    return PASS;
  }
  if (!verdict.owed) return PASS;

  return { decision: 'deny', reason: buildReason({ init: forJournal(verdict.init), tickets: verdict.tickets }) };
}

/** See journal.mjs — both sides canonicalized, or a symlinked path no-ops. */
function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) {
  await main(() =>
    runGate({
      event: 'Stop',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => apply(input),
    }),
  );
}
