use crate::constants::*;
use crate::errors::RegistryError;
use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum ListingStatus {
    Vetting,
    Live,
    Paused,
    Delisted,
}

/// Fee and risk configuration applied to a listing at approval time.
/// `None` at the call site means "use the locked launch defaults".
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct FeeConfig {
    pub listing_fee_bps: u16,
    pub performance_fee_bps: u16,
    pub builder_split_bps: u16,
    pub position_cap_bps: u16,
    pub max_drawdown_bps: u16,
    pub auto_pause: bool,
}

impl Default for FeeConfig {
    fn default() -> Self {
        Self {
            listing_fee_bps: DEFAULT_LISTING_FEE_BPS,
            performance_fee_bps: DEFAULT_PERFORMANCE_FEE_BPS,
            builder_split_bps: DEFAULT_BUILDER_SPLIT_BPS,
            position_cap_bps: DEFAULT_POSITION_CAP_BPS,
            max_drawdown_bps: DEFAULT_MAX_DRAWDOWN_BPS,
            auto_pause: true,
        }
    }
}

impl FeeConfig {
    /// Guardrails the multisig itself cannot exceed. Even a compromised or
    /// careless authority cannot set a 100% performance fee.
    pub fn validate(&self) -> Result<()> {
        require!(
            self.listing_fee_bps <= MAX_LISTING_FEE_BPS,
            RegistryError::ListingFeeTooHigh
        );
        require!(
            self.performance_fee_bps <= MAX_PERFORMANCE_FEE_BPS,
            RegistryError::PerformanceFeeTooHigh
        );
        require!(
            self.builder_split_bps >= MIN_BUILDER_SPLIT_BPS,
            RegistryError::BuilderSplitTooLow
        );
        require!(
            self.builder_split_bps <= MAX_BPS
                && self.position_cap_bps <= MAX_BPS
                && self.max_drawdown_bps <= MAX_BPS,
            RegistryError::BpsOutOfRange
        );
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// Squads multisig. Approves listings, slashes bonds, revises tiers.
    pub authority: Pubkey,
    /// $AGENT mint used for bonds.
    pub agent_mint: Pubkey,
    /// PDA of the agent_vault program permitted to report AUM changes.
    /// `Pubkey::default()` until the vault program is deployed.
    pub vault_authority: Pubkey,
    /// Bond required for tier 1/2/3, in $AGENT base units.
    pub tier_bonds: [u64; TIER_COUNT],
    /// Total AUM a builder at tier 1/2/3 may take on, in quote-token base units.
    pub tier_ceilings: [u64; TIER_COUNT],
    pub unbond_period: i64,
    pub bump: u8,
}

impl Config {
    /// Highest tier fully covered by `bond`. Returns 0 when below tier 1.
    pub fn tier_for_bond(&self, bond: u64) -> u8 {
        let mut tier = 0u8;
        for (i, threshold) in self.tier_bonds.iter().enumerate() {
            if bond >= *threshold {
                tier = (i + 1) as u8;
            }
        }
        tier
    }

    /// AUM ceiling unlocked by a tier. Tier 0 may hold no capital.
    pub fn ceiling_for_tier(&self, tier: u8) -> u64 {
        if tier == 0 || tier as usize > TIER_COUNT {
            0
        } else {
            self.tier_ceilings[(tier - 1) as usize]
        }
    }

    pub fn validate_tiers(&self) -> Result<()> {
        require!(
            self.tier_bonds[0] < self.tier_bonds[1] && self.tier_bonds[1] < self.tier_bonds[2],
            RegistryError::TierBondsNotIncreasing
        );
        require!(
            self.tier_ceilings[0] < self.tier_ceilings[1]
                && self.tier_ceilings[1] < self.tier_ceilings[2],
            RegistryError::TierCeilingsNotIncreasing
        );
        require!(self.unbond_period > 0, RegistryError::InvalidUnbondPeriod);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Builder {
    pub authority: Pubkey,
    /// $AGENT currently escrowed in the bond vault.
    pub bond_amount: u64,
    /// Sum of `aum_current` across every listing this builder owns.
    ///
    /// The ceiling is enforced per-*builder*, not per-listing: the bond is the
    /// deterrent, and a builder able to defraud across three agents is exposed
    /// for the total, not for each one separately.
    pub total_aum: u64,
    pub tier: u8,
    /// Unix timestamp of the unbond request, or 0 when none is in flight.
    pub unbond_requested_at: i64,
    pub slash_count: u16,
    /// Monotonic — also used as the seed for each new listing PDA.
    pub agent_count: u16,
    pub created_at: i64,
    pub bump: u8,
}

impl Builder {
    pub fn is_unbonding(&self) -> bool {
        self.unbond_requested_at > 0
    }
}

#[account]
#[derive(InitSpace)]
pub struct AgentListing {
    pub builder: Pubkey,
    /// Signing key held by the builder's bot. Rotatable after compromise.
    pub agent_authority: Pubkey,
    pub status: ListingStatus,
    pub market: u8,
    /// Hash of the off-chain description. Keeps the chain cheap while making
    /// listing content tamper-evident.
    pub metadata_hash: [u8; 32],
    pub listing_fee_bps: u16,
    pub performance_fee_bps: u16,
    pub builder_split_bps: u16,
    pub position_cap_bps: u16,
    pub max_drawdown_bps: u16,
    pub auto_pause: bool,
    pub aum_current: u64,
    pub vault_count: u32,
    pub index: u16,
    pub created_at: i64,
    pub approved_at: i64,
    pub bump: u8,
}

impl AgentListing {
    pub fn apply_fee_config(&mut self, cfg: &FeeConfig) {
        self.listing_fee_bps = cfg.listing_fee_bps;
        self.performance_fee_bps = cfg.performance_fee_bps;
        self.builder_split_bps = cfg.builder_split_bps;
        self.position_cap_bps = cfg.position_cap_bps;
        self.max_drawdown_bps = cfg.max_drawdown_bps;
        self.auto_pause = cfg.auto_pause;
    }
}
