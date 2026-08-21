# Agent Circle — Polygon route

Contingency implementation of `agent_vault` in Solidity, for the case where Polymarket
liquidity cannot be reached from a Solana program.

**Status: scaffolding. Nothing here has been compiled.** Foundry is not installed on the
machine this was written on, so every contract and test in this directory is unverified.
Treat the structure and the reasoning as the deliverable; expect compile errors on the
first `forge build` and fix them before reading anything else as working.

---

## 1. Why this exists

The Solana route is preferred and is not abandoned. It hangs on three questions currently
sitting unanswered with Jupiter (see
[`venue-analysis-and-jupiter-questions.md`](../../agent-circle-app/docs/onchain/venue-analysis-and-jupiter-questions.md) §5).
The deepest prediction-market liquidity is Polymarket, and Polymarket is on Polygon, so
this is the shorter path — which is exactly why it needs to be built with the same care
rather than treated as a fallback nobody will look at closely.

Everything here mirrors
[`agent-registry-and-vault.md`](../../agent-circle-app/docs/onchain/agent-registry-and-vault.md).
Where the two diverge, the spec wins and this is wrong.

---

## 2. Open decision: where does the registry live?

**Not resolved. The code is written so it doesn't have to be, yet.**

`agent_registry` is deployed and working on Solana devnet. It owns listings, builder
bonds, tier ceilings and the fee parameters. On Solana the vault reaches it by CPI. On
Polygon it cannot.

Three options, none free:

| Option | Cost |
|---|---|
| **a.** Port the registry to Polygon | Full duplication. Builder bonds are denominated in $AGENT, a Solana token that does not exist yet. Bridging it to bond against is a second problem stacked on the first. |
| **b.** Keep the registry on Solana, mirror listing state to Polygon | Requires a relayer attesting Solana state to Polygon. That relayer becomes a trusted party that can forge a `Live` listing — precisely the failure mode §11 of the spec was written to avoid. |
| **c.** Two independent deployments | Registry on each chain, each authoritative for its own vaults. No bridge, no relayer, but reputation and leaderboard history fragment across chains. |

`IAgentRegistry` is the seam. The vault depends only on that interface, so resolving this
swaps one implementation and leaves `AgentVault.sol` untouched.

Leaning **(c)** — it's the only one that adds no new trusted party. But this is a
product decision about whether builder reputation is per-chain, not purely a technical
one, so it is flagged rather than taken.

---

## 3. Open decision: how does a trade actually settle?

**This is the largest unresolved question on the Polygon route, and it is a real threat
to the core guarantee.**

The Solana design passes instruction data straight through to a whitelisted program, so
the trade happens inside our transaction and our risk checks bracket it. Polymarket's CTF
Exchange does not work that way: orders are signed off-chain, matched by an operator, and
settled later. If the vault signs an order, the funds move at settlement — in a
transaction we do not control and cannot attach post-conditions to.

That breaks "position caps and drawdown limits enforced atomically, in the same
transaction as the trade," which is the sentence the entire product rests on.

Possible resolutions, in rough order of preference:

1. **Vault as taker.** Call `fillOrder` directly against a resting order. Atomic, and our
   post-conditions hold. Costs the maker rebate and requires a counterparty order to
   already exist at an acceptable price.
2. **Bounded pre-authorisation.** Sign orders whose worst-case fill is provably inside
   the limits, so no settlement outcome can breach them. Weaker: enforces at signing
   rather than at settlement, and stale orders are a real hazard.
3. **Operator-side enforcement.** Rejected. Puts the guarantee in someone else's process.

`IVenueAdapter.execute` is documented to require atomicity precisely so this cannot be
quietly compromised: an adapter that merely queues an order does not satisfy the
interface and must not be whitelisted.

**Nobody should write the Polymarket adapter until this is settled.** That is why
`src/adapters/` does not exist yet — a half-designed adapter would be the most expensive
thing in this directory.

---

## 4. What is here

```
src/
  AgentVault.sol            core vault: custody, limits, fee assessment
  VenueWhitelist.sol        timelocked allowlist with a veto-only guardian
  Errors.sol                revert reasons, named to match the Anchor error codes
  libraries/
    HighWaterMark.sol       fee accounting — the correctness-critical part
  interfaces/
    IAgentRegistry.sol      the seam described in §2
    IVenueAdapter.sol       the seam described in §3
test/
  HighWaterMark.t.sol       variance-farming scenarios, plus fuzz invariants
  AgentVault.t.sol          custody and limit enforcement
  VenueWhitelist.t.sol      the Drift lesson, encoded
script/
  Deploy.s.sol              Amoy only, deliberately
```

### Translation decisions worth knowing

**One contract, many vaults.** On Solana each vault is its own PDA. Deploying a contract
per trader on Polygon would be pointless gas, so this is a singleton with a mapping keyed
by `keccak256(trader, listingId)`. Security properties are identical. Accounting is not:
the contract now custodies many traders' tokens at once, so per-vault `idle` bookkeeping
is load-bearing and the contract's own ERC-20 balance must never be read as any single
vault's balance.

**Post-condition enforcement.** Rather than predicting what a venue call will do, the
vault performs it and asserts the resulting state is legal, reverting everything if not.
Prediction is fragile against venues we do not control.

**Bounded allowances.** `executeTrade` takes an explicit `maxSpend` and resets the
allowance to zero afterwards, so a compromised adapter cannot pull more than the agent
authorised for that one call.

---

## 5. Setup

Foundry is not installed. Install it yourself rather than having an agent pipe a remote
script into your shell:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

Then, from this directory:

```bash
forge install foundry-rs/forge-std OpenZeppelin/openzeppelin-contracts --no-git
```

```bash
forge build
```

```bash
forge test -vvv
```

Expect the first build to fail. It has never been run.

---

## 6. Before mainnet

- `GOVERNANCE` must be a Safe multisig, never an EOA.
- `GUARDIAN` must be a separate key held by a different person, on different hardware.
- Audit, covering `HighWaterMark` and `executeTrade` first.
- §2 and §3 resolved and documented, not worked around.
