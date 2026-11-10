// SPDX-License-Identifier: MIT
pragma solidity 0.8.38;

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
    }
}

contract EmpiyaP2P {
    uint256 public immutable RESERVATION_TIMEOUT;

    Escrow escrowContract;
    address public admin;
    address public pendingAdmin;
    bytes32 public immutable escrowCodeHash;
    mapping(address => bool) public retiredEscrows;
    uint256 public maxDeposit;
    uint256 public maxOutstanding;
    bool public paused;

    event AdminProposed(address indexed currentAdmin, address indexed pendingAdmin);
    event AdminProposalCancelled(address indexed currentAdmin, address indexed cancelledAdmin);
    event AdminAccepted(address indexed previousAdmin, address indexed newAdmin);
    event EscrowUpdated(address indexed previousEscrow, address indexed newEscrow);
    event DepositLimitsUpdated(uint256 maxDeposit, uint256 maxOutstanding);
    event Paused(address indexed admin);
    event Unpaused(address indexed admin);

    constructor (uint256 reservationTimeout, uint256 initialMaxDeposit, uint256 initialMaxOutstanding) {
        Escrow initialEscrow = new Escrow(address(this), reservationTimeout);
        escrowContract = initialEscrow;
        escrowCodeHash = address(initialEscrow).codehash;
        RESERVATION_TIMEOUT = reservationTimeout;
        admin = msg.sender;
        updateDepositLimits(initialMaxDeposit, initialMaxOutstanding);
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "Only an Admin can execute this transaction.");
        _;
    }

    // A pause stops new deposits and reservations only. Every path that returns or pays out coin stays open.
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

    function pause() external onlyAdmin {
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

    function getUserBalance() external view returns (uint balance) {
        balance = msg.sender.balance;
    }

    function getEscrowAddress() external view onlyAdmin returns (address owner) {
        owner = escrowContract.getAddress();
    }

    function setEscrowContract(Escrow escrowContractAccount) external onlyAdmin returns (address) {
        require(address(escrowContractAccount).codehash == escrowCodeHash, "Escrow code does not match.");
        require(escrowContract.outstanding() == 0, "Outstanding deposits must be settled first.");
        require(escrowContractAccount.getArbitrator() == address(this), "Escrow arbitrator must be this contract.");
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

    function deposit() external payable whenNotPaused returns (uint256, UserTransactionType.UserTransaction memory) {
        require(msg.value <= maxDeposit, "Deposit exceeds the per-deposit limit.");
        require(escrowContract.outstanding() + msg.value <= maxOutstanding, "Deposit exceeds the total escrow limit.");
        (uint256 transactionKey, UserTransactionType.UserTransaction memory userTransaction) = escrowContract.deposit{value: msg.value}(msg.sender);
        return (transactionKey, userTransaction);
    }

    function withdraw(uint256 transactionKey, bytes32 transactionNumber) external returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.withdraw(payable(msg.sender), transactionKey, transactionNumber);
    }

    function reserve(uint256 transactionKey, bytes32 transactionNumber, address payable buyer) external whenNotPaused returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.reserve(msg.sender, transactionKey, transactionNumber, buyer);
    }

    function expireReservation(address depositor, uint256 transactionKey, bytes32 transactionNumber) external returns (UserTransactionType.UserTransaction memory userTransaction) {
        require(msg.sender == depositor || msg.sender == admin, "Only the depositor or an Admin can expire a reservation.");
        userTransaction = escrowContract.expireReservation(depositor, transactionKey, transactionNumber);
    }

    // `buyer` must be the address the seller reserved for, so a release meant for one trade cannot pay the buyer of a later reservation.
    function releaseToBuyer(address depositor, uint256 transactionKey, bytes32 transactionNumber, address buyer) external onlyAdmin returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.release(depositor, transactionKey, transactionNumber, buyer);
    }

    function refundSeller(address depositor, uint256 transactionKey, bytes32 transactionNumber) external onlyAdmin returns (uint256 _transactionKey, UserTransactionType.UserTransaction memory userTransaction) {
        (_transactionKey, userTransaction) = escrowContract.refund(depositor, transactionKey, transactionNumber);
    }

    function withdrawSurplus(address payable to) external onlyAdmin {
        escrowContract.withdrawSurplus(to);
    }

    function withdrawRetiredEscrowSurplus(Escrow retiredEscrow, address payable to) external onlyAdmin {
        require(retiredEscrows[address(retiredEscrow)], "Escrow is not retired.");
        retiredEscrow.withdrawSurplus(to);
    }
}

