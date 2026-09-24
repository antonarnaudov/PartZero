/**
 * Scrubbing for recorded CLI fixtures: session ids, uuids, message and tool-use ids become stable
 * placeholders; workspace and home paths are replaced; plan-usage numbers are normalized; identity
 * keys are dropped. Used when recording (AICAD_RECORD_FIXTURES=claude); the recorded files are reviewed
 * before they are committed.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY_KEYS = new Set(["email", "orgId", "orgName", "organization", "account", "accountUuid", "organizationUuid", "userId", "user_id"]);

export class Scrubber {
  readonly #map = new Map<string, string>();
  readonly #paths: [string, string][];
  readonly #secrets: string[];
  #n = { uuid: 0, msg: 0, toolu: 0, req: 0 };

  constructor(paths: [string, string][], secrets: string[]) {
    // Longest first so nested paths are replaced before their parents.
    this.#paths = [...paths].filter(([p]) => p.length > 0).sort((a, b) => b[0].length - a[0].length);
    this.#secrets = secrets.filter((s) => s.length > 0);
  }

  #id(v: string): string {
    const hit = this.#map.get(v);
    if (hit) return hit;
    let out: string;
    if (v.startsWith("toolu_")) out = `toolu_${String(++this.#n.toolu).padStart(4, "0")}`;
    else if (v.startsWith("msg_")) out = `msg_${String(++this.#n.msg).padStart(4, "0")}`;
    else if (v.startsWith("req_")) out = `req_${String(++this.#n.req).padStart(4, "0")}`;
    else out = `00000000-0000-4000-8000-${String(++this.#n.uuid).padStart(12, "0")}`;
    this.#map.set(v, out);
    return out;
  }

  #string(s: string): string {
    for (const secret of this.#secrets) if (s.includes(secret)) throw new Error("a secret reached the recorded output");
    if (UUID.test(s) || /^(toolu|msg|req)_[A-Za-z0-9]+$/.test(s)) return this.#id(s);
    let out = s;
    for (const [p, r] of this.#paths) out = out.split(p).join(r);
    return out;
  }

  value(v: unknown, key = ""): unknown {
    if (typeof v === "string") {
      if (key === "signature") return "<signature>"; // opaque, embeds request ids
      // Keep where the socket went (inside <root> or not), not the pid or the uid.
      if (key === "messaging_socket_path") return this.#string(v).replace(/cc-socks-\d+/, "cc-socks-<uid>").replace(/\/\d+\.sock$/, "/<pid>.sock");
      if (key === "timestamp") return "2026-01-01T00:00:00.000Z";
      return this.#string(v);
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (typeof v !== "object" || v === null) {
      if (typeof v === "number" && /resetsAt/i.test(key)) return 1_790_000_000;
      if (typeof v === "number" && /utilization/i.test(key)) return 0.1;
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (IDENTITY_KEYS.has(k)) continue;
      out[this.#string(k)] = this.value(x, k);
    }
    return out;
  }

  line(line: string): string {
    return JSON.stringify(this.value(JSON.parse(line)));
  }
}
