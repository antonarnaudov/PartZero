// Test-only wrapper used when recording fixtures (AICAD_RECORD_FIXTURES=claude): runs the real shim and
// appends every frame the MCP client sends to the file in AICAD_MCP_TEE. Never used by the product.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const shim = process.argv[2];
const out = process.env.AICAD_MCP_TEE;
const child = spawn(process.execPath, [shim], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
process.stdin.on("data", (c) => {
  if (out) appendFileSync(out, c);
  child.stdin.write(c);
});
process.stdin.on("end", () => child.stdin.end());
child.stdout.pipe(process.stdout);
child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGTERM", () => child.kill("SIGTERM"));
