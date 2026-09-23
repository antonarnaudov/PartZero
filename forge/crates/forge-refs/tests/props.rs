//! Property tests of the resolver's invariants: the canonical order does not depend on the
//! input order; alias chains close to their end and key normalisation is idempotent; region
//! shifts by whole pitches (member-qualified caps and bodies land on each other's captured
//! places) and distance edits never turn an exact reference into anything else; a junction
//! reversal against a stale capture is never rebound silently; a named key the query's own
//! pick dropped is never brought back; split pieces are never key problems while pieces on
//! different carriers always are; a pick over a split uses exactly the pick's answer or fails;
//! a split (slivers included) is never used as its name-anchored piece alone; an integer card
//! fails `REF_SPLIT` exactly when the split's extra pieces break it.

mod common;

use common::{dee, doc, e1, eval, notched, plate, r, split_bottom};
use forge_ir::v1::metrics::RefStatus;
use forge_ir::v1::{EntityKind, Ref};
use forge_refs::{Scope, ScopeBuilder, capture, eval_query, resolve};
use proptest::prelude::*;
use serde_json::json;

fn captured(r: &Ref, scope: &Scope<'_>) -> Ref {
    let res = resolve(r, scope);
    assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
    let mut out = r.clone();
    out.capture = Some(capture(&res.members, scope).expect("capture"));
    out
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 16, .. ProptestConfig::default() })]

    /// §5.4: the canonical order of a set is the same whatever order it is given in.
    #[test]
    fn canonical_order_ignores_the_input_order(seed in any::<u64>(), n in 2usize..5) {
        let xs: Vec<f64> = (0..n).map(|k| 10.0 * k as f64).collect();
        let m = eval(&doc(&common::squares(&xs, 4.0), &e1(2.0)));
        let s = m.scope();
        for kind in [EntityKind::Face, EntityKind::Edge, EntityKind::Vertex, EntityKind::Body] {
            let all = s.entities(kind);
            let want = s.canonical(all.clone());
            // A deterministic shuffle from the seed.
            let mut shuffled = all.clone();
            let mut x = seed | 1;
            for i in (1..shuffled.len()).rev() {
                x ^= x << 13;
                x ^= x >> 7;
                x ^= x << 17;
                shuffled.swap(i, (x % (i as u64 + 1)) as usize);
            }
            prop_assert_eq!(s.canonical(shuffled), want);
        }
    }

    /// Alias chains are closed to their last key, and normalising a key through them is
    /// idempotent (nested keys included).
    #[test]
    fn alias_chains_close_and_normalisation_is_idempotent(len in 1usize..6, nest in any::<bool>()) {
        let m = common::plate();
        let mut b = ScopeBuilder::new(m.table.clone()).body(&m.bodies[0].0, m.bodies[0].1.clone());
        let key = |k: usize| format!("e1/side:s{k}");
        for k in 0..len {
            b = b.alias(key(k), key(k + 1));
        }
        let s = b.build();
        let last = key(len);
        for k in 0..len {
            let t = key(k);
            prop_assert_eq!(s.alias_target(&t), Some(last.as_str()));
        }
        let q = if nest {
            format!("e1/edge:{{e1/cap:end@bottom|{}}}", key(0))
        } else {
            key(0)
        };
        let once = s.normalize_key(&q);
        prop_assert_eq!(s.normalize_key(&once), once.clone());
        prop_assert!(once.contains(&key(len)), "{}", once);
    }

    /// A multi-region sketch shifted by a whole number of region pitches: the member-qualified
    /// cap and body references of every region stay exact (no sibling of the family is ever
    /// taken for the member), wherever the other regions land.
    #[test]
    fn region_shifts_keep_member_references_exact(shift in 0usize..4, n in 2usize..4) {
        let base_xs: Vec<f64> = (0..n).map(|k| 10.0 * k as f64).collect();
        let moved: Vec<f64> = base_xs.iter().map(|x| x + 10.0 * shift as f64).collect();
        let a = eval(&doc(&common::squares(&base_xs, 4.0), &e1(2.0)));
        let b = eval(&doc(&common::squares(&moved, 4.0), &e1(2.0)));
        let (sa, sb) = (a.scope(), b.scope());
        for k in 0..n {
            let member = format!("{}1", (b'a' + k as u8) as char);
            for q in [
                json!({ "kind": "face", "q": { "op": "cap", "feature": "e1", "end": "end", "member": member } }),
                json!({ "kind": "body", "q": { "op": "body", "feature": "e1", "member": member } }),
            ] {
                let rc = captured(&r(q), &sa);
                let res = resolve(&rc, &sb);
                prop_assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
            }
        }
    }

    /// A dimension-like edit of an extrude (distance) keeps every face reference of every
    /// region exact, captured or not.
    #[test]
    fn distance_edits_keep_face_references_exact(d in 0.5f64..20.0) {
        let a = eval(&doc(&common::squares(&[0.0, 10.0], 4.0), &e1(2.0)));
        let b = eval(&doc(&common::squares(&[0.0, 10.0], 4.0), &e1(d)));
        let (sa, sb) = (a.scope(), b.scope());
        for e in sa.canonical(sa.entities(EntityKind::Face)) {
            let q = forge_refs::synthesize_query(e, &sa, None).expect("a query");
            let rc = captured(
                &Ref { kind: EntityKind::Face, q, card: None, capture: None },
                &sa,
            );
            let res = resolve(&rc, &sb);
            prop_assert_eq!(res.status, RefStatus::Exact, "{}: {:?}", sa.key(e), res.error);
        }
    }

    /// Captures are not refreshed on exact commits (§0.6): whatever earlier edits did to the
    /// "D" (distance, a move along Y — including by exactly its junction gap), its junction
    /// reference stays exact on the moved junction, and after a reversal of the arc it fails
    /// `REF_AMBIGUOUS` instead of rebinding to the other junction.
    #[test]
    fn junction_references_follow_the_junction_or_fail(
        dist in 1.0f64..12.0,
        dy in prop_oneof![Just(-8.0), Just(8.0), Just(0.0), -20.0f64..20.0],
        reversed in any::<bool>(),
    ) {
        let e = r(json!({ "kind": "edge", "q": { "op": "edge_at", "feature": "e2", "curve": "bow", "end": "end" } }));
        let rc = captured(&e, &dee(4.0, 0.0, false).scope());
        let m = dee(dist, dy, reversed);
        let res = resolve(&rc, &m.scope());
        if reversed {
            prop_assert_eq!(res.code(), Some("REF_AMBIGUOUS"), "{:?}", res.members);
            let c = &res.report.unresolved[0].candidates;
            // The captured junction (moved with the loop) is the first candidate.
            prop_assert!((c[0].probe.point[1] - (dy - 4.0)).abs() < 1e-9, "{:?}", c[0].probe);
        } else {
            prop_assert_eq!(res.status, RefStatus::Exact, "{:?}", res.error);
            let p = res.report.members[0].probe.point;
            prop_assert!((p[1] - (dy - 4.0)).abs() < 1e-9 && (p[2] - dist / 2.0).abs() < 1e-9, "{:?}", p);
        }
    }

    /// The query is the intent (§5.7 step 5): wherever square `b` moves, a captured pick
    /// (`extreme +X` of two named sides) uses exactly the pick's current answer, never an
    /// entity the pick dropped (no `REF_REPAIRED` of a key that still exists).
    #[test]
    fn a_pick_uses_its_current_answer_never_a_dropped_key(bx in -30.0f64..60.0, some in any::<bool>()) {
        prop_assume!((bx - 10.0).abs() > 5.0);
        let q = json!({ "op": "extreme", "dir": "+X", "which": "max", "of": { "op": "union", "of": [
            { "op": "side", "feature": "e1", "curve": "a2" },
            { "op": "side", "feature": "e1", "curve": "b2" } ] } });
        let mut rf = r(json!({ "kind": "face", "q": q }));
        if some {
            rf.card = Some(forge_ir::v1::Cardinality::SOME);
        }
        let base = eval(&doc(&common::squares(&[10.0, 0.0], 4.0), &e1(5.0)));
        let rc = captured(&rf, &base.scope());
        let m = eval(&doc(&common::squares(&[10.0, bx], 4.0), &e1(5.0)));
        let s = m.scope();
        let res = resolve(&rc, &s);
        prop_assert!(res.is_used(), "{:?}", res.error);
        let want = eval_query(&rf.q, &s).expect("evaluates").entities();
        prop_assert_eq!(res.entities(), want);
        prop_assert!(res.warnings.iter().all(|w| w.code != "REF_REPAIRED"));
    }
}

