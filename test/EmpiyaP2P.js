import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const Status = { Open: 0n, Processing: 1n, Complete: 2n, Cancelled: 3n };
const RESERVATION_TIMEOUT = 3600n;
const DECIMALS = 6;
const ONE = ethers.parseUnits("1", DECIMALS);
const UNLIMITED = ethers.MaxUint256;
const MINED = { gasLimit: 800_000 };

async function blockTimestamp(tx) {
  const receipt = await tx.wait();
  return BigInt((await ethers.provider.getBlock(receipt.blockNumber)).timestamp);
}

async function setNextTimestamp(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

async function deployFixture({ decimals = DECIMALS, returnsBool = false, maxDeposit = UNLIMITED, maxOutstanding = UNLIMITED } = {}) {
  const [admin, seller, buyer, other, operator] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDT", [decimals, returnsBool]);
  const empiya = await ethers.deployContract("EmpiyaP2P", [
    await token.getAddress(),
    decimals,
    RESERVATION_TIMEOUT,
    maxDeposit,
    maxOutstanding,
  ]);
  const escrow = await ethers.getContractAt("Escrow", await empiya.getEscrowAddress());

  for (const account of [admin, seller, buyer, other, operator]) {
    await token.mint(account.address, ethers.parseUnits("1000000", decimals));
    await token.connect(account).approve(await empiya.getAddress(), UNLIMITED);
  }

  return { admin, seller, buyer, other, operator, token, empiya, escrow, decimals };
}

async function latestTransaction(empiya, signer) {
  const transactions = await empiya.connect(signer).getUserTransactions();
  const key = transactions.length - 1;
  return { key, transaction: transactions[key] };
}

describe("EmpiyaP2P", function () {
  for (const variant of [
    { name: "Ethereum USDT mock (6 decimals, no return)", decimals: 6, returnsBool: false },
    { name: "BSC-like USDT mock (18 decimals, returns bool)", decimals: 18, returnsBool: true },
  ]) {
    describe(variant.name, function () {
      let admin, seller, buyer, other, operator, token, empiya, escrow, unit;

      beforeEach(async function () {
        ({ admin, seller, buyer, other, operator, token, empiya, escrow } = await deployFixture({
          decimals: variant.decimals,
          returnsBool: variant.returnsBool,
        }));
        unit = ethers.parseUnits("1", variant.decimals);
      });

      async function deposit(signer = seller, amount = unit) {
        await empiya.connect(signer).deposit(amount);
        return latestTransaction(empiya, signer);
      }

      it("pins the token and decimals and makes the deployer admin and operator", async function () {
        expect(await empiya.token()).to.equal(await token.getAddress());
        expect(await empiya.TOKEN_DECIMALS()).to.equal(variant.decimals);
        expect(await empiya.admin()).to.equal(admin.address);
        expect(await empiya.operator()).to.equal(admin.address);
        expect(await escrow.token()).to.equal(await token.getAddress());
        expect(await empiya.getOwner()).to.equal(await empiya.getAddress());
      });

      it("rejects a decimals mismatch at deploy", async function () {
        await expect(
          ethers.deployContract("EmpiyaP2P", [
            await token.getAddress(),
            variant.decimals === 18 ? 6 : 18,
            RESERVATION_TIMEOUT,
            unit,
            unit * 10n,
          ]),
        ).to.be.revertedWith("Token decimals mismatch.");
      });

      it("locks USDT on deposit and returns it on withdraw", async function () {
        await expect(empiya.connect(seller).deposit(unit)).to.changeTokenBalances(
          ethers,
          token,
          [seller, escrow],
          [-unit, unit],
        );
        const { key, transaction } = await latestTransaction(empiya, seller);
        expect(transaction.status).to.equal(Status.Open);
        expect(transaction.amount).to.equal(unit);
        expect(await escrow.outstanding()).to.equal(unit);

        await expect(empiya.connect(seller).withdraw(key, transaction.transactionNumber)).to.changeTokenBalances(
          ethers,
          token,
          [seller, escrow],
          [unit, -unit],
        );
        expect(await escrow.outstanding()).to.equal(0n);
      });

      it("rejects a deposit without approval and a fee-on-transfer token", async function () {
        await token.connect(seller).approve(await empiya.getAddress(), 0);
        await expect(empiya.connect(seller).deposit(unit)).to.be.revert(ethers);

        const feeToken = await ethers.deployContract("FeeOnTransferToken");
        const feeEmpiya = await ethers.deployContract("EmpiyaP2P", [
          await feeToken.getAddress(),
          18,
          RESERVATION_TIMEOUT,
          UNLIMITED,
          UNLIMITED,
        ]);
        await feeToken.mint(seller.address, unit * 10n);
        await feeToken.connect(seller).approve(await feeEmpiya.getAddress(), UNLIMITED);
        await expect(feeEmpiya.connect(seller).deposit(unit)).to.be.revertedWith("Token transfer amount mismatch.");
      });

      it("names a buyer with a reservation id and lets only the operator release or refund", async function () {
        const { key, transaction } = await deposit();
        const tx = await empiya.connect(seller).reserve(key, transaction.transactionNumber, buyer.address);
        const reservedAt = await blockTimestamp(tx);
        const reserved = await empiya.connect(seller).getUserTransaction(key);
        expect(reserved.status).to.equal(Status.Processing);
        expect(reserved.reservationId).to.equal(1n);
        await expect(tx)
          .to.emit(escrow, "Reserved")
          .withArgs(seller.address, buyer.address, key, transaction.transactionNumber, reservedAt + RESERVATION_TIMEOUT, 1n);

        await expect(
          empiya.connect(seller).releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
        ).to.be.revertedWith("Only an Operator can execute this transaction.");

        await expect(
          empiya.releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
        ).to.changeTokenBalances(ethers, token, [buyer, seller, escrow], [unit, 0n, -unit]);
      });

      it("depositAndReserve deposits and names the buyer in one call", async function () {
        const tx = await empiya.connect(seller).depositAndReserve(unit, buyer.address);
        const reservedAt = await blockTimestamp(tx);
        const { key, transaction } = await latestTransaction(empiya, seller);
        expect(transaction.status).to.equal(Status.Processing);
        expect(transaction.recipient).to.equal(buyer.address);
        expect(transaction.reservationId).to.equal(1n);
        await expect(tx)
          .to.emit(escrow, "Reserved")
          .withArgs(seller.address, buyer.address, key, transaction.transactionNumber, reservedAt + RESERVATION_TIMEOUT, 1n);
      });

      it("rejects release and refund with a stale reservation id after re-reserve", async function () {
        const { key, transaction } = await deposit();
        await empiya.connect(seller).reserve(key, transaction.transactionNumber, buyer.address);
        await setNextTimestamp((await ethers.provider.getBlock("latest")).timestamp + Number(RESERVATION_TIMEOUT));
        await empiya.connect(seller).reserve(key, transaction.transactionNumber, other.address);
        const renewed = await empiya.connect(seller).getUserTransaction(key);
        expect(renewed.reservationId).to.equal(2n);

        await expect(
          empiya.releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
        ).to.be.revertedWith("Reservation does not match.");
        await expect(
          empiya.refundSeller(seller.address, key, transaction.transactionNumber, 1n),
        ).to.be.revertedWith("Reservation does not match.");

        await expect(
          empiya.releaseToBuyer(seller.address, key, transaction.transactionNumber, other.address, 2n),
        ).to.changeTokenBalances(ethers, token, [other, buyer, escrow], [unit, 0n, -unit]);
      });

      it("lets the admin release after the window while Processing, and the seller reclaim at the boundary", async function () {
        const { key, transaction } = await deposit();
        const reservedAt = await blockTimestamp(
          await empiya.connect(seller).reserve(key, transaction.transactionNumber, buyer.address),
        );

        await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT - 1n);
        await expect(empiya.connect(seller).withdraw(key, transaction.transactionNumber, MINED)).to.be.revertedWith(
          "This deposit is reserved for a buyer.",
        );

        const snapshot = await ethers.provider.send("evm_snapshot", []);
        await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
        await expect(
          empiya.releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
        ).to.changeTokenBalances(ethers, token, [buyer, escrow], [unit, -unit]);

        await ethers.provider.send("evm_revert", [snapshot]);
        await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
        await expect(empiya.connect(seller).withdraw(key, transaction.transactionNumber)).to.changeTokenBalances(
          ethers,
          token,
          [seller, escrow],
          [unit, -unit],
        );
      });

      it("rejects the token address as a buyer and gives the admin and buyer no reserve path", async function () {
        const { key, transaction } = await deposit();
        await expect(
          empiya.connect(seller).reserve(key, transaction.transactionNumber, await token.getAddress()),
        ).to.be.revertedWith("Invalid address input.");
        for (const caller of [admin, buyer]) {
          await expect(
            empiya.connect(caller).reserve(key, transaction.transactionNumber, buyer.address),
          ).to.be.revertedWith("Transaction does not exist.");
        }
      });

      it("splits operator and admin powers", async function () {
        await empiya.setOperator(operator.address);
        expect(await empiya.operator()).to.equal(operator.address);

        const { key, transaction } = await deposit();
        await empiya.connect(seller).reserve(key, transaction.transactionNumber, buyer.address);

        await expect(empiya.connect(operator).pause()).to.emit(empiya, "Paused").withArgs(operator.address);
        await expect(empiya.connect(operator).unpause()).to.be.revertedWith(
          "Only an Admin can execute this transaction.",
        );
        await empiya.unpause();

        await expect(
          empiya.connect(admin).releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
        ).to.be.revertedWith("Only an Operator can execute this transaction.");
        await expect(
          empiya.connect(operator).releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
        ).to.changeTokenBalances(ethers, token, [buyer, escrow], [unit, -unit]);

        await expect(empiya.connect(operator).setDepositLimits(1n, 1n)).to.be.revertedWith(
          "Only an Admin can execute this transaction.",
        );
        await expect(empiya.connect(operator).setOperator(other.address)).to.be.revertedWith(
          "Only an Admin can execute this transaction.",
        );
      });

      it("recovers surplus USDT and other tokens, and ignores forced native coin", async function () {
        await deposit();
        await token.mint(await escrow.getAddress(), unit);
        await expect(empiya.withdrawSurplus(admin.address)).to.changeTokenBalances(
          ethers,
          token,
          [admin, escrow],
          [unit, -unit],
        );

        const otherToken = await ethers.deployContract("MockUSDT", [18, true]);
        await otherToken.mint(await escrow.getAddress(), unit);
        await expect(empiya.rescueToken(await otherToken.getAddress(), admin.address)).to.changeTokenBalances(
          ethers,
          otherToken,
          [admin, escrow],
          [unit, -unit],
        );
        await expect(empiya.rescueToken(await token.getAddress(), admin.address)).to.be.revertedWith(
          "Cannot rescue the escrow token.",
        );

        // Escrow has no receive/fallback, so plain ETH transfers revert. Forced ETH via
        // selfdestruct is still ignored by accounting because surplus is token-based.
        await expect(other.sendTransaction({ to: await escrow.getAddress(), value: 1n })).to.be.revert(ethers);
        expect(await escrow.outstanding()).to.equal(unit);
      });

      it("enforces deposit caps exactly", async function () {
        const limited = await ethers.deployContract("EmpiyaP2P", [
          await token.getAddress(),
          variant.decimals,
          RESERVATION_TIMEOUT,
          unit,
          (unit * 5n) / 2n,
        ]);
        await token.connect(seller).approve(await limited.getAddress(), UNLIMITED);
        await token.connect(buyer).approve(await limited.getAddress(), UNLIMITED);
        await token.connect(other).approve(await limited.getAddress(), UNLIMITED);

        await expect(limited.connect(seller).deposit(unit + 1n)).to.be.revertedWith(
          "Deposit exceeds the per-deposit limit.",
        );
        await limited.connect(seller).deposit(unit);
        await limited.connect(buyer).deposit(unit);
        await expect(limited.connect(other).deposit(unit / 2n + 1n)).to.be.revertedWith(
          "Deposit exceeds the total escrow limit.",
        );
        await limited.connect(other).deposit(unit / 2n);
      });

      it("rejects an escrow swap for a different token and recovers retired surplus", async function () {
        const otherToken = await ethers.deployContract("MockUSDT", [variant.decimals, variant.returnsBool]);
        const wrongEscrow = await ethers.deployContract("Escrow", [
          await empiya.getAddress(),
          await otherToken.getAddress(),
          RESERVATION_TIMEOUT,
        ]);
        await expect(empiya.setEscrowContract(await wrongEscrow.getAddress())).to.be.revertedWith(
          "Escrow code does not match.",
        );

        const replacement = await ethers.deployContract("Escrow", [
          await empiya.getAddress(),
          await token.getAddress(),
          RESERVATION_TIMEOUT,
        ]);
        await empiya.setEscrowContract(await replacement.getAddress());
        expect(await empiya.getEscrowAddress()).to.equal(await replacement.getAddress());

        await token.mint(await escrow.getAddress(), unit);
        await expect(
          empiya.withdrawRetiredEscrowSurplus(await escrow.getAddress(), admin.address),
        ).to.changeTokenBalances(ethers, token, [admin, escrow], [unit, -unit]);
      });

      it("blocks deposits and reservations while paused", async function () {
        const first = await deposit();
        await empiya.pause();
        await expect(empiya.connect(seller).deposit(unit)).to.be.revertedWith(
          "New deposits and reservations are paused.",
        );
        await expect(
          empiya.connect(seller).reserve(first.key, first.transaction.transactionNumber, buyer.address),
        ).to.be.revertedWith("New deposits and reservations are paused.");
        await empiya.unpause();
        await empiya.connect(seller).reserve(first.key, first.transaction.transactionNumber, buyer.address);
      });
    });
  }

  describe("pause exits and blacklisted buyer", function () {
    it("keeps withdraw, release, refund and expiry working while paused", async function () {
      const { admin, seller, buyer, other, token, empiya, escrow } = await deployFixture();
      for (let i = 0; i < 4; i++) {
        await empiya.connect(seller).deposit(ONE);
      }
      const numbers = (await empiya.connect(seller).getUserTransactions()).map((t) => t.transactionNumber);
      await empiya.connect(seller).reserve(1, numbers[1], buyer.address);
      await empiya.connect(seller).reserve(2, numbers[2], buyer.address);
      const last = await empiya.connect(seller).reserve(3, numbers[3], buyer.address);
      const reservedAt = await blockTimestamp(last);

      await empiya.pause();
      await expect(empiya.connect(seller).deposit(ONE)).to.be.revertedWith(
        "New deposits and reservations are paused.",
      );
      await expect(empiya.connect(seller).reserve(0, numbers[0], buyer.address)).to.be.revertedWith(
        "New deposits and reservations are paused.",
      );

      await expect(empiya.connect(seller).withdraw(0, numbers[0])).to.changeTokenBalances(
        ethers,
        token,
        [seller, escrow],
        [ONE, -ONE],
      );
      await expect(
        empiya.releaseToBuyer(seller.address, 1, numbers[1], buyer.address, 1n),
      ).to.changeTokenBalances(ethers, token, [buyer, escrow], [ONE, -ONE]);
      await expect(empiya.refundSeller(seller.address, 2, numbers[2], 2n)).to.changeTokenBalances(
        ethers,
        token,
        [seller, escrow],
        [ONE, -ONE],
      );

      await setNextTimestamp(reservedAt + RESERVATION_TIMEOUT);
      await expect(empiya.connect(seller).expireReservation(seller.address, 3, numbers[3]))
        .to.emit(escrow, "ReservationExpired")
        .withArgs(seller.address, buyer.address, 3, numbers[3]);
      await expect(empiya.connect(seller).withdraw(3, numbers[3])).to.changeTokenBalances(
        ethers,
        token,
        [seller, escrow],
        [ONE, -ONE],
      );

      await empiya.unpause();
      await empiya.connect(seller).deposit(ONE);
    });

    it("keeps a reserved deposit when the buyer is blacklisted, then refunds the seller", async function () {
      const { seller, buyer, token, empiya, escrow } = await deployFixture();
      await empiya.connect(seller).deposit(ONE);
      const { key, transaction } = await latestTransaction(empiya, seller);
      await empiya.connect(seller).reserve(key, transaction.transactionNumber, buyer.address);
      await token.addBlackList(buyer.address);

      await expect(
        empiya.releaseToBuyer(seller.address, key, transaction.transactionNumber, buyer.address, 1n),
      ).to.be.revert(ethers);
      expect((await empiya.connect(seller).getUserTransaction(key)).status).to.equal(Status.Processing);

      await expect(
        empiya.refundSeller(seller.address, key, transaction.transactionNumber, 1n),
      ).to.changeTokenBalances(ethers, token, [seller, escrow], [ONE, -ONE]);
    });

    it("blocks reentrancy through a callback token during withdraw", async function () {
      const [admin, seller] = await ethers.getSigners();
      const token = await ethers.deployContract("ReentrantToken");
      const empiya = await ethers.deployContract("EmpiyaP2P", [
        await token.getAddress(),
        18,
        RESERVATION_TIMEOUT,
        UNLIMITED,
        UNLIMITED,
      ]);
      const escrow = await ethers.getContractAt("Escrow", await empiya.getEscrowAddress());
      await token.mint(seller.address, ONE * 2n);
      await token.mint(await token.getAddress(), ONE);
      await token.connect(seller).approve(await empiya.getAddress(), UNLIMITED);
      // The token contract also approves EmpiyaP2P so a nested deposit would succeed without the guard.
      await ethers.provider.send("hardhat_impersonateAccount", [await token.getAddress()]);
      await ethers.provider.send("hardhat_setBalance", [await token.getAddress(), "0x10000000000000000"]);
      const tokenSigner = await ethers.getSigner(await token.getAddress());
      await token.connect(tokenSigner).approve(await empiya.getAddress(), UNLIMITED);

      await empiya.connect(seller).deposit(ONE);
      const { key, transaction } = await latestTransaction(empiya, seller);

      await token.setReentry(
        await empiya.getAddress(),
        empiya.interface.encodeFunctionData("deposit", [1n]),
      );
      await empiya.connect(seller).withdraw(key, transaction.transactionNumber);
      expect(await token.revertReason()).to.equal("Reentrancy blocked.");
      expect(await escrow.outstanding()).to.equal(0n);
      expect(await token.callbacks()).to.equal(1n);
    });
  });
});
