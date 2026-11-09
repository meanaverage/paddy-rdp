//! Target identities and credential/trust key scopes. All identities retain UTF-16 code units.
pub mod text;
use serde_json::{json, Value};
use text::{join, literal, lower, token, trim, Text};

fn escape(value: &[u16], kind: u8) -> Text {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut out = Vec::new();
    for &c in value {
        if c < 0x20
            || c == 0x7f
            || matches!(c, 0x25 | 0x23 | 0x3e)
            || kind >= 1 && c == 0x40
            || kind >= 2 && c == 0x3a
        {
            out.extend([
                0x25,
                u16::from(HEX[(c >> 4) as usize]),
                u16::from(HEX[(c & 15) as usize]),
            ]);
        } else {
            out.push(c);
        }
    }
    out
}
fn hex(c: u16) -> Option<u16> {
    match c {
        0x30..=0x39 => Some(c - 0x30),
        0x41..=0x46 => Some(c - 0x41 + 10),
        _ => None,
    }
}
fn unescape(value: &[u16], display: bool) -> Text {
    let mut result = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if value[i] == 0x25 && i + 2 < value.len() {
            if let (Some(a), Some(b)) = (hex(value[i + 1]), hex(value[i + 2])) {
                let c = a * 16 + b;
                if !display || matches!(c, 0x25 | 0x23 | 0x3e | 0x40 | 0x3a) {
                    result.push(c);
                    i += 3;
                    continue;
                }
            }
        }
        result.push(value[i]);
        i += 1;
    }
    result
}

#[derive(Debug, PartialEq, Eq)]
pub struct Fields {
    pub user: Text,
    pub host: Text,
    pub port: Text,
}

pub fn key_of(fields: &Fields) -> Text {
    join(&[
        &escape(&fields.user, 0),
        &[0x40],
        &escape(&lower(&fields.host), 1),
        &[0x3a],
        &escape(&fields.port, 2),
    ])
}
pub fn key_fields(key: &[u16]) -> Fields {
    let value = &key[key.iter().rposition(|c| *c == 0x3e).map_or(0, |i| i + 1)..];
    let at = value
        .iter()
        .rposition(|c| *c == 0x40)
        .map_or(-1, |i| i as isize);
    let colon = value
        .iter()
        .rposition(|c| *c == 0x3a)
        .map_or(-1, |i| i as isize);
    let end = if colon > at {
        colon as usize
    } else {
        value.len()
    };
    Fields {
        user: unescape(&value[..at.max(0) as usize], false),
        host: unescape(&value[(at + 1) as usize..end], false),
        port: unescape(&value[(end + 1).min(value.len())..], false),
    }
}
fn config_field(out: &[u16], name: &str) -> Option<Text> {
    let prefix = literal(&format!("{name} "));
    out.split(|c| matches!(*c, 10 | 13 | 0x2028 | 0x2029))
        .find_map(|line| {
            let value = line.strip_prefix(prefix.as_slice())?;
            (!value.is_empty()).then(|| trim(value).to_vec())
        })
}
pub fn config_fields(out: &[u16], destination: &[u16]) -> Fields {
    Fields {
        user: config_field(out, "user").unwrap_or_default(),
        host: config_field(out, "hostname").unwrap_or_else(|| destination.to_vec()),
        port: config_field(out, "port").unwrap_or_else(|| literal("22")),
    }
}
pub fn key_from_config(out: &[u16], destination: &[u16]) -> Text {
    key_of(&config_fields(out, destination))
}
pub fn legacy_key(out: &[u16], destination: &[u16]) -> Text {
    let fields = config_fields(out, destination);
    join(&[
        &fields.user,
        &[0x40],
        &lower(&fields.host),
        &[0x3a],
        &fields.port,
    ])
}
pub fn is_target_key(key: &[u16]) -> bool {
    let mut parts = key.split(|c| *c == 0x3e);
    let first = parts.next().unwrap();
    if key_of(&key_fields(first)) != first {
        return false;
    }
    if let Some(second) = parts.next() {
        if key_of(&key_fields(second)) != second {
            return false;
        }
    }
    parts.next().is_none()
}
pub fn nested_key(outer: &[u16], config: &[u16], destination: &[u16]) -> Text {
    join(&[outer, &[0x3e], &key_from_config(config, destination)])
}
pub fn shown_key(key: &[u16]) -> Text {
    let mut parts = key.split(|c| *c == 0x3e);
    let outer = parts.next().unwrap();
    match parts.next() {
        None => unescape(outer, true),
        Some(inner) => join(&[
            &unescape(inner, true),
            &literal(", through "),
            &unescape(outer, true),
        ]),
    }
}
pub fn via_matches(via: &[u16], key: &[u16], label: &[u16], has_via: bool) -> bool {
    let v = lower(trim(via));
    if v.is_empty() || has_via {
        return false;
    }
    let Fields { user, host, port } = key_fields(key);
    let user_host = join(&[&user, &[0x40], &host]);
    let written = &user_host[user_host.iter().position(|c| *c == 0x40).unwrap() + 1..];
    let full = join(&[&user_host, &[0x3a], &port]);
    let matched = [
        key,
        full.as_slice(),
        user_host.as_slice(),
        host.as_slice(),
        written,
        label,
    ]
    .iter()
    .any(|name| lower(name) == v);
    matched
}

