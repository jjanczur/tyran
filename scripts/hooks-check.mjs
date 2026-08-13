/**
 * hooks-check — is every gate this plugin declares actually ALIVE?
 *
 * ## Why this file exists
 *
 * Everything else in this repository defends against a gate that decides
 * wrongly. This one defends against a gate that is not there — which is the
 * failure the platform hands us for free, and the only one no gate can catch
 * from the inside.
 *
 * Measured on the shipped binary (v2.1.116, `hooks/HOOK-CONTRACT-MEASURED.md`):
 * a hook file that is missing, or present without the execute bit, is spawned
 * through `shell: true`, the shell exits 126/127 with empty stdout, and that
 * lands in the "non-blocking status code" branch — **the action proceeds and
 * nothing is printed**. A matcher containing a comma silently becomes an
 * unanchored regex that matches no tool name that will ever exist. In both
 * cases `hooks.json` still lists the gate, the manifest still validates, and
 * the user still believes they are protected.
 *
 * So there exists a state in which the plugin is installed, every document
 * says it guards, and it guards nothing.
 *
 * ## What this is, said in the words that are true
 *
 * **This is DETECTION, not ENFORCEMENT.** Nothing here can make a gate run.
 * `doctor --hooks` reports; the `SessionStart` probe warns. Neither can refuse
 * anything — `SessionStart` has no refusal channel at all (ADR-22) — and a
 * README claiming the plugin "guarantees" its gates fire would be a false
 * guarantee, which this project treats as a blocking defect rather than as
 * marketing. What the check buys is that the silent state stops being silent.
 *
 * ## Why the matcher analysis duplicates platform logic, and how far
 *
 * `matcherMatches` below is a verbatim transcription of the platform's own
 * predicate. Copying another program's logic is normally the thing this repo
 * refuses to do, so the reason has to be stated rather than assumed: the
 * predicate is not a rule we may choose, it is an OBSERVATION about a system
 * we do not control, and there is no other way to answer "will this matcher
 * ever fire?" than to evaluate the same expression the platform evaluates.
 * The alternative — a hand-rolled approximation — would be a check that is
 * confidently wrong, which is worse than no check.
 *
 * The cost is stated in one place, `PLATFORM_VERSION`, and it is real: the
 * transcription is pinned to one version and a platform upgrade can silently
 * make it stale. That is why every subject-based verdict is phrased as "this
 * matcher does not match any subject KNOWN TO THIS CHECK" and why an open
 * subject set can only ever produce a warning.
 */
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { escapeInvisible } from './invisible.mjs';

/**
 * The platform build every measured statement in this file was read from.
 *
 * Named, exported and printed in the report on purpose (ADR-22 correction 2:
 * a measured fact carries its measurement conditions, never just its
 * conclusion). A reader who upgrades Claude Code and sees this string is
 * looking at a check whose model of the platform is one version behind.
 */
export const PLATFORM_VERSION = '2.1.116';

/** A journal-derived or config-derived value on its way into a message. */
const q = (value) => escapeInvisible(String(value));

/**
 * Every event name the platform's hook dispatcher knows, read out of the
 * binary's own event table.
 *
 * An event key that is not in this set is not a typo the platform will
 * complain about — the block is simply never dispatched, which is the same
 * silent absence a deleted file produces. This is why the check exists at
 * the level of the KEY and not only at the level of the file.
 */
export const PLATFORM_EVENTS = Object.freeze([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
]);

/**
 * Which input field the platform turns into the match query, per event —
 * transcribed from the dispatcher's own switch.
 *
 * An event ABSENT from this table has no match query, and that is not a
 * detail. Measured, verbatim:
 *
 *     let z = ($ ? T.filter(k => !k.matcher || UB5($, k.matcher)) : T)
 *
 * When the query `$` is falsy the matcher list is **not filtered at all**.
 * So on `Stop`, `UserPromptSubmit`, `TaskCreated`, `TaskCompleted` and
 * `TeammateIdle` a matcher is inert: the hook fires whatever it says. The
 * same expression is also the mechanism behind the empty-`agent_type` case
 * that S-E3-2 had to work around — an empty string is falsy, so a
 * `SubagentStop` carrying `agent_type: ""` runs EVERY hook registered for
 * the event, matcher or no matcher. One ternary, two consequences, and
 * neither is documented.
 */
export const MATCH_QUERY_FIELD = Object.freeze(
  Object.assign(Object.create(null), {
    PreToolUse: 'tool_name',
    PostToolUse: 'tool_name',
    PostToolUseFailure: 'tool_name',
    PermissionRequest: 'tool_name',
    PermissionDenied: 'tool_name',
    UserPromptExpansion: 'command_name',
    SessionStart: 'source',
    Setup: 'trigger',
    PreCompact: 'trigger',
    PostCompact: 'trigger',
    Notification: 'notification_type',
    SessionEnd: 'reason',
    StopFailure: 'error',
    SubagentStart: 'agent_type',
    SubagentStop: 'agent_type',
    Elicitation: 'mcp_server_name',
    ElicitationResult: 'mcp_server_name',
    ConfigChange: 'source',
    InstructionsLoaded: 'load_reason',
    FileChanged: 'file_path (basename)',
  }),
);

/**
 * Events whose match query comes from a CLOSED enumeration in the platform's
 * own input schema, so "this matcher matches none of them" is a fact rather
 * than an opinion, and is reported as an error.
 *
 * `PreCompact`/`PostCompact` are `h.enum(["manual","auto"])` in the schema;
 * `SessionStart`'s sources are the documented five.
 */
export const CLOSED_SUBJECTS = Object.freeze(
  Object.assign(Object.create(null), {
    SessionStart: Object.freeze(['startup', 'resume', 'clear', 'compact', 'fork']),
    PreCompact: Object.freeze(['manual', 'auto']),
    PostCompact: Object.freeze(['manual', 'auto']),
  }),
);

/**
 * The platform's tool-name alias table, read from the binary (`gJ6`).
 *
 * It is load-bearing for the matcher predicate in a way that is easy to miss:
 * `normalise` is applied to the MATCHER and compared against the RAW query,
 * so a `hooks.json` written against the old name `Task` still fires for a
 * query of `Agent` — while a regex matcher is additionally retried against
 * every alias OF the query. Both directions are transcribed below because
 * getting one of them backwards would make this check disagree with the
 * platform in the direction that reports a live gate as dead.
 */
