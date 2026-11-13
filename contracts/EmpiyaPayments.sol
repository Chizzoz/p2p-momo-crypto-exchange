// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Holds USDT while the platform pays a shop or phone number from its own fiat liquidity.
/// Only the operator can settle to the treasury or refund the payer. A long claim delay is the
/// payer's backstop if the admin key is lost.
contract EmpiyaPayments {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_CLAIM_DELAY = 90 days;

    enum Status {
        None,
        Pending,
        Settled,
        Refunded
    }

    struct Payment {
        address payer;
        uint256 amount;
        Status status;
        uint256 createdAt;
    }

    IERC20 public immutable token;
    uint8 public immutable TOKEN_DECIMALS;
    address public immutable treasury;
    uint256 public immutable CLAIM_DELAY;

    address public admin;
    address public pendingAdmin;
    address public operator;
    uint256 public maxPayment;
    uint256 public maxPending;
    uint256 public totalPending;
    bool public paused;

    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private statusGuard = NOT_ENTERED;

    mapping(bytes32 => Payment) public payments;

    event AdminProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminProposalCancelled(address indexed currentAdmin, address indexed cancelledAdmin);
    event AdminAccepted(address indexed previousAdmin, address indexed newAdmin);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event PaymentLimitsUpdated(uint256 maxPayment, uint256 maxPending);
    event Paused(address indexed account);
    event Unpaused(address indexed account);
    event PaymentReceived(bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event PaymentSettled(bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event PaymentRefunded(bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event PaymentClaimed(bytes32 indexed paymentId, address indexed payer, uint256 amount);
    event SurplusWithdrawn(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(
        IERC20 tokenAddress,
        uint8 tokenDecimals,
        address treasuryAddress,
        uint256 claimDelay,
        uint256 initialMaxPayment,
        uint256 initialMaxPending
    ) {
        require(address(tokenAddress) != address(0) && treasuryAddress != address(0), "Invalid address input.");
        require(IERC20Metadata(address(tokenAddress)).decimals() == tokenDecimals, "Token decimals mismatch.");
        require(claimDelay != 0 && claimDelay <= MAX_CLAIM_DELAY, "Invalid claim delay.");

        token = tokenAddress;
        TOKEN_DECIMALS = tokenDecimals;
        treasury = treasuryAddress;
        CLAIM_DELAY = claimDelay;
        admin = msg.sender;
        operator = msg.sender;
        updatePaymentLimits(initialMaxPayment, initialMaxPending);
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only an Admin can execute this transaction.");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only an Operator can execute this transaction.");
        _;
    }

    modifier whenNotPaused() {
        require(!paused, "New payments are paused.");
        _;
    }

    modifier nonReentrant() {
        require(statusGuard != ENTERED, "Reentrancy blocked.");
        statusGuard = ENTERED;
        _;
        statusGuard = NOT_ENTERED;
    }

    function updatePaymentLimits(uint256 newMaxPayment, uint256 newMaxPending) private {
        require(newMaxPayment != 0 && newMaxPayment <= newMaxPending, "Invalid payment limits.");
        maxPayment = newMaxPayment;
        maxPending = newMaxPending;
        emit PaymentLimitsUpdated(newMaxPayment, newMaxPending);
    }

    function setPaymentLimits(uint256 newMaxPayment, uint256 newMaxPending) external onlyAdmin {
        updatePaymentLimits(newMaxPayment, newMaxPending);
    }

    function setOperator(address newOperator) external onlyAdmin {
        require(newOperator != address(0), "Invalid address input.");
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    function pause() external onlyOperator {
        require(!paused, "Already paused.");
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external onlyAdmin {
        require(paused, "Not paused.");
        paused = false;
        emit Unpaused(msg.sender);
    }

    function proposeAdmin(address _admin) external onlyAdmin {
        require(_admin != address(0), "Invalid address input.");
        pendingAdmin = _admin;
        emit AdminProposed(admin, _admin);
    }

    function cancelAdminProposal() external onlyAdmin {
        require(pendingAdmin != address(0), "No admin proposal to cancel.");
        emit AdminProposalCancelled(admin, pendingAdmin);
        pendingAdmin = address(0);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "Only the proposed admin can accept.");
        emit AdminAccepted(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function pay(bytes32 paymentId, uint256 amount) external whenNotPaused nonReentrant {
        require(paymentId != bytes32(0), "Invalid payment id.");
        require(payments[paymentId].status == Status.None, "Payment id already used.");
        require(amount != 0, "Amount should be greater than zero.");
        require(amount <= maxPayment, "Payment exceeds the per-payment limit.");
        require(totalPending + amount <= maxPending, "Payment exceeds the total pending limit.");

        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == before + amount, "Token transfer amount mismatch.");

        payments[paymentId] = Payment(msg.sender, amount, Status.Pending, block.timestamp);
        totalPending += amount;
        emit PaymentReceived(paymentId, msg.sender, amount);
    }

    function settle(bytes32 paymentId) external onlyOperator nonReentrant {
        Payment storage payment = payments[paymentId];
        require(payment.status == Status.Pending, "Payment is not pending.");

        payment.status = Status.Settled;
        totalPending -= payment.amount;
        token.safeTransfer(treasury, payment.amount);
        emit PaymentSettled(paymentId, payment.payer, payment.amount);
    }

    function refund(bytes32 paymentId) external onlyOperator nonReentrant {
        Payment storage payment = payments[paymentId];
        require(payment.status == Status.Pending, "Payment is not pending.");

        payment.status = Status.Refunded;
        totalPending -= payment.amount;
        token.safeTransfer(payment.payer, payment.amount);
        emit PaymentRefunded(paymentId, payment.payer, payment.amount);
    }

    // Payer backstop after CLAIM_DELAY so a lost admin key cannot lock funds forever.
    function claimBack(bytes32 paymentId) external nonReentrant {
        Payment storage payment = payments[paymentId];
        require(payment.status == Status.Pending, "Payment is not pending.");
        require(msg.sender == payment.payer, "Only the payer can claim back.");
        require(block.timestamp >= payment.createdAt + CLAIM_DELAY, "Claim delay has not passed.");

        payment.status = Status.Refunded;
        totalPending -= payment.amount;
        token.safeTransfer(payment.payer, payment.amount);
        emit PaymentClaimed(paymentId, payment.payer, payment.amount);
    }

    function withdrawSurplus() external onlyAdmin nonReentrant {
        uint256 surplus = token.balanceOf(address(this)) - totalPending;
        require(surplus > 0, "No surplus.");
        token.safeTransfer(treasury, surplus);
        emit SurplusWithdrawn(treasury, surplus);
    }

    function rescueToken(IERC20 other, address to) external onlyAdmin nonReentrant {
        require(to != address(0), "Invalid address input.");
        require(address(other) != address(token), "Cannot rescue the payment token.");
        uint256 amount = other.balanceOf(address(this));
        require(amount > 0, "No surplus.");
        other.safeTransfer(to, amount);
        emit TokenRescued(address(other), to, amount);
    }

    function getPayment(bytes32 paymentId) external view returns (Payment memory) {
        return payments[paymentId];
    }
}
