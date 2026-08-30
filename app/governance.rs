//! Timelocked governance and the guardian veto.
//!
//! Designed against a real precedent. In April 2026 Drift lost $285M — not to a bug, but
//! to months of social engineering that ended in admin control. The lesson recorded in
//! spec §11 is that a multisig is a smaller attack surface than a single key, not a safe
//! one, and that the code must assume the multisig itself can fall.
//!
//! Two defences follow from that:
//!
//! 1. **The dangerous levers are delayed.** `transfer_authority`, `set_vault_authority`
//!    and `update_tiers` can each hand an attacker the whole registry — the first by
//!    seizing it outright, the second by pointing AUM accounting at a program that mints
//!    headroom from nothing, the third by raising ceilings so bonds stop covering
//!    anything. None of them may take effect in the transaction that proposes them. A
//!    compromised multisig buys the attacker a public announcement, not the registry.
//!
//! 2. **The guardian can cancel but never initiate.** A separate key, held by a different
//!    person on different hardware, can veto any pending change and pause any listing
//!    instantly. It cannot propose, approve, or execute anything. Stealing it gains an
//!    attacker no ability to act — only the ability to obstruct, which is the direction
//!    it is safe to be wrong in.
//!
//! Vetoes and pauses are immediate; only additions of power wait. Emergency response must
//! always be faster than emergency damage.

use crate::constants::*;
use crate::errors::RegistryError;
use crate::state::*;
use anchor_lang::prelude::*;

// ───────────────────────────────────────────────────────────── bootstrap

#[derive(Accounts)]
pub struct InitializeGovernance<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(
        init,
        payer = payer,
        space = 8 + Governance::INIT_SPACE,
        seeds = [GOVERNANCE_SEED],
        bump
    )]
    pub governance: Account<'info, Governance>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

/// One-time. The PDA can only be created once, so this cannot be re-run to install a
/// friendly guardian later — replacing one goes through `set_guardian`.
pub fn initialize_governance(
    ctx: Context<InitializeGovernance>,
    guardian: Pubkey,
    timelock_delay: Option<i64>,
) -> Result<()> {
    require_keys_neq!(guardian, Pubkey::default(), RegistryError::Unauthorized);
    // A guardian that is the authority is not a guardian. The whole value of the key is
    // that compromising the multisig does not also compromise the veto.
    require_keys_neq!(
        guardian,
        ctx.accounts.config.authority,
        RegistryError::Unauthorized
    );

    // Production passes `None` → 72 hours. Tests pass a short delay so both the
    // "too early" and "elapsed" branches are reachable.
    let delay = timelock_delay.unwrap_or(DEFAULT_TIMELOCK_DELAY);
    require!(
        (MIN_TIMELOCK_DELAY..=MAX_TIMELOCK_DELAY).contains(&delay),
        RegistryError::InvalidTimelockDelay
    );

    let g = &mut ctx.accounts.governance;
    g.guardian = guardian;
    g.timelock_delay = delay;
    g.bump = ctx.bumps.governance;

    msg!("Governance initialised. Guardian {}, delay {}s", guardian, delay);
    Ok(())
}

#[derive(Accounts)]
pub struct SetGuardian<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(mut, seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,

    pub authority: Signer<'info>,
}

/// Deliberately immediate, and deliberately not timelocked.
///
/// A guardian suspected of compromise needs replacing faster than a delay allows, and
/// rotating the veto key grants the authority no new power over funds — it only changes
/// who can obstruct it. The risk of a slow rotation is larger than the risk of a fast one.
pub fn set_guardian(ctx: Context<SetGuardian>, new_guardian: Pubkey) -> Result<()> {
    require_keys_neq!(new_guardian, Pubkey::default(), RegistryError::Unauthorized);
    require_keys_neq!(
        new_guardian,
        ctx.accounts.config.authority,
        RegistryError::Unauthorized
    );

    let previous = ctx.accounts.governance.guardian;
    ctx.accounts.governance.guardian = new_guardian;

    msg!("Guardian rotated from {} to {}", previous, new_guardian);
    Ok(())
}

/// Increase-only, and that restriction is load-bearing rather than fussy.
///
/// If the delay could be lowered, a compromised authority would not need to defeat the
/// timelock — it would simply shorten it to the floor, queue, wait out the remnant, and
/// execute. The guardian's window would be whatever the attacker chose to leave. Allowing
/// only increases means the delay in force is always at least the one the guardian agreed
/// to when they took the key.
///
/// Shortening it therefore requires a program upgrade, which on mainnet is itself behind
/// the Squads multisig. Losing the ability to make governance *faster* is a cost worth
/// paying; nothing here is urgent enough to need it.
pub fn set_timelock_delay(ctx: Context<SetGuardian>, delay: i64) -> Result<()> {
    require!(
        delay <= MAX_TIMELOCK_DELAY && delay > ctx.accounts.governance.timelock_delay,
        RegistryError::InvalidTimelockDelay
    );
    ctx.accounts.governance.timelock_delay = delay;
    msg!("Timelock delay raised to {}s", delay);
    Ok(())
}

