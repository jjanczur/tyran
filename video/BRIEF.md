# BRIEF — Tyran marketing video slate

The confirmed intent document. Every later step reads this.

## Message

**Tyran is an open-source orchestrator for Claude Code that saves tokens,
delivers better work, and gets better the more you use it.** One model for a
whole session is both the expensive choice and the worse one; Tyran routes each
role to a tier, keeps state in files instead of a chat window, refuses reports
that carry no evidence, and writes what it learned back into your repo.

## Audience

Developers who already use Claude Code (or Cursor / Codex) on a real codebase,
have felt a long session degrade, and have seen a bill. Senior enough to
distrust a marketing claim and to recognise a real terminal.

## Arc (shared spine, every cut is a subset)

**Recognition → Mechanism → Proof → Compounding → Landing**

## Mood

Warm stone and gold, cold screen-light. Confident and unhurried; a measurement
being read out, not a pitch. Never bright, never breathless.

## Decisions

| Field | Value |
|---|---|
| Mode | autonomous |
| Storyboard | yes — `storyboards/*.md`, reviewed before build |
| Directions | **A** proof-led brand-framed · **B** brand-first cinematic |
| Voice | OpenAI `gpt-4o-mini-tts`, `cedar`, steered by `instructions` |
| Captions | burned-in on every spoken cut + `.srt` sidecars |
| Music | Gemini Lyria, ducked under −18 dB, only on S1 |
| SFX | bundled library, cued to specific frames, never sprinkled |
| Claims | marketing latitude — copy written for impact, no sourcing requirement |
| Fonts | system stacks only, no web fonts (repo doctrine) |
| Theme | dark only, no light variant anywhere |

## Deliverables

| ID | Aspect | Length | Platform | Audio |
|---|---|---|---|---|
| `hero-95` | 1920×1080 | 95s | YouTube, site, LinkedIn | VO + BGM + SFX |
| `onboard-240` | 1920×1080 | 240s | YouTube tutorial | VO + SFX |
| `gates-45` | 1080×1920 | 45s | Shorts, TikTok | VO + SFX |
| `forgot-28` | 1080×1920 | 28s | TikTok | VO + SFX |
| `tiers-55` | 1080×1080 + 1920×1080 | 55s | X | VO + SFX |
| `readme-18` | 1280×720 | 18s | GitHub README | **silent** |
| `sting-6` | 1920×1080 + 1080×1920 | 6s | reusable | SFX |

Direction A builds all seven. Direction B builds `hero`, `gates`, `forgot`,
`tiers`, `sting` — not the four-minute tutorial and not the silent README loop,
where cinematic treatment fights the job.

## Negative list — checked against every frame

No purple-blue AI gradients · no bokeh · no stock developers · no drop-shadow
cards · no light theme · no third accent colour (gold is the only accent; glow
is a light source; red is refusal; green is a ledger `+`) · no web fonts · no
browser chrome around the board · no infinite loops · no unseeded randomness ·
no frozen final frame.

## Callback motif

A single gold lash-stroke, planted early at low weight, completing in the
landing frame into the jackal lockup. Present in all seven.

## Assets on hand

- `assets/capture/hi-*.png` — the real board at 2240px content width, five tabs
  plus element crops. Captured off `site/dist/sandbox/index.html`, which is the
  real page rendered by `scripts/board.mjs`, not a mockup.
- `../assets/banner.jpg` — 1600×872, the only committed artwork; the source of
  the whole palette.
- Mark geometry from `site/src/components/landing/Logo.astro`.
- Refusal text, verbatim, from `site/src/components/landing/Gates.astro` and
  `docs/evidence-gate.md`.
