//! Canonical sketches with analytically known degrees of freedom, redundancies and
//! conflicts.

use forge_solve::{
    Constraint, ConstraintState, Entity, Sketch, SolveOptions, SolveResult, SolveStatus, c, solve,
};

fn run(s: &Sketch) -> SolveResult {
    solve(s, &SolveOptions::default()).expect("valid sketch")
}

fn state(r: &SolveResult, id: &str) -> ConstraintState {
    r.constraints
        .iter()
        .find(|c| c.id == id)
        .expect("constraint")
        .state
}

fn ent<'a>(r: &'a SolveResult, id: &str) -> &'a forge_solve::EntityReport {
    r.entities.iter().find(|e| e.id == id).expect("entity")
}

/// Four lines with their own endpoints (8 points) and a coincident constraint per corner.
fn loose_rectangle() -> Sketch {
    let pts = [[0.0, 0.0], [10.0, 0.3], [10.4, 6.0], [0.2, 5.8]];
    let mut s = Sketch::default();
    for i in 0..4 {
        let j = (i + 1) % 4;
        s.entities
            .push(Entity::point(format!("a{i}"), pts[i][0] + 0.01, pts[i][1]));
        s.entities
            .push(Entity::point(format!("b{i}"), pts[j][0], pts[j][1] - 0.01));
        s.entities.push(Entity::line(
            format!("L{i}"),
            format!("a{i}"),
            format!("b{i}"),
        ));
    }
    for i in 0..4 {
        let j = (i + 1) % 4;
        s.constraints.push(Constraint::new(
            format!("corner{j}"),
            c::coincident(&format!("b{i}"), &format!("a{j}")),
        ));
    }
    s
}

fn add(s: &mut Sketch, id: &str, k: forge_solve::ConstraintKind) {
    s.constraints.push(Constraint::new(id, k));
}

#[test]
fn unconstrained_rectangle_of_four_lines_with_coincident_corners_has_8_dof() {
    let r = run(&loose_rectangle());
    assert_eq!(r.status, SolveStatus::UnderConstrained);
    assert_eq!(r.dof, 8, "{}", r.explanation);
    assert!(r.ok);
    // Each line can move with both endpoints independently (4 DOF each).
    for i in 0..4 {
        assert_eq!(ent(&r, &format!("L{i}")).dof, 4);
        assert_eq!(ent(&r, &format!("a{i}")).dof, 2);
    }
}

#[test]
fn horizontal_vertical_rectangle_has_4_dof_then_2_then_0() {
    let mut s = loose_rectangle();
    add(&mut s, "h0", c::horizontal("L0"));
    add(&mut s, "v1", c::vertical("L1"));
    add(&mut s, "h2", c::horizontal("L2"));
    add(&mut s, "v3", c::vertical("L3"));
    let r = run(&s);
    assert_eq!(r.dof, 4, "{}", r.explanation);
    assert_eq!(r.status, SolveStatus::UnderConstrained);
    add(&mut s, "w", c::distance("a0", "b0", 12.0));
    add(&mut s, "h", c::distance("a1", "b1", 7.0));
    let r = run(&s);
    assert_eq!(r.dof, 2);
    // Only translation remains: every point moves in both directions.
    assert_eq!(ent(&r, "a2").dof, 2);
    add(&mut s, "fix", c::fix("a0"));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::FullyConstrained, "{}", r.explanation);
    assert_eq!(r.dof, 0);
    assert!(r.ok && r.max_residual <= 1e-10);
    assert!(r.entities.iter().all(|e| e.dof == 0));
    // The fixed corner stays, the others land on the exact rectangle.
    let a0 = match ent(&r, "a0").geometry {
        forge_solve::SolvedGeometry::Point { x, y } => [x, y],
        _ => unreachable!(),
    };
    let a2 = match ent(&r, "a2").geometry {
        forge_solve::SolvedGeometry::Point { x, y } => [x, y],
        _ => unreachable!(),
    };
    assert!(
        (a2[0] - a0[0] - 12.0).abs() < 1e-9 && (a2[1] - a0[1] - 7.0).abs() < 1e-9,
        "{a0:?} {a2:?}"
    );
}

