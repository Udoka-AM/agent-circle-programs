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

mkdir -p target/idl target/types

echo "▸ Building program (platform-tools ${TOOLS_VERSION})"
cargo-build-sbf --tools-version "${TOOLS_VERSION}" \
  --manifest-path programs/agent-registry/Cargo.toml

echo "▸ Generating IDL and TypeScript types"
anchor idl build \
  --out target/idl/agent_registry.json \
  --out-ts target/types/agent_registry.ts

echo "▸ Done"
ls -la target/deploy/agent_registry.so target/idl/agent_registry.json
