//! Portable .rdp file decoding and import decisions. No files, network or credentials are accessed.
use num_traits::ToPrimitive;
use serde::Serialize;

pub const MAX_FILE: usize = 1024 * 1024;
pub const MICROPHONE_NOTE: &str = "the microphone (Settings › Remote Desktop › Microphone)";

/// UTF-16 code units preserve names in UTF-16 files, including lone surrogates, across JSON IPC.
pub type Text = Vec<u16>;

#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct RdpFile {
    pub host: Text,
    pub port: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<Text>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub domain: Option<Text>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sharpness: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gateway: Option<Text>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub clipboard: Option<&'static str>,
    pub ignored: Vec<Text>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    TooLarge,
    OddBigEndian,
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::TooLarge => "RDP file exceeds 1 MiB",
            Self::OddBigEndian => "Buffer size must be a multiple of 16-bits",
        })
    }
}
impl std::error::Error for Error {}

// Only these settings can affect the result. Keeping their first insertion order and final value
// preserves note ordering without storing arbitrary unknown keys from an untrusted file.
const KEYS: &[&str] = &[
    "full address",
    "server port",
    "username",
    "domain",
    "desktopscalefactor",
    "gatewayhostname",
    "gatewayusagemethod",
    "redirectclipboard",
    "audiomode",
    "audiocapturemode",
    "redirectdrives",
    "drivestoredirect",
    "redirectprinters",
    "redirectsmartcards",
    "redirectcomports",
    "usbdevicestoredirect",
    "use multimon",
    "screen mode id",
    "desktopwidth",
    "desktopheight",
    "promptcredentialonce",
    "gatewaycredentialssource",
    "remoteapplicationmode",
    "alternate shell",
    "enablecredsspsupport",
];
type Settings<'a> = Vec<(&'static str, &'a [u16])>;
fn get<'a>(settings: &Settings<'a>, key: &str) -> Option<&'a [u16]> {
    settings.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}
