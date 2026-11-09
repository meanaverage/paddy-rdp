# RDP file import

This portable library owns `.rdp` byte decoding, line parsing, destination and port selection, scale mapping, gateway use, clipboard restrictions and ordered notes for unsupported settings. `rdp_file_parse` passes raw bytes from Tauri to the blocking pool. The frontend awaits the result, performs the existing spoofing checks and confirmation, then creates or opens a profile. Files, dialogs, IDNA conversion, profile storage and connections remain in their platform adapters.

The file picker, TypeScript facade, native command and library independently enforce the same inclusive **1 MiB** file limit. The native command rejects nonbinary bodies and oversized input before copying it to the worker. Parsing holds only the decoded input and slices for 25 recognized keys; unknown settings do not create map entries. The line scanner is linear in input size. No network access, saved accounts, certificate acceptance or connection authorization is performed here.

Compatibility follows `rdp-plugin/src/rdpFile.ts` at `0e4d0fa9fff51c1970e5347b2c2dce6bb9ad3b07`: UTF-8 replacement decoding, UTF-16LE/BE BOMs, unmarked UTF-16LE detection, discarded odd trailing LE bytes, rejected odd BE bytes, ECMAScript whitespace, last-value settings with first-insertion note order and sticky decimal-zero clipboard restrictions. UTF-16 code-unit arrays retain lone surrogates across JSON IPC. Port values retain JavaScript numeric parsing, including radix prefixes and rounded decimal values; arbitrary precision radix parsing avoids overflow. The existing permissive IPv6-like address fallback and exact gateway-method comparisons are deliberate compatibility behavior, not a claim to implement all mstsc validation.

Independent settings checks use Microsoft's [RDP URI documentation](https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remote-desktop-uri) for full address and port syntax and [supported RDP properties](https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-properties) for account, clipboard and display properties. The old production implementation supplies the broader compatibility oracle, including behavior outside the supported-property examples.

Run the following under the repository build lock for local builds:

```sh
cargo test --locked --manifest-path src-tauri/rdp-file-core/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/rdp-file-core/Cargo.toml --all-targets -- -D warnings
cargo build --release --locked --manifest-path src-tauri/rdp-file-core/Cargo.toml --example parse
node scripts/rdp-file-core.check.mjs src-tauri/rdp-file-core/target/release/examples/parse
```

The checker executes the actual old parser and current TypeScript facade against a compiled Rust process. Its JSON-lines transport is a test adapter, not Tauri; `node scripts/test.mjs '^RDP'` exercises the actual raw-byte IPC and Add only/Cancel import flows in an isolated packaged app. No external RDP host is contacted. Full remote-session testing remains a release concern described in `rdp-plugin/README.md`.

The `fuzz/rdp_file` target accepts raw bytes at the public library boundary without prefiltering. `fuzz/seed.py` supplies valid, malformed, truncated, exact-limit and oversized files, including UTF-16 and duplicate restrictions. Build with `cargo +nightly-2026-10-25 fuzz build --fuzz-dir src-tauri/rdp-file-core/fuzz rdp_file`; overflow checks are enabled in the fuzz profile. CI uses AddressSanitizer, a 60-second campaign, a 1,048,577-byte maximum input and a 2 GiB RSS limit. A bounded campaign does not establish security or validate actual remote desktops.
