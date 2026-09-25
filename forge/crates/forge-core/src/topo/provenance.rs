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
    /// An operation role whose `sources` are the **keys** of the entities the new entity was
    /// derived from (SPEC-v1 §5.2 rule 3: `blend:{E}`, `bevel:{E}`, `corner:{V}`,
    /// `offset:{X}`, `rim:{X}`, `copy:{K}`). Rendered `label:{k|…}` (sources verbatim,
    /// sorted) in both [`Provenance::name`] and [`Provenance::key`]; the label is escaped in
    /// the key like any id.
    Derived(String),
}

/// Characters that may not appear in feature names, `Role::Other` labels and leaf
/// sources (sketch curve ids, import ids), because they delimit the name grammar.
pub const RESERVED_NAME_CHARS: &[char] = &['/', ':', '{', '}', '|', '+', '#'];

/// Characters that an id is escaped for when it is rendered into a provenance **key**
/// (IR v1, SPEC-v1 §5.2 rule 5): the delimiters of the key grammar, [`RESERVED_NAME_CHARS`]
/// plus `@` (the qualifier separator) and `%` (the escape character itself). Every UTF-8
/// byte of such a character, and of any whitespace character, is written as `%XX`
/// (upper-case hex). `.` is **not** escaped (compound members render as `outline.bottom`).
pub const KEY_ESCAPED_CHARS: &[char] = &['/', ':', '{', '}', '|', '+', '#', '@', '%'];

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
///         | label ":{" names "}"                  ; Derived(label): sources are keys
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
    /// IR v1 key qualifier (SPEC-v1 §5.2 rule 1): the body member of a cap (`m`), the
    /// junction curve end of a side–side edge (`c.end`), a hole position, a pattern
    /// instance. Part of [`Provenance::key`], never of the v0 [`Provenance::name`].
    pub qualifier: Option<String>,
}

impl Provenance {
    /// Provenance with no sources, index 0 and no qualifier.
    pub fn new(feature: impl Into<String>, role: Role) -> Self {
        Self {
            feature: feature.into(),
            role,
            sources: SmallVec::new(),
            index: 0,
            qualifier: None,
        }
    }
    /// Set the IR v1 key qualifier (see [`Provenance::qualifier`]).
    pub fn with_qualifier(mut self, qualifier: impl Into<String>) -> Self {
        self.qualifier = Some(qualifier.into());
        self
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
            Role::Derived(label) => format!("{label}:{{{}}}", leaves("|")),
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
            Role::Other(label) | Role::Derived(label) if label.is_empty() || reserved(label) => {
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
            Role::Derived(_) if self.sources.is_empty() => {
                out.push("derived role needs at least one source key".into())
            }
            _ => {}
        }
        out
    }

    /// The role label of the key grammar: `cap`, `endcap`, `side`, `edge`, `vertex`,
    /// `imported`, or the [`Role::Other`] label (what a v1 `created { role }` query matches).
    pub fn role_label(&self) -> &str {
        match &self.role {
            Role::CapStart | Role::CapEnd => "cap",
            Role::EndCapStart | Role::EndCapEnd => "endcap",
            Role::Side => "side",
            Role::EdgeBetween => "edge",
            Role::VertexAt => "vertex",
            Role::Imported => "imported",
            Role::Other(label) | Role::Derived(label) => label,
        }
    }

    /// The IR v1 **provenance key** (SPEC-v1 §5.2):
    /// ```text
    /// key  := fid "/" role [ "@" qual ]      ; "#index" is never part of a key
    /// ```
    /// with the feature id and every leaf escaped ([`escape_key_id`]), `EdgeBetween` /
    /// `VertexAt` sources rendered **verbatim** (they must already be keys) and sorted
    /// byte-wise, and the [`Provenance::qualifier`] escaped the same way (`.` stays).
    ///
    /// Operations that stored face *names* as the sources of edges and vertices (the v0
    /// convention) use [`Provenance::key_with_sources`] with the faces' keys instead.
    pub fn key(&self) -> String {
        let sources: Vec<String> = self.sources.iter().cloned().collect();
        self.key_with_sources(&sources)
    }