fn side_bottom(card: Option<forge_ir::v1::Cardinality>) -> Ref {
    let mut rf =
        r(json!({ "kind": "face", "q": { "op": "side", "feature": "e1", "curve": "bottom" } }));
    rf.card = card;
    rf
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 24, .. ProptestConfig::default() })]

    /// §5.2 rule 3: the pieces of a face a cut went through share its key and are never a key
    /// problem, wherever the cut is; the same pieces on different planes always are one.
    #[test]
    fn split_pieces_are_no_key_problem_and_pieces_on_two_carriers_are(
        xl in -18.0f64..0.0,
        w in 0.5f64..15.0,
        dy in prop_oneof![Just(0.0), 0.01f64..4.0, -4.0f64..-0.01],
    ) {
        let xr = (xl + w).min(18.0);
        prop_assume!(xr - xl >= 0.5);
        let m = notched(xl, xr, dy);
        let problems = m.scope().key_problems();
        if dy == 0.0 {
            prop_assert!(problems.is_empty(), "{:?}", problems);
        } else {
            prop_assert!(
                problems.iter().any(|p| p.key == "e1/side:bottom" && p.problem.contains("different carriers")),
                "{:?}", problems
            );
        }
    }

    /// A pick over a member split into pieces that share its key (§5.7 step 3, the query is the
    /// intent): with `card: some` exactly the pick's answer is used, never a piece the pick
    /// dropped; with `card: one` it fails `REF_SPLIT` and no candidate is a dropped piece.
    #[test]
    fn a_pick_over_a_shared_key_split_uses_the_picked_piece_or_fails(
        t in -15.0f64..15.0,
        max in any::<bool>(),
        some in any::<bool>(),
    ) {
        let which = if max { "max" } else { "min" };
        let mut rf = r(json!({ "kind": "face", "q": { "op": "extreme", "dir": "+X", "which": which,
            "of": { "op": "side", "feature": "e1", "curve": "bottom" } } }));
        if some {
            rf.card = Some(forge_ir::v1::Cardinality::SOME);
        }
        let rc = captured(&rf, &plate().scope());
        let m = split_bottom(&[t], true);
        let s = m.scope();
        let want = eval_query(&rf.q, &s).expect("evaluates").entities();
        prop_assert_eq!(want.len(), 1);
        let res = resolve(&rc, &s);
        if some {
            prop_assert!(res.is_used(), "{:?}", res.error);
            prop_assert_eq!(res.entities(), want);
        } else {
            prop_assert_eq!(res.code(), Some("REF_SPLIT"));
            let picked = s.probe(want[0]).expect("probe");
            for c in &res.report.unresolved[0].candidates {
                prop_assert_eq!(&c.probe, &picked);
            }
        }
    }

    /// A split of the captured member into a name-anchored piece and a piece with a new key —
    /// anywhere, slivers inside the comparison's box padding included — is never used as the
    /// anchor alone: `card: one` fails `REF_SPLIT`, `card: some` uses both pieces.
    #[test]
    fn a_split_is_never_used_as_its_anchor_alone(
        t in prop_oneof![-19.99f64..19.99, 19.9955f64..19.9999, -19.9999f64..-19.9955],
        some in any::<bool>(),
    ) {
        let card = some.then_some(forge_ir::v1::Cardinality::SOME);
        let rc = captured(&side_bottom(card), &plate().scope());
        let m = split_bottom(&[t], false);
        let s = m.scope();
        let res = resolve(&rc, &s);
        if some {
            prop_assert!(res.is_used(), "{:?}", res.error);
            let mut keys: Vec<&str> = res.members.iter().map(|m| m.key.as_str()).collect();
            keys.sort_unstable();
            prop_assert_eq!(keys, ["e1/side:bottom", "e1/side:bottom1"]);
        } else {
            prop_assert_eq!(res.code(), Some("REF_SPLIT"), "{:?}", res.members);
        }
    }

    /// §5.7 step 3/5: with `union(bottom, top)` and `bottom` split into `p` pieces sharing its
    /// key, an integer card `k` is used when it counts every piece, fails `REF_SPLIT` when only
    /// the split's extra pieces break it (`k` = 2) or when it is 1 (card one: a split is never
    /// used, step 3), and is `REF_CARDINALITY` otherwise.
    #[test]
    fn an_integer_card_fails_split_only_when_the_pieces_break_it(
        p in 2usize..5,
        k in 1u32..7,
    ) {
        let mut rf = r(json!({ "kind": "face", "card": "some", "q": { "op": "union", "of": [
            { "op": "side", "feature": "e1", "curve": "bottom" },
            { "op": "side", "feature": "e1", "curve": "top" } ] } }));
        let rc0 = captured(&rf, &plate().scope());
        rf = rc0.clone();
        rf.card = Some(forge_ir::v1::Cardinality::Exactly(k));
        let cuts: Vec<f64> = (1..p).map(|i| -20.0 + 40.0 * i as f64 / p as f64).collect();
        let m = split_bottom(&cuts, true);
        let res = resolve(&rf, &m.scope());
        let n = p + 1;
        if k as usize == n {
            prop_assert!(res.is_used(), "{:?}", res.error);
            prop_assert_eq!(res.members.len(), n);
        } else if k <= 2 {
            prop_assert_eq!(res.code(), Some("REF_SPLIT"));
            prop_assert_eq!(res.report.unresolved[0].candidates.len(), p);
        } else {
            prop_assert_eq!(res.code(), Some("REF_CARDINALITY"));
            let d = &res.error.as_ref().expect("error").details;
            prop_assert_eq!(&d["found"], &json!(n));
        }
    }

    /// A captured key that does not parse names no feature (§5.7 step 4's own-feature rule
    /// cannot hold): whatever it is, its geometry-identical match is never used.
    #[test]
    fn an_unparsable_captured_key_is_never_used(key in "[a-z0-9 :{|}@]{0,16}", some in any::<bool>()) {
        prop_assume!(forge_core::topo::parse_key(&key).is_err());
        let card = some.then_some(forge_ir::v1::Cardinality::SOME);
        let m = plate();
        let s = m.scope();
        let mut rc = captured(&side_bottom(card), &s);
        rc.capture.as_mut().expect("capture").members[0].key = key;
        let res = resolve(&rc, &s);
        prop_assert!(!res.is_used(), "{:?}", res.members);
        prop_assert!(res.warnings.iter().all(|w| w.code != "REF_REPAIRED"));
    }
}
