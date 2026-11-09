# Remote audio processing

This dependency-free Rust library owns streaming linear-interpolation resampling,
mono mixing/stereo duplication, PCM16 conversion, playback lead, peak levels and
elapsed-audio counters. Web Audio retains devices, permission requests, capture
nodes, source creation and start/stop effects. Capture generation gates and the
existing worklet batching remain in the platform layer. Processing is synchronous
on the page thread.

The source contract is the existing IronRDP callbacks: interleaved signed PCM16
in little-endian order for playback, and per-channel float32 samples from Web Audio
for capture. MS-RDPEA 2.2.2.1.1 and MS-RDPEAI 2.2.2.3 describe negotiated channel
count, sample rate and sample representation; these documents are pinned through
`.github/review/specs.json`. The protocol channel field is unsigned 16-bit. Web
Audio decides which channel counts it can create; the core does not impose a
32-channel maximum because [Web Audio requires support for at least 32](https://webaudio.github.io/web-audio-api/#dom-baseaudiocontext-createbuffer).
Capture preserves the existing mono/stereo format gate. IronRDP still owns wire
parsing, negotiated formats and packet assembly; this is not a new wire decoder.

Resampling preserves the original float32 rounding after each mixing addition,
JavaScript's halfway rounding toward positive infinity, NaN-to-PCM-zero behavior,
and last-sample carry across blocks. A shorter channel retains a missing tail
sample, rather than its own last sample. Volume clamps finite values to 0..1 and
normalizes negative zero. Playback retains the existing 80 ms lead and 500 ms
maximum-ahead rule, including exact boundary behavior. Scheduling commits its
start time before source creation; elapsed duration advances only after a
successful source start. Capture peaks advance before delivery and sent time only
after successful delivery. Resetting either stream keeps its lifetime counters.

## Binary boundary

Each `AudioCore` owns one module instance. Compiled code is shared, mutable memory
is not. No host imports or callbacks occur inside Rust. Rust never dereferences a
pointer supplied by JavaScript; the only exposed pointers refer to owned buffers.

- `audio_prepare(length)` resizes the owned input buffer, refusing more than 8 MiB
  before allocation. JavaScript fills it before conversion and recreates views
  after any call that can grow memory.
- `audio_process(kind, channels, input_rate, output_rate)` converts capture (0) or
  playback (1), returning 0 on success or a typed refusal code. Capture input has a
  u32 channel count followed by each channel's u32 length and f32-LE samples.
  Playback input is PCM16-LE. All declared lengths are checked before reading.
- `audio_output()` and `audio_output_len()` expose converted bytes until the next
  conversion. Capture returns interleaved PCM16-LE; playback returns planar f32-LE.
  The adapter copies samples into independently owned arrays before another call.
- `audio_control` resets capture phase (0), plans playback (1), commits playback
  duration (2), resets playback position (3), commits sent capture frames (4), reads
  peak level (5), or clamps volume (6). Invalid observations return NaN without
  changing the corresponding counters.

Output is bounded to 16 MiB before allocation; excessive resampling expansion is
refused. Both buffers retain capacity for reuse until their owner is collected.
The module's linear memory cannot exceed 128 MiB. A trap permanently disables the
adapter so it cannot silently reset sample phase or playback time. A new connection
gets a new owner. These are local processing limits, not RDP wire requirements.

## Validation

Use the shared build lock for native and Wasm builds:

```sh
cargo test --locked --manifest-path src-tauri/rdp-audio-core/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/rdp-audio-core/Cargo.toml --all-targets -- -D warnings
node scripts/rust-page.mjs .build/rust-page --offline
node scripts/rdp-audio-core.check.mjs .build/rust-page/rdp-audio.data.ts --bench
```

The checker extracts actual TypeScript classes from
`ed3133e64ed9b970bf38c72d55addfffa2c707d8` and compares them with current adapters
through compiled Wasm: 2,688 streaming blocks / 1,197,189 PCM samples, 1,000 playback
traces, volume negative-zero behavior and 300 capture/reset/send-failure traces.
It also exercises the real inclusive 8 MiB input and 16 MiB output limits, malformed
packets, allocation reuse, independent owners and returned-buffer lifetime.
The synthetic trap check verifies permanent adapter refusal; it does not claim
an untrusted audio packet caused a real engine trap.

`fuzz/audio` passes arbitrary bytes into both public conversions at their real
bounds, then drives separately bounded sample/timing sequences. `fuzz/seed.py`
retains finite and nonfinite samples, short channels, malformed lengths, truncation,
channel limits and input-boundary seeds. The workflow uses AddressSanitizer and
integer overflow checks with a 60-second campaign, 2 GiB RSS ceiling and 15-second
per-input timeout. Native instrumentation does not instrument Wasm.

Packaged `RDP audio:` checks use actual Web Audio buffers and offline rendering,
plus synthetic microphone samples. They do not open a microphone or physical audio
output, change system permissions, or connect to a remote desktop. The benchmark
measures complete adapter/sample conversion cost, excluding device access,
transport and audible playback.
