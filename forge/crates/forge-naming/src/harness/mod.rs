//! The spike-2 naming stability harness.
//!
//! For every model and every scripted [`mutate::Mutation`]:
//! 1. evaluate the base and the mutated document ([`ModelView::build`]);
//! 2. capture a reference ([`EntityRef`]) to **every** face and edge of the base;
//! 3. resolve each reference against the mutated model ([`resolve()`]);
//! 4. compute what it *should* resolve to with the geometry-only ground truth
//!    ([`truth::expected`]) and score the pair ([`score`]).
//!
//! The run is deterministic: models, mutations, entities and references are visited in
//! fixed orders and every map is a `BTreeMap`.

pub mod models;
pub mod mutate;
pub mod report;
pub mod truth;

use std::collections::BTreeMap;

use forge_ir::{Document, to_json};

use crate::resolve::{
    AUTO_ACCEPT_CONFIDENCE, EntityRef, Reason, Resolution, Status, resolve, resolve_name_only,
};
use crate::view::{EntityKind, Loc, ModelView};
use models::Model;
use mutate::{Family, Mutation, mutations};
use truth::{Expected, Truth, expected, label};

/// Score of one reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Outcome {
    /// Resolved exactly to the ground-truth entity.
    Correct,
    /// Flagged, and either the ground-truth entity (or a piece of it) is ranked first,
    /// or the entity is correctly reported missing.
    FlaggedCorrectly,
    /// Reported exact, or with auto-accept confidence, but wrong: the unforgivable case.
    /// Includes an exact resolution to one piece of a split entity (a partial rebind).
    SilentWrong,
    /// Flagged (below auto-accept confidence) but the proposal is wrong.
    WrongButFlagged,
    /// Ground truth inconclusive; not scored.
    Excluded,
}

impl Outcome {
    /// Report label.
    pub fn as_str(self) -> &'static str {
        match self {
            Outcome::Correct => "CORRECT",
            Outcome::FlaggedCorrectly => "FLAGGED_CORRECTLY",
            Outcome::SilentWrong => "SILENT_WRONG",
            Outcome::WrongButFlagged => "WRONG_BUT_FLAGGED",
            Outcome::Excluded => "EXCLUDED",
        }
    }
}

/// Score a resolution against the ground truth.
pub fn score(exp: &Expected, res: &Resolution) -> Outcome {
    let top = res.top();
    let high = res.confidence() >= AUTO_ACCEPT_CONFIDENCE;
    let missing = matches!(res.status, Status::Missing);
    match exp {
        Expected::Inconclusive(_) => Outcome::Excluded,
        Expected::Same(e) | Expected::Renamed(e) => {
            if res.is_exact() {
                if top == Some(*e) {
                    Outcome::Correct
                } else {
                    Outcome::SilentWrong
                }
            } else if top == Some(*e) || (missing && matches!(exp, Expected::Renamed(_))) {
                // A renamed source may legitimately be reported missing.
                Outcome::FlaggedCorrectly
            } else if high {
                Outcome::SilentWrong
            } else {
                Outcome::WrongButFlagged
            }
        }
        Expected::Split(pieces) => {
            if res.is_exact() || high {
                Outcome::SilentWrong
            } else if top.is_some_and(|t| pieces.contains(&t)) {
                Outcome::FlaggedCorrectly
            } else {
                Outcome::WrongButFlagged
            }
        }
        Expected::Gone => {
            if res.is_exact() || high {
                Outcome::SilentWrong
            } else if missing {
                Outcome::FlaggedCorrectly
            } else {
                Outcome::WrongButFlagged
            }
        }
    }
}

/// One scored reference.
#[derive(Clone, Debug)]
pub struct RefRecord {
    /// Model name.
    pub model: String,
    /// Mutation id.
    pub mutation: String,
    /// Family.
    pub family: Family,
    /// Mutation kind.
    pub kind: &'static str,
    /// Face or edge.
    pub entity: EntityKind,
    /// The stored name.
    pub name: String,
    /// Ground truth, in words.
    pub expected: String,
    /// Ground-truth category.
    pub expected_kind: &'static str,
    /// Resolution, in words.
    pub resolution: String,
    /// Resolution status label.
    pub status: &'static str,
    /// Resolution reason.
    pub reason: Reason,
    /// Resolution confidence (1 for exact).
    pub confidence: f64,
    /// Score.
    pub outcome: Outcome,
    /// Score of the names-only baseline ([`resolve_name_only`]).
    pub baseline: Outcome,
}

