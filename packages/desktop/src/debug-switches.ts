/**
 * Debugger switches a packaged build refuses to start with (phase 0 audit L8/L13; electron-free,
 * unit-tested).
 *
 * The Electron fuses turn off `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and Node's `--inspect*`
 * arguments, and `webPreferences.devTools: false` turns off the DevTools window, but no fuse covers
 * Chromium's `--remote-debugging-port` / `--remote-debugging-pipe`: with either, any process of the
 * same user can attach over the DevTools protocol, run script in the app page and drive the
 * privileged preload bridge (`window.aicad`: settings, provider keys, granted files). So a packaged
 * build (and an unpackaged run with `AICAD_SIMULATE_PACKAGED=1`) exits at startup when any of these
 * is present, before a window, the agent or the IPC handlers exist.
 */

/** Switch names (without dashes), in the order they are reported. */
export const DEBUG_SWITCHES: readonly string[] = [
  // Chromium: DevTools protocol for every renderer (and the browser process).
  "remote-debugging-port",
  "remote-debugging-pipe",
  "remote-debugging-io-pipes",
  // Node inspector for the main process (also off through the enableNodeCliInspectArguments fuse).
  "inspect",
  "inspect-brk",
  "inspect-brk-node",
  "inspect-port",
  "inspect-wait",
  // Arbitrary V8 flags (e.g. `--allow-natives-syntax`, `--expose-gc`) for every process.
  "js-flags",
];

/**
 * The {@link DEBUG_SWITCHES} present, in list order. `hasSwitch` is Chromium's parser
 * (`app.commandLine.hasSwitch`); `argv` is scanned as well (`-x`, `--x`, `--x=value`, up to a `--`
 * terminator) so that a switch Node parses on its own is not missed. Case-insensitive: refusing too
 * much is safe, starting with a debugger attached is not.
 */
export function forbiddenDebugSwitches(hasSwitch: (name: string) => boolean, argv: readonly string[] = []): string[] {
  const found = new Set(DEBUG_SWITCHES.filter((s) => hasSwitch(s)));
  for (const arg of argv) {
    if (arg === "--") break;
    const m = /^--?([^=]+)/.exec(arg);
    const name = m?.[1]?.toLowerCase();
    if (name !== undefined && DEBUG_SWITCHES.includes(name)) found.add(name);
  }
  return DEBUG_SWITCHES.filter((s) => found.has(s));
}

/** The startup error for {@link forbiddenDebugSwitches}' result. */
export function debugSwitchRefusal(switches: readonly string[]): string {
  return `refusing to start: ${switches.map((s) => `--${s}`).join(", ")} would let another process debug this app and drive its privileged bridge; packaged builds do not accept debugger switches`;
}