// ───────────────────────────────────────────────────────────── queue

#[derive(Accounts)]
#[instruction(kind: ActionKind)]
pub struct QueueChange<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = authority @ RegistryError::Unauthorized)]
    pub config: Account<'info, Config>,

    #[account(seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,

    /// One slot per action kind, so a pending authority transfer and a pending tier
    /// update cannot displace each other. `init` also means a second proposal of the same
    /// kind fails outright rather than silently overwriting the first — re-proposing
    /// requires an explicit veto or execution, which keeps the pending set legible to
    /// anyone watching the chain.
    #[account(
        init,
        payer = payer,
        space = 8 + PendingChange::INIT_SPACE,
        seeds = [PENDING_SEED, &[kind.seed()]],
        bump
    )]
    pub pending: Account<'info, PendingChange>,

    pub authority: Signer<'info>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

fn queue(
    ctx: &mut Context<QueueChange>,
    kind: ActionKind,
    new_key: Pubkey,
    tier_bonds: [u64; TIER_COUNT],
    tier_ceilings: [u64; TIER_COUNT],
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let eta = now
        .checked_add(ctx.accounts.governance.timelock_delay)
        .ok_or(RegistryError::MathOverflow)?;

    let p = &mut ctx.accounts.pending;
    p.kind = kind;
    p.new_key = new_key;
    p.tier_bonds = tier_bonds;
    p.tier_ceilings = tier_ceilings;
    p.eta = eta;
    p.queued_at = now;
    p.payer = ctx.accounts.payer.key();
    p.bump = ctx.bumps.pending;

    msg!("Queued {:?}, executable at {}", kind, eta);
    Ok(())
}

/// Hands the entire registry to a new key. The single most dangerous instruction here.
pub fn queue_transfer_authority(
    mut ctx: Context<QueueChange>,
    _kind: ActionKind,
    new_authority: Pubkey,
) -> Result<()> {
    require_keys_neq!(new_authority, Pubkey::default(), RegistryError::Unauthorized);
    queue(
        &mut ctx,
        ActionKind::TransferAuthority,
        new_authority,
        [0; TIER_COUNT],
        [0; TIER_COUNT],
    )
}

/// Names the program permitted to report AUM. A hostile value here is a program that
/// mints ceiling headroom from nothing, letting an unbonded builder take unlimited
/// trader capital — the same shape as the fake collateral that drained Drift.
pub fn queue_set_vault_authority(
    mut ctx: Context<QueueChange>,
    _kind: ActionKind,
    vault_authority: Pubkey,
) -> Result<()> {
    queue(
        &mut ctx,
        ActionKind::SetVaultAuthority,
        vault_authority,
        [0; TIER_COUNT],
        [0; TIER_COUNT],
    )
}

/// Tiers are fixed token counts rather than USD-pegged, so the multisig needs a way to
/// revise them if $AGENT moves materially. It is also the lever that decides how much
/// capital a given bond may stand behind, which is why it waits.
pub fn queue_update_tiers(
    mut ctx: Context<QueueChange>,
    _kind: ActionKind,
    tier_bonds: [u64; TIER_COUNT],
    tier_ceilings: [u64; TIER_COUNT],
) -> Result<()> {
    // Validated here as well as at execution. Failing at queue time is a courtesy —
    // it keeps an obviously bad proposal from sitting on-chain looking legitimate for
    // three days before anyone discovers it cannot execute.
    validate_tier_shape(&tier_bonds, &tier_ceilings)?;
    queue(
        &mut ctx,
        ActionKind::UpdateTiers,
        Pubkey::default(),
        tier_bonds,
        tier_ceilings,
    )
}

fn validate_tier_shape(bonds: &[u64; TIER_COUNT], ceilings: &[u64; TIER_COUNT]) -> Result<()> {
    require!(
        bonds[0] < bonds[1] && bonds[1] < bonds[2],
        RegistryError::TierBondsNotIncreasing
    );
    require!(
        ceilings[0] < ceilings[1] && ceilings[1] < ceilings[2],
        RegistryError::TierCeilingsNotIncreasing
    );
    Ok(())
}

// ───────────────────────────────────────────────────────── execute / veto

