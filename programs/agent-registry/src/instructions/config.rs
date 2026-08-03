use crate::constants::*;
use crate::errors::RegistryError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = payer,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    pub agent_mint: Account<'info, Mint>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// One-time setup. The PDA can only be created once, so this cannot be re-run
/// to seize control.
pub fn initialize_config(
    ctx: Context<InitializeConfig>,
    authority: Pubkey,
    tier_bonds: [u64; TIER_COUNT],
    tier_ceilings: [u64; TIER_COUNT],
    unbond_period: Option<i64>,
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = authority;
    config.agent_mint = ctx.accounts.agent_mint.key();
    config.vault_authority = Pubkey::default();
    config.tier_bonds = tier_bonds;
    config.tier_ceilings = tier_ceilings;
    // Production passes `None` → 14 days. Tests pass a short period so both the
    // "too early" and "elapsed" branches of `withdraw_bond` are reachable.
    config.unbond_period = unbond_period.unwrap_or(DEFAULT_UNBOND_PERIOD);
    config.bump = ctx.bumps.config;
    config.validate_tiers()?;

    msg!(
        "Config initialised. Authority {}, unbond period {}s",
        authority,
        config.unbond_period
    );
    Ok(())
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    pub authority: Signer<'info>,
}

/// Tiers are fixed token counts rather than USD-pegged (no oracle dependency),
/// so the multisig needs a way to revise them if $AGENT price moves materially.
pub fn update_tiers(
    ctx: Context<UpdateConfig>,
    tier_bonds: [u64; TIER_COUNT],
    tier_ceilings: [u64; TIER_COUNT],
) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.tier_bonds = tier_bonds;
    config.tier_ceilings = tier_ceilings;
    config.validate_tiers()?;

    msg!("Tiers updated");
    Ok(())
}

/// Set once `agent_vault` is deployed. Until then no account can report AUM.
pub fn set_vault_authority(ctx: Context<UpdateConfig>, vault_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.vault_authority = vault_authority;
    msg!("Vault authority set to {}", vault_authority);
    Ok(())
}

/// Governance lever. Bounded above so a mistake cannot lock builder bonds
/// indefinitely; no lower bound, since shortening it only reduces the
/// multisig's own window to catch fraud.
pub fn set_unbond_period(ctx: Context<UpdateConfig>, unbond_period: i64) -> Result<()> {
    require!(
        unbond_period > 0 && unbond_period <= MAX_UNBOND_PERIOD,
        RegistryError::InvalidUnbondPeriod
    );
    ctx.accounts.config.unbond_period = unbond_period;
    msg!("Unbond period set to {}s", unbond_period);
    Ok(())
}

pub fn transfer_authority(ctx: Context<UpdateConfig>, new_authority: Pubkey) -> Result<()> {
    ctx.accounts.config.authority = new_authority;
    msg!("Authority transferred to {}", new_authority);
    Ok(())
}
