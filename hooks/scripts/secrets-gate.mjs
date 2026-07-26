#!/usr/bin/env node
/**
 * secrets-gate — the commit that carries a secret does not leave the machine.
 *
 * This is the only gate in Tyran whose failure is IRREVERSIBLE. A key pushed
 * to a public repository is burned the moment it is published, and deleting
 * the commit a minute later does not unburn it. Everything below is shaped by
 * that asymmetry, and by one measured property of the platform (ADR-22):
 * **Claude Code fails OPEN**, so a gate that breaks is a gate that approves.
 *
 * ## What this gate actually defends, stated honestly
 *
 * A `PreToolUse` hook sees the state BEFORE the command runs, so it can only
 * check what already exists. That single fact decides the whole architecture:
 *
 *  - `git commit` — the content is already in the index, so the index is
 *    scanned. This is the EARLY WARNING: it stops a secret before it ever
 *    becomes an object in the repository.
 *  - `git push` (and `gh pr create`, which pushes) — the commits already
 *    exist, so the range "local and not on any remote" is scanned. This is
 *    the REAL BOUNDARY, because publication is the irreversible act.
 *  - `git am`, `git cherry-pick`, `git rebase`, `git apply --index`, a commit
 *    made through the GitHub API, a commit made before this gate was
 *    installed — none of them can be checked in advance, because the content
 *    does not exist yet at the moment the gate runs. They are all caught at
 *    the push, which is the point of putting the boundary there.
 *
 * `docs/hooks.md` carries the same statement in the section that names what
 * this gate does not catch. Keep the two in step; a boundary described in
 * only one place drifts.
 *
 * ## Why the detector is deliberately over-sensitive
 *
 * The input is a shell command string written by a model. Recognising "this
 * is a commit" from it is a denylist on hostile input and therefore cannot be
 * complete (ADR-19 correction 1: an enumeration moves the hole, it does not
 * close it). The costs are wildly asymmetric — over-triggering costs one
 * gitleaks run, measured at 34 ms on a staged index and 187 ms on a 133-commit
 * range; under-triggering costs a burned key — so the detector errs towards
 * firing. Over-segmentation of the command string is likewise safe by
 * construction: splitting inside a quoted string can only produce MORE
 * candidate segments, never fewer.
 *
 * ## Why nothing from the command reaches a shell
 *
 * Every child process is spawned with an argument vector and `shell: false`.
 * The command string is never interpolated into another command, never
 * expanded, and never used to build a path that is executed. It is used for
 * exactly three things: lexical classification in this process, resolution of
 * a directory hint (which is then passed as one argv element to `git`), and
 * being piped to `gitleaks stdin` as data. This matters more than it looks:
 * in this initiative a live review already found two escaping lines with no
 * test whose removal produced execution of a planted command.
 */
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PASS, field, main, runGate } from './hook-io.mjs';

/**
 * This gate's own budget, half of the `timeout` its hooks.json entry declares
 * (a test walks both numbers and refuses to let them cross). The platform
 * kills a hook at its timeout and then does not read its output at all
 * (ADR-22 correction 2), so a gate that is merely slow has approved.
 */
export const DEADLINE_MS = 7000;

/**
 * Left unspent so a refusal can still be serialized and written after the
 * last child returns. Without it the final scan could consume the whole
 * budget and the verdict would be discarded as an overrun.
 */
export const DEADLINE_MARGIN_MS = 1200;

/** No single child may hold the whole budget; several may have to run. */
export const CHILD_BUDGET_MS = 5000;

/** Cheap `git` queries. Generous next to a measured 24-75 ms. */
export const GIT_BUDGET_MS = 2000;

/**
 * A gate reads no file without checking its size first (`docs/hooks.md`).
 * Measured: a gitleaks report over 2151 commits of a real repository held
 * 2157 findings; a bounded range holds a handful. Anything past this is a
 * signal that the scan was not the bounded one we asked for.
 */
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

/** Bytes of a command we are willing to hand to the scanner as data. */
export const MAX_COMMAND_BYTES = 128 * 1024;

/** Output kept from a child. Diagnostics only; never part of a refusal. */
const MAX_CHILD_OUTPUT_BYTES = 256 * 1024;

/** Findings named individually in a refusal before we stop repeating. */
const MAX_FINDINGS_SHOWN = 10;

