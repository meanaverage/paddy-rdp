//! Streaming PCM conversion and playback timing; callers retain audio devices and nodes.
#![cfg_attr(not(target_arch = "wasm32"), forbid(unsafe_code))]

pub const MAX_INPUT: usize = 8 << 20;
pub const MAX_OUTPUT: usize = 16 << 20;
// The negotiated RDP channel field is u16; Web Audio decides its supported subset.
pub const MAX_CHANNELS: usize = u16::MAX as usize;

pub fn volume(level: f64) -> Result<f64, Error> {
    if !level.is_finite() {
        return Err(Error::Format);
    }
    // Math.max(0, Math.min(1, level)) turns negative zero into positive zero.
    Ok(if level <= 0.0 { 0.0 } else { level.min(1.0) })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    Input,
    Format,
    Output,
}

/// The packet carries a channel count, then each channel's length and f32-LE samples.
/// Lengths are separate because a missing sample has the old typed-array NaN semantics.
pub fn capture_packet(bytes: &[u8]) -> Result<Vec<Vec<f32>>, Error> {
    if bytes.len() > MAX_INPUT {
        return Err(Error::Input);
    }
    let mut at = 0usize;
    let word = |at: &mut usize| -> Result<u32, Error> {
        let end = at.checked_add(4).ok_or(Error::Input)?;
        let raw = bytes.get(*at..end).ok_or(Error::Input)?;
        *at = end;
        Ok(u32::from_le_bytes(raw.try_into().unwrap()))
    };
    let count = word(&mut at)? as usize;
    if !(1..=MAX_CHANNELS).contains(&count) {
        return Err(Error::Format);
    }
    let mut channels = Vec::with_capacity(count);
    for _ in 0..count {
        let len = word(&mut at)? as usize;
        let end = at
            .checked_add(len.checked_mul(4).ok_or(Error::Input)?)
            .ok_or(Error::Input)?;
        let raw = bytes.get(at..end).ok_or(Error::Input)?;
        channels.push(
            raw.chunks_exact(4)
                .map(|s| f32::from_le_bytes(s.try_into().unwrap()))
                .collect(),
        );
        at = end;
    }
    if at != bytes.len() {
        return Err(Error::Input);
    }
    Ok(channels)
}

