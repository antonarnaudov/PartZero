#!/usr/bin/env bash
# PartZero Alpha 0: build, check and install PartZero.app on this Mac (docs/ALPHA-0-PLAN.md W1, §4.2).
#
#   scripts/alpha0-mac.sh --build               build packages/desktop/release/alpha-local/mac-arm64/PartZero.app
#                                               and check it (signature, fuses, --self-test)
#   scripts/alpha0-mac.sh --install             --build, then install it into /Applications
#   scripts/alpha0-mac.sh --install --no-build  install the app the last --build made
#   scripts/alpha0-mac.sh --self-test           only run the checks on the last build (or --app <path>)
#   scripts/alpha0-mac.sh --rollback            put /Applications/PartZero-previous.app back
#
# --install quits a running PartZero (it asks it to quit, like ⌘Q: a document with unsaved changes keeps it open,
# and the script stops), moves /Applications/PartZero.app to PartZero-previous.app (replacing an older previous
# one), and copies the new app in with `ditto`. A build made on this Mac carries no quarantine flag, so it opens
# without a Gatekeeper dialog [as9]; if macOS blocks it anyway, use System Settings → Privacy & Security → Open
# Anyway (only you change that setting).
#
# What the build is: an ad-hoc signed, arm64-only app with the Alpha 0 edition's name (PartZero), bundle id
# (ai.partzero.desktop) and fuses (electron-builder.alpha-local.cjs). It never asks for your keychain and stores no
# API keys: the agent runs on the Claude Code you are logged into.
#
# Environment:
#   PARTZERO_INSTALL_DIR   where --install/--rollback put the app (default /Applications; the tests use a scratch folder)
#   PARTZERO_SKIP_SELF_TEST=1  skip --self-test after --build (not recommended)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$REPO/packages/desktop"
CONFIG="electron-builder.alpha-local.cjs"
APP_NAME="PartZero"
BUNDLE_ID="ai.partzero.desktop"
BUILT_APP="$DESKTOP/release/alpha-local/mac-arm64/$APP_NAME.app"
INSTALL_DIR="${PARTZERO_INSTALL_DIR:-/Applications}"
REPORT_DIR="$DESKTOP/release/alpha-local"

say() { printf '\033[1m[alpha0]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[alpha0] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  sed -n '2,24p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

build=0; install=0; selftest=0; rollback=0; nobuild=0; app_override=""
while [ $# -gt 0 ]; do
  case "$1" in
    --build) build=1 ;;
    --install) install=1 ;;
    --no-build) nobuild=1 ;;
    --self-test) selftest=1 ;;
    --rollback) rollback=1 ;;
    --app) shift; app_override="${1:-}" ;;
    -h|--help) usage 0 ;;
    *) printf 'unknown option: %s\n\n' "$1" >&2; usage 2 ;;
  esac
  shift
done
[ $((build + install + selftest + rollback)) -gt 0 ] || usage 2
[ -n "$app_override" ] && BUILT_APP="$app_override"
if [ "$install" = 1 ] && [ "$nobuild" = 0 ]; then build=1; fi

preflight() {
  [ "$(uname -s)" = "Darwin" ] || die "PartZero Alpha 0 builds on macOS only"
  [ "$(uname -m)" = "arm64" ] || die "PartZero Alpha 0 is arm64 only (this Mac is $(uname -m))"
  [ "$(id -u)" != 0 ] || die "do not run this as root"
  for tool in node pnpm cargo git codesign ditto; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is not on PATH"
  done
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$major" -ge 22 ] || die "Node 22 or newer is needed (found $(node --version))"
  command -v wasm-bindgen >/dev/null 2>&1 || die "wasm-bindgen is not on PATH: cargo install wasm-bindgen-cli --version 0.2.128 --locked"
}

do_build() {
  preflight
  local t0=$SECONDS
  say "1/8 pnpm install"
  (cd "$REPO" && pnpm install --frozen-lockfile)
  say "2/8 cargo build --release -p forge-cli (the aicad binary the app bundles)"
  (cd "$REPO/forge" && cargo build --release -p forge-cli)
  say "3/8 build the workspace packages the app bundles (forge-web WASM, agent, gateway, MCP server, web app)"
  (cd "$REPO" && pnpm --filter "@aicad/desktop^..." run build)
  say "4/8 typecheck the desktop shell"
  (cd "$DESKTOP" && pnpm run typecheck)
  say "5/8 bundle main, preload, agent worker and MCP shim (edition alpha-local)"
  (cd "$DESKTOP" && node scripts/bundle.mjs --edition alpha-local)
  say "6/8 third-party notices for the aicad binary"
  (cd "$DESKTOP" && node scripts/package-notices.mjs)
  say "7/8 electron-builder --dir (arm64, ad-hoc signed)"
  (cd "$DESKTOP" && pnpm exec electron-builder --config "$CONFIG" --mac)
  [ -d "$BUILT_APP" ] || die "electron-builder made no $BUILT_APP"
  say "8/8 checks"
  check_app "$BUILT_APP"
  say "built $BUILT_APP in $((SECONDS - t0)) s"
}

