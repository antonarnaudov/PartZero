//! ISO 10303-21 ("Part 21") text: parameter encoding and deterministic instance numbering.
//!
//! Instances are numbered `#1, #2, …` in the order they are added, children before their
//! parents, so the text is a pure function of the traversal order. Identical
//! `CARTESIAN_POINT`s and `DIRECTION`s are shared (keyed by their bit patterns).

use std::collections::BTreeMap;
use std::fmt::Write;

use forge_core::linalg::{Point3, Vec3};

/// Append a Part 21 `REAL`: shortest round-trip digits (computed in `core` with integer
/// arithmetic, identical on every target), always with a decimal point and an upper-case
/// exponent (`1.`, `0.5`, `-2.25`, `1.E-07` is written `1.E-7`). `±0` is written `0.`.
///
/// The caller guarantees `x` is finite.
pub(crate) fn push_real(out: &mut String, x: f64) {
    let a = x.abs();
    if a == 0.0 {
        out.push_str("0.");
        return;
    }
    let s = if (1e-5..1e15).contains(&a) {
        format!("{x}")
    } else {
        format!("{x:E}")
    };
    match s.find('E') {
        Some(e) => {
            let (mantissa, exp) = s.split_at(e);
            out.push_str(mantissa);
            if !mantissa.contains('.') {
                out.push('.');
            }
            out.push_str(exp);
        }
        None => {
            out.push_str(&s);
            if !s.contains('.') {
                out.push('.');
            }
        }
    }
}

/// Append a Part 21 string literal: printable ASCII as is (`'` doubled, `\` doubled),
/// other characters of the Basic Multilingual Plane as `\X2\…\X0\` (4 upper-case hex
/// digits each) and the rest as `\X4\…\X0\` (8 digits each), per ISO 10303-21:2002
/// §6.4.3.
pub(crate) fn push_string(out: &mut String, s: &str) {
    #[derive(PartialEq)]
    enum Mode {
        Plain,
        X2,
        X4,
    }
    out.push('\'');
    let mut mode = Mode::Plain;
    for c in s.chars() {
        let want = if (' '..='~').contains(&c) {
            Mode::Plain
        } else if (c as u32) <= 0xFFFF {
            Mode::X2
        } else {
            Mode::X4
        };
        if want != mode {
            if mode != Mode::Plain {
                out.push_str("\\X0\\");
            }
            match want {
                Mode::X2 => out.push_str("\\X2\\"),
                Mode::X4 => out.push_str("\\X4\\"),
                Mode::Plain => {}
            }
            mode = want;
        }
        match mode {
            Mode::Plain => match c {
                '\'' => out.push_str("''"),
                '\\' => out.push_str("\\\\"),
                _ => out.push(c),
            },
            Mode::X2 => {
                let _ = write!(out, "{:04X}", c as u32);
            }
            Mode::X4 => {
                let _ = write!(out, "{:08X}", c as u32);
            }
        }
    }
    if mode != Mode::Plain {
        out.push_str("\\X0\\");
    }
    out.push('\'');
}

/// The parameter list of one entity instance, built left to right.
#[derive(Default)]
pub(crate) struct Args {
    text: String,
    first: bool,
}