#[derive(Accounts)]
#[instruction(kind: ActionKind)]
pub struct ResolveChange<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(seeds = [GOVERNANCE_SEED], bump = governance.bump)]
    pub governance: Account<'info, Governance>,

    #[account(
        mut,
        seeds = [PENDING_SEED, &[kind.seed()]],
        bump = pending.bump,
        constraint = pending.kind == kind @ RegistryError::PendingChangeKindMismatch,
        close = rent_refund,
    )]
    pub pending: Account<'info, PendingChange>,

    /// CHECK: validated against the payer recorded at queue time. Only ever receives
    /// lamports, never read or written as data.
    #[account(mut, constraint = rent_refund.key() == pending.payer @ RegistryError::WrongRentRecipient)]
    pub rent_refund: UncheckedAccount<'info>,

    pub signer: Signer<'info>,
}

impl<'info> ResolveChange<'info> {
    fn assert_authority(&self) -> Result<()> {
        require_keys_eq!(
            self.signer.key(),
            self.config.authority,
            RegistryError::Unauthorized
        );
        Ok(())
    }

    fn assert_guardian_or_authority(&self) -> Result<()> {
        let s = self.signer.key();
        require!(
            s == self.governance.guardian || s == self.config.authority,
            RegistryError::NotGuardianOrAuthority
        );
        Ok(())
    }
}

/// Applies a queued change once its delay has run. Authority only — the guardian's power
/// is strictly negative and it may never execute anything.
pub fn execute_change(ctx: Context<ResolveChange>, _kind: ActionKind) -> Result<()> {
    ctx.accounts.assert_authority()?;

    let now = Clock::get()?.unix_timestamp;
    let pending_eta = ctx.accounts.pending.eta;
    require!(now >= pending_eta, RegistryError::TimelockNotElapsed);

    let kind = ctx.accounts.pending.kind;
    let new_key = ctx.accounts.pending.new_key;
    let bonds = ctx.accounts.pending.tier_bonds;
    let ceilings = ctx.accounts.pending.tier_ceilings;

    let config = &mut ctx.accounts.config;
    match kind {
        ActionKind::TransferAuthority => {
            config.authority = new_key;
            msg!("Authority transferred to {}", new_key);
        }
        ActionKind::SetVaultAuthority => {
            config.vault_authority = new_key;
            msg!("Vault authority set to {}", new_key);
        }
        ActionKind::UpdateTiers => {
            config.tier_bonds = bonds;
            config.tier_ceilings = ceilings;
            // Re-validated against live state: `validate_tiers` also checks the unbond
            // period, which may have moved since this was queued.
            config.validate_tiers()?;
            msg!("Tiers updated");
        }
    }

    Ok(())
}

/// Cancels a pending change. Either the guardian or the authority may.
///
/// A veto simply removes the proposal; it does not blacklist it. An attacker holding the
/// multisig can re-queue immediately, and that is fine — the protection is that the full
/// delay restarts every time, so the guardian only has to stay awake, never win a race.
pub fn veto_change(ctx: Context<ResolveChange>, _kind: ActionKind) -> Result<()> {
    ctx.accounts.assert_guardian_or_authority()?;
    msg!(
        "Vetoed {:?} by {}",
        ctx.accounts.pending.kind,
        ctx.accounts.signer.key()
    );
    Ok(())
}

// ─────────────────────────────────────────────────── guardian emergency stop

#[derive(Accounts)]
pub struct GuardianPauseListing<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        seeds = [GOVERNANCE_SEED],
        bump = governance.bump,
        constraint = governance.guardian == guardian.key() @ RegistryError::NotGuardian,
    )]
    pub governance: Account<'info, Governance>,

    #[account(
        mut,
        seeds = [AGENT_SEED, listing.builder.as_ref(), &listing.index.to_le_bytes()],
        bump = listing.bump,
    )]
    pub listing: Account<'info, AgentListing>,

    pub guardian: Signer<'info>,
}

/// Immediate, no timelock, no second signature. Spec §11.3 item 4: emergency response
/// must always be faster than emergency damage, and waiting out a delay to stop an
/// agent that is actively losing other people's money would be absurd.
///
/// Deliberately one-directional. The guardian can stop an agent but cannot restart one —
/// resuming stays with the builder or the authority through `resume_listing`. An
/// emergency key that could also un-pause would be a key that can put capital back at
/// risk, and this one is only ever allowed to reduce exposure.
///
/// Pausing does not touch trader funds. Positions remain exitable and balances remain
/// withdrawable throughout; stopping new money going in must never strand money already
/// there.
pub fn guardian_pause_listing(ctx: Context<GuardianPauseListing>) -> Result<()> {
    let listing = &mut ctx.accounts.listing;
    require!(
        listing.status == ListingStatus::Live,
        RegistryError::ListingNotLive
    );

    listing.status = ListingStatus::Paused;
    msg!(
        "Listing {} paused by guardian {}",
        listing.index,
        ctx.accounts.guardian.key()
    );
    Ok(())
}