pub struct Resampler {
    input_rate: f64,
    output_rate: f64,
    channels: usize,
    step: f64,
    position: f64,
    last: Vec<f64>,
}
impl Resampler {
    pub fn new(input_rate: f64, output_rate: f64, channels: usize) -> Result<Self, Error> {
        let step = input_rate / output_rate;
        if !input_rate.is_finite()
            || input_rate <= 0.0
            || !output_rate.is_finite()
            || output_rate <= 0.0
            || !step.is_finite()
            || step <= 0.0
            || !(1..=2).contains(&channels)
        {
            return Err(Error::Format);
        }
        Ok(Self {
            input_rate,
            output_rate,
            channels,
            step,
            position: 0.0,
            last: vec![0.0; channels],
        })
    }
    pub fn process(&mut self, input: &[Vec<f32>]) -> Result<Vec<i16>, Error> {
        let frames = input.first().ok_or(Error::Input)?.len();
        if input.len() > MAX_CHANNELS || input.iter().map(Vec::len).sum::<usize>() > MAX_INPUT / 4 {
            return Err(Error::Input);
        }
        let count = ((frames as f64 - 1.0 - self.position) / self.step)
            .ceil()
            .max(0.0);
        if !count.is_finite() || count > (MAX_OUTPUT / 2 / self.channels) as f64 {
            return Err(Error::Output);
        }
        let count = count as usize;
        let mono = if self.channels == 1 && input.len() > 1 {
            let mut mono = vec![0.0f32; frames];
            for channel in input {
                for (i, value) in mono.iter_mut().enumerate() {
                    // JS Float32Array rounds after each channel addition, not after the sum.
                    *value = (f64::from(*value)
                        + f64::from(*channel.get(i).unwrap_or(&f32::NAN)) / input.len() as f64)
                        as f32;
                }
            }
            Some(mono)
        } else {
            None
        };
        let mixed: Vec<&[f32]> = (0..self.channels)
            .map(|c| {
                mono.as_deref()
                    .unwrap_or_else(|| input.get(c).unwrap_or(&input[0]).as_slice())
            })
            .collect();
        let mut output = vec![0i16; count * self.channels];
        let mut t = self.position;
        for frame in output.chunks_exact_mut(self.channels) {
            let i = t.floor();
            let fraction = t - i;
            for (c, out) in frame.iter_mut().enumerate() {
                let samples = mixed[c];
                let a = if i < 0.0 {
                    self.last[c]
                } else {
                    f64::from(*samples.get(i as usize).unwrap_or(&f32::NAN))
                };
                let next = i + 1.0;
                let b = if next < 0.0 {
                    f64::NAN
                } else {
                    f64::from(*samples.get(next as usize).unwrap_or(&f32::NAN))
                };
                let value = (a + (b - a) * fraction).clamp(-1.0, 1.0) * 32767.0;
                // Math.round's halfway choice is toward +infinity; Int16Array maps NaN to zero.
                let floor = value.floor();
                *out = if value.is_nan() {
                    0
                } else if value - floor < 0.5 {
                    floor as i16
                } else {
                    (floor + 1.0) as i16
                };
            }
            t += self.step;
        }
        self.position = t - frames as f64;
        for (c, samples) in mixed.iter().enumerate() {
            self.last[c] = f64::from(
                *frames
                    .checked_sub(1)
                    .and_then(|i| samples.get(i))
                    .unwrap_or(&f32::NAN),
            );
        }
        Ok(output)
    }
}

#[derive(Default)]
pub struct Engine {
    resampler: Option<Resampler>,
    pub peak: f64,
    pub sent: f64,
    pub received: f64,
    pub next: f64,
}
impl Engine {
    pub fn reset_capture(&mut self) {
        self.resampler = None;
    }
    pub fn capture(
        &mut self,
        bytes: &[u8],
        input_rate: f64,
        output_rate: f64,
        channels: usize,
    ) -> Result<Vec<u8>, Error> {
        let input = capture_packet(bytes)?;
        let changed = self.resampler.as_ref().is_none_or(|r| {
            r.input_rate != input_rate || r.output_rate != output_rate || r.channels != channels
        });
        let pcm = if changed {
            let mut r = Resampler::new(input_rate, output_rate, channels)?;
            let pcm = r.process(&input)?;
            self.resampler = Some(r);
            pcm
        } else {
            self.resampler.as_mut().unwrap().process(&input)?
        };
        for value in &pcm {
            self.peak = self.peak.max(f64::from(*value).abs() / 32768.0);
        }
        Ok(pcm.into_iter().flat_map(i16::to_le_bytes).collect())
    }
    pub fn playback(&mut self, bytes: &[u8], channels: usize) -> Result<Vec<u8>, Error> {
        if bytes.len() > MAX_INPUT {
            return Err(Error::Input);
        }
        if !(1..=MAX_CHANNELS).contains(&channels) {
            return Err(Error::Format);
        }
        let frames = bytes.len() / 2 / channels;
        let length = frames
            .checked_mul(channels)
            .and_then(|v| v.checked_mul(4))
            .filter(|n| *n <= MAX_OUTPUT)
            .ok_or(Error::Output)?;
        let mut output = Vec::with_capacity(length);
        for channel in 0..channels {
            for frame in 0..frames {
                let at = (frame * channels + channel) * 2;
                let value = f32::from(i16::from_le_bytes([bytes[at], bytes[at + 1]])) / 32768.0;
                self.peak = self.peak.max(f64::from(value).abs());
                output.extend_from_slice(&value.to_le_bytes());
            }
        }
        Ok(output)
    }
    pub fn schedule(&mut self, now: f64) -> Result<f64, Error> {
        if !now.is_finite() {
            return Err(Error::Format);
        }
        if self.next < now || self.next > now + 0.5 {
            self.next = now + 0.08;
        }
        Ok(self.next)
    }
    pub fn played(&mut self, duration: f64) -> Result<(), Error> {
        if !duration.is_finite()
            || duration < 0.0
            || !(self.next + duration).is_finite()
            || !(self.received + duration).is_finite()
        {
            return Err(Error::Format);
        }
        self.next += duration;
        self.received += duration;
        Ok(())
    }
    pub fn capture_sent(
        &mut self,
        samples: usize,
        channels: usize,
        rate: f64,
    ) -> Result<(), Error> {
        if !(1..=2).contains(&channels) || !rate.is_finite() || rate <= 0.0 {
            return Err(Error::Format);
        }
        let next = self.sent + samples as f64 / channels as f64 / rate;
        if !next.is_finite() {
            return Err(Error::Format);
        }
        self.sent = next;
        Ok(())
    }
}

