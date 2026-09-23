//! A small, strict, non-validating XML 1.0 parser into an element tree, and escaping
//! for the writers. Enough for OPC/3MF parts: elements, attributes, character data,
//! the five predefined entities and numeric character references, comments,
//! processing instructions and CDATA. Document type declarations are rejected (3MF
//! forbids DTDs, and rejecting them rules out entity-expansion attacks).
//!
//! Well-formedness is enforced: one root element, matching end tags, unique attribute
//! names per element, valid names, no `<` or bare `&` in character data or attribute
//! values. Violations are [`IoError::Xml`] with a byte offset.

use crate::IoError;

/// An element with its attributes (in document order), children and concatenated
/// character data.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Element {
    /// Qualified name as written (`prefix:local` or `local`).
    pub name: String,
    /// Attributes in document order.
    pub attrs: Vec<(String, String)>,
    /// Child elements in document order.
    pub children: Vec<Element>,
    /// Concatenated character data directly inside this element.
    pub text: String,
}

impl Element {
    /// The name without its namespace prefix.
    pub fn local_name(&self) -> &str {
        self.name.rsplit(':').next().unwrap_or(&self.name)
    }
    /// Attribute value by qualified name.
    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
    /// Children with the given local name.
    pub fn children_named<'a>(&'a self, local: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children
            .iter()
            .filter(move |c| c.local_name() == local)
    }
    /// The first child with the given local name.
    pub fn child(&self, local: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.local_name() == local)
    }
}

/// Escape character data or an attribute value.
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c if (c as u32) < 0x20 && !matches!(c, '\t' | '\n' | '\r') => {
                // Not representable in XML 1.0: substitute.
                out.push('\u{FFFD}');
            }
            c => out.push(c),
        }
    }
    out
}

struct Parser<'a> {
    s: &'a str,
    b: &'a [u8],
    i: usize,
}

fn is_name_start(c: char) -> bool {
    c.is_alphabetic() || c == '_' || c == ':'
}
fn is_name_char(c: char) -> bool {
    is_name_start(c) || c.is_numeric() || matches!(c, '-' | '.' | '\u{B7}')
}

impl<'a> Parser<'a> {
    fn err(&self, detail: impl Into<String>) -> IoError {
        IoError::Xml {
            offset: self.i,
            detail: detail.into(),
        }
    }
    fn starts(&self, p: &str) -> bool {
        self.s[self.i..].starts_with(p)
    }
    fn peek(&self) -> Option<char> {
        self.s[self.i..].chars().next()
    }
    fn skip_ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n') {
            self.i += 1;
        }
    }
    fn expect(&mut self, p: &str) -> Result<(), IoError> {
        if self.starts(p) {
            self.i += p.len();
            Ok(())
        } else {
            Err(self.err(format!("expected {p:?}")))
        }
    }
    fn skip_until(&mut self, end: &str, what: &str) -> Result<&'a str, IoError> {
        match self.s[self.i..].find(end) {
            Some(k) => {
                let body = &self.s[self.i..self.i + k];
                self.i += k + end.len();
                Ok(body)
            }
            None => Err(self.err(format!("unterminated {what}"))),
        }
    }
    fn name(&mut self) -> Result<String, IoError> {
        let start = self.i;
        match self.peek() {
            Some(c) if is_name_start(c) => self.i += c.len_utf8(),
            _ => return Err(self.err("expected a name")),
        }
        while let Some(c) = self.peek() {
            if is_name_char(c) {
                self.i += c.len_utf8();
            } else {
                break;
            }
        }
        Ok(self.s[start..self.i].to_string())
    }
    /// Decode character data up to (not including) `stop`, resolving references.
    fn decode(&self, raw: &str, base: usize) -> Result<String, IoError> {
        let mut out = String::with_capacity(raw.len());
        let mut rest = raw;
        let mut off = base;
        while let Some(k) = rest.find(['&', '<']) {
            out.push_str(&rest[..k]);
            if rest.as_bytes()[k] == b'<' {
                return Err(IoError::Xml {
                    offset: off + k,
                    detail: "'<' in character data".into(),
                });
            }
            let after = &rest[k + 1..];
            let end = after.find(';').ok_or(IoError::Xml {
                offset: off + k,
                detail: "unterminated reference".into(),
            })?;
            let ent = &after[..end];
            let c = match ent {
                "lt" => '<',
                "gt" => '>',
                "amp" => '&',
                "quot" => '"',
                "apos" => '\'',
                _ => {
                    let code = if let Some(h) = ent.strip_prefix("#x") {
                        u32::from_str_radix(h, 16).ok()
                    } else if let Some(d) = ent.strip_prefix('#') {
                        d.parse::<u32>().ok()
                    } else {
                        None
                    };
                    code.and_then(char::from_u32).ok_or(IoError::Xml {
                        offset: off + k,
                        detail: format!("unknown reference &{ent};"),
                    })?
                }
            };
            out.push(c);
            let consumed = k + 1 + end + 1;
            rest = &rest[consumed..];
            off += consumed;
        }
        out.push_str(rest);
        Ok(out)
    }
    /// Skip comments, processing instructions and whitespace (prolog/epilog).
    fn misc(&mut self) -> Result<(), IoError> {
        loop {
            self.skip_ws();
            if self.starts("<!--") {
                self.i += 4;
                self.skip_until("-->", "comment")?;
            } else if self.starts("<?") {
                self.i += 2;
                self.skip_until("?>", "processing instruction")?;
            } else if self.starts("<!DOCTYPE") {
                return Err(self.err("document type declarations are not allowed"));
            } else {
                return Ok(());
            }
        }
    }
    fn element(&mut self, depth: usize) -> Result<Element, IoError> {
        if depth > 256 {
            return Err(self.err("elements nested too deeply"));
        }
        self.expect("<")?;
        let name = self.name()?;
        let mut el = Element {
            name,
            ..Element::default()
        };
        loop {
            let had_ws =
                self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\r' | b'\n');
            self.skip_ws();
            if self.starts("/>") {
                self.i += 2;
                return Ok(el);
            }
            if self.starts(">") {
                self.i += 1;
                break;
            }
            if !had_ws {
                return Err(self.err("expected whitespace before an attribute"));
            }
            let an = self.name()?;
            self.skip_ws();
            self.expect("=")?;
            self.skip_ws();
            let q = match self.peek() {
                Some(c @ ('"' | '\'')) => c,
                _ => return Err(self.err("expected a quoted attribute value")),
            };
            self.i += 1;
            let start = self.i;
            let raw = self.skip_until(if q == '"' { "\"" } else { "'" }, "attribute value")?;
            let val = self.decode(raw, start)?;
            if el.attrs.iter().any(|(k, _)| *k == an) {
                return Err(self.err(format!("duplicate attribute {an}")));
            }
            el.attrs.push((an, val));
        }
        // Content.
        loop {
            if self.i >= self.b.len() {
                return Err(self.err(format!("unclosed element <{}>", el.name)));
            }
            if self.starts("</") {
                self.i += 2;
                let end = self.name()?;
                if end != el.name {
                    return Err(self.err(format!("</{end}> does not close <{}>", el.name)));
                }
                self.skip_ws();
                self.expect(">")?;
                return Ok(el);
            } else if self.starts("<!--") {
                self.i += 4;
                self.skip_until("-->", "comment")?;
            } else if self.starts("<![CDATA[") {
                self.i += 9;
                let body = self.skip_until("]]>", "CDATA section")?;
                el.text.push_str(body);
            } else if self.starts("<?") {
                self.i += 2;
                self.skip_until("?>", "processing instruction")?;
            } else if self.starts("<!") {
                return Err(self.err("markup declarations are not allowed"));
            } else if self.starts("<") {
                el.children.push(self.element(depth + 1)?);
            } else {
                let start = self.i;
                let k = self.s[self.i..].find('<').unwrap_or(self.s.len() - self.i);
                let raw = &self.s[start..start + k];
                self.i += k;
                let t = self.decode(raw, start)?;
                el.text.push_str(&t);
            }
        }
    }
}