/** Where the scanner lives. An operator may point at a pinned build. */
export const GITLEAKS_BIN = () => process.env.TYRAN_GITLEAKS_BIN || 'gitleaks';

/**
 * The conventional baseline: findings a repository has agreed to ignore.
 * Supported because a gate with no way to record an accepted exception gets
 * switched off wholesale, which protects nothing (ADR-19).
 */
export const BASELINE_ENV = 'TYRAN_GITLEAKS_BASELINE';
export const BASELINE_FILE = '.gitleaks-baseline.json';

// --------------------------------------------------------------- the lexer

/**
 * Characters at which one shell command can end and another begin.
 *
 * Quoting is deliberately NOT honoured. A quoted `;` is not a separator, so
 * respecting quotes would make the split more accurate — and less sensitive.
 * Splitting anyway can only cut a segment into more pieces, which can only
 * produce more candidate commands, which is the direction this gate wants to
 * be wrong in. `<` and `>` are redirections rather than separators and are
 * included for the same reason.
 */
export const SEPARATORS = ';&|\n\r()`{}<>';

/** Characters that make a word non-literal, i.e. the shell would rewrite it. */
export const EXPANSION_CHARS = '$`*?[]~!';

/**
 * Split a command line into candidate command segments.
 *
 * A backslash-newline continuation is folded to a space FIRST. Without that,
 * `git \<newline> commit` splits into a segment holding `git` and a segment
 * holding `commit`, and the detector sees neither a git invocation nor a
 * commit — a miss produced by pure formatting. The story lists exactly this
 * spelling as one the naive detector loses to.
 */
