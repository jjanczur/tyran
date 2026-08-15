/**
 * Gemini TTS provider.
 *
 * Gemini returns RAW PCM — signed 16-bit little-endian, 24 kHz, mono — not a
 * container. It has to be wrapped in a WAV header before ffmpeg or Hyperframes
 * will touch it, which is the one non-obvious part of this path.
 *
 * Style is controlled by prefixing the text with a natural-language direction
 * ("Read this in a dry, unhurried voice: ..."). That prefix is spoken-as-
 * direction, not read aloud — but it MUST be separated from the content or the
 * model occasionally reads it, so it ends with a colon and a newline.
 *
 * Exported for pipeline/tts.mjs; runnable directly as a shootout.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { need } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Wrap raw PCM s16le in a RIFF/WAVE header. */
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bits = 16 } = {}) {
  const byteRate = (sampleRate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Gemini reports the rate in a mime type like `audio/L16;codec=pcm;rate=24000`. */
function rateFromMime(mime) {
  const m = /rate=(\d+)/.exec(mime || "");
  return m ? Number(m[1]) : 24000;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The TTS preview models return an occasional 400 INVALID_ARGUMENT on input
 * they accept perfectly well on the next attempt — measured here on a
 * six-word line with no unusual characters in it. It is transient, not a
 * content problem, so retry rather than "fixing" text that was never broken.
 */
export async function synthesizeGemini({ model, voice, text, direction, apiKey, attempts = 8 }) {
  /**
   * Direction and content go in SEPARATE parts, never concatenated into one
   * string. Concatenated, the model reads content that looks like an
   * instruction as an instruction and rejects the whole request with a bare
   * 400 INVALID_ARGUMENT — reproduced here on the line "Underneath all of it,
   * hooks. Not prompts.", which fails glued to a direction and succeeds
   * without one. Two parts fixes it and is what the API's shape is for.
   */
  const parts = direction ? [{ text: direction }, { text }] : [{ text }];
  let lastErr;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts }],
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
            },
          }),
        }
      );

      if (!res.ok) throw new Error(`gemini tts ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
      const inline = part?.inlineData || part?.inline_data;
      if (!inline?.data) throw new Error(`gemini tts: no audio in response`);

      return pcmToWav(Buffer.from(inline.data, "base64"), {
        sampleRate: rateFromMime(inline.mimeType || inline.mime_type),
      });
    } catch (e) {
      lastErr = e;
      // Exponential-ish: the transient 400s cluster when requests are fired
      // back to back, so later attempts need real distance, not a token pause.
      if (attempt < attempts) await sleep(Math.min(8000, 900 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

/* ---------------------------------------------------------------- shootout */

if (import.meta.url === `file://${process.argv[1]}`) {
  const OUT = join(HERE, "..", "assets", "vo", "_voicetest2");
  mkdirSync(OUT, { recursive: true });

  const GEMINI = need("GEMINI_API_KEY");
  const OPENAI = need("OPENAI_API_KEY");

  /* The line the operator flagged as sounding worst — short, punchy, two hard
     stops. If a voice survives this it survives the slate. */
  const LINE =
    "Tyran puts the state in files, committed to your repo. A restart reads the same thing you do.";

  const DIRECTION =
    "Read the following in a calm, unhurried, dry voice — a senior engineer reading a measurement " +
    "out loud, not selling one. Natural pacing, no dramatic pauses, slight downward inflection to " +
    "close each sentence. Never bright or salesy.";

  const OPENAI_INSTR =
    "Unhurried, dry, precise. A senior engineer reading a measurement out loud, not selling one. " +
    "Natural pacing, no dramatic pauses. Slight downward inflection to close each fact. " +
    "Never bright, never breathless, no upsell lift at the end of a sentence.";

  /* Voices chosen from Gemini's roster for a dry technical read. */
  const GEMINI_MODELS = ["gemini-3.1-flash-tts-preview", "gemini-2.5-pro-preview-tts"];
  const GEMINI_VOICES = ["Charon", "Iapetus", "Rasalgethi", "Alnilam", "Schedar", "Orus"];

  function secs(f) {
    return Number.parseFloat(
      execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], {
        encoding: "utf8",
      }).trim()
    ).toFixed(2);
  }

  console.log("OpenAI (no speed parameter — the 1.05 time-stretch is what sounded synthetic):");
  for (const voice of ["cedar", "marin"]) {
    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: { Authorization: `Bearer ${OPENAI}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts-2025-12-15",
        voice,
        input: LINE,
        instructions: OPENAI_INSTR,
        response_format: "wav",
      }),
    });
    const f = join(OUT, `openai-${voice}.wav`);
    writeFileSync(f, Buffer.from(await res.arrayBuffer()));
    console.log(`  openai/${voice.padEnd(10)} ${secs(f)}s  ${f}`);
  }

  for (const model of GEMINI_MODELS) {
    const tag = model.includes("3.1") ? "g31" : "g25pro";
    console.log(`\n${model}:`);
    for (const voice of GEMINI_VOICES) {
      try {
        const wav = await synthesizeGemini({ model, voice, text: LINE, direction: DIRECTION, apiKey: GEMINI });
        const f = join(OUT, `${tag}-${voice}.wav`);
        writeFileSync(f, wav);
        console.log(`  ${tag}/${voice.padEnd(12)} ${secs(f)}s  ${f}`);
      } catch (e) {
        console.log(`  ${tag}/${voice.padEnd(12)} FAILED ${String(e.message).slice(0, 120)}`);
      }
    }
  }

  console.log(`\nCompare:  for f in ${OUT}/*.wav; do echo "$f"; afplay "$f"; done`);
}
