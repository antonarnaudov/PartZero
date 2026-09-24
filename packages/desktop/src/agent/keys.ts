/**
 * API keys (bring your own) for the design agent. SECURITY RULES:
 *
 * - Keys entered in Settings are encrypted with Electron `safeStorage` (macOS Keychain, Windows
 *   DPAPI, Linux libsecret/kwallet) and only the ciphertext is written, to
 *   `<userData>/agent-keys.json` (mode 0600). If the OS offers no real encryption (Linux
 *   `basic_text` backend) keys are refused rather than stored weakly.
 * - Plaintext keys live only in main-process memory while a run starts, and in the agent utility
 *   process for the duration of a run. They are never logged, never written anywhere else and never
 *   sent to the renderer: it sees `configured`, the source and the last four characters.
 * - In development, keys can also come from the environment or the repo-root `.env` (gitignored).
 *   Precedence: Settings (keychain) → environment → `.env`.
 * - Keys are optional (ADR 0014): CLI agents run on the user's own login and local models need none.
 *   Only API-key providers (`ApiProviderId`) have keys; CLI credentials are never read.
 * - No keychain access until a key is stored (docs/ALPHA-0-PLAN.md W1, as10): on macOS every `safeStorage` call reads
 *   or creates the app's "Safe Storage" keychain item, and an ad-hoc signed build (a new signature after every
 *   rebuild) is then asked for the login password. So a store without a key file never probes the cipher when the
 *   cipher says a probe may prompt ({@link Cipher.probeMayPrompt}); the probe runs when the first key is saved.
 * - A build can turn API keys off altogether (`build-info.ts` `flags.apiKeys`, the Alpha 0 build): then the store
 *   never reads its file or touches the cipher, and saving a key is refused.
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ApiProviderId as ProviderId, KeySource } from "@aicad/app/bridge";
import { PROVIDER_IDS } from "./protocol.js";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** Environment variables read in development, in order. */
  envVars: readonly string[];
  keyRequired: boolean;
}

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: "anthropic", label: "Anthropic", envVars: ["ANTHROPIC_API_KEY"], keyRequired: true },
  { id: "openai", label: "OpenAI", envVars: ["OPENAI_API_KEY"], keyRequired: true },
  { id: "google", label: "Google Gemini", envVars: ["GEMINI_API_KEY", "GOOGLE_API_KEY"], keyRequired: true },
  { id: "openai-compat", label: "OpenAI-compatible", envVars: ["OPENAI_COMPAT_API_KEY"], keyRequired: false },
];

export function providerInfo(id: ProviderId): ProviderInfo {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
}

/** Last four characters, only for keys long enough that this reveals little. */
export function last4(key: string): string | null {
  return key.length >= 16 ? key.slice(-4) : null;
}

/**
 * A minimal `.env` parser: `KEY=value`, optional `export `, `#` comments, single/double quotes.
 * No variable expansion, no multi-line values.
 */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2]!.trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.length >= 2 && value.endsWith(q)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    out[m[1]!] = value;
  }
  return out;
}

/** Keys found in a variable map, per provider (first non-empty variable wins). */
export function keysFromVariables(vars: Readonly<Record<string, string | undefined>>): Partial<Record<ProviderId, string>> {
  const out: Partial<Record<ProviderId, string>> = {};
  for (const p of PROVIDERS) {
    for (const name of p.envVars) {
      const v = vars[name]?.trim();
      if (v) {
        out[p.id] = v;
        break;
      }
    }
  }
  return out;
}

// ─── Encrypted store ───────────────────────────────────────────────────────────────────────

/** The subset of Electron `safeStorage` the store needs (injectable for tests). */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux: `basic_text` | `gnome_libsecret` | `kwallet*` …; elsewhere the OS store name. */
  backend(): string;
  /**
   * Whether asking {@link isEncryptionAvailable} may itself show an OS prompt (macOS: it reads or creates the app's
   * keychain item). Then the store probes only once a key file exists or a key is being saved.
   */
  probeMayPrompt?: boolean;
}

/** Why saving a key is refused in a build without API keys. */
export const API_KEYS_OFF_DETAIL = "API keys are turned off in this build: the agent runs on a CLI agent you are logged into (Claude Code), with no key.";

interface StoredKey {
  ciphertext: string;
  last4: string | null;
  savedAt: string;
}

interface KeyFile {
  v: 1;
  keys: Partial<Record<ProviderId, StoredKey>>;
}

export class KeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyStoreError";
  }
}

export interface KeyStoreOptions {
  /** False: API keys are off in this build (never read, never stored, no keychain access). Default true. */
  enabled?: boolean;
}

export class KeyStore {
  readonly file: string;
  /** Whether this build takes API keys at all (`build-info.ts` `flags.apiKeys`). */
  readonly enabled: boolean;
  readonly #cipher: Cipher;
  #data: KeyFile;

  constructor(file: string, cipher: Cipher, options: KeyStoreOptions = {}) {
    this.file = file;
    this.enabled = options.enabled ?? true;
    this.#cipher = cipher;
    this.#data = this.enabled ? KeyStore.#read(file) : { v: 1, keys: {} };
  }