export function splitSegments(command) {
  const folded = String(command).replace(/\\\r?\n/g, ' ');
  const out = [];
  let current = '';
  for (const ch of folded) {
    if (SEPARATORS.includes(ch)) {
      out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out.filter((s) => s.trim() !== '');
}

/**
 * Words of one segment, normalized for RECOGNITION only.
 *
 * Quote and backslash characters are dropped from inside every word, which is
 * what defeats `gi"t" commit`, `g\it commit` and `git "commit"` in one rule
 * instead of three. The result is never executed, never used as a filesystem
 * path without a further existence check, and never concatenated into another
 * command — it exists purely to be compared against literals.
 */
export function tokensOf(segment) {
  return segment
    .split(/\s+/)
    .map((w) => w.replaceAll('"', '').replaceAll("'", '').replaceAll('\\', ''))
    .filter((w) => w !== '');
}

/** True for a word that invokes git, however it is spelled or pathed. */
export function isGitProgram(token) {
  const base = basename(token).toLowerCase();
  return base === 'git' || base === 'git.exe';
}

/** True for a word that invokes the GitHub CLI. */
export function isGhProgram(token) {
  const base = basename(token).toLowerCase();
  return base === 'gh' || base === 'gh.exe';
}

/** True for the short-option cluster `-abc` (not `--long`, not a value). */
function isShortCluster(token) {
  return token.length >= 2 && token[0] === '-' && token[1] !== '-';
}

/**
 * True when a word is safe to treat as a literal path. Anything the shell
 * would rewrite — a variable, a command substitution, a glob, a tilde — is
 * not, and this gate never performs that rewriting itself.
 */
export function isLiteralPath(token) {
  if (token === '' || token.startsWith('-')) return false;
  for (const ch of EXPANSION_CHARS) if (token.includes(ch)) return false;
  return true;
}

// ----------------------------------------------------------- the classifier

/** Refusals that need no scanner, and the way out of each. */
export const DENIAL_CODES = Object.freeze({
  NO_VERIFY: 'no-verify',
  HOOKS_PATH: 'hooks-path-override',
  FORCE_PUSH: 'force-push',
  SIGKILL: 'sigkill',
});

/**
 * Read a shell command and say what this gate must do about it.
 *
 * Pure, and that is the point: the whole detector — the part most likely to
 * be wrong — is testable without a filesystem, a repository or a scanner.
 */
export function classifyCommand(command) {
  const denials = [];
  const triggers = [];
  const hints = [];
  let scanStaged = false;
  let scanUnpushed = false;

  let lastTriggerSegment = -1;
  const allSegments = splitSegments(command);
  for (let segmentIndex = 0; segmentIndex < allSegments.length; segmentIndex++) {
    const segment = allSegments[segmentIndex];
    const tokens = tokensOf(segment);
    if (tokens.length === 0) continue;

    const hasGit = tokens.some(isGitProgram);
    const hasGh = tokens.some(isGhProgram);
    const words = new Set(tokens);
    const gitCommit = hasGit && words.has('commit');
    const gitPush = hasGit && words.has('push');
    // `gh pr create` pushes the current branch before opening the PR, and
    // `gh repo create --push`/`gh release create` publish just as finally as
    // a push does. They travel a different binary, not a different risk.
    const ghPublishes =
      hasGh &&
      ((words.has('pr') && words.has('create')) ||
        (words.has('repo') && words.has('create')) ||
        (words.has('release') && words.has('create')));

    if (gitCommit) {
      scanStaged = true;
      lastTriggerSegment = segmentIndex;
      triggers.push('a git commit (the index is scanned)');
    }
    if (gitPush || ghPublishes) {
      scanUnpushed = true;
      lastTriggerSegment = segmentIndex;
      triggers.push(
        gitPush
          ? 'a git push (every local commit not yet on a remote is scanned)'
          : 'a gh command that publishes (every local commit not yet on a remote is scanned)',
      );
    }

    // --- unconditional refusals -------------------------------------------

    // "Skip the hooks" is not a workflow, it is the removal of the control.
    // Scoped to nothing: a `--no-verify` anywhere in a command line means
    // some git invocation in it is bypassing verification, and the corpus
    // measurement found zero legitimate uses in 7168 real commands.
    if (words.has('--no-verify')) {
      denials.push({
        code: DENIAL_CODES.NO_VERIFY,
        detail: '`--no-verify` disables git\'s own hooks for this command',
        remedy:
          'run the command without --no-verify. If a repo hook is genuinely broken, fix or ' +
          'uninstall that hook deliberately rather than skipping verification for one commit.',
      });
    }
    // The same act, spelled through configuration instead of a flag.
    if (tokens.some((t) => t.toLowerCase().includes('core.hookspath'))) {
      denials.push({
        code: DENIAL_CODES.HOOKS_PATH,
        detail: '`core.hooksPath` is being overridden, which disables git\'s hooks for this command',
        remedy: 'run the command without -c core.hooksPath=...',
      });
    }
    // `git commit -n` IS --no-verify. `git push -n` is --dry-run, which is
    // harmless — so the cluster rule is applied only on the commit side.
    // Every other short option of `git commit` is a-p-C-c-F-m-t-s-e-i-o-u-v-q-S,
    // so an `n` inside a cluster can mean nothing else.
    if (gitCommit && tokens.some((t) => isShortCluster(t) && t.includes('n'))) {
      denials.push({
        code: DENIAL_CODES.NO_VERIFY,
        detail: '`-n` on git commit is --no-verify, which disables git\'s own hooks',
        remedy: 'drop the -n. On `git push` the same letter means --dry-run and is fine.',
      });
    }

    if (gitPush) {
      for (const token of tokens) {
        // Prefix, not equality, and the exemption below is what makes it
        // safe. An earlier version tested `token === '--force'` and then
        // exempted the leased spellings — which made the exemption DEAD CODE,
        // since a leased flag never matched the narrow test in the first
        // place. Mutation caught it (ADR-20): removing the exemption changed
        // nothing, which is the signature of a guard that guards nothing.
        // Written this way round, any future `--force-something` spelling is
        // refused by default and the two safe ones are named explicitly.
        const forced =
          token.startsWith('--force') ||
          (isShortCluster(token) && token.includes('f')) ||
          // `git push origin +main:main` is a force push wearing a refspec.
          (token.startsWith('+') && token.length > 1);
        const leased =
          token.startsWith('--force-with-lease') || token.startsWith('--force-if-includes');
        if (forced && !leased) {
          denials.push({
            code: DENIAL_CODES.FORCE_PUSH,
            detail: `\`${token}\` force-pushes: it overwrites the remote branch unconditionally`,
            remedy:
              'use --force-with-lease instead. The difference is not style: --force overwrites ' +
              'commits it has never seen, so it silently discards work another agent pushed ' +
              'between your last fetch and now. --force-with-lease refuses in exactly that case ' +
              'and succeeds in every other, so it costs you nothing and is not a weaker tool.',
          });
        }
      }
    }

    // SIGKILL leaves a slot dirty: no cleanup, no lease release, orphaned
    // lock files that the next agent then has to break by hand. The slot
    // protocol is built on SIGTERM for that reason.
    // ANY token, not the first one. `sudo kill -9 <pid>`, `env kill -9` and
    // `xargs kill -9` all put something else in the program slot, and a rule
    // that only reads position zero loses to every one of them. Measured on
    // 7168 real commands: this wider form produces zero false alarms.
    const killer = tokens.some((t) => ['kill', 'pkill', 'killall'].includes(basename(t)));
    if (killer) {
      const sig = tokens.some((t, i) => {
        const upper = t.toUpperCase();
        if (upper === '-9' || upper === '-SIGKILL' || upper === '-KILL') return true;
        if (upper === '-S9' || upper === '-SSIGKILL' || upper === '-SKILL') return true;
        if (t === '-s' || t === '--signal') {
          const next = (tokens[i + 1] ?? '').toUpperCase();
          return next === '9' || next === 'KILL' || next === 'SIGKILL';
        }
        return false;
      });
      if (sig) {
        denials.push({
          code: DENIAL_CODES.SIGKILL,
          detail: 'SIGKILL cannot be caught, so the target never runs its cleanup',
          remedy:
            'send SIGTERM (the default: `kill <pid>`), wait, and only escalate if the process ' +
            'is still there. A SIGKILLed agent leaves its lease held and its lock files behind, ' +
            'and the next agent has to break them by hand.',
        });
      }
    }

    // --- directory hints ---------------------------------------------------
    //
    // Which repository a command writes to is not always the session's cwd.
    // A gate that fires on `git -C ../other commit` and then scans the wrong
    // index has not failed loudly: it has PASSED quietly, which is failure
    // class 1. So every stated directory is collected here and resolved
    // later; an unresolvable one is refused rather than assumed away.
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (hasGit && token === '-C') {
        hints.push({ raw: tokens[i + 1] ?? '', why: 'git -C', segmentIndex });
      } else if (token.startsWith('--work-tree=')) {
        hints.push({ raw: token.slice('--work-tree='.length), why: 'git --work-tree', segmentIndex });
      } else if (token === 'cd' && i === 0) {
        hints.push({ raw: tokens[i + 1] ?? '', why: 'cd', segmentIndex });
      }
    }
  }

  return {
    denials,
    triggers: [...new Set(triggers)],
    scanStaged,
    scanUnpushed,
    // A directory named AFTER the last commit or push in the line cannot
    // change which repository that commit or push touched, so it is dropped
    // here rather than refused later. Sound, and it is not free-floating
    // leniency: measured on 7168 real commands it removes false alarms
    // without admitting a single new silent pass, because the only hints it
    // discards are ones no trigger can be downstream of.
    hints: hints.filter((h) => h.segmentIndex <= lastTriggerSegment),
    needsScan: scanStaged || scanUnpushed,
  };
}

// ------------------------------------------------------------ child process

/**
 * Run a child with an argument VECTOR and no shell, under its own timeout.
 *
 * Asynchronous on purpose, and this is a correctness property rather than a
 * preference. `execFileSync` would block the thread, and a blocked thread is
 * the one deadline case `hook-io` explicitly cannot enforce (`docs/hooks.md`,
 * third row): nothing else runs, the platform kills the process, and the
 * output it wrote is never parsed. Staying asynchronous keeps the event loop
 * free so the runtime's own timer can still emit a refusal and EXIT.
 *
 * The child is killed with SIGKILL when it overruns. That is not in tension
 * with this gate refusing `kill -9` elsewhere: the rule protects agent slots
 * that hold leases and lock files, and a scanner process holds neither.
 */
export function runChild(bin, args, { cwd, timeoutMs, input = null } = {}) {
  return new Promise((resolveChild) => {
    let child;
    try {
      // shell:false is the anti-injection guarantee, spelled out rather than
      // left to the default: with it, a command full of metacharacters is
      // inert data in argv[n].
      child = spawn(bin, args, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolveChild({ spawned: false, error: err });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveChild(result);
    };
    child.on('error', (err) => finish({ spawned: false, error: err }));
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_CHILD_OUTPUT_BYTES) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_CHILD_OUTPUT_BYTES) stderr += d.toString('utf8');
    });
    child.on('close', (code, signal) => finish({ spawned: true, code, signal, stdout, stderr, timedOut }));
    // A scanner that exits before reading its input makes the write fail with
    // EPIPE; that is the child's verdict arriving early, not our error.
    child.stdin.on('error', () => {});
    child.stdin.end(input === null ? '' : input);
  });
}

