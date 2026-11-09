#![no_main]
use libfuzzer_sys::fuzz_target;
use paddy_rdp_file_core::{parse, Error, MAX_FILE};
fuzz_target!(|bytes: &[u8]| {
    let result = parse(bytes);
    if bytes.len() > MAX_FILE {
        assert_eq!(result, Err(Error::TooLarge));
    } else if let Ok(Some(file)) = result {
        assert!(!file.host.is_empty());
        assert!(!file.host.contains(&35));
        assert!(file.port > 0);
        assert!(file.host.len() <= MAX_FILE);
        assert!(file.username.as_ref().is_none_or(|v| v.len() <= MAX_FILE));
        assert!(file.domain.as_ref().is_none_or(|v| v.len() <= MAX_FILE));
        assert!(file.gateway.as_ref().is_none_or(|v| v.len() <= MAX_FILE));
        assert!(file.ignored.len() <= 16);
        for (i, note) in file.ignored.iter().enumerate() {
            assert!(note.len() <= MAX_FILE + 256);
            assert!(!file.ignored[..i].contains(note));
        }
    }
});
