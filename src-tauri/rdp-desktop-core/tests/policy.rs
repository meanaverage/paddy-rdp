use paddy_rdp_desktop_core::{
    data::{self, object, text, Data},
    *,
};
use paddy_rdp_identity_core::text::literal as t;
use serde_json::json;

#[test]
fn observation_codec_preserves_missing_nonfinite_and_utf16_values() {
    let value = object(&[
        ("missing", Data::Undefined),
        ("null", Data::Null),
        ("text", Data::Text(vec![0xd800, 0xfffd])),
        ("zero", Data::Number(-0.0)),
    ]);
    let copy = data::decode(&data::encode(&value)).unwrap();
    assert_eq!(copy, value);
    assert!(copy.get("zero").numeric().is_sign_negative());
    assert!(data::decode(&json!(["n", "NaN"]))
        .unwrap()
        .numeric()
        .is_nan());
    assert_eq!(
        data::decode(&json!(["n", "Infinity"])).unwrap().numeric(),
        f64::INFINITY
    );
    for value in [
        json!(null),
        json!(["s", "null"]),
        json!(["n", "inf"]),
        json!(["u", 1]),
        json!(["o", [["null", ["z"]]]]),
    ] {
        assert!(data::decode(&value).is_err());
    }
}

#[test]
fn scalar_numbers_keep_javascript_grammar_and_negative_zero() {
    // Values from Number's scalar grammar, not Rust's broader float spellings.
    for (source, expected) in [
        ("", 0.0),
        ("\u{feff}9\u{a0}", 9.0),
        ("0x10", 16.0),
        ("0o10", 8.0),
        ("0b10", 2.0),
        ("1.e2", 100.0),
        (".5", 0.5),
        ("1e309", f64::INFINITY),
    ] {
        assert_eq!(data::number(&t(source)), expected, "{source}");
    }
    for source in [
        "inf", "infinity", "+0x1", "0x", "1_000", "1e", ".1x", "１２",
    ] {
        assert!(data::number(&t(source)).is_nan(), "{source}");
    }
    assert!(data::number(&t("-0")).is_sign_negative());
    assert!(data::decode(&json!(["n", "-0"]))
        .unwrap()
        .numeric()
        .is_sign_negative());
    assert_eq!(
        data::number(&t(&format!("0x1{}", "0".repeat(10000)))),
        f64::INFINITY
    );
}

#[test]
fn host_reported_xrdp_never_gains_unasked_password_consent() {
    let mut entry = object(&[
        ("host", text("desk")),
        ("kind", text("xrdp")),
        ("wake", object(&[("vm", text("guest"))])),
    ]);
    assert!(xrdp_from_host(&entry));
    assert_eq!(spec_of(&entry).get("kindTrusted"), &Data::Bool(false));
    entry.set("kindFromHost", Data::Bool(false));
    assert!(!xrdp_from_host(&entry));
    assert_eq!(spec_of(&entry).get("kindTrusted"), &Data::Bool(true));
    entry.set("kindFromHost", Data::Bool(true));
    assert_eq!(spec_of(&entry).get("kindTrusted"), &Data::Bool(false));
    let target = object(&[("key", text("u@host:22")), ("label", text("host"))]);
    let list = desktops_for(
        &target,
        &Data::Undefined,
        &object(&[("kind", text("xrdp"))]),
        &Data::Array(vec![]),
        &text("both"),
    );
    assert!(list.items()[0].get("kindTrusted").missing());
}

#[test]
fn desktop_duplicates_keep_first_values_and_narrow_clipboard_permission() {
    let target = object(&[("key", text("u@host:22")), ("label", text("alias"))]);
    let first = object(&[
        ("via", text("alias")),
        ("host", text("desk")),
        ("name", text("first")),
    ]);
    let second = object(&[
        ("via", text("alias")),
        ("host", text("desk")),
        ("name", text("second")),
        ("clipboard", text("off")),
    ]);
    let extras = Data::Array(vec![first, second]);
    let list = desktops_for(
        &target,
        &extras,
        &Data::Undefined,
        &Data::Array(vec![]),
        &text("both"),
    );
    assert_eq!(list.items().len(), 2);
    assert!(list.items()[1].get("name").is("first"));
    assert!(list.items()[1].get("clipboard").is("off"));
    let mut nested = target;
    nested.set("via", object(&[]));
    assert_eq!(
        desktops_for(
            &nested,
            &extras,
            &Data::Undefined,
            &Data::Array(vec![]),
            &text("both")
        )
        .items()
        .len(),
        1
    );
}

