//! Provenance: where a face, edge or vertex came from, and its persistent name.

use smallvec::SmallVec;

/// The role an entity plays in the feature that created it.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Role {
    /// Extrude: the face at the start of the sweep (the sketch region itself).
    CapStart,
    /// Extrude: the face at the end of the sweep.
    CapEnd,
    /// A face swept from sketch curves (`sources` = the curve ids).
    Side,
    /// Revolve (< 360°): the planar end cap at the start angle.
    EndCapStart,
    /// Revolve (< 360°): the planar end cap at the end angle.
    EndCapEnd,
    /// An edge where faces meet (`sources` = the names of the two faces).
    EdgeBetween,
    /// A vertex where entities meet (`sources` = the names of the faces, or edges, that
    /// define it).
    VertexAt,
    /// An entity read from an external file (`sources` = identifiers from that file).
    Imported,
    /// Any other role; the label becomes the role part of the name.
    Other(String),
}

/// Characters that may not appear in feature names, `Role::Other` labels and leaf
/// sources (sketch curve ids, import ids), because they delimit the name grammar.
pub const RESERVED_NAME_CHARS: &[char] = &['/', ':', '{', '}', '|', '+', '#'];

/// Where an entity came from. Every face, edge and vertex carries one.
///
/// Provenance is the **only** persistent identity of topology: arena ids are
/// process-local. [`Provenance::name`] renders the canonical, deterministic name.
///
/// # Name grammar
/// ```text
/// name   := feature "/" role [ "#" index ]        ; "#index" only when index > 0
/// role   := "cap:start" | "cap:end"               ; CapStart, CapEnd
///         | "endcap:start" | "endcap:end"         ; EndCapStart, EndCapEnd
///         | "side" [ ":" leaves ]                 ; Side
///         | "edge:{" names "}"                    ; EdgeBetween
///         | "vertex:{" names "}"                  ; VertexAt
///         | "imported" [ ":" leaves ]             ; Imported
///         | label [ ":" leaves ]                  ; Other(label)
/// leaves := leaf ( "+" leaf )*                    ; sources, sorted
/// names  := name ( "|" name )*                    ; sources (entity names), sorted
/// ```
/// Sources are always **sorted** (byte-wise) before rendering, so the name does not
/// depend on the order in which an operation discovered them. Cap roles do not render
/// their sources (they are metadata, e.g. the region's curves). Feature names, labels and
/// leaf sources must not contain [`RESERVED_NAME_CHARS`]; `EdgeBetween`/`VertexAt`
/// sources are full names and may contain them (they are brace-delimited).
///
/// Examples: `plate/cap:end`, `plate/side:bottom`,
/// `plate/edge:{plate/cap:end|plate/side:bottom}`.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Provenance {
    /// Name of the feature that created the entity (the CadScript `const` name).
    pub feature: String,
    /// Role within that feature.
    pub role: Role,
    /// Source identifiers (see [`Role`] for what they mean per role).
    pub sources: SmallVec<[String; 2]>,
    /// Disambiguating instance index (0 = the only / first instance).
    pub index: u32,
}

