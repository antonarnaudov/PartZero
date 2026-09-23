import { EngineError, type EvalResult, type ForgeEngine, type MeshFormat } from "./types";

/** No engine available: the app still compiles and type-checks CadScript, but shows no geometry. */
export class NullEngine implements ForgeEngine {
  readonly id = "none" as const;
  readonly label = "No engine";
  readonly detail: string;

  constructor(detail = "Neither @aicad/forge-web nor the Forge CLI is available.") {
    this.detail = detail;
  }

  evaluate(_irJson: string): Promise<EvalResult> {
    return Promise.reject(new EngineError("ENGINE_UNAVAILABLE", this.detail));
  }

  exportMesh(_irJson: string, _format: MeshFormat): Promise<Uint8Array> {
    return Promise.reject(new EngineError("ENGINE_UNAVAILABLE", this.detail));
  }

  dispose(): void {}
}
