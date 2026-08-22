/**
 * usage-transcript — the account wall, read back out of the session transcript.
 *
 * THE PROBLEM THIS EXISTS FOR, measured rather than supposed. The usage gate
 * needs a subscription figure and has had two channels for one: the statusline
 * sidecar, and `~/.claude.json`'s `cachedUsageUtilization` (see
 * `usage-source.mjs`). On Claude Code 2.1.197 BOTH are empty — the statusline
 * payload carries no `rate_limits` block, and `cachedUsageUtilization` is not
 * a key of that file at all. Measured on a real machine: no `usage.json` had
 * ever been written in ANY repo, and a config carrying `mode: 'pause'` with
 * `pause_at_percent: 99` had never once been able to fire. The gate fails
 * open, so nothing said so; the agents ran into the wall at full speed and the
 * run died there.
 *
 * But the wall itself IS recorded. Every rejected request lands in the session
 * transcript as an `assistant` line with `isApiErrorMessage: true` and:
 *
 *   "quotaLimits": {"status":"rejected","resetsAt":1787342400,
 *                   "rateLimitType":"five_hour", ...}
 *
 * Measured across `~/.claude/projects/**`: 45 such records, `rateLimitType`
 * always one of `five_hour` or `seven_day`, `resetsAt` always epoch SECONDS.
 * It appears in `<session>/subagents/*.jsonl` as well as the session's own
 * file — which closes the seam this project had written off, because the limit
 * usually surfaces inside a subagent's API call where no hook can see it.
 *
 * WHAT THIS SIGNAL IS AND IS NOT. It is exact and it is LATE: there is no
 * record before the wall, only the rejection at it. So this cannot restore the
 * preventive pause — it reports 100% of a window that is already spent. What
 * it buys is the other half, which is the half that was losing whole nights: a
 * `resets_at` precise to the second, from which the marker, the wind-down and
 * the scheduled resume all follow. Unlike the platform cache's reading, this
 * one is not a lower bound — a rejection is not evidence that usage is "at
 * least" anything, it is the window closing — so it is safe to RESUME on.
 *
 * A REJECTION IS NOT PROOF THE WALL IS STILL UP, and this is the correctness
 * rule of the whole module rather than a detail. Measured on this machine: a
 * `seven_day` rejection on 2026-08-22T14:26 carried `resetsAt` of Aug 28 —
 * and 565 successful assistant messages follow it in the same transcript,
 * because a weekly allowance can be topped up, and because a rejection can
 * name a pool the next request does not draw on. Acting on `resetsAt` alone
 * would have paused a session that was working, which is a worse failure than
 * the one this fixes: a false pause burns the night the pause was supposed to
 * save.
 *
 * So a rejection counts only while nothing NEWER shows the model answering.
 * `message.model` carries that: a real answer names a model, and everything
 * the platform generates itself — errors, notices, interruptions — is
 * `<synthetic>`. A later real answer clears every pending rejection.
 *
 * WHY THE READ IS BOUNDED THE WAY IT IS. This runs inside a PreToolUse hook,
 * on every tool call, against a directory that in a busy repo holds 88 session
 * transcripts and their agents, some of them hundreds of megabytes. Reading
 * all of that per tool call is not a telemetry channel, it is an outage. Three
 * bounds, in the order they cut:
 *
 *   1. mtime. A rejection whose reset is still ahead was written at most a
 *      weekly window ago, so a file untouched since then cannot hold one.
 *   2. rank. The wall lands in the session that is RUNNING, whose transcript
 *      is by construction among the most recently modified. Only the newest
 *      few sessions and their agents are opened.
 *   3. the tail. A rejection is at the END of the file it killed. Only the
 *      last `TAIL_BYTES` are read, positionally — never the whole file.
 *
 * The third bound is also FREE OF FALSE NEGATIVES, which is why it is safe to
 * be this aggressive: a rejection old enough to have scrolled out of the tail
 * has thousands of lines after it, and a transcript that kept going is one the
 * clearing rule above would have discarded anyway.
 *
 * Measured with these bounds against the busiest repo on this machine: 12
 * files, 34 ms, against the gate's 8-second budget. `tests/unit/
 * usage-transcript.test.mjs` pins the budget rather than describing it.
 *
 * Shape note: like `usage-source.mjs`, this speaks the SIDECAR's language, not
 * the platform's. `resetsAt` becomes `resets_at`, and a closed window becomes
 * `used_percentage: 100` — so the gate has one shape to reason about and its
 * threshold comparison needs no special case for "the wall".
 */
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

