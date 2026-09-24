#!/usr/bin/env bash
# PartZero Alpha 0: build, check and install PartZero.app on this Mac (docs/ALPHA-0-PLAN.md W1, §4.2).
#
#   scripts/alpha0-mac.sh --build               build packages/desktop/release/alpha-local/mac-arm64/PartZero.app
#                                               and check it (signature, fuses, --self-test)
#   scripts/alpha0-mac.sh --install             --build, then install it into /Applications
#   scripts/alpha0-mac.sh --install --no-build  install the app the last --build made
#   scripts/alpha0-mac.sh --self-test           only run the checks on the last build (or --app <path>)
#   scripts/alpha0-mac.sh --rollback            put the previous build back in /Applications
#
# --install quits a running PartZero (it asks it to quit, like ⌘Q: a document with unsaved changes keeps it open,
# and the script stops), moves /Applications/PartZero.app to /Applications/.PartZero-builds/previous (replacing an
# older previous one), copies the new app in with `ditto`, and checks the installed copy's signature and fuses. The
# kept builds are not named *.app, so macOS does not list them as apps. --rollback swaps the previous build back and
# keeps the newer one as .PartZero-builds/rolled-back. A build made on this Mac carries no quarantine flag, so it
# opens without a Gatekeeper dialog [as9]; if macOS blocks it anyway, use System Settings → Privacy & Security →
# Open Anyway (only you change that setting). If macOS refuses to quit or move the app (Automation, App
# Management), the script says which setting it is; only you change those.
#
# What the build is: an ad-hoc signed, arm64-only app with the Alpha 0 edition's name (PartZero), bundle id
# (ai.partzero.desktop) and fuses (electron-builder.alpha-local.cjs). It never asks for your keychain and stores no
# API keys: the agent runs on the Claude Code you are logged into.
#
# Environment:
#   PARTZERO_INSTALL_DIR   where --install/--rollback put the app (default /Applications; the tests use a scratch folder)
#   PARTZERO_SKIP_SELF_TEST=1  skip --self-test after --build (not recommended)
#   PARTZERO_SELF_TEST_TIMEOUT  seconds before a hung --self-test is stopped (default 240; the app gives up at 180)
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$REPO/packages/desktop"
CONFIG="electron-builder.alpha-local.cjs"
APP_NAME="PartZero"
BUNDLE_ID="ai.partzero.desktop"
BUILT_APP="$DESKTOP/release/alpha-local/mac-arm64/$APP_NAME.app"
INSTALL_DIR="${PARTZERO_INSTALL_DIR:-/Applications}"
# Earlier builds, for --rollback: a hidden folder next to the app, and folders without the .app extension, so macOS
# never takes them for apps (no second PartZero in Spotlight or Launchpad, and none that `open -b` could pick).
BACKUP_DIR="$INSTALL_DIR/.$APP_NAME-builds"
REPORT_DIR="$DESKTOP/release/alpha-local"
SELF_TEST_TIMEOUT="${PARTZERO_SELF_TEST_TIMEOUT:-240}"
case "$SELF_TEST_TIMEOUT" in ''|*[!0-9]*) printf 'PARTZERO_SELF_TEST_TIMEOUT must be a number of seconds\n' >&2; exit 2 ;; esac

say() { printf '\033[1m[alpha0]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[alpha0] %s\033[0m\n' "$*" >&2; exit 1; }

