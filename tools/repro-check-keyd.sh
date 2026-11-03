#!/usr/bin/env bash
# Build keyd twice from the same source in two different directories and
# compare SHA-256 of the binaries. Run from the repo root (CI job
# "keyd-reproducible"). Paths are remapped and the clock is pinned, so the
# only inputs are source, Cargo.lock and the toolchain.
set -euo pipefail
ROOT=$(git rev-parse --show-toplevel)
export SOURCE_DATE_EPOCH=$(git -C "$ROOT" log -1 --format=%ct)
export CARGO_INCREMENTAL=0
W=$(mktemp -d)
build() { # $1 = copy dir
  mkdir -p "$1" && cp -r "$ROOT/keyd" "$1/keyd" && rm -rf "$1/keyd/target"
  ( cd "$1/keyd" && RUSTFLAGS="--remap-path-prefix=$1/keyd=/build --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo" \
      cargo build --release --locked --quiet )
  sha256sum "$1/keyd/target/release/tvkeyd" | cut -d' ' -f1
}
A=$(build "$W/a"); B=$(build "$W/bb/different/path")
echo "build A: $A"; echo "build B: $B"
[ "$A" = "$B" ] || { echo "keyd build is NOT reproducible" >&2; exit 1; }
echo "keyd build is reproducible: $A"
