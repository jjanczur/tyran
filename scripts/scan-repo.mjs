#!/usr/bin/env node
/**
 * scan-repo — everything about a repository that can be established WITHOUT
 * asking, and an honest list of what cannot.
 *
 * This is the deterministic half of `/tyran:setup`. Keeping it in a script
 * rather than in the skill's prose matters for one reason: the same repo must
 * produce the same answer every time. A model asked to "work out the
 * validation commands" produces a plausible answer, and a plausible answer to
 * "how do I know this repo is green" is worse than no answer, because it is
 * believed once and then never re-examined.
 *
 * Every value it emits carries PROVENANCE — the fact that produced it and a
 * confidence. A field it could not establish is marked `needs_confirmation`,
 * which is the only thing setup is allowed to ask the operator about. The
 * point of the provenance is auditability months later: "why does this repo
 * think it is P2" has an answer in the file itself.
 *
 * ## The one thing this deliberately will not do
 *
 * It never infers `P3`. Autonomy class P3 means an agent merges to main and
 * deploys to production; no arrangement of files is evidence that a human
 * intended to grant that. P1 is the default, P2 requires positive evidence,
 * and P3 is a decision a person makes in words.
 *
 * CLI:
 *   node scan-repo.mjs [--dir <repo>] [--write <path>] [--json]
 *   node scan-repo.mjs [--dir <repo>] --ensure-policy
 * Exit: 0 scanned · 2 usage/IO error
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmdirSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from './yaml-lite.mjs';
import { validatePolicy } from './schema.mjs';
import { escapeInvisible } from './invisible.mjs';

/** Lockfile -> package manager. Order matters only for reporting stability. */
export const LOCKFILES = Object.freeze({
  'pnpm-lock.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'yarn.lock': 'yarn',
  'package-lock.json': 'npm',
  'poetry.lock': 'poetry',
  'uv.lock': 'uv',
  'Cargo.lock': 'cargo',
  'go.sum': 'go',
  'Gemfile.lock': 'bundler',
});

/** Extension -> language, for the "what is this repo written in" summary. */
export const LANGUAGES = Object.freeze({
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.swift': 'Swift',
  '.php': 'PHP',
  '.cs': 'C#',
  '.sh': 'Shell',
});

/**
 * Script names worth running before calling something done. `build` is
 * deliberately absent: it is slow, and on most repos the type check already
 * covers what a build would catch.
 *
 * `format:check` leads because it is the cheapest and fails fastest, and it is
 * here at all because omitting it ships a red main. Measured: a repo declared
 * `format:check` in package.json AND ran it in CI, this list did not include
 * it, so no handoff required it — two unformatted files reached main and
 * needed a repair commit. Only the CHECKING name is listed: a bare `format`
 * REWRITES the working tree, which is not a validation command.
 */
export const VALIDATION_SCRIPTS = Object.freeze(['format:check', 'lint', 'typecheck', 'types', 'test']);

const RUN_PREFIX = Object.freeze({ npm: 'npm run', pnpm: 'pnpm', yarn: 'yarn', bun: 'bun run' });

function provenance(value, source, confidence, needsConfirmation = false) {
  return { value, source, confidence, needs_confirmation: needsConfirmation };
}

/** Run a git command, returning '' when git is absent or the call fails. */
export function gitRunner(dir) {
  return (args) => {
    try {
      return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return '';
    }
  };
}

/** The repo's tracked files as a Set, or null when git could not answer. */
export function trackedFiles(run) {
  const listing = run(['ls-files']);
  if (listing === '') return null;
  return new Set(listing.split('\n').filter((line) => line !== ''));
}

/**
 * Which package manager this repo actually uses.
 *
 * A lockfile being ON DISK is not evidence that it is the repo's lockfile.
 * Measured on a real install: the repo had both `pnpm-lock.yaml` and
 * `package-lock.json`, `pnpm-lock.yaml` was gitignored and untracked, and
 * `.gitignore` said in words that the npm lockfile was authoritative. Picking
 * by disk order chose pnpm, and then EVERY validation command was wrong —
 * `pnpm lint`, `pnpm typecheck`, `pnpm test` in a repo with no pnpm.
 *
 * So git is asked which lockfiles it tracks, and a tracked one wins. The
 * distinction that keeps this honest: `git ls-files` returning NOTHING means
 * git could not answer (no repository, nothing committed yet), and no
 * conclusion is drawn from it. A non-empty listing that omits a lockfile is
 * positive evidence that the file is ignored or untracked, and that is the
 * only case that changes the answer.
 */
