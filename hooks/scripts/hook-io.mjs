/**
 * hook-io — the runtime every Tyran hook runs inside.
 *
 * This is not a stdin parser. It is a security component, because of one
 * measured property of the platform (ADR-22): **Claude Code fails OPEN.**
 * A hook that crashes, times out, prints garbage, or is missing entirely
 * does not block anything — the action proceeds with a small "hook error"
 * note. So the worse a gate behaves, the less it gates. An attacker does
 * not need to defeat a gate's logic; breaking the gate is enough.
 *
 * Everything below exists to remove the ways a gate can fail quietly.
 *
 * Measured against the local install (v2.1.116, binary disassembled at
 * `hooks/HOOK-CONTRACT-MEASURED.md`), not assumed:
 *
 *  - stdout that does not parse as the hook-output schema is discarded and
 *    the action proceeds. Our JSON must always be valid AND schema-shaped.
 *  - `hookSpecificOutput.hookEventName` must EQUAL the event that fired, or
 *    the platform throws while reading our output — which fails open.
 *  - `hookSpecificOutput` has no variant for Stop / SubagentStop /
 *    PreCompact / TaskCompleted. Emitting one there fails the schema, so
 *    those events refuse through top-level `decision` + `reason` instead.
 *    Two shapes, one call site: `deny(reason)`.
 *  - the 10 000 limit is applied as `String.prototype.length`, i.e. UTF-16
 *    code units, so that is what we count.
 *  - `permissionDecision: "allow"` is NOT "no objection" — it AUTO-APPROVES
 *    the tool call and skips the permission prompt. There is deliberately no
 *    way to emit it from this runtime; see `PASS`.
 */
import { writeSync } from 'node:fs';

import { FORBIDDEN, formatCodePoint } from '../../scripts/scan-control-chars.mjs';

/**
 * The platform's cap on hook stdout and on `additionalContext`, measured as
 * `text.length <= 10000` — UTF-16 code units, not code points. Oversize
 * output is not rejected: it is persisted to a temp file and replaced by a
 * reference, which for injected context means the content silently stops
 * being context. Staying under the limit is the only way to stay read.
 */
export const OUTPUT_LIMIT = 10000;

/** Refuse absurd stdin rather than buffering it. 1 MB is ~100x a real payload. */
export const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * What each event can do — a property of the TYPE, not of a comment.
 *
 * `canBlock: false` events are probes: the platform gives them no way to
 * refuse. Registering a gate on one produces a control that looks like it
 * works and cannot say no, which is the most dangerous defect this system
 * can contain, so `runGate` refuses the registration outright.
 *
 * `refusal` names the OUTPUT SHAPE, which differs per event and is checked
 * by the platform's schema:
 *   'permissionDecision' -> hookSpecificOutput.permissionDecision = 'deny'
 *   'decision'           -> top-level decision:'block' + reason
 *
 * `context` says whether the event accepts `hookSpecificOutput.additional-
 * Context`. Where it is null the platform's schema has no variant for the
 * event and emitting one makes the whole output invalid (fail open).
 *
 * Prototype-free, so an event called `constructor` cannot resolve to an
 * inherited member (same reason as doctor.mjs SEVERITY_BY_CODE).
 */
export const EVENTS = Object.freeze(
  Object.assign(Object.create(null), {
    // Gates — refusal is the product.
    PreToolUse: Object.freeze({ canBlock: true, refusal: 'permissionDecision', context: true }),
    UserPromptSubmit: Object.freeze({ canBlock: true, refusal: 'decision', context: true }),
    Stop: Object.freeze({ canBlock: true, refusal: 'decision', context: false }),
    SubagentStop: Object.freeze({ canBlock: true, refusal: 'decision', context: false }),
    PreCompact: Object.freeze({ canBlock: true, refusal: 'decision', context: false }),
    TaskCompleted: Object.freeze({ canBlock: true, refusal: 'decision', context: false }),
    // Probes — injection or record only; refusal is impossible.
    SessionStart: Object.freeze({ canBlock: false, refusal: null, context: true }),
    SubagentStart: Object.freeze({ canBlock: false, refusal: null, context: true }),
    PostToolUse: Object.freeze({ canBlock: false, refusal: null, context: true }),
    Notification: Object.freeze({ canBlock: false, refusal: null, context: true }),
    SessionEnd: Object.freeze({ canBlock: false, refusal: null, context: false }),
  }),
);

