/**
 * The design host for external MCP clients (ARCHITECTURE §9; CLI-PROVIDERS.md §6.7): one user document,
 * served to any number of clients, each on its own `mcp/<client>` branch.
 *
 * - **Branches.** A client's edits land on `mcp/<client-name>`: a `DesignSession` opened from the
 *   document's source. The document itself never changes here; `propose` hands the branch to the host
 *   (`onProposal`: the review UI, or the headless proposal file). A second concurrent client with the
 *   same name gets `mcp/<name>-2`.
 * - **Branches are a convenience, not a security boundary.** The name comes from the client's own MCP
 *   `clientInfo`. On a direct transport ({@link DesignHost.backend} without a key) a client that reports
 *   the name of a client that has disconnected gets that branch back, edits included. Hosts that need
 *   isolation key the branch: {@link DesignHost.handler} (desktop bridge) keys it to its broker by
 *   default, and {@link DesignHostHandler.close} releases it when the broker is disposed. Nothing on
 *   any branch reaches the document without the user's review.
 * - **Scopes.** `ext-read` (read tools), `ext-edit` (read + edit tools, without `ask_user`: the external
 *   agent talks to its own user), `ext-export` (`export_design`, only inside the export directory).
 * - **Resources.** `cad://doc/{id}/code | ir-summary | spec | tests`, read from the client's branch;
 *   offered only with `ext-read` or `ext-edit`.
 * - **Gating and limits.** Tool calls and resource reads pass the same gates: `close(reason)` refuses
 *   every later request; `gate()` can refuse any (resource reads as `resources/read`); per-connection
 *   call cap and calls-per-minute window (reads count); argument size; handler timeout (from when the
 *   work starts). Requests on one branch run one at a time (the session is not re-entrant); one that
 *   waits longer than the handler timeout behind an earlier one is dropped, never run late.
 * - **Filesystem.** None, except new files in the export directory (`export-dir.ts`) and whatever the
 *   host's `onProposal` writes (headless: the proposal file).
 */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  defineTool,
  designRegistry,
  DesignSession,
  evalModeAnswers,
  irSummary,
  ToolRegistry,
  type DesignToolContext,
  type Proposal,
  type ToolData,
  type ToolOutput,
} from "@aicad/agent-tools";
import type { Engine } from "@aicad/evals";
import { closedText, HOST_UNAVAILABLE_TEXT, type BrokerTool } from "../bridge-protocol.js";
import { JSONRPC_METHOD_NOT_FOUND } from "../jsonrpc.js";
import {
  MCP_REQUEST_REFUSED,
  McpRequestError,
  type McpBackend,
  type McpClientInfo,
  type McpResource,
  type McpResourceContents,
  type McpResourceTemplate,
  type McpServerInfo,
  type McpToolRequest,
} from "../mcp.js";
import { EXPORT_TOOL, registryToolDefs, scopeToolNames } from "../scopes.js";
import { toBrokerTools } from "../tools.js";
import type { McpCallControl, McpToolCall, McpToolDef, McpToolResult } from "../types.js";
import { MCP_SERVER_VERSION } from "../version.js";
import { ExportError, openExportDir, type ExportDir } from "./export-dir.js";

export type ExternalScope = "ext-read" | "ext-edit" | "ext-export";

export interface DesignHostLimits {
  /** Tool calls and resource reads per connection. */
  maxCalls: number;
  maxArgBytes: number;
  /** Sliding one-minute window per connection (resource reads count). */
  maxCallsPerMinute: number;
  /** Per request, from when it starts on its branch; also the longest it may wait for the branch. */
  handlerTimeoutMs: number;
}

export const DEFAULT_DESIGN_HOST_LIMITS: Readonly<DesignHostLimits> = Object.freeze({
  maxCalls: 1_000,
  maxArgBytes: 262_144,
  maxCallsPerMinute: 60,
  handlerTimeoutMs: 120_000,
});

export interface BranchProposal {
  branch: string;
  client: McpClientInfo | null;
  /** The branch's CadScript at the time of the proposal. */
  source: string;
  proposal: Proposal;
  /** The branch verified (L0–L2) when it was proposed. */
  verified: boolean;
}

