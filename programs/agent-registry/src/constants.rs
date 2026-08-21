use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const BUILDER_SEED: &[u8] = b"builder";
#[constant]
pub const AGENT_SEED: &[u8] = b"agent";
#[constant]
pub const BOND_SEED: &[u8] = b"bond";
#[constant]
pub const GOVERNANCE_SEED: &[u8] = b"governance";
#[constant]
pub const PENDING_SEED: &[u8] = b"pending";

pub const BPS_DENOMINATOR: u64 = 10_000;

/// 14 days. A bond only deters fraud if it is still slashable when the fraud is
/// caught — detection, investigation and convening the multisig all take time.
pub const DEFAULT_UNBOND_PERIOD: i64 = 14 * 24 * 60 * 60;

/// Upper bound on the governance-settable unbonding period (90 days), so a
/// misconfiguration cannot strand builder bonds indefinitely.
pub const MAX_UNBOND_PERIOD: i64 = 90 * 24 * 60 * 60;

/// 72 hours. Spec §11.3: the delay between a governance change being announced and
/// becoming real is the whole defence — it converts a silent instant seizure into a
/// public, observable pending change that the guardian and anyone watching can react to.
pub const DEFAULT_TIMELOCK_DELAY: i64 = 72 * 60 * 60;

/// A delay short enough to be outrun is not a delay. The floor exists so a careless
/// authority cannot initialise governance with a delay of zero and leave the guardian no
/// window at all. (`set_timelock_delay` is increase-only for the same reason, so the
/// floor only ever binds at initialisation.)
#[cfg(not(feature = "localnet"))]
pub const MIN_TIMELOCK_DELAY: i64 = 60 * 60;

/// Test-only. A validator's clock cannot be warped, so exercising a *successful*
/// timelocked execution means really waiting — which is only tolerable at a few seconds.
/// Guarded by a feature the production build script never passes.
#[cfg(feature = "localnet")]
pub const MIN_TIMELOCK_DELAY: i64 = 2;

/// Bounded above so a mistake cannot freeze governance permanently.
pub const MAX_TIMELOCK_DELAY: i64 = 30 * 24 * 60 * 60;

// ——— Locked launch parameters (see docs/onchain/agent-registry-and-vault.md §0) ———
pub const DEFAULT_LISTING_FEE_BPS: u16 = 0;
pub const DEFAULT_PERFORMANCE_FEE_BPS: u16 = 1_000; // 10% of net new profit
pub const DEFAULT_BUILDER_SPLIT_BPS: u16 = 8_000; // 80% builder / 20% platform
pub const DEFAULT_POSITION_CAP_BPS: u16 = 1_200; // 12%
pub const DEFAULT_MAX_DRAWDOWN_BPS: u16 = 1_500; // 15%

/// Slashed bonds split 70% to harmed traders, 30% to the buyback pool. Never
/// 100% to treasury — that would create an incentive to slash.
pub const SLASH_TRADER_BPS: u64 = 7_000;

// ——— Guardrails: hard ceilings the multisig itself cannot exceed ———
pub const MAX_LISTING_FEE_BPS: u16 = 500; // 5%
pub const MAX_PERFORMANCE_FEE_BPS: u16 = 2_000; // 20%
pub const MIN_BUILDER_SPLIT_BPS: u16 = 5_000; // builder never drops below 50%
pub const MAX_BPS: u16 = 10_000;

pub const TIER_COUNT: usize = 3;
