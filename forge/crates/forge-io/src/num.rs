//! Deterministic number formatting.
//!
//! Rust's float `Display`/`LowerExp` produce the **shortest** decimal that parses back to
//! the same value, computed in `core` with integer arithmetic, so the text is identical
//! on every target and round-trips exactly. Plain notation is used for moderate
//! magnitudes and scientific notation outside `[1e-5, 1e15)` (never hundreds of zeros).

use std::fmt::Write;

/// Append `x` (finite) in shortest round-trip form; `±0` is written as `0`.
pub fn push_f64(out: &mut String, x: f64) {
    let a = x.abs();
    let _ = if a == 0.0 {
        write!(out, "0")
    } else if (1e-5..1e15).contains(&a) {
        write!(out, "{x}")
    } else {
        write!(out, "{x:e}")
    };
}

/// Append `x` (finite) in shortest round-trip form for `f32`; `±0` is written as `0`.
pub fn push_f32(out: &mut String, x: f32) {
    let a = x.abs();
    let _ = if a == 0.0 {
        write!(out, "0")
    } else if (1e-5..1e15).contains(&a) {
        write!(out, "{x}")
    } else {
        write!(out, "{x:e}")
    };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formatting_round_trips_and_avoids_long_zero_runs() {
        for x in [
            0.1,
            -2.5,
            1e-300,
            6.02e23,
            1.0 / 3.0,
            123456.789,
            -0.0,
            1e-5,
            9.99e14,
        ] {
            let mut s = String::new();
            push_f64(&mut s, x);
            assert!(s.len() < 30, "{s}");
            let back: f64 = s.parse().expect("parse");
            assert_eq!(
                back.to_bits() & !(1 << 63),
                x.to_bits() & !(1 << 63),
                "{x} -> {s}"
            );
        }
        let mut s = String::new();
        push_f32(&mut s, 0.1f32);
        assert_eq!(s, "0.1");
    }
}
