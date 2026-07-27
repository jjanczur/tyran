/**
 * How many skills and agents Tyran actually ships, counted at BUILD time.
 *
 * The hero used to carry `v2 — under construction, in public` and
 * `867 tests green at v0.1.0`. Both were true the day they were typed and
 * decayed afterwards — the suite had reached 873 while the page still said
 * 867, and the badge apologised for a state the project had left.
 *
 * This repository already has three guards for values of that shape (the
 * doc test counts, the quoted refusal text, the release link), and each one
 * catches drift AFTER it is written. Counting from the filesystem is the
 * strictly better move where it is available: there is no window in which
 * the page and the repo can disagree, so there is nothing for a guard to
 * catch. `readdirSync` runs while Astro builds the page, not in the browser.
 *
 * A skill is a DIRECTORY CONTAINING `SKILL.md`, not a directory. Claude Code
 * loads a skill by reading that file; a folder without one is invisible to
 * the platform, and counting it would inflate the number on the one page
 * whose whole argument is that claims decay. (Frontmatter validity is a
 * second question, and a stricter one — `tests/unit/agents.test.mjs` already
 * refuses a skill or agent whose frontmatter parses empty, which is the
 * failure mode that matters: it loads silently, as nothing.)
 */
import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

const skillsDir = join(ROOT, 'skills');
const agentsDir = join(ROOT, 'agents');

export const SKILLS = readdirSync(skillsDir, { withFileTypes: true }).filter(
  (e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')),
).length;

export const AGENTS = readdirSync(agentsDir).filter((f) => f.endsWith('.md')).length;