usage() {
  # The header comment, up to the first line that is not a comment.
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "${BASH_SOURCE[0]}"
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

# Signature and fuses of an app bundle (G1 #1; on the installed copy, the first G2b check).
check_signature_and_fuses() {
  local app="$1" report="$2"
  say "codesign --verify --deep --strict"
  codesign --verify --deep --strict "$app" || die "$app fails codesign --verify --deep --strict"
  codesign -dv "$app" 2>&1 | grep -E '^(Identifier|Format|Signature)' | sed 's/^/    /'
  say "fuses (expected: $CONFIG)"
  (cd "$DESKTOP" && node scripts/check-fuses.mjs "$app" --config "$CONFIG") > "$report" || { cat "$report"; die "the fuses of $app do not match $CONFIG"; }
  node -e 'const r=require(process.argv[1]); for (const [k,v] of Object.entries(r.fuses)) console.log(`    ${k}: ${v.actual}`); for (const u of r.unconfigured) console.log(`    (fuse #${u.position} not in the config: ${u.state})`)' "$report"
}

# Signature, fuses and --self-test of an app bundle.
check_app() {
  local app="$1"
  check_signature_and_fuses "$app" "$REPORT_DIR/fuses.json"
  if [ "${PARTZERO_SKIP_SELF_TEST:-}" = 1 ]; then say "self-test skipped (PARTZERO_SKIP_SELF_TEST=1)"; return; fi
  run_self_test "$app"
}

# The app's own --self-test, in an environment no richer than a Finder launch gets: launchd's minimal PATH and no
# shell rc files, so Claude Code must be found the way the installed app will find it; and no USER, LOGNAME or SHELL
# either (launchd sets them, but the app fills them from the account when they are missing, and this proves it).
#
# The app stops itself after 180 s with a failing report (exit 2). The script's own limit is longer and covers what the
# app cannot: a main thread blocked by a system dialog (a keychain or privacy prompt), which a hidden app never shows.
run_self_test() {
  local app="$1" exe="$1/Contents/MacOS/$APP_NAME" out="$REPORT_DIR/self-test.json" errlog="$REPORT_DIR/self-test.stderr.log"
  local code=0 ncode=0 pid ticks=0 tmp="${TMPDIR:-/tmp}" marker
  [ -x "$exe" ] || die "no executable at $exe"
  say "--self-test (Finder-like environment: PATH=/usr/bin:/bin:/usr/sbin:/sbin, no USER, LOGNAME or SHELL; limit ${SELF_TEST_TIMEOUT} s)"
  rm -f "$out"
  marker="$(mktemp "$REPORT_DIR/.self-test-started.XXXXXX")"
  env -i HOME="$HOME" TMPDIR="$tmp" PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG="${LANG:-en_US.UTF-8}" \
    "$exe" --self-test > "$out" 2> "$errlog" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge $((SELF_TEST_TIMEOUT * 2)) ]; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 2
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      # The throwaway profile it made (the app removes it itself only when it finishes).
      find "$tmp" -maxdepth 1 -type d -name 'partzero-self-test-*' -newer "$marker" -exec rm -rf {} + 2>/dev/null || true
      rm -f "$marker"
      die "--self-test did not finish within ${SELF_TEST_TIMEOUT} s, so it was stopped. The app runs hidden: a keychain or privacy prompt it was waiting for would not show. See $errlog"
    fi
    sleep 0.5
    ticks=$((ticks + 1))
  done
  wait "$pid" || code=$?
  rm -f "$marker"
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
    // The app must be the Alpha 0 edition itself, not a bundle of another edition packaged with the alpha config.
    if (r.app.edition !== "alpha-local" || r.app.name !== "PartZero" || r.app.packaged !== true) {
      console.log(`    FAILED: this is ${r.app.name} (edition ${r.app.edition}${r.app.packaged ? "" : ", not packaged"}), not the packaged PartZero alpha-local build`);
      process.exit(3);
    }
  ' "$out" || ncode=$?
  case "$ncode" in
    0) ;;
    3) die "the app at $app is not the PartZero alpha-local build: rebuild it with --build" ;;
    *) die "--self-test printed no report (exit $code; see $errlog)" ;;
  esac
  [ "$code" != 2 ] || die "--self-test did not finish (exit 2): see the reason above; the full report is $out"
  [ "$code" = 0 ] || die "--self-test failed (exit $code); the full report is $out"
  say "self-test passed ($out)"
}

is_running() {
  [ "$(osascript -e "application id \"$BUNDLE_ID\" is running" 2>/dev/null || echo false)" = "true" ]
}

# Asks a running PartZero to quit (an Apple Event, like ⌘Q), and says why when that is refused: macOS asks once
# whether the app running this script may control PartZero (Automation), and PartZero itself may be waiting for an
# answer about unsaved changes.
quit_running_app() {
  is_running || return 0
  say "quitting the running $APP_NAME"
  local err code=0
  err="$(osascript -e 'with timeout of 20 seconds' -e "tell application id \"$BUNDLE_ID\" to quit" -e 'end timeout' 2>&1 >/dev/null)" || code=$?
  if [ "$code" != 0 ]; then
    case "$err" in
      *-1743*) die "macOS did not let this terminal ask $APP_NAME to quit (Automation permission, error -1743). Quit $APP_NAME yourself (⌘Q) and run this again, or allow this terminal app to control $APP_NAME in System Settings → Privacy & Security → Automation (only you change that setting)." ;;
      *-128*) die "$APP_NAME did not quit: the quit was cancelled (a document with unsaved changes?). Save or close it, quit $APP_NAME, and run this again." ;;
      *-1712*) die "$APP_NAME did not answer the request to quit within 20 s (is it asking about unsaved changes?). Answer it or quit $APP_NAME yourself, then run this again." ;;
      *) die "could not ask $APP_NAME to quit (${err:-osascript exit $code}). Quit it yourself (⌘Q) and run this again." ;;
    esac
  fi
  for _ in $(seq 1 60); do
    is_running || return 0
    sleep 0.5
  done
  die "$APP_NAME is still running 30 s after it was asked to quit. Quit it yourself (⌘Q) and run this again."
}