export interface DesignHostOptions {
  engine: Engine;
  /** The user's document (CadScript). Clients never change it. Default: empty. */
  source?: string;
  /** Resource id in `cad://doc/{id}/…`: `[A-Za-z0-9_-]{1,64}`. */
  docId: string;
  scopes: readonly ExternalScope[];
  /** Required with `ext-export`. */
  exportDir?: string;
  limits?: Partial<DesignHostLimits>;
  /** Runs on every new branch session (e.g. set and freeze the document's spec tests). */
  seed?(session: DesignSession): void | Promise<void>;
  /** A client proposed its branch. The returned text (if any) is appended to the tool result. */
  onProposal?(proposal: BranchProposal): string | void | Promise<string | void>;
  /**
   * Where `onProposal` records proposals, as the instructions tell the client (e.g. "part.proposal.cad.ts
   * next to the document"). Default: the user reviews them in the app.
   */
  proposalDestination?: string;
  /** Refuse a request: return the reason shown to the model, or null to allow. Resource reads come as `resources/read`. */
  gate?(call: { client: McpClientInfo | null; branch: string; name: string }): string | null | undefined;
  clock?: () => number;
}

/** A broker handler bound to one client's branch (see {@link DesignHost.handler}). */
export interface DesignHostHandler {
  (call: McpToolCall, control?: McpCallControl): Promise<McpToolResult>;
  /** Release the client's branch (call when the broker is disposed). Later calls get the unavailable text. */
  close(): void;
}

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RESOURCE_VIEWS = ["code", "ir-summary", "spec", "tests"] as const;
type ResourceView = (typeof RESOURCE_VIEWS)[number];

/** The name `gate()` sees for a resource read. */
export const RESOURCE_READ_GATE_NAME = "resources/read";

const EXPORT_FORMATS = { cadscript: ".cad.ts", ir: ".ir.json", report: ".metrics.json" } as const;

interface ExportContext {
  session: DesignSession;
  dir: ExportDir;
}

const exportDesign = defineTool({
  name: EXPORT_TOOL,
  description:
    "Write the current design of your branch into the export directory the user chose: `cadscript` (the .cad.ts source), `ir` (the Feature-Graph IR as JSON) or `report` (the engine's metrics JSON). Creates a new file; never overwrites one.",
  input: z.strictObject({
    format: z.enum(["cadscript", "ir", "report"]).describe("What to write."),
    name: z.string().describe("Bare file name without directory or extension, e.g. 'bracket-v2'."),
  }),
  async run(input, { session, dir }: ExportContext): Promise<ToolOutput> {
    const ext = EXPORT_FORMATS[input.format];
    let content: string;
    if (input.format === "cadscript") {
      if (session.source.trim() === "") return { text: "Nothing to export: the branch is empty.", isError: true };
      content = session.source;
    } else if (input.format === "ir") {
      if (!session.ir) return { text: "Nothing to export: the current source does not compile.", isError: true };
      content = JSON.stringify(session.ir, null, 1) + "\n";
    } else {
      if (!session.report) return { text: "Nothing to export: there is no evaluation report (the current source does not compile or evaluate).", isError: true };
      content = JSON.stringify(session.report, null, 1) + "\n";
    }
    try {
      const file = await dir.write(input.name, ext, content);
      return { text: `Exported ${input.format} to ${file} in the export directory.`, data: { kind: "export", file, format: input.format } };
    } catch (e) {
      if (e instanceof ExportError) return { text: e.message, isError: true };
      throw e;
    }
  },
});

function exportRegistry(): ToolRegistry<ExportContext> {
  return new ToolRegistry<ExportContext>([exportDesign]);
}