    /// [`Provenance::key`] with `sources` in place of [`Provenance::sources`] (for
    /// `EdgeBetween` / `VertexAt`: the keys of the entities the stored names designate).
    pub fn key_with_sources(&self, sources: &[String]) -> String {
        let leaves = || {
            let mut s: Vec<String> = sources.iter().map(|x| escape_key_id(x)).collect();
            s.sort_unstable();
            s.join("+")
        };
        let with_leaves = |tag: &str| {
            if sources.is_empty() {
                tag.to_string()
            } else {
                format!("{tag}:{}", leaves())
            }
        };
        let keys = || {
            let mut s: Vec<&str> = sources.iter().map(String::as_str).collect();
            s.sort_unstable();
            s.join("|")
        };
        let role = match &self.role {
            Role::CapStart => "cap:start".to_string(),
            Role::CapEnd => "cap:end".to_string(),
            Role::EndCapStart => "endcap:start".to_string(),
            Role::EndCapEnd => "endcap:end".to_string(),
            Role::Side => with_leaves("side"),
            Role::EdgeBetween => format!("edge:{{{}}}", keys()),
            Role::VertexAt => format!("vertex:{{{}}}", keys()),
            Role::Imported => with_leaves("imported"),
            Role::Other(label) => with_leaves(&escape_key_id(label)),
            Role::Derived(label) => format!("{}:{{{}}}", escape_key_id(label), keys()),
        };
        let mut out = format!("{}/{role}", escape_key_id(&self.feature));
        if let Some(q) = &self.qualifier {
            out.push('@');
            out.push_str(&escape_key_id(q));
        }
        out
    }
}

