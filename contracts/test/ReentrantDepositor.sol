// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EmpiyaP2P, UserTransactionType} from "../EmpiyaP2P.sol";

contract ReentrantDepositor {
    EmpiyaP2P public empiya;
    IERC20 public token;
    uint256 public key;
    bytes32 public transactionNumber;
    uint256 public reservationId;
    string public revertReason;
    uint256 public callbacks;
    uint8 public mode;

    constructor(address empiyaAddress, address tokenAddress) {
        empiya = EmpiyaP2P(empiyaAddress);
        token = IERC20(tokenAddress);
    }

    function approveAndDeposit(uint256 amount) external {
        token.approve(address(empiya), amount);
        (uint256 transactionKey, UserTransactionType.UserTransaction memory txn) = empiya.deposit(amount);
        key = transactionKey;
        transactionNumber = txn.transactionNumber;
    }

    function depositTwice(uint256 amount) external {
        uint256 half = amount / 2;
        token.approve(address(empiya), amount);
        empiya.deposit(half);
        empiya.deposit(amount - half);
    }

    function attackWithdraw() external {
        mode = 1;
        empiya.withdraw(key, transactionNumber);
    }

    function attackDeposit() external {
        mode = 3;
        empiya.withdraw(key, transactionNumber);
    }

    function reserveForSelf() external {
        mode = 1;
        (, UserTransactionType.UserTransaction memory txn) = empiya.reserve(key, transactionNumber, address(this));
        reservationId = txn.reservationId;
    }

    function reserveForBuyer(address buyer) external {
        (, UserTransactionType.UserTransaction memory txn) = empiya.reserve(key, transactionNumber, buyer);
        reservationId = txn.reservationId;
    }

    function attackRefund() external {
        mode = 7;
        empiya.refundSeller(address(this), key, transactionNumber, reservationId);
    }

    function acceptAdmin() external {
        empiya.acceptAdmin();
    }

    function withdrawSurplusToSelf() external {
        mode = 5;
        empiya.withdrawSurplus(address(this));
    }

    // Tokens arrive via ERC-20 transfer, so reentry is arranged through ReentrantToken instead.
    // This contract still covers EmpiyaP2P reentry when it receives a payout through a token callback
    // by exposing a hook the ReentrantToken can call.
    function onTokenTransfer() external {
        callbacks += 1;
        if (mode == 0 || callbacks > 1) {
            return;
        }
        bytes memory reentry;
        if (mode == 1) {
            reentry = abi.encodeCall(EmpiyaP2P.withdraw, (key, transactionNumber));
        } else if (mode == 3) {
            reentry = abi.encodeCall(EmpiyaP2P.deposit, (1));
        } else if (mode == 7) {
            reentry = abi.encodeCall(EmpiyaP2P.refundSeller, (address(this), key, transactionNumber, reservationId));
        } else {
            reentry = abi.encodeCall(EmpiyaP2P.withdrawSurplus, (address(this)));
        }
        (bool ok, bytes memory result) = address(empiya).call(reentry);
        if (ok) {
            return;
        }
        if (result.length >= 4 && bytes4(result) == bytes4(keccak256("Error(string)"))) {
            revertReason = this.decodeReason(result);
        } else {
            revertReason = "Non-string revert.";
        }
    }

    function decodeReason(bytes calldata result) external pure returns (string memory) {
        return abi.decode(result[4:], (string));
    }
}
