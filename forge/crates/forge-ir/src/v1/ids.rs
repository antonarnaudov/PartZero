//! Identifier grammar (SPEC-v1 §0.3, [W0-12]).
//!
//! Every author-chosen id and name — part ids and names, feature ids and names, parameter
//! names, curve and point ids, constraint ids, hole position ids, query role labels — matches
//! [`ID_PATTERN`] (`[A-Za-z_][A-Za-z0-9_]*`, 1 to [`MAX_ID_LEN`] bytes). Strings that *refer* to
//! ids may add up to two `.`-separated segments for derived and member ids (`l.start`,
//! `outline.bottom`, `outline.c_br.start`), see [`is_ref`].
//!
//! Why: ids flow into provenance keys (whose grammar reserves `/ : { } | + # @ %`) and, through
//! reports and error messages, into LLM prompts; unrestricted ids were shown to inject control
//! lines into the orchestrator. Validation never echoes a string that fails this grammar.

/// The id grammar as a regular expression (for the TS and Python ports).
pub const ID_PATTERN: &str = "^[A-Za-z_][A-Za-z0-9_]*$";
/// Maximum id or name length in bytes.
pub const MAX_ID_LEN: usize = 64;
/// Maximum number of `.`-separated segments in a reference (`outline.c_br.start`).
pub const MAX_REF_SEGMENTS: usize = 3;

/// Why a string is not an id.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdProblem {
    Empty,
    TooLong,
    Charset,
}

impl IdProblem {
    pub fn as_str(self) -> &'static str {
        match self {
            IdProblem::Empty => "empty",
            IdProblem::TooLong => "too-long",
            IdProblem::Charset => "charset",
        }
    }
}

/// Check one id or name.
pub fn check_id(s: &str) -> Result<(), IdProblem> {
    if s.is_empty() {
        return Err(IdProblem::Empty);
    }
    let b = s.as_bytes();
    if !(b[0] == b'_' || b[0].is_ascii_alphabetic())
        || !b.iter().all(|c| *c == b'_' || c.is_ascii_alphanumeric())
    {
        return Err(IdProblem::Charset);
    }
    if s.len() > MAX_ID_LEN {
        return Err(IdProblem::TooLong);
    }
    Ok(())
}

/// `true` when `s` is a valid id or name.
pub fn is_id(s: &str) -> bool {
    check_id(s).is_ok()
}

/// Check a reference to an id: 1 to [`MAX_REF_SEGMENTS`] ids joined by `.`.
pub fn check_ref(s: &str) -> Result<(), IdProblem> {
    if s.is_empty() {
        return Err(IdProblem::Empty);
    }
    let segs: Vec<&str> = s.split('.').collect();
    if segs.len() > MAX_REF_SEGMENTS {
        return Err(IdProblem::Charset);
    }
    segs.into_iter().try_for_each(check_id)
}

/// `true` when `s` is a valid reference.
pub fn is_ref(s: &str) -> bool {
    check_ref(s).is_ok()
}

/// `s` if it is a valid reference, else a placeholder: what messages and details may show.
pub fn shown(s: &str) -> String {
    if is_ref(s) {
        s.to_string()
    } else {
        "<invalid id>".to_string()
    }
}

/// The deterministic rewrite of a string into an id (migration, [W0-12]): every character
/// outside `[A-Za-z0-9_]` becomes `_`; a leading digit or an empty result gets a `_` prefix;
/// the result is cut to [`MAX_ID_LEN`] bytes.
pub fn sanitize(s: &str) -> String {
    let mut t: String = s
        .chars()
        .map(|c| {
            if c == '_' || c.is_ascii_alphanumeric() {
                c
            } else {
                '_'
            }
        })
        .collect();
    if t.is_empty() || t.as_bytes()[0].is_ascii_digit() {
        t.insert(0, '_');
    }
    t.truncate(MAX_ID_LEN);
    t
}

/// `base` if it is not taken, else `base` (cut to fit) + `_2`, `_3`, … — the first free one.
pub fn unique(base: &str, taken: &std::collections::BTreeSet<String>) -> String {
    if !taken.contains(base) {
        return base.to_string();
    }
    (2u64..)
        .map(|k| {
            let suffix = format!("_{k}");
            let mut b = base.to_string();
            b.truncate(MAX_ID_LEN - suffix.len());
            b + &suffix
        })
        .find(|c| !taken.contains(c))
        .expect("an unused suffix exists")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grammar() {
        for ok in ["a", "_", "A_1", "line_04", &"x".repeat(64)] {
            assert!(is_id(ok), "{ok}");
        }
        for (bad, why) in [
            ("", IdProblem::Empty),
            ("1a", IdProblem::Charset),
            ("a-b", IdProblem::Charset),
            ("a/b", IdProblem::Charset),
            ("a b", IdProblem::Charset),
            ("é", IdProblem::Charset),
            ("a.b", IdProblem::Charset),
            ("x\ny", IdProblem::Charset),
        ] {
            assert_eq!(check_id(bad), Err(why), "{bad:?}");
        }
        assert_eq!(check_id(&"x".repeat(65)), Err(IdProblem::TooLong));
        assert!(is_ref("outline.c_br.start"));
        assert!(!is_ref("a.b.c.d"));
        assert!(!is_ref("a..b"));
        assert!(!is_ref(".a"));
    }

    #[test]
    fn sanitize_and_unique_are_deterministic() {
        assert_eq!(sanitize("a-b c"), "a_b_c");
        assert_eq!(sanitize(""), "_");
        assert_eq!(sanitize("1st"), "_1st");
        assert_eq!(sanitize("höhe"), "h_he");
        assert_eq!(sanitize(&"y".repeat(70)).len(), 64);
        let taken: std::collections::BTreeSet<String> =
            ["a_b".to_string(), "a_b_2".to_string()].into();
        assert_eq!(unique("a_b", &taken), "a_b_3");
        assert_eq!(unique("free", &taken), "free");
        let long = "z".repeat(64);
        let taken: std::collections::BTreeSet<String> = [long.clone()].into();
        let u = unique(&long, &taken);
        assert_eq!(u.len(), 64);
        assert!(u.ends_with("_2"));
    }
}
