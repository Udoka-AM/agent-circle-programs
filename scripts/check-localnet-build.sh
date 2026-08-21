#!/usr/bin/env bash
#
# Refuse to run the test suite against a production binary.
#
# The governance tests use a 2-second timelock, which only exists under the `localnet`
# feature. Against a production build they fail with InvalidTimelockDelay — a real error
# from the program, which reads exactly like a code bug and is actually a stale artifact.
# Cheaper to catch here than to debug there.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE_FILE="$ROOT/target/deploy/.build-profile"

if [[ ! -f "$PROFILE_FILE" ]]; then
  echo "✗ No build profile recorded. Run: yarn build:localnet" >&2
  exit 1
fi

if ! grep -q "LOCALNET" "$PROFILE_FILE"; then
  echo "✗ target/deploy holds a $(cat "$PROFILE_FILE") build." >&2
  echo "  The governance tests need the 2s timelock floor. Run: yarn build:localnet" >&2
  exit 1
fi
