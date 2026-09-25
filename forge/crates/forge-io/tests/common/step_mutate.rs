//! Mutations of written STEP files for the verifier's negative tests: inside-out faces and
//! shells that keep every edge used twice in opposite directions.

/// Toggle `same_sense` of the `k`-th `ADVANCED_FACE` (its loops stay as they are).
pub fn flip_face(text: &str, k: usize) -> String {
    let mut seen = 0;
    text.lines()
        .map(|l| {
            if l.contains("=ADVANCED_FACE(") {
                seen += 1;
                if seen == k + 1 {
                    return toggle_flag(l);
                }
            }
            l.to_string()
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Toggle the trailing `.T.`/`.F.` of one entity line.
fn toggle_flag(line: &str) -> String {
    if let Some(head) = line.strip_suffix(",.T.);") {
        format!("{head},.F.);")
    } else if let Some(head) = line.strip_suffix(",.F.);") {
        format!("{head},.T.);")
    } else {
        panic!("no trailing flag: {line}")
    }
}

/// Turn every face inside out consistently: every `same_sense` and every bound's
/// orientation toggled. Every edge is still used twice in opposite directions and every
/// face is consistent with its loops; only the shell's enclosed volume tells.
pub fn invert_shells(text: &str) -> String {
    text.lines()
        .map(|l| {
            if l.contains("=ADVANCED_FACE(")
                || l.contains("=FACE_OUTER_BOUND(")
                || l.contains("=FACE_BOUND(")
            {
                toggle_flag(l)
            } else {
                l.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}
