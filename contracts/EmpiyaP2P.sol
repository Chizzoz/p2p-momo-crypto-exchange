// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

library UserTransactionType {
    enum Status {
        Open,
        Processing,
        Complete,
        Cancelled
    }

    struct UserTransaction {
        bytes32 transactionNumber;
        uint256 amount;
        Status status;
        address recipient;
        uint256 reservedAt;
        // Appended so existing index-based reads of earlier fields stay valid.
        uint256 reservationId;
    }
}

contract EmpiyaP2P {
    using SafeERC20 for IERC20;

    uint256 public immutable RESERVATION_TIMEOUT;
    IERC20 public immutable token;
    uint8 public immutable TOKEN_DECIMALS;

    Escrow escrowContract;
    address public admin;
    address public pendingAdmin;
    address public operator;
    bytes32 public immutable escrowCodeHash;
    mapping(address => bool) public retiredEscrows;
    uint256 public maxDeposit;
    uint256 public maxOutstanding;
    bool public paused;

    event AdminProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminProposalCancelled(address indexed currentAdmin, address indexed cancelledAdmin);
    event AdminAccepted(address indexed previousAdmin, address indexed newAdmin);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event EscrowUpdated(address indexed previousEscrow, address indexed newEscrow);
    event DepositLimitsUpdated(uint256 maxDeposit, uint256 maxOutstanding);
    event Paused(address indexed account);
    event Unpaused(address indexed account);

    constructor(
        IERC20 tokenAddress,
        uint8 tokenDecimals,
        uint256 reservationTimeout,
        uint256 initialMaxDeposit,
        uint256 initialMaxOutstanding
    ) {
        require(address(tokenAddress) != address(0), "Invalid address input.");
        require(IERC20Metadata(address(tokenAddress)).decimals() == tokenDecimals, "Token decimals mismatch.");

        Escrow initialEscrow = new Escrow(address(this), tokenAddress, reservationTimeout);
        escrowContract = initialEscrow;
        escrowCodeHash = address(initialEscrow).codehash;
        token = tokenAddress;
        TOKEN_DECIMALS = tokenDecimals;
        RESERVATION_TIMEOUT = reservationTimeout;
        admin = msg.sender;
        operator = msg.sender;
        updateDepositLimits(initialMaxDeposit, initialMaxOutstanding);
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only an Admin can execute this transaction.");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "Only an Operator can execute this transaction.");
        _;
    }

    // A pause stops new deposits and reservations only. Every path that returns or pays out tokens stays open.
    modifier whenNotPaused() {
        require(!paused, "New deposits and reservations are paused.");
        _;
    }

    function updateDepositLimits(uint256 newMaxDeposit, uint256 newMaxOutstanding) private {
        require(newMaxDeposit != 0 && newMaxDeposit <= newMaxOutstanding, "Invalid deposit limits.");
        maxDeposit = newMaxDeposit;
        maxOutstanding = newMaxOutstanding;
        emit DepositLimitsUpdated(newMaxDeposit, newMaxOutstanding);
    }

    // Limits apply to new deposits only. Lowering them leaves existing deposits untouched.
    function setDepositLimits(uint256 newMaxDeposit, uint256 newMaxOutstanding) external onlyAdmin {
        updateDepositLimits(newMaxDeposit, newMaxOutstanding);
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

    function getCaller() external view onlyAdmin returns (address caller) {
        caller = escrowContract.getCaller();
    }

    function getOwner() external view onlyAdmin returns (address owner) {
        owner = escrowContract.getOwner();
    }

    function getUserBalance() external view returns (uint256 balance) {
        balance = token.balanceOf(msg.sender);
    }

    function getEscrowAddress() external view onlyAdmin returns (address escrowAddress) {
        escrowAddress = escrowContract.getAddress();
    }

    function setEscrowContract(Escrow escrowContractAccount) external onlyAdmin returns (address) {
        require(address(escrowContractAccount).codehash == escrowCodeHash, "Escrow code does not match.");
        require(escrowContract.outstanding() == 0, "Outstanding deposits must be settled first.");
        require(escrowContractAccount.getArbitrator() == address(this), "Escrow arbitrator must be this contract.");
        require(address(escrowContractAccount.token()) == address(token), "Escrow token does not match.");
        address previousEscrow = address(escrowContract);
        require(address(escrowContractAccount) != previousEscrow, "Escrow is already active.");
        require(!retiredEscrows[address(escrowContractAccount)], "Retired escrow cannot be reactivated.");
        retiredEscrows[previousEscrow] = true;
        escrowContract = escrowContractAccount;
        emit EscrowUpdated(previousEscrow, address(escrowContract));
        return address(escrowContract);
    }

    function getTotalBalance() external view onlyAdmin returns (uint256 balance) {
        balance = escrowContract.getTotalBalance();
    }

    function getUserTransaction(uint256 transactionKey) external view returns (UserTransactionType.UserTransaction memory transaction) {
        transaction = escrowContract.getTransaction(msg.sender, transactionKey);
    }

    function getUserTransactionByUser(address userAddress, uint256 transactionKey) external view returns (UserTransactionType.UserTransaction memory transaction) {
        transaction = escrowContract.getTransaction(userAddress, transactionKey);
    }

    function getUserTransactions() external view returns (UserTransactionType.UserTransaction[] memory transactions) {
        transactions = escrowContract.getTransactionsByUser(msg.sender);
    }

    function getUserTransactionsPage(uint256 offset, uint256 limit) external view returns (UserTransactionType.UserTransaction[] memory transactions) {
        transactions = escrowContract.getUserTransactionsPage(msg.sender, offset, limit);
    }

    function getTransactionsByUser(address userAddress) external view onlyAdmin returns (UserTransactionType.UserTransaction[] memory transactions) {
        transactions = escrowContract.getTransactionsByUser(userAddress);
    }

    function pullDeposit(uint256 amount) private {
        require(amount != 0, "Amount should be greater than zero.");
        require(amount <= maxDeposit, "Deposit exceeds the per-deposit limit.");
        require(escrowContract.outstanding() + amount <= maxOutstanding, "Deposit exceeds the total escrow limit.");

        address escrowAddress = address(escrowContract);
        uint256 before = token.balanceOf(escrowAddress);
        token.safeTransferFrom(msg.sender, escrowAddress, amount);
        require(token.balanceOf(escrowAddress) == before + amount, "Token transfer amount mismatch.");
    }

    function deposit(uint256 amount) external whenNotPaused returns (uint256, UserTransactionType.UserTransaction memory) {
        pullDeposit(amount);
        return escrowContract.recordDeposit(msg.sender, amount);
    }

    // One-step sell for a waiting buy order: deposit and name the buyer in the same transaction.
    function depositAndReserve(uint256 amount, address buyer)
        external
        whenNotPaused
        returns (uint256 transactionKey, UserTransactionType.UserTransaction memory userTransaction)
    {
        pullDeposit(amount);
        (transactionKey, userTransaction) = escrowContract.recordDeposit(msg.sender, amount);
        (transactionKey, userTransaction) = escrowContract.reserve(
            msg.sender,
            transactionKey,
            userTransaction.transactionNumber,
            buyer
        );
    }

    function withdraw(uint256 transactionKey, bytes32 transactionNumber) external returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.withdraw(msg.sender, transactionKey, transactionNumber);
    }

    function reserve(uint256 transactionKey, bytes32 transactionNumber, address buyer) external whenNotPaused returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.reserve(msg.sender, transactionKey, transactionNumber, buyer);
    }

    function expireReservation(address depositor, uint256 transactionKey, bytes32 transactionNumber) external returns (UserTransactionType.UserTransaction memory userTransaction) {
        require(
            msg.sender == depositor || msg.sender == admin || msg.sender == operator,
            "Only the depositor, Admin, or Operator can expire a reservation."
        );
        userTransaction = escrowContract.expireReservation(depositor, transactionKey, transactionNumber);
    }

    // `buyer` and `reservationId` must match the active reservation so a late release or refund cannot settle the wrong trade.
    function releaseToBuyer(
        address depositor,
        uint256 transactionKey,
        bytes32 transactionNumber,
        address buyer,
        uint256 reservationId
    ) external onlyOperator returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.release(depositor, transactionKey, transactionNumber, buyer, reservationId);
    }

    function refundSeller(
        address depositor,
        uint256 transactionKey,
        bytes32 transactionNumber,
        uint256 reservationId
    ) external onlyOperator returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.refund(depositor, transactionKey, transactionNumber, reservationId);
    }

    function withdrawSurplus(address to) external onlyAdmin {
        escrowContract.withdrawSurplus(to);
    }

    function withdrawRetiredEscrowSurplus(Escrow retiredEscrow, address to) external onlyAdmin {
        require(retiredEscrows[address(retiredEscrow)], "Escrow is not retired.");
        retiredEscrow.withdrawSurplus(to);
    }

    function rescueToken(IERC20 other, address to) external onlyAdmin {
        escrowContract.rescueToken(other, to);
    }

    function rescueRetiredEscrowToken(Escrow retiredEscrow, IERC20 other, address to) external onlyAdmin {
        require(retiredEscrows[address(retiredEscrow)], "Escrow is not retired.");
        retiredEscrow.rescueToken(other, to);
    }
}

