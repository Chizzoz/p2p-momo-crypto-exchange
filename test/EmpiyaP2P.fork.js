import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkName } = await network.create();

const RESERVATION_TIMEOUT = 3600n;
const FORK_ENABLED = Boolean(process.env.ETHEREUM_RPC_URL && process.env.ETHEREUM_USDT_ADDRESS);

describe("EmpiyaP2P Ethereum fork", function () {
  before(function () {
    if (!FORK_ENABLED || networkName !== "ethereumFork") {
      this.skip();
    }
  });

  it("deposits, reserves, and releases against native Tether USD₮", async function () {
    const tokenAddress = process.env.ETHEREUM_USDT_ADDRESS;
    // Native Ethereum USDT often omits a bool return; do not require one in the ABI.
    const token = await ethers.getContractAt(
      [
        "function decimals() view returns (uint8)",
        "function balanceOf(address) view returns (uint256)",
        "function approve(address,uint256)",
        "function transfer(address,uint256)",
      ],
      tokenAddress,
    );
    const decimals = Number(await token.decimals());
    expect(decimals).to.equal(Number(process.env.ETHEREUM_USDT_DECIMALS || "6"));

    const [admin, seller, buyer] = await ethers.getSigners();
    const unit = ethers.parseUnits("1", decimals);
    const empiya = await ethers.deployContract("EmpiyaP2P", [
      tokenAddress,
      decimals,
      RESERVATION_TIMEOUT,
      unit * 10n,
      unit * 100n,
    ]);

    // The fork test expects the first seller signer to already hold USDT on the forked chain.
    const sellerBalance = await token.balanceOf(seller.address);
    if (sellerBalance < unit) {
      this.skip();
    }

    await token.connect(seller).approve(await empiya.getAddress(), unit);
    await empiya.connect(seller).deposit(unit);
    const [txn] = await empiya.connect(seller).getUserTransactions();
    await empiya.connect(seller).reserve(0, txn.transactionNumber, buyer.address);
    const reserved = await empiya.connect(seller).getUserTransaction(0);

    await expect(
      empiya.releaseToBuyer(seller.address, 0, txn.transactionNumber, buyer.address, reserved.reservationId),
    ).to.changeTokenBalances(token, [buyer, await empiya.getEscrowAddress()], [unit, -unit]);
  });
});
