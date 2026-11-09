// A binary-transparent process transport for the loopback RDP fixture on every host platform.
use std::io;
use std::net::{Shutdown, TcpStream};
fn main() -> io::Result<()> {
    let mut socket = TcpStream::connect(std::env::args().nth(1).expect("fixture address"))?;
    let mut send = socket.try_clone()?;
    std::thread::spawn(move || {
        let _ = io::copy(&mut io::stdin().lock(), &mut send);
        let _ = send.shutdown(Shutdown::Write);
    });
    io::copy(&mut socket, &mut io::stdout().lock())?;
    Ok(())
}
