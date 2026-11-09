//! JSON-lines adapter for the actual TypeScript compatibility oracle.
use paddy_rdp_command_core::{Output, StderrTail};
use serde::Deserialize;
use std::io::{self, BufRead, Write};

#[derive(Deserialize)]
struct Input {
    chunks: Vec<Vec<u8>>,
    strip: bool,
}
fn main() {
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Input = serde_json::from_str(&line.unwrap()).unwrap();
        let mut output = Output::default();
        let mut tail = StderrTail::default();
        for bytes in &input.chunks {
            let _ = output.push(bytes);
            tail.push(bytes);
        }
        let result = match output.finish(input.strip) {
            Ok(value) => serde_json::json!({"ok":value,"tail":tail.finish()}),
            Err(error) => serde_json::json!({"error":error,"tail":tail.finish()}),
        };
        serde_json::to_writer(&mut out, &result).unwrap();
        writeln!(out).unwrap();
        out.flush().unwrap();
    }
}
