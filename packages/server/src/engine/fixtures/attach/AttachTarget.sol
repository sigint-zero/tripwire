// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// The application's attach-mode target: a watchable value and its own
/// pause switch, so a rule can trip and stage a `call` response.
contract AttachTarget {
    uint256 public value;
    bool public paused;

    function set(uint256 v) external {
        value = v;
    }

    function pause() external {
        paused = true;
    }
}