export const TOOL_ALIASES = Object.freeze(
  Object.assign(Object.create(null), {
    Task: 'Agent',
    KillShell: 'TaskStop',
    AgentOutputTool: 'TaskOutput',
    BashOutputTool: 'TaskOutput',
    // The fifth entry, missed on the first pass and caught in review. The
    // table is built as
    //     { Task: …, KillShell: …, AgentOutputTool: …, BashOutputTool: …,
    //       ...(BRIEF_TOOL_NAME ? { Brief: BRIEF_TOOL_NAME } : {}) }
    // and BRIEF_TOOL_NAME is an imported constant equal to "SendUserMessage",
    // never a runtime flag — so the spread is ALWAYS active and the table
    // always has five entries.
    //
    // Worth stating why a missing row mattered rather than just fixing it: a
    // matcher of "Brief" fires on the live platform, and this check called it
    // dead. A LIVE gate reported as dead is the direction this module's own
    // header calls inadmissible, and it happened in the one file whose entire
    // value is fidelity of transcription.
    Brief: 'SendUserMessage',
  }),
);

/**
 * Tool names this check knows about. Deliberately NOT presented as complete:
 * MCP tools arrive as `mcp__<server>__<tool>` at runtime and a project may
 * add more, so the set is OPEN and a matcher matching nothing in it can only
 * ever be a warning here.
 *
 * Read from the binary's `filePatternTools` / `bashPrefixTools` tables and
 * from the alias table above, rather than typed from memory.
 */
export const KNOWN_TOOLS = Object.freeze([
  'Read',
  'Write',
  'Edit',
  'Glob',
  'Grep',
  'NotebookRead',
  'NotebookEdit',
  'Bash',
  'WebFetch',
  'WebSearch',
  'Agent',
  'TaskOutput',
  'TaskStop',
]);

/**
 * The tools that put NEW content into a file, as the platform itself
 * enumerates them for its own diff statistics (`sn_ = new Set([Edit, Write,
 * NotebookEdit])`, where the three constants resolve to exactly those
 * strings).
 *
 * Exported from here rather than from the guard that uses it, because it is a
 * measured property of the PLATFORM and this module is where measured
 * platform facts live. The write guard imports it; there is no second list.
 */
export const FILE_WRITING_TOOLS = Object.freeze(['Write', 'Edit', 'NotebookEdit']);

/** `normalise` from the matcher predicate: alias -> canonical, else identity. */
export function normalizeName(name) {
  return Object.hasOwn(TOOL_ALIASES, name) ? TOOL_ALIASES[name] : name;
}

/** `aliasesOf` from the matcher predicate: canonical -> every alias of it. */
export function aliasesOf(name) {
  const out = [];
  for (const [alias, canonical] of Object.entries(TOOL_ALIASES)) {
    if (canonical === name) out.push(alias);
  }
  return out;
}

/**
 * The platform's matcher predicate, transcribed from v2.1.116.
 *
 * Kept as one expression-for-expression copy rather than "improved", so that
 * a future reader can diff it against a new binary in one sitting. Every
 * surprising consequence this repo relies on falls out of these six lines:
 *
 *  - an empty matcher, or `*`, matches EVERYTHING;
 *  - a matcher of only `[a-zA-Z0-9_|]` is EQUALITY (or a `|`-list of
 *    equalities), never a substring — so `implementer` can never match
 *    `tyran:implementer`, measured live;
 *  - anything else is `new RegExp(matcher)`, UNANCHORED — so
 *    `tyran-implementer` also matches `evil-tyran-implementer-nope`;
 *  - an invalid regex matches NOTHING and only writes a debug line.
 *
 * The `.trim()` in the list branch is dead code in the platform, and the copy
 * keeps it: the character class that guards the branch forbids whitespace, so
 * no alternative can ever have any to trim. Noted rather than dropped,
 * because a transcription that silently "fixes" its source stops being usable
 * as a reference.
 */
