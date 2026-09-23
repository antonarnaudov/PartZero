// Dev mode: the @aicad/app Vite dev server (HMR, COOP/COEP headers) + Electron pointed at it.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const require = createRequire(import.meta.url);
const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const appRoot = dirname(require.resolve("@aicad/app/package.json"));
const electronPath = require("electron");

const server = await createServer({ root: appRoot, configFile: join(appRoot, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local[0] ?? "http://localhost:5173/";
console.log(`[aicad] app dev server at ${url}`);

const child = spawn(electronPath, [desktopRoot], {
  stdio: "inherit",
  env: { ...process.env, AICAD_DEV_URL: url },
});
const stop = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
child.on("exit", (code) => void stop(code));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