// ------------------------------------------------------------------ scanner

/** A budget that shrinks as the gate spends it, so the total stays bounded. */
export function makeBudget(startedAt, deadlineMs = DEADLINE_MS, margin = DEADLINE_MARGIN_MS) {
  return (cap) => {
    const remaining = deadlineMs - (Date.now() - startedAt) - margin;
    return Math.min(cap, remaining);
  };
}

/** Thrown when the gate could not complete a check. Always becomes a refusal. */
export class ScanFailure extends Error {
  constructor(what, remedy) {
    super(what);
    this.name = 'ScanFailure';
    this.remedy = remedy;
  }
}

const INSTALL_INSTRUCTIONS =
  'Install it and re-run:\n' +
  '    macOS      brew install gitleaks\n' +
  '    Linux      see https://github.com/gitleaks/gitleaks/releases (or your package manager)\n' +
  '    Docker     alias gitleaks=\'docker run --rm -v "$PWD:/p" zricethezav/gitleaks:latest\'\n' +
  'or point TYRAN_GITLEAKS_BIN at an existing binary.\n' +
  'This gate refuses instead of warning on purpose: a check that passes when its scanner ' +
  'is missing is a check you disable by uninstalling a package.';

/**
 * Read a gitleaks JSON report, size-checked before it is opened.
 *
 * The size check is the rule from `docs/hooks.md` and it is load-bearing
 * here: an unbounded `readFile` inside a gate is the deadline case the
 * runtime cannot enforce.
 */