pub fn session_key(target: &[u16], id: &[u16]) -> Text {
    if id == literal("own") {
        target.to_vec()
    } else {
        join(&[target, &[0x23], id])
    }
}
pub fn sign_in_name(username: &[u16], domain: &[u16]) -> Text {
    if !domain.is_empty() && !username.iter().any(|c| matches!(*c, 0x5c | 0x40)) {
        join(&[domain, &[0x5c], username])
    } else {
        username.to_vec()
    }
}
pub fn is_login_of(username: &[u16], who: &[u16]) -> bool {
    let slash = who.iter().position(|c| *c == 0x5c).unwrap_or(0);
    !who.is_empty() && sign_in_name(username, &who[..slash]) == who
}
pub fn user_scope(who: &[u16]) -> Text {
    if who.is_empty() {
        Vec::new()
    } else {
        join(&[&literal("@user#"), &escape(who, 0)])
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct Parts {
    pub target: Text,
    pub desktop_id: Text,
    pub user: Text,
    pub gateway: Text,
}

/// Grammar shared by keyParts and rekeyed: a desktop id, optional @user# scope,
/// then optional @gateway# scope. Extra '#' characters are never matched partially.
fn scopes(rest: &[u16]) -> Option<(&[u16], &[u16], &[u16])> {
    let hashes: Vec<usize> = rest
        .iter()
        .enumerate()
        .filter_map(|(i, c)| (*c == 0x23).then_some(i))
        .take(3)
        .collect();
    match hashes.as_slice() {
        [] => Some((rest, &[], &[])),
        &[hash] => {
            let before = &rest[..hash];
            if let Some(id) = before.strip_suffix(literal("@user").as_slice()) {
                Some((id, &rest[id.len()..], &[]))
            } else {
                before
                    .strip_suffix(literal("@gateway").as_slice())
                    .map(|id| (id, &[][..], &rest[id.len()..]))
            }
        }
        &[first, second] => {
            let id = rest[..first].strip_suffix(literal("@user").as_slice())?;
            let middle = rest[first + 1..second].strip_suffix(literal("@gateway").as_slice())?;
            let gateway = first + 1 + middle.len();
            Some((id, &rest[id.len()..gateway], &rest[gateway..]))
        }
        _ => None,
    }
}
pub fn key_parts(key: &[u16]) -> Parts {
    let Some(hash) = key.iter().position(|c| *c == 0x23) else {
        return Parts {
            target: key.to_vec(),
            desktop_id: Vec::new(),
            user: Vec::new(),
            gateway: Vec::new(),
        };
    };
    let rest = &key[hash + 1..];
    let (id, user, gateway) = scopes(rest).unwrap_or((rest, &[], &[]));
    Parts {
        target: key[..hash].to_vec(),
        desktop_id: id.to_vec(),
        user: user.to_vec(),
        gateway: gateway.to_vec(),
    }
}
pub fn rekeyed(key: &[u16], from: &[u16], to: &[u16]) -> Option<Text> {
    if key == from {
        return Some(to.to_vec());
    }
    let rest = key.strip_prefix(from)?.strip_prefix(&[0x23])?;
    scopes(rest)?;
    Some(join(&[to, &[0x23], rest]))
}

fn field(v: &Value, name: &str) -> Result<Text, String> {
    text::parse(
        v[name]
            .as_str()
            .ok_or_else(|| format!("Missing identity field {name}"))?,
    )
}
fn output(value: &[u16]) -> Value {
    Value::String(token(value))
}
pub fn handle(request: Value) -> Result<Value, String> {
    let a = || field(&request, "a");
    let b = || field(&request, "b");
    let c = || field(&request, "c");
    Ok(
        match request["op"].as_str().ok_or("Missing identity operation")? {
            "key_from_config" => output(&key_from_config(&a()?, &b()?)),
            "legacy_key" => output(&legacy_key(&a()?, &b()?)),
            "key_fields" => {
                let f = key_fields(&a()?);
                json!({"user":token(&f.user),"host":token(&f.host),"port":token(&f.port)})
            }
            "is_target_key" => json!(is_target_key(&a()?)),
            "nested_key" => output(&nested_key(&a()?, &b()?, &c()?)),
            "shown_key" => output(&shown_key(&a()?)),
            "via_matches" => json!(via_matches(
                &a()?,
                &b()?,
                &c()?,
                request["hasVia"]
                    .as_bool()
                    .ok_or("Missing via observation")?
            )),
            "session_key" => output(&session_key(&a()?, &b()?)),
            "sign_in_name" => output(&sign_in_name(&a()?, &b()?)),
            "is_login_of" => json!(is_login_of(&a()?, &b()?)),
            "user_scope" => output(&user_scope(&a()?)),
            "key_parts" => {
                let p = key_parts(&a()?);
                json!({"target":token(&p.target),"desktopId":token(&p.desktop_id),"user":token(&p.user),"gateway":token(&p.gateway)})
            }
            "rekeyed" => rekeyed(&a()?, &b()?, &c()?).map_or(Value::Null, |v| output(&v)),
            _ => return Err("Unknown identity operation".into()),
        },
    )
}
pub fn dispatch(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > paddy_page_core::MAX_REQUEST {
        return Err("Request is too large".into());
    }
    handle(serde_json::from_slice(bytes).map_err(|e| e.to_string())?)
}
#[cfg(all(target_arch = "wasm32", feature = "page"))]
paddy_page_core::export!(handle);
