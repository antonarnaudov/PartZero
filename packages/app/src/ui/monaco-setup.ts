/**
 * Monaco configured for CadScript: TypeScript mode with the `@aicad/std` declarations mounted as
 * an extra lib (completions, signature help and hover docs come from the std JSDoc).
 *
 * Monaco's own TS diagnostics are off: diagnostics come from `@aicad/cadscript` (the CadScript
 * compiler + its type-check against the same std) and Forge evaluation, mapped to markers by the
 * editor component, so the editor and the agent see exactly the same errors.
 */
import { STD_DTS } from "@aicad/cadscript";
import * as monaco from "monaco-editor";
import EditorWorker from "monaco-editor/editor/editor.worker?worker";
import TsWorker from "monaco-editor/languages/features/typescript/ts.worker?worker";

export const CADSCRIPT_MODEL_URI = "file:///main.cad.ts";
export const STD_LIB_URI = "file:///node_modules/@aicad/std/index.d.ts";

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string): Worker {
      if (label === "typescript" || label === "javascript") return new TsWorker();
      return new EditorWorker();
    },
  };

  const ts = monaco.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    strict: true,
    noEmit: true,
    allowNonTsExtensions: true,
    // No DOM: keep completions to CadScript and the language itself.
    lib: ["es2020"],
  });
  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: true,
    noSyntaxValidation: true,
    noSuggestionDiagnostics: true,
  });
  ts.typescriptDefaults.setEagerModelSync(true);
  ts.typescriptDefaults.addExtraLib(STD_DTS, STD_LIB_URI);

  monaco.editor.defineTheme("aicad-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6b7380", fontStyle: "italic" },
      { token: "keyword", foreground: "c49cff" },
      { token: "number", foreground: "e6b673" },
      { token: "string", foreground: "9fcf8f" },
      { token: "identifier", foreground: "d7dae0" },
      { token: "type.identifier", foreground: "7cc4e8" },
      { token: "delimiter", foreground: "8b919c" },
    ],
    colors: {
      "editor.background": "#1d1f24",
      "editor.foreground": "#d7dae0",
      "editorLineNumber.foreground": "#4b515c",
      "editorLineNumber.activeForeground": "#9aa1ad",
      "editor.lineHighlightBackground": "#23262c",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#2d4f8a88",
      "editor.inactiveSelectionBackground": "#2d4f8a44",
      "editorIndentGuide.background1": "#2a2e35",
      "editorGutter.background": "#1d1f24",
      "editorWidget.background": "#24272d",
      "editorWidget.border": "#343944",
      "editorHoverWidget.background": "#24272d",
      "editorHoverWidget.border": "#343944",
      "editorSuggestWidget.background": "#24272d",
      "editorSuggestWidget.border": "#343944",
      "editorSuggestWidget.selectedBackground": "#2d3a52",
      "scrollbarSlider.background": "#ffffff14",
      "scrollbarSlider.hoverBackground": "#ffffff24",
      "editorError.foreground": "#f0706a",
      "editorWarning.foreground": "#e0b04f",
      "editorOverviewRuler.border": "#00000000",
    },
  });
  monaco.editor.defineTheme("aicad-light", {
    base: "vs",
    inherit: true,
    rules: [
      { token: "comment", foreground: "8a919c", fontStyle: "italic" },
      { token: "keyword", foreground: "7a3fd1" },
      { token: "number", foreground: "a4640f" },
      { token: "string", foreground: "3d7f2c" },
      { token: "type.identifier", foreground: "1c6c96" },
      { token: "delimiter", foreground: "6b7280" },
    ],
    colors: {
      "editor.background": "#ffffff",
      "editor.foreground": "#1f2329",
      "editorLineNumber.foreground": "#b3b9c2",
      "editorLineNumber.activeForeground": "#59606b",
      "editor.lineHighlightBackground": "#f4f6f8",
      "editor.lineHighlightBorder": "#00000000",
      "editor.selectionBackground": "#bcd3ff",
      "editorGutter.background": "#ffffff",
      "editorWidget.background": "#ffffff",
      "editorWidget.border": "#d9dde3",
      "editorHoverWidget.background": "#ffffff",
      "editorHoverWidget.border": "#d9dde3",
      "editorSuggestWidget.selectedBackground": "#e6efff",
      "editorError.foreground": "#d13b35",
      "editorWarning.foreground": "#b7791f",
      "editorOverviewRuler.border": "#00000000",
    },
  });
  return monaco;
}

export type Monaco = typeof monaco;