async function readReport(path) {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    // Measured, and it is the reason this function exists: on a FATAL error
    // gitleaks exits 1 — the same code it uses for "leaks found" — and writes
    // no report at all. Exit status alone therefore cannot tell a leak from a
    // broken scan, and the one that must never be mistaken for the other is
    // the broken scan.
    throw new ScanFailure(
      `the scanner wrote no report (${err.code ?? err.message})`,
      'run the same gitleaks command by hand to see why; the gate refuses while it cannot read a result',
    );
  }
  if (info.size > MAX_REPORT_BYTES) {
    throw new ScanFailure(
      `the scanner's report is ${info.size} bytes, past the ${MAX_REPORT_BYTES}-byte limit this gate will read`,
      'that size means the scan was far wider than the bounded range asked for; run gitleaks by hand',
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (err) {
    throw new ScanFailure(
      `the scanner's report is not JSON (${err.message})`,
      'check the gitleaks version; this gate expects --report-format json',
    );
  }
  if (!Array.isArray(parsed)) {
    throw new ScanFailure('the scanner\'s report is not a JSON array', 'check the gitleaks version');
  }
  return parsed;
}

/**
 * Keep only the fields that can never carry the secret itself.
 *
 * `Match`, `Secret` and `Line` hold the finding verbatim, and a refusal
 * reason is written into the transcript and into the model's context — so
 * quoting one there would publish the key in the act of refusing to publish
 * it. `--redact` is passed to gitleaks as well, which makes this a second
 * layer rather than the only one; a test asserts the generated secret does
 * not appear in the refusal.
 */
export function safeFinding(raw) {
  return {
    rule: typeof raw?.RuleID === 'string' ? raw.RuleID : '(unnamed rule)',
    file: typeof raw?.File === 'string' && raw.File !== '' ? raw.File : null,
    line: Number.isInteger(raw?.StartLine) ? raw.StartLine : null,
    commit: typeof raw?.Commit === 'string' && raw.Commit !== '' ? raw.Commit.slice(0, 12) : null,
  };
}

/** Flags shared by every invocation, including the baseline when there is one. */
export function commonArgs({ reportPath, baseline }) {
  const args = [
    '--report-format',
    'json',
    '--report-path',
    reportPath,
    '--no-banner',
    // Belt and braces: with this, the secret is not in the report we parse,
    // so a future edit that widens the quoted fields still cannot leak it.
    '--redact',
  ];
  if (baseline !== null) args.push('--baseline-path', baseline);
  return args;
}

/**
 * One gitleaks invocation, turned into findings or into a ScanFailure.
 * Never into silence: every ending here is either a verdict or a refusal.
 */
async function invokeScanner({ args, cwd, timeoutMs, input, reportPath, runner }) {
  if (timeoutMs <= 0) {
    throw new ScanFailure(
      'the gate ran out of its own budget before it could start the scan',
      'raise DEADLINE_MS together with the timeout in hooks.json',
    );
  }
  const result = await runner(GITLEAKS_BIN(), args, { cwd, timeoutMs, input });
  if (!result.spawned) {
    if (result.error?.code === 'ENOENT') {
      throw new ScanFailure(`gitleaks is not installed (or not on PATH)`, INSTALL_INSTRUCTIONS);
    }
    throw new ScanFailure(
      `gitleaks could not be started (${result.error?.code ?? result.error?.message ?? 'unknown error'})`,
      INSTALL_INSTRUCTIONS,
    );
  }
  if (result.timedOut) {
    // The report is deliberately NOT read here. A killed scan may have
    // written a partial report, and a partial report showing no findings is
    // indistinguishable from a clean one — the exact shape of a silent pass.
    throw new ScanFailure(
      `the scan did not finish within ${timeoutMs} ms and was killed`,
      'a range this large cannot be checked inside a hook budget; run gitleaks by hand, ' +
        'or push in smaller steps so the unpushed range stays bounded',
    );
  }
  const findings = await readReport(reportPath);
  // gitleaks exits 0 for clean and 1 for "leaks found". Any other code is the
  // scanner reporting that it failed, and a failed scan is not a pass.
  if (result.code !== 0 && result.code !== 1) {
    throw new ScanFailure(
      `gitleaks exited ${result.code}${result.signal ? ` (signal ${result.signal})` : ''}`,
      `its own message was: ${result.stderr.trim().split('\n').slice(-3).join(' | ') || '(nothing on stderr)'}`,
    );
  }
  return findings.map(safeFinding);
}

// ---------------------------------------------------------------- git facts

/** The work tree root for a directory, or null when it is not in a repo. */
export async function gitToplevel(dir, { runner, timeoutMs }) {
  const result = await runner('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
    cwd: undefined,
    timeoutMs,
  });
  if (!result.spawned || result.timedOut || result.code !== 0) return null;
  const line = result.stdout.trim().split('\n')[0] ?? '';
  return line === '' ? null : line;
}