fn eq(value: &[u16], text: &str) -> bool {
    value.iter().copied().eq(text.encode_utf16())
}
fn whitespace(c: u16) -> bool {
    matches!(c, 0x9..=0xd | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028..=0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
fn trim(value: &[u16]) -> &[u16] {
    let start = value.iter().take_while(|c| whitespace(**c)).count();
    let end = value.len()
        - value[start..]
            .iter()
            .rev()
            .take_while(|c| whitespace(**c))
            .count();
    &value[start..end]
}

fn decode(bytes: &[u8]) -> Result<Text, Error> {
    let (data, big_endian) = if bytes.starts_with(&[0xff, 0xfe]) {
        (&bytes[2..], false)
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        if !bytes.len().is_multiple_of(2) {
            return Err(Error::OddBigEndian);
        }
        (&bytes[2..], true)
    } else if bytes.len() >= 2 && bytes[0] != 0 && bytes[1] == 0 {
        (bytes, false)
    } else {
        let data = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
        return Ok(String::from_utf8_lossy(data).encode_utf16().collect());
    };
    Ok(data
        .chunks_exact(2)
        .map(|c| {
            if big_endian {
                u16::from_be_bytes([c[0], c[1]])
            } else {
                u16::from_le_bytes([c[0], c[1]])
            }
        })
        .collect())
}

/// Match the legacy line grammar in linear time, with ECMAScript whitespace and line terminators.
fn setting(line: &[u16]) -> Option<(&'static str, &[u16])> {
    let colon = line.iter().position(|c| *c == 58)?;
    let raw_key = trim(&line[..colon]);
    // All recognized keys are ASCII and contain no 'k', the only ASCII lowercase letter whose
    // Unicode lowercase preimages include a non-ASCII character (the Kelvin sign).
    let key = *KEYS.iter().find(|key| {
        raw_key
            .iter()
            .map(|c| if (65..=90).contains(c) { c + 32 } else { *c })
            .eq(key.encode_utf16())
    })?;
    let mut rest = &line[colon + 1..];
    rest = &rest[rest.iter().take_while(|c| whitespace(**c)).count()..];
    if !matches!(rest.first(), Some(83 | 73 | 66 | 115 | 105 | 98)) {
        return None;
    }
    rest = &rest[1..];
    rest = &rest[rest.iter().take_while(|c| whitespace(**c)).count()..];
    if rest.first() != Some(&58) {
        return None;
    }
    rest = &rest[1..];
    // Without the multiline flag, JavaScript's $ requires the actual end of the line slice.
    if rest.iter().any(|c| matches!(c, 10 | 13 | 0x2028 | 0x2029)) {
        return None;
    }
    Some((key, trim(rest)))
}

fn number(value: &[u16]) -> Option<f64> {
    let text = String::from_utf16(value).ok()?;
    if text.is_empty() {
        return Some(0.0);
    }
    let bytes = text.as_bytes();
    if bytes.len() >= 2 && bytes[0] == b'0' {
        let radix = match bytes[1] {
            b'x' | b'X' => 16,
            b'b' | b'B' => 2,
            b'o' | b'O' => 8,
            _ => 0,
        };
        if radix != 0 {
            if !text[2..].chars().all(|c| c.is_digit(radix)) {
                return None;
            }
            return num_bigint::BigUint::parse_bytes(&bytes[2..], radix)
                .and_then(|n| n.to_f64())
                .filter(|n| n.is_finite());
        }
    }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}
fn digits(value: &[u16]) -> bool {
    !value.is_empty() && value.iter().all(|c| (48..=57).contains(c))
}
fn suffix_port(rest: &[u16]) -> Option<Option<&[u16]>> {
    if rest.is_empty() {
        Some(None)
    } else if rest[0] == 58 && digits(&rest[1..]) {
        Some(Some(&rest[1..]))
    } else {
        None
    }
}
fn address(full: &[u16]) -> Option<(&[u16], Option<&[u16]>)> {
    if full.first() == Some(&91) {
        if let Some(end) = full.iter().position(|c| *c == 93) {
            if end > 1 && !full[1..end].contains(&35) {
                if let Some(port) = suffix_port(&full[end + 1..]) {
                    return Some((&full[1..end], port));
                }
            }
        }
    }
    let end = full.iter().position(|c| *c == 58).unwrap_or(full.len());
    if end > 0 && full[..end].iter().all(|c| *c != 35 && !whitespace(*c)) {
        if let Some(port) = suffix_port(&full[end..]) {
            return Some((&full[..end], port));
        }
    }
    if full
        .iter()
        .all(|c| matches!(c, 48..=57 | 65..=70 | 97..=102 | 46 | 58))
        && full.iter().filter(|c| **c == 58).count() > 1
    {
        return Some((full, None));
    }
    None
}
fn uses_gateway(settings: &Settings<'_>) -> bool {
    get(settings, "gatewayhostname").is_some_and(|v| !v.is_empty())
        && !get(settings, "gatewayusagemethod").is_some_and(|v| eq(v, "0") || eq(v, "4"))
}
fn text(value: &str) -> Text {
    value.encode_utf16().collect()
}
fn joined(parts: &[&[u16]]) -> Text {
    parts.concat()
}
fn note(key: &str, v: &[u16], s: &Settings<'_>) -> Option<Text> {
    let fixed = match key {
        "audiomode" if eq(v, "1") => "sound left on the remote (sound plays here; Settings › Remote Desktop › Sound)",
        "audiomode" if eq(v, "2") => "sound off (Settings › Remote Desktop › Sound)",
        "audiocapturemode" if eq(v, "1") => MICROPHONE_NOTE,
        "redirectdrives" if eq(v, "1") => "its drives (share folders in Settings › Remote Desktop › Shared folders)",
        "drivestoredirect" if !v.is_empty() => "its drives (share folders in Settings › Remote Desktop › Shared folders)",
        "redirectprinters" if eq(v, "1") => "printer redirection (not supported)",
        "redirectsmartcards" if eq(v, "1") => "smart card redirection (not supported)",
        "redirectcomports" if eq(v, "1") => "serial port redirection (not supported)",
        "usbdevicestoredirect" if !v.is_empty() => "USB redirection (not supported)",
        "use multimon" if eq(v, "1") => "several monitors (one screen per desktop here)",
        "screen mode id" if eq(v, "1") && ["desktopwidth", "desktopheight"].iter().any(|k| get(s, k).is_some_and(|v| !v.is_empty())) => {
            return Some(joined(&[&text("a fixed "), get(s, "desktopwidth").unwrap_or(&[63]), &text("×"), get(s, "desktopheight").unwrap_or(&[63]), &text(" window (the desktop follows the pane; Settings › Remote Desktop › When the pane is resized)")]));
        }
        "gatewayhostname" if !v.is_empty() && !uses_gateway(s) => {
            return Some(joined(&[&text("the RD Gateway "), v, &text(", which the file names but doesn't use (the profile's RD Gateway field takes it)")]));
        }
        "promptcredentialonce" if eq(v, "0") && uses_gateway(s) => "an account of its own for the gateway (pick a saved account as the profile's Gateway account)",
        "gatewaycredentialssource" if (eq(v, "1") || eq(v, "5")) && uses_gateway(s) => {
            return Some(text(&format!("a {} at the gateway (not supported; it is signed in to with a user name and password)", if eq(v, "1") { "smart card" } else { "sign-in page" })));
        }
        "remoteapplicationmode" if eq(v, "1") => "RemoteApp (not supported; the whole desktop opens)",
        "alternate shell" if !v.is_empty() => "a program to start instead of the desktop (not supported)",
        "enablecredsspsupport" if eq(v, "0") => "sign-in without Network Level Authentication (it is always used)",
        _ => return None,
    };
    Some(text(fixed))
}

/// Import the supported settings. Repeated clipboard restrictions narrow even when a later line enables sharing.
pub fn parse(bytes: &[u8]) -> Result<Option<RdpFile>, Error> {
    if bytes.len() > MAX_FILE {
        return Err(Error::TooLarge);
    }
    let decoded = decode(bytes)?;
    let mut settings = Settings::new();
    let mut clipboard_off = false;
    for line in decoded.split_inclusive(|c| *c == 10) {
        let line = match line.strip_suffix(&[10]) {
            Some(line) => line.strip_suffix(&[13]).unwrap_or(line),
            None => line,
        };
        if let Some((key, value)) = setting(line) {
            if key == "redirectclipboard" {
                let zero = if matches!(value.first(), Some(43 | 45)) {
                    &value[1..]
                } else {
                    value
                };
                clipboard_off |= !zero.is_empty() && zero.iter().all(|c| *c == 48);
            }
            if let Some((_, old)) = settings.iter_mut().find(|(k, _)| *k == key) {
                *old = value;
            } else {
                settings.push((key, value));
            }
        }
    }
    let Some((host, explicit_port)) = get(&settings, "full address").and_then(address) else {
        return Ok(None);
    };
    let port_text =
        explicit_port.or_else(|| get(&settings, "server port").filter(|v| !v.is_empty()));
    let Some(port) = port_text
        .map_or(Some(3389.0), number)
        .filter(|p| p.fract() == 0.0 && (1.0..=65535.0).contains(p))
    else {
        return Ok(None);
    };
    let scale = get(&settings, "desktopscalefactor")
        .and_then(number)
        .filter(|n| *n >= 100.0);
    let mut ignored = Vec::new();
    for (key, value) in &settings {
        if let Some(note) = note(key, value, &settings) {
            if !ignored.contains(&note) {
                ignored.push(note);
            }
        }
    }
    Ok(Some(RdpFile {
        host: host.to_vec(),
        port: port as u16,
        username: get(&settings, "username")
            .filter(|v| !v.is_empty())
            .map(<[u16]>::to_vec),
        domain: get(&settings, "domain")
            .filter(|v| !v.is_empty())
            .map(<[u16]>::to_vec),
        sharpness: scale.map(|n| if n >= 150.0 { "retina" } else { "standard" }),
        gateway: uses_gateway(&settings)
            .then(|| get(&settings, "gatewayhostname").unwrap().to_vec()),
        clipboard: clipboard_off.then_some("off"),
        ignored,
    }))
}
