// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

/// One adapter per prediction-market venue.
///
/// The Solana design passes raw instruction data straight through to a whitelisted
/// program. That does not translate cleanly to Polymarket, whose CTF Exchange settles
/// signed orders matched off-chain rather than exposing a synchronous "open this
/// position" call. See `polygon/README.md` §3 — this is the single largest unresolved
/// question on the Polygon route, and the adapter boundary is where it gets resolved.
///
/// The vault depends only on this interface, so the answer changes one file.
interface IVenueAdapter {
    /// Execute a trade on behalf of `vault`. Implementations pull quote tokens from the
    /// vault via `transferFrom` and must leave no residual allowance.
    ///
    /// MUST be atomic: either the position is open when this returns, or it reverts.
    /// An adapter that merely *queues* an order cannot satisfy the vault's risk
    /// guarantees and must not be whitelisted.
    function execute(address vault, bytes calldata data) external returns (bytes memory result);

    /// Total value of all positions this adapter holds for `vault`, in quote-token units.
    /// Used for the position cap and drawdown checks, so it must be a mark-to-market
    /// figure, not cost basis.
    function positionValue(address vault, bytes32 vaultId) external view returns (uint256);

    /// The ERC-20 the adapter settles in. Must match the vault's quote token.
    function quoteToken() external view returns (address);
}
