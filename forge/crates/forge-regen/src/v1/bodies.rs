//! The bodies of a part during v1 evaluation: identity (SPEC-v1 §5.2 rule 4), metrics
//! (v0 §5 plus `origin`, `change`, `shells`; §7.2) and the canonical order of §5.4.

use std::cmp::Ordering;

use forge_core::topo::Body;
use forge_ir::v1::LINEAR_TOLERANCE;
use forge_ir::v1::metrics::{BodyChange, BodyReport, Origin};

use super::error::FeatureError;

/// A body of a part's current state, with its identity and the metrics computed when it was
/// produced (bodies are immutable: an operation replaces them).
#[derive(Clone, Debug)]
pub struct PartBody {
    /// The body (validated when produced).
    pub body: Body,
    /// Its origin: creating feature id and member (§5.2 rule 4).
    pub origin: Origin,
    /// Timeline index of the origin feature in its part (orders origins, §5.4).
    pub timeline: usize,
    /// Metrics (without `change`).
    pub metrics: BodyReport,
}

impl PartBody {
    /// Measure `body` (exact mass properties, box, topology counts) and wrap it.
    pub(crate) fn new(body: Body, origin: Origin, timeline: usize) -> Result<Self, FeatureError> {
        let metrics = measure(&body, &origin)?;
        Ok(PartBody {
            body,
            origin,
            timeline,
            metrics,
        })
    }

    /// The feature entry form of the metrics (§6.0.5).
    pub fn report(&self, change: BodyChange) -> BodyReport {
        BodyReport {
            change: Some(change),
            ..self.metrics.clone()
        }
    }
}

/// Replace `-0.0` by `0.0` (one spelling keeps reports stable).
fn clean(x: f64) -> f64 {
    x + 0.0
}

/// v0 §5 metrics of a produced body plus `origin` and `shells` (§7.2). Non-finite metrics are
/// an engine failure (`FORGE_NON_FINITE`), never reported.
fn measure(body: &Body, origin: &Origin) -> Result<BodyReport, FeatureError> {
    let m = forge_check::body_metrics(body)?;
    let finite = std::iter::once(m.volume)
        .chain(std::iter::once(m.area))
        .chain(m.centroid)
        .chain(m.bbox_min)
        .chain(m.bbox_max)
        .all(f64::is_finite);
    if !finite {
        return Err(FeatureError::new(
            "FORGE_NON_FINITE",
            "non-finite body metrics",
            serde_json::json!({ "what": "body metrics" }),
        ));
    }
    let shells = body.shells().values().filter(|s| s.closed).count() as u32;
    Ok(BodyReport {
        origin: origin.clone(),
        change: None,
        volume: clean(m.volume),
        area: clean(m.area),
        centroid: m.centroid.map(clean),
        bbox_min: m.bbox_min.map(clean),
        bbox_max: m.bbox_max.map(clean),
        faces: m.faces,
        edges: m.edges,
        shells,
        face_types: m.face_types,
        edge_types: m.edge_types,
        valid: m.valid,
    })
}

/// The scale `s` of §5.4 / v0 §6: the diagonal of the bodies' common bounding box, at least 1.
pub(crate) fn scale_of<'a>(bodies: impl IntoIterator<Item = &'a BodyReport>) -> f64 {
    let mut lo = [f64::INFINITY; 3];
    let mut hi = [f64::NEG_INFINITY; 3];
    let mut any = false;
    for b in bodies {
        any = true;
        for k in 0..3 {
            lo[k] = lo[k].min(b.bbox_min[k]);
            hi[k] = hi[k].max(b.bbox_max[k]);
        }
    }
    if !any {
        return 1.0;
    }
    let d = (0..3).map(|k| (hi[k] - lo[k]).powi(2)).sum::<f64>().sqrt();
    if d.is_finite() { d.max(1.0) } else { 1.0 }
}

/// The origin part of the canonical order (§5.4): timeline index of the origin feature, then
/// the member (byte-wise), then the pattern instance.
fn origin_order(a: (usize, &Origin), b: (usize, &Origin)) -> Ordering {
    a.0.cmp(&b.0)
        .then_with(|| a.1.member.as_bytes().cmp(b.1.member.as_bytes()))
        .then_with(|| a.1.instance.cmp(&b.1.instance))
}

/// Centroids compared lexicographically, components within `tol` counting as equal.
fn centroid_order(a: &[f64; 3], b: &[f64; 3], tol: f64) -> Ordering {
    for k in 0..3 {
        if (a[k] - b[k]).abs() > tol {
            return a[k].total_cmp(&b[k]);
        }
    }
    Ordering::Equal
}

