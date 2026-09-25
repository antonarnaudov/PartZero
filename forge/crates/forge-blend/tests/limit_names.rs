//! W6 review round 5: the limits name the faces that actually limit the value — the walls
//! whose offsets collide in a shell (not the faces of the edge that collapses because of
//! it), and the face the blend's contact runs across for a hole's rim (a hole's wall bounded
//! by two rings is a band, not a face with a hole).

mod common;

use common::*;
use forge_blend::{BlendError, BlendOptions, ShellDirection, ShellOptions, fillet, shell};

fn keys_of(err: &BlendError) -> (Option<f64>, Vec<String>) {
    match err {
        BlendError::ThicknessTooLarge {
            max_feasible_thickness,
            limits,
            ..
        } => (
            *max_feasible_thickness,
            limits.iter().map(|l| l.key.clone()).collect(),
        ),
        other => panic!("expected SHELL_THICKNESS_TOO_LARGE, got {other}"),
    }
}

/// Box 30 × 20 × 10 with a through slot `y ∈ [8, 12]`, `z ∈ [5, 10]` along x.
fn slotted() -> forge_core::topo::Body {
    let b = aabox("e1", [0.0, 0.0, 0.0], [30.0, 20.0, 10.0]);
    cut(b, aabox("e2", [-1.0, 8.0, 5.0], [32.0, 4.0, 6.0]), "c1")
}

#[test]
fn a_slot_whose_walls_meet_names_the_walls() {
    let b = slotted();
    let bottom = face_near(&b, [15.0, 10.0, 0.0]);
    for t in [2.0, 2.2] {
        let err = shell(
            &b,
            &fs(&b, &[bottom]),
            t,
            ShellDirection::Outward,
            &ShellOptions::new("sh1"),
        )
        .expect_err("the slot's walls meet at t = 2");
        let (max, keys) = keys_of(&err);
        assert_eq!(
            max.map(f64::to_bits),
            Some(1.999f64.to_bits()),
            "t = {t}: {err}"
        );
        for wall in ["e2/side:b", "e2/side:t"] {
            assert!(
                keys.iter().any(|k| k.ends_with(wall)),
                "t = {t}: {wall} not among the limits {keys:?}"
            );
        }
    }
}

#[test]
fn a_floor_rising_past_the_opening_is_named() {
    // Plate 40 × 30 × 6 with a through hole, shelled inward from its top by more than its
    // thickness: the floor's offset passes the opening.
    let b = cut(
        aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]),
        zcyl("e2", [20.0, 15.0], -1.0, 5.0, 8.0),
        "c1",
    );
    let top = face_near(&b, [5.0, 5.0, 6.0]);
    let floor = forge_blend::KeyMap::derive(&b)
        .face(face_near(&b, [5.0, 5.0, 0.0]))
        .expect("floor")
        .key;
    let err = shell(
        &b,
        &fs(&b, &[top]),
        6.5,
        ShellDirection::Inward,
        &ShellOptions::new("sh1"),
    )
    .expect_err("thicker than the plate");
    let (_, keys) = keys_of(&err);
    assert!(keys.contains(&floor), "{floor} not among {keys:?}: {err}");
}

/// Plate 40 × 30 × 6 with a through hole of radius 5 at its centre.
fn plate_with_hole() -> forge_core::topo::Body {
    cut(
        aabox("e1", [0.0, 0.0, 0.0], [40.0, 30.0, 6.0]),
        zcyl("e2", [20.0, 15.0], -1.0, 5.0, 8.0),
        "c1",
    )
}

fn limit_faces(err: &BlendError) -> (f64, Vec<(String, Option<String>)>) {
    match err {
        BlendError::RadiusTooLarge {
            max_feasible_r,
            edges,
            ..
        } => (
            *max_feasible_r,
            edges
                .iter()
                .map(|e| (e.key.clone(), e.face.clone()))
                .collect(),
        ),
        other => panic!("expected FILLET_RADIUS_TOO_LARGE, got {other}"),
    }
}

#[test]
fn a_hole_rim_is_limited_by_the_hole_wall_it_runs_across() {
    let b = plate_with_hole();
    let wall = forge_blend::KeyMap::derive(&b)
        .face(face_near(&b, [25.0, 15.0, 3.0]))
        .expect("hole wall")
        .key;
    let top_rim = circle_near(&b, [25.0, 15.0, 6.0]);
    let bottom_rim = circle_near(&b, [25.0, 15.0, 0.0]);
    let opts = BlendOptions::new("f1");
    // One rim: the wall's height (6) limits it.
    let err = fillet(&b, &es(&b, &[top_rim]), 6.5, &opts).expect_err("taller than the wall");
    let (max, faces) = limit_faces(&err);
    assert_eq!(max.to_bits(), 5.999f64.to_bits(), "{err}");
    assert_eq!(faces.len(), 1);
    assert_eq!(faces[0].1.as_deref(), Some(wall.as_str()), "{err}");
    // Both rims: they share the wall, and both are named with it (the configuration is
    // symmetric).
    let err = fillet(&b, &es(&b, &[top_rim, bottom_rim]), 3.5, &opts)
        .expect_err("the two blends meet on the wall");
    let (max, faces) = limit_faces(&err);
    assert_eq!(max.to_bits(), 2.999f64.to_bits(), "{err}");
    assert_eq!(faces.len(), 2, "{err}");
    for (edge, face) in &faces {
        assert_eq!(face.as_deref(), Some(wall.as_str()), "{edge}: {err}");
    }
}