/** The two windows the gate knows about, in the platform's own spelling. */
export const WINDOW_KEYS = Object.freeze(['five_hour', 'seven_day']);

/** Where Claude Code keeps one directory per project, under the home dir. */
export const PROJECTS_RELPATH = join('.claude', 'projects');

/**
 * The platform's directory name for a repo: its absolute path with every
 * separator replaced by a dash, leading separator included.
 *
 * `cost.mjs` resolves the same directory for the spend report and had this
 * rule inline. It lives HERE because the usage gate imports this module on
 * every tool call and must not pay for `cost.mjs` to be loaded — and two
 * spellings of one platform convention is ADR-21's named defect in the place
 * it would be hardest to notice, since nothing fails while they agree.
 */
export function projectSlug(repoRoot) {
  return resolve(repoRoot).split(sep).join('-');
}

/**
 * Where this repo's transcripts are, or null.
 *
 * Only the direct name. `cost.mjs` additionally SCANS for a directory whose
 * sessions name this repo, because there a miss hides a panel an operator
 * asked for; here a miss means one telemetry channel stays quiet and the gate
 * behaves exactly as it did before this channel existed, which is not worth a
 * directory walk on every tool call.
 */
export function transcriptDirOf(repoRoot, { home = homedir(), projectsRoot = null, exists = existsSync } = {}) {
  if (typeof repoRoot !== 'string' || repoRoot === '') return null;
  const root = projectsRoot ?? join(home, PROJECTS_RELPATH);
  const dir = join(root, projectSlug(repoRoot));
  return exists(dir) ? dir : null;
}

/** How much of a transcript's END is read. A record is ~1 KB; this is generous. */
export const TAIL_BYTES = 128 * 1024;

/**
 * How far back a transcript can have been touched and still matter. The
 * longest window whose reset can be ahead of us is the weekly one, so a file
 * older than that cannot hold a rejection that is still in force. One extra
 * day for clock skew and a laptop that slept through the boundary.
 */
export const CANDIDATE_MAX_AGE_MS = 8 * 24 * 3600 * 1000;

/** Newest sessions opened per scan; each brings its own agents. */
export const MAX_SESSIONS = 4;

/**
 * A session id safe to hand to `claude --resume <id>` as an argv element.
 *
 * Stricter than the gate's `SESSION_ID_RE` on purpose, in one respect: that
 * pattern allows `-`, including in first position, so `--dangerous` is 11
 * characters of `[A-Za-z0-9_-]` and passes it. There the id comes from the
 * platform's own hook payload; HERE it comes from a FILENAME in a directory
 * this module walks, and a name is a weaker provenance than a payload. An
 * argument that can start a flag never leaves this file.
 */
export const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{7,127}$/;

/** Hard ceiling on files opened per scan, agents included. */
export const MAX_FILES = 12;

/** Own-property read on a prototype-free view of foreign JSON. */
function own(obj, name) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, name)
    ? obj[name]
    : undefined;
}

/**
 * One transcript line as a rejection, or null.
 *
 * `nowMs` is what makes a record actionable rather than historical: a
 * rejection whose `resetsAt` has passed is not stale data, it is data about a
 * window that has since REFILLED, and pausing on it would hold a session that
 * has its full allowance. That check is the one that makes everything else
 * here safe, and it is tested directly.
 */
export function rejectionOf(line, nowMs) {
  // A substring test before JSON.parse. A transcript is overwhelmingly lines
  // that cannot match, and parsing each of them is the entire cost of this
  // module; `quotaLimits` appears on 5 lines of a 5700-line transcript.
  if (line.length === 0 || line.charCodeAt(0) !== 123 /* { */ || !line.includes('"quotaLimits"')) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  const quota = own(event, 'quotaLimits');
  if (own(quota, 'status') !== 'rejected') return null;
  const window = own(quota, 'rateLimitType');
  // An unknown window is not a window this gate has a threshold for. Silently
  // ignoring it is right: the platform may add one, and a hook that throws on
  // an unrecognised string stops the repository's work over telemetry.
  if (typeof window !== 'string' || !WINDOW_KEYS.includes(window)) return null;
  const resets = own(quota, 'resetsAt');
  if (typeof resets !== 'number' || !Number.isFinite(resets)) return null;
  if (resets * 1000 <= nowMs) return null;
  // Required, not optional: the rejection is weighed by ORDERING it against
  // the last real answer, and a record that cannot be placed on that timeline
  // cannot be shown to be current. See `answeredAt`.
  const at = own(event, 'timestamp');
  if (typeof at !== 'string' || at === '') return null;
  return { window, resets_at: resets, at };
}