export function matcherMatches(query, matcher) {
  if (!matcher || matcher === '*') return true;
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    if (matcher.includes('|')) {
      return matcher.split('|').map((k) => normalizeName(k.trim())).includes(query);
    }
    return query === normalizeName(matcher);
  }
  try {
    const re = new RegExp(matcher);
    if (re.test(query)) return true;
    for (const alias of aliasesOf(query)) if (re.test(alias)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Which branch of the predicate a matcher falls into. The whole point of the
 * check is that authors believe they are in one branch and are in another.
 */
export function matcherBranch(matcher) {
  if (!matcher || matcher === '*') return 'always';
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) return matcher.includes('|') ? 'list' : 'exact';
  try {
    new RegExp(matcher);
    return 'regex';
  } catch {
    return 'invalid-regex';
  }
}

/** True when a regex-branch matcher is anchored at both ends. */
function isAnchored(matcher) {
  return matcher.startsWith('^') && matcher.endsWith('$') && !matcher.endsWith('\\$');
}

// ------------------------------------------------------------- the findings

/**
 * Severity is a property of the finding CODE, declared once — the same rule,
 * and the same reason, as `doctor.SEVERITY_BY_CODE`: a literal at each call
 * site is N independent places where an `error` can quietly become an `info`
 * while every test stays green.
 *
 * doctor merges this table into its own and asserts the two do not collide,
 * so a code cannot end up with two severities depending on who rendered it.
 */
export const HOOK_SEVERITY_BY_CODE = Object.freeze(
  Object.assign(Object.create(null), {
    // the manifest and the hooks file itself
    'hooks-manifest-missing': 'error',
    'hooks-manifest-unreadable': 'error',
    'hooks-manifest-no-hooks': 'error',
    'hooks-manifest-duplicates-standard': 'error',
    'hooks-file-missing': 'error',
    'hooks-file-unreadable': 'error',
    'hooks-file-invalid': 'error',
    'hooks-file-empty': 'warning',
    // the event key
    'hook-event-unknown': 'error',
    'hook-event-not-a-list': 'error',
    'hook-entry-malformed': 'error',
    // the command and its file
    'hook-command-missing': 'error',
    'hook-command-not-modellable': 'warning',
    'hook-path-unquoted': 'error',
    'hook-file-absent': 'error',
    'hook-file-not-a-file': 'error',
    'hook-file-unreadable': 'error',
    'hook-not-executable': 'error',
    'hook-no-shebang': 'error',
    'hook-interpreter-absent': 'error',
    'hook-type-unchecked': 'info',
    'hook-duplicate-command': 'warning',
    // keys on the ENTRY that disarm a gate while everything else looks right
    'hook-async-on-gate': 'error',
    'hook-once-on-gate': 'error',
    'hook-conditional-gate': 'error',
    'hook-foreign-shell': 'error',
    // the timeout
    'hook-no-timeout': 'warning',
    'hook-timeout-implausible': 'warning',
    // the matcher
    'matcher-invalid-regex': 'error',
    'matcher-comma-separated': 'error',
    'matcher-matches-nothing-closed': 'error',
    'matcher-matches-nothing-known': 'warning',
    'matcher-whitespace': 'warning',
    'matcher-unanchored': 'warning',
    'matcher-ignored-by-event': 'warning',
    'matcher-matches-everything': 'info',
    // cross-checks between the file and the script it names
    'hook-event-declaration-mismatch': 'warning',
    'hook-namespace-drift': 'error',
    // accounting
    'hooks-ok': 'info',
  }),
);

/** The severity of a hook finding code, or a loud failure. See doctor's twin. */
export function hookSeverityFor(code) {
  const severity = HOOK_SEVERITY_BY_CODE[code];
  if (severity === undefined) {
    throw new Error(`hooks-check bug: finding code "${code}" has no severity in HOOK_SEVERITY_BY_CODE`);
  }
  return severity;
}

function finding(code, where, message, fix = null) {
  return { severity: hookSeverityFor(code), code, where, message, fix };
}

// ------------------------------------------------- keys on the hook entry

/**
 * Events on which a hook is a GATE — i.e. the platform will read a refusal
 * from it. Kept here rather than imported from `hook-io.EVENTS` on purpose:
 * this module is the one that models the PLATFORM, and `hook-io` models what
 * OUR runtime is willing to answer. They agree today and a test asserts it,
 * but they are answers to different questions and merging them would make the
 * next disagreement invisible.
 */
export const BLOCKING_EVENTS = Object.freeze([
  'PreToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'TaskCreated',
  'TaskCompleted',
  'TeammateIdle',
  'PermissionRequest',
  'ConfigChange',
  'PostToolBatch',
]);

/** The platform's default `shell` for a command hook. */
export const DEFAULT_SHELL = 'bash';

/**
 * The largest `timeout` that can plausibly be a number of SECONDS.
 *
 * The platform's own default is 600 and the field is documented as seconds.
 * A value above that is almost always a millisecond figure pasted into a
 * seconds field — `10000` reads as ten seconds to the author and buys the
 * hook two hours and 46 minutes, during which a hung gate holds the tool call.
 */
export const MAX_PLAUSIBLE_TIMEOUT_S = 600;

/**
 * Keys on a hook ENTRY that turn a gate into decoration.
 *
 * This is the fifth failure variant, and it is the worst of them, because
 * every earlier check passes: the file exists, is executable, has a shebang,
 * the matcher is correct and the event is real. Measured live by review, same
 * payload, one key changed:
 *
 *     bare entry              -> refused, the file was never written
 *     + "async": true         -> PASSED, raw TAG characters landed on disk
 *     + "if": "Bash(git *)"   -> PASSED
 *     + "shell": "powershell" -> PASSED
 *
 * and in every case a logger on the same matcher fired normally, so dispatch
 * and matching were both working. `doctor --hooks` printed `healthy`.
 *
 * That is a false guarantee produced by the tool built to detect false
 * guarantees, so these are ERRORS rather than warnings — with one shared
 * justification, taken from the schema's own descriptions:
 *
 *  - `async` / `asyncRewake`: "hook runs in background without blocking".
 *    A backgrounded hook has no channel to return a decision through. The
 *    gate cannot refuse. There is no severity below error for that.
 *  - `once`: "hook runs once and is removed after execution". A gate that
 *    guards the first write and nothing after it is worse than no gate,
 *    because the first run is the one people test with.
 *  - `shell`: the command is handed to a different interpreter than the one
 *    it was written for; our hooks are `#!`-dispatched POSIX invocations and
 *    the failure under pwsh is the silent 127 kind.
 *  - `if`: the condition is a language this check does not evaluate, so the
 *    gate's coverage is UNKNOWN. Unknown coverage on a control is treated as
 *    failure everywhere else in this repository — the secrets gate refuses
 *    rather than scanning a prefix — and this is the same call.
 *
 * On a NON-blocking event none of these is an error: a probe that runs in the
 * background, once, or conditionally is a legitimate design. The severity is
 * a property of the pair (key, event), which is why this takes the event.
 */
export function entryKeyFindings(event, hook, where) {
  const findings = [];
  if (!BLOCKING_EVENTS.includes(event)) return findings;

  if (hook.async === true || hook.asyncRewake === true) {
    const key = hook.async === true ? 'async' : 'asyncRewake';
    findings.push(
      finding(
        'hook-async-on-gate',
        where,
        `"${key}": true on ${q(event)}, which is an event the platform reads a REFUSAL from. The schema ` +
          'describes the key as "hook runs in background without blocking" (asyncRewake implies async), and ' +
          'a backgrounded hook has no channel to return a decision — measured live: the identical gate ' +
          'refused without this key and PASSED with it, writing the payload to disk. Every other check ' +
          'here still passes, which is what makes this the dangerous one.',
        `remove "${key}" from this entry, or move the hook to a non-blocking event`,
      ),
    );
  }
  if (hook.once === true) {
    findings.push(
      finding(
        'hook-once-on-gate',
        where,
        `"once": true on ${q(event)}. The schema describes it as "hook runs once and is removed after ` +
          'execution", so this gate guards the first occurrence and nothing after it — and the first ' +
          'occurrence is the one anybody testing the installation will use.',
        'remove "once" from this entry',
      ),
    );
  }
  if (hook.if !== undefined && hook.if !== null && hook.if !== '') {
    findings.push(
      finding(
        'hook-conditional-gate',
        where,
        `"if": ${JSON.stringify(q(String(hook.if)))} on ${q(event)}. The condition is evaluated by the ` +
          'platform in a language this check does not interpret, so what this gate actually covers is ' +
          'UNKNOWN — it is narrower than its matcher claims by an unknown amount. Measured live: a gate ' +
          'whose matcher covered the call PASSED the payload because the condition did not match. Unknown ' +
          'coverage on a control is treated as failure everywhere else here (the secrets gate refuses ' +
          'rather than scanning a prefix); this is the same call.',
        'drop the condition and narrow inside the hook, where the reasoning is testable',
      ),
    );
  }
  if (hook.shell !== undefined && hook.shell !== DEFAULT_SHELL) {
    findings.push(
      finding(
        'hook-foreign-shell',
        where,
        `"shell": ${JSON.stringify(q(String(hook.shell)))} on ${q(event)}. The command is handed to an ` +
          `interpreter other than the default ${DEFAULT_SHELL}, and these hooks are POSIX invocations ` +
          'dispatched through a shebang. Measured live: the gate PASSED the payload under pwsh, in the ' +
          'silent way — the interpreter fails, the platform records a non-blocking error, the action ' +
          'proceeds.',
        `remove "shell", or provide a command the named interpreter can run`,
      ),
    );
  }
  return findings;
}

// -------------------------------------------------------------- the command

/**
 * Characters that make a command line something other than "one program and
 * its literal arguments". Same doctrine as the secrets gate: enumerate what
 * is inert and refuse to model the rest, rather than guess and be confidently
 * wrong about which file is about to run.
 */
const SHELL_METACHARACTERS = ';&|<>()';

/**
 * Lex a hooks.json command into argv, recording which variable references
 * were left UNQUOTED.
 *
 * The quoting matters and it is measured, not stylistic: the platform spawns
 * the command with `shell: true`, so an unquoted `${CLAUDE_PLUGIN_ROOT}`
 * whose value contains a space is split by the shell into two words. The
 * first is then a path that does not exist, the shell exits 127, and — per
 * the failure table above — the action proceeds silently. A user whose
 * checkout lives under `~/Library/Application Support/...` therefore installs
 * a plugin whose every gate is dead, with nothing to read anywhere.
 */
export function lexCommand(command) {
  const argv = [];
  const unquotedVars = [];
  const metachars = [];
  const expansions = [];
  let current = '';
  let started = false;
  let quote = null; // null | "'" | '"'
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote === null && ch === '\\') {
      const next = command[++i];
      if (next !== undefined) {
        current += next;
        started = true;
      }
      continue;
    }
    if (quote === null && (ch === "'" || ch === '"')) {
      quote = ch;
      started = true;
      continue;
    }
    if (quote !== null && ch === quote) {
      quote = null;
      continue;
    }
    if (quote === "'") {
      current += ch;
      continue;
    }
    // Outside single quotes a `${...}` is a shell expansion. Record the ones
    // that are NOT inside double quotes; those are the dangerous ones.
    if (ch === '$' && command[i + 1] === '{') {
      const close = command.indexOf('}', i + 2);
      if (close !== -1) {
        const name = command.slice(i + 2, close);
        expansions.push(name);
        if (quote === null) unquotedVars.push(name);
        current += command.slice(i, close + 1);
        started = true;
        i = close;
        continue;
      }
    }
    if (quote === null && (ch === ' ' || ch === '\t' || ch === '\n')) {
      if (started) argv.push(current);
      current = '';
      started = false;
      continue;
    }
    if (quote === null && (SHELL_METACHARACTERS.includes(ch) || ch === '`' || ch === '$')) {
      metachars.push(ch);
    }
    current += ch;
    started = true;
  }
  if (started) argv.push(current);
  return { argv, unquotedVars, metachars, expansions, unterminatedQuote: quote !== null };
}

