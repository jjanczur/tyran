---
description: Where is the work right now. Regenerates STATE.md and PROGRESS.md from the journal and answers with the progress line, the agents still running, the open gates and the resume steps. Read-only. Use for /tyran:status or when asked what is going on.
---

# Status

Answer from the journal, never from memory.

```bash
J=$(ls -t .tyran/state/*/journal.jsonl 2>/dev/null | head -1)
node "${CLAUDE_PLUGIN_ROOT}/scripts/project.mjs" "$J" --out-dir "$(dirname "$J")"
node "${CLAUDE_PLUGIN_ROOT}/scripts/journal.mjs" tail "$J"
node "${CLAUDE_PLUGIN_ROOT}/scripts/journal.mjs" open-spawns "$J"
```

Then report, in this order and no longer than a screen:

1. If `.tyran/state/paused-until.json` exists, the pause comes FIRST: which
   window, when it resumes, and `node "${CLAUDE_PLUGIN_ROOT}/scripts/overnight.mjs" status`
   output. Everything below it is context for a session that is deliberately
   not working.
2. The progress line: `PROGRESS: NN% · X/Y tickets · phase: <name> · last merge: <sha>`.
3. **Agents with no report yet** — the ones from `open-spawns`. Say how long
   each has been open. An agent that has been running for an hour is the most
   useful thing on this screen and the easiest to overlook.
4. Open gates, and who is waiting on whom.
5. Any lease released by someone who did not hold it. The projection surfaces
   these; they mean two agents believed they owned the same worktree.
6. The resume steps from the last checkpoint.

If there is no journal, say exactly that and suggest `/tyran:setup`. Do not
reconstruct a status from the git log — a plausible status is worse than none,
because it will be believed.

Change nothing. This command reads.
