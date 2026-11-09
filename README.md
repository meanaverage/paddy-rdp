# Paddy RDP

Paddy's trusted core component for remote desktops: IronRDP in the webview, native TCP/TLS and RD Gateway transport, shared drives, and portable Rust policy cores. This repository is separate from the classic Tabby extension at [meanaverage/tabby-rdp](https://github.com/meanaverage/tabby-rdp). The internal package name remains `tabby-rdp` for compatibility with stored configuration and the host module registry.

Paddy pins this repository as a submodule at `components/paddy-rdp` and includes it by default. This is a source/build boundary; it is not yet a downloadable sandboxed plugin. Installation and updates still come from Paddy. The native transport accepts an explicit `SshHost` interface, so this repository cannot look up Paddy's SSH sessions itself. The host checks the requesting window's ownership before opening a stream.

## Contents

- `rdp-plugin/`: frontend, IronRDP assets, licenses and asset checksums.
- `src-tauri/rdp-native/`: native proxy, gateway and shared-drive commands.
- `src-tauri/rdp-*-core/`: portable audio, desktop, identity, transfer, command and file policy.
- `sdk-provenance.json`: the exact shared Rust ABI, JavaScript loader and host interface snapshots used for independent checks. These snapshots preserve Paddy's bounded ABI, UTF-16 and tagged-value contracts. The host's canonical loader is used when bundling Paddy.
- `fixtures/reference/`: narrowly exported pre-migration source oracles, with original commits, Git blob IDs and SHA-256 hashes. Tests do not require access to private Git history.

## Checks

Use the pinned Rust toolchain and Node 24 or newer. Run `node scripts/check-rdp-assets.mjs`, `cargo test --locked --manifest-path src-tauri/rdp-native/Cargo.toml`, and `cargo test --locked --manifest-path src-tauri/rdp-identity-core/Cargo.toml` (likewise the other five cores). Build page modules with `node scripts/rust-page.mjs .build/page-cores`. The CI workflows run native platform checks, WebAssembly parity and bounded sanitizer/fuzz campaigns on standard GitHub-hosted runners.

Paddy integration and packaged WebKit checks live in the host repository. They cover window ownership, SSH adapters, module registration, RDP input routing and RDP-omitted builds. A standalone frontend package is not advertised until the host API and installer are versioned independently.

## Licensing

MIT for the component and exported SDK sources. Retain the IronRDP and other third-party notices under `rdp-plugin/vendor` and the component's license files. Asset updates must pass `scripts/check-rdp-assets.mjs`.
