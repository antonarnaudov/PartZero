//! Display modes: how faces and edges are drawn.
//!
//! | Mode | Faces | Edges and silhouettes | Face picking |
//! |---|---|---|---|
//! | [`DisplayMode::Shaded`] | shaded | none | yes |
//! | [`DisplayMode::ShadedEdges`] | shaded | visible ones (the default) | yes |
//! | [`DisplayMode::Wireframe`] | none | all, hidden ones included | no (edges only) |
//! | [`DisplayMode::HiddenLine`] | flat, in the background colour, occluding | visible ones | yes |
//! | [`DisplayMode::XRay`] | shaded, semi-transparent, not occluding | all | yes (nearest face) |
//!
//! Hover and selection highlights apply in every mode that draws faces (a selected face in
//! hidden-line mode is tinted, not shaded). The names are the ones the app uses
//! (`shadedEdges`, `hiddenLine`, `xray`), so the JS bindings pass them through unchanged.

/// How faces and edges are drawn (see the module docs).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub enum DisplayMode {
    /// Shaded faces, no edges.
    Shaded,
    /// Shaded faces with B-rep edges and silhouettes.
    #[default]
    ShadedEdges,
    /// Edges only, hidden ones included.
    Wireframe,
    /// Faces flat in the background colour, visible edges and silhouettes.
    HiddenLine,
    /// Semi-transparent faces, every edge visible.
    XRay,
}

impl DisplayMode {
    /// Every mode, in menu order.
    pub const ALL: [DisplayMode; 5] = [
        DisplayMode::Shaded,
        DisplayMode::ShadedEdges,
        DisplayMode::Wireframe,
        DisplayMode::HiddenLine,
        DisplayMode::XRay,
    ];

    /// The mode's name (`shaded`, `shadedEdges`, `wireframe`, `hiddenLine`, `xray`).
    pub fn as_str(self) -> &'static str {
        match self {
            DisplayMode::Shaded => "shaded",
            DisplayMode::ShadedEdges => "shadedEdges",
            DisplayMode::Wireframe => "wireframe",
            DisplayMode::HiddenLine => "hiddenLine",
            DisplayMode::XRay => "xray",
        }
    }

    /// Parse a name from [`DisplayMode::as_str`] (also accepts `x-ray` and `hidden-line`).
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "shaded" => DisplayMode::Shaded,
            "shadedEdges" | "shaded-edges" => DisplayMode::ShadedEdges,
            "wireframe" => DisplayMode::Wireframe,
            "hiddenLine" | "hidden-line" => DisplayMode::HiddenLine,
            "xray" | "x-ray" => DisplayMode::XRay,
            _ => return None,
        })
    }

    /// The code the shaders read from `frame.flags.w` (`MODE_*` in `common.wgsl`).
    pub fn code(self) -> u32 {
        match self {
            DisplayMode::Shaded => 0,
            DisplayMode::ShadedEdges => 1,
            DisplayMode::Wireframe => 2,
            DisplayMode::HiddenLine => 3,
            DisplayMode::XRay => 4,
        }
    }

    /// Whether faces are drawn at all.
    pub fn draws_faces(self) -> bool {
        self != DisplayMode::Wireframe
    }

    /// Whether faces occlude (write depth): not in wireframe and X-ray.
    pub fn faces_occlude(self) -> bool {
        matches!(
            self,
            DisplayMode::Shaded | DisplayMode::ShadedEdges | DisplayMode::HiddenLine
        )
    }

    /// Whether B-rep edges and silhouettes are drawn (given the edge/silhouette toggles).
    pub fn draws_lines(self) -> bool {
        self != DisplayMode::Shaded
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_round_trip_and_codes_match_the_shaders() {
        let src = include_str!("shaders/common.wgsl");
        for m in DisplayMode::ALL {
            assert_eq!(DisplayMode::parse(m.as_str()), Some(m));
            let name = match m {
                DisplayMode::Shaded => "MODE_SHADED",
                DisplayMode::ShadedEdges => "MODE_SHADED_EDGES",
                DisplayMode::Wireframe => "MODE_WIREFRAME",
                DisplayMode::HiddenLine => "MODE_HIDDEN_LINE",
                DisplayMode::XRay => "MODE_XRAY",
            };
            let decl = format!("const {name}: u32 = {}u;", m.code());
            assert!(src.contains(&decl), "common.wgsl lacks `{decl}`");
        }
        assert_eq!(DisplayMode::parse("x-ray"), Some(DisplayMode::XRay));
        assert_eq!(DisplayMode::parse("nope"), None);
        assert_eq!(DisplayMode::default(), DisplayMode::ShadedEdges);
    }

    #[test]
    fn mode_properties() {
        assert!(!DisplayMode::Wireframe.draws_faces());
        assert!(DisplayMode::XRay.draws_faces() && !DisplayMode::XRay.faces_occlude());
        assert!(DisplayMode::HiddenLine.faces_occlude() && DisplayMode::HiddenLine.draws_lines());
        assert!(!DisplayMode::Shaded.draws_lines());
    }
}
