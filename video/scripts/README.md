# The scripts

Seven concepts, read as words. `vo.json` next to this file is the machine
source the TTS pipeline reads; this is the same content laid out to be read and
argued with.

**VO** is what the narrator says. **ON SCREEN** is what is drawn — and on the
silent-readable cuts (`tiers`, `readme`) every fact in the VO also exists on
screen, because X and GitHub autoplay muted.

Spoken text spells slash commands phonetically ("slash tyran setup") because
TTS reads punctuation literally; the real command is drawn on screen instead.

---

## S1 · `hero-95` — 95s · 16:9 · YouTube, site, LinkedIn

The whole argument, once.

| t | ON SCREEN | VO |
|---|---|---|
| 0.8 | Terminal: `tyran:implementer — final report` / `the tests pass`. The claim fades and sags. | "Every long session ends the same way." |
| 6.4 | Context meter climbing to 100%; four dashed chips — *the plan · what you already tried · why you ruled that out · the thing you explained twice* — lift away and vanish. | "The context fills up. The plan is somewhere in the scrollback. And 'the tests pass' is a sentence — not something you can check." |
| 16.2 | **The gold lash cracks across the frame.** Then: *Tyran is a conductor.* | "Tyran is a conductor." |
| 21.4 | Four tiers draw in, one per role. `top` lands and a gold rule seals under it: *a floor no cost profile and no risk flag can cross*. | "It sizes the work, then hands each piece to a fresh agent on a tier matched to how hard that piece actually is. Cheap for a mechanical sweep. The expensive tier reserved for the security boundary — on a floor nothing can cross." |
| 37.0 | Left: the agent's report, "everything is green". Right: the real refusal, in red. The frame washes red once. | "A report with no raw command output is refused. Not by a prompt. By a hook." |
| 47.5 | `journal.jsonl` lines append; five projection files fan out beneath them. | "Every decision, spawn and merge is appended to a journal committed to your repo. A restart, a compaction, and a colleague on another branch all read the same thing." |
| 60.0 | The real board, crawling slowly through frame. | "And it comes with a board. What every agent is doing right now, what is waiting on you, and what the work cost." |
| 72.5 | The ledger types in: three `+` lines, then one struck-through `−` line. | "After every initiative it writes what it learned back into your repo. A failure that repeats graduates into a rule. One that never earned a catch gets retired." |
| 84.5 | **The lash completes into the mark.** Install command, Apache-2.0, 0 runtime dependencies. | "Open source. Zero dependencies. The more you use it, the better it gets." |

---

## S2 · `onboard-240` — 4 min · 16:9 · YouTube tutorial

Chapter rail on screen throughout, because a tutorial has to say where you are.

**0:00 — the problem.** *"Every long Claude Code session ends the same way. The
context fills up, and the plan is somewhere in the scrollback."* → *"This is
Tyran. In the next four minutes: install it, point it at a repository, run
something real, and read the board."*

**0:17 — 01 Install.** *"Installing is two slash commands inside Claude
Code."* → *"Add the marketplace. Install the plugin. Then restart — hooks and
agents are read when a session starts, so an install you have not restarted
into is an install you are not running."* → *"Slash tyran hello is the smoke
test. If it answers, the plugin is installed and its paths resolve."*

**0:46 — 02 Setup.** *"Run setup once per repository. It reads how the repo is
actually worked — the stack, the validation commands, how things get deployed —
rather than asking you to describe it."* The `source:` line lights on its own
cue: *"Every value it infers carries the fact that produced it. This one reads:
git log, last fifty merges are pull requests, main is protected. Confidence,
nought point nine. It asks you only about what it could not establish."*

**1:19 — "Now the work."**

**1:22 — 03 Run.** *"Type slash tyran and describe what you want done. It
interviews you until the goal is unambiguous, sizes the task, and plans it."* →
*"Then it hands each piece to a dedicated subagent with fresh context, on a
model tier matched to how hard that piece is. They run in parallel."* → *"A
scout for reconnaissance. An implementer per story, each on its own branch. A
reviewer that has no editing tools at all — because a reviewer who can fix what
they found ends up approving their own patch."* → *"When an agent reports, a
hook reads it first. No raw command output, no report. It goes back and tries
again."* → *"Everything that happens is appended to a journal, committed to
your repository."*

**2:22 — 04 The board.** Four tabs, each with its own crawl. *"Five tabs,
because the page answers five questions. Overview: what is waiting on you, what
is running, and what needs a human."* → Board → Waiting on you → *"And Spend:
what the work cost, per model, per agent type, per ticket."*

