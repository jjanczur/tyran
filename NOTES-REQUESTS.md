# Open requests from the operator

Written down because they arrived mid-run and would otherwise live only in a
chat window — the exact failure this project exists to prevent. Newest first.
Delete an entry when it ships; move it to a ticket when it gets picked up.

## 1. Model fallback when a tier's limit is hit — NOT BUILT

**Observed live, 2026-08-14:** the `fable` tier hit its limit and subagents
**failed** instead of dropping to `opus` and respawning. The weekly window was
still available, so the work could have continued.

What is wanted: when the model behind a tier is exhausted, the spawn falls back
to the next available model rather than dying.

Notes before anyone builds this:

- `scripts/tiers.mjs` resolves a role to a tier to a model name from
  `.tyran/config.yaml`. It resolves; it does not retry. There is no fallback
  chain anywhere today.
- The failure surfaces INSIDE a subagent's API call, not in a hook, so the
  conductor sees a dead agent rather than a typed "limit" signal. Whatever is
  built has to distinguish "limit reached on this model" from every other
  failure, or it will silently re-run genuine errors on a more expensive model.
- Overnight mode already handles the SUBSCRIPTION window (pause, checkpoint,
  resume at reset). This is a different case: one tier is exhausted while the
  account still has budget, so the right move is substitution, not a pause.
- Open question for the operator: should a fallback be allowed to move work
  UP a tier (cheaper to more expensive) without asking? That spends more money
  than the routing table promised, which is exactly the property the tier table
  exists to make legible.

## 2. Config editing from the dashboard — DECIDED, not built

The operator decided (2026-08-14) that the comments in `.tyran/config.yaml` are
not worth preserving, because the dashboard can explain what each knob does at
the point of editing. So **`autonomy` and the whole config may be editable from
the dashboard**, not only the safe subset I proposed.

Also wanted: default agent settings, default models, per-role tier overrides.

Constraints that still hold:

- `yaml-lite` does not round-trip comments. Writing the file from a form
  deletes every comment in it. The operator accepts this; the dashboard must
  therefore carry the explanations the file used to carry.
- The write route needs the same treatment as `POST /answer`: `Host` pin
  (already there), an `Origin` check, and the initiative/field validated against
  a known list rather than trusted from the request body.
- `.tyran/policies/**` is KERNEL and must stay out of this. Editing `autonomy`
  in `config.yaml` is a privilege change; it should be visible in the journal
  as a `decision` event, not just a silent file write.

## 3. One dashboard per repo — NOT BUILT

When agents run in several repos, show one board per repo (a switcher beside
the tabs). `--serve` would take several `.tyran` directories.

Note: `cost.mjs` is per-repo by construction — the transcript directory is
derived from the repo path — so spend has to be computed per repo and summed,
not read once.

## 4. Ship regularly, do not leave dangling PRs

Standing instruction from the operator: merge to `main` over PRs proactively;
work parked in an open PR is wasted work. Check open PRs before finishing a
session.

## 5. Video with hyperframes + TTS — NOT ASSESSED

`https://github.com/heygen-com/hyperframes` plus an OpenAI TTS voiceover, to
produce short explainer videos and GIFs. I have **not** evaluated the tool and
should not pretend otherwise. The README GIF (`assets/board-demo.gif`) is
recorded from the real board and covers the immediate need.