impl Args {
    pub(crate) fn new() -> Self {
        Args {
            text: String::new(),
            first: true,
        }
    }
    fn sep(&mut self) {
        if !self.first {
            self.text.push(',');
        }
        self.first = false;
    }
    /// A string.
    pub(crate) fn str(mut self, s: &str) -> Self {
        self.sep();
        push_string(&mut self.text, s);
        self
    }
    /// A real.
    pub(crate) fn real(mut self, x: f64) -> Self {
        self.sep();
        push_real(&mut self.text, x);
        self
    }
    /// An integer.
    pub(crate) fn int(mut self, i: usize) -> Self {
        self.sep();
        let _ = write!(self.text, "{i}");
        self
    }
    /// An instance reference.
    pub(crate) fn r(mut self, id: u32) -> Self {
        self.sep();
        let _ = write!(self.text, "#{id}");
        self
    }
    /// A list of instance references.
    pub(crate) fn refs(mut self, ids: &[u32]) -> Self {
        self.sep();
        self.text.push('(');
        for (k, id) in ids.iter().enumerate() {
            if k > 0 {
                self.text.push(',');
            }
            let _ = write!(self.text, "#{id}");
        }
        self.text.push(')');
        self
    }
    /// A list of lists of instance references.
    pub(crate) fn refs2(mut self, rows: &[Vec<u32>]) -> Self {
        self.sep();
        self.text.push('(');
        for (k, row) in rows.iter().enumerate() {
            if k > 0 {
                self.text.push(',');
            }
            self.text.push('(');
            for (j, id) in row.iter().enumerate() {
                if j > 0 {
                    self.text.push(',');
                }
                let _ = write!(self.text, "#{id}");
            }
            self.text.push(')');
        }
        self.text.push(')');
        self
    }
    /// A list of reals.
    pub(crate) fn reals(mut self, xs: &[f64]) -> Self {
        self.sep();
        self.text.push('(');
        for (k, x) in xs.iter().enumerate() {
            if k > 0 {
                self.text.push(',');
            }
            push_real(&mut self.text, *x);
        }
        self.text.push(')');
        self
    }
    /// A list of lists of reals.
    pub(crate) fn reals2(mut self, rows: &[Vec<f64>]) -> Self {
        self.sep();
        self.text.push('(');
        for (k, row) in rows.iter().enumerate() {
            if k > 0 {
                self.text.push(',');
            }
            self.text.push('(');
            for (j, x) in row.iter().enumerate() {
                if j > 0 {
                    self.text.push(',');
                }
                push_real(&mut self.text, *x);
            }
            self.text.push(')');
        }
        self.text.push(')');
        self
    }
    /// A list of integers.
    pub(crate) fn ints(mut self, xs: &[usize]) -> Self {
        self.sep();
        self.text.push('(');
        for (k, x) in xs.iter().enumerate() {
            if k > 0 {
                self.text.push(',');
            }
            let _ = write!(self.text, "{x}");
        }
        self.text.push(')');
        self
    }
    /// A boolean / logical `.T.` or `.F.`.
    pub(crate) fn bool(self, b: bool) -> Self {
        self.raw(if b { ".T." } else { ".F." })
    }
    /// A token written verbatim (`*`, `$`, `.UNSPECIFIED.`, a typed value, …).
    pub(crate) fn raw(mut self, token: &str) -> Self {
        self.sep();
        self.text.push_str(token);
        self
    }
    /// `ENTITY(args)`.
    pub(crate) fn entity(self, name: &str) -> String {
        format!("{name}({})", self.text)
    }
}

/// The DATA section under construction.
#[derive(Default)]
pub(crate) struct DataSection {
    instances: Vec<String>,
    points: BTreeMap<[u64; 3], u32>,
    directions: BTreeMap<[u64; 3], u32>,
    axes: BTreeMap<[u32; 3], u32>,
}

fn bits(v: Vec3) -> [u64; 3] {
    // `+ 0.0` folds −0 into +0, so both spellings share one instance.
    [
        (v.x + 0.0).to_bits(),
        (v.y + 0.0).to_bits(),
        (v.z + 0.0).to_bits(),
    ]
}

