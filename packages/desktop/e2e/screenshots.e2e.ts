/**
 * The e2e suite must not rewrite the committed documentation screenshots unless asked to
 * (AICAD_UPDATE_DOC_SCREENSHOTS=1). Pure path logic: no Electron is launched.
 */
import { join, relative, sep } from "node:path";
import { expect, test } from "@playwright/test";
import { docScreenshotsDir, screenshotPath, testResultsDir, updateDocScreenshots } from "./screenshots.js";

const rel = (p: string) => relative(join(testResultsDir, "..", "..", ".."), p).split(sep).join("/");

test("screenshots go to test-results/ by default", () => {
  for (const env of [{}, { AICAD_UPDATE_DOC_SCREENSHOTS: "" }, { AICAD_UPDATE_DOC_SCREENSHOTS: "0" }, { AICAD_UPDATE_DOC_SCREENSHOTS: "true" }]) {
    expect(updateDocScreenshots(env)).toBe(false);
    expect(rel(screenshotPath("app-shell.png", "AICAD_E2E_SCREENSHOT", env))).toBe("packages/desktop/test-results/app-shell.png");
    expect(rel(screenshotPath("agent-proposal.png", "AICAD_E2E_AGENT_SCREENSHOT", env))).toBe("packages/desktop/test-results/agent-proposal.png");
  }
});

test("AICAD_UPDATE_DOC_SCREENSHOTS=1 targets the committed docs/spikes/assets/ files", () => {
  const env = { AICAD_UPDATE_DOC_SCREENSHOTS: "1" };
  expect(updateDocScreenshots(env)).toBe(true);
  expect(rel(docScreenshotsDir)).toBe("docs/spikes/assets");
  expect(rel(screenshotPath("app-shell.png", "AICAD_E2E_SCREENSHOT", env))).toBe("docs/spikes/assets/app-shell.png");
  expect(rel(screenshotPath("agent-proposal.png", "AICAD_E2E_AGENT_SCREENSHOT", env))).toBe("docs/spikes/assets/agent-proposal.png");
});

test("an explicit per-screenshot path wins over both", () => {
  const custom = join(testResultsDir, "custom", "shot.png");
  for (const flag of ["", "1"]) {
    const env = { AICAD_UPDATE_DOC_SCREENSHOTS: flag, AICAD_E2E_SCREENSHOT: custom };
    expect(screenshotPath("app-shell.png", "AICAD_E2E_SCREENSHOT", env)).toBe(custom);
    // Another screenshot's override does not leak.
    expect(screenshotPath("agent-proposal.png", "AICAD_E2E_AGENT_SCREENSHOT", env)).not.toBe(custom);
  }
});
