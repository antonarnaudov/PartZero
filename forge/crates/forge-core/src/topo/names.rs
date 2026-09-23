//! Entity names for messages that leave the process.
//!
//! Arena ids are process-local and body-local: their `Debug` form (`Face#3v0`, see
//! [`crate::arena::Id`]) depends on construction order and on the compiler's type names,
//! so it must never reach a report. [`TopoIssue`]'s `Display` and the messages of
//! [`validate`](fn@super::validate) use that form; they are for in-process logs only.
//! Anything that leaves the process is named here instead:
//! - with the body at hand, [`EntityNames`] gives every entity a stable name: a face, edge
//!   or vertex its [`Provenance::name`](super::Provenance::name), a loop
//!   `loop of <face>`, a coedge `coedge of <edge>`, a shell (which has no provenance) its
//!   ordinal and first face, `shell <k> (<face>)`;
//! - without it (the body is gone), [`scrub_arena_ids`] replaces each id by its kind
//!   (`an edge`), a last-resort backstop.

use std::collections::BTreeMap;

use super::entities::{Body, ShellId};
use super::validate::{EntityRef, TopoIssue};

/// A shell's name: its ordinal among [`Body::shell_ids`] and its first face's provenance
/// (shells have no provenance of their own).
pub fn shell_name(body: &Body, sid: ShellId) -> String {
    let Some(shell) = body.shell(sid) else {
        return "a stale shell id".to_string();
    };
    let first = shell
        .faces
        .first()
        .and_then(|&f| body.face(f))
        .map(|f| f.provenance.name());
    let ordinal = body.shell_ids().iter().position(|&s| s == sid);
    match (ordinal, first) {
        (Some(k), Some(f)) => format!("shell {k} ({f})"),
        (Some(k), None) => format!("shell {k}"),
        (None, Some(f)) => format!("an unlisted shell ({f})"),
        (None, None) => "an unlisted shell".to_string(),
    }
}

/// The stable name of an entity (a face, edge or vertex its provenance, a loop or coedge
/// that of its face or edge, a shell [`shell_name`]); `None` for
/// [`EntityRef::Body`] and for an id that is not live in `body`.
pub fn entity_name(body: &Body, e: EntityRef) -> Option<String> {
    match e {
        EntityRef::Face(id) => body.face(id).map(|f| f.provenance.name()),
        EntityRef::Edge(id) => body.edge(id).map(|x| x.provenance.name()),
        EntityRef::Vertex(id) => body.vertex(id).map(|x| x.provenance.name()),
        EntityRef::Loop(id) => body
            .loop_(id)
            .and_then(|l| body.face(l.face))
            .map(|f| format!("loop of {}", f.provenance.name())),
        EntityRef::Coedge(id) => body
            .coedge(id)
            .and_then(|c| body.edge(c.edge))
            .map(|e| format!("coedge of {}", e.provenance.name())),
        EntityRef::Shell(id) => body.shell(id).map(|_| shell_name(body, id)),
        EntityRef::Body => None,
    }
}

/// The names of every live entity of a body, keyed by the `Debug` form of its arena id,
/// to turn in-process messages into ones that may leave the process.
#[derive(Clone, Debug)]
pub struct EntityNames(BTreeMap<String, String>);

impl EntityNames {
    /// Name every live entity of `body`.
    pub fn new(body: &Body) -> Self {
        let mut m = BTreeMap::new();
        let mut put = |k: String, e: EntityRef| {
            if let Some(n) = entity_name(body, e) {
                m.insert(k, n);
            }
        };
        for (id, _) in body.shells().iter() {
            put(format!("{id:?}"), EntityRef::Shell(id));
        }
        for (id, _) in body.faces().iter() {
            put(format!("{id:?}"), EntityRef::Face(id));
        }
        for (id, _) in body.loops().iter() {
            put(format!("{id:?}"), EntityRef::Loop(id));
        }
        for (id, _) in body.coedges().iter() {
            put(format!("{id:?}"), EntityRef::Coedge(id));
        }
        for (id, _) in body.edges().iter() {
            put(format!("{id:?}"), EntityRef::Edge(id));
        }
        for (id, _) in body.vertices().iter() {
            put(format!("{id:?}"), EntityRef::Vertex(id));
        }
        Self(m)
    }