impl DataSection {
    /// Add an instance (`ENTITY(...)` or a complex `(A() B(...))`); returns its number.
    pub(crate) fn add(&mut self, record: String) -> u32 {
        self.instances.push(record);
        u32::try_from(self.instances.len()).unwrap_or(u32::MAX)
    }
    /// A `CARTESIAN_POINT` (shared with identical points).
    pub(crate) fn point(&mut self, p: Point3) -> u32 {
        let key = bits(p);
        if let Some(&id) = self.points.get(&key) {
            return id;
        }
        let id = self.add(
            Args::new()
                .str("")
                .reals(&[p.x, p.y, p.z])
                .entity("CARTESIAN_POINT"),
        );
        self.points.insert(key, id);
        id
    }
    /// A `DIRECTION` (shared with identical directions). `d` is written as given (unit
    /// length is the caller's business; readers normalize).
    pub(crate) fn direction(&mut self, d: Vec3) -> u32 {
        let key = bits(d);
        if let Some(&id) = self.directions.get(&key) {
            return id;
        }
        let id = self.add(
            Args::new()
                .str("")
                .reals(&[d.x, d.y, d.z])
                .entity("DIRECTION"),
        );
        self.directions.insert(key, id);
        id
    }
    /// An `AXIS2_PLACEMENT_3D` of a location and two directions (shared with identical
    /// placements).
    pub(crate) fn axis2(&mut self, loc: u32, axis: u32, ref_dir: u32) -> u32 {
        let key = [loc, axis, ref_dir];
        if let Some(&id) = self.axes.get(&key) {
            return id;
        }
        let id = self.add(
            Args::new()
                .str("")
                .r(loc)
                .r(axis)
                .r(ref_dir)
                .entity("AXIS2_PLACEMENT_3D"),
        );
        self.axes.insert(key, id);
        id
    }
    /// Number of instances so far.
    pub(crate) fn len(&self) -> usize {
        self.instances.len()
    }
    /// The `DATA;` … `ENDSEC;` text.
    pub(crate) fn write_to(&self, out: &mut String) {
        out.push_str("DATA;\n");
        for (k, rec) in self.instances.iter().enumerate() {
            let _ = writeln!(out, "#{}={};", k + 1, rec);
        }
        out.push_str("ENDSEC;\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn real(x: f64) -> String {
        let mut s = String::new();
        push_real(&mut s, x);
        s
    }

    #[test]
    fn reals_always_have_a_decimal_point_and_round_trip() {
        assert_eq!(real(1.0), "1.");
        assert_eq!(real(-2.0), "-2.");
        assert_eq!(real(0.5), "0.5");
        assert_eq!(real(0.0), "0.");
        assert_eq!(real(-0.0), "0.");
        assert_eq!(real(1e-7), "1.E-7");
        assert_eq!(real(1.5e20), "1.5E20");
        assert_eq!(real(1e15), "1.E15");
        for x in [
            0.1,
            1.0 / 3.0,
            -123456.789,
            6.02e23,
            1e-300,
            2.5e-6,
            99999.0,
        ] {
            let s = real(x);
            assert!(s.contains('.'), "{s}");
            let back: f64 = s.parse().expect("parses");
            assert_eq!(back.to_bits(), x.to_bits(), "{x} -> {s}");
        }
    }

    #[test]
    fn strings_escape_quotes_backslashes_and_non_ascii() {
        let mut s = String::new();
        push_string(&mut s, "it's a\\b");
        assert_eq!(s, "'it''s a\\\\b'");
        let mut s = String::new();
        push_string(&mut s, "Klammer ü1");
        assert_eq!(s, "'Klammer \\X2\\00FC\\X0\\1'");
        let mut s = String::new();
        push_string(&mut s, "a𝔸ü");
        assert_eq!(s, "'a\\X4\\0001D538\\X0\\\\X2\\00FC\\X0\\'");
    }

    #[test]
    fn points_and_directions_are_shared_and_numbered_in_order() {
        let mut d = DataSection::default();
        let a = d.point(Vec3::new(0.0, 0.0, 0.0));
        let b = d.point(Vec3::new(-0.0, 0.0, 0.0));
        let c = d.direction(Vec3::new(0.0, 0.0, 1.0));
        let e = d.direction(Vec3::new(0.0, 0.0, 1.0));
        assert_eq!((a, b, c, e), (1, 1, 2, 2));
        let mut out = String::new();
        d.write_to(&mut out);
        assert_eq!(
            out,
            "DATA;\n#1=CARTESIAN_POINT('',(0.,0.,0.));\n#2=DIRECTION('',(0.,0.,1.));\nENDSEC;\n"
        );
    }
}