# Signature, fuses and --self-test of an app bundle.
check_app() {
  local app="$1"
  say "codesign --verify --deep --strict"
  codesign --verify --deep --strict "$app" || die "$app fails codesign --verify --deep --strict"
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|Format|Signature)' | sed 's/^/    /'
  say "fuses (expected: $CONFIG)"
  (cd "$DESKTOP" && node scripts/check-fuses.mjs "$app" --config "$CONFIG") > "$REPORT_DIR/fuses.json" || { cat "$REPORT_DIR/fuses.json"; die "the fuses do not match $CONFIG"; }
  node -e 'const r=require(process.argv[1]); for (const [k,v] of Object.entries(r.fuses)) console.log(`    ${k}: ${v.actual}`); for (const u of r.unconfigured) console.log(`    (fuse #${u.position} not in the config: ${u.state})`)' "$REPORT_DIR/fuses.json"
  if [ "${PARTZERO_SKIP_SELF_TEST:-}" = 1 ]; then say "self-test skipped (PARTZERO_SKIP_SELF_TEST=1)"; return; fi
  run_self_test "$app"
}

# The app's own --self-test, in the environment a Finder launch gets (launchd's minimal PATH, no shell rc files), so
# Claude Code must be found the way the installed app will find it.
run_self_test() {
  local app="$1" exe="$1/Contents/MacOS/$APP_NAME" out="$REPORT_DIR/self-test.json" code=0
  [ -x "$exe" ] || die "no executable at $exe"
  say "--self-test (Finder-like environment: PATH=/usr/bin:/bin:/usr/sbin:/sbin)"
  env -i HOME="$HOME" USER="${USER:-$(id -un)}" LOGNAME="${LOGNAME:-$(id -un)}" TMPDIR="${TMPDIR:-/tmp}" SHELL="${SHELL:-/bin/zsh}" \
    PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG="${LANG:-en_US.UTF-8}" \
    "$exe" --self-test > "$out" 2> "$REPORT_DIR/self-test.stderr.log" || code=$?
  node -e '
    const r = require(process.argv[1]);
    const line = (k, v) => console.log(`    ${k.padEnd(12)} ${v}`);
    line("app", `${r.app.name} ${r.app.version} (${r.app.edition}, ${r.app.commit ?? "no commit"}${r.app.dirty ? ", dirty" : ""})`);
    line("aicad", r.forgeCli.detail);
    line("worker", `${r.worker.detail}; ${r.worker.report ? r.worker.report.engine.detail : "no report"}`);
    line("MCP shim", r.worker.report ? r.worker.report.mcp.detail : "no report");
    line("renderer", r.renderer.detail);
    line("Claude Code", r.claudeCode.detail);
    line("slicer", r.slicer.found ? `${r.slicer.name} ${r.slicer.version} (${r.slicer.bundleId}) at ${r.slicer.path}` : "Bambu Studio not found");
    for (const w of r.warnings) console.log(`    warning: ${w}`);
    for (const f of r.failures) console.log(`    FAILED: ${f}`);
  ' "$out" || die "--self-test printed no report (see $REPORT_DIR/self-test.stderr.log)"
  [ "$code" = 0 ] || die "--self-test failed (exit $code); the full report is $out"
  say "self-test passed ($out)"
}

is_running() {
  [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null || echo false)" = "true" ]
}

quit_running_app() {
  if ! is_running; then return; fi
  say "quitting the running $APP_NAME"
  osascript -e "tell application id \"$BUNDLE_ID\" to quit" >/dev/null 2>&1 || true
  for _ in $(seq 1 60); do
    is_running || return 0
    sleep 0.5
  done
  die "$APP_NAME is still running (a document with unsaved changes?). Save or close it, quit $APP_NAME, and run this again."
}

do_install() {
  [ -d "$BUILT_APP" ] || die "nothing to install: $BUILT_APP does not exist (run with --build first)"
  codesign --verify --deep --strict "$BUILT_APP" || die "$BUILT_APP fails codesign --verify; rebuild it"
  [ -d "$INSTALL_DIR" ] || die "$INSTALL_DIR does not exist"
  [ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable for $(id -un)"
  local target="$INSTALL_DIR/$APP_NAME.app" previous="$INSTALL_DIR/$APP_NAME-previous.app"
  quit_running_app
  if [ -d "$target" ]; then
    rm -rf "$previous"
    mv "$target" "$previous"
    say "kept the old app as $previous (roll back with --rollback)"
  fi
  ditto "$BUILT_APP" "$target"
  codesign --verify --deep --strict "$target" || die "the installed app fails codesign --verify"
  if xattr -p com.apple.quarantine "$target" >/dev/null 2>&1; then
    say "note: $target carries a quarantine flag; if macOS blocks it, use System Settings → Privacy & Security → Open Anyway"
  fi
  say "installed $target. Open it from Applications (the first launch shows the welcome card)."
}

do_rollback() {
  local target="$INSTALL_DIR/$APP_NAME.app" previous="$INSTALL_DIR/$APP_NAME-previous.app" undone="$INSTALL_DIR/$APP_NAME-rolled-back.app"
  [ -d "$previous" ] || die "there is no $previous to roll back to"
  quit_running_app
  if [ -d "$target" ]; then
    rm -rf "$undone"
    mv "$target" "$undone"
  fi
  mv "$previous" "$target"
  say "rolled back: $target is the previous build again (the newer one is $undone)"
}

if [ "$rollback" = 1 ]; then do_rollback; exit 0; fi
mkdir -p "$REPORT_DIR"
if [ "$build" = 1 ]; then do_build; fi
if [ "$selftest" = 1 ] && [ "$build" = 0 ]; then
  [ -d "$BUILT_APP" ] || die "no app at $BUILT_APP (run with --build first, or pass --app <path>)"
  check_app "$BUILT_APP"
fi
if [ "$install" = 1 ]; then do_install; fi
