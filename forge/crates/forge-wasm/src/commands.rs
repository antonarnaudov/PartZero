//! Command-layer engine entry points (SPEC-v1 §0.6, §2.4, §5.9, §9.2; W9, interface I7).
//!
//! The DocStore's domain ops that need Forge, host-independent (tested natively; `web` binds
//! them). Each takes the document text (either IR version; a v0 document is migrated) and
//! returns an [`Edited`] document — canonical `aicad.ir/1` text — or a [`Rejection`]. They are
//! pure: nothing is stored here, the command layer records the edit (and its inverse) as one
//! undoable transaction.
//!
//! | Op | SPEC | What it writes |
//! |---|---|---|
//! | [`set_param`] | §2.1, §2.4 | a parameter's `value`, a literal or an expression stored in canonical form |
//! | [`rename_feature`] | §0.3 rule 2, §5.9 | a feature's `name` (references use ids: nothing else changes) |
//! | [`upgrade_feature`] | §9.2 | a feature's `v`, with the report diff it causes |
//! | [`capture_ref`] | §0.6, §5.6 | a Ref's `capture`, from its current resolution |
//! | [`accept_ref_proposal`] | §5.8, §5.9 | a Ref replaced by its `proposal` (query and fresh capture) |
//! | [`accept_ref_candidate`] | §5.9 | a Ref's query replaced by a candidate's `query`, capture refreshed |
//! | [`rename_curve`] | §5.9 | a sketch curve's id and every query field, constraint argument, region, hole point and capture key naming it |
//!
//! (`writeBackSolution` is [`crate::engine::write_back`], iterated to its fixed point.)
//!
//! **Every op reads and writes canonical text**: the input is loaded with every expression in
//! its canonical form (SPEC-v1 §0.4, §2.4; a document whose canonical form would be rejected is
//! refused with those rejections, [W0-20]), so `changed` compares canonical forms and an op's
//! inverse restores the same bytes. The pure IR edits (`setParam`, `renameFeature`) load with the
//! contract's rejection pipeline alone and so accept documents Forge does not evaluate (the
//! optional `draft`, SPEC-v1 §6.9; any future mandatory type before it is implemented); the
//! others are verified by evaluation and are refused on such documents with this engine's
//! capability check (`UNSUPPORTED_FEATURE`, `UNSUPPORTED_FEATURE_VERSION`).
//!
//! **Every write is verified by evaluation before it is returned** (CLAUDE.md "never return
//! silently wrong"): a capture must resolve to exactly the set it records; an accepted
//! proposal or candidate must resolve to what it promised; a renamed curve must leave the
//! report as it was up to the rename — statuses, codes, counts, types, origins and every
//! resolved reference's members (keys rewritten) exactly, float metrics and probes within
//! SPEC-v1 §8.2's tolerances (see [`rename_curve`]). A write that fails its check is refused
//! with `COMMAND_NOT_EXACT` and never stored. One thing a rename cannot check is listed
//! instead: capture keys it rewrote in a reference the engine does not resolve (its feature
//! fails before resolving it, or a Ref nested in a direction) are in `result.unverified`.
//!
//! **How a capture is computed.** forge-regen keeps its scopes private, so a fresh capture is
//! read from the resolver itself: the reference is evaluated with an **empty** capture
//! (`{ "members": [] }`), so every member of its current result is "added since the capture"
//! (§5.7 step 5) and the report's `proposal` (§5.8) is the same query with a fresh capture of
//! exactly that set, computed by forge-refs' `capture`. A reference whose current result is
//! empty (card `any`) captures `{ "members": [] }`. Because the query read without a capture
//! can differ from the reference's current resolution (a capture restricts a key to the entity
//! it designated, [W0-33]; a member found only by the geometric fallback is not in the query's
//! result), `captureRef` first checks the document's own report entry (not failed, no member
//! repaired) and then requires the fresh capture, and the captured document, to resolve to the
//! same members `(key, probe)` as that entry. The integrator can replace this with a direct
//! `forge_regen::v1::capture_ref` of the current resolution (notes in the W9 report); the
//! contract is the same. The ops that write one reference (`captureRef`, `acceptRefProposal`,
//! `acceptRefCandidate`) read and verify that reference's entry only, so they evaluate the
//! model only through its feature (`evaluate_through`: a feature references only earlier ones).
//!
//! **Command errors** (not IR report codes; the op is not applied). `details` carries the
//! structured context; ids and keys that fail the id grammar are never echoed (§0.3 rule 1).
//!
//! | Code | When |
//! |---|---|
//! | `COMMAND_INVALID_ARGUMENT` | a malformed argument (`{ argument, reason }`) |
//! | `COMMAND_UNKNOWN_FEATURE` / `_PARAM` / `_SKETCH` / `_CURVE` | no such feature, parameter, sketch or declared curve |
//! | `COMMAND_NOT_A_REF` | the field is not a Ref of the feature |
//! | `COMMAND_NO_REF_REPORT` | the reference was not resolved: `reason` `suppressed`, `failed` (with the feature's `code`) or `not-reported` (a Ref nested in a direction, §5.8 [W0-34]) |
//! | `COMMAND_REF_FAILED` | captureRef of a reference that fails — the document's own report entry: `code`, `members`, `unresolved` (captured keys, candidates with queries: the arguments of `acceptRefCandidate`), `proposal` (bool): repair it first |
//! | `COMMAND_REF_REPAIRED` | captureRef of a reference with a member found only by the geometric fallback (`code: "REF_REPAIRED"`, `repaired` keys, `proposal`): accept its proposal (`acceptRefProposal`) |
//! | `COMMAND_NO_PROPOSAL` | acceptRefProposal without a `proposal` (`status`, `code`) |
//! | `COMMAND_UNKNOWN_MEMBER` / `COMMAND_UNKNOWN_CANDIDATE` | no unresolved member / candidate with that key (and index) |
//! | `COMMAND_CANDIDATE_AMBIGUOUS` | several candidates carry the key (split pieces): pass its index or probe |
//! | `COMMAND_CANDIDATE_CHANGED` | the candidate chosen is not the entity whose probe the caller gave (`reason: "probe"`, `index`, `expected`, `found`): the model changed since its report was read |
//! | `COMMAND_CANDIDATE_NO_QUERY` | the candidate has no synthesised `query` (§5.9: "the op fails if there is none") |
//! | `COMMAND_CANDIDATE_PARTIAL` | the reference has other members or unresolved members that replacing its query would drop |
//! | `COMMAND_NOT_AN_UPGRADE` | upgradeFeature to an older `v` |
//! | `COMMAND_NOT_EXACT` | the write failed its verification (`op`, `reason`): a capture or repair that does not resolve to what it records, a capture whose query (read without it) or result differs from the current resolution (`members`, `found`), a candidate query that does not resolve by itself, a rename whose report differs, whose sketch is not evaluated or that meets a pattern `body` member the two readings of §5.3 rewrite differently (`patterns`), a write-back without a fixed point or that fails a feature |
//! | `COMMAND_CAPTURE_UNAVAILABLE` | the resolver gave no fresh capture (an engine inconsistency) |

use std::collections::{BTreeMap, BTreeSet};

use forge_ir::v1::metrics::{
    EvalReport, FeatureReport, MemberStatus, Probe, RefMember, RefReport, RefStatus, Status,
};
use forge_ir::v1::{Document, Feature};
use serde_json::{Map, Value, json};

use crate::engine::Rejection;

/// The result of a command-layer edit.
#[derive(Clone, Debug, PartialEq)]
pub struct Edited {
    /// The edited document: canonical `aicad.ir/1` text (SPEC-v1 §0.4) ending with a newline.
    pub document: String,
    /// `false` when the op changed nothing (the canonical input and output are equal).
    pub changed: bool,
    /// Op-specific result (previous values for the inverse op, the report data it used).
    pub result: Value,
}

// ---- errors and argument display ------------------------------------------------------------

fn refusal(code: &str, message: impl Into<String>, details: Value) -> Rejection {
    Rejection {
        code: code.to_string(),
        message: message.into(),
        errors: Vec::new(),
        details,
    }
}

/// An id as shown in messages: itself when it follows the id grammar (possibly dotted, up to
/// `MAX_REF_SEGMENTS` segments), else its length only (§0.3 rule 1, no echo).
fn shown(id: &str) -> String {
    if id_like(id) {
        format!("{id:?}")
    } else {
        format!("(an invalid id of {} bytes)", id.len())
    }
}

fn id_like(id: &str) -> bool {
    let segs: Vec<&str> = id.split('.').collect();
    segs.len() <= 3 && segs.iter().all(|s| forge_ir::v1::ids::is_id(s))
}

/// An id for `details`: the id, or `null` when it would be echoed unsafely.
fn id_value(id: &str) -> Value {
    if id_like(id) { json!(id) } else { Value::Null }
}

/// A provenance key or JSON pointer for `details`/messages: only the characters keys and
/// pointers are made of (ids, `/ : { } | @ + % .`), at most 2048 bytes.
fn key_like(k: &str) -> bool {
    k.len() <= 2048
        && k.chars()
            .all(|c| c.is_ascii_alphanumeric() || "_./:{}|@+%".contains(c))
}

fn key_value(k: &str) -> Value {
    if key_like(k) { json!(k) } else { Value::Null }
}

fn shown_key(k: &str) -> String {
    if key_like(k) {
        format!("{k:?}")
    } else {
        format!("(a key of {} bytes)", k.len())
    }
}

pub(crate) fn invalid_argument(argument: &str, reason: &str) -> Rejection {
    refusal(
        "COMMAND_INVALID_ARGUMENT",
        format!("invalid argument {argument}: {reason}"),
        json!({ "argument": argument, "reason": reason }),
    )
}

// ---- documents --------------------------------------------------------------------------------

/// What an op needs of the documents it reads and writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Needs {
    /// A pure IR edit, nothing evaluated but the parameters (`renameFeature`, `setParam`): the
    /// contract's rejection pipeline alone (SPEC-v1 §0.5 rule 4, default options), so a
    /// document with feature types Forge does not evaluate (the optional `draft`) can still be
    /// edited.
    Ir,
    /// An edit verified by evaluation: forge-regen's loader, this engine's rejections and
    /// capability check included (`UNSUPPORTED_FEATURE_VERSION` for a type it does not
    /// implement).
    Evaluation,
}

/// Load a document of either version as the canonical v1 document an op edits: validated as
/// `needs` says (a v0 document is migrated), then every expression in its canonical form
/// (SPEC-v1 §0.4, §2.4: "the DocStore MUST store the canonical form"). So every op reads and
/// returns canonical text, whatever its input, and an op's inverse restores the same bytes.
/// A document whose canonical form would be rejected is refused with those rejections at their
/// sites' paths ([W0-20]; `forge_ir::v1::expr::canonicalize_expressions_with`).
fn load_as(text: &str, needs: Needs) -> Result<Document, Rejection> {
    match needs {
        Needs::Evaluation => {
            let doc = forge_regen::v1::load(text)
                .map(|l| l.doc)
                .map_err(|e| Rejection::of(&e))?;
            canonical_expressions(&doc, &forge_regen::v1::validate_options())
        }
        Needs::Ir => {
            let doc = match forge_ir::VersionedDocument::from_json(text) {
                Ok(forge_ir::VersionedDocument::V0(d)) => forge_ir::v1::migrate_v0_to_v1(&d),
                Ok(forge_ir::VersionedDocument::V1(d)) => d,
                Err(e) => return Err(Rejection::of(&e)),
            };
            canonical_expressions(&doc, &forge_ir::v1::ValidateOptions::default())
        }
    }
}

/// `doc` with every expression stored canonically (see [`load_as`]); `opts` are the options
/// `doc` was validated with.
pub(crate) fn canonical_expressions(
    doc: &Document,
    opts: &forge_ir::v1::ValidateOptions<'_>,
) -> Result<Document, Rejection> {
    use forge_ir::v1::expr::{CanonicalizeError, canonicalize_expressions_with};
    canonicalize_expressions_with(doc, opts).map_err(|e| match e {
        CanonicalizeError::Rejected(errs) => Rejection::of(&forge_ir::v1::LoadError::Invalid(errs)),
        other => not_exact("canonicalize", other.to_string(), json!({})),
    })
}

