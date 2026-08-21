use anchor_lang::prelude::*;

#[error_code]
pub enum RegistryError {
    #[msg("Only the configured multisig authority may perform this action")]
    Unauthorized,

    #[msg("Tier bonds must be strictly increasing")]
    TierBondsNotIncreasing,
    #[msg("Tier ceilings must be strictly increasing")]
    TierCeilingsNotIncreasing,
    #[msg("Unbonding period must be positive")]
    InvalidUnbondPeriod,

    #[msg("Listing fee exceeds the protocol maximum")]
    ListingFeeTooHigh,
    #[msg("Performance fee exceeds the protocol maximum")]
    PerformanceFeeTooHigh,
    #[msg("Builder split is below the protocol minimum")]
    BuilderSplitTooLow,
    #[msg("Basis-point value exceeds 10000")]
    BpsOutOfRange,

    #[msg("Builder has an unbond request in flight and cannot take on new capital")]
    BuilderUnbonding,
    #[msg("No unbond request is in flight")]
    UnbondNotRequested,
    #[msg("An unbond request is already in flight")]
    UnbondAlreadyRequested,
    #[msg("The 14-day unbonding period has not elapsed")]
    UnbondPeriodNotElapsed,
    #[msg("Withdrawal would leave a tier that cannot cover current assets under management")]
    TierWouldNotCoverAum,
    #[msg("Requested amount exceeds the staked bond")]
    InsufficientBond,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,

    #[msg("Listing is not in the Vetting state")]
    ListingNotVetting,
    #[msg("Listing is not Live")]
    ListingNotLive,
    #[msg("Listing is not Paused")]
    ListingNotPaused,
    #[msg("Listing has been delisted and is terminal")]
    ListingDelisted,
    #[msg("Builder must hold at least tier 1 to list an agent")]
    BondBelowTierOne,
    #[msg("Listing still has assets under management")]
    ListingHasAum,

    #[msg("Only the agent vault program may record AUM changes")]
    NotVaultAuthority,
    #[msg("Vault authority has not been configured")]
    VaultAuthorityUnset,
    #[msg("Assets under management would exceed the builder's tier ceiling")]
    AumCeilingExceeded,

    #[msg("Only the guardian or the multisig authority may perform this action")]
    NotGuardianOrAuthority,
    #[msg("Only the guardian may perform this action")]
    NotGuardian,
    #[msg("Governance has not been initialised; privileged config changes are unavailable")]
    GovernanceUnset,
    #[msg("Timelock delay is outside the permitted range")]
    InvalidTimelockDelay,
    #[msg("The timelock on this change has not elapsed")]
    TimelockNotElapsed,
    #[msg("Pending change does not match the requested action")]
    PendingChangeKindMismatch,
    #[msg("Rent refund must go to the account that paid for the pending change")]
    WrongRentRecipient,

    #[msg("Arithmetic overflow")]
    MathOverflow,
}
