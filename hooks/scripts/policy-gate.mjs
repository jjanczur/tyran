#!/usr/bin/env node
/**
 * policy-gate — the autonomy classes stop being a description and become a
 * refusal.
 *
 * ADR-06 splits every artefact into AUTO (the loop edits it itself), GATED
 * (a human approves) and KERNEL (humans only, by hand). Until this file
 * existed that split lived in `.tyran/policies/autonomy.yaml` and in prose:
 * a policy nothing enforces is a comment. This gate enforces it on the
 * PreToolUse event, plus the deployment class from `.tyran/config.yaml`
 * (P1/P2/P3), which decides how far a `git push` may reach.
 *
 * ## What it is built out of, and what it deliberately does not re-derive
 *
 * Three answers already exist in this repository and this file asks them
 * rather than re-spelling them. ADR-21 counted three spellings of one rule
 * here once already; there is no fourth.
 *
 *  - **which class a path has** — `scripts/schema.mjs`: `classifyPath`,
 *    `normalizePath`, and the unconditional `MANDATORY_KERNEL_PATHS` check
 *    that runs BEFORE any rule, so no glob spelling can outrank it;
 *  - **what a shell command line does** — `secrets-gate.mjs`'s lexer:
 *    segmentation, transparent prefixes, the `cd`/`pushd`/`popd` working
 *    directory model, and refusal on anything needing expansion. This gate
 *    reads that lexer's OUTPUT and never looks at the command string itself;
 *  - **how a refusal may be worded** — `hook-io.mjs` sanitizes every reason,
 *    and `elideOpaqueRuns`/`safeRuleName` handle the repository-controlled
 *    strings that reach the model's context.
 *
 * ## The two questions this gate had to answer out loud
 *
 * **1. A path no rule matches is a row of the matrix, not a fall-through —
 * and it turned out to be TWO rows.** Inside Tyran's own namespace it takes
 * the policy's `default:` (GATED in the shipped template); outside it the
 * policy has nothing to say and the gate is silent. See `GOVERNED_PREFIXES`
 * for the full argument and the measurement that forced it — the first
 * version of this file applied `default:` everywhere and would have refused
 * an implementer subagent on 65 of the 65 tracked files in this repository.
 * A gate that refuses ordinary work is uninstalled, and then it protects
 * nothing at all; that is the cost side of ADR-19 correction 1, which is
 * otherwise entirely right that "unmatched means allowed" makes a policy
 * protect only what somebody remembered to list.
 *
 * **2. The highest class covers WRITES. Reads are guarded by a separate,
 * narrower rule, and that boundary is stated rather than left to be found.**
 * The trigger was real: a neighbouring project's `.env` was read whole into a
 * conductor session — dozens of live credentials, nobody having asked for the
 * read. The secrets gate defends PUBLICATION and would never have seen it.
 * So a read is refused when the path is secret-SHAPED, for every actor, and
 * AUTO/GATED/KERNEL are not consulted for reads at all. Extending KERNEL to
 * reads instead would have made `hooks/**` unreadable — a gate whose own
 * source cannot be read teaches its user to switch it off. The narrow rule is
 * a denylist and therefore incomplete; `docs/policy-gate.md` says so in those
 * words instead of implying otherwise.
 *
 * ## Failure is refusal
 *
 * Missing policy file, unparseable YAML, a policy the validator rejects, a
 * budget overrun: all deny. A broken policy must never read as "anything
 * goes" (ADR-22). The one exception is deliberate and documented: a repo with
 * no `.tyran/` directory at all has not adopted Tyran, so the path classes
 * have nothing to say there and the gate is silent — except for the secret
 * read rule, which needs no configuration and is what the incident above
 * actually called for.
 */
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PASS, field, main, runGate } from './hook-io.mjs';
import {
  GIT_BUDGET_MS,
  isGitProgram,
  isLiteralPath,
  isLiteralRef,
  makeBudget,
  planCommand,
  runChild,
  shortPath,
  splitSegments,
  tokensOf,
} from './secrets-gate.mjs';
import {
  MANDATORY_KERNEL_PATHS,
  classifyPath,
  globMatches,
  normalizePath,
  validatePolicy,
} from '../../scripts/schema.mjs';
import { parse } from '../../scripts/yaml-lite.mjs';

/** This gate's own budget, half the `timeout` its hooks.json entry declares. */
export const DEADLINE_MS = 4000;

/** Left unspent so a refusal can still be serialized after the last child. */
export const DEADLINE_MARGIN_MS = 800;

/**
 * The most policy this gate will read. A `.tyran/` tree can come from a
 * template someone else wrote, and ADR-22 correction 1 point D is explicit:
 * every file a gate reads is size-checked, because the platform's timeout
 * kills the process and never reads what it wrote.
 */
export const MAX_POLICY_BYTES = 256 * 1024;

/** Where the two files this gate reads live, relative to the repo root. */
export const POLICY_PATH = '.tyran/policies/autonomy.yaml';
export const CONFIG_PATH = '.tyran/config.yaml';
export const TYRAN_DIR = '.tyran';

/** Deployment classes, in increasing order of reach. See ADR-06 / config.yaml. */
export const DEPLOY_CLASSES = Object.freeze(['P1', 'P2', 'P3']);

/**
 * A `default:` that is not an artefact class, used to ask `classifyPath`
 * "did any rule match at all?" without a second glob engine.
 *
 * Plain ASCII on purpose. The first spelling of this constant was a string
 * beginning with a space, and the writing tool put a raw NUL byte there
 * instead — after which `grep` reported ZERO matches in this file, with exit
 * status 1 and no message, and `file` called it binary data. That is failure
 * class 1 and ADR-19's opening example, reproduced inside the gate written to
 * enforce them. A constant whose repertoire is `[A-Za-z_]` cannot do it again.
 */
const UNMATCHED = '__unmatched__';

/**
 * Tools that write a file. A tool named here with no readable path REFUSES:
 * a write whose target the gate could not read is a write it did not classify.
 */
