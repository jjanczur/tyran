/**
 * Caption timing — word-level, in composition time.
 *
 * Transcribes each LINE's wav separately (short clips transcribe more
 * accurately than one long track) and offsets every word by that line's
 * measured `at`. The script text is passed as a `prompt` so the transcriber is
 * biased toward the words we actually synthesized rather than its own guess at
 * them — we are timing known text, not discovering unknown text.
 *
 * Produces, per video:
 *   assets/vo/<video>.captions.json   [{ w, s, e, line }] in composition time
 *   out/<video>.srt                   sidecar for YouTube
 *
 * Burned-in captions are built from the .captions.json inside each
 * composition; the .srt is the same data for platforms that render their own.
 *
 * Usage:  node pipeline/captions.mjs [videoId ...]
 */
import { readFileSync, writeFileSync, existsSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { need } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const VO_DIR = join(ROOT, "assets", "vo");
const OUT_DIR = join(ROOT, "out");

const API_KEY = need("OPENAI_API_KEY");
const manifest = JSON.parse(readFileSync(join(ROOT, "scripts", "vo.json"), "utf8"));

const only = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = Object.keys(manifest.videos).filter((v) => !only.length || only.includes(v));

/** Words per caption cue, the longest a cue may sit on screen, and the silence
 *  that always forces a break (a cue must never span a pause between lines). */
const MAX_WORDS = 6;
const MAX_CUE = 3.2;
const MAX_GAP = 0.5;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Whisper returns bare tokens with the punctuation stripped, so "forgot. Again."
 * comes back as "forgot Again" and every sentence break disappears. We already
 * know the words — we synthesized them — so take the TIMING from whisper and
 * the SPELLING and PUNCTUATION from the script, walking the two in step and
 * resyncing over the occasional mismatch.
 */
function reattachPunctuation(whisperWords, scriptText) {
  const script = scriptText.split(/\s+/).filter(Boolean);
  const out = [];
  let si = 0;
  let lastMatched = true;

  for (const ww of whisperWords) {
    const target = norm(ww.word);
    if (!target) continue;

    let hit = -1;
    for (let k = si; k < Math.min(si + 4, script.length); k++) {
      if (norm(script[k]) === target) {
        hit = k;
        break;
      }
    }
    if (hit === -1) {
      // Whisper heard something the script does not have — usually a
      // contraction ("doesn't" for "does not"). Keep its token so the
      // timeline stays complete, and remember that we are out of step.
      out.push({ w: ww.word, s: ww.start, e: ww.end });
      lastMatched = false;
      continue;
    }

    // Words skipped in the script are only "dropped by the transcriber" when
    // we were IN STEP. After a mismatch they are the expansion of the token we
    // just emitted — folding them in duplicates the phrase, which produced
    // "It doesn't does not land in the scrollback" on a finished cut.
    const skipped = lastMatched ? script.slice(si, hit).join(" ") : "";
    out.push({ w: (skipped ? skipped + " " : "") + script[hit], s: ww.start, e: ww.end });
    si = hit + 1;
    lastMatched = true;
  }
  return out;
}

async function wordsFor(file, promptText) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)]), "line.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  // Bias toward the text we synthesized. We are timing known words.
  form.append("prompt", promptText.slice(0, 880));

  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  return j.words || [];
}

/**
 * Whisper emits the occasional word whose start equals its end, and sometimes
 * a run of them, and occasionally a word that starts before the previous one
 * finished. All three break per-word highlighting (an invisible or flickering
 * word) and produce zero-length SRT cues.
 *
 * Fixed in two steps. First make the sequence monotonic. Then, within each
 * CUE, if any word is degenerate, redistribute that cue's words evenly across
 * the cue's own span — the cue boundary is the thing that has to be right, and
 * an even spread inside it reads better than a stutter followed by a hold.
 */
const MIN_WORD = 0.12;

function makeMonotonic(words) {
  for (let i = 1; i < words.length; i++) {
    if (words[i].s < words[i - 1].e) words[i].s = words[i - 1].e;
    if (words[i].e < words[i].s) words[i].e = words[i].s;
  }
  return words;
}

