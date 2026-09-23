//! # forge-params — IR v1 parameters and the expression evaluator of record
//!
//! SPEC-v1 §2.7 [D-12] and §2.8 [D-13] (interface I2). The language itself (parser,
//! canonical printer, type checker, scopes and dependency graph) is pure and lives in
//! `forge_ir::v1::expr`; this crate *evaluates*:
//!
//! - [`eval`] / [`eval_at`]: one type-checked expression, IEEE-754 binary64, bit-identical on
//!   every target (degree trigonometry through `forge_ir::v1::degtrig`, every other
//!   transcendental through `forge_core::math`);
//! - [`evaluate`]: every parameter of a document in dependency order, with bounds
//!   (`PARAM_OUT_OF_RANGE`) and `PARAM_FAILED` propagation, giving [`ParamValues`], which
//!   also evaluates feature fields ([`ParamValues::scalar`], [`ParamValues::boolean`],
//!   [`ParamValues::feature_failure`]) and produces the report's `params`
//!   ([`ParamValues::report`]).
//!
//! The IR-V1 plan names this `forge_regen::params::evaluate`; it is a crate of its own so that
//! the regeneration workstreams can depend on it without sharing a crate.

pub mod eval;
pub mod values;

pub use eval::{EvalError, EvalErrorKind, RAD_TO_DEG, Value, eval, eval_at, is_count, no_neg_zero};
pub use values::{Failure, ParamEntry, ParamValues, evaluate};
