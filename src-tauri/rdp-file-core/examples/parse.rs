//! JSON-lines transport for the actual TypeScript compatibility checker, not an application command.
use std::io::{self, BufRead, Write};
fn main() {
    let mut out = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let bytes: Vec<u8> = serde_json::from_str(&line.unwrap()).unwrap();
        let result = match paddy_rdp_file_core::parse(&bytes) {
            Ok(value) => serde_json::json!({"ok": value}),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        };
        serde_json::to_writer(&mut out, &result).unwrap();
        writeln!(out).unwrap();
        out.flush().unwrap();
    }
}
