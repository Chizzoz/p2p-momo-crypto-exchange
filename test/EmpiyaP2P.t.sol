// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {Test} from "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EmpiyaP2P, Escrow, UserTransactionType} from "../contracts/EmpiyaP2P.sol";
import {EmpiyaPayments} from "../contracts/EmpiyaPayments.sol";
import {MockUSDT} from "../contracts/test/MockUSDT.sol";

/// @dev Ethereum-like MockUSDT returns no data from approve; high-level Solidity calls revert on that.
function approveUnlimited(MockUSDT token, address spender) {
    (bool ok,) = address(token).call(abi.encodeCall(token.approve, (spender, type(uint256).max)));
    require(ok, "approve failed");
}

contract EscrowHandler is CommonBase, StdUtils {
    uint256 public constant TIMEOUT = 1 hours;
    uint256 public constant USDT_UNIT = 1e6;
    uint256 public constant MAX_DEPOSIT = 1_000 * USDT_UNIT;
    uint256 public constant MAX_OUTSTANDING = 5_000 * USDT_UNIT;

    struct TrackedDeposit {
        address depositor;
        uint256 key;
        bytes32 transactionNumber;
        uint256 amount;
        address buyer;
        uint256 reservedAt;
        uint256 reservationId;
    }

    EmpiyaP2P public empiya;
    Escrow public escrow;
    MockUSDT public token;
    address[] public actors;
    TrackedDeposit[] public tracked;
    uint256 public ghostOutstanding;
    string public failure;

    constructor() {
        token = new MockUSDT(6, false);
        empiya = new EmpiyaP2P(IERC20(address(token)), 6, TIMEOUT, MAX_DEPOSIT, MAX_OUTSTANDING);
        escrow = Escrow(empiya.getEscrowAddress());
        for (uint160 i = 1; i <= 3; i++) {
            address actor = address(0x1000 + i);
            actors.push(actor);
            token.mint(actor, type(uint128).max);
            vm.prank(actor);
            approveUnlimited(token, address(empiya));
        }
    }

    function trackedCount() external view returns (uint256) {
        return tracked.length;
    }

    function deposit(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        amount = bound(amount, 1, MAX_DEPOSIT);
        bool allowed = !empiya.paused() && escrow.outstanding() + amount <= MAX_OUTSTANDING;
        vm.prank(actor);
        try empiya.deposit(amount) returns (uint256 key, UserTransactionType.UserTransaction memory txn) {
            if (!allowed) failure = "deposit accepted while paused or over the total limit";
            tracked.push(TrackedDeposit(actor, key, txn.transactionNumber, amount, address(0), 0, 0));
            ghostOutstanding += amount;
        } catch {
            if (allowed) failure = "deposit reverted within the limits";
        }
    }

    function withdraw(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, false);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        uint256 before = token.balanceOf(d.depositor);
        vm.prank(d.depositor);
        try empiya.withdraw(d.key, d.transactionNumber) {
            if (token.balanceOf(d.depositor) != before + d.amount) failure = "withdraw paid the wrong amount";
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
        try empiya.reserve(d.key, d.transactionNumber, buyer) returns (uint256, UserTransactionType.UserTransaction memory txn) {
            if (!allowed) failure = "reserve accepted while paused";
            d.buyer = buyer;
            d.reservedAt = block.timestamp;
            d.reservationId = txn.reservationId;
        } catch {
            if (allowed) failure = "reserve of an open deposit reverted";
        }
    }

    function adminRelease(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        uint256 before = token.balanceOf(d.buyer);
        try empiya.releaseToBuyer(d.depositor, d.key, d.transactionNumber, d.buyer, d.reservationId) {
            if (token.balanceOf(d.buyer) != before + d.amount) failure = "release paid the wrong buyer";
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
        try empiya.releaseToBuyer(d.depositor, d.key, d.transactionNumber, wrongBuyer, d.reservationId) {
            failure = "release accepted a buyer the seller did not name";
        } catch {}
    }

    function adminRefund(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        uint256 before = token.balanceOf(d.depositor);
        try empiya.refundSeller(d.depositor, d.key, d.transactionNumber, d.reservationId) {
            if (token.balanceOf(d.depositor) != before + d.amount) failure = "refund paid the wrong amount";
            settle(index);
        } catch {
            failure = "refund of a Processing deposit reverted";
        }
    }

    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1, 2 * TIMEOUT));
    }

    function sellerReclaim(uint256 seed) external {
        (bool found, uint256 index) = pick(seed, true);
        if (!found) return;
        TrackedDeposit memory d = tracked[index];
        bool expired = block.timestamp >= d.reservedAt + TIMEOUT;
        uint256 before = token.balanceOf(d.depositor);
        vm.prank(d.depositor);
        try empiya.withdraw(d.key, d.transactionNumber) {
            if (!expired) failure = "seller withdrew inside the reservation window";
            if (token.balanceOf(d.depositor) != before + d.amount) failure = "reclaim paid the wrong amount";
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
        try empiya.reserve(d.key, d.transactionNumber, buyer) returns (uint256, UserTransactionType.UserTransaction memory txn) {
            if (!allowed) failure = "seller replaced the buyer while paused or inside the window";
            d.buyer = buyer;
            d.reservedAt = block.timestamp;
            d.reservationId = txn.reservationId;
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
            d.reservationId = 0;
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
        amount = bound(amount, 1, (10 * 1e6));
        token.mint(address(escrow), amount);
    }

    function withdrawSurplus() external {
        if (token.balanceOf(address(escrow)) == escrow.outstanding()) return;
        empiya.withdrawSurplus(address(0xBEEF));
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
        assertGe(handler.token().balanceOf(address(escrow)), escrow.outstanding());
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
            (address depositor, uint256 key,,, address buyer, uint256 reservedAt, uint256 reservationId) = handler.tracked(i);
            vm.prank(depositor);
            UserTransactionType.UserTransaction memory txn = empiya.getUserTransaction(key);
            assertEq(txn.recipient, buyer);
            assertEq(txn.reservedAt, reservedAt);
            assertEq(txn.reservationId, reservationId);
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
    MockUSDT token;
    address seller = address(0xA11CE);
    address buyer = address(0xB0B);

    function setUp() public {
        token = new MockUSDT(6, false);
        empiya = new EmpiyaP2P(IERC20(address(token)), 6, TIMEOUT, type(uint128).max, type(uint256).max);
        escrow = Escrow(empiya.getEscrowAddress());
        token.mint(seller, type(uint128).max);
        vm.prank(seller);
        approveUnlimited(token, address(empiya));
    }

    function depositAs(address account, uint256 amount) private returns (uint256 key, bytes32 transactionNumber) {
        vm.prank(account);
        UserTransactionType.UserTransaction memory txn;
        (key, txn) = empiya.deposit(amount);
        transactionNumber = txn.transactionNumber;
    }

    function testFuzz_depositThenWithdrawReturnsTheExactAmount(uint256 amount, uint256 donation) public {
        amount = bound(amount, 1, type(uint128).max / 2);
        donation = bound(donation, 0, (100 * 1e6));
        token.mint(address(escrow), donation);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        uint256 before = token.balanceOf(seller);
        vm.prank(seller);
        empiya.withdraw(key, transactionNumber);

        assertEq(token.balanceOf(seller), before + amount);
        assertEq(escrow.outstanding(), 0);
        assertEq(token.balanceOf(address(escrow)), donation);
    }

    function testFuzz_onlyTheDepositorCanWithdraw(address caller, uint256 amount) public {
        vm.assume(caller != seller);
        amount = bound(amount, 1, (1_000 * 1e6));
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(caller);
        vm.expectRevert(bytes("Transaction does not exist."));
        empiya.withdraw(key, transactionNumber);
    }

    function testFuzz_onlyTheDepositorCanReserve(address caller, address namedBuyer, uint256 amount) public {
        vm.assume(caller != seller);
        vm.assume(namedBuyer != address(0) && namedBuyer != address(escrow) && namedBuyer != address(empiya) && namedBuyer != address(token));
        amount = bound(amount, 1, (1_000 * 1e6));
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(caller);
        vm.expectRevert(bytes("Transaction does not exist."));
        empiya.reserve(key, transactionNumber, namedBuyer);

        vm.expectRevert(bytes("Transaction does not exist."));
        empiya.reserve(key, transactionNumber, namedBuyer);

        vm.prank(seller);
        empiya.reserve(key, transactionNumber, namedBuyer);
        vm.prank(seller);
        UserTransactionType.UserTransaction memory stored = empiya.getUserTransaction(key);
        assertEq(uint8(stored.status), uint8(UserTransactionType.Status.Processing));
        assertEq(stored.recipient, namedBuyer);
        assertGt(stored.reservationId, 0);
    }

    function testFuzz_adminReleasePaysOnlyTheNamedBuyerAtAnyTime(
        uint256 amount,
        address namedBuyer,
        address wrongBuyer,
        uint256 elapsed
    ) public {
        vm.assume(namedBuyer != address(0) && namedBuyer.code.length == 0 && uint160(namedBuyer) > 0xffff);
        vm.assume(namedBuyer != seller && namedBuyer != address(escrow) && namedBuyer != address(empiya) && namedBuyer != address(token));
        vm.assume(wrongBuyer != namedBuyer);
        amount = bound(amount, 1, (1_000 * 1e6));
        elapsed = bound(elapsed, 0, 365 days);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);
        uint256 before = token.balanceOf(namedBuyer);

        vm.prank(seller);
        (, UserTransactionType.UserTransaction memory reserved) = empiya.reserve(key, transactionNumber, namedBuyer);

        vm.warp(block.timestamp + elapsed);

        vm.expectRevert(bytes("This deposit is reserved for a different buyer."));
        empiya.releaseToBuyer(seller, key, transactionNumber, wrongBuyer, reserved.reservationId);

        empiya.releaseToBuyer(seller, key, transactionNumber, namedBuyer, reserved.reservationId);
        assertEq(token.balanceOf(namedBuyer), before + amount);
        assertEq(escrow.outstanding(), 0);

        vm.expectRevert(bytes("This deposit transaction has already been completed."));
        empiya.refundSeller(seller, key, transactionNumber, reserved.reservationId);
    }

    function testFuzz_staleReservationIdCannotRefundANewReservation(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1, (1_000 * 1e6));
        elapsed = bound(elapsed, TIMEOUT, 365 days);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(seller);
        (, UserTransactionType.UserTransaction memory first) = empiya.reserve(key, transactionNumber, buyer);
        vm.warp(block.timestamp + elapsed);
        vm.prank(seller);
        (, UserTransactionType.UserTransaction memory second) = empiya.reserve(key, transactionNumber, address(0xB0B2));

        vm.expectRevert(bytes("Reservation does not match."));
        empiya.refundSeller(seller, key, transactionNumber, first.reservationId);
        vm.expectRevert(bytes("Reservation does not match."));
        empiya.releaseToBuyer(seller, key, transactionNumber, buyer, first.reservationId);

        empiya.releaseToBuyer(seller, key, transactionNumber, address(0xB0B2), second.reservationId);
        assertEq(token.balanceOf(address(0xB0B2)), amount);
    }

    function testFuzz_adminRefundPaysOnlyTheSellerAtAnyTime(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1, (1_000 * 1e6));
        elapsed = bound(elapsed, 0, 365 days);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(seller);
        (, UserTransactionType.UserTransaction memory reserved) = empiya.reserve(key, transactionNumber, buyer);
        vm.warp(block.timestamp + elapsed);

        uint256 before = token.balanceOf(seller);
        empiya.refundSeller(seller, key, transactionNumber, reserved.reservationId);

        assertEq(token.balanceOf(seller), before + amount);
        assertEq(token.balanceOf(buyer), 0);
        assertEq(escrow.outstanding(), 0);
    }

    function testFuzz_sellerReclaimsOnlyFromTheWindowEnd(uint256 amount, uint256 elapsed) public {
        amount = bound(amount, 1, (1_000 * 1e6));
        elapsed = bound(elapsed, 0, 2 * TIMEOUT);
        (uint256 key, bytes32 transactionNumber) = depositAs(seller, amount);

        vm.prank(seller);
        empiya.reserve(key, transactionNumber, buyer);
        vm.warp(block.timestamp + elapsed);

        uint256 before = token.balanceOf(seller);
        vm.prank(seller);
        if (elapsed < TIMEOUT) {
            vm.expectRevert(bytes("This deposit is reserved for a buyer."));
            empiya.withdraw(key, transactionNumber);
            assertEq(escrow.outstanding(), amount);
        } else {
            empiya.withdraw(key, transactionNumber);
            assertEq(escrow.outstanding(), 0);
            assertEq(token.balanceOf(seller), before + amount);
        }
        assertEq(token.balanceOf(buyer), 0);
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
        EmpiyaP2P limited = new EmpiyaP2P(IERC20(address(token)), 6, TIMEOUT, maxDeposit, maxOutstanding);
        Escrow limitedEscrow = Escrow(limited.getEscrowAddress());
        token.mint(seller, first + second);
        vm.startPrank(seller);
        approveUnlimited(token, address(limited));
        limited.deposit(first);

        if (second > maxDeposit) {
            vm.expectRevert(bytes("Deposit exceeds the per-deposit limit."));
            limited.deposit(second);
            assertEq(limitedEscrow.outstanding(), first);
        } else if (first + second > maxOutstanding) {
            vm.expectRevert(bytes("Deposit exceeds the total escrow limit."));
            limited.deposit(second);
            assertEq(limitedEscrow.outstanding(), first);
        } else {
            limited.deposit(second);
            assertEq(limitedEscrow.outstanding(), first + second);
        }
        vm.stopPrank();
        assertLe(limitedEscrow.outstanding(), maxOutstanding);
    }

    function test_constructorRejectsDecimalsMismatch() public {
        vm.expectRevert(bytes("Token decimals mismatch."));
        new EmpiyaP2P(IERC20(address(token)), 18, TIMEOUT, 1e6, 10e6);
    }
}

