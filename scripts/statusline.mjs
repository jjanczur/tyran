#!/usr/bin/env node
/**
 * statusline — tees the platform's rate-limit telemetry into the sidecar the
 * usage gate reads.
 *
 * Measured on Claude Code 2.1.197: the PreToolUse hook payload does NOT carry
 * `rate_limits` (recorded in hooks/HOOK-CONTRACT-MEASURED.md), so the ONLY
 * place a session's subscription usage is programmatically visible is the
 * statusline JSON — which a plugin cannot install; the operator registers this
 * command in their user settings (`/tyran:setup` prints the snippet). Each
 * time the statusline fires, this writes `.tyran/state/usage.json`
 * atomically; the usage gate treats a sidecar older than its staleness window
 * as absent and fails open.
 *
 * Trust boundary: the payload is platform-produced but this writer is
 * deliberately a filter, not a copier — ONLY finite numbers and a
 * shape-validated session id reach the sidecar, never free strings, so
 * nothing downstream has to sanitize what it reads back.
 *
 * A statusline is a UI element: it must never break the UI. Every failure
 * path exits 0, silently. `--sidecar-only` prints nothing at all, so an
 * operator with an existing statusline can compose:
 *   existing-statusline.sh | tee >(node .../statusline.mjs --sidecar-only)
 * (the payload is consumed from stdin either way).
 *
 * CLI: node statusline.mjs [--sidecar-only]     # payload on stdin
 * Exit: always 0
 */
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const SIDECAR_RELPATH = join('.tyran', 'state', 'usage.json');
const MAX_INPUT_BYTES = 1024 * 1024;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** Own-property read on a prototype-free view of foreign JSON. */
function field(obj, name) {
  return obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, name)
    ? obj[name]
    : undefined;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** One rate-limit window ({used_percentage, resets_at}) — numbers only. */
function windowOf(node) {
  if (node === null || typeof node !== 'object') return null;
  const used = finiteNumber(field(node, 'used_percentage'));
  const resets = finiteNumber(field(node, 'resets_at'));
  if (used === null && resets === null) return null;
  const out = {};
  if (used !== null) out.used_percentage = used;
  if (resets !== null) out.resets_at = resets;
  return out;
}

/**
 * The sidecar document, or null when the payload carries nothing usable.
 * `now` is injected so tests are deterministic.
 */
export function sidecarOf(payload, nowIso) {
  if (payload === null || typeof payload !== 'object') return null;
  const limits = field(payload, 'rate_limits');
  const fiveHour = windowOf(field(limits, 'five_hour'));
  const sevenDay = windowOf(field(limits, 'seven_day'));
  if (fiveHour === null && sevenDay === null) return null;
  const doc = { written_at: nowIso };
  const sessionId = field(payload, 'session_id');
  if (typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)) doc.session_id = sessionId;
  if (fiveHour !== null) doc.five_hour = fiveHour;
  if (sevenDay !== null) doc.seven_day = sevenDay;
  return doc;
}

/** Where the repo is, per the payload; last resort is the process cwd. */
export function repoRootOf(payload, cwd = process.cwd()) {
  const workspace = field(payload, 'workspace');
  for (const candidate of [field(workspace, 'project_dir'), field(workspace, 'current_dir'), field(payload, 'cwd')]) {
    if (typeof candidate === 'string' && candidate !== '' && existsSync(candidate)) return candidate;
  }
  return cwd;
}

/** Atomic create-or-replace: temp in the same directory, then rename. */
export function writeSidecar(root, doc) {
  const target = join(resolve(root), SIDECAR_RELPATH);
  const dir = join(resolve(root), '.tyran', 'state');
  if (!existsSync(join(resolve(root), '.tyran'))) return false; // not a Tyran repo — write nothing
  mkdirSync(dir, { recursive: true });
  const temp = join(dir, `.usage-${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(temp, target);
  return true;
}

/** The one visible line. Only numbers formatted here — nothing foreign. */
export function statusLineOf(doc) {
  const parts = [];
  const fmt = (label, w) => {
    if (!w) return;
    let text = `${label}`;
    if (typeof w.used_percentage === 'number') text += ` ${Math.round(w.used_percentage)}%`;
    if (typeof w.resets_at === 'number') {
      const at = new Date(w.resets_at * 1000);
      if (!Number.isNaN(at.getTime())) {
        text += ` resets ${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
      }
    }
    parts.push(text);
  };
  fmt('5h', doc.five_hour);
  fmt('7d', doc.seven_day);
  return parts.join(' · ');
}

async function readStdin(limit = MAX_INPUT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const sidecarOnly = process.argv.includes('--sidecar-only');
  try {
    const raw = await readStdin();
    if (raw === null) return;
    const payload = JSON.parse(raw);
    const doc = sidecarOf(payload, new Date().toISOString());
    if (doc === null) return;
    writeSidecar(repoRootOf(payload), doc);
    if (!sidecarOnly) process.stdout.write(statusLineOf(doc) + '\n');
  } catch {
    // A statusline that breaks the UI is worse than one that says nothing.
  }
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
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
if (isMainModule(import.meta.url)) await main();