// The Wasm owner exposes only its own input/output buffers. No raw pointer supplied
// by JavaScript is dereferenced; prepare bounds the allocation before JS fills it.
#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    use std::cell::RefCell;
    #[derive(Default)]
    struct State {
        engine: Engine,
        input: Vec<u8>,
        output: Vec<u8>,
    }
    thread_local! { static STATE: RefCell<State> = RefCell::new(State::default()); }
    #[no_mangle]
    pub extern "C" fn audio_prepare(length: usize) -> *mut u8 {
        if length > MAX_INPUT {
            return std::ptr::null_mut();
        }
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            s.input.resize(length, 0);
            s.input.as_mut_ptr()
        })
    }
    #[no_mangle]
    pub extern "C" fn audio_process(
        kind: u32,
        channels: usize,
        input_rate: f64,
        output_rate: f64,
    ) -> i32 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let State {
                engine,
                input,
                output,
            } = &mut *s;
            let result = match kind {
                0 => engine.capture(input, input_rate, output_rate, channels),
                1 => engine.playback(input, channels),
                _ => Err(Error::Format),
            };
            match result {
                Ok(bytes) => {
                    *output = bytes;
                    0
                }
                Err(e) => {
                    output.clear();
                    match e {
                        Error::Input => 1,
                        Error::Format => 2,
                        Error::Output => 3,
                    }
                }
            }
        })
    }
    #[no_mangle]
    pub extern "C" fn audio_output() -> *const u8 {
        STATE.with(|s| s.borrow().output.as_ptr())
    }
    #[no_mangle]
    pub extern "C" fn audio_output_len() -> usize {
        STATE.with(|s| s.borrow().output.len())
    }
    #[no_mangle]
    pub extern "C" fn audio_control(operation: u32, a: f64, b: f64, c: f64) -> f64 {
        STATE.with(|s| {
            let mut s = s.borrow_mut();
            let e = &mut s.engine;
            match operation {
                0 => {
                    e.reset_capture();
                    0.0
                }
                1 => e.schedule(a).unwrap_or(f64::NAN),
                2 => {
                    if e.played(a).is_err() {
                        f64::NAN
                    } else {
                        e.received
                    }
                }
                3 => {
                    e.next = 0.0;
                    0.0
                }
                4 => {
                    if !a.is_finite()
                        || a < 0.0
                        || a.fract() != 0.0
                        || b.fract() != 0.0
                        || e.capture_sent(a as usize, b as usize, c).is_err()
                    {
                        f64::NAN
                    } else {
                        e.sent
                    }
                }
                5 => e.peak,
                6 => volume(a).unwrap_or(f64::NAN),
                _ => f64::NAN,
            }
        })
    }
}
