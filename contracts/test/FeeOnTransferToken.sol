// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Always takes a 1% fee so EmpiyaP2P's exact-receipt check must reject it.
contract FeeOnTransferToken {
    string public name = "Fee Token";
    string public symbol = "FEE";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
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
        uint256 fee = value / 100;
        uint256 sendAmount = value - fee;
        require(balanceOf[from] >= value, "Insufficient balance.");
        balanceOf[from] -= value;
        balanceOf[to] += sendAmount;
        balanceOf[address(this)] += fee;
        emit Transfer(from, to, sendAmount);
        if (fee != 0) {
            emit Transfer(from, address(this), fee);
        }
    }
}
