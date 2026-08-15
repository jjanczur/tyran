/**
 * Voice shootout — synthesize one representative passage across candidate
 * voices and model snapshots so the choice is made by ear rather than by
 * reading a docs page.
 *
 * The passage is deliberately the hardest thing in the slate: a hard consonant
 * opening, an em-dash pause, a file path, and a number. If a voice survives
 * this line it survives the whole script.
 *
 * Usage:  node pipeline/voice-test.mjs
 * Then:   open assets/vo/_voicetest/  (or `afplay` each file)
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { need } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets", "vo", "_voicetest");
mkdirSync(OUT, { recursive: true });

const API_KEY = need("OPENAI_API_KEY");

const PASSAGE =
  "It sizes the work, then hands each piece to a fresh agent on a tier matched to how hard that piece actually is. " +
  "Cheap for a mechanical sweep. The expensive tier reserved for the security boundary — on a floor nothing can cross.";

const INSTRUCTIONS =
  "Unhurried, dry, precise. A senior engineer reading a measurement out loud, not selling one. " +
  "Slight downward inflection to close each fact. Half a beat of pause before a number, a file path or a command. " +
  "Never bright, never breathless, no upsell lift at the end of a sentence. " +
  "Read terminal text, file paths and commands flat and clipped, slightly slower than the prose around them.";

/* marin and cedar are OpenAI's quality-tier voices; ash and onyx are the
   darker options if the read wants more authority; sage is the neutral
   control. */
const VOICES = ["cedar", "marin", "ash", "onyx", "sage"];
const MODELS = ["gpt-4o-mini-tts-2025-12-15", "gpt-4o-mini-tts-2025-03-20"];

function seconds(file) {
  return Number.parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
      encoding: "utf8",
    }).trim()
  ).toFixed(2);
}

for (const model of MODELS) {
  const tag = model.endsWith("12-15") ? "new" : "old";
  for (const voice of VOICES) {
    // The old snapshot only needs the control voice — this is an A/B on the
    // decoder, not a full second matrix.
    if (tag === "old" && voice !== "cedar" && voice !== "marin") continue;

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        voice,
        input: PASSAGE,
        instructions: INSTRUCTIONS,
        response_format: "wav",
      }),
    });
    if (!res.ok) {
      console.log(`  ${tag}/${voice.padEnd(6)} FAILED ${res.status} ${(await res.text()).slice(0, 160)}`);
      continue;
    }
    const file = join(OUT, `${tag}-${voice}.wav`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    console.log(`  ${tag}/${voice.padEnd(6)} ${seconds(file)}s  ${file}`);
  }
}

console.log(`\nListen:  afplay ${join(OUT, "new-cedar.wav")}`);
console.log(`Compare: for f in ${OUT}/*.wav; do echo "$f"; afplay "$f"; done`);
