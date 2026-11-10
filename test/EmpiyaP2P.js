import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const Status = {
  Open: 0n,
  Processing: 1n,
  Complete: 2n,
  Cancelled: 3n,
};

const ONE_ETHER = ethers.parseEther("1");
const RESERVATION_TIMEOUT = 3600n;
const UNLIMITED = ethers.MaxUint256;

async function blockTimestamp(tx) {
  const receipt = await tx.wait();
  return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
}

async function latestTimestamp() {
  return BigInt((await ethers.provider.getBlock("latest")).timestamp);
}

// The next transaction is mined in a block with exactly this timestamp.
async function setNextTimestamp(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

// A fixed gas limit skips gas estimation, so a reverting transaction is still mined at the timestamp set above.
const MINED = { gasLimit: 500_000 };

async function latestTransaction(empiya, signer) {
  const transactions = await empiya.connect(signer).getUserTransactions();
  const key = transactions.length - 1;
  return { key, transaction: transactions[key] };
}

describe("EmpiyaP2P", function () {
  let admin;
  let seller;
  let buyer;
  let other;
  let empiya;
  let escrow;

  beforeEach(async function () {
    [admin, seller, buyer, other] = await ethers.getSigners();
    empiya = await ethers.deployContract("EmpiyaP2P", [RESERVATION_TIMEOUT, UNLIMITED, UNLIMITED]);
    escrow = await ethers.getContractAt("Escrow", await empiya.getEscrowAddress());
  });

  describe("deployment", function () {
    it("makes the deployer the only admin and the contract the escrow arbitrator", async function () {
      expect(await empiya.getCaller()).to.equal(await empiya.getAddress());
      expect(await empiya.getOwner()).to.equal(await empiya.getAddress());
      expect(await empiya.getTotalBalance()).to.equal(0n);
    });

    it("rejects admin-only calls from other accounts", async function () {
      const adminOnly = "Only an Admin can execute this transaction.";

      await expect(empiya.connect(other).getCaller()).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).getOwner()).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).getEscrowAddress()).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).getTotalBalance()).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).getTransactionsByUser(seller.address)).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).proposeAdmin(other.address)).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).withdrawSurplus(other.address)).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).setDepositLimits(1n, 1n)).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).pause()).to.be.revertedWith(adminOnly);
      await expect(empiya.connect(other).unpause()).to.be.revertedWith(adminOnly);
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);
      await expect(
        empiya.connect(other).setEscrowContract(await replacement.getAddress()),
      ).to.be.revertedWith(adminOnly);
      await expect(
        empiya.connect(other).withdrawRetiredEscrowSurplus(await escrow.getAddress(), other.address),
      ).to.be.revertedWith(adminOnly);
    });

    it("lets the proposed admin accept the role and rejects the zero address", async function () {
      await expect(empiya.proposeAdmin(ethers.ZeroAddress)).to.be.revertedWith("Invalid address input.");

      await empiya.proposeAdmin(other.address);

      expect(await empiya.getOwner()).to.equal(await empiya.getAddress());
      await expect(empiya.acceptAdmin()).to.be.revertedWith("Only the proposed admin can accept.");

      await empiya.connect(other).acceptAdmin();

      await expect(empiya.getOwner()).to.be.revertedWith("Only an Admin can execute this transaction.");
      await expect(empiya.proposeAdmin(seller.address)).to.be.revertedWith(
        "Only an Admin can execute this transaction.",
      );
      await expect(empiya.cancelAdminProposal()).to.be.revertedWith(
        "Only an Admin can execute this transaction.",
      );
      expect(await empiya.connect(other).getOwner()).to.equal(await empiya.getAddress());
    });

    it("lets the admin cancel a pending admin proposal", async function () {
      await expect(empiya.cancelAdminProposal()).to.be.revertedWith("No admin proposal to cancel.");

      await empiya.proposeAdmin(other.address);
      await expect(empiya.connect(other).cancelAdminProposal()).to.be.revertedWith(
        "Only an Admin can execute this transaction.",
      );
      await empiya.cancelAdminProposal();

      expect(await empiya.pendingAdmin()).to.equal(ethers.ZeroAddress);
      await expect(empiya.connect(other).acceptAdmin()).to.be.revertedWith("Only the proposed admin can accept.");
    });

    it("reports the caller's wallet balance", async function () {
      expect(await empiya.connect(seller).getUserBalance()).to.equal(
        await ethers.provider.getBalance(seller.address),
      );
    });

    it("lets the admin point the contract at a replacement escrow", async function () {
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);

      const replacementCode = await ethers.provider.getCode(await replacement.getAddress());
      const initialEscrowCode = await ethers.provider.getCode(await escrow.getAddress());
      expect(replacementCode).not.to.equal("0x");
      expect(replacementCode).to.equal(initialEscrowCode);
      expect(ethers.keccak256(replacementCode)).to.equal(await empiya.escrowCodeHash());
      await empiya.setEscrowContract(await replacement.getAddress());

      expect(await empiya.getEscrowAddress()).to.equal(await replacement.getAddress());
      expect(await empiya.retiredEscrows(await escrow.getAddress())).to.equal(true);

      await empiya.connect(seller).deposit({ value: ONE_ETHER });

      expect(await ethers.provider.getBalance(replacement)).to.equal(ONE_ETHER);
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);
      expect(await empiya.getTotalBalance()).to.equal(ONE_ETHER);
    });

    it("lets the admin recover coin forced into a retired escrow", async function () {
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);
      await empiya.setEscrowContract(await replacement.getAddress());
      await ethers.provider.send("hardhat_setBalance", [
        await escrow.getAddress(),
        ethers.toQuantity(ONE_ETHER),
      ]);

      await expect(
        empiya.withdrawRetiredEscrowSurplus(await escrow.getAddress(), admin.address),
      ).to.changeEtherBalances(ethers, [admin, escrow], [ONE_ETHER, -ONE_ETHER]);
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);
    });

    it("rejects retired escrow surplus withdrawals from non-admins and for active escrows", async function () {
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);
      await empiya.setEscrowContract(await replacement.getAddress());

      await expect(
        empiya.connect(other).withdrawRetiredEscrowSurplus(await escrow.getAddress(), other.address),
      ).to.be.revertedWith("Only an Admin can execute this transaction.");
      await expect(
        empiya.withdrawRetiredEscrowSurplus(await replacement.getAddress(), admin.address),
      ).to.be.revertedWith("Escrow is not retired.");
    });

    it("does not allow the active escrow or a retired escrow to be set again", async function () {
      await expect(empiya.setEscrowContract(await escrow.getAddress())).to.be.revertedWith(
        "Escrow is already active.",
      );

      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);
      await empiya.setEscrowContract(await replacement.getAddress());

      await expect(empiya.setEscrowContract(await escrow.getAddress())).to.be.revertedWith(
        "Retired escrow cannot be reactivated.",
      );
    });

    it("rejects an escrow swap while deposits are outstanding", async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);

      await expect(empiya.setEscrowContract(await replacement.getAddress())).to.be.revertedWith(
        "Outstanding deposits must be settled first.",
      );
    });

    it("allows an escrow swap despite surplus and recovers it from the retired escrow", async function () {
      await other.sendTransaction({ to: await escrow.getAddress(), value: 1n });
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);

      await empiya.setEscrowContract(await replacement.getAddress());
      expect(await empiya.getEscrowAddress()).to.equal(await replacement.getAddress());
      await expect(
        empiya.withdrawRetiredEscrowSurplus(await escrow.getAddress(), admin.address),
      ).to.changeEtherBalances(ethers, [admin, escrow], [1n, -1n]);
    });

    it("rejects a fake escrow that reports the expected arbitrator", async function () {
      const fake = await ethers.deployContract("FakeEscrow", [await empiya.getAddress()]);

      expect(await fake.getArbitrator()).to.equal(await empiya.getAddress());
      await expect(empiya.setEscrowContract(await fake.getAddress())).to.be.revertedWith(
        "Escrow code does not match.",
      );
    });

    it("rejects an escrow with a different arbitrator before calling it", async function () {
      const replacement = await ethers.deployContract("Escrow", [other.address, RESERVATION_TIMEOUT]);

      await expect(empiya.setEscrowContract(await replacement.getAddress())).to.be.revertedWith(
        "Escrow code does not match.",
      );
    });

    it("rejects a replacement escrow with a different reservation window", async function () {
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT + 1n]);

      await expect(empiya.setEscrowContract(await replacement.getAddress())).to.be.revertedWith(
        "Escrow code does not match.",
      );
    });

    it("takes the reservation window and deposit limits from the constructor", async function () {
      const custom = await ethers.deployContract("EmpiyaP2P", [7200n, ONE_ETHER, ONE_ETHER * 5n]);
      const customEscrow = await ethers.getContractAt("Escrow", await custom.getEscrowAddress());

      await expect(custom.deploymentTransaction())
        .to.emit(custom, "DepositLimitsUpdated")
        .withArgs(ONE_ETHER, ONE_ETHER * 5n);
      expect(await custom.RESERVATION_TIMEOUT()).to.equal(7200n);
      expect(await customEscrow.RESERVATION_TIMEOUT()).to.equal(7200n);
      expect(await custom.maxDeposit()).to.equal(ONE_ETHER);
      expect(await custom.maxOutstanding()).to.equal(ONE_ETHER * 5n);
      expect(await custom.paused()).to.equal(false);
    });

    it("rejects a reservation window of zero or more than 30 days, and invalid limits", async function () {
      const thirtyDays = 30n * 24n * 3600n;

      await expect(ethers.deployContract("EmpiyaP2P", [0n, ONE_ETHER, ONE_ETHER])).to.be.revertedWith(
        "Invalid reservation timeout.",
      );
      await expect(
        ethers.deployContract("EmpiyaP2P", [thirtyDays + 1n, ONE_ETHER, ONE_ETHER]),
      ).to.be.revertedWith("Invalid reservation timeout.");
      const longest = await ethers.deployContract("EmpiyaP2P", [thirtyDays, ONE_ETHER, ONE_ETHER]);
      expect(await longest.RESERVATION_TIMEOUT()).to.equal(thirtyDays);

      await expect(ethers.deployContract("EmpiyaP2P", [RESERVATION_TIMEOUT, 0n, ONE_ETHER])).to.be.revertedWith(
        "Invalid deposit limits.",
      );
      await expect(
        ethers.deployContract("EmpiyaP2P", [RESERVATION_TIMEOUT, ONE_ETHER + 1n, ONE_ETHER]),
      ).to.be.revertedWith("Invalid deposit limits.");
      await expect(
        ethers.deployContract("Escrow", [ethers.ZeroAddress, RESERVATION_TIMEOUT]),
      ).to.be.revertedWith("Invalid address input.");
    });

    it("rejects an EOA or an address with no code as an escrow", async function () {
      await expect(empiya.setEscrowContract(other.address)).to.be.revertedWith(
        "Escrow code does not match.",
      );
      await expect(empiya.setEscrowContract(ethers.ZeroAddress)).to.be.revertedWith(
        "Escrow code does not match.",
      );
    });
  });

  describe("deposit", function () {
    it("locks the native coin and records an open transaction", async function () {
      await expect(empiya.connect(seller).deposit({ value: ONE_ETHER })).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [-ONE_ETHER, ONE_ETHER],
      );

      const { key, transaction } = await latestTransaction(empiya, seller);

      expect(key).to.equal(0);
      expect(transaction.amount).to.equal(ONE_ETHER);
      expect(transaction.status).to.equal(Status.Open);
      expect(transaction.recipient).to.equal(ethers.ZeroAddress);
      expect(transaction.transactionNumber).to.not.equal(ethers.ZeroHash);
      expect(await empiya.getTotalBalance()).to.equal(ONE_ETHER);
    });

    it("keeps a separate list for each depositor", async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      await empiya.connect(seller).deposit({ value: ONE_ETHER / 2n });
      await empiya.connect(buyer).deposit({ value: ONE_ETHER / 4n });

      const sellerTransactions = await empiya.connect(seller).getUserTransactions();
      const buyerTransactions = await empiya.connect(buyer).getUserTransactions();
      const sellerFromAdmin = await empiya.getTransactionsByUser(seller.address);

      expect(sellerTransactions).to.have.length(2);
      expect(sellerTransactions[1].amount).to.equal(ONE_ETHER / 2n);
      expect(buyerTransactions).to.have.length(1);
      expect(sellerFromAdmin[0].transactionNumber).to.equal(sellerTransactions[0].transactionNumber);
      expect(sellerTransactions[0].transactionNumber).to.not.equal(sellerTransactions[1].transactionNumber);
      expect(await empiya.connect(other).getUserTransactionByUser(seller.address, 1)).to.deep.equal(
        sellerTransactions[1],
      );

      const page = await empiya.connect(seller).getUserTransactionsPage(1, 1);
      expect(page).to.have.length(1);
      expect(page[0].transactionNumber).to.equal(sellerTransactions[1].transactionNumber);
    });

    it("returns pages that stop at the end of the list", async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      await empiya.connect(seller).deposit({ value: ONE_ETHER });

      expect(await empiya.connect(seller).getUserTransactionsPage(2, 1)).to.have.length(0);
      expect(await empiya.connect(seller).getUserTransactionsPage(3, 1)).to.have.length(0);
      expect(await empiya.connect(seller).getUserTransactionsPage(0, 0)).to.have.length(0);
      expect(await empiya.connect(seller).getUserTransactionsPage(1, 10)).to.have.length(1);
      expect(await empiya.connect(seller).getUserTransactionsPage(0, 10)).to.have.length(2);
      expect(await empiya.connect(other).getUserTransactionsPage(0, 10)).to.have.length(0);
    });

    it("rejects transaction keys outside a user's transaction list", async function () {
      await expect(
        empiya.connect(other).withdraw(0, ethers.ZeroHash),
      ).to.be.revertedWith("Transaction does not exist.");

      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      await expect(
        empiya.connect(seller).withdraw(1, ethers.ZeroHash),
      ).to.be.revertedWith("Transaction does not exist.");
    });

    it("gives two equal deposits in one transaction different numbers", async function () {
      const attacker = await ethers.deployContract("ReentrantDepositor", [await empiya.getAddress()]);

      await attacker.depositTwice({ value: ONE_ETHER });

      const first = await empiya.getUserTransactionByUser(await attacker.getAddress(), 0);
      const second = await empiya.getUserTransactionByUser(await attacker.getAddress(), 1);
      expect(first.amount).to.equal(ONE_ETHER / 2n);
      expect(second.amount).to.equal(ONE_ETHER / 2n);
      expect(first.transactionNumber).to.not.equal(second.transactionNumber);
    });

    it("rejects a zero amount", async function () {
      await expect(empiya.connect(seller).deposit({ value: 0 })).to.be.revertedWith(
        "Amount should be greater than zero.",
      );
    });

    it("rejects direct calls to the escrow", async function () {
      await expect(
        escrow.connect(seller).deposit(seller.address, { value: ONE_ETHER }),
      ).to.be.revertedWith("Only Arbitrator can execute this transaction.");
    });
  });

  describe("withdraw", function () {
    beforeEach(async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
    });

    it("returns the deposit to the seller and marks it cancelled", async function () {
      const { transaction } = await latestTransaction(empiya, seller);

      await expect(empiya.connect(seller).withdraw(0, transaction.transactionNumber))
        .to.emit(escrow, "Withdrawn")
        .withArgs(seller.address, 0, transaction.transactionNumber, ONE_ETHER);

      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Cancelled);
      expect(await empiya.getTotalBalance()).to.equal(0n);
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);
    });

    it("moves the funds back to the seller", async function () {
      const { transaction } = await latestTransaction(empiya, seller);

      await expect(
        empiya.connect(seller).withdraw(0, transaction.transactionNumber),
      ).to.changeEtherBalances(ethers, [seller, escrow], [ONE_ETHER, -ONE_ETHER]);
    });

    it("rejects the wrong transaction number", async function () {
      const wrongNumber = ethers.hexlify(ethers.randomBytes(32));

      await expect(empiya.connect(seller).withdraw(0, wrongNumber)).to.be.revertedWith(
        "Wrong Transaction Number provided.",
      );
    });

    it("rejects a second withdrawal", async function () {
      const { transaction } = await latestTransaction(empiya, seller);
      await empiya.connect(seller).withdraw(0, transaction.transactionNumber);

      await expect(empiya.connect(seller).withdraw(0, transaction.transactionNumber)).to.be.revertedWith(
        "This deposit transaction has been cancelled.",
      );
    });

    it("does not let another account withdraw the seller's deposit", async function () {
      const { transaction } = await latestTransaction(empiya, seller);

      await expect(empiya.connect(buyer).withdraw(0, transaction.transactionNumber)).to.be.revertedWith(
        "Transaction does not exist.",
      );
    });

    it("gives the seller no call that sends a deposit to another address", async function () {
      const { transaction } = await latestTransaction(empiya, seller);
      const removed = new ethers.Interface([
        "function transfer(uint256 transactionKey, bytes32 transactionNumber, address recipient)",
        "function release(uint256 transactionKey, bytes32 transactionNumber)",
      ]);

      expect(empiya.interface.hasFunction("transfer")).to.equal(false);
      expect(empiya.interface.hasFunction("release")).to.equal(false);
      expect(escrow.interface.hasFunction("transfer")).to.equal(false);
      expect(escrow.interface.hasEvent("Transferred")).to.equal(false);

      const calls = [
        removed.encodeFunctionData("transfer", [0, transaction.transactionNumber, buyer.address]),
        removed.encodeFunctionData("release", [0, transaction.transactionNumber]),
      ];
      for (const data of calls) {
        await expect(
          seller.sendTransaction({ to: await empiya.getAddress(), data, ...MINED }),
        ).to.be.revert(ethers);
      }

      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Open);
      expect(await ethers.provider.getBalance(escrow)).to.equal(ONE_ETHER);
    });
  });

  describe("reservation", function () {
    let transactionNumber;

    beforeEach(async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      ({ transaction: { transactionNumber } } = await latestTransaction(empiya, seller));
    });

    async function reserveFor(account) {
      const tx = await empiya.connect(seller).reserve(0, transactionNumber, account.address);
      const reservedAt = await blockTimestamp(tx);
      await expect(tx)
        .to.emit(escrow, "Reserved")
        .withArgs(seller.address, account.address, 0, transactionNumber, reservedAt + RESERVATION_TIMEOUT);
      return reservedAt;
    }

    function reserveForBuyer() {
      return reserveFor(buyer);
    }

    it("names the buyer and moves the deposit to Processing without moving coin", async function () {
      const reservedAt = await reserveForBuyer();

      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Processing);
      expect(stored.recipient).to.equal(buyer.address);
      expect(stored.reservedAt).to.equal(reservedAt);
      expect(await empiya.RESERVATION_TIMEOUT()).to.equal(RESERVATION_TIMEOUT);
      expect(await escrow.RESERVATION_TIMEOUT()).to.equal(RESERVATION_TIMEOUT);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
      expect(await ethers.provider.getBalance(escrow)).to.equal(ONE_ETHER);
    });

    it("only lets the depositor reserve an open deposit, once, for a real address", async function () {
      await expect(empiya.connect(other).reserve(0, transactionNumber, buyer.address)).to.be.revertedWith(
        "Transaction does not exist.",
      );
      await expect(empiya.connect(seller).reserve(0, transactionNumber, ethers.ZeroAddress)).to.be.revertedWith(
        "Invalid address input.",
      );
      for (const invalidBuyer of [await escrow.getAddress(), await empiya.getAddress()]) {
        await expect(empiya.connect(seller).reserve(0, transactionNumber, invalidBuyer)).to.be.revertedWith(
          "Invalid address input.",
        );
      }

      await reserveForBuyer();

      await expect(empiya.connect(seller).reserve(0, transactionNumber, other.address)).to.be.revertedWith(
        "This deposit is reserved for a buyer.",
      );
    });

    it("gives the admin and the buyer no way to reserve a seller's deposit", async function () {
      const reserveCalls = empiya.interface.fragments
        .filter((fragment) => fragment.type === "function" && /reserve$/i.test(fragment.name))
        .map((fragment) => fragment.format());
      expect(reserveCalls).to.deep.equal(["reserve(uint256,bytes32,address)"]);

      for (const caller of [admin, buyer]) {
        await expect(
          empiya.connect(caller).reserve(0, transactionNumber, buyer.address),
        ).to.be.revertedWith("Transaction does not exist.");
        await expect(
          escrow.connect(caller).reserve(seller.address, 0, transactionNumber, buyer.address),
        ).to.be.revertedWith("Only Arbitrator can execute this transaction.");
      }

      // A caller with a deposit of their own at the same key still cannot reach the seller's deposit.
      for (const caller of [admin, buyer]) {
        await empiya.connect(caller).deposit({ value: ONE_ETHER });
        await expect(
          empiya.connect(caller).reserve(0, transactionNumber, buyer.address),
        ).to.be.revertedWith("Wrong Transaction Number provided.");
        const own = await empiya.connect(caller).getUserTransaction(0);
        expect(own.status).to.equal(Status.Open);
      }

      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Open);
      expect(stored.recipient).to.equal(ethers.ZeroAddress);
      expect(stored.reservedAt).to.equal(0n);
    });

    it("blocks escrow replacement while a reservation is processing", async function () {
      await reserveForBuyer();
      const replacement = await ethers.deployContract("Escrow", [await empiya.getAddress(), RESERVATION_TIMEOUT]);

      await expect(empiya.setEscrowContract(await replacement.getAddress())).to.be.revertedWith(
        "Outstanding deposits must be settled first.",
      );
    });

    it("lets the admin release a reserved deposit only to the named buyer", async function () {
      await reserveForBuyer();
      const tx = empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address);

      await expect(tx).to.changeEtherBalances(ethers, [buyer, seller, escrow], [ONE_ETHER, 0n, -ONE_ETHER]);
      await expect(tx)
        .to.emit(escrow, "Released")
        .withArgs(seller.address, buyer.address, 0, transactionNumber, ONE_ETHER);
      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Complete);
      expect(stored.recipient).to.equal(buyer.address);
      expect(await escrow.outstanding()).to.equal(0n);
    });

    it("rejects a release that names anyone but the reserved buyer", async function () {
      await reserveForBuyer();

      for (const wrongBuyer of [other.address, seller.address, admin.address, ethers.ZeroAddress]) {
        await expect(
          empiya.releaseToBuyer(seller.address, 0, transactionNumber, wrongBuyer),
        ).to.be.revertedWith("This deposit is reserved for a different buyer.");
      }

      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Processing);
      expect(stored.recipient).to.equal(buyer.address);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
    });

    it("lets the admin refund a reserved deposit only to the seller", async function () {
      await reserveForBuyer();
      const tx = empiya.refundSeller(seller.address, 0, transactionNumber);

      await expect(tx).to.changeEtherBalances(ethers, [seller, buyer, escrow], [ONE_ETHER, 0n, -ONE_ETHER]);
      await expect(tx)
        .to.emit(escrow, "Refunded")
        .withArgs(seller.address, 0, transactionNumber, ONE_ETHER);
      expect((await empiya.connect(seller).getUserTransaction(0)).status).to.equal(Status.Cancelled);
      expect(await escrow.outstanding()).to.equal(0n);
    });

    it("rejects release and refund before a buyer is named", async function () {
      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("This deposit is not reserved for a buyer.");
      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, ethers.ZeroAddress),
      ).to.be.revertedWith("This deposit is not reserved for a buyer.");
      await expect(empiya.refundSeller(seller.address, 0, transactionNumber)).to.be.revertedWith(
        "This deposit is not reserved for a buyer.",
      );
    });

    it("keeps the seller locked until the last second of the window and lets them withdraw at the boundary", async function () {
      const reservedAt = await reserveForBuyer();

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT - 1n);
      await expect(empiya.connect(seller).withdraw(0, transactionNumber, MINED)).to.be.revertedWith(
        "This deposit is reserved for a buyer.",
      );
      expect(await latestTimestamp()).to.equal(reservedAt + RESERVATION_TIMEOUT - 1n);

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      const tx = empiya.connect(seller).withdraw(0, transactionNumber);
      await expect(tx).to.changeEtherBalances(ethers, [seller, buyer, escrow], [ONE_ETHER, 0n, -ONE_ETHER]);
      await expect(tx)
        .to.emit(escrow, "ReservationExpired")
        .withArgs(seller.address, buyer.address, 0, transactionNumber);
      await expect(tx).to.emit(escrow, "Withdrawn").withArgs(seller.address, 0, transactionNumber, ONE_ETHER);
      expect(await latestTimestamp()).to.equal(reservedAt + RESERVATION_TIMEOUT);

      const settled = await empiya.connect(seller).getUserTransaction(0);
      expect(settled.status).to.equal(Status.Cancelled);
      expect(settled.recipient).to.equal(ethers.ZeroAddress);
      expect(await escrow.outstanding()).to.equal(0n);
    });

    it("lets the seller reserve for another buyer only from the window end", async function () {
      const reservedAt = await reserveForBuyer();

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT - 1n);
      await expect(
        empiya.connect(seller).reserve(0, transactionNumber, other.address, MINED),
      ).to.be.revertedWith("This deposit is reserved for a buyer.");

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      const tx = await empiya.connect(seller).reserve(0, transactionNumber, other.address);
      const renewedAt = await blockTimestamp(tx);
      expect(renewedAt).to.equal(reservedAt + RESERVATION_TIMEOUT);
      await expect(tx)
        .to.emit(escrow, "ReservationExpired")
        .withArgs(seller.address, buyer.address, 0, transactionNumber);
      await expect(tx)
        .to.emit(escrow, "Reserved")
        .withArgs(seller.address, other.address, 0, transactionNumber, renewedAt + RESERVATION_TIMEOUT);

      const renewed = await empiya.connect(seller).getUserTransaction(0);
      expect(renewed.status).to.equal(Status.Processing);
      expect(renewed.recipient).to.equal(other.address);
      expect(renewed.reservedAt).to.equal(renewedAt);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
    });

    it("lets the depositor expire a reservation from the window end and reopens it", async function () {
      const reservedAt = await reserveForBuyer();

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT - 1n);
      await expect(
        empiya.connect(seller).expireReservation(seller.address, 0, transactionNumber, MINED),
      ).to.be.revertedWith("Reservation has not expired.");
      expect(await latestTimestamp()).to.equal(reservedAt + RESERVATION_TIMEOUT - 1n);

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await expect(empiya.connect(seller).expireReservation(seller.address, 0, transactionNumber))
        .to.emit(escrow, "ReservationExpired")
        .withArgs(seller.address, buyer.address, 0, transactionNumber);

      const reopened = await empiya.connect(seller).getUserTransaction(0);
      expect(reopened.status).to.equal(Status.Open);
      expect(reopened.recipient).to.equal(ethers.ZeroAddress);
      expect(reopened.reservedAt).to.equal(0n);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
      expect(await ethers.provider.getBalance(escrow)).to.equal(ONE_ETHER);
    });

    it("lets the admin expire a reservation from the window end", async function () {
      const reservedAt = await reserveForBuyer();

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT - 1n);
      await expect(
        empiya.expireReservation(seller.address, 0, transactionNumber, MINED),
      ).to.be.revertedWith("Reservation has not expired.");

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await expect(empiya.expireReservation(seller.address, 0, transactionNumber))
        .to.emit(escrow, "ReservationExpired")
        .withArgs(seller.address, buyer.address, 0, transactionNumber);
      expect((await empiya.connect(seller).getUserTransaction(0)).status).to.equal(Status.Open);
    });

    it("does not let the buyer or a third party expire a reservation", async function () {
      const reservedAt = await reserveForBuyer();
      const restricted = "Only the depositor or an Admin can expire a reservation.";

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT * 2n);
      await expect(
        empiya.connect(other).expireReservation(seller.address, 0, transactionNumber, MINED),
      ).to.be.revertedWith(restricted);
      await expect(
        empiya.connect(buyer).expireReservation(seller.address, 0, transactionNumber),
      ).to.be.revertedWith(restricted);

      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Processing);
      expect(stored.recipient).to.equal(buyer.address);
    });

    it("lets the admin release at and after the window end while the deposit is still Processing", async function () {
      const reservedAt = await reserveForBuyer();
      const snapshot = await ethers.provider.send("evm_snapshot", []);

      for (const elapsed of [RESERVATION_TIMEOUT, RESERVATION_TIMEOUT * 10n]) {
        await setNextTimestamp(reservedAt + elapsed);
        const tx = empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address);
        await expect(tx).to.changeEtherBalances(ethers, [buyer, seller, escrow], [ONE_ETHER, 0n, -ONE_ETHER]);
        await expect(tx)
          .to.emit(escrow, "Released")
          .withArgs(seller.address, buyer.address, 0, transactionNumber, ONE_ETHER);
        expect(await latestTimestamp()).to.equal(reservedAt + elapsed);
        expect((await empiya.connect(seller).getUserTransaction(0)).status).to.equal(Status.Complete);
        expect(await escrow.outstanding()).to.equal(0n);

        await expect(empiya.connect(seller).withdraw(0, transactionNumber)).to.be.revertedWith(
          "This deposit transaction has already been completed.",
        );
        await ethers.provider.send("evm_revert", [snapshot]);
      }
    });

    it("lets the admin refund at and after the window end while the deposit is still Processing", async function () {
      const reservedAt = await reserveForBuyer();
      const snapshot = await ethers.provider.send("evm_snapshot", []);

      for (const elapsed of [RESERVATION_TIMEOUT, RESERVATION_TIMEOUT * 10n]) {
        await setNextTimestamp(reservedAt + elapsed);
        const tx = empiya.refundSeller(seller.address, 0, transactionNumber);
        await expect(tx).to.changeEtherBalances(ethers, [seller, buyer, escrow], [ONE_ETHER, 0n, -ONE_ETHER]);
        await expect(tx).to.emit(escrow, "Refunded").withArgs(seller.address, 0, transactionNumber, ONE_ETHER);
        expect(await latestTimestamp()).to.equal(reservedAt + elapsed);
        expect((await empiya.connect(seller).getUserTransaction(0)).status).to.equal(Status.Cancelled);
        expect(await escrow.outstanding()).to.equal(0n);
        await ethers.provider.send("evm_revert", [snapshot]);
      }
    });

    it("rejects a late release and refund once the seller has withdrawn", async function () {
      const reservedAt = await reserveForBuyer();
      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await empiya.connect(seller).withdraw(0, transactionNumber);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("This deposit transaction has been cancelled.");
      await expect(empiya.refundSeller(seller.address, 0, transactionNumber)).to.be.revertedWith(
        "This deposit transaction has been cancelled.",
      );
      expect(await escrow.outstanding()).to.equal(0n);
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);
    });

    it("rejects a late release and refund once the reservation has been expired", async function () {
      const reservedAt = await reserveForBuyer();
      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await empiya.connect(seller).expireReservation(seller.address, 0, transactionNumber);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("This deposit is not reserved for a buyer.");
      await expect(empiya.refundSeller(seller.address, 0, transactionNumber)).to.be.revertedWith(
        "This deposit is not reserved for a buyer.",
      );
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);

      await expect(empiya.connect(seller).withdraw(0, transactionNumber)).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
      expect(await escrow.outstanding()).to.equal(0n);
    });

    it("does not pay a new buyer when a release for the earlier buyer lands after a re-reservation", async function () {
      const reservedAt = await reserveForBuyer();
      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await empiya.connect(seller).reserve(0, transactionNumber, other.address);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("This deposit is reserved for a different buyer.");
      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Processing);
      expect(stored.recipient).to.equal(other.address);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, other.address),
      ).to.changeEtherBalances(ethers, [other, buyer, escrow], [ONE_ETHER, 0n, -ONE_ETHER]);
    });

    it("rejects expiry for open or settled deposits", async function () {
      await expect(
        empiya.expireReservation(seller.address, 0, transactionNumber),
      ).to.be.revertedWith("This deposit is not reserved for a buyer.");

      const snapshot = await ethers.provider.send("evm_snapshot", []);
      await reserveForBuyer();
      await empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address);
      await expect(
        empiya.connect(seller).expireReservation(seller.address, 0, transactionNumber),
      ).to.be.revertedWith("This deposit transaction has already been completed.");

      await ethers.provider.send("evm_revert", [snapshot]);
      await reserveForBuyer();
      await empiya.refundSeller(seller.address, 0, transactionNumber);
      await expect(
        empiya.expireReservation(seller.address, 0, transactionNumber),
      ).to.be.revertedWith("This deposit transaction has been cancelled.");
    });

    it("rejects a second release or refund after settlement", async function () {
      await reserveForBuyer();
      await empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("This deposit transaction has already been completed.");
      await expect(empiya.refundSeller(seller.address, 0, transactionNumber)).to.be.revertedWith(
        "This deposit transaction has already been completed.",
      );
      await expect(empiya.connect(seller).reserve(0, transactionNumber, other.address)).to.be.revertedWith(
        "This deposit transaction has already been completed.",
      );
    });

    it("rejects release after refund", async function () {
      await reserveForBuyer();
      await empiya.refundSeller(seller.address, 0, transactionNumber);
      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("This deposit transaction has been cancelled.");
    });

    it("rejects release and refund from the seller, the buyer, and other accounts", async function () {
      const reservedAt = await reserveForBuyer();
      const adminOnly = "Only an Admin can execute this transaction.";

      for (const caller of [seller, buyer, other]) {
        await expect(
          empiya.connect(caller).releaseToBuyer(seller.address, 0, transactionNumber, buyer.address),
        ).to.be.revertedWith(adminOnly);
        await expect(
          empiya.connect(caller).refundSeller(seller.address, 0, transactionNumber),
        ).to.be.revertedWith(adminOnly);
      }
      await expect(
        escrow.connect(seller).release(seller.address, 0, transactionNumber, buyer.address),
      ).to.be.revertedWith("Only Arbitrator can execute this transaction.");
      await expect(
        escrow.connect(seller).refund(seller.address, 0, transactionNumber),
      ).to.be.revertedWith("Only Arbitrator can execute this transaction.");

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await expect(
        empiya.connect(seller).releaseToBuyer(seller.address, 0, transactionNumber, buyer.address, MINED),
      ).to.be.revertedWith(adminOnly);
    });

    it("keeps a reserved deposit when the named buyer rejects the payment", async function () {
      const rejectingBuyer = await ethers.deployContract("RejectingRecipient");
      const rejectingAddress = await rejectingBuyer.getAddress();
      await empiya.connect(seller).reserve(0, transactionNumber, rejectingAddress);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, rejectingAddress),
      ).to.be.revertedWith("Failed to send Ether to recipient.");
      const stored = await empiya.connect(seller).getUserTransaction(0);
      expect(stored.status).to.equal(Status.Processing);
      expect(stored.recipient).to.equal(rejectingAddress);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);

      await expect(empiya.refundSeller(seller.address, 0, transactionNumber)).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
    });

    it("pays a named buyer that returns a large payload", async function () {
      const bomb = await ethers.deployContract("ReturnDataBomb");
      const bombAddress = await bomb.getAddress();
      await empiya.connect(seller).reserve(0, transactionNumber, bombAddress);

      await expect(
        empiya.releaseToBuyer(seller.address, 0, transactionNumber, bombAddress, { gasLimit: 1_000_000 }),
      ).to.changeEtherBalances(ethers, [bomb, escrow], [ONE_ETHER, -ONE_ETHER]);
    });
  });

  describe("deposit limits", function () {
    const MAX_DEPOSIT = ONE_ETHER;
    const MAX_OUTSTANDING = (ONE_ETHER * 5n) / 2n;
    let limited;
    let limitedEscrow;

    beforeEach(async function () {
      limited = await ethers.deployContract("EmpiyaP2P", [RESERVATION_TIMEOUT, MAX_DEPOSIT, MAX_OUTSTANDING]);
      limitedEscrow = await ethers.getContractAt("Escrow", await limited.getEscrowAddress());
    });

    it("accepts a deposit exactly at the per-deposit limit and rejects one wei more", async function () {
      await expect(limited.connect(seller).deposit({ value: MAX_DEPOSIT + 1n })).to.be.revertedWith(
        "Deposit exceeds the per-deposit limit.",
      );
      await expect(limited.connect(seller).deposit({ value: MAX_DEPOSIT })).to.changeEtherBalances(
        ethers,
        [seller, limitedEscrow],
        [-MAX_DEPOSIT, MAX_DEPOSIT],
      );
      expect(await limitedEscrow.outstanding()).to.equal(MAX_DEPOSIT);
    });

    it("accepts deposits up to exactly the total limit, rejects one wei more, and frees room on settlement", async function () {
      await limited.connect(seller).deposit({ value: ONE_ETHER });
      await limited.connect(buyer).deposit({ value: ONE_ETHER });

      await expect(limited.connect(other).deposit({ value: ONE_ETHER / 2n + 1n })).to.be.revertedWith(
        "Deposit exceeds the total escrow limit.",
      );
      await limited.connect(other).deposit({ value: ONE_ETHER / 2n });
      expect(await limitedEscrow.outstanding()).to.equal(MAX_OUTSTANDING);
      await expect(limited.connect(other).deposit({ value: 1n })).to.be.revertedWith(
        "Deposit exceeds the total escrow limit.",
      );

      const { transaction } = await latestTransaction(limited, seller);
      await limited.connect(seller).withdraw(0, transaction.transactionNumber);
      await limited.connect(other).deposit({ value: ONE_ETHER });
      expect(await limitedEscrow.outstanding()).to.equal(MAX_OUTSTANDING);
    });

    it("does not count coin sent or forced into the escrow against the total limit", async function () {
      await other.sendTransaction({ to: await limitedEscrow.getAddress(), value: ONE_ETHER * 10n });

      await limited.connect(seller).deposit({ value: ONE_ETHER });
      await limited.connect(seller).deposit({ value: ONE_ETHER });
      await limited.connect(seller).deposit({ value: ONE_ETHER / 2n });
      expect(await limitedEscrow.outstanding()).to.equal(MAX_OUTSTANDING);
      expect(await ethers.provider.getBalance(limitedEscrow)).to.equal(MAX_OUTSTANDING + ONE_ETHER * 10n);
    });

    it("lets only the admin change the limits and rejects invalid ones", async function () {
      await expect(limited.connect(other).setDepositLimits(1n, 2n)).to.be.revertedWith(
        "Only an Admin can execute this transaction.",
      );
      await expect(limited.setDepositLimits(0n, 2n)).to.be.revertedWith("Invalid deposit limits.");
      await expect(limited.setDepositLimits(3n, 2n)).to.be.revertedWith("Invalid deposit limits.");

      await expect(limited.setDepositLimits(2n, 2n)).to.emit(limited, "DepositLimitsUpdated").withArgs(2n, 2n);
      expect(await limited.maxDeposit()).to.equal(2n);
      expect(await limited.maxOutstanding()).to.equal(2n);
      await expect(limited.connect(seller).deposit({ value: 3n })).to.be.revertedWith(
        "Deposit exceeds the per-deposit limit.",
      );
      await limited.connect(seller).deposit({ value: 2n });
    });

    it("leaves existing deposits usable after the limits are lowered below them", async function () {
      await limited.connect(seller).deposit({ value: ONE_ETHER });
      await limited.connect(seller).deposit({ value: ONE_ETHER });
      const transactions = await limited.connect(seller).getUserTransactions();

      await limited.setDepositLimits(ONE_ETHER / 10n, ONE_ETHER / 2n);

      await expect(limited.connect(other).deposit({ value: 1n })).to.be.revertedWith(
        "Deposit exceeds the total escrow limit.",
      );
      expect(await limitedEscrow.outstanding()).to.equal(ONE_ETHER * 2n);

      await expect(
        limited.connect(seller).withdraw(0, transactions[0].transactionNumber),
      ).to.changeEtherBalances(ethers, [seller, limitedEscrow], [ONE_ETHER, -ONE_ETHER]);
      await limited.connect(seller).reserve(1, transactions[1].transactionNumber, buyer.address);
      await expect(
        limited.releaseToBuyer(seller.address, 1, transactions[1].transactionNumber, buyer.address),
      ).to.changeEtherBalances(ethers, [buyer, limitedEscrow], [ONE_ETHER, -ONE_ETHER]);
      expect(await limitedEscrow.outstanding()).to.equal(0n);

      await limited.connect(other).deposit({ value: ONE_ETHER / 10n });
    });
  });

  describe("pause", function () {
    const paused = "New deposits and reservations are paused.";

    it("lets only the admin pause and unpause, once each", async function () {
      await expect(empiya.unpause()).to.be.revertedWith("Not paused.");
      await expect(empiya.pause()).to.emit(empiya, "Paused").withArgs(admin.address);
      expect(await empiya.paused()).to.equal(true);
      await expect(empiya.pause()).to.be.revertedWith("Already paused.");
      await expect(empiya.connect(other).unpause()).to.be.revertedWith(
        "Only an Admin can execute this transaction.",
      );

      await expect(empiya.unpause()).to.emit(empiya, "Unpaused").withArgs(admin.address);
      expect(await empiya.paused()).to.equal(false);
    });

    it("blocks new deposits and reservations while every exit keeps working", async function () {
      for (let i = 0; i < 5; i++) {
        await empiya.connect(seller).deposit({ value: ONE_ETHER });
      }
      const numbers = (await empiya.connect(seller).getUserTransactions()).map((t) => t.transactionNumber);
      await empiya.connect(seller).reserve(1, numbers[1], buyer.address);
      await empiya.connect(seller).reserve(2, numbers[2], buyer.address);
      await empiya.connect(seller).reserve(3, numbers[3], buyer.address);
      const lastReservation = await empiya.connect(seller).reserve(4, numbers[4], buyer.address);
      const reservedAt = await blockTimestamp(lastReservation);
      await other.sendTransaction({ to: await escrow.getAddress(), value: 7n });

      await empiya.pause();

      await expect(empiya.connect(seller).deposit({ value: ONE_ETHER })).to.be.revertedWith(paused);
      await expect(empiya.connect(seller).reserve(0, numbers[0], buyer.address)).to.be.revertedWith(paused);

      await expect(empiya.connect(seller).withdraw(0, numbers[0])).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
      await expect(
        empiya.releaseToBuyer(seller.address, 1, numbers[1], buyer.address),
      ).to.changeEtherBalances(ethers, [buyer, escrow], [ONE_ETHER, -ONE_ETHER]);
      await expect(empiya.refundSeller(seller.address, 2, numbers[2])).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
      await expect(empiya.withdrawSurplus(admin.address)).to.changeEtherBalances(
        ethers,
        [admin, escrow],
        [7n, -7n],
      );

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await expect(empiya.connect(seller).expireReservation(seller.address, 3, numbers[3]))
        .to.emit(escrow, "ReservationExpired")
        .withArgs(seller.address, buyer.address, 3, numbers[3]);
      await expect(empiya.connect(seller).reserve(3, numbers[3], other.address)).to.be.revertedWith(paused);
      await expect(empiya.connect(seller).reserve(4, numbers[4], other.address)).to.be.revertedWith(paused);
      await expect(empiya.connect(seller).withdraw(3, numbers[3])).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
      await expect(empiya.connect(seller).withdraw(4, numbers[4])).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
      expect(await escrow.outstanding()).to.equal(0n);
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);

      await empiya.unpause();
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      const { key, transaction } = await latestTransaction(empiya, seller);
      await empiya.connect(seller).reserve(key, transaction.transactionNumber, buyer.address);
    });
  });

  describe("reentrancy", function () {
    afterEach(async function () {
      expect(await ethers.provider.getBalance(escrow)).to.be.gte(await escrow.outstanding());
    });

    async function fundEscrow() {
      const attacker = await ethers.deployContract("ReentrantDepositor", [await empiya.getAddress()]);
      await attacker.deposit({ value: ONE_ETHER });
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      return attacker;
    }

    it("pays a reentering withdraw once and leaves the other deposit", async function () {
      const attacker = await fundEscrow();

      await expect(attacker.attackWithdraw()).to.changeEtherBalances(
        ethers,
        [attacker, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );

      expect(await attacker.revertReason()).to.equal("Reentrancy blocked.");
      expect(await attacker.payouts()).to.equal(1n);

      const stored = await empiya.getUserTransactionByUser(await attacker.getAddress(), 0);
      expect(stored.status).to.equal(Status.Cancelled);
      const sellerDeposit = await empiya.connect(seller).getUserTransaction(0);
      expect(sellerDeposit.status).to.equal(Status.Open);
      expect(await ethers.provider.getBalance(escrow)).to.equal(ONE_ETHER);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
    });

    it("rejects a deposit made from inside a payout", async function () {
      const attacker = await fundEscrow();

      await attacker.attackDeposit();

      expect(await attacker.revertReason()).to.equal("Reentrancy blocked.");
      expect(await empiya.getTransactionsByUser(await attacker.getAddress())).to.have.length(1);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
    });

    it("blocks a named buyer from reentering during an admin release", async function () {
      const attacker = await fundEscrow();
      await attacker.reserveForSelf();
      const attackerAddress = await attacker.getAddress();

      await expect(
        empiya.releaseToBuyer(attackerAddress, 0, await attacker.transactionNumber(), attackerAddress),
      ).to.changeEtherBalances(ethers, [attacker, escrow], [ONE_ETHER, -ONE_ETHER]);

      expect(await attacker.revertReason()).to.equal("Reentrancy blocked.");
      expect(await attacker.payouts()).to.equal(1n);
      expect((await empiya.getUserTransactionByUser(attackerAddress, 0)).status).to.equal(Status.Complete);
      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
      expect((await empiya.connect(seller).getUserTransaction(0)).status).to.equal(Status.Open);
    });

    it("blocks a seller contract from reentering during an admin refund", async function () {
      const attacker = await ethers.deployContract("ReentrantDepositor", [await empiya.getAddress()]);
      await empiya.proposeAdmin(await attacker.getAddress());
      await attacker.acceptAdmin();
      await attacker.deposit({ value: ONE_ETHER });
      await attacker.reserveForBuyer(buyer.address);

      await expect(attacker.attackRefund()).to.changeEtherBalances(
        ethers,
        [attacker, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );

      expect(await attacker.revertReason()).to.equal("Reentrancy blocked.");
      expect(await attacker.payouts()).to.equal(1n);
      expect((await empiya.getUserTransactionByUser(await attacker.getAddress(), 0)).status).to.equal(Status.Cancelled);
      expect(await escrow.outstanding()).to.equal(0n);
    });

    it("blocks reentrant surplus withdrawal when the admin receives the surplus", async function () {
      const attacker = await ethers.deployContract("ReentrantDepositor", [await empiya.getAddress()]);
      await empiya.proposeAdmin(await attacker.getAddress());
      await attacker.acceptAdmin();
      await other.sendTransaction({ to: await escrow.getAddress(), value: ONE_ETHER });

      await attacker.withdrawSurplusToSelf();

      expect(await attacker.revertReason()).to.equal("Reentrancy blocked.");
      expect(await attacker.payouts()).to.equal(1n);
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);
    });
  });

  describe("surplus", function () {
    it("lets the admin withdraw coin that is not an open deposit", async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      await other.sendTransaction({ to: await escrow.getAddress(), value: ONE_ETHER });

      expect(await escrow.outstanding()).to.equal(ONE_ETHER);
      expect(await ethers.provider.getBalance(escrow)).to.equal(ONE_ETHER * 2n);

      await expect(empiya.withdrawSurplus(admin.address)).to.changeEtherBalances(
        ethers,
        [admin, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );

      const { transaction } = await latestTransaction(empiya, seller);
      await expect(empiya.connect(seller).withdraw(0, transaction.transactionNumber)).to.changeEtherBalances(
        ethers,
        [seller, escrow],
        [ONE_ETHER, -ONE_ETHER],
      );
      expect(await ethers.provider.getBalance(escrow)).to.equal(0n);
    });

    it("treats coin forced into the escrow without receive() as surplus", async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });
      const escrowAddress = await escrow.getAddress();
      await ethers.provider.send("hardhat_setBalance", [escrowAddress, ethers.toQuantity(ONE_ETHER * 3n)]);

      await expect(empiya.withdrawSurplus(admin.address)).to.changeEtherBalances(
        ethers,
        [admin, escrow],
        [ONE_ETHER * 2n, -ONE_ETHER * 2n],
      );
      expect(await ethers.provider.getBalance(escrow)).to.equal(await escrow.outstanding());
    });

    it("rejects a surplus withdrawal when every coin is owed", async function () {
      await empiya.connect(seller).deposit({ value: ONE_ETHER });

      await expect(empiya.withdrawSurplus(admin.address)).to.be.revertedWith("No surplus.");
    });

    it("keeps outstanding equal to unsettled deposits across varied amounts and outcomes", async function () {
      const largeAmount = 1n << 200n;
      await ethers.provider.send("hardhat_setBalance", [
        seller.address,
        ethers.toQuantity(largeAmount + ethers.parseEther("2000")),
      ]);
      const deposits = [
        { signer: seller, amount: 1n, key: 0 },
        { signer: seller, amount: ethers.parseEther("1000"), key: 1 },
        { signer: seller, amount: largeAmount, key: 2 },
        { signer: buyer, amount: 2n, key: 0 },
      ];

      async function expectAccountingInvariant() {
        let openTotal = 0n;
        for (const signer of [seller, buyer]) {
          const transactions = await empiya.connect(signer).getUserTransactions();
          for (const transaction of transactions) {
            if (transaction.status === Status.Open || transaction.status === Status.Processing) {
              openTotal += transaction.amount;
            }
          }
        }
        expect(await escrow.outstanding()).to.equal(openTotal);
        expect(await ethers.provider.getBalance(escrow)).to.be.gte(openTotal);
      }

      for (const { signer, amount } of deposits) {
        await empiya.connect(signer).deposit({ value: amount });
        await expectAccountingInvariant();
      }

      const sellerTransactions = await empiya.connect(seller).getUserTransactions();
      await empiya.connect(seller).withdraw(0, sellerTransactions[0].transactionNumber);
      await expectAccountingInvariant();

      await empiya.connect(seller).reserve(1, sellerTransactions[1].transactionNumber, other.address);
      await expectAccountingInvariant();
      await empiya.releaseToBuyer(seller.address, 1, sellerTransactions[1].transactionNumber, other.address);
      await expectAccountingInvariant();

      await empiya.connect(seller).withdraw(2, sellerTransactions[2].transactionNumber);
      await expectAccountingInvariant();

      const buyerTransactions = await empiya.connect(buyer).getUserTransactions();
      await empiya.connect(buyer).withdraw(0, buyerTransactions[0].transactionNumber);
      await expectAccountingInvariant();
    });
  });
});
