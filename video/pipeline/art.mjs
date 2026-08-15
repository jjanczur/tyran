/**
 * Direction B art plates — Nano Banana Pro (gemini-3-pro-image-preview).
 *
 * Every plate is generated WITH assets/banner.jpg attached as a style
 * reference. The banner is the only artwork this project has committed to and
 * the whole palette is read off it; generating blind would produce a second,
 * competing world. The reference is what keeps one.
 *
 * Every prompt ends with the same two clauses on purpose:
 *   - the negative list from BRIEF.md, so a plate cannot smuggle in the
 *     purple-blue AI-slop gradient the whole direction is defined against;
 *   - an explicit statement of where the NEGATIVE SPACE must be, because these
 *     are backplates that carry type, not illustrations to be admired.
 *
 * Usage:  node pipeline/art.mjs [name ...]      (default: all missing)
 *         node pipeline/art.mjs --force
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { need } from "./env.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const OUT = join(ROOT, "assets", "art");
mkdirSync(OUT, { recursive: true });

const API_KEY = need("GEMINI_API_KEY");
const MODEL = "gemini-3-pro-image-preview";
const BANNER = join(ROOT, "..", "assets", "banner.jpg");

const STYLE = `
STYLE REFERENCE: match the attached image exactly — its palette, its lighting and its world.
A subterranean Egyptian stone hall repurposed as a machine room. Warm near-black stone
(#12100e), carved hieroglyph walls, heavy columns. Two light sources only: warm GOLD
(#d4a017) from lamps, glyphs and energy, and COLD CYAN (#8fd8ea) spilling off computer
screens. Cinematic, volumetric haze, deep depth of field, photoreal 3D render quality.
`.trim();

const NEGATIVES = `
NEGATIVE: no purple or violet, no blue-to-pink gradients, no generic sci-fi neon, no lens
flares, no bokeh circles, no text, no letters, no numbers, no logos, no watermark, no UI
overlays, no human faces, no bright or daylight scene. Keep it dark, warm and restrained;
large areas must stay near-black.
`.trim();

const PLATES = [
  {
    name: "hall-wide-16x9",
    aspect: "16:9",
    prompt: `A wide, symmetrical view down the centre of the hall. Rows of identical robot
      operators seated at glowing terminals recede into haze on the left and right. The centre
      of the frame is an EMPTY stone floor and empty air — a clear corridor of darkness running
      from the bottom of the frame to the vanishing point. Camera at eye level.
      NEGATIVE SPACE: the central third of the image, top to bottom, must be almost black and
      free of detail — a title will sit there.`,
  },
  {
    name: "hall-wide-9x16",
    aspect: "9:16",
    prompt: `A tall vertical view of the hall. A single towering carved column dominates,
      with rows of glowing robot workstations receding at its base in the lower third. The upper
      half is dark stone, haze and a faint gold glow from unseen lamps.
      NEGATIVE SPACE: the upper half and the centre must be almost black — titles and captions
      will sit there.`,
  },
  {
    name: "conductor-16x9",
    aspect: "16:9",
    prompt: `The jackal-headed conductor from the reference, seen from behind and slightly
      below, standing at a raised stone console. Gold energy filaments run from the console out
      to unseen workstations in the haze ahead. We see its silhouette and the cyan screen-light
      rimming its shoulders. It occupies the RIGHT third of the frame.
      NEGATIVE SPACE: the left two thirds is deep haze and darkness.`,
  },
  {
    name: "conductor-9x16",
    aspect: "9:16",
    prompt: `The jackal-headed conductor from the reference, full body, standing in a vertical
      shaft of gold light in a dark stone hall, seen from the front but low-key and mostly in
      silhouette, cyan screen-glow rimming one side. It occupies the LOWER two thirds.
      NEGATIVE SPACE: the top third is dark stone and haze.`,
  },
  {
    name: "tiers-16x9",
    aspect: "16:9",
    prompt: `Four stone terraces at clearly different heights, receding upward into haze like a
      ziggurat seen from inside. On the lowest terrace many small identical robot workers at
      dim terminals; on each higher terrace progressively fewer and larger figures at brighter
      terminals; on the highest, a single figure at one intensely gold-lit console. Reads
      instantly as a hierarchy of four levels.
      NEGATIVE SPACE: the left half is haze and shadow.`,
  },
  {
    name: "tiers-1x1",
    aspect: "1:1",
    prompt: `Four stone terraces at clearly different heights stacked toward the top of the
      frame, like a ziggurat seen from inside. Many dim robot workers at the bottom level,
      progressively fewer and brighter figures above, one single gold-lit console at the top.
      Centred composition.
      NEGATIVE SPACE: generous dark stone margins on the left and right.`,
  },
  {
    name: "gate-9x16",
    aspect: "9:16",
    prompt: `A colossal sealed stone doorway carved with hieroglyphs, filling a tall vertical
      frame, lit from below by hard RED emergency light that rakes across the carvings. Two
      jackal statues flank it. The door is shut. Ominous, still, heavy — a refusal made
      architectural. Faint cyan glow leaks from the seam of the door.
      NEGATIVE SPACE: the upper third is dark stone above the doorway.`,
  },
  {
    name: "scales-16x9",
    aspect: "16:9",
    prompt: `An enormous ancient balance scale carved from stone and brass, standing alone in
      the dark hall, lit by cold cyan from one side and gold from the other. One pan holds a
      small glowing data-crystal; the other holds a single feather. The beam is tipped so the
      feather side is LOW. Shot from a low angle, monumental.
      NEGATIVE SPACE: the right third is empty dark haze.`,
  },
];

const bannerB64 = readFileSync(BANNER).toString("base64");
const argv = process.argv.slice(2);
const force = argv.includes("--force");
const only = argv.filter((a) => !a.startsWith("--"));

for (const plate of PLATES) {
  if (only.length && !only.includes(plate.name)) continue;
  const file = join(OUT, `${plate.name}.png`);
  if (existsSync(file) && !force) {
    console.log(`  ${plate.name.padEnd(18)} cached`);
    continue;
  }

  const prompt = `${STYLE}\n\nSCENE: ${plate.prompt.replace(/\s+/g, " ").trim()}\n\n${NEGATIVES}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [
              { inline_data: { mime_type: "image/jpeg", data: bannerB64 } },
              { text: prompt },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: plate.aspect, imageSize: "2K" },
        },
      }),
    }
  );

  if (!res.ok) {
    console.log(`  ${plate.name.padEnd(18)} FAILED ${res.status} ${(await res.text()).slice(0, 300)}`);
    continue;
  }
  const j = await res.json();
  const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData || p.inline_data);
  const data = part?.inlineData?.data || part?.inline_data?.data;
  if (!data) {
    console.log(`  ${plate.name.padEnd(18)} NO IMAGE  ${JSON.stringify(j).slice(0, 300)}`);
    continue;
  }
  writeFileSync(file, Buffer.from(data, "base64"));
  const kb = Math.round(readFileSync(file).length / 1024);
  console.log(`  ${plate.name.padEnd(18)} ${plate.aspect.padEnd(5)} ${String(kb).padStart(5)} KB  ${file}`);
}
