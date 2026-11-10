// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {EmpiyaP2P, Escrow, UserTransactionType} from "../contracts/EmpiyaP2P.sol";

contract EscrowHandler is CommonBase, StdUtils {
    uint256 public constant TIMEOUT = 1 hours;
    uint256 public constant MAX_DEPOSIT = 1_000 ether;
    uint256 public constant MAX_OUTSTANDING = 5_000 ether;

    struct TrackedDeposit {
        address depositor;
        uint256 key;
        bytes32 transactionNumber;
        uint256 amount;
        address buyer;
        uint256 reservedAt;
    }

    EmpiyaP2P public empiya;
    Escrow public escrow;
    address[] public actors;
    TrackedDeposit[] public tracked;
    uint256 public ghostOutstanding;
    // Set when a call that must succeed reverts, or a payout lands on the wrong balance.
    string public failure;

    constructor() {
        empiya = new EmpiyaP2P(TIMEOUT, MAX_DEPOSIT, MAX_OUTSTANDING);
        escrow = Escrow(payable(empiya.getEscrowAddress()));
        for (uint160 i = 1; i <= 3; i++) {
            actors.push(address(0x1000 + i));
        }
    }

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1, MAX_DEPOSIT);
        vm.deal(actor, amount);
        bool allowed = !empiya.paused() && escrow.outstanding() + amount <= MAX_OUTSTANDING;
        vm.prank(actor);
        try empiya.deposit{value: amount}() returns (uint256 key, UserTransactionType.UserTransaction memory txn) {
            if (!allowed) {
                failure = "deposit accepted while paused or over the total limit";
            }
            tracked.push(TrackedDeposit(actor, key, txn.transactionNumber, amount, address(0), 0));
            ghostOutstanding += amount;
        } catch {
            if (allowed) {
                failure = "deposit reverted within the limits";
            }
        }
    }

    function withdraw(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, false);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        uint256 before = d.depositor.balance;
        vm.prank(d.depositor);
        try empiya.withdraw(d.key, d.transactionNumber) {
            if (d.depositor.balance != before + d.amount) failure = "withdraw paid the wrong amount";
            settle(index);
        } catch {
            failure = "withdraw of an open deposit reverted";
        }
    }

    function reserve(uint256 seed, uint256 buyerSeed) external {
        (bool found, uint256 index) = pick(seed, false);
        if (!found) return;
        TrackedDeposit storage d = tracked[index];
        address buyer = actors[buyerSeed % actors.length];
        bool allowed = !empiya.paused();
        vm.prank(d.depositor);
        try empiya.reserve(d.key, d.transactionNumber, payable(buyer)) {
            if (!allowed) failure = "reserve accepted while paused";
            d.buyer = buyer;
            d.reservedAt = block.timestamp;
        } catch {
            if (allowed) failure = "reserve of an open deposit reverted";
        }
    }

    // Runs at any time after the reservation, including long after the window has ended.
    function adminRelease(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        uint256 before = d.buyer.balance;
        try empiya.releaseToBuyer(d.depositor, d.key, d.transactionNumber, d.buyer) {
            if (d.buyer.balance != before + d.amount) failure = "release paid the wrong buyer";
            settle(index);
        } catch {
            failure = "release of a Processing deposit reverted";
        }
    }

    function adminReleaseToWrongBuyer(uint256 seed, uint256 buyerSeed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        address wrongBuyer = actors[buyerSeed % actors.length];
        if (wrongBuyer == d.buyer) return;
        try empiya.releaseToBuyer(d.depositor, d.key, d.transactionNumber, wrongBuyer) {
            failure = "release accepted a buyer the seller did not name";
        } catch {}
    }

    function adminRefund(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        uint256 before = d.depositor.balance;
        try empiya.refundSeller(d.depositor, d.key, d.transactionNumber) {
            if (d.depositor.balance != before + d.amount) failure = "refund paid the wrong amount";
            settle(index);
        } catch {
            failure = "refund of a Processing deposit reverted";
        }
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1, 2 * TIMEOUT));
    }

    // The seller gets the deposit back only once the window has ended.
    function sellerReclaim(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        bool expired = block.timestamp >= d.reservedAt + TIMEOUT;
        uint256 before = d.depositor.balance;
        vm.prank(d.depositor);
        try empiya.withdraw(d.key, d.transactionNumber) {
            if (!expired) failure = "seller withdrew inside the reservation window";
            if (d.depositor.balance != before + d.amount) failure = "reclaim paid the wrong amount";
            settle(index);
        } catch {
            if (expired) failure = "seller could not reclaim after the window";
        }
    }

    function sellerReserveAgain(uint256 seed, uint256 buyerSeed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit storage d = tracked[index];
        address buyer = actors[buyerSeed % actors.length];
        bool allowed = !empiya.paused() && block.timestamp >= d.reservedAt + TIMEOUT;
        vm.prank(d.depositor);
        try empiya.reserve(d.key, d.transactionNumber, payable(buyer)) {
            if (!allowed) failure = "seller replaced the buyer while paused or inside the window";
            d.buyer = buyer;
            d.reservedAt = block.timestamp;
        } catch {
            if (allowed) failure = "seller could not reserve again after the window";
        }
    }

    function expireReservation(uint256 seed, bool asAdmin) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit storage d = tracked[index];
        bool expired = block.timestamp >= d.reservedAt + TIMEOUT;
        if (!asAdmin) vm.prank(d.depositor);
        try empiya.expireReservation(d.depositor, d.key, d.transactionNumber) {
            if (!expired) failure = "reservation expired inside the window";
            d.buyer = address(0);
            d.reservedAt = 0;
        } catch {
            if (expired) failure = "expiry reverted after the window";
        }
    }

    function expireReservationAsStranger(uint256 seed, uint256 strangerSeed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        address stranger = actors[strangerSeed % actors.length];
        if (stranger == d.depositor) return;
        vm.prank(stranger);
        try empiya.expireReservation(d.depositor, d.key, d.transactionNumber) {
            failure = "a stranger expired a reservation";
        } catch {}
    }

    function togglePause() external {
        if (empiya.paused()) {
            empiya.unpause();
        } else {
            empiya.pause();
        }
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 1, 10 ether);
        vm.deal(address(this), amount);
        (bool sent,) = address(escrow).call{value: amount}("");
        require(sent, "donation failed");
    }

    function forceCoin(uint256 amount) external {
        amount = bound(amount, 1, 10 ether);
        vm.deal(address(escrow), address(escrow).balance + amount);
    }

    function withdrawSurplus() external {
        if (address(escrow).balance == escrow.outstanding()) return;
        empiya.withdrawSurplus(payable(address(0xBEEF)));
    }

    function pick(uint256 seed, bool reserved) private view returns (bool, uint256) {
        uint256 count = tracked.length;
        for (uint256 i = 0; i < count; i++) {
            uint256 index = (seed + i) % count;
            if ((tracked[index].buyer != address(0)) == reserved) {
                return (true, index);
            }
        }
        return (false, 0);
    }

    function settle(uint256 index) private {
        ghostOutstanding -= tracked[index].amount;
        tracked[index] = tracked[tracked.length - 1];
        tracked.pop();
    }
}

