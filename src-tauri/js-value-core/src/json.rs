//! JSON data using ECMAScript strings and numbers, without executing conversion hooks.
//! Escaped lone surrogates and overflowing decimal numbers are valid JSON.parse inputs.
use crate::{data::Data, text};
use std::collections::HashMap;

pub const MAX_DEPTH: usize = 128;
pub fn parse(input: &str) -> Result<Data, String> {
    parse_bounded(input, paddy_page_core::MAX_REQUEST)
}

/// A caller with its own input framing supplies that boundary; nesting stays bounded.
pub fn parse_bounded(input: &str, max_bytes: usize) -> Result<Data, String> {
    if input.len() > max_bytes {
        return Err("JSON is too large".into());
    }
    let mut parser = Parser {
        input,
        pos: 0,
        max_bytes,
    };
    let value = parser.value(0)?;
    parser.space();
    if parser.pos != input.len() {
        return Err("Trailing JSON data".into());
    }
    Ok(value)
}
struct Parser<'a> {
    input: &'a str,
    pos: usize,
    max_bytes: usize,
}
impl Parser<'_> {
    fn byte(&self) -> Option<u8> {
        self.input.as_bytes().get(self.pos).copied()
    }
    fn space(&mut self) {
        while matches!(self.byte(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }
    fn take(&mut self, byte: u8) -> bool {
        if self.byte() == Some(byte) {
            self.pos += 1;
            true
        } else {
            false
        }
    }
    fn string(&mut self) -> Result<Vec<u16>, String> {
        let start = self.pos;
        if !self.take(b'"') {
            return Err("Expected a JSON string".into());
        }
        while let Some(c) = self.byte() {
            self.pos += 1;
            match c {
                b'"' => return text::parse_bounded(&self.input[start..self.pos], self.max_bytes),
                b'\\' => {
                    if self.byte().is_none() {
                        break;
                    }
                    self.pos += 1;
                }
                _ => {}
            }
        }
        Err("Unterminated JSON string".into())
    }
    fn value(&mut self, depth: usize) -> Result<Data, String> {
        if depth > MAX_DEPTH {
            return Err("JSON nesting is too deep".into());
        }
        self.space();
        match self.byte() {
            Some(b'"') => Ok(Data::Text(self.string()?)),
            Some(b'n') if self.input[self.pos..].starts_with("null") => {
                self.pos += 4;
                Ok(Data::Null)
            }
            Some(b't') if self.input[self.pos..].starts_with("true") => {
                self.pos += 4;
                Ok(Data::Bool(true))
            }
            Some(b'f') if self.input[self.pos..].starts_with("false") => {
                self.pos += 5;
                Ok(Data::Bool(false))
            }
            Some(b'[') => {
                self.pos += 1;
                self.space();
                let mut values = Vec::new();
                if self.take(b']') {
                    return Ok(Data::Array(values));
                }
                loop {
                    values.push(self.value(depth + 1)?);
                    self.space();
                    if self.take(b']') {
                        break;
                    }
                    if !self.take(b',') {
                        return Err("Expected a JSON comma".into());
                    }
                }
                Ok(Data::Array(values))
            }
            Some(b'{') => {
                self.pos += 1;
                self.space();
                let mut values: Vec<(Vec<u16>, Data)> = Vec::new();
                let mut positions: HashMap<Vec<u16>, usize> = HashMap::new();
                if self.take(b'}') {
                    return Ok(Data::Object(values));
                }
                loop {
                    self.space();
                    let key = self.string()?;
                    self.space();
                    if !self.take(b':') {
                        return Err("Expected a JSON colon".into());
                    }
                    let value = self.value(depth + 1)?;
                    if let Some(&i) = positions.get(&key) {
                        values[i].1 = value;
                    } else {
                        positions.insert(key.clone(), values.len());
                        values.push((key, value));
                    }
                    self.space();
                    if self.take(b'}') {
                        break;
                    }
                    if !self.take(b',') {
                        return Err("Expected a JSON comma".into());
                    }
                }
                Ok(Data::Object(values))
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err("Invalid JSON value".into()),
        }
    }
    fn number(&mut self) -> Result<Data, String> {
        let start = self.pos;
        self.take(b'-');
        if !self.take(b'0') {
            if !matches!(self.byte(), Some(b'1'..=b'9')) {
                return Err("Invalid JSON number".into());
            }
            self.digits();
        }
        if self.take(b'.') && !self.digits() {
            return Err("Invalid JSON fraction".into());
        }
        if self.take(b'e') || self.take(b'E') {
            if !self.take(b'+') {
                self.take(b'-');
            }
            if !self.digits() {
                return Err("Invalid JSON exponent".into());
            }
        }
        self.input[start..self.pos]
            .parse::<f64>()
            .map(Data::Number)
            .map_err(|_| "Invalid JSON number".into())
    }
    fn digits(&mut self) -> bool {
        let start = self.pos;
        while matches!(self.byte(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        self.pos > start
    }
}

/// String(value) for data produced by JSON.parse. Own non-callable toString fields
/// cause the same conversion failure as JavaScript; no object method is invoked.
pub fn string(value: &Data) -> Result<Vec<u16>, String> {
    Ok(match value {
        Data::Undefined => text::literal("undefined"),
        Data::Null => text::literal("null"),
        Data::Bool(v) => text::literal(if *v { "true" } else { "false" }),
        Data::Number(v) => text::literal(ryu_js::Buffer::new().format(*v)),
        Data::Text(v) => v.clone(),
        Data::Array(values) => {
            let mut out = Vec::new();
            for (i, v) in values.iter().enumerate() {
                if i > 0 {
                    out.push(0x2c);
                }
                if !v.nullish() {
                    out.extend(string(v)?);
                }
            }
            out
        }
        Data::Object(_) if !value.get("toString").missing() => {
            return Err("Cannot convert object to a primitive".into())
        }
        Data::Object(_) => text::literal("[object Object]"),
    })
}
pub fn number(value: &Data) -> Result<f64, String> {
    Ok(match value {
        Data::Undefined => f64::NAN,
        Data::Null => 0.0,
        Data::Bool(v) => f64::from(*v),
        Data::Number(v) => *v,
        _ => crate::data::number(&string(value)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn json_strings_numbers_and_duplicates() {
        // ECMA-404 JSON grammar and ECMAScript ParseJSON: last duplicate wins,
        // escaped UTF-16 units survive, and JSON numbers become IEEE-754 doubles.
        let value = parse(r#"{"a":1,"a":2,"s":"\ud800x\udfff","n":1e999,"z":-0}"#).unwrap();
        assert_eq!(value.get("a"), &Data::Number(2.0));
        assert_eq!(value.get("s").string(), &[0xd800, 120, 0xdfff]);
        assert_eq!(value.get("n"), &Data::Number(f64::INFINITY));
        assert!(value.get("z").numeric().is_sign_negative());
        for bad in [
            "01",
            "1.",
            "+1",
            "1e",
            "[1,]",
            "{\"x\":1,}",
            "true false",
            "\"\\x00\"",
            "\"\n\"",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn explicit_bound_does_not_change_default_request_limit() {
        let input = format!("\"{}\"", "x".repeat(paddy_page_core::MAX_REQUEST));
        assert!(parse(&input).is_err());
        assert!(parse_bounded(&input, 12 << 20).is_ok());
        assert!(parse_bounded(&input, input.len() - 1).is_err());
        assert!(parse_bounded(&input, input.len()).is_ok());
    }
    #[test]
    fn depth_and_real_byte_bound() {
        assert!(parse(&format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH),
            "]".repeat(MAX_DEPTH)
        ))
        .is_ok());
        assert!(parse(&format!(
            "{}0{}",
            "[".repeat(MAX_DEPTH + 1),
            "]".repeat(MAX_DEPTH + 1)
        ))
        .is_err());
        let input = format!("\"{}\"", "x".repeat(paddy_page_core::MAX_REQUEST - 2));
        assert!(parse(&input).is_ok());
        assert!(parse(&(input + " ")).is_err());
    }
}