/** Substitute the path variables this check can resolve. */
function substitute(token, vars) {
  return token.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? vars[name] : whole,
  );
}

/** Is `interpreter` reachable? Absolute path, or a bare name on PATH. */
function interpreterExists(interpreter, env) {
  if (interpreter.includes('/')) return existsSync(interpreter);
  const path = env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir !== '' && existsSync(join(dir, interpreter))) return true;
  }
  return false;
}

/**
 * The interpreter a shebang line names, resolved through `/usr/bin/env`.
 * Returns null when the line is not a shebang at all.
 */
export function shebangInterpreter(firstLine) {
  if (!firstLine.startsWith('#!')) return null;
  const words = firstLine.slice(2).trim().split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return null;
  if (words[0].endsWith('/env') || words[0] === 'env') {
    // `#!/usr/bin/env -S node --flag` is legal; skip the flags to find the name.
    for (const word of words.slice(1)) {
      if (!word.startsWith('-') && !word.includes('=')) return word;
    }
    return null;
  }
  return words[0];
}

// ---------------------------------------------------------- the file checks

/**
 * Everything that can be wrong with the FILE a hook entry names.
 *
 * Split out so each condition is reachable from a test without constructing a
 * whole plugin tree, and so the order is explicit: a missing file must not
 * also be reported as "no shebang", which would bury the finding that
 * actually says what to do.
 */
function checkHookFile(path, where, { env, dispatcher = null }) {
  const findings = [];
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    if (err.code === 'ENOENT') {
      findings.push(
        finding(
          'hook-file-absent',
          where,
          `the hook file does not exist. The platform spawns hook commands through a shell, so a ` +
            `missing file makes the shell exit 127 with empty stdout — which the platform records as a ` +
            `non-blocking error and THE ACTION PROCEEDS. This gate is not weakened, it is absent, and ` +
            `nothing anywhere says so.`,
          `ls -l ${q(path)}   # then reinstall the plugin, or restore the file from git`,
        ),
      );
    } else {
      findings.push(
        finding('hook-file-unreadable', where, `cannot stat the hook file (${q(err.code ?? err.message)})`),
      );
    }
    return findings;
  }
  if (!stat.isFile()) {
    findings.push(finding('hook-file-not-a-file', where, 'the hook command names something that is not a file'));
    return findings;
  }

  // TWO tests, and the mode bits come first deliberately. `accessSync(X_OK)`
  // answers "may THIS process execute it", which depends on who is running —
  // and under uid 0 in a container the answer can be yes for a file the shell
  // still cannot dispatch. The mode bits answer "is this file executable at
  // all", which is the property the platform's `shell: true` spawn depends on
  // and is the same on every machine. Raised in review as a CI hazard that
  // would have disarmed the mutant for this guard; measuring the bits removes
  // the dependency instead of hoping about the runner.
  // A command of the form `node "<script>"` dispatches through the named
  // interpreter, so neither the mode bits nor a shebang decide whether it can
  // run — the file only has to exist and be readable, and `node` itself has
  // to resolve. Registering this way is the sanctioned route for a hook file
  // an agent authored: the policy gate refuses agent-run chmod on hook paths,
  // deliberately, so the exec bit cannot be set from inside a session.
  if (dispatcher !== null) {
    if (!interpreterExists(dispatcher, env)) {
      findings.push(
        finding(
          'hook-interpreter-absent',
          where,
          `the command dispatches through "${q(dispatcher)}", which is not on PATH and is not an ` +
            'existing absolute path. The spawn fails in the non-blocking way, so the action proceeds.',
          `command -v ${q(dispatcher)}`,
        ),
      );
    }
    try {
      readFileSync(path, 'utf8');
    } catch (err) {
      findings.push(
        finding('hook-file-unreadable', where, `cannot read the hook file (${q(err.code ?? err.message)})`),
      );
    }
    return findings;
  }

  let executable = (stat.mode & 0o111) !== 0;
  if (executable) {
    try {
      accessSync(path, constants.X_OK);
    } catch {
      executable = false;
    }
  }
  if (!executable) {
    findings.push(
      finding(
        'hook-not-executable',
        where,
        `the hook file exists but is not executable (mode ${(stat.mode & 0o777).toString(8)}). The shell ` +
          `exits 126, the platform records a non-blocking error, and THE ACTION PROCEEDS. An installer ` +
          `that loses the execute bit disables every gate it copies, silently.`,
        `chmod +x ${q(path)}`,
      ),
    );
  }

  let head;
  try {
    head = readFileSync(path, 'utf8').split('\n', 1)[0] ?? '';
  } catch (err) {
    findings.push(
      finding('hook-file-unreadable', where, `cannot read the hook file (${q(err.code ?? err.message)})`),
    );
    return findings;
  }
  const interpreter = shebangInterpreter(head);
  if (interpreter === null) {
    findings.push(
      finding(
        'hook-no-shebang',
        where,
        'the hook file has no shebang line. It is spawned as a program, not passed to node, so without ' +
          '`#!/usr/bin/env node` the shell tries to interpret JavaScript as shell script — which fails ' +
          'in the non-blocking way, so the action proceeds.',
        `add "#!/usr/bin/env node" as the first line of ${q(path)}`,
      ),
    );
  } else if (!interpreterExists(interpreter, env)) {
    findings.push(
      finding(
        'hook-interpreter-absent',
        where,
        `the shebang names the interpreter "${q(interpreter)}", which is not on PATH and is not an ` +
          'existing absolute path. The spawn fails in the non-blocking way, so the action proceeds.',
        `command -v ${q(interpreter)}`,
      ),
    );
  }
  return findings;
}