contract EmpiyaP2PInvariantTest is Test {
    EscrowHandler handler;

    function setUp() public {
        handler = new EscrowHandler();
        targetContract(address(handler));
    }

    function invariant_escrowHoldsAtLeastWhatIsOwed() public view {
        Escrow escrow = handler.escrow();
        assertGe(address(escrow).balance, escrow.outstanding());
    }

    function invariant_outstandingEqualsUnsettledDeposits() public view {
        assertEq(handler.escrow().outstanding(), handler.ghostOutstanding());
    }

    function invariant_outstandingStaysWithinTheTotalLimit() public view {
        assertLe(handler.escrow().outstanding(), handler.MAX_OUTSTANDING());
    }

    function invariant_everyCallBehavedAsTheRulesSay() public view {
        assertEq(handler.failure(), "");
    }

    function invariant_unsettledDepositsKeepTheirStatusAndBuyer() public {
        EmpiyaP2P empiya = handler.empiya();
        uint256 count = handler.trackedCount();
        for (uint256 i = 0; i < count; i++) {
            (address depositor, uint256 key,,, address buyer, uint256 reservedAt) = handler.tracked(i);
            vm.prank(depositor);
            UserTransactionType.UserTransaction memory txn = empiya.getUserTransaction(key);
            assertEq(txn.recipient, buyer);
            assertEq(txn.reservedAt, reservedAt);
            if (buyer == address(0)) {
                assertEq(uint8(txn.status), uint8(UserTransactionType.Status.Open));
            } else {
                assertEq(uint8(txn.status), uint8(UserTransactionType.Status.Processing));
            }
        }
    }
}