#[test]
fn adding_a_redundant_parallel_flags_it_and_names_what_implies_it() {
    let mut s = loose_rectangle();
    add(&mut s, "h0", c::horizontal("L0"));
    add(&mut s, "v1", c::vertical("L1"));
    add(&mut s, "h2", c::horizontal("L2"));
    add(&mut s, "v3", c::vertical("L3"));
    add(&mut s, "w", c::distance("a0", "b0", 12.0));
    add(&mut s, "h", c::distance("a1", "b1", 7.0));
    add(&mut s, "fix", c::fix("a0"));
    add(&mut s, "par", c::parallel("L0", "L2"));
    let r = run(&s);
    assert_eq!(
        r.status,
        SolveStatus::OverConstrainedRedundant,
        "{}",
        r.explanation
    );
    assert!(r.ok);
    assert_eq!(r.dof, 0);
    assert_eq!(r.redundant.len(), 1);
    assert_eq!(r.redundant[0].constraint, "par");
    assert!(!r.redundant[0].partial);
    assert_eq!(state(&r, "par"), ConstraintState::Redundant);
    let by = &r.redundant[0].implied_by;
    assert!(
        by.contains(&"h0".to_owned()) && by.contains(&"h2".to_owned()),
        "{by:?}"
    );
    assert!(r.redundant[0].explanation.contains("par"));
}

#[test]
fn contradicting_dimensions_form_exactly_the_minimal_conflict() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("a", 0.0, 0.0));
    s.entities.push(Entity::point("b", 9.0, 0.5));
    s.entities.push(Entity::line("ab", "a", "b"));
    s.entities.push(Entity::point("q", 4.0, 7.0));
    s.entities.push(Entity::point("r", 40.0, 0.0));
    s.entities.push(Entity::point("t", 44.0, 1.0));
    add(&mut s, "fa", c::fix("a"));
    add(&mut s, "h", c::horizontal("ab"));
    add(&mut s, "d10", c::distance("a", "b", 10.0));
    add(&mut s, "dq", c::distance("a", "q", 5.0));
    add(&mut s, "drt", c::distance("r", "t", 5.0));
    add(&mut s, "d12", c::distance("a", "b", 12.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::Conflict, "{}", r.explanation);
    assert!(!r.ok);
    assert_eq!(r.conflicts.len(), 1);
    assert_eq!(r.conflicts[0].constraints, ["d10", "d12"]);
    assert_eq!(r.conflicts[0].suggested_removal, "d12");
    assert_eq!(state(&r, "d10"), ConstraintState::Conflicting);
    // Same cluster as the conflict: left unsolved (input geometry kept) and reported so.
    assert_eq!(state(&r, "dq"), ConstraintState::Unsatisfied);
    // An independent cluster is still solved.
    assert_eq!(state(&r, "drt"), ConstraintState::Satisfied);
    assert_eq!(r.clusters.len(), 2);
    // Conflicting clusters keep their input geometry.
    let b = match ent(&r, "b").geometry {
        forge_solve::SolvedGeometry::Point { x, y } => [x, y],
        _ => unreachable!(),
    };
    assert_eq!(b.map(f64::to_bits), [9.0f64, 0.5].map(f64::to_bits));
}

#[test]
fn rectangle_with_conflicting_opposite_widths_isolates_the_true_minimal_set() {
    let mut s = loose_rectangle();
    add(&mut s, "h0", c::horizontal("L0"));
    add(&mut s, "v1", c::vertical("L1"));
    add(&mut s, "h2", c::horizontal("L2"));
    add(&mut s, "v3", c::vertical("L3"));
    add(&mut s, "w", c::distance("a0", "b0", 10.0));
    add(&mut s, "fix", c::fix("a0"));
    add(&mut s, "w2", c::distance("a2", "b2", 12.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::Conflict, "{}", r.explanation);
    let set = &r.conflicts[0].constraints;
    // The top (12) cannot be longer than the bottom's horizontal extent (≤ 10) once both
    // verticals tie the x-coordinates and the top is horizontal; h0 is NOT needed (a
    // tilted bottom is even shorter horizontally), and neither is the fix.
    for id in ["v1", "h2", "v3", "w", "w2"] {
        assert!(set.contains(&id.to_owned()), "{id} missing from {set:?}");
    }
    assert!(
        !set.contains(&"fix".to_owned()) && !set.contains(&"h0".to_owned()),
        "{set:?}"
    );
}

#[test]
fn angle_contradicting_horizontal_and_vertical_is_a_three_constraint_conflict() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("o", 0.0, 0.0));
    s.entities.push(Entity::point("x", 10.0, 0.2));
    s.entities.push(Entity::point("y", 0.1, 8.0));
    s.entities.push(Entity::line("lx", "o", "x"));
    s.entities.push(Entity::line("ly", "o", "y"));
    add(&mut s, "h", c::horizontal("lx"));
    add(&mut s, "v", c::vertical("ly"));
    add(&mut s, "dx", c::distance("o", "x", 10.0));
    add(&mut s, "ang", c::angle("lx", "ly", 80.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::Conflict, "{}", r.explanation);
    assert_eq!(r.conflicts[0].constraints, ["h", "v", "ang"]);
    // The 90° version is redundant instead.
    s.constraints.last_mut().expect("ang").kind = c::angle("lx", "ly", 90.0);
    let r = run(&s);
    assert_eq!(
        r.status,
        SolveStatus::OverConstrainedRedundant,
        "{}",
        r.explanation
    );
    assert_eq!(r.redundant[0].constraint, "ang");
}

