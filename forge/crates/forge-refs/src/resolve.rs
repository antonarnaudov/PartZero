//! Reference resolution (SPEC-v1 §5.7 [D-30]) and its report entry (§5.8 [D-31], I5).
//!
//! The normative order:
//! 1. **evaluate the query** (exact provenance through keys and aliases, filters, picks); a
//!    source of a failed feature fails with `DEPENDENCY_FAILED`, one of a suppressed feature
//!    yields nothing (reason `feature-suppressed`);
//! 2. without a capture, go to 5;
//! 3. **validate the captured named members**, one key at a time, against the members carrying
//!    that key or an alias of it (nested keys included, [`Scope::normalize_key`]): exact,
//!    merged, neighbourhood changed, kind changed, or split. A key that several captured members
//!    carry (a re-captured accepted split) is matched piece by piece: as many pieces as captured
//!    are validated one-to-one (exact when nothing changed), more pieces are a further split,
//!    fewer send the unmatched captured pieces to step 4. A member with more same-carrier
//!    neighbours is split into itself and the same-carrier neighbours inside the captured box
//!    (a sliver piece of a geometry-identical member included); with none in the box it is
//!    exact when geometry-identical to its capture (a collinear segment added next to an
//!    unchanged face is no split), otherwise (a capture that predates other edits, §0.6) the
//!    split cannot be delimited and fails `REF_SPLIT` whatever the card. Pieces carrying the
//!    captured key that the query's picks or filters dropped are never pieces; pieces with new
//!    keys under a query that chooses (`extreme`, `largest`, `smallest`, `filter`,
//!    `intersect`, `minus`) make the split fail `REF_SPLIT` whatever the card (the query never
//!    saw them).
//!    A captured key the scope still carries but the query's own filters or picks dropped is
//!    **removed** (`REF_SET_CHANGED`, the query is the intent), never sent to step 4 — unless
//!    its entity was split into pieces with new keys (`REF_SPLIT`, see above);
//! 4. **geometric fallback** for a captured named member whose key is gone, scored with the
//!    forge-naming comparison over every entity of its kind and type in scope; entities that
//!    another captured member accounts for (their key is in the step-1 result, or step 3 or 4
//!    already took them) are never identical matches or split pieces and are ranked after the
//!    free ones: a unique geometry-identical entity is used (`REF_REPAIRED`, confidence
//!    `IDENTICAL_MATCH_CONFIDENCE`) **only if it is the member's own feature's** (a captured
//!    key that does not parse has no own feature);
//!    several geometry-identical entities (of any features) are `REF_AMBIGUOUS` with the own
//!    feature's first; a unique geometry-identical entity of another feature is a candidate
//!    only (`REF_UNCERTAIN`). Every other outcome fails with ranked candidates
//!    (`REF_MISSING`, `REF_SPLIT`, `REF_UNCERTAIN`, `REF_AMBIGUOUS`);
//! 5. **broad members and cardinality**: broad differences (and the named members of step 3
//!    the query dropped) are `REF_SET_CHANGED` (the query is the intent), then `card` is
//!    checked on the final set (`REF_MISSING`, `REF_AMBIGUOUS`, `REF_SPLIT` — also for an
//!    integer card that accepted split pieces break, i.e. the set without the extra pieces
//!    would match it —, `REF_CARDINALITY` otherwise).
//!
//! Candidate reasons and confidences emitted (the metrics schema describes `identical` as
//! "confidence `IDENTICAL_MATCH_CONFIDENCE`", but §5.7 lists identical candidates that are not
//! used): `identical` at `IDENTICAL_MATCH_CONFIDENCE` (a rejected query's own-feature
//! identical entity), at `MAX_DISAMBIGUATION_CONFIDENCE` (a unique identical entity of another
//! feature) or at 0 (several identical entities; the entity at the captured place in a
//! junction swap); `split-piece` at 0 (split pieces) or 0.7 (the one piece of step 4);
//! `plausible` at `min(score, MAX_DISAMBIGUATION_CONFIDENCE)`; `tie` at 0 (fingerprint ties,
//! card-one ambiguity, and the name-anchored entity of a junction swap). A candidate is never
//! used without an explicit accept, whatever its reason or confidence.
//!
//! Only exact resolutions and geometry-identical repairs are used without confirmation
//! (naming recommendation 8): the confidence of every other candidate is below
//! `AUTO_ACCEPT_CONFIDENCE`, and those outcomes fail the reference. Infos that say something is
//! used (`REF_SPLIT_ACCEPTED`, `REF_REPAIRED`) are dropped when the reference fails.
//!
//! Every reported entity carries its probe (§7.6). An entity whose probe cannot be computed is
//! never reported with a made-up point: it is left out of the report with a
//! `FORGE_PROBE_FAILED` warning, and a reference that would use it fails with the probe's
//! error (its forge-check code).

use std::collections::{BTreeMap, BTreeSet};

use forge_ir::v1::metrics::{
    Candidate, CandidateReason, MemberStatus, Probe, RefMember, RefReport, RefStatus, ReportError,
    Severity, Unresolved, UnresolvedReason, Warning,
};
use forge_ir::v1::{
    Capture, CaptureMember, CardWord, Cardinality, EntityKind, Fingerprint,
    IDENTICAL_MATCH_CONFIDENCE, MAX_CANDIDATES, MAX_DISAMBIGUATION_CONFIDENCE, MIN_PLAUSIBLE,
    Query, Ref, TIE_MARGIN, Via,
};
use serde_json::{Map, Value, json};

use crate::error::RefError;
use crate::geom::{Comparison, box_pad, compare, comparison_scale};
use crate::keys::EntityId;
use crate::query::{QuerySet, eval_query, faces_of};
use crate::scope::{Entity, Scope};
use crate::synth::synthesize_query;
use crate::table::FeatureStatus;

/// The field a reference sits in: its JSON pointer in the feature (report `field`) and the
/// field's default cardinality (§5.5).
#[derive(Clone, Debug, PartialEq)]
pub struct FieldSpec {
    /// JSON pointer relative to the feature, e.g. `/edges`, `/on/face`.
    pub field: String,
    /// The field's default cardinality.
    pub card: Cardinality,
}

impl FieldSpec {
    /// A field with default card `one`.
    pub fn one(field: impl Into<String>) -> Self {
        FieldSpec {
            field: field.into(),
            card: Cardinality::ONE,
        }
    }
}

/// A member of the resolved set.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedMember {
    /// The entity.
    pub entity: Entity,
    /// Its key.
    pub key: String,
    /// Named or broad.
    pub via: Via,
    /// How it was resolved.
    pub status: MemberStatus,
}

/// The outcome of resolving one reference.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolution {
    /// `exact`, `accepted` (warnings or infos only) or `failed`.
    pub status: RefStatus,
    /// The set the feature uses, in canonical order; empty when failed.
    pub members: Vec<ResolvedMember>,
    /// The report entry (§5.8).
    pub report: RefReport,
    /// Warnings and infos raised (also to be listed in the feature's `warnings`, §5.8).
    pub warnings: Vec<Warning>,
    /// The failure (`REF_*`, `DEPENDENCY_FAILED`, …) when `status` is `failed`.
    pub error: Option<ReportError>,
}

impl Resolution {
    /// The failing code, if failed.
    pub fn code(&self) -> Option<&str> {
        self.error.as_ref().map(|e| e.code.as_str())
    }
    /// `true` unless failed.
    pub fn is_used(&self) -> bool {
        self.status != RefStatus::Failed
    }
    /// The used entities.
    pub fn entities(&self) -> Vec<Entity> {
        self.members.iter().map(|m| m.entity).collect()
    }
}

/// Resolve a reference that sits in no particular field (report `field` `""`, the JSON pointer
/// of the whole feature) with default card `one`. The evaluator resolves feature fields with
/// [`resolve_with`], which reports the field's pointer and applies its default card.
pub fn resolve(r: &Ref, scope: &Scope<'_>) -> Resolution {
    resolve_with(r, scope, &FieldSpec::one(""))
}

fn warn(code: &str, severity: Severity, message: String, details: Value) -> Warning {
    Warning {
        code: code.to_string(),
        severity,
        message,
        details: obj(details),
    }
}

fn obj(v: Value) -> Map<String, Value> {
    match v {
        Value::Object(m) => m,
        _ => Map::new(),
    }
}

