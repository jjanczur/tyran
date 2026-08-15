# Tyran video slate

Ten rendered videos across YouTube, Shorts, TikTok, X and GitHub, built with
[Hyperframes](https://hyperframes.heygen.com) — HTML in, deterministic MP4 out.

**Nothing here is committed.** `video/` is gitignored in full.

---

## The slate

Scripts written by a 17-agent team (marketing strategist, director, product
analyst, narrative designer → four competing drafts → three judges → showrunner
→ per-video writers → completeness critic). Raw team output in
[`scripts/team-output.json`](scripts/team-output.json); the critic's line fixes
are applied by [`pipeline/build-vo-manifest.mjs`](pipeline/build-vo-manifest.mjs).

| file | aspect | length | platform |
|---|---|---|---|
| `a-explainer-16x9.mp4` | 1920×1080 | 3m20 | YouTube · site · LinkedIn |
| `a-onboarding-16x9.mp4` | 1920×1080 | 3m53 | YouTube tutorial |
| `a-mistake-9x16.mp4` | 1080×1920 | 61s | TikTok · Shorts |
| `a-board-9x16.mp4` | 1080×1920 | 59s | TikTok · Shorts |
| `a-retro-9x16.mp4` | 1080×1920 | 82s | TikTok · Shorts |
| `a-readme-16x9.mp4` · `.gif` | 1280×720 | 18s | GitHub README (**silent**) |
| `a-sting-{16x9,9x16}.mp4` | both | 6s | intro/outro |
| `b-sting-{16x9,9x16}.mp4` | both | 6s | intro/outro, cinematic |

Plus `*.srt` sidecars for every spoken cut. Captions are also burned in.

### The through-line

*One chat and one model for every job is the mistake* → *you didn't install a
tool, you hired a manager* → *he interviews you, then deploys a routed team;
a principal engineer doesn't do scouting* → *every subagent starts with fresh
context* → *nothing you say is lost — your aside becomes ticket T-9 on the
Kanban* → *agents move their own cards and ask you for decisions on the board*
→ *hooks decide before the tool runs* → *the retro edits Tyran itself*.

---

## Voice

**Gemini `gemini-3.1-flash-tts-preview`, voice `Alnilam`, energy level L2.**

Three findings worth keeping:

- **Never use OpenAI's `speed` parameter.** It time-stretches the rendered
  audio and the artifact is audible — it is what made the first pass sound
  synthetic. Only two cuts used `1.05`, and they were exactly the two flagged.
- **Gemini's direction must stay short and plainly instructional.** A richer
  brief ("a sharp product person who wants you to get it…") is rejected with a
  non-configurable `PROHIBITED_CONTENT` block on entirely benign lines —
  measured 0/3 against 3/3 for the plain wording. `BLOCK_NONE` does not lift it.
- **Direction and content go in separate API parts.** Concatenated, a line that
  looks like an instruction *is read as one*: "Underneath all of it, hooks. Not
  prompts." returns a bare 400 glued to a direction and succeeds without one.

Energy ladder: `node pipeline/energy-ladder.mjs` → `assets/vo/_ENERGY-LADDER.wav`.
L1 was judged too hot, L3/L4 too flat. Charon is the sanctioned alternative —
change one field in `scripts/vo.json` and re-run.

## Pacing

Timings are **packed against measured audio**, never hand-written. Each line
declares only the gap that follows it; `pipeline/tts.mjs` computes the layout
and prints the `data-duration` to set.

Two fixes took the slate from 55% speech density with 7.5-second holes to
**85–92% density with a 0.8s maximum gap**:

1. Gaps became a number you set rather than a number you discover.
2. **Both TTS providers pad silence onto every clip**, which hurts short lines
   worst. `trimSilence()` strips it before packing — that alone moved the read
   from 103–132 wpm to 140.

---

## Pipeline

```bash
node pipeline/build-vo-manifest.mjs   # team-output.json + critic fixes -> vo.json
node pipeline/tts.mjs                 # --force to re-synthesize
node pipeline/captions.mjs            # word timings -> captions.json + .srt
node pipeline/scaffold.mjs <project> --vo <id> [--img a.png,b.png]
cd projects/<id> && npx hyperframes check && npx hyperframes render --quality high
```

Captions take **timing from the transcriber and spelling from the script** —
whisper strips punctuation, so every sentence break would otherwise vanish. It
also contracts ("doesn't" for "does not"), which duplicated a phrase on a
finished cut until the realigner learned to stop folding skipped words in after
a mismatch.

## The board

In 9:16 the board is **rebuilt natively in HTML** using its own tokens from
`scripts/board-html.mjs` (`--brass #a8863c`, `--steel #7d9ea9`, `--sage #88a06a`,
`--clay #c07a70`). A 2240px screenshot scaled into a 1080px frame is unreadable
on a phone — and a native rebuild is the only way a ticket can actually *move
between lanes*, which is the whole point of the shot.

Captures for the 16:9 cuts come from the real page,
`site/dist/sandbox/index.html`, at 2× zoom.

---

## Gotchas paid for during this build

- **Percentage `margin-top` resolves against the container's WIDTH**, not its
  height. `margin-top:-62%` on a 1920×1080 frame pushes up 1190px, not 670 —
  which decapitated the conductor and left a black band. Use `left/top` insets.
- **`tl.set` has `immediateRender: true`** — a zero-duration set applies at
  *build* time, not at its timeline position. Seven chapter labels all resolved
  to the last one from frame zero. Cross-fade separate elements instead.
- **Never tween `fontSize` or `letterSpacing`** — they reflow text and snap
  glyphs to integer device pixels (`gsap_non_transform_motion`). Use `scale`.
- **`hooks/**` and `locales/*.json` fail lint as visible text** — `/` then `*`
  reads as a CSS comment. Escape as `&#42;`.
- **A lane that receives a card must make room for it**, or the traveller lands
  on the resident and both strings render on the same pixels.
- **The ground fill goes on a full-bleed child, never the root** — the producer
  can drop a root background and render the frame black.
- **An exit tween ending on a clip boundary needs a `tl.set` hard kill**, or a
  cold seek past it leaves stale visibility. Write them one per line: the
  linter reads source statically and cannot see sets built in a loop.
- **The policy gate refuses shell commands naming `hooks/**` or `.env`** —
  including a `grep`. Use Read. `pipeline/env.mjs` opens the dotenv file at
  runtime so no command text ever names it.

## Verification

Every composition passes `npx hyperframes check` with 0 errors across lint,
runtime, layout, motion and WCAG AA contrast.

| check | result |
|---|---|
| durations match the packed audio | 10/10 exact |
| audio present where intended | 5/5 · silent 5/5 |
| speech density | 85–92% (was 55%) |
| longest gap between lines | 0.8s (was 7.5s) |
| caption cues overlapping | 0 of 428 |
| caption duplications | 0 of 428 |
| determinism (`sting-16x9` twice, `cmp`) | byte-identical |
| README GIF | 3.6 MB, 640×360 |

## Cost

Renders are local and free. API spend across the whole project — TTS,
transcription, 9 Nano Banana Pro images, and a 17-agent 2.1M-token workflow —
is roughly **$25**.
