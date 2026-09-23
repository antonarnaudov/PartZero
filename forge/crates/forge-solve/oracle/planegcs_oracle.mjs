// Oracle comparison for forge-solve against FreeCAD's PlaneGCS (wasm build, LGPL).
// CI/dev tooling only: PlaneGCS is never a runtime dependency of Forge (CLAUDE.md §1).
//
//   cargo run -p forge-solve --release --example oracle_corpus -- <dir> 1000 2026
//   (cd crates/forge-solve/oracle && npm ci && node planegcs_oracle.mjs <dir>)
//
// Reads <dir>/corpus.jsonl and <dir>/forge.jsonl, runs PlaneGCS on every sketch and writes
// <dir>/planegcs.jsonl (per-sketch answers) and <dir>/summary.json (agreement rates).
//
// Checks
//   dof            forge DOF == PlaneGCS DOF (params − Jacobian rank); PlaneGCS's DOF is
//                  only rank-based when it reports no conflict, so `dof_pgcs_no_conflict`
//                  is the meaningful rate
//   class          same class: conflict / redundant / clean (under or fully)
//   class_adj      as `class`, but a PlaneGCS "conflict" whose own solve succeeds (status
//                  Success: every constraint satisfied) is counted as redundant — a
//                  consistent system cannot conflict
//   conflict set   forge's minimal conflicting sets vs PlaneGCS's conflicting list
//   mcs verified   PlaneGCS itself confirms each forge MCS: the MCS alone does not solve,
//                  and removing any single member makes it solve (true minimality);
//                  `mcs_minimal_when_verified` restricts to sets forge flags
//                  `verified_minimal` (every one-smaller subset solved by forge)
//   redundancy     PlaneGCS confirms each forge-redundant constraint: removing it leaves
//                  PlaneGCS's DOF unchanged and the rest still solves

import fs from "node:fs";
import path from "node:path";
import { init_planegcs_module, GcsWrapper } from "@salusoft89/planegcs";

const dir = process.argv[2] ?? "../../../target/forge-solve-oracle";
const readJsonl = (f) =>
  fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const corpus = readJsonl("corpus.jsonl");
const forge = readJsonl("forge.jsonl");
if (corpus.length !== forge.length) throw new Error("corpus/forge length mismatch");

const mod = await init_planegcs_module({ print: () => {}, printErr: () => {} });

// ---- sketch → PlaneGCS primitives -------------------------------------------------------

const DEG = Math.PI / 180;
const base = (id) => id.split("#")[0];

