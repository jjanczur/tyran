/**
 * cli-args — the two things every command-line entry point owes its caller:
 * answer `--help`, and refuse a flag it does not understand.
 *
 * Measured across the 14 commands `bin/tyran.mjs` dispatches, on a repo where
 * setup had just run:
 *
 *   --help answered as help ............ 0 of 14
 *   silently IGNORED an unknown flag ... 4 (tiers, scan-repo, stop-check,
 *                                          desc-budget)
 *
 * The second is the defect; the first is the symptom that found it. Those four
 * parse by scanning for the flags they know (`args.indexOf('--role')`), so a
 * flag they do not know is not rejected — it is never looked at. `tiers --rol
 * reviewer` therefore exits 0 and prints the whole routing table, which is a
 * different answer to a different question, given without a word about the
 * typo. The same line one character later, `tiers --role revieweer`, is
 * refused with the list of valid roles: the VALUE was validated and the flag
 * NAME was not.
 *
 * board.mjs, doctor.mjs, answer.mjs, cost.mjs and migrate.mjs already refuse
 * unknown flags. This module is not a new convention — it is the one already
 * in the majority, made importable so the count of spellings stops going up
 * (ADR-21).
 */

/** What a caller types when they want to be told, rather than obeyed. */
export const HELP_FLAGS = Object.freeze(['--help', '-h', 'help']);

export function wantsHelp(args) {
  return args.some((arg) => HELP_FLAGS.includes(arg));
}

/**
 * Every `--flag` in `args` that is not in `known`.
 *
 * Returns the offending tokens rather than throwing, so each caller keeps its
 * own exit code and its own `name: message` prefix — the scripts disagree
 * about those on purpose and this module has no business unifying them.
 *
 * A bare `--` ends flag parsing by convention and is not a flag; anything
 * after it is a positional and is not inspected. Negative numbers (`-3`) are
 * not flags either, which is why only `--` prefixes are considered.
 */
export function unknownFlags(args, known) {
  const allow = new Set(known.map((k) => (k.startsWith('--') ? k : `--${k}`)));
  const found = [];
  for (const arg of args) {
    if (arg === '--') break;
    if (!arg.startsWith('--')) continue;
    // `--flag=value` is the same flag as `--flag`.
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    if (!allow.has(name)) found.push(name);
  }
  return found;
}

/**
 * The whole contract in one call, for a script whose usage is a plain string.
 *
 * `print`/`fail` are injected so a test can drive this without a process, and
 * `exit` is called rather than returned so a caller cannot forget to stop.
 */
export function handleArgs(
  args,
  { name, usage, known },
  { print = console.log, fail = console.error, exit = process.exit } = {},
) {
  if (wantsHelp(args)) {
    print(usage);
    exit(0);
    return false;
  }
  const bad = unknownFlags(args, known);
  if (bad.length > 0) {
    fail(`${name}: unknown flag ${bad.join(', ')}`);
    fail(usage);
    exit(2);
    return false;
  }
  return true;
}
