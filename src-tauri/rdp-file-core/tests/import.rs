use paddy_rdp_file_core::{parse, Error, MAX_FILE};
fn text(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

#[test]
fn supported_properties() {
    // Microsoft's supported RDP properties document full address, username, domain, scale and
    // redirectclipboard:0. The 3389 default is the registered RDP port; explicit address ports win.
    let got = parse(b"full address:s:desktop.example\r\nusername:s:alice\r\ndomain:s:EXAMPLE\r\ndesktopscalefactor:i:150\r\nredirectclipboard:i:0\r\n").unwrap().unwrap();
    assert_eq!(got.host, text("desktop.example"));
    assert_eq!(got.port, 3389);
    assert_eq!(got.username, Some(text("alice")));
    assert_eq!(got.domain, Some(text("EXAMPLE")));
    assert_eq!(got.sharpness, Some("retina"));
    assert_eq!(got.clipboard, Some("off"));
    assert!(got.ignored.is_empty());
}

#[test]
fn duplicate_values_keep_restrictions_and_note_order() {
    let got = parse(b"full address:s:[::1]:3390\nserver port:i:0\nredirectdrives:i:1\nredirectprinters:i:0\nredirectclipboard:i:-000\nredirectclipboard:i:1\ndrivestoredirect:s:*\nredirectprinters:i:1\n").unwrap().unwrap();
    assert_eq!(got.host, text("::1"));
    assert_eq!(got.port, 3390);
    assert_eq!(got.clipboard, Some("off"));
    assert_eq!(
        got.ignored,
        vec![
            text("its drives (share folders in Settings › Remote Desktop › Shared folders)"),
            text("printer redirection (not supported)")
        ]
    );
}

#[test]
fn gateways_are_used_unless_exact_method_disables_them() {
    for method in ["", "1", "2", "3", "00", "4", "0"] {
        let file = format!("full address:s:desktop\ngatewayhostname:s:gateway\ngatewayusagemethod:i:{method}\npromptcredentialonce:i:0\n");
        let got = parse(file.as_bytes()).unwrap().unwrap();
        let uses = !["0", "4"].contains(&method);
        assert_eq!(got.gateway, uses.then(|| text("gateway")));
        assert_eq!(got.ignored.len(), 1);
    }
}

#[test]
fn utf16_and_malformed_encodings() {
    let mut units = text("full address:s:desktop\nusername:s:");
    units.extend([0xd800, 0x61, 0xd801]);
    for big in [false, true] {
        let mut bytes = if big {
            vec![0xfe, 0xff]
        } else {
            vec![0xff, 0xfe]
        };
        for c in &units {
            bytes.extend(if big {
                c.to_be_bytes()
            } else {
                c.to_le_bytes()
            });
        }
        assert_eq!(
            parse(&bytes).unwrap().unwrap().username,
            Some(vec![0xd800, 0x61, 0xd801])
        );
        bytes.push(1);
        if big {
            assert_eq!(parse(&bytes), Err(Error::OddBigEndian));
        } else {
            assert!(parse(&bytes).unwrap().is_some());
        }
    }
    assert_eq!(
        parse(b"full address:s:desktop\nusername:s:\xf0\x80\x80\x80")
            .unwrap()
            .unwrap()
            .username,
        Some(vec![0xfffd; 4])
    );
}

#[test]
fn line_grammar_and_unicode_whitespace() {
    let got = parse(
        "\u{feff}FULL ADDRESS : S : desktop\r\nusername:s:ignored\r\ndomain:s:bad\u{2028}"
            .as_bytes(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(got.host, text("desktop"));
    assert_eq!(got.username, Some(text("ignored")));
    assert_eq!(got.domain, None);
    assert_eq!(parse(b"full address:s:desktop\r"), Ok(None));
    assert_eq!(parse(b"full address:s:desktop\r\r\n"), Ok(None));
}

#[test]
fn bounds_and_invalid_destinations() {
    let mut max = b"full address:s:desktop\n".to_vec();
    max.resize(MAX_FILE, b' ');
    assert!(parse(&max).unwrap().is_some());
    max.push(0);
    assert_eq!(parse(&max), Err(Error::TooLarge));
    for host in [
        "",
        "host#other",
        "[::1]#other",
        "host:0",
        "host:65536",
        "host:1.5",
        "host:abc",
        "with space",
    ] {
        assert_eq!(
            parse(format!("full address:s:{host}\n").as_bytes()),
            Ok(None),
            "{host}"
        );
    }
}

#[test]
fn numeric_compatibility() {
    for (port, expected) in [
        ("0xd3d", Some(3389)),
        ("0b110100111101", Some(3389)),
        ("0o6475", Some(3389)),
        ("3.389e3", Some(3389)),
        ("+3389.0", Some(3389)),
        ("0x_d3d", None),
        ("Infinity", None),
        ("1_000", None),
        ("65535.000000000001", Some(65535)),
    ] {
        let got =
            parse(format!("full address:s:desktop\nserver port:i:{port}\n").as_bytes()).unwrap();
        assert_eq!(got.map(|p| p.port), expected, "{port}");
    }
}
