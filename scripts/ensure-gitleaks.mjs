#!/usr/bin/env node
/**
 * ensure-gitleaks — remove the one prerequisite that blocks day one.
 *
 * The secrets gate refuses every commit and push until `gitleaks` exists, and
 * it refuses rather than warning for a reason that has not changed: a check
 * that passes when its scanner is missing is a check you disable by
 * uninstalling a package.
 *
 * The unstated assumption in that design is that the operator can install a
 * binary. Measured against the people actually adopting this: some have no
 * Homebrew, no admin rights, or are on Windows. For them the realistic
 * outcome of "install gitleaks and re-run" is not a safer repository — it is
 * switching the hook off, or abandoning the tool. A gate nobody can satisfy
 * protects nothing, which is the same argument `.tyran/config.yaml` being
 * AUTO already rests on.
 *
 * So this fetches the scanner instead of asking someone else to. It is the
 * same thing `.github/workflows/ci.yml` has always done — pinned version,
 * pinned checksum — moved to where a user can reach it.
 *
 * ## Why a checksum table and not "download the latest"
 *
 * This writes an executable and something else later runs it. Version alone
 * is not integrity: a tag can be moved, a mirror can lie, and a scanner that
 * has been replaced reports clean on everything. The digests below are the
 * ones GitHub publishes for 8.30.1, and a mismatch DELETES the download and
 * refuses. The linux_x64 line is the same digest ci.yml already pins, which
 * is the cross-check that this table was transcribed and not invented.
 *
 * Usage:
 *   node scripts/ensure-gitleaks.mjs [--check]
 *
 * Exit: 0 present or installed · 1 unavailable (reason printed) · 2 usage.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/** The version this table describes. Bumping it means re-fetching every digest. */
export const GITLEAKS_VERSION = '8.30.1';

/**
 * SHA-256 per platform, from the release's own `checksums.txt`.
 *
 * Keyed `<process.platform>-<process.arch>` so the lookup cannot drift from
 * what Node reports. A platform absent from this table is a REFUSAL with
 * instructions, never a silent skip — an unknown platform is exactly where a
 * "best effort" download would install something unverified.
 */
export const GITLEAKS_SHA256 = Object.freeze({
  'darwin-arm64': 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
  'darwin-x64': 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  'linux-arm64': 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  // The digest ci.yml pins. If these two ever disagree, one of them is wrong.
  'linux-x64': '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  'win32-arm64': 'b95f5e4f5c425cedca7ee203d9afd29597e692c4924a12ed42f970537c72cc0f',
  'win32-x64': 'd29144deff3a68aa93ced33dddf84b7fdc26070add4aa0f4513094c8332afc4e',
});

/**
 * Where a managed scanner lives: under the operator's HOME, never the repo.
 *
 * The first shape of this put it in `<repo>/.tyran/bin/`, which is worse in a
 * way worth recording: a path inside the repository travels with a clone, so
 * a planted binary that reports clean on everything would arrive with the
 * checkout — the attack the tracked-only rule for `.gitleaksignore` already
 * exists to prevent, reopened through a file that is not even in a diff.
 * Under the home directory the scanner is the operator's machine, exactly
 * like anything on PATH, and one install serves every repository on it.
 */
export const MANAGED_DIR = join(homedir(), '.tyran', 'bin');

const ASSET_ARCH = Object.freeze({ arm64: 'arm64', x64: 'x64' });

/** The release asset name for a platform key, or null if unsupported. */
export function assetFor(platform = process.platform, arch = process.arch) {
  const a = ASSET_ARCH[arch];
  if (a === undefined) return null;
  if (platform === 'darwin') return `gitleaks_${GITLEAKS_VERSION}_darwin_${a}.tar.gz`;
  if (platform === 'linux') return `gitleaks_${GITLEAKS_VERSION}_linux_${a}.tar.gz`;
  if (platform === 'win32') return `gitleaks_${GITLEAKS_VERSION}_windows_${a}.zip`;
  return null;
}