export function detectPackageManager(dir, run = gitRunner(dir)) {
  const present = Object.entries(LOCKFILES).filter(([file]) => existsSync(join(dir, file)));
  if (present.length > 0) {
    const tracked = trackedFiles(run);
    if (tracked === null) {
      const [file, manager] = present[0];
      return provenance(manager, `lockfile: ${file}`, 0.95);
    }
    const inGit = present.filter(([file]) => tracked.has(file));
    if (inGit.length > 0) {
      const [file, manager] = inGit[0];
      const ignored = present.filter(([f]) => !tracked.has(f)).map(([f]) => f);
      const source =
        ignored.length === 0
          ? `lockfile: ${file}`
          : `lockfile: ${file} — tracked by git, unlike ${ignored.join(', ')}, which git does not track`;
      return provenance(manager, source, 0.95);
    }
    // On disk, none of them committed. Something is the answer here, but the
    // repository is not saying which — so it is a flagged guess, not a fact.
    const [file, manager] = present[0];
    return provenance(
      manager,
      `lockfile: ${file}, but git tracks no lockfile at all — this one may be ignored`,
      0.4,
      true,
    );
  }
  if (existsSync(join(dir, 'package.json'))) {
    return provenance('npm', 'package.json with no lockfile — npm assumed', 0.5, true);
  }
  return null;
}

