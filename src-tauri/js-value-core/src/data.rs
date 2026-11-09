//! Configuration observations retain missing values, nonfinite numbers and UTF-16 identities.
use crate::text::{self, literal, Text};
use num_traits::ToPrimitive;
use serde_json::{json, Value as Json};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq)]
pub enum Data {
    Undefined,
    Null,
    Bool(bool),
    Number(f64),
    Text(Text),
    Array(Vec<Data>),
    Object(Vec<(Text, Data)>),
}
static UNDEFINED: Data = Data::Undefined;
impl Data {
    pub fn get(&self, key: &str) -> &Data {
        let key = literal(key);
        if let Self::Object(entries) = self {
            entries
                .iter()
                .find(|(k, _)| k == &key)
                .map_or(&UNDEFINED, |(_, v)| v)
        } else {
            &UNDEFINED
        }
    }
    pub fn set(&mut self, key: &str, value: Data) {
        self.set_text(literal(key), value)
    }
    pub fn set_text(&mut self, key: Text, value: Data) {
        let Self::Object(entries) = self else {
            panic!("Object required")
        };
        if let Some((_, v)) = entries.iter_mut().find(|(k, _)| k == &key) {
            *v = value;
        } else {
            entries.push((key, value));
        }
    }
    pub fn merge(&mut self, entries: impl IntoIterator<Item = (Text, Data)>) {
        let Self::Object(out) = self else {
            panic!("Object required")
        };
        let mut positions: HashMap<Text, usize> = out
            .iter()
            .enumerate()
            .map(|(i, (k, _))| (k.clone(), i))
            .collect();
        for (key, value) in entries {
            if let Some(&i) = positions.get(&key) {
                out[i].1 = value;
            } else {
                positions.insert(key.clone(), out.len());
                out.push((key, value));
            }
        }
    }
    pub fn truthy(&self) -> bool {
        match self {
            Self::Undefined | Self::Null => false,
            Self::Bool(v) => *v,
            Self::Number(v) => *v != 0.0 && !v.is_nan(),
            Self::Text(v) => !v.is_empty(),
            _ => true,
        }
    }
    pub fn is(&self, s: &str) -> bool {
        matches!(self, Self::Text(v) if *v == literal(s))
    }
    pub fn missing(&self) -> bool {
        matches!(self, Self::Undefined)
    }
    pub fn nullish(&self) -> bool {
        matches!(self, Self::Undefined | Self::Null)
    }
    pub fn text(&self) -> Text {
        match self {
            Self::Text(v) => v.clone(),
            Self::Number(n) if n.is_finite() => literal(ryu_js::Buffer::new().format(*n)),
            _ => Vec::new(),
        }
    }
    pub fn string(&self) -> &[u16] {
        if let Self::Text(v) = self {
            v
        } else {
            &[]
        }
    }
    pub fn numeric(&self) -> f64 {
        match self {
            Self::Number(n) => *n,
            Self::Text(s) => number(s),
            _ => f64::NAN,
        }
    }
    pub fn items(&self) -> &[Data] {
        if let Self::Array(v) = self {
            v
        } else {
            &[]
        }
    }
}
pub fn text(s: &str) -> Data {
    Data::Text(literal(s))
}
pub fn object(entries: &[(&str, Data)]) -> Data {
    Data::Object(
        entries
            .iter()
            .map(|(k, v)| (literal(k), v.clone()))
            .collect(),
    )
}
pub fn optional(s: Text) -> Data {
    if s.is_empty() {
        Data::Undefined
    } else {
        Data::Text(s)
    }
}

