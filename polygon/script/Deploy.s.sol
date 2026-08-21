// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { AgentVault } from "../src/AgentVault.sol";
import { VenueWhitelist } from "../src/VenueWhitelist.sol";

/// Amoy testnet deploy. Mainnet is deliberately not wired up here — see README §5;
/// governance must be a Safe multisig before anything touches Polygon mainnet, and a
/// script that makes that easy to skip is a script that will eventually skip it.
contract Deploy is Script {
    // USDC.e on Polygon PoS. Override for Amoy via env.
    address constant POLYGON_USDC = 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174;

    uint64 constant TIMELOCK_DELAY = 2 days;

    function run() external {
        address usdc = vm.envOr("QUOTE_TOKEN", POLYGON_USDC);
        address governance = vm.envAddress("GOVERNANCE");
        address guardian = vm.envAddress("GUARDIAN");
        address treasury = vm.envAddress("TREASURY");
        address registry = vm.envAddress("REGISTRY");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));

        VenueWhitelist whitelist = new VenueWhitelist(governance, guardian, TIMELOCK_DELAY);
        AgentVault vault = new AgentVault(usdc, registry, address(whitelist), treasury);

        vm.stopBroadcast();

        console2.log("VenueWhitelist:", address(whitelist));
        console2.log("AgentVault:    ", address(vault));
        console2.log("");
        console2.log("No venue is whitelisted yet. Queue one, wait out the timelock,");
        console2.log("then execute. Deposits will succeed before that; trades will not.");
    }
}