/// The loader of every op verified by evaluation (and of `writeBackSolution`).
pub(crate) fn load(text: &str) -> Result<Document, Rejection> {
    load_as(text, Needs::Evaluation)
}

fn value_text(v: &Value) -> Result<String, Rejection> {
    serde_json::to_string(v).map_err(|e| {
        refusal(
            "COMMAND_INVALID_ARGUMENT",
            format!("the edited document does not serialize: {e}"),
            json!({ "argument": "document", "reason": "serialize" }),
        )
    })
}

fn load_value(v: &Value) -> Result<Document, Rejection> {
    load(&value_text(v)?)
}

fn load_value_as(v: &Value, needs: Needs) -> Result<Document, Rejection> {
    load_as(&value_text(v)?, needs)
}

fn to_value(doc: &Document) -> Value {
    serde_json::to_value(doc).expect("IR documents are always serializable")
}

pub(crate) fn canonical(doc: &Document) -> String {
    forge_ir::v1::to_json(doc) + "\n"
}

fn evaluate(doc: &Document) -> EvalReport {
    let ev = forge_regen::v1::evaluate(doc);
    forge_regen::v1::report(&ev, &forge_regen::engine_id(), &doc.meta.name, None)
}

/// The report of `doc` evaluated only **through** feature `feature`: its part's features up to
/// and including it, no feature of another part. A feature references only earlier features of
/// its part (SPEC-v1 §5.3, §7.1), so `feature`'s entry — its references, members, probes and
/// candidates — is the whole document's; the ops that write one reference's capture read and
/// verify that entry only, and skip evaluating the rest of the model.
fn evaluate_through(doc: &Document, feature: &str) -> EvalReport {
    let mut d = doc.clone();
    for p in &mut d.parts {
        match p.features.iter().position(|f| f.id() == feature) {
            Some(i) => p.features.truncate(i + 1),
            None => p.features.clear(),
        }
    }
    evaluate(&d)
}

fn edited(before: &Document, after: &Document, result: Value) -> Edited {
    let document = canonical(after);
    Edited {
        changed: document != canonical(before),
        document,
        result,
    }
}

fn feature_index(doc: &Document, id: &str) -> Result<(usize, usize), Rejection> {
    for (pi, p) in doc.parts.iter().enumerate() {
        if let Some(fi) = p.features.iter().position(|f| f.id() == id) {
            return Ok((pi, fi));
        }
    }
    Err(refusal(
        "COMMAND_UNKNOWN_FEATURE",
        format!("{} is not the id of a feature of the document", shown(id)),
        json!({ "feature": id_value(id) }),
    ))
}

/// The JSON pointer of the Ref at `field` (a pointer relative to the feature, as the report's
/// `refs[].field`) of feature `(pi, fi)`, checked to address a Ref (`{ kind, q, … }`).
fn ref_pointer(
    v: &Value,
    pi: usize,
    fi: usize,
    feature: &str,
    field: &str,
) -> Result<String, Rejection> {
    if !field.starts_with('/') || !key_like(field) {
        return Err(invalid_argument(
            "field",
            "a JSON pointer relative to the feature, e.g. \"/target\" or \"/plane/face\"",
        ));
    }
    let ptr = format!("/parts/{pi}/features/{fi}{field}");
    match v.pointer(&ptr) {
        Some(Value::Object(o)) if o.contains_key("kind") && o.contains_key("q") => Ok(ptr),
        _ => Err(refusal(
            "COMMAND_NOT_A_REF",
            format!(
                "{} of feature {} is not a reference",
                shown_key(field),
                shown(feature)
            ),
            json!({ "feature": id_value(feature), "field": key_value(field) }),
        )),
    }
}

fn no_ref_report(feature: &str, field: &str, reason: &str, code: Option<&str>) -> Rejection {
    let why = match reason {
        "suppressed" => "the feature is suppressed (it has no report entry)".to_string(),
        "failed" => format!(
            "the feature failed before its references were resolved ({})",
            code.unwrap_or("?")
        ),
        _ => "the reference has no report entry (a Ref nested in a direction is part of its \
              predicate, SPEC-v1 §5.8)"
            .to_string(),
    };
    let mut d =
        json!({ "feature": id_value(feature), "field": key_value(field), "reason": reason });
    if let Some(c) = code {
        d["code"] = json!(c);
    }
    refusal(
        "COMMAND_NO_REF_REPORT",
        format!(
            "reference {} of feature {} was not resolved: {why}",
            shown_key(field),
            shown(feature)
        ),
        d,
    )
}

/// The report entry of the reference `field` of `feature`.
fn ref_entry<'r>(
    rep: &'r EvalReport,
    feature: &str,
    field: &str,
) -> Result<&'r RefReport, Rejection> {
    let Some(f) = rep.features.iter().find(|f| f.feature_id == feature) else {
        return Err(no_ref_report(feature, field, "suppressed", None));
    };
    match f.refs.iter().find(|r| r.field == field) {
        Some(r) => Ok(r),
        None if f.status == Status::Error => Err(no_ref_report(
            feature,
            field,
            "failed",
            f.error.as_ref().map(|e| e.code.as_str()),
        )),
        None => Err(no_ref_report(feature, field, "not-reported", None)),
    }
}

fn not_exact(op: &str, reason: String, details: Value) -> Rejection {
    let mut d = json!({ "op": op, "reason": reason });
    if let (Value::Object(o), Value::Object(extra)) = (&mut d, details) {
        o.extend(extra);
    }
    refusal(
        "COMMAND_NOT_EXACT",
        format!("{op} was not applied: its result failed verification ({reason})"),
        d,
    )
}

/// The post-condition of every capture write: the reference resolves, nothing was added or
/// removed since the capture, no member was repaired, and the members are exactly `keys`.
fn check_resolves_to<'r>(
    rep: &'r EvalReport,
    op: &str,
    feature: &str,
    field: &str,
    keys: &[String],
) -> Result<&'r RefReport, Rejection> {
    let entry = ref_entry(rep, feature, field)?;
    let got: Vec<&str> = entry.members.iter().map(|m| m.key.as_str()).collect();
    let want: Vec<&str> = keys.iter().map(String::as_str).collect();
    let repaired = entry
        .members
        .iter()
        .any(|m| m.status == MemberStatus::Repaired);
    let reason = if entry.status == RefStatus::Failed {
        Some(format!(
            "the reference fails with {}",
            entry.code.as_deref().unwrap_or("?")
        ))
    } else if !entry.added.is_empty() || !entry.removed.is_empty() {
        Some("the resolved set differs from the capture".to_string())
    } else if repaired {
        Some("a member resolves only through the geometric fallback".to_string())
    } else if got != want {
        Some("the resolved members differ from the capture".to_string())
    } else {
        None
    };
    match reason {
        None => Ok(entry),
        Some(r) => Err(not_exact(
            op,
            r,
            json!({
                "feature": id_value(feature), "field": key_value(field),
                "status": entry.status, "code": entry.code,
                "members": got, "expected": want,
                "added": entry.added, "removed": entry.removed,
            }),
        )),
    }
}