#[test]
fn free_entities_report_their_dof_and_directions() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("c", 0.0, 0.0));
    s.entities.push(Entity::circle("circ", "c", 3.0));
    s.entities.push(Entity::point("ac", 20.0, 0.0));
    s.entities.push(Entity::point("as", 25.0, 0.0));
    s.entities.push(Entity::point("ae", 20.0, 5.1));
    s.entities.push(Entity::arc("arc", "ac", "as", "ae"));
    s.entities.push(Entity::point("slider", 3.0, 1.0));
    s.entities.push(Entity::point("g0", -10.0, 1.0).fixed());
    s.entities.push(Entity::point("g1", 10.0, 1.0).fixed());
    s.entities.push(Entity::line("guide", "g0", "g1"));
    add(&mut s, "on", c::point_on_line("slider", "guide"));
    let r = run(&s);
    // circle 3 + arc (6 − 1 rule) 5 + slider 1.
    assert_eq!(r.dof, 9, "{}", r.explanation);
    assert_eq!(ent(&r, "circ").dof, 3);
    assert_eq!(ent(&r, "circ").radius_free, Some(true));
    assert_eq!(ent(&r, "arc").dof, 5);
    assert_eq!(ent(&r, "slider").dof, 1);
    assert_eq!(ent(&r, "slider").free_direction, Some([1.0, 0.0]));
    assert_eq!(ent(&r, "guide").dof, 0);
    assert!(r.explanation.contains("slider (1 DOF"), "{}", r.explanation);
}

#[test]
fn triangle_with_three_sides_and_a_pinned_edge_is_fully_constrained() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("a", 0.0, 0.0));
    s.entities.push(Entity::point("b", 5.0, 0.3));
    s.entities.push(Entity::point("c", 2.0, 3.0));
    for (id, p, q) in [("ab", "a", "b"), ("bc", "b", "c"), ("ca", "c", "a")] {
        s.entities.push(Entity::line(id, p, q));
    }
    add(&mut s, "fa", c::fix("a"));
    add(&mut s, "h", c::horizontal("ab"));
    add(&mut s, "d1", c::distance("a", "b", 5.0));
    add(&mut s, "d2", c::distance("b", "c", 4.0));
    add(&mut s, "d3", c::distance("c", "a", 3.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::FullyConstrained, "{}", r.explanation);
    // 3-4-5 right triangle with the right angle at c.
    let measured = |id: &str| {
        r.constraints
            .iter()
            .find(|c| c.id == id)
            .and_then(|c| c.measured)
    };
    assert!((measured("d1").expect("d1") - 5.0).abs() < 1e-10);
    // A reference angle is measured, not enforced.
    let mut s2 = s.clone();
    s2.constraints
        .push(Constraint::new("ref", c::angle("bc", "ca", 0.0)).reference());
    let r2 = run(&s2);
    assert_eq!(r2.status, SolveStatus::FullyConstrained);
    let ang = r2.constraints.iter().find(|c| c.id == "ref").expect("ref");
    assert_eq!(ang.state, ConstraintState::Reference);
    assert!(
        (ang.measured.expect("measured").abs() - 90.0).abs() < 1e-8,
        "{ang:?}"
    );
}

#[test]
fn slot_dof_counts_follow_the_tangency_structure() {
    use forge_solve::generate::slot;
    // Tangents at the joints + equal radii leave position, rotation, length and radius.
    assert_eq!(run(&slot(1, 0).sketch).dof, 5);
    assert_eq!(
        run(&slot(1, 1).sketch).dof,
        5,
        "separate endpoints + coincident"
    );
    let r = run(&slot(1, 2).sketch);
    assert_eq!(
        (r.status, r.dof),
        (SolveStatus::FullyConstrained, 0),
        "{}",
        r.explanation
    );
    // Joint tangency is well conditioned (no double root at the solution).
    assert!(
        r.clusters[0].conditioning > 1e-3,
        "{}",
        r.clusters[0].conditioning
    );
    assert!(!r.clusters[0].near_degenerate);
}

