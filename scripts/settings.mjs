#!/usr/bin/env node
/**
 * settings — the knobs an operator may turn, and what each one means.
 *
 * `.tyran/config.yaml` and `.tyran/policies/autonomy.yaml` were editable in
 * exactly one way before this file existed: open them in an editor and know
 * what you are doing. That is fine for the person who wrote them and useless
 * for everyone else, and the board — the one screen an operator already has
 * open — could not answer "where do I change this?" at all.
 *
 * So this module is the CATALOGUE: every knob, its type, its legal values, and
 * a sentence of prose saying what turning it actually does. The board renders
 * it; `applySetting` writes it back through `yaml-patch`, which keeps the
 * file's comments; `schema.mjs` validates the result before anything lands.
 *
 * ## One answer in one place
 *
 * The legal values are IMPORTED, never restated: `PROFILES`, `AUTONOMY_CLASSES`,
 * `TIER_KEYS`, `LIMITS_MODES`, `LIMITS_LONG_WAIT`, `ARTIFACT_CLASSES` all come
 * from `schema.mjs`, which is the validator. A second list here would drift
 * from the one that enforces it, and the UI would offer a choice the file
 * rejects. The prose is the only thing this file owns.
 *
 * ## What is deliberately NOT here
 *
 * `pricing:` — a rate card is a table of numbers copied from a vendor's price
 * list, which is a spreadsheet task, not a knob. It stays a hand edit.
 *
 * Adding and removing POLICY RULES. A rule is a path glob, a class and a
 * written reason, and the reason is the load-bearing part: `docs/policy-gate.md`
 * asks every boundary to say why it exists. Changing an existing rule's class
 * is a decision the operator can make from a screen; authoring a new boundary
 * with a one-line reason typed into a web form is how a policy file turns into
 * a list of unexplained globs. Class changes are here; authoring is not.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_CLASSES,
  AUTONOMY_CLASSES,
  BOUNDARY_PRESETS,
  BOUNDARY_PROMPTS,
  BOUNDARY_VALUES,
  LIMITS_LONG_WAIT,
  LIMITS_MODES,
  MANDATORY_KERNEL_PATHS,
  PROFILES,
  TIER_KEYS,
  validateConfig,
  validatePolicy,
} from './schema.mjs';
import { parse, YamlLiteError } from './yaml-lite.mjs';
import { patch, YamlPatchError } from './yaml-patch.mjs';

export const SETTINGS_SCHEMA = 1;

export const CONFIG_FILE = 'config.yaml';
export const POLICY_FILE = join('policies', 'autonomy.yaml');

export class SettingsError extends Error {
  constructor(message, detail = {}) {
    super(message);
    Object.assign(this, detail);
  }
}

const choice = (values, describe) => ({ kind: 'choice', choices: values.map((v) => ({ value: v, describe: describe[v] })) });

/**
 * Every editable knob in `config.yaml`, grouped the way an operator thinks
 * about them rather than the way YAML nests them.
 *
 * `path` addresses the value inside the document. Fields that `schema.mjs`
 * wraps in provenance (`profile`, `autonomy`, `validation` can each be either
 * a bare value or `{value, source, confidence}`) are resolved at read time by
 * `resolvePath` — the catalogue names the logical field, not the spelling a
 * particular file happens to use.
 */
