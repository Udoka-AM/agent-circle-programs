// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import { IAgentRegistry } from "../../src/interfaces/IAgentRegistry.sol";

/// Stand-in for whatever the registry turns out to be on Polygon. Mirrors the launch
/// parameters already locked on the Solana side so the vault is tested against the
/// numbers it will actually run with.
contract MockRegistry is IAgentRegistry {
    mapping(bytes32 => Listing) internal _listings;
    mapping(bytes32 => uint256) internal _headroom;
    mapping(bytes32 => int256) public aumDelta;

    function setListing(bytes32 id, Listing memory l) external {
        _listings[id] = l;
    }

    function setHeadroom(bytes32 id, uint256 amount) external {
        _headroom[id] = amount;
    }

    function getListing(bytes32 id) external view returns (Listing memory) {
        return _listings[id];
    }

    function availableAumHeadroom(bytes32 id) external view returns (uint256) {
        return _headroom[id];
    }

    function notifyAumDelta(bytes32 id, int256 delta) external {
        aumDelta[id] += delta;
    }

    /// Convenience: a Live listing carrying the locked launch parameters.
    function liveListing(address builder, address agent) external pure returns (Listing memory) {
        return Listing({
            builder: builder,
            agentAuthority: agent,
            status: ListingStatus.Live,
            performanceFeeBps: 1_000,
            builderSplitBps: 8_000,
            positionCapBps: 1_200,
            maxDrawdownBps: 1_500
        });
    }
}
