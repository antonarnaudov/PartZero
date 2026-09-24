/**
 * Scrubbing for recorded Claude Code stream-json (live smoke → offline fixtures): uuids, session,
 * message and tool-use ids become stable placeholders; workspace, temp and home paths are replaced;
 * thinking signatures, timestamps and plan-usage numbers are normalized; identity keys are dropped.
 * A known secret (the MCP ticket) reaching the output throws. Review the files before committing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTITY_KEYS = new Set(["email", "orgId", "orgName", "organization", "account", "accountUuid", "organizationUuid", "userId", "user_id"]);

export class Scrubber {
  readonly #map = new Map<string, string>();
  readonly #paths: Array<[string, string]>;
  readonly #secrets: string[];
  readonly #n = { uuid: 0, msg: 0, toolu: 0, req: 0 };

  constructor(paths: Array<[string, string]>, secrets: string[] = []) {
    this.#paths = paths.filter(([p]) => p.length > 0).sort((a, b) => b[0].length - a[0].length);
    this.#secrets = secrets.filter((s) => s.length >= 8);
  }

  #id(v: string): string {
    const hit = this.#map.get(v);
    if (hit !== undefined) return hit;
    const pad = (n: number) => String(n).padStart(4, "0");
    const out = v.startsWith("toolu_")
      ? `toolu_${pad(++this.#n.toolu)}`
      : v.startsWith("msg_")
        ? `msg_${pad(++this.#n.msg)}`
        : v.startsWith("req_")
          ? `req_${pad(++this.#n.req)}`
          : `00000000-0000-4000-8000-${String(++this.#n.uuid).padStart(12, "0")}`;
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
      if (key === "signature") return "<signature>";
      if (key === "timestamp") return "2026-01-01T00:00:00.000Z";
      return this.#string(v);
    }
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (typeof v !== "object" || v === null) {
      if (typeof v === "number" && /resetsAt/i.test(key)) return 1_790_000_000;
      if (typeof v === "number" && /utilization/i.test(key)) return 10;
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
