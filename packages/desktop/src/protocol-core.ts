/**
 * The `app://aicad/` protocol, electron-free part: URL → file resolution (no escaping the web
 * root), content types, and the security headers every response carries.
 *
 * COOP + COEP make the renderer cross-origin isolated, so SharedArrayBuffer (and WASM threads for
 * Forge) are available. The CSP allows only same-origin code, WASM compilation and inline styles
 * (Monaco sets element styles).
 */
import { extname, normalize, resolve, sep } from "node:path";

export const APP_SCHEME = "app";
export const APP_HOST = "aicad";
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;
export const APP_ENTRY_URL = `${APP_ORIGIN}/index.html`;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Map an `app://aicad/...` URL to a file under `root`, or null when the URL is for another host,
 * is malformed, or would escape the root (`..`, encoded separators, absolute paths).
 */
export function resolveAssetPath(root: string, requestUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  // Encoded separators or dot segments (`..%2f`) survive URL normalization: reject them outright.
  if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes("..")) return null;
  if (pathname === "/" || pathname === "") pathname = "/index.html";
  const base = resolve(root);
  const full = resolve(base, `.${normalize(pathname)}`);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}