fn capture_keys(capture: &Value) -> Vec<String> {
    capture["members"]
        .as_array()
        .map(|ms| {
            ms.iter()
                .filter_map(|m| m["key"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// The resolved members of a reference entry as a sorted multiset of `(key, probe)`: split
/// pieces share a key and are told apart by their probes (§7.6).
fn member_set(entry: &RefReport) -> Vec<String> {
    let mut v: Vec<String> = entry
        .members
        .iter()
        .map(|m| json!([m.key, m.probe]).to_string())
        .collect();
    v.sort();
    v
}

fn member_keys(entry: &RefReport) -> Vec<&str> {
    entry.members.iter().map(|m| m.key.as_str()).collect()
}

/// The document's own report entry of the reference, checked to be one a capture can record:
/// resolved (not failed: `COMMAND_REF_FAILED`, built from this entry — its code, its members,
/// its unresolved members with their captured keys and candidates — so a caller can act on it
/// with `acceptRefCandidate` directly) and with no member repaired by the geometric fallback
/// (`COMMAND_REF_REPAIRED`: the query no longer selects it, so a capture of the query's result
/// would drop it silently; its `proposal` is the repair).
fn capturable<'r>(
    rep: &'r EvalReport,
    feature: &str,
    field: &str,
) -> Result<&'r RefReport, Rejection> {
    let cur = ref_entry(rep, feature, field)?;
    if cur.status == RefStatus::Failed {
        let code = cur.code.clone().unwrap_or_default();
        return Err(refusal(
            "COMMAND_REF_FAILED",
            format!(
                "reference {} of feature {} fails with {code}: repair it first (acceptRefCandidate \
                 with one of the candidates of its unresolved members), then capture it",
                shown_key(field),
                shown(feature)
            ),
            json!({
                "feature": id_value(feature), "field": key_value(field),
                "code": code, "members": cur.members, "unresolved": cur.unresolved,
                "proposal": cur.proposal.is_some(),
            }),
        ));
    }
    let repaired: Vec<&str> = cur
        .members
        .iter()
        .filter(|m| m.status == MemberStatus::Repaired)
        .map(|m| m.key.as_str())
        .collect();
    if !repaired.is_empty() {
        return Err(refusal(
            "COMMAND_REF_REPAIRED",
            format!(
                "reference {} of feature {} resolves {} member(s) only through the geometric \
                 fallback (REF_REPAIRED): accept its proposal (acceptRefProposal) instead of \
                 capturing it",
                shown_key(field),
                shown(feature),
                repaired.len()
            ),
            json!({
                "feature": id_value(feature), "field": key_value(field),
                "code": "REF_REPAIRED", "repaired": repaired,
                "proposal": cur.proposal.is_some(),
            }),
        ));
    }
    Ok(cur)
}

/// A capture must record exactly what the reference resolved to before it (`want`, from
/// [`member_set`]): `got` is a later resolution (the query read without a capture, or the
/// captured document). A difference would silently change what the reference designates
/// (SPEC-v1 §5.7: a repair is an explicit edit; [W0-33]: a capture restricts its key to the
/// entity it designated), so the write is refused (`COMMAND_NOT_EXACT`).
fn check_same_members(
    op: &str,
    feature: &str,
    field: &str,
    what: &str,
    cur: &RefReport,
    got: &RefReport,
) -> Result<(), Rejection> {
    if member_set(cur) == member_set(got) {
        return Ok(());
    }
    Err(not_exact(
        op,
        format!("{what} resolves to other members than the reference's current resolution"),
        json!({
            "feature": id_value(feature), "field": key_value(field),
            "members": member_keys(cur), "found": member_keys(got),
        }),
    ))
}

/// A fresh capture of the reference at `ptr` of document value `v` (see the module docs: the
/// resolver's own capture of its current result, read through an empty capture), with the
/// report entry it was read from. The query must resolve by itself: a failure there is refused
/// with `COMMAND_NOT_EXACT` (`op`), never passed off as the document's own failure.
fn fresh_capture(
    op: &str,
    v: &Value,
    ptr: &str,
    feature: &str,
    field: &str,
) -> Result<(Value, RefReport), Rejection> {
    let mut probe = v.clone();
    let r = probe
        .pointer_mut(ptr)
        .and_then(Value::as_object_mut)
        .expect("ref_pointer checked the Ref");
    r.insert("capture".into(), json!({ "members": [] }));
    let doc = load_value(&probe)?;
    let rep = evaluate_through(&doc, feature);
    let entry = ref_entry(&rep, feature, field)?.clone();
    if entry.status == RefStatus::Failed {
        let code = entry.code.clone().unwrap_or_default();
        return Err(not_exact(
            op,
            format!("the reference's query, read without a capture, fails with {code}"),
            json!({
                "feature": id_value(feature), "field": key_value(field),
                "code": code, "found": member_keys(&entry),
            }),
        ));
    }
    let unavailable = || {
        refusal(
            "COMMAND_CAPTURE_UNAVAILABLE",
            format!(
                "the resolver gave no fresh capture for reference {} of feature {}",
                shown_key(field),
                shown(feature)
            ),
            json!({ "feature": id_value(feature), "field": key_value(field) }),
        )
    };
    let q = v
        .pointer(ptr)
        .map(|r| r["q"].clone())
        .unwrap_or(Value::Null);
    let capture = match &entry.proposal {
        Some(p) => {
            if serde_json::to_value(&p.q).ok() != Some(q) {
                return Err(unavailable());
            }
            let c = p.capture.as_ref().ok_or_else(unavailable)?;
            serde_json::to_value(c).map_err(|_| unavailable())?
        }
        None if entry.members.is_empty() => json!({ "members": [] }),
        None => return Err(unavailable()),
    };
    Ok((capture, entry))
}

// ---- setParam ---------------------------------------------------------------------------------

/// The pointer of parameter `name` (document parameters, then each part's).
fn param_pointer(doc: &Document, name: &str) -> Option<String> {
    if let Some(i) = doc.params.iter().position(|p| p.name == name) {
        return Some(format!("/params/{i}"));
    }
    for (pi, part) in doc.parts.iter().enumerate() {
        if let Some(i) = part.params.iter().position(|p| p.name == name) {
            return Some(format!("/parts/{pi}/params/{i}"));
        }
    }
    None
}

/// `setParam(name, value)` (SPEC-v1 §2.1): set a parameter's `value` to a literal (JSON number
/// or boolean) or an expression (JSON string), stored canonically (§2.4: a plain literal of the
/// field's kind as a JSON literal, `"8"` → `8`, `"-0"` → `0`; anything else as its canonical
/// text). The canonical form is forge-ir's own (`canonicalize_expressions_with`, run by the
/// loader on the edited document, whose other sites are already canonical). The edit is refused
/// with the document's rejections (`EXPR_*`, `PARAM_*`, … at their paths) when the edited
/// document does not load, including when only its canonical form would not ([W0-20]). A pure
/// IR edit: documents with feature types Forge does not evaluate (`draft`) are edited too.
/// `result`: `{ param, previous, value, params }` — the stored value before and after, and the
/// report's `params` block of the edited document (every value or failure).
pub fn set_param(ir_json: &str, name: &str, value: &Value) -> Result<Edited, Rejection> {
    let doc = load_as(ir_json, Needs::Ir)?;
    let value = match value {
        Value::Number(n) if n.as_f64() == Some(0.0) => json!(0),
        Value::Number(_) | Value::Bool(_) | Value::String(_) => value.clone(),
        _ => {
            return Err(invalid_argument(
                "value",
                "a number, a boolean or an expression string",
            ));
        }
    };
    let ptr = param_pointer(&doc, name).ok_or_else(|| {
        refusal(
            "COMMAND_UNKNOWN_PARAM",
            format!("{} is not a parameter of the document", shown(name)),
            json!({ "name": id_value(name) }),
        )
    })?;
    let site = format!("{ptr}/value");
    let mut v = to_value(&doc);
    let previous = v.pointer(&site).cloned().unwrap_or(Value::Null);
    *v.pointer_mut(&site).expect("the parameter's value") = value;
    let out = load_value_as(&v, Needs::Ir)?;
    let stored = to_value(&out)
        .pointer(&site)
        .cloned()
        .unwrap_or(Value::Null);
    let params = serde_json::to_value(forge_regen::v1::params(&out)).unwrap_or(Value::Null);
    Ok(edited(
        &doc,
        &out,
        json!({ "param": name, "previous": previous, "value": stored, "params": params }),
    ))
}

// ---- renameFeature ----------------------------------------------------------------------------

/// `renameFeature(featureId, newName)` (SPEC-v1 §0.3 rule 2, §5.9): the feature's `name` only;
/// references use ids, so nothing else is rewritten. Refused with the document's rejection when
/// the name is invalid, reserved or taken (`INVALID_NAME`, `RESERVED_NAME`, `DUPLICATE_NAME`).
///
/// Reserved means the **full** v1 `RESERVED_NAMES` (v0's list and the CadScript v1 builtins,
/// `ir-v1.constants.json`), stricter than IR validation, which checks feature names against the
/// v0 list only so that migrated v0 documents stay valid ([W0-2]). §9.3 names this op as the fix
/// for such a name (`CS_RESERVED_NAME`), so it never writes one: a new name in the list is
/// refused with `RESERVED_NAME` at the feature's `name` path. Keeping the current name (a no-op)
/// is allowed, and so is renaming a feature away from a reserved name. A pure IR edit (nothing
/// is evaluated). `result`: `{ feature, previous, name }`.
pub fn rename_feature(ir_json: &str, feature: &str, name: &str) -> Result<Edited, Rejection> {
    let doc = load_as(ir_json, Needs::Ir)?;
    let (pi, fi) = feature_index(&doc, feature)?;
    let previous = doc.parts[pi].features[fi].name().to_string();
    if name != previous && forge_ir::v1::reserved_names().contains(&name) {
        return Err(Rejection::of(&forge_ir::v1::LoadError::Invalid(vec![
            forge_ir::v1::ValidationError::new(
                "RESERVED_NAME",
                format!("/parts/{pi}/features/{fi}/name"),
                format!(
                    "{name:?} is a reserved word or CadScript builtin; pick another name \
                     (SPEC-v1 §9.3: renameFeature never writes a v1 reserved name)"
                ),
                json!({ "name": name }),
            ),
        ])));
    }
    let mut v = to_value(&doc);
    v["parts"][pi]["features"][fi]["name"] = json!(name);
    let out = load_value_as(&v, Needs::Ir)?;
    Ok(edited(
        &doc,
        &out,
        json!({ "feature": feature, "previous": previous, "name": name }),
    ))
}

// ---- upgradeFeature ---------------------------------------------------------------------------

/// `upgradeFeature(featureId, to?)` (SPEC-v1 §9.2): set the feature's behavior version `v` to
/// `to` (default: the newest version the contract defines for its type) and report the diff
/// it causes — the command layer shows it before applying. Refused when `to` is older than the
/// current `v` (`COMMAND_NOT_AN_UPGRADE`) or when this engine does not implement it
/// (`UNSUPPORTED_FEATURE_VERSION`, the document's rejection). `result`: `{ feature, type,
/// from, to, diff }`, where `diff` lists every feature entry (by `feature_id`) and part whose
/// report changes, `{ feature_id | part_id, before, after }` (`null` when absent).
pub fn upgrade_feature(ir_json: &str, feature: &str, to: Option<u32>) -> Result<Edited, Rejection> {
    let doc = load(ir_json)?;
    let (pi, fi) = feature_index(&doc, feature)?;
    let f = &doc.parts[pi].features[fi];
    let ty = f.type_name();
    let from = f.v();
    let newest = forge_ir::v1::defined_versions(ty)
        .iter()
        .copied()
        .max()
        .unwrap_or(from);
    let to = to.unwrap_or(newest.max(from));
    if to < from {
        return Err(refusal(
            "COMMAND_NOT_AN_UPGRADE",
            format!("feature {} is at v{from}; v{to} is older", shown(feature)),
            json!({ "feature": id_value(feature), "from": from, "to": to }),
        ));
    }
    if to == from {
        return Ok(edited(
            &doc,
            &doc,
            json!({ "feature": feature, "type": ty, "from": from, "to": to, "diff": [] }),
        ));
    }
    let mut v = to_value(&doc);
    v["parts"][pi]["features"][fi]["v"] = json!(to);
    let out = load_value(&v)?;
    let (before, after) = (evaluate(&doc), evaluate(&out));
    Ok(edited(
        &doc,
        &out,
        json!({ "feature": feature, "type": ty, "from": from, "to": to,
                "diff": report_diff(&before, &after) }),
    ))
}

fn report_diff(before: &EvalReport, after: &EvalReport) -> Vec<Value> {
    let by_id = |r: &EvalReport| -> BTreeMap<String, Value> {
        r.features
            .iter()
            .map(|f| {
                (
                    f.feature_id.clone(),
                    serde_json::to_value(f).unwrap_or(Value::Null),
                )
            })
            .collect()
    };
    let (b, a) = (by_id(before), by_id(after));
    let mut out = Vec::new();
    let order = before
        .features
        .iter()
        .chain(&after.features)
        .map(|f| f.feature_id.clone());
    let mut seen = BTreeSet::new();
    for id in order {
        if !seen.insert(id.clone()) {
            continue;
        }
        let (x, y) = (b.get(&id), a.get(&id));
        if x != y {
            out.push(json!({ "feature_id": id, "before": x, "after": y }));
        }
    }
    for (pb, pa) in before.parts.iter().zip(&after.parts) {
        if pb != pa {
            out.push(json!({ "part_id": pb.part_id, "before": pb, "after": pa }));
        }
    }
    out
}

// ---- captureRef -------------------------------------------------------------------------------

/// `captureRef(featureId, field)` (SPEC-v1 §0.6, §5.6): write the capture of the reference's
/// current resolution — the members the document's own report entry resolves, never more or
/// fewer. Refused when the reference fails (`COMMAND_REF_FAILED`, with the document's own
/// code, members and unresolved members with candidates: repair it first), when a member is
/// only repaired by the geometric fallback (`COMMAND_REF_REPAIRED`: accept the proposal), or
/// when it was not resolved (`COMMAND_NO_REF_REPORT`). Verified: the query read without a
/// capture, and the captured document, must resolve to the same members `(key, probe)` as the
/// reference before the op, else `COMMAND_NOT_EXACT` (a capture never widens nor narrows what
/// the reference designates). Idempotent: capturing again yields the same document. `result`:
/// `{ feature, field, capture, previous, members }` (`previous` the replaced capture or
/// `null`; `members` the report's resolved members with probes).
pub fn capture_ref(ir_json: &str, feature: &str, field: &str) -> Result<Edited, Rejection> {
    let doc = load(ir_json)?;
    let (pi, fi) = feature_index(&doc, feature)?;
    let mut v = to_value(&doc);
    let ptr = ref_pointer(&v, pi, fi, feature, field)?;
    let previous = v
        .pointer(&ptr)
        .map(|r| r["capture"].clone())
        .unwrap_or(Value::Null);
    let rep0 = evaluate_through(&doc, feature);
    let cur = capturable(&rep0, feature, field)?;
    let (capture, fresh) = fresh_capture("captureRef", &v, &ptr, feature, field)?;
    check_same_members(
        "captureRef",
        feature,
        field,
        "the query, read without a capture,",
        cur,
        &fresh,
    )?;
    v.pointer_mut(&ptr).expect("the Ref")["capture"] = capture.clone();
    let out = load_value(&v)?;
    let rep = evaluate_through(&out, feature);
    let entry = check_resolves_to(&rep, "captureRef", feature, field, &capture_keys(&capture))?;
    check_same_members(
        "captureRef",
        feature,
        field,
        "the captured reference",
        cur,
        entry,
    )?;
    Ok(edited(
        &doc,
        &out,
        json!({ "feature": feature, "field": field, "capture": capture,
                "previous": previous, "members": entry.members }),
    ))
}

// ---- acceptRefProposal ------------------------------------------------------------------------

/// `acceptRefProposal(featureId, field)` (SPEC-v1 §5.8, §5.9): replace the reference by the
/// `proposal` of its current report entry (`REF_REPAIRED`: the query rewritten to select the
/// repaired set; `REF_SET_CHANGED`: the same query) — query and fresh capture in one op.
/// Refused without a proposal (`COMMAND_NO_PROPOSAL`). `result`: `{ feature, field, ref,
/// previous, code }` (`code` the warning that carried the proposal).
pub fn accept_ref_proposal(ir_json: &str, feature: &str, field: &str) -> Result<Edited, Rejection> {
    let doc = load(ir_json)?;
    let (pi, fi) = feature_index(&doc, feature)?;
    let mut v = to_value(&doc);
    let ptr = ref_pointer(&v, pi, fi, feature, field)?;
    let rep = evaluate_through(&doc, feature);
    let entry = ref_entry(&rep, feature, field)?;
    let Some(proposal) = entry.proposal.clone() else {
        return Err(refusal(
            "COMMAND_NO_PROPOSAL",
            format!(
                "reference {} of feature {} has no proposal (only REF_REPAIRED and \
                 REF_SET_CHANGED carry one)",
                shown_key(field),
                shown(feature)
            ),
            json!({ "feature": id_value(feature), "field": key_value(field),
                    "status": entry.status, "code": entry.code }),
        ));
    };
    let code = feature_entry(&rep, feature).and_then(|f| {
        f.warnings
            .iter()
            .find(|w| {
                matches!(w.code.as_str(), "REF_REPAIRED" | "REF_SET_CHANGED")
                    && w.details.get("field").and_then(Value::as_str) == Some(field)
            })
            .map(|w| w.code.clone())
    });
    let new_ref = serde_json::to_value(&proposal).unwrap_or(Value::Null);
    let keys = capture_keys(&new_ref["capture"]);
    if new_ref["capture"].is_null() {
        return Err(refusal(
            "COMMAND_CAPTURE_UNAVAILABLE",
            "the proposal has no capture",
            json!({ "feature": id_value(feature), "field": key_value(field) }),
        ));
    }
    let slot = v.pointer_mut(&ptr).expect("the Ref");
    let previous = std::mem::replace(slot, new_ref.clone());
    let out = load_value(&v)?;
    let rep2 = evaluate_through(&out, feature);
    check_resolves_to(&rep2, "acceptRefProposal", feature, field, &keys)?;
    Ok(edited(
        &doc,
        &out,
        json!({ "feature": feature, "field": field, "ref": new_ref,
                "previous": previous, "code": code }),
    ))
}

fn feature_entry<'r>(rep: &'r EvalReport, feature: &str) -> Option<&'r FeatureReport> {
    rep.features.iter().find(|f| f.feature_id == feature)
}

/// Whether a reported member is the entity with that key and probe (split pieces share a key;
/// the probe tells them apart, §7.6).
fn same_entity(m: &RefMember, key: &str, probe: &Probe) -> bool {
    m.key == key && m.probe == *probe
}

/// How far a candidate's probe point may be from the probe the caller gave (mm): `5·tol`, the
/// upper clamp of the oracle's probe-matching radius ([W0-35]). Above the *tol* by which a
/// write-back can move geometry ([W0-31]) and far below the `10·tol` probes keep from their
/// entity's boundary (§7.6), so two pieces never both match.
pub const PROBE_MATCH_RADIUS: f64 = 5.0 * forge_ir::v1::LINEAR_TOLERANCE;

/// Whether probe `p` locates the entity `expected` located: same kind, points within
/// [`PROBE_MATCH_RADIUS`], and, when both have a normal, normals on the same side ([W0-35]).
fn probe_matches(p: &Probe, expected: &Probe) -> bool {
    let d2: f64 = (0..3)
        .map(|i| (p.point[i] - expected.point[i]).powi(2))
        .sum();
    let same_side = match (&p.normal, &expected.normal) {
        (Some(a), Some(b)) => (0..3).map(|i| a[i] * b[i]).sum::<f64>() > 0.0,
        _ => true,
    };
    p.kind == expected.kind && d2.sqrt() <= PROBE_MATCH_RADIUS && same_side
}

// ---- acceptRefCandidate -----------------------------------------------------------------------

/// `acceptRefCandidate(featureId, field, memberKey, candidateKey, candidateIndex?)` (SPEC-v1
/// §5.9): replace the reference's query by the candidate's synthesised `query` and refresh the
/// capture. The candidate is looked up in the reference's current report entry: the unresolved
/// member `memberKey` (`""` for a reference without a capture, §5.8), then the candidate with
/// `candidateKey` — split pieces share a key, so `candidateIndex` (its position in the
/// member's `candidates`) picks one. Verified: the reference must then resolve to exactly that
/// candidate (same key and probe).
///
/// `probe` is the candidate's probe as the caller read it (§7.6): the candidate chosen must
/// still be that entity — same kind, its point within [`PROBE_MATCH_RADIUS`] and, when both
/// carry one, a normal on the same side (positive dot product) — or the op is refused with
/// `COMMAND_CANDIDATE_CHANGED` (`details: { reason: "probe", index, expected, found }`, `found`
/// the probes of the candidates with that key). Without `candidateIndex` it picks the piece
/// among those sharing the key. The command layer passes it whenever the document it applies
/// the op to may differ from the one whose report the caller read (the DocStore writes back
/// solved geometry before a repair, SPEC-v1 §0.6): an index read from another report could
/// name another piece, and a write-back moves geometry by at most *tol* ([W0-31]).
///
/// A reference that has other members, or other unresolved members, is refused
/// (`COMMAND_CANDIDATE_PARTIAL`, `details.members` / `details.unresolved`): replacing its whole
/// query by a one-entity query would drop them silently (a W0 contract issue: §5.9 does not say
/// how to accept a candidate for one member of a multi-member reference). "Other" is every
/// resolved member but the candidate itself and what the chosen entry stands for — the
/// members an entry without a capture (key `""`: a card-one ambiguity or split) offers as its
/// candidates, the pieces of a captured member's key it offers — and never merely a key that
/// appears among the candidates (forge-refs lists members that another captured key accounts
/// for as lower-ranked candidates). `result`: `{ feature, field, ref, previous, candidate }`.
pub fn accept_ref_candidate(
    ir_json: &str,
    feature: &str,
    field: &str,
    member: &str,
    candidate: &str,
    index: Option<usize>,
    probe: Option<&Probe>,
) -> Result<Edited, Rejection> {
    let doc = load(ir_json)?;
    let (pi, fi) = feature_index(&doc, feature)?;
    let mut v = to_value(&doc);
    let ptr = ref_pointer(&v, pi, fi, feature, field)?;
    let rep = evaluate_through(&doc, feature);
    let entry = ref_entry(&rep, feature, field)?;
    let ctx = || {
        json!({ "feature": id_value(feature), "field": key_value(field),
                         "member": key_value(member), "candidate": key_value(candidate) })
    };
    let members: Vec<_> = entry
        .unresolved
        .iter()
        .filter(|u| u.key == member)
        .collect();
    if members.is_empty() {
        return Err(refusal(
            "COMMAND_UNKNOWN_MEMBER",
            format!(
                "reference {} of feature {} has no unresolved member {}",
                shown_key(field),
                shown(feature),
                shown_key(member)
            ),
            ctx(),
        ));
    }
    let mut hits = Vec::new();
    for (ui, u) in members.iter().enumerate() {
        for (ci, c) in u.candidates.iter().enumerate() {
            if c.key == candidate && index.is_none_or(|i| i == ci) {
                hits.push((ui, ci));
            }
        }
    }
    if let Some(expected) = probe
        && !hits.is_empty()
    {
        let found: Vec<&Probe> = hits
            .iter()
            .map(|&(ui, ci)| &members[ui].candidates[ci].probe)
            .collect();
        hits.retain(|&(ui, ci)| probe_matches(&members[ui].candidates[ci].probe, expected));
        if hits.is_empty() {
            let mut d = ctx();
            d["reason"] = json!("probe");
            d["index"] = json!(index);
            d["expected"] = json!(expected);
            d["found"] = json!(found);
            return Err(refusal(
                "COMMAND_CANDIDATE_CHANGED",
                format!(
                    "candidate {}{} is no longer the entity whose probe was given (the model \
                     changed since its report was read): read the report again",
                    shown_key(candidate),
                    index.map(|i| format!(" at index {i}")).unwrap_or_default()
                ),
                d,
            ));
        }
    }
    let (ui, ci) = match hits.as_slice() {
        [one] => *one,
        [] => {
            let mut d = ctx();
            d["index"] = json!(index);
            return Err(refusal(
                "COMMAND_UNKNOWN_CANDIDATE",
                format!(
                    "unresolved member {} has no candidate {}{}",
                    shown_key(member),
                    shown_key(candidate),
                    index.map(|i| format!(" at index {i}")).unwrap_or_default()
                ),
                d,
            ));
        }
        many => {
            let mut d = ctx();
            d["count"] = json!(many.len());
            return Err(refusal(
                "COMMAND_CANDIDATE_AMBIGUOUS",
                format!(
                    "{} candidates carry the key {} (split pieces): pass the candidate's index",
                    many.len(),
                    shown_key(candidate)
                ),
                d,
            ));
        }
    };
    let unresolved = members[ui];
    let cand = unresolved.candidates[ci].clone();
    let Some(query) = cand.query.clone() else {
        return Err(refusal(
            "COMMAND_CANDIDATE_NO_QUERY",
            format!(
                "candidate {} has no query that selects exactly it",
                shown_key(candidate)
            ),
            ctx(),
        ));
    };
    // What the replacement stands for: the candidate itself, and the resolved members the
    // chosen unresolved entry designates — for an entry without a capture (key "", a card-one
    // ambiguity or split) the members it offers as candidates, for a captured member the pieces
    // carrying its key that it offers (a split). Every other resolved member would be dropped
    // with the query: a member some other captured key accounts for is listed as a (lower
    // ranked) candidate of this entry, but it is still another member (forge-refs' fallback).
    let replaced = |m: &RefMember| {
        same_entity(m, &cand.key, &cand.probe)
            || ((unresolved.key.is_empty() || m.key == unresolved.key)
                && unresolved
                    .candidates
                    .iter()
                    .any(|c| same_entity(m, &c.key, &c.probe)))
    };
    let others: Vec<&str> = entry
        .members
        .iter()
        .filter(|m| !replaced(m))
        .map(|m| m.key.as_str())
        .collect();
    let other_unresolved: Vec<&str> = entry
        .unresolved
        .iter()
        .filter(|u| !std::ptr::eq(*u, unresolved))
        .map(|u| u.key.as_str())
        .collect();
    if !others.is_empty() || !other_unresolved.is_empty() {
        let mut d = ctx();
        d["members"] = json!(others);
        d["unresolved"] = json!(other_unresolved);
        return Err(refusal(
            "COMMAND_CANDIDATE_PARTIAL",
            format!(
                "reference {} has {} other member(s) and {} other unresolved member(s): \
                 replacing its query by the candidate's would drop them",
                shown_key(field),
                others.len(),
                other_unresolved.len()
            ),
            d,
        ));
    }
    let slot = v.pointer_mut(&ptr).expect("the Ref");
    let previous = slot.clone();
    let mut new_ref = Map::new();
    new_ref.insert("kind".into(), previous["kind"].clone());
    new_ref.insert(
        "q".into(),
        serde_json::to_value(&query).unwrap_or(Value::Null),
    );
    if let Some(card) = previous.get("card") {
        new_ref.insert("card".into(), card.clone());
    }
    *slot = Value::Object(new_ref);
    let (capture, _) = fresh_capture("acceptRefCandidate", &v, &ptr, feature, field)?;
    v.pointer_mut(&ptr).expect("the Ref")["capture"] = capture.clone();
    let out = load_value(&v)?;
    let rep2 = evaluate_through(&out, feature);
    let entry2 = check_resolves_to(
        &rep2,
        "acceptRefCandidate",
        feature,
        field,
        std::slice::from_ref(&cand.key),
    )?;
    if entry2.members.first().map(|m| &m.probe) != Some(&cand.probe) {
        return Err(not_exact(
            "acceptRefCandidate",
            "the reference resolves to another entity with the candidate's key".into(),
            ctx(),
        ));
    }
    // Post-condition: every member the reference resolved is still resolved, but what the
    // candidate replaces (implied by the refusal above; checked so that a change to either rule
    // cannot drop a member silently).
    if let Some(lost) = entry.members.iter().find(|m| {
        !replaced(m)
            && !entry2
                .members
                .iter()
                .any(|n| same_entity(n, &m.key, &m.probe))
    }) {
        let mut d = ctx();
        d["lost"] = key_value(&lost.key);
        return Err(not_exact(
            "acceptRefCandidate",
            "a member the reference resolved before is no longer resolved".into(),
            d,
        ));
    }
    let new_ref = v.pointer(&ptr).cloned().unwrap_or(Value::Null);
    Ok(edited(
        &doc,
        &out,
        json!({ "feature": feature, "field": field, "ref": new_ref,
                "previous": previous, "candidate": cand }),
    ))
}

// ---- renameCurve ------------------------------------------------------------------------------

/// Provenance keys (SPEC-v1 §5.2 rule 1): `fid "/" label [ ":" ( leaf ( "+" leaf )* | "{" key
/// ( "|" key )* "}" ) ] [ "@" qual ]`, ids escaped `%XX` (rule 5). A port of forge-core's
/// `parse_key` / `KeyParts::render`, which forge-wasm cannot reach (not a dependency).
mod keys {
    const ESCAPED: &[char] = &['/', ':', '{', '}', '|', '+', '#', '@', '%'];

    pub fn escape(id: &str) -> String {
        let mut out = String::with_capacity(id.len());
        for c in id.chars() {
            if ESCAPED.contains(&c) || c.is_whitespace() {
                let mut buf = [0u8; 4];
                for b in c.encode_utf8(&mut buf).bytes() {
                    out.push_str(&format!("%{b:02X}"));
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    fn unescape(s: &str) -> Option<String> {
        let b = s.as_bytes();
        let mut out = Vec::with_capacity(b.len());
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'%' {
                let hex = s.get(i + 1..i + 3)?;
                if !hex
                    .bytes()
                    .all(|h| h.is_ascii_digit() || (b'A'..=b'F').contains(&h))
                {
                    return None;
                }
                out.push(u8::from_str_radix(hex, 16).ok()?);
                i += 3;
            } else {
                out.push(b[i]);
                i += 1;
            }
        }
        String::from_utf8(out).ok()
    }

    fn seg(s: &str) -> Option<String> {
        let raw = !s.contains(|c: char| (ESCAPED.contains(&c) && c != '%') || c.is_whitespace());
        if raw { unescape(s) } else { None }
    }

    #[derive(Clone, Debug, PartialEq)]
    pub enum Arg {
        None,
        Leaf(String),
        Leaves(Vec<String>),
        Keys(Vec<String>),
    }

    #[derive(Clone, Debug, PartialEq)]
    pub struct Key {
        pub feature: String,
        pub label: String,
        pub arg: Arg,
        pub qualifier: Option<String>,
    }

    pub fn parse(key: &str) -> Option<Key> {
        if key.contains('#') {
            return None;
        }
        let slash = key.find('/')?;
        let feature = seg(&key[..slash])?;
        if feature.is_empty() {
            return None;
        }
        let rest = &key[slash + 1..];
        let label_end = rest.find([':', '@']).unwrap_or(rest.len());
        let label = seg(&rest[..label_end])?;
        if label.is_empty() {
            return None;
        }
        let mut i = label_end;
        let mut arg = Arg::None;
        if rest[i..].starts_with(':') {
            i += 1;
            if rest[i..].starts_with('{') {
                let mut depth = 0usize;
                let mut parts = Vec::new();
                let mut start = i + 1;
                let mut end = None;
                for (j, c) in rest[i..].char_indices() {
                    let j = i + j;
                    match c {
                        '{' => depth += 1,
                        '}' => {
                            depth -= 1;
                            if depth == 0 {
                                parts.push(rest[start..j].to_string());
                                end = Some(j + 1);
                                break;
                            }
                        }
                        '|' if depth == 1 => {
                            parts.push(rest[start..j].to_string());
                            start = j + 1;
                        }
                        _ => {}
                    }
                }
                i = end?;
                if parts.iter().any(String::is_empty) {
                    return None;
                }
                arg = Arg::Keys(parts);
            } else {
                let leaf_end = rest[i..].find('@').map_or(rest.len(), |j| i + j);
                let mut leaves = Vec::new();
                for part in rest[i..leaf_end].split('+') {
                    let leaf = seg(part)?;
                    if leaf.is_empty() {
                        return None;
                    }
                    leaves.push(leaf);
                }
                arg = if leaves.len() == 1 {
                    Arg::Leaf(leaves.remove(0))
                } else {
                    Arg::Leaves(leaves)
                };
                i = leaf_end;
            }
        }
        let qualifier = if rest[i..].starts_with('@') {
            let q = seg(&rest[i + 1..])?;
            if q.is_empty() {
                return None;
            }
            Some(q)
        } else if i == rest.len() {
            None
        } else {
            return None;
        };
        Some(Key {
            feature,
            label,
            arg,
            qualifier,
        })
    }

    impl Key {
        pub fn render(&self) -> String {
            let mut out = format!("{}/{}", escape(&self.feature), escape(&self.label));
            match &self.arg {
                Arg::None => {}
                Arg::Leaf(l) => {
                    out.push(':');
                    out.push_str(&escape(l));
                }
                Arg::Leaves(ls) => {
                    out.push(':');
                    out.push_str(&ls.iter().map(|l| escape(l)).collect::<Vec<_>>().join("+"));
                }
                Arg::Keys(ks) => {
                    out.push_str(":{");
                    out.push_str(&ks.join("|"));
                    out.push('}');
                }
            }
            if let Some(q) = &self.qualifier {
                out.push('@');
                out.push_str(&escape(q));
            }
            out
        }
    }
}

/// The hole face roles (§5.2 rule 3), qualified by the position id.
const HOLE_ROLES: [&str; 6] = ["wall", "tip", "floor", "cbore_wall", "cbore_floor", "csink"];
/// Constraint argument fields that name sketch entities (§4.3).
const CONSTRAINT_ARGS: [&str; 6] = ["a", "b", "line", "point", "curve", "entity"];

/// `renameCurve` on everything that names a curve (a port of forge-refs' `CurveRename`, with
/// compound members and derived ids: renaming `outline` renames `outline.bottom`, renaming
/// `l` renames `l.start`). Body members and junction qualifiers are recomputed from the
/// sketch's evaluated regions and solved geometry (§5.2 rules 3–4), not substituted: renaming
/// any curve of a region can change its member (the byte-wise smallest outer-loop curve id).
struct Renamer {
    /// The renamed curve's sketch.
    sketch: String,
    old: String,
    new: String,
    /// Sweeps consuming the sketch.
    consumers: BTreeSet<String>,
    /// Holes placed on the sketch's points.
    holes: BTreeSet<String>,
    /// Patterns whose new bodies copy bodies of the sketch's consumers: feature seeds that
    /// include a consumer, and body seeds whose seed reference resolves to such a body (known
    /// from the report, [`Renamer::refine_patterns`]; a body seed without a report entry is
    /// kept). A copy's origin is `{ pattern, the seed body's member, instance }` (§5.2 rule 4,
    /// §6.10), so its member follows the rename like the seed's (`P/body:m@i` keys).
    patterns: BTreeSet<String>,
    /// `{ pattern, member, as_curve, as_origin }` of every `body` query on such a pattern whose
    /// `member` the two readings of §5.3 rewrite differently: as a curve of the seed's outer loop
    /// (§5.3's wording, `as_curve`) or as the copies' origin member (forge-refs' resolution:
    /// a pattern has no regions, so `member` must equal the origin member, `as_origin`). Which
    /// one §5.3 means is a W0 contract issue; such a rename is refused rather than guessed.
    /// Where both readings agree the member is rewritten (and verified).
    pattern_members: Vec<Value>,
    /// Old body member → new (per region of the sketch).
    members: BTreeMap<String, String>,
    /// Old junction qualifier `c.end` → new.
    qualifiers: BTreeMap<String, String>,
    /// Whether `members` and `qualifiers` come from an evaluation of the sketch. When they do
    /// not (a sketch that fails, even unsuppressed), every body member and junction qualifier of
    /// a consumer is counted in `unmapped` and the rename is refused if there is any.
    derived: bool,
    unmapped: std::cell::Cell<usize>,
    /// Timeline position of every feature (the canonical order of bodies, §5.4).
    order: BTreeMap<String, (usize, usize)>,
    /// What was rewritten.
    counts: BTreeMap<&'static str, usize>,
    /// `(feature id, field)` of every Ref whose capture keys the rewrite changed (`field` the
    /// Ref's JSON pointer relative to the feature, as the report's `refs[].field`).
    rewritten_refs: Vec<(String, String)>,
}

impl Renamer {
    /// The rename of curve `old` of sketch `sketch` (part `pi` of `doc`), before any fact of the
    /// sketch's evaluation is known.
    fn new(doc: &Document, pi: usize, sketch: &str, old: &str, new: &str) -> Self {
        let part = &doc.parts[pi];
        let consumers: BTreeSet<String> = part
            .features
            .iter()
            .filter(|f| match f {
                Feature::Extrude(e) => e.sketch == sketch,
                Feature::Revolve(r) => r.sketch == sketch,
                _ => false,
            })
            .map(|f| f.id().to_string())
            .collect();
        let holes = part
            .features
            .iter()
            .filter(|f| {
                matches!(f, Feature::Hole(h)
                    if matches!(&h.at, forge_ir::v1::HolePlacement::Points(p) if p.sketch == sketch))
            })
            .map(|f| f.id().to_string())
            .collect();
        let patterns = part
            .features
            .iter()
            .filter(|f| match f {
                Feature::Pattern(p) => match &p.seed {
                    forge_ir::v1::PatternSeed::Features(ids) => {
                        ids.iter().any(|s| consumers.contains(s))
                    }
                    forge_ir::v1::PatternSeed::Bodies(_) => true,
                },
                _ => false,
            })
            .map(|f| f.id().to_string())
            .collect();
        let order = doc
            .parts
            .iter()
            .enumerate()
            .flat_map(|(pi, p)| {
                p.features
                    .iter()
                    .enumerate()
                    .map(move |(fi, f)| (f.id().to_string(), (pi, fi)))
            })
            .collect();
        Renamer {
            sketch: sketch.to_string(),
            old: old.to_string(),
            new: new.to_string(),
            consumers,
            holes,
            patterns,
            pattern_members: Vec::new(),
            members: BTreeMap::new(),
            qualifiers: BTreeMap::new(),
            derived: false,
            unmapped: std::cell::Cell::new(0),
            order,
            counts: BTreeMap::new(),
            rewritten_refs: Vec::new(),
        }
    }

    /// Drop the body-seeded patterns that copy no body of the sketch's consumers, from `rep`'s
    /// entries of their seed references (`/seed/bodies`) in timeline order: a seed body keyed
    /// `F/body:…` whose `F` is a consumer or a pattern kept so far. A pattern without such an
    /// entry (it failed before resolving its seed, or is suppressed) is kept.
    fn refine_patterns(&mut self, doc: &Document, rep: &EvalReport) {
        let mut kept = BTreeSet::new();
        for f in doc.parts.iter().flat_map(|p| &p.features) {
            let id = f.id();
            if !self.patterns.contains(id) {
                continue;
            }
            let body_seeded = matches!(f, Feature::Pattern(p)
                if matches!(p.seed, forge_ir::v1::PatternSeed::Bodies(_)));
            let entry = feature_entry(rep, id)
                .and_then(|e| e.refs.iter().find(|r| r.field == "/seed/bodies"));
            let ours = match entry {
                Some(e) if body_seeded => e.members.iter().any(|m| {
                    keys::parse(&m.key).is_some_and(|k| {
                        k.label == "body"
                            && (self.consumers.contains(&k.feature) || kept.contains(&k.feature))
                    })
                }),
                _ => true,
            };
            if ours {
                kept.insert(id.to_string());
            }
        }
        self.patterns = kept;
    }

    /// Rewrite `v` (the value of `doc`; the sketch is feature `fi` of part `pi`): the curve's
    /// id and the constraint arguments naming it (derived ids too), the consumers' `regions`,
    /// the holes' `points`, and every query field and capture key.
    fn rewrite(&mut self, doc: &Document, v: &mut Value, pi: usize, fi: usize) {
        let sk = &mut v["parts"][pi]["features"][fi];
        if let Some(Value::Array(cs)) = sk.get_mut("curves") {
            for c in cs.iter_mut() {
                if c["id"] == self.old.as_str() {
                    c["id"] = json!(self.new);
                    self.count("curves");
                }
            }
        }
        if let Some(Value::Array(cs)) = sk.get_mut("constraints") {
            for c in cs.iter_mut() {
                if let Value::Object(o) = c {
                    for k in CONSTRAINT_ARGS {
                        self.field(o, k, "constraints");
                    }
                }
            }
        }
        for (i, f) in doc.parts[pi].features.iter().enumerate() {
            let fv = &mut v["parts"][pi]["features"][i];
            if self.consumers.contains(f.id()) {
                self.list(fv.get_mut("regions"), "regions");
            } else if self.holes.contains(f.id()) {
                self.list(fv.pointer_mut("/at/points/ids"), "points");
            }
        }
        for (qi, part) in doc.parts.iter().enumerate() {
            for (i, f) in part.features.iter().enumerate() {
                let fv = &mut v["parts"][qi]["features"][i];
                self.walk(fv, false, f.id(), &mut String::new());
            }
        }
    }

    fn curve(&self, c: &str) -> String {
        if c == self.old {
            return self.new.clone();
        }
        match c.strip_prefix(self.old.as_str()) {
            Some(rest) if rest.starts_with('.') => format!("{}{rest}", self.new),
            _ => c.to_string(),
        }
    }

    fn count(&mut self, what: &'static str) {
        *self.counts.entry(what).or_default() += 1;
    }

    /// Rewrite a string field in place; counts a change.
    fn field(&mut self, o: &mut Map<String, Value>, k: &str, what: &'static str) {
        if let Some(Value::String(s)) = o.get(k) {
            let n = self.curve(s);
            if n != *s {
                o.insert(k.to_string(), Value::String(n));
                self.count(what);
            }
        }
    }

    fn list(&mut self, v: Option<&mut Value>, what: &'static str) {
        if let Some(Value::Array(a)) = v {
            for x in a.iter_mut() {
                if let Value::String(s) = x {
                    let n = self.curve(s);
                    if n != *s {
                        *s = n;
                        self.count(what);
                    }
                }
            }
        }
    }

    /// A body member of a consumer, renamed. Without an evaluated sketch it cannot be known
    /// (counted in `unmapped`); a member no current region has (a capture that predates other
    /// edits) keeps its curve renamed.
    fn member(&self, m: &str) -> String {
        if let Some(n) = self.members.get(m) {
            return n.clone();
        }
        self.miss();
        self.curve(m)
    }

    /// A junction qualifier `c.start` / `c.end` of a consumer's edge or vertex key, renamed (see
    /// [`Renamer::member`]).
    fn qualifier(&self, q: &str) -> String {
        if let Some(n) = self.qualifiers.get(q) {
            return n.clone();
        }
        self.miss();
        match q.rsplit_once('.') {
            Some((c, e)) => format!("{}.{e}", self.curve(c)),
            None => q.to_string(),
        }
    }

    /// The member of a pattern copy's origin (`P/body:m@i`, a `body` query's origin reading),
    /// renamed: the seed body's member follows the rename ([`Renamer::patterns`]). A member no
    /// region of the sketch has is another sketch's (a body seed copying other bodies too) and
    /// is kept. Without an evaluated sketch it cannot be known (counted in `unmapped`).
    fn pattern_member(&self, m: &str) -> String {
        if let Some(n) = self.members.get(m) {
            return n.clone();
        }
        self.miss();
        m.to_string()
    }

    fn miss(&self) {
        if !self.derived {
            self.unmapped.set(self.unmapped.get() + 1);
        }
    }

    /// Rewrite a provenance key (nested keys recursively, then sorted, as the grammar keeps
    /// them). A string that is not a key is returned unchanged.
    fn key(&self, key: &str) -> String {
        use keys::Arg;
        let Some(mut p) = keys::parse(key) else {
            return key.to_string();
        };
        let ours = self.consumers.contains(&p.feature);
        let hole = self.holes.contains(&p.feature);
        let copies = self.patterns.contains(&p.feature);
        p.arg = match std::mem::replace(&mut p.arg, Arg::None) {
            Arg::Keys(ks) => {
                let mut ks: Vec<String> = ks.iter().map(|k| self.key(k)).collect();
                ks.sort();
                Arg::Keys(ks)
            }
            Arg::Leaf(l) if ours && p.label == "side" => Arg::Leaf(self.curve(&l)),
            Arg::Leaf(l) if ours && p.label == "body" => Arg::Leaf(self.member(&l)),
            Arg::Leaf(l) if copies && p.label == "body" => Arg::Leaf(self.pattern_member(&l)),
            Arg::Leaves(ls) if ours && p.label == "side" => {
                let mut ls: Vec<String> = ls.iter().map(|l| self.curve(l)).collect();
                ls.sort();
                Arg::Leaves(ls)
            }
            other => other,
        };
        if let Some(q) = p.qualifier.take() {
            p.qualifier = Some(match p.label.as_str() {
                "cap" | "endcap" if ours => self.member(&q),
                "edge" | "vertex" if ours => self.qualifier(&q),
                l if hole && HOLE_ROLES.contains(&l) => self.curve(&q),
                _ => q,
            });
        }
        p.render()
    }

    /// A query node's own curve fields (`side`/`edge_at` `curve`, `body`/`cap`/`endcap`/
    /// `sides` `member`, `hole_face` `at`) when it names a feature of the renamed sketch.
    fn query_node(&mut self, o: &mut Map<String, Value>) {
        let Some(op) = o.get("op").and_then(Value::as_str).map(str::to_string) else {
            return;
        };
        let feature = o.get("feature").and_then(Value::as_str).unwrap_or("");
        let ours = self.consumers.contains(feature);
        let hole = self.holes.contains(feature);
        match op.as_str() {
            "side" | "edge_at" if ours => self.field(o, "curve", "queries"),
            "body" | "cap" | "endcap" | "sides" if ours => self.field(o, "member", "queries"),
            "hole_face" if hole => self.field(o, "at", "queries"),
            "body" if self.patterns.contains(feature) => {
                let Some(m) = o.get("member").and_then(Value::as_str).map(str::to_string) else {
                    return;
                };
                let feature = feature.to_string();
                // See `pattern_members`: rewritten only when both readings of §5.3 agree.
                let as_curve = self.curve(&m);
                let as_origin = self.pattern_member(&m);
                if as_curve != as_origin {
                    if self.derived {
                        self.pattern_members.push(json!({
                            "pattern": id_value(&feature), "member": id_value(&m),
                            "as_curve": id_value(&as_curve), "as_origin": id_value(&as_origin),
                        }));
                    }
                } else if as_curve != m {
                    o.insert("member".into(), Value::String(as_curve));
                    self.count("queries");
                }
            }
            _ => {}
        }
    }

    /// Rewrite the keys of a capture of a `kind` Ref, then (when a key changed) restore the
    /// canonical member order (§5.6: one entry per member in the canonical order of §5.4 —
    /// faces, edges and vertices by key, byte-wise; bodies by origin, i.e. timeline index of the
    /// origin feature then member), stably: the pieces of one key (one origin) keep their order,
    /// which the rename does not change (probe points, instances, centroids).
    fn capture(&mut self, c: &mut Value, kind: &str) -> usize {
        let Some(ms) = c.get_mut("members").and_then(Value::as_array_mut) else {
            return 0;
        };
        let mut n = 0;
        for m in ms.iter_mut() {
            if let Some(Value::String(k)) = m.get_mut("key") {
                let r = self.key(k);
                if r != *k {
                    *k = r;
                    n += 1;
                }
            }
            if let Some(Value::Array(fs)) = m.get_mut("faces") {
                for f in fs.iter_mut() {
                    if let Value::String(k) = f {
                        let r = self.key(k);
                        if r != *k {
                            *k = r;
                            n += 1;
                        }
                    }
                }
                // The two face keys are stored sorted (§5.6).
                fs.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            }
        }
        if n > 0 {
            let rank = |m: &Value| -> (usize, usize, String) {
                let k = m.get("key").and_then(Value::as_str).unwrap_or("");
                if kind != "body" {
                    return (0, 0, k.to_string());
                }
                match keys::parse(k) {
                    Some(p) if p.label == "body" => {
                        let (pi, fi) = self
                            .order
                            .get(&p.feature)
                            .copied()
                            .unwrap_or((usize::MAX, usize::MAX));
                        let member = match p.arg {
                            keys::Arg::Leaf(l) => l,
                            _ => String::new(),
                        };
                        (pi, fi, member)
                    }
                    _ => (usize::MAX, usize::MAX, k.to_string()),
                }
            };
            // `sort_by_key` is stable.
            ms.sort_by_key(rank);
        }
        *self.counts.entry("capture_keys").or_default() += n;
        n
    }

    /// Every Ref (`{ kind, q, … }`) of `v`, the value of feature `feature` at `path` (a JSON
    /// pointer relative to the feature): its query nodes and capture keys; Refs nested in
    /// queries (axis objects of directions) included. A Ref whose capture keys change is
    /// recorded in `rewritten_refs`.
    fn walk(&mut self, v: &mut Value, in_query: bool, feature: &str, path: &mut String) {
        match v {
            Value::Object(o) => {
                let is_ref = o.contains_key("kind") && o.contains_key("q");
                if is_ref {
                    let kind = o
                        .get("kind")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if let Some(c) = o.get_mut("capture")
                        && self.capture(c, &kind) > 0
                    {
                        self.rewritten_refs
                            .push((feature.to_string(), path.clone()));
                    }
                }
                if in_query {
                    self.query_node(o);
                }
                for (k, child) in o.iter_mut() {
                    if is_ref && k == "capture" {
                        continue;
                    }
                    let len = path.len();
                    path.push('/');
                    path.push_str(&k.replace('~', "~0").replace('/', "~1"));
                    self.walk(child, in_query || (is_ref && k == "q"), feature, path);
                    path.truncate(len);
                }
            }
            Value::Array(a) => {
                for (i, x) in a.iter_mut().enumerate() {
                    let len = path.len();
                    path.push_str(&format!("/{i}"));
                    self.walk(x, in_query, feature, path);
                    path.truncate(len);
                }
            }
            _ => {}
        }
    }
}

/// `renameCurve(sketchId, old, new)` (SPEC-v1 §5.9, naming recommendation 7): rename a declared
/// curve of a sketch and, in the same op, every query field naming it (`side`/`edge_at`
/// `curve`, `member`s, `hole_face` `at`), the consuming sweeps' `regions`, hole `points`, the
/// sketch's constraint arguments and every capture key (body members and junction qualifiers
/// recomputed). Direction and geometry are untouched. Compound members and derived ids follow
/// (`outline` → `frame` renames `outline.bottom`).
///
/// Captures whose keys changed are re-sorted into canonical member order (§5.6), so the result
/// is what `captureRef` would write for the renamed document.
///
/// Body members and junction qualifiers come from the sketch's evaluation: a suppressed sketch
/// (or one that fails only because something is suppressed) is read from a probe of the
/// document with every feature unsuppressed. A sketch that fails even then has no regions or
/// solution: the rename is refused (`COMMAND_NOT_EXACT`, reason "sketch not evaluated …",
/// `details: { sketch_status, code, keys }`) when a capture key needs them, since substituting
/// the id would write keys the engine does not produce.
///
/// Patterns: a copy's origin is `{ pattern, the seed body's member, instance }` (§5.2 rule 4,
/// §6.10), so the `P/body:m@i` keys of a pattern that copies the consumers' bodies follow the
/// rename like `F/body:m` ([`Renamer::patterns`]). A `body` query may name such a pattern with
/// a `member` (§5.3), which reads two ways — a curve of the seed's outer loop (§5.3's wording)
/// or the copies' origin member (how forge-refs resolves it: a pattern has no regions). Where
/// the two rewrite it alike it is rewritten; where they differ the rename is refused
/// (`COMMAND_NOT_EXACT`, `details.patterns: [{ pattern, member, as_curve, as_origin }]`)
/// rather than guessed, until W0 rules which reading §5.3 means.
///
/// Verified before it is returned: the edited document must evaluate to the same report up to
/// the rename (the IR-V1 plan's "report identical except display names") — else
/// `COMMAND_NOT_EXACT` (renames resolve exactly, never through a geometric match). Compared
/// **exactly**: the document and every feature's status, error and warning codes, parameter
/// values, regions (`loops`, `outer_curves` renamed), the sketch solution, body counts,
/// origins (members renamed), `faces`, `edges`, `shells`, `face_types`, `edge_types`, `removed`,
/// hole `at` ids and kinds, blend and shell face keys, pattern instances, and every reference's
/// status, code, members, unresolved members and candidates (keys renamed, `via`, statuses,
/// reasons). Compared **within SPEC-v1 §8.2's tolerances** (v0 §6's `rel`, `abs` and `s`, the
/// largest body diagonal of either report): `volume`, `area`, `centroid`, `bbox_*`, datum
/// origins and directions, hole `center`, `axis`, `d` and `depth`, and the probes of members
/// and candidates (points like centroids, normals like directions). Every other number is
/// compared bit for bit. The tolerance exists because a renamed id can change the order in
/// which Forge accumulates a metric: renaming plate_features' hole point `p1` moves the x of
/// the centroids of `h2`'s body and of the bodies after it by about 4e-19 mm (an id-dependent
/// order in the kernel, reported with W9 as a W4/W5 follow-up). What a reference designates is
/// still compared exactly (keys and statuses), and its location to far below any gap between
/// distinct entities. When a feature is suppressed,
/// the same check runs on both documents with every feature unsuppressed (a suppressed feature
/// has no report entry to compare).
///
/// A rewritten capture is verified through its reference's report entry. A reference with no
/// resolution to compare — its feature fails before resolving it (`DEPENDENCY_FAILED`,
/// `PARAM_FAILED`, …; the entry has no members, unresolved or removed keys), or a Ref nested in a
/// direction (not reported, §5.8 [W0-34]) — keeps keys rewritten by the rules above but
/// unchecked by the engine: it is listed in `result.unverified` (`{ feature, field, reason:
/// "failed" | "not-reported", code? }`), so the caller can re-check it once the feature
/// evaluates (a `captureRef` then refreshes it if needed).
///
/// `result`: `{ sketch, old, new, rewritten: { curves, constraints, regions, points, queries,
/// capture_keys }, unverified }`.
pub fn rename_curve(
    ir_json: &str,
    sketch: &str,
    old: &str,
    new: &str,
) -> Result<Edited, Rejection> {
    let doc = load(ir_json)?;
    let (pi, fi) = feature_index(&doc, sketch)?;
    let Feature::Sketch(s) = &doc.parts[pi].features[fi] else {
        return Err(refusal(
            "COMMAND_UNKNOWN_SKETCH",
            format!("{} is not a sketch", shown(sketch)),
            json!({ "sketch": id_value(sketch) }),
        ));
    };
    if !s.curves.iter().any(|c| c.id() == old) {
        return Err(refusal(
            "COMMAND_UNKNOWN_CURVE",
            format!("{} is not a curve of sketch {}", shown(old), shown(sketch)),
            json!({ "sketch": id_value(sketch), "curve": id_value(old) }),
        ));
    }
    if old == new {
        return Ok(edited(
            &doc,
            &doc,
            json!({ "sketch": sketch, "old": old, "new": new, "rewritten": {} }),
        ));
    }
    let before = evaluate(&doc);
    let mut v = to_value(&doc);
    // A suppressed feature has no report entry: its references (and a suppressed sketch's
    // regions) are read from a probe of the document with every feature unsuppressed, and the
    // rename is verified on that probe too.
    let probe_before = if any_suppressed(&v) {
        Some(evaluate(&load_value(&unsuppressed(&v))?))
    } else {
        None
    };
    let mut r = Renamer::new(&doc, pi, sketch, old, new);
    let facts = evaluated_sketch(&before, sketch).or_else(|| {
        probe_before
            .as_ref()
            .and_then(|p| evaluated_sketch(p, sketch))
    });
    if let Some(entry) = facts {
        r.members = region_members(entry, &r);
        r.qualifiers = junction_qualifiers(entry, &r);
        r.derived = true;
    }
    r.refine_patterns(&doc, probe_before.as_ref().unwrap_or(&before));
    r.rewrite(&doc, &mut v, pi, fi);
    let ctx = || json!({ "sketch": id_value(sketch), "old": id_value(old), "new": id_value(new) });
    if let Some(e) = pattern_member_refusal(&r, ctx()) {
        return Err(e);
    }
    if !r.derived && r.unmapped.get() > 0 {
        // Substituting the id would write keys the engine does not produce (a region's member
        // is its smallest curve id, a junction's qualifier its smallest end): every reference
        // through them would then resolve only by the geometric fallback (§5.9: never).
        let entry = probe_before
            .as_ref()
            .and_then(|p| feature_entry(p, sketch))
            .or_else(|| feature_entry(&before, sketch));
        let (status, code) = match entry {
            None => ("suppressed", None),
            Some(e) => ("failed", e.error.as_ref().map(|x| x.code.clone())),
        };
        let mut d = ctx();
        d["sketch_status"] = json!(status);
        d["code"] = json!(code);
        d["keys"] = json!(r.unmapped.get());
        return Err(not_exact(
            "renameCurve",
            format!(
                "sketch not evaluated: sketch {} {}, so the body members and junction qualifiers \
                 of {} capture key(s) cannot be recomputed; fix the sketch first",
                shown(sketch),
                match &code {
                    Some(c) => format!("fails with {c}"),
                    None if status == "failed" => "fails".to_string(),
                    None => "is not evaluated".to_string(),
                },
                r.unmapped.get()
            ),
            d,
        ));
    }
    let out = load_value(&v)?;
    let after = evaluate(&out);
    if let Err(reason) = verify_rename(&before, &after, &r) {
        return Err(not_exact("renameCurve", reason, ctx()));
    }
    if let Some(pb) = &probe_before {
        let pa = evaluate(&load_value(&unsuppressed(&v))?);
        if let Err(reason) = verify_rename(pb, &pa, &r) {
            return Err(not_exact(
                "renameCurve",
                format!("with every feature unsuppressed, {reason}"),
                ctx(),
            ));
        }
    }
    let rewritten: Map<String, Value> = r
        .counts
        .iter()
        .map(|(k, n)| ((*k).to_string(), json!(n)))
        .collect();
    let unverified = unverified_refs(probe_before.as_ref().unwrap_or(&before), &r);
    Ok(edited(
        &doc,
        &out,
        json!({ "sketch": sketch, "old": old, "new": new, "rewritten": rewritten,
                "unverified": unverified }),
    ))
}

/// The refusal of a rename that meets a `body` query naming a pattern with a `member` that the
/// two readings of §5.3 rewrite differently (see [`Renamer::pattern_members`]):
/// `COMMAND_NOT_EXACT`, `details.patterns: [{ pattern, member, as_curve, as_origin }]`. Pending
/// a W0 ruling on which reading §5.3 means.
fn pattern_member_refusal(r: &Renamer, mut details: Value) -> Option<Rejection> {
    if r.pattern_members.is_empty() {
        return None;
    }
    let n = r.pattern_members.len();
    details["patterns"] = Value::Array(r.pattern_members.clone());
    Some(not_exact(
        "renameCurve",
        format!(
            "{n} body quer{} name a pattern with a member this rename changes, and SPEC-v1 §5.3 \
             reads it two ways (a curve of the seed's outer loop, or the copies' origin member) \
             that rewrite it differently; W0 has not ruled which one it means, so it is not \
             rewritten by guess",
            if n == 1 { "y" } else { "ies" }
        ),
        details,
    ))
}

/// The rewritten references whose report entry in `rep` (the report the rename was verified
/// on) has nothing that exercised their capture keys: `{ feature, field, reason, code? }` —
/// `failed` when the feature failed before resolving it (no members, unresolved or removed
/// keys; `code` the reference's or the feature's), `not-reported` for a Ref without a report
/// entry (nested in a direction, §5.8 [W0-34]).
fn unverified_refs(rep: &EvalReport, r: &Renamer) -> Vec<Value> {
    let mut out = Vec::new();
    for (feature, field) in &r.rewritten_refs {
        let f = feature_entry(rep, feature);
        let entry = f.and_then(|f| f.refs.iter().find(|x| &x.field == field));
        let (reason, code) = match (f, entry) {
            (_, Some(e))
                if !e.members.is_empty() || !e.unresolved.is_empty() || !e.removed.is_empty() =>
            {
                continue;
            }
            (Some(f), Some(e)) => (
                "failed",
                e.code
                    .clone()
                    .or_else(|| f.error.as_ref().map(|x| x.code.clone())),
            ),
            (Some(f), None) if f.status == Status::Error => {
                ("failed", f.error.as_ref().map(|x| x.code.clone()))
            }
            _ => ("not-reported", None),
        };
        let mut o = json!({ "feature": id_value(feature), "field": key_value(field),
                            "reason": reason });
        if let Some(c) = code {
            o["code"] = json!(c);
        }
        out.push(o);
    }
    out
}

/// The sketch's report entry when it evaluated (regions and solved geometry).
fn evaluated_sketch<'r>(rep: &'r EvalReport, sketch: &str) -> Option<&'r FeatureReport> {
    feature_entry(rep, sketch).filter(|e| e.status != Status::Error && e.sketch.is_some())
}

/// Whether any feature of the document value is suppressed (`suppressed` other than `false`).
fn any_suppressed(v: &Value) -> bool {
    v["parts"].as_array().is_some_and(|ps| {
        ps.iter().any(|p| {
            p["features"].as_array().is_some_and(|fs| {
                fs.iter().any(|f| {
                    f.get("suppressed")
                        .is_some_and(|x| *x != Value::Bool(false))
                })
            })
        })
    })
}

/// The document value with every feature unsuppressed.
fn unsuppressed(v: &Value) -> Value {
    let mut out = v.clone();
    if let Some(ps) = out.get_mut("parts").and_then(Value::as_array_mut) {
        for p in ps {
            if let Some(fs) = p.get_mut("features").and_then(Value::as_array_mut) {
                for f in fs.iter_mut().filter_map(Value::as_object_mut) {
                    f.remove("suppressed");
                }
            }
        }
    }
    out
}

/// Old body member → new, for every region of the sketch (§5.2 rule 4: the byte-wise smallest
/// outer-loop curve id).
fn region_members(entry: &FeatureReport, r: &Renamer) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for reg in &entry.regions {
        let old = reg.outer_curves.iter().min();
        let new = reg.outer_curves.iter().map(|c| r.curve(c)).min();
        if let (Some(o), Some(n)) = (old, new) {
            out.insert(o.clone(), n);
        }
    }
    out
}

/// Old junction qualifier → new (§5.2 rule 3: the byte-wise smallest `c.start` / `c.end` of the
/// curve ends meeting at a sketch vertex), from the sketch's solved geometry: the ends of its
/// profile lines and arcs, grouped by coincidence within `LINEAR_TOLERANCE`.
fn junction_qualifiers(entry: &FeatureReport, r: &Renamer) -> BTreeMap<String, String> {
    use forge_ir::v1::LiteralCurve;
    let Some(sk) = &entry.sketch else {
        return BTreeMap::new();
    };
    let mut ends: Vec<(String, [f64; 2])> = Vec::new();
    for c in &sk.solved {
        match c {
            LiteralCurve::Line {
                id,
                start,
                end,
                construction: false,
            }
            | LiteralCurve::Arc {
                id,
                start,
                end,
                construction: false,
                ..
            } => {
                ends.push((format!("{id}.start"), *start));
                ends.push((format!("{id}.end"), *end));
            }
            _ => {}
        }
    }
    // Union-find over coincident ends, in order.
    let mut parent: Vec<usize> = (0..ends.len()).collect();
    fn root(p: &mut [usize], mut i: usize) -> usize {
        while p[i] != i {
            p[i] = p[p[i]];
            i = p[i];
        }
        i
    }
    for i in 0..ends.len() {
        for j in i + 1..ends.len() {
            let (a, b) = (ends[i].1, ends[j].1);
            let d = ((a[0] - b[0]).powi(2) + (a[1] - b[1]).powi(2)).sqrt();
            if d <= forge_ir::v1::LINEAR_TOLERANCE {
                let (ri, rj) = (root(&mut parent, i), root(&mut parent, j));
                if ri != rj {
                    parent[rj.max(ri)] = rj.min(ri);
                }
            }
        }
    }
    let mut groups: BTreeMap<usize, Vec<&str>> = BTreeMap::new();
    for (i, (end, _)) in ends.iter().enumerate() {
        let g = root(&mut parent, i);
        groups.entry(g).or_default().push(end.as_str());
    }
    let mut out = BTreeMap::new();
    for g in groups.values().filter(|g| g.len() >= 2) {
        let old = g.iter().min().map(|s| (*s).to_string());
        let new = g
            .iter()
            .map(|e| match e.rsplit_once('.') {
                Some((c, x)) => format!("{}.{x}", r.curve(c)),
                None => (*e).to_string(),
            })
            .min();
        if let (Some(o), Some(n)) = (old, new) {
            out.insert(o, n);
        }
    }
    out
}

// ---- renameCurve: the verification --------------------------------------------------------------

/// The float tolerances of the rename's verification (see [`rename_curve`]): SPEC-v1 §8.2 for
/// the quantities it lists, with v0 §6's definitions of `rel`, `abs` and `s`; every other
/// number must be bit-identical.
struct Tolerances {
    /// `s`: the largest bounding-box diagonal of any body of either report, at least 1.
    s: f64,
}

impl Tolerances {
    fn of(reports: [&EvalReport; 2]) -> Self {
        let mut s: f64 = 1.0;
        for rep in reports {
            let bodies = rep
                .features
                .iter()
                .flat_map(|f| &f.bodies)
                .chain(rep.parts.iter().flat_map(|p| &p.bodies));
            for b in bodies {
                let d = (0..3)
                    .map(|i| (b.bbox_max[i] - b.bbox_min[i]).powi(2))
                    .sum::<f64>()
                    .sqrt();
                if d.is_finite() {
                    s = s.max(d);
                }
            }
        }
        Tolerances { s }
    }

    /// Whether `a` and `b`, held by field `key` (a vector's components share its key), match.
    /// `region`: a sketch region's area (v0 §6: `s = 1` for regions).
    fn numbers(&self, key: &str, region: bool, a: f64, b: f64) -> bool {
        if a.to_bits() == b.to_bits() {
            return true;
        }
        let abs = (a - b).abs();
        let rel = abs / a.abs().max(b.abs());
        let s = if region { 1.0 } else { self.s };
        match key {
            "volume" => rel <= 1e-6 || abs <= 1e-9 * s * s * s,
            "area" => rel <= 1e-6 || abs <= 1e-9 * s * s,
            "centroid" | "bbox_min" | "bbox_max" | "center" | "origin" | "point" => abs <= 1e-6 * s,
            "normal" | "axis" | "direction" | "x" | "y" => abs <= 1e-9,
            "d" | "depth" => abs <= 1e-9 * s,
            _ => false,
        }
    }
}

/// The first difference between `a` and `b` (the JSON pointer of it), numbers compared with
/// `tol` under the key of the field that holds them, everything else exactly.
fn difference(a: &Value, b: &Value, tol: &Tolerances, key: &str, region: bool) -> Option<String> {
    let at = |p: &str, rest: Option<String>| rest.map(|r| format!("/{p}{r}"));
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) if tol.numbers(key, region, x, y) => None,
            _ => Some(String::new()),
        },
        (Value::Array(xs), Value::Array(ys)) => {
            if xs.len() != ys.len() {
                return Some(String::new());
            }
            xs.iter()
                .zip(ys)
                .enumerate()
                .find_map(|(i, (x, y))| at(&i.to_string(), difference(x, y, tol, key, region)))
        }
        (Value::Object(xs), Value::Object(ys)) => {
            if xs.len() != ys.len() || xs.keys().any(|k| !ys.contains_key(k)) {
                return Some(String::new());
            }
            xs.iter()
                .find_map(|(k, x)| at(k, difference(x, &ys[k], tol, k, region || k == "regions")))
        }
        _ => (a != b).then(String::new),
    }
}

