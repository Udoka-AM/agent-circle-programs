# Agent Circle — On-Chain Programs

Anchor programs backing the Agent Circle marketplace.

**Spec:** [`agent-circle-app/docs/onchain/agent-registry-and-vault.md`](https://github.com/el-uno/agent-circle-app/blob/main/docs/onchain/agent-registry-and-vault.md)

| Program | Status | Purpose |
|---|---|---|
| `agent-registry` | **Built · 38 tests passing · devnet-ready** | Builder identity, agent listings, staked bonds, slashing |
| `agent-vault` | Not started — blocked on venue whitelist | Trader capital, trade permissions, fee accounting |

Program ID (devnet): `22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6`

--

## Quick start

```bash
yarn install
yarn build     # compile + emit IDL and TS types
yarn test      # build, then run against a local validator
yarn test:fast # skip the rebuild
```

### Why `scripts/build.sh` and not `anchor build`

The Solana CLI (2.1.22) ships platform-tools **v1.43**, whose bundled rustc (1.79)
predates the `edition2024` stabilisation that several transitive dependencies of
`anchor-spl` now require. Platform-tools **v1.52** carries rustc 1.89 and compiles
the tree cleanly.

`anchor build` forwards trailing arguments to *both* the SBF build and the IDL
build, and the IDL step (`cargo test`) rejects `--tools-version`. The script runs
the two steps separately; the IDL step uses the host toolchain, which is already
new enough.

Override with `SBF_TOOLS_VERSION=v1.52 yarn build` if needed. Versions v1.53+ fail
with a missing `core` crate against this CLI

---

## `agent-registry`

### Accounts

| Account | PDA seeds | Purpose |
|---|---|---|
| `Config` | `["config"]` | Multisig authority, $AGENT mint, tier table, unbond period |
| `Builder` | `["builder", authority]` | Identity, bond, tier, total AUM, slash history |
| `AgentListing` | `["agent", builder, index_le]` | Status, fees, risk caps, agent signing key |
| `BondVault` | `["bond", builder]` | SPL escrow for staked $AGENT, owned by the builder PDA |

### Instruction groups

- **Config (multisig):** `initialize_config`, `update_tiers`, `set_unbond_period`, `set_vault_authority`, `transfer_authority`
- **Builder:** `register_builder`
- **Bond:** `stake_bond`, `request_unbond`, `cancel_unbond`, `withdraw_bond`, `slash_bond` *(multisig)*
- **Listing:** `submit_listing`, `approve_listing` *(multisig)*, `pause_listing`, `resume_listing`, `delist`, `rotate_agent_authority`
- **AUM (CPI from `agent-vault`):** `record_deposit`, `record_withdrawal`

### Invariants worth knowing

- **The AUM ceiling is enforced per *builder*, not per listing.** The bond is the
  deterrent, and a builder able to defraud across three agents is exposed for the
  sum of them. `Builder.total_aum` is the enforced figure; `AgentListing.aum_current`
  is per-listing bookkeeping.
- **Withdrawals always work.** `record_withdrawal` has no status or tier checks, so
  traders can exit a paused listing, a delisted agent, or an unbonding builder.
- **Unbonding blocks inflow, not outflow.** `request_unbond` immediately stops new
  listings and new trader capital; the bond stays slashable for the full period.
- **A withdrawal consumes the unbond request.** Withdrawing again means waiting
  another period — there is no permanently open exit window.
- **Fee guardrails bound the multisig itself.** Performance fee ≤ 20%, listing fee
  ≤ 5%, builder split ≥ 50%. `approve_listing(null)` applies the locked launch
  defaults (0 / 1000 / 8000 bps, 1200 position cap, 1500 max drawdown).
- **Slashing splits 70/30** between harmed traders and the buyback pool. Never 100%
  to treasury, which would create an incentive to slash

### Deviation from the spec

The spec listed `aum_ceiling` on `AgentListing`. It is not implemented there: a
per-listing copy of a builder-level tier value is duplicated state that can drift,
and the correct invariant is the sum across a builder's listings. The ceiling is
derived from `Builder.tier` via `Config::ceiling_for_tier` at check time.

---

## ⚠️ Program keypair

`target/` is gitignored, so `target/deploy/agent_registry-keypair.json` — which
**is** the program's identity and upgrade authority — is not in version control and
would be destroyed by `anchor clean`.

A backup exists at `~/Documents/agent-registry-PROGRAM-KEYPAIR-BACKUP.json`.
Move it into a password manager or the team's secret store. Losing it means the
program can never be upgraded at this address.

---

## Not yet done

- Devnet deployment (`solana program deploy`)
- `agent-vault` — blocked on the venue whitelist decision (see spec §9.1)
- Bond tier amounts — currently supplied per-call; production values pending the
  $AGENT price/float decision (spec §9.2)
- Independent audit — required before any real funds.