    /// `text` with every arena id (and its `EntityRef` wrapper, `Edge(Edge#3v0)`)
    /// replaced by the entity's name; an id that is not live becomes `a stale <kind> id`.
    pub fn rewrite(&self, text: &str) -> String {
        replace_arena_ids(text, |kind, token| match self.0.get(token) {
            Some(name) => name.clone(),
            None => format!("a stale {} id", kind.to_ascii_lowercase()),
        })
    }

    /// The name of the entity an issue is about ("the body" for [`EntityRef::Body`]).
    pub fn entity(&self, e: EntityRef) -> String {
        match e {
            EntityRef::Body => "the body".to_string(),
            e => self.rewrite(&format!("{e:?}")),
        }
    }

    /// An issue as `[CODE] <entity>: <message>`, like its `Display`, with every entity
    /// named instead of identified.
    pub fn describe(&self, issue: &TopoIssue) -> String {
        format!(
            "[{}] {}: {}",
            issue.code.as_str(),
            self.entity(issue.entity),
            self.rewrite(&issue.message)
        )
    }
}

/// `text` with every arena id (`Kind#<index>v<generation>`, optionally wrapped as
/// `Kind(…)`) replaced by `a <kind>` / `an <kind>`, e.g. `[EDGE_USE_COUNT]
/// Edge(Edge#3v0): …` → `[EDGE_USE_COUNT] an edge: …`.
///
/// The backstop for text that reaches a report from where the body is gone; with the body
/// at hand, use [`EntityNames`], which keeps which entity is meant.
pub fn scrub_arena_ids(text: &str) -> String {
    replace_arena_ids(text, |kind, _| {
        let kind = kind.to_ascii_lowercase();
        let article = if kind.starts_with(['a', 'e', 'i', 'o', 'u']) {
            "an"
        } else {
            "a"
        };
        format!("{article} {kind}")
    })
}