function redistributeDegenerateCues(cueGroups) {
  for (const g of cueGroups) {
    if (!g.some((w) => w.e - w.s < MIN_WORD)) continue;
    const start = g[0].s;
    const end = Math.max(g[g.length - 1].e, start + MIN_WORD * g.length);
    const each = (end - start) / g.length;
    g.forEach((w, i) => {
      w.s = +(start + each * i).toFixed(3);
      w.e = +(start + each * (i + 1)).toFixed(3);
    });
  }
}

function srtTime(t) {
  const ms = Math.round(t * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const x = String(ms % 1000).padStart(3, "0");
  return `${h}:${m}:${s},${x}`;
}

/** Group words into cues: break on a sentence end, a word cap, a long cue, a
 *  silence, or a change of VO line. A cue never spans two lines. */
function toCues(words) {
  const cues = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    cur.push(w);
    const next = words[i + 1];
    const endsSentence = /[.!?—:]$/.test(w.w.trim());
    const tooMany = cur.length >= MAX_WORDS;
    const tooLong = w.e - cur[0].s >= MAX_CUE;
    const silence = next && next.s - w.e > MAX_GAP;
    const lineChange = next && next.line !== w.line;
    if (endsSentence || tooMany || tooLong || silence || lineChange || !next) {
      cues.push(cur);
      cur = [];
    }
  }
  if (cur.length) cues.push(cur);
  redistributeDegenerateCues(cues);

  const out = cues.map((g) => ({
    s: g[0].s,
    e: g[g.length - 1].e,
    text: g.map((x) => x.w).join(" ").replace(/\s+([,.;:!?])/g, "$1"),
  }));

  /* A short cue ("Again.") lands on a clipped word and would flash for a
     handful of frames. Hold it into the silence that follows — never into the
     next cue, and never past the caption's natural dwell. */
  const MIN_CUE = 0.55;
  for (let i = 0; i < out.length; i++) {
    if (out[i].e - out[i].s >= MIN_CUE) continue;
    const ceiling = i + 1 < out.length ? out[i + 1].s - 0.03 : out[i].s + MIN_CUE;
    out[i].e = +Math.max(out[i].e, Math.min(out[i].s + MIN_CUE, ceiling)).toFixed(3);
  }
  return out;
}

for (const videoId of targets) {
  const timingFile = join(VO_DIR, `${videoId}.timing.json`);
  if (!existsSync(timingFile)) {
    console.log(`${videoId}: no timing file — run pipeline/tts.mjs first`);
    continue;
  }
  const timing = JSON.parse(readFileSync(timingFile, "utf8"));

  const all = [];
  for (const line of timing.lines) {
    const wav = join(VO_DIR, videoId, `${line.id}.wav`);
    const raw = await wordsFor(wav, line.text);
    for (const w of reattachPunctuation(raw, line.text)) {
      all.push({
        w: w.w,
        s: +(line.at + w.s).toFixed(3),
        e: +(line.at + w.e).toFixed(3),
        line: line.id,
      });
    }
  }

  makeMonotonic(all);

  // toCues mutates `all` in place via redistributeDegenerateCues, so build the
  // cues BEFORE serialising the word list — burned-in captions and the .srt
  // must come from identical timings.
  const cues = toCues(all);

  writeFileSync(
    join(VO_DIR, `${videoId}.captions.json`),
    JSON.stringify({ video: videoId, total: timing.total, words: all, cues }, null, 0) + "\n"
  );
  const srt = cues
    .map((c, i) => `${i + 1}\n${srtTime(c.s)} --> ${srtTime(c.e)}\n${c.text}\n`)
    .join("\n");
  writeFileSync(join(OUT_DIR, `${videoId}.srt`), srt);

  console.log(
    `${videoId.padEnd(13)} ${String(all.length).padStart(4)} words · ${String(cues.length).padStart(3)} cues · ` +
      `last word ${all.length ? all[all.length - 1].e : 0}s → out/${videoId}.srt`
  );
}
