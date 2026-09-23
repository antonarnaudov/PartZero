//! A strict RFC 8259 JSON reader with **correctly rounded** numbers (SPEC-v1 §0.4, [W0-11]).
//!
//! serde_json without its `float_roundtrip` feature parses about one in eight 17-digit decimals
//! one ulp off, so `to_json → from_json` is not bit-exact. Turning the feature on would change
//! how every crate in the build parses v0 documents; instead the v1 loader reads JSON text with
//! this reader, which converts every number with `str::parse::<f64>` (correctly rounded), and
//! then deserializes the typed document from the resulting [`serde_json::Value`].
//!
//! v0 documents keep serde_json's parser (`crate::from_json`), so v0 behavior is unchanged.
//! Duplicate object keys are rejected.

use serde_json::{Map, Number, Value};

/// A syntax error with the byte offset where it was found.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("JSON syntax error at byte {offset}: {message}")]
pub struct JsonError {
    pub offset: usize,
    pub message: String,
}

const MAX_DEPTH: usize = 128;

/// Parse JSON text into a [`Value`]; numbers are correctly rounded.
pub fn parse(text: &str) -> Result<Value, JsonError> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
        text,
    };
    p.ws();
    let v = p.value(0)?;
    p.ws();
    if p.i != p.s.len() {
        return Err(p.err("trailing characters"));
    }
    Ok(v)
}

/// Parse JSON text and deserialize it (numbers correctly rounded).
pub fn from_str<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    let v = parse(text).map_err(|e| e.to_string())?;
    serde_json::from_value(v).map_err(|e| e.to_string())
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
    text: &'a str,
}

