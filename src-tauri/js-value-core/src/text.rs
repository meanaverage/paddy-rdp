//! A JSON string literal inside the normal UTF-8 envelope preserves every UTF-16
//! code unit. Lone surrogates remain escaped through the shared page loader.
pub type Text = Vec<u16>;

pub fn parse(token: &str) -> Result<Text, String> {
    parse_bounded(token, paddy_page_core::MAX_REQUEST)
}
pub(crate) fn parse_bounded(token: &str, max_bytes: usize) -> Result<Text, String> {
    if token.len() > max_bytes {
        return Err("Identity text is too large".into());
    }
    let mut chars = token.chars();
    if chars.next() != Some('"') {
        return Err("Expected a JSON string literal".into());
    }
    let mut result = Vec::new();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                return if chars.next().is_none() {
                    Ok(result)
                } else {
                    Err("Trailing identity text".into())
                }
            }
            '\\' => {
                let value = match chars.next() {
                    Some('"') => 0x22,
                    Some('\\') => 0x5c,
                    Some('/') => 0x2f,
                    Some('b') => 8,
                    Some('f') => 12,
                    Some('n') => 10,
                    Some('r') => 13,
                    Some('t') => 9,
                    Some('u') => {
                        let mut unit = 0u16;
                        for _ in 0..4 {
                            unit = unit * 16
                                + chars
                                    .next()
                                    .and_then(|c| c.to_digit(16))
                                    .ok_or("Invalid identity escape")?
                                    as u16;
                        }
                        unit
                    }
                    _ => return Err("Invalid identity escape".into()),
                };
                result.push(value);
            }
            c if c < ' ' => return Err("Unescaped identity control character".into()),
            c => {
                result.extend_from_slice(c.encode_utf16(&mut [0; 2]));
            }
        }
    }
    Err("Unterminated identity text".into())
}

pub fn token(value: &[u16]) -> String {
    use std::fmt::Write;
    let mut out = String::from("\"");
    for c in char::decode_utf16(value.iter().copied()) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok(c) if c < ' ' => {
                write!(out, "\\u{:04x}", c as u32).unwrap();
            }
            Ok(c) => out.push(c),
            Err(e) => {
                write!(out, "\\u{:04x}", e.unpaired_surrogate()).unwrap();
            }
        }
    }
    out.push('"');
    out
}

pub fn literal(value: &str) -> Text {
    value.encode_utf16().collect()
}
pub fn whitespace(c: u16) -> bool {
    matches!(c, 0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub fn trim(value: &[u16]) -> &[u16] {
    let start = value
        .iter()
        .position(|c| !whitespace(*c))
        .unwrap_or(value.len());
    let end = value
        .iter()
        .rposition(|c| !whitespace(*c))
        .map_or(start, |n| n + 1);
    &value[start..end]
}
pub fn lower(value: &[u16]) -> Text {
    let mut out = Vec::new();
    let mut valid = String::new();
    for c in char::decode_utf16(value.iter().copied()) {
        match c {
            Ok(c) => valid.push(c),
            Err(e) => {
                out.extend(valid.to_lowercase().encode_utf16());
                valid.clear();
                out.push(e.unpaired_surrogate());
            }
        }
    }
    out.extend(valid.to_lowercase().encode_utf16());
    out
}
pub fn join(parts: &[&[u16]]) -> Text {
    parts.iter().flat_map(|part| part.iter().copied()).collect()
}
