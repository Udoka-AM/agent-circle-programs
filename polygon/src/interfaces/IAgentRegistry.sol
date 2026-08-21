// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

/// The vault's view of the registry.
///
/// On Solana this is a CPI into `agent_registry`, which is already deployed and is the
/// source of truth for listings, builder bonds and AUM ceilings. On Polygon the registry
/// does not exist yet, and *where it should live is an open architectural decision* —
/// see `polygon/README.md` §2. This interface exists so the vault can be written and
/// tested now without that decision being made, and so whichever answer wins is a swap
/// of the implementation rather than a rewrite of the vault.
///
/// Every method here is a read. The vault never mutates registry state except through
/// `notifyAumDelta`, which exists because the AUM ceiling is enforced per-*builder*
/// across all their listings and therefore cannot be tracked inside a single vault.
interface IAgentRegistry {
    enum ListingStatus {
        Draft,
        Vetting,
        Live,
        Suspended,
        Delisted
    }

    struct Listing {
        address builder;
        address agentAuthority;
        ListingStatus status;
        uint16 performanceFeeBps;
        uint16 builderSplitBps;
        uint16 positionCapBps;
        uint16 maxDrawdownBps;
    }

    function getListing(bytes32 listingId) external view returns (Listing memory);

    /// Remaining headroom under the builder's tier ceiling, in quote-token units.
    /// The vault rejects a deposit that would exceed this.
    function availableAumHeadroom(bytes32 listingId) external view returns (uint256);

    /// Called by the vault on deposit (positive) and withdrawal (negative) so the
    /// registry can maintain `builder.totalAum`. Reverts if the caller is not a
    /// registered vault.
    function notifyAumDelta(bytes32 listingId, int256 delta) external;
}
