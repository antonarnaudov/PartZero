/**
 * Chooses the evaluation engine: `@aicad/forge-web` (WASM worker) when it initialises, else the
 * native Forge CLI over the desktop bridge, else no engine (compile-only). The preference can be
 * changed at runtime (`engine.select`); engines are created lazily and cached.
 */
import { Store } from "../store";
import { NullEngine } from "./null-engine";
import type { EngineId, ForgeEngine } from "./types";

export type EnginePreference = "auto" | "forge-web" | "forge-cli";

export interface EngineCandidate {
  id: Exclude<EngineId, "none">;
  /** null = not probed yet. */
  available: boolean | null;
  detail: string;
}

export interface EngineManagerState {
  active: ForgeEngine;
  preference: EnginePreference;
  candidates: EngineCandidate[];
  initializing: boolean;
}

export interface EngineFactories {
  "forge-web"?: () => Promise<ForgeEngine>;
  "forge-cli"?: () => Promise<ForgeEngine>;
}

const ORDER: Array<Exclude<EngineId, "none">> = ["forge-web", "forge-cli"];

export class EngineManager extends Store<EngineManagerState> {
  private readonly factories: EngineFactories;
  private readonly cache = new Map<EngineId, Promise<ForgeEngine>>();

  constructor(factories: EngineFactories, unavailable: Partial<Record<Exclude<EngineId, "none">, string>> = {}) {
    super({
      active: new NullEngine(),
      preference: "auto",
      initializing: false,
      candidates: ORDER.map((id) => ({
        id,
        available: factories[id] ? null : false,
        detail: factories[id] ? "not probed yet" : (unavailable[id] ?? "not provided by this host"),
      })),
    });
    this.factories = factories;
  }

  get active(): ForgeEngine {
    return this.getState().active;
  }

  /** Select an engine. `auto` walks forge-web → forge-cli → none. Explicit choices throw when unavailable. */
  async select(preference: EnginePreference = "auto"): Promise<ForgeEngine> {
    this.setState({ initializing: true });
    try {
      const order = preference === "auto" ? ORDER : [preference];
      const errors: string[] = [];
      for (const id of order) {
        try {
          const engine = await this.create(id);
          this.setState({ active: engine, preference });
          return engine;
        } catch (e) {
          errors.push(`${id}: ${(e as Error).message}`);
        }
      }
      if (preference !== "auto") throw new Error(errors.join("; "));
      const none = new NullEngine(errors.length ? `No engine: ${errors.join("; ")}` : undefined);
      this.setState({ active: none, preference });
      return none;
    } finally {
      this.setState({ initializing: false });
    }
  }

  private create(id: Exclude<EngineId, "none">): Promise<ForgeEngine> {
    const factory = this.factories[id];
    if (!factory) return Promise.reject(new Error(this.candidate(id)?.detail ?? "not provided by this host"));
    let p = this.cache.get(id);
    if (!p) {
      p = factory();
      this.cache.set(id, p);
      p.then(
        (engine) => this.updateCandidate(id, true, engine.detail),
        (e: unknown) => {
          this.cache.delete(id);
          this.updateCandidate(id, false, e instanceof Error ? e.message : String(e));
        },
      );
    }
    return p;
  }

  private candidate(id: EngineId): EngineCandidate | undefined {
    return this.getState().candidates.find((c) => c.id === id);
  }

  private updateCandidate(id: EngineId, available: boolean, detail: string): void {
    this.setState((s) => ({ candidates: s.candidates.map((c) => (c.id === id ? { ...c, available, detail } : c)) }));
  }

  dispose(): void {
    for (const p of this.cache.values()) p.then((e) => e.dispose(), () => undefined);
    this.cache.clear();
  }
}