/// The canonical order of bodies (SPEC-v1 §5.4): by origin, then pieces of one origin by
/// centroid with tolerance `LINEAR_TOLERANCE·s`. Returns the permutation (indices into
/// `items`). A stable insertion sort: the tolerant comparison is not a total order, so no
/// library sort (which may panic on one) is used; ties keep the input order.
pub(crate) fn canonical_perm(items: &[(usize, &Origin, &[f64; 3])], scale: f64) -> Vec<usize> {
    let tol = LINEAR_TOLERANCE * scale.max(1.0);
    let cmp = |x: &(usize, &Origin, &[f64; 3]), y: &(usize, &Origin, &[f64; 3])| {
        origin_order((x.0, x.1), (y.0, y.1)).then_with(|| centroid_order(x.2, y.2, tol))
    };
    let mut perm: Vec<usize> = Vec::with_capacity(items.len());
    for i in 0..items.len() {
        let mut pos = perm.len();
        while pos > 0 && cmp(&items[perm[pos - 1]], &items[i]) == Ordering::Greater {
            pos -= 1;
        }
        perm.insert(pos, i);
    }
    perm
}

/// Sort part bodies canonically (§5.4) at the scale of the given bodies.
pub(crate) fn canonical_bodies(bodies: &mut Vec<PartBody>) {
    let scale = scale_of(bodies.iter().map(|b| &b.metrics));
    let perm = {
        let items: Vec<(usize, &Origin, &[f64; 3])> = bodies
            .iter()
            .map(|b| (b.timeline, &b.origin, &b.metrics.centroid))
            .collect();
        canonical_perm(&items, scale)
    };
    let mut slots: Vec<Option<PartBody>> = std::mem::take(bodies).into_iter().map(Some).collect();
    *bodies = perm.into_iter().filter_map(|i| slots[i].take()).collect();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn o(f: &str, m: &str) -> Origin {
        Origin {
            feature: f.into(),
            member: m.into(),
            instance: None,
        }
    }

    #[test]
    fn origins_order_by_timeline_then_member_bytes_then_instance() {
        let (a, b, c) = (o("e2", "b"), o("e1", "z"), o("e1", "Z"));
        let mut d = o("e1", "Z");
        d.instance = Some(vec![1]);
        let cen = [0.0; 3];
        let items = vec![(2, &a, &cen), (1, &b, &cen), (1, &d, &cen), (1, &c, &cen)];
        // `Z` < `z` byte-wise; no instance before an instance.
        assert_eq!(canonical_perm(&items, 1.0), vec![3, 2, 1, 0]);
    }

    #[test]
    fn pieces_of_one_origin_order_by_centroid_with_tolerance() {
        let x = o("e1", "a");
        let c1 = [1.0, 5.0, 0.0];
        let c2 = [1.0 + 1e-7, 2.0, 0.0]; // x within tol: y decides
        let c3 = [0.0, 9.0, 0.0];
        let items = vec![(0, &x, &c1), (0, &x, &c2), (0, &x, &c3)];
        assert_eq!(canonical_perm(&items, 1.0), vec![2, 1, 0]);
        // Equal pieces keep the input order (stable).
        let items = vec![(0, &x, &c1), (0, &x, &c1)];
        assert_eq!(canonical_perm(&items, 1.0), vec![0, 1]);
    }

    #[test]
    fn scale_is_the_common_box_diagonal_at_least_one() {
        assert_eq!(scale_of(std::iter::empty()).to_bits(), 1.0f64.to_bits());
    }

    #[cfg(not(target_family = "wasm"))]
    proptest::proptest! {
        /// The canonical permutation is a permutation, and applying it twice changes nothing
        /// (the order is a fixed point): deterministic whatever the input order.
        #[test]
        fn canonical_order_is_a_stable_permutation(
            raw in proptest::collection::vec((0usize..3, 0u8..3, -5i32..5, -5i32..5), 0..12)
        ) {
            let origins: Vec<Origin> = raw.iter().map(|r| o("f", &format!("m{}", r.1))).collect();
            let cents: Vec<[f64; 3]> =
                raw.iter().map(|r| [f64::from(r.2), f64::from(r.3), 0.0]).collect();
            let items: Vec<(usize, &Origin, &[f64; 3])> =
                raw.iter().enumerate().map(|(i, r)| (r.0, &origins[i], &cents[i])).collect();
            let p = canonical_perm(&items, 1.0);
            let mut seen = p.clone();
            seen.sort_unstable();
            proptest::prop_assert_eq!(seen, (0..items.len()).collect::<Vec<_>>());
            let sorted: Vec<(usize, &Origin, &[f64; 3])> = p.iter().map(|&i| items[i]).collect();
            let q = canonical_perm(&sorted, 1.0);
            proptest::prop_assert_eq!(q, (0..items.len()).collect::<Vec<_>>());
        }
    }
}