export const GROUPS = Object.freeze([
  {
    id: 'work',
    title: 'How work gets done',
    blurb: 'What Tyran spends, and how far it may go on its own.',
    settings: [
      {
        id: 'profile',
        path: ['profile'],
        label: 'Cost profile',
        help: 'How much verification each piece of work carries. The cheaper profiles skip review passes, not tests.',
        ...choice(PROFILES, {
          eco: 'Fewest agents and fewest review passes. Good for small, well-understood changes.',
          balanced: 'The default. Implementation plus an independent review on anything non-trivial.',
          full: 'Every gate, every review, the strongest tier where it matters. Slow and thorough.',
        }),
      },
      {
        id: 'autonomy',
        path: ['autonomy'],
        label: 'Deployment autonomy',
        help: 'How far a finished piece of work may travel without you. The gate enforces this downward — it will not stop someone who edits this file from raising it, which is why the policy below decides who may.',
        widening: {
          scale: 'autonomy',
          consequence:
            'A higher deployment class lets finished work travel further without you — P2 reaches staging, P3 merges to the default branch.',
        },
        ...choice(AUTONOMY_CLASSES, {
          P1: 'Branch only. Agents commit and push a branch; you open and merge the PR.',
          P2: 'Through to staging. Agents may merge and deploy to a non-production environment.',
          P3: 'Merge to main. Agents may land work on the default branch by themselves.',
        }),
      },
    ],
  },
  {
    id: 'boundaries',
    title: 'What agents may touch',
    blurb:
      'How far the policy gate turns its refusals down. Everything here starts at the strict setting, and every move toward the looser one asks you to confirm it a second time. Four things are NOT on this screen because no setting reaches them: secret scanning at commit and push, the enforcement hooks themselves, the file that registers them, and the STOP brake.',
    settings: [
      {
        id: 'boundaries.preset',
        path: ['boundaries', 'preset'],
        label: 'Preset',
        help: 'The one switch. "Open" turns every boundary below to its loose setting at once — the closest thing Tyran has to running Claude Code with permissions skipped. Anything you set individually below wins over the preset.',
        widening: {
          scale: 'preset',
          consequence:
            'OPEN lets agents read your credentials, work outside this repository, write paths your own policy gates, push anywhere, and act without a permission prompt. Secret scanning and the gate\'s own files are unaffected.',
        },
        ...choice(BOUNDARY_PRESETS, {
          strict: 'Every boundary on. This is what Tyran has always done.',
          open: 'Every boundary below turned down at once.',
        }),
      },
      {
        id: 'boundaries.outside_repo',
        path: ['boundaries', 'outside_repo'],
        label: 'Files outside this repository',
        help: 'Today a path outside the repo root is refused for every agent. Allowing it lets them read and write anywhere on this machine — another project, your home directory, system files.',
        widening: {
          scale: 'boundary',
          consequence: 'Agents will be able to write files anywhere on this machine, not only inside this repository.',
        },
        ...choice(BOUNDARY_VALUES, {
          refuse: 'Agents stay inside this repository.',
          allow: 'Agents may read and write anywhere on this machine.',
        }),
      },
      {
        id: 'boundaries.credentials',
        path: ['boundaries', 'credentials'],
        label: 'Credential files',
        help: 'Today .env files, private keys, ~/.ssh, ~/.aws and their relatives are refused before they can reach the model — a transcript is storage. Allowing it also removes the false refusal where a word merely ENDING in .key or .pem is treated as a file.',
        widening: {
          scale: 'boundary',
          consequence:
            'Agents will be able to read your secrets into the conversation. What stops those bytes being COMMITTED or PUSHED is the secrets gate, which this setting does not reach.',
        },
        ...choice(BOUNDARY_VALUES, {
          refuse: 'Credential-shaped files never enter the conversation.',
          allow: 'Agents may read .env files, keys and credential stores.',
        }),
      },
      {
        id: 'boundaries.path_classes',
        path: ['boundaries', 'path_classes'],
        label: 'Your own path rules',
        help: 'The AUTO / GATED / KERNEL rules in the policy below. Allowing this makes them advisory: a subagent may write a path you gated. The four paths that protect the gate itself stay refused whatever this says.',
        widening: {
          scale: 'boundary',
          consequence: 'The GATED and KERNEL rules in your own policy stop being enforced for writes.',
        },
        ...choice(BOUNDARY_VALUES, {
          refuse: 'The classes in your policy are enforced.',
          allow: 'Agents may write paths your policy gates.',
        }),
      },
      {
        id: 'boundaries.push',
        path: ['boundaries', 'push'],
        label: 'Where work may be pushed',
        help: 'Turns off the deployment-class check on git push entirely, including the rules that gate the pushes nothing can undo — a force push to main, a deleted remote branch, a mirror push.',
        widening: {
          scale: 'boundary',
          consequence:
            'The deployment class stops being checked. Agents may force-push, delete remote branches and mirror-push, none of which can be undone.',
        },
        ...choice(BOUNDARY_VALUES, {
          refuse: 'Pushes are checked against the deployment autonomy above.',
          allow: 'Any push is allowed, including the irreversible ones.',
        }),
      },
      {
        id: 'boundaries.prompts',
        path: ['boundaries', 'prompts'],
        label: 'Permission prompts',
        help: 'Whether Claude Code still asks you before a tool call this gate has no objection to. "Skip" auto-approves those calls, which is what people mean by skipping permissions — a refusal from any gate still wins, so this cannot approve something another gate denied.',
        widening: {
          scale: 'prompts',
          consequence: 'Claude Code will stop asking before it edits files or runs commands that no gate objects to.',
        },
        ...choice(BOUNDARY_PROMPTS, {
          ask: 'Claude Code prompts you as it normally would.',
          skip: 'Calls no gate objects to are approved without asking.',
        }),
      },
    ],
  },
  {
    id: 'tiers',
    title: 'Model tiers',
    blurb:
      'The only place model names appear. Skills, agents and policies are all written in ROLE names, so a model deprecation is four lines here and nothing else moves.',
    settings: TIER_KEYS.map((key) => ({
      id: `tiers.${key}`,
      path: ['tiers', key],
      label: key,
      kind: 'text',
      help: {
        cheap: 'Scouts, mechanical sweeps, ledger bookkeeping. Work where being fast beats being clever.',
        work: 'The default tier: ordinary implementation and ordinary review. Most work lands here.',
        deep: 'Root-cause diagnosis, hard implementation, risky review — where a wrong answer is expensive.',
        top: 'Security review, arbitration, final acceptance. The last word, used sparingly.',
      }[key],
      placeholder: 'a model id or alias your CLI accepts',
    })),
  },
  {
    id: 'proof',
    title: 'Proving it works',
    blurb: 'What every agent must run before it is allowed to call anything done.',
    settings: [
      {
        id: 'validation',
        path: ['validation'],
        label: 'Validation commands',
        kind: 'list',
        help: 'Run in order before any work is reported. Each must EXIT — a watch-mode test runner here hangs every agent you ever spawn, which is a real measured incident, not a hypothetical.',
        placeholder: 'npm test',
      },
      {
        id: 'shared_zones',
        path: ['shared_zones'],
        label: 'Shared zones',
        kind: 'list',
        help: 'Files more than one agent may touch in parallel. Writes to these are append-only and serialized by the conductor, so two agents cannot clobber each other.',
        placeholder: 'src/registry.ts',
      },
    ],
  },
  {
    id: 'overnight',
    title: 'Overnight mode',
    blurb:
      'Pause near the subscription usage limit and resume after the window resets. Needs the statusline helper installed — it is the only place the platform reports usage, and without it this whole section is inert and doctor says so.',
    settings: [
      {
        id: 'limits.mode',
        path: ['limits', 'mode'],
        label: 'Mode',
        ...choice(LIMITS_MODES, {
          off: 'Nothing pauses. The usage gate never denies a tool call.',
          warn: 'Surfaces how close you are, but never denies anything.',
          pause: 'Winds work down at the threshold, checkpoints it, and schedules the resume.',
        }),
        help: 'What happens as the usage window fills up.',
      },
      {
        id: 'limits.pause_at_percent',
        path: ['limits', 'pause_at_percent'],
        label: 'Pause at (5-hour window)',
        kind: 'number',
        min: 50,
        max: 100,
        unit: '%',
        help: 'How full the five-hour window must be before work winds down. The floor of 50 exists to catch 0.97 pasted where 97 belongs.',
      },
      {
        id: 'limits.weekly_pause_at_percent',
        path: ['limits', 'weekly_pause_at_percent'],
        label: 'Pause at (weekly window)',
        kind: 'number',
        min: 50,
        max: 100,
        unit: '%',
        help: 'The same threshold for the seven-day window. Hitting this one means a much longer wait.',
      },
      {
        id: 'limits.wait_max_hours',
        path: ['limits', 'wait_max_hours'],
        label: 'Longest silent wait',
        kind: 'number',
        min: 0.5,
        max: 24,
        unit: 'h',
        help: 'A reset further away than this is a LONG pause: it gets announced rather than silently waited out. The weekly window can be days.',
      },
      {
        id: 'limits.long_wait',
        path: ['limits', 'long_wait'],
        label: 'Beyond that',
        ...choice(LIMITS_LONG_WAIT, {
          hold: 'Stop and tell you. You decide when to pick it back up.',
          resume: 'Schedule the resume anyway, however far out it is.',
        }),
        help: 'What the scheduler does when the reset is further away than the wait above.',
      },
      {
        id: 'limits.resume_margin_minutes',
        path: ['limits', 'resume_margin_minutes'],
        label: 'Resume margin',
        kind: 'number',
        min: 1,
        max: 240,
        unit: 'min',
        help: 'How long after the window resets before work restarts. A little slack absorbs clock skew between your machine and the platform.',
      },
      {
        id: 'limits.keep_awake',
        path: ['limits', 'keep_awake'],
        label: 'Hold the machine awake',
        kind: 'boolean',
        help: 'A laptop that suspends takes the resume watcher down with it. This holds the SYSTEM awake while it waits — never the display, so your screen lock is untouched.',
      },
    ],
  },
]);

