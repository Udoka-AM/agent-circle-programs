// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { Errors } from "./Errors.sol";
import { HighWaterMark } from "./libraries/HighWaterMark.sol";
import { IAgentRegistry } from "./interfaces/IAgentRegistry.sol";
import { IVenueAdapter } from "./interfaces/IVenueAdapter.sol";
import { VenueWhitelist } from "./VenueWhitelist.sol";

/// Non-custodial vault for agent-directed capital.
///
/// The trader is the sole withdrawal authority. The agent holds scoped permission to
/// trade and nothing else — it can never move funds out, only move them between
/// whitelisted venues, and only within limits this contract enforces in the same
/// transaction as the trade.
///
/// ## Translation note
///
/// On Solana each vault is its own PDA account, seeded `["vault", trader, listing]`.
/// Deploying a contract per trader on Polygon would be needless gas, so this is a
/// singleton holding a mapping keyed by the same tuple. The security properties are
/// identical; the accounting is not, because one contract now custodies many traders'
/// tokens at once. That makes per-vault `idle` bookkeeping load-bearing: the contract's
/// own ERC-20 balance is *not* any single vault's balance, and must never be read as
/// though it were.
contract AgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;
    using HighWaterMark for HighWaterMark.State;

    uint256 internal constant BPS = 10_000;

    enum VaultStatus {
        Active,
        Paused,
        Closing
    }

    struct Vault {
        address trader;
        bytes32 listingId;
        uint256 idle; // quote tokens not currently deployed to a venue
        uint256 principal; // net deposits, for the AUM ceiling
        uint256 highWaterMark;
        uint16 positionCapBps;
        uint16 maxDrawdownBps;
        bool autoPause;
        VaultStatus status;
        uint64 lastFeeAssessment;
        bool exists;
    }

    IERC20 public immutable quoteToken;
    IAgentRegistry public immutable registry;
    VenueWhitelist public immutable whitelist;
    address public immutable platformTreasury;

    /// Minimum gap between fee assessments. The crank is permissionless, so without this
    /// anyone could assess repeatedly and grind a vault down through rounding.
    uint64 public constant FEE_ASSESSMENT_INTERVAL = 7 days;

    mapping(bytes32 vaultId => Vault) public vaults;
    /// Adapters a vault has ever traded through, so total value can be marked to market.
    mapping(bytes32 vaultId => address[]) internal _touchedAdapters;
    mapping(bytes32 vaultId => mapping(address adapter => bool)) internal _hasTouched;

    event VaultOpened(bytes32 indexed vaultId, address indexed trader, bytes32 indexed listingId);
    event Deposited(bytes32 indexed vaultId, uint256 amount);
    event Withdrawn(bytes32 indexed vaultId, uint256 amount);
    event TradeExecuted(bytes32 indexed vaultId, address indexed venue, uint256 spent);
    event FeesAssessed(bytes32 indexed vaultId, uint256 builderCut, uint256 platformCut);
    event StatusChanged(bytes32 indexed vaultId, VaultStatus status);
    event AutoPaused(bytes32 indexed vaultId, uint256 drawdownBps);

    constructor(
        address quoteToken_,
        address registry_,
        address whitelist_,
        address platformTreasury_
    ) {
        if (
            quoteToken_ == address(0) || registry_ == address(0) || whitelist_ == address(0)
                || platformTreasury_ == address(0)
        ) revert Errors.ZeroAddress();

        quoteToken = IERC20(quoteToken_);
        registry = IAgentRegistry(registry_);
        whitelist = VenueWhitelist(whitelist_);
        platformTreasury = platformTreasury_;
    }

    // ─────────────────────────────────────────────────────────── identity

    function vaultId(address trader, bytes32 listingId) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(trader, listingId));
    }

    modifier onlyTrader(bytes32 id) {
        if (vaults[id].trader != msg.sender) revert Errors.NotTrader();
        _;
    }

    // ─────────────────────────────────────────────────────────── lifecycle

    /// Risk overrides may only ever be *stricter* than the listing's own limits. A
    /// trader tightening their exposure is their business; a trader loosening it past
    /// what the listing was vetted at would silently void the guarantee the leaderboard
    /// makes to everyone else.
    function openVault(bytes32 listingId, uint16 positionCapBps_, uint16 maxDrawdownBps_)
        external
        returns (bytes32 id)
    {
        id = vaultId(msg.sender, listingId);
        if (vaults[id].exists) revert Errors.VaultAlreadyExists();

        IAgentRegistry.Listing memory listing = registry.getListing(listingId);
        if (listing.status != IAgentRegistry.ListingStatus.Live) revert Errors.ListingNotLive();

        uint16 cap = positionCapBps_ == 0 ? listing.positionCapBps : positionCapBps_;
        uint16 dd = maxDrawdownBps_ == 0 ? listing.maxDrawdownBps : maxDrawdownBps_;
        if (cap > listing.positionCapBps || dd > listing.maxDrawdownBps) {
            revert Errors.RiskOverrideNotStricter();
        }

        vaults[id] = Vault({
            trader: msg.sender,
            listingId: listingId,
            idle: 0,
            principal: 0,
            highWaterMark: 0,
            positionCapBps: cap,
            maxDrawdownBps: dd,
            autoPause: true,
            status: VaultStatus.Active,
            lastFeeAssessment: uint64(block.timestamp),
            exists: true
        });

        emit VaultOpened(id, msg.sender, listingId);
    }

    function deposit(bytes32 id, uint256 amount) external nonReentrant onlyTrader(id) {
        if (amount == 0) revert Errors.ZeroAmount();
        Vault storage v = vaults[id];
        if (v.status != VaultStatus.Active) revert Errors.VaultNotActive();

        if (amount > registry.availableAumHeadroom(v.listingId)) {
            revert Errors.AumCeilingExceeded();
        }

        quoteToken.safeTransferFrom(msg.sender, address(this), amount);

        HighWaterMark.State memory s =
            HighWaterMark.State({ balance: v.idle, highWaterMark: v.highWaterMark });
        s = s.onDeposit(amount);

        v.idle = s.balance;
        v.highWaterMark = s.highWaterMark;
        v.principal += amount;

        registry.notifyAumDelta(v.listingId, int256(amount));
        emit Deposited(id, amount);
    }

    /// Trader only. Assesses fees first — withdrawing ahead of assessment would let a
    /// trader exit a profitable position without paying the fee that profit earned.
    function withdraw(bytes32 id, uint256 amount) external nonReentrant onlyTrader(id) {
        if (amount == 0) revert Errors.ZeroAmount();
        _assessFees(id);

        Vault storage v = vaults[id];
        if (amount > v.idle) revert Errors.InsufficientBalance();

        HighWaterMark.State memory s =
            HighWaterMark.State({ balance: v.idle, highWaterMark: v.highWaterMark });
        s = s.onWithdraw(amount);

        v.idle = s.balance;
        v.highWaterMark = s.highWaterMark;
        v.principal = amount >= v.principal ? 0 : v.principal - amount;

        registry.notifyAumDelta(v.listingId, -int256(amount));
        quoteToken.safeTransfer(v.trader, amount);
        emit Withdrawn(id, amount);
    }

    function pauseVault(bytes32 id) external onlyTrader(id) {
        vaults[id].status = VaultStatus.Paused;
        emit StatusChanged(id, VaultStatus.Paused);
    }

    function resumeVault(bytes32 id) external onlyTrader(id) {
        vaults[id].status = VaultStatus.Active;
        emit StatusChanged(id, VaultStatus.Active);
    }

    // ─────────────────────────────────────────────────────────── trading

    /// The whole design rests on this function. All six checks from spec §4.4 hold in
    /// the same transaction as the trade, so a limit cannot be exceeded even briefly.
    ///
    /// Checks 5 and 6 are enforced as *post-conditions*: rather than predicting what a
    /// venue call will do, the vault performs it and then asserts the resulting state is
    /// legal, reverting the whole transaction if not. Prediction is fragile against
    /// venues we do not control; assertion is not.
    ///
    /// `maxSpend` bounds the allowance granted to the adapter, so a compromised or buggy
    /// adapter cannot drain more than the agent explicitly authorised for this call.
    function executeTrade(bytes32 id, address venue, uint256 maxSpend, bytes calldata data)
        external
        nonReentrant
        returns (bytes memory result)
    {
        Vault storage v = vaults[id];
        if (!v.exists) revert Errors.VaultNotFound();
        if (v.status != VaultStatus.Active) revert Errors.VaultNotActive();

        IAgentRegistry.Listing memory listing = registry.getListing(v.listingId);
        if (listing.status != IAgentRegistry.ListingStatus.Live) revert Errors.ListingNotLive();
        if (msg.sender != listing.agentAuthority) revert Errors.NotAgentAuthority();
        if (!whitelist.isWhitelisted(venue)) revert Errors.VenueNotWhitelisted();
        if (maxSpend > v.idle) revert Errors.InsufficientBalance();

        uint256 valueBefore = _totalValue(id);

        uint256 heldBefore = quoteToken.balanceOf(address(this));
        quoteToken.forceApprove(venue, maxSpend);
        result = IVenueAdapter(venue).execute(address(this), data);
        quoteToken.forceApprove(venue, 0);
        uint256 heldAfter = quoteToken.balanceOf(address(this));

        _touch(id, venue);

        // Attribute the actual token movement to this vault. A venue that returned
        // tokens (closing a position) increases idle instead of decreasing it.
        if (heldBefore >= heldAfter) {
            v.idle -= (heldBefore - heldAfter);
        } else {
            v.idle += (heldAfter - heldBefore);
        }

        // ── post-conditions
        uint256 valueAfter = _totalValue(id);
        uint256 positionValue = valueAfter - v.idle;

        if ((positionValue * BPS) > (valueAfter * v.positionCapBps)) {
            revert Errors.PositionCapExceeded();
        }

        uint256 dd = HighWaterMark.drawdownBps(
            HighWaterMark.State({ balance: valueAfter, highWaterMark: v.highWaterMark })
        );
        if (dd >= v.maxDrawdownBps) {
            if (v.autoPause) {
                v.status = VaultStatus.Paused;
                emit AutoPaused(id, dd);
            } else {
                revert Errors.DrawdownLimitBreached();
            }
        }

        emit TradeExecuted(id, venue, valueBefore > valueAfter ? valueBefore - valueAfter : 0);
    }

    // ─────────────────────────────────────────────────────────── fees

    /// Permissionless crank, rate-limited by `FEE_ASSESSMENT_INTERVAL`.
    function assessFees(bytes32 id) external nonReentrant {
        Vault storage v = vaults[id];
        if (block.timestamp < v.lastFeeAssessment + FEE_ASSESSMENT_INTERVAL) {
            revert Errors.FeeAssessmentTooSoon();
        }
        _assessFees(id);
    }

    function _assessFees(bytes32 id) internal {
        Vault storage v = vaults[id];
        if (!v.exists) revert Errors.VaultNotFound();

        IAgentRegistry.Listing memory listing = registry.getListing(v.listingId);

        // Fees are charged against total value, but can only be *paid* from idle
        // tokens — capital sitting in an open position is not ours to move.
        HighWaterMark.State memory s =
            HighWaterMark.State({ balance: _totalValue(id), highWaterMark: v.highWaterMark });

        HighWaterMark.FeeSplit memory split;
        (s, split) = s.assess(listing.performanceFeeBps, listing.builderSplitBps);

        v.highWaterMark = s.highWaterMark;
        v.lastFeeAssessment = uint64(block.timestamp);

        if (split.total == 0) return;
        if (split.total > v.idle) revert Errors.InsufficientBalance();

        v.idle -= split.total;
        // TODO(streamflow-equivalent): the Solana design streams the builder's cut via
        // Streamflow rather than paying it lump-sum. Sablier is the closest Polygon
        // analogue. Paying directly until that is decided.
        quoteToken.safeTransfer(listing.builder, split.builderCut);
        quoteToken.safeTransfer(platformTreasury, split.platformCut);

        emit FeesAssessed(id, split.builderCut, split.platformCut);
    }

    // ─────────────────────────────────────────────────────────── views

    /// Idle tokens plus mark-to-market value of every position the vault holds.
    function totalValue(bytes32 id) external view returns (uint256) {
        return _totalValue(id);
    }

    function _totalValue(bytes32 id) internal view returns (uint256 total) {
        total = vaults[id].idle;
        address[] storage adapters = _touchedAdapters[id];
        for (uint256 i; i < adapters.length; ++i) {
            total += IVenueAdapter(adapters[i]).positionValue(address(this), id);
        }
    }

    function _touch(bytes32 id, address adapter) internal {
        if (_hasTouched[id][adapter]) return;
        _hasTouched[id][adapter] = true;
        _touchedAdapters[id].push(adapter);
    }
}
