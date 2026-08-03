use crate::constants::*;
use crate::errors::RegistryError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

// ——————————————————————————————— stake ———————————————————————————————

#[derive(Accounts)]
pub struct StakeBond<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BUILDER_SEED, authority.key().as_ref()],
        bump = builder.bump,
        has_one = authority,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        mut,
        seeds = [BOND_SEED, builder.key().as_ref()],
        bump,
    )]
    pub bond_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = source.mint == config.agent_mint,
        constraint = source.owner == authority.key(),
    )]
    pub source: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn stake_bond(ctx: Context<StakeBond>, amount: u64) -> Result<()> {
    require!(amount > 0, RegistryError::ZeroAmount);
    require!(
        !ctx.accounts.builder.is_unbonding(),
        RegistryError::BuilderUnbonding
    );

    token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.source.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            },
        ),
        amount,
    )?;

    let config = &ctx.accounts.config;
    let builder = &mut ctx.accounts.builder;
    builder.bond_amount = builder
        .bond_amount
        .checked_add(amount)
        .ok_or(RegistryError::MathOverflow)?;
    builder.tier = config.tier_for_bond(builder.bond_amount);

    msg!(
        "Staked {}. Bond {} → tier {} (ceiling {})",
        amount,
        builder.bond_amount,
        builder.tier,
        config.ceiling_for_tier(builder.tier)
    );
    Ok(())
}

// ——————————————————————————————— unbond ———————————————————————————————

#[derive(Accounts)]
pub struct ManageUnbond<'info> {
    #[account(
        mut,
        seeds = [BUILDER_SEED, authority.key().as_ref()],
        bump = builder.bump,
        has_one = authority,
    )]
    pub builder: Account<'info, Builder>,

    pub authority: Signer<'info>,
}

/// Starts the unbonding clock. From this moment the builder may take on no new
/// trader capital — `agent_vault` refuses deposits while `unbond_requested_at`
/// is set — but the bond stays fully slashable for the whole period.
pub fn request_unbond(ctx: Context<ManageUnbond>) -> Result<()> {
    let builder = &mut ctx.accounts.builder;
    require!(
        !builder.is_unbonding(),
        RegistryError::UnbondAlreadyRequested
    );

    builder.unbond_requested_at = Clock::get()?.unix_timestamp;
    msg!("Unbond requested at {}", builder.unbond_requested_at);
    Ok(())
}

pub fn cancel_unbond(ctx: Context<ManageUnbond>) -> Result<()> {
    let builder = &mut ctx.accounts.builder;
    require!(builder.is_unbonding(), RegistryError::UnbondNotRequested);

    builder.unbond_requested_at = 0;
    msg!("Unbond cancelled");
    Ok(())
}

// ——————————————————————————————— withdraw ———————————————————————————————

#[derive(Accounts)]
pub struct WithdrawBond<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BUILDER_SEED, authority.key().as_ref()],
        bump = builder.bump,
        has_one = authority,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        mut,
        seeds = [BOND_SEED, builder.key().as_ref()],
        bump,
    )]
    pub bond_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = destination.mint == config.agent_mint,
    )]
    pub destination: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

