#!/usr/bin/env node
/**
 * board-refresh — the board is fresh after every agent, without anyone
 * remembering to regenerate it.
 *
 * A SubagentStop PROBE, deliberately separate from the evidence gate that
 * shares the event: a gate's output channel is a refusal channel, and a
 * render failure must never refuse a report — while the evidence gate's own
 * header refuses to drag the projection module into a gate's startup. Probes
 * fail open by construction (`runProbe`); every failure here degrades to
 * silence and the next merge re-renders anyway.
 *
 * Interleaving note: the evidence gate may append its `gate` event
 * concurrently with this render. The journal's write lock serializes the
 * writers; this probe may therefore render the pre-event state, which the
 * next stop or merge corrects. A board is a projection, not a ledger.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from './session-start.mjs';
import { main, runProbe } from './hook-io.mjs';

export const DEADLINE_MS = 6000;

export async function refresh(input) {
  const repoRoot = resolveRepoRoot(input);
  if (repoRoot === null) return {};
  const tyranDir = join(repoRoot, '.tyran');
  if (!existsSync(join(tyranDir, 'state'))) return {};
  try {
    // Dynamic imports on purpose: nothing heavy loads before we know there is
    // a state directory to render.
    const [{ readdirSync, statSync }, projectModule, boardModule] = await Promise.all([
      import('node:fs'),
      import('../../scripts/project.mjs'),
      import('../../scripts/board.mjs'),
    ]);
    const stateDir = join(tyranDir, 'state');
    for (const name of readdirSync(stateDir).sort()) {
      const dir = join(stateDir, name);
      try {
        if (!statSync(dir).isDirectory()) continue;
        const journal = join(dir, 'journal.jsonl');
        if (!existsSync(journal)) continue;
        const { files, state } = projectModule.projectFile(journal);
        // The CLI's own refusal guard, mirrored: a journal with zero readable
        // events and damage renders an EMPTY board — writing that over good
        // projections would erase state exactly when the journal needs help.
        if (state.total === 0 && (state.corruptLines + state.malformed > 0 || state.truncatedTail)) continue;
        projectModule.writeAllAtomic(Object.entries(files).map(([f, content]) => [join(dir, f), content]));
      } catch {
        /* one broken initiative must not stop the rest */
      }
    }
    const rendered = boardModule.renderAll(tyranDir);
    projectModule.writeAllAtomic(
      Object.entries(rendered.files).map(([name, content]) => [join(stateDir, name), content]),
    );
  } catch {
    /* a probe never speaks about its own failure; doctor reports staleness */
  }
  return {};
}

function canonicalPath(path) {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isMainModule(moduleUrl) {
  if (!process.argv[1]) return false;
  return canonicalPath(process.argv[1]) === canonicalPath(fileURLToPath(moduleUrl));
}

if (isMainModule(import.meta.url)) {
  await main(() =>
    runProbe({
      event: 'SubagentStop',
      deadlineMs: DEADLINE_MS,
      handler: ({ input }) => refresh(input),
    }),
  );
}
