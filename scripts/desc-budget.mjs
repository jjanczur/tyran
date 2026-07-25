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
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_BUDGET = 4000;

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

function main() {
  const args = process.argv.slice(2);
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
    console.log(`${String(r.length).padStart(6)}  ${r.skill}${r.missing ? '  (MISSING description)' : ''}`);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