function toPrimitives(sketch, keep = () => true) {
  const ents = new Map(sketch.entities.map((e) => [e.id, e]));
  const fixedPoints = new Set();
  const extra = []; // constraints standing in for fixed non-point parameters
  for (const e of sketch.entities) {
    if (!e.fixed) continue;
    if (e.type === "point") fixedPoints.add(e.id);
    if (e.type === "line") [e.p1, e.p2].forEach((p) => fixedPoints.add(p));
    if (e.type === "circle") {
      fixedPoints.add(e.center);
      extra.push({ id: `${e.id}#fixr`, type: "circle_radius", c_id: e.id, radius: e.radius });
    }
    if (e.type === "arc") [e.center, e.start, e.end].forEach((p) => fixedPoints.add(p));
  }
  const prims = [];
  for (const e of sketch.entities) {
    if (e.type === "point") prims.push({ id: e.id, type: "point", x: e.x, y: e.y, fixed: fixedPoints.has(e.id) });
  }
  const pt = (id) => ents.get(id);
  for (const e of sketch.entities) {
    if (e.type === "line") prims.push({ id: e.id, type: "line", p1_id: e.p1, p2_id: e.p2 });
    if (e.type === "circle") prims.push({ id: e.id, type: "circle", c_id: e.center, radius: e.radius });
    if (e.type === "arc") {
      const c = pt(e.center), s = pt(e.start), en = pt(e.end);
      prims.push({
        id: e.id, type: "arc", c_id: e.center, start_id: e.start, end_id: e.end,
        radius: Math.hypot(s.x - c.x, s.y - c.y),
        start_angle: Math.atan2(s.y - c.y, s.x - c.x),
        end_angle: Math.atan2(en.y - c.y, en.x - c.x),
      });
      prims.push({ id: `${e.id}#rules`, type: "arc_rules", a_id: e.id });
    }
  }
  const kind = (id) => ents.get(id).type;
  for (const k of sketch.constraints) {
    if (k.driving === false || !keep(k.id)) continue;
    const id = k.id;
    const push = (o, suffix = "") => prims.push({ id: id + suffix, ...o });
    switch (k.type) {
      case "coincident": push({ type: "p2p_coincident", p1_id: k.a, p2_id: k.b }); break;
      case "horizontal": push({ type: "horizontal_l", l_id: k.line }); break;
      case "vertical": push({ type: "vertical_l", l_id: k.line }); break;
      case "parallel": push({ type: "parallel", l1_id: k.a, l2_id: k.b }); break;
      case "perpendicular": push({ type: "perpendicular_ll", l1_id: k.a, l2_id: k.b }); break;
      case "tangent": {
        const [ta, tb] = [kind(k.a), kind(k.b)];
        const key = `${ta}-${tb}`;
        if (key === "line-circle") push({ type: "tangent_lc", l_id: k.a, c_id: k.b });
        else if (key === "circle-line") push({ type: "tangent_lc", l_id: k.b, c_id: k.a });
        else if (key === "line-arc") push({ type: "tangent_la", l_id: k.a, a_id: k.b });
        else if (key === "arc-line") push({ type: "tangent_la", l_id: k.b, a_id: k.a });
        else if (key === "circle-circle") push({ type: "tangent_cc", c1_id: k.a, c2_id: k.b });
        else if (key === "arc-arc") push({ type: "tangent_aa", a1_id: k.a, a2_id: k.b });
        else if (key === "circle-arc") push({ type: "tangent_ca", c_id: k.a, a_id: k.b });
        else if (key === "arc-circle") push({ type: "tangent_ca", c_id: k.b, a_id: k.a });
        else throw new Error(`tangent ${key}`);
        break;
      }
      case "equal": {
        const [ta, tb] = [kind(k.a), kind(k.b)];
        if (ta === "line") push({ type: "equal_length", l1_id: k.a, l2_id: k.b });
        else if (ta === "circle" && tb === "circle") push({ type: "equal_radius_cc", c1_id: k.a, c2_id: k.b });
        else if (ta === "arc" && tb === "arc") push({ type: "equal_radius_aa", a1_id: k.a, a2_id: k.b });
        else if (ta === "circle") push({ type: "equal_radius_ca", c_id: k.a, a_id: k.b });
        else push({ type: "equal_radius_ca", c_id: k.b, a_id: k.a });
        break;
      }
      case "distance":
        if (kind(k.b) === "line") push({ type: "p2l_distance", p_id: k.a, l_id: k.b, distance: k.value });
        else push({ type: "p2p_distance", p1_id: k.a, p2_id: k.b, distance: k.value });
        break;
      case "angle": push({ type: "l2l_angle_ll", l1_id: k.a, l2_id: k.b, angle: k.value * DEG }); break;
      case "radius":
        if (kind(k.curve) === "arc") push({ type: "arc_radius", a_id: k.curve, radius: k.value });
        else push({ type: "circle_radius", c_id: k.curve, radius: k.value });
        break;
      case "diameter":
        if (kind(k.curve) === "arc") push({ type: "arc_diameter", a_id: k.curve, diameter: k.value });
        else push({ type: "circle_diameter", c_id: k.curve, diameter: k.value });
        break;
      case "point_on_line": push({ type: "point_on_line_pl", p_id: k.point, l_id: k.line }); break;
      case "point_on_circle":
        if (kind(k.curve) === "arc") push({ type: "point_on_arc", p_id: k.point, a_id: k.curve });
        else push({ type: "point_on_circle", p_id: k.point, c_id: k.curve });
        break;
      case "midpoint": {
        const l = ents.get(k.line);
        push({ type: "p2p_symmetric_ppp", p1_id: l.p1, p2_id: l.p2, p_id: k.point });
        break;
      }
      case "symmetric": push({ type: "p2p_symmetric_ppl", p1_id: k.a, p2_id: k.b, l_id: k.line }); break;
      case "fix": {
        const e = ents.get(k.entity);
        const fixPoint = (pid, sfx, x, y) => {
          const p = ents.get(pid);
          push({ type: "coordinate_x", p_id: pid, x: x ?? p.x }, `#${sfx}x`);
          push({ type: "coordinate_y", p_id: pid, y: y ?? p.y }, `#${sfx}y`);
        };
        if (e.type === "point") fixPoint(e.id, "", k.x, k.y);
        else if (e.type === "line") { fixPoint(e.p1, "a"); fixPoint(e.p2, "b"); }
        else if (e.type === "circle") {
          fixPoint(e.center, "c");
          push({ type: "circle_radius", c_id: e.id, radius: e.radius }, "#r");
        }
        break;
      }
      default: throw new Error(`unmapped constraint ${k.type}`);
    }
  }
  return prims.concat(extra);
}