/**
 * When this line showed a real model answering, or null.
 *
 * The platform writes its own messages into the transcript as `assistant`
 * records too — the wall notice among them — and stamps them `<synthetic>`.
 * Only a named model is evidence that a request went out and came back, which
 * is the one thing that retires a pending rejection.
 *
 * An answer with no timestamp is not usable, because the rule it feeds is an
 * ORDERING against the rejection. Both sides therefore require one, and both
 * sides fail toward "no pause" without it — which is the status quo, and the
 * safe direction for a control that can otherwise halt a working session.
 */
export function answeredAt(line) {
  if (line.length === 0 || line.charCodeAt(0) !== 123 /* { */ || !line.includes('"assistant"')) return null;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    return null;
  }
  if (own(event, 'type') !== 'assistant') return null;
  const model = own(own(event, 'message'), 'model');
  if (typeof model !== 'string' || model === '' || model === '<synthetic>') return null;
  const ts = own(event, 'timestamp');
  return typeof ts === 'string' && ts !== '' ? ts : null;
}

/**
 * One block of transcript text, folded to what the caller has to weigh:
 * `{answered_at, rejections: {five_hour?, seven_day?}}`.
 *
 * Rejections are kept per window rather than "the last one seen", because the
 * two are not alternatives: a five-hour wall can follow a weekly one within
 * the same file, and `trippedWindow` gives the weekly precedence for a reason
 * — waiting out the five-hour refill just hits the weekly wall again.
 * Reporting only the newest record would hide the binding constraint behind
 * the recent one.
 *
 * `answered_at` is carried rather than applied here, because the clearing rule
 * is not per file: the wall lands in a SUBAGENT's transcript while its parent
 * session keeps answering in another, and either file read alone gives the
 * wrong verdict. `readTranscriptRejection` reconciles them on one timeline.
 */
export function scanTail(text, nowMs) {
  const rejections = {};
  let latest = null;
  for (const line of text.split('\n')) {
    const ts = answeredAt(line);
    if (ts !== null) {
      if (latest === null || ts > latest) latest = ts;
      continue;
    }
    const hit = rejectionOf(line, nowMs);
    // Lines are chronological, so a later hit is the fresher reading of that
    // window and simply replaces the earlier one.
    if (hit !== null) rejections[hit.window] = hit;
  }
  return { answered_at: latest, rejections };
}

/**
 * The last `maxBytes` of a file, as complete lines.
 *
 * Positional, so a 200 MB transcript costs the same as a 200 KB one. The first
 * line of a tail read is almost always a fragment of the record that straddles
 * the cut — it is dropped, because a fragment that happens to parse is a
 * reading this module would INVENT. Never throws: an unreadable transcript is
 * one this module has no opinion about.
 */
export function readTail(path, maxBytes = TAIL_BYTES, io = {}) {
  const { open = openSync, read = readSync, close = closeSync, stat = statSync } = io;
  let fd = null;
  try {
    const size = stat(path).size;
    if (size === 0) return '';
    const want = Math.min(size, maxBytes);
    const start = size - want;
    fd = open(path, 'r');
    const buffer = Buffer.allocUnsafe(want);
    let got = 0;
    while (got < want) {
      const n = read(fd, buffer, got, want - got, start + got);
      if (n === 0) break;
      got += n;
    }
    const text = buffer.subarray(0, got).toString('utf8');
    if (start === 0) return text;
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } catch {
    return '';
  } finally {
    if (fd !== null) {
      try {
        close(fd);
      } catch {
        /* a descriptor we could not close is not a reason to fail a read */
      }
    }
  }
}

