/**
 * platform-usage — subscription usage read from Claude Code's own config,
 * for the case where the statusline never fires.
 *
 * THE PROBLEM THIS EXISTS FOR, measured rather than supposed. The usage gate
 * reads `.tyran/state/usage.json`; only `statusline.mjs` writes it; the
 * statusline writes only when the platform's payload carries `rate_limits`;
 * and on a real machine that block is ABSENT — it is populated from
 * `anthropic-ratelimit-unified-*` response headers that are not always sent.
 * So no sidecar had ever been written anywhere on that machine, and a config
 * carrying `limits: mode: 'pause'` had never once been able to fire. The gate
 * fails open, so nothing ever said so: overnight mode was silently inert.
 *
 * Meanwhile `~/.claude.json` carries `cachedUsageUtilization` with the same
 * two windows. Reading it removes the statusline from the critical path — and
 * with it the one onboarding step no script can perform, since registering a
 * statusline means writing the operator's own settings file.
 *
 * AND THEN THAT KEY WENT AWAY TOO. Measured on Claude Code 2.1.197:
 * `cachedUsageUtilization` is not a key of `~/.claude.json` at all, and no
 * percentage is reachable anywhere on the machine. Both channels above are
 * dark, and the account wall was being hit at full speed by runs configured to
 * stop before it. So `readPlatformUsage` gained a third channel — the wall
 * itself, read back out of the session transcript by `usage-transcript.mjs`.
 * It is exact and it is late; what it restores is the wind-down and the
 * scheduled resume, not the early stop. Everything above still applies the
 * moment the platform starts reporting a percentage again, which is why the
 * order in `readPlatformUsage` puts the percentage first.
 *
 * WHY A STALE READING IS STILL WORTH ACTING ON, which is the whole design.
 * That cache is refreshed by the platform on its own schedule; measured at 83
 * minutes old during heavy continuous use. Under the gate's ten-minute
 * freshness rule it would be discarded every time and this would fix nothing.
 *
 * But usage within a window only ever goes UP. So a reading taken inside the
 * window that is still running is a LOWER BOUND on usage now:
 *
 *   - reading says >= threshold  ->  the true value is also >= threshold,
 *                                    so pausing is correct;
 *   - reading says <  threshold  ->  the true value may be higher, so we may
 *                                    fail to pause — which is exactly what
 *                                    happens today, and is the safe direction.
 *
 * Acting on it is therefore never WORSE than ignoring it, and often better.
 * The bound holds only while the window has not rolled: a reading of 95% taken
 * before a reset says nothing about the fresh window after it, and acting on
 * it would pause a session that has its full allowance. So a reading whose
 * own `resets_at` has passed is discarded — that check is what makes the rest
 * of this safe, and it is tested directly.
 *
 * Shape note: this file speaks the SIDECAR's language, not the platform's.
 * `cachedUsageUtilization` reports `utilization` (0-100) and `resets_at` as an
 * ISO string; the sidecar and the gate use `used_percentage` and epoch
 * SECONDS. Converting here means the gate has one shape to reason about.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptRejection } from './usage-transcript.mjs';

/**
 * Where the statusline writes and everything else reads.
 *
 * This path had THREE spellings — `statusline.mjs` (the writer),
 * `overnight.mjs` (the scheduler) and `usage-gate.mjs` (the hook) each
 * declared their own — and the freshness window had two. That is ADR-21's
 * named defect in the one place it would be hardest to notice: nothing fails
 * when they agree, and when they stop agreeing the symptom is a pause that
 * silently never fires. Adding a fourth module here without collapsing them
 * would have made it worse, so they collapse to these.
 */
export const SIDECAR_RELPATH = join('.tyran', 'state', 'usage.json');

/** Telemetry older than this is unknown, and unknown fails open. */
export const SIDECAR_FRESH_MS = 10 * 60 * 1000;

/** Where Claude Code keeps the config this reads. */
export const CLAUDE_CONFIG_RELPATH = '.claude.json';

/** Refuse to parse anything larger; measured at 65 KB on a real machine. */
const MAX_BYTES = 4 * 1024 * 1024;

/** The two windows the gate knows about, in the platform's spelling. */
const WINDOW_KEYS = Object.freeze(['five_hour', 'seven_day']);

