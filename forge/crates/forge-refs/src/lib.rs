//! # forge-refs — IR v1 references (interface I3)
//!
//! Everything a feature needs to point at topology (SPEC-v1 §3, §5, §7.6), extracted from
//! `forge-naming` so that `forge-regen` can depend on it (ADR 0013 follow-up):
//!
//! | Item | SPEC | |
//! |---|---|---|
//! | [`Scope`] ([`ScopeBuilder`]) | §5.3 | the bodies of a part in a feature's input state, the earlier features ([`FeatureTable`]), aliases of merged keys |
//! | keys ([`keys`]) | §5.2 | provenance keys by feature id with qualifiers (`@m`, `@c.end`), escaping, display names, the key invariant ([`Scope::key_problems`]) |
//! | [`eval_query`] | §5.3–§5.4 | the 23 query operations, named/broad tracking, canonical order |
//! | [`check_ref`], [`static_kind`] | §5.3–§5.5 | static checks (pinned to validation by the I9 typing fixtures) |
//! | [`resolve()`], [`resolve_with`] → [`Resolution`] | §5.7–§5.8 | exact provenance → capture validation → geometric fallback → cardinality, with the `refs` report entry (I5) |
//! | [`Scope::fingerprint`], [`capture`] | §5.6 | exact fingerprints (sizes, centroids and boxes on the exact geometry) |
//! | [`Scope::probe`] | §7.6 | probes (I6) |
//! | [`synthesize_query`] | §5.8 | a query selecting exactly one candidate |
//! | [`CurveRename`] | §5.9 | `renameCurve` on queries and capture keys (members and junction qualifiers recomputed) |
//! | [`plane_frame`], [`axis`], [`point`], [`direction`], [`datum_plane`], [`datum_axis`] | §3 | face frames, datums, axis references, sketch on face |
//!
//! # Using it from the evaluator (integrator notes)
//! 1. Before each feature, build a [`Scope`]: `FeatureTable::from_part(part, index)`, then set
//!    each earlier feature's [`FeatureStatus`], the [`SweepRegion`]s of every extrude/revolve
//!    (outer and inner-loop curves and the forge-ops region junctions, in world coordinates)
//!    and the evaluated [`DatumValue`]s; add the part's current bodies with their [`Origin`]s
//!    and the aliases of same-domain merges (chains are closed by the builder); give the W1
//!    expression evaluator as the scalar and bool hooks ([`ScopeBuilder::scalars`],
//!    [`ScopeBuilder::bools`]). Stamp provenance with **feature ids** (or map the stamped
//!    segment with [`ScopeBuilder::provenance_feature`]).
//! 2. In debug builds, assert [`Scope::key_problems`] is empty after every operation (the key
//!    invariant of §5.2 rule 3: every key complete — caps with their member, side–side
//!    junction edges with their `@c.end`, every edge source a face of the body — and unique
//!    within its body **except split pieces**, which share their key on one carrier, and
//!    intersection vertices `G/vertex:{…}`, which §5.2 does not qualify; see
//!    [`keys::key_problems`]). Correct splits never trip it; faces or edges sharing a key on
//!    different carriers, and a sweep's own vertices sharing a key, always do.
//! 3. Resolve every Ref-valued field in field order with [`resolve_with`] (the field's JSON
//!    pointer and default card); a failed [`Resolution`] fails the feature with its code
//!    (`Resolution::error`), and every resolution's `report` goes into the feature's `refs`,
//!    its `warnings` into the feature's warnings. [`resolve()`] is for field-less uses (report
//!    `field` `""`, the pointer of the whole feature).
//! 4. Captures are written only by the command layer ([`capture`] of a resolution's members).
//! 5. Until W4, forge-ops stamps no qualifiers: caps get their member `@m` from the body's
//!    origin or the sweep's only region, junction edges `@c.end` from the recorded junctions
//!    ([`keys`]). A multi-region sweep joined into another body leaves its caps unqualified (a
//!    key problem): forge-ops must stamp `Provenance::qualifier` on caps at creation (W4), and
//!    pattern copies / hole faces are expected stamped by W5.
//!
//! # Deviations and contract notes
//! - **Vertex qualifiers.** §5.2 gives junction qualifiers to side–side edges only; the two
//!   vertices at the ends of a "D" profile's two junction edges would then share a key. Forge
//!   qualifies a junction vertex with the smallest qualifier of its incident junction edges of
//!   the same feature (`…/vertex:{…}@c.end`). The W7 oracle keys vertices without a qualifier
//!   (`oracle/v1/topo.py`): the two engines' vertex keys differ until the SPEC settles it
//!   (`REF_MISMATCH` in independent-refs mode, §8.1).
//! - **Intersection vertices.** §5.2 keys the new vertices of a body operation `G/vertex:{…}`
//!   with no qualifier, so a tool crossing an edge twice gives two vertices one key; the key
//!   invariant accepts that (sources of two or more features), and such a vertex is told
//!   apart only by its display index and probe.
//! - **Body keys.** §5.6 captures bodies but §5.2 defines no body key; bodies are keyed
//!   `F/body:m` (origin feature and member), `@i`/`@i.j` for pattern instances.
//! - **Fallback pool** (§5.7 step 4 scores "every entity of the member's kind in scope").
//!   Every such entity is scored, but those another captured member accounts for (its key's
//!   step-1 hits, computed before any fallback, and entities steps 3–4 already took) are never
//!   identical matches or split pieces, and are ranked after every free candidate, so two
//!   captured members never collapse into one entity whatever the key order. A captured key
//!   that does not parse names no feature: none of its matches is "own", so none is used. Several
//!   geometry-identical entities are `REF_AMBIGUOUS` (row 2) whatever their features, the own
//!   feature's first — an own entity never wins over a coincident one of another feature. A
//!   **unique** geometry-identical entity is used (row 1) **only if it is the member's own
//!   feature's**: coincident geometry of another feature is a different design entity
//!   (auto-accepting across features re-bound a suppressed tray floor's top edges onto the
//!   coincident bottom edges of its walls: 8 SILENT_WRONG in the v1 harness), so it is a
//!   candidate at `MAX_DISAMBIGUATION_CONFIDENCE` (`REF_UNCERTAIN`) — first if the query still
//!   returns it (an edge a boolean re-keyed `G/edge:{…}`), otherwise after the member's own
//!   split pieces; pieces on the captured carrier count only from the own feature; the
//!   plausible and tie rows rank everything. A member of a **suppressed** feature is
//!   `REF_MISSING` (`feature-suppressed`) without candidates (step 1: it went away with its
//!   feature).
//! - **Keys the query dropped** (§5.7 step 3 defines `M` on the step-1 result, so a literal
//!   reading sends a named member the query's own pick or filter dropped to step 4, which
//!   "repairs" it into the entity that still carries the key). A captured key the scope still
//!   carries but the step-1 result does not is **removed** instead (`REF_SET_CHANGED`, its
//!   `removed` lists it: the query is the intent, step 5), for every card.
//! - **Split proxy** (§5.7 step 3: "more `neighbors`" is a split). The pieces are the member
//!   and its same-carrier neighbours inside the captured box, also for a member that is
//!   geometry-identical to its capture (a sliver piece within the comparison's tolerances is
//!   still a piece). When no neighbour lies in the box, a geometry-identical member is exact
//!   (a collinear segment added next to an unchanged face is no piece of it); a changed one —
//!   the capture predates other edits (§0.6 never refreshes captures on exact commits) and its
//!   box no longer delimits the pieces — fails `REF_SPLIT` **whatever the card** (never used
//!   on the anchor alone: harness family (g) found that silent-wrong).
//! - **Splits under a choosing query** (§5.7 step 3 applies "all pieces" to the members of the
//!   step-1 result, after the query's picks and filters). Pieces that share the captured key
//!   went through the query: a piece its pick or filter dropped is never brought back (the
//!   query is the intent), and the pieces it kept are used, card permitting. Pieces with **new
//!   keys** are no members of the query's named sources, so a query that chooses among its
//!   sources' members (`extreme`, `largest`, `smallest`, `filter`, `intersect`, `minus`) never
//!   saw them: such a split fails `REF_SPLIT` whatever the card — also when the pick dropped
//!   the captured member itself (its key still carried by one piece). Queries that only name
//!   and unite take every piece (card permitting), as §5.7 says. Harness family (i) scores
//!   split sources (the pick over every piece is the truth); the literal reading was
//!   silent-wrong on 3 picks.
//! - **Integer cards and splits** (§5.7 step 3 "an `n` the pieces break"): `REF_SPLIT` only when
//!   the set without the splits' extra pieces would have `n` members; any other count is
//!   `REF_CARDINALITY` `{ field, expected, found }`.
//! - **Comparison scale** (§5.7 step 4 "within the forge-naming tolerances"): captures store no
//!   scale, so the comparison runs at the larger of the scope's scale and a lower bound of the
//!   captured body's diagonal derived from the capture ([`geom::comparison_scale`]; forge-naming
//!   uses the larger of the two bodies' diagonals).
//! - **Junction swaps** (§5.7 step 3 row "|M| = 1, same type, same neighbours → exact"). A
//!   reversed curve swaps `@c.start`/`@c.end` between the two junction edges of a "D", which
//!   step 3 alone would call exact. Captures are not refreshed on exact commits (§0.6), so a
//!   reversal is recognised by **place**, not identity: the key's entity is compared with its
//!   sibling junctions of the same curve pair by their distance to the captured box, in the
//!   world and after moving the captured box with the body's box centre, and by the
//!   body-relative centroid. The key's entity stays exact when it moved with the body (a rigid
//!   move, e.g. by exactly the junction gap); otherwise a sibling at the captured place (or
//!   strictly nearer, or tied without the body-relative match) makes the member
//!   `REF_AMBIGUOUS` (that sibling first, then the name-anchored entity), also after earlier
//!   distance edits or moves. A moved *hole* "D" inside an unmoved body, by exactly its
//!   junction gap, is indistinguishable from a reversal and stays ambiguous (the one
//!   `WRONG_BUT_FLAGGED` of harness family (a)). No other qualified family (caps `@m`, hole
//!   faces `@p`, pattern copies `@i`) is compared with its siblings: a parameter edit that
//!   moves copy `@1` to where `@2` was stays exact.
//! - **Candidate reasons** (the metrics schema describes `identical` as "confidence
//!   `IDENTICAL_MATCH_CONFIDENCE`"; §5.7 lists identical candidates at 0): see
//!   [`mod@resolve`] for the reason/confidence pairs emitted. No candidate is used without an
//!   explicit accept, whatever its reason or confidence.
//! - **Multi-piece captures** (§5.7 step 3 is written per captured member). Captured named
//!   members are validated per key: a key several captured members carry (an accepted split,
//!   re-captured) is exact when as many pieces carry it, matched one-to-one by fingerprint;
//!   more pieces are a split (one `REF_SPLIT_ACCEPTED`), fewer send the unmatched captured
//!   pieces to step 4. An integer card the accepted pieces break fails with `REF_SPLIT` and the
//!   pieces as candidates. At most one warning per code and key.
//! - **Merged neighbourhoods.** A member found through an alias whose same-carrier neighbours
//!   decreased reports both `REF_MERGED` and `REF_NEIGHBORHOOD_CHANGED` (status
//!   `neighborhood_changed`). Aliases reach nested keys ([`Scope::normalize_key`]): an edge
//!   `G/edge:{A|C}` next to a face merged into `B` is found as `G/edge:{B|C}` (merged).
//! - **Rejected queries keep candidates.** A captured reference whose query names a curve that
//!   no longer exists fails with `QUERY_UNKNOWN_CURVE`, and its capture is still validated so the
//!   report lists repair candidates.
//! - **New named members** (e.g. a second region's cap under `cap { feature, end }`) are handled
//!   like broad additions (`added`, then the cardinality check), name-anchored members first.
//! - **Unresolved entries without a member.** A reference without a capture has no member key:
//!   its card-one ambiguity lists the candidates under key `""`, and a source of a suppressed
//!   feature is reported under key `""` with the feature's name and reason
//!   `feature-suppressed`.
//! - **Every feature-id source is gated** (§7.5 `DEPENDENCY_FAILED`: "any feature referenced by
//!   id or named in a query failed"): `sides`, `created` and `instance` of a failed feature fail
//!   too, and yield nothing (reason `feature-suppressed`) for a suppressed one.
//! - **`tagged`** passes the tag's own resolution through: its infos and warnings (e.g.
//!   `REF_REPAIRED`) and member statuses on success, its code and candidates on failure
//!   ([`RefError::TagFailed`], not `DEPENDENCY_FAILED`: the tag feature itself did not fail).
//!   A tag's query may only name tags earlier than the tag (§6.12: it resolves at its own
//!   position); one naming a later tag or itself fails `UNRESOLVED_FEATURE` before anything is
//!   resolved, so tag cycles terminate even when every tag is before the consumer.
//! - **Probes are never made up.** An entity whose probe cannot be computed is left out of the
//!   report with a `FORGE_PROBE_FAILED` warning; a reference that would use it fails with the
//!   probe's `FORGE_*` code.
//! - **Expression-driven frames** (`datum_plane` `frame` mode and explicit PlaneRef frames) are
//!   `INVALID_PLANE` when the evaluated normal and x direction are not perpendicular
//!   (`|n̂·x̂| > 1e-9`, validation's test for literals, [W0-8]).
//! - **Face-frame ties** (§3.1 step 3): `|n·axis|` values within `ANGULAR_TOLERANCE` of the
//!   minimum are ties (decided against the minimum, X before Y before Z).
//! - **Query synthesis** adds a last strategy to §5.8's list: peeling the members above the
//!   candidate along one axis (`minus`/`extreme`), for interior pieces no axis isolates.
//! - **Exact face geometry** ports forge-check's (crate-private) domain reconstruction and box
//!   helpers into [`exact`]; forge-check should expose per-face properties and this copy should
//!   then be removed.
//!
//! Deterministic: every map is ordered, every sort has a total tie-break, every quadrature is
//! fixed. Arena ids never leave the process: entities are named by keys and located by probes.