const BY_ID = new Map(GROUPS.flatMap((g) => g.settings.map((s) => [s.id, s])));

/**
 * Which way is looser.
 *
 * Two changes on this screen are not like the others: lowering a path's class
 * lets agents write something they previously had to ask about, and raising
 * the deployment class lets finished work travel further without a human. A
 * dropdown treats both as ordinary, and the shipped policy carries rules whose
 * own stated reason is that they must not move — `.claude/settings.json`
 * ("anything that can edit it can switch every gate off"), `.tyran/STOP` ("a
 * loop that can clear its own stop signal has none"). None of those is in
 * `MANDATORY_KERNEL_PATHS`, so the validator does not stop them and nothing
 * else did either.
 *
 * The rule is strictly one-directional. TIGHTENING applies on one click,
 * exactly like every other setting — friction on making a boundary stricter is
 * how you teach people to stop making boundaries stricter. Loosening needs a
 * second, deliberate act, and the page shows the rule's own reason first.
 */
const LOOSER_FIRST = Object.freeze({
  class: Object.freeze(['AUTO', 'GATED', 'KERNEL']),
  autonomy: Object.freeze(['P3', 'P2', 'P1']),
  // The `boundaries:` block. Each of these turns a REFUSAL off, so the
  // direction that needs the second act is the one that removes a check.
  boundary: Object.freeze([...BOUNDARY_VALUES].reverse()),
  prompts: Object.freeze([...BOUNDARY_PROMPTS].reverse()),
  preset: Object.freeze([...BOUNDARY_PRESETS].reverse()),
});

