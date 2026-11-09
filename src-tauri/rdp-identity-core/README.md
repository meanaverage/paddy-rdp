# Remote desktop identities

Portable target, session and credential-key rules for the bundled RDP plugin. The
crate has no platform, network or credential-store dependency. Its page module uses
the shared bounded JSON ABI; native clients can call the same functions directly.

The default `page` feature exports that ABI. Other page cores use
`default-features = false` when linking these identity functions as a library.
Page builds use separate Cargo target subdirectories because cdylib/rlib output
names otherwise collide between standalone and dependency feature sets.

Identity text is UTF-16 code units, including lone surrogates. The page adapter
encodes each string as a JSON string literal inside the normal UTF-8 envelope and
decodes returned literals. This preserves the former JavaScript key space: a lone
surrogate must not turn into U+FFFD and address a different saved credential.

Rust owns SSH configuration field selection, delimiter escaping, host lowercase,
canonicality checks, nested-host keys, display unescaping, via matching, session
keys, domain-qualified login names, user scopes and whole-key rekeying. Unknown or
malformed scoped suffixes retain their old whole-value comparison and do not move
through rekeying. TypeScript retains configuration observations, profiles, stored
values, keychain operations, timers, transport and UI. This does not change the
RDP wire format or certificate validation policy.

Validation from the checkout root (local builds use the shared build lock):

```sh
cargo test --locked --manifest-path src-tauri/rdp-identity-core/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/rdp-identity-core/Cargo.toml --all-targets -- -D warnings
node scripts/rdp-identity-core.check.mjs .build/tabby/tabby-rdp/src/rust/rdp-identity.data.ts --bench
node scripts/rust-page.check.mjs .build/tabby/tabby-rdp/src/rust/rdp-identity.data.ts
node scripts/test.mjs '^RDP identities:'
```

The comparator loads the actual prior TypeScript functions at commit
`c8685a4d3b7c8a5d48520deb1c6058c69b0bb36d` and the current facade through compiled
Wasm. Its 1,442,388 outcomes include every Unicode scalar's lowercase mapping,
every UTF-16 unit's identity, malformed suffixes and JavaScript configuration
coercion. Native tests additionally specify independent delimiter and scope
examples. Packaged checks use the production plugin's functions inside WebKit;
they do not use a real credential store or external desktop.
The comparator also loads the sibling `rdp-desktop.data.ts` module used by the
configuration-text facade; the page builder generates both together.

The `identity` coverage-guided fuzz target sends arbitrary bytes to the real 8 MiB
request boundary and separately bounds generated UTF-16 identities to 4,096 units.
`fuzz/seed.py OUTPUT` supplies valid, malformed, truncated, surrogate and real
boundary seeds. Build with `cargo +nightly-2026-10-25 fuzz build --fuzz-dir
src-tauri/rdp-identity-core/fuzz identity`; run its binary with
`-max_total_time=60 -max_len=8388609 -rss_limit_mb=2048 -timeout=15` and separate
corpus/artifact paths. AddressSanitizer and overflow checks are enabled. Native
fuzzing does not instrument Wasm memory or platform scheduling.

See [Rust page cores](../../docs/rust-page-cores.md) for allocation limits,
synchronous execution, build integration and measured boundary cost.
