/**
 * forge-render demo: evaluate a corpus document with Forge (WASM), render it with
 * forge-render (WebGPU or WebGL2), orbit / pick / section, and measure frame time and
 * dimension-edit latency. Uses the built package (dist/ + pkg/).
 */
import corpus from "virtual:aicad-corpus";

import {
  createEvaluator,
  evaluate,
  init,
  Viewport,
  type Evaluator,
  type LoadResult,
  type PickResult,
  type StandardView,
} from "../dist/index.js";
import { benchDocument } from "./bench-doc.js";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface Doc {
  group: string;
  name: string;
  ir: unknown;
}

const BENCH = "bench_fixture_25";
const docs: Doc[] = [{ group: "bench", name: BENCH, ir: null }, ...(corpus as Doc[])];

let viewport: Viewport;
let evaluator: Evaluator;
let current: Doc = docs.find((d) => d.name === "t1-gt2-idler") ?? docs[1] ?? docs[0]!;
let thickness = 6;
let bounds: { min: number[]; max: number[] } | null = null;
let lastEval = "";
let lastEdit = "";
let lastPick: PickResult | null = null;
let sectionFlip = false;
const editLatencies: number[] = [];
const frameWaits: number[] = [];

function docIr(d: Doc): unknown {
  return d.name === BENCH ? benchDocument(thickness) : d.ir;
}

const fmt = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : "–");
const median = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)] ?? NaN;
};
const p95 = (a: number[]) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] ?? NaN;
};
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame((t) => r(t)));

function boundsOf(r: { report: LoadResult["report"] }) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const f of r.report.features) {
    for (const b of f.bodies ?? []) {
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k]!, b.bbox_min[k]!);
        max[k] = Math.max(max[k]!, b.bbox_max[k]!);
      }
    }
  }
  return Number.isFinite(min[0]!) ? { min, max } : null;
}

function describeResult(r: LoadResult, wallMs: number): string {
  const t = r.timings;
  const bad = r.report.features.filter((f) => f.status !== "ok").map((f) => `${f.feature}: ${f.error?.code}`);
  return `eval ${fmt(t.parseMs + t.evaluateMs, 2)} · tess ${fmt(t.tessellateMs, 2)} · upload ${fmt(t.uploadMs ?? 0, 2)} · total ${fmt(wallMs, 2)} ms${bad.length ? `\nERRORS ${bad.join(", ")}` : ""}`;
}

/** Load a document on the main thread (evaluate + tessellate + upload inside WASM). */
function loadMain(fit: boolean): LoadResult {
  const t0 = performance.now();
  const r = viewport.loadIr(docIr(current) as Record<string, unknown>);
  const t1 = performance.now();
  bounds = boundsOf(r);
  lastEval = describeResult(r, t1 - t0);
  if (fit) viewport.fitView();
  applySection();
  return r;
}

/** Load through the worker: evaluate off-thread, transfer typed arrays, setBodies. */
async function loadWorker(): Promise<void> {
  const t0 = performance.now();
  const r = await evaluator.evaluate(docIr(current) as Record<string, unknown>);
  const t1 = performance.now();
  viewport.setBodies(r.bodies);
  const t2 = performance.now();
  bounds = boundsOf(r);
  lastEval = `worker: evaluate ${fmt(r.timings.totalMs, 2)} (round trip ${fmt(t1 - t0, 2)}) · setBodies ${fmt(t2 - t1, 2)} ms`;
  applySection();
}

/**
 * One dimension edit, timed from the input until the GPU has finished the new frame.
 * The fence is a 1-pixel pick submitted after the frame: its read-back resolves only
 * once all earlier queue work (the frame) completed. Presentation then happens at the
 * next vsync (≤ one frame interval later), measured separately when rAF is running.
 */
