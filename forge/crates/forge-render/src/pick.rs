//! GPU ID picking: the id encoding shared with the shaders, and the CPU side of a pick
//! (choosing the entity from a read-back window of the ID buffer).
//!
//! ## Encoding (`R32Uint`)
//! `id = kind << 30 | index`, with `index < 2^30`:
//! - `0` — background (the clear value);
//! - kind `1` — a face: `index` is the scene-global face index;
//! - kind `2` — an edge: `index` is the scene-global edge index;
//! - kind `3` — a section cap seen through the clip plane: `index` is the global index
//!   of the (back) face behind the cap, which identifies the body.
//!
//! The shaders use the same constants (`ID_FACE`, `ID_EDGE`, `ID_CAP` in
//! `shaders/common.wgsl`); a unit test checks they agree.
//!
//! ## Choosing the entity
//! A pick reads back a small window around the cursor. The pixel under the cursor is
//! exact; edges get a snapping radius: if any edge pixel lies within `edge_radius`
//! pixels (Euclidean) of the cursor, the nearest one wins (ties broken by the smaller
//! id, so the choice is deterministic). Otherwise the pixel under the cursor decides.

/// Bit position of the kind in an encoded id.
pub const KIND_SHIFT: u32 = 30;
/// Mask of the index part of an encoded id.
pub const INDEX_MASK: u32 = (1 << KIND_SHIFT) - 1;
/// Largest encodable index.
pub const MAX_INDEX: u32 = INDEX_MASK;

/// What a picked pixel shows.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PickKind {
    /// A face.
    Face = 1,
    /// A B-rep edge.
    Edge = 2,
    /// The section cap of a body cut by the section plane.
    SectionCap = 3,
}

impl PickKind {
    /// Lower-case name used in JSON (`face`, `edge`, `section`).
    pub fn as_str(self) -> &'static str {
        match self {
            PickKind::Face => "face",
            PickKind::Edge => "edge",
            PickKind::SectionCap => "section",
        }
    }
}

/// Encode `(kind, index)`; `None` if the index does not fit in 30 bits.
pub fn encode(kind: PickKind, index: u32) -> Option<u32> {
    (index <= MAX_INDEX).then_some(((kind as u32) << KIND_SHIFT) | index)
}

/// Decode an id; `None` for the background.
pub fn decode(id: u32) -> Option<(PickKind, u32)> {
    let index = id & INDEX_MASK;
    match id >> KIND_SHIFT {
        1 => Some((PickKind::Face, index)),
        2 => Some((PickKind::Edge, index)),
        3 => Some((PickKind::SectionCap, index)),
        _ => None,
    }
}

/// A rectangle of the ID buffer read back for one pick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PickWindow {
    /// Left pixel (inclusive).
    pub x0: u32,
    /// Top pixel (inclusive).
    pub y0: u32,
    /// Width in pixels (≥ 1).
    pub width: u32,
    /// Height in pixels (≥ 1).
    pub height: u32,
    /// Cursor pixel, absolute.
    pub cx: u32,
    /// Cursor pixel, absolute.
    pub cy: u32,
}

impl PickWindow {
    /// The window of radius `radius` around pixel `(cx, cy)`, clamped to a
    /// `width × height` target; `None` if the cursor is outside the target.
    pub fn around(cx: f64, cy: f64, radius: u32, width: u32, height: u32) -> Option<Self> {
        if !(cx.is_finite() && cy.is_finite()) || cx < 0.0 || cy < 0.0 {
            return None;
        }
        let (cx, cy) = (cx.floor() as u64, cy.floor() as u64);
        if cx >= u64::from(width) || cy >= u64::from(height) {
            return None;
        }
        let (cx, cy) = (cx as u32, cy as u32);
        let x0 = cx.saturating_sub(radius);
        let y0 = cy.saturating_sub(radius);
        let x1 = cx.saturating_add(radius).min(width - 1);
        let y1 = cy.saturating_add(radius).min(height - 1);
        Some(PickWindow {
            x0,
            y0,
            width: x1 - x0 + 1,
            height: y1 - y0 + 1,
            cx,
            cy,
        })
    }