/// The rename's verification: the report after the rename equals the report before, up to
/// the rename (see [`rename_curve`]). Returns the first difference.
fn verify_rename(before: &EvalReport, after: &EvalReport, r: &Renamer) -> Result<(), String> {
    if before.status != after.status {
        return Err(format!(
            "the document status changed from {:?} to {:?}",
            before.status, after.status
        ));
    }
    if before.params != after.params {
        return Err("the parameter values changed".into());
    }
    if before.features.len() != after.features.len()
        || before
            .features
            .iter()
            .zip(&after.features)
            .any(|(b, a)| b.feature_id != a.feature_id || b.feature_type != a.feature_type)
    {
        return Err("the evaluated features changed".into());
    }
    let tol = Tolerances::of([before, after]);
    for (b, a) in before.features.iter().zip(&after.features) {
        let (vb, va) = (feature_value(b, r, true), feature_value(a, r, false));
        if let Some(path) = difference(&vb, &va, &tol, "", false) {
            let what = path.split('/').nth(1).unwrap_or("entry");
            return Err(format!(
                "feature {}: {what} changed (at {})",
                shown(&b.feature_id),
                shown_key(&path)
            ));
        }
    }
    if before.parts.len() != after.parts.len() {
        return Err("the parts changed".into());
    }
    for (pb, pa) in before.parts.iter().zip(&after.parts) {
        let (vb, va) = (
            bodies_value(&pb.bodies, r, true),
            bodies_value(&pa.bodies, r, false),
        );
        if let Some(path) = difference(&vb, &va, &tol, "", false) {
            return Err(format!(
                "the final bodies of part {} changed (at {})",
                shown(&pb.part_id),
                shown_key(&path)
            ));
        }
    }
    Ok(())
}

