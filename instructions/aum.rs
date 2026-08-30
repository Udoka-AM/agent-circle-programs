use crate::constants::*;
use crate::errors::RegistryError;
use crate::state::*;
use anchor_lang::prelude::*;

/// Called by `agent_vault` over CPI. The vault signs with its own PDA, which the
/// multisig registers here via `set_vault_authority` once that program is
/// deployed — until then nothing can move AUM.
#[derive(Accounts)]
pub struct RecordAum<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BUILDER_SEED, builder.authority.as_ref()],
        bump = builder.bump,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        mut,
        seeds = [AGENT_SEED, listing.builder.as_ref(), &listing.index.to_le_bytes()],
        bump = listing.bump,
        constraint = listing.builder == builder.key(),
    )]
    pub listing: Account<'info, AgentListing>,

    pub vault_authority: Signer<'info>,
}

impl<'info> RecordAum<'info> {
    fn assert_vault(&self) -> Result<()> {
        require!(
            self.config.vault_authority != Pubkey::default(),
            RegistryError::VaultAuthorityUnset
        );
        require!(
            self.vault_authority.key() == self.config.vault_authority,
            RegistryError::NotVaultAuthority
        );
        Ok(())
    }
}

/// Trader capital entering a vault.
///
/// The ceiling is checked against the builder's *total* AUM rather than the
/// single listing: the bond is the deterrent, and a builder able to defraud
/// across several agents is exposed for the sum of them.
pub fn record_deposit(ctx: Context<RecordAum>, amount: u64, is_new_vault: bool) -> Result<()> {
    ctx.accounts.assert_vault()?;
    require!(amount > 0, RegistryError::ZeroAmount);

    require!(
        ctx.accounts.listing.status == ListingStatus::Live,
        RegistryError::ListingNotLive
    );
    require!(
        !ctx.accounts.builder.is_unbonding(),
        RegistryError::BuilderUnbonding
    );

    let new_total = ctx
        .accounts
        .builder
        .total_aum
        .checked_add(amount)
        .ok_or(RegistryError::MathOverflow)?;
    let ceiling = ctx
        .accounts
        .config
        .ceiling_for_tier(ctx.accounts.builder.tier);
    require!(new_total <= ceiling, RegistryError::AumCeilingExceeded);

    let builder = &mut ctx.accounts.builder;
    builder.total_aum = new_total;

    let listing = &mut ctx.accounts.listing;
    listing.aum_current = listing
        .aum_current
        .checked_add(amount)
        .ok_or(RegistryError::MathOverflow)?;
    if is_new_vault {
        listing.vault_count = listing
            .vault_count
            .checked_add(1)
            .ok_or(RegistryError::MathOverflow)?;
    }

    msg!(
        "Deposit {} — listing AUM {}, builder AUM {}/{}",
        amount,
        listing.aum_current,
        new_total,
        ceiling
    );
    Ok(())
}

/// Trader capital leaving a vault. Deliberately has no status or tier checks —
/// withdrawal must stay possible even when a listing is paused, delisted, or
/// the builder is unbonding.
pub fn record_withdrawal(ctx: Context<RecordAum>, amount: u64, vault_closed: bool) -> Result<()> {
    ctx.accounts.assert_vault()?;
    require!(amount > 0, RegistryError::ZeroAmount);

    let builder = &mut ctx.accounts.builder;
    builder.total_aum = builder.total_aum.saturating_sub(amount);

    let listing = &mut ctx.accounts.listing;
    listing.aum_current = listing.aum_current.saturating_sub(amount);
    if vault_closed {
        listing.vault_count = listing.vault_count.saturating_sub(1);
    }

    msg!(
        "Withdrawal {} — listing AUM {}, builder AUM {}",
        amount,
        listing.aum_current,
        builder.total_aum
    );
    Ok(())
}