    /// Bytes per row of a buffer copy of this window with 4-byte texels, padded to the
    /// 256-byte alignment `copy_texture_to_buffer` requires.
    pub fn padded_bytes_per_row(&self) -> u32 {
        (self.width * 4).div_ceil(256) * 256
    }
}

/// The chosen pixel of a pick.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChosenPixel {
    /// Encoded id (non-zero).
    pub id: u32,
    /// Absolute pixel.
    pub x: u32,
    /// Absolute pixel.
    pub y: u32,
}

/// Choose the picked pixel from the window's ids (row-major, `window.width` per row).
pub fn choose(ids: &[u32], window: &PickWindow, edge_radius: u32) -> Option<ChosenPixel> {
    let w = window.width as usize;
    let at = |x: u32, y: u32| ids.get((y - window.y0) as usize * w + (x - window.x0) as usize);
    let r2 = u64::from(edge_radius) * u64::from(edge_radius);
    let mut best: Option<(u64, u32, u32, u32)> = None;
    for y in window.y0..window.y0 + window.height {
        for x in window.x0..window.x0 + window.width {
            let Some(&id) = at(x, y) else { continue };
            if !matches!(decode(id), Some((PickKind::Edge, _))) {
                continue;
            }
            let dx = i64::from(x) - i64::from(window.cx);
            let dy = i64::from(y) - i64::from(window.cy);
            let d2 = (dx * dx + dy * dy) as u64;
            if d2 > r2 {
                continue;
            }
            let cand = (d2, id, y, x);
            if best.is_none_or(|b| (cand.0, cand.1) < (b.0, b.1)) {
                best = Some(cand);
            }
        }
    }
    if let Some((_, id, y, x)) = best {
        return Some(ChosenPixel { id, x, y });
    }
    let &id = at(window.cx, window.cy)?;
    decode(id).map(|_| ChosenPixel {
        id,
        x: window.cx,
        y: window.cy,
    })
}