async function dimensionEdit(value: number): Promise<number> {
  thickness = value;
  $("dimOut").textContent = value.toFixed(1);
  const t0 = performance.now();
  if (($<HTMLSelectElement>("editPath")).value === "worker") await loadWorker();
  else loadMain(false);
  viewport.render();
  const tSubmit = performance.now();
  await viewport.pick(0, 0);
  const tGpu = performance.now();
  const frame = await Promise.race([nextFrame().then(() => performance.now()), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
  const ms = tGpu - t0;
  editLatencies.push(ms);
  frameWaits.push(frame === null ? NaN : frame - tGpu);
  lastEdit = `edit → submitted ${fmt(tSubmit - t0, 1)} ms → GPU done ${fmt(ms, 1)} ms${frame === null ? "" : ` → next frame +${fmt(frame - tGpu, 1)} ms`}`;
  return ms;
}

function applySection(): void {
  const on = $<HTMLInputElement>("section").checked;
  if (!on || !bounds) {
    viewport.setSectionPlane(null);
    return;
  }
  const axis = "XYZ".indexOf($<HTMLSelectElement>("secAxis").value);
  const t = Number($<HTMLInputElement>("secPos").value);
  const origin: [number, number, number] = [0, 1, 2].map((k) => (bounds!.min[k]! + bounds!.max[k]!) / 2) as [number, number, number];
  origin[axis] = bounds.min[axis]! + (bounds.max[axis]! - bounds.min[axis]!) * t;
  const normal: [number, number, number] = [0, 0, 0];
  normal[axis] = sectionFlip ? -1 : 1;
  viewport.setSectionPlane({ origin, normal });
}

function renderStats(): void {
  const s = viewport.stats();
  const rows: [string, string][] = [
    ["adapter", s.adapter || "–"],
    ["msaa", `×${s.sampleCount}`],
    ["size", `${s.width}×${s.height}`],
    ["bodies", `${s.bodies}`],
    ["faces / edges", `${s.faces} / ${s.edges}`],
    ["triangles", `${s.triangles}`],
    ["edge segs / sil cand", `${s.edgeSegments} / ${s.silhouetteCandidates}`],
    ["draw calls", `${s.drawCalls}`],
    ["frame cpu (avg)", `${fmt(s.lastFrameMs, 2)} (${fmt(s.avgFrameMs, 2)}) ms`],
    ["frame interval", s.frameIntervalMs ? `${fmt(s.frameIntervalMs, 1)} ms (${fmt(1000 / s.frameIntervalMs, 0)} fps)` : "idle"],
  ];
  if (editLatencies.length) {
    rows.push(["edit → GPU done", `med ${fmt(median(editLatencies))} p95 ${fmt(p95(editLatencies))} ms (n=${editLatencies.length})`]);
  }
  $("stats").replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement("dt");
      dt.textContent = k;
      const dd = document.createElement("dd");
      dd.textContent = v;
      return [dt, dd];
    }),
  );
  const pick = lastPick
    ? `${lastPick.kind}  ${lastPick.body}\n${lastPick.face ?? lastPick.edge ?? ""}\n${lastPick.point ? `@ ${lastPick.point.map((x) => x.toFixed(2)).join(", ")}` : ""}`
    : "–";
  $("pick").textContent = `${lastEval}\n${lastEdit}\n\npick: ${pick}\nselected: ${viewport.selection().length}`;
}

async function createViewport(backend: "auto" | "webgpu" | "webgl2"): Promise<void> {
  // A canvas keeps its first context type: switching backends needs a fresh canvas.
  const old = $<HTMLCanvasElement>("view");
  const canvas = document.createElement("canvas");
  canvas.id = "view";
  canvas.tabIndex = 0;
  old.replaceWith(canvas);
  viewport?.dispose();
  viewport = await Viewport.create(canvas, { backend });
  viewport.attachControls();
  viewport.on((e) => {
    if (e.type === "hover" || e.type === "select") {
      lastPick = e.pick;
      renderStats();
    }
  });
  $("backend").textContent = viewport.backend();
  $<HTMLSelectElement>("backendSel").value = backend;
  loadMain(true);
}

let spinning = false;
async function spin(): Promise<void> {
  if (spinning) return;
  spinning = true;
  while ($<HTMLInputElement>("spin").checked) {
    viewport.orbit(2, 0);
    await nextFrame();
  }
  spinning = false;
}