function widens(scale, before, after) {
  const order = LOOSER_FIRST[scale];
  const from = order.indexOf(before);
  const to = order.indexOf(after);
  // An unknown value is treated as a widening: this guard exists for the case
  // where something unexpected is happening, and a value nobody recognises is
  // not the moment to wave a change through.
  if (from === -1 || to === -1) return before !== after;
  return to < from;
}

/**
 * The confirmation a widening write must carry.
 *
 * It is the new value itself rather than a boolean, so a caller cannot satisfy
 * it by sending `confirm: true` alongside whatever value it liked — the token
 * only matches the change the operator was actually shown.
 */
function requireConfirm(scale, before, after, confirm, consequence) {
  if (!widens(scale, before, after)) return;
  if (confirm === after) return;
  throw new SettingsError(
    `${before} -> ${after} loosens this boundary, so it needs a second, deliberate confirmation. ${consequence}`,
    { widens: true, confirm_with: after },
  );
}

/** Every setting, flat, in catalogue order. */
export function allSettings() {
  return GROUPS.flatMap((g) => g.settings);
}

/**
 * The real path to a value, allowing for provenance.
 *
 * `profile: balanced` and `profile: {value: balanced, source: ...}` are both
 * legal and mean the same thing, so the catalogue names `profile` and this
 * decides which of the two spellings the file in front of us is using.
 */
function resolvePath(doc, path) {
  let node = doc;
  for (const segment of path) {
    // The REQUESTED path, never null. `limits:` is optional in a valid config
    // — every install set up before it existed has none — and returning null
    // here fed `readAt`'s `for (const segment of path)` an unusable value, so
    // the whole Settings tab died with "path is not iterable" and every write
    // became an HTTP 500. Handing the path back lets the absent-key branch do
    // its job: `present: false`, and a control that says so.
    if (node === null || typeof node !== 'object') return path;
    node = node[segment];
  }
  if (node !== null && typeof node === 'object' && !Array.isArray(node) && 'value' in node) {
    return [...path, 'value'];
  }
  return path;
}

function readAt(doc, path) {
  let node = doc;
  for (const segment of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[segment];
  }
  return node;
}

/** Read a YAML file, reporting a parse failure as data rather than throwing. */
function loadFile(file) {
  if (!existsSync(file)) return { present: false, doc: null, error: null, text: '' };
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    return { present: true, doc: null, error: String(err?.message ?? err), text: '' };
  }
  try {
    return { present: true, doc: parse(text), error: null, text };
  } catch (err) {
    // A config that does not parse is exactly when an operator most wants to
    // see this screen, so the failure is rendered rather than thrown.
    return { present: true, doc: null, error: err instanceof YamlLiteError ? err.message : String(err?.message ?? err), text };
  }
}