export const managedBinPath = (platform = process.platform) =>
  join(MANAGED_DIR, platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');

/** SHA-256 of a file on disk, hex. */
export function digestOf(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Is a usable `gitleaks` already reachable? Checks the operator's override
 * first, then PATH — the two the gate itself consults, in the gate's order.
 */
export function alreadyAvailable({ run = defaultRun } = {}) {
  const explicit = process.env.TYRAN_GITLEAKS_BIN;
  if (typeof explicit === 'string' && explicit !== '') {
    return run(explicit, ['version']) === null ? null : { path: explicit, why: 'TYRAN_GITLEAKS_BIN' };
  }
  const version = run('gitleaks', ['version']);
  return version === null ? null : { path: 'gitleaks', why: 'on PATH', version: version.trim() };
}

function defaultRun(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  } catch {
    return null;
  }
}

/**
 * Download one URL to a path, following redirects. GitHub answers a release
 * asset with a 302 to a CDN, so a client that does not follow them downloads
 * an HTML document and hashes it — which fails the digest check rather than
 * installing anything, but reports the wrong reason.
 */
async function download(url, dest, { redirects = 5 } = {}) {
  const { get } = await import('node:https');
  const { createWriteStream } = await import('node:fs');
  return new Promise((resolvePromise, reject) => {
    get(url, { headers: { 'user-agent': 'tyran-ensure-gitleaks' } }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode !== undefined && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        if (redirects === 0) return reject(new Error('too many redirects'));
        return resolvePromise(download(headers.location, dest, { redirects: redirects - 1 }));
      }
      if (statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${statusCode} from ${url}`));
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolvePromise(undefined)));
      file.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Fetch, verify and unpack the pinned scanner into `<dir>/bin/`.
 *
 * The digest is checked BEFORE anything is unpacked and before the file is
 * made executable: an archive that fails is deleted and nothing it contained
 * ever reaches the disk as a program.
 *
 * `tar` does the unpacking on every platform — bsdtar reads zip, and Windows
 * has shipped it since 10 — so this needs no archive library and no
 * dependency, which is the property that lets it ship inside a plugin.
 */
export async function installGitleaks({ platform = process.platform, arch = process.arch, run = defaultRun } = {}) {
  const key = `${platform}-${arch}`;
  const asset = assetFor(platform, arch);
  const expected = GITLEAKS_SHA256[key];
  if (asset === null || expected === undefined) {
    return { ok: false, reason: `no pinned build for ${key}`, unsupported: true };
  }
  const target = managedBinPath(platform);
  if (existsSync(target) && digestOf(target) !== '' && run(target, ['version']) !== null) {
    return { ok: true, path: target, already: true };
  }
  const url = `https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/${asset}`;
  const staging = join(tmpdir(), `tyran-gitleaks-${process.pid}`);
  mkdirSync(staging, { recursive: true });
  const archive = join(staging, asset);
  try {
    await download(url, archive);
    const actual = digestOf(archive);
    if (actual !== expected) {
      rmSync(staging, { recursive: true, force: true });
      return {
        ok: false,
        reason: `checksum mismatch for ${asset}: expected ${expected}, got ${actual}. Nothing was installed.`,
      };
    }
    execFileSync('tar', ['-xf', archive, '-C', staging], { stdio: 'ignore', timeout: 60_000 });
    const unpacked = join(staging, platform === 'win32' ? 'gitleaks.exe' : 'gitleaks');
    if (!existsSync(unpacked)) {
      rmSync(staging, { recursive: true, force: true });
      return { ok: false, reason: `the archive did not contain a gitleaks binary` };
    }
    mkdirSync(MANAGED_DIR, { recursive: true });
    writeFileSync(target, readFileSync(unpacked));
    if (platform !== 'win32') chmodSync(target, 0o755);
    rmSync(staging, { recursive: true, force: true });
    if (run(target, ['version']) === null) {
      return { ok: false, reason: 'the installed binary did not run — the platform build may not match this machine' };
    }
    return { ok: true, path: target, installed: true, digest: expected };
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, reason: String(error.message ?? error) };
  }
}

const MANUAL =
  'Install it by hand and re-run:\n' +
  '    macOS      brew install gitleaks\n' +
  '    Linux      see https://github.com/gitleaks/gitleaks/releases (or your package manager)\n' +
  'or point TYRAN_GITLEAKS_BIN at an existing binary.';

function usage(message) {
  if (message) console.error(`ensure-gitleaks: ${message}`);
  console.error('usage: node scripts/ensure-gitleaks.mjs [--check]');
  process.exit(2);
}

async function main(argv) {
  const args = argv.slice(2);
  for (const arg of args) {
    if (arg.startsWith('--') && arg !== '--check') usage(`unknown flag ${arg}`);
  }

  const found = alreadyAvailable();
  if (found !== null) {
    console.log(`ensure-gitleaks: already available (${found.why})${found.version ? ` — ${found.version}` : ''}`);
    process.exit(0);
  }
  const local = managedBinPath();
  if (existsSync(local) && defaultRun(local, ['version']) !== null) {
    console.log(`ensure-gitleaks: present at ${local}`);
    process.exit(0);
  }
  if (args.includes('--check')) {
    console.error('ensure-gitleaks: NOT available — the secrets gate refuses every commit and push until it is.');
    console.error(MANUAL);
    process.exit(1);
  }

  console.log(`ensure-gitleaks: fetching gitleaks ${GITLEAKS_VERSION} for ${process.platform}-${process.arch}…`);
  const result = await installGitleaks();
  if (!result.ok) {
    console.error(`ensure-gitleaks: could not install it (${result.reason})`);
    console.error(MANUAL);
    process.exit(1);
  }
  console.log(`ensure-gitleaks: installed ${result.path}`);
  console.log(`ensure-gitleaks: verified sha256 ${result.digest}`);
  console.log('ensure-gitleaks: the secrets gate finds this automatically — nothing to add to your shell.');
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv).catch((error) => {
    console.error(`ensure-gitleaks: ${error.message}`);
    process.exit(1);
  });
}
