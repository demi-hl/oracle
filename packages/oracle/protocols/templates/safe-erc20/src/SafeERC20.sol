// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/**
 * @title SafeERC20
 * @notice Opinionated fixed-supply ERC20 for Oracle protocol-builder v1.
 *
 * Security posture (templates, NOT a firm audit):
 * - Fixed supply minted once to `initialHolder` in constructor (no hidden mint).
 * - Ownable2Step ownership (no single-tx accidental transfer).
 * - Pausable emergency stop (owner only).
 * - No transfer tax, no blacklist, no max-tx, no trading cooldown.
 * - No upgradeability / no proxy.
 * - Burn optional by holders only (ERC20Burnable).
 *
 * This is a reviewed starter template with Foundry tests. It is NOT a paid
 * security-firm audit. Do not put mainnet TVL on custom forks without one.
 */
contract SafeERC20 is ERC20, ERC20Burnable, ERC20Pausable, Ownable2Step {
    constructor(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address initialHolder,
        address initialOwner
    ) ERC20(name_, symbol_) Ownable(initialOwner) {
        require(initialHolder != address(0), "SafeERC20: holder zero");
        require(initialOwner != address(0), "SafeERC20: owner zero");
        require(initialSupply > 0, "SafeERC20: supply zero");
        _mint(initialHolder, initialSupply);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function _update(address from, address to, uint256 value)
        internal
        override(ERC20, ERC20Pausable)
    {
        super._update(from, to, value);
    }
}