/** True for an event this runtime knows how to answer. */
export function isKnownEvent(name) {
  return typeof name === 'string' && Object.hasOwn(EVENTS, name);
}

/** True for an event on which a refusal is possible at all. */
export function canBlock(name) {
  return isKnownEvent(name) && EVENTS[name].canBlock === true;
}

/**
 * Registering a gate on an event that cannot refuse. Its own class because
 * it must be assertable in a test: this is the failure that produces a
 * control which passes review and cannot say no.
 */
export class GateOnProbeEventError extends Error {
  constructor(event) {
    super(
      `cannot register a gate on "${event}": the platform gives this event no way to refuse. ` +
        'Move the check to PreToolUse, SubagentStop, Stop, PreCompact, UserPromptSubmit or ' +
        'TaskCompleted, or declare it a probe with runProbe().',
    );
    this.name = 'GateOnProbeEventError';
    this.event = event;
  }
}

/** An input this runtime refused to trust. `errorClass` reaches the operator. */
export class HookInputError extends Error {
  constructor(errorClass, message, fix) {
    super(message);
    this.name = 'HookInputError';
    this.errorClass = errorClass;
    this.fix = fix;
  }
}

// ------------------------------------------------------------ sanitization

/**
 * Codepoints this runtime refuses to echo, taken from the SAME table the CI
 * scanner enforces. Deliberately imported rather than restated: ADR-19's own
 * correction found THREE spellings of this rule already in the repo, and the
 * outermost one was the weakest. When that list grows, this grows with it.
 */
function isForbidden(cp) {
  for (const range of FORBIDDEN) {
    if (cp >= range.lo && cp <= range.hi) return true;
  }
  return false;
}

/**
 * Everything that reaches our stdout passes through here first.
 *
 * `tool_input` is written by the model and by repo content, and a refusal
 * reason quotes it back. Without this, a gate's own denial message is an
 * injection channel into the transcript: an unterminated bidi override in a
 * quoted path reverses everything the operator reads after it, and a NUL
 * makes the surrounding text invisible to every tool that greps it later.
 *
 * Forbidden codepoints become their ESCAPE NOTATION, not nothing. Silent
 * removal would make a poisoned string and a clean one render identically —
 * the same class of defect as a silent exemption in the scanner.
 */
export function sanitizeForOutput(value) {
  const text = typeof value === 'string' ? value : String(value);
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    out += isForbidden(cp) ? `<${formatCodePoint(cp)}>` : ch;
  }
  return out;
}

// ---------------------------------------------------------------- payloads