/** How many commits a push from here would publish. Diagnostic, not a gate. */
export async function unpushedCount(repo, { runner, timeoutMs }) {
  const result = await runner('git', ['-C', repo, 'rev-list', '--count', '--all', '--not', '--remotes'], {
    cwd: undefined,
    timeoutMs,
  });
  if (!result.spawned || result.timedOut || result.code !== 0) return null;
  const n = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/** The repo's agreed baseline of ignorable findings, or null. */
export async function findBaseline(repo) {
  const fromEnv = process.env[BASELINE_ENV];
  if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv;
  const candidate = join(repo, BASELINE_FILE);
  try {
    if ((await stat(candidate)).isFile()) return candidate;
  } catch {
    /* no baseline, which is the normal case */
  }
  return null;
}

// ----------------------------------------------------------------- the gate

function renderFindings(findings) {
  const shown = findings.slice(0, MAX_FINDINGS_SHOWN).map((f) => {
    const where = f.file ? f.file : 'the command text itself';
    const at = f.line === null ? '' : `:${f.line}`;
    const inCommit = f.commit ? ` in commit ${f.commit}` : '';
    return `  - ${where}${at}${inCommit} — rule \`${f.rule}\``;
  });
  if (findings.length > MAX_FINDINGS_SHOWN) {
    shown.push(`  - ... and ${findings.length - MAX_FINDINGS_SHOWN} more`);
  }
  return shown.join('\n');
}

/**
 * Resolve every repository this command could write to.
 *
 * The session's own cwd is always one of them. A stated hint that resolves to
 * a different work tree is added; a hint that cannot be resolved is a
 * refusal, because scanning the wrong repository and passing is the failure
 * this whole function exists to prevent.
 */
export async function resolveRepos({ cwd, hints, runner, budget }) {
  const repos = new Set();
  // `typeof`, not `!== null`: an absent cwd arrives as undefined, and passing
  // that to the argument vector below would throw inside spawn rather than
  // land in the "no work tree" refusal where it belongs.
  const root =
    typeof cwd === 'string' && cwd !== ''
      ? await gitToplevel(cwd, { runner, timeoutMs: budget(GIT_BUDGET_MS) })
      : null;
  if (root !== null) repos.add(root);

  for (const hint of hints) {
    if (hint.raw === '' || !isLiteralPath(hint.raw)) {
      // Only refuse when the unresolvable hint could actually change the
      // answer. `cd "$DIR" && npm test` has no scan to misdirect.
      throw new ScanFailure(
        `this command names a directory the gate cannot resolve without running a shell (${hint.why} ${hint.raw === '' ? '(empty)' : hint.raw})`,
        'the gate never expands variables, globs or command substitutions from a command line — ' +
          'that is what keeps hostile input out of a shell. Write the path literally, or run the ' +
          'command from that directory so the session cwd names it.',
      );
    }
    const abs = resolvePath(cwd ?? process.cwd(), hint.raw);
    const top = await gitToplevel(abs, { runner, timeoutMs: budget(GIT_BUDGET_MS) });
    if (top !== null) repos.add(top);
  }
  if (repos.size === 0) {
    throw new ScanFailure(
      'the gate could not find a git work tree for this command',
      'if the command really does not touch a repository, it should not have matched the ' +
        'detector; report the command so the detector can be narrowed',
    );
  }
  return [...repos];
}

/**
 * The whole decision, with its I/O injected.
 *
 * Injection is not for tidiness. Every failure mode this gate must survive —
 * a missing scanner, a scan that times out, a scanner that exits 137, a
 * report that is not JSON — is reachable only by controlling the child
 * runner, and ADR-22 requires a test for each of them separately.
 */
export async function decide({ input, cwd, runner = runChild, startedAt = Date.now() } = {}) {
  const budget = makeBudget(startedAt);
  const toolName = field(input, 'tool_name');
  const toolInput = field(input, 'tool_input');
  const command = field(toolInput, 'command');

  // A matcher is a narrowing this gate does not rely on. Measured in
  // v2.1.116, a matcher that is not pure `[a-zA-Z0-9_|]` becomes an
  // UNANCHORED regex, so a gate can be handed a tool it never asked for — and
  // a `Write` call has no `command`, which would otherwise fall into the
  // refusal below and block every file write in the session. This gate models
  // Bash and says so; anything else is not its business.
  if (typeof toolName === 'string' && toolName !== 'Bash') return PASS;

  if (typeof command !== 'string') {
    // A Bash call whose command we cannot read is a Bash call we cannot
    // check. The platform fails open, so silence here would be approval.
    return {
      decision: 'deny',
      reason:
        'tyran secrets-gate: this Bash call carries no readable `command`, so the gate could ' +
        'not check it for secrets.\nA check that cannot run must not read as approval (ADR-22).',
    };
  }

  const found = classifyCommand(command);

  if (found.denials.length > 0) {
    const lines = found.denials.map((d) => `- ${d.detail}\n  instead: ${d.remedy}`);
    return {
      decision: 'deny',
      reason:
        `tyran secrets-gate: refused, ${found.denials.length} unconditional rule(s) matched.\n` +
        `${lines.join('\n')}\n` +
        'These are refused without scanning anything, because each one is a way of turning a ' +
        'control off rather than a way of doing work.',
    };
  }

  if (!found.needsScan) return PASS;

  if (Buffer.byteLength(command, 'utf8') > MAX_COMMAND_BYTES) {
    throw new ScanFailure(
      `the command is ${Buffer.byteLength(command, 'utf8')} bytes, past the ${MAX_COMMAND_BYTES} this gate will scan`,
      'split the command; a gate that skips oversized input is a gate with a size-shaped hole in it',
    );
  }

  const repos = await resolveRepos({ cwd, hints: found.hints, runner, budget });
  const workDir = await mkdtemp(join(tmpdir(), 'tyran-secrets-gate-'));
  const findings = [];
  const scanned = [];
  let baselineUsed = null;
  try {
    let n = 0;
    for (const repo of repos) {
      const baseline = await findBaseline(repo);
      if (baseline !== null) baselineUsed = baseline;

      if (found.scanStaged) {
        const reportPath = join(workDir, `staged-${n++}.json`);
        findings.push(
          ...(await invokeScanner({
            args: ['git', '--staged', ...commonArgs({ reportPath, baseline }), repo],
            cwd: repo,
            timeoutMs: budget(CHILD_BUDGET_MS),
            input: null,
            reportPath,
            runner,
          })),
        );
        scanned.push(`the staged index of ${repo}`);
      }

      if (found.scanUnpushed) {
        const reportPath = join(workDir, `unpushed-${n++}.json`);
        const count = await unpushedCount(repo, { runner, timeoutMs: budget(GIT_BUDGET_MS) });
        findings.push(
          ...(await invokeScanner({
            args: [
              'git',
              // Bounded on purpose. Measured on a 2151-commit repository: the
              // full history takes 18.8 s and produces 2157 findings, which is
              // both past any hook budget and past any human's patience. The
              // range "local and on no remote" is what a push would actually
              // publish, and the same repository answers it in 187 ms.
              '--log-opts=--all --not --remotes',
              ...commonArgs({ reportPath, baseline }),
              repo,
            ],
            cwd: repo,
            timeoutMs: budget(CHILD_BUDGET_MS),
            input: null,
            reportPath,
            runner,
          })),
        );
        scanned.push(`${count === null ? 'the' : count} unpushed commit(s) of ${repo}`);
      }
    }

    // The command line itself, scanned as DATA through the same rule set.
    // `git commit -m "<key>"` puts a secret into history without it ever
    // being in the index, so the index scan alone has a hole exactly the
    // shape of a commit message. Delegating to the same scanner rather than
    // writing a second list of secret patterns is deliberate: this repo has
    // already paid for having one rule in three spellings (ADR-19 corr. 1).
    const reportPath = join(workDir, 'command.json');
    findings.push(
      ...(await invokeScanner({
        args: ['stdin', ...commonArgs({ reportPath, baseline: baselineUsed })],
        cwd: undefined,
        timeoutMs: budget(CHILD_BUDGET_MS),
        input: command,
        reportPath,
        runner,
      })),
    );
    scanned.push('the command line itself');
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }

  if (findings.length === 0) return PASS;

  return {
    decision: 'deny',
    reason:
      `tyran secrets-gate: refused. ${findings.length} secret-shaped finding(s) in what this ` +
      `command would publish.\n` +
      `Triggered by: ${found.triggers.join('; ')}.\n` +
      `Scanned: ${scanned.join('; ')}.\n` +
      `${renderFindings(findings)}\n` +
      (baselineUsed === null ? '' : `A baseline was applied: ${baselineUsed}.\n`) +
      'The secret itself is NOT quoted above, deliberately: this text goes into the transcript ' +
      'and into the model context, and repeating a key there would publish it in the act of ' +
      'refusing to publish it. Open the file and line named above.\n' +
      'If a finding is a false positive, record it in .gitleaksignore by its fingerprint, or ' +
      `agree a baseline at ${BASELINE_FILE} — do not work around the gate.`,
  };
}

/** Turn a ScanFailure into the refusal it always has to be. */
export async function handle({ input, cwd, runner, startedAt }) {
  try {
    return await decide({ input, cwd, runner, startedAt });
  } catch (err) {
    if (err instanceof ScanFailure) {
      return {
        decision: 'deny',
        reason:
          `tyran secrets-gate: refused because the check could not be completed.\n` +
          `what happened: ${err.message}\n` +
          `what to do: ${err.remedy}\n` +
          'This is a refusal rather than a warning because the platform fails open (ADR-22): ' +
          'a gate that lets the action through whenever it breaks is a gate you switch off by ' +
          'breaking it.',
      };
    }
    // Anything else is a bug in this gate. hook-io turns a throw into a
    // refusal naming the error class, which is the correct ending, so it is
    // re-thrown rather than swallowed into a vague message here.
    throw err;
  }
}

/** See journal.mjs — both sides canonicalized, or a symlinked path no-ops. */
function canonicalPath(path) {
  const abs = resolvePath(path);
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
      event: 'PreToolUse',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => handle({ input, cwd: field(input, 'cwd') ?? process.cwd() }),
    }),
  );
}