/// A feature's report entry up to the rename, as the value [`verify_rename`] compares: ids and
/// keys renamed (`map`: the entry before the rename), display names, messages and warning
/// details dropped, every list whose order follows ids sorted by what identifies its items.
fn feature_value(f: &FeatureReport, r: &Renamer, map: bool) -> Value {
    let mut warnings: Vec<&str> = f.warnings.iter().map(|w| w.code.as_str()).collect();
    warnings.sort_unstable();
    // Curve ids are the renamed sketch's in its own entry and its consumers' only (other
    // sketches may have a curve with the old id).
    let curves = map && (f.feature_id == r.sketch || r.consumers.contains(&f.feature_id));
    let mut regions: Vec<(Vec<String>, u32, f64)> = f
        .regions
        .iter()
        .map(|x| {
            let mut cs: Vec<String> = x
                .outer_curves
                .iter()
                .map(|c| if curves { r.curve(c) } else { c.clone() })
                .collect();
            cs.sort();
            (cs, x.loops, x.area)
        })
        .collect();
    regions.sort_by(|a, b| (&a.0, a.1).cmp(&(&b.0, b.1)));
    let regions: Vec<Value> = regions
        .into_iter()
        .map(|(cs, loops, area)| json!({ "outer_curves": cs, "loops": loops, "area": area }))
        .collect();
    let hole = map && r.holes.contains(&f.feature_id);
    let mut holes: Vec<Value> = f
        .holes
        .iter()
        .map(|h| {
            let mut v = serde_json::to_value(h).unwrap_or(Value::Null);
            if hole {
                v["at"] = json!(r.curve(&h.at));
            }
            v
        })
        .collect();
    holes.sort_by(|a, b| a["at"].as_str().cmp(&b["at"].as_str()));
    let keys = |ks: &[String]| -> Vec<String> {
        let mut v: Vec<String> = ks
            .iter()
            .map(|k| if map { r.key(k) } else { k.clone() })
            .collect();
        v.sort();
        v
    };
    let blend = |b: &Option<forge_ir::v1::metrics::BlendReport>| {
        b.as_ref().map(|b| {
            json!({ "edges": keys(&b.edges), "chain_added": keys(&b.chain_added),
                    "faces_created": keys(&b.faces_created) })
        })
    };
    json!({
        "status": f.status,
        "error": f.error.as_ref().map(|e| &e.code),
        "warnings": warnings,
        "regions": regions,
        // The solution is compared bit for bit (a string: never within a tolerance).
        "sketch": f.sketch.as_ref().map(|s| sketch_value(s, r, curves)),
        "datum": f.datum,
        "bodies": bodies_value(&f.bodies, r, map),
        "removed": origins_value(&f.removed, r, map),
        "refs": f.refs.iter().map(|e| ref_value(e, r, map)).collect::<Vec<_>>(),
        "holes": holes,
        "fillet": blend(&f.fillet),
        "chamfer": blend(&f.chamfer),
        "shell": f.shell.as_ref().map(|s| json!({ "removed_faces": keys(&s.removed_faces),
                                                   "closed_void": s.closed_void })),
        "pattern": f.pattern,
    })
}

