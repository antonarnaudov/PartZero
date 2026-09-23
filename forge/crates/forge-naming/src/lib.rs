//! # forge-naming — persistent references and the naming stability harness
//!
//! Persistent naming is the #1 risk of parametric CAD: after an upstream edit, a
//! reference to a face or edge must keep pointing at the *same* entity, or be flagged —
//! never silently re-bound to another one. Forge names every entity natively from its
//! provenance ([ADR 0006](../../../docs/adr/0006-native-persistent-naming.md)); this
//! crate measures how well those names survive edits and implements the layered
//! resolver that falls back — always with a warning — when they do not.
//!
//! - [`EntityRef`]: a stored reference — provenance name (primary key) + region of the
//!   owning body + geometric [`Fingerprint`] + cardinality.
//! - [`resolve()`]: exact provenance name (validated against the fingerprint) →
//!   fingerprint among split pieces / `#index` siblings / region bodies → geometric match
//!   with confidence and ranked candidates → missing. Anything but
//!   [`Status::Exact`] is a flag.
//! - [`ModelView`]: an evaluated document with names and fingerprints per entity.
//! - [`harness`]: the Phase 0 spike-2 harness — 20 maker models × scripted mutations,
//!   every face and edge referenced, each resolution scored against a ground truth
//!   computed from geometry alone ([`harness::truth`]). Run it with
//!   `cargo run -p forge-naming --release --bin naming-harness`.
//!
//! IR v0 has no feature → face references yet (they arrive in IR v1 as semantic
//! queries); this crate measures the foundation those queries will stand on.

pub mod fingerprint;
pub mod harness;
pub mod resolve;
pub mod view;

pub use fingerprint::{Fingerprint, GeomKind, Support};
pub use resolve::{
    AUTO_ACCEPT_CONFIDENCE, Candidate, EntityRef, Reason, Resolution, Status, resolve,
};
pub use view::{EntityId, EntityKind, Loc, ModelView};
