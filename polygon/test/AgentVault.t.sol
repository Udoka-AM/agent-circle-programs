// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import { Test } from "forge-std/Test.sol";
import { AgentVault } from "../src/AgentVault.sol";
import { VenueWhitelist } from "../src/VenueWhitelist.sol";
import { IAgentRegistry } from "../src/interfaces/IAgentRegistry.sol";
import { Errors } from "../src/Errors.sol";
import { MockERC20 } from "./mocks/MockERC20.sol";
import { MockRegistry } from "./mocks/MockRegistry.sol";
import { MockVenueAdapter } from "./mocks/MockVenueAdapter.sol";

contract AgentVaultTest is Test {
    AgentVault vault;
    VenueWhitelist whitelist;
    MockRegistry registry;
    MockERC20 usdc;
    MockVenueAdapter venue;

    address governance = makeAddr("governance");
    address guardian = makeAddr("guardian");
    address treasury = makeAddr("treasury");
    address builder = makeAddr("builder");
    address agent = makeAddr("agent");
    address trader = makeAddr("trader");
    address attacker = makeAddr("attacker");

    bytes32 constant LISTING = bytes32(uint256(1));
    uint64 constant DELAY = 2 days;

    bytes32 id;

    function setUp() public {
        usdc = new MockERC20();
        registry = new MockRegistry();
        whitelist = new VenueWhitelist(governance, guardian, DELAY);
        vault = new AgentVault(address(usdc), address(registry), address(whitelist), treasury);
        venue = new MockVenueAdapter(address(usdc));

        registry.setListing(LISTING, registry.liveListing(builder, agent));
        registry.setHeadroom(LISTING, 1_000_000e6);

        vm.startPrank(governance);
        whitelist.queueAddition(address(venue));
        vm.warp(block.timestamp + DELAY);
        whitelist.executeAddition(address(venue));
        vm.stopPrank();

        usdc.mint(trader, 100_000e6);

        vm.startPrank(trader);
        id = vault.openVault(LISTING, 0, 0);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(id, 10_000e6);
        vm.stopPrank();
    }

    // ─────────────────────────────────────── custody

    function test_onlyTraderCanWithdraw() public {
        vm.prank(agent);
        vm.expectRevert(Errors.NotTrader.selector);
        vault.withdraw(id, 1e6);

        vm.prank(attacker);
        vm.expectRevert(Errors.NotTrader.selector);
        vault.withdraw(id, 1e6);

        vm.prank(trader);
        vault.withdraw(id, 1_000e6);
        assertEq(usdc.balanceOf(trader), 91_000e6);
    }

    function test_agentCannotMoveFundsOut() public {
        // The agent's only lever is executeTrade, and that can only reach a whitelisted
        // adapter. There is no path from agent authority to an arbitrary transfer.
        vm.prank(agent);
        vm.expectRevert(Errors.VenueNotWhitelisted.selector);
        vault.executeTrade(id, attacker, 10_000e6, "");
    }

    function test_onlyAgentAuthorityCanTrade() public {
        bytes memory data = abi.encode(id, 1_000e6, 1_000e6);
        vm.prank(attacker);
        vm.expectRevert(Errors.NotAgentAuthority.selector);
        vault.executeTrade(id, address(venue), 1_000e6, data);
    }

    // ─────────────────────────────────────── limits

    function test_positionCapEnforcedAtomically() public {
        // Cap is 1200bps of 10,000 = 1,200. Deploying 2,000 must revert the whole tx.
        bytes memory data = abi.encode(id, 2_000e6, 2_000e6);
        vm.prank(agent);
        vm.expectRevert(Errors.PositionCapExceeded.selector);
        vault.executeTrade(id, address(venue), 2_000e6, data);

        assertEq(vault.totalValue(id), 10_000e6, "state must be untouched after revert");
    }

    function test_tradeWithinCapSucceeds() public {
        bytes memory data = abi.encode(id, 1_000e6, 1_000e6);
        vm.prank(agent);
        vault.executeTrade(id, address(venue), 1_000e6, data);

        assertEq(vault.totalValue(id), 10_000e6, "value conserved: 9,000 idle + 1,000 position");
    }

    function test_drawdownBreachAutoPauses() public {
        bytes memory data = abi.encode(id, 1_000e6, 1_000e6);
        vm.prank(agent);
        vault.executeTrade(id, address(venue), 1_000e6, data);

        // Position craters, dragging total value more than 1500bps below the mark.
        venue.setPositionValue(id, 0);
        usdc.mint(address(vault), 0);

        vm.prank(agent);
        vault.executeTrade(id, address(venue), 0, abi.encode(id, uint256(0), uint256(0)));

        (,,,,,,, bool autoPause, AgentVault.VaultStatus status,,) = _vault(id);
        assertTrue(autoPause);
        assertEq(uint256(status), uint256(AgentVault.VaultStatus.Paused));

        // Only the trader can bring it back.
        vm.prank(agent);
        vm.expectRevert(Errors.NotTrader.selector);
        vault.resumeVault(id);
    }

    function test_riskOverrideMustBeStricter() public {
        vm.prank(trader);
        vm.expectRevert(Errors.RiskOverrideNotStricter.selector);
        vault.openVault(bytes32(uint256(2)), 5_000, 1_500);
    }

    // ─────────────────────────────────────── ceiling

    function test_depositRejectedAboveAumCeiling() public {
        registry.setHeadroom(LISTING, 500e6);
        vm.prank(trader);
        vm.expectRevert(Errors.AumCeilingExceeded.selector);
        vault.deposit(id, 1_000e6);
    }

    // ─────────────────────────────────────── helper

    function _vault(bytes32 id_)
        internal
        view
        returns (
            address,
            bytes32,
            uint256,
            uint256,
            uint256,
            uint16,
            uint16,
            bool,
            AgentVault.VaultStatus,
            uint64,
            bool
        )
    {
        return vault.vaults(id_);
    }
}
