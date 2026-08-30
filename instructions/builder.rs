use crate::constants::*;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};

#[derive(Accounts)]
pub struct RegisterBuilder<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = authority,
        space = 8 + Builder::INIT_SPACE,
        seeds = [BUILDER_SEED, authority.key().as_ref()],
        bump
    )]
    pub builder: Account<'info, Builder>,

    /// Escrow for staked $AGENT, owned by the builder PDA. Created here so that
    /// `stake_bond` never needs `init_if_needed`.
    #[account(
        init,
        payer = authority,
        seeds = [BOND_SEED, builder.key().as_ref()],
        bump,
        token::mint = agent_mint,
        token::authority = builder,
    )]
    pub bond_vault: Account<'info, TokenAccount>,

    #[account(address = config.agent_mint)]
    pub agent_mint: Account<'info, Mint>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn register_builder(ctx: Context<RegisterBuilder>) -> Result<()> {
    let builder = &mut ctx.accounts.builder;
    builder.authority = ctx.accounts.authority.key();
    builder.bond_amount = 0;
    builder.total_aum = 0;
    builder.tier = 0;
    builder.unbond_requested_at = 0;
    builder.slash_count = 0;
    builder.agent_count = 0;
    builder.created_at = Clock::get()?.unix_timestamp;
    builder.bump = ctx.bumps.builder;

    msg!("Builder registered: {}", builder.authority);
    Ok(())
}