// ---- run PlaneGCS ----------------------------------------------------------------------

const uniq = (xs) => [...new Set(xs)];
const userIds = (xs) => uniq(xs.filter((x) => !x.includes("#rules") && !x.includes("#fixr")).map(base));

function planegcs(sketch, keep) {
  const g = new GcsWrapper(new mod.GcsSystem());
  try {
    g.push_primitives_and_params(toPrimitives(sketch, keep));
    const status = g.solve();
    return {
      status,
      dof: g.gcs.dof(),
      conflicting: userIds(g.get_gcs_conflicting_constraints()),
      redundant: userIds(g.get_gcs_redundant_constraints()),
      partial: userIds(g.get_gcs_partially_redundant_constraints()),
      rawConflicting: g.get_gcs_conflicting_constraints(),
    };
  } finally {
    g.destroy_gcs_module();
  }
}

const solves = (r) => r.conflicting.length === 0 && (r.status === 0 || r.status === 1);
const classOf = (r) =>
  r.conflicting.length > 0 ? "conflict"
    : r.status === 2 || r.status === 3 ? "failed"
    : r.redundant.length + r.partial.length > 0 ? "redundant" : "clean";
const forgeClass = (f) =>
  f.status === "conflict" ? "conflict"
    : f.status === "failed_to_converge" ? "failed"
    : f.status === "over_constrained_redundant" ? "redundant" : "clean";
const sameSet = (a, b) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
const subset = (a, b) => a.every((x) => b.includes(x));

// ---- compare ---------------------------------------------------------------------------

const tally = () => ({ n: 0, ok: 0 });
const stats = {
  dof: tally(), dof_pgcs_no_conflict: tally(), class: tally(), class_adj: tally(),
  conflict_detected: tally(), conflict_set_equal: tally(), conflict_set_subset: tally(),
  mcs_inconsistent: tally(), mcs_minimal: tally(), mcs_minimal_when_verified: tally(), mcs_verified_flag: tally(),
  redundant_detected: tally(), redundant_set_equal: tally(), redundant_count_equal: tally(),
  redundancy_verified: tally(), svd_backend_agrees: tally(), expected_dof: tally(), expected_mcs: tally(),
};
const byFamily = {};
const disagreements = [];
const out = fs.createWriteStream(path.join(dir, "planegcs.jsonl"));
const hit = (t, ok) => { t.n++; if (ok) t.ok++; };
let pgcsMs = 0;

