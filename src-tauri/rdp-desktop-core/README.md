# Remote desktop configuration and clipboard policy

This portable library owns desktop specification validation, ordering and duplicate
resolution, xrdp consent classification, Hyper-V IDs, wake configuration, scalar
configuration conversion and clipboard permissions. Its synchronous page module
uses the [shared bounded ABI](../../docs/rust-page-cores.md). TypeScript observes
configuration and vendor hooks, retains original desktop objects for paste, and
executes UI, clipboard, transport and wake effects.

The port preserves the shipped policy. Host-reported xrdp never grants unasked
non-NLA sign-in; an explicit user kind choice retains its existing meaning.
Duplicate desktops keep the first specification and intersect clipboard rights.
Unknown persisted clipboard modes mean off. Nested targets cannot borrow an
outer host's configured desktops. Wake parsing keeps Hyper-V, VM-name, MAC priority
and the former IPv4 shape check, including values such as `999.1.2.3`; this is not
a stricter network-address validator.

Tagged observations distinguish missing and null, nonfinite numbers, negative
zero and arbitrary UTF-16 strings. Text travels as an inner JSON string literal,
preserving lone surrogates in desktop and credential identities. Scalar number
parsing uses the former JavaScript grammar, including unsigned radix literals;
finite-number formatting uses `ryu-js`. Objects used as scalar config values are
opaque and their conversion hooks are not called. Object merging indexes keys
while retaining first insertion order and last value, avoiding quadratic work on
large requests. The identity dependency disables its `page` feature so only this
module exports the page ABI.

Validation from the checkout root (build commands use the shared build lock):

```sh
cargo test --locked --manifest-path src-tauri/rdp-desktop-core/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/rdp-desktop-core/Cargo.toml --all-targets -- -D warnings
node scripts/rust-page.mjs .build/desktop-page --offline
node scripts/rdp-desktop-core.check.mjs .build/desktop-page/rdp-desktop.data.ts .build/desktop-page/rdp-identity.data.ts --bench
node scripts/rdp-identity-core.check.mjs .build/desktop-page/rdp-identity.data.ts
node scripts/rust-page.check.mjs .build/desktop-page/rdp-desktop.data.ts
node scripts/test.mjs '^RDP desktop policy:'
```

The comparator loads the actual TypeScript at
`2bade577d9945ba4620a8fcb5636d6c7dee4ea61` and the current adapters through compiled
Wasm. Its 114,374 outcomes include generated configuration, random IEEE numbers,
negative zero, malformed values, missing properties, UTF-16, callback order and
original object identity. The compiled boundary checks malformed JSON/UTF-8,
the inclusive 8 MiB request limit, repeated calls and the 128 MiB memory ceiling.
Packaged WebKit checks use production facades and actual IronRDP clipboard hook
composition without connecting to a desktop. They do not exercise an external
host, live sign-in or the system clipboard.

The `desktop` coverage-guided target sends arbitrary bytes to the real request
decoder and separately generates observations with at most 2,048 UTF-16 units.
`fuzz/seed.py OUTPUT` retains valid, malformed, truncated, exact-boundary,
large-number and 50,000-field requests. The last seed reproduces the former
quadratic merge timeout under the same 15-second per-input limit. Build with
`cargo +nightly-2026-10-25 fuzz build --fuzz-dir src-tauri/rdp-desktop-core/fuzz desktop`;
run its binary with `-max_total_time=60 -max_len=8388609 -rss_limit_mb=2048
-timeout=15` and separate corpus/artifact directories. AddressSanitizer and
integer overflow checks are enabled. Native fuzzing does not instrument Wasm or
the vendor clipboard implementation.