export function readPackageJson(dir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Validation commands, taken from what the repo ACTUALLY declares.
 *
 * A guessed command is worse than none: it fails for a reason unrelated to
 * the change, the agent spends a round on it, and the operator learns the
 * gate is noise. When nothing can be read, the list comes back empty and
 * flagged rather than filled in with `npm test`.
 */
/**
 * Suffixes a repo uses for "the same thing, but it exits". Tried in order.
 */
export const RUN_ONCE_SUFFIXES = Object.freeze([':run', ':ci', ':once']);

/**
 * Why this script would never return, or null.
 *
 * This is the single most dangerous inference the scanner can make. A
 * validation command that watches instead of exiting does not fail the agent
 * that runs it — it HANGS it, with no output and no timeout, and the operator
 * sees a session that has simply stopped. Measured on a real install: setup
 * wrote `pnpm test`, whose script was bare `vitest`, and every agent handed
 * that gate would have waited forever.
 *
 * Deliberately narrow, because a false positive here drops a real test command
 * out of the config. `jest` is NOT listed: it runs once by default and only
 * watches when told to, so the explicit-flag rule below already covers it.
 */
export function watchModeProblem(script) {
  const text = String(script);
  if (/(^|[\s;&|])nodemon(\s|$)/.test(text)) return 'runs `nodemon`, which watches and never exits';
  if (/--watch(All|-all)?\b(?!=false)/.test(text)) return 'passes --watch, so it never exits';
  // `vitest` with no subcommand is watch mode outside CI. `vitest run`,
  // `vitest bench` and an explicit `--run` all terminate.
  if (/(^|[\s;&|])vitest(\s|$)/.test(text) && !/(^|\s)vitest\s+(run|bench|related)\b/.test(text) && !/--run\b/.test(text)) {
    return 'is bare `vitest`, which defaults to watch mode and never exits';
  }
  return null;
}

/**
 * The script to actually run for `name`, avoiding a watcher.
 *
 * Returns `{ script, note }` — `script` null when every candidate watches,
 * which is a command deliberately LEFT OUT rather than written into a config
 * where it would hang the first agent that trusted it.
 */
export function resolveValidationScript(scripts, name) {
  const problem = watchModeProblem(scripts[name]);
  if (problem === null) return { script: name, note: null };
  for (const suffix of RUN_ONCE_SUFFIXES) {
    const alternate = `${name}${suffix}`;
    if (typeof scripts[alternate] === 'string' && watchModeProblem(scripts[alternate]) === null) {
      return { script: alternate, note: `\`${name}\` ${problem}, so \`${alternate}\` is used instead` };
    }
  }
  return { script: null, note: `\`${name}\` ${problem}, and no run-once variant exists — left out` };
}

export function detectValidation(dir, pkg, manager) {
  const scripts = pkg?.scripts;
  if (scripts && typeof scripts === 'object') {
    const prefix = RUN_PREFIX[manager] ?? 'npm run';
    const found = [];
    const notes = [];
    let dropped = false;
    for (const name of VALIDATION_SCRIPTS) {
      if (typeof scripts[name] !== 'string') continue;
      const { script, note } = resolveValidationScript(scripts, name);
      if (note !== null) notes.push(note);
      if (script === null) dropped = true;
      else found.push(`${prefix} ${script}`);
    }
    if (found.length > 0 || notes.length > 0) {
      const base = `package.json scripts: ${found.length} of the usual names`;
      const source = notes.length === 0 ? base : `${base}. ${notes.join('; ')}`;
      // A dropped command means this repo's validation is INCOMPLETE, and the
      // operator is the only one who can say what to run instead.
      return provenance(found, source, dropped ? 0.6 : 0.9, dropped);
    }
  }
  if (existsSync(join(dir, 'Makefile'))) {
    try {
      const text = readFileSync(join(dir, 'Makefile'), 'utf8');
      const targets = ['lint', 'test', 'check'].filter((t) => new RegExp(`^${t}:`, 'm').test(text));
      if (targets.length > 0) {
        return provenance(targets.map((t) => `make ${t}`), `Makefile targets: ${targets.join(', ')}`, 0.8);
      }
    } catch {
      /* fall through to the honest empty answer */
    }
  }
  return provenance([], 'no scripts or Makefile targets recognised — fill these in yourself', 0.2, true);
}

export function detectLanguages(dir, run = gitRunner(dir)) {
  const listing = run(['ls-files']);
  if (listing === '') return [];
  const counts = new Map();
  for (const file of listing.split('\n')) {
    const lang = LANGUAGES[extname(file)];
    if (lang) counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([lang]) => lang);
}

/**
 * Infer the deployment autonomy class from how the repository is actually
 * worked, not from what a document claims.
 *
 * P3 is never inferred. See the header: no arrangement of files is evidence
 * that a human meant to let an agent deploy to production.
 */
export function detectAutonomy(dir, run = gitRunner(dir)) {
  const head = run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (head === '') return provenance('P1', 'not a git repository — the safest class', 0.4, true);

  const log = run(['log', '--first-parent', '-50', '--pretty=%p|%s']).trim();
  if (log === '') return provenance('P1', 'no commit history to judge from — the safest class', 0.4, true);

  const commits = log.split('\n');
  const merges = commits.filter((line) => {
    const [parents, subject = ''] = line.split('|');
    return parents.trim().split(/\s+/).length > 1 || /^Merge pull request|^Merge branch/.test(subject);
  }).length;
  const share = merges / commits.length;

  const branches = run(['branch', '-a', '--format=%(refname:short)']);
  const hasStaging = /(^|\/)(staging|testing|develop|preprod)$/m.test(branches);
  const hasCi = existsSync(join(dir, '.github', 'workflows')) || existsSync(join(dir, '.gitlab-ci.yml'));

  if (share >= 0.6) {
    return provenance(
      'P1',
      `git log: ${merges} of the last ${commits.length} first-parent commits arrived as merges — main is PR-driven`,
      0.85,
    );
  }
  if (hasStaging && hasCi) {
    return provenance(
      'P2',
      `git log: ${merges}/${commits.length} merges, plus a staging-class branch and CI — direct pushes look normal here`,
      0.6,
      true,
    );
  }
  return provenance(
    'P1',
    `git log: ${merges}/${commits.length} merges, no staging branch found — defaulting to the safest class`,
    0.5,
    true,
  );
}

/** The whole scan. Returns `{config, languages, questions}`. */
export function scanRepo(dir, { run = gitRunner(dir) } = {}) {
  const pkg = readPackageJson(dir);
  const manager = detectPackageManager(dir, run);
  const validation = detectValidation(dir, pkg, manager?.value);
  const autonomy = detectAutonomy(dir, run);
  const languages = detectLanguages(dir, run);

  const config = {
    profile: 'balanced',
    autonomy,
    tiers: { cheap: 'haiku', work: 'sonnet', deep: 'opus', top: 'fable' },
    validation,
    shared_zones: [],
  };

  const questions = [];
  if (autonomy.needs_confirmation) questions.push({ field: 'autonomy', asked: autonomy.source });
  if (validation.needs_confirmation) questions.push({ field: 'validation', asked: validation.source });
  if (manager?.needs_confirmation) questions.push({ field: 'package manager', asked: manager.source });

  return { config, languages, packageManager: manager, questions };
}

/**
 * Render the config to YAML.
 *
 * `stringify` is the repo's own emitter, which the parser round-trips — a
 * hand-rolled writer here would reintroduce the quoting bug that has already
 * cost this project one red CI run (an apostrophe inside an unquoted scalar).
 */
export function renderConfig(config) {
  return (
    '# Tyran configuration for this repository.\n' +
    '#\n' +
    '# Written by /tyran:setup. Inferred values carry provenance so you can\n' +
    '# audit where each one came from. Edit freely — your edits win.\n' +
    '#\n' +
    '# EDITING BY HAND: Tyran parses a small YAML subset. Block scalars (>- and\n' +
    '# |-) are REJECTED, and a file this parser cannot read makes the policy\n' +
    '# gate refuse every write in this repository. Keep each `source:` on ONE\n' +
    '# line, single-quoted, however long it gets.\n' +
    '#\n' +
    '# COMMIT THIS DIRECTORY. `.tyran/` is your repo\'s data, and an untracked\n' +
    '# one does not reach `git worktree add` — agents then run there with no\n' +
    '# autonomy class at all, which is the boundary silently missing exactly\n' +
    '# where the most agents run.\n' +
    '#\n' +
    '# Validate:  node scripts/schema.mjs validate config .tyran/config.yaml\n' +
    '# Resolve a role to a model:  node scripts/tiers.mjs --role reviewer\n' +
    '\n' +
    stringify(config)
  );
}

// ------------------------------------------------------- bootstrapping the policy

/**
 * The directory whose existence ARMS the policy gate, and the file that gate
 * needs in order to answer anything.
 */
export const TYRAN_DIR = '.tyran';
export const POLICY_PATH = '.tyran/policies/autonomy.yaml';

/**
 * Seeding the policy is part of writing the config, and it is not optional.
 *
 * The policy gate is silent in a repository with no `.tyran/` directory — no
 * adoption, nothing to say — and REFUSES every write in a repository that has
 * one but no `.tyran/policies/autonomy.yaml`, because a boundary it cannot
 * read must never read as an open one (ADR-22). Both halves are right. Their
 * seam was not: `--write .tyran/config.yaml` created the directory and nothing
 * created the policy, so setup's own first command moved the repo from
 * "silent" to "refuses everything" — including the write that would have
 * installed the missing file. Measured on a real install: the setup session
 * ended with the operator being handed a `mkdir` and a `cp` to run by hand.
 *
 * Seeding it here is bootstrap, not self-authorization, and the difference is
 * mechanical rather than a matter of intent:
 *
 *  - it only ever CREATES. An existing policy is never read, never merged,
 *    never overwritten — `existsSync` returns first. So this cannot weaken a
 *    boundary that exists, which is the whole content of KERNEL;
 *  - what it writes is the shipped template byte for byte, which is the
 *    strictest default Tyran has (`default: GATED`, `hooks/**` and
 *    `.tyran/policies/**` KERNEL). There is no arrangement of inputs that
 *    makes it write something more permissive;
 *  - it is validated before it lands, so a damaged template becomes a loud
 *    exit 2 rather than a repository nobody can write to.
 *
 * Editing the policy afterwards is still human-only, by hand, and the gate
 * still refuses `Write`, `Edit` and any shell command that names the path.
 */
export class BootstrapError extends Error {
  constructor(message, remedy) {
    super(message);
    this.name = 'BootstrapError';
    this.remedy = remedy;
  }
}

/** The shipped template, from this script's REAL location (see isMainModule). */
export function policyTemplatePath() {
  const self = canonicalPath(fileURLToPath(import.meta.url));
  return join(dirname(self), '..', 'templates', 'policies', 'autonomy.yaml');
}

/** True when writing `path` would create or populate the repo's `.tyran/`. */
export function underTyranDir(path, repoRoot) {
  const rel = relative(resolve(repoRoot), resolve(path)).replace(/\\/g, '/');
  return rel === TYRAN_DIR || rel.startsWith(`${TYRAN_DIR}/`);
}

/** The ancestors of `leaf` up to and including `stopAt` that do not exist yet. */
function absentAncestors(leaf, stopAt) {
  const absent = [];
  let cursor = resolve(leaf);
  const root = resolve(stopAt);
  while (cursor !== root && cursor !== dirname(cursor)) {
    if (!existsSync(cursor)) absent.push(cursor);
    cursor = dirname(cursor);
  }
  return absent;
}

/**
 * Install `.tyran/policies/autonomy.yaml` from the shipped template if it is
 * absent. Returns `{ path, status: 'created' | 'present' }`.
 *
 * On failure it removes the directories it created before throwing. That
 * cleanup is the point rather than tidiness: a half-finished bootstrap leaves
 * `.tyran/` on disk with no policy under it, which is exactly the state that
 * refuses every subsequent write — the bug this function exists to prevent,
 * reintroduced by its own error path.
 */
export function ensureAutonomyPolicy(repoRoot, { templatePath = policyTemplatePath() } = {}) {
  const root = resolve(repoRoot);
  const path = join(root, ...POLICY_PATH.split('/'));
  if (existsSync(path)) return { path, status: 'present' };

  let text;
  try {
    text = readFileSync(templatePath, 'utf8');
  } catch (error) {
    throw new BootstrapError(
      `the shipped policy template is unreadable at ${escapeInvisible(templatePath)}: ${error.message}`,
      'reinstall the plugin — this file ships with it, and without it a repository cannot be set up at all',
    );
  }

  // Validated BEFORE it lands. A template that fails its own schema installs a
  // repository the gate refuses on every write, and the operator then debugs a
  // policy they never wrote.
  let errors;
  try {
    errors = validatePolicy(parse(text));
  } catch (error) {
    errors = [`the template is not parseable YAML (${error.name})`];
  }
  if (errors.length > 0) {
    throw new BootstrapError(
      `the shipped policy template does not validate (${errors.length} finding(s); the first is ` +
        `${escapeInvisible(String(errors[0]))})`,
      'this is a defect in the plugin, not in your repository. Report it rather than hand-editing the template.',
    );
  }

  const created = absentAncestors(dirname(path), root);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  } catch (error) {
    for (const dir of created) {
      // Deepest first, and only while empty — rmdirSync refuses a directory
      // with anything in it, which is the behaviour to want here.
      try {
        rmdirSync(dir);
      } catch {
        break;
      }
    }
    throw new BootstrapError(
      `could not write ${escapeInvisible(path)}: ${error.message}`,
      'check the directory permissions; nothing was left behind, so re-running this command is safe',
    );
  }
  return { path, status: 'created' };
}

