// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

contract FakeEscrow {
    address private immutable arbitrator;

    constructor(address arbitratorAddress) {
        arbitrator = arbitratorAddress;
    }

    function getArbitrator() external view returns (address) {
        return arbitrator;
    }
}