impl Parser<'_> {
    fn err(&self, m: &str) -> JsonError {
        JsonError {
            offset: self.i,
            message: m.to_string(),
        }
    }
    fn ws(&mut self) {
        while self.i < self.s.len() && matches!(self.s[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }
    fn lit(&mut self, word: &str, v: Value) -> Result<Value, JsonError> {
        if self.s[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            Ok(v)
        } else {
            Err(self.err("invalid literal"))
        }
    }
    fn value(&mut self, depth: usize) -> Result<Value, JsonError> {
        if depth > MAX_DEPTH {
            return Err(self.err("nesting too deep"));
        }
        match self.s.get(self.i) {
            None => Err(self.err("unexpected end of input")),
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b't') => self.lit("true", Value::Bool(true)),
            Some(b'f') => self.lit("false", Value::Bool(false)),
            Some(b'n') => self.lit("null", Value::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.err("unexpected character")),
        }
    }
    fn object(&mut self, depth: usize) -> Result<Value, JsonError> {
        self.i += 1;
        let mut m = Map::new();
        self.ws();
        if self.s.get(self.i) == Some(&b'}') {
            self.i += 1;
            return Ok(Value::Object(m));
        }
        loop {
            self.ws();
            if self.s.get(self.i) != Some(&b'"') {
                return Err(self.err("expected a string key"));
            }
            let at = self.i;
            let k = self.string()?;
            self.ws();
            if self.s.get(self.i) != Some(&b':') {
                return Err(self.err("expected ':'"));
            }
            self.i += 1;
            self.ws();
            let v = self.value(depth + 1)?;
            if m.insert(k.clone(), v).is_some() {
                return Err(JsonError {
                    offset: at,
                    message: format!("duplicate key {k:?}"),
                });
            }
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b'}') => {
                    self.i += 1;
                    return Ok(Value::Object(m));
                }
                _ => return Err(self.err("expected ',' or '}'")),
            }
        }
    }
    fn array(&mut self, depth: usize) -> Result<Value, JsonError> {
        self.i += 1;
        let mut a = Vec::new();
        self.ws();
        if self.s.get(self.i) == Some(&b']') {
            self.i += 1;
            return Ok(Value::Array(a));
        }
        loop {
            self.ws();
            a.push(self.value(depth + 1)?);
            self.ws();
            match self.s.get(self.i) {
                Some(b',') => self.i += 1,
                Some(b']') => {
                    self.i += 1;
                    return Ok(Value::Array(a));
                }
                _ => return Err(self.err("expected ',' or ']'")),
            }
        }
    }
    fn hex4(&mut self) -> Result<u32, JsonError> {
        let h = self
            .text
            .get(self.i..self.i + 4)
            .ok_or_else(|| self.err("short \\u escape"))?;
        let v = u32::from_str_radix(h, 16).map_err(|_| self.err("bad \\u escape"))?;
        self.i += 4;
        Ok(v)
    }
    fn string(&mut self) -> Result<String, JsonError> {
        self.i += 1;
        let mut out = String::new();
        loop {
            let start = self.i;
            while self.i < self.s.len() && !matches!(self.s[self.i], b'"' | b'\\' | 0..=0x1f) {
                self.i += 1;
            }
            out.push_str(&self.text[start..self.i]);
            match self.s.get(self.i) {
                None => return Err(self.err("unterminated string")),
                Some(b'"') => {
                    self.i += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.i += 1;
                    let c = *self.s.get(self.i).ok_or_else(|| self.err("bad escape"))?;
                    self.i += 1;
                    match c {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let hi = self.hex4()?;
                            let cp = if (0xD800..0xDC00).contains(&hi) {
                                if !self.s[self.i..].starts_with(b"\\u") {
                                    return Err(self.err("lone surrogate"));
                                }
                                self.i += 2;
                                let lo = self.hex4()?;
                                if !(0xDC00..0xE000).contains(&lo) {
                                    return Err(self.err("bad surrogate pair"));
                                }
                                0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                            } else {
                                hi
                            };
                            out.push(char::from_u32(cp).ok_or_else(|| self.err("lone surrogate"))?);
                        }
                        _ => return Err(self.err("bad escape")),
                    }
                }
                Some(_) => return Err(self.err("control character in string")),
            }
        }
    }
    fn number(&mut self) -> Result<Value, JsonError> {
        let start = self.i;
        let digits = |p: &mut Self| {
            let s = p.i;
            while p.i < p.s.len() && p.s[p.i].is_ascii_digit() {
                p.i += 1;
            }
            p.i - s
        };
        if self.s[self.i] == b'-' {
            self.i += 1;
        }
        match self.s.get(self.i) {
            Some(b'0') => self.i += 1,
            Some(b'1'..=b'9') => {
                digits(self);
            }
            _ => return Err(self.err("invalid number")),
        }
        let mut integer = true;
        if self.s.get(self.i) == Some(&b'.') {
            self.i += 1;
            integer = false;
            if digits(self) == 0 {
                return Err(self.err("invalid number"));
            }
        }
        if matches!(self.s.get(self.i), Some(b'e' | b'E')) {
            self.i += 1;
            integer = false;
            if matches!(self.s.get(self.i), Some(b'+' | b'-')) {
                self.i += 1;
            }
            if digits(self) == 0 {
                return Err(self.err("invalid number"));
            }
        }
        let t = &self.text[start..self.i];
        if integer {
            if let Ok(u) = t.parse::<u64>() {
                return Ok(Value::Number(u.into()));
            }
            if let Ok(i) = t.parse::<i64>() {
                return Ok(Value::Number(i.into()));
            }
        }
        let f: f64 = t.parse().map_err(|_| self.err("invalid number"))?;
        Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| JsonError {
                offset: start,
                message: format!("number {t} is out of the f64 range"),
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_are_correctly_rounded() {
        // serde_json's default parser gets these wrong by one ulp.
        for s in [
            "-23957.515365261122",
            "1.5212603486793025e-05",
            "-1984.5926649180853",
            "-12.070162795213857",
        ] {
            let v = parse(s).unwrap();
            assert_eq!(
                v.as_f64().unwrap().to_bits(),
                s.parse::<f64>().unwrap().to_bits(),
                "{s}"
            );
        }
        assert_eq!(parse("80").unwrap(), Value::Number(80u64.into()));
        assert_eq!(parse("-3").unwrap(), Value::Number((-3i64).into()));
        assert!(parse("1e999").is_err());
        assert_eq!(
            parse("-0.0").unwrap().as_f64().unwrap().to_bits(),
            (-0.0f64).to_bits()
        );
    }

    #[test]
    fn rejects_malformed_json() {
        for s in [
            "",
            "{",
            "[1,]",
            "{\"a\":1,}",
            "01",
            "1.",
            ".5",
            "+1",
            "\"\\x\"",
            "{\"a\":1,\"a\":2}",
            "tru",
            "[1] 2",
            "\"\u{1}\"",
        ] {
            assert!(parse(s).is_err(), "{s:?}");
        }
    }

    #[test]
    fn strings_and_nesting() {
        let v = parse(r#"{"a": ["x\"y", "\u00e9\ud83d\ude00", true, false, null, {"b": []}]}"#)
            .unwrap();
        assert_eq!(v["a"][0], "x\"y");
        assert_eq!(v["a"][1], "é😀");
        assert!(parse(&("[".repeat(200) + &"]".repeat(200))).is_err());
    }
}