  static #read(file: string): KeyFile {
    try {
      if (!existsSync(file)) return { v: 1, keys: {} };
      const j = JSON.parse(readFileSync(file, "utf8")) as Partial<KeyFile>;
      const keys: KeyFile["keys"] = {};
      for (const id of PROVIDER_IDS) {
        const k = j.keys?.[id];
        if (k && typeof k.ciphertext === "string") keys[id] = { ciphertext: k.ciphertext, last4: typeof k.last4 === "string" ? k.last4 : null, savedAt: String(k.savedAt ?? "") };
      }
      return { v: 1, keys };
    } catch {
      return { v: 1, keys: {} };
    }
  }

  /**
   * Whether keys can be stored securely on this machine, and how (the Settings view). Touches the cipher only when
   * that cannot prompt, or when keys are already stored (see the file header).
   */
  secureStorage(): { available: boolean; detail: string } {
    if (!this.enabled) return { available: false, detail: API_KEYS_OFF_DETAIL };
    if (this.#cipher.probeMayPrompt === true && Object.keys(this.#data.keys).length === 0 && !existsSync(this.file)) {
      return { available: true, detail: "Keys you save are encrypted with the OS keychain." };
    }
    return this.#probe();
  }

  /** The cipher's real answer (may read the keychain). */
  #probe(): { available: boolean; detail: string } {
    let available = false;
    let backend = "unknown";
    try {
      available = this.#cipher.isEncryptionAvailable();
      backend = this.#cipher.backend();
    } catch {
      available = false;
    }
    if (!available) return { available: false, detail: "OS-level encryption is not available; use environment variables instead." };
    if (backend === "basic_text") return { available: false, detail: "No OS keyring (libsecret/kwallet) found; keys would only be obfuscated, so they are not stored. Use environment variables instead." };
    return { available: true, detail: `Encrypted with the OS keychain (${backend}).` };
  }

  has(provider: ProviderId): boolean {
    return this.#data.keys[provider] !== undefined;
  }

  last4(provider: ProviderId): string | null {
    return this.#data.keys[provider]?.last4 ?? null;
  }

  set(provider: ProviderId, key: string): void {
    if (!this.enabled) throw new KeyStoreError(API_KEYS_OFF_DETAIL);
    const s = this.#probe();
    if (!s.available) throw new KeyStoreError(`Cannot store the key securely: ${s.detail}`);
    const ciphertext = this.#cipher.encryptString(key).toString("base64");
    this.#data = { v: 1, keys: { ...this.#data.keys, [provider]: { ciphertext, last4: last4(key), savedAt: new Date().toISOString() } } };
    this.#write();
  }

  clear(provider: ProviderId): void {
    if (!this.has(provider)) return;
    const keys = { ...this.#data.keys };
    delete keys[provider];
    this.#data = { v: 1, keys };
    this.#write();
  }

  /** Decrypt a stored key (main process only). Undefined when none is stored or it cannot be decrypted. */
  get(provider: ProviderId): string | undefined {
    const k = this.#data.keys[provider];
    if (!k) return undefined;
    try {
      return this.#cipher.decryptString(Buffer.from(k.ciphertext, "base64"));
    } catch {
      return undefined;
    }
  }

  #write(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      // best effort (Windows)
    }
  }
}

// ─── Resolution: keychain → env → .env ─────────────────────────────────────────────────────

export interface ResolvedKey {
  key: string | undefined;
  source: KeySource | null;
  last4: string | null;
}

export class KeyResolver {
  readonly store: KeyStore;
  readonly #env: Partial<Record<ProviderId, string>>;
  readonly #dotenv: Partial<Record<ProviderId, string>>;

  constructor(store: KeyStore, env: Partial<Record<ProviderId, string>> = {}, dotenv: Partial<Record<ProviderId, string>> = {}) {
    this.store = store;
    this.#env = env;
    this.#dotenv = dotenv;
  }

  /** Status without decrypting (no keychain access): for the settings view. */
  status(provider: ProviderId): Omit<ResolvedKey, "key"> {
    if (this.store.has(provider)) return { source: "keychain", last4: this.store.last4(provider) };
    const e = this.#env[provider];
    if (e) return { source: "env", last4: last4(e) };
    const d = this.#dotenv[provider];
    if (d) return { source: "dotenv", last4: last4(d) };
    return { source: null, last4: null };
  }

  /** The effective key (decrypts a stored key). */
  resolve(provider: ProviderId): ResolvedKey {
    const st = this.status(provider);
    if (st.source === "keychain") {
      const key = this.store.get(provider);
      if (key) return { key, ...st };
      // Undecryptable (keychain reset, other machine): fall through to env / .env.
    }
    const e = this.#env[provider];
    if (e) return { key: e, source: "env", last4: last4(e) };
    const d = this.#dotenv[provider];
    if (d) return { key: d, source: "dotenv", last4: last4(d) };
    return { key: undefined, source: null, last4: null };
  }
}