/// ECMAScript's scalar Number conversion, without object coercion hooks.
pub fn number(value: &[u16]) -> f64 {
    let Ok(s) = String::from_utf16(text::trim(value)) else {
        return f64::NAN;
    };
    if s.is_empty() {
        return 0.0;
    }
    if matches!(s.as_str(), "Infinity" | "+Infinity") {
        return f64::INFINITY;
    }
    if s == "-Infinity" {
        return f64::NEG_INFINITY;
    }
    let bytes = s.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => Some((16, 4)),
            b'o' | b'O' => Some((8, 3)),
            b'b' | b'B' => Some((2, 1)),
            _ => None,
        };
        if let Some((radix, bits)) = radix {
            let digits = &s[2..];
            if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
                return f64::NAN;
            }
            let digits = digits.trim_start_matches('0');
            if digits.is_empty() {
                return 0.0;
            }
            // Once far beyond f64's exponent, retaining a huge bigint cannot affect the result.
            if digits.len() > 1024 / bits + 1 {
                return f64::INFINITY;
            }
            return num_bigint::BigUint::parse_bytes(digits.as_bytes(), radix)
                .and_then(|n| n.to_f64())
                .unwrap_or(f64::INFINITY);
        }
    }
    let mut i = usize::from(matches!(bytes[0], b'+' | b'-'));
    let mut digits = 0;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
        digits += 1;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
            digits += 1;
        }
    }
    if digits == 0 {
        return f64::NAN;
    }
    if i < bytes.len() && matches!(bytes[i], b'e' | b'E') {
        i += 1;
        if i < bytes.len() && matches!(bytes[i], b'+' | b'-') {
            i += 1;
        }
        let start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return f64::NAN;
        }
    }
    if i != bytes.len() {
        return f64::NAN;
    }
    s.parse().unwrap_or(f64::NAN)
}

pub fn decode(value: &Json) -> Result<Data, String> {
    let a = value.as_array().ok_or("Expected an observation")?;
    let tag = a
        .first()
        .and_then(Json::as_str)
        .ok_or("Missing observation type")?;
    match (tag, a.len()) {
        ("u", 1) => Ok(Data::Undefined),
        ("z", 1) => Ok(Data::Null),
        ("b", 2) => Ok(Data::Bool(a[1].as_bool().ok_or("Invalid boolean")?)),
        ("n", 2) => {
            let n = if let Some(n) = a[1].as_f64() {
                n
            } else {
                match a[1].as_str() {
                    Some("-0") => -0.0,
                    Some("NaN") => f64::NAN,
                    Some("Infinity") => f64::INFINITY,
                    Some("-Infinity") => f64::NEG_INFINITY,
                    _ => return Err("Invalid number".into()),
                }
            };
            Ok(Data::Number(n))
        }
        ("s", 2) => Ok(Data::Text(text::parse(
            a[1].as_str().ok_or("Invalid text")?,
        )?)),
        ("a", 2) => Ok(Data::Array(
            a[1].as_array()
                .ok_or("Invalid array")?
                .iter()
                .map(decode)
                .collect::<Result<_, _>>()?,
        )),
        ("o", 2) => {
            let mut entries = Vec::new();
            for entry in a[1].as_array().ok_or("Invalid object")? {
                let pair = entry
                    .as_array()
                    .filter(|p| p.len() == 2)
                    .ok_or("Invalid field")?;
                let key = text::parse(pair[0].as_str().ok_or("Invalid key")?)?;
                entries.push((key, decode(&pair[1])?));
            }
            let mut out = Data::Object(Vec::new());
            out.merge(entries);
            Ok(out)
        }
        _ => Err("Invalid observation".into()),
    }
}
pub fn encode(value: &Data) -> Json {
    match value {
        Data::Undefined => json!(["u"]),
        Data::Null => json!(["z"]),
        Data::Bool(v) => json!(["b", v]),
        Data::Number(v) if v.is_finite() => json!(["n", v]),
        Data::Number(v) => json!(["n", ryu_js::Buffer::new().format(*v)]),
        Data::Text(v) => json!(["s", text::token(v)]),
        Data::Array(v) => json!(["a", v.iter().map(encode).collect::<Vec<_>>()]),
        Data::Object(v) => json!([
            "o",
            v.iter()
                .map(|(k, v)| json!([text::token(k), encode(v)]))
                .collect::<Vec<_>>()
        ]),
    }
}