struct Builder<'s, 'a> {
    scope: &'s Scope<'a>,
    r: &'s Ref,
    field: String,
    warnings: Vec<Warning>,
    unresolved: Vec<Unresolved>,
    /// The first failing code (in captured order).
    fail: Option<&'static str>,
    split: bool,
    repaired: bool,
    /// The query was rejected statically: candidates only, nothing is used.
    rejected: bool,
    /// Splits whose pieces were taken (the card allowed it): captured key, pieces in candidate
    /// order (name-anchored first, then by size), and how many captured members carried the
    /// key (the pieces beyond those are the split's extra members, step 5).
    accepted_splits: Vec<(String, Vec<Entity>, usize)>,
    /// Entities whose probe could not be computed, with the error.
    probe_failures: BTreeMap<Entity, RefError>,
    /// The step-1 result (empty for a rejected query).
    query_members: BTreeSet<Entity>,
    /// The step-1 hits of every captured named key (computed before any fallback runs): the
    /// fallback never takes them, and a split never counts them as its pieces.
    claimed: BTreeSet<Entity>,
    /// Captured named keys the scope still carries but the query's filters or picks dropped
    /// (one entry per captured member): removed, `REF_SET_CHANGED`.
    dropped: Vec<String>,
}

impl Builder<'_, '_> {
    /// The probe of an entity, or `None` (recorded) when it cannot be computed.
    fn probe(&mut self, e: Entity) -> Option<Probe> {
        match self.scope.probe(e) {
            Ok(p) => Some(p),
            Err(err) => {
                self.probe_failures.entry(e).or_insert(err);
                None
            }
        }
    }

    /// A candidate (§5.8), or `None` when its probe cannot be computed.
    fn candidate(
        &mut self,
        e: Entity,
        confidence: f64,
        reason: CandidateReason,
    ) -> Option<Candidate> {
        let probe = self.probe(e)?;
        Some(Candidate {
            key: self.scope.key(e).to_string(),
            name: self.scope.display_name(e),
            confidence,
            reason,
            probe,
            query: synthesize_query(e, self.scope, Some(&self.r.q)),
        })
    }

    /// Up to `MAX_CANDIDATES` candidates in the given order.
    fn candidates(
        &mut self,
        ranked: impl IntoIterator<Item = (Entity, f64, CandidateReason)>,
    ) -> Vec<Candidate> {
        let mut out = Vec::new();
        for (e, confidence, reason) in ranked {
            if out.len() >= MAX_CANDIDATES as usize {
                break;
            }
            if let Some(c) = self.candidate(e, confidence, reason) {
                out.push(c);
            }
        }
        out
    }

    /// Record a warning; at most one per code and captured key.
    fn warn(&mut self, w: Warning) {
        if let Some(k) = w.details.get("key")
            && self
                .warnings
                .iter()
                .any(|x| x.code == w.code && x.details.get("key") == Some(k))
        {
            return;
        }
        self.warnings.push(w);
    }

    fn unresolved(
        &mut self,
        key: &str,
        reason: UnresolvedReason,
        cands: Vec<Candidate>,
        code: &'static str,
    ) {
        let name = if key.is_empty() {
            String::new()
        } else {
            self.scope.display_of_key(key)
        };
        self.unresolved.push(Unresolved {
            key: key.to_string(),
            name,
            reason,
            candidates: cands,
        });
        if self.fail.is_none() {
            self.fail = Some(code);
        }
    }

    /// `FORGE_PROBE_FAILED` warnings for the entities left out of the report.
    fn probe_warnings(&mut self) {
        let failures: Vec<(Entity, RefError)> = self
            .probe_failures
            .iter()
            .map(|(e, err)| (*e, err.clone()))
            .collect();
        for (e, err) in failures {
            let key = self.scope.key(e).to_string();
            let w = warn(
                "FORGE_PROBE_FAILED",
                Severity::Warning,
                format!(
                    "{key} is left out of the report{}: {err}",
                    of_field(" of", &self.field)
                ),
                json!({ "field": self.field, "key": key, "message": err.to_string() }),
            );
            self.warn(w);
        }
    }
}

