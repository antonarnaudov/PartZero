//! # forge-blend — fillets, chamfers and shells (IR v1 W6, F2)
//!
//! - [`fillet`] (SPEC-v1 §6.6): constant-radius rolling-ball blends, analytic where the
//!   blend is exact (a line edge between planes, or a plane and a parallel cylinder →
//!   cylinder; a circle edge between faces of revolution about its axis → torus), with
//!   vertex blends at corners (the normative equal-radius sphere corner of three planes),
//!   mitres where two blends meet, and tangent-chain propagation.
//! - [`chamfer`] (§6.7): the three forms (distance, two distances, distance and angle);
//!   bevels are planes or cones.
//! - [`shell`] (§6.8): offset of every face but the open ones by the thickness, inward or
//!   outward, with intersection (sharp) joins; offsets of analytic faces are exact (a torus
//!   whose tube grows past its axis becomes the outer sheet of a spindle torus). Openings
//!   bounded by convex edges get rims on their plane; openings bounded by smooth edges (the
//!   flat top of a rounded box) get lateral rims along their normal (W6 review round 4).
//!
//! Every operation is **direct B-rep construction** on the input body (no booleans), then
//! verified: every result passes `forge_check::validate`, and every failure is a
//! [`BlendError`] with the SPEC's code and `details` — feasible ranges
//! (`max_feasible_r`, `max_feasible_d`, `max_feasible_thickness`) where the value is too
//! large. Nothing is ever returned that did not pass the checks: configurations outside the
//! implemented set fail explicitly (`FILLET_FAILED` … naming the entity), never silently.
//!
//! Only a **proven** violation is a size limit (W6 review rounds 4 and 5): what the checks
//! cannot decide either way — two walls neither forge-ssi nor the band certificate separates,
//! a boundary or point-in-face test out of budget, an intersection forge-ssi cannot certify
//! near a blend, a free-form face near a blend, a shell vertex whose faces' offsets are not
//! found to meet, a built body that fails validation — is `*_FAILED` naming it, never a
//! `*_TOO_LARGE` limit, and never a bracket of the feasible-range search (fillet, chamfer and
//! shell alike). The searches
//! run within fixed, deterministic budgets of constructions, and a suggested maximum is
//! confirmed: it was built, and `max + 0.001` and `1.01·max` (from 0.1 mm up, where 1 % is a
//! whole rounding step) fail with the same code.
//!
//! The checks that decide feasibility are **certified**, not sampled (W6 review round 2):
//! face boundaries meeting in a face's parameter plane (`cert2d`: exact rational Bézier
//! forms of the pcurves, convex-hull bounds, subdivision; point in face with a clearance
//! certificate), a blend's material against the rest of the body (forge-ssi's certified
//! intersections), and a shell's offset body against itself and the input
//! (`interfere`: forge-ssi, then the parameter-plane tests). Whatever cannot be certified
//! is undecided: never a pass, never a violation (see above). Closed forms of the feasible range (a face's width, two rim
//! contacts on one plane, a rim contact and a line contact, parallel walls, tubes and a
//! tube and a wall of a shell) are candidates confirmed by that construction; otherwise the
//! range is bisected, and a suggested value is always one that was built and checked.
//! [`self_intersections`] exposes the pairwise interference test on a whole body as a
//! verification helper (forge-check does not detect a body passing through itself).
//!
//! # Scope (v1, this revision) and deferrals
//! Implemented: line edges between two faces that are planes or cylinders parallel to the edge
//! (a D-flat's edge: the blend is a cylinder, the bevel a plane), circle edges between faces
//! of revolution about the circle's axis — planes across it, cylinders, cones, spheres centred
//! on it and ring tori about it (a dimple's rim: a torus, a cone) — the faces' cross-sections
//! solved as lines and circles (`blend::section`; chamfer distances are chord distances on a
//! curved face, OCCT's convention); a blend ending at a vertex on a plane across it (also at a
//! reflex vertex, where that face meets it on the material's side: the face takes the end
//! cap, as OCCT builds it), or on any other analytic face (a curved face, or a plane oblique to
//! a circle blend's meridians: its end curve traced along the blend's rulings); corners of 2
//! tangent or 2 same-convexity
//! blended line edges between planes (a mitre, also at a reflex vertex; where their dihedral
//! angles differ, the mitre to the first side face it reaches and the other blend ending on
//! that face, as OCCT builds it), of a line edge and a circle edge on one plane (the curved
//! mitre: the blends' intersection, traced) or of 3 (the normative sphere, the ball's sphere at oblique vertices; chamfers: the
//! corner triangle through the contact lines' corners where the three faces are mutually
//! perpendicular — the only chamfer corner OCCT builds alike; mixed-convexity three-edge
//! corners in two passes); shells of bodies of analytic faces with planar
//! openings bounded by convex edges or by smooth ones (fillet → shell).
//! **Not implemented** — each an explicit `*_FAILED` naming the entity, measured by the
//! F2 corpus's curved families rather than left out of it:
//! - NURBS rolling-ball blends for the other supported pairs (cylinder–cylinder cross holes,
//!   ellipse and B-spline edges, non-coaxial circles) and NURBS offsets of B-spline faces in
//!   shells: their certified checks need B-spline surfaces in forge-ssi;
//! - corners of three blends where one is not a line between planes (a D-flat's corner with
//!   its vertical edge blended too), and corners of two blended edges of mixed convexity (the
//!   rolling ball changes the face it touches there: OCCT closes them with a free-form patch,
//!   an engine-defined corner SPEC §8.3 rule 5 does not yet cover for two edges) — a D-flat's
//!   top line and top arc meeting at its corner are built (W6 review round 4: their curved
//!   mitre, traced);
//! - trimmed blends around another feature (W6 review round 6): a blend that runs into a
//!   hole, a boss, a tunnel or a drill point — an entity not on the outer boundary of a face
//!   it touches or ends on — is `*_FAILED` naming the obstacle's face, with the largest value
//!   that builds clear of it in the reason; SPEC §6.6 defines the rolling ball there (OCCT
//!   trims it around the feature), so it is a capability gap, never `*_TOO_LARGE`;
//! - chamfer corners of three edges at vertices whose faces are not mutually perpendicular
//!   (W6 review round 6): SPEC §6.7 defines no chamfer corner, and OCCT's differs from the
//!   corner triangle there beyond §8.3 rule 5's 1e-5 — `CHAMFER_FAILED` naming the vertex
//!   until the Contract stage defines the corner;
//! - shells of bodies with **mitred blends** (the ellipse where two fillets meet at a corner,
//!   a traced B-spline mitre: offsets of ellipse and B-spline edges are not built) and of
//!   vertices of more than three faces (each vertex of a three-chamfer corner triangle): both
//!   `SHELL_FAILED` naming them;
//! - a blend radius equal to a face's width (a full round), a blend ending at a reflex vertex
//!   on a curved face, openings with both smooth and sharp edges, draft of a curved face or
//!   of a face next to a curved one (`DRAFT_FACE_UNSUPPORTED`, `DRAFT_FAILED`).
//!
//! **Selections** are [`Pick`]s — an id together with the index of the body it was resolved
//! on (the caller's numbering, e.g. forge-refs' `Entity::body`) and its key — and the
//! options name the index of the body operated on. Face and edge ids are per-body arena
//! indices, so a pick of another body (or an id the body does not have) is an explicit
//! failure (`SHELL_FACE_NOT_ON_BODY`, `CHAMFER_SIDE_NOT_ADJACENT`, `*_FAILED`), never the
//! entity of this body that happens to have the same index.
//!
//! Provenance (§5.2): blend faces `F/blend:{E}` (`F/bevel:{E}` for chamfers), corner
//! patches `F/corner:{V}`, shell offsets `S/offset:{X}` and rims `S/rim:{X}`; new edges and
//! vertices `F/edge:{A|B}`, `F/vertex:{…}`; modified entities keep their keys.
//!
//! Draft (§6.9, optional in v1) is built on planar faces between planar faces ([`draft`]):
//! drafted faces keep their keys.

