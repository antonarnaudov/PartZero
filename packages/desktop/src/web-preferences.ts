/**
 * `webPreferences` of the main window (electron-free, unit-tested): sandboxed, context-isolated, no
 * Node in the renderer, and DevTools only in unpackaged runs. In a packaged build a DevTools
 * console would put the preload bridge (file access, the agent, settings) one social-engineering
 * paste away.
 */
export interface MainWindowPreferences {
  preload: string;
  contextIsolation: true;
  nodeIntegration: false;
  sandbox: true;
  webSecurity: true;
  spellcheck: false;
  devTools: boolean;
}

export function mainWindowWebPreferences(preload: string, devTools: boolean): MainWindowPreferences {
  return { preload, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false, devTools };
}
