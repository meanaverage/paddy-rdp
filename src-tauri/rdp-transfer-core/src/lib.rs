//! Clipboard file request scheduling. Callers execute I/O, timers and vendor callbacks.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, VecDeque};

pub const MAX_RANGE: u32 = 16 * 1024 * 1024;
pub const MAX_IN_FLIGHT: u64 = 4 * MAX_RANGE as u64;
pub const MAX_WAITING: usize = 256;
pub const MIN_COST: u32 = 64 * 1024;
pub const READ_EXPIRES: f64 = 65_000.0;
const MAX_READS: usize = (MAX_IN_FLIGHT / MIN_COST as u64) as usize;
const MAX_SAFE_ID: u64 = (1 << 53) - 1;

/// Vendor observations from MS-RDPECLIP 2.2.5.3. The position retains the page's
/// existing f64 representation; file I/O still decides whether a range is usable.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub stream_id: u32,
    pub index: i64,
    pub flags: u32,
    pub position: f64,
    pub size: u32,
}
impl Request {
    fn validate(&self) -> Result<(), String> {
        if !(i32::MIN as i64..=u32::MAX as i64).contains(&self.index)
            || !self.position.is_finite()
            || self.position < 0.0
            || self.position.fract() != 0.0
        {
            return Err("Invalid file request observation".into());
        }
        Ok(())
    }
    fn cost(&self) -> u32 {
        self.size.clamp(MIN_COST, MAX_RANGE)
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Reading {
    id: u64,
    stream_id: u32,
    bytes: u32,
    since: Option<f64>,
    number: Option<u64>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Served {
    stream_id: u32,
    reading: Option<u64>,
}

/// One instance per file-transfer owner; no platform callbacks run under its lock.
pub struct Transfer {
    waiting: VecDeque<Request>,
    reading: Vec<Reading>,
    served: BTreeMap<u64, Served>,
    numbered: u64,
    next_reading: u64,
    room_awaited: bool,
    closed: bool,
}
impl Default for Transfer {
    fn default() -> Self {
        Self::new()
    }
}
impl Transfer {
    pub const fn new() -> Self {
        Self {
            waiting: VecDeque::new(),
            reading: Vec::new(),
            served: BTreeMap::new(),
            numbered: 0,
            next_reading: 0,
            room_awaited: false,
            closed: false,
        }
    }
    pub fn reserved(&self) -> u64 {
        self.reading.iter().map(|r| u64::from(r.bytes)).sum()
    }
    pub fn snapshot(&self) -> Value {
        json!({"waiting": self.waiting, "reading": self.reading, "served": self.served,
            "numbered": self.numbered, "roomAwaited": self.room_awaited, "closed": self.closed})
    }
    fn expire(&mut self, now: f64) -> Vec<u32> {
        let mut refunds = Vec::new();
        self.reading.retain(|r| {
            let live = r.since.is_none_or(|since| now - since < READ_EXPIRES);
            if !live {
                refunds.push(r.bytes);
                if let Some(n) = r.number {
                    self.served.remove(&n);
                }
            }
            live
        });
        refunds
    }
    fn drop_reading(&mut self, ready_only: bool) -> Vec<u32> {
        let mut refunds = Vec::new();
        self.reading.retain(|r| {
            if ready_only && r.since.is_none() {
                return true;
            }
            refunds.push(r.bytes);
            false
        });
        refunds
    }
    fn apply(&mut self, operation: Operation) -> Result<Value, String> {
        if self.closed
            && !matches!(
                operation,
                Operation::Snapshot
                    | Operation::Dispose
                    | Operation::RoomReady
                    | Operation::Answered { .. }
            )
        {
            return Err("File transfer is closed".into());
        }
        Ok(match operation {
            Operation::Snapshot => self.snapshot(),
            Operation::Waiting => json!(self.waiting.len()),
            Operation::Admit { request } => {
                request.validate()?;
                if self
                    .reading
                    .iter()
                    .any(|r| r.stream_id == request.stream_id)
                    || self
                        .waiting
                        .iter()
                        .any(|r| r.stream_id == request.stream_id)
                {
                    json!("overlap")
                } else if request.flags & 1 != 0 || request.flags & 2 == 0 {
                    json!("read")
                } else if self.waiting.len() >= MAX_WAITING {
                    json!("full")
                } else {
                    self.waiting.push_back(request);
                    json!("queued")
                }
            }
            Operation::TakeNext => {
                if self.waiting.front().is_some_and(|r| {
                    self.reading.is_empty()
                        || self.reserved() + u64::from(r.cost()) <= MAX_IN_FLIGHT
                }) {
                    let request = self.waiting.pop_front().unwrap();
                    json!({"bytes": request.cost(), "request": request})
                } else {
                    Value::Null
                }
            }
            Operation::Reserve { request } => {
                request.validate()?;
                if self.reading.len() >= MAX_READS
                    || self.reserved() + u64::from(request.cost()) > MAX_IN_FLIGHT
                {
                    return Err("File read budget exhausted".into());
                }
                let id = next_id(self.next_reading)?;
                self.next_reading = id;
                self.reading.push(Reading {
                    id,
                    stream_id: request.stream_id,
                    bytes: request.cost(),
                    since: None,
                    number: None,
                });
                json!(id)
            }
            Operation::Ready { reading, now } => {
                finite_time(now)?;
                if let Some(r) = self.reading.iter_mut().find(|r| r.id == reading) {
                    r.since = Some(now);
                }
                Value::Null
            }
            Operation::Serve { request, reading } => {
                request.validate()?;
                if self.served.len() > MAX_READS {
                    return Err("Too many provider requests".into());
                }
                if let Some(id) = reading {
                    if !self
                        .reading
                        .iter()
                        .any(|r| r.id == id && r.number.is_none())
                    {
                        return Err("File read is no longer awaiting its provider".into());
                    }
                }
                let number = next_id(self.numbered)?;
                self.numbered = number;
                if let Some(id) = reading {
                    self.reading.iter_mut().find(|r| r.id == id).unwrap().number = Some(number);
                }
                self.served.insert(
                    number,
                    Served {
                        stream_id: request.stream_id,
                        reading,
                    },
                );
                json!(number)
            }
            Operation::Answered { number } => json!(self.served.remove(&number)),
            Operation::Contains { number } => json!(self.served.contains_key(&number)),
            Operation::Forget { number } => {
                self.served.remove(&number);
                Value::Null
            }
            Operation::Release { reading } => {
                if let Some(i) = self.reading.iter().position(|r| r.id == reading) {
                    let r = self.reading.remove(i);
                    if let Some(n) = r.number {
                        self.served.remove(&n);
                    }
                    json!(r.bytes)
                } else {
                    Value::Null
                }
            }
            Operation::Expire { now } => {
                finite_time(now)?;
                json!(self.expire(now))
            }
            Operation::DropReading { ready_only } => json!(self.drop_reading(ready_only)),
            Operation::NextServed { after } => self
                .served
                .range((std::ops::Bound::Excluded(after), std::ops::Bound::Unbounded))
                .next()
                .map_or(
                    Value::Null,
                    |(n, s)| json!({"number": n, "streamId": s.stream_id}),
                ),
            Operation::ClearServed => {
                self.served.clear();
                Value::Null
            }
            Operation::DrainWaiting => json!(self.waiting.drain(..).collect::<Vec<_>>()),
            Operation::AwaitRoom => {
                let start = !self.room_awaited;
                self.room_awaited = true;
                json!(start)
            }
            Operation::RoomReady => {
                self.room_awaited = false;
                Value::Null
            }
            Operation::Dispose => {
                self.closed = true;
                self.waiting.clear();
                let refunds = self.drop_reading(false);
                self.served.clear();
                json!(refunds)
            }
        })
    }
}
fn finite_time(now: f64) -> Result<(), String> {
    if now.is_finite() {
        Ok(())
    } else {
        Err("Invalid clock observation".into())
    }
}
fn next_id(previous: u64) -> Result<u64, String> {
    previous
        .checked_add(1)
        .filter(|v| *v <= MAX_SAFE_ID)
        .ok_or_else(|| "File request identities exhausted".into())
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
enum Operation {
    Snapshot,
    Waiting,
    Admit {
        request: Request,
    },
    TakeNext,
    Reserve {
        request: Request,
    },
    Ready {
        reading: u64,
        now: f64,
    },
    Serve {
        request: Request,
        reading: Option<u64>,
    },
    Answered {
        number: u64,
    },
    Contains {
        number: u64,
    },
    Forget {
        number: u64,
    },
    Release {
        reading: u64,
    },
    Expire {
        now: f64,
    },
    DropReading {
        ready_only: bool,
    },
    NextServed {
        after: u64,
    },
    ClearServed,
    DrainWaiting,
    AwaitRoom,
    RoomReady,
    Dispose,
}
pub fn handle(state: &mut Transfer, request: Value) -> Result<Value, String> {
    let operation = serde_json::from_value(request).map_err(|e| e.to_string())?;
    let value = state.apply(operation)?;
    Ok(json!({"value": value, "reserved": state.reserved()}))
}
pub fn dispatch(state: &mut Transfer, bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() > paddy_page_core::MAX_REQUEST {
        return Err("Request is too large".into());
    }
    handle(
        state,
        serde_json::from_slice(bytes).map_err(|e| e.to_string())?,
    )
}

#[cfg(target_arch = "wasm32")]
fn page_handle(request: Value) -> Result<Value, String> {
    static STATE: std::sync::Mutex<Transfer> = std::sync::Mutex::new(Transfer::new());
    let mut state = STATE
        .lock()
        .map_err(|_| "File transfer state unavailable")?;
    handle(&mut state, request)
}
#[cfg(target_arch = "wasm32")]
paddy_page_core::export!(page_handle);

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_counter_stops_before_javascript_can_alias_ids() {
        // Above 2^53-1, consecutive integer additions are not distinct JS numbers.
        let mut state = Transfer::new();
        state.numbered = MAX_SAFE_ID;
        let before = state.snapshot();
        assert!(handle(&mut state,json!({"op":"serve","request":{"streamId":7,"index":0,"flags":1,"position":0,"size":8},"reading":null})).is_err());
        assert_eq!(state.snapshot(), before);
    }
}
