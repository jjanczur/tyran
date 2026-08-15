#!/usr/bin/env node
/**
 * youtube-masters — re-render the slate at upload quality.
 *
 * Not a re-encode. The archival renders in video/out sit around 1.4 Mbit/s,
 * which is below YouTube's own recommendation for 1080p SDR (8 Mbit/s) — and
 * YouTube re-encodes whatever it is given, so handing it a 1.4 Mbit/s file
 * compounds two lossy passes on exactly the content that suffers most from it:
 * small mono type on a near-black ground, where blocking shows first.
 *
 * Re-encoding the existing master upward cannot help; the information is
 * already gone. So this renders again from the composition at CRF 14, which is
 * visually lossless for flat UI motion and still well under the practical
 * upload ceiling.
 *
 * Output goes to video/out/youtube so the web encodes in video/out keep their
 * inputs and nothing overwrites a master already reviewed.
 *
 * Usage: node pipeline/youtube-masters.mjs [id ...]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = resolve(HERE, '..', 'projects');
const DEST = resolve(HERE, '..', 'out', 'youtube');

// The five spoken cuts are the ones that get uploaded. The stings are six
// seconds of branding and the README loop is silent — neither is a video
// anybody subscribes to, and both are already in the repo.
const SLATE = [
  'a-explainer-16x9',
  'a-onboarding-16x9',
  'a-mistake-9x16',
  'a-board-9x16',
  'a-retro-9x16',
];

const CRF = '14';
const want = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const ids = want.length ? want : SLATE;

mkdirSync(DEST, { recursive: true });

for (const id of ids) {
  const out = join(DEST, `${id}.mp4`);
  process.stdout.write(`${id} ... `);
  const started = process.hrtime.bigint();
  execFileSync(
    'npx',
    ['hyperframes', 'render', '--quality', 'high', '--crf', CRF, '-o', out, '--quiet'],
    { cwd: join(PROJECTS, id), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const secs = Number(process.hrtime.bigint() - started) / 1e9;
  const size = (statSync(out).size / 1024 / 1024).toFixed(1);
  const probe = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=bit_rate', '-of', 'csv=p=0', out],
    { encoding: 'utf8' },
  ).trim();
  console.log(`${size} MB @ ${(Number(probe) / 1e6).toFixed(1)} Mbit/s (${secs.toFixed(0)}s)`);
}