contract EmpiyaPaymentsFuzzTest is Test {
    uint256 constant CLAIM_DELAY = 7 days;

    EmpiyaPayments payments;
    MockUSDT token;
    address treasury = address(0x7EA5);
    address payer = address(0xB01);

    function setUp() public {
        token = new MockUSDT(6, false);
        payments = new EmpiyaPayments(IERC20(address(token)), 6, treasury, CLAIM_DELAY, 1_000 * 1e6, 5_000 * 1e6);
        token.mint(payer, type(uint128).max);
        vm.prank(payer);
        approveUnlimited(token, address(payments));
    }

    function testFuzz_settlePaysOnlyTheTreasury(bytes32 paymentId, uint256 amount) public {
        vm.assume(paymentId != bytes32(0));
        amount = bound(amount, 1, (1_000 * 1e6));
        vm.prank(payer);
        payments.pay(paymentId, amount);

        uint256 before = token.balanceOf(treasury);
        payments.settle(paymentId);
        assertEq(token.balanceOf(treasury), before + amount);
        assertEq(payments.totalPending(), 0);

        vm.expectRevert(bytes("Payment is not pending."));
        payments.refund(paymentId);
    }

    function testFuzz_refundAndClaimPayOnlyThePayer(bytes32 paymentId, uint256 amount, uint256 elapsed) public {
        vm.assume(paymentId != bytes32(0));
        amount = bound(amount, 1, (1_000 * 1e6));
        elapsed = bound(elapsed, CLAIM_DELAY, 365 days);

        vm.prank(payer);
        payments.pay(paymentId, amount);
        vm.warp(block.timestamp + elapsed);

        uint256 before = token.balanceOf(payer);
        vm.prank(payer);
        payments.claimBack(paymentId);
        assertEq(token.balanceOf(payer), before + amount);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(payments.totalPending(), 0);
    }

    function testFuzz_duplicatePaymentIdReverts(bytes32 paymentId, uint256 amount) public {
        vm.assume(paymentId != bytes32(0));
        amount = bound(amount, 1, (500 * 1e6));
        vm.startPrank(payer);
        payments.pay(paymentId, amount);
        vm.expectRevert(bytes("Payment id already used."));
        payments.pay(paymentId, amount);
        vm.stopPrank();
    }
}