/// Resolve a reference in a field (see the module docs).
pub fn resolve_with(r: &Ref, scope: &Scope<'_>, spec: &FieldSpec) -> Resolution {
    let card = r.card.unwrap_or(spec.card);
    let mut b = Builder {
        scope,
        r,
        field: spec.field.clone(),
        warnings: Vec::new(),
        unresolved: Vec::new(),
        fail: None,
        split: false,
        repaired: false,
        rejected: false,
        accepted_splits: Vec::new(),
        probe_failures: BTreeMap::new(),
        query_members: BTreeSet::new(),
        claimed: BTreeSet::new(),
        dropped: Vec::new(),
    };
    // Step 1.
    let qs = match eval_query(&r.q, scope) {
        Ok(qs) => qs,
        Err(e) => return query_failed(&mut b, e),
    };
    b.query_members = qs.members.iter().map(|m| m.entity).collect();
    // A `tagged` source's own warnings (a repaired or split tag) are this reference's too.
    for w in &qs.warnings {
        let mut w = w.clone();
        if w.details.contains_key("field") {
            w.details.insert("field".into(), json!(b.field));
        }
        b.warn(w);
    }
    // The used set: entity → (via, status).
    let mut used: BTreeMap<Entity, (Via, MemberStatus)> = BTreeMap::new();
    let mut added: Vec<String> = Vec::new();
    let mut removed: Vec<String> = Vec::new();
    // Entities accounted for by captured named members (name-anchored).
    let mut consumed: BTreeSet<Entity> = BTreeSet::new();
    match &r.capture {
        None => {
            for m in &qs.members {
                let status = qs
                    .statuses
                    .get(&m.entity)
                    .copied()
                    .unwrap_or(MemberStatus::Exact);
                used.insert(m.entity, (m.via, status));
            }
        }
        Some(cap) => {
            // Step 3, one captured key at a time (in captured order).
            let mut groups: Vec<(&str, Vec<&CaptureMember>)> = Vec::new();
            for m in cap.members.iter().filter(|m| m.via == Via::Named) {
                match groups.iter_mut().find(|(k, _)| *k == m.key) {
                    Some((_, g)) => g.push(m),
                    None => groups.push((m.key.as_str(), vec![m])),
                }
            }
            let named_keys: BTreeSet<&str> = groups.iter().map(|(k, _)| *k).collect();
            // Every captured key's step-1 hits, before any fallback runs (so a missing key
            // never takes an entity another captured key designates, whatever the key order).
            b.claimed = groups
                .iter()
                .flat_map(|(k, _)| hits_of(scope, &qs, k))
                .map(|(e, _)| e)
                .collect();
            for (key, caps) in &groups {
                validate_key(&mut b, &qs, key, caps, card, &mut used, &mut consumed);
            }
            // Step 5: everything else of the result is used as the query says; broad (and
            // new named) differences are reported.
            let mut current: BTreeMap<String, usize> = BTreeMap::new();
            for m in &qs.members {
                if consumed.contains(&m.entity) {
                    continue;
                }
                used.entry(m.entity).or_insert((m.via, MemberStatus::Exact));
                let k = scope.key(m.entity);
                if m.via == Via::Broad || !named_keys.contains(k) {
                    *current.entry(k.to_string()).or_default() += 1;
                }
            }
            let mut captured: BTreeMap<String, usize> = BTreeMap::new();
            for m in cap.members.iter().filter(|m| m.via == Via::Broad) {
                *captured.entry(m.key.clone()).or_default() += 1;
            }
            for (k, n) in &current {
                let c = captured.get(k).copied().unwrap_or(0);
                added.extend(std::iter::repeat_n(k.clone(), n.saturating_sub(c)));
            }
            for (k, n) in &captured {
                let c = current.get(k).copied().unwrap_or(0);
                removed.extend(std::iter::repeat_n(k.clone(), n.saturating_sub(c)));
            }
            // Named members the query's own filters or picks dropped (step 3).
            removed.append(&mut b.dropped);
            removed.sort();
        }
    }
    // The final set, canonical.
    let order = scope.canonical(used.keys().copied().collect());
    let final_members: Vec<ResolvedMember> = order
        .iter()
        .map(|e| ResolvedMember {
            entity: *e,
            key: scope.key(*e).to_string(),
            via: used[e].0,
            status: used[e].1,
        })
        .collect();
    // Cardinality (step 5).
    let n = final_members.len();
    let mut card_details: Option<Value> = None;
    if b.fail.is_none() {
        match card {
            Cardinality::Word(CardWord::One) | Cardinality::Exactly(1) if n == 0 => {
                missing(&mut b, &qs);
            }
            Cardinality::Word(CardWord::One) | Cardinality::Exactly(1) if n >= 2 => {
                let code = if b.split {
                    "REF_SPLIT"
                } else {
                    "REF_AMBIGUOUS"
                };
                let reason = if b.split {
                    UnresolvedReason::Split
                } else {
                    UnresolvedReason::Tie
                };
                let cr = if b.split {
                    CandidateReason::SplitPiece
                } else {
                    CandidateReason::Tie
                };
                // Name-anchored members (those the capture validated) first.
                let mut ranked: Vec<Entity> = order.clone();
                ranked.sort_by_key(|e| !consumed.contains(e));
                let cands = b.candidates(ranked.iter().map(|e| (*e, 0.0, cr)));
                b.unresolved("", reason, cands, code);
            }
            Cardinality::Word(CardWord::Some) if n == 0 => missing(&mut b, &qs),
            Cardinality::Exactly(k) if n != k as usize => {
                // An `n` the pieces break (§5.7 step 3): only when the set without the splits'
                // extra pieces would have had `k` members; any other mismatch (members added or
                // removed by the query, a missing member) is `REF_CARDINALITY`.
                let extra: usize = b
                    .accepted_splits
                    .iter()
                    .map(|(_, pieces, captured)| pieces.len().saturating_sub(*captured))
                    .sum();
                if extra > 0 && n - extra == k as usize {
                    // The reference fails with the pieces of each split as candidates.
                    let splits = std::mem::take(&mut b.accepted_splits);
                    for (key, pieces, captured) in &splits {
                        if pieces.len() <= *captured {
                            continue;
                        }
                        let cands = b.candidates(
                            pieces
                                .iter()
                                .map(|p| (*p, 0.0, CandidateReason::SplitPiece)),
                        );
                        b.unresolved(key, UnresolvedReason::Split, cands, "REF_SPLIT");
                    }
                } else {
                    b.fail = Some("REF_CARDINALITY");
                    card_details = Some(json!({ "field": b.field, "expected": k, "found": n }));
                }
            }
            _ => {}
        }
    }
    // The report members, each with its probe; a used member without one fails the reference.
    let mut report_members: Vec<RefMember> = Vec::with_capacity(n);
    for m in &final_members {
        if let Some(probe) = b.probe(m.entity) {
            report_members.push(RefMember {
                key: m.key.clone(),
                name: scope.display_name(m.entity),
                via: m.via,
                status: m.status,
                probe,
            });
        }
    }
    let probe_error: Option<ReportError> = if b.fail.is_none() {
        final_members.iter().find_map(|m| {
            b.probe_failures.get(&m.entity).map(|err| ReportError {
                code: err.code().to_string(),
                message: format!(
                    "reference{}: no probe for member {}: {err}",
                    of_field("", &b.field),
                    m.key
                ),
                details: obj(json!({ "field": b.field, "key": m.key, "message": err.to_string() })),
            })
        })
    } else {
        None
    };
    let failed = b.fail.is_some() || probe_error.is_some();
    if failed {
        b.warnings
            .retain(|w| !matches!(w.code.as_str(), "REF_SPLIT_ACCEPTED" | "REF_REPAIRED"));
    }
    // Set changes (step 5) and the proposal.
    let mut proposal = None;
    if !failed && (!added.is_empty() || !removed.is_empty()) {
        let p = proposal_ref(r, scope, &final_members, false);
        b.warnings.push(warn(
            "REF_SET_CHANGED",
            Severity::Warning,
            format!(
                "{} member(s) added and {} removed since the reference was captured",
                added.len(),
                removed.len()
            ),
            json!({ "field": b.field, "added": added, "removed": removed, "proposal": p }),
        ));
        proposal = p;
    }
    if !failed && b.repaired {
        let p = proposal_ref(r, scope, &final_members, true);
        for w in b.warnings.iter_mut().filter(|w| w.code == "REF_REPAIRED") {
            w.details.insert("proposal".into(), json!(p));
        }
        proposal = p;
    }
    b.probe_warnings();
    let status = if failed {
        RefStatus::Failed
    } else if b.warnings.is_empty() {
        RefStatus::Exact
    } else {
        RefStatus::Accepted
    };
    let error = match (b.fail, probe_error) {
        (Some(code), _) => {
            let details = match (code, &card_details) {
                ("REF_CARDINALITY", Some(d)) => obj(d.clone()),
                _ => obj(json!({ "field": b.field, "unresolved": b.unresolved })),
            };
            Some(ReportError {
                code: code.to_string(),
                message: failure_message(code, &b.field, &b.unresolved, n),
                details,
            })
        }
        (None, Some(e)) => Some(e),
        (None, None) => None,
    };
    let report = RefReport {
        field: b.field.clone(),
        status,
        code: error.as_ref().map(|e| e.code.clone()),
        members: report_members,
        unresolved: b.unresolved.clone(),
        added: if failed { Vec::new() } else { added },
        removed: if failed { Vec::new() } else { removed },
        proposal: proposal.clone(),
    };
    Resolution {
        status,
        members: if failed { Vec::new() } else { final_members },
        report,
        warnings: b.warnings,
        error,
    }
}

/// `REF_MISSING` on an empty set; sources of suppressed features are reported with reason
/// `feature-suppressed` (§5.7 step 1) when no captured member explains the failure (a
/// reference without a capture has no member key: the entry names the feature).
fn missing(b: &mut Builder<'_, '_>, qs: &QuerySet) {
    if b.unresolved.is_empty() {
        for f in &qs.suppressed {
            let name = b.scope.table().name_of(f).to_string();
            b.unresolved.push(Unresolved {
                key: String::new(),
                name,
                reason: UnresolvedReason::FeatureSuppressed,
                candidates: Vec::new(),
            });
        }
    }
    b.fail = Some("REF_MISSING");
}

/// The query could not be evaluated (step 1): a static rejection, a failed dependency, a
/// failed tag, an unevaluable expression. Paths in the details become relative to the feature
/// (`<field>/q/…`). A query naming a curve the sketch no longer has is a rejection (§5.3), but
/// its capture still says what it designated: the fallback's candidates are listed so the
/// repair is one op (the reference keeps the static code). A failed tag passes its own
/// unresolved members and candidates through.
fn query_failed(b: &mut Builder<'_, '_>, e: RefError) -> Resolution {
    let code = e.code().to_string();
    let mut details = e.details();
    let mut unresolved = Vec::new();
    if let RefError::TagFailed { unresolved: u, .. } = &e {
        if details.contains_key("field") {
            details.insert("field".into(), json!(b.field));
        }
        unresolved = u.clone();
    } else {
        feature_relative(&mut details, &format!("{}/q", b.field));
    }
    if code == "QUERY_UNKNOWN_CURVE"
        && let Some(cap) = &b.r.capture
    {
        b.rejected = true;
        let (mut used, mut consumed) = (BTreeMap::new(), BTreeSet::new());
        for m in cap.members.iter().filter(|m| m.via == Via::Named) {
            fallback(b, m, &mut used, &mut consumed);
        }
        unresolved = std::mem::take(&mut b.unresolved);
    }
    b.probe_warnings();
    let error = ReportError {
        code: code.clone(),
        message: e.to_string(),
        details,
    };
    Resolution {
        status: RefStatus::Failed,
        members: Vec::new(),
        report: RefReport {
            field: b.field.clone(),
            status: RefStatus::Failed,
            code: Some(code),
            members: Vec::new(),
            unresolved,
            added: Vec::new(),
            removed: Vec::new(),
            proposal: None,
        },
        warnings: std::mem::take(&mut b.warnings),
        error: Some(error),
    }
}

/// Prefix the query-relative JSON pointers of an evaluation error's details (`path`,
/// `field`) with the reference's pointer in the feature.
fn feature_relative(details: &mut Map<String, Value>, prefix: &str) {
    for k in ["path", "field"] {
        if let Some(Value::String(s)) = details.get_mut(k)
            && (s.is_empty() || s.starts_with('/'))
        {
            *s = format!("{prefix}{s}");
        }
    }
}

