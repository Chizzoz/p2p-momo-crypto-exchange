// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import "../EmpiyaP2P.sol";

contract ReentrantDepositor {
    EmpiyaP2P public empiya;
    uint256 public key;
    bytes32 public transactionNumber;
    string public revertReason;
    uint256 public payouts;
    uint8 public mode;

    constructor(address empiyaAddress) {
        empiya = EmpiyaP2P(empiyaAddress);
    }

    function deposit() external payable {
        (uint256 transactionKey, UserTransactionType.UserTransaction memory txn) = empiya.deposit{value: msg.value}();
        key = transactionKey;
        transactionNumber = txn.transactionNumber;
    }

    function depositTwice() external payable {
        uint256 half = msg.value / 2;
        empiya.deposit{value: half}();
        empiya.deposit{value: msg.value - half}();
    }

    function attackWithdraw() external {
        mode = 1;
        empiya.withdraw(key, transactionNumber);
    }

    function attackDeposit() external {
        mode = 3;
        empiya.withdraw(key, transactionNumber);
    }

    // Names this contract as the buyer, so an admin release pays it and its receive() tries to withdraw the same deposit.
    function reserveForSelf() external {
        mode = 1;
        empiya.reserve(key, transactionNumber, payable(address(this)));
    }

    function reserveForBuyer(address buyer) external {
        empiya.reserve(key, transactionNumber, payable(buyer));
    }

    function attackRefund() external {
        mode = 7;
        empiya.refundSeller(address(this), key, transactionNumber);
    }

    function acceptAdmin() external {
        empiya.acceptAdmin();
    }

    function withdrawSurplusToSelf() external {
        mode = 5;
        empiya.withdrawSurplus(payable(address(this)));
    }

    receive() external payable {
        payouts += 1;
        if (mode == 0 || payouts > 1) {
            return;
        }
        bytes memory reentry;
        uint256 value;
        if (mode == 1) {
            reentry = abi.encodeCall(EmpiyaP2P.withdraw, (key, transactionNumber));
        } else if (mode == 3) {
            reentry = abi.encodeCall(EmpiyaP2P.deposit, ());
            value = msg.value;
        } else if (mode == 7) {
            reentry = abi.encodeCall(EmpiyaP2P.refundSeller, (address(this), key, transactionNumber));
        } else {
            reentry = abi.encodeCall(EmpiyaP2P.withdrawSurplus, (payable(address(this))));
        }
        (bool ok, bytes memory result) = address(empiya).call{value: value}(reentry);
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