#[test]
fn desktop_validation_preserves_bounds_and_exact_host_identities() {
    for port in [0.5, -1.0, 65536.0, f64::INFINITY] {
        assert_eq!(
            spec_of(&object(&[("port", Data::Number(port))])),
            Data::Null
        );
    }
    assert_eq!(spec_of(&object(&[("host", text("a#b"))])), Data::Null);
    let entry = object(&[("host", Data::Text(vec![0xd800])), ("port", text("0xD3D"))]);
    assert_eq!(
        spec_of(&entry).get("id").string(),
        [&[0xd800][..], &t(":3389")].concat()
    );
    assert_eq!(
        desktop_id(&object(&[("port", text("inf"))])),
        t("127.0.0.1:NaN")
    );
    // A falsy zero retains the shipped default-port behavior.
    assert_eq!(
        spec_of(&object(&[("port", Data::Number(0.0))])).get("port"),
        &Data::Number(3389.0)
    );
}

#[test]
fn wake_forms_keep_priority_and_existing_validation_dialect() {
    let guid = "5F05E000-1234-ABCD-EF01-0123456789AB";
    assert_eq!(vm_id(&text(&format!(" {{ {guid} }} "))), Vec::<u16>::new());
    assert_eq!(vm_id(&text(&format!("{{{guid}"))), t(&guid.to_lowercase()));
    let wake = object(&[
        ("hyperv", text(guid)),
        ("vm", text("guest")),
        ("mac", text("aabbccddeeff")),
    ]);
    assert_eq!(
        parse_wake(&wake),
        object(&[("hyperv", text(&guid.to_lowercase()))])
    );
    let wol = object(&[
        ("mac", text("AA-BB-CC-DD-EE-FF")),
        ("broadcast", text("999.1.2.3")),
        ("port", text("10")),
    ]);
    assert_eq!(
        parse_wake(&wol),
        object(&[
            ("mac", text("AA-BB-CC-DD-EE-FF")),
            ("broadcast", text("999.1.2.3")),
            ("port", Data::Number(10.0))
        ])
    );
    assert!(parse_wake(&object(&[("mac", text("aa-bb:cc-dd-ee-ff"))])).missing());
    assert_eq!(
        wake_from_text(&text(" guest ")),
        object(&[("vm", text("guest"))])
    );
}

#[test]
fn clipboard_permissions_fail_closed_and_paste_excludes_blocked_desktops() {
    assert!(own_clipboard(&object(&[])).is("off"));
    assert!(clipboard_setting(&Data::Undefined).is("both"));
    assert!(narrowest(&[text("both"), text("fromRemote")]).is("fromRemote"));
    assert!(narrowest(&[text("off"), text("both")]).is("off"));
    let setup = clipboard_setup(&text("both"), false);
    assert!(setup.get("mode").is("off"));
    assert_eq!(setup.get("stop"), &Data::Bool(true));
    assert_eq!(setup.get("disable"), &Data::Bool(true));
    let plan = paste_plan(&Data::Array(vec![
        Data::Bool(true),
        Data::Bool(false),
        Data::Bool(true),
    ]));
    assert_eq!(
        plan.get("targets"),
        &Data::Array(vec![Data::Number(0.0), Data::Number(2.0)])
    );
    assert_eq!(plan.get("left"), &Data::Array(vec![Data::Number(1.0)]));
    assert!(paste_note(3, 2, &Data::Array(vec![text("two")])).is(
        "Pasting on 2 of 3 desktops: not on two, which doesn't take this computer's clipboard."
    ));
}
