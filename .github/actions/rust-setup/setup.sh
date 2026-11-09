#!/usr/bin/env bash
set -euo pipefail

# The checkout and temporary directory are noexec. Only the job-private tool
# cache permits compiler, build-script and test execution.
export RUSTUP_HOME="$RUNNER_TOOL_CACHE/paddy/rustup"
export CARGO_HOME="$RUNNER_TOOL_CACHE/paddy/cargo"
export TMPDIR="$RUNNER_TOOL_CACHE/paddy/tmp"
export CARGO_BUILD_JOBS=4
export PATH="$CARGO_HOME/bin:$PATH"
mkdir -p "$CARGO_HOME" "$RUSTUP_HOME" "$TMPDIR"
if ! command -v rustup >/dev/null; then
    case "$(uname -m)" in
        aarch64) triple=aarch64-unknown-linux-gnu; digest=e3853c5a252fca15252d07cb23a1bdd9377a8c6f3efa01531109281ae47f841c ;;
        x86_64) triple=x86_64-unknown-linux-gnu; digest=20a06e644b0d9bd2fbdbfd52d42540bdde820ea7df86e92e533c073da0cdd43c ;;
        *) echo 'Unsupported Linux runner architecture' >&2; exit 1 ;;
    esac
    installer="$RUNNER_TOOL_CACHE/paddy/rustup-init"
    curl --fail --show-error --silent --location --retry 3 --proto '=https' --tlsv1.2 \
        "https://static.rust-lang.org/rustup/archive/1.28.2/$triple/rustup-init" -o "$installer"
    printf '%s  %s\n' "$digest" "$installer" | sha256sum --check --strict
    chmod 0700 "$installer"
    "$installer" -y --no-modify-path --default-toolchain none
fi
toolchain=$(sed -n 's/^channel = "\([^"]*\)"/\1/p' rust-toolchain.toml)
test -n "$toolchain"
rustup toolchain install "$toolchain" --profile minimal --component clippy,rustfmt --target wasm32-unknown-unknown
if [[ "$PADDY_INSTALL_FUZZ" == true ]]; then
    rustup toolchain install nightly-2026-10-25 --profile minimal --component rust-src
    if [[ "$(cargo +"$toolchain" fuzz --version 2>/dev/null || true)" != 'cargo-fuzz 0.13.2' ]]; then
        cargo +"$toolchain" install cargo-fuzz --version 0.13.2 --locked
    fi
fi
printf '%s\n' "$CARGO_HOME/bin" >> "$GITHUB_PATH"
printf 'CARGO_HOME=%s\nRUSTUP_HOME=%s\nTMPDIR=%s\nCARGO_BUILD_JOBS=4\n' "$CARGO_HOME" "$RUSTUP_HOME" "$TMPDIR" >> "$GITHUB_ENV"
rustc +"$toolchain" -vV | sed -n 's/^host: /PADDY_RUST_HOST=/p' >> "$GITHUB_ENV"

# Keep existing crate/example/fuzz paths while executing outputs on that mount.
# Cargo workspace targets use the workspace root; standalone crates use theirs.
while IFS= read -r manifest; do
    dir=$(dirname "$manifest")
    destination="$RUNNER_TOOL_CACHE/paddy/targets/$dir"
    mkdir -p "$destination"
    test ! -e "$dir/target" && test ! -L "$dir/target"
    ln -s "$destination" "$dir/target"
done < <(git ls-files 'Cargo.toml' '**/Cargo.toml')
if [[ ! -e target && ! -L target ]]; then
    mkdir -p "$RUNNER_TOOL_CACHE/paddy/targets/root"
    ln -s "$RUNNER_TOOL_CACHE/paddy/targets/root" target
fi
