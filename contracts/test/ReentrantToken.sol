// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

interface IEmpiyaP2P {
    function deposit(uint256 amount) external returns (uint256, bytes memory);
    function withdraw(uint256 transactionKey, bytes32 transactionNumber) external returns (uint256, bytes memory);
    function releaseToBuyer(
        address depositor,
        uint256 transactionKey,
        bytes32 transactionNumber,
        address buyer,
        uint256 reservationId
    ) external returns (uint256, bytes memory);
    function refundSeller(
        address depositor,
        uint256 transactionKey,
        bytes32 transactionNumber,
        uint256 reservationId
    ) external returns (uint256, bytes memory);
    function withdrawSurplus(address to) external;
}

interface IEmpiyaPayments {
    function pay(bytes32 paymentId, uint256 amount) external;
    function settle(bytes32 paymentId) external;
    function refund(bytes32 paymentId) external;
    function claimBack(bytes32 paymentId) external;
}

/// @notice Calls back into EmpiyaP2P or EmpiyaPayments during a transfer to exercise the reentrancy guards.
contract ReentrantToken {
    string public name = "Reentrant Token";
    string public symbol = "RNT";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public target;
    bytes public reentryCalldata;
    string public revertReason;
    uint256 public callbacks;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setReentry(address targetAddress, bytes calldata data) external {
        target = targetAddress;
        reentryCalldata = data;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "Insufficient allowance.");
        allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) private {
        require(balanceOf[from] >= value, "Insufficient balance.");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);

        if (target != address(0) && reentryCalldata.length != 0 && callbacks == 0) {
            callbacks += 1;
            (bool ok, bytes memory result) = target.call(reentryCalldata);
            if (!ok) {
                if (result.length >= 4 && bytes4(result) == bytes4(keccak256("Error(string)"))) {
                    revertReason = this.decodeReason(result);
                } else {
                    revertReason = "Non-string revert.";
                }
            }
        }
    }

    function decodeReason(bytes calldata result) external pure returns (string memory) {
        return abi.decode(result[4:], (string));
    }
}
