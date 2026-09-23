import { readFile } from "node:fs/promises";
import { protocol } from "electron";
import { APP_SCHEME, contentTypeFor, resolveAssetPath, SECURITY_HEADERS } from "./protocol-core.js";

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);
}

/** Serve the built app (`@aicad/app` `dist/web`) from `app://aicad/` with COOP/COEP/CSP headers. */
export function serveApp(webRoot: string): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const path = resolveAssetPath(webRoot, request.url);
    if (!path) return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    try {
      const body = await readFile(path);
      return new Response(body, { status: 200, headers: { ...SECURITY_HEADERS, "Content-Type": contentTypeFor(path) } });
    } catch {
      return new Response("Not found", { status: 404, headers: SECURITY_HEADERS });
    }
  });
}
