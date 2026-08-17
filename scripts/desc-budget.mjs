#!/usr/bin/env node
/**
 * desc-budget — CI guard against the "skill sprawl context tax".
 *
 * Every skill's frontmatter `description` is loaded into EVERY session's
 * context. This script sums the description lengths across all skills and
 * fails when the total exceeds the budget. The library may grow; the
 * always-loaded context surface may not.
 *
 * Usage:  node scripts/desc-budget.mjs [--budget <chars>] [pluginRoot]
 * Exit:   0 within budget · 1 over budget · 2 usage/IO error
 */
import { readFileSync, readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { escapeInvisible } from './invisible.mjs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleArgs } from './cli-args.mjs';

/**
 * The ceiling, and the ONLY place it is written.
 *
 * It was 4000 while the library was eight skills. Raising it to 5000 for the
 * six protocol skills is an OWNER decision, recorded in the changelog — which
 * is the whole difference between this and the failure the README cites
 * (oh-my-claudecode #2943, where the budget was exceeded rather than moved).
 * An agent proposes a raise; it does not perform one.
 *
 * Exported so a test can pin it. Until this change the number lived here AND
 * in `.github/workflows/ci.yml` as `--budget 4000`, which is the hand-copied
 * constant `prompt-tuning` rule 7 calls a future lie: raising one leaves the
 * other enforcing the old value, and the CI failure names a budget that no
 * longer exists anywhere in the repo. The workflow now invokes the script
 * bare, exactly as `CONTRIBUTING.md` already did.
 */
export const DEFAULT_BUDGET = 5000;

export function parseFrontmatterDescription(markdown) {
  // Frontmatter = first block delimited by lines that are exactly `---`.
  const lines = markdown.split('\n');
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end === -1) return null;
  const fm = lines.slice(1, end);
  const idx = fm.findIndex((l) => /^description:/.test(l));
  if (idx === -1) return null;
  // Single-line value (possibly quoted) + YAML folded/literal continuation lines.
  let value = fm[idx].replace(/^description:\s*/, '');
  if (/^[>|][+-]?\s*$/.test(value.trim())) {
    value = '';
    for (let i = idx + 1; i < fm.length; i++) {
      if (/^\s+\S/.test(fm[i])) value += fm[i].trim() + ' ';
      else break;
    }
  }
  return value.replace(/^["']|["']$/g, '').trim();
}

export function collectSkillDescriptions(pluginRoot) {
  const skillsDir = join(pluginRoot, 'skills');
  if (!existsSync(skillsDir)) return [];
  const out = [];
  for (const entry of readdirSync(skillsDir)) {
    const skillMd = join(skillsDir, entry, 'SKILL.md');
    if (statSync(join(skillsDir, entry)).isDirectory() && existsSync(skillMd)) {
      const description = parseFrontmatterDescription(readFileSync(skillMd, 'utf8'));
      out.push({ skill: entry, length: description ? description.length : 0, missing: description === null });
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

export const DESC_BUDGET_USAGE =
  'usage: desc-budget.mjs [--budget <chars>] [pluginRoot]\n' +
  'Exit: 0 within budget · 1 over budget · 2 usage/IO error';

function main() {
  const args = process.argv.slice(2);
  if (!handleArgs(args, { name: 'desc-budget', usage: DESC_BUDGET_USAGE, known: ['budget'] })) return;
  let budget = DEFAULT_BUDGET;
  const bi = args.indexOf('--budget');
  if (bi !== -1) {
    budget = Number(args[bi + 1]);
    if (!Number.isFinite(budget) || budget <= 0) {
      console.error('desc-budget: --budget must be a positive number');
      process.exit(2);
    }
    args.splice(bi, 2);
  }
  const root = resolve(args[0] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));

  const rows = collectSkillDescriptions(root);
  const missing = rows.filter((r) => r.missing);
  const total = rows.reduce((s, r) => s + r.length, 0);

  for (const r of rows) {
    // A skill directory name is attacker-controlled the moment a repo
    // installs a third-party skill, and this line runs in CI where the output
    // is read by whoever is debugging the build.
    console.log(`${String(r.length).padStart(6)}  ${escapeInvisible(r.skill)}${r.missing ? '  (MISSING description)' : ''}`);
  }
  console.log(`${String(total).padStart(6)}  TOTAL (budget: ${budget})`);

  if (missing.length > 0) {
    console.error(`desc-budget: ${missing.length} skill(s) missing a description — every skill must declare one`);
    process.exit(1);
  }
  if (total > budget) {
    console.error(`desc-budget: total ${total} exceeds budget ${budget}. Trim descriptions or remove skills.`);
    process.exit(1);
  }
}

/**
 * Absolute, symlink-resolved path; falls back to the merely absolute form when
 * realpath cannot follow argv[1] (the script directory was renamed after
 * launch, a parent component is unreadable, or a launcher rewrote argv[1] to a
 * logical name). Without the fallback the guard would throw out of module
 * scope and kill the tool at startup — a different bug, not a fix.
 */
function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * True when this module is the program's entry point.
 *
 * BOTH sides must be canonicalized. `import.meta.url` already names the real
 * file — Node resolves module specifiers through symlinks — while
 * `process.argv[1]` is whatever the caller typed. Comparing them raw turned
 * every invocation through a symlinked path into a SILENT no-op under exit 0:
 * `main()` never ran, nothing was summed, and CI read that as "within budget".
 * `/tmp` and `/var` are symlinks on macOS and plugin installs reach `scripts/`
 * through one, so this is the ordinary case rather than an exotic one.
 */
function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) main();
