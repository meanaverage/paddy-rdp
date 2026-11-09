//! Bounded remote-command output, subprocess collection, and page-owned cancellation.
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

pub const MAX_OUTPUT: usize = 4 * 1024 * 1024;
pub const END: &str = "__trd_exec_end__";
pub const OVERFLOW: &str =
    "Remote command printed more than 4 MB where a few lines were expected: stopped reading it";
pub const TIMEOUT: &str = "RDP_COMMAND_TIMEOUT";
pub const CANCELLED: &str = "Remote command cancelled because its page closed or reloaded";

#[derive(Default)]
pub struct Output {
    bytes: Vec<u8>,
    overflowed: bool,
}
impl Output {
    /// Refuse the whole piece before allocating past the limit. A rejected stream stays rejected.
    pub fn push(&mut self, bytes: &[u8]) -> Result<(), &'static str> {
        if self.overflowed || bytes.len() > MAX_OUTPUT - self.bytes.len() {
            self.overflowed = true;
            return Err(OVERFLOW);
        }
        self.bytes.extend_from_slice(bytes);
        Ok(())
    }
    pub fn finish(self, strip_marker: bool) -> Result<String, &'static str> {
        if self.overflowed {
            return Err(OVERFLOW);
        }
        let end = if strip_marker {
            self.bytes
                .windows(END.len())
                .rposition(|w| w == END.as_bytes())
                .unwrap_or(self.bytes.len())
        } else {
            self.bytes.len()
        };
        Ok(String::from_utf8_lossy(&self.bytes[..end]).into_owned())
    }
}

/// The former page concatenated each decoded stderr chunk and kept its last 4096 UTF-16 units.
#[derive(Default)]
pub struct StderrTail(Vec<u16>);
impl StderrTail {
    pub fn push(&mut self, bytes: &[u8]) {
        let decoded = String::from_utf8_lossy(bytes);
        self.0.extend(decoded.encode_utf16());
        if self.0.len() > 4096 {
            self.0.drain(..self.0.len() - 4096);
        }
    }
    pub fn finish(self) -> Vec<u16> {
        self.0
    }
}

#[derive(Debug, Serialize)]
pub struct Captured {
    pub output: String,
    pub stderr: Vec<u16>,
    pub code: Option<i32>,
}

async fn stdout(mut input: impl AsyncRead + Unpin) -> Result<String, String> {
    let mut buffer = [0; 16384];
    let mut output = Output::default();
    loop {
        let n = input.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return output.finish(false).map_err(String::from);
        }
        output.push(&buffer[..n]).map_err(String::from)?;
    }
}
async fn stderr(mut input: impl AsyncRead + Unpin) -> Result<Vec<u16>, String> {
    // Same read size as the old native subprocess bridge (one byte was reserved for its stream tag).
    let mut buffer = vec![0; 64 * 1024 - 1];
    let mut output = StderrTail::default();
    loop {
        let n = input.read(&mut buffer).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(output.finish());
        }
        output.push(&buffer[..n]);
    }
}

/// Drain all pipes concurrently. Dropping the future (page cancellation) kills the owned child.
/// The app adapter fixes `program` to ssh; keeping it explicit permits socket-free fixture tests.
pub async fn process(
    program: &str,
    args: &[String],
    input: &[u8],
    within: Duration,
) -> Result<Captured, String> {
    use std::process::Stdio;
    let deadline = tokio::time::Instant::now() + within;
    let mut child = tokio::process::Command::new(program)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().unwrap();
    let out = child.stdout.take().unwrap();
    let err = child.stderr.take().unwrap();
    let result = tokio::time::timeout_at(deadline, async {
        let write = async {
            let result = async {
                stdin.write_all(input).await?;
                stdin.shutdown().await
            }
            .await;
            drop(stdin);
            match result {
                Err(e) if e.kind() != std::io::ErrorKind::BrokenPipe => Err(e.to_string()),
                _ => Ok(()),
            }
        };
        let wait = async { child.wait().await.map_err(|e| e.to_string()) };
        let ((), output, stderr, status) = tokio::try_join!(write, stdout(out), stderr(err), wait)?;
        Ok(Captured {
            output,
            stderr,
            code: status.code(),
        })
    })
    .await
    .map_err(|_| TIMEOUT.to_owned())
    .and_then(|r| r);
    if result.is_err() {
        let _ = child.kill().await;
    }
    result
}

type Table = Arc<Mutex<HashMap<u64, (String, oneshot::Sender<()>)>>>;
#[derive(Default)]
pub struct Commands {
    next: AtomicU64,
    table: Table,
}
pub struct CommandGuard {
    id: u64,
    table: Table,
}
impl Drop for CommandGuard {
    fn drop(&mut self) {
        self.table.lock().unwrap().remove(&self.id);
    }
}
impl Commands {
    /// Register synchronously before the first await, so page reset cannot miss an opening command.
    pub fn start(&self, owner: &str) -> (CommandGuard, oneshot::Receiver<()>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.table.lock().unwrap().insert(id, (owner.into(), tx));
        (
            CommandGuard {
                id,
                table: self.table.clone(),
            },
            rx,
        )
    }
    pub fn reset(&self, owner: &str) {
        self.table
            .lock()
            .unwrap()
            .retain(|_, (who, _)| who != owner);
    }
    pub fn active(&self, owner: &str) -> usize {
        self.table
            .lock()
            .unwrap()
            .values()
            .filter(|(who, _)| who == owner)
            .count()
    }
}