// ------------------------------------------------------- the matcher checks

/**
 * Everything that can be wrong with a matcher, given the event it sits on.
 *
 * `subjects` is the vocabulary this check knows for the event; `closed` says
 * whether that vocabulary is the whole world. The distinction is the entire
 * difference between an error and a warning here, and it is why the two are
 * separate finding codes rather than one code with a variable severity.
 */
export function analyzeMatcher(event, matcher, where, { subjects, closed, namespace = null }) {
  const findings = [];
  const hasQuery = Object.hasOwn(MATCH_QUERY_FIELD, event);

  if (!hasQuery) {
    if (matcher !== undefined && matcher !== '' && matcher !== '*') {
      findings.push(
        finding(
          'matcher-ignored-by-event',
          where,
          `this entry sets matcher "${q(matcher)}", but the platform builds no match query for ${q(event)} ` +
            '— measured, the filter is `($ ? T.filter(...) : T)`, so with no query the matcher list is not ' +
            'filtered at all. The hook fires for EVERY occurrence of the event. The matcher is not doing ' +
            'what it says; whatever it was meant to narrow has to be re-checked inside the hook.',
          'remove the matcher, and narrow inside the hook script instead',
        ),
      );
    }
    return findings;
  }

  if (matcher === undefined || matcher === '' || matcher === '*') {
    findings.push(
      finding(
        'matcher-matches-everything',
        where,
        `matcher ${matcher === undefined ? '(absent)' : `"${q(matcher)}"`} matches every ` +
          `${q(MATCH_QUERY_FIELD[event])} for this event. That is a deliberate shape, not a defect — ` +
          'stated so it is a choice on the record rather than an omission.',
      ),
    );
    return findings;
  }

  const branch = matcherBranch(matcher);

  if (branch === 'invalid-regex') {
    findings.push(
      finding(
        'matcher-invalid-regex',
        where,
        `matcher "${q(matcher)}" is not valid as a regular expression and does not fit the exact-match ` +
          'character class, so the platform catches the error locally and the predicate returns false ' +
          'FOREVER. This hook can never fire. The only trace is a debug-level log line.',
        'fix the expression, or write the matcher as an exact `A|B` list',
      ),
    );
    return findings;
  }

  // The measured killer: `Edit, Write` reads as a list, is valid JSON, appears
  // in the manifest, and matches nothing that will ever exist.
  if (branch === 'regex' && matcher.includes(',')) {
    findings.push(
      finding(
        'matcher-comma-separated',
        where,
        `matcher "${q(matcher)}" contains a comma. The platform never splits a matcher on commas: the ` +
          'exact-match branch is guarded by `/^[a-zA-Z0-9_|]+$/`, which a comma fails, so this became an ' +
          `unanchored regex that can only match a ${q(MATCH_QUERY_FIELD[event])} CONTAINING the literal ` +
          `text "${q(matcher)}". Measured: matcher "Edit, Write" matches neither "Edit" nor "Write". ` +
          'The entry looks installed and never fires.',
        `write it as an alternation instead: "${q(matcher.split(/\s*,\s*/).filter((s) => s !== '').join('|'))}"`,
      ),
    );
  } else if (branch === 'regex' && /\s/.test(matcher)) {
    findings.push(
      finding(
        'matcher-whitespace',
        where,
        `matcher "${q(matcher)}" contains whitespace, which puts it in the regex branch (the exact-match ` +
          'character class has no space in it). A regex containing a literal space matches only a subject ' +
          'containing that space, and no tool name, source or trigger does.',
        'remove the whitespace; use `A|B` for a list',
      ),
    );
  }

  // A matcher that matches every probe — including the empty string and a
  // string nobody would ever name — is a WILDCARD, whatever its syntax. Saying
  // ".+|^$ is unanchored" would be true, useless, and exactly the kind of
  // noise that gets a check switched off: the author wrote it precisely so
  // that it would match everything, including the measured empty-`agent_type`
  // case. Report the shape that is actually there.
  const probes = [...subjects, '', 'x', 'zzz-no-such-subject-9'];
  if (probes.every((p) => matcherMatches(p, matcher))) {
    findings.push(
      finding(
        'matcher-matches-everything',
        where,
        `matcher "${q(matcher)}" matches every ${q(MATCH_QUERY_FIELD[event])} this check can construct, ` +
          'including the empty string. That is a wildcard written the long way — a deliberate shape for ' +
          'an event whose subject must be re-checked inside the hook, and it is recorded here so the ' +
          'choice is on the record rather than mistaken for a narrowing that failed.',
      ),
    );
    return findings;
  }

  if (branch === 'regex' && !isAnchored(matcher)) {
    findings.push(
      finding(
        'matcher-unanchored',
        where,
        `matcher "${q(matcher)}" is applied with \`new RegExp(matcher)\` and is NOT anchored, so it ` +
          'matches anywhere inside the subject. Measured: `tyran-implementer` also matches ' +
          '`evil-tyran-implementer-nope`. For a gate this widens what it fires on; for an EXEMPTION it ' +
          'widens what escapes.',
        matcher.includes('|')
          ? 'anchor EACH alternative — `^a$|^b$`, not `^a|b$`, which anchors only the outer two'
          : `anchor it: "^${q(matcher)}$"`,
      ),
    );
  }

  // The namespace check, which this module's header promised and the first
  // pass never emitted — a declared severity with no code behind it is a line
  // no mutant can kill, i.e. exactly the decoration this file exists to find.
  //
  // Measured: an agent's `agent_type` is `<name from plugin.json>:<agent>`,
  // and the namespace comes from the MANIFEST, not the install directory. So
  // renaming the plugin silently disarms every matcher that spells the old
  // name, and nothing else in the system notices.
  if (namespace !== null && (event === 'SubagentStart' || event === 'SubagentStop')) {
    for (const [, spelled] of matcher.matchAll(/([A-Za-z0-9_-]+):/g)) {
      if (spelled === namespace) continue;
      findings.push(
        finding(
          'hook-namespace-drift',
          where,
          `matcher "${q(matcher)}" spells the namespace "${q(spelled)}:", but this plugin's manifest says ` +
            `its name is "${q(namespace)}" — so its agents present as "${q(namespace)}:<agent>". A plugin ` +
            'rename changes every agent_type at once and leaves the matchers behind; the hook then never ' +
            'fires and nothing reports it.',
          `spell it "${q(namespace)}:", or change "name" in .claude-plugin/plugin.json back`,
        ),
      );
      break;
    }
  }

  if (subjects.length === 0) return findings;

  const hits = subjects.filter((s) => matcherMatches(s, matcher));
  if (hits.length > 0) return findings;

  const listed = subjects.map((s) => `"${q(s)}"`).join(', ');
  if (closed) {
    findings.push(
      finding(
        'matcher-matches-nothing-closed',
        where,
        `matcher "${q(matcher)}" matches none of the ${subjects.length} values ${q(event)} can ever carry ` +
          `in ${q(MATCH_QUERY_FIELD[event])} (${listed}) — that set is closed by the platform's own input ` +
          'schema, so this hook can never fire.',
        'correct the matcher to one of the values above',
      ),
    );
  } else {
    findings.push(
      finding(
        'matcher-matches-nothing-known',
        where,
        `matcher "${q(matcher)}" matches none of the ${q(MATCH_QUERY_FIELD[event])} values this check ` +
          `knows about (${listed}). That set is OPEN — MCP tools arrive as \`mcp__server__tool\` and a ` +
          'project may define its own agents — so this is a warning, not a verdict. If the matcher aims ' +
          'at something outside the list, it is fine; if it aims at something in it, it is dead.' +
          (matcherBranch(matcher) === 'exact' || matcherBranch(matcher) === 'list'
            ? ' Note this matcher is in the EQUALITY branch: it is not a substring test, so a value ' +
              'like "tyran:implementer" can never be matched by "implementer".'
            : ''),
        'check the matcher against `claude agents` (for agent types) or the tool name in a transcript',
      ),
    );
  }
  return findings;
}

