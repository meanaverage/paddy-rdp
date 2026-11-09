#![no_main]
use libfuzzer_sys::fuzz_target;
use paddy_rdp_command_core::{Commands, Output, StderrTail, END, MAX_OUTPUT, OVERFLOW};
fuzz_target!(|bytes: &[u8]| {
    let mut single = Output::default();
    let pushed = single.push(bytes);
    let mut split = Output::default();
    let mut tail = StderrTail::default();
    for chunk in bytes.chunks(1 + bytes.first().copied().unwrap_or(0) as usize * 257) {
        let _ = split.push(chunk);
        tail.push(chunk);
    }
    if bytes.len() > MAX_OUTPUT {
        assert_eq!(pushed, Err(OVERFLOW));
        assert_eq!(single.finish(false), Err(OVERFLOW));
        assert_eq!(split.finish(true), Err(OVERFLOW));
    } else {
        assert_eq!(single.finish(false).unwrap(), String::from_utf8_lossy(bytes));
        let decoded = String::from_utf8_lossy(bytes);
        let end = decoded.rfind(END).unwrap_or(decoded.len());
        assert_eq!(split.finish(true).unwrap(), decoded[..end]);
    }
    assert!(tail.finish().len() <= 4096);
    // Bounded generated lifecycle sequences supplement the unfiltered public output boundary.
    let commands = Commands::default();
    let mut slots = Vec::new();
    for byte in bytes.iter().take(64) {
        let owner = if byte & 1 == 0 { "first" } else { "second" };
        match byte % 3 {
            0 => slots.push(commands.start(owner)),
            1 => { slots.pop(); },
            _ => commands.reset(owner),
        }
        assert!(commands.active("first") + commands.active("second") <= slots.len());
    }
    drop(slots);
    assert_eq!(commands.active("first") + commands.active("second"), 0);
});
