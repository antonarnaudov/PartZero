/** Locations inside the repository, resolved from this module (works from `src/` and `dist/`). */
import { fileURLToPath } from "node:url";

/** `packages/evals/` */
export function packageRoot(): string {
  return fileURLToPath(new URL("../", import.meta.url));
}

/** The monorepo root (`packages/evals/../../`). */
export function repoRoot(): string {
  return fileURLToPath(new URL("../../../", import.meta.url));
}

/** `packages/evals/schema/makerbench-task.schema.json` */
export function schemaPath(): string {
  return fileURLToPath(new URL("../schema/makerbench-task.schema.json", import.meta.url));
}
