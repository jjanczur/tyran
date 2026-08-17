#!/bin/sh
# Tyran installer — everything a machine can do without a human in the loop.
#
# One restart cannot be automated: Claude Code loads plugins at startup, and
# nothing inside a session can make the app reload itself. So this does every
# other step, and ends by printing the ONE thing left to paste afterwards.
# Telling someone "and now run four more commands" is where installs are
# abandoned; telling them "restart, then paste this" is not.
#
#   curl -fsSL https://raw.githubusercontent.com/jjanczur/tyran/main/install.sh | sh
#
# It is deliberately POSIX sh with no dependencies beyond node and the claude
# CLI, because the people this exists for are the ones least likely to have a
# working toolchain to fix it with.
#
# Nothing here is irreversible: the plugin install is undone with
# `claude plugin uninstall`, and the scanner is one file under ~/.tyran/bin.
set -eu

say() { printf '%s\n' "$*"; }
fail() { printf 'tyran: %s\n' "$*" >&2; exit 1; }

say ""
say "  Tyran — setting up everything that does not need you"
say ""

# ---------------------------------------------------------------- node
# Checked FIRST and by version, because every hook shells out to `node`: an
# old one does not fail at install time, it fails later as a gate that cannot
# run, which is the hardest possible thing for a non-technical user to read.
command -v node >/dev/null 2>&1 || fail "node is not installed. Tyran needs Node 22 or newer — https://nodejs.org"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || fail "node $(node -v 2>/dev/null) is too old — Tyran needs 22 or newer."
say "  ✓ node $(node -v)"

# ---------------------------------------------------------------- claude CLI
command -v claude >/dev/null 2>&1 || fail "the claude CLI is not installed — see https://claude.com/claude-code"
say "  ✓ claude CLI"

# ---------------------------------------------------------------- the plugin
# Both commands are idempotent: re-running the installer on a machine that
# already has Tyran is a no-op that re-verifies, not a second copy.
say "  … installing the plugin"
claude plugin marketplace add jjanczur/tyran >/dev/null 2>&1 || true
claude plugin install tyran@tyran >/dev/null 2>&1 || true
say "  ✓ plugin installed"

# ---------------------------------------------------------------- the scanner
# The secrets gate refuses every commit and push until gitleaks exists. Doing
# this now, rather than letting the first commit fail, is the difference
# between a tool that works and a tool that says no on day one for a reason
# the user cannot act on.
say "  … checking the secrets scanner"
if npx --yes @jjanczur/tyran ensure-gitleaks >/dev/null 2>&1; then
  say "  ✓ secrets scanner ready"
else
  say "  ! could not install gitleaks automatically."
  say "    Tyran still works; the first commit will explain what to do."
fi

say ""
say "  Done. One step left, and only you can do it:"
say ""
say "  1. Restart Claude Code (quit and reopen — it loads plugins at startup)."
say "  2. Paste this into a Claude Code session in the repo you want to use:"
say ""
say "  ─────────────────────────────────────────────────────────────────"
cat <<'PROMPT'
  Set Tyran up for this repository and show me the dashboard.

  Run /tyran:setup. Work out what you can from the repo itself and ask me
  at most one question, in plain language, about anything you genuinely
  cannot establish. Then run /tyran:doctor to prove the install works, and
  start the dashboard with:

    node "${CLAUDE_PLUGIN_ROOT}/scripts/board.mjs" --dir .tyran --serve --write --open

  Tell me in plain words what you set up and what the dashboard shows me.
  If this repo already contains secrets in its history, say so and explain
  my options before changing anything.
PROMPT
say "  ─────────────────────────────────────────────────────────────────"
say ""
