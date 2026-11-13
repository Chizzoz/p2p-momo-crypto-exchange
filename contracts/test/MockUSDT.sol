// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

/// @notice Configurable USDT stand-in for Ethereum (6 decimals, no return values, non-zero
/// allowance reset, fee, blacklist, pause) and optional BSC-like (18 decimals, returns bool).
contract MockUSDT {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint8 public immutable decimals;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public isBlackListed;
    bool public paused;
    bool public returnsBool;
    uint256 public basisPointsRate;
    uint256 public maximumFee;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AddedBlackList(address indexed user);
    event RemovedBlackList(address indexed user);
    event Pause();
    event Unpause();

    constructor(uint8 tokenDecimals, bool returnBool) {
        decimals = tokenDecimals;
        returnsBool = returnBool;
    }

    function mint(address to, uint256 amount) external {
        require(!isBlackListed[to], "Blacklisted.");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setParams(uint256 newBasisPoints, uint256 newMaxFee) external {
        basisPointsRate = newBasisPoints;
        maximumFee = newMaxFee;
    }

    function addBlackList(address user) external {
        isBlackListed[user] = true;
        emit AddedBlackList(user);
    }

    function removeBlackList(address user) external {
        isBlackListed[user] = false;
        emit RemovedBlackList(user);
    }

    function pause() external {
        paused = true;
        emit Pause();
    }

    function unpause() external {
        paused = false;
        emit Unpause();
    }

    function approve(address spender, uint256 value) external returns (bool) {
        // Ethereum USDT rejects changing a non-zero allowance directly to another non-zero value.
        if (!returnsBool && allowance[msg.sender][spender] != 0 && value != 0) {
            revert("USDT approve: reset to zero first");
        }
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        if (returnsBool) {
            return true;
        }
        assembly {
            return(0, 0)
        }
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        if (returnsBool) {
            return true;
        }
        assembly {
            return(0, 0)
        }
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= value, "Insufficient allowance.");
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        if (returnsBool) {
            return true;
        }
        assembly {
            return(0, 0)
        }
    }

    function _transfer(address from, address to, uint256 value) private {
        require(!paused, "Paused.");
        require(!isBlackListed[from] && !isBlackListed[to], "Blacklisted.");
        require(to != address(0), "Invalid address input.");

        uint256 fee = (value * basisPointsRate) / 10_000;
        if (fee > maximumFee) {
            fee = maximumFee;
        }
        uint256 sendAmount = value - fee;
        require(balanceOf[from] >= value, "Insufficient balance.");

        balanceOf[from] -= value;
        balanceOf[to] += sendAmount;
        emit Transfer(from, to, sendAmount);

        if (fee != 0) {
            balanceOf[address(this)] += fee;
            emit Transfer(from, address(this), fee);
        }
    }
}
