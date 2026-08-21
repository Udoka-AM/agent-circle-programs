#!/usr/bin/env bash
#
# Build agent-registry and emit the IDL + TypeScript types.
#
# Why this exists instead of a plain `anchor build`:
#
#   The Solana CLI (2.1.22) ships platform-tools v1.43, whose bundled rustc
#   (1.79) predates the edition2024 stabilisation that several transitive
#   dependencies of anchor-spl now require. Platform-tools v1.52 carries
#   rustc 1.89 and compiles the tree cleanly.
#
#   `anchor build` forwards trailing args to *both* the SBF build and the IDL
#   build, and the IDL step (`cargo test`) rejects --tools-version. So the two
#   steps are run separately here. The IDL step uses the host toolchain, which
#   is already new enough.
#
set -euo pipefail

TOOLS_VERSION="${SBF_TOOLS_VERSION:-v1.52}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# --localnet lowers MIN_TIMELOCK_DELAY to 2s so the governance happy path is testable
# against a validator, whose clock cannot be warped. Anything deployed anywhere real must
# be built WITHOUT it; the default below is the safe one, and it is not switchable by
# environment variable on purpose.
FEATURES=""
LABEL="production defaults"
if [[ "${1:-}" == "--localnet" ]]; then
  FEATURES="--features localnet"
  LABEL="LOCALNET — 2s timelock floor, DO NOT DEPLOY"
fi

mkdir -p target/idl target/types

echo "▸ Building program (platform-tools ${TOOLS_VERSION}, ${LABEL})"
# shellcheck disable=SC2086
cargo-build-sbf --tools-version "${TOOLS_VERSION}" \
  --manifest-path programs/agent-registry/Cargo.toml ${FEATURES}

# Which profile produced the .so currently sitting in target/deploy. `test:fast` reads
# this and refuses to run against a production binary, whose 1-hour timelock floor makes
# the governance tests fail in a way that looks like a code bug rather than a stale build.
# Learned the hard way.
echo "${LABEL}" > target/deploy/.build-profile

echo "▸ Generating IDL and TypeScript types"
anchor idl build \
  --out target/idl/agent_registry.json \
  --out-ts target/types/agent_registry.ts

echo "▸ Done"
ls -la target/deploy/agent_registry.so target/idl/agent_registry.json
