// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import { Errors } from "./Errors.sol";

/// The set of venue adapters vaults are permitted to call.
///
/// Designed against a real precedent (spec §11). Drift lost $285M in April 2026 when
/// months of social engineering yielded admin control and the attacker whitelisted fake
/// collateral. This contract is structurally the same object: an allowlist whose
/// compromise drains every vault at once. So it carries two defences the Solana version
/// must also grow:
///
///   1. A timelock. Additions are queued publicly and cannot execute for `delay`.
///      A compromised governance key buys the attacker an announcement, not the funds.
///   2. A guardian that can veto a queued addition and can remove instantly, but can
///      never add. Least authority in the direction that matters: the emergency key
///      can only ever shrink the attack surface.
///
/// Removals bypass the timelock deliberately. Waiting out a delay to stop an active
/// exploit is the wrong trade.
contract VenueWhitelist {
    struct Queued {
        uint64 eta;
        bool vetoed;
    }

    address public governance;
    address public guardian;
    uint64 public immutable delay;

    mapping(address venue => bool) public isWhitelisted;
    mapping(address venue => Queued) public queued;

    event AdditionQueued(address indexed venue, uint64 eta);
    event AdditionExecuted(address indexed venue);
    event AdditionVetoed(address indexed venue, address indexed by);
    event VenueRemoved(address indexed venue, address indexed by);
    event GuardianChanged(address indexed previous, address indexed next);

    modifier onlyGovernance() {
        if (msg.sender != governance) revert Errors.NotGovernance();
        _;
    }

    /// Either key may remove. Governance is the normal path; the guardian is the
    /// 3am path.
    modifier onlyGovernanceOrGuardian() {
        if (msg.sender != governance && msg.sender != guardian) revert Errors.NotGuardian();
        _;
    }

    constructor(address governance_, address guardian_, uint64 delay_) {
        if (governance_ == address(0) || guardian_ == address(0)) revert Errors.ZeroAddress();
        governance = governance_;
        guardian = guardian_;
        delay = delay_;
    }

    function queueAddition(address venue) external onlyGovernance {
        if (venue == address(0)) revert Errors.ZeroAddress();
        uint64 eta = uint64(block.timestamp) + delay;
        queued[venue] = Queued({ eta: eta, vetoed: false });
        emit AdditionQueued(venue, eta);
    }

    function executeAddition(address venue) external onlyGovernance {
        Queued memory q = queued[venue];
        if (q.eta == 0) revert Errors.TimelockNotQueued();
        if (q.vetoed) revert Errors.ProposalVetoed();
        if (block.timestamp < q.eta) revert Errors.TimelockNotElapsed();

        delete queued[venue];
        isWhitelisted[venue] = true;
        emit AdditionExecuted(venue);
    }

    function vetoAddition(address venue) external onlyGovernanceOrGuardian {
        if (queued[venue].eta == 0) revert Errors.TimelockNotQueued();
        queued[venue].vetoed = true;
        emit AdditionVetoed(venue, msg.sender);
    }

    /// No timelock. See the contract-level note.
    function removeVenue(address venue) external onlyGovernanceOrGuardian {
        isWhitelisted[venue] = false;
        delete queued[venue];
        emit VenueRemoved(venue, msg.sender);
    }

    /// Guardian rotation is itself governance-only and deliberately immediate: a
    /// suspected-compromised guardian needs replacing faster than a timelock allows.
    function setGuardian(address next) external onlyGovernance {
        if (next == address(0)) revert Errors.ZeroAddress();
        emit GuardianChanged(guardian, next);
        guardian = next;
    }
}
