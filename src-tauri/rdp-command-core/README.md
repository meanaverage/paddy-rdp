# Remote command collection

RDP setup and probe commands now collect their output in Rust. The portable core owns the inclusive 4 MiB stdout bound, final marker trimming, UTF-8 decoding, bounded stderr, concurrent subprocess pipes, deadline and page-owned cancellation registry. The app's `rdp/command.rs` adapter binds it to an authenticated SSH transport or a system `ssh` child. The page keeps transport discovery, command/argv construction and user-facing SSH failure messages.

Managed commands retain the existing `command` plus `echo __trd_exec_end__` request, stdout-only collection, last-marker trimming and ignored remote exit status. Data is routed to native consumers, so it does not enter the page's SSH data callbacks. The native queue preserves data/close ordering; the old page-only late-data polling workaround is no longer needed. Input writes and output reads proceed concurrently. The deadline starts before channel opening. A timed-out open still completes its routing fence, then closes a channel whose recipient has gone. Closing an active command affects its channel, never the shared interactive transport.

System commands use the same argv and inherited environment with the executable fixed to `ssh`. They drain stdin/stdout/stderr and wait for process and pipe closure under one deadline. Early stdin EPIPE leaves exit status and stderr authoritative. Status 255 still uses the page's SSH failure message; other statuses retain their output. Dropping the native future kills its owned child. Stderr retains the previous per-chunk replacement decoding and last 4096 UTF-16 code units, including a tail that starts with an unpaired surrogate; the native read size matches the former subprocess bridge. Stdout is decoded once after complete collection.

Each command registers its page before the first await. Both page reload and window close cancel that page's commands; a completed command unregisters itself. Managed transport handles must belong to the calling page. All commands remain behind the trusted app-interface gate. The count-only diagnostic is available only in isolated background test instances. No new remote authorization or saved-account behavior is introduced.

Build local targets under the repository build lock:

```sh
cargo test --locked --manifest-path src-tauri/rdp-command-core/Cargo.toml
cargo clippy --locked --manifest-path src-tauri/rdp-command-core/Cargo.toml --all-targets -- -D warnings
cargo build --release --locked --manifest-path src-tauri/rdp-command-core/Cargo.toml --example output
node scripts/rdp-command-core.check.mjs src-tauri/rdp-command-core/target/release/examples/output
```

The compatibility checker runs the actual production `Output` implementation at `0e4d0fa9fff51c1970e5347b2c2dce6bb9ad3b07`, with the old marker and stderr rules, against the compiled Rust core. Separate subprocess fixtures establish full-duplex draining, exact/over-limit output, retained exit statuses, early input closure, timeout and child termination when a future is cancelled. They run as synthetic copies of the test executable, without SSH or credentials, on every CI OS.

`node scripts/test.mjs '^RDP'` exercises the packaged app against the suite's throwaway loopback SSH server, including managed and system commands, timeout recovery, retained interactive terminals, cross-window transport isolation and complete before/after IPC timing. No external host is used.

The `fuzz/command_output` target exercises unfiltered output at its real 4 MiB boundary, arbitrary fragmentation, malformed/truncated UTF-8, markers and bounded generated ownership sequences. `fuzz/seed.py` includes exact-limit and over-limit inputs. CI runs 60 seconds with AddressSanitizer, overflow checks, a 4,194,305-byte maximum and 2 GiB RSS ceiling. This campaign does not instrument SSH transport or subprocess scheduling; the application and subprocess checks cover those paths separately.