mod blend;
mod cert2d;
mod check;
mod draft;
mod error;
mod geom;
mod interfere;
mod keys;
mod pcurve;
mod plan;
mod shell;
mod topo;

pub use blend::{BlendOptions, BlendOutput, ChamferSpec, chamfer, fillet};

/// Hooks for tests of this crate's failure paths (not part of the API).
#[doc(hidden)]
pub mod testing {
    /// Runs `f` with the work budget of the parameter-plane crossing certificate set to
    /// `budget` on this thread (0: every pair it has to examine stays unresolved), to test
    /// that an undecided check is `*_FAILED`, never a size limit.
    pub fn with_crossings_budget<R>(budget: usize, f: impl FnOnce() -> R) -> R {
        crate::cert2d::with_crossings_budget(budget, f)
    }
}
pub use draft::{DraftOptions, DraftSpec, draft};
pub use error::{
    BlendError, BlendOp, DraftFaceReason, EdgeDistanceLimit, EdgeRadiusLimit, Limit, Named,
    ShellLimit, ShellLimitReason, UnsupportedEdge, UnsupportedFace, UnsupportedReason,
    round_down_mm,
};
pub use forge_ir::v1::ShellDirection;
pub use keys::{KeyMap, Pick, pick_edges, pick_faces};
pub use shell::{ShellOptions, ShellOutput, shell};
pub use topo::Convexity;