fn sketch_value(s: &forge_ir::v1::metrics::SketchReport, r: &Renamer, map: bool) -> String {
    let mut v = serde_json::to_value(s).unwrap_or(Value::Null);
    if map && let Some(Value::Array(cs)) = v.get_mut("solved") {
        for c in cs.iter_mut() {
            if let Some(Value::String(id)) = c.get_mut("id") {
                *id = r.curve(id);
            }
        }
    }
    v.to_string()
}

fn origin_value(o: &forge_ir::v1::metrics::Origin, r: &Renamer, map: bool) -> Value {
    let mut o = o.clone();
    if map && r.consumers.contains(&o.feature) {
        o.member = r.member(&o.member);
    } else if map && r.patterns.contains(&o.feature) {
        o.member = r.pattern_member(&o.member);
    }
    serde_json::to_value(&o).unwrap_or(Value::Null)
}

/// Bodies with their origins renamed, sorted by origin (canonical body order is by member, so
/// a rename can reorder them); bodies sharing an origin (split pieces) keep their order.
fn bodies_value(bs: &[forge_ir::v1::metrics::BodyReport], r: &Renamer, map: bool) -> Value {
    let mut v: Vec<(String, Value)> = bs
        .iter()
        .map(|b| {
            let mut x = serde_json::to_value(b).unwrap_or(Value::Null);
            let o = origin_value(&b.origin, r, map);
            x["origin"] = o.clone();
            (o.to_string(), x)
        })
        .collect();
    v.sort_by(|a, b| a.0.cmp(&b.0));
    Value::Array(v.into_iter().map(|(_, x)| x).collect())
}