// ------------------------------------------------------------- the plugin

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where this checkout's plugin root is, derived from this file's own path. */
export const DEFAULT_PLUGIN_ROOT = resolve(HERE, '..');

/** Bytes of a hook script this check will read looking for its event name. */
const MAX_SCRIPT_BYTES = 512 * 1024;

/**
 * The agent types the plugin's own agents will present, measured format:
 * `<name from plugin.json>:<agent name>`.
 *
 * The namespace comes from the MANIFEST, not from the install directory —
 * proven with a directory called `DIRNAME_DIFFERENT` holding a manifest named
 * `manifestname`. The consequence is the reason this function exists: renaming
 * the plugin in `plugin.json` silently disarms every matcher that spells the
 * old namespace, and nothing else in the system would notice.
 */
export function pluginAgentTypes(root) {
  const namespace = readPluginName(root);
  if (namespace === null) return [];
  let entries;
  try {
    entries = readdirSync(join(root, 'agents'));
  } catch {
    return [];
  }
  return entries
    .filter((n) => n.endsWith('.md'))
    .map((n) => `${namespace}:${n.slice(0, -3)}`)
    .sort();
}

/** The `name` field of the plugin manifest, or null when unreadable. */
export function readPluginName(root) {
  try {
    const parsed = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof parsed?.name === 'string' && parsed.name !== '' ? parsed.name : null;
  } catch {
    return null;
  }
}

/** The subject vocabulary this check knows for an event, and whether it is all of it. */
export function subjectsFor(event, root) {
  if (Object.hasOwn(CLOSED_SUBJECTS, event)) {
    return { subjects: [...CLOSED_SUBJECTS[event]], closed: true };
  }
  if (MATCH_QUERY_FIELD[event] === 'tool_name') {
    return { subjects: [...KNOWN_TOOLS], closed: false };
  }
  if (event === 'SubagentStart' || event === 'SubagentStop') {
    // Built-ins measured live, plus this plugin's own agents. A project may
    // add more from `.claude/agents/`, so the set stays open.
    return { subjects: [...pluginAgentTypes(root), 'general-purpose', 'Explore'], closed: false };
  }
  return { subjects: [], closed: false };
}

/**
 * The event a hook script declares to its runtime, found textually.
 *
 * A HEURISTIC, and labelled as one everywhere it surfaces. It exists because
 * the failure it catches is total: `hook-io.runGate` compares the event it was
 * registered for against `hook_event_name` from the platform and turns a
 * mismatch into a refusal, so a gate registered under the wrong key in
 * hooks.json does not misbehave occasionally — it refuses EVERY invocation.
 * That is loud, but it is loud in the transcript of whoever hits it, not in
 * any place an installer looks.
 */