export const WRITE_TOOLS = Object.freeze(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Update']);

/**
 * Tools that put file CONTENT into the model's context. `Grep` is here for a
 * measured reason rather than for symmetry: with `output_mode: "content"` it
 * prints matching lines, so it reads a file just as effectively as `Read`.
 */
export const READ_TOOLS = Object.freeze(['Read', 'NotebookRead', 'Grep']);

/** Input keys that name a file. Read prototype-safely; see `field`. */
export const PATH_FIELDS = Object.freeze(['file_path', 'notebook_path', 'path']);

/**
 * The namespace these path classes govern: Tyran's own artefacts.
 *
 * This is a CORRECTED PREMISE, and it is stated rather than quietly encoded.
 * ADR-06 is titled "the limits of SELF-improvement autonomy", and its table
 * classifies what the retrospective agent may change about **Tyran** —
 * knowledge files, local skills, agent overrides, config, the enforcement
 * hooks. It says nothing about a user's source tree, because a user's source
 * tree is not what the self-improvement loop edits.
 *
 * The first version of this gate applied `default:` to every path, and the
 * cost was measured rather than imagined: in THIS repository 65 of 65 tracked
 * files match no rule in the shipped template, so an implementer subagent
 * would have been refused on every single write it makes. That is not a
 * stricter gate, it is an uninstalled one — and subagents writing code is what
 * Tyran is for.
 *
 * So "no rule matched" is not one row of the matrix but two:
 *
 *  - **inside this namespace** — the policy is meant to enumerate it, so an
 *    unmatched path means somebody added a new kind of Tyran artefact. That
 *    deserves `default:` (GATED in the template): fail-closed, and cheap,
 *    because these trees are small and fully listed;
 *  - **outside it** — the policy has nothing to say and neither does this
 *    gate. Silence, declared in `docs/policy-gate.md` as a boundary rather
 *    than left to be discovered.
 *
 * What this does NOT weaken, and each is pinned by a test: an explicit rule
 * still applies to any path anywhere, so a user who wants `src/**` gated
 * writes that rule and gets it; a path outside the repository is still
 * KERNEL; and `MANDATORY_KERNEL_PATHS` is still checked unconditionally,
 * before any of this.
 */
export const GOVERNED_PREFIXES = Object.freeze(['.tyran/', '.claude/', 'hooks/']);

/** True when the policy's `default:` is the right answer for an unmatched path. */
export function isGoverned(normalized) {
  // Case-insensitive for the same reason `globMatches` is: on a
  // case-insensitive filesystem `.TYRAN/x` and `.tyran/x` are one file, and a
  // classifier must not let casing pick the weaker answer.
  const lower = String(normalized).toLowerCase();
  return GOVERNED_PREFIXES.some((prefix) => lower === prefix.slice(0, -1) || lower.startsWith(prefix));
}

/**
 * Permission modes in which the USER is still asked before a write lands.
 *
 * Measured on the live install (v2.1.116): `permission_mode` is present on
 * every PreToolUse payload — `default` in the main loop, and whatever the
 * session was started with otherwise, inherited by subagents. Anything not
 * listed here (`acceptEdits`, `bypassPermissions`, an unknown future mode, or
 * a missing field) counts as unsupervised, which is the fail-closed direction.
 *
 * `ask` was in this list and is gone: the platform does not emit it, so it was
 * a dead entry in a security list — the shape that reads as coverage and is
 * not. Review probed `dontAsk` and `auto`; both are unknown and therefore
 * unsupervised, which is the behaviour this list is for.
 *
 * KNOWN LIMIT, measured by review and stated because an unstated limit is a
 * false guarantee: `permission_mode` stays `default` when the user has
 * allow-listed a tool in their settings, and the hook cannot read those
 * settings. So `default` means "the platform MAY prompt", never "the user was
 * asked", and no refusal from this gate claims otherwise.
 */
export const SUPERVISED_MODES = Object.freeze(['default', 'plan']);

// ------------------------------------------------------------- the read rule

/**
 * Path shapes that carry credentials.
 *
 * This is a DENYLIST and is structurally incomplete — the same property
 * ADR-19 correction 1 measured on the invisible-codepoint list, where 18
 * added ranges still leaked. It is used anyway, and the reason is the shape
 * of the alternative: the allowlist version of this rule is "refuse every
 * read", which no user keeps installed for an hour. So the incompleteness is
 * declared in `docs/policy-gate.md` rather than papered over.
 *
 * Matched on the BASENAME unless the id says otherwise, and always
 * case-insensitively: on macOS and Windows `.ENV` and `.env` are one file,
 * and a security classifier must not let casing pick the weaker answer (the
 * same reasoning as `globMatches` in schema.mjs).
 */
export const SECRET_READ_RULES = Object.freeze([
  // `.env`, `.env.local`, `.env.prod` — but not the checked-in samples, which
  // are the documented way to tell an agent what the real file must contain.
  {
    id: 'dotenv',
    on: 'basename',
    match: (b) => /^\.env(\.[^/]*)?$/i.test(b) && !/\.(example|sample|template|dist|defaults?|schema)$/i.test(b),
  },
  { id: 'private-key-file', on: 'basename', match: (b) => /\.(pem|key|p12|pfx|jks|keystore|kdbx|asc|ppk)$/i.test(b) },
  { id: 'ssh-private-key', on: 'basename', match: (b) => /^id_[a-z0-9]+$/i.test(b) },
  { id: 'credentials-file', on: 'basename', match: (b) => /^\.?credentials(\.[a-z0-9]+)?$/i.test(b) },
  { id: 'netrc', on: 'basename', match: (b) => /^_?\.?netrc$/i.test(b) },
  { id: 'registry-auth', on: 'basename', match: (b) => /^\.(npmrc|pypirc|pgpass|dockercfg)$/i.test(b) },
  // `.git-credentials` holds `https://user:token@host` in plain text, and the
  // documentation already promised "credentials"; review read it without
  // objection. `.envrc` is direnv's shell file and is where a .env moves to
  // when someone wants it auto-loaded. Both are shapes the prose implied and
  // the code did not have — the gap between a claim and its mechanism.
  { id: 'git-credentials', on: 'basename', match: (b) => /^\.git-credentials$/i.test(b) },
  { id: 'direnv', on: 'basename', match: (b) => /^\.envrc$/i.test(b) },
  { id: 'service-account-key', on: 'basename', match: (b) => /service[-_]?account.*\.json$/i.test(b) },
  // Whole-path shapes: the directory is the secret, whatever the file inside
  // is called. This is the shape the measured incident actually had.
  { id: 'ssh-directory', on: 'path', match: (p) => /(^|\/)\.ssh\//i.test(p) },
  { id: 'aws-credentials', on: 'path', match: (p) => /(^|\/)\.aws\//i.test(p) },
  { id: 'gnupg-directory', on: 'path', match: (p) => /(^|\/)\.gnupg\//i.test(p) },
  { id: 'gcloud-credentials', on: 'path', match: (p) => /(^|\/)\.config\/gcloud\//i.test(p) },
  { id: 'kube-config', on: 'path', match: (p) => /(^|\/)\.kube\/config$/i.test(p) },
]);

/**
 * The ids of every secret rule a path matches. Returns a LIST, not a boolean,
 * so the refusal can name what it recognised without quoting the path's
 * contents back at anyone.
 */
export function secretReadRules(rawPath) {
  const text = String(rawPath).replace(/\\/g, '/');
  const base = basename(text);
  const hits = [];
  for (const rule of SECRET_READ_RULES) {
    const subject = rule.on === 'basename' ? base : text;
    if (rule.match(subject)) hits.push(rule.id);
  }
  return hits;
}

// ---------------------------------------------------------------- the actor

/**
 * Which actor this call belongs to.
 *
 * Measured, and asymmetric — the asymmetry is the whole point. `agent_id`
 * present means we are INSIDE a subagent; its absence does NOT mean the main
 * loop is unattended, because a main thread started with `--agent` carries
 * `agent_type` and still no `agent_id`. So the presence test is used in the
 * direction it is sound in, and nothing is inferred from its absence beyond
 * "not a subagent".
 */
export function actorOf(input) {
  const agentId = field(input, 'agent_id');
  return typeof agentId === 'string' && agentId.trim() !== '' ? 'subagent' : 'main';
}

/**
 * True when nobody will be asked before this call takes effect.
 *
 * A subagent is unsupervised by construction: its tool calls do not surface a
 * permission prompt to the user. The main loop is supervised only while the
 * session's permission mode still prompts. This is what lets GATED mean what
 * ADR-06 says it means — "the operator approves" — without this gate having to
 * invent an approval channel it does not have: on PreToolUse the platform
 * offers `deny` and silence, and no third answer.
 */
export function isUnsupervised(input) {
  if (actorOf(input) === 'subagent') return true;
  const mode = field(input, 'permission_mode');
  return !(typeof mode === 'string' && SUPERVISED_MODES.includes(mode));
}

// --------------------------------------------------------------- the policy

/** Thrown when the gate could not decide. Always becomes a refusal. */
export class PolicyFailure extends Error {
  constructor(what, remedy) {
    super(what);
    this.name = 'PolicyFailure';
    this.remedy = remedy;
  }
}

// ------------------------------------------------------------- git worktrees

/**
 * A linked worktree's main checkout, or null when this IS the main checkout.
 *
 * Two field reports on 0.1.2 described opposite failures with one cause: this
 * gate treated "the repository" as "this directory tree", and a git worktree is
 * neither inside it nor a different repository.
 *
 *  - a session running IN a worktree found no `.tyran/` there — the directory
 *    is committed data, but `git worktree add` gives you a fresh checkout and
 *    the tree only travels if it was committed — so `loadPolicy` returned null
 *    and the gate went SILENT. Measured: four worktrees, four implementers with
 *    no autonomy class and no path classes, and `git push origin main` passing;
 *  - a session running in the main checkout and writing into a sibling worktree
 *    got `normalizePath` -> null -> unconditional KERNEL, so every `Edit` was
 *    refused as "outside this repository". Five agents hit it in one initiative
 *    and all converged on `python3` heredocs through `Bash`, which this gate
 *    does not class at all. A refusal that reroutes work into a less visible
 *    channel is worse than no refusal.
 *
 * Both are fixed by asking the same question — *which repository is this path
 * in* — instead of *is this path under my root*.
 *
 * Detection is pure filesystem, deliberately. `.git` is a DIRECTORY in a main
 * checkout and a FILE in a linked worktree, holding `gitdir: <path>`. Reading
 * it costs a stat and a small read; asking git would cost a subprocess on the
 * write path, which today does none at all and is measured at ~50 ms.
 */
export function mainWorktreeOf(root) {
  const dotGit = join(root, '.git');
  let text;
  try {
    if (statSync(dotGit).isDirectory()) return null;
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return null;
  }
  if (text.length > MAX_GITFILE_BYTES) return null;
  const match = /^gitdir:\s*(.+)$/m.exec(text);
  if (match === null) return null;
  // `<main>/.git/worktrees/<name>` — the main checkout is what precedes it.
  const gitdir = resolvePath(root, match[1].trim()).replace(/\\/g, '/');
  const marker = '/.git/worktrees/';
  const at = gitdir.indexOf(marker);
  return at === -1 ? null : gitdir.slice(0, at);
}

/** A `.git` file is one short line. Anything larger is not one (ADR-22 c1 D). */
export const MAX_GITFILE_BYTES = 4096;

/** How far up from a path to look for the checkout containing it. */
const MAX_WORKTREE_WALK = 64;

/**
 * The checkout root containing `path`, and the repository it belongs to.
 *
 * Returns `{ checkout, repository }` where `repository` is the main worktree —
 * the identity two sibling worktrees share — or null when no checkout is found.
 */
export function checkoutOf(path) {
  let cursor = resolvePath(path);
  for (let i = 0; i < MAX_WORKTREE_WALK; i++) {
    let exists = false;
    try {
      exists = statSync(join(cursor, '.git')) !== null;
    } catch {
      exists = false;
    }
    if (exists) return { checkout: cursor, repository: mainWorktreeOf(cursor) ?? cursor };
    const parent = dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
  return null;
}

/** The repository this call is about. Explicit, never defaulted per call site. */
export function repoRootOf(input, env = process.env) {
  const fromEnv = env.CLAUDE_PROJECT_DIR;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv;
  const cwd = field(input, 'cwd');
  if (typeof cwd === 'string' && cwd.trim() !== '') return cwd;
  return process.cwd();
}

/**
 * Read a small file, or say why not. Size-checked BEFORE it is read, because
 * a gate that blocks the thread on a large read is a gate the platform kills
 * without ever reading its refusal (ADR-22 correction 2).
 */
async function readBounded(path, what) {
  let info;
  try {
    info = await stat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw new PolicyFailure(
      `${what} at ${JSON.stringify(shortPath(path))} could not be read (${err?.code ?? 'unknown error'})`,
      'fix the file permissions, or remove the file if this repository is not meant to use Tyran',
    );
  }
  if (!info.isFile()) {
    throw new PolicyFailure(
      `${what} at ${JSON.stringify(shortPath(path))} is not a regular file`,
      'a directory or a device in the policy path means the gate cannot know what the policy says',
    );
  }
  if (info.size > MAX_POLICY_BYTES) {
    throw new PolicyFailure(
      `${what} is ${info.size} bytes, past the ${MAX_POLICY_BYTES} this gate will read`,
      'a policy file this large is not a policy; split it or shrink it',
    );
  }
  return await readFile(path, 'utf8');
}

/**
 * Load and validate the autonomy policy.
 *
 * Returns `null` — and only then — when the repository has no `.tyran/`
 * directory at all. Every other outcome is either a valid policy or a
 * refusal: absent while `.tyran/` exists, unparseable, or rejected by
 * `validatePolicy` all mean the boundary is unknown, and an unknown boundary
 * that lets writes through is the defect this whole epic is about.
 */
export async function loadPolicy(root) {
  // A linked worktree inherits its repository's policy. Without this a
  // worktree with no `.tyran/` of its own reads as "this repo never adopted
  // Tyran" and the gate goes silent — measured in the field as four worktrees
  // running four implementers with no autonomy class at all. Tried in order,
  // so a `.tyran/` that DID travel with the worktree still wins.
  const roots = [root, mainWorktreeOf(root)].filter((r) => r !== null);
  let text = null;
  let from = root;
  for (const candidate of roots) {
    text = await readBounded(join(candidate, POLICY_PATH), 'the autonomy policy');
    if (text !== null) {
      from = candidate;
      break;
    }
  }
  if (text === null) {
    let adopted = false;
    for (const candidate of roots) {
      try {
        if ((await stat(join(candidate, TYRAN_DIR))).isDirectory()) {
          adopted = true;
          break;
        }
      } catch {
        /* keep looking */
      }
    }
    if (!adopted) return null;
    throw new PolicyFailure(
      `this repository has a ${TYRAN_DIR}/ directory but no ${POLICY_PATH}`,
      `restore it from the shipped template (templates/policies/autonomy.yaml) and validate it with ` +
        `\`node scripts/schema.mjs validate policy ${POLICY_PATH}\`. A missing boundary is not an open one.`,
    );
  }
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    throw new PolicyFailure(
      `${POLICY_PATH} is not parseable YAML (${err?.name ?? 'error'})`,
      `fix the file and check it with \`node scripts/schema.mjs validate policy ${POLICY_PATH}\`. ` +
        'A policy the gate cannot read cannot mean "everything is allowed".',
    );
  }
  const errors = validatePolicy(doc);
  if (errors.length > 0) {
    throw new PolicyFailure(
      `${POLICY_PATH} is not a valid policy (${errors.length} finding(s); the first is ` +
        `${JSON.stringify(safePolicyText(errors[0]))})`,
      `run \`node scripts/schema.mjs validate policy ${POLICY_PATH}\` for the full list. ` +
        'The validator is what stops a policy from downgrading its own enforcement paths.',
    );
  }
  return doc;
}

/** Load the deployment class from config.yaml, or refuse. `null` = no config. */
export async function loadDeployClass(root) {
  // Same inheritance as the policy, and for the sharper reason: without it a
  // `git push origin main` from inside a worktree found no config, concluded
  // the repo had not adopted Tyran, and PASSED at every deployment class.
  let text = null;
  for (const candidate of [root, mainWorktreeOf(root)].filter((r) => r !== null)) {
    text = await readBounded(join(candidate, CONFIG_PATH), 'the Tyran config');
    if (text !== null) break;
  }
  if (text === null) return null;
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    throw new PolicyFailure(
      `${CONFIG_PATH} is not parseable YAML (${err?.name ?? 'error'})`,
      `fix the file and check it with \`node scripts/schema.mjs validate config ${CONFIG_PATH}\`.`,
    );
  }
  const node = doc === null || typeof doc !== 'object' ? undefined : doc.autonomy;
  // The field carries provenance when a scanner inferred it: `{value, source,
  // confidence}`. Reading `.autonomy` raw would then compare an object against
  // 'P1' and silently fall through to the widest class.
  const value = node !== null && typeof node === 'object' && 'value' in node ? node.value : node;
  if (!DEPLOY_CLASSES.includes(value)) {
    throw new PolicyFailure(
      `${CONFIG_PATH} does not declare a deployment class (autonomy: ${DEPLOY_CLASSES.join(' | ')})`,
      `set \`autonomy: P1\` if you are unsure — it is the narrowest class, and setup picks it by ` +
        'default. The gate refuses rather than assuming the widest one.',
    );
  }
  return value;
}

/**
 * A leading `~` expanded to the home directory; everything else untouched so
 * the `*`/`**` in a glob survive (`resolve` would collapse a trailing `**`).
 */
function expandHome(p) {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * The out-of-repo paths config.yaml lets the MAIN thread write, home-expanded.
 * Optional: absence is [], never a refusal. A config too broken to parse yields
 * [] rather than throwing, so the write stays refused — fail closed. This only
 * lists paths; the actor split (main-thread only) is enforced at the call site,
 * so it can never widen what a subagent may do.
 */
export async function loadMainWritablePaths(root) {
  let text = null;
  for (const candidate of [root, mainWorktreeOf(root)].filter((r) => r !== null)) {
    text = await readBounded(join(candidate, CONFIG_PATH), 'the Tyran config');
    if (text !== null) break;
  }
  if (text === null) return [];
  let doc;
  try {
    doc = parse(text);
  } catch {
    return [];
  }
  const raw = doc !== null && typeof doc === 'object' ? doc.main_writable_paths : undefined;
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim() !== '') out.push(expandHome(entry.trim()));
  }
  return out;
}

// ------------------------------------------------------ quoting the decision

/**
 * The repertoire a policy string is allowed to contribute to a refusal.
 *
 * A refusal is republished into the model's context, so every string in it
 * that came out of a file is attacker-controlled text (failure class 6, which
 * happened four times in this initiative). Review of the secrets gate put an
 * imperative sentence in a rule id and had it printed back verbatim.
 *
 * The mechanical answer used there was an allowlist that drops spaces, so a
 * sentence stops being a sentence. That works for an identifier and destroys
 * a prose `reason:` field. So this gate does not reproduce `reason:` AT ALL —
 * the refusal quotes the rule's `path` glob and its `class`, and points the
 * reader at the file. The guarantee is then exact and testable: the only
 * bytes that travel from the policy file into the model's context are a glob
 * in this repertoire and one of three enum members.
 *
 * The narrower claim, because review measured the wider one false: dropping
 * spaces is NOT the same as "it stops reading as an instruction". A glob may
 * contain `-`, `!` and `?`, so `ignore-previous-instructions-and-approve!`
 * survives this filter intact. What is guaranteed is the REPERTOIRE and the
 * LENGTH, and that a rule path is the only prose-shaped field reproduced at
 * all; the reader of a refusal still has to treat a quoted glob as data.
 */
export function safePolicyText(value, limit = 120) {
  const kept = String(value).replace(/[^A-Za-z0-9._/*[\]{}?!-]/g, '');
  return (kept === '' ? '(empty)' : kept).slice(0, limit);
}

/**
 * The rule that decided, and a proof that it is the same rule the resolver
 * used.
 *
 * `classifyPath` returns a class, not a rule, so a refusal that names the
 * deciding rule has to select one — and selecting one means restating the
 * precedence, which is exactly how a repository ends up with two spellings of
 * one rule (ADR-21). It is restated here and then CHECKED: the caller
 * compares this rule's class against `classifyPath`'s answer and refuses on
 * disagreement rather than reporting the wrong reason. The check, not the
 * code, is what keeps the two honest, and a test pins it over a corpus.
 *
 * Matching itself is delegated: a single-rule probe policy is handed to
 * `classifyPath`, so the glob semantics are never re-implemented.
 */
export function decidingRule(policy, normalized) {
  const strictness = { AUTO: 0, GATED: 1, KERNEL: 2 };
  let best = null;
  for (const rule of policy?.rules ?? []) {
    if (rule === null || typeof rule !== 'object') continue;
    if (typeof rule.path !== 'string' || rule.path.trim() === '') continue;
    // A one-rule policy answers "does this rule match?" without a second glob
    // engine. The unconditional kernel check inside classifyPath cannot make
    // this a false positive: it returns KERNEL for kernel paths whatever the
    // rule says, and a kernel path is refused by the caller regardless.
    if (classifyPath({ rules: [rule], default: UNMATCHED }, normalized) === UNMATCHED) continue;
    if (
      best === null ||
      rule.path.length > best.path.length ||
      (rule.path.length === best.path.length && strictness[rule.class] > strictness[best.class])
    ) {
      best = rule;
    }
  }
  return best;
}

/**
 * The built-in protected glob covering this path, or null.
 *
 * `classifyPath` applies `MANDATORY_KERNEL_PATHS` unconditionally, before any
 * rule is consulted, so a refusal that could only ever quote the policy file
 * would name the wrong authority for exactly the paths that matter most. An
 * EMPTY policy isolates that unconditional branch: whatever it still calls
 * KERNEL, it calls KERNEL for a reason no policy can edit.
 */
export function protectedGlobFor(normalized) {
  // Asked of the MATCHER, never of the resolver.
  //
  // The first version probed `classifyPath` with a one-rule policy, and it was
  // wrong for every path except the ones covered by the first glob in the list:
  // `classifyPath` applies EVERY protected glob unconditionally, before it
  // looks at any rule, so a one-rule probe answers KERNEL whichever glob it was
  // handed. `.tyran/policies/autonomy.yaml` was therefore refused while being
  // told it was `hooks/**` — the strictest refusal this gate gives, naming the
  // wrong authority, with the `.tyran/policies/**` branch unreachable.
  //
  // Worse than the bug: the whole suite was green with it AND green with the
  // fix, because nothing asserted WHICH glob was quoted. That is the fifth
  // "the test aims beside the sink" in this initiative, so the test added
  // alongside this uses a REPAIRING mutant — it must go red when this function
  // is put back the way it was.
  if (normalized === null || normalized === undefined) return null;
  for (const glob of MANDATORY_KERNEL_PATHS) {
    if (globMatches(glob, normalized)) return glob;
  }
  return null;
}

/** How the refusal names the rule that decided. Never the `reason:` prose. */
export function quoteRule(policy, normalized, cls) {
  if (normalized === null) {
    return 'no rule applies: the path is outside this repository, which is never autonomous';
  }
  const glob = protectedGlobFor(normalized);
  if (glob !== null) {
    return (
      `the built-in protected path \`${safePolicyText(glob)}\` (class KERNEL). No policy can ` +
      'downgrade it: the validator rejects the file whatever glob spelling is used.'
    );
  }
  const rule = decidingRule(policy, normalized);
  if (rule === null) {
    return `no rule in \`${POLICY_PATH}\` matched, so its \`default:\` applies (class ${safePolicyText(cls)})`;
  }
  return (
    `\`${POLICY_PATH}\`, rule \`path: ${safePolicyText(rule.path)}\` (class ${safePolicyText(rule.class)}). ` +
    "The rule's `reason:` is deliberately not reproduced here — read it in the file"
  );
}

// ----------------------------------------------------------- the path matrix

/** How many ancestors `canonicalDeepest` will walk. A path is not a tree. */
const MAX_PATH_DEPTH = 64;

/**
 * The realpath of the deepest ANCESTOR that exists, with the rest re-appended.
 *
 * A write usually names a file that does not exist yet, so `realpath` on the
 * target itself fails. The directory above it almost always does.
 */
function canonicalDeepest(raw) {
  let head = resolvePath(raw);
  const tail = [];
  for (let i = 0; i < MAX_PATH_DEPTH; i++) {
    try {
      return tail.length === 0 ? realpathSync(head) : join(realpathSync(head), ...tail);
    } catch {
      const parent = dirname(head);
      if (parent === head) return resolvePath(raw);
      tail.unshift(basename(head));
      head = parent;
    }
  }
  return resolvePath(raw);
}

/**
 * The path segments below `base`, canonicalized on BOTH sides, or null when
 * `target` is not under `base`. `canonicalDeepest` on the base too, so `/tmp`
 * and `/private/tmp` — one directory in two spellings on macOS — do not read as
 * two, the same symlink hazard `repoRelative` documents.
 */
function segmentsUnder(canonTarget, base) {
  let root;
  try {
    root = canonicalDeepest(base);
  } catch {
    return null;
  }
  if (canonTarget === root) return [];
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (!canonTarget.startsWith(prefix)) return null;
  return canonTarget.slice(prefix.length).split(sep).filter(Boolean);
}

/**
 * Claude Code's own two working directories, which belong to no repository:
 * the persistent memory store under the config dir, and the per-session
 * scratchpad under the system temp dir. `repoRelative` returns null for both —
 * they are genuinely outside every repo — so the write matrix answered them
 * with KERNEL, and adopting Tyran in a repo then refused the harness's OWN
 * memory writes: `Write` to `~/.claude/projects/<slug>/memory/*.md` failed with
 * "outside this repository", so the assistant could no longer persist what it
 * learned while working in a Tyran repo. A boundary that blocks the tool's own
 * bookkeeping is one its user turns off.
 *
 * The exemption is narrow on two axes, and both carry weight:
 *   - PATH — only the memory store <config>/projects/<slug>/memory and the
 *     scratchpad <tmp>/claude-<id>. The rest of the config dir is untouched,
 *     so `.claude/settings.json`, which registers these very hooks, stays
 *     KERNEL and out of reach. An allowlist of two shapes, never "anything
 *     under home".
 *   - ACTOR — `main` only, enforced at the call site. A subagent has no
 *     business writing outside its worktree; `actorOf` returns `subagent` for
 *     it and it still falls through to KERNEL. So the blast radius is an
 *     interactive thread writing advisory notes and temp files, not a
 *     fanned-out loop reaching across the filesystem.
 *
 * Bash never needed this: an out-of-repo token yields no finding in
 * `shellPathFindings`, so `echo > scratch` was already allowed. The refusal
 * lived only on the file-writing tools, which is the asymmetry a user meets.
 */
export function harnessWritable(rawPath, env = process.env) {
  let canon;
  try {
    canon = canonicalDeepest(rawPath);
  } catch {
    return false;
  }
  const configDir =
    typeof env.CLAUDE_CONFIG_DIR === 'string' && env.CLAUDE_CONFIG_DIR.trim() !== ''
      ? env.CLAUDE_CONFIG_DIR
      : join(homedir(), '.claude');
  const underConfig = segmentsUnder(canon, configDir);
  if (underConfig !== null) {
    // The memory store's exact shape: <config>/projects/<slug>/memory/**.
    if (underConfig[0] === 'projects' && underConfig[2] === 'memory') return true;
    // The plans directory: <config>/plans/** — where the main thread writes the
    // plan files a user reads between sessions. A popular out-of-repo path, so
    // it is exempt by default rather than requiring per-repo config.
    if (underConfig[0] === 'plans') return true;
  }
  // The scratchpad: <tmp>/claude-*/**, under whichever temp root the platform
  // used. `/tmp` is included explicitly because `os.tmpdir()` is `/var/...` on
  // macOS while the scratchpad lives under `/private/tmp`.
  for (const tempRoot of new Set([tmpdir(), '/tmp'])) {
    const underTemp = segmentsUnder(canon, tempRoot);
    if (underTemp !== null && underTemp.length >= 1 && /^claude-/.test(underTemp[0])) {
      return true;
    }
  }
  return false;
}

/**
 * The repo-relative path, resolved through symlinks on BOTH sides.
 *
 * Measured on the live install: `file_path` is always ABSOLUTE — the matrix
 * for this gate was first written against relative paths, which is a shape the
 * platform never sends, and mutant M17 is what exposed it. Absolute paths make
 * symlinks load-bearing, and on macOS `/tmp` and `/var` ARE symlinks, so a
 * root and a `file_path` routinely name one directory in two spellings. Left
 * alone that produces "outside the repository, class KERNEL" for an ordinary
 * source file: a refusal on the commonest write there is, which is how a gate
 * gets switched off in its first hour.
 *
 * Canonicalizing unconditionally (rather than only as a retry) also closes the
 * other direction: `repo/link/x` where `link` points at `/etc` reads as
 * repo-relative until the symlink is followed, and then correctly reads as
 * outside. Two spellings of one location must not resolve to two classes.
 */
export function repoRelative(raw, root) {
  const direct = normalizePath(canonicalDeepest(raw), canonicalDeepest(root));
  if (direct !== null) return direct;
  // Not under this root — but a git worktree of the SAME repository is not
  // "outside the repository", and calling it that refused every Edit an
  // implementer made in the worktree rule 7 tells the conductor to give it.
  // Five agents hit this in one initiative and all rerouted their writes
  // through `Bash` heredocs, which this gate does not class at all.
  //
  // The test is repository IDENTITY, never proximity: both sides resolve to a
  // main checkout and those must be the same path. A path in a DIFFERENT
  // repository still normalizes to null and is still KERNEL, which is the
  // property that keeps this from being a hole.
  const target = checkoutOf(canonicalDeepest(raw));
  if (target === null) return null;
  const session = checkoutOf(canonicalDeepest(root));
  if (session === null || target.repository !== session.repository) return null;
  // Classified against the worktree it lives in, so `.tyran/knowledge/x.yaml`
  // in a worktree is the same class as in the main checkout.
  return normalizePath(canonicalDeepest(raw), target.checkout);
}

/** Every path this tool call names. Prototype-safe, deduplicated, order-stable. */
export function pathTargets(toolInput) {
  if (toolInput === null || typeof toolInput !== 'object') return [];
  const out = [];
  for (const key of PATH_FIELDS) {
    const value = field(toolInput, key);
    if (typeof value === 'string' && value.trim() !== '') out.push(value);
  }
  return [...new Set(out)];
}

/**
 * The decision for one classified path, given the class and the supervision.
 *
 * The full matrix, and every cell is a decision rather than a fall-through:
 *
 * | class    | supervised main loop | main, prompts off (askable) | subagent / other |
 * |----------|----------------------|-----------------------------|------------------|
 * | AUTO     | pass                 | pass                        | pass             |
 * | GATED    | pass — the platform's own prompt IS the approval | **ask** — the gate summons the prompt itself | **deny** |
 * | KERNEL   | **deny**             | **deny**                    | **deny**         |
 * | unmatched| = the policy's `default:` (GATED in the shipped template) |  |  |
 *
 * The GATED row is the one worth arguing. hook-io can emit a third answer —
 * an "ask" — which renders the user's own prompt even in a mode that
 * auto-accepts edits, so GATED can mean what ADR-06 says it means wherever a
 * prompt can render. `askable` is that fact as an argument: the caller sets
 * it only for the MAIN loop under `acceptEdits`, the mode agents actually
 * run in. It stays false under `bypassPermissions` and unknown modes — an
 * ask a mode might not render must fail toward deny, never toward approval —
 * and false for every subagent, whose calls have no prompt surface at all.
 * Measured before this cell existed: under `acceptEdits` the operator's own
 * conductor could not perform a GATED write anywhere, while the refusal text
 * pointed at a main session that refused exactly the same way.
 */
export function verdictForClass(cls, unsupervised, askable = false) {
  if (cls === 'KERNEL') return 'deny';
  if (cls === 'GATED') {
    if (!unsupervised) return 'pass';
    return askable ? 'ask' : 'deny';
  }
  if (cls === 'AUTO') return 'pass';
  // An unrecognised class cannot be resolved to a permission. validatePolicy
  // rejects one, so reaching here means the resolver and the validator
  // disagree — refuse rather than guess which of them is right.
  return 'deny';
}

// ------------------------------------------------------- the deployment class

/**
 * Branch names that are production wherever they appear.
 *
 * An enumeration, and therefore incomplete — a repository whose production
 * branch is called `ship` is not in it. It is the FLOOR, not the rule: the
 * gate also resolves the remote's own default branch, and refuses under P1/P2
 * when it cannot. Two criteria pointing the same way, so a miss in the list
 * does not become a silent pass (ADR-19: an exclusion may never be quiet).
 */
export const PRODUCTION_BRANCHES = Object.freeze([
  'main', 'master', 'production', 'prod', 'release', 'live', 'trunk', 'stable',
]);

/** Long-lived shared branches. P1 keeps an agent off these too; P2 allows them. */
export const SHARED_BRANCHES = Object.freeze([
  'testing', 'staging', 'stage', 'test', 'dev', 'develop', 'development',
  'preview', 'next', 'qa', 'uat', 'integration', 'beta', 'canary',
]);

/** `refs/heads/main` -> `main`; `+main` -> `main`. Never a shell expansion. */
export function refName(spec) {
  const text = String(spec).replace(/^\+/, '');
  return text.replace(/^refs\/(heads|remotes)\//, '');
}

/**
 * What a `git push` in this segment would publish, from the LEXER's tokens.
 *
 * The command string is never re-read here. `planCommand` already segments the
 * line, walks `cd`/`pushd`/`popd`, recognises the program through quoting
 * tricks, and refuses anything needing expansion; this only interprets the
 * argv it produced. Writing a second decomposition would have been the third
 * spelling of one rule in this repository.
 */
export function readPush(argv) {
  const flags = argv.filter((t) => t.startsWith('-'));
  const words = argv.filter((t) => !t.startsWith('-'));
  const has = (...names) => flags.some((f) => names.includes(f));
  const deleteFlag = has('--delete', '-d');
  const specs = words.slice(1); // words[0] is the remote, when present
  const destinations = [];
  let deletes = deleteFlag && specs.length > 0;
  let forced = flags.some((f) => f.startsWith('--force') || (f.length >= 2 && f[1] !== '-' && f.includes('f')));
  let tags = has('--tags', '--follow-tags') || specs.some((s) => s.includes('refs/tags/'));
  // A refspec the shell would rewrite is a destination this gate cannot read.
  //
  // Round two checked `isLiteralPath` for the REMOTE and nothing at all for the
  // refspec, so `B=main; git push origin "$B"` produced the destination `$B`,
  // which matched no production name and sailed through as a feature branch.
  // It landed a commit on `main` for real. The gate never expands anything —
  // that is what keeps a model-written command line out of a shell — so the
  // only honest answer here is a refusal.
  const unreadable = specs.filter((s) => !isLiteralRef(s.replace(/^\+/, '')));
  const symbolic = [];
  for (const spec of specs) {
    if (spec.startsWith('+')) forced = true;
    const parts = spec.split(':');
    if (parts.length > 1 && parts[0].replace(/^\+/, '') === '') deletes = true;
    const dst = parts.length > 1 ? parts[parts.length - 1] : parts[0];
    if (dst === '') continue;
    const name = refName(dst);
    // `HEAD` and `@` are the same thing and both name whatever is checked out.
    // `git push origin HEAD` is the COMMONEST spelling there is and round two
    // did not have it in the table at all: only a bare `git push` reached for
    // `symbolic-ref`, so `HEAD` was compared against the production names as
    // if it were a branch called "HEAD", matched nothing, and published.
    if (name === 'HEAD' || name === '@') symbolic.push(name);
    else destinations.push(name);
  }
  return {
    remote: words[0] ?? null,
    destinations,
    unreadable,
    // Destinations that only git can name. Resolved by the caller, exactly
    // like the no-refspec case, so there is one answer for "which branch is
    // this" instead of two.
    symbolic,
    deletes,
    forced,
    tags,
    // `--all` and `--mirror` publish every local branch, which includes the
    // default one whatever it is called, and `--mirror` also DELETES remote
    // refs that are absent locally.
    everything: has('--all', '--mirror'),
    mirrors: has('--mirror'),
    // No refspec and no wildcard flag: the destination is whatever branch is
    // checked out, and only git can say which. Resolved by the caller.
    impliesCurrentBranch: specs.length === 0 && !has('--all', '--mirror', '--tags'),
  };
}

/**
 * `git symbolic-ref --short`, or null.
 *
 * Every way of not getting an answer collapses to null — git absent, killed,
 * non-zero, empty — because the CALLER turns null into a refusal with a
 * one-command remedy. Distinguishing them here would only produce refusals
 * that differ in wording and not in what the reader has to do.
 */
export async function symbolicRef(dir, ref, { runner, timeoutMs }) {
  if (!(timeoutMs > 0)) return null;
  const result = await runner('git', ['-C', dir, 'symbolic-ref', '--quiet', '--short', ref], {
    cwd: dir,
    timeoutMs,
  });
  if (result?.spawned !== true || result.timedOut === true || result.code !== 0) return null;
  const line = String(result.stdout ?? '').trim().split('\n')[0] ?? '';
  return line === '' ? null : line;
}

/**
 * The decision for one `git push`, under the repo's deployment class.
 *
 * P1 keeps an agent on its own branch · P2 adds the shared/testing branches ·
 * P3 adds production but still refuses the irreversible, user-visible
 * operations, which is what "P3 passes" was always supposed to mean and never
 * mechanically did.
 */
export function deployVerdict(deployClass, scope, irreversible) {
  if (irreversible.length > 0) return { verdict: 'deny', because: 'irreversible' };
  if (deployClass === 'P3') return { verdict: 'pass', because: 'P3' };
  if (deployClass === 'P2') {
    return scope === 'production' ? { verdict: 'deny', because: 'production' } : { verdict: 'pass', because: 'P2' };
  }
  return scope === 'feature' ? { verdict: 'pass', because: 'P1' } : { verdict: 'deny', because: scope };
}

// -------------------------------------------------------------- the decision

const READ_REMEDY =
  'If you need a value from this file, ask the operator for the single value rather than the file. ' +
  'If this path is genuinely not a secret in this repository, the operator can add an explicit ' +
  `\`class: AUTO\` rule for it in \`${POLICY_PATH}\`.\n` +
  // The round-two version of this sentence ended "this gate cannot be talked
  // out of it from inside a session", and review took it apart in three tool
  // calls: `cat >> .tyran/policies/autonomy.yaml`, then the same read, allowed.
  // The shell route is closed now, so the claim is nearly true — and "nearly"
  // is exactly the word a guarantee may not leave out.
  'That file is class KERNEL, and a shell command that NAMES it is refused too, so the exemption ' +
  'is not one an agent can write for itself in the ordinary way. It is not a proof: a path this ' +
  'gate never sees as a word — assembled from a variable, or from a program it launches — is in ' +
  'the declared floor in docs/policy-gate.md. Writing that exemption yourself is working around ' +
  'the gate, which is the one move that makes a boundary worse than no boundary.';

export async function decide({ input, runner = runChild, startedAt = Date.now(), env = process.env } = {}) {
  const budget = makeBudget(startedAt, DEADLINE_MS, DEADLINE_MARGIN_MS);
  const toolName = field(input, 'tool_name');
  const toolInput = field(input, 'tool_input');
  const root = repoRootOf(input, env);
  const unsupervised = isUnsupervised(input);
  const actor = actorOf(input);
  // The one mode where an unsupervised main loop still renders an ask.
  // Deliberately not "any unsupervised main": bypassPermissions and unknown
  // modes must keep the hard deny — see verdictForClass's matrix.
  const askable = actor === 'main' && field(input, 'permission_mode') === 'acceptEdits';

  if (toolName === 'Bash') return await decideBash({ input, toolInput, root, runner, budget });

  const targets = pathTargets(toolInput);
  const isWriteTool = typeof toolName === 'string' && WRITE_TOOLS.includes(toolName);
  const isReadTool = typeof toolName === 'string' && READ_TOOLS.includes(toolName);

  if (targets.length === 0) {
    if (!isWriteTool) return PASS;
    return {
      decision: 'deny',
      reason:
        `tyran policy-gate: refused. \`${safePolicyText(String(toolName))}\` writes a file, but this ` +
        'call carries no readable path, so the gate could not tell which autonomy class applies.\n' +
        'A write the gate did not classify is a write it did not check (ADR-22).\n' +
        'Reissue the call with an explicit file path.',
    };
  }

  // --- reads: one narrow rule, and the write classes are NOT consulted -------
  if (isReadTool) {
    const policy = await loadPolicy(root).catch((err) => {
      // A broken policy must not make reads MORE permissive, but it also must
      // not make the secret rule unavailable: the rule needs no policy, only
      // the exemption does. Rethrow for writes, degrade to "no exemptions" here.
      if (err instanceof PolicyFailure) return { rules: [], default: 'GATED', degraded: err };
      throw err;
    });
    for (const target of targets) {
      // Tested on the RAW spelling and on the resolved one. Round two checked
      // only the raw string while the write path canonicalized, so
      // `notes-symlink-to-env.txt -> .env` was read without objection — the
      // exact inversion of this file's own argument that two spellings of one
      // location must not resolve to two classes. The cost of skipping it is
      // higher here than on the write path, not lower.
      const resolved = canonicalDeepest(target);
      const hits = [...new Set([...secretReadRules(target), ...secretReadRules(resolved)])];
      if (hits.length === 0) continue;
      const normalized = repoRelative(target, root);
      const exempt =
        normalized !== null &&
        policy !== null &&
        decidingRule(policy, normalized)?.class === 'AUTO';
      if (exempt) continue;
      return {
        decision: 'deny',
        reason:
          `tyran policy-gate: refused. This read would put a credential-shaped file into the ` +
          `model's context.\n` +
          `path: ${JSON.stringify(shortPath(target))}\n` +
          `matched: ${hits.map((h) => `\`${h}\``).join(', ')}\n` +
          `actor: ${actor}${normalized === null ? ' · this path is OUTSIDE the repository' : ''}\n` +
          'Why a read and not just a commit: the secrets gate defends PUBLICATION. A neighbouring ' +
          "project's .env was read whole into a conductor session in this project's own history — " +
          'dozens of live credentials, nobody having asked for the read, and no commit involved. ' +
          'A transcript is storage.\n' +
          `${READ_REMEDY}\n` +
          'Declared limit: this rule is a denylist of path shapes and is therefore incomplete. ' +
          'It is not a claim that no secret can reach the context by another name.',
      };
    }
    return PASS;
  }

  // --- writes: the AUTO / GATED / KERNEL matrix ------------------------------
  const policy = await loadPolicy(root);
  if (policy === null) {
    // No `.tyran/` at all: Tyran does not orchestrate this repository, so the
    // path classes have nothing to say. Stated in docs/policy-gate.md as a
    // boundary rather than left to be discovered.
    return PASS;
  }

  // Config-declared out-of-repo allowances for the main thread
  // (`.tyran/config.yaml` `main_writable_paths`), loaded lazily and once: only
  // an out-of-repo main-thread write ever consults them.
  let mainWritable;

  for (const target of targets) {
    // Normalized HERE, with the root this call is about, and only then handed
    // to the resolver. `classifyPath` normalizes internally too, but against
    // `CLAUDE_PROJECT_DIR ?? process.cwd()` — and a hook process's cwd is not
    // reliably the session's repository. Feeding it the raw path would
    // classify against one directory while the refusal talked about another,
    // and the two would agree in every test that happened to run in the repo
    // root. Normalization is idempotent, so the resolver's own call is a no-op.
    const normalized = repoRelative(target, root);
    // Claude Code's own memory store, plans dir and scratchpad are outside every
    // repository, so `normalized` is null and the matrix below answers KERNEL —
    // which made adopting Tyran refuse the harness's own writes. `harnessWritable`
    // exempts those built-in locations; `main_writable_paths` in config.yaml adds
    // operator-chosen ones. Both are MAIN-thread only: a subagent still falls
    // through to KERNEL.
    if (normalized === null && actor === 'main') {
      if (harnessWritable(target, env)) continue;
      if (mainWritable === undefined) mainWritable = await loadMainWritablePaths(root);
      if (mainWritable.length > 0) {
        const canon = canonicalDeepest(target);
        if (mainWritable.some((glob) => globMatches(glob, canon) || globMatches(glob, target))) continue;
      }
    }
    // The one branch this cannot delegate: a path outside the repository makes
    // `normalizePath` return null, which `classifyPath` answers with KERNEL.
    // Restated in one line rather than reached by passing a null through, and
    // pinned by a test that asserts both spellings still agree.
    const cls = normalized === null ? 'KERNEL' : classifyPath(policy, normalized);
    // The unmatched row, split in two. `decidingRule` returning null is
    // exactly "the policy said nothing about this path"; outside the governed
    // namespace that is not a decision the policy is entitled to make, so the
    // gate is silent. Inside it, `default:` applies and the class above is
    // already it.
    if (normalized !== null && decidingRule(policy, normalized) === null && !isGoverned(normalized)) {
      continue;
    }
    const verdict = verdictForClass(cls, unsupervised, askable);

    // ADR-21, applied as a check rather than as a refactor: the rule this
    // refusal names and the class the resolver returned must agree. They are
    // selected by two pieces of code, so the agreement is asserted at runtime
    // and pinned by a test instead of being assumed.
    const named = normalized === null ? null : decidingRule(policy, normalized);
    if (named !== null && normalized !== null && classifyPath(policy, normalized) !== 'KERNEL' && named.class !== cls) {
      throw new PolicyFailure(
        'the rule this gate would quote and the class the resolver returned disagree',
        'this is a bug in the gate, not in the policy. The gate refuses rather than reporting a ' +
          'reason that is not the reason.',
      );
    }

    if (verdict === 'pass') continue;
    if (verdict === 'ask') {
      return {
        decision: 'ask',
        reason:
          `tyran policy-gate: this write is GATED — your approval IS the gate. ` +
          `${describeTarget(target, normalized)}\n` +
          `class: ${safePolicyText(cls)} · actor: ${actor} · permission_mode: ` +
          `${safePolicyText(String(field(input, 'permission_mode') ?? '(absent)'))}\n` +
          `rule: ${quoteRule(policy, normalized, cls)}\n` +
          'Approve to perform exactly this write, once. Decline and the agent is told to put ' +
          'the change in its report instead.',
      };
    }
    return {
      decision: 'deny',
      reason:
        `tyran policy-gate: refused. ${describeTarget(target, normalized)}\n` +
        `class: ${safePolicyText(cls)} · actor: ${actor} · permission_mode: ` +
        `${safePolicyText(String(field(input, 'permission_mode') ?? '(absent)'))}\n` +
        `rule: ${quoteRule(policy, normalized, cls)}\n` +
        `${escapeRoute(cls, unsupervised)}`,
    };
  }
  return PASS;
}

function describeTarget(raw, normalized) {
  if (normalized === null) {
    return (
      `${JSON.stringify(shortPath(raw))} is outside this repository, and a path outside the repo ` +
      'is never autonomous.'
    );
  }
  return `${JSON.stringify(shortPath(raw))} is not writable at this autonomy level.`;
}

function escapeRoute(cls, unsupervised) {
  if (cls === 'KERNEL') {
    return (
      'What to do instead: KERNEL means a human edits this by hand, outside an agent session — ' +
      'these are the files that enforce every other boundary, so a loop able to edit them has no ' +
      'boundaries at all. Put the change in your report as a diff for the operator to apply. ' +
      'Reclassifying it is not available: the validator rejects a policy that downgrades a ' +
      'protected path, whatever glob spelling it uses.'
    );
  }
  if (unsupervised) {
    return (
      'What to do instead: GATED means the operator approves this one. Stop, and put the exact ' +
      'change in your report — path, diff, and why — so the conductor can apply it or run the same ' +
      'edit in the main session, where the permission prompt is the approval. Do not look for a ' +
      'path around this gate: writing the same bytes through `Bash` is outside what this gate ' +
      'checks for CLASSES — though it does refuse a shell command that names a credential file or ' +
      'a built-in protected path — and doing it deliberately is the one thing that turns a ' +
      'boundary into a decoration.'
    );
  }
  return (
    'What to do instead: put the change in your report for the operator, with the path and the ' +
    'diff.'
  );
  // No third branch. A GATED path in a supervised main loop PASSES, so the
  // only refusals that reach here are KERNEL or unsupervised — review found the
  // third arm unreachable, with zero hits in the tests and in the docs, which
  // is a strand of load-bearing-looking text that bears nothing (ADR-20's own
  // lesson, and the same defect the lexer's `cd -` branch had).
}

// --------------------------------------------------------------- Bash / push

/**
 * Options whose ARGUMENT is prose, not a path.
 *
 * `git commit -m "fix .env loading"` must not be refused for the words in a
 * commit message. This is an enumeration and therefore incomplete — but the
 * direction of its incompleteness is a FALSE REFUSAL, never a silent pass: a
 * message flag this list misses produces an over-strict gate, not a hole.
 * That is the only shape of enumeration this file allows.
 *
 * `--data` is here for the same reason as `-m`, and the cost of its absence
 * was measured twice on one install: `journal.mjs append ... --data '{...}'`
 * carries a JSON blob of PROSE — a decision's text, a report's summary — and
 * a journal entry merely DESCRIBING a dotenv-shaped filename ("applied the
 * migration against .env.test") was indistinguishable to this gate from a
 * command PUBLISHING that file. The refusal pushed conductors into a
 * convention of never writing certain filenames into their own ledger, which
 * is the journal failing at its one job of recording what happened.
 */
const MESSAGE_FLAGS = Object.freeze(['-m', '--message', '-F', '--file', '-t', '--template', '-am', '-ma', '--data']);

/**
 * Remove the ARGUMENT of a message-bearing option before the tokens are taken.
 *
 * `git commit -m "fix .env loading"` is three tokens after whitespace
 * splitting, so skipping "the next token" left `.env` in the stream and this
 * gate refused a commit message — a false alarm on one of the commonest
 * commands there is, which is exactly how a gate gets uninstalled.
 *
 * A quoted run is matched on the RAW text, before quotes are stripped. That is
 * the same move `stripHeredocBodies` makes in the shared lexer and for the same
 * reason: a here-doc body and a commit message are DATA, and lexing data as a
 * program was measured there to be the single largest source of noise.
 *
 * Deliberately NOT a general quote-aware lexer — this repository has one lexer
 * and is not getting a second. What is skipped is a bounded, named shape.
 */
export const MESSAGE_ARGUMENT_RE = /(^|\s)(-m|--message|-F|--file|-t|--template|-am|-ma|--data)(=|\s+)("[^"]*"|'[^']*'|\S+)/g;

export function stripMessageArguments(command) {
  return String(command).replace(MESSAGE_ARGUMENT_RE, '$1');
}

/**
 * Paths a shell command NAMES that this gate protects elsewhere.
 *
 * ## Why this exists at all
 *
 * Round two declared "shell commands are not path-classified" as a boundary.
 * Review measured what that boundary costs, twice, and both are refusals:
 *
 *  - `Read .env` was refused and the model reached for `Bash: grep` **in the
 *    next tool call**, unprompted, and read the value;
 *  - the read rule's own way out — "only a human can edit the policy, so only
 *    a human can add an exemption" — was taken by an agent in three tool calls
 *    with `cat >> .tyran/policies/autonomy.yaml`.
 *
 * The sibling `write-guard` on `main` had already closed this class for its own
 * rule, with a matcher covering `Bash` and a refusal that says the rule is not
 * tool-specific. Two sibling gates answering the same question two ways is the
 * collision ADR-21 exists to prevent, so this one now answers the same way.
 *
 * ## What it checks, and the doctrine it inherits
 *
 * Like `write-guard`, it reads the TEXT of the command, never the effect of
 * running it. Every literal token of every segment is tested — no heuristic
 * about which token "looks like a path", because an ordinary word matches
 * nothing and testing it costs nothing. Two families are refused:
 *
 *  - a **credential-shaped** path, whatever the program does with it. `cat`,
 *    `grep`, `cp` and `base64` all publish the bytes; the distinction between
 *    reading and copying is not one this gate can make, and does not matter.
 *  - a path under `MANDATORY_KERNEL_PATHS`. Deliberately NOT the policy's own
 *    KERNEL rules: those need the policy file, and a broken policy must not be
 *    the thing that stops an operator running the validator. The two built-in
 *    globs need no configuration and cannot be edited away.
 *
 * ## The declared floor
 *
 * `SHELL_DECLARED_MISSES` names what still gets through. A path assembled at
 * runtime, or written by a program the command launches, cannot be seen
 * without running the command — the same ceiling `write-guard` states.
 */
/**
 * The globs the SHELL rule protects. Wider than the validator's list, on purpose.
 *
 * `MANDATORY_KERNEL_PATHS` is the validator's business: a policy may not
 * downgrade those two, and changing that list is a decision about what a
 * policy file is allowed to say. This list is a different question — which
 * paths this gate refuses to see in a shell command — and it has one more
 * entry for one reason:
 *
 * **`.claude/settings.json` is the hook registry. It is the only place inside
 * a repository from which every gate can be switched off at once.** The
 * template classifies it KERNEL, so `Edit` and `Write` refuse it — and until
 * now `echo x > .claude/settings.json` did not, which left the shortest path
 * to disabling this gate as the one route it did not watch.
 *
 * THE ASYMMETRY THIS LEAVES, named rather than hidden: the registry is
 * protected from a shell write by THIS list, which no policy can edit, but its
 * CLASS comes from a template rule, which a user can downgrade to AUTO. So a
 * user who rewrites their own policy can make `Edit .claude/settings.json`
 * allowed while `echo > .claude/settings.json` stays refused. Raising it into
 * the validator's list would close that, and is deliberately out of scope here
 * — it changes what every policy file in the world is allowed to say.
 */
export const SHELL_PROTECTED_GLOBS = Object.freeze([
  ...MANDATORY_KERNEL_PATHS,
  '.claude/settings.json',
  '.claude/settings.local.json',
]);

/** The shell-protected glob covering this path, or null. */
export function shellProtectedGlobFor(normalized) {
  if (normalized === null || normalized === undefined) return null;
  for (const glob of SHELL_PROTECTED_GLOBS) {
    if (globMatches(glob, normalized)) return glob;
  }
  return null;
}

export const SHELL_DECLARED_MISSES = Object.freeze([
  'a path assembled at runtime — from a variable, a command substitution, a glob, or a file ' +
    'already on disk. The gate never expands anything, so it never sees the result',
  'a path reached through a relative walk this gate resolves against the SESSION directory ' +
    'rather than the directory a `cd` moved to: the answer is then stricter, not looser, but it ' +
    'is a different path from the one the shell would use',
  'anything a script writes once it is running — this reads the COMMAND, never its effect',
  'a KERNEL path declared by the POLICY rather than built in; only SHELL_PROTECTED_GLOBS is ' +
    'checked here, so that a broken policy cannot stop the operator repairing it',
]);

/** Every literal token of a command, with message-flag arguments skipped. */
export function commandTokens(command) {
  const out = [];
  for (const segment of splitSegments(stripMessageArguments(command))) {
    for (const token of tokensOf(segment)) {
      // A leftover bare flag, when the argument was already removed above.
      if (MESSAGE_FLAGS.includes(token)) continue;
      if (isLiteralPath(token)) out.push(token);
    }
  }
  return out;
}

/** The protected paths a command names. Empty is the ordinary case. */
export function shellPathFindings(command, startDir, root) {
  const findings = [];
  for (const token of commandTokens(command)) {
    const abs = resolvePath(startDir, token);
    const secret = secretReadRules(token).length > 0 ? secretReadRules(token) : secretReadRules(abs);
    if (secret.length > 0) {
      findings.push({ kind: 'credential', token, detail: secret.join(', ') });
      continue;
    }
    const rel = repoRelative(abs, root);
    const glob = rel === null ? null : shellProtectedGlobFor(rel);
    if (glob !== null) findings.push({ kind: 'kernel', token, detail: glob });
  }
  return findings;
}

/** The refusal for a protected path named in a shell command. */
function refuseShellPaths(findings) {
  const credentials = findings.filter((f) => f.kind === 'credential');
  const kernel = findings.filter((f) => f.kind === 'kernel');
  const lines = [
    'tyran policy-gate: refused. This command names a path this gate protects.',
    ...credentials.map(
      (f) => `  - ${JSON.stringify(shortPath(f.token))} is credential-shaped (${safePolicyText(f.detail)})`,
    ),
    ...kernel.map(
      (f) => `  - ${JSON.stringify(shortPath(f.token))} is under the protected path \`${safePolicyText(f.detail)}\``,
    ),
  ];
  if (credentials.length > 0) {
    lines.push(
      '',
      'A shell command that names a credential file publishes its bytes whatever the program is: ' +
        '`cat`, `grep`, `cp` and `base64` are the same event. Measured in review: this gate refused ' +
        'a `Read` of a .env file and the model reached for `Bash: grep` in its NEXT tool call, ' +
        'unprompted, and got the value.',
    );
  }
  if (kernel.length > 0) {
    lines.push(
      '',
      'A protected path is edited by a human, by hand, outside an agent session — these are the ' +
        'files that enforce every other boundary. To READ one, use the Read tool, which is not ' +
        'refused for them.',
    );
  }
  lines.push(
    '',
    // The same sentence write-guard settled on, for the same measured reason:
    // the model proposes the other tool by itself, so the refusal answers the
    // idea before it is tried rather than leaving a gap for it to find.
    'This rule is not specific to one tool: the same check runs on Write, Edit, NotebookEdit, Read',
    'and on the text of a Bash command. Reaching for a different tool is not a way around it.',
    '',
    'Declared floor: this reads the COMMAND, never the effect of running it. ' +
      `${SHELL_DECLARED_MISSES.length} known ways past it are listed in docs/policy-gate.md.`,
  );
  return { decision: 'deny', reason: lines.join('\n') };
}

async function decideBash({ input, toolInput, root, runner, budget }) {
  const command = field(toolInput, 'command');
  if (typeof command !== 'string') {
    return {
      decision: 'deny',
      reason:
        'tyran policy-gate: refused. This Bash call carries no readable `command`, so the gate ' +
        'could not tell whether it publishes anything.\n' +
        'A check that cannot run must not read as approval (ADR-22).',
    };
  }
  const startDir = (() => {
    const cwd = field(input, 'cwd');
    return typeof cwd === 'string' && cwd !== '' ? cwd : root;
  })();

  // The path rules come FIRST and need no configuration: they are the answer to
  // "the model was refused a Read and reached for Bash in the next call", and a
  // check that only runs once a policy loads is a check an unconfigured repo
  // does not have.
  const findings = shellPathFindings(command, startDir, root);
  if (findings.length > 0) return refuseShellPaths(findings);

  const plan = planCommand(command, startDir);
  const pushes = plan.targets.filter((t) => t.scanPush === true && Array.isArray(t.pushArgv));
  // Asked of the LEXER, not spelled again here. The first version of this gate
  // carried its own alias test, which was a second spelling of one rule two
  // files apart — and the secrets gate, which had the same blind spot, went on
  // not knowing. It is one answer now, in `planCommand`, and both gates read it.
  if (plan.aliased) {
    throw new PolicyFailure(
      'this git command defines or uses an ALIAS, so which subcommand it runs is not readable ' +
        'from the command line',
      'run the subcommand by its real name (`git push origin my-branch`). An alias can rename ' +
        'any subcommand, so a gate that trusted the words it can see would be reading a different ' +
        'command from the one git runs — measured: `git -c alias.zz=push zz origin main` published ' +
        'to a protected branch while this gate saw no push at all.',
    );
  }
  if (pushes.length === 0) return PASS;

  const deployClass = await loadDeployClass(root);
  if (deployClass === null) {
    // Symmetry with the policy file, which round two did not have: a missing
    // config in an ADOPTED repo refuses, exactly as a missing policy does.
    // Only a repo with no `.tyran/` at all is silent.
    let adopted = false;
    // The worktree's repository, not just the worktree: a push from a linked
    // checkout must not read as "Tyran does not run here" (see loadPolicy).
    for (const candidate of [root, mainWorktreeOf(root)].filter((r) => r !== null)) {
      try {
        if ((await stat(join(candidate, TYRAN_DIR))).isDirectory()) {
          adopted = true;
          break;
        }
      } catch {
        /* keep looking */
      }
    }
    if (!adopted) return PASS;
    throw new PolicyFailure(
      `this command pushes, and this repository has a ${TYRAN_DIR}/ directory but no ${CONFIG_PATH}`,
      `restore it from the shipped template and set \`autonomy: P1\` if you are unsure. A missing ` +
        'deployment class is not the widest one.',
    );
  }

  if (plan.unmodellable.length > 0) {
    const what = [...new Set(plan.unmodellable.map((u) => u.what))];
    throw new PolicyFailure(
      `this command pushes, and ${what.length} part(s) of it decide WHERE in a way this gate ` +
        `cannot follow:\n${what.map((w) => `  - ${w}`).join('\n')}`,
      'Write the path literally, run the command from that directory, or split it into separate ' +
        'tool calls so each one is unambiguous. The gate never expands variables or runs a shell ' +
        'to find out where a command would land.',
    );
  }

  for (const target of pushes) {
    const push = readPush(target.pushArgv);
    const dir = target.dir;

    if (push.unreadable.length > 0) {
      throw new PolicyFailure(
        `this push names ${push.unreadable.length} refspec(s) the shell would rewrite before git ` +
          'sees them, so the gate cannot tell which branch it publishes to',
        'write the refspec literally (`git push origin my-branch`). Measured: a destination held ' +
          'in a variable was read as a branch literally named `$B`, matched no protected name, ' +
          'and published to the default branch.',
      );
    }

    let destinations = [...push.destinations];
    // `HEAD` and `@` resolve exactly like a bare `git push`: one answer for
    // "which branch is this", not two.
    if (push.symbolic.length > 0 || push.impliesCurrentBranch) {
      const current = await symbolicRef(dir, 'HEAD', { runner, timeoutMs: budget(GIT_BUDGET_MS) });
      if (current === null) {
        throw new PolicyFailure(
          `this push's destination is whatever branch is checked out in ` +
            `${JSON.stringify(shortPath(dir))} — and the gate could not read that branch`,
          'run the push with an explicit refspec (`git push origin my-branch`), or check out a ' +
            'named branch. A detached HEAD has no branch name for a policy to reason about.',
        );
      }
      destinations.push(current);
    }

    const remote = push.remote ?? 'origin';
    let defaultBranch = null;
    if (deployClass !== 'P3') {
      defaultBranch = await symbolicRef(dir, `refs/remotes/${remote}/HEAD`, {
        runner,
        timeoutMs: budget(GIT_BUDGET_MS),
      });
      if (defaultBranch !== null) defaultBranch = refName(defaultBranch).replace(`${remote}/`, '');
      if (defaultBranch === null) {
        // Refusing here rather than falling back to the name list alone. The
        // list is an enumeration and a repository whose production branch is
        // called `ship` would sail through it silently. The remedy is one
        // command and permanent, which is what makes a refusal honest rather
        // than an obstacle.
        throw new PolicyFailure(
          `this repository does not record which branch \`${safePolicyText(remote)}\` treats as ` +
            'default, and under ' + deployClass + ' the gate has to know that before it can tell a ' +
            'feature branch from production',
          `run \`git remote set-head ${safePolicyText(remote)} -a\` once in this repository. It ` +
            'writes a local ref, changes nothing on the remote, and is the whole fix. The gate ' +
            'refuses instead of guessing, because guessing here means guessing in the direction ' +
            'of publishing.',
        );
      }
    }

    const isProduction = (b) =>
      PRODUCTION_BRANCHES.includes(b.toLowerCase()) || (defaultBranch !== null && b === defaultBranch);
    const isShared = (b) => SHARED_BRANCHES.includes(b.toLowerCase());

    let scope = 'feature';
    if (push.everything || push.tags || destinations.some(isProduction)) scope = 'production';
    else if (destinations.some(isShared)) scope = 'shared';
    if (destinations.length === 0 && !push.everything && !push.tags) {
      throw new PolicyFailure(
        'this push has no destination the gate could read',
        'name the remote and the refspec explicitly (`git push origin my-branch`).',
      );
    }

    const irreversible = [];
    if (push.deletes) irreversible.push('it deletes a ref on the remote');
    if (push.mirrors) irreversible.push('`--mirror` deletes every remote ref that is absent locally');
    if (push.forced && scope !== 'feature') {
      irreversible.push('it force-pushes over a shared branch, discarding published history');
    }

    const { verdict, because } = deployVerdict(deployClass, scope, irreversible);
    if (verdict === 'pass') continue;

    const named = destinations.map((d) => `\`${safePolicyText(d)}\``).join(', ') || '(every branch)';
    return {
      decision: 'deny',
      reason:
        `tyran policy-gate: refused. This push reaches further than deployment class ` +
        `${deployClass} allows.\n` +
        `destination: ${named} on remote \`${safePolicyText(remote)}\` · scope: ${scope}` +
        `${defaultBranch === null ? '' : ` · this remote's default branch is \`${safePolicyText(defaultBranch)}\``}\n` +
        `rule: \`${CONFIG_PATH}\`, \`autonomy: ${deployClass}\` — ` +
        `${DEPLOY_CLASS_MEANING[deployClass]}\n` +
        (irreversible.length > 0
          ? `irreversible: ${irreversible.join('; ')}. These stay refused at every class, ` +
            'including P3, because "autonomous" was never meant to include "unrecoverable".\n'
          : '') +
        `${DEPLOY_REMEDY[because] ?? DEPLOY_REMEDY.default}`,
    };
  }
  return PASS;
}

const DEPLOY_CLASS_MEANING = Object.freeze(Object.assign(Object.create(null), {
  P1: 'branch only; an agent pushes its own work and a human moves it further',
  P2: 'staging and testing branches; production stays a human decision',
  P3: 'production too, minus the operations that cannot be undone',
}));

const DEPLOY_REMEDY = Object.freeze(Object.assign(Object.create(null), {
  irreversible:
    'What to do instead: push the branch without deleting or rewriting anything, and let the ' +
    'operator do the destructive step. A deleted remote ref and an overwritten history are not ' +
    'recoverable from this session, which is the whole reason they are outside every autonomy class.',
  production:
    'What to do instead: push to your own branch and open a pull request. The class lives in ' +
    `\`${CONFIG_PATH}\`, and it is your own policy that decides whether an agent may edit that ` +
    'file — the shipped template classifies it AUTO — so keeping the class where the operator put ' +
    'it is by CONVENTION, not by mechanism. No class is named here on purpose: this text would ' +
    'otherwise go stale the moment a repo reclassified the file, and a refusal that states the ' +
    'wrong reason is worse than one that states none. Measured in review, an agent in an ' +
    'unattended main loop edited P1 to P3 with no refusal. Treat raising it yourself as the thing ' +
    'you were asked not to do, and say in your report that you wanted to.',
  shared:
    'What to do instead: push to your own branch and open a pull request. Under P1 an agent stays ' +
    'on the branch it created; the shared branches are P2 and above.',
  default:
    'What to do instead: push to a branch of your own and open a pull request from it.',
}));

/** Turn a PolicyFailure into the refusal it always has to be. */
export async function handle({ input, runner, startedAt, env }) {
  try {
    return await decide({ input, runner, startedAt, env });
  } catch (err) {
    if (err instanceof PolicyFailure) {
      return {
        decision: 'deny',
        reason:
          `tyran policy-gate: refused because the check could not be completed.\n` +
          `what happened: ${err.message}\n` +
          `what to do: ${err.remedy}\n` +
          'This is a refusal rather than a warning because the platform fails open (ADR-22): a ' +
          'gate that lets the action through whenever it breaks is a gate you switch off by ' +
          'breaking it.',
      };
    }
    // Anything else is a bug here. hook-io turns a throw into a refusal naming
    // the error class, which is the correct ending.
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
      handler: ({ input }) => handle({ input }),
    }),
  );
}