pub fn withdraw_bond(ctx: Context<WithdrawBond>, amount: u64) -> Result<()> {
    require!(amount > 0, RegistryError::ZeroAmount);

    let config = &ctx.accounts.config;
    let builder = &ctx.accounts.builder;

    require!(builder.is_unbonding(), RegistryError::UnbondNotRequested);
    require!(
        amount <= builder.bond_amount,
        RegistryError::InsufficientBond
    );

    let now = Clock::get()?.unix_timestamp;
    let elapsed = now
        .checked_sub(builder.unbond_requested_at)
        .ok_or(RegistryError::MathOverflow)?;
    require!(
        elapsed >= config.unbond_period,
        RegistryError::UnbondPeriodNotElapsed
    );

    // Even after the clock expires the builder cannot drop below the tier that
    // covers capital still deployed with them — traders must exit first.
    let remaining = builder
        .bond_amount
        .checked_sub(amount)
        .ok_or(RegistryError::MathOverflow)?;
    let new_tier = config.tier_for_bond(remaining);
    require!(
        config.ceiling_for_tier(new_tier) >= builder.total_aum,
        RegistryError::TierWouldNotCoverAum
    );

    let authority_key = builder.authority;
    let builder_bump = builder.bump;
    let seeds: &[&[u8]] = &[BUILDER_SEED, authority_key.as_ref(), &[builder_bump]];

    token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.bond_vault.to_account_info(),
                to: ctx.accounts.destination.to_account_info(),
                authority: ctx.accounts.builder.to_account_info(),
            },
            &[seeds],
        ),
        amount,
    )?;

    let builder = &mut ctx.accounts.builder;
    builder.bond_amount = remaining;
    builder.tier = new_tier;
    // The request is consumed. Withdrawing again means waiting another period —
    // this prevents a permanently open withdrawal window.
    builder.unbond_requested_at = 0;

    msg!("Withdrew {}. Bond {} → tier {}", amount, remaining, new_tier);
    Ok(())
}

// ——————————————————————————————— slash ———————————————————————————————

#[derive(Accounts)]
pub struct SlashBond<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = authority @ RegistryError::Unauthorized,
    )]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        seeds = [BUILDER_SEED, builder.authority.as_ref()],
        bump = builder.bump,
    )]
    pub builder: Account<'info, Builder>,

    #[account(
        mut,
        seeds = [BOND_SEED, builder.key().as_ref()],
        bump,
    )]
    pub bond_vault: Account<'info, TokenAccount>,

    /// Receives 70% — compensation for harmed traders.
    #[account(mut, constraint = trader_compensation.mint == config.agent_mint)]
    pub trader_compensation: Account<'info, TokenAccount>,

    /// Receives 30% — the buyback pool.
    #[account(mut, constraint = buyback.mint == config.agent_mint)]
    pub buyback: Account<'info, TokenAccount>,

    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

/// Multisig-gated. Most real misconduct (wash trading, manipulation) is not
/// mechanically provable on-chain, so this is governed slashing with public
/// rationale — deliberately not marketed as trustless.
pub fn slash_bond(ctx: Context<SlashBond>, amount: u64, reason_hash: [u8; 32]) -> Result<()> {
    require!(amount > 0, RegistryError::ZeroAmount);
    require!(
        amount <= ctx.accounts.builder.bond_amount,
        RegistryError::InsufficientBond
    );

    let trader_cut = (amount as u128)
        .checked_mul(SLASH_TRADER_BPS as u128)
        .ok_or(RegistryError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(RegistryError::MathOverflow)? as u64;
    let buyback_cut = amount
        .checked_sub(trader_cut)
        .ok_or(RegistryError::MathOverflow)?;

    let authority_key = ctx.accounts.builder.authority;
    let builder_bump = ctx.accounts.builder.bump;
    let seeds: &[&[u8]] = &[BUILDER_SEED, authority_key.as_ref(), &[builder_bump]];

    if trader_cut > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.trader_compensation.to_account_info(),
                    authority: ctx.accounts.builder.to_account_info(),
                },
                &[seeds],
            ),
            trader_cut,
        )?;
    }

    if buyback_cut > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.bond_vault.to_account_info(),
                    to: ctx.accounts.buyback.to_account_info(),
                    authority: ctx.accounts.builder.to_account_info(),
                },
                &[seeds],
            ),
            buyback_cut,
        )?;
    }

    let config = &ctx.accounts.config;
    let builder = &mut ctx.accounts.builder;
    builder.bond_amount = builder
        .bond_amount
        .checked_sub(amount)
        .ok_or(RegistryError::MathOverflow)?;
    builder.tier = config.tier_for_bond(builder.bond_amount);
    builder.slash_count = builder.slash_count.saturating_add(1);

    msg!(
        "Slashed {} ({} traders / {} buyback). Reason {:?}. Bond {} → tier {}",
        amount,
        trader_cut,
        buyback_cut,
        reason_hash,
        builder.bond_amount,
        builder.tier
    );
    Ok(())
}
