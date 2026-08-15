#!/usr/bin/env node
/**
 * publish — turn the archival renders in video/out into the web deliverables
 * committed at assets/video.
 *
 * Why re-encode at all: `hyperframes render --quality high` targets a master,
 * not a download. The six-second Direction B sting leaves the renderer at
 * 12 Mbit/s because film grain defeats inter-frame prediction; at CRF 24 the
 * same six seconds is 1 MB and no viewer can tell. Over the slate this is the
 * difference between 143 MB in git forever and roughly 25 MB — which is also
 * the difference between needing Git LFS and not. LFS was considered and
 * rejected: `claude plugin install` clones this repo, and a clone without
 * `git lfs` installed gets pointer files where the videos should be.
 *
 * The masters stay in video/out (gitignored). They are what goes to YouTube;
 * re-encoding an already-encoded file for upload only compounds loss.
 *
 * CRF is per-clip because the content differs in kind: flat UI motion holds up
 * at 26, generated art plates need 24 to keep the grain from turning blocky.
 *
 * Poster frames are pulled at a hand-picked second — the first frame of most
 * of these compositions is deliberately near-black, which makes a useless
 * thumbnail.
 *
 * Usage: node pipeline/publish.mjs [--only <id>]
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync, readdirSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'out');
const DEST = resolve(HERE, '..', '..', 'assets', 'video');

/** crf: quality. poster: second to grab the thumbnail from, null = no poster. */
const SLATE = [
  { id: 'a-explainer-16x9', crf: 26, poster: 19.5 },
  { id: 'a-onboarding-16x9', crf: 26, poster: 12.0 },
  { id: 'a-mistake-9x16', crf: 26, poster: 6.0 },
  { id: 'a-board-9x16', crf: 26, poster: 21.0 },
  { id: 'a-retro-9x16', crf: 26, poster: 30.0 },
  { id: 'a-readme-16x9', crf: 25, poster: 8.0 },
  { id: 'a-sting-16x9', crf: 24, poster: 4.5 },
  { id: 'a-sting-9x16', crf: 24, poster: 4.5 },
  { id: 'b-sting-16x9', crf: 24, poster: 4.5 },
  { id: 'b-sting-9x16', crf: 24, poster: 4.5 },
];

const SRT = ['explainer', 'onboarding', 'mistake', 'board', 'retro'];

const mb = (p) => (statSync(p).size / 1024 / 1024).toFixed(1);

function hasAudio(src) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', src],
    { encoding: 'utf8' },
  );
  return out.trim().length > 0;
}

function encode({ id, crf, poster }) {
  const src = join(OUT, `${id}.mp4`);
  const dst = join(DEST, `${id}.mp4`);
  const args = [
    '-v', 'error', '-y', '-i', src,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
    '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.0',
    // faststart moves the moov atom to the front so a <video> element can
    // begin playing before the whole file has arrived.
    '-movflags', '+faststart',
  ];
  if (hasAudio(src)) args.push('-c:a', 'aac', '-b:a', '112k', '-ac', '1');
  else args.push('-an');
  args.push(dst);
  execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });

  if (poster != null) {
    execFileSync(
      'ffmpeg',
      ['-v', 'error', '-y', '-ss', String(poster), '-i', src, '-frames:v', '1',
       '-q:v', '4', join(DEST, `${id}.jpg`)],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
  }
  return { id, from: mb(src), to: mb(dst) };
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1]
  : null;

mkdirSync(DEST, { recursive: true });

let before = 0;
let after = 0;
for (const clip of SLATE) {
  if (only && clip.id !== only) continue;
  const r = encode(clip);
  before += Number(r.from);
  after += Number(r.to);
  console.log(`${r.id.padEnd(20)} ${r.from.padStart(6)} MB -> ${r.to.padStart(6)} MB`);
}

// Only the posters and the caption sidecars are committed. The encoded MP4s
// above stay local: nothing in the README or the docs references them (both
// link to YouTube), and Tyran's own secrets gate refuses a commit whose payload
// it cannot scan inside 4 MiB — which the videos alone exceeded.
if (!only) {
  for (const s of SRT) copyFileSync(join(OUT, `${s}.srt`), join(DEST, `${s}.srt`));
}

const total = readdirSync(DEST).reduce((n, f) => n + statSync(join(DEST, f)).size, 0);
console.log(`\nmasters ${before.toFixed(1)} MB -> web ${after.toFixed(1)} MB`);
console.log(`assets/video total (incl. posters, gif, srt): ${(total / 1024 / 1024).toFixed(1)} MB`);