contract Escrow {
    uint256 public constant MAX_RESERVATION_TIMEOUT = 30 days;
    uint256 public immutable RESERVATION_TIMEOUT;
    address private immutable arbitrator;
    uint256 public outstanding;
    uint256 private nonce;
    uint256 private constant NOT_ENTERED = 1;
    uint256 private constant ENTERED = 2;
    uint256 private statusGuard = NOT_ENTERED;

    event Deposited(address indexed depositor, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Withdrawn(address indexed depositor, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Released(address indexed depositor, address indexed buyer, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Refunded(address indexed depositor, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 amount);
    event Reserved(address indexed depositor, address indexed buyer, uint256 indexed transactionKey, bytes32 transactionNumber, uint256 expiresAt);
    event ReservationExpired(address indexed depositor, address indexed buyer, uint256 indexed transactionKey, bytes32 transactionNumber);
    event SurplusWithdrawn(address indexed to, uint256 amount);

    mapping(address => UserTransactionType.UserTransaction[]) public userTransactions;

    receive() external payable {}

    modifier nonReentrant() {
        require(statusGuard != ENTERED, "Reentrancy blocked.");
        statusGuard = ENTERED;
        _;
        statusGuard = NOT_ENTERED;
    }

    modifier nonZeroAmount() {
        require(msg.value > 0, "Amount should be greater than zero.");
        _;
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

    constructor (address _arbitrator, uint256 reservationTimeout) {
        require(_arbitrator != address(0), "Invalid address input.");
        require(reservationTimeout != 0 && reservationTimeout <= MAX_RESERVATION_TIMEOUT, "Invalid reservation timeout.");
        arbitrator = _arbitrator;
        RESERVATION_TIMEOUT = reservationTimeout;
    }

    // Return data is never copied, so a recipient cannot make the payout run out of gas with a large return payload.
    function sendValue(address to, uint256 amount) private returns (bool sent) {
        assembly ("memory-safe") {
            sent := call(gas(), to, amount, 0, 0, 0, 0)
        }
    }

    function deposit(address depositorAddress) public onlyArbitrator nonZeroAmount nonReentrant payable returns (uint256, UserTransactionType.UserTransaction memory) {
        uint256 amount = msg.value;
        outstanding += amount;
        bytes32 transactionNumber = keccak256(abi.encode(depositorAddress, amount, nonce));
        nonce += 1;
        userTransactions[depositorAddress].push(UserTransactionType.UserTransaction(transactionNumber, amount, UserTransactionType.Status.Open, address(0), 0));
        uint256 transactionKey = userTransactions[depositorAddress].length - 1;
        emit Deposited(depositorAddress, transactionKey, transactionNumber, amount);
        return (transactionKey, userTransactions[depositorAddress][transactionKey]);
    }

    // The timeout only decides when the seller may reclaim a reserved deposit. Until the seller does,
    // the stored status stays Processing and the arbitrator can still release or refund it.
    function requireStatus(address depositorAddress, uint256 transactionKey, UserTransactionType.UserTransaction storage txn, UserTransactionType.Status expected) private {
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
        emit ReservationExpired(depositorAddress, buyer, transactionKey, txn.transactionNumber);
    }

    function withdraw(address payable depositorAddress, uint256 transactionKey, bytes32 transactionNumber) public onlyArbitrator transactionNumberMatch(depositorAddress, transactionKey, transactionNumber) nonReentrant returns (uint256, UserTransactionType.UserTransaction memory) {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Open);
        (uint256 key, UserTransactionType.UserTransaction memory updated) = payDepositor(depositorAddress, transactionKey, txn);
        emit Withdrawn(depositorAddress, transactionKey, txn.transactionNumber, txn.amount);
        return (key, updated);
    }

    function reserve(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber, address payable buyer) public onlyArbitrator transactionNumberMatch(depositorAddress, transactionKey, transactionNumber) nonReentrant returns (uint256, UserTransactionType.UserTransaction memory) {
        require(
            buyer != address(0) && buyer != address(this) && buyer != arbitrator,
            "Invalid address input."
        );
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Open);
        txn.recipient = buyer;
        txn.status = UserTransactionType.Status.Processing;
        txn.reservedAt = block.timestamp;
        emit Reserved(depositorAddress, buyer, transactionKey, transactionNumber, block.timestamp + RESERVATION_TIMEOUT);
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

    function release(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber, address expectedBuyer) public onlyArbitrator transactionNumberMatch(depositorAddress, transactionKey, transactionNumber) nonReentrant returns (uint256, UserTransactionType.UserTransaction memory) {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Processing);
        address buyer = txn.recipient;
        require(buyer == expectedBuyer, "This deposit is reserved for a different buyer.");
        (uint256 key, UserTransactionType.UserTransaction memory updated) = payRecipient(transactionKey, txn);
        emit Released(depositorAddress, buyer, transactionKey, txn.transactionNumber, txn.amount);
        return (key, updated);
    }

    function refund(address depositorAddress, uint256 transactionKey, bytes32 transactionNumber) public onlyArbitrator transactionNumberMatch(depositorAddress, transactionKey, transactionNumber) nonReentrant returns (uint256, UserTransactionType.UserTransaction memory) {
        UserTransactionType.UserTransaction storage txn = userTransactions[depositorAddress][transactionKey];
        requireStatus(depositorAddress, transactionKey, txn, UserTransactionType.Status.Processing);
        (uint256 key, UserTransactionType.UserTransaction memory updated) = payDepositor(depositorAddress, transactionKey, txn);
        emit Refunded(depositorAddress, transactionKey, txn.transactionNumber, txn.amount);
        return (key, updated);
    }

    function payDepositor(address depositorAddress, uint256 transactionKey, UserTransactionType.UserTransaction storage txn) private returns (uint256, UserTransactionType.UserTransaction memory) {
        uint256 amount = txn.amount;
        txn.status = UserTransactionType.Status.Cancelled;
        outstanding -= amount;

        require(sendValue(depositorAddress, amount), "Failed to send Ether back to depositor.");
        return (transactionKey, txn);
    }

    function payRecipient(uint256 transactionKey, UserTransactionType.UserTransaction storage txn) private returns (uint256, UserTransactionType.UserTransaction memory) {
        uint256 amount = txn.amount;
        address receiver = txn.recipient;
        txn.status = UserTransactionType.Status.Complete;
        outstanding -= amount;

        require(sendValue(receiver, amount), "Failed to send Ether to recipient.");
        return (transactionKey, txn);
    }

    function withdrawSurplus(address payable to) external onlyArbitrator nonReentrant {
        require(to != address(0), "Invalid address input.");
        uint256 surplus = address(this).balance - outstanding;
        require(surplus > 0, "No surplus.");
        require(sendValue(to, surplus), "Failed to send surplus.");
        emit SurplusWithdrawn(to, surplus);
    }

    function getTotalBalance() external view onlyArbitrator returns (uint256 balance) {
        balance = address(this).balance;
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
