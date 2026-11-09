// A binary-transparent process transport for the loopback RDP fixture on every host platform.
use std::io::{self, Read, Write};
use std::net::{Shutdown, TcpStream};

fn copy_flushed(mut input: impl Read, mut output: impl Write) -> io::Result<()> {
    let mut bytes = [0; 8192];
    loop {
        let count = input.read(&mut bytes)?;
        if count == 0 { return Ok(()); }
        output.write_all(&bytes[..count])?;
        output.flush()?;
    }
}

fn main() -> io::Result<()> {
    let destination = std::env::args().nth(1).expect("fixture address or --fail");
    if destination == "--fail" {
        eprintln!("Permission denied (publickey).");
        std::process::exit(255);
    }
    let socket = TcpStream::connect(destination)?;
    let send = socket.try_clone()?;
    std::thread::spawn(move || {
        let _ = copy_flushed(io::stdin().lock(), &send);
        let _ = send.shutdown(Shutdown::Write);
    });
    // Stdout is line-buffered even when redirected; binary RDP records require an explicit flush.
    copy_flushed(socket, io::stdout().lock())
}