contract Escrow {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_RESERVATION_TIMEOUT = 30 days;
    uint256 public immutable RESERVATION_TIMEOUT;
    IERC20 public immutable token;
    address private immutable arbitrator;
    uint256 public outstanding;
    uint256 private nonce;
    uint256 private reservationNonce;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private statusGuard = NOT_ENTERED;

    event Deposited(address indexed depositor, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Withdrawn(address indexed depositor, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Released(address indexed depositor, address indexed buyer, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Refunded(address indexed depositor, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Reserved(
        address indexed depositor,
        address indexed buyer,
        uint256 indexed transactionKey,
        bytes32 transactionNumber,
        uint256 expiresAt,
        uint256 reservationId
    );
    event ReservationExpired(address indexed depositor, address indexed buyer, uint256 indexed transactionKey, bytes32 transactionNumber);
    event SurplusWithdrawn(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    mapping(address => UserTransactionType.UserTransaction[]) public userTransactions;

    modifier nonReentrant() {
        require(statusGuard != ENTERED, "Reentrancy blocked.");
        statusGuard = ENTERED;
        _;
        statusGuard = NOT_ENTERED;
    }

    modifier onlyArbitrator() {
        require(msg.sender == address(arbitrator), "Only Arbitrator can execute this transaction.");
        _;
    }

    modifier transactionNumberMatch(address userAddress, uint256 transactionKey, bytes32 transactionNumber) {
        require(transactionKey < userTransactions[userAddress].length, "Transaction does not exist.");
        require(userTransactions[userAddress][transactionKey].transactionNumber == transactionNumber, "Wrong Transaction Number provided.");
        _;
    }

    constructor(address _arbitrator, IERC20 tokenAddress, uint256 reservationTimeout) {
        require(_arbitrator != address(0) && address(tokenAddress) != address(0), "Invalid address input.");
        require(reservationTimeout != 0 && reservationTimeout <= MAX_RESERVATION_TIMEOUT, "Invalid reservation timeout.");
        arbitrator = _arbitrator;
        token = tokenAddress;
        RESERVATION_TIMEOUT = reservationTimeout;
    }

    function recordDeposit(address depositorAddress, uint256 amount)
        external
        onlyArbitrator
        nonReentrant
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        require(amount != 0, "Amount should be greater than zero.");
        require(token.balanceOf(address(this)) >= outstanding + amount, "Escrow token balance too low.");

        outstanding += amount;
        bytes32 transactionNumber = keccak256(abi.encode(depositorAddress, amount, nonce));
        nonce += 1;
        userTransactions[depositorAddress].push(
            UserTransactionType.UserTransaction(
                transactionNumber,
                amount,
                UserTransactionType.Status.Open,
                address(0),
                0,
                0
            )
        );
        uint256 transactionKey = userTransactions[depositorAddress].length - 1;
        emit Deposited(depositorAddress, transactionKey, transactionNumber, amount);
        return (transactionKey, userTransactions[depositorAddress][transactionKey]);
    }

    // The timeout only decides when the seller may reclaim a reserved deposit. Until the seller does,
    // the stored status stays Processing and the arbitrator can still release or refund it.
    function requireStatus(
        address depositorAddress,
        uint256 transactionKey,
        UserTransactionType.UserTransaction storage txn,
        UserTransactionType.Status expected
    ) private {
        if (
            expected == UserTransactionType.Status.Open &&
            txn.status == UserTransactionType.Status.Processing &&
            block.timestamp >= txn.reservedAt + RESERVATION_TIMEOUT
        ) {
            expireReservationState(depositorAddress, transactionKey, txn);
        }
        require(txn.status != UserTransactionType.Status.Cancelled, "This deposit transaction has been cancelled.");
        require(txn.status != UserTransactionType.Status.Complete, "This deposit transaction has already been completed.");
        if (expected == UserTransactionType.Status.Open) {
            require(txn.status == UserTransactionType.Status.Open, "This deposit is reserved for a buyer.");
        } else {
            require(txn.status == UserTransactionType.Status.Processing, "This deposit is not reserved for a buyer.");
        }
    }

    function expireReservationState(
        address depositorAddress,
        uint256 transactionKey,
        UserTransactionType.UserTransaction storage txn
    ) private {
        address buyer = txn.recipient;
        txn.status = UserTransactionType.Status.Open;
        txn.recipient = address(0);
        txn.reservedAt = 0;
        txn.reservationId = 0;
        emit ReservationExpired(depositorAddress, buyer, transactionKey, txn.transactionNumber);
    }

    function withdraw(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber)
        public
        onlyArbitrator
        transactionNumberMatch(depositorAddress, transactionKey, transactionNumber)
        nonReentrant
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Open);
        (uint256 key, UserTransactionType.UserTransaction memory updated) = payDepositor(depositorAddress, transactionKey, txn);
        emit Withdrawn(depositorAddress, transactionKey, txn.transactionNumber, txn.amount);
        return (key, updated);
    }

    function reserve(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber, address buyer)
        public
        onlyArbitrator
        transactionNumberMatch(depositorAddress, transactionKey, transactionNumber)
        nonReentrant
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        require(
            buyer != address(0) && buyer != address(this) && buyer != arbitrator && buyer != address(token),
            "Invalid address input."
        );
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Open);

        reservationNonce += 1;
        uint256 reservationId = reservationNonce;
        txn.recipient = buyer;
        txn.status = UserTransactionType.Status.Processing;
        txn.reservedAt = block.timestamp;
        txn.reservationId = reservationId;
        emit Reserved(
            depositorAddress,
            buyer,
            transactionKey,
            transactionNumber,
            block.timestamp + RESERVATION_TIMEOUT,
            reservationId
        );
        return (transactionKey, txn);
    }

    function expireReservation(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber)
        external
        onlyArbitrator
        transactionNumberMatch(depositorAddress, transactionKey, transactionNumber)
        nonReentrant
        returns (UserTransactionType.UserTransaction memory)
    {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        require(txn.status != UserTransactionType.Status.Cancelled, "This deposit transaction has been cancelled.");
        require(txn.status != UserTransactionType.Status.Complete, "This deposit transaction has already been completed.");
        require(txn.status == UserTransactionType.Status.Processing, "This deposit is not reserved for a buyer.");
        require(block.timestamp >= txn.reservedAt + RESERVATION_TIMEOUT, "Reservation has not expired.");
        expireReservationState(depositorAddress, transactionKey, txn);
        return txn;
    }

    function release(
        address depositorAddress,
        uint256 transactionKey,
        bytes32 transactionNumber,
        address expectedBuyer,
        uint256 reservationId
    )
        public
        onlyArbitrator
        transactionNumberMatch(depositorAddress, transactionKey, transactionNumber)
        nonReentrant
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Processing);
        require(txn.reservationId == reservationId, "Reservation does not match.");
        address buyer = txn.recipient;
        require(buyer == expectedBuyer, "This deposit is reserved for a different buyer.");
        (uint256 key, UserTransactionType.UserTransaction memory updated) = payRecipient(transactionKey, txn);
        emit Released(depositorAddress, buyer, transactionKey, txn.transactionNumber, txn.amount);
        return (key, updated);
    }

    function refund(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber, uint256 reservationId)
        public
        onlyArbitrator
        transactionNumberMatch(depositorAddress, transactionKey, transactionNumber)
        nonReentrant
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Processing);
        require(txn.reservationId == reservationId, "Reservation does not match.");
        (uint256 key, UserTransactionType.UserTransaction memory updated) = payDepositor(depositorAddress, transactionKey, txn);
        emit Refunded(depositorAddress, transactionKey, txn.transactionNumber, txn.amount);
        return (key, updated);
    }

    function payDepositor(address depositorAddress, uint256 transactionKey, UserTransactionType.UserTransaction storage txn)
        private
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        uint256 amount = txn.amount;
        txn.status = UserTransactionType.Status.Cancelled;
        outstanding -= amount;
        token.safeTransfer(depositorAddress, amount);
        return (transactionKey, txn);
    }

    function payRecipient(uint256 transactionKey, UserTransactionType.UserTransaction storage txn)
        private
        returns (uint256, UserTransactionType.UserTransaction memory)
    {
        uint256 amount = txn.amount;
        address receiver = txn.recipient;
        txn.status = UserTransactionType.Status.Complete;
        outstanding -= amount;
        token.safeTransfer(receiver, amount);
        return (transactionKey, txn);
    }

    function withdrawSurplus(address to) external onlyArbitrator nonReentrant {
        require(to != address(0), "Invalid address input.");
        uint256 surplus = token.balanceOf(address(this)) - outstanding;
        require(surplus > 0, "No surplus.");
        token.safeTransfer(to, surplus);
        emit SurplusWithdrawn(to, surplus);
    }

    function rescueToken(IERC20 other, address to) external onlyArbitrator nonReentrant {
        require(to != address(0), "Invalid address input.");
        require(address(other) != address(token), "Cannot rescue the escrow token.");
        uint256 amount = other.balanceOf(address(this));
        require(amount > 0, "No surplus.");
        other.safeTransfer(to, amount);
        emit TokenRescued(address(other), to, amount);
    }

    function getTotalBalance() external view onlyArbitrator returns (uint256 balance) {
        balance = token.balanceOf(address(this));
    }

    function getTransaction(address userAddress, uint256 transactionKey) external view onlyArbitrator returns (UserTransactionType.UserTransaction memory transaction) {
        transaction = userTransactions[userAddress][transactionKey];
    }

    function getTransactionsByUser(address userAddress) external view onlyArbitrator returns (UserTransactionType.UserTransaction[] memory transactions) {
        transactions = userTransactions[userAddress];
    }

    function getUserTransactionsPage(address userAddress, uint256 offset, uint256 limit) external view onlyArbitrator returns (UserTransactionType.UserTransaction[] memory transactions) {
        UserTransactionType.UserTransaction[] storage all = userTransactions[userAddress];
        if (offset >= all.length || limit == 0) {
            return new UserTransactionType.UserTransaction[](0);
        }
        uint256 remaining = all.length - offset;
        uint256 size = limit < remaining ? limit : remaining;
        transactions = new UserTransactionType.UserTransaction[](size);
        for (uint256 i = 0; i < size; i++) {
            transactions[i] = all[offset + i];
        }
    }

    function getCaller() external view onlyArbitrator returns (address caller) {
        caller = msg.sender;
    }

    function getOwner() external view onlyArbitrator returns (address owner) {
        owner = arbitrator;
    }

    function getArbitrator() external view returns (address) {
        return arbitrator;
    }

    function getAddress() external view onlyArbitrator returns (address contractAddress) {
        contractAddress = address(this);
    }
}
