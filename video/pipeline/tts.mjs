/**
 * Voiceover generation.
 *
 * Two providers, chosen per-manifest:
 *   openai  — gpt-4o-mini-tts-*, steered by the `instructions` field
 *   gemini  — gemini-*-tts, steered by a natural-language direction prefix
 *
 * THREE THINGS THIS FILE GETS RIGHT THAT THE FIRST VERSION DID NOT:
 *
 * 1. NO `speed` PARAMETER, EVER. OpenAI's speed does a time-stretch on the
 *    rendered audio, and the artifact is audible — it is what made the 1.05x
 *    cuts sound synthetic next to the 1.0x ones. Pace is controlled by the
 *    delivery instruction instead, which changes how the model performs the
 *    line rather than resampling it afterwards.
 *
 * 2. TIMINGS ARE PACKED, NOT GUESSED. The old manifest hand-wrote an `at` for
 *    every line, which meant every gap was a guess against an unknown duration
 *    — and the guesses were far too generous (one cut ran 28s of speech in a
 *    55s slot). Now each line declares only the GAP that should follow it, and
 *    the layout is computed from measured audio. Dead air becomes a number you
 *    set, not a number you discover.
 *
 * 3. THE COMPOSITION LENGTH IS AN OUTPUT. `total` is computed from the packed
 *    layout and written into the timing file; the composition's data-duration
 *    is set to match.
 *
 * Produces, per video:
 *   assets/vo/<video>/<id>.wav     one file per line
 *   assets/vo/<video>.wav          the packed track
 *   assets/vo/<video>.timing.json  measured start/end per line, and the total
 *
 * Usage:  node pipeline/tts.mjs [videoId ...] [--force]
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { need, has } from "./env.mjs";
import { synthesizeGemini } from "./tts-gemini.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VO_DIR = join(ROOT, "assets", "vo");
const MANIFEST = join(ROOT, "scripts", "vo.json");

const argv = process.argv.slice(2);
const FORCE = argv.includes("--force");
const only = argv.filter((a) => !a.startsWith("--"));

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const PROVIDER = manifest.provider || "openai";

function duration(file) {
  return Number.parseFloat(
    execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], {
      encoding: "utf8",
    }).trim()
  );
}

/**
 * Trim the silence the TTS pads onto each clip.
 *
 * Both providers return a little dead air at the head and tail of every line.
 * Packed end to end that padding becomes invisible extra gap — and it hurts
 * SHORT lines worst, because the padding is roughly constant while the speech
 * is not. Measured across the slate before trimming: 103-132 words per minute,
 * against 158 for the same voice on one long isolated line. The gap between
 * those two numbers is entirely padding.
 *
 * Trimming here means the `gap` values in the manifest are the ONLY silence in
 * the finished track, which is the whole point of packing against measurement.
 */
function trimSilence(src, dst) {
  const gate =
    "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak," +
    "areverse," +
    "silenceremove=start_periods=1:start_duration=0:start_threshold=-45dB:detection=peak," +
    "areverse";
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", src, "-af", gate, "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", dst],
    { stdio: ["ignore", "ignore", "pipe"] }
  );
  return dst;
}

async function synthesize(text, outFile) {
  if (PROVIDER === "gemini") {
    const wav = await synthesizeGemini({
      model: manifest.model,
      voice: manifest.voice,
      text,
      direction: manifest.direction,
      apiKey: need("GEMINI_API_KEY"),
    });
    writeFileSync(outFile, wav);
    return;
  }

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${need("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: manifest.model,
      voice: manifest.voice,
      input: text,
      instructions: manifest.direction_openai || manifest.direction,
      response_format: "wav",
      // NO speed: see note 1 at the top of this file.
    }),
  });
  if (!res.ok) throw new Error(`TTS ${res.status} for ${outFile}: ${(await res.text()).slice(0, 400)}`);
  writeFileSync(outFile, Buffer.from(await res.arrayBuffer()));
}

/** Place each line at its computed start on one track, padded to `total`. */
function assemble(files, starts, total, outFile) {
  const args = [];
  for (const f of files) args.push("-i", f);
  const chains = files
    .map((_, i) => `[${i}:a]aresample=48000,adelay=${Math.round(starts[i] * 1000)}|${Math.round(starts[i] * 1000)}[a${i}]`)
    .join(";");
  const mixIn = files.map((_, i) => `[a${i}]`).join("");
  args.push(
    "-filter_complex",
    `${chains};${mixIn}amix=inputs=${files.length}:normalize=0:dropout_transition=0[m];[m]apad[out]`,
    "-map", "[out]", "-t", String(total),
    "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", "-y", outFile
  );
  execFileSync("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
}

const targets = Object.keys(manifest.videos).filter((v) => !only.length || only.includes(v));
if (!targets.length) {
  console.error(`no matching video ids. available: ${Object.keys(manifest.videos).join(", ")}`);
  process.exit(2);
}

console.log(`provider: ${PROVIDER} · model ${manifest.model} · voice ${manifest.voice}\n`);

for (const videoId of targets) {
  const cfg = manifest.videos[videoId];
  const dir = join(VO_DIR, videoId);
  mkdirSync(dir, { recursive: true });

  const lead = cfg.lead ?? 0.35;
  const tail = cfg.tail ?? 2.0;
  const defaultGap = cfg.gap ?? 0.5;

  console.log(`${videoId} · ${cfg.lines.length} lines · lead ${lead}s · gap ${defaultGap}s · tail ${tail}s`);

  const files = [];
  const starts = [];
  const timing = [];
  let cursor = lead;

  for (const line of cfg.lines) {
    const out = join(dir, `${line.id}.wav`);
    if (FORCE || !existsSync(out) || statSync(out).size === 0) {
      await synthesize(line.text, out);
      // Pace the calls. Fired back to back, the TTS preview endpoints start
      // returning transient 400s that retry alone does not clear.
      await new Promise((r) => setTimeout(r, 450));
    }

    /* Measure and pack the TRIMMED clip, never the padded original. */
    const trimmed = trimSilence(out, out.replace(/\.wav$/, ".trim.wav"));
    const dur = duration(trimmed);
    files.push(trimmed);
    starts.push(+cursor.toFixed(3));
    timing.push({
      id: line.id,
      at: +cursor.toFixed(3),
      end: +(cursor + dur).toFixed(3),
      dur: +dur.toFixed(3),
      text: line.text,
    });
    cursor += dur + (line.gapAfter ?? defaultGap);
  }

  const speech = timing.reduce((a, l) => a + l.dur, 0);
  const last = timing[timing.length - 1];
  const total = +(last.end + tail).toFixed(2);

  const track = join(VO_DIR, `${videoId}.wav`);
  assemble(files, starts, total, track);
  writeFileSync(
    join(VO_DIR, `${videoId}.timing.json`),
    JSON.stringify(
      { video: videoId, provider: PROVIDER, voice: manifest.voice, total, lines: timing },
      null,
      2
    ) + "\n"
  );

  const density = ((speech / total) * 100).toFixed(0);
  console.log(
    `  → ${total}s composition · ${speech.toFixed(1)}s speech (${density}% dense) · ` +
      `set data-duration="${total}"`
  );
}

console.log(`\nSet each composition's root data-duration to the total printed above.`);