impl Provenance {
    /// Provenance with no sources and index 0.
    pub fn new(feature: impl Into<String>, role: Role) -> Self {
        Self {
            feature: feature.into(),
            role,
            sources: SmallVec::new(),
            index: 0,
        }
    }
    /// Replace the sources.
    pub fn with_sources<I, T>(mut self, sources: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<String>,
    {
        self.sources = sources.into_iter().map(Into::into).collect();
        self
    }
    /// Set the instance index.
    pub fn with_index(mut self, index: u32) -> Self {
        self.index = index;
        self
    }
    /// `feature/cap:start`.
    pub fn cap_start(feature: impl Into<String>) -> Self {
        Self::new(feature, Role::CapStart)
    }
    /// `feature/cap:end`.
    pub fn cap_end(feature: impl Into<String>) -> Self {
        Self::new(feature, Role::CapEnd)
    }
    /// `feature/side:<curve>`.
    pub fn side(feature: impl Into<String>, curve: impl Into<String>) -> Self {
        Self::new(feature, Role::Side).with_sources([curve])
    }
    /// `feature/endcap:start`.
    pub fn end_cap_start(feature: impl Into<String>) -> Self {
        Self::new(feature, Role::EndCapStart)
    }
    /// `feature/endcap:end`.
    pub fn end_cap_end(feature: impl Into<String>) -> Self {
        Self::new(feature, Role::EndCapEnd)
    }
    /// `feature/edge:{a|b}` for the edge between the faces named `a` and `b`.
    pub fn edge_between(
        feature: impl Into<String>,
        face_a: impl Into<String>,
        face_b: impl Into<String>,
    ) -> Self {
        Self::new(feature, Role::EdgeBetween).with_sources([face_a.into(), face_b.into()])
    }
    /// `feature/vertex:{…}` for the vertex defined by the named entities.
    pub fn vertex_at<I, T>(feature: impl Into<String>, names: I) -> Self
    where
        I: IntoIterator<Item = T>,
        T: Into<String>,
    {
        Self::new(feature, Role::VertexAt).with_sources(names)
    }

    fn sorted_sources(&self) -> Vec<&str> {
        let mut s: Vec<&str> = self.sources.iter().map(String::as_str).collect();
        s.sort_unstable();
        s
    }

    /// The canonical persistent name (see the grammar in the type docs).
    pub fn name(&self) -> String {
        let leaves = |sep: &str| self.sorted_sources().join(sep);
        let with_leaves = |tag: &str| {
            if self.sources.is_empty() {
                tag.to_string()
            } else {
                format!("{tag}:{}", leaves("+"))
            }
        };
        let role = match &self.role {
            Role::CapStart => "cap:start".to_string(),
            Role::CapEnd => "cap:end".to_string(),
            Role::EndCapStart => "endcap:start".to_string(),
            Role::EndCapEnd => "endcap:end".to_string(),
            Role::Side => with_leaves("side"),
            Role::EdgeBetween => format!("edge:{{{}}}", leaves("|")),
            Role::VertexAt => format!("vertex:{{{}}}", leaves("|")),
            Role::Imported => with_leaves("imported"),
            Role::Other(label) => with_leaves(label),
        };
        if self.index > 0 {
            format!("{}/{}#{}", self.feature, role, self.index)
        } else {
            format!("{}/{}", self.feature, role)
        }
    }

    /// Problems that make the name ambiguous or unparseable, as human-readable strings
    /// (empty if well-formed). Used by [`crate::topo::validate`].
    pub fn problems(&self) -> Vec<String> {
        let mut out = Vec::new();
        let reserved = |s: &str| s.contains(RESERVED_NAME_CHARS);
        if self.feature.is_empty() {
            out.push("empty feature name".to_string());
        } else if reserved(&self.feature) {
            out.push(format!(
                "feature name {:?} contains a reserved character",
                self.feature
            ));
        }
        match &self.role {
            Role::Other(label) if label.is_empty() || reserved(label) => {
                out.push(format!(
                    "role label {label:?} is empty or contains a reserved character"
                ));
            }
            _ => {}
        }
        let leaf_sources = matches!(self.role, Role::Side | Role::Imported | Role::Other(_));
        if leaf_sources {
            if let Some(s) = self.sources.iter().find(|s| s.is_empty() || reserved(s)) {
                out.push(format!(
                    "source {s:?} is empty or contains a reserved character"
                ));
            }
        } else if let Some(s) = self.sources.iter().find(|s| s.is_empty()) {
            out.push(format!("source {s:?} is empty"));
        }
        match self.role {
            Role::Side if self.sources.is_empty() => {
                out.push("side role needs at least one source curve".into())
            }
            Role::EdgeBetween if self.sources.len() != 2 => {
                out.push(format!(
                    "edge role needs exactly 2 face names, got {}",
                    self.sources.len()
                ));
            }
            Role::VertexAt if self.sources.is_empty() => {
                out.push("vertex role needs at least one source".into())
            }
            _ => {}
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_names_match_spec_examples() {
        let cap = Provenance::cap_end("plate");
        let side = Provenance::side("plate", "bottom");
        assert_eq!(cap.name(), "plate/cap:end");
        assert_eq!(side.name(), "plate/side:bottom");
        let e = Provenance::edge_between("plate", side.name(), cap.name());
        assert_eq!(e.name(), "plate/edge:{plate/cap:end|plate/side:bottom}");
        assert!(e.problems().is_empty());
    }

    #[test]
    fn names_are_independent_of_source_order_and_show_index() {
        let a = Provenance::vertex_at("b", ["z", "a", "m"]);
        let b = Provenance::vertex_at("b", ["m", "z", "a"]);
        assert_eq!(a.name(), b.name());
        assert_eq!(a.name(), "b/vertex:{a|m|z}");
        assert_eq!(
            Provenance::cap_start("x").with_index(2).name(),
            "x/cap:start#2"
        );
        assert_eq!(Provenance::new("r", Role::EndCapEnd).name(), "r/endcap:end");
        assert_eq!(
            Provenance::new("imp", Role::Imported).name(),
            "imp/imported"
        );
        assert_eq!(
            Provenance::new("f", Role::Other("fillet".into()))
                .with_sources(["e1"])
                .name(),
            "f/fillet:e1"
        );
    }

    #[test]
    fn malformed_provenance_is_reported() {
        assert!(!Provenance::cap_end("").problems().is_empty());
        assert!(!Provenance::cap_end("a/b").problems().is_empty());
        assert!(!Provenance::side("p", "c+d").problems().is_empty());
        assert!(
            !Provenance::new("p", Role::EdgeBetween)
                .with_sources(["only-one"])
                .problems()
                .is_empty()
        );
        assert!(!Provenance::new("p", Role::Side).problems().is_empty());
    }
}
