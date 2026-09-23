//! STEP (ISO 10303-21 physical files, AP214 / AP242) — **planned for milestone F1**; this
//! module is a placeholder that fixes the design.
//!
//! # Plan
//! - **Our own reader and writer.** A streaming Part 21 lexer/parser (entity instances,
//!   typed parameters, complex instances) and an emitter with canonical, deterministic
//!   instance numbering. No dependency on another CAD kernel or STEP toolkit
//!   (CLAUDE.md, "own the core"); OCCT is used only in the oracle to cross-check files.
//! - **Schemas.** AP214 (`AUTOMOTIVE_DESIGN`) and AP242 (`AP242_MANAGED_MODEL_BASED_3D_
//!   ENGINEERING`) geometry and topology: `manifold_solid_brep`, `closed_shell`,
//!   `advanced_face`, `face_bound`/`face_outer_bound`, `edge_loop`, `oriented_edge`,
//!   `edge_curve`, `vertex_point`, the analytic surfaces/curves Forge has (plane,
//!   cylindrical, conical, spherical and toroidal surfaces; line, circle, ellipse) and
//!   `b_spline_*_with_knots` / rational B-splines; units and `product` structure.
//! - **Seams and degenerate edges (ADR 0012).** Forge has neither. On **export**, a
//!   periodic face bounded by ring edges gets a synthesized seam edge (used twice by the
//!   face, placed deterministically, e.g. at parameter 0 or at the tessellation cut) and
//!   singular points get degenerate `vertex_loop`/degenerate edges where target readers
//!   need them; ring edges get a synthesized vertex. On **import**, seams are detected
//!   (an edge used twice by one face with opposite orientation on a periodic surface) and
//!   removed by merging the face's parameter domain, degenerate edges at poles and
//!   apexes are dropped, and ring edges lose their artificial vertices — healing
//!   imported data into Forge's model. Provenance of imported entities uses
//!   `Role::Imported` with the STEP instance ids as sources.
//! - **Tolerances.** Imported geometry is checked against the file's
//!   `uncertainty_measure_with_unit`; edges/vertices get explicit tolerances and the
//!   result is validated with `forge_core::validate` (structured errors, never silent
//!   healing).
//! - **Verification.** Round-trip tests (Forge → STEP → Forge preserves topology counts,
//!   geometry and mass properties exactly for analytic bodies), differential import of the
//!   ABC corpus against the OCCT oracle, and golden files for byte-stable export.