/** `mcp/<slug>` from a client name: lowercase letters, digits and dashes, ≤ 40. */
export function branchSlug(name: string | undefined): string {
  const slug = (name ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? "client" : slug;
}

interface Branch {
  name: string;
  session: DesignSession;
  active: boolean;
  /** Who may take the branch back once it is released: a connection key, or null (by client name). */
  owner: string | null;
  /** Serializes requests on this branch. */
  tail: Promise<unknown>;
}

type Result = { text: string; isError: boolean };

type Admitted = { ok: true; branch: Branch } | { ok: false; text: string };

export class DesignHost {
  readonly docId: string;
  readonly scopes: readonly ExternalScope[];
  readonly #o: DesignHostOptions;
  readonly #limits: DesignHostLimits;
  readonly #exportDir: ExportDir | null;
  readonly #designTools = designRegistry();
  readonly #exportTools = exportRegistry();
  readonly #toolNames: ReadonlySet<string>;
  readonly #tools: BrokerTool[];
  readonly #branches = new Map<string, Branch>();
  #closed: string | null = null;
  #attachTail: Promise<unknown> = Promise.resolve();

  private constructor(options: DesignHostOptions, exportDir: ExportDir | null) {
    this.#o = options;
    this.docId = options.docId;
    this.scopes = [...new Set(options.scopes)].sort();
    this.#limits = { ...DEFAULT_DESIGN_HOST_LIMITS, ...options.limits };
    this.#exportDir = exportDir;
    const designNames = new Set<string>();
    const defs: McpToolDef[] = [];
    for (const s of this.scopes) {
      if (s === "ext-export") continue;
      for (const n of scopeToolNames(s)) designNames.add(n);
    }
    defs.push(...registryToolDefs(this.#designTools, [...designNames]));
    if (this.scopes.includes("ext-export")) defs.push(...this.#exportTools.defs().map((d) => ({ ...d, readOnly: false })));
    defs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    this.#tools = toBrokerTools(defs);
    this.#toolNames = new Set(this.#tools.map((t) => t.name));
  }

  /** Validates the options (doc id, scopes, export directory). */
  static async create(options: DesignHostOptions): Promise<DesignHost> {
    if (!DOC_ID.test(options.docId)) throw new Error(`doc id must match ${DOC_ID}`);
    if (options.scopes.length === 0) throw new Error("give at least one scope");
    for (const s of options.scopes) if (s !== "ext-read" && s !== "ext-edit" && s !== "ext-export") throw new Error(`unknown external scope ${String(s)}`);
    let dir: ExportDir | null = null;
    if (options.scopes.includes("ext-export")) {
      if (!options.exportDir) throw new Error("the ext-export scope needs an export directory");
      dir = await openExportDir(options.exportDir);
    }
    return new DesignHost(options, dir);
  }

  /** The tools every client of this host sees. */
  get tools(): readonly BrokerTool[] {
    return this.#tools;
  }

  /** Resources are offered only to scopes that may read the design (`ext-read`, `ext-edit`). */
  get offersResources(): boolean {
    return this.scopes.includes("ext-read") || this.scopes.includes("ext-edit");
  }

  get closedReason(): string | null {
    return this.#closed;
  }

  /** Refuse every later request (tool calls and resource reads) on every branch. */
  close(reason: string): void {
    this.#closed ??= reason;
  }

  branchNames(): string[] {
    return [...this.#branches.keys()].sort();
  }

  /** A branch's session (the host's review UI reads it). */
  branch(name: string): DesignSession | undefined {
    return this.#branches.get(name)?.session;
  }

  /**
   * A backend for one client connection (initialize assigns its branch). Without a `key` a released
   * branch goes back to the next client that reports the same name (a convenience, not isolation);
   * with one, only to a connection with the same key.
   */
  backend(options: { key?: string } = {}): McpBackend {
    return new ClientBackend(this, options.key ?? null);
  }

  /**
   * A broker handler serving one bridge client from this host (the desktop app's external mode): open
   * the broker with `tools: host.tools`, pass `() => broker.client`, and call `handler.close()` when the
   * broker is disposed so the branch is released. The branch is chosen on the first call (the bridge
   * `hello` always precedes calls) and keyed to this handler: another broker never gets it back, however
   * its client names itself. Pass a stable `key` to hand the same branch to a later broker on purpose.
   * Resources need a direct MCP transport.
   */
  handler(getClient: () => McpClientInfo | null, options: { key?: string } = {}): DesignHostHandler {
    const backend = new ClientBackend(this, options.key ?? `broker:${randomUUID()}`);
    let ready: Promise<McpServerInfo> | null = null;
    let closed = false;
    const run = async (call: McpToolCall): Promise<McpToolResult> => {
      if (closed) return { text: HOST_UNAVAILABLE_TEXT, isError: true };
      // A failed start is not cached: the next call tries again.
      ready ??= backend.initialize(getClient()).catch((e: unknown) => {
        ready = null;
        throw e;
      });
      try {
        await ready;
      } catch {
        return { text: "The CAD host could not open a branch for this session; try again.", isError: true };
      }
      return backend.callTool({ name: call.name, args: call.args, toolUseId: call.toolUseId });
    };
    return Object.assign(run, {
      close(): void {
        closed = true;
        backend.close();
      },
    });
  }

  // ── Internals used by ClientBackend ──

  get limits(): DesignHostLimits {
    return this.#limits;
  }
  get options(): DesignHostOptions {
    return this.#o;
  }
  now(): number {
    return this.#o.clock?.() ?? Date.now();
  }
  hasTool(name: string): boolean {
    return this.#toolNames.has(name);
  }

  /** Assign a client its branch (serialized: two clients with one name never share a branch). */
  attach(client: McpClientInfo | null, owner: string | null): Promise<Branch> {
    const next = this.#attachTail.then(() => this.#attach(client, owner));
    this.#attachTail = next.catch(() => undefined);
    return next;
  }

  async #attach(client: McpClientInfo | null, owner: string | null): Promise<Branch> {
    const slug = branchSlug(client?.name);
    for (let i = 1; ; i++) {
      const name = `mcp/${slug}${i === 1 ? "" : `-${i}`}`;
      const existing = this.#branches.get(name);
      if (existing) {
        if (existing.active || existing.owner !== owner) continue;
        existing.active = true;
        return existing;
      }
      const session = await DesignSession.open({ engine: this.#o.engine, source: this.#o.source ?? "", name: slug });
      await this.#o.seed?.(session);
      const b: Branch = { name, session, active: true, owner, tail: Promise.resolve() };
      this.#branches.set(name, b);
      return b;
    }
  }

  instructions(branch: string): string {
    const edit = this.scopes.includes("ext-edit");
    const exporting = this.scopes.includes("ext-export");
    const review = this.#o.proposalDestination ? `The host writes each proposal to ${this.#o.proposalDestination} for the user's review.` : "The user reviews proposals in the app.";
    const lines = [
      `CAD tools for the document "${this.docId}". You work on the branch ${branch}.`,
      edit
        ? `Every edit (apply_cadscript) is compiled and evaluated by the real engine and verified (L0 compile, L1 kernel, L2 your expect checks, L3 spec tests). Nothing reaches the user's document until they accept your proposal: finish with propose. ${review}`
        : exporting && !this.offersResources
          ? "This session can only export the design: export_design."
          : "This session is read-only: get_code, ir_summary, measure and run_tests.",
    ];
    if (this.offersResources) lines.push(`Resources: cad://doc/${this.docId}/code, ir-summary, spec and tests (your branch's current state).`);
    lines.push(
      exporting
        ? "You have no file access, except export_design, which creates new files in the export directory the user chose."
        : "You have no file access.",
    );
    return lines.join("\n");
  }

  async execute(branch: Branch, client: McpClientInfo | null, request: McpToolRequest): Promise<Result> {
    if (request.name === EXPORT_TOOL) {
      const out = await this.#exportTools.execute({ name: request.name, input: request.args }, { session: branch.session, dir: this.#exportDir! });
      return { text: out.text, isError: out.isError === true };
    }
    const ctx: DesignToolContext = {
      session: branch.session,
      askUser: evalModeAnswers(),
      ...(this.scopes.includes("ext-edit") ? {} : { readOnly: true }),
    };
    const out: ToolOutput & { data?: ToolData } = await this.#designTools.execute({ ...(request.toolUseId ? { id: request.toolUseId } : {}), name: request.name, input: request.args }, ctx);
    if (request.name === "propose" && out.isError !== true && out.data?.kind === "propose") {
      const proposal = out.data["proposal"] as Proposal;
      const verified = branch.session.verification.ok;
      let note: string | void = undefined;
      try {
        note = await this.#o.onProposal?.({ branch: branch.name, client, source: branch.session.source, proposal, verified });
      } catch {
        return { text: "The proposal could not be recorded by the host; try propose again later.", isError: true };
      }
      const text = [
        `Proposal recorded for review on branch ${branch.name} (${verified ? "model verified" : "model NOT verified"}). The user's document changes only when they accept it in the app.`,
        ...(typeof note === "string" && note !== "" ? [note] : []),
      ].join("\n");
      return { text, isError: false };
    }
    return { text: out.text, isError: out.isError === true };
  }

  resourceList(): McpResource[] {
    const base = `cad://doc/${this.docId}`;
    return [
      { uri: `${base}/code`, name: "code", title: "CadScript source", description: "The branch's current CadScript file.", mimeType: "text/typescript" },
      { uri: `${base}/ir-summary`, name: "ir-summary", title: "Feature summary", description: "Every feature with its key parameters and latest result.", mimeType: "text/plain" },
      { uri: `${base}/spec`, name: "spec", title: "Design spec", description: "The frozen DesignSpec (null when there is none).", mimeType: "application/json" },
      { uri: `${base}/tests`, name: "tests", title: "Spec tests", description: "The spec tests and their results on the current model.", mimeType: "application/json" },
    ];
  }

  resourceTemplates(): McpResourceTemplate[] {
    return [{ uriTemplate: "cad://doc/{id}/{view}", name: "document view", description: `view: ${RESOURCE_VIEWS.join(" | ")}`, mimeType: "text/plain" }];
  }

  /** One view of a branch. Callers serialize it with the branch's other requests (`tests` runs the spec tests). */
  readResource(branch: Branch, uri: string): McpResourceContents[] | null {
    const m = /^cad:\/\/doc\/([^/]+)\/([a-z-]+)$/.exec(uri);
    if (!m || m[1] !== this.docId || !(RESOURCE_VIEWS as readonly string[]).includes(m[2]!)) return null;
    const s = branch.session;
    const view = m[2] as ResourceView;
    switch (view) {
      case "code":
        return [{ uri, mimeType: "text/typescript", text: s.source }];
      case "ir-summary": {
        const text = s.ir ? irSummary(s.ir, s.report) : s.source.trim() === "" ? "Nothing has been applied yet." : "The current source does not compile.";
        return [{ uri, mimeType: "text/plain", text }];
      }
      case "spec":
        return [{ uri, mimeType: "application/json", text: JSON.stringify(s.spec ?? null, null, 1) }];
      case "tests":
        return [{ uri, mimeType: "application/json", text: JSON.stringify({ tests: s.tests, results: s.runTests() ?? null }, null, 1) }];
    }
  }
}

class ClientBackend implements McpBackend {
  readonly #host: DesignHost;
  readonly #owner: string | null;
  #branch: Branch | null = null;
  #client: McpClientInfo | null = null;
  #calls = 0;
  #window: number[] = [];
  #ended = false;

  constructor(host: DesignHost, owner: string | null) {
    this.#host = host;
    this.#owner = owner;
  }

  async initialize(client: McpClientInfo | null): Promise<McpServerInfo> {
    this.#client = client;
    const branch = await this.#host.attach(client, this.#owner);
    if (this.#ended) {
      branch.active = false; // closed while the branch was being opened
      throw new Error("the connection closed");
    }
    this.#branch = branch;
    return { version: MCP_SERVER_VERSION, instructions: this.#host.instructions(branch.name), tools: this.#host.tools, resources: this.#host.offersResources };
  }

  /** The branch this connection works on (after initialize). */
  get branchName(): string | null {
    return this.#branch?.name ?? null;
  }

  /** Closed host, ended connection, then the host's gate. */
  #preflight(name: string): Admitted {
    const host = this.#host;
    if (host.closedReason !== null) return { ok: false, text: closedText(host.closedReason) };
    const branch = this.#branch;
    if (!branch || this.#ended) return { ok: false, text: HOST_UNAVAILABLE_TEXT };
    const refusal = host.options.gate?.({ client: this.#client, branch: branch.name, name });
    if (typeof refusal === "string" && refusal !== "") return { ok: false, text: `Refused by the host: ${refusal}` };
    return { ok: true, branch };
  }

  /** The per-connection call cap and the per-minute window; counts the request when it passes. */
  #count(): string | null {
    const host = this.#host;
    const L = host.limits;
    if (this.#calls >= L.maxCalls) return `Not executed: this session reached its limit of ${L.maxCalls} tool calls (resource reads count too). Start a new session.`;
    const now = host.now();
    this.#window = this.#window.filter((t) => now - t < 60_000);
    if (this.#window.length >= L.maxCallsPerMinute) {
      const waitS = Math.ceil((60_000 - (now - this.#window[0]!)) / 1000);
      return `Not executed: rate limit of ${L.maxCallsPerMinute} tool calls per minute (resource reads count too). Retry in about ${waitS} s.`;
    }
    this.#calls++;
    this.#window.push(now);
    return null;
  }

  /**
   * Run `work` on the branch, one request at a time. The timeout starts when the work starts. A request
   * that waits longer than the timeout behind an earlier one is dropped (answered, never run). The chain
   * always waits for the real work, even after a timeout: the session is not re-entrant.
   */
  async #onBranch<T>(branch: Branch, label: string, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; text: string }> {
    const L = this.#host.limits;
    let phase: "queued" | "running" | "dropped" = "queued";
    let timer: NodeJS.Timeout | undefined;
    let expire!: (text: string) => void;
    const expired = new Promise<{ ok: false; text: string }>((resolve) => (expire = (text) => resolve({ ok: false, text })));
    const arm = (onFire: () => void): void => {
      clearTimeout(timer);
      timer = setTimeout(onFire, L.handlerTimeoutMs);
      timer.unref();
    };
    arm(() => {
      if (phase !== "queued") return;
      phase = "dropped";
      expire(`Not executed: an earlier request on branch ${branch.name} was still running after ${L.handlerTimeoutMs} ms. Retry later.`);
    });
    const run = branch.tail.then(async () => {
      if (phase === "dropped") return null;
      phase = "running";
      arm(() => expire(`${label} did not finish within ${L.handlerTimeoutMs} ms; its result is unknown. Check the state with get_code before continuing.`));
      return { ok: true as const, value: await work() };
    });
    branch.tail = run.catch(() => undefined);
    try {
      const r = await Promise.race([run, expired]);
      return r ?? { ok: false, text: `Not executed: branch ${branch.name} is busy. Retry later.` };
    } finally {
      clearTimeout(timer);
    }
  }

  async callTool(request: McpToolRequest): Promise<Result> {
    const host = this.#host;
    const L = host.limits;
    const pre = this.#preflight(request.name);
    if (!pre.ok) return { text: pre.text, isError: true };
    const argBytes = Buffer.byteLength(JSON.stringify(request.args), "utf8");
    if (argBytes > L.maxArgBytes) return { text: `Not executed: the arguments are ${argBytes} bytes; the limit is ${L.maxArgBytes}. Send smaller edits (patches).`, isError: true };
    if (!host.hasTool(request.name)) return { text: `Unknown tool "${request.name}". Available: ${host.tools.map((t) => t.name).join(", ")}.`, isError: true };
    const limited = this.#count();
    if (limited !== null) return { text: limited, isError: true };
    const branch = pre.branch;
    try {
      const r = await this.#onBranch(branch, request.name, () => host.execute(branch, this.#client, request));
      return r.ok ? r.value : { text: r.text, isError: true };
    } catch {
      return { text: `${request.name} failed in the CAD host.`, isError: true };
    }
  }

  /** `resources/list` and `templates/list` hand out no design data, but still stop once the host closed. */
  #refuseIfClosed(): void {
    const host = this.#host;
    if (host.closedReason !== null) throw new McpRequestError(MCP_REQUEST_REFUSED, closedText(host.closedReason));
    if (!host.offersResources) throw new McpRequestError(JSONRPC_METHOD_NOT_FOUND, "This session has no resources.");
  }

  readonly resources = {
    list: async (): Promise<McpResource[]> => {
      this.#refuseIfClosed();
      return this.#host.resourceList();
    },
    templates: (): McpResourceTemplate[] => {
      this.#refuseIfClosed();
      return this.#host.resourceTemplates();
    },
    read: async (uri: string): Promise<McpResourceContents[] | null> => {
      const host = this.#host;
      this.#refuseIfClosed();
      const pre = this.#preflight(RESOURCE_READ_GATE_NAME);
      if (!pre.ok) throw new McpRequestError(MCP_REQUEST_REFUSED, pre.text);
      const limited = this.#count();
      if (limited !== null) throw new McpRequestError(MCP_REQUEST_REFUSED, limited);
      const branch = pre.branch;
      const r = await this.#onBranch(branch, RESOURCE_READ_GATE_NAME, async () => host.readResource(branch, uri));
      if (!r.ok) throw new McpRequestError(MCP_REQUEST_REFUSED, r.text);
      return r.value;
    },
  };

  close(): void {
    this.#ended = true;
    if (this.#branch) this.#branch.active = false;
  }
}