/// `text` with every arena id replaced by `name(kind, token)`: a token is the `Debug` form
/// of an id, `Kind#<index>v<generation>` (e.g. `Coedge#3v0`, kind `Coedge`), and an
/// enclosing `Kind(…)` of the same kind (the `Debug` form of [`EntityRef`], e.g.
/// `Edge(Edge#3v0)`) is replaced with it.
fn replace_arena_ids(text: &str, name: impl Fn(&str, &str) -> String) -> String {
    let b = text.as_bytes();
    let digits = |mut j: usize| {
        let s = j;
        while j < b.len() && b[j].is_ascii_digit() {
            j += 1;
        }
        (j > s).then_some(j)
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i < b.len() {
        if b[i] == b'#' {
            // Kind: the ASCII letters before '#'.
            let mut k = i;
            while k > copied && b[k - 1].is_ascii_alphabetic() {
                k -= 1;
            }
            if k < i
                && let Some(j) = digits(i + 1)
                && j < b.len()
                && b[j] == b'v'
                && let Some(end) = digits(j + 1)
            {
                let kind = &text[k..i];
                let token = &text[k..end];
                // `Kind(Kind#…)`: the wrapper goes too.
                let wrapped = k > copied + kind.len()
                    && b[k - 1] == b'('
                    && &text[k - 1 - kind.len()..k - 1] == kind
                    && (k - 1 - kind.len() == 0 || !b[k - 2 - kind.len()].is_ascii_alphabetic())
                    && b.get(end) == Some(&b')');
                let (from, to) = if wrapped {
                    (k - 1 - kind.len(), end + 1)
                } else {
                    (k, end)
                };
                out.push_str(&text[copied..from]);
                out.push_str(&name(kind, token));
                copied = to;
                i = to;
                continue;
            }
        }
        i += 1;
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::super::{BodyBuilder, Provenance, Severity, samples, validate};
    use super::*;
    use crate::Tolerance;

    /// Any `Kind#<digits>v<digits>` left in `s`.
    fn has_arena_id(s: &str) -> bool {
        let b = s.as_bytes();
        (0..b.len()).any(|i| {
            b[i] == b'#' && i > 0 && b[i - 1].is_ascii_alphabetic() && {
                let mut j = i + 1;
                while j < b.len() && b[j].is_ascii_digit() {
                    j += 1;
                }
                j > i + 1 && b.get(j) == Some(&b'v')
            }
        })
    }

    #[test]
    fn arena_ids_in_messages_become_entity_names() {
        let cube = samples::unit_cube();
        let names = EntityNames::new(&cube);
        let (fid, face) = cube.faces().iter().next().expect("face");
        let (eid, edge) = cube.edges().iter().next().expect("edge");
        let sid = cube.shell_ids()[0];
        let text = format!("{fid:?} meets {eid:?} in {sid:?}; Vertex#999v7 is gone");
        let out = names.rewrite(&text);
        assert_eq!(
            out,
            format!(
                "{} meets {} in {}; a stale vertex id is gone",
                face.provenance.name(),
                edge.provenance.name(),
                shell_name(&cube, sid)
            )
        );
        assert!(!has_arena_id(&out), "{out}");
        assert_eq!(
            shell_name(&cube, sid),
            format!("shell 0 ({})", face.provenance.name())
        );
        // Text without ids is unchanged, including a lone '#'.
        assert_eq!(names.rewrite("# of loops: 3"), "# of loops: 3");
        // The `EntityRef` Debug form `Kind(Kind#…)` is replaced as a whole.
        assert_eq!(
            names.rewrite(&format!("[X] Edge({eid:?}): y")),
            format!("[X] {}: y", edge.provenance.name())
        );
        assert_eq!(names.entity(EntityRef::Edge(eid)), edge.provenance.name());
        assert_eq!(names.entity(EntityRef::Body), "the body");
    }

    #[test]
    fn scrubbed_messages_carry_no_arena_ids() {
        assert_eq!(
            scrub_arena_ids("[EDGE_USE_COUNT] Edge(Edge#3v0): used by Coedge#7v2 and Face#0v0"),
            "[EDGE_USE_COUNT] an edge: used by a coedge and a face"
        );
        assert_eq!(scrub_arena_ids("Shell(Shell#0v1)"), "a shell");
        // A wrapper of another kind stays; text without ids is unchanged.
        assert_eq!(scrub_arena_ids("Loop(Face#2v0)"), "Loop(a face)");
        assert_eq!(scrub_arena_ids("# of loops: 3; C#5"), "# of loops: 3; C#5");
    }

    /// Audit L3: an issue described with the body at hand names its entities by
    /// provenance, where its `Display` (for in-process logs) shows arena ids.
    #[test]
    fn described_issues_name_entities_by_provenance() {
        // A unit cube with a second copy of one face: its four edges are used three times.
        let cube = samples::unit_cube();
        let (_, f) = cube.faces().iter().next().expect("face");
        let uses: Vec<_> = cube
            .loop_(f.loops[0])
            .expect("loop")
            .coedges
            .iter()
            .map(|&c| {
                let c = cube.coedge(c).expect("coedge");
                (c.edge, c.forward)
            })
            .collect();
        let (surface, sense, shell) = (f.surface.clone(), f.sense, f.shell);
        let mut bb = BodyBuilder::from_body(cube, Tolerance::IR_DEFAULT);
        let dup = bb
            .add_face(shell, surface, sense, Provenance::side("dup", "a"))
            .expect("face");
        bb.add_loop(dup, &uses).expect("loop");
        let body = bb.finish();
        let issues: Vec<_> = validate(&body)
            .into_iter()
            .filter(|i| i.severity == Severity::Error)
            .collect();
        assert!(!issues.is_empty());
        let names = EntityNames::new(&body);
        for i in &issues {
            assert!(has_arena_id(&i.to_string()), "Display keeps ids: {i}");
            let d = names.describe(i);
            assert!(!has_arena_id(&d), "{d}");
            let e = names.entity(i.entity);
            if i.entity != EntityRef::Body {
                assert_eq!(Some(&e), entity_name(&body, i.entity).as_ref());
            }
            assert!(
                d.starts_with(&format!("[{}] {e}: ", i.code.as_str())),
                "{d}"
            );
        }
    }
}
