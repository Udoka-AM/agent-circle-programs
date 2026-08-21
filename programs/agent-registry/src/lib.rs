//! # Agent Registry
//!
//! Builder identity, agent listings, and staked bonds for Agent Circle.
//!
//! Companion program to `agent_vault`, which holds trader capital and calls back
//! here over CPI to report AUM. Splitting them keeps this identity layer stable
//! while the value-holding program iterates behind its own upgrade authority.
//!
//! Spec: `docs/onchain/agent-registry-and-vault.md`

use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;

use constants::TIER_COUNT;
use instructions::*;
use state::{ActionKind, FeeConfig};

declare_id!("22rFHvivAX4hDwx3NdwfQ1hsyorwDFxc9JLy5WcZV7x6");

#[program]
pub mod agent_registry {
    use super::*;

    // ——— configuration (multisig) ———

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        authority: Pubkey,
        tier_bonds: [u64; TIER_COUNT],
        tier_ceilings: [u64; TIER_COUNT],
        unbond_period: Option<i64>,
    ) -> Result<()> {
        instructions::config::initialize_config(
            ctx,
            authority,
            tier_bonds,
            tier_ceilings,
            unbond_period,
        )
    }

    pub fn set_unbond_period(ctx: Context<UpdateConfig>, unbond_period: i64) -> Result<()> {
        instructions::config::set_unbond_period(ctx, unbond_period)
    }

    // ——— governance: timelock and guardian (spec §11) ———
    //
    // `transfer_authority`, `set_vault_authority` and `update_tiers` used to apply
    // immediately. They no longer exist as direct instructions — each can hand an
    // attacker the registry, so each is now queue-wait-execute with a guardian able to
    // veto during the wait. See `instructions/governance.rs`.

    pub fn initialize_governance(
        ctx: Context<InitializeGovernance>,
        guardian: Pubkey,
        timelock_delay: Option<i64>,
    ) -> Result<()> {
        instructions::governance::initialize_governance(ctx, guardian, timelock_delay)
    }

    pub fn set_guardian(ctx: Context<SetGuardian>, new_guardian: Pubkey) -> Result<()> {
        instructions::governance::set_guardian(ctx, new_guardian)
    }

    pub fn set_timelock_delay(ctx: Context<SetGuardian>, delay: i64) -> Result<()> {
        instructions::governance::set_timelock_delay(ctx, delay)
    }

    pub fn queue_transfer_authority(
        ctx: Context<QueueChange>,
        kind: ActionKind,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::governance::queue_transfer_authority(ctx, kind, new_authority)
    }

    pub fn queue_set_vault_authority(
        ctx: Context<QueueChange>,
        kind: ActionKind,
        vault_authority: Pubkey,
    ) -> Result<()> {
        instructions::governance::queue_set_vault_authority(ctx, kind, vault_authority)
    }

    pub fn queue_update_tiers(
        ctx: Context<QueueChange>,
        kind: ActionKind,
        tier_bonds: [u64; TIER_COUNT],
        tier_ceilings: [u64; TIER_COUNT],
    ) -> Result<()> {
        instructions::governance::queue_update_tiers(ctx, kind, tier_bonds, tier_ceilings)
    }

    pub fn execute_change(ctx: Context<ResolveChange>, kind: ActionKind) -> Result<()> {
        instructions::governance::execute_change(ctx, kind)
    }

    pub fn veto_change(ctx: Context<ResolveChange>, kind: ActionKind) -> Result<()> {
        instructions::governance::veto_change(ctx, kind)
    }

    pub fn guardian_pause_listing(ctx: Context<GuardianPauseListing>) -> Result<()> {
        instructions::governance::guardian_pause_listing(ctx)
    }

    // ——— builder identity ———

    pub fn register_builder(ctx: Context<RegisterBuilder>) -> Result<()> {
        instructions::builder::register_builder(ctx)
    }

    // ——— bond ———

    pub fn stake_bond(ctx: Context<StakeBond>, amount: u64) -> Result<()> {
        instructions::bond::stake_bond(ctx, amount)
    }

    pub fn request_unbond(ctx: Context<ManageUnbond>) -> Result<()> {
        instructions::bond::request_unbond(ctx)
    }

    pub fn cancel_unbond(ctx: Context<ManageUnbond>) -> Result<()> {
        instructions::bond::cancel_unbond(ctx)
    }

    pub fn withdraw_bond(ctx: Context<WithdrawBond>, amount: u64) -> Result<()> {
        instructions::bond::withdraw_bond(ctx, amount)
    }

    pub fn slash_bond(
        ctx: Context<SlashBond>,
        amount: u64,
        reason_hash: [u8; 32],
    ) -> Result<()> {
        instructions::bond::slash_bond(ctx, amount, reason_hash)
    }

    // ——— listings ———

    pub fn submit_listing(
        ctx: Context<SubmitListing>,
        agent_authority: Pubkey,
        market: u8,
        metadata_hash: [u8; 32],
    ) -> Result<()> {
        instructions::listing::submit_listing(ctx, agent_authority, market, metadata_hash)
    }

    pub fn approve_listing(
        ctx: Context<ApproveListing>,
        fee_config: Option<FeeConfig>,
    ) -> Result<()> {
        instructions::listing::approve_listing(ctx, fee_config)
    }

    pub fn pause_listing(ctx: Context<ManageListing>) -> Result<()> {
        instructions::listing::pause_listing(ctx)
    }

    pub fn resume_listing(ctx: Context<ManageListing>) -> Result<()> {
        instructions::listing::resume_listing(ctx)
    }

    pub fn delist(ctx: Context<ManageListing>) -> Result<()> {
        instructions::listing::delist(ctx)
    }

    pub fn rotate_agent_authority(
        ctx: Context<RotateAgentAuthority>,
        new_agent_authority: Pubkey,
    ) -> Result<()> {
        instructions::listing::rotate_agent_authority(ctx, new_agent_authority)
    }

    // ——— AUM reporting (CPI from agent_vault) ———

    pub fn record_deposit(
        ctx: Context<RecordAum>,
        amount: u64,
        is_new_vault: bool,
    ) -> Result<()> {
        instructions::aum::record_deposit(ctx, amount, is_new_vault)
    }

    pub fn record_withdrawal(
        ctx: Context<RecordAum>,
        amount: u64,
        vault_closed: bool,
    ) -> Result<()> {
        instructions::aum::record_withdrawal(ctx, amount, vault_closed)
    }
}
