//! Remote-desktop configuration, consent and clipboard policy; platform code executes effects.
pub mod data;
use data::{object, optional, text, Data};
use paddy_rdp_identity_core::{
    self as identity,
    text::{join, literal, trim, Text},
};
use serde_json::Value as Json;
use std::collections::HashMap;

fn number(v: f64) -> Data {
    Data::Number(v)
}
fn integer_port(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n > 0.0 && n < 65536.0
}
fn display_number(n: f64) -> Text {
    literal(ryu_js::Buffer::new().format(n))
}
fn config_port(extra: &Data) -> f64 {
    let p = extra.get("port");
    if p.truthy() {
        p.numeric()
    } else {
        3389.0
    }
}
fn config_host(extra: &Data) -> Text {
    if extra.get("host").truthy() {
        extra.get("host").text()
    } else {
        literal("127.0.0.1")
    }
}
pub fn vm_id(value: &Data) -> Text {
    let mut id = trim(value.string());
    if id.first() == Some(&0x7b) {
        id = &id[1..];
    }
    if id.last() == Some(&0x7d) {
        id = &id[..id.len() - 1];
    }
    if id.len() != 36
        || !id.iter().enumerate().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                *c == 0x2d
            } else {
                matches!(*c, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66)
            }
        })
    {
        return Vec::new();
    }
    id.iter()
        .map(|c| {
            if (0x41..=0x46).contains(c) {
                c + 32
            } else {
                *c
            }
        })
        .collect()
}
fn mac(value: &[u16]) -> bool {
    let hex = |c: &u16| matches!(*c, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66);
    if value.len() == 12 {
        return value.iter().all(hex);
    }
    if value.len() != 17 || !matches!(value[2], 0x3a | 0x2d) {
        return false;
    }
    value
        .iter()
        .enumerate()
        .all(|(i, c)| if i % 3 == 2 { *c == value[2] } else { hex(c) })
}
fn ipv4_shape(value: &[u16]) -> bool {
    let parts: Vec<_> = value.split(|c| *c == 0x2e).collect();
    parts.len() == 4
        && parts
            .iter()
            .all(|p| (1..=3).contains(&p.len()) && p.iter().all(|c| (0x30..=0x39).contains(c)))
}
pub fn parse_wake(raw: &Data) -> Data {
    let id = vm_id(raw.get("hyperv"));
    if !id.is_empty() {
        return object(&[("hyperv", Data::Text(id))]);
    }
    let vm = trim(raw.get("vm").string());
    if !vm.is_empty() {
        return object(&[("vm", Data::Text(vm.to_vec()))]);
    }
    let address = trim(raw.get("mac").string());
    if !mac(address) {
        return Data::Undefined;
    }
    let mut out = object(&[("mac", Data::Text(address.to_vec()))]);
    let broadcast = trim(raw.get("broadcast").string());
    if ipv4_shape(broadcast) {
        out.set("broadcast", Data::Text(broadcast.to_vec()));
    }
    let port = if raw.get("port").nullish() {
        9.0
    } else {
        raw.get("port").numeric()
    };
    if integer_port(port) && port != 9.0 {
        out.set("port", number(port));
    }
    out
}
pub fn wake_from_text(value: &Data) -> Data {
    let value = trim(value.string());
    if value.is_empty() {
        Data::Undefined
    } else {
        object(&[(
            if mac(value) { "mac" } else { "vm" },
            Data::Text(value.to_vec()),
        )])
    }
}
pub fn own_clipboard(value: &Data) -> Data {
    if value.nullish() || value.is("") {
        Data::Undefined
    } else if value.is("both") || value.is("fromRemote") || value.is("off") {
        value.clone()
    } else {
        text("off")
    }
}
pub fn clipboard_setting(value: &Data) -> Data {
    let own = own_clipboard(value);
    if own.missing() {
        text("both")
    } else {
        own
    }
}
pub fn clipboard_ways(modes: &[Data]) -> Data {
    object(&[
        ("toRemote", Data::Bool(modes.iter().all(|v| v.is("both")))),
        ("fromRemote", Data::Bool(modes.iter().all(|v| !v.is("off")))),
    ])
}
pub fn narrowest(modes: &[Data]) -> Data {
    if modes.iter().any(|v| v.is("off")) {
        text("off")
    } else if modes.iter().all(|v| v.is("both")) {
        text("both")
    } else {
        text("fromRemote")
    }
}
pub fn clipboard_setup(mode: &Data, hooks: bool) -> Data {
    let mode = if hooks { mode.clone() } else { text("off") };
    object(&[
        ("stop", Data::Bool(!mode.is("both"))),
        ("disable", Data::Bool(mode.is("off"))),
        ("mode", mode),
    ])
}
pub fn xrdp_from_host(extra: &Data) -> bool {
    extra.get("kind").is("xrdp")
        && (extra.get("kindFromHost") == &Data::Bool(true)
            || extra.get("kindFromHost").missing() && extra.get("wake").get("vm").truthy())
}
pub fn hyperv_spec(id: &[u16], name: &[u16], more: &Data) -> Data {
    let mut out = object(&[
        ("id", Data::Text(join(&[&literal("hyperv:"), id]))),
        ("name", Data::Text(name.to_vec())),
        ("kind", text("windows")),
        ("host", text("127.0.0.1")),
        ("port", number(2179.0)),
        ("hyperv", Data::Text(id.to_vec())),
        ("wake", object(&[("hyperv", Data::Text(id.to_vec()))])),
    ]);
    if let Data::Object(entries) = more {
        out.merge(entries.iter().cloned());
    }
    out
}
pub fn spec_of(extra: &Data) -> Data {
    let clipboard = own_clipboard(extra.get("clipboard"));
    let id = vm_id(extra.get("hyperv"));
    let mut names = object(&[
        ("username", optional(extra.get("username").text())),
        ("domain", optional(extra.get("domain").text())),
        ("account", optional(extra.get("account").text())),
    ]);
    if !id.is_empty() {
        if !clipboard.missing() {
            names.set("clipboard", clipboard);
        }
        let name = extra.get("name").text();
        return hyperv_spec(&id, if name.is_empty() { &id } else { &name }, &names);
    }
    let port = config_port(extra);
    let host = config_host(extra);
    if !integer_port(port) || host.is_empty() || host.contains(&0x23) {
        return Data::Null;
    }
    let id = join(&[&host, &[0x3a], &display_number(port)]);
    let name = extra.get("name").text();
    let kind = extra.get("kind");
    let mut out = object(&[
        ("id", Data::Text(id.clone())),
        ("name", Data::Text(if name.is_empty() { id } else { name })),
        (
            "kind",
            if kind.is("gnome") || kind.is("xrdp") {
                kind.clone()
            } else {
                text("windows")
            },
        ),
        ("kindTrusted", Data::Bool(!xrdp_from_host(extra))),
        ("host", Data::Text(host)),
        ("port", number(port)),
        ("username", names.get("username").clone()),
        ("domain", names.get("domain").clone()),
        ("account", names.get("account").clone()),
        ("wake", parse_wake(extra.get("wake"))),
    ]);
    let gateway = trim(extra.get("gateway").string());
    if !gateway.is_empty() {
        out.set("gateway", Data::Text(gateway.to_vec()));
        out.set(
            "gatewayAccount",
            optional(extra.get("gatewayAccount").text()),
        );
    }
    if !clipboard.missing() {
        out.set("clipboard", clipboard);
    }
    out
}
pub fn desktop_id(extra: &Data) -> Text {
    let id = vm_id(extra.get("hyperv"));
    if !id.is_empty() {
        join(&[&literal("hyperv:"), &id])
    } else {
        join(&[
            &config_host(extra),
            &[0x3a],
            &display_number(config_port(extra)),
        ])
    }
}
pub fn entry_text(extra: &Data) -> Data {
    let address = desktop_id(extra);
    let name = extra.get("name").text();
    object(&[
        (
            "name",
            Data::Text(if name.is_empty() {
                address.clone()
            } else {
                name
            }),
        ),
        ("address", Data::Text(address)),
        ("via", Data::Text(extra.get("via").text())),
        ("hyperv", Data::Bool(!vm_id(extra.get("hyperv")).is_empty())),
    ])
}
fn target_matches(via: &Data, target: &Data) -> bool {
    identity::via_matches(
        &via.text(),
        target.get("key").string(),
        target.get("label").string(),
        !target.get("via").missing(),
    )
}
pub fn desktops_for(
    target: &Data,
    extras: &Data,
    found: &Data,
    more: &Data,
    clipboard: &Data,
) -> Data {
    let name = Data::Text(join(&[target.get("label").string(), &literal(" desktop")]));
    let (kind, port, username) = if found.get("kind").is("xrdp") {
        (
            text("xrdp"),
            if found.get("xrdpPort").nullish() {
                number(3389.0)
            } else {
                found.get("xrdpPort").clone()
            },
            Some(found.get("xrdpUser").clone()),
        )
    } else if found.get("kind").is("windows") {
        (
            text("windows"),
            number(3389.0),
            Some(optional(
                identity::key_fields(target.get("key").string()).user,
            )),
        )
    } else {
        (text("gnome"), number(0.0), None)
    };
    let mut own = object(&[
        ("id", text("own")),
        ("name", name),
        ("kind", kind),
        ("host", text("127.0.0.1")),
        ("port", port),
    ]);
    if let Some(user) = username {
        own.set("username", user);
    }
    let mut specs = vec![own];
    let mut ids = HashMap::from([(literal("own"), 0)]);
    for extra in extras
        .items()
        .iter()
        .filter(|e| e.get("via").truthy() && target_matches(e.get("via"), target))
        .chain(more.items())
    {
        let spec = spec_of(extra);
        if spec == Data::Null {
            continue;
        }
        let id = spec.get("id").string().to_vec();
        if let Some(&index) = ids.get(&id) {
            let kept = &mut specs[index];
            let old = if kept.get("clipboard").nullish() {
                clipboard
            } else {
                kept.get("clipboard")
            };
            let new = if spec.get("clipboard").nullish() {
                clipboard
            } else {
                spec.get("clipboard")
            };
            let restricted = narrowest(&[old.clone(), new.clone()]);
            if &restricted != old {
                kept.set("clipboard", restricted);
            }
        } else {
            ids.insert(id, specs.len());
            specs.push(spec);
        }
    }
    let port = found.get("xrdpPort");
    let port_text = match port {
        Data::Number(n) => display_number(*n),
        _ => port.text(),
    };
    let id = join(&[&literal("127.0.0.1:"), &port_text]);
    if found.get("kind").is("gnome") && port.truthy() && !ids.contains_key(&id) {
        specs.push(object(&[
            ("id", Data::Text(id)),
            (
                "name",
                Data::Text(join(&[
                    target.get("label").string(),
                    &literal(" desktop (xrdp)"),
                ])),
            ),
            ("kind", text("xrdp")),
            ("host", text("127.0.0.1")),
            ("port", port.clone()),
            ("username", found.get("xrdpUser").clone()),
        ]));
    }
    Data::Array(specs)
}
pub fn paste_plan(permissions: &Data) -> Data {
    let (mut taking, mut left) = (Vec::new(), Vec::new());
    for (i, p) in permissions.items().iter().enumerate() {
        if p.truthy() {
            taking.push(number(i as f64));
        } else {
            left.push(number(i as f64));
        }
    }
    object(&[
        ("targets", Data::Array(taking)),
        ("left", Data::Array(left)),
    ])
}
pub fn paste_note(total: usize, taking: usize, names: &Data) -> Data {
    let names = names.items();
    if names.is_empty() {
        return Data::Null;
    }
    if taking == 0 {
        return text(&format!(
            "Not pasted: {} take this computer's clipboard.",
            if total > 1 {
                "these desktops don't"
            } else {
                "this desktop doesn't"
            }
        ));
    }
    let mut which = Vec::new();
    for (i, n) in names.iter().enumerate() {
        if i > 0 {
            which.extend(literal(if i == names.len() - 1 { " and " } else { ", " }));
        }
        which.extend(n.string());
    }
    Data::Text(join(&[
        &literal(&format!("Pasting on {taking} of {total} desktops: not on ")),
        &which,
        &literal(if names.len() > 1 {
            ", which don't take this computer's clipboard."
        } else {
            ", which doesn't take this computer's clipboard."
        }),
    ]))
}
pub fn handle(request: Json) -> Result<Json, String> {
    let args = request["args"]
        .as_array()
        .ok_or("Missing policy observations")?
        .iter()
        .map(data::decode)
        .collect::<Result<Vec<_>, _>>()?;
    let arg = |n| args.get(n).ok_or_else(|| format!("Missing argument {n}"));
    let value = match request["op"].as_str().ok_or("Missing policy operation")? {
        "vm_id" => Data::Text(vm_id(arg(0)?)),
        "wake" => parse_wake(arg(0)?),
        "wake_text" => wake_from_text(arg(0)?),
        "own_clipboard" => own_clipboard(arg(0)?),
        "clipboard_setting" => clipboard_setting(arg(0)?),
        "clipboard_ways" => clipboard_ways(arg(0)?.items()),
        "narrowest" => narrowest(arg(0)?.items()),
        "clipboard_setup" => clipboard_setup(arg(0)?, arg(1)? == &Data::Bool(true)),
        "config_text" => Data::Text(arg(0)?.text()),
        "config_number" => number(arg(0)?.numeric()),
        "spec" => spec_of(arg(0)?),
        "xrdp_from_host" => Data::Bool(xrdp_from_host(arg(0)?)),
        "xrdp_unasked" => Data::Bool(
            arg(0)?.get("kind").is("xrdp") && arg(0)?.get("kindTrusted") == &Data::Bool(true),
        ),
        "hyperv_spec" => hyperv_spec(arg(0)?.string(), arg(1)?.string(), arg(2)?),
        "desktop_id" => Data::Text(desktop_id(arg(0)?)),
        "entry_text" => entry_text(arg(0)?),
        "desktops" => desktops_for(arg(0)?, arg(1)?, arg(2)?, arg(3)?, arg(4)?),
        "paste_plan" => paste_plan(arg(0)?),
        "paste_note" => paste_note(
            arg(0)?.numeric() as usize,
            arg(1)?.numeric() as usize,
            arg(2)?,
        ),
        _ => return Err("Unknown policy operation".into()),
    };
    Ok(data::encode(&value))
}
pub fn dispatch(bytes: &[u8]) -> Result<Json, String> {
    if bytes.len() > paddy_page_core::MAX_REQUEST {
        return Err("Request is too large".into());
    }
    handle(serde_json::from_slice(bytes).map_err(|e| e.to_string())?)
}
#[cfg(target_arch = "wasm32")]
paddy_page_core::export!(handle);
