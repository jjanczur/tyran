#!/usr/bin/env node
/**
 * pre-compact — the state survives the compaction that is about to erase it.
 *
 * ## The product question, and the argument for the answer
 *
 * `PreCompact` CAN refuse: it is one of the events whose `decision: "block"`
 * the platform honours. So the question is real — should a compaction with no
 * recorded checkpoint be REFUSED, or should the hook WRITE the checkpoint and
 * let it through? The answer here is **write and pass**, and it is not a
 * default. Four reasons, in the order that decided it.
 *
 * **1. Compaction is not a dangerous act. It is a LOSSY one.** Every other
 * gate in this plugin stands in front of something irreversible done to the
 * outside world — a secret published, a report accepted without evidence. A
 * compaction damages only the session's own memory of itself. The correct
 * response to lossy is to PERSIST FIRST, not to forbid; refusing would leave
 * the state exactly as unsaved as it was.
 *
 * **2. Refusing an automatic compaction wedges the session.** Measured: the
 * input carries `trigger: "manual" | "auto"`. An `auto` compaction fires
 * because the context is full — it is the platform's own memory management,
 * not a user's choice. Blocking it does not buy time to save anything; it
 * removes the mechanism that lets the conversation continue at all, and the
 * user's remaining options are to abandon the session or to uninstall the
 * plugin. ADR-19's rule applies exactly: a refusal with no reachable way
 * forward produces an agent — or a person — who looks for a way around.
 *
 * **3. Writing CLOSES the loop; refusing breaks it.** The checkpoint written
 * here is read back automatically: after the compaction the platform raises
 * `SessionStart` with `source: "compact"`, which this plugin already matches
 * (`startup|resume|compact`), and the session-start probe injects the state
 * back into the fresh context. Persisting is not a consolation prize for not
 * blocking — it is the mechanism that makes compaction survivable, and it is
 * strictly better than a block, which would preserve nothing.
 *
 * **4. The block is kept for the ONE case where passing is worse.** If a
 * journal exists and the checkpoint CANNOT be written, state is about to be
 * lost silently — the failure this whole project is built to remove. There
 * the hook refuses, but only on `trigger: "manual"`: the user asked for the
 * compaction, is present, and can act on the reason. On `auto` it never
 * refuses, for reason 2, and says so loudly on stderr instead. Asymmetric on
 * purpose, and the asymmetry is the argument, not an omission.
 *
 * When there is no journal to write to at all — not a Tyran repository, or no
 * initiative yet — it passes in silence. There is nothing to lose, and a gate
 * that fires where it has no business is a gate that gets switched off.
 *
 * ## The output shape, which is the way this gate dies if it is wrong
 *
 * `PreCompact` has NO `hookSpecificOutput` variant (measured: the union is
 * keyed on `hookEventName` and there is no member for it). Emitting one fails
 * the platform's schema, the WHOLE output is discarded, and the refusal
 * becomes an approval. This gate therefore refuses through top-level
 * `decision` + `reason`, which `hook-io.refusalPayload` selects from its event
 * table — this file never builds the payload itself, and a test asserts that
 * no `hookSpecificOutput` appears on the wire.
 */
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { append } from '../../scripts/journal.mjs';
import { forJournal, locateJournal } from './evidence-gate.mjs';
import { resolveRepoRoot } from './session-start.mjs';
import { PASS, field, main, runGate } from './hook-io.mjs';

/**
 * This gate's own budget, below the `timeout` its hooks.json entry declares.
 *
 * The number is inherited from a measured constraint rather than chosen:
 * `journal.append` takes a cross-process mutex that waits up to 5 000 ms for a
 * contended lock, and it waits SYNCHRONOUSLY (`Atomics.wait`). Nothing on this
 * thread runs during that wait, so the runtime's deadline timer cannot fire —
 * the one case `hook-io` documents as unenforceable. The budget is therefore
 * sized to CONTAIN the worst case the lock itself bounds, not to be woken by a
 * timer that cannot run. Same reasoning, and the same 8 000 ms, as the
 * evidence gate, which reached it first.
 *
 * The contention is real here rather than hypothetical: hooks matched to one
 * event run in parallel, and every other journal writer in this plugin takes
 * the same lock.
 */
export const DEADLINE_MS = 8000;

