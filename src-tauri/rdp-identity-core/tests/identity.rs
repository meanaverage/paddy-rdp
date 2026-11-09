use paddy_rdp_identity_core::text::{literal as t, parse, token};
use paddy_rdp_identity_core::*;

#[test]
fn inner_json_retains_every_utf16_code_unit_and_rejects_bad_literals() {
    // JSON string escapes are UTF-16 code units; an unpaired one is still an identity,
    // not U+FFFD. All 65,536 units are exercised individually as well as paired.
    for unit in 0u16..=u16::MAX {
        assert_eq!(parse(&token(&[unit])).unwrap(), [unit]);
    }
    let units = [0, 9, 10, 34, 92, 0xd800, 0xdc00, 0xdc00, 0x41, 0xd800];
    assert_eq!(parse(&token(&units)).unwrap(), units);
    for bad in [
        "",
        "null",
        "3",
        "\"",
        "\"x\"tail",
        "\"\\u12\"",
        "\"\\z\"",
        "\"\n\"",
    ] {
        assert!(parse(bad).is_err(), "{bad:?}");
    }
    assert_eq!(
        parse(r#""a\b\f\n\r\t\/\"\\""#).unwrap(),
        [97, 8, 12, 10, 13, 9, 47, 34, 92]
    );
}

#[test]
fn canonical_keys_escape_only_delimiters_and_controls_without_aliasing() {
    let config = t("user alice@corp#ops\nhostname FE80::1%en0@host>name\nport 22:side\n");
    assert_eq!(
        key_from_config(&config, &t("unused")),
        t("alice@corp%23ops@fe80::1%25en0%40host%3Ename:22%3Aside")
    );
    let fields = key_fields(&key_from_config(&config, &[]));
    assert_eq!(fields.user, t("alice@corp#ops"));
    assert_eq!(fields.host, t("fe80::1%en0@host>name"));
    assert_eq!(fields.port, t("22:side"));
    assert!(is_target_key(&key_from_config(&config, &[])));
    assert_ne!(
        key_from_config(&t("user a%23b\n"), &t("host")),
        key_from_config(&t("user a#b\n"), &t("host"))
    );
    assert_eq!(
        shown_key(&t("u%23x@h:22>v%00%40y@x:22>ignored")),
        t("v%00@y@x:22, through u#x@h:22")
    );
    assert_eq!(key_fields(&t("u%2f%2F@HOST:22")).user, t("u%2f/"));
}

#[test]
fn configuration_keeps_first_matching_field_and_javascript_line_and_trim_rules() {
    let config = t("hostname \nhostname  \r\nhostname later\u{2028}user \u{feff}Alice\u{a0}\u{2029}port 22\nport 99");
    assert_eq!(key_from_config(&config, &t("fallback")), t("Alice@:22"));
    assert_eq!(key_from_config(&[], &t("ΟΣ")), t("@ος:22"));
    assert_eq!(key_from_config(&[], &t("İ")), t("@i\u{307}:22"));
    assert_eq!(
        key_from_config(&t("user A\u{85}B\n"), &t("host")),
        t("A\u{85}B@host:22")
    );
}

#[test]
fn nested_hosts_cannot_match_direct_targets_or_borrow_their_scope() {
    let outer = t("outer@jump:22");
    let nested = nested_key(&outer, &t("user admin\nhostname desktop\nport 22"), &[]);
    assert_eq!(nested, t("outer@jump:22>admin@desktop:22"));
    assert_ne!(nested, t("admin@desktop:22"));
    assert!(is_target_key(&nested));
    assert!(!is_target_key(
        &[nested.clone(), t(">third@host:22")].concat()
    ));
    assert!(via_matches(
        &t(" DESKTOP "),
        &t("admin@desktop:22"),
        &t("alias"),
        false
    ));
    assert!(!via_matches(&t("desktop"), &nested, &t("desktop"), true));
}

#[test]
fn credential_scopes_are_whole_parts_and_malformed_keys_are_never_rekeyed() {
    let original = t("u@host:22#desk@user#D\\alice@gateway#gw:443");
    let p = key_parts(&original);
    assert_eq!(p.target, t("u@host:22"));
    assert_eq!(p.desktop_id, t("desk"));
    assert_eq!(p.user, t("@user#D\\alice"));
    assert_eq!(p.gateway, t("@gateway#gw:443"));
    assert_eq!(
        rekeyed(&original, &t("u@host:22"), &t("new@host:22")).unwrap(),
        t("new@host:22#desk@user#D\\alice@gateway#gw:443")
    );
    for key in [
        "u@host:22#desk#extra",
        "u@host:22#desk@gateway#gw@user#u",
        "otheru@host:22#desk",
    ] {
        assert!(rekeyed(&t(key), &t("u@host:22"), &t("new")).is_none());
    }
    assert_eq!(key_parts(&t("rdp#desk#extra")).desktop_id, t("desk#extra"));
    assert_eq!(user_scope(&t("a#b%")), t("@user#a%23b%25"));
    assert_eq!(session_key(&t("u@host:22"), &t("own")), t("u@host:22"));
    assert_eq!(session_key(&t("rdp"), &t("host:3389")), t("rdp#host:3389"));
}

#[test]
fn login_matching_preserves_domain_and_surrogate_identity() {
    assert_eq!(sign_in_name(&t("alice"), &t("DOMAIN")), t("DOMAIN\\alice"));
    assert_eq!(
        sign_in_name(&t("alice@corp"), &t("DOMAIN")),
        t("alice@corp")
    );
    assert!(is_login_of(&t("alice"), &t("DOMAIN\\alice")));
    assert!(!is_login_of(&t("Alice"), &t("DOMAIN\\alice")));
    assert!(!is_login_of(&[], &[]));
    let (a, b) = ([0xd800], [0xfffd]);
    assert_ne!(user_scope(&a), user_scope(&b));
    assert_ne!(key_from_config(&[], &a), key_from_config(&[], &b));
    assert_eq!(key_fields(&key_from_config(&[], &a)).host, a);
}