/// Parse a complete XML document; returns its root element.
pub fn parse(bytes: &[u8]) -> Result<Element, IoError> {
    let s = std::str::from_utf8(bytes).map_err(|e| IoError::Xml {
        offset: e.valid_up_to(),
        detail: "not UTF-8".into(),
    })?;
    let s = s.strip_prefix('\u{FEFF}').unwrap_or(s);
    let mut p = Parser {
        s,
        b: s.as_bytes(),
        i: 0,
    };
    p.misc()?;
    if !p.starts("<") {
        return Err(p.err("expected the root element"));
    }
    let root = p.element(0)?;
    p.misc()?;
    if p.i != p.b.len() {
        return Err(p.err("content after the root element"));
    }
    Ok(root)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_elements_attributes_entities() {
        let doc = br#"<?xml version="1.0" encoding="UTF-8"?>
<!-- c --><a x="1 &amp; 2" y='&#x41;&#66;'><b/><c>t&lt;<![CDATA[<raw>]]></c></a>"#;
        let r = parse(doc).expect("parse");
        assert_eq!(r.name, "a");
        assert_eq!(r.attr("x"), Some("1 & 2"));
        assert_eq!(r.attr("y"), Some("AB"));
        assert_eq!(r.children.len(), 2);
        assert_eq!(r.child("c").map(|c| c.text.as_str()), Some("t<<raw>"));
    }

    #[test]
    fn rejects_malformed_documents() {
        for bad in [
            &b"<a><b></a>"[..],
            b"<a x='1' x='2'/>",
            b"<a>&bogus;</a>",
            b"<a/><b/>",
            b"<!DOCTYPE a><a/>",
            b"<a",
            b"<a x=1/>",
            b"text",
        ] {
            assert!(parse(bad).is_err(), "{:?}", std::str::from_utf8(bad));
        }
    }

    #[test]
    fn escape_round_trips_through_the_parser() {
        let s = "a<b>&\"c'";
        let doc = format!("<r v=\"{}\">{}</r>", escape(s), escape(s));
        let r = parse(doc.as_bytes()).expect("parse");
        assert_eq!(r.attr("v"), Some(s));
        assert_eq!(r.text, s);
    }
}
