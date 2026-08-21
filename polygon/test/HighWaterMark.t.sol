// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { HighWaterMark as HWM } from "../src/libraries/HighWaterMark.sol";

/// The variance-farming scenarios the high-water mark exists to prevent. If any of
/// these regress, a builder can extract fees from a trader who ended up flat or down.
contract HighWaterMarkTest is Test {
    using HWM for HWM.State;

    uint16 constant PERF = 1_000; // 10%
    uint16 constant SPLIT = 8_000; // 80/20

    function _state(uint256 bal, uint256 hwm) internal pure returns (HWM.State memory) {
        return HWM.State({ balance: bal, highWaterMark: hwm });
    }

    function test_noFeeBelowMark() public pure {
        (HWM.State memory s, HWM.FeeSplit memory f) = _state(900e6, 1_000e6).assess(PERF, SPLIT);
        assertEq(f.total, 0);
        assertEq(s.balance, 900e6, "balance must not move when under water");
        assertEq(s.highWaterMark, 1_000e6, "mark must not fall on a loss");
    }

    function test_feeOnProfitOnly() public pure {
        (HWM.State memory s, HWM.FeeSplit memory f) = _state(1_100e6, 1_000e6).assess(PERF, SPLIT);
        assertEq(f.total, 10e6, "10% of 100 profit");
        assertEq(f.builderCut, 8e6);
        assertEq(f.platformCut, 2e6);
        assertEq(s.balance, 1_090e6);
        assertEq(s.highWaterMark, 1_090e6, "mark advances post-fee");
    }

    /// The core property. Up 100, back down 100, up 100 again should be charged once,
    /// not twice.
    function test_varianceCannotBeFarmed() public pure {
        HWM.State memory s = _state(1_000e6, 1_000e6);
        HWM.FeeSplit memory f;

        (s, f) = s.assess(PERF, SPLIT); // flat
        assertEq(f.total, 0);

        s.balance = 1_100e6;
        (s, f) = s.assess(PERF, SPLIT); // up
        uint256 firstFee = f.total;
        assertEq(firstFee, 10e6);

        s.balance = 1_000e6;
        (s, f) = s.assess(PERF, SPLIT); // back down
        assertEq(f.total, 0, "no fee on the way down");

        s.balance = 1_090e6;
        (s, f) = s.assess(PERF, SPLIT); // recover to the post-fee mark
        assertEq(f.total, 0, "recovery to the mark is not new profit");
    }

    function test_depositIsNotProfit() public pure {
        HWM.State memory s = _state(1_000e6, 1_000e6).onDeposit(500e6);
        assertEq(s.balance, 1_500e6);
        assertEq(s.highWaterMark, 1_500e6);

        (, HWM.FeeSplit memory f) = s.assess(PERF, SPLIT);
        assertEq(f.total, 0, "fresh capital must never read as profit");
    }

    function test_withdrawalLowersMark() public pure {
        HWM.State memory s = _state(1_000e6, 1_000e6).onWithdraw(400e6);
        assertEq(s.balance, 600e6);
        assertEq(s.highWaterMark, 600e6, "otherwise recovery is never fee-free");
    }

    /// A vault under water withdrawing everything must not underflow.
    function test_fullWithdrawalUnderWaterClampsMark() public pure {
        HWM.State memory s = _state(800e6, 1_000e6).onWithdraw(800e6);
        assertEq(s.balance, 0);
        assertEq(s.highWaterMark, 0);
    }

    function test_drawdownBps() public pure {
        assertEq(HWM.drawdownBps(_state(850e6, 1_000e6)), 1_500);
        assertEq(HWM.drawdownBps(_state(1_200e6, 1_000e6)), 0);
        assertEq(HWM.drawdownBps(_state(0, 0)), 0);
    }

    /// Cuts must always sum to the total, whatever the rounding.
    function testFuzz_splitIsExact(uint96 balance, uint96 mark) public pure {
        vm.assume(balance > mark);
        (, HWM.FeeSplit memory f) = _state(balance, mark).assess(PERF, SPLIT);
        assertEq(f.builderCut + f.platformCut, f.total);
    }

    function testFuzz_feeNeverExceedsProfit(uint96 balance, uint96 mark) public pure {
        vm.assume(balance > mark);
        (, HWM.FeeSplit memory f) = _state(balance, mark).assess(PERF, SPLIT);
        assertLe(f.total, uint256(balance) - uint256(mark));
    }
}
