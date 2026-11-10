// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

contract ReturnDataBomb {
    receive() external payable {
        assembly {
            return(0, 500000)
        }
    }
}