contract EmpiyaP2PFuzzTest is Test {
    uint256 constant TIMEOUT = 1 hours;

    EmpiyaP2P empiya;
    Escrow escrow;
    address seller = address(0xA11CE);
    address buyer = address(0xB0B);

    function setUp() public {
        empiya = new EmpiyaP2P(TIMEOUT, type(uint128).max, type(uint256).max);
        escrow = Escrow(payable(empiya.getEscrowAddress()));
    }

    function depositAs(address account, uint256 amount) private returns (uint256 key, bytes32 transactionNumber) {
        vm.deal(account, amount);
        vm.prank(account);
        UserTransactionType.UserTransaction memory txn;
        (key, txn) = empiya.deposit{value: amount}();
        transactionNumber = txn.transactionNumber;
    }

    function testFuzz_depositThenWithdrawReturnsTheExactAmount(uint256 amount, uint256 donation) public {
        amount = bound(amount, 1, type(uint128).max);
        donation = bound(donation, 0, 100 ether);
        vm.deal(address(escrow), donation);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(seller);
        empiya.withdraw(key, transactionNumber);

        assertEq(seller.balance, amount);
        assertEq(escrow.outstanding(), 0);
        assertEq(address(escrow).balance, donation);
    }

    function testFuzz_onlyTheDepositorCanWithdraw(address caller, uint256 amount) public {
        vm.assume(caller != seller);
        amount = bound(amount, 1, 1_000 ether);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(caller);
        vm.expectRevert(bytes("Transaction does not exist."));
        empiya.withdraw(key, transactionNumber);

        vm.prank(seller);
        vm.expectRevert(bytes("Wrong Transaction Number provided."));
        empiya.withdraw(key, keccak256(abi.encode(transactionNumber)));
    }

    // The second rejected call has no prank, so it comes from this test contract, which is the admin.
    function testFuzz_onlyTheDepositorCanReserve(address caller, address namedBuyer, uint256 amount) public {
        vm.assume(caller != seller);
        vm.assume(namedBuyer != address(0) && namedBuyer != address(escrow) && namedBuyer != address(empiya));
        amount = bound(amount, 1, 1_000 ether);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(caller);
        vm.expectRevert(bytes("Transaction does not exist."));
        empiya.reserve(key, transactionNumber, payable(namedBuyer));

        vm.expectRevert(bytes("Transaction does not exist."));
        empiya.reserve(key, transactionNumber, payable(namedBuyer));

        vm.prank(seller);
        UserTransactionType.UserTransaction memory stored = empiya.getUserTransaction(key);
        assertEq(uint8(stored.status), uint8(UserTransactionType.Status.Open));
        assertEq(stored.recipient, address(0));

        vm.prank(seller);
        empiya.reserve(key, transactionNumber, payable(namedBuyer));
        vm.prank(seller);
        stored = empiya.getUserTransaction(key);
        assertEq(uint8(stored.status), uint8(UserTransactionType.Status.Processing));
        assertEq(stored.recipient, namedBuyer);
    }

    function testFuzz_adminReleasePaysOnlyTheNamedBuyerAtAnyTime(
        uint256 amount,
        address namedBuyer,
        address wrongBuyer,
        uint256 elapsed
    ) public {
        vm.assume(namedBuyer != address(0) && namedBuyer.code.length == 0 && uint160(namedBuyer) > 0xffff);
        vm.assume(namedBuyer != seller && namedBuyer != address(escrow) && namedBuyer != address(empiya));
        vm.assume(wrongBuyer != namedBuyer);
        amount = bound(amount, 1, 1_000 ether);
        elapsed = bound(elapsed, 0, 365 days);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);
        uint256 before = namedBuyer.balance;

        vm.prank(seller);
        empiya.reserve(key, transactionNumber, payable(namedBuyer));

        vm.prank(seller);
        vm.expectRevert(bytes("This deposit is reserved for a buyer."));
        empiya.withdraw(key, transactionNumber);

        vm.warp(block.timestamp + elapsed);

        vm.expectRevert(bytes("This deposit is reserved for a different buyer."));
        empiya.releaseToBuyer(seller, key, transactionNumber, wrongBuyer);

        empiya.releaseToBuyer(seller, key, transactionNumber, namedBuyer);
        assertEq(namedBuyer.balance, before + amount);
        assertEq(seller.balance, 0);
        assertEq(escrow.outstanding(), 0);

        vm.expectRevert(bytes("This deposit transaction has already been completed."));
        empiya.refundSeller(seller, key, transactionNumber);
    }

    function testFuzz_adminRefundPaysOnlyTheSellerAtAnyTime(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1, 1_000 ether);
        elapsed = bound(elapsed, 0, 365 days);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(seller);
        empiya.reserve(key, transactionNumber, payable(buyer));
        vm.warp(block.timestamp + elapsed);
        empiya.refundSeller(seller, key, transactionNumber);

        assertEq(seller.balance, amount);
        assertEq(buyer.balance, 0);
        assertEq(escrow.outstanding(), 0);
        vm.expectRevert(bytes("This deposit transaction has been cancelled."));
        empiya.releaseToBuyer(seller, key, transactionNumber, buyer);
    }

    function testFuzz_sellerReclaimsOnlyFromTheWindowEnd(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1, 1_000 ether);
        elapsed = bound(elapsed, 0, 2 * TIMEOUT);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(seller);
        empiya.reserve(key, transactionNumber, payable(buyer));
        vm.warp(block.timestamp + elapsed);

        vm.prank(seller);
        if (elapsed < TIMEOUT) {
            vm.expectRevert(bytes("This deposit is reserved for a buyer."));
            empiya.withdraw(key, transactionNumber);
            assertEq(escrow.outstanding(), amount);
            assertEq(seller.balance, 0);
        } else {
            empiya.withdraw(key, transactionNumber);
            assertEq(escrow.outstanding(), 0);
            assertEq(seller.balance, amount);

            vm.expectRevert(bytes("This deposit transaction has been cancelled."));
            empiya.releaseToBuyer(seller, key, transactionNumber, buyer);
        }
        assertEq(buyer.balance, 0);
    }

    function testFuzz_depositLimitsBoundEveryDeposit(
        uint256 maxDeposit,
        uint256 maxOutstanding,
        uint256 first,
        uint256 second
    ) public {
        maxDeposit = bound(maxDeposit, 1, 1e30);
        maxOutstanding = bound(maxOutstanding, maxDeposit, 1e30);
        first = bound(first, 1, maxDeposit);
        second = bound(second, 1, 2e30);
        EmpiyaP2P limited = new EmpiyaP2P(TIMEOUT, maxDeposit, maxOutstanding);
        Escrow limitedEscrow = Escrow(payable(limited.getEscrowAddress()));

        vm.deal(seller, first + second);
        vm.prank(seller);
        limited.deposit{value: first}();

        vm.prank(seller);
        if (second > maxDeposit) {
            vm.expectRevert(bytes("Deposit exceeds the per-deposit limit."));
            limited.deposit{value: second}();
            assertEq(limitedEscrow.outstanding(), first);
        } else if (first + second > maxOutstanding) {
            vm.expectRevert(bytes("Deposit exceeds the total escrow limit."));
            limited.deposit{value: second}();
            assertEq(limitedEscrow.outstanding(), first);
        } else {
            limited.deposit{value: second}();
            assertEq(limitedEscrow.outstanding(), first + second);
        }
        assertLe(limitedEscrow.outstanding(), maxOutstanding);
    }
}