/** The refusal payload for `event`, in the shape that event's schema accepts. */
export function refusalPayload(event, reason) {
  const meta = EVENTS[event];
  if (meta === undefined || meta.refusal === null) {
    throw new GateOnProbeEventError(String(event));
  }
  if (meta.refusal === 'permissionDecision') {
    return {
      hookSpecificOutput: {
        hookEventName: event,
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    };
  }
  return { decision: 'block', reason };
}

/** The context-injection payload for `event`, or `{}` where it accepts none. */
export function contextPayload(event, additionalContext) {
  const meta = EVENTS[event];
  if (meta === undefined || meta.context !== true) return {};
  return { hookSpecificOutput: { hookEventName: event, additionalContext } };
}

/**
 * `PASS` is "I have no objection", and it is an EMPTY object on purpose.
 *
 * The obvious spelling would be `permissionDecision: "allow"`, and it would
 * be a serious bug: measured in the platform, `allow` does not mean "this
 * gate is satisfied", it means "approve this tool call and skip the
 * permission prompt". A gate whose only job is to look for secrets would
 * then be silently auto-approving every command it happened not to object
 * to. There is no way to emit `allow` from this runtime, and a test pins
 * that.
 */
export const PASS = Object.freeze({ decision: 'pass' });

// --------------------------------------------------------------- truncation

const TRUNCATION_NOTE = (omitted, total) =>
  `\n[tyran hook-io: output truncated to fit the platform's ${OUTPUT_LIMIT}-character limit; ` +
  `${omitted} of ${total} characters omitted]`;

/** UTF-16 length of the serialized payload — the unit the platform counts. */
function serializedLength(payload) {
  return JSON.stringify(payload).length;
}

/**
 * Fit `text` into `build(text)` so the SERIALIZED payload stays under the
 * platform limit, deterministically and audibly.
 *
 * Two properties matter more than the arithmetic:
 *
 *  - it clamps the SERIALIZED form, not the raw string. JSON escaping can
 *    triple a length, so a reason measured before encoding sails past the
 *    limit after it and the whole output is discarded (fail open).
 *  - what is left always SAYS it was cut, and by how much. A quietly
 *    shortened state file is the same defect as a quietly skipped file in
 *    ADR-19: the reader has no way to know the thing they are trusting is
 *    partial.
 *
 * Cuts land on code-point boundaries, so a truncated payload can never end
 * in half a surrogate pair (which would make the JSON lone-surrogate and
 * unparseable — fail open again).
 */
export function clampPayload(build, text, limit = OUTPUT_LIMIT) {
  const full = build(text);
  if (serializedLength(full) <= limit) return { payload: full, omitted: 0 };

  const points = [...text];
  const total = points.length;
  const fits = (keep) =>
    serializedLength(build(points.slice(0, keep).join('') + TRUNCATION_NOTE(total - keep, total))) <=
    limit;

  // Adding one kept code point never shortens the result by more than the
  // one digit the omission counter may lose, so the predicate is monotone
  // and a binary search is exact rather than approximate.
  let lo = 0;
  let hi = total;
  if (!fits(0)) {
    // Even the note alone does not fit: the envelope itself is oversized.
    // Say so in the smallest possible words rather than emitting nothing.
    return { payload: build(`[tyran hook-io: output too large to report]`), omitted: total };
  }
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return {
    payload: build(points.slice(0, lo).join('') + TRUNCATION_NOTE(total - lo, total)),
    omitted: total - lo,
  };
}

// -------------------------------------------------------------------- input

/**
 * Read all of stdin, refusing rather than buffering an unbounded payload.
 * A stream that never ends is handled by the caller's deadline, not here.
 */
export async function readStdin(stream, { maxBytes = MAX_INPUT_BYTES } = {}) {
  if (stream === undefined || stream === null) return '';
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    size += buf.length;
    if (size > maxBytes) {
      throw new HookInputError(
        'input-too-large',
        `hook input exceeded ${maxBytes} bytes`,
        'this hook reads whole tool inputs; if a legitimate payload is this large, raise MAX_INPUT_BYTES deliberately',
      );
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Parse hook input. Every rejection carries a class, because "the gate said
 * no" without saying which way it broke is unfixable in production.
 */
export function parseHookInput(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new HookInputError(
      'empty-input',
      'hook received no input on stdin',
      'the platform always writes a JSON object to a hook stdin; an empty read means the hook was invoked by something else',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HookInputError(
      'malformed-json',
      `hook input is not valid JSON: ${err.message}`,
      'check whether a wrapper script is writing to stdout on the way in',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HookInputError(
      'not-an-object',
      `hook input parsed to ${Array.isArray(parsed) ? 'an array' : typeof parsed}, not an object`,
      'the hook contract is a single JSON object',
    );
  }
  return parsed;
}

/**
 * Own-property read. `JSON.parse` puts a `__proto__` key on the object as an
 * own property rather than walking the prototype chain, but every OTHER
 * lookup on that object still consults `Object.prototype` — so a payload
 * with no `tool_name` at all would otherwise resolve `constructor` or
 * `toString` to a function and let a gate compare against it.
 */
export function field(object, name) {
  if (object === null || typeof object !== 'object') return undefined;
  return Object.hasOwn(object, name) ? object[name] : undefined;
}

/**
 * The event whose shape our answer must take.
 *
 * The platform throws if `hookSpecificOutput.hookEventName` differs from the
 * event it fired, and that throw is caught upstream as "hook failed" — i.e.
 * it fails open. The input's `hook_event_name` is written by the platform
 * itself, so it is the more reliable of the two names; the declared event is
 * the fallback for input we could not read at all. A gate always answers in
 * a shape that can refuse, so a probe name never wins here.
 */
export function resolveEvent(declared, fromInput, { mustBlock }) {
  if (isKnownEvent(fromInput)) {
    if (!mustBlock || EVENTS[fromInput].canBlock) return fromInput;
  }
  return declared;
}

// ------------------------------------------------------------------ runners

function defaultIo() {
  return {
    stdin: process.stdin,
    write: (text) => writeSync(1, text),
    warn: (text) => writeSync(2, text),
    exit: (code) => process.exit(code),
    onExit: (cb) => {
      process.on('exit', cb);
      return () => process.removeListener('exit', cb);
    },
  };
}

function describeError(err) {
  if (err instanceof HookInputError) {
    return { errorClass: err.errorClass, message: err.message, fix: err.fix };
  }
  if (err instanceof Error) {
    return {
      errorClass: err.constructor?.name ?? 'Error',
      message: err.message,
      fix: 'this is a bug in the hook, not in the input; the stack is in the transcript',
    };
  }
  return {
    errorClass: 'non-error-throw',
    message: String(err),
    fix: 'the handler threw a value that is not an Error',
  };
}

function refusalText({ errorClass, message, fix }) {
  return (
    `tyran refused because the gate itself could not finish.\n` +
    `error class: ${errorClass}\n` +
    `detail: ${message}\n` +
    `fix: ${fix}\n` +
    'This is a refusal, not a crash: an unfinished check must not read as approval.'
  );
}

/**
 * Run a blocking hook.
 *
 * Contract, and the whole reason this file exists:
 *
 *  1. it NEVER throws outward and never exits non-zero. Every unexpected
 *     error becomes exit 0 plus a well-formed refusal naming the error
 *     class, because every other ending is an approval;
 *  2. it refuses to be registered on an event that cannot refuse;
 *  3. it holds its OWN deadline, shorter than the one in hooks.json. The
 *     platform's timeout kills the process and DISCARDS its output, so a
 *     gate that is merely slow is a gate that approves. A gate that did not
 *     finish in time refuses on its own terms instead.
 *
 * `handler(input)` returns `PASS` or `{ decision: 'deny', reason }`.
 * Anything else is treated as a bug and refuses — an unrecognised return
 * value must not be able to mean "allow".
 */
export async function runGate({ event, handler, deadlineMs, io = defaultIo() }) {
  if (!isKnownEvent(event)) throw new GateOnProbeEventError(String(event));
  if (!EVENTS[event].canBlock) throw new GateOnProbeEventError(event);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`runGate needs a positive deadlineMs (got ${String(deadlineMs)})`);
  }

  let done = false;
  const emit = (payload) => {
    if (done) return;
    done = true;
    io.write(JSON.stringify(payload) + '\n');
    io.exit(0);
  };
  const refuse = (outEvent, info) => {
    const { payload } = clampPayload(
      (reason) => refusalPayload(outEvent, reason),
      sanitizeForOutput(refusalText(info)),
    );
    emit(payload);
  };

  /**
   * Last line of defence: the process is ending and no decision was written.
   *
   * This is not theoretical — it is how the first version of this file failed
   * its own test. The deadline timer was `unref`'d, so when a handler awaited
   * something that did not hold the event loop, Node ran out of work, exited
   * cleanly with empty stdout, and the platform read that as "hook fine,
   * proceed". An unhandled rejection reaches here the same way. Writing
   * synchronously from an `exit` listener is the only thing that still works
   * at that point, which is why the whole output path uses writeSync.
   */
  const silentExitGuard = () => {
    if (done) return;
    done = true;
    const { payload } = clampPayload(
      (reason) => refusalPayload(event, reason),
      sanitizeForOutput(
        refusalText({
          errorClass: 'exited-without-decision',
          message: 'the hook process ended before the gate produced a verdict',
          fix: 'an unhandled rejection or an empty event loop; the gate must always reach deny or pass',
        }),
      ),
    );
    io.write(JSON.stringify(payload) + '\n');
    process.exitCode = 0;
  };
  const releaseGuard = io.onExit ? io.onExit(silentExitGuard) : () => {};

  let timer = null;
  const deadline = new Promise((resolve) => {
    // Deliberately NOT unref'd: an unref'd deadline stops holding the event
    // loop, and a hook that exits without writing anything is a hook that
    // approves. The timer is cleared the moment a decision is emitted.
    timer = setTimeout(() => {
      refuse(event, {
        errorClass: 'deadline-exceeded',
        message: `the gate did not reach a decision within ${deadlineMs} ms`,
        fix: 'make the check faster, or raise deadlineMs together with the hooks.json timeout above it',
      });
      resolve();
    }, deadlineMs);
  });

  const work = (async () => {
    let outEvent = event;
    try {
      const raw = await readStdin(io.stdin);
      const input = parseHookInput(raw);
      const named = field(input, 'hook_event_name');
      outEvent = resolveEvent(event, named, { mustBlock: true });
      if (named !== undefined && named !== event) {
        throw new HookInputError(
          'event-mismatch',
          `this hook is registered for ${event} but the platform fired ${sanitizeForOutput(String(named))}`,
          'fix the event key in hooks.json; a gate answering for the wrong event is not a gate',
        );
      }
      const verdict = await handler(Object.freeze({ event: outEvent, input }));
      if (verdict === PASS || (verdict !== null && typeof verdict === 'object' && verdict.decision === 'pass')) {
        // No objection is silence, never `permissionDecision:"allow"` — see PASS.
        emit({});
        return;
      }
      if (verdict !== null && typeof verdict === 'object' && verdict.decision === 'deny') {
        const { payload } = clampPayload(
          (reason) => refusalPayload(outEvent, reason),
          sanitizeForOutput(String(verdict.reason ?? 'refused without a stated reason')),
        );
        emit(payload);
        return;
      }
      throw new Error(
        `handler returned ${JSON.stringify(verdict)}; expected PASS or { decision: 'deny', reason }`,
      );
    } catch (err) {
      refuse(outEvent, describeError(err));
    }
  })();

  await Promise.race([work, deadline]);
  if (timer !== null) clearTimeout(timer);
  releaseGuard();
  return done;
}

/**
 * Run a non-blocking hook.
 *
 * A probe has no way to refuse, so failing open here is not a compromise —
 * it is the only honest behaviour, and the cost of getting it wrong is a
 * session the user cannot start. Every failure therefore degrades to the
 * smallest valid output for the event and exit 0.
 *
 * The deadline still exists, for a different reason: a probe that hangs
 * holds up session startup until the platform kills it.
 */
export async function runProbe({ event, handler, deadlineMs, io = defaultIo() }) {
  if (!isKnownEvent(event)) throw new Error(`unknown hook event: ${String(event)}`);
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) {
    throw new Error(`runProbe needs a positive deadlineMs (got ${String(deadlineMs)})`);
  }

  let done = false;
  const emit = (payload) => {
    if (done) return;
    done = true;
    io.write(JSON.stringify(payload) + '\n');
    io.exit(0);
  };
  const note = (text) => {
    // stderr on a probe event is a transcript message, never a block.
    try {
      io.warn(`tyran ${event}: ${sanitizeForOutput(text)}\n`);
    } catch {
      /* a probe may not fail because it could not complain */
    }
  };

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => {
      note(`gave up after ${deadlineMs} ms; the session continues without injected context`);
      emit({});
      resolve();
    }, deadlineMs);
  });

  const work = (async () => {
    try {
      const raw = await readStdin(io.stdin);
      const input = parseHookInput(raw);
      const named = field(input, 'hook_event_name');
      const outEvent = resolveEvent(event, named, { mustBlock: false });
      const result = await handler(Object.freeze({ event: outEvent, input }));
      const text = typeof result === 'string' ? result : (result?.additionalContext ?? '');
      if (text === '') {
        emit({});
        return;
      }
      const { payload, omitted } = clampPayload(
        (ctx) => contextPayload(outEvent, ctx),
        sanitizeForOutput(text),
      );
      if (omitted > 0) note(`injected context truncated, ${omitted} character(s) omitted`);
      emit(payload);
    } catch (err) {
      const info = describeError(err);
      note(`${info.errorClass}: ${info.message}`);
      emit({});
    }
  })();

  await Promise.race([work, deadline]);
  if (timer !== null) clearTimeout(timer);
  return done;
}

/**
 * Entry point for a hook script's `main`. Its one job is the case `runGate`
 * cannot answer for itself: a gate declared on an event that cannot refuse.
 *
 * That throw happens before any input is read, so there is no decision to
 * emit. Exit 2 is the loudest ending available — on a blocking event it
 * blocks, on a probe event it surfaces the message — and it is strictly
 * better than the alternative, which is an unhandled rejection that reads as
 * a small tooling hiccup while the control silently no longer exists.
 */
export async function main(run, io = defaultIo()) {
  try {
    await run();
  } catch (err) {
    const info = describeError(err);
    io.warn(`tyran hook-io: ${sanitizeForOutput(refusalText(info))}\n`);
    io.exit(2);
  }
}
