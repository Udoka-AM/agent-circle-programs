use anchor_lang::prelude::*;

#[constant]
pub const CONFIG_SEED: &[u8] = b"config";
#[constant]
pub const BUILDER_SEED: &[u8] = b"builder";
#[constant]
pub const AGENT_SEED: &[u8] = b"agent";
#[constant]
pub const BOND_SEED: &[u8] = b"bond";

pub const BPS_DENOMINATOR: u64 = 10_000;

/// 14 days. A bond only deters fraud if it is still slashable when the fraud is
/// caught — detection, investigation and convening the multisig all take time.
pub const DEFAULT_UNBOND_PERIOD: i64 = 14 * 24 * 60 * 60;

/// Upper bound on the governance-settable unbonding period (90 days), so a
/// misconfiguration cannot strand builder bonds indefinitely.
pub const MAX_UNBOND_PERIOD: i64 = 90 * 24 * 60 * 60;

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
