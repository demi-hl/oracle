// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SafeERC20} from "../src/SafeERC20.sol";

contract SafeERC20Test is Test {
    SafeERC20 internal token;
    address internal owner = makeAddr("owner");
    address internal holder = makeAddr("holder");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant SUPPLY = 1_000_000 ether;

    function setUp() public {
        token = new SafeERC20("Safe", "SAFE", SUPPLY, holder, owner);
    }

    function test_fixedSupply_noHiddenMint() public view {
        assertEq(token.totalSupply(), SUPPLY);
        assertEq(token.balanceOf(holder), SUPPLY);
        assertEq(token.balanceOf(owner), 0);
    }

    function test_transfer_noTax() public {
        vm.prank(holder);
        token.transfer(alice, 100 ether);
        assertEq(token.balanceOf(alice), 100 ether);
        assertEq(token.balanceOf(holder), SUPPLY - 100 ether);
    }

    function test_pause_blocksTransfers() public {
        vm.prank(owner);
        token.pause();
        vm.prank(holder);
        vm.expectRevert();
        token.transfer(alice, 1 ether);
    }

    function test_onlyOwner_canPause() public {
        vm.prank(alice);
        vm.expectRevert();
        token.pause();
    }

    function test_ownable2Step_requiresAccept() public {
        vm.prank(owner);
        token.transferOwnership(alice);
        // still owner until accept
        assertEq(token.owner(), owner);
        vm.prank(alice);
        token.acceptOwnership();
        assertEq(token.owner(), alice);
    }

    function test_burn_reducesSupply() public {
        vm.prank(holder);
        token.burn(10 ether);
        assertEq(token.totalSupply(), SUPPLY - 10 ether);
    }

    function test_rejectZeroHolder() public {
        vm.expectRevert(bytes("SafeERC20: holder zero"));
        new SafeERC20("X", "X", SUPPLY, address(0), owner);
    }

    function test_rejectZeroSupply() public {
        vm.expectRevert(bytes("SafeERC20: supply zero"));
        new SafeERC20("X", "X", 0, holder, owner);
    }
}
