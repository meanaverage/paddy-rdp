#![no_main]
use libfuzzer_sys::fuzz_target;
use paddy_rdp_desktop_core::{
    data::{self, object, text, Data},
    *,
};
fuzz_target!(|bytes: &[u8]| {
    // Every byte reaches the actual request decoder and its 8 MiB bound.
    let _ = dispatch(bytes);
    // Generated valid observations have their own smaller bound.
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .take(2048)
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
        .collect();
    let value = Data::Text(units.clone());
    assert_eq!(data::decode(&data::encode(&value)).unwrap(), value);
    let _ = data::number(&units);
    let _ = vm_id(&value);
    let _ = wake_from_text(&value);
    let n = bytes
        .get(..8)
        .map(|b| f64::from_le_bytes(b.try_into().unwrap()))
        .unwrap_or(0.0);
    let entry = object(&[
        ("host", value.clone()),
        ("port", Data::Number(n)),
        ("kind", text("xrdp")),
        ("kindFromHost", Data::Bool(true)),
        ("clipboard", value.clone()),
        ("wake", object(&[("vm", value.clone()), ("mac", value)])),
    ]);
    let spec = spec_of(&entry);
    if spec != Data::Null {
        assert_eq!(spec.get("kindTrusted"), &Data::Bool(false));
    }
    let _ = entry_text(&entry);
    let _ = parse_wake(entry.get("wake"));
    let target = object(&[("key", text("u@host:22")), ("label", text("host"))]);
    let _ = desktops_for(
        &target,
        &Data::Array(vec![entry.clone(), entry.clone()]),
        &Data::Undefined,
        &Data::Array(vec![entry]),
        &text("both"),
    );
    // Unknown persisted clipboard values must never allow either direction.
    assert!(own_clipboard(&object(&[])).is("off"));
    assert_eq!(
        clipboard_ways(&[text("off")]).get("toRemote"),
        &Data::Bool(false)
    );
    assert_eq!(
        clipboard_ways(&[text("off")]).get("fromRemote"),
        &Data::Bool(false)
    );
});