export const STATE_GITIGNORE_PATH = '.tyran/.gitignore';
export const STATE_GITIGNORE_LINES = Object.freeze([
  'state/*/locks/',
  'state/paused-until.json',
  'state/resume.json',
  'state/resume.log',
  'state/usage.json',
]);
const STATE_GITIGNORE_BODY =
  '# Runtime files, never history. Leases record who holds a worktree or a\n' +
  '# heavy slot RIGHT NOW; committing one makes every parallel merge conflict\n' +
  '# on state that was stale the moment it was written. The overnight files\n' +
  '# are machine-local by nature: another clone has a different watcher pid,\n' +
  '# a different telemetry stream, and no business inheriting this one\'s pause.\n' +
  `${STATE_GITIGNORE_LINES.join('\n')}\n`;

/**
 * Seed `.tyran/.gitignore` excluding runtime files. A nested gitignore rather
 * than a line in the host's, because `.tyran/` is committed and travels into
 * every worktree — the exclusion has to travel with it. An existing file gains
 * any managed line it lacks, APPENDED at the end (matched by exact trimmed
 * line): create-only seeding left every 0.1.9 install without the overnight
 * exclusions, and the wind-down checklist's `git add .tyran/state` then
 * committed a machine-local pause marker that every clone inherited. Existing
 * content — operator additions included — is never reordered or rewritten,
 * and a `!`-negated managed line is an operator decision this never reverses.
 * Returns `{ path, status: 'created' | 'updated' | 'present' | 'unreadable' }`.
 */
