import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.create();

const Status = { None: 0n, Pending: 1n, Settled: 2n, Refunded: 3n };
const CLAIM_DELAY = 7n * 24n * 3600n;
const DECIMALS = 6;
const ONE = ethers.parseUnits("1", DECIMALS);
const UNLIMITED = ethers.MaxUint256;
const MINED = { gasLimit: 800_000 };

async function setNextTimestamp(timestamp) {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

async function deployPayments({ decimals = DECIMALS, returnsBool = false, maxPayment = UNLIMITED, maxPending = UNLIMITED } = {}) {
  const [admin, payer, other, operator, treasury] = await ethers.getSigners();
  const token = await ethers.deployContract("MockUSDT", [decimals, returnsBool]);
  const payments = await ethers.deployContract("EmpiyaPayments", [
    await token.getAddress(),
    decimals,
    treasury.address,
    CLAIM_DELAY,
    maxPayment,
    maxPending,
  ]);

  for (const account of [admin, payer, other, operator]) {
    await token.mint(account.address, ethers.parseUnits("1000000", decimals));
    await token.connect(account).approve(await payments.getAddress(), UNLIMITED);
  }

  return { admin, payer, other, operator, treasury, token, payments, decimals };
}

describe("EmpiyaPayments", function () {
  for (const variant of [
    { name: "Ethereum USDT mock", decimals: 6, returnsBool: false },
    { name: "BSC-like USDT mock", decimals: 18, returnsBool: true },
  ]) {
    describe(variant.name, function () {
      let admin, payer, other, operator, treasury, token, payments, unit;

      beforeEach(async function () {
        ({ admin, payer, other, operator, treasury, token, payments } = await deployPayments({
          decimals: variant.decimals,
          returnsBool: variant.returnsBool,
        }));
        unit = ethers.parseUnits("1", variant.decimals);
      });

      it("pins the token, treasury and claim delay", async function () {
        expect(await payments.token()).to.equal(await token.getAddress());
        expect(await payments.TOKEN_DECIMALS()).to.equal(variant.decimals);
        expect(await payments.treasury()).to.equal(treasury.address);
        expect(await payments.CLAIM_DELAY()).to.equal(CLAIM_DELAY);
        expect(await payments.admin()).to.equal(admin.address);
        expect(await payments.operator()).to.equal(admin.address);
      });

      it("rejects a decimals mismatch at deploy", async function () {
        await expect(
          ethers.deployContract("EmpiyaPayments", [
            await token.getAddress(),
            variant.decimals === 18 ? 6 : 18,
            treasury.address,
            CLAIM_DELAY,
            unit,
            unit * 10n,
          ]),
        ).to.be.revertedWith("Token decimals mismatch.");
      });

      it("accepts a payment and settles only to the treasury", async function () {
        const paymentId = ethers.id("quote-1");
        await expect(payments.connect(payer).pay(paymentId, unit)).to.changeTokenBalances(
          ethers,
          token,
          [payer, payments],
          [-unit, unit],
        );
        const stored = await payments.getPayment(paymentId);
        expect(stored.payer).to.equal(payer.address);
        expect(stored.amount).to.equal(unit);
        expect(stored.status).to.equal(Status.Pending);
        expect(await payments.totalPending()).to.equal(unit);

        await expect(payments.settle(paymentId)).to.changeTokenBalances(
          ethers,
          token,
          [payments, treasury, payer],
          [-unit, unit, 0n],
        );
        expect((await payments.getPayment(paymentId)).status).to.equal(Status.Settled);
        expect(await payments.totalPending()).to.equal(0n);

        await expect(payments.settle(paymentId)).to.be.revertedWith("Payment is not pending.");
        await expect(payments.refund(paymentId)).to.be.revertedWith("Payment is not pending.");
      });

      it("refunds only the payer and rejects a duplicate payment id", async function () {
        const paymentId = ethers.id("quote-2");
        await payments.connect(payer).pay(paymentId, unit);
        await expect(payments.connect(payer).pay(paymentId, unit)).to.be.revertedWith("Payment id already used.");

        await expect(payments.refund(paymentId)).to.changeTokenBalances(
          ethers,
          token,
          [payments, payer, treasury],
          [-unit, unit, 0n],
        );
        expect((await payments.getPayment(paymentId)).status).to.equal(Status.Refunded);
      });

      it("lets the payer claim back only after the claim delay", async function () {
        const paymentId = ethers.id("quote-3");
        const tx = await payments.connect(payer).pay(paymentId, unit);
        const createdAt = BigInt((await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp);

        await setNextTimestamp(createdAt + CLAIM_DELAY - 1n);
        await expect(payments.connect(payer).claimBack(paymentId, MINED)).to.be.revertedWith(
          "Claim delay has not passed.",
        );

        await setNextTimestamp(createdAt + CLAIM_DELAY);
        await expect(payments.connect(other).claimBack(paymentId, MINED)).to.be.revertedWith(
          "Only the payer can claim back.",
        );
        await expect(payments.connect(payer).claimBack(paymentId)).to.changeTokenBalances(
          ethers,
          token,
          [payments, payer],
          [-unit, unit],
        );
      });

      it("lets the operator settle until the claim delay and not after a claim", async function () {
        await payments.setOperator(operator.address);
        const paymentId = ethers.id("quote-4");
        const tx = await payments.connect(payer).pay(paymentId, unit);
        const createdAt = BigInt((await ethers.provider.getBlock((await tx.wait()).blockNumber)).timestamp);

        await setNextTimestamp(createdAt + CLAIM_DELAY - 1n);
        await expect(payments.connect(operator).settle(paymentId)).to.changeTokenBalances(
          ethers,
          token,
          [payments, treasury],
          [-unit, unit],
        );
      });

      it("splits operator and admin powers and enforces limits", async function () {
        await payments.setOperator(operator.address);
        await expect(payments.connect(operator).pause()).to.emit(payments, "Paused");
        await expect(payments.connect(operator).unpause()).to.be.revertedWith(
          "Only an Admin can execute this transaction.",
        );
        await payments.unpause();
        await expect(payments.connect(operator).setPaymentLimits(1n, 1n)).to.be.revertedWith(
          "Only an Admin can execute this transaction.",
        );

        const limited = await ethers.deployContract("EmpiyaPayments", [
          await token.getAddress(),
          variant.decimals,
          treasury.address,
          CLAIM_DELAY,
          unit,
          (unit * 5n) / 2n,
        ]);
        await token.connect(payer).approve(await limited.getAddress(), UNLIMITED);
        await token.connect(other).approve(await limited.getAddress(), UNLIMITED);

        await expect(limited.connect(payer).pay(ethers.id("a"), unit + 1n)).to.be.revertedWith(
          "Payment exceeds the per-payment limit.",
        );
        await limited.connect(payer).pay(ethers.id("b"), unit);
        await limited.connect(payer).pay(ethers.id("c"), unit);
        await expect(limited.connect(other).pay(ethers.id("d"), unit / 2n + 1n)).to.be.revertedWith(
          "Payment exceeds the total pending limit.",
        );
        await limited.connect(other).pay(ethers.id("e"), unit / 2n);
      });

      it("blocks new payments while paused and keeps settle and refund open", async function () {
        const paymentId = ethers.id("quote-5");
        await payments.connect(payer).pay(paymentId, unit);
        await payments.pause();
        await expect(payments.connect(payer).pay(ethers.id("quote-6"), unit)).to.be.revertedWith(
          "New payments are paused.",
        );
        await expect(payments.settle(paymentId)).to.changeTokenBalances(
          ethers,
          token,
          [payments, treasury],
          [-unit, unit],
        );
        await payments.unpause();
      });

      it("withdraws surplus only to the treasury and rescues other tokens", async function () {
        await token.mint(await payments.getAddress(), unit);
        await expect(payments.withdrawSurplus()).to.changeTokenBalances(
          ethers,
          token,
          [payments, treasury],
          [-unit, unit],
        );

        const otherToken = await ethers.deployContract("MockUSDT", [18, true]);
        await otherToken.mint(await payments.getAddress(), unit);
        await expect(payments.rescueToken(await otherToken.getAddress(), admin.address)).to.changeTokenBalances(
          ethers,
          otherToken,
          [admin, payments],
          [unit, -unit],
        );
      });

      it("rejects a fee-on-transfer payment", async function () {
        const feeToken = await ethers.deployContract("FeeOnTransferToken");
        const feePayments = await ethers.deployContract("EmpiyaPayments", [
          await feeToken.getAddress(),
          18,
          treasury.address,
          CLAIM_DELAY,
          UNLIMITED,
          UNLIMITED,
        ]);
        await feeToken.mint(payer.address, unit * 10n);
        await feeToken.connect(payer).approve(await feePayments.getAddress(), UNLIMITED);
        await expect(feePayments.connect(payer).pay(ethers.id("fee"), unit)).to.be.revertedWith(
          "Token transfer amount mismatch.",
        );
      });
    });
  }
});