pub mod error;
pub mod exact;
pub mod frames;
pub mod geom;
pub mod keys;
pub mod probe;
pub mod query;
pub mod rename;
pub mod resolve;
pub mod scope;
pub mod synth;
pub mod table;
pub mod typing;

pub use error::RefError;
pub use forge_ir::v1::metrics::Origin;
pub use frames::{
    AxisLine, Evaluated, PlaneFrame, axis, datum_axis, datum_plane, direction, plane_frame, point,
};
pub use keys::{EntityId, KeyProblem, body_key, display_key};
pub use query::{Member, QuerySet, eval_query};
pub use rename::CurveRename;
pub use resolve::{FieldSpec, Resolution, ResolvedMember, capture, resolve, resolve_with};
pub use scope::{BoolHook, Entity, Props, ScalarHook, Scope, ScopeBody, ScopeBuilder};
pub use synth::synthesize_query;
pub use table::{
    CurveClass, DatumValue, FeatureInfo, FeatureStatus, FeatureTable, Junction, Profile,
    SweepRegion,
};
pub use typing::{RefField, TypeError, check_ref, static_kind};

use forge_ir::v1::Fingerprint;
use forge_ir::v1::metrics::Probe;

/// The probe of an entity (I3 `probe(entity)`; §7.6).
pub fn probe(e: Entity, scope: &Scope<'_>) -> Result<Probe, RefError> {
    scope.probe(e)
}

/// The fingerprint of an entity (I3 `fingerprint(entity)`; §5.6).
pub fn fingerprint(e: Entity, scope: &Scope<'_>) -> Result<Fingerprint, RefError> {
    scope.fingerprint(e)
}