export function ensureStateGitignore(repoRoot) {
  const root = resolve(repoRoot);
  const path = join(root, ...STATE_GITIGNORE_PATH.split('/'));
  if (existsSync(path)) {
    let existing;
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      // A directory or unreadable file at this path is the operator's to
      // resolve; crashing the scan over an ignore nicety helps nobody.
      return { path, status: 'unreadable' };
    }
    const have = new Set(existing.split('\n').map((line) => line.trim()));
    // `!line` is the operator explicitly TRACKING that file; appending the
    // plain line after it would win by last-match and silently reverse them.
    const missing = STATE_GITIGNORE_LINES.filter((line) => !have.has(line) && !have.has(`!${line}`));
    if (missing.length === 0) return { path, status: 'present' };
    try {
      const glue = existing === '' || existing.endsWith('\n') ? '' : '\n';
      writeFileSync(path, `${existing}${glue}${missing.join('\n')}\n`);
    } catch (error) {
      throw new BootstrapError(
        `could not write ${escapeInvisible(path)}: ${error.message}`,
        'check the directory permissions; re-running this command is safe',
      );
    }
    return { path, status: 'updated' };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, STATE_GITIGNORE_BODY);
  } catch (error) {
    throw new BootstrapError(
      `could not write ${escapeInvisible(path)}: ${error.message}`,
      'check the directory permissions; re-running this command is safe',
    );
  }
  return { path, status: 'created' };
}