# Runs a file operation on an app bundle ("$1" says what, for the message). When macOS refuses it, says why instead of
# stopping with a bare error: App Management protects app bundles from being changed by other apps.
guarded() {
  local what="$1" err
  shift
  if ! err="$("$@" 2>&1)"; then
    case "$err" in
      *"Operation not permitted"*) die "macOS did not allow this: $what ($err). In /Applications this is usually App Management, which protects apps from being changed by other apps: allow the terminal app you run this from in System Settings → Privacy & Security → App Management (only you change that setting), then run this again." ;;
      *) die "could not $what: $err" ;;
    esac
  fi
}

# The rest of G2b needs the app running (docs/ALPHA-0-PLAN.md §2.3): what to check once it is.
g2b_reminder() {
  say "G2b is still open for this install: the signature and fuses above are its first check. Still to do, on this app:"
  printf '    - with %s open and idle: lsof -nP -i shows no connection from its own processes\n' "$APP_NAME"
  printf '    - once the agent runs (W4): after Stop, ps shows no claude process left from %s; killing the agent worker\n' "$APP_NAME"
  printf '      mid-run shows "The agent process stopped; your document is safe", and the next run works\n'
}

do_install() {
  [ -d "$BUILT_APP" ] || die "nothing to install: $BUILT_APP does not exist (run with --build first)"
  codesign --verify --deep --strict "$BUILT_APP" || die "$BUILT_APP fails codesign --verify; rebuild it"
  [ -d "$INSTALL_DIR" ] || die "$INSTALL_DIR does not exist"
  [ -w "$INSTALL_DIR" ] || die "$INSTALL_DIR is not writable for $(id -un)"
  local target="$INSTALL_DIR/$APP_NAME.app" previous="$BACKUP_DIR/previous" staging="$BACKUP_DIR/moving"
  quit_running_app
  if [ -d "$target" ]; then
    # Moved aside first: if macOS refuses the move, nothing has changed yet (the older backup is still there).
    guarded "create $BACKUP_DIR" mkdir -p "$BACKUP_DIR"
    guarded "remove $staging (left by an interrupted run)" rm -rf "$staging"
    guarded "move $target aside" mv "$target" "$staging"
    guarded "remove the older backup $previous" rm -rf "$previous"
    guarded "keep the old app as $previous" mv "$staging" "$previous"
    say "kept the old app as $previous (roll back with --rollback)"
  fi
  guarded "copy the new app to $target" ditto "$BUILT_APP" "$target"
  if xattr -p com.apple.quarantine "$target" >/dev/null 2>&1; then
    say "note: $target carries a quarantine flag; if macOS blocks it, use System Settings → Privacy & Security → Open Anyway"
  fi
  mkdir -p "$REPORT_DIR"
  check_signature_and_fuses "$target" "$REPORT_DIR/fuses-installed.json"
  say "installed $target. Open it from Applications (the first launch shows the welcome card)."
  g2b_reminder
}

do_rollback() {
  local target="$INSTALL_DIR/$APP_NAME.app" previous="$BACKUP_DIR/previous" undone="$BACKUP_DIR/rolled-back" staging="$BACKUP_DIR/moving"
  [ -d "$previous" ] || die "there is no previous build to roll back to ($previous)"
  quit_running_app
  guarded "remove $staging (left by an interrupted run)" rm -rf "$staging"
  if [ -d "$target" ]; then guarded "move $target aside" mv "$target" "$staging"; fi
  if ! mv "$previous" "$target" 2>/dev/null; then
    # Put the current app back before saying why, so a refused rollback leaves the installed app as it was.
    if [ -d "$staging" ]; then mv "$staging" "$target" || true; fi
    guarded "move $previous to $target" mv "$previous" "$target"
  fi
  if [ -d "$staging" ]; then
    guarded "remove the older rolled-back build $undone" rm -rf "$undone"
    guarded "keep the newer app as $undone" mv "$staging" "$undone"
  fi
  codesign --verify --deep --strict "$target" || die "the restored $target fails codesign --verify"
  say "rolled back: $target is the previous build again (the newer one is kept as $undone)"
}

if [ "$rollback" = 1 ]; then do_rollback; exit 0; fi
mkdir -p "$REPORT_DIR"
if [ "$build" = 1 ]; then do_build; fi
if [ "$selftest" = 1 ] && [ "$build" = 0 ]; then
  [ -d "$BUILT_APP" ] || die "no app at $BUILT_APP (run with --build first, or pass --app <path>)"
  check_app "$BUILT_APP"
fi
if [ "$install" = 1 ]; then do_install; fi