/** What the resumed session is told to do first. Short: long lists go unread. */
const NEXT_STEPS = Object.freeze([
  're-read .tyran/state/<initiative>/STATE.md — the context before this point is gone',
  'check open leases and open spawns before starting anything new',
  'continue from the last recorded checkpoint, not from memory of this conversation',
]);

/**
 * The `checkpoint` event for this compaction.
 *
 * `checkpoint` is an existing member of the closed event set and it fits
 * without stretching: it means "a deliberate pause", and a compaction is
 * exactly that — the session stops carrying its own history. No new event type
 * is invented here; that would be an escalation, not a decision.
 *
 * `trigger` and `custom_instructions` come from the platform and are recorded
 * through `forJournal`: `custom_instructions` is free text a USER typed into
 * `/compact`, so it is foreign text on its way into our own state file and it
 * gets the same bounding and escaping as any other.
 */
export function checkpointEvent(init, trigger, customInstructions) {
  const data = {
    phase: 'context-compaction',
    next_steps: [...NEXT_STEPS],
    trigger: forJournal(trigger ?? 'unknown'),
    written_by: 'pre-compact hook',
  };
  if (typeof customInstructions === 'string' && customInstructions !== '') {
    data.custom_instructions = forJournal(customInstructions);
  }
  return { ev: 'checkpoint', init, actor: 'pre-compact-hook', data };
}

/**
 * A trigger this gate will treat as user-initiated.
 *
 * Anything it does not recognise — including the field being absent, which the
 * schema says cannot happen but which costs nothing to survive — is treated as
 * `auto`. That is the direction that cannot wedge a session, and choosing the
 * safe direction for an unknown value is the opposite of the fail-open habit
 * this project fights: here the DANGEROUS action is refusing, not passing.
 */
export function isManual(trigger) {
  return trigger === 'manual';
}

/**
 * The verdict, with every edge injected so the whole decision is testable.
 *
 * `write` throws on failure; that is the signal the checkpoint did not land.
 */
export function decide(input, { locate = locateJournal, write = append, warn = () => {} } = {}) {
  const trigger = field(input, 'trigger');
  const repoRoot = resolveRepoRoot(input);
  const journal = locate(repoRoot ?? '');

  if (journal.file === null) {
    // Nothing to lose. Silence is correct: a gate that speaks where it has no
    // business is a gate the user turns off before it ever matters.
    return PASS;
  }

  try {
    write(journal.file, checkpointEvent(journal.init, trigger, field(input, 'custom_instructions')));
    return PASS;
  } catch (err) {
    const detail = String(err?.message ?? err);
    // Contention and damage need OPPOSITE advice, and telling a user to
    // validate a healthy journal is a false remedy — the failure class this
    // project calls "a refusal with no reachable way forward". journal.mjs
    // throws a distinct message when the cross-process mutex times out, which
    // means another writer holds it right now and the file itself is fine.
    const contended = /journal lock timeout/.test(detail);
    if (!isManual(trigger)) {
      // Never refuse an automatic compaction — see reason 2 in the header.
      // Loud on stderr, which reaches the transcript, instead of silent.
      warn(
        `tyran pre-compact: could not write a checkpoint before an automatic compaction ` +
          `(${detail}). The compaction is going ahead because refusing an automatic one would ` +
          `stop the session entirely. State recorded up to the last successful write survives; ` +
          `anything since then does not.`,
      );
      return PASS;
    }
    return {
      decision: 'deny',
      reason:
        'tyran pre-compact: refusing this /compact because the checkpoint could not be written ' +
        `(${detail}).\n\n` +
        'Compacting now would discard the part of this session that is not in the journal, and ' +
        'nothing would say that it happened. You asked for this compaction, so you can act on it.\n\n' +
        (contended
          ? '  Another agent holds the journal lock right now. The journal is HEALTHY — it is busy.\n' +
            '  Wait a moment and run /compact again; there is nothing to repair.\n'
          : `  node scripts/journal.mjs validate ${journal.file}\n`) +
        '\nAn AUTOMATIC compaction is never refused for this reason — stopping one would end the ' +
        'session rather than protect it.',
    };
  }
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
      event: 'PreCompact',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) =>
        decide(input, { warn: (text) => process.stderr.write(text + '\n') }),
    }),
  );
}