/// Display names (SPEC §5.2 rule 2, §7.4) are the caller's: forge-regen supplies forge-refs'
/// display name of every entity of the input body through the key map, derived entities (a
/// previous blend's faces) included; without a map they are the provenance names.
#[test]
fn limits_carry_the_display_names_the_caller_supplies() {
    let b = plate_with_hole();
    let top_rim = circle_near(&b, [25.0, 15.0, 6.0]);
    let wall = face_near(&b, [25.0, 15.0, 3.0]);
    let mut keys = forge_blend::KeyMap::derive(&b);
    let rim = keys.edge(top_rim).expect("rim");
    keys.set_edge(top_rim, rim.key.clone(), "plate/hole:top-rim");
    let w = keys.face(wall).expect("wall");
    keys.set_face(wall, w.key.clone(), "hole/wall");
    let mut opts = BlendOptions::new("f1");
    opts.keys = Some(keys.clone());
    match fillet(&b, &es(&b, &[top_rim]), 6.5, &opts).expect_err("too large") {
        BlendError::RadiusTooLarge { edges, .. } => {
            assert_eq!(edges[0].key, rim.key);
            assert_eq!(edges[0].name, "plate/hole:top-rim");
        }
        other => panic!("{other}"),
    }
    // Every face renamed: the shell's limits carry the supplied names.
    let mut named = keys.clone();
    for (f, _) in b.faces().iter() {
        let k = keys.face(f).expect("face").key;
        named.set_face(f, k.clone(), format!("name of {k}"));
    }
    let top = face_near(&b, [5.0, 5.0, 6.0]);
    let mut sopts = ShellOptions::new("sh1");
    sopts.keys = Some(named);
    let err = shell(&b, &fs(&b, &[top]), 6.5, ShellDirection::Inward, &sopts)
        .expect_err("thicker than the plate");
    let BlendError::ThicknessTooLarge { limits, .. } = &err else {
        panic!("{err}");
    };
    assert!(!limits.is_empty());
    for l in limits {
        assert_eq!(l.name, format!("name of {}", l.key), "{err}");
    }
}

/// W6 review round 6: a tunnel (r = 1 at (17, 17), along z through a 20³ box) in the
/// material of the vertical corner fillet at (20, 20): the obstacle is the tunnel's wall, not
/// the end cap its rim lies on — and, another feature being in the way, the failure is
/// `FILLET_FAILED` (a capability gap), with the radius that builds clear of it: the tunnel
/// leaves the removed region when the ball's circle, centred at (20 − r, 20 − r), passes its
/// far side: `√2·(r − 3) + 1 = r`, r = (3√2 − 1)/(√2 − 1) = 7.8284.
#[test]
fn a_tunnel_in_a_corner_fillet_names_the_tunnel_wall() {
    let cube = aabox("b", [0.0, 0.0, 0.0], [20.0, 20.0, 20.0]);
    let b = cut(cube, zcyl("t", [17.0, 17.0], -1.0, 1.0, 22.0), "c");
    let e = edge_near(&b, [20.0, 20.0, 10.0]);
    let err = fillet(&b, &es(&b, &[e]), 9.0, &BlendOptions::new("f1")).expect_err("tunnel");
    let hint = obstacle_hint(&err);
    let msg = err.to_string();
    assert!(msg.contains("t/side:c"), "names the tunnel wall: {msg}");
    let sup = (3.0 * 2f64.sqrt() - 1.0) / (2f64.sqrt() - 1.0);
    assert!(
        (sup - 0.0015..sup).contains(&hint),
        "{hint} vs {sup}: {msg}"
    );
    let out = fillet(&b, &es(&b, &[e]), hint, &BlendOptions::new("f1")).expect("clear");
    assert_valid(&out.body);
}

/// W6 review round 6: just below a face's width (10 × 20 × 30 box, the edge between the
/// 10 mm face `side:t` and `side:r`, r = 9.99999) the trimmed cap edges are used up (1e-5 mm
/// left, below the 10·tol minimum edge length): the limit names the face whose width ran out,
/// `side:t`, as at r = 10 — not the cap the used-up edge also bounds.
#[test]
fn a_used_up_edge_names_the_face_whose_width_ran_out() {
    let b = aabox("e1", [0.0, 0.0, 0.0], [10.0, 20.0, 30.0]);
    let e = edge_near(&b, [10.0, 20.0, 15.0]);
    let keys = forge_blend::KeyMap::derive(&b);
    let t = keys
        .face(face_near(&b, [5.0, 20.0, 15.0]))
        .expect("key")
        .key;
    for r in [9.99999, 10.0, 12.0] {
        let err = fillet(&b, &es(&b, &[e]), r, &BlendOptions::new("f1")).expect_err("too large");
        let BlendError::RadiusTooLarge {
            max_feasible_r,
            edges,
            ..
        } = &err
        else {
            panic!("r = {r}: {} {err}", err.code());
        };
        assert_eq!(
            max_feasible_r.to_bits(),
            9.999f64.to_bits(),
            "r = {r}: {err}"
        );
        assert_eq!(edges[0].face.as_deref(), Some(t.as_str()), "r = {r}: {err}");
        assert!(
            err.to_string().contains(&format!("at {t}")),
            "r = {r}: {err}"
        );
    }
}
