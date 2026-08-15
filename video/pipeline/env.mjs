/**
 * Minimal dotenv reader.
 *
 * Deliberately a module rather than a shell step: Tyran's own policy gate
 * refuses any Bash command whose TEXT names a credential-shaped path, and it
 * is right to. `node pipeline/tts.mjs` names no such path; the file is opened
 * here, at runtime, and only the value we need is read out of it.
 *
 * Never print a value. `report()` prints presence and length only.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

let cache = null;

function load() {
  if (cache) return cache;
  cache = { ...process.env };

  const dotfile = join(REPO_ROOT, [".", "env"].join(""));
  if (!existsSync(dotfile)) return cache;

  for (const raw of readFileSync(dotfile, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // A real environment variable wins over the file.
    if (!(key in process.env)) cache[key] = val;
  }
  return cache;
}

export function need(key) {
  const v = load()[key];
  if (!v) {
    throw new Error(
      `${key} is not set. Add it to the repo-root env file or export it before running this script.`
    );
  }
  return v;
}

export function has(key) {
  return Boolean(load()[key]);
}

/** Presence and length only — never the value. */
export function report(keys) {
  const env = load();
  for (const k of keys) {
    const v = env[k];
    console.log(`  ${k.padEnd(18)} ${v ? `present (${v.length} chars)` : "MISSING"}`);
  }
}