/// `"{sep} {field}"`, or `""` for the field-less [`resolve`] (no doubled spaces in messages).
fn of_field(sep: &str, field: &str) -> String {
    if field.is_empty() {
        String::new()
    } else {
        format!("{sep} {field}")
    }
}

fn failure_message(code: &str, field: &str, unresolved: &[Unresolved], n: usize) -> String {
    let name = unresolved.first().map_or("", |u| u.name.as_str());
    // "reference", then the field and the member's name, each only when present.
    let subject: String = std::iter::once("reference")
        .chain([field, name].into_iter().filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join(" ");
    let cands = unresolved.first().map_or(0, |u| u.candidates.len());
    let reference = std::iter::once("reference")
        .chain(std::iter::once(field).filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join(" ");
    match code {
        "REF_MISSING" => format!("{subject} resolves to nothing"),
        "REF_AMBIGUOUS" => format!("{subject} is ambiguous ({cands} candidates)"),
        "REF_SPLIT" => format!("{subject} was split into pieces"),
        "REF_UNCERTAIN" => {
            format!("{subject} has no exact match; {cands} candidate(s) need confirmation")
        }
        "REF_CARDINALITY" => format!("{reference} resolves to {n} entities"),
        _ => format!("{reference} failed ({code})"),
    }
}

fn allows_many(card: Cardinality) -> bool {
    !matches!(
        card,
        Cardinality::Word(CardWord::One) | Cardinality::Exactly(1)
    )
}

/// The members of the step-1 result that carry `key` (`false`) or designate it through an
/// alias, nested keys included (`true`: merged).
fn hits_of(scope: &Scope<'_>, qs: &QuerySet, key: &str) -> Vec<(Entity, bool)> {
    let norm = scope.normalize_key(key);
    qs.members
        .iter()
        .filter_map(|x| {
            let k = scope.key(x.entity);
            if k == key {
                Some((x.entity, false))
            } else if norm != key && k == norm {
                Some((x.entity, true))
            } else {
                None
            }
        })
        .collect()
}

/// The entity of `ents` most like the captured member (comparison score; first on ties).
fn best_match(scope: &Scope<'_>, m: &CaptureMember, ents: &[Entity]) -> Entity {
    let s = scope.scale();
    let mut best = ents[0];
    let mut bs = f64::NEG_INFINITY;
    for e in ents {
        let sc = scope
            .fingerprint(*e)
            .map_or(-1.0, |f| compare(&m.geom, &f, s).score);
        if sc > bs {
            best = *e;
            bs = sc;
        }
    }
    best
}

/// A one-to-one matching of captured pieces to current pieces of one key (greedy by
/// comparison score, ties by captured then canonical order): `out[i]` is the index in `ents`
/// of captured piece `i`'s match, `None` when there are fewer pieces than captured.
fn assign(scope: &Scope<'_>, caps: &[&CaptureMember], ents: &[Entity]) -> Vec<Option<usize>> {
    let s = scope.scale();
    let fps: Vec<Option<forge_ir::v1::Fingerprint>> =
        ents.iter().map(|e| scope.fingerprint(*e).ok()).collect();
    let mut pairs: Vec<(f64, usize, usize)> = Vec::with_capacity(caps.len() * ents.len());
    for (i, m) in caps.iter().enumerate() {
        for (j, f) in fps.iter().enumerate() {
            let sc = f.as_ref().map_or(-1.0, |f| compare(&m.geom, f, s).score);
            pairs.push((sc, i, j));
        }
    }
    pairs.sort_by(|a, b| b.0.total_cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut out = vec![None; caps.len()];
    let mut taken = vec![false; ents.len()];
    for (_, i, j) in pairs {
        if out[i].is_none() && !taken[j] {
            out[i] = Some(j);
            taken[j] = true;
        }
    }
    out
}

/// Step 3 (and 4) for the captured named members carrying one key.
fn validate_key(
    b: &mut Builder<'_, '_>,
    qs: &QuerySet,
    key: &str,
    caps: &[&CaptureMember],
    card: Cardinality,
    used: &mut BTreeMap<Entity, (Via, MemberStatus)>,
    consumed: &mut BTreeSet<Entity>,
) {
    let scope = b.scope;
    let hits = hits_of(scope, qs, key);
    let ents: Vec<Entity> = hits.iter().map(|h| h.0).collect();
    // The scope still has entities carrying the key that the query's own filters or picks
    // dropped: the query is the intent (step 5), so the captured members it no longer
    // selects are removed, never brought back by the fallback (which would "repair" the key
    // into an entity that still carries it).
    let dropped = dropped_by_query(scope, qs, key, b.r.kind);
    if let [m] = caps {
        match hits.as_slice() {
            [] if dropped => dropped_member(b, qs, m, used, consumed),
            [] => fallback(b, m, used, consumed),
            [(e, via_alias)] => validate_one(b, m, *e, *via_alias, card, used, consumed),
            _ => {
                // Pieces sharing the key.
                let anchor = best_match(scope, m, &ents);
                split(b, m, anchor, ents, card, 1, used, consumed);
            }
        }
        return;
    }
    // Several captured members carry the key: an accepted split, re-captured.
    if ents.len() > caps.len() {
        // Split further.
        let anchor = best_match(scope, caps[0], &ents);
        split(b, caps[0], anchor, ents, card, caps.len(), used, consumed);
        return;
    }
    for (m, j) in caps.iter().zip(assign(scope, caps, &ents)) {
        match j {
            Some(j) => validate_one(b, m, ents[j], hits[j].1, card, used, consumed),
            None if dropped => dropped_member(b, qs, m, used, consumed),
            None => fallback(b, m, used, consumed),
        }
    }
}

/// `true` when the query chooses among the members of its sources (`extreme`, `largest`,
/// `smallest`, `filter`, `intersect`, `minus`, anywhere in it): the pieces of a split that
/// carry new keys are no members of its named sources, so they never went through that choice.
fn chooses(q: &Query) -> bool {
    match q {
        Query::Extreme { .. }
        | Query::Largest { .. }
        | Query::Smallest { .. }
        | Query::Filter { .. }
        | Query::Intersect { .. }
        | Query::Minus { .. } => true,
        Query::Between { a, b } => chooses(a) || chooses(b),
        Query::Faces { of }
        | Query::Edges { of }
        | Query::Vertices { of }
        | Query::Owner { of } => chooses(of),
        Query::Union { of } => of.iter().any(chooses),
        _ => false,
    }
}

/// A captured named member whose key the scope still carries but the query's own picks or
/// filters dropped: removed (`REF_SET_CHANGED`, the query is the intent) — unless the entity
/// carrying the key was split into pieces with new keys (more same-carrier neighbours, pieces
/// inside the captured box): the query then chose without those pieces (they are no members
/// of its named sources), so its choice cannot be trusted and the split is loud (`REF_SPLIT`
/// whatever the card, the pieces as candidates).
fn dropped_member(
    b: &mut Builder<'_, '_>,
    qs: &QuerySet,
    m: &CaptureMember,
    used: &mut BTreeMap<Entity, (Via, MemberStatus)>,
    consumed: &mut BTreeSet<Entity>,
) {
    let scope = b.scope;
    let norm = scope.normalize_key(&m.key);
    let in_result = |e: &Entity| qs.members.iter().any(|x| x.entity == *e);
    let carriers: BTreeSet<Entity> = [m.key.as_str(), norm.as_str()]
        .into_iter()
        .flat_map(|k| scope.with_key(k).iter().copied())
        .filter(|x| x.kind() == b.r.kind && !in_result(x))
        .collect();
    for x in scope.canonical(carriers.into_iter().collect()) {
        if scope.neighbors(x) > m.geom.neighbors {
            let (pieces, _) = new_key_pieces(b, m, x);
            if pieces.len() >= 2 {
                split(b, m, x, pieces, Cardinality::ONE, 1, used, consumed);
                return;
            }
        }
    }
    b.dropped.push(m.key.clone());
}

/// `true` when the scope has an entity of `kind` carrying `key` (or the key it is an alias
/// of) that the step-1 result does not contain: the query's filters or picks dropped it.
fn dropped_by_query(scope: &Scope<'_>, qs: &QuerySet, key: &str, kind: EntityKind) -> bool {
    let norm = scope.normalize_key(key);
    let in_result = |e: &Entity| qs.members.iter().any(|m| m.entity == *e);
    [key, norm.as_str()].into_iter().any(|k| {
        scope
            .with_key(k)
            .iter()
            .any(|e| e.kind() == kind && !in_result(e))
    })
}

/// Step 3 for one captured named member and the one entity carrying its key.
#[allow(clippy::too_many_arguments)]
fn validate_one(
    b: &mut Builder<'_, '_>,
    m: &CaptureMember,
    e: Entity,
    via_alias: bool,
    card: Cardinality,
    used: &mut BTreeMap<Entity, (Via, MemberStatus)>,
    consumed: &mut BTreeSet<Entity>,
) {
    let scope = b.scope;
    let field = b.field.clone();
    let now_n = scope.neighbors(e);
    if now_n > m.geom.neighbors {
        // More same-carrier neighbours (§5.7 step 3: a split). The pieces are the entity and
        // the same-carrier entities inside the captured box — also when the entity is
        // geometry-identical to its capture: within the comparison's tolerances a sliver piece
        // inside the box is still a piece, and dropping it would be silent.
        let (pieces, query_dropped) = new_key_pieces(b, m, e);
        if pieces.len() >= 2 {
            // Pieces with new keys are no members of the query's named sources: a query that
            // chooses among its sources' members (a pick, a filter, a set difference; or one
            // that dropped same-key pieces) never saw them, so which of them it would keep is
            // unknown and the split is never used (`REF_SPLIT` whatever the card). A query
            // that only names and unites takes every piece (§5.7 step 3), card permitting.
            let card = if query_dropped > 0 || chooses(&b.r.q) {
                Cardinality::ONE
            } else {
                card
            };
            split(b, m, e, pieces, card, 1, used, consumed);
            return;
        }
        if query_dropped > 0 {
            // Split into pieces that share the key, and the query's own picks or filters kept
            // this one (the query is the intent): the pieces it selects, card permitting.
            split(b, m, e, pieces, card, 1, used, consumed);
            return;
        }
        let identical = scope
            .fingerprint(e)
            .is_ok_and(|f| compare(&m.geom, &f, scope.scale()).identical);
        if !identical {
            // The entity changed and gained a same-carrier neighbour, but none lies inside the
            // captured box: the capture predates other edits (§0.6: exact commits do not
            // refresh it), so its box cannot tell the pieces. A split that cannot be delimited
            // is never used, whatever the card: `REF_SPLIT`, with the entity and its unclaimed
            // same-carrier neighbours as candidates (never an entity carrying the captured key
            // that the query dropped).
            let mut pieces = same_carrier_pieces(scope, e);
            pieces.retain(|p| *p == e || (!b.claimed.contains(p) && !dropped_piece(b, m, *p)));
            split(b, m, e, pieces, Cardinality::ONE, 1, used, consumed);
            return;
        }
        // Geometry-identical, and no other same-carrier entity inside the captured box: the
        // new neighbour lies outside it (a collinear segment added next to an unchanged
        // face), no piece of the member: exact below.
    }
    if let Some(sib) = junction_swap(scope, e, m) {
        // The junction qualifier now designates the other junction edge of the curve pair
        // (a reversed curve swaps `@c.start`/`@c.end`). Never rebind silently: both are
        // candidates at confidence 0, the one at the captured place first (reason
        // `identical` only when it is geometry-identical to the capture, else `tie`), then
        // the one the name now designates (`tie`: the two junctions tie for the name).
        let sib_reason = if scope
            .fingerprint(sib)
            .is_ok_and(|f| compare(&m.geom, &f, scope.scale()).identical)
        {
            CandidateReason::Identical
        } else {
            CandidateReason::Tie
        };
        let cands = b.candidates([(sib, 0.0, sib_reason), (e, 0.0, CandidateReason::Tie)]);
        b.unresolved(&m.key, UnresolvedReason::Tie, cands, "REF_AMBIGUOUS");
        consumed.insert(e);
        return;
    }
    let (now_t, _) = scope.carrier(e);
    let mut status = MemberStatus::Exact;
    if via_alias {
        status = MemberStatus::Merged;
        b.warn(warn(
            "REF_MERGED",
            Severity::Info,
            format!("{} was merged into {}", m.key, scope.key(e)),
            json!({ "field": field, "key": m.key, "into": scope.key(e) }),
        ));
    }
    if now_t != m.geom.geom_type {
        status = MemberStatus::KindChanged;
        let (was, now) = (
            type_name(&json!(m.geom.geom_type)),
            type_name(&json!(now_t)),
        );
        b.warn(warn(
            "REF_KIND_CHANGED",
            Severity::Warning,
            format!("{} is now a {now}, it was a {was}", m.key),
            json!({ "field": field, "key": m.key, "was": was, "now": now }),
        ));
    } else if now_n < m.geom.neighbors {
        // Also after a merge (the table of §5.7 step 3 has no exemption).
        status = MemberStatus::NeighborhoodChanged;
        b.warn(warn(
            "REF_NEIGHBORHOOD_CHANGED",
            Severity::Warning,
            format!(
                "{} has {now_n} same-carrier neighbour(s), it had {}",
                m.key, m.geom.neighbors
            ),
            json!({ "field": field, "key": m.key, "was": m.geom.neighbors, "now": now_n }),
        ));
    }
    // Two captured members never collapse silently into one entity: an entity another
    // captured member took by repair or as a split piece is a collision (the step-1 hits are
    // excluded from both, so this is a defence in depth). Merges (aliases) are not collisions.
    if let Some((_, prev)) = used.get(&e)
        && matches!(prev, MemberStatus::Repaired | MemberStatus::Split)
    {
        let cands = b.candidates([(e, 0.0, CandidateReason::Tie)]);
        b.unresolved(&m.key, UnresolvedReason::Tie, cands, "REF_AMBIGUOUS");
        return;
    }
    used.insert(e, (Via::Named, status));
    consumed.insert(e);
}

/// `true` for a junction key: an edge or vertex qualified `@c.start` / `@c.end` (§5.2).
fn is_junction_key(p: &forge_core::topo::KeyParts) -> bool {
    matches!(p.label.as_str(), "edge" | "vertex")
        && p.qualifier
            .as_deref()
            .and_then(|q| q.rsplit_once('.'))
            .is_some_and(|(c, end)| !c.is_empty() && matches!(end, "start" | "end"))
}

/// Tolerance on the body-relative centroid (`local`, coordinates normalised to the body's box,
/// so dimensionless) under which an entity keeps its captured place in its body
/// ([`junction_swap`]). A rigid move or a distance edit along the junction leaves `local`
/// unchanged up to rounding (≈1e-15); a swap moves it by the junction gap over the body's
/// extent. It is 100× tighter than the relative part of the comparison's box padding
/// ([`BOX_PAD_REL`](crate::geom::BOX_PAD_REL)) on purpose: a stricter test only makes more swaps
/// ambiguous (reported), never exact.
const LOCAL_PLACE_TOL: f64 = 1e-6;

/// Where a fingerprint lies relative to a captured one (for [`junction_swap`]).
#[derive(Clone, Copy, Debug)]
struct Place {
    /// World distance of the boxes (sum of the two corner distances).
    world: f64,
    /// The same after moving the captured box with the body's box centre (the body moved, or
    /// grew, since the capture).
    moved: f64,
    /// The centroid relative to the body's box (`local`) is the captured one.
    local: bool,
}

impl Place {
    fn of(cap: &Fingerprint, f: &Fingerprint) -> Place {
        let d = |a: [f64; 3], b: [f64; 3], t: [f64; 3]| {
            (0..3)
                .map(|i| (a[i] - (b[i] + t[i])).powi(2))
                .sum::<f64>()
                .sqrt()
        };
        let zero = [0.0; 3];
        let shift: [f64; 3] = std::array::from_fn(|i| f.body_center[i] - cap.body_center[i]);
        Place {
            world: d(f.bbox[0], cap.bbox[0], zero) + d(f.bbox[1], cap.bbox[1], zero),
            moved: d(f.bbox[0], cap.bbox[0], shift) + d(f.bbox[1], cap.bbox[1], shift),
            local: (0..3).all(|i| (f.local[i] - cap.local[i]).abs() <= LOCAL_PLACE_TOL),
        }
    }
    fn gap(&self) -> f64 {
        self.world.min(self.moved)
    }
}

/// A **junction** key (`…edge:{F/side:a|F/side:b}@c.end`, its vertices) names one of the
/// edges swept from the sketch vertices where the same two curves meet (the two edges of a
/// "D"). Reversing a curve swaps the `c.start`/`c.end` qualifiers between them without moving
/// anything. Captures are not refreshed on exact commits (§0.6), so the capture may predate
/// other edits (a distance edit, a move): the swap is recognised by *place*, comparing the
/// entity now carrying the key with its sibling junctions of the same curve pair ([`Place`]):
///
/// - the key's entity moved with the body (its box is the captured box moved with the body's
///   box centre, and its body-relative centroid is the captured one: a rigid motion, e.g. the
///   loop moved by exactly the gap between its two junctions): no swap, it stays exact
///   (§5.7 step 3);
/// - it stayed at the captured world place while the body's box moved: a swap only if a
///   sibling moved with the body onto the captured place (a rigid move plus a reversal);
/// - otherwise the sibling nearest the captured place (the smaller of the world and moved
///   distances) is the swap if it is strictly nearer than the key's entity; a tie is broken
///   by the body-relative centroid, and is a swap (ambiguous) unless only the key's entity
///   has the captured body-relative centroid.
///
/// Only junction qualifiers are checked. Other qualified families (caps `@m`, hole faces
/// `@p`, pattern copies `@i`) are never compared with their siblings: a parameter edit that
/// moves copy `@1` to where `@2` was keeps `@1` exact.
fn junction_swap(scope: &Scope<'_>, e: Entity, m: &CaptureMember) -> Option<Entity> {
    let p = forge_core::topo::parse_key(&m.key).ok()?;
    if !is_junction_key(&p) {
        return None;
    }
    let s = scope.scale();
    let fe = scope.fingerprint(e).ok()?;
    // (No shortcut for a geometry-identical entity: after a rigid move by the junction gap
    // plus a reversal, the name lands on the captured world place while the captured
    // junction moved with the body.)
    // Twice the box padding of the comparison (two corners), at the comparison's scale.
    let tol = 2.0 * box_pad(comparison_scale(&m.geom, s));
    let pe = Place::of(&m.geom, &fe);
    if pe.moved <= tol && pe.local {
        return None;
    }
    let base = (&p.feature, &p.label, &p.arg);
    let siblings: Vec<Entity> = scope
        .entities(e.kind())
        .into_iter()
        .filter(|x| *x != e)
        .filter(|x| {
            forge_core::topo::parse_key(scope.key(*x)).is_ok_and(|q| {
                (&q.feature, &q.label, &q.arg) == base
                    && q.qualifier != p.qualifier
                    && is_junction_key(&q)
            })
        })
        .collect();
    let places: Vec<(Entity, Place)> = scope
        .canonical(siblings)
        .into_iter()
        .filter_map(|x| Some((x, Place::of(&m.geom, &scope.fingerprint(x).ok()?))))
        .collect();
    if pe.world <= tol {
        // At the captured world place while the body's box moved: fine, unless a sibling
        // moved with the body onto the captured place.
        return places
            .iter()
            .find(|(_, q)| q.moved <= tol && q.local)
            .map(|(x, _)| *x);
    }
    // At neither place: the nearest sibling (canonical order on ties).
    let (x, q) = places
        .iter()
        .copied()
        .min_by(|a, b| a.1.gap().total_cmp(&b.1.gap()))?;
    let (gs, ge) = (q.gap(), pe.gap());
    if gs + tol < ge {
        return Some(x);
    }
    if (gs - ge).abs() <= tol && (q.local || !pe.local) {
        // Equally near: ambiguous, unless only the key's entity keeps the captured
        // body-relative place.
        return Some(x);
    }
    None
}

fn type_name(v: &Value) -> String {
    v.as_str().unwrap_or("other").to_string()
}

/// The same-carrier component of `e` in its body (faces across edges, edges through vertices),
/// `e` first.
fn same_carrier_pieces(scope: &Scope<'_>, e: Entity) -> Vec<Entity> {
    let (_, c) = scope.carrier(e);
    let s = scope.scale();
    let mut out = vec![e];
    let mut i = 0;
    while i < out.len() {
        let cur = out[i];
        i += 1;
        let next: Vec<Entity> = match cur.id {
            EntityId::Face(f) => {
                let body = scope.body(cur);
                let mut v = Vec::new();
                for ed in body.face_edges(f) {
                    for g in body.edge_faces(ed) {
                        if g != f {
                            v.push(Entity {
                                body: cur.body,
                                id: EntityId::Face(g),
                            });
                        }
                    }
                }
                v
            }
            EntityId::Edge(x) => scope
                .edge_neighbors(cur.body, x)
                .into_iter()
                .map(|g| Entity {
                    body: cur.body,
                    id: EntityId::Edge(g),
                })
                .collect(),
            _ => Vec::new(),
        };
        for n in next {
            if !out.contains(&n) && crate::geom::same_support(&c, &scope.carrier(n).1, s) {
                out.push(n);
            }
        }
    }
    out
}

/// `true` for an entity that carries the captured key `m.key` (or the key it is now an alias
/// of) but is not in the step-1 result: the query's own picks or filters dropped it.
fn dropped_piece(b: &Builder<'_, '_>, m: &CaptureMember, e: Entity) -> bool {
    let k = b.scope.key(e);
    (k == m.key || k == b.scope.normalize_key(&m.key)) && !b.query_members.contains(&e)
}

/// The pieces of a captured member whose key now has more same-carrier neighbours: `anchor`
/// (the entity carrying the key) first, then the same-carrier entities connected to it that
/// lie on the captured carrier inside the captured box; and how many such entities carry the
/// captured key but were dropped by the query's own picks or filters (never pieces: the query
/// is the intent). Entities another captured key designates in the step-1 result are never
/// pieces of this one.
fn new_key_pieces(b: &Builder<'_, '_>, m: &CaptureMember, anchor: Entity) -> (Vec<Entity>, usize) {
    let scope = b.scope;
    let mut pieces = same_carrier_pieces(scope, anchor);
    pieces.retain(|p| {
        *p == anchor
            || (!b.claimed.contains(p)
                && scope.fingerprint(*p).is_ok_and(|f| {
                    let c = compare(&m.geom, &f, scope.scale());
                    c.same_support && c.contained
                }))
    });
    let before = pieces.len();
    pieces.retain(|p| *p == anchor || !dropped_piece(b, m, *p));
    let dropped = before - pieces.len();
    (pieces, dropped)
}

/// A split captured member: all pieces if the cardinality allows it (`REF_SPLIT_ACCEPTED`,
/// its `pieces` in canonical order, §5.4; an integer card the pieces break fails at step 5),
/// else `REF_SPLIT` with the pieces as candidates: the name-anchored piece first, then by
/// size (then canonical order). `captured` is the number of captured members carrying the key.
/// Pieces that carry the key but that the query's own picks or filters dropped are not among
/// `pieces` (they are counted in the message only).
#[allow(clippy::too_many_arguments)]
fn split(
    b: &mut Builder<'_, '_>,
    m: &CaptureMember,
    anchor: Entity,
    mut pieces: Vec<Entity>,
    card: Cardinality,
    captured: usize,
    used: &mut BTreeMap<Entity, (Via, MemberStatus)>,
    consumed: &mut BTreeSet<Entity>,
) {
    let scope = b.scope;
    let canon = scope.canonical(pieces.clone());
    let pos = |e: &Entity| canon.iter().position(|x| x == e).unwrap_or(usize::MAX);
    let size = |e: &Entity| scope.props(*e).map_or(0.0, |p| p.size);
    pieces.sort_by(|x, y| {
        (*y == anchor)
            .cmp(&(*x == anchor))
            .then_with(|| size(y).total_cmp(&size(x)))
            .then_with(|| pos(x).cmp(&pos(y)))
    });
    pieces.dedup();
    b.split = true;
    for p in &pieces {
        consumed.insert(*p);
    }
    if allows_many(card) {
        // The report lists the pieces in canonical order, like the reference's members.
        let mut names: Vec<Value> = Vec::with_capacity(pieces.len());
        for p in &canon {
            if let Some(probe) = b.probe(*p) {
                names.push(
                    json!({ "key": scope.key(*p), "name": scope.display_name(*p), "probe": probe }),
                );
            }
        }
        for p in &pieces {
            used.insert(*p, (Via::Named, MemberStatus::Split));
        }
        b.accepted_splits
            .push((m.key.clone(), pieces.clone(), captured));
        // Pieces carrying the key that the query dropped (its picks or filters chose).
        let norm = scope.normalize_key(&m.key);
        let dropped: BTreeSet<Entity> = [m.key.as_str(), norm.as_str()]
            .into_iter()
            .flat_map(|k| scope.with_key(k).iter().copied())
            .filter(|x| x.kind() == b.r.kind && !pieces.contains(x) && dropped_piece(b, m, *x))
            .collect();
        let message = if dropped.is_empty() {
            format!(
                "{} was split into {} pieces; all are used",
                m.key,
                pieces.len()
            )
        } else {
            format!(
                "{} was split into {} pieces; the {} the query selects are used",
                m.key,
                pieces.len() + dropped.len(),
                pieces.len()
            )
        };
        b.warn(warn(
            "REF_SPLIT_ACCEPTED",
            Severity::Info,
            message,
            json!({ "field": b.field, "key": m.key, "pieces": names }),
        ));
    } else {
        let cands = b.candidates(
            pieces
                .iter()
                .map(|p| (*p, 0.0, CandidateReason::SplitPiece)),
        );
        b.unresolved(&m.key, UnresolvedReason::Split, cands, "REF_SPLIT");
    }
}

/// Step 4: the geometric fallback for a captured named member whose key is gone.
fn fallback(
    b: &mut Builder<'_, '_>,
    m: &CaptureMember,
    used: &mut BTreeMap<Entity, (Via, MemberStatus)>,
    consumed: &mut BTreeSet<Entity>,
) {
    let scope = b.scope;
    let kind = b.r.kind;
    let s = scope.scale();
    let creator = |k: &str| forge_core::topo::parse_key(k).ok().map(|p| p.feature);
    let own = creator(&m.key);
    // A member of a suppressed feature went away with it (§5.7 step 1): no entity of another
    // feature is it, however coincident (a tray's walls sit on its suppressed floor).
    if let Some(f) = &own
        && matches!(
            scope.table().get(f).map(|x| &x.status),
            Some(FeatureStatus::Suppressed)
        )
    {
        b.unresolved(
            &m.key,
            UnresolvedReason::FeatureSuppressed,
            Vec::new(),
            "REF_MISSING",
        );
        return;
    }
    // Candidates: every entity of the member's kind and captured type (a hard filter, §5.7
    // step 4), scored. Only the member's own feature's entities can be used without
    // confirmation (the scope spike 02 validated): coincident geometry of another feature is a
    // different design entity, so those are candidates only.
    let mut comps: Vec<(Entity, Comparison, f64, bool)> = Vec::new();
    for e in scope.canonical(scope.entities(kind)) {
        if scope.carrier(e).0 != m.geom.geom_type {
            continue;
        }
        let Ok(f) = scope.fingerprint(e) else {
            continue;
        };
        // A captured key that does not parse (a hand-edited or mis-migrated capture) names no
        // feature: every entity is foreign, a candidate only.
        let mine = own.is_some() && creator(scope.key(e)) == own;
        comps.push((e, compare(&m.geom, &f, s), f.size, mine));
    }
    // Every geometry-identical entity, own feature's first (each group in canonical order),
    // except those another captured member accounts for: taken by step 3 or 4 (`consumed`),
    // or designated by its key in the step-1 result (`claimed`, whatever the key order).
    let taken: BTreeSet<Entity> = consumed.union(&b.claimed).copied().collect();
    let free = |e: &Entity| !taken.contains(e);
    // Scored candidates: the free ones by score, then those another captured member accounts
    // for (listed, never first; stable: canonical order breaks ties).
    let mut ranked: Vec<(Entity, f64)> = comps.iter().map(|(e, c, ..)| (*e, c.score)).collect();
    ranked.sort_by(|a, b| {
        free(&b.0)
            .cmp(&free(&a.0))
            .then_with(|| b.1.total_cmp(&a.1))
    });
    let own_identical: Vec<Entity> = comps
        .iter()
        .filter(|(e, c, _, mine)| *mine && c.identical && free(e))
        .map(|(e, ..)| *e)
        .collect();
    // Geometry-identical entities of other features are never used (see the crate docs).
    // Those the query itself still returns (an edge a boolean re-keyed `G/edge:{…}` is still
    // `between` the same faces) are the strongest candidates; the others are coincident
    // geometry of other bodies (a tray's walls on its floor), offered only after the member's
    // own split pieces.
    let (foreign_in_query, foreign_elsewhere): (Vec<Entity>, Vec<Entity>) = comps
        .iter()
        .filter(|(e, c, _, mine)| !*mine && c.identical && free(e))
        .map(|(e, ..)| *e)
        .partition(|e| b.query_members.contains(e));
    let n_identical = own_identical.len() + foreign_in_query.len() + foreign_elsewhere.len();
    if n_identical >= 2 {
        // Several geometry-identical entities (§5.7 step 4 row 2), own and foreign alike: an
        // own entity never wins over a coincident one of another feature.
        let all: Vec<Entity> = own_identical
            .iter()
            .chain(&foreign_in_query)
            .chain(&foreign_elsewhere)
            .copied()
            .collect();
        let cands = b.candidates(all.iter().map(|e| (*e, 0.0, CandidateReason::Identical)));
        b.unresolved(&m.key, UnresolvedReason::Tie, cands, "REF_AMBIGUOUS");
        return;
    }
    if let [one] = own_identical.as_slice() {
        let one = *one;
        if b.rejected {
            // Not usable (the query is rejected): the identical entity is the candidate.
            let c = b.candidates([(one, IDENTICAL_MATCH_CONFIDENCE, CandidateReason::Identical)]);
            b.unresolved(&m.key, UnresolvedReason::NameNotFound, c, "REF_UNCERTAIN");
            return;
        }
        b.repaired = true;
        b.warn(warn(
            "REF_REPAIRED",
            Severity::Info,
            format!(
                "{} is gone; {} has identical geometry and is used (confidence {IDENTICAL_MATCH_CONFIDENCE})",
                m.key,
                scope.key(one)
            ),
            json!({ "field": b.field, "key": m.key, "into": scope.key(one) }),
        ));
        used.insert(one, (Via::Named, MemberStatus::Repaired));
        consumed.insert(one);
        return;
    }
    // At most one geometry-identical entity is left, of another feature: a candidate only.
    if foreign_identical(b, m, &foreign_in_query) {
        return;
    }
    // An edge whose two captured faces still exist (by key or alias) but no longer meet is
    // gone.
    if kind == EntityKind::Edge
        && let Some([fa, fb]) = &m.faces
    {
        let faces = |k: &str| -> Vec<Entity> {
            scope
                .with_key(&scope.normalize_key(k))
                .iter()
                .copied()
                .filter(|e| e.kind() == EntityKind::Face)
                .collect()
        };
        let (a, bb) = (faces(fa), faces(fb));
        if !a.is_empty() && !bb.is_empty() {
            let meet = scope.entities(EntityKind::Edge).into_iter().any(|e| {
                let fs = faces_of(scope, e);
                fs.iter().any(|x| a.contains(x)) && fs.iter().any(|x| bb.contains(x))
            });
            if !meet {
                b.unresolved(
                    &m.key,
                    UnresolvedReason::FacesNoLongerMeet,
                    Vec::new(),
                    "REF_MISSING",
                );
                return;
            }
        }
    }
    // Pieces of the member's own feature on the captured carrier inside the captured box (a
    // split with new keys; coincident entities of other features are not pieces of it).
    let mut pieces: Vec<(Entity, f64)> = comps
        .iter()
        .filter(|(e, c, _, mine)| *mine && c.same_support && c.contained && free(e))
        .map(|(e, _, size, _)| (*e, *size))
        .collect();
    pieces.sort_by(|a, b| b.1.total_cmp(&a.1));
    let capped = |x: f64| x.min(MAX_DISAMBIGUATION_CONFIDENCE);
    if pieces.len() >= 2 {
        let cands = b.candidates(
            pieces
                .iter()
                .map(|(e, _)| (*e, 0.0, CandidateReason::SplitPiece)),
        );
        b.split = true;
        b.unresolved(&m.key, UnresolvedReason::Split, cands, "REF_SPLIT");
        return;
    }
    if let [(piece, _)] = pieces.as_slice() {
        let piece = *piece;
        let others: Vec<(Entity, f64, CandidateReason)> = ranked
            .iter()
            .filter(|(e, sc)| *e != piece && *sc >= MIN_PLAUSIBLE)
            .map(|(e, sc)| (*e, capped(*sc).min(0.7), CandidateReason::Plausible))
            .collect();
        let cands =
            b.candidates(std::iter::once((piece, 0.7, CandidateReason::SplitPiece)).chain(others));
        b.unresolved(
            &m.key,
            UnresolvedReason::NameNotFound,
            cands,
            "REF_UNCERTAIN",
        );
        return;
    }
    if foreign_identical(b, m, &foreign_elsewhere) {
        return;
    }
    // The best free candidate decides when it is plausible (an entity another captured member
    // accounts for then never makes a tie; it is still listed after the free ones). Otherwise
    // the best of the others is the (never used) lead, so a member collapsed into another
    // member's entity is still offered.
    let lead_free = ranked
        .first()
        .is_some_and(|x| free(&x.0) && x.1 >= MIN_PLAUSIBLE);
    let best = if lead_free {
        ranked[0].1
    } else {
        ranked
            .iter()
            .filter(|x| !free(&x.0))
            .map(|x| x.1)
            .next()
            .unwrap_or(0.0)
    };
    if best >= MIN_PLAUSIBLE {
        let tied: Vec<Entity> = ranked
            .iter()
            .filter(|(e, sc)| free(e) == lead_free && *sc >= best * (1.0 - TIE_MARGIN))
            .map(|(e, _)| *e)
            .collect();
        if tied.len() > 1 {
            let cands = b.candidates(tied.iter().map(|e| (*e, 0.0, CandidateReason::Tie)));
            b.unresolved(&m.key, UnresolvedReason::Tie, cands, "REF_AMBIGUOUS");
        } else {
            let plausible: Vec<(Entity, f64, CandidateReason)> = ranked
                .iter()
                .filter(|(_, sc)| *sc >= MIN_PLAUSIBLE)
                .map(|(e, sc)| (*e, capped(*sc), CandidateReason::Plausible))
                .collect();
            let cands = b.candidates(plausible);
            b.unresolved(
                &m.key,
                UnresolvedReason::NameNotFound,
                cands,
                "REF_UNCERTAIN",
            );
        }
        return;
    }
    b.unresolved(
        &m.key,
        UnresolvedReason::NoPlausibleMatch,
        Vec::new(),
        "REF_MISSING",
    );
}

/// The unique geometry-identical entity of another feature as the member's candidate (never
/// used): `REF_UNCERTAIN` at `MAX_DISAMBIGUATION_CONFIDENCE`. Returns `false` when there is
/// none (several geometry-identical entities are `REF_AMBIGUOUS` before this is reached).
fn foreign_identical(b: &mut Builder<'_, '_>, m: &CaptureMember, es: &[Entity]) -> bool {
    debug_assert!(es.len() <= 1, "several identical entities are ambiguous");
    let [one] = es else {
        return false;
    };
    let c = b.candidates([(
        *one,
        MAX_DISAMBIGUATION_CONFIDENCE,
        CandidateReason::Identical,
    )]);
    b.unresolved(&m.key, UnresolvedReason::NameNotFound, c, "REF_UNCERTAIN");
    true
}

/// A fresh capture of a resolved set (the command layer's `captureRef`, §0.6, §5.6).
pub fn capture(members: &[ResolvedMember], scope: &Scope<'_>) -> Result<Capture, RefError> {
    let mut out = Vec::with_capacity(members.len());
    for m in members {
        let faces = if m.entity.kind() == EntityKind::Edge {
            let mut ks: Vec<String> = faces_of(scope, m.entity)
                .iter()
                .map(|f| scope.key(*f).to_string())
                .collect();
            ks.sort();
            match ks.as_slice() {
                [a, b] => Some([a.clone(), b.clone()]),
                _ => None,
            }
        } else {
            None
        };
        out.push(CaptureMember {
            key: m.key.clone(),
            via: m.via,
            faces,
            geom: scope.fingerprint(m.entity)?,
        });
    }
    Ok(Capture { members: out })
}

/// The rewritten reference of `REF_REPAIRED` / `REF_SET_CHANGED` (§5.8): for a set change the
/// same query (it is the intent) with a fresh capture; for a repair, the query rewritten to
/// select the repaired set (see [`rewrite_for`]) with a fresh capture.
fn proposal_ref(
    r: &Ref,
    scope: &Scope<'_>,
    members: &[ResolvedMember],
    repaired: bool,
) -> Option<Ref> {
    let q = if repaired {
        rewrite_for(r, scope, members)
    } else {
        r.q.clone()
    };
    let cap = capture(members, scope).ok()?;
    Some(Ref {
        kind: r.kind,
        q,
        card: r.card,
        capture: Some(cap),
    })
}

/// A query selecting a repaired set: the synthesized query of the single member; otherwise
/// the original query with every named leaf that now yields nothing replaced by the
/// synthesized queries of the repaired members (as a union); the original query when no
/// rewrite verifies.
fn rewrite_for(r: &Ref, scope: &Scope<'_>, members: &[ResolvedMember]) -> Query {
    let want: BTreeSet<Entity> = members.iter().map(|m| m.entity).collect();
    let selects = |q: &Query| {
        eval_query(q, scope)
            .is_ok_and(|s| s.entities().into_iter().collect::<BTreeSet<_>>() == want)
    };
    if let [one] = members
        && let Some(q) = synthesize_query(one.entity, scope, Some(&r.q))
    {
        return q;
    }
    let repaired: Vec<Query> = members
        .iter()
        .filter(|m| m.status == MemberStatus::Repaired)
        .filter_map(|m| synthesize_query(m.entity, scope, None))
        .collect();
    if repaired.is_empty() {
        return r.q.clone();
    }
    let patch = if let [one] = repaired.as_slice() {
        one.clone()
    } else {
        Query::Union { of: repaired }
    };
    let rewritten = replace_empty_leaves(&r.q, scope, &patch);
    if selects(&rewritten) {
        return rewritten;
    }
    let union = Query::Union {
        of: vec![r.q.clone(), patch],
    };
    if selects(&union) { union } else { r.q.clone() }
}

fn replace_empty_leaves(q: &Query, scope: &Scope<'_>, patch: &Query) -> Query {
    let named_leaf = matches!(
        q,
        Query::Body { .. }
            | Query::Cap { .. }
            | Query::Endcap { .. }
            | Query::Side { .. }
            | Query::EdgeAt { .. }
            | Query::HoleFace { .. }
    );
    let kind = crate::typing::static_kind(q, scope.table()).ok();
    let patch_kind = crate::typing::static_kind(patch, scope.table()).ok();
    if named_leaf && kind == patch_kind && eval_query(q, scope).is_ok_and(|s| s.members.is_empty())
    {
        return patch.clone();
    }
    let rec = |x: &Query| Box::new(replace_empty_leaves(x, scope, patch));
    match q {
        Query::Between { a, b } => Query::Between {
            a: rec(a),
            b: rec(b),
        },
        Query::Faces { of } => Query::Faces { of: rec(of) },
        Query::Edges { of } => Query::Edges { of: rec(of) },
        Query::Vertices { of } => Query::Vertices { of: rec(of) },
        Query::Owner { of } => Query::Owner { of: rec(of) },
        Query::Union { of } => Query::Union {
            of: of
                .iter()
                .map(|x| replace_empty_leaves(x, scope, patch))
                .collect(),
        },
        Query::Intersect { of } => Query::Intersect {
            of: of
                .iter()
                .map(|x| replace_empty_leaves(x, scope, patch))
                .collect(),
        },
        Query::Minus { a, b } => Query::Minus {
            a: rec(a),
            b: rec(b),
        },
        Query::Filter { of, pred } => Query::Filter {
            of: rec(of),
            pred: pred.clone(),
        },
        Query::Extreme { of, dir, which } => Query::Extreme {
            of: rec(of),
            dir: dir.clone(),
            which: *which,
        },
        Query::Largest { of } => Query::Largest { of: rec(of) },
        Query::Smallest { of } => Query::Smallest { of: rec(of) },
        other => other.clone(),
    }
}