/// Unpack a read-back window (`padded_bytes_per_row` per row, little-endian `u32`
/// texels) into a tight row-major vector.
pub fn unpack_rows(bytes: &[u8], window: &PickWindow, padded_bytes_per_row: u32) -> Vec<u32> {
    let mut out = Vec::with_capacity((window.width * window.height) as usize);
    for row in 0..window.height as usize {
        let start = row * padded_bytes_per_row as usize;
        for col in 0..window.width as usize {
            let o = start + col * 4;
            let v = bytes
                .get(o..o + 4)
                .map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
            out.push(v);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_decode_round_trips_and_background_is_zero() {
        for kind in [PickKind::Face, PickKind::Edge, PickKind::SectionCap] {
            for index in [0, 1, 7, 1000, MAX_INDEX] {
                let id = encode(kind, index).expect("fits");
                assert_ne!(id, 0);
                assert_eq!(decode(id), Some((kind, index)));
            }
        }
        assert_eq!(decode(0), None);
        assert_eq!(encode(PickKind::Face, MAX_INDEX + 1), None);
        // Kinds occupy disjoint ranges.
        assert!(encode(PickKind::Face, MAX_INDEX) < encode(PickKind::Edge, 0));
        assert!(encode(PickKind::Edge, MAX_INDEX) < encode(PickKind::SectionCap, 0));
    }

    #[test]
    fn shader_constants_match_the_encoding() {
        let src = include_str!("shaders/common.wgsl");
        let face = format!(
            "const ID_FACE: u32 = {}u;",
            encode(PickKind::Face, 0).expect("fits")
        );
        let edge = format!(
            "const ID_EDGE: u32 = {}u;",
            encode(PickKind::Edge, 0).expect("fits")
        );
        let cap = format!(
            "const ID_CAP: u32 = {}u;",
            encode(PickKind::SectionCap, 0).expect("fits")
        );
        for c in [face, edge, cap] {
            assert!(src.contains(&c), "common.wgsl lacks `{c}`");
        }
    }

    #[test]
    fn window_is_clamped_to_the_target() {
        let w = PickWindow::around(1.2, 2.9, 4, 100, 50).expect("inside");
        assert_eq!(
            (w.x0, w.y0, w.width, w.height, w.cx, w.cy),
            (0, 0, 6, 7, 1, 2)
        );
        let w = PickWindow::around(99.9, 49.0, 4, 100, 50).expect("inside");
        assert_eq!((w.x0, w.y0, w.width, w.height), (95, 45, 5, 5));
        assert!(PickWindow::around(100.0, 3.0, 4, 100, 50).is_none());
        assert!(PickWindow::around(-0.5, 3.0, 4, 100, 50).is_none());
        assert!(PickWindow::around(f64::NAN, 3.0, 4, 100, 50).is_none());
        assert_eq!(w.padded_bytes_per_row(), 256);
        let big = PickWindow::around(500.0, 500.0, 40, 1000, 1000).expect("inside");
        assert_eq!(big.padded_bytes_per_row(), 512);
    }

    fn grid(window: &PickWindow, f: impl Fn(u32, u32) -> u32) -> Vec<u32> {
        let mut v = Vec::new();
        for y in window.y0..window.y0 + window.height {
            for x in window.x0..window.x0 + window.width {
                v.push(f(x, y));
            }
        }
        v
    }

    #[test]
    fn centre_pixel_is_exact_when_no_edge_is_near() {
        let win = PickWindow::around(10.0, 10.0, 3, 100, 100).expect("inside");
        let face_a = encode(PickKind::Face, 4).expect("fits");
        let face_b = encode(PickKind::Face, 5).expect("fits");
        // A face boundary exactly at the cursor column: x >= 10 is face B.
        let ids = grid(&win, |x, _| if x >= 10 { face_b } else { face_a });
        assert_eq!(choose(&ids, &win, 3).expect("hit").id, face_b);
        let ids = grid(&win, |x, _| if x > 10 { face_b } else { face_a });
        assert_eq!(choose(&ids, &win, 3).expect("hit").id, face_a);
        let ids = grid(&win, |_, _| 0);
        assert_eq!(choose(&ids, &win, 3), None);
    }

    #[test]
    fn nearest_edge_within_the_radius_wins_deterministically() {
        let win = PickWindow::around(10.0, 10.0, 4, 100, 100).expect("inside");
        let face = encode(PickKind::Face, 1).expect("fits");
        let e1 = encode(PickKind::Edge, 9).expect("fits");
        let e2 = encode(PickKind::Edge, 3).expect("fits");
        // e1 at distance 2 (x = 12), e2 at distance 3 (x = 7).
        let ids = grid(&win, |x, _| match x {
            12 => e1,
            7 => e2,
            _ => face,
        });
        let c = choose(&ids, &win, 4).expect("hit");
        assert_eq!((c.id, c.x, c.y), (e1, 12, 10));
        // Radius 1: no edge close enough, the face under the cursor wins.
        assert_eq!(choose(&ids, &win, 1).expect("hit").id, face);
        // Equal distance: the smaller id wins.
        let ids = grid(&win, |x, _| match x {
            12 => e1,
            8 => e2,
            _ => face,
        });
        assert_eq!(choose(&ids, &win, 4).expect("hit").id, e2);
        // Radius 0 is pixel-exact.
        assert_eq!(choose(&ids, &win, 0).expect("hit").id, face);
    }

    #[test]
    fn unpack_rows_skips_row_padding() {
        let win = PickWindow::around(1.0, 1.0, 1, 10, 10).expect("inside");
        let bpr = win.padded_bytes_per_row();
        let mut bytes = vec![0xAAu8; (bpr * win.height) as usize];
        for row in 0..win.height {
            for col in 0..win.width {
                let v = row * 100 + col;
                let o = (row * bpr + col * 4) as usize;
                bytes[o..o + 4].copy_from_slice(&v.to_le_bytes());
            }
        }
        let ids = unpack_rows(&bytes, &win, bpr);
        assert_eq!(ids, vec![0, 1, 2, 100, 101, 102, 200, 201, 202]);
    }
}
