// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

contract RejectingRecipient {
    receive() external payable {
        revert("Payout rejected.");
    }
}
