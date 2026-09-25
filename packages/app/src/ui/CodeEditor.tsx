/**
 * The CadScript code view (Monaco). Two-way bound to the DocStore:
 * - typing → `doc.setSource` (coalesced into one undo step per burst, recompile debounced);
 * - store changes (undo, templates, agent/IR edits) → minimal edits into the Monaco model;
 * - problems → markers; the selected feature → a line highlight; cursor → timeline focus.
 */
import type { Span } from "@aicad/cadscript";
import type { editor as MonacoEditor } from "monaco-editor";
import { useEffect, useRef } from "react";
import { collectProblems, problemsToMarkers } from "../doc/problems";
import { featureAtPosition } from "../doc/provenance";
import { diffText } from "../doc/text-edit";
import { useApp } from "./context";
import { CADSCRIPT_MODEL_URI, setupMonaco, type Monaco } from "./monaco-setup";

function toRange(monaco: Monaco, span: Span): InstanceType<Monaco["Range"]> {
  return new monaco.Range(span.start.line, span.start.col, span.end.line, span.end.col);
}

function applyMinimalEdit(monaco: Monaco, editor: MonacoEditor.IStandaloneCodeEditor, model: MonacoEditor.ITextModel, text: string): void {
  const edit = diffText(model.getValue(), text);
  const start = model.getPositionAt(edit.offset);
  const end = model.getPositionAt(edit.offset + edit.removed.length);
  const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
  editor.executeEdits("aicad-doc", [{ range, text: edit.inserted, forceMoveMarkers: true }]);
}

export function CodeEditor(): React.ReactElement {
  const { services, run } = useApp();
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { doc, ui } = services;
    const monaco = setupMonaco();
    const uri = monaco.Uri.parse(CADSCRIPT_MODEL_URI);
    monaco.editor.getModel(uri)?.dispose();
    const model = monaco.editor.createModel(doc.getState().source, "typescript", uri);
    model.updateOptions({ tabSize: 2, insertSpaces: true });
    const editor = monaco.editor.create(host, {
      model,
      theme: ui.getState().resolvedTheme === "light" ? "aicad-light" : "aicad-dark",
      automaticLayout: true,
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || "monospace",
      fontSize: 12.5,
      lineHeight: 19,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      renderLineHighlight: "line",
      lineNumbersMinChars: 3,
      glyphMargin: false,
      folding: true,
      padding: { top: 8, bottom: 8 },
      smoothScrolling: true,
      fixedOverflowWidgets: true,
      overviewRulerBorder: false,
      stickyScroll: { enabled: false },
      bracketPairColorization: { enabled: true },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      "semanticHighlighting.enabled": false,
      ariaLabel: "CadScript code",
    });

    let applying = false;
    const subs: Array<{ dispose(): void }> = [];
    const unsubs: Array<() => void> = [];

    // Editor → store.
    subs.push(
      model.onDidChangeContent(() => {
        if (applying || doc.isV1) return;
        run({ id: "doc.setSource", args: { source: model.getValue(), coalesceKey: "editor" } }, "ui");
      }),
    );
    subs.push(editor.onDidBlurEditorText(() => doc.sealTransaction()));

    // Cursor → timeline focus.
    subs.push(
      editor.onDidChangeCursorPosition((e) => {
        const spans = doc.getState().model?.spans ?? {};
        ui.setCodeFocus(featureAtPosition(spans, { line: e.position.lineNumber, col: e.position.column }));
      }),
    );

    // Store → editor, markers and decorations.
    const selectionDecorations = editor.createDecorationsCollection();
    let lastDiagnosticsKey: unknown[] = [];
    // An IR v1 model is edited through the command layer: the code view shows it as CadScript v1,
    // read-only (View ▸ Show Code).
    let printed: string | null = null;
    const syncV1 = (source: string): void => {
      editor.updateOptions({ readOnly: true });
      if (printed === source) return;
      printed = source;
      void services.cadscript.printV1(source).then((code) => {
        if (printed !== source) return;
        const text = code ?? `// This model cannot be printed as CadScript yet; its IR:\n${source}`;
        if (text === model.getValue()) return;
        applying = true;
        try {
          // A model-level write: the editor is read-only, and `executeEdits` refuses then.
          model.setValue(text);
        } finally {
          applying = false;
        }
        monaco.editor.setModelMarkers(model, "aicad", []);
      });
    };
    const sync = (): void => {
      const s = doc.getState();
      if (s.format === "ir-v1") {
        syncV1(s.source);
        return;
      }
      printed = null;
      editor.updateOptions({ readOnly: false });
      if (s.source !== model.getValue()) {
        applying = true;
        try {
          applyMinimalEdit(monaco, editor, model, s.source);
        } finally {
          applying = false;
        }
      }
      const key = [s.compile, s.report, s.engineError, s.model];
      if (key.some((k, i) => k !== lastDiagnosticsKey[i])) {
        lastDiagnosticsKey = key;
        // Markers only from a compile of the current text; Monaco moves existing markers while typing.
        if (s.compiledRevision === s.revision) {
          const lines = model.getLineCount();
          const markers = problemsToMarkers(collectProblems(s), (line) => (line >= 1 && line <= lines ? model.getLineLength(line) : 0))
            .filter((m) => m.startLineNumber <= lines)
            .map((m) => ({ ...m, endLineNumber: Math.min(m.endLineNumber, lines) }));
          monaco.editor.setModelMarkers(model, "aicad", markers);
        }
      }
      const span = s.selection.featureId ? s.model?.spans[s.selection.featureId] : undefined;
      selectionDecorations.set(
        span
          ? [{ range: toRange(monaco, span), options: { isWholeLine: true, className: "cad-selected-feature", linesDecorationsClassName: "cad-selected-feature-gutter" } }]
          : [],
      );
    };
    sync();
    unsubs.push(doc.subscribe(sync));

    let theme = ui.getState().resolvedTheme;
    unsubs.push(
      ui.subscribe(() => {
        const t = ui.getState().resolvedTheme;
        if (t !== theme) {
          theme = t;
          monaco.editor.setTheme(t === "light" ? "aicad-light" : "aicad-dark");
        }
      }),
    );

    unsubs.push(
      services.editor.attach({
        reveal(span, { select, focus }) {
          const range = toRange(monaco, span);
          editor.revealRangeInCenterIfOutsideViewport(range, 0);
          if (select) editor.setSelection(range);
          else editor.setPosition({ lineNumber: span.start.line, column: span.start.col });
          if (focus) editor.focus();
        },
        focus() {
          editor.focus();
        },
      }),
    );

    return () => {
      for (const s of subs) s.dispose();
      for (const u of unsubs) u();
      editor.dispose();
      model.dispose();
    };
  }, [services, run]);

  return <div ref={hostRef} className="code-editor" data-testid="code-editor" />;
}