function ownField(obj, name) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, name)
    ? obj[name]
    : undefined;
}

/**
 * One window, converted to the sidecar's shape, or null.
 *
 * `nowMs` decides whether the reading still describes a running window. A
 * window whose reset has passed is not stale data, it is data about a
 * DIFFERENT window, and no amount of freshness reasoning rescues it.
 */
export function windowFrom(node, nowMs) {
  const used = ownField(node, 'utilization');
  const resetsRaw = ownField(node, 'resets_at');
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  if (typeof resetsRaw !== 'string') return null;
  const resetsMs = Date.parse(resetsRaw);
  if (!Number.isFinite(resetsMs)) return null;
  // The bound only holds inside the window the reading was taken in.
  if (resetsMs <= nowMs) return null;
  return { used_percentage: used, resets_at: Math.floor(resetsMs / 1000) };
}

/**
 * The platform's own usage cache, in sidecar shape, or null when it cannot be
 * used. Never throws: this is read from inside a PreToolUse hook, and a hook
 * that throws on a malformed config file stops the repository's work over
 * telemetry it was only consulting.
 *
 * Measured cost: 0.29 ms to read and parse 65 KB, against the gate's 4-second
 * budget and a hook process spawn that costs an order of magnitude more. No
 * caching layer is warranted and none is here.
 */
export function readConfigUsage({ home = homedir(), readFile = readFileSync, nowMs = Date.now() } = {}) {
  let doc;
  try {
    const raw = readFile(join(home, CLAUDE_CONFIG_RELPATH), 'utf8');
    if (typeof raw !== 'string' || raw.length > MAX_BYTES) return null;
    doc = JSON.parse(raw);
  } catch {
    // Absent, unreadable, not JSON, not signed in. One answer for all of them.
    return null;
  }
  const utilization = ownField(ownField(doc, 'cachedUsageUtilization'), 'utilization');
  if (utilization === null || typeof utilization !== 'object') return null;

  const out = {};
  for (const key of WINDOW_KEYS) {
    const window = windowFrom(ownField(utilization, key), nowMs);
    if (window !== null) out[key] = window;
  }
  if (Object.keys(out).length === 0) return null;

  // `written_at` is the moment the reading is TRUE OF, which is now: the
  // bound above is a statement about the present, derived from a past
  // measurement. Stamping the platform's own fetch time here would hand the
  // gate a document its freshness rule discards, reintroducing the bug.
  // What the reading cannot support is a RESUME, and the gate is told so.
  return { written_at: new Date(nowMs).toISOString(), lower_bound: true, source: 'claude.json', ...out };
}

/**
 * Everything the platform will tell us about this subscription, in the
 * sidecar's shape, or null.
 *
 * TWO CHANNELS, IN THIS ORDER, and the order is the whole point:
 *
 *   1. `~/.claude.json`'s usage cache — a PERCENTAGE, which can cross a
 *      threshold BEFORE the window closes. This is the only channel that can
 *      stop a run early enough to wind down on its own terms, so it is
 *      consulted first and its answer is never second-guessed.
 *   2. the session transcript's `quotaLimits` record — the wall itself, read
 *      back after the fact. Exact, and too late to prevent anything.
 *
 * Measured on Claude Code 2.1.197, which is why (2) exists at all: (1)'s key
 * is not present in that file, and neither is the statusline's `rate_limits`
 * block. Both of the percentage channels are dark on this build, so without
 * (2) a repo configured to pause has nothing to pause ON — which is exactly
 * the state a real overnight run was found in, having driven into the wall at
 * full speed and stayed there until a human noticed in the morning.
 *
 * When (1) returns, (2) is not consulted: a percentage below the threshold is
 * a live statement that the window is OPEN, and a stale rejection cannot
 * outrank it.
 */
export function readPlatformUsage({
  home = homedir(),
  readFile = readFileSync,
  nowMs = Date.now(),
  repoRoot = process.cwd(),
  readTranscript = readTranscriptRejection,
} = {}) {
  const cached = readConfigUsage({ home, readFile, nowMs });
  if (cached !== null) return cached;
  try {
    return readTranscript({ repoRoot, home, nowMs });
  } catch {
    // Same contract as everything else here: telemetry is consulted, never
    // depended on. A hook that throws over a transcript it was only reading
    // stops the repository's work.
    return null;
  }
}