#[test]
fn circle_tangencies_internal_external_and_line() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("o1", 0.0, 0.0));
    s.entities.push(Entity::point("o2", 9.3, 0.4));
    s.entities.push(Entity::point("o3", 1.2, 0.1));
    s.entities.push(Entity::circle("C1", "o1", 4.0));
    s.entities.push(Entity::circle("C2", "o2", 5.0));
    s.entities.push(Entity::circle("C3", "o3", 2.5));
    s.entities.push(Entity::point("l0", -10.0, 4.2));
    s.entities.push(Entity::point("l1", 20.0, 4.3));
    s.entities.push(Entity::line("top", "l0", "l1"));
    add(&mut s, "fix", c::fix("o1"));
    add(&mut s, "r1", c::radius("C1", 4.0));
    add(&mut s, "r2", c::radius("C2", 5.0));
    add(&mut s, "r3", c::radius("C3", 2.0));
    add(&mut s, "ext", c::tangent("C1", "C2"));
    add(&mut s, "int", c::tangent("C1", "C3"));
    add(&mut s, "t", c::tangent("top", "C1"));
    add(&mut s, "h", c::horizontal("top"));
    let r = run(&s);
    assert!(r.ok, "{}", r.explanation);
    let pt = |id: &str| match ent(&r, id).geometry {
        forge_solve::SolvedGeometry::Point { x, y } => [x, y],
        _ => unreachable!(),
    };
    let d = |a: [f64; 2], b: [f64; 2]| forge_core::math::hypot(a[0] - b[0], a[1] - b[1]);
    assert!(
        (d(pt("o1"), pt("o2")) - 9.0).abs() < 1e-9,
        "external: 4 + 5"
    );
    assert!(
        (d(pt("o1"), pt("o3")) - 2.0).abs() < 1e-9,
        "internal: 4 − 2"
    );
    assert!(
        (pt("l0")[1] - 4.0).abs() < 1e-9,
        "horizontal tangent line at y = 4"
    );
    // o2 and o3 can still rotate around o1; the line can slide along itself.
    assert_eq!(ent(&r, "o2").dof, 1);
    assert_eq!(ent(&r, "o3").dof, 1);
}

#[test]
fn midpoint_and_symmetry_remove_two_dof_each() {
    let mut s = Sketch::default();
    for (id, x, y) in [
        ("a", 0.0, 0.0),
        ("b", 10.0, 0.5),
        ("m", 4.0, 1.0),
        ("p", -3.0, 6.0),
        ("q", 2.0, 9.0),
        ("ax0", 5.0, -5.0),
        ("ax1", 5.2, 12.0),
    ] {
        s.entities.push(Entity::point(id, x, y));
    }
    s.entities.push(Entity::line("ab", "a", "b"));
    s.entities.push(Entity::line("axis", "ax0", "ax1"));
    let free = run(&s).dof;
    add(&mut s, "mid", c::midpoint("m", "ab"));
    add(&mut s, "sym", c::symmetric("p", "q", "axis"));
    let r = run(&s);
    assert_eq!(r.dof, free - 4, "{}", r.explanation);
    assert!(r.ok);
}

#[test]
fn partially_redundant_coincidence_is_reported_as_partial() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("p", 0.0, 0.0));
    s.entities.push(Entity::point("r", 5.0, 0.2));
    s.entities.push(Entity::line("pr", "p", "r"));
    add(&mut s, "fp", c::fix("p"));
    add(&mut s, "h", c::horizontal("pr"));
    // r.y = p.y is already implied by `h`; r.x = p.x is new information.
    add(&mut s, "co", c::coincident("r", "p"));
    let r = run(&s);
    assert_eq!(
        r.status,
        SolveStatus::OverConstrainedRedundant,
        "{}",
        r.explanation
    );
    assert_eq!(r.redundant.len(), 1);
    assert_eq!(r.redundant[0].constraint, "co");
    assert!(r.redundant[0].partial);
    assert_eq!(state(&r, "co"), ConstraintState::PartiallyRedundant);
    assert_eq!(r.dof, 0);
}

