use paddy_rdp_command_core::{Commands, Output, StderrTail, END, MAX_OUTPUT, OVERFLOW};

#[test]
fn stdout_is_decoded_once_and_last_marker_is_removed() {
    let mut output = Output::default();
    for piece in [
        b"a\xf0\x9f".as_slice(),
        b"\x98\x80",
        END.as_bytes(),
        b"middle",
        END.as_bytes(),
        b"\n",
    ] {
        output.push(piece).unwrap();
    }
    assert_eq!(output.finish(true).unwrap(), format!("a😀{END}middle"));
}
#[test]
fn inclusive_output_limit_and_sticky_overflow() {
    let mut output = Output::default();
    output.push(&vec![b'a'; MAX_OUTPUT]).unwrap();
    assert_eq!(output.finish(false).unwrap().len(), MAX_OUTPUT);
    let mut output = Output::default();
    assert_eq!(output.push(&vec![0; MAX_OUTPUT + 1]), Err(OVERFLOW));
    assert_eq!(output.push(&[]), Err(OVERFLOW));
    assert_eq!(output.finish(false), Err(OVERFLOW));
}
#[test]
fn stderr_keeps_legacy_chunk_decoding_and_utf16_tail() {
    let mut tail = StderrTail::default();
    tail.push(b"\xf0\x9f");
    tail.push(b"\x98\x80");
    assert_eq!(tail.finish(), vec![0xfffd, 0xfffd, 0xfffd]);
    let mut tail = StderrTail::default();
    tail.push(format!("😀{}", "x".repeat(4095)).as_bytes());
    let units = tail.finish();
    assert_eq!(units.len(), 4096);
    assert_eq!(units[0], 0xde00);
}
#[tokio::test]
async fn page_reset_cancels_only_its_commands_and_finished_guards_unregister() {
    let commands = Commands::default();
    let (first, rx) = commands.start("first");
    let (second, mut other) = commands.start("second");
    commands.reset("first");
    assert!(rx.await.is_err());
    assert!(matches!(
        other.try_recv(),
        Err(tokio::sync::oneshot::error::TryRecvError::Empty)
    ));
    assert_eq!(commands.active("first"), 0);
    assert_eq!(commands.active("second"), 1);
    drop(first);
    drop(second);
    assert_eq!(commands.active("second"), 0);
}