/// Convexity of an edge of `body` (SPEC §5.3, at its parametric middle); `None` if the
/// edge does not lie between two faces.
pub fn edge_convexity(
    body: &forge_core::topo::Body,
    edge: forge_core::topo::EdgeId,
) -> Option<Convexity> {
    let plan = plan::Plan::from_body(body).ok()?;
    let adj = topo::Adj::new(&plan);
    topo::edge_convexity(&plan, &adj, *plan.emap.get(&edge)?)
}

/// The edges tangent-chain expansion adds to `edges` (SPEC §6.6), in the order found.
pub fn tangent_chain(
    body: &forge_core::topo::Body,
    edges: &[forge_core::topo::EdgeId],
) -> Vec<forge_core::topo::EdgeId> {
    let Ok(plan) = plan::Plan::from_body(body) else {
        return Vec::new();
    };
    let adj = topo::Adj::new(&plan);
    let set: Vec<usize> = edges
        .iter()
        .filter_map(|e| plan.emap.get(e).copied())
        .collect();
    let inv: std::collections::BTreeMap<usize, forge_core::topo::EdgeId> =
        plan.emap.iter().map(|(k, v)| (*v, *k)).collect();
    topo::tangent_chain(&plan, &adj, &set)
        .into_iter()
        .map(|i| inv[&i])
        .collect()
}

/// Pairs of faces of `body` that intersect, touch or come within 1e-6 mm of each other away
/// from the edges and vertices they share — a **verification helper** (forge-check's
/// validation does not detect a body passing through itself). Certified: forge-ssi's
/// intersections and the parameter-plane tests of this crate; `Err` names a pair that cannot
/// be certified (e.g. a B-spline face). Two faces tangent along a shared edge (a blend and
/// its neighbour, two blends of one tangent chain) are certified apart outside a band of
/// half-width `√(2R·5e-3)` around it (contacts inside are within 5e-3 mm of each other):
/// first, when they are joined tangentially along every edge they share (forge-ssi takes
/// seconds on such pairs), and otherwise where forge-ssi cannot resolve them. The whole of
/// every face is covered, poles and apexes included (W6 review round 3). Quadratic in the
/// number of faces.
pub fn self_intersections(
    body: &forge_core::topo::Body,
) -> Result<Vec<(forge_core::topo::FaceId, forge_core::topo::FaceId)>, String> {
    let plan = plan::Plan::from_body(body)?;
    let faces: Vec<usize> = (0..plan.fs.len())
        .filter(|&f| plan.fs[f].is_some())
        .collect();
    let mut ck = interfere::Checker::new(&plan, &faces);
    ck.tangent_band = true;
    let inv: std::collections::BTreeMap<usize, forge_core::topo::FaceId> =
        plan.fmap.iter().map(|(k, v)| (*v, *k)).collect();
    let mut out = Vec::new();
    for (i, &a) in faces.iter().enumerate() {
        for &b in &faces[i + 1..] {
            let sh = ck.topo_shared(a, b);
            let res = ck.pair(a, b, &sh);
            match res {
                interfere::Outcome::Clear => {}
                interfere::Outcome::Hit { .. } => out.push((inv[&a], inv[&b])),
                interfere::Outcome::Unverified(m) => {
                    return Err(format!(
                        "faces {} and {}: {m}",
                        plan.fs[a].as_ref().expect("face").prov.name(),
                        plan.fs[b].as_ref().expect("face").prov.name()
                    ));
                }
            }
        }
    }
    Ok(out)
}