**3:04 — 05 Overnight.** *"You can leave it running. At the usage limit Tyran
does not crash. It checkpoints, commits the state files, schedules a resume,
and stops. A watcher wakes at the window reset and carries on."* → *"Leave it
working and read the board in the morning."*

**3:30 — 06 The brake.** *"And you can hit the brake from anywhere without
killing the session. Write one line into a STOP file. It needs no session, so
it works from a phone at three in the morning."*

**3:46 — CTA.** *"Open source, Apache two. Zero runtime dependencies. The more
you use it, the better it gets."*

---

## S3 · `gates-45` — 45s · 9:16 · Shorts, TikTok

Hook lands by 1.2s. Three refusals, then the thesis.

| t | ON SCREEN | VO |
|---|---|---|
| 0.3 | *A prompt asks.* / *A hook refuses.* — the second half in red, punching in. | "A prompt asks. A hook refuses." |
| 4.5 | The agent's report claiming green. **REFUSED** stamps in above it; the evidence-gate text, verbatim. | "Your agent says the tests pass. Tyran does not take its word for it. No raw output, no report." |
| 15.5 | `rm -rf hooks/scripts/` → the policy gate refusing, naming the protected path. | "It classifies every write against a policy file you own — before it happens." |
| 26.5 | `git commit --no-verify` → the secrets gate refusing. *"A key is burned the moment it is published."* | "And a commit carrying a secret does not leave your machine." |
| 36.5 | *Mechanisms rather than instructions.* Mark, repo URL. | "Mechanisms rather than instructions. That is the whole argument." |

---

## S4 · `forgot-28` — 28s · 9:16 · TikTok

One idea: state lives in files. Nothing about tiers, nothing about gates.

| t | ON SCREEN | VO |
|---|---|---|
| 0.3 | `> explain the codebase again` types itself into a fresh session. | "Your agent forgot. Again." |
| 3.3 | Context meter redlines; four lines of scrollback fall out of frame. | "Everything it learned lived in a chat window. The window closed." |
| 9.3 | `journal.jsonl` lines append one at a time; `STATE.md`, `BOARD.md`, `board.json` pop out beneath. | "Tyran puts the state in files, committed to your repo. A restart reads the same thing you do." |
| 19.4 | Three real agent cards — ages green, amber, bold red. Then the mark. | "And every run leaves it fitting your repo better than the last." |

---

## S5 · `tiers-55` — 55s · 1:1 + 16:9 · X

Silent-readable throughout — X autoplays muted.

| t | ON SCREEN | VO |
|---|---|---|
| 0.4 | *One model for the whole session **is the bug**.* | "One model for the whole session is the bug." |
| 5.4 | Three rows, each tagged **TOP TIER**: `npm test`, `rename a variable`, `grep the changelog` — all `$$$$`. A gold strike runs through them. | "You are paying senior rates to run a test suite." |
| 16.3 | The four tiers stack in with their roles. A gold floor draws under `top`. | "Tyran routes every role to a tier. Cheap for a mechanical sweep. The expensive tier held for security review, arbitration and final acceptance — on a floor no cost profile can cross." |
| 34.4 | The `tiers:` block, four lines, in `.tyran/config.yaml`. | "Model names appear in exactly one file, so a deprecation is a one line edit." |
| 46.3 | *Cut your token bill without cutting the judgement.* Mark, repo, licence. | "Cut your token bill without cutting the judgement calls." |

---

## S6 · `readme-18` — 18s · 1280×720 · GitHub README · **silent**

No narration, no captions track — nothing to caption. Numbered labels carry it.

| t | ON SCREEN |
|---|---|
| 0.0 | `npx @jjanczur/tyran board --dir .tyran --serve` types itself; the echo `board: serving http://127.0.0.1:4173/` appears. |
| 3.2 | **01 Overview** — *what is waiting on you, and what is running.* The page crawls. |
| 7.1 | **02 Board** — *every ticket in exactly one of ten lanes.* |
| 11.0 | **03 Spend** — *per model, per agent type, per ticket.* |
| 14.9 | The mark, breathing into the loop point. |

---

## S7 · `sting-6` — 6s · 16:9 + 9:16 · reusable intro/outro

No VO. One low brass hit at the resolve.

The gold lash draws across the frame, whips, retracts, and its tail resolves
into the jackal head. The mark's own lash follows one beat behind the head —
follow-through, not simultaneity. Wordmark, hairline rule, then *the more you
use it, the better it gets.* Ambient drift to the end; it never freezes.