for (let i = 0; i < corpus.length; i++) {
  const g = corpus[i];
  const f = forge[i];
  if (g.name !== f.name) throw new Error(`order mismatch at ${i}`);
  const t0 = performance.now();
  const p = planegcs(g.sketch);
  pgcsMs += performance.now() - t0;
  const fam = (byFamily[g.family] ??= { n: 0, dof: 0, class: 0 });
  fam.n++;
  const note = [];

  const dofOk = p.dof === f.dof;
  hit(stats.dof, dofOk);
  if (p.conflicting.length === 0) {
    hit(stats.dof_pgcs_no_conflict, dofOk);
    if (dofOk) fam.dof++; else note.push(`dof forge ${f.dof} planegcs ${p.dof}`);
  }
  const [fc, pcRaw] = [forgeClass(f), classOf(p)];
  const pc = pcRaw === "conflict" && p.status === 0 ? "redundant" : pcRaw;
  hit(stats.class, fc === pcRaw);
  hit(stats.class_adj, fc === pc);
  if (fc === pc) fam.class++; else note.push(`class forge ${fc} planegcs ${pc} (status ${p.status})`);
  if (pc !== pcRaw) note.push(`planegcs labels [${p.conflicting}] conflicting but its own solve succeeds`);
  hit(stats.svd_backend_agrees, f.status === f.svd_status && f.dof === f.svd_dof &&
    JSON.stringify(f.conflicts) === JSON.stringify(f.svd_conflicts) &&
    JSON.stringify(f.redundant) === JSON.stringify(f.svd_redundant));
  if (g.expected_dof != null && f.status !== "conflict") hit(stats.expected_dof, f.dof === g.expected_dof);

  if (pc === "conflict" || fc === "conflict") {
    hit(stats.conflict_detected, pc === "conflict" && fc === "conflict");
    const ours = uniq(f.conflicts.flat());
    if (pc === "conflict" && fc === "conflict") {
      hit(stats.conflict_set_equal, sameSet(ours, p.conflicting));
      hit(stats.conflict_set_subset, subset(ours, p.conflicting));
      if (!sameSet(ours, p.conflicting)) note.push(`conflict forge [${ours}] planegcs [${p.conflicting}]`);
    }
  }
  if (g.expected_conflict && fc === "conflict") hit(stats.expected_mcs, sameSet(f.conflicts[0], g.expected_conflict));
  // Independent verification of every forge MCS by PlaneGCS.
  for (const [mi, mcs] of f.conflicts.entries()) {
    const flagged = f.conflicts_verified_minimal?.[mi] ?? true;
    const inc = !solves(planegcs(g.sketch, (id) => mcs.includes(id)));
    hit(stats.mcs_inconsistent, inc);
    let minimal = true;
    for (const c of mcs) {
      if (!solves(planegcs(g.sketch, (id) => mcs.includes(id) && id !== c))) minimal = false;
    }
    hit(stats.mcs_minimal, minimal);
    hit(stats.mcs_verified_flag, flagged);
    if (flagged) hit(stats.mcs_minimal_when_verified, minimal);
    if (!inc || !minimal) note.push(`mcs [${mcs}] inconsistent=${inc} minimal=${minimal}`);
  }
  if (pc === "redundant" || fc === "redundant") {
    hit(stats.redundant_detected, pc === "redundant" && fc === "redundant");
    if (pc === "redundant" && fc === "redundant") {
      const theirs = uniq([...p.redundant, ...p.partial]);
      hit(stats.redundant_set_equal, sameSet(f.redundant, theirs));
      hit(stats.redundant_count_equal, f.redundant.length === theirs.length);
      if (!sameSet(f.redundant, theirs)) note.push(`redundant forge [${f.redundant}] planegcs [${theirs}]`);
    }
  }
  // Independent verification of every forge (full) redundancy claim: without it, the
  // sketch still solves in PlaneGCS and PlaneGCS's DOF equals forge's DOF of the full
  // sketch (a non-redundant constraint would free one more DOF).
  if (fc === "redundant") {
    for (const r of f.redundant) {
      if (f.redundant_partial.includes(r)) continue;
      const without = planegcs(g.sketch, (id) => id !== r);
      const ok = without.dof === f.dof && solves(without);
      hit(stats.redundancy_verified, ok);
      if (!ok) note.push(`redundancy ${r} not confirmed (dof without ${without.dof}, status ${without.status})`);
    }
  }
  const rec = { name: g.name, family: g.family, planegcs: { ...p, rawConflicting: undefined }, forge: { status: f.status, dof: f.dof }, note };
  out.write(JSON.stringify(rec) + "\n");
  if (note.length) disagreements.push({ name: g.name, note });
}
out.end();

const rate = (t) => (t.n ? `${t.ok}/${t.n} (${((100 * t.ok) / t.n).toFixed(1)}%)` : "n/a");
const summary = {
  sketches: corpus.length,
  planegcs_ms_total: Math.round(pgcsMs),
  rates: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { ...v, rate: v.n ? v.ok / v.n : null }])),
  by_family: byFamily,
  disagreements: disagreements.slice(0, 200),
  disagreement_count: disagreements.length,
};
fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2));
console.log(`| Check | Agreement |\n|---|---|`);
for (const [k, v] of Object.entries(stats)) console.log(`| ${k} | ${rate(v)} |`);
console.log(`\nby family: ${JSON.stringify(byFamily)}`);
console.log(`disagreements: ${disagreements.length} (first 15 below; all in summary.json)`);
for (const d of disagreements.slice(0, 15)) console.log(`  ${d.name}: ${d.note.join("; ")}`);