#[test]
fn constraints_on_fixed_geometry_only_are_redundant_or_conflicting() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("a", 0.0, 0.0).fixed());
    s.entities.push(Entity::point("b", 3.0, 4.0).fixed());
    add(&mut s, "ok", c::distance("a", "b", 5.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::OverConstrainedRedundant);
    assert_eq!(r.redundant[0].constraint, "ok");
    assert!(r.redundant[0].explanation.contains("fixed geometry"));
    add(&mut s, "bad", c::distance("a", "b", 6.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::Conflict);
    assert_eq!(r.conflicts[0].constraints, ["bad"]);
    assert!(
        r.conflicts[0].explanation.contains("fixed geometry"),
        "{}",
        r.conflicts[0].explanation
    );
}

#[test]
fn two_independent_conflicts_in_one_cluster_are_both_reported() {
    let mut s = loose_rectangle();
    add(&mut s, "h0", c::horizontal("L0"));
    add(&mut s, "v1", c::vertical("L1"));
    add(&mut s, "h2", c::horizontal("L2"));
    add(&mut s, "v3", c::vertical("L3"));
    add(&mut s, "w", c::distance("a0", "b0", 10.0));
    add(&mut s, "h", c::distance("a1", "b1", 6.0));
    add(&mut s, "fix", c::fix("a0"));
    add(&mut s, "w_bad", c::distance("a0", "b0", 11.0));
    add(&mut s, "h_bad", c::distance("a1", "b1", 7.0));
    let r = run(&s);
    assert_eq!(r.status, SolveStatus::Conflict, "{}", r.explanation);
    let mut sets: Vec<Vec<String>> = r.conflicts.iter().map(|c| c.constraints.clone()).collect();
    sets.sort();
    assert_eq!(
        sets,
        vec![
            vec!["h".to_owned(), "h_bad".to_owned()],
            vec!["w".to_owned(), "w_bad".to_owned()]
        ]
    );
    assert!(r.conflicts.iter().all(|c| c.verified_minimal));
}

#[test]
fn nonlinear_conflicts_are_isolated_and_starved_solves_never_invent_them() {
    let tri = |d3: f64, max_iterations: usize| {
        let mut s = Sketch::default();
        s.entities.push(Entity::point("a", 0.0, 0.0));
        s.entities.push(Entity::point("b", 5.0, 0.3));
        s.entities.push(Entity::point("c", 2.0, 3.0));
        add(&mut s, "fa", c::fix("a"));
        add(&mut s, "d1", c::distance("a", "b", 3.0));
        add(&mut s, "d2", c::distance("b", "c", 4.0));
        add(&mut s, "d3", c::distance("c", "a", d3));
        solve(
            &s,
            &SolveOptions {
                max_iterations,
                ..SolveOptions::default()
            },
        )
        .expect("valid")
    };
    // Triangle inequality violated (3 + 4 < 10): the three sides conflict, the fix does not.
    let r = tri(10.0, 200);
    assert_eq!(r.status, SolveStatus::Conflict);
    assert_eq!(r.conflicts[0].constraints, ["d1", "d2", "d3"]);
    // A consistent triangle with a starved iteration budget is "failed to converge",
    // never an invented conflict.
    let r = tri(6.0, 1);
    assert_eq!(r.status, SolveStatus::FailedToConverge, "{}", r.explanation);
    assert!(r.conflicts.is_empty() && !r.ok);
    assert!(tri(6.0, 200).ok);
}

#[test]
fn point_on_circle_moves_tangentially() {
    let mut s = Sketch::default();
    s.entities.push(Entity::point("o", 0.0, 0.0).fixed());
    s.entities.push(Entity::circle("C", "o", 5.0).fixed());
    s.entities.push(Entity::point("p", 3.0, 4.2));
    add(&mut s, "on", c::point_on_circle("p", "C"));
    let r = run(&s);
    assert_eq!(r.dof, 1);
    let d = ent(&r, "p").free_direction.expect("one direction");
    let p = match ent(&r, "p").geometry {
        forge_solve::SolvedGeometry::Point { x, y } => [x, y],
        _ => unreachable!(),
    };
    // The minimal-norm solve moves p radially onto the circle, near (3, 4).
    assert!((forge_core::math::hypot(p[0], p[1]) - 5.0).abs() < 1e-10 && (p[0] - 3.0).abs() < 0.2);
    // Its free direction is the tangent ±(p_y, −p_x)/5 (canonical sign: largest
    // component positive).
    assert!(
        (d[0] - p[1] / 5.0).abs() < 1e-9 && (d[1] + p[0] / 5.0).abs() < 1e-9,
        "{d:?} at {p:?}"
    );
}