/// Escape an id for a provenance key (SPEC-v1 §5.2 rule 5): every UTF-8 byte of a
/// [`KEY_ESCAPED_CHARS`] character or of a whitespace character becomes `%XX` (upper-case
/// hex); everything else, including `.`, is kept. Ids of the v1 id grammar
/// (`[A-Za-z_][A-Za-z0-9_]*`, joined by `.`) are returned unchanged.
pub fn escape_key_id(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for c in id.chars() {
        if KEY_ESCAPED_CHARS.contains(&c) || c.is_whitespace() {
            let mut buf = [0u8; 4];
            for b in c.encode_utf8(&mut buf).bytes() {
                out.push('%');
                out.push_str(&format!("{b:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

/// Invert [`escape_key_id`]; `None` for a malformed `%` escape or bytes that are not UTF-8.
pub fn unescape_key_id(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = s.get(i + 1..i + 3)?;
            if !hex
                .bytes()
                .all(|h| h.is_ascii_digit() || (b'A'..=b'F').contains(&h))
            {
                return None;
            }
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// The argument of a key's role.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum KeyRoleArg {
    /// No argument (`H/wall@p`).
    None,
    /// `:leaf` — e.g. `start` of `cap:start`, the curve of `side:c` (unescaped).
    Leaf(String),
    /// `:leaf+leaf…` — several leaves (sorted in the key; unescaped).
    Leaves(Vec<String>),
    /// `:{k|k…}` — the nested keys of `edge:{…}`, `vertex:{…}`, `blend:{…}`, in order.
    Keys(Vec<String>),
}

/// A provenance key split into its parts (see [`parse_key`]).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct KeyParts {
    /// The feature id (unescaped).
    pub feature: String,
    /// The role label (`cap`, `side`, `edge`, `wall`, …; unescaped).
    pub label: String,
    /// The role argument.
    pub arg: KeyRoleArg,
    /// The qualifier after `@` (unescaped).
    pub qualifier: Option<String>,
}

impl KeyParts {
    /// Render back to a key (the inverse of [`parse_key`]): the feature, label, leaf and
    /// qualifier escaped with [`escape_key_id`]; nested keys verbatim, in the given order.
    pub fn render(&self) -> String {
        let mut out = format!(
            "{}/{}",
            escape_key_id(&self.feature),
            escape_key_id(&self.label)
        );
        match &self.arg {
            KeyRoleArg::None => {}
            KeyRoleArg::Leaf(l) => {
                out.push(':');
                out.push_str(&escape_key_id(l));
            }
            KeyRoleArg::Leaves(ls) => {
                let ls: Vec<String> = ls.iter().map(|l| escape_key_id(l)).collect();
                out.push(':');
                out.push_str(&ls.join("+"));
            }
            KeyRoleArg::Keys(ks) => {
                out.push_str(":{");
                out.push_str(&ks.join("|"));
                out.push('}');
            }
        }
        if let Some(q) = &self.qualifier {
            out.push('@');
            out.push_str(&escape_key_id(q));
        }
        out
    }
}

/// Why a string is not a provenance key.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("malformed provenance key at byte {at}: {what}")]
pub struct KeyParseError {
    /// Byte offset of the problem.
    pub at: usize,
    /// What is wrong.
    pub what: &'static str,
}

/// Parse a provenance key (the inverse of [`Provenance::key`] up to the role enum):
/// `fid "/" label [ ":" ( leaf | "{" key ( "|" key )* "}" ) ] [ "@" qual ]`. Nested keys
/// are returned verbatim (parse them again to descend). `#` is not part of any key and is
/// rejected.
pub fn parse_key(key: &str) -> Result<KeyParts, KeyParseError> {
    let err = |at: usize, what: &'static str| KeyParseError { at, what };
    // An escaped segment holds no raw delimiter (only `%XX` escapes of them).
    let raw = |s: &str| {
        !s.contains(|c: char| (KEY_ESCAPED_CHARS.contains(&c) && c != '%') || c.is_whitespace())
    };
    let seg = |s: &str, at: usize, what: &'static str| {
        if raw(s) {
            unescape_key_id(s).ok_or(err(at, what))
        } else {
            Err(err(at, "unescaped delimiter"))
        }
    };
    let slash = key.find('/').ok_or(err(0, "no '/' after the feature id"))?;
    let feature = seg(&key[..slash], 0, "bad escape in feature id")?;
    if feature.is_empty() {
        return Err(err(0, "empty feature id"));
    }
    let rest = &key[slash + 1..];
    let base = slash + 1;
    let label_end = rest.find([':', '@']).unwrap_or(rest.len());
    let label = seg(&rest[..label_end], base, "bad escape in label")?;
    if label.is_empty() {
        return Err(err(base, "empty role label"));
    }
    let mut i = label_end;
    let mut arg = KeyRoleArg::None;
    if rest[i..].starts_with(':') {
        i += 1;
        if rest[i..].starts_with('{') {
            // Balanced braces; top-level '|' separates the nested keys.
            let mut depth = 0usize;
            let mut parts = Vec::new();
            let mut start = i + 1;
            let mut end = None;
            for (j, c) in rest[i..].char_indices() {
                let j = i + j;
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            parts.push(rest[start..j].to_string());
                            end = Some(j + 1);
                            break;
                        }
                    }
                    '|' if depth == 1 => {
                        parts.push(rest[start..j].to_string());
                        start = j + 1;
                    }
                    _ => {}
                }
            }
            let end = end.ok_or(err(base + i, "unbalanced braces"))?;
            if parts.iter().any(String::is_empty) {
                return Err(err(base + i, "empty nested key"));
            }
            arg = KeyRoleArg::Keys(parts);
            i = end;
        } else {
            let leaf_end = rest[i..].find('@').map_or(rest.len(), |j| i + j);
            let mut leaves = Vec::new();
            for part in rest[i..leaf_end].split('+') {
                let leaf = seg(part, base + i, "bad escape in leaf")?;
                if leaf.is_empty() {
                    return Err(err(base + i, "empty leaf"));
                }
                leaves.push(leaf);
            }
            arg = if leaves.len() == 1 {
                KeyRoleArg::Leaf(leaves.remove(0))
            } else {
                KeyRoleArg::Leaves(leaves)
            };
            i = leaf_end;
        }
    }
    let qualifier = if rest[i..].starts_with('@') {
        let q = seg(&rest[i + 1..], base + i, "bad escape in qualifier")?;
        if q.is_empty() {
            return Err(err(base + i, "empty qualifier"));
        }
        Some(q)
    } else if i == rest.len() {
        None
    } else {
        return Err(err(base + i, "trailing characters after the role"));
    };
    if key.contains('#') {
        return Err(err(
            key.find('#').unwrap_or(0),
            "'#' is display-only, never in a key",
        ));
    }
    Ok(KeyParts {
        feature,
        label,
        arg,
        qualifier,
    })
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
    fn keys_follow_the_v1_grammar_of_spec_examples() {
        // SPEC-v1 §5.2: feature ids, qualifiers, no `#index`, `.` not escaped.
        let cap = Provenance::cap_end("e1").with_qualifier("bottom");
        assert_eq!(cap.key(), "e1/cap:end@bottom");
        assert_eq!(
            cap.name(),
            "e1/cap:end",
            "the v0 name never shows the qualifier"
        );
        let side = Provenance::side("e1", "outline.bottom");
        assert_eq!(side.key(), "e1/side:outline.bottom");
        let e = Provenance::edge_between("e1", side.key(), cap.key())
            .with_index(1)
            .with_qualifier("outline.bottom.start");
        assert_eq!(
            e.key(),
            "e1/edge:{e1/cap:end@bottom|e1/side:outline.bottom}@outline.bottom.start"
        );
        assert!(!e.key().contains('#'));
        assert_eq!(
            e.name(),
            format!("e1/edge:{{{}|{}}}#1", cap.key(), side.key())
        );
        let wall = Provenance::new("h1", Role::Other("wall".into())).with_qualifier("ne");
        assert_eq!(wall.key(), "h1/wall@ne");
        assert_eq!(wall.role_label(), "wall");
        assert_eq!(Provenance::end_cap_start("r").role_label(), "endcap");
        // key_with_sources substitutes the stored names (v0 convention) by keys.
        let by_name = Provenance::edge_between("e1", side.name(), cap.name());
        assert_eq!(
            by_name.key_with_sources(&[cap.key(), side.key()]),
            "e1/edge:{e1/cap:end@bottom|e1/side:outline.bottom}"
        );
    }

    #[test]
    fn derived_roles_render_nested_keys_in_names_and_keys() {
        // SPEC-v1 §5.2 rule 3: `F/blend:{E}`, `S/offset:{X}`, … with the source key verbatim.
        let e = "e1/edge:{e1/cap:end@m|e1/side:a}";
        let blend = Provenance::new("f1", Role::Derived("blend".into())).with_sources([e]);
        assert_eq!(blend.key(), format!("f1/blend:{{{e}}}"));
        assert_eq!(blend.name(), format!("f1/blend:{{{e}}}"));
        assert_eq!(blend.role_label(), "blend");
        assert!(blend.problems().is_empty(), "{:?}", blend.problems());
        let p = parse_key(&blend.key()).expect("derived key parses");
        assert_eq!(p.label, "blend");
        assert_eq!(p.arg, KeyRoleArg::Keys(vec![e.to_string()]));
        assert_eq!(p.render(), blend.key());
        // Several sources are sorted; a qualifier follows the braces.
        let corner = Provenance::new("f1", Role::Derived("corner".into()))
            .with_sources(["b/x", "a/y"])
            .with_qualifier("1");
        assert_eq!(corner.key(), "f1/corner:{a/y|b/x}@1");
        // Malformed: no source, or a reserved character in the label.
        assert!(
            !Provenance::new("f1", Role::Derived("blend".into()))
                .problems()
                .is_empty()
        );
        assert!(
            !Provenance::new("f1", Role::Derived("a:b".into()))
                .with_sources(["x/y"])
                .problems()
                .is_empty()
        );
    }

    #[test]
    fn key_ids_are_escaped_and_unescaped() {
        assert_eq!(escape_key_id("plain_id.m"), "plain_id.m");
        assert_eq!(
            escape_key_id("a/b:c{d}e|f+g#h@i%j k"),
            "a%2Fb%3Ac%7Bd%7De%7Cf%2Bg%23h%40i%25j%20k"
        );
        assert_eq!(escape_key_id("tab\there"), "tab%09here");
        assert_eq!(escape_key_id("nbsp\u{a0}x"), "nbsp%C2%A0x");
        for s in ["a/b:c{d}e|f+g#h@i%j k", "tab\there", "nbsp\u{a0}x", "é", ""] {
            assert_eq!(unescape_key_id(&escape_key_id(s)).as_deref(), Some(s));
        }
        assert_eq!(unescape_key_id("%2"), None);
        assert_eq!(unescape_key_id("%zz"), None);
        assert_eq!(unescape_key_id("%2f"), None, "upper-case hex only");
        assert_eq!(unescape_key_id("%FF"), None, "not UTF-8");
        let p = Provenance::side("f/1", "c@2").with_qualifier("q%");
        assert_eq!(p.key(), "f%2F1/side:c%402@q%25");
        let parts = parse_key(&p.key()).expect("parses");
        assert_eq!(parts.feature, "f/1");
        assert_eq!(parts.arg, KeyRoleArg::Leaf("c@2".into()));
        assert_eq!(parts.qualifier.as_deref(), Some("q%"));
    }

    #[test]
    fn keys_parse_into_their_parts() {
        let k = "e1/edge:{e1/cap:end@bottom|e1/side:bottom}@bottom.start";
        let p = parse_key(k).expect("parses");
        assert_eq!(p.feature, "e1");
        assert_eq!(p.label, "edge");
        assert_eq!(
            p.arg,
            KeyRoleArg::Keys(vec!["e1/cap:end@bottom".into(), "e1/side:bottom".into()])
        );
        assert_eq!(p.qualifier.as_deref(), Some("bottom.start"));
        let v =
            parse_key("e1/vertex:{a/cap:end@m|a/edge:{x/side:p|x/side:q}@p.end|b/side:c}@p.end")
                .expect("nested");
        assert_eq!(
            v.arg,
            KeyRoleArg::Keys(vec![
                "a/cap:end@m".into(),
                "a/edge:{x/side:p|x/side:q}@p.end".into(),
                "b/side:c".into()
            ])
        );
        let h = parse_key("h1/wall@ne").expect("no arg");
        assert_eq!((h.label.as_str(), &h.arg), ("wall", &KeyRoleArg::None));
        let c = parse_key("e1/cap:start").expect("leaf");
        assert_eq!(c.arg, KeyRoleArg::Leaf("start".into()));
        assert_eq!(c.qualifier, None);
        let multi = Provenance::side("f", "b").with_sources(["b", "a%"]);
        let pm = parse_key(&multi.key()).expect("several leaves");
        assert_eq!(pm.arg, KeyRoleArg::Leaves(vec!["a%".into(), "b".into()]));
        for k in [
            multi.key(),
            "e1/edge:{e1/cap:end@bottom|e1/side:bottom}@bottom.start".to_string(),
            "h1/wall@ne".to_string(),
            "e1/cap:start".to_string(),
        ] {
            assert_eq!(parse_key(&k).expect("parses").render(), k);
        }
        for bad in [
            "",
            "noslash",
            "/side:a",
            "e1/",
            "e1/side:",
            "e1/edge:{a/b|",
            "e1/edge:{}",
            "e1/cap:end@",
            "e1/cap:end#1",
            "e1/side:a}b",
        ] {
            assert!(parse_key(bad).is_err(), "{bad:?} must not parse");
        }
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

    #[cfg(not(target_family = "wasm"))]
    mod props {
        use proptest::prelude::*;

        use super::super::*;

        fn any_id() -> impl Strategy<Value = String> {
            // Printable ASCII plus a few multi-byte and whitespace characters: everything a
            // v0 id could contain, including every delimiter of the key grammar.
            proptest::collection::vec(
                prop_oneof![
                    8 => (0x21u8..0x7f).prop_map(char::from),
                    1 => Just(' '),
                    1 => Just('\t'),
                    1 => Just('é'),
                    1 => Just('\u{a0}'),
                ],
                1..12,
            )
            .prop_map(|v| v.into_iter().collect())
        }

        proptest! {
            /// Escaping is injective and invertible, and escaped ids never contain a
            /// delimiter of the key grammar.
            #[test]
            fn escape_roundtrips_and_hides_delimiters(s in any_id()) {
                let e = escape_key_id(&s);
                prop_assert_eq!(unescape_key_id(&e), Some(s.clone()));
                let delimiter =
                    |c: char| (KEY_ESCAPED_CHARS.contains(&c) && c != '%') || c.is_whitespace();
                let hides = !e.contains(delimiter);
                prop_assert!(hides, "delimiter left in {}", e);
            }

            /// `parse_key` recovers the feature, label, leaf and qualifier of any rendered
            /// key, and nested keys are returned verbatim in sorted order.
            #[test]
            fn rendered_keys_parse_back(f in any_id(), c in any_id(), q in any_id(), g in any_id()) {
                let side = Provenance::side(f.clone(), c.clone()).with_qualifier(q.clone());
                let p = parse_key(&side.key()).expect("side key parses");
                prop_assert_eq!(&p.feature, &f);
                prop_assert_eq!(p.label.as_str(), "side");
                prop_assert_eq!(p.arg.clone(), KeyRoleArg::Leaf(c.clone()));
                prop_assert_eq!(p.qualifier.clone(), Some(q.clone()));
                prop_assert_eq!(p.render(), side.key());
                let cap = Provenance::cap_start(g.clone()).with_qualifier(c.clone());
                let mut nested = vec![side.key(), cap.key()];
                nested.sort();
                let e = Provenance::edge_between(f.clone(), side.key(), cap.key())
                    .with_qualifier(q.clone());
                let pe = parse_key(&e.key()).expect("edge key parses");
                prop_assert_eq!(pe.arg, KeyRoleArg::Keys(nested));
                prop_assert_eq!(pe.qualifier, Some(q));
                prop_assert!(!e.key().contains('#'));
            }
        }
    }
}
