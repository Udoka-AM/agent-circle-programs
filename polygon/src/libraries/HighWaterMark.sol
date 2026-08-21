// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

/// High-water-mark fee accounting.
///
/// This is the correctness-critical part of the whole system (spec §4.3). Fees accrue
/// only on profit above a vault's all-time-high balance. Without that, a volatile agent
/// earns on every up-swing and returns nothing on down-swings, letting a builder farm
/// variance and extract fees from a trader who ended up flat or down.
///
/// Deliberately a pure library over a plain struct: no storage, no external calls, no
/// access control. That makes every rule here unit-testable in isolation, which is the
/// point — this is the logic most worth proving and least worth trusting to review.
library HighWaterMark {
    uint256 internal constant BPS = 10_000;

    struct State {
        uint256 balance;
        uint256 highWaterMark;
    }

    struct FeeSplit {
        uint256 total;
        uint256 builderCut;
        uint256 platformCut;
    }

    /// Assess the performance fee and advance the mark.
    ///
    /// Returns a zeroed split when the vault is at or below its previous high, which is
    /// the common case and must stay cheap.
    function assess(
        State memory s,
        uint16 performanceFeeBps,
        uint16 builderSplitBps
    ) internal pure returns (State memory, FeeSplit memory split) {
        if (s.balance <= s.highWaterMark) {
            return (s, split);
        }

        uint256 profit = s.balance - s.highWaterMark;
        split.total = (profit * performanceFeeBps) / BPS;
        split.builderCut = (split.total * builderSplitBps) / BPS;
        // Derived by subtraction, never by a second multiplication, so the two cuts
        // always sum to exactly `total` regardless of rounding.
        split.platformCut = split.total - split.builderCut;

        s.balance -= split.total;
        // Post-fee, so the same profit is never charged twice.
        s.highWaterMark = s.balance;

        return (s, split);
    }

    /// Fresh capital must raise the mark, otherwise a deposit instantly reads as profit
    /// and the trader is charged a fee on their own money.
    function onDeposit(State memory s, uint256 amount) internal pure returns (State memory) {
        s.balance += amount;
        s.highWaterMark += amount;
        return s;
    }

    /// Withdrawal lowers the mark by the same amount, otherwise the trader can never
    /// earn a fee-free recovery on the capital they left in.
    ///
    /// Call *after* `assess`, never before: withdrawing first would let a trader exit a
    /// profitable position without paying the fee that profit earned.
    function onWithdraw(State memory s, uint256 amount) internal pure returns (State memory) {
        s.balance -= amount;
        // A vault sitting below its mark after losses can have `highWaterMark > balance`,
        // so a full withdrawal would underflow. Clamping leaves the mark at zero, which
        // is correct: there is no capital left for a loss-carryforward to apply to.
        s.highWaterMark = amount >= s.highWaterMark ? 0 : s.highWaterMark - amount;
        return s;
    }

    /// Current drawdown from the mark, in basis points. Zero when at or above the mark.
    function drawdownBps(State memory s) internal pure returns (uint256) {
        if (s.highWaterMark == 0 || s.balance >= s.highWaterMark) return 0;
        return ((s.highWaterMark - s.balance) * BPS) / s.highWaterMark;
    }
}
