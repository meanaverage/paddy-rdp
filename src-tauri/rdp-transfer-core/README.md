# Clipboard file-transfer scheduling

Rust owns request admission, FIFO range scheduling, read reservations, provider
expiry, room-wait coalescing and provider-to-remote request correlation. TypeScript
keeps file objects, disk promises, permission and connection observations, vendor
callbacks, connection accounting and UI. Calls are synchronous and do not invoke
platform callbacks while Rust state is borrowed. Each transfer owner receives
its own WebAssembly instance and monotonically increasing local identities.

The governing wire fields are MS-RDPECLIP 2.2.5.3 and 2.2.5.4: unsigned 32-bit
stream IDs, request flags and sizes, and a response stream ID matching its request.
The source is the [pinned Open Specifications corpus](https://github.com/awakecoding/openspecs/blob/f3229c8af0ab4c38021e4190b691d91a8323cabe/skills/windows-protocols/MS-RDPECLIP/MS-RDPECLIP.md),
also recorded in `.github/review/specs.json`. IronRDP retains wire decoding. This
core consumes its observations, including the existing floating-point position
representation and signed/unsigned index observations. It preserves SIZE
precedence for mixed flags; that compatibility behavior is not a claim that such
a sender conforms to the wire specification.

The 16 MiB range maximum, 64 MiB reservation budget, 64 KiB minimum charge, 256
waiting requests and 65-second provider expiry are existing local resource policy,
not wire requirements. Wall-clock rollback retains the old behavior. Browser
provider reads expire; disk I/O stays charged until settlement, including across
offer replacement. Old or repeated responses cannot release another reservation
or answer a new offer that reuses the remote stream ID. Offer replacement retains
the existing stages between synchronous callbacks.

Provider and reading IDs stop at 2^53-1 so JavaScript cannot alias them. A native
test verifies refusal without changing state at this boundary; the compatibility
checker demonstrates the old TypeScript counter routing an older completion to
the newer remote stream after precision is exhausted. The stateful adapter
permanently refuses work after an error or trap, preventing the general page
loader's fresh-instance recovery from reusing provider IDs. It retains the last
reservation total so disposal still refunds outstanding connection charges once.

The page ABI admits at most 8 MiB of JSON and returns at most 16 MiB, with a
128 MiB linear-memory ceiling. Normal scheduling requests are small. The compiled
check also forces a real Wasm out-of-memory trap using a dense, admitted JSON value
and verifies that IDs cannot restart and disposal can still release reservations.

From the repository root, use the shared build lock for build commands:

```sh
cargo test --locked --manifest-path src-tauri/rdp-transfer-core/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/rdp-transfer-core/Cargo.toml --all-targets -- -D warnings
node scripts/rust-page.mjs .build/rust-page --offline
node scripts/rust-page.check.mjs .build/rust-page/rdp-transfer.data.ts
node scripts/rdp-transfer-core.check.mjs .build/rust-page/rdp-transfer.data.ts --bench
```

The compatibility checker runs actual old and current `FileTransfer` classes,
including disk-promise settlement and provider callbacks, against controlled
platform observations. Its reference is `ca663bab74dea6d62048c5d83bf100901fcaebf9`.
It compares 5,119 scheduling states and callback traces, including saturation,
clock rollback, repeated responses, synchronous provider exceptions, restrictions,
replacement and disposal. The packaged `RDP transfer:` checks use real vendor
FileReader behavior and native reads of synthetic temporary files, with transport
output captured privately. These are local checks, not live remote-host or system
clipboard coverage.

The `fuzz/transfer` target sends arbitrary bytes to the real parser bound and
separately drives bounded lifecycle sequences. `fuzz/seed.py OUTPUT` generates
valid, malformed, truncated, inclusive/over-limit and dense-allocation seeds.
CI runs a 60-second AddressSanitizer campaign with integer overflow checks,
`-max_len=8388609`, `-rss_limit_mb=2048` and `-timeout=15`, alongside native tests on
Linux, macOS and Windows and compiled-Wasm compatibility. Native instrumentation
does not instrument Wasm; compiled ABI and trap checks cover that boundary.