function main() {
  const args = process.argv.slice(2);
  const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
  };
  const dir = resolve(flag('dir', process.cwd()));
  if (!existsSync(dir)) {
    console.error(`scan-repo: no such directory ${escapeInvisible(dir)}`);
    process.exit(2);
  }

  // Repair mode: seed the policy and do nothing else. This is what `doctor`
  // hands an operator whose `.tyran/` predates this bootstrap, and it names no
  // protected path on its command line, so it is a remedy an agent can run
  // rather than a chore an agent has to delegate back to a human.
  if (args.includes('--ensure-policy')) {
    const seeded = seedPolicy(dir);
    console.error(
      seeded.status === 'created'
        ? `scan-repo: created ${escapeInvisible(seeded.path)} from the shipped template`
        : `scan-repo: ${escapeInvisible(seeded.path)} already exists — left untouched`,
    );
    reportStateGitignore(seedStateGitignore(dir));
    return;
  }

  const result = scanRepo(dir);
  const target = flag('write', null);
  if (target !== null) {
    const path = resolve(target);
    // The boundary goes in FIRST. Between the mkdir that creates `.tyran/` and
    // the write that puts a policy under it, every tool call in the session is
    // refused; ordering it this way makes that window empty instead of
    // permanent.
    if (underTyranDir(path, dir)) {
      const seeded = seedPolicy(dir);
      if (seeded.status === 'created') {
        console.error(`scan-repo: created ${escapeInvisible(seeded.path)} from the shipped template`);
      }
      reportStateGitignore(seedStateGitignore(dir));
    }
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, renderConfig(result.config));
    } catch (error) {
      console.error(`scan-repo: could not write ${escapeInvisible(path)}: ${error.message}`);
      process.exit(2);
    }
    console.error(`scan-repo: wrote ${escapeInvisible(path)}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

/** `ensureAutonomyPolicy`, with a BootstrapError turned into exit 2. */
function seedPolicy(dir) {
  try {
    return ensureAutonomyPolicy(dir);
  } catch (error) {
    if (!(error instanceof BootstrapError)) throw error;
    console.error(`scan-repo: ${error.message}`);
    console.error(`scan-repo: ${error.remedy}`);
    process.exit(2);
  }
}

/** A silent line only when nothing changed — every other shape is reported. */
function reportStateGitignore({ path, status }) {
  if (status === 'created') {
    console.error(`scan-repo: created ${escapeInvisible(path)} (lease files stay out of history)`);
  } else if (status === 'updated') {
    console.error(`scan-repo: updated ${escapeInvisible(path)} (appended missing runtime exclusions)`);
  } else if (status === 'unreadable') {
    console.error(`scan-repo: could not read ${escapeInvisible(path)} — runtime exclusions were NOT updated`);
  }
}

/**
 * `ensureStateGitignore`, with a BootstrapError turned into exit 2. Both call
 * sites run this AFTER `seedPolicy` on purpose: it creates `.tyran/` when
 * absent, and `.tyran/` without a policy under it is the state that refuses
 * every subsequent write.
 */
function seedStateGitignore(dir) {
  try {
    return ensureStateGitignore(dir);
  } catch (error) {
    if (!(error instanceof BootstrapError)) throw error;
    console.error(`scan-repo: ${error.message}`);
    console.error(`scan-repo: ${error.remedy}`);
    process.exit(2);
  }
}

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

if (isMainModule(import.meta.url)) main();
