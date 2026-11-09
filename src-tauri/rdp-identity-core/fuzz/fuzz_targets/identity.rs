#![no_main]
use libfuzzer_sys::fuzz_target;
use paddy_rdp_identity_core::{text, *};
use serde_json::json;

fuzz_target!(|data: &[u8]| {
    // Arbitrary request bytes reach the real 8 MiB boundary without filtering.
    let _ = dispatch(data);
    // Generated identities have a separate bound; raw requests above are not clamped.
    let units: Vec<u16> = data
        .chunks_exact(2)
        .take(4096)
        .map(|v| u16::from_le_bytes([v[0], v[1]]))
        .collect();
    let split = units.len() / 3;
    let (a, rest) = units.split_at(split);
    let (b, c) = rest.split_at(split);
    assert_eq!(text::parse(&text::token(&units)).unwrap(), units);
    let fields = Fields {
        user: a.to_vec(),
        host: b.to_vec(),
        port: c.to_vec(),
    };
    let key = key_of(&fields);
    let decoded = key_fields(&key);
    assert_eq!(decoded.user, a);
    assert_eq!(decoded.host, text::lower(b));
    assert_eq!(decoded.port, c);
    assert!(is_target_key(&key));
    // Independent delimiter examples supplement the round-trip properties.
    assert_eq!(
        user_scope(&text::literal("a#b%")),
        text::literal("@user#a%23b%25")
    );
    assert!(rekeyed(
        &text::literal("u@h:22#d#extra"),
        &text::literal("u@h:22"),
        a
    )
    .is_none());
    for op in [
        "key_from_config",
        "legacy_key",
        "key_fields",
        "is_target_key",
        "nested_key",
        "shown_key",
        "via_matches",
        "session_key",
        "sign_in_name",
        "is_login_of",
        "user_scope",
        "key_parts",
        "rekeyed",
    ] {
        let value = handle(json!({"op":op,"a":text::token(a),"b":text::token(b),
            "c":text::token(c),"hasVia":data.first().is_some_and(|v| v & 1 != 0)}))
        .unwrap();
        if let Some(s) = value.as_str() {
            assert!(text::parse(s).is_ok());
        }
    }
});
