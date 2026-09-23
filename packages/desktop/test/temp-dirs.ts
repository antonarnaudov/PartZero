import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

/**
 * A factory for fresh directories under the system temp dir (`<prefix>XXXXXX`), all deleted once the
 * enclosing suite (or the file, when called at top level) has finished. Test runs leave nothing behind.
 */
export function tempDirs(prefix: string): () => string {
  const made: string[] = [];
  afterAll(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  return () => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}