export function declaredEvents(source) {
  const found = new Set();
  for (const m of source.matchAll(/\bevent:\s*['"]([A-Za-z]+)['"]/g)) {
    if (PLATFORM_EVENTS.includes(m[1])) found.add(m[1]);
  }
  return [...found];
}

// ------------------------------------------------------------------- check

/**
 * Check every hook this plugin declares.
 *
 * Pure with respect to the process: everything it needs is a root directory
 * and an environment, both injectable, so the whole check is testable against
 * a synthetic plugin tree without touching the real one.
 */
export function checkHooks({ root = DEFAULT_PLUGIN_ROOT, env = process.env } = {}) {
  const findings = [];
  const checked = [];
  const pluginRoot = resolve(root);
  const vars = { CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: process.cwd() };

  // ---- the manifest ------------------------------------------------------
  const manifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    findings.push(
      finding(
        err.code === 'ENOENT' ? 'hooks-manifest-missing' : 'hooks-manifest-unreadable',
        q(manifestPath),
        err.code === 'ENOENT'
          ? 'no plugin manifest — nothing declares where the hooks file is, so no gate is registered at all'
          : `cannot read the plugin manifest (${q(err.message)})`,
      ),
    );
    return summarize(pluginRoot, findings, checked);
  }
  // Claude Code auto-loads the standard hooks/hooks.json at the plugin root, so
  // manifest.hooks is for ADDITIONAL hook files only. Declaring the standard
  // path there too is a duplicate the harness rejects — measured on 2.1.197,
  // "Duplicate hooks file detected" — and the plugin then fails to load and
  // gates NOTHING. This inverts the old check: a missing field is healthy when
  // the standard file exists, and a field naming the standard file is the error.
  const standardHooksPath = resolve(pluginRoot, 'hooks', 'hooks.json');
  const declaredHooks = typeof manifest?.hooks === 'string' ? manifest.hooks : null;
  const declaredIsStandard = declaredHooks !== null && resolve(pluginRoot, declaredHooks) === standardHooksPath;

  if (declaredIsStandard) {
    findings.push(
      finding(
        'hooks-manifest-duplicates-standard',
        q(manifestPath),
        `the manifest declares "hooks": ${q(declaredHooks)}, but Claude Code auto-loads the standard ` +
          'hooks/hooks.json at the plugin root. Declaring it again is a duplicate the harness rejects, so ' +
          'the plugin fails to load and gates NOTHING. manifest.hooks is for ADDITIONAL hook files only.',
        `remove the "hooks" key from ${q(manifestPath)} — the standard file is auto-loaded`,
      ),
    );
    return summarize(pluginRoot, findings, checked);
  }

  if (declaredHooks === null && !existsSync(standardHooksPath)) {
    findings.push(
      finding(
        'hooks-manifest-no-hooks',
        q(manifestPath),
        'no hooks file: the manifest declares none and there is no hooks/hooks.json at the plugin root, ' +
          'so nothing registers a gate at all.',
        `create ${q(standardHooksPath)} — it is auto-loaded — or point "hooks" at an additional file`,
      ),
    );
    return summarize(pluginRoot, findings, checked);
  }

  // The file the platform loads: the additional file if the manifest names one,
  // otherwise the auto-loaded standard file.
  const hooksRel = declaredHooks ?? './hooks/hooks.json';
  checked.push(
    `manifest: name "${readPluginName(pluginRoot) ?? '(unnamed)'}", hooks -> ${hooksRel}` +
      (declaredHooks === null ? ' (auto-loaded)' : ''),
  );

  // ---- the hooks file ----------------------------------------------------
  const hooksPath = resolve(pluginRoot, hooksRel);
  let doc;
  try {
    doc = JSON.parse(readFileSync(hooksPath, 'utf8'));
  } catch (err) {
    findings.push(
      finding(
        err.code === 'ENOENT' ? 'hooks-file-missing' : err instanceof SyntaxError ? 'hooks-file-invalid' : 'hooks-file-unreadable',
        q(hooksPath),
        err.code === 'ENOENT'
          ? 'the manifest points at a hooks file that does not exist — no gate is registered'
          : `the hooks file could not be read as JSON (${q(err.message)}). The platform reads the same ` +
            'file the same way, so it registers nothing and says nothing.',
        `node -e "JSON.parse(require('fs').readFileSync(${JSON.stringify(hooksPath)},'utf8'))"`,
      ),
    );
    return summarize(pluginRoot, findings, checked);
  }

  const events = doc?.hooks;
  if (typeof events !== 'object' || events === null || Array.isArray(events)) {
    findings.push(
      finding('hooks-file-invalid', q(hooksPath), 'the hooks file has no top-level "hooks" object'),
    );
    return summarize(pluginRoot, findings, checked);
  }
  const eventNames = Object.keys(events);
  if (eventNames.length === 0) {
    findings.push(finding('hooks-file-empty', q(hooksPath), 'the hooks file registers no events at all'));
    return summarize(pluginRoot, findings, checked);
  }

  // The platform deduplicates matched hooks by (pluginRoot, command), so two
  // entries carrying the same command run ONCE. Counted per event, because
  // that is the scope of the deduplication.
  let commandCount = 0;

  for (const event of eventNames) {
    if (!PLATFORM_EVENTS.includes(event)) {
      findings.push(
        finding(
          'hook-event-unknown',
          `${q(hooksPath)} -> hooks.${q(event)}`,
          `"${q(event)}" is not an event this platform build (${PLATFORM_VERSION}) dispatches. The block is ` +
            'never reached. A one-character typo in an event key removes every gate under it, and neither ' +
            'the manifest nor the platform complains.',
          `spell it as one of: ${PLATFORM_EVENTS.join(', ')}`,
        ),
      );
      continue;
    }
    const groups = events[event];
    if (!Array.isArray(groups)) {
      findings.push(
        finding('hook-event-not-a-list', `${q(hooksPath)} -> hooks.${q(event)}`, 'the value must be an array of matcher groups'),
      );
      continue;
    }
    const { subjects, closed } = subjectsFor(event, pluginRoot);
    const namespace = readPluginName(pluginRoot);
    const seenCommands = new Map();

    groups.forEach((group, gi) => {
      const at = `${q(hooksPath)} -> hooks.${q(event)}[${gi}]`;
      if (typeof group !== 'object' || group === null || !Array.isArray(group.hooks)) {
        findings.push(finding('hook-entry-malformed', at, 'a matcher group must be an object with a "hooks" array'));
        return;
      }
      findings.push(...analyzeMatcher(event, group.matcher, at, { subjects, closed, namespace }));

      group.hooks.forEach((hook, hi) => {
        const where = `${at}.hooks[${hi}]`;
        if (typeof hook !== 'object' || hook === null) {
          findings.push(finding('hook-entry-malformed', where, 'a hook entry must be an object'));
          return;
        }
        if (hook.type !== 'command') {
          findings.push(
            finding(
              'hook-type-unchecked',
              where,
              `hook type "${q(hook.type)}" is not a command hook. This check can only verify that a ` +
                'FILE exists and can run; nothing here inspects prompt, http, agent or callback hooks.',
            ),
          );
          return;
        }
        commandCount++;
        if (typeof hook.command !== 'string' || hook.command.trim() === '') {
          findings.push(finding('hook-command-missing', where, 'a command hook with no command string'));
          return;
        }
        if (hook.timeout === undefined) {
          findings.push(
            finding(
              'hook-no-timeout',
              where,
              'no timeout is declared, so the platform default of 600 seconds applies. A gate that hangs ' +
                'then holds the tool call for ten minutes, and its own runtime deadline cannot help: the ' +
                'deadline only survives if it is SHORTER than this number.',
              'add "timeout": <seconds>, larger than the gate\'s own deadline and far below 600',
            ),
          );
        } else if (typeof hook.timeout === 'number' && hook.timeout > MAX_PLAUSIBLE_TIMEOUT_S) {
          // Checking only for ABSENCE was the gap: a present-but-nonsensical
          // value passed silently, and the commonest nonsense is a
          // milliseconds figure in a field documented as seconds.
          const days = (hook.timeout / 86400).toFixed(1);
          findings.push(
            finding(
              'hook-timeout-implausible',
              where,
              `"timeout": ${hook.timeout} is in SECONDS — that is ${days} day(s). The platform's own ` +
                `default is ${MAX_PLAUSIBLE_TIMEOUT_S} s, so a value above it is almost always a ` +
                'millisecond figure pasted into a seconds field. Until the hook exits, the tool call it ' +
                'guards is held.',
              `set "timeout" to the number of SECONDS this hook may take (e.g. ${Math.max(1, Math.round(hook.timeout / 1000))})`,
            ),
          );
        }
        findings.push(...entryKeyFindings(event, hook, where));

        const previous = seenCommands.get(hook.command);
        if (previous !== undefined) {
          findings.push(
            finding(
              'hook-duplicate-command',
              where,
              `the same command is already registered for ${q(event)} at ${q(previous)}. The platform ` +
                'deduplicates matched hooks by (pluginRoot, command), so the second registration never ' +
                'runs — including its matcher, which is what usually makes this a mistake rather than ' +
                'a redundancy.',
              'give the two entries different commands, or merge their matchers',
            ),
          );
        } else {
          seenCommands.set(hook.command, where);
        }

        const lexed = lexCommand(hook.command);
        if (lexed.unterminatedQuote) {
          findings.push(
            finding('hook-command-not-modellable', where, 'the command has an unterminated quote; this check will not guess where the path ends'),
          );
          return;
        }
        for (const name of lexed.unquotedVars) {
          findings.push(
            finding(
              'hook-path-unquoted',
              where,
              `\${${q(name)}} is used unquoted. The platform spawns hook commands with \`shell: true\`, so ` +
                'the shell word-splits the substituted value: an installation path containing a space ' +
                'becomes two arguments, the first names a file that does not exist, the shell exits 127, ' +
                'and the action proceeds silently. Every gate under such a path is dead on machines whose ' +
                'home directory has a space in it, and alive everywhere else.',
              `quote it: "\\"\${${q(name)}}/...\\""`,
            ),
          );
        }
        // A metacharacter means the command is a shell program, not a file
        // invocation. Refuse to model it rather than check the wrong path.
        const unmodellable = lexed.metachars.filter((c) => c !== '$');
        if (unmodellable.length > 0) {
          findings.push(
            finding(
              'hook-command-not-modellable',
              where,
              `the command contains the shell metacharacter(s) ${unmodellable.map((c) => `"${c}"`).join(', ')}, ` +
                'so which file actually runs depends on the shell. This check verifies files, not shell ' +
                'programs, and says so rather than checking a path that may not be the one that executes.',
            ),
          );
          return;
        }
        // `node "<script>"` dispatches through the interpreter: the SCRIPT is
        // the file to check, and mode bits/shebang stop being requirements
        // (checkHookFile handles that under `dispatcher`).
        let programWord = lexed.argv[0] ?? '';
        let dispatcher = null;
        if (substitute(programWord, vars) === 'node' && typeof lexed.argv[1] === 'string') {
          dispatcher = 'node';
          programWord = lexed.argv[1];
        }
        const program = substitute(programWord, vars);
        if (program === '' || /\$\{/.test(program)) {
          findings.push(
            finding(
              'hook-command-not-modellable',
              where,
              `the command's program word "${q(programWord)}" still contains a variable this check ` +
                'cannot resolve, so the file it names is unknown here.',
            ),
          );
          return;
        }
        const path = resolve(pluginRoot, program);
        const fileFindings = checkHookFile(path, `${where} -> ${q(path)}`, { env, dispatcher });
        findings.push(...fileFindings);

        // Only cross-check the declared event when the file was readable —
        // otherwise the absent-file finding above is the whole story.
        if (fileFindings.some((f) => f.code === 'hook-file-absent' || f.code === 'hook-file-not-a-file' || f.code === 'hook-file-unreadable')) {
          return;
        }
        try {
          const stat = statSync(path);
          if (stat.size <= MAX_SCRIPT_BYTES) {
            const declared = declaredEvents(readFileSync(path, 'utf8'));
            if (declared.length > 0 && !declared.includes(event)) {
              findings.push(
                finding(
                  'hook-event-declaration-mismatch',
                  where,
                  `hooks.json registers this script for ${q(event)}, but the script itself names ` +
                    `${declared.map((e) => `"${q(e)}"`).join(', ')} to its runtime. hook-io compares the two ` +
                    'and turns a mismatch into a refusal, so the gate would refuse every invocation rather ' +
                    'than check anything. This is a TEXTUAL heuristic over the source, not a proof — a ' +
                    'script that computes its event will trip it wrongly.',
                  'align the event key in hooks.json with the one the script declares',
                ),
              );
            }
          }
        } catch {
          /* already reported above; a race here is not a second finding */
        }
      });
    });
    checked.push(`${event}: ${groups.length} matcher group(s)`);
  }

  if (findings.every((f) => f.severity === 'info')) {
    findings.push(
      finding(
        'hooks-ok',
        q(hooksPath),
        `${commandCount} command hook(s) checked against platform ${PLATFORM_VERSION}: every file exists, ` +
          'is executable, has a runnable shebang, and every matcher can match something. This is DETECTION ' +
          'only — nothing here can make a gate run.',
      ),
    );
  }
  return summarize(pluginRoot, findings, checked);
}

function summarize(root, findings, checked) {
  const order = ['error', 'warning', 'info'];
  const sorted = [...findings].sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of sorted) counts[f.severity]++;
  return {
    ok: counts.error === 0 && counts.warning === 0,
    root: q(root),
    platform: PLATFORM_VERSION,
    checked,
    counts,
    findings: sorted,
  };
}
