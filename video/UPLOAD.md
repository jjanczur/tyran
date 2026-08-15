# YouTube upload sheet

Copy-paste ready. **Upload the files in `out/youtube/`**, not `out/` and not
`assets/video/` — `out/youtube/` is re-rendered from the compositions at CRF 14
(roughly 8-12 Mbit/s) because YouTube re-encodes whatever it receives, and
handing it the 1.4 Mbit/s archival render stacks two lossy passes on small mono
type over near-black, which is exactly where blocking shows first.

Every description ends with the same link block. Both links are load-bearing:
the repo is where the plugin is installed from, the site is where the docs and
the clickable board live.

- Repo — https://github.com/jjanczur/tyran
- Docs — https://jjanczur.github.io/tyran/
- Live board (no install) — https://jjanczur.github.io/tyran/sandbox/

Captions: upload the matching `.srt` from `out/` as an English subtitle track.
The videos already carry burned-in captions, so the SRT is for search and for
viewers who use YouTube's own caption UI — not for legibility.

Thumbnails: `assets/video/<id>.jpg` is a frame pulled from the cut. Good enough
to publish; a designed thumbnail would beat it.

---

## 1 · Explainer — the main channel video

| | |
|---|---|
| file | `out/youtube/a-explainer-16x9.mp4` |
| length | 3:20 · 1920×1080 |
| captions | `out/explainer.srt` |
| thumbnail | `assets/video/a-explainer-16x9.jpg` |
| visibility | Public. This is the one to pin to the channel. |

**Title**

```
You Didn't Install a Tool — You Hired a Manager | Tyran for Claude Code
```

**Description**

```
Your most expensive model just renamed a variable. In the same chat, it judged
an authentication boundary. One chat, one model, every job — that is why the
bill is high and the work gets worse.

Tyran is a task conductor for Claude Code. You brief one manager. He interviews
you, turns the plan into tickets on a live Kanban board, and hands each piece to
a fresh agent on a tier matched to how hard that piece actually is. A scout
reads the repo on the cheap tier. Implementers take one story each on their own
branch, with an empty scrollback. The reviewer has no editing tools at all.

Everything you see on the board in this video is real: the tickets moved
themselves, the spend is the actual bill broken out by role, and the run shown
is Tyran building Tyran.

Open source, Apache-2.0. Zero runtime dependencies.

Install (inside Claude Code):
  /plugin marketplace add jjanczur/tyran
  /plugin install tyran@tyran
  /tyran:setup

Repo — https://github.com/jjanczur/tyran
Docs — https://jjanczur.github.io/tyran/
Click the board yourself, nothing to install — https://jjanczur.github.io/tyran/sandbox/

Chapters
0:00 One chat, one model, every job
0:16 You hired a manager
0:24 He interviews you, then stops asking
0:35 The team goes out: scout, implementers, reviewer
1:02 Routing roles to tiers — and the floor that can't be lowered
1:16 The board: five agents running, two questions waiting
1:31 Your aside becomes ticket T-9
1:49 The bill, broken out by role
2:12 Hooks decide before the tool runs
2:38 The retro it runs on itself
3:10 Install

#ClaudeCode #AIAgents #OpenSource #DeveloperTools #AICoding
```

---

## 2 · Onboarding — the tutorial

| | |
|---|---|
| file | `out/youtube/a-onboarding-16x9.mp4` |
| length | 3:53 · 1920×1080 |
| captions | `out/onboarding.srt` |
| thumbnail | `assets/video/a-onboarding-16x9.jpg` |
| visibility | Public. Link it from the explainer's end screen. |

**Title**

```
Tyran Setup: Your First Session — Install, Run, Read the Board (Claude Code)
```

**Description**