/// One evaluated mutation.
#[derive(Clone, Debug)]
pub struct MutationRecord {
    /// Model name.
    pub model: String,
    /// Mutation id.
    pub id: String,
    /// Family.
    pub family: Family,
    /// Kind.
    pub kind: &'static str,
    /// Description.
    pub description: String,
    /// Number of references scored (including excluded).
    pub refs: usize,
    /// Unlabelled entities in the mutated model (ground-truth gaps).
    pub truth_problems: usize,
}

/// A generated mutation the runner rejected, and why.
#[derive(Clone, Debug)]
pub struct Skipped {
    /// Model name.
    pub model: String,
    /// Mutation id.
    pub id: String,
    /// Family.
    pub family: Family,
    /// Reason.
    pub reason: String,
}

/// Ground truth vs provenance on an unmutated model.
#[derive(Clone, Debug)]
pub struct Sanity {
    /// Model name.
    pub model: String,
    /// Source of the model.
    pub source: &'static str,
    /// Bodies.
    pub bodies: usize,
    /// Faces + edges.
    pub entities: usize,
    /// Entities the ground truth could not label.
    pub unlabelled: usize,
    /// Entities whose label and provenance name correspond one-to-one.
    pub agree: usize,
    /// Accepted mutations.
    pub mutations: usize,
}

/// Everything a harness run produced.
#[derive(Clone, Debug, Default)]
pub struct Report {
    /// Per-model sanity data.
    pub sanity: Vec<Sanity>,
    /// Accepted mutations.
    pub mutations: Vec<MutationRecord>,
    /// Every scored reference.
    pub refs: Vec<RefRecord>,
    /// Rejected mutations.
    pub skipped: Vec<Skipped>,
}

/// Face and edge counts and face-type histogram of every body (the topology guard for
/// family (a)).
fn topology_signature(
    view: &ModelView,
) -> Vec<(String, usize, usize, BTreeMap<&'static str, usize>)> {
    view.bodies
        .iter()
        .map(|b| {
            let mut kinds = BTreeMap::new();
            for (_, f) in b.body.faces().iter() {
                *kinds.entry(f.surface.kind_name()).or_insert(0) += 1;
            }
            (
                b.feature.clone(),
                b.body.faces().len(),
                b.body.edges().len(),
                kinds,
            )
        })
        .collect()
}

fn describe_expected(exp: &Expected, view: &ModelView) -> String {
    match exp {
        Expected::Same(l) => format!("same: {}", view.name(*l)),
        Expected::Renamed(l) => format!("renamed: {}", view.name(*l)),
        Expected::Split(ls) => format!(
            "split into [{}]",
            ls.iter()
                .map(|l| view.name(*l).to_string())
                .collect::<Vec<_>>()
                .join(", ")
        ),
        Expected::Gone => "gone".to_string(),
        Expected::Inconclusive(why) => format!("inconclusive: {why}"),
    }
}

/// Ground-truth labels vs provenance names on one view: `(unlabelled, agree)`.
fn sanity_check(view: &ModelView, truth: &Truth) -> (usize, usize) {
    let mut name_to_labels: BTreeMap<&str, Vec<&truth::Label>> = BTreeMap::new();
    let mut label_to_names: BTreeMap<&truth::Label, Vec<(usize, &str)>> = BTreeMap::new();
    for l in view.entities() {
        if let Some(lab) = truth.labels.get(&l) {
            name_to_labels.entry(view.name(l)).or_default().push(lab);
            label_to_names
                .entry(lab)
                .or_default()
                .push((l.body, view.name(l)));
        }
    }
    let unlabelled = view.entities().len() - truth.labels.len();
    let agree = view
        .entities()
        .into_iter()
        .filter(|l| {
            truth.labels.get(l).is_some_and(|lab| {
                label_to_names.get(lab).is_some_and(|v| v.len() == 1)
                    && name_to_labels.get(view.name(*l)).is_some_and(|v| {
                        // A name shared by several region bodies (caps) is fine as long
                        // as every sharer has a distinct label.
                        let mut u = v.clone();
                        u.sort();
                        u.dedup();
                        u.len() == v.len()
                    })
            })
        })
        .count();
    (unlabelled, agree)
}

fn same_doc(a: &Document, b: &Document) -> bool {
    to_json(a) == to_json(b)
}