/**
 * A rule may only be shown as editable if changing its class could ever be
 * accepted. The kernel paths that protect the gate itself can be tightened but
 * never lowered — `validatePolicy` enforces that and would refuse the write —
 * so offering the choice would be offering a button that always fails.
 */
function ruleLocked(rulePath) {
  return MANDATORY_KERNEL_PATHS.includes(rulePath);
}

/** Everything the board needs to draw the Settings tab. */
export function readSettings(tyranDir) {
  const configFile = join(tyranDir, CONFIG_FILE);
  const policyFile = join(tyranDir, POLICY_FILE);
  const config = loadFile(configFile);
  const policy = loadFile(policyFile);

  const groups = GROUPS.map((group) => ({
    id: group.id,
    title: group.title,
    blurb: group.blurb,
    settings: group.settings.map((setting) => {
      const present = config.doc !== null && readAt(config.doc, resolvePath(config.doc, setting.path)) !== undefined;
      return {
        id: setting.id,
        label: setting.label,
        help: setting.help,
        kind: setting.kind ?? 'choice',
        choices: setting.choices ?? null,
        min: setting.min ?? null,
        max: setting.max ?? null,
        unit: setting.unit ?? null,
        placeholder: setting.placeholder ?? null,
        present,
        value: present ? readAt(config.doc, resolvePath(config.doc, setting.path)) : null,
      };
    }),
  }));

  const rules = Array.isArray(policy.doc?.rules)
    ? policy.doc.rules
        .filter((rule) => rule !== null && typeof rule === 'object' && typeof rule.path === 'string')
        .map((rule) => ({
          path: rule.path,
          class: rule.class ?? null,
          reason: typeof rule.reason === 'string' ? rule.reason : '',
          locked: ruleLocked(rule.path),
        }))
    : [];

  return {
    schema: SETTINGS_SCHEMA,
    files: {
      config: { path: join(tyranDir, CONFIG_FILE), present: config.present, error: config.error },
      policy: { path: join(tyranDir, POLICY_FILE), present: policy.present, error: policy.error },
    },
    groups,
    policy: {
      classes: [...ARTIFACT_CLASSES],
      describe: {
        AUTO: 'Agents write it themselves. Rollback is a git revert.',
        GATED: 'Agents propose, you approve. Denied outright to a subagent.',
        KERNEL: 'Humans only, by hand. Never autonomously, ever.',
      },
      default: policy.doc?.default ?? null,
      rules,
    },
  };
}

/** Reject a value that the catalogue's own type says is wrong. */
function coerce(setting, raw) {
  const kind = setting.kind ?? 'choice';
  if (kind === 'choice') {
    const legal = setting.choices.map((c) => c.value);
    if (!legal.includes(raw)) throw new SettingsError(`${setting.id}: must be one of ${legal.join(' | ')}`);
    return raw;
  }
  if (kind === 'boolean') {
    if (typeof raw !== 'boolean') throw new SettingsError(`${setting.id}: must be true or false`);
    return raw;
  }
  if (kind === 'number') {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new SettingsError(`${setting.id}: must be a number`);
    if (raw < setting.min || raw > setting.max) {
      throw new SettingsError(`${setting.id}: must be between ${setting.min} and ${setting.max}`);
    }
    return raw;
  }
  if (kind === 'text') {
    if (typeof raw !== 'string' || raw.trim() === '') throw new SettingsError(`${setting.id}: must not be empty`);
    return raw.trim();
  }
  if (kind === 'list') {
    if (!Array.isArray(raw)) throw new SettingsError(`${setting.id}: must be a list`);
    const items = raw.map((item) => (typeof item === 'string' ? item.trim() : item)).filter((item) => item !== '');
    for (const item of items) {
      if (typeof item !== 'string') throw new SettingsError(`${setting.id}: every entry must be text`);
    }
    return items;
  }
  throw new SettingsError(`${setting.id}: no editor for this kind of value`);
}

/**
 * Write one config setting, or refuse and change nothing.
 *
 * The order is the point: patch the TEXT, re-validate the RESULT with the same
 * validator `schema.mjs validate` runs, and only then hand the caller
 * something to write. A value that would produce a config the validator
 * rejects never reaches the disk, so the board cannot leave a repo in a state
 * its own tooling refuses to load.
 */
