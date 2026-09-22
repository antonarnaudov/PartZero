//! # forge-core — the foundation of the Forge geometry kernel
//!
//! Every other Forge crate (operations, meshing, checking, I/O, regeneration) builds on
//! the types in this crate. It serves the Feature-Graph IR v0 contract
//! (`forge-ir/SPEC.md`): millimetres, a normative linear tolerance of `1e-6` mm, and
//! metrics that count faces/edges by canonical geometry type.
//!
//! ## Architecture
//! | Module | Contents |
//! |---|---|
//! | [`scalar`] | The [`Scalar`] trait and its implementations: `f64`, [`Interval`] (certified enclosures), [`Dual`] (forward-mode derivatives). |
//! | [`math`] | Deterministic transcendental functions (libm), π, degree conversions exact at right angles. |
//! | [`linalg`] | [`Vec2`]/[`Vec3`] (points are aliases), [`Mat3`], rigid [`Transform`], orthonormal [`Frame`]. |
//! | [`predicates`] | Adaptive exact `orient2d`, `orient3d`, `incircle`, `insphere` (after Shewchuk). |
//! | [`tolerance`] | The explicit, named [`Tolerance`] (`IR_DEFAULT`). |
//! | [`arena`] | [`Arena<T>`] with typed generational [`Id<T>`]. |
//! | [`geom`] | Curves (2D/3D), surfaces, NURBS: evaluation, derivatives, projection, arc length. |
//! | [`topo`] | Half-edge B-rep ([`Body`], faces, loops, coedges, edges, vertices) with [`Provenance`], [`BodyBuilder`], [`validate`]. |
//!
//! ## Rules this crate enforces (and every extension must keep)
//! 1. **Bit-identical determinism** on macOS, Windows, Linux and wasm32:
//!    - transcendental functions only via [`math`] (libm), never `f64::sin` & co.;
//!      `+ − × ÷ sqrt` are IEEE-exact and fine; no `mul_add`, no `f64::powi`;
//!    - no iteration over `HashMap`/`HashSet` that can reach an output: arenas iterate by
//!      index, collections use `BTreeMap`/`BTreeSet`/sorted `Vec`;
//!    - iterative algorithms use fixed schedules and deterministic tie-breaking.
//! 2. **Generic numerics**: algorithms that will be certified or differentiated are
//!    written over `S: Scalar` (see the rules in [`scalar`]). Curve and surface
//!    evaluation is generic in the parameters.
//! 3. **Robust decisions**: orientation / in-circle decisions use [`predicates`]; never
//!    compare a raw floating-point determinant with a magic epsilon in topology code.
//!    Modelling tolerances are explicit ([`Tolerance`]) and stored on vertices and edges.
//! 4. **Topology in arenas** with typed generational ids; no `Rc<RefCell<…>>`. Ids are
//!    process-local; persistence uses [`Provenance::name`].
//! 5. **Every face, edge and vertex carries provenance**, checked by [`validate`].
//! 6. **No seams, ring edges allowed, singularities are not edges** (see [`topo`]).
//! 7. **Never silently wrong**: constructors validate and return structured errors with
//!    stable codes ([`GeomError::code`], [`NurbsError::code`], [`TopoError::code`],
//!    [`IssueCode::as_str`]).
//! 8. `unsafe` is forbidden (workspace lint).
//!
//! ## Extending forge-core
//! - **A new curve or surface type**: add a struct with private fields and a validating
//!   constructor in `geom/`, implement generic `eval`/`derivs2` (and `normal` for
//!   surfaces) plus `project`, then add an enum variant to [`Curve3`]/[`Surface`] and
//!   extend every `match` (the compiler lists them). Document the parametrization in the
//!   type docs and in the table on the enum. Add property tests to
//!   `tests/geom_properties.rs` (derivatives vs finite differences / `Dual`, projection
//!   round trip, normal orthogonality) and a validation case for a face or edge on it.
//! - **A new scalar type** (e.g. `Rational`): implement [`Scalar`]; document how
//!   transcendental functions behave; add containment/agreement property tests.
//! - **A new predicate**: write a floating-point filter with a proven error bound and an
//!   exact fallback on expansions (`predicates/expansion.rs`), and test signs against
//!   `num-rational` on random and near-degenerate inputs (`tests/predicates_exact.rs`).
//! - **A new topology operation** (in `forge-ops`): build or edit bodies only through
//!   [`BodyBuilder`] (use [`BodyBuilder::from_body`] to edit), give every new entity a
//!   [`Provenance`], and run [`validate`] in tests (it must report no errors). If you need
//!   a new invariant, add an [`IssueCode`] with a stable string.
//! - **A new provenance role**: add a [`Role`] variant, extend [`Provenance::name`] and
//!   the grammar in its docs, and add a naming test. Names are persisted: never change
//!   the rendering of existing roles without a migration.

pub mod arena;
pub mod geom;
pub mod linalg;
pub mod math;
pub mod predicates;
pub mod scalar;
pub mod tolerance;
pub mod topo;

pub use arena::{Arena, Id};
pub use geom::{
    Circle2, Circle3, Cone, Curve2, Curve3, Cylinder, Ellipse2, Ellipse3, GeomError, Line2, Line3,
    NurbsCurve2, NurbsCurve3, NurbsError, NurbsSurface, Plane, Sphere, Surface, Torus,
};
pub use linalg::{Frame, Mat3, Point2, Point3, Transform, Vec2, Vec3};
pub use predicates::{Sign, incircle, insphere, orient2d, orient3d};
pub use scalar::{Dual, Interval, Scalar};
pub use tolerance::Tolerance;
pub use topo::{
    Body, BodyBuilder, EntityRef, IssueCode, Provenance, Role, Severity, TopoError, TopoIssue,
    validate,
};