async function main(): Promise<void> {
  await init();
  evaluator = createEvaluator();
  const sel = $<HTMLSelectElement>("doc");
  for (const group of ["bench", "programs", "makerbench"]) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const d of docs.filter((x) => x.group === group)) {
      const o = document.createElement("option");
      o.value = `${d.group}/${d.name}`;
      o.textContent = d.name;
      og.append(o);
    }
    sel.append(og);
  }
  const params = new URLSearchParams(location.search);
  const want = params.get("doc");
  current = docs.find((d) => `${d.group}/${d.name}` === want || d.name === want) ?? current;
  sel.value = `${current.group}/${current.name}`;
  $("dim").hidden = current.name !== BENCH;
  const backend = (params.get("backend") ?? "auto") as "auto" | "webgpu" | "webgl2";
  $<HTMLSelectElement>("backendSel").value = backend;
  await createViewport(backend);

  sel.onchange = () => {
    current = docs.find((d) => `${d.group}/${d.name}` === sel.value) ?? current;
    $("dim").hidden = current.name !== BENCH;
    loadMain(true);
    renderStats();
  };
  $<HTMLInputElement>("dimIn").oninput = (e) => void dimensionEdit(Number((e.target as HTMLInputElement).value)).then(renderStats);
  $("bench").onclick = () => void runBench().then(renderStats);
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("button[data-view]"))) {
    b.onclick = () => viewport.setView(b.dataset.view as StandardView);
  }
  $("fit").onclick = () => viewport.fitView();
  $<HTMLInputElement>("ortho").onchange = (e) =>
    viewport.setProjection((e.target as HTMLInputElement).checked ? "orthographic" : "perspective");
  const display = () =>
    viewport.setDisplayOptions({
      edges: $<HTMLInputElement>("edges").checked,
      silhouettes: $<HTMLInputElement>("sil").checked,
      grid: $<HTMLInputElement>("grid").checked,
    });
  for (const id of ["edges", "sil", "grid"]) $<HTMLInputElement>(id).onchange = display;
  $<HTMLInputElement>("spin").onchange = () => void spin();
  for (const id of ["section", "secAxis", "secPos"]) $(id).oninput = applySection;
  $("section").onchange = applySection;
  $("secFlip").onclick = () => {
    sectionFlip = !sectionFlip;
    applySection();
  };
  $<HTMLSelectElement>("backendSel").onchange = (e) =>
    void createViewport((e.target as HTMLSelectElement).value as "auto" | "webgpu" | "webgl2").then(renderStats);
  setInterval(renderStats, 500);
  renderStats();
}

/** 20 automated dimension edits (thickness 4 → 9.7 mm); returns latency stats. */
async function runBench(n = 20): Promise<{ median: number; p95: number; max: number; samples: number[]; frameWaitMedian: number }> {
  if (current.name !== BENCH) {
    current = docs[0]!;
    $<HTMLSelectElement>("doc").value = `${current.group}/${current.name}`;
    $("dim").hidden = false;
    loadMain(true);
  }
  editLatencies.length = 0;
  frameWaits.length = 0;
  for (let i = 0; i < n; i++) await dimensionEdit(4 + i * 0.3);
  const waits = frameWaits.filter((x) => Number.isFinite(x));
  return {
    median: median(editLatencies),
    p95: p95(editLatencies),
    max: Math.max(...editLatencies),
    samples: [...editLatencies],
    frameWaitMedian: waits.length ? median(waits) : NaN,
  };
}

/** Frame time while orbiting continuously for `frames` frames. */
async function measureFrames(frames = 120): Promise<{ cpuMs: number; intervalMs: number }> {
  const cpu: number[] = [];
  const iv: number[] = [];
  let last = await nextFrame();
  for (let i = 0; i < frames; i++) {
    viewport.orbit(2, 0);
    const t = await nextFrame();
    iv.push(t - last);
    last = t;
    cpu.push(viewport.stats().lastFrameMs);
  }
  return { cpuMs: median(cpu), intervalMs: median(iv) };
}

// Automation hooks (used by the spike report's browser runs).
Object.assign(globalThis, {
  forgeDemo: {
    get viewport() {
      return viewport;
    },
    evaluate,
    runBench,
    measureFrames,
    selectDoc(name: string) {
      const d = docs.find((x) => x.name === name || `${x.group}/${x.name}` === name);
      if (!d) throw new Error(`no document ${name}`);
      current = d;
      $<HTMLSelectElement>("doc").value = `${d.group}/${d.name}`;
      $("dim").hidden = d.name !== BENCH;
      return loadMain(true);
    },
    setBackend: (b: "auto" | "webgpu" | "webgl2") => createViewport(b),
  },
});

main().catch((e: unknown) => {
  $("pick").textContent = `Failed to start: ${(e as Error).message ?? e}`;
  console.error(e);
});