export function applySetting(tyranDir, id, value, confirm = null) {
  const setting = BY_ID.get(id);
  if (!setting) throw new SettingsError(`unknown setting "${id}"`);
  const file = join(tyranDir, CONFIG_FILE);
  const loaded = loadFile(file);
  if (!loaded.present) throw new SettingsError(`${file} does not exist — run /tyran:setup first`);
  if (loaded.doc === null) throw new SettingsError(`${file} does not parse, so it cannot be edited safely: ${loaded.error}`);

  const path = resolvePath(loaded.doc, setting.path);
  const before = readAt(loaded.doc, path);
  if (before === undefined) {
    throw new SettingsError(
      `"${setting.path.join('.')}" is not in ${file}. This screen edits values that are already there; ` +
        'add the key by hand once and it becomes editable here.',
    );
  }
  const next = coerce(setting, value);
  // Driven by the catalogue rather than by a list of ids here. The `autonomy`
  // check used to be an `if (id === ...)`, and every knob added beside it since
  // would have had to remember to extend that line — which is exactly how a
  // boundary-loosening control ships with no confirmation at all.
  if (setting.widening) {
    requireConfirm(setting.widening.scale, before, next, confirm, setting.widening.consequence);
  }

  let text;
  try {
    text = patch(loaded.text, path, next);
  } catch (err) {
    if (err instanceof YamlPatchError) throw new SettingsError(err.message);
    throw err;
  }

  const errors = validateConfig(parse(text));
  if (errors.length > 0) {
    throw new SettingsError(`that change makes the config invalid, so nothing was written:\n  ${errors.join('\n  ')}`);
  }
  return { file, path, before, after: next, text, before_text: loaded.text };
}

/**
 * Change one policy rule's class, or the default class, and refuse anything
 * that would weaken the boundary protecting the gate.
 *
 * The rule is addressed by its path GLOB, not by its position, and re-resolved
 * against the file as it is right now. An index captured when the page loaded
 * would point at a different rule if the file moved underneath it, and the
 * write would land on the wrong boundary with no error at all.
 */
export function applyPolicyClass(tyranDir, rulePath, klass, confirm = null) {
  if (!ARTIFACT_CLASSES.includes(klass)) {
    throw new SettingsError(`class must be one of ${ARTIFACT_CLASSES.join(' | ')}`);
  }
  const file = join(tyranDir, POLICY_FILE);
  const loaded = loadFile(file);
  if (!loaded.present) throw new SettingsError(`${file} does not exist — run /tyran:setup first`);
  if (loaded.doc === null) throw new SettingsError(`${file} does not parse, so it cannot be edited safely: ${loaded.error}`);

  let path;
  let before;
  let consequence;
  if (rulePath === null) {
    path = ['default'];
    before = loaded.doc.default;
    if (before === undefined) throw new SettingsError(`${file} has no "default" — add one by hand once and it becomes editable here`);
    consequence = 'This is the class every path no rule matches gets, so it is the widest change available on this screen.';
  } else {
    if (ruleLocked(rulePath)) {
      throw new SettingsError(
        `"${rulePath}" is one of the paths that protect the gate itself, and it stays KERNEL. ` +
          'A system that can lower the class of its own enforcement has no boundary at all.',
      );
    }
    const rules = Array.isArray(loaded.doc.rules) ? loaded.doc.rules : [];
    const index = rules.findIndex((rule) => rule !== null && typeof rule === 'object' && rule.path === rulePath);
    if (index === -1) throw new SettingsError(`no rule for "${rulePath}" in ${file}`);
    path = ['rules', index, 'class'];
    before = rules[index].class;
    // The rule's own `reason:` is the consequence, verbatim. Every boundary in
    // this file is required to say why it exists; that sentence was written by
    // whoever put the boundary there, and it is a better warning than anything
    // this module could compose about a path it has never seen.
    consequence = typeof rules[index].reason === 'string' && rules[index].reason !== ''
      ? `This rule exists because: ${rules[index].reason}`
      : 'This rule records no reason, which is itself worth looking at before loosening it.';
  }
  requireConfirm('class', before, klass, confirm, consequence);

  let text;
  try {
    text = patch(loaded.text, path, klass);
  } catch (err) {
    if (err instanceof YamlPatchError) throw new SettingsError(err.message);
    throw err;
  }

  // The same validator `schema.mjs validate policy` runs — including the check
  // that no rule, however spelled, can claim a kernel path at a lower class.
  const errors = validatePolicy(parse(text));
  if (errors.length > 0) {
    throw new SettingsError(`that change makes the policy invalid, so nothing was written:\n  ${errors.join('\n  ')}`);
  }
  return { file, path, before, after: klass, text, before_text: loaded.text };
}
