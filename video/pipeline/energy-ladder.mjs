/**
 * Energy ladder — find the delivery level between "dry measurement" (too flat,
 * rejected) and "punchy product person" (too hot, rejected).
 *
 * Two voices the operator picked (Alnilam, Charon) across four descending
 * energy levels, on a line with both a claim and a warm turn in it.
 *
 * Every direction here is deliberately SHORT and plainly instructional.
 * A longer, more characterful brief triggers Gemini's non-configurable
 * PROHIBITED_CONTENT block on benign copy — measured, see scripts/vo.json.
 *
 * Usage: node pipeline/energy-ladder.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { need } from "./env.mjs";
import { synthesizeGemini } from "./tts-gemini.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets", "vo", "_ladder");
mkdirSync(OUT, { recursive: true });

const KEY = need("GEMINI_API_KEY");
const MODEL = "gemini-3.1-flash-tts-preview";

/* Two sentences: a flat statement, then a turn that wants a little warmth.
   A level that works on both is a level that works on the slate. */
const LINE =
  "You hand him the work, and he deploys the team. A principal engineer does not do scouting.";

const LEVELS = [
  { tag: "L1-lively", dir: "Speak with energy, briskly and clearly, landing the end of each sentence." },
  { tag: "L2-assured", dir: "Speak clearly at a natural pace, with quiet confidence and a little warmth." },
  { tag: "L3-calm", dir: "Speak calmly and evenly, at an unhurried natural pace, with quiet warmth." },
  { tag: "L4-flat", dir: "Speak plainly and evenly at a natural pace." },
];

const VOICES = ["Alnilam", "Charon"];

const secs = (f) =>
  Number.parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], {
      encoding: "utf8",
    }).trim()
  ).toFixed(2);

const made = [];
for (const level of LEVELS) {
  for (const voice of VOICES) {
    try {
      const wav = await synthesizeGemini({ model: MODEL, voice, text: LINE, direction: level.dir, apiKey: KEY });
      const name = `${level.tag}-${voice}`;
      const f = join(OUT, `${name}.wav`);
      writeFileSync(f, wav);
      made.push(name);
      console.log(`  ${name.padEnd(22)} ${secs(f)}s`);
    } catch (e) {
      console.log(`  ${level.tag}-${voice} FAILED ${String(e.message).slice(0, 90)}`);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

/* one reel, so the ladder can be heard in order instead of file by file */
const listFile = join(OUT, "_l.txt");
const sil = join(OUT, "_s.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", "0.9", "-c:a", "pcm_s16le", sil]);
writeFileSync(listFile, made.map((n) => `file '${n}.wav'\nfile '_s.wav'`).join("\n") + "\n");
const reel = join(HERE, "..", "assets", "vo", "_ENERGY-LADDER.wav");
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", listFile, "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", reel]);

console.log(`\norder in the reel:`);
made.forEach((n, i) => console.log(`  ${String(i + 1).padStart(2)}. ${n}`));
console.log(`\n  afplay ${reel}`);