function mtimeOf(path, stat) {
  try {
    return stat(path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Which transcripts are worth opening, newest first: the most recently touched
 * sessions and the agents belonging to them.
 *
 * The three bounds of the header apply here, and the ORDER matters — mtime
 * before rank before tail — because each is cheaper than the next and cuts
 * more.
 */
export function candidates(transcriptDir, { nowMs = Date.now(), maxAgeMs = CANDIDATE_MAX_AGE_MS, io = {} } = {}) {
  const { readdir = readdirSync, stat = statSync } = io;
  let files;
  try {
    files = readdir(transcriptDir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const sessions = [];
  for (const file of files) {
    const path = join(transcriptDir, file);
    const mtime = mtimeOf(path, stat);
    if (mtime === null || nowMs - mtime > maxAgeMs) continue;
    sessions.push({ path, mtime, session: basename(file, '.jsonl') });
  }
  sessions.sort((a, b) => b.mtime - a.mtime);

  const out = [];
  for (const session of sessions.slice(0, MAX_SESSIONS)) {
    out.push(session);
    let agents;
    try {
      agents = readdir(join(transcriptDir, session.session, 'subagents')).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue; // a session with no agents is the common case, not an error
    }
    for (const agent of agents) {
      const path = join(transcriptDir, session.session, 'subagents', agent);
      const mtime = mtimeOf(path, stat);
      if (mtime === null || nowMs - mtime > maxAgeMs) continue;
      out.push({ path, mtime, session: session.session });
    }
  }
  // One more sort so an AGENT that outlived its session's last write is opened
  // before an older session — the wall usually lands in an agent first.
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, MAX_FILES);
}

/**
 * The account wall as the gate's sidecar document, or null.
 *
 * `repoRoot` decides which project's transcripts are read; the caller inside
 * the hook has no session id to narrow it further, which is why the bounds
 * above do that job instead.
 */
export function readTranscriptRejection({
  repoRoot = process.cwd(),
  transcriptDir = null,
  home = homedir(),
  projectsRoot = null,
  nowMs = Date.now(),
  maxAgeMs = CANDIDATE_MAX_AGE_MS,
  tailBytes = TAIL_BYTES,
  io = {},
} = {}) {
  const dir = transcriptDir ?? transcriptDirOf(repoRoot, { home, projectsRoot, ...(io.exists ? { exists: io.exists } : {}) });
  if (typeof dir !== 'string' || dir === '') return null;

  const found = {};
  const sessionOf = {};
  // ONE timeline across every candidate, which is the whole reason this loop
  // collects before it decides. The wall lands in a subagent's transcript
  // while its parent session keeps answering in another file: read either
  // alone and the verdict is wrong in a different direction each time.
  let lastAnswerAt = null;
  for (const candidate of candidates(dir, { nowMs, maxAgeMs, io })) {
    const { answered_at: seen, rejections } = scanTail(readTail(candidate.path, tailBytes, io), nowMs);
    if (seen !== null && (lastAnswerAt === null || seen > lastAnswerAt)) lastAnswerAt = seen;
    for (const window of WINDOW_KEYS) {
      const hit = rejections[window];
      if (hit === undefined) continue;
      // Across files, the record with the LATEST reset governs: two sessions
      // that hit the same wall report the same reset, and a session that hit
      // it later in the window reports the same one again. A later reset is a
      // later window, and that is the one still in force.
      if (found[window] === undefined || hit.resets_at > found[window].resets_at) {
        found[window] = hit;
        sessionOf[window] = candidate.session;
      }
    }
  }

  const windows = WINDOW_KEYS.filter(
    (w) => found[w] !== undefined && (lastAnswerAt === null || found[w].at > lastAnswerAt),
  );
  if (windows.length === 0) return null;

  // The weekly window names the session to resume when both are walled: it is
  // the binding constraint, and its record is the one the scheduler acts on.
  const governing = windows.includes('seven_day') ? 'seven_day' : windows[0];
  const session = sessionOf[governing] ?? null;
  const doc = {
    written_at: new Date(nowMs).toISOString(),
    // NOT a lower bound. The platform cache reports "usage is at least N%",
    // which is a reason to stop and never a reason to start; a rejection is
    // the window closing, with an exact reset. The scheduler may act on it.
    lower_bound: false,
    source: 'transcript',
    session_id: typeof session === 'string' && SAFE_SESSION_ID_RE.test(session) ? session : null,
    rejected_at: found[governing].at,
  };
  for (const window of windows) doc[window] = { used_percentage: 100, resets_at: found[window].resets_at };
  return doc;
}
