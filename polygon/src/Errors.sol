// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

/// Shared revert reasons. Named to mirror the Anchor `#[error_code]` variants on the
/// Solana side so a failure means the same thing on either chain.
library Errors {
    // ── authority
    error NotTrader();
    error NotAgentAuthority();
    error NotGovernance();
    error NotGuardian();

    // ── lifecycle
    error VaultNotActive();
    error VaultAlreadyExists();
    error VaultNotFound();
    error ListingNotLive();

    // ── limits
    error AumCeilingExceeded();
    error PositionCapExceeded();
    error DrawdownLimitBreached();
    error RiskOverrideNotStricter();
    error InsufficientBalance();

    // ── venue
    error VenueNotWhitelisted();
    error VenueCallFailed();
    error VaultValueDecreasedUnexpectedly();

    // ── fees
    error FeeAssessmentTooSoon();

    // ── governance
    error TimelockNotElapsed();
    error TimelockNotQueued();
    error ProposalVetoed();

    // ── misc
    error ZeroAmount();
    error ZeroAddress();
}
