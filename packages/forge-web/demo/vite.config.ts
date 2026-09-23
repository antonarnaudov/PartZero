import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile } from "@aicad/cadscript";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(here, "../../..");

/**
 * `virtual:aicad-corpus`: corpus/programs/*.json plus every corpus/makerbench/*.cad.ts
 * compiled to IR with @aicad/cadscript (in Node, at dev-server start / build time).
 */
function corpusPlugin(): Plugin {
  const id = "virtual:aicad-corpus";
  return {
    name: "aicad-corpus",
    resolveId: (s) => (s === id ? "\0" + id : null),
    load(s) {
      if (s !== "\0" + id) return null;
      const docs: { group: string; name: string; ir: unknown }[] = [];
      const programs = join(repoRoot, "corpus/programs");
      for (const f of readdirSync(programs).filter((f) => f.endsWith(".json")).sort()) {
        docs.push({ group: "programs", name: f.replace(/\.json$/, ""), ir: JSON.parse(readFileSync(join(programs, f), "utf8")) });
      }
      const mb = join(repoRoot, "corpus/makerbench");
      for (const f of readdirSync(mb).filter((f) => f.endsWith(".cad.ts") && !f.includes(".context.")).sort()) {
        const r = compile(readFileSync(join(mb, f), "utf8"), { fileName: f });
        if (r.ok && r.ir) docs.push({ group: "makerbench", name: f.replace(/\.cad\.ts$/, ""), ir: r.ir });
        else this.warn(`${f}: ${r.diagnostics.map((d) => d.message).join("; ")}`);
      }
      return `export default ${JSON.stringify(docs)};`;
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [corpusPlugin()],
  server: {
    port: 5178,
    fs: { allow: [pkgRoot, join(repoRoot, "corpus")] },
  },
  worker: { format: "es" },
  build: { outDir: join(here, "dist"), emptyOutDir: true, target: "es2022" },
});