```
The whole first session, start to finish: install it, set it up on a real
repository, run something, read the board, answer a question from the board,
and see what the retrospective did afterwards.

One idea to hold on to — Tyran is a manager for a team of agents, and you stay
the stakeholder.

Every command appears on screen exactly as it is typed. Requires Claude Code 2.1
and Node for the board.

Install (inside Claude Code):
  /plugin marketplace add jjanczur/tyran
  /plugin install tyran@tyran
  /tyran:hello        <- smoke test
  /tyran:setup        <- once per repository

Repo — https://github.com/jjanczur/tyran
Docs — https://jjanczur.github.io/tyran/
Getting started — https://jjanczur.github.io/tyran/getting-started/
Live board, nothing to install — https://jjanczur.github.io/tyran/sandbox/

Chapters
0:00 What this covers
0:16 Install — two slash commands, then restart
0:34 /tyran:setup and the provenance it records
0:57 Commit .tyran/ (worktrees carry no untracked files)
1:05 Brief the manager — at most four questions
1:20 The team: scout, implementers, reviewer
1:43 Open the board
1:49 Overview — is anything on fire?
2:00 The Board tab, ten lanes, and ticket T-9
2:24 Answering a question from the board
2:33 Spend — by model, by agent, by ticket
2:54 The two hooks that refuse
3:13 The retro, and the 3-to-knowledge / 5-to-law ladder
3:40 The STOP file

#ClaudeCode #AIAgents #Tutorial #OpenSource #DeveloperTools
```

---

## 3 · Short — the mistake

| | |
|---|---|
| file | `out/youtube/a-mistake-9x16.mp4` |
| length | 1:01 · 1080×1920 · **Short** |
| captions | `out/mistake.srt` |
| thumbnail | `assets/video/a-mistake-9x16.jpg` |

**Title**

```
One chat. One model. Every job. That's the mistake. #Shorts
```

**Description**

```
No good team puts a principal engineer on a grep — but that is what one chat and
one model does to every task you hand it.

Tyran is a task conductor for Claude Code: a manager who routes each piece of
work to its own agent at its own tier, each starting with a clean context.
Security review always gets the strongest tier and no setting can lower it.

Open source — https://github.com/jjanczur/tyran
Docs — https://jjanczur.github.io/tyran/
Live board — https://jjanczur.github.io/tyran/sandbox/

#Shorts #ClaudeCode #AIAgents #OpenSource #AICoding
```

---

## 4 · Short — the board

| | |
|---|---|
| file | `out/youtube/a-board-9x16.mp4` |
| length | 0:59 · 1080×1920 · **Short** |
| captions | `out/board.srt` |
| thumbnail | `assets/video/a-board-9x16.jpg` |

The most shareable of the three. If you only post one Short, post this one.

**Title**

```
Your AI agents have a Kanban board now — and they move their own tickets #Shorts
```

**Description**

```
Ten lanes. Every ticket in exactly one. Blocked cards say how long they have
stood still. Say something halfway through a run and it does not land in the
scrollback — it becomes a ticket, written into the journal.

Agents move their own cards. The board in this video is Tyran building Tyran.

Click the board yourself, nothing to install:
https://jjanczur.github.io/tyran/sandbox/

Open source — https://github.com/jjanczur/tyran
Docs — https://jjanczur.github.io/tyran/

#Shorts #ClaudeCode #AIAgents #Kanban #OpenSource
```

---

## 5 · Short — the retro

| | |
|---|---|
| file | `out/youtube/a-retro-9x16.mp4` |
| length | 1:22 · 1080×1920 · **Short** |
| captions | `out/retro.srt` |
| thumbnail | `assets/video/a-retro-9x16.jpg` |

**Title**

```
This AI agent team runs a retro on itself — and usually changes nothing #Shorts
```

**Description**

```
Every ticket merged. You close the session. It refuses — once.

The retrospective reads the record: the ledger, the reports, the git history. A
question it asked you three times gets edited out of its own instructions. A
request you made three times becomes a skill. A rule that never helped is
deleted. Most candidates are rejected, because changing nothing is a correct
outcome.

The same failure three times becomes knowledge, pasted into every matching
handoff. Five times, and it becomes a rule in your CLAUDE.md — with the dates
that earned it.

Open source — https://github.com/jjanczur/tyran
How it learns — https://jjanczur.github.io/tyran/self-improvement/
Live board — https://jjanczur.github.io/tyran/sandbox/

#Shorts #ClaudeCode #AIAgents #OpenSource #DeveloperTools
```

---

## After uploading

Send the five URLs back and they get written into `site/src/data/videos.json`,
which is the single place the docs page and the README read video IDs from.
Until then both surfaces link to the repo instead of to a dead embed.