fn origins_value(os: &[forge_ir::v1::metrics::Origin], r: &Renamer, map: bool) -> Value {
    let mut v: Vec<Value> = os.iter().map(|o| origin_value(o, r, map)).collect();
    v.sort_by_key(Value::to_string);
    Value::Array(v)
}

/// A reference entry up to the rename: members, unresolved members and candidates with keys
/// renamed (display names dropped), each list sorted by what identifies its items (pieces of
/// one key keep their order); `added`/`removed` renamed and sorted.
fn ref_value(e: &RefReport, r: &Renamer, map: bool) -> Value {
    let k = |s: &str| if map { r.key(s) } else { s.to_string() };
    let sorted = |mut v: Vec<(String, Value)>| -> Vec<Value> {
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v.into_iter().map(|(_, x)| x).collect()
    };
    let members = sorted(
        e.members
            .iter()
            .map(|m| {
                let id = json!([k(&m.key), m.via, m.status]);
                (
                    id.to_string(),
                    json!({ "member": id, "probe": serde_json::to_value(&m.probe).ok() }),
                )
            })
            .collect(),
    );
    let unresolved = sorted(
        e.unresolved
            .iter()
            .map(|u| {
                let cands = sorted(
                    u.candidates
                        .iter()
                        .map(|c| {
                            let id = json!([k(&c.key), c.reason]);
                            (
                                id.to_string(),
                                json!({ "candidate": id, "confidence": c.confidence,
                                        "probe": serde_json::to_value(&c.probe).ok() }),
                            )
                        })
                        .collect(),
                );
                let id = json!([k(&u.key), u.reason]);
                (
                    id.to_string(),
                    json!({ "unresolved": id, "candidates": cands }),
                )
            })
            .collect(),
    );
    let mut added: Vec<String> = e.added.iter().map(|x| k(x)).collect();
    added.sort();
    let mut removed: Vec<String> = e.removed.iter().map(|x| k(x)).collect();
    removed.sort();
    json!({ "field": e.field, "status": e.status, "code": e.code,
            "members": members, "unresolved": unresolved, "added": added, "removed": removed,
            "proposal": e.proposal.is_some() })
}

#[cfg(test)]
#[path = "commands_tests.rs"]
mod tests;