/// Why a candidate mutation must be rejected, if it must.
fn rejection(m: &Mutation, base: &ModelView, new: &ModelView) -> Option<String> {
    if let Err(e) = forge_ir::validate(&m.mutated) {
        return Some(format!("invalid IR: {e:?}"));
    }
    if same_doc(&m.base, &m.mutated) {
        return Some("no change".into());
    }
    if !base.failed.is_empty() {
        return Some("base evaluation failed".into());
    }
    if base.bodies.is_empty() {
        return Some("no references on the base model (nothing to resolve)".into());
    }
    match m.family {
        Family::Suppress => {
            if let Some(f) = new.failed.iter().find(|f| f.code != "SKETCH_SUPPRESSED") {
                return Some(format!("feature {} failed with {}", f.feature, f.code));
            }
        }
        Family::Dimension | Family::Topology => {
            if let Some(f) = new.failed.first() {
                return Some(format!("feature {} failed with {}", f.feature, f.code));
            }
        }
    }
    if m.family == Family::Dimension {
        let (a, b) = (topology_signature(base), topology_signature(new));
        if a != b {
            return Some("not topology-preserving".into());
        }
    }
    None
}

/// Run the harness over `models`.
pub fn run_models(models: &[Model]) -> Report {
    let mut rep = Report::default();
    for model in models {
        let base_view = ModelView::build(&model.doc);
        let base_truth = label(&model.doc, &base_view);
        let (unlabelled, agree) = sanity_check(&base_view, &base_truth);
        let mut accepted = 0;
        for mut m in mutations(&model.doc) {
            let own_base;
            let (bview, btruth) = if same_doc(&m.base, &model.doc) {
                (&base_view, &base_truth)
            } else {
                let v = ModelView::build(&m.base);
                let t = label(&m.base, &v);
                own_base = (v, t);
                (&own_base.0, &own_base.1)
            };
            let new_view = ModelView::build(&m.mutated);
            // A dimension edit that turns out to change a face's type or the face/edge
            // counts (e.g. a vertex moved off a revolve axis) is a topology edit.
            if m.family == Family::Dimension
                && new_view.failed.is_empty()
                && topology_signature(bview) != topology_signature(&new_view)
            {
                m.family = Family::Topology;
                m.kind = "dimension_edit_changing_topology";
                m.description
                    .push_str(" — changes a face's type or the topology");
            }
            if let Some(reason) = rejection(&m, bview, &new_view) {
                rep.skipped.push(Skipped {
                    model: model.name.to_string(),
                    id: m.id.clone(),
                    family: m.family,
                    reason,
                });
                continue;
            }
            accepted += 1;
            let new_truth = label(&m.mutated, &new_view);
            let refs = EntityRef::capture_all(bview);
            for (loc, r) in &refs {
                let mut exp = expected(btruth, &new_truth, &m.intent, *loc);
                if exp == Expected::Gone && !new_truth.problems.is_empty() {
                    exp = Expected::Inconclusive("mutated model has unlabelled entities".into());
                }
                let res = resolve(r, &new_view);
                let outcome = score(&exp, &res);
                let baseline = score(&exp, &resolve_name_only(r, &new_view));
                rep.refs.push(RefRecord {
                    model: model.name.to_string(),
                    mutation: m.id.clone(),
                    family: m.family,
                    kind: m.kind,
                    entity: r.kind,
                    name: r.name.clone(),
                    expected: describe_expected(&exp, &new_view),
                    expected_kind: exp.kind_str(),
                    resolution: res.describe(&new_view),
                    status: res.status_str(),
                    reason: res.reason,
                    confidence: res.confidence(),
                    outcome,
                    baseline,
                });
            }
            rep.mutations.push(MutationRecord {
                model: model.name.to_string(),
                id: m.id.clone(),
                family: m.family,
                kind: m.kind,
                description: m.description.clone(),
                refs: refs.len(),
                truth_problems: new_truth.problems.len(),
            });
        }
        rep.sanity.push(Sanity {
            model: model.name.to_string(),
            source: model.source,
            bodies: base_view.bodies.len(),
            entities: base_view.entities().len(),
            unlabelled,
            agree,
            mutations: accepted,
        });
    }
    rep
}

/// Run the harness over all spike models.
pub fn run() -> Report {
    run_models(&models::models())
}

/// Resolve every reference of `doc` against `doc` itself (the identity check: every
/// reference must be exact and point at its own entity). Returns the failures.
pub fn identity_failures(doc: &Document) -> Vec<(String, String)> {
    let view = ModelView::build(doc);
    EntityRef::capture_all(&view)
        .into_iter()
        .filter_map(|(loc, r): (Loc, EntityRef)| {
            let res = resolve(&r, &view);
            (res.status != Status::Exact(loc)).then(|| (r.name.clone(), res.describe(&view)))
        })
        .collect()
}
