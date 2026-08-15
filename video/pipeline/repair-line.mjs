#!/usr/bin/env node
/**
 * repair-line — re-speak ONE line of an already-packed video without moving
 * anything else.
 *
 * The normal path (delete the wav, re-run tts.mjs) repacks the whole track:
 * the corrected line is a different length, every later line starts somewhere
 * new, and the clip timings baked into the composition no longer match. For a
 * one-word repair that is a rebuild of the entire cut.
 *
 * So this pads the corrected line back to the ORIGINAL line's exact duration.
 * The packer then measures what it measured before, computes the same starts,
 * and the composition is still correct — only the audio inside that one slot
 * has changed. It works only when the new reading is SHORTER than the old one,
 * which it refuses to guess about.
 *
 * Usage: node pipeline/repair-line.mjs <videoId> <lineId>
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeGemini } from './tts-gemini.mjs';
import { need } from './env.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VO = join(ROOT, 'assets', 'vo');

const [videoId, lineId] = process.argv.slice(2);
if (!videoId || !lineId) {
  console.error('usage: repair-line.mjs <videoId> <lineId>');
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts', 'vo.json'), 'utf8'));
const video = manifest.videos[videoId];
const line = video.lines.find((l) => l.id === lineId);
if (!line) {
  console.error(`no line ${lineId} in ${videoId}`);
  process.exit(2);
}

const target = join(VO, videoId, `${lineId}.wav`);
if (!existsSync(target)) {
  console.error(`${target} does not exist — nothing to repair`);
  process.exit(2);
}

const seconds = (f) =>
  Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f],
      { encoding: 'utf8' },
    ).trim(),
  );

const original = seconds(target);
copyFileSync(target, `${target}.bak`);

const raw = join(VO, videoId, `${lineId}.raw.wav`);
const audio = await synthesizeGemini({
  model: manifest.model,
  voice: manifest.voice,
  text: line.text,
  direction: manifest.direction,
  apiKey: need('GEMINI_API_KEY'),
});
writeFileSync(raw, audio);

// Same gate tts.mjs uses: both providers pad silence onto every clip, and the
// pack is computed against trimmed audio.
const trimmed = join(VO, videoId, `${lineId}.trim.wav`);
execFileSync('ffmpeg', [
  '-v', 'error', '-y', '-i', raw, '-af',
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,areverse,' +
  'silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak,areverse',
  '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', trimmed,
]);

const fresh = seconds(trimmed);
if (fresh > original) {
  console.error(
    `refusing: new reading is ${fresh.toFixed(2)}s, original slot is ${original.toFixed(2)}s.\n` +
    'A longer line cannot be padded into the same slot — repack and re-render instead.',
  );
  process.exit(1);
}

// Pad the tail back to the original length so the packer measures no change.
execFileSync('ffmpeg', [
  '-v', 'error', '-y', '-i', trimmed,
  '-af', `apad=whole_dur=${original}`,
  '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', target,
]);

console.log(`${lineId}: ${fresh.toFixed(2)}s speech padded to ${seconds(target).toFixed(2)}s (was ${original.toFixed(2)}s)`);
console.log(`text: ${line.text}`);
console.log('\nnow re-run:  node pipeline/tts.mjs ' + videoId + '   (reassembles the track, regenerates nothing)');
