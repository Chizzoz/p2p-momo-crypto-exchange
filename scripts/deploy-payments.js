import { network } from "hardhat";

const { ethers, networkName } = await network.create();

const LOCAL_CHAIN_ID = 31337n;
const NETWORKS = {
  mainnet: { chainId: 1n, prefix: "ETHEREUM" },
  sepolia: { chainId: 11155111n, prefix: "SEPOLIA" },
  bsc: { chainId: 56n, prefix: "BNB" },
  bscTestnet: { chainId: 97n, prefix: "BNB_TESTNET" },
};
const LOCAL_LIMITS = { MAX_PAYMENT: "200", MAX_PENDING: "2000" };
const MAX_REASONABLE_USDT = 10_000_000n;
const ERC20_METADATA_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const { chainId } = await ethers.provider.getNetwork();
const networkConfig = NETWORKS[networkName];

function requireAmount(name, value, decimals) {
  if (!value) {
    throw new Error(`Set ${name} in .env to a decimal USDT amount, for example 200.`);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a decimal USDT amount, for example 200 or 0.5.`);
  }
  const fractional = value.includes(".") ? value.split(".")[1].length : 0;
  if (fractional > decimals) {
    throw new Error(`${name}=${value} has more than ${decimals} decimal places.`);
  }
  const parsed = ethers.parseUnits(value, decimals);
  if (parsed > ethers.parseUnits(MAX_REASONABLE_USDT.toString(), decimals)) {
    throw new Error(`${name}=${value} is above ${MAX_REASONABLE_USDT} USDT; check you did not paste base units.`);
  }
  return parsed;
}

async function resolveConfig() {
  if (chainId === LOCAL_CHAIN_ID) {
    // Ethereum-like local mock: 6 decimals, no bool return (matches native Tether USD₮).
    const mock = await ethers.deployContract("MockUSDT", [6, false]);
    await mock.waitForDeployment();
    const [deployer] = await ethers.getSigners();
    await mock.mint(deployer.address, ethers.parseUnits("1000000", 6));
    console.log(`Local MockUSDT deployed to ${await mock.getAddress()}`);
    return {
      tokenAddress: await mock.getAddress(),
      decimals: 6,
      treasury: deployer.address,
      maxPayment: ethers.parseUnits(LOCAL_LIMITS.MAX_PAYMENT, 6),
      maxPending: ethers.parseUnits(LOCAL_LIMITS.MAX_PENDING, 6),
      operatorAddress: undefined,
      prefix: "LOCAL",
    };
  }

  if (!networkConfig) {
    throw new Error(`Network "${networkName}" is not configured for EmpiyaPayments deploy.`);
  }
  if (chainId !== networkConfig.chainId) {
    throw new Error(
      `Provider chain id ${chainId} does not match expected ${networkConfig.chainId} for ${networkName}.`,
    );
  }

  const prefix = networkConfig.prefix;
  const rawTokenAddress = process.env[`${prefix}_USDT_ADDRESS`];
  const rawTreasury = process.env[`${prefix}_TREASURY_ADDRESS`];
  if (!rawTokenAddress) {
    throw new Error(`Set ${prefix}_USDT_ADDRESS in .env.`);
  }
  if (!rawTreasury) {
    throw new Error(`Set ${prefix}_TREASURY_ADDRESS in .env to the multisig treasury.`);
  }
  const tokenAddress = ethers.getAddress(rawTokenAddress);
  const treasury = ethers.getAddress(rawTreasury);
  if (treasury === ethers.ZeroAddress) {
    throw new Error(`Set ${prefix}_TREASURY_ADDRESS in .env to the multisig treasury.`);
  }
  if ((await ethers.provider.getCode(tokenAddress)) === "0x") {
    throw new Error(`${prefix}_USDT_ADDRESS=${tokenAddress} has no contract code.`);
  }

  const expectedDecimals = Number(process.env[`${prefix}_USDT_DECIMALS`]);
  if (!Number.isInteger(expectedDecimals) || expectedDecimals < 0 || expectedDecimals > 255) {
    throw new Error(`Set ${prefix}_USDT_DECIMALS to the token's decimals, for example 6.`);
  }

  const token = new ethers.Contract(tokenAddress, ERC20_METADATA_ABI, ethers.provider);
  const decimals = Number(await token.decimals());
  if (decimals !== expectedDecimals) {
    throw new Error(
      `${prefix}_USDT_DECIMALS=${expectedDecimals} does not match token.decimals()=${decimals}.`,
    );
  }

  let symbol = "USDT";
  try {
    symbol = await token.symbol();
  } catch {
    // ignore
  }
  console.log(`Token: ${symbol} at ${tokenAddress} (${decimals} decimals)`);

  const maxPayment = requireAmount(
    `${prefix}_MAX_PAYMENT_USDT`,
    process.env[`${prefix}_MAX_PAYMENT_USDT`],
    decimals,
  );
  const maxPending = requireAmount(
    `${prefix}_MAX_PENDING_USDT`,
    process.env[`${prefix}_MAX_PENDING_USDT`],
    decimals,
  );
  if (maxPayment === 0n || maxPayment > maxPending) {
    throw new Error("MAX_PAYMENT_USDT must be greater than zero and no larger than MAX_PENDING_USDT.");
  }

  return {
    tokenAddress,
    decimals,
    treasury,
    maxPayment,
    maxPending,
    operatorAddress: process.env[`${prefix}_PAYMENTS_OPERATOR_ADDRESS`]
      ? ethers.getAddress(process.env[`${prefix}_PAYMENTS_OPERATOR_ADDRESS`])
      : undefined,
    prefix,
  };
}

const claimDelay = BigInt(process.env.PAYMENT_CLAIM_DELAY_SECONDS || String(7 * 24 * 3600));
if (claimDelay === 0n || claimDelay > 90n * 24n * 3600n) {
  throw new Error("PAYMENT_CLAIM_DELAY_SECONDS must be between 1 and 7776000 (90 days).");
}

const { tokenAddress, decimals, treasury, maxPayment, maxPending, operatorAddress, prefix } =
  await resolveConfig();

console.log(`Deploying EmpiyaPayments to ${networkName}...`);

const payments = await ethers.deployContract("EmpiyaPayments", [
  tokenAddress,
  decimals,
  treasury,
  claimDelay,
  maxPayment,
  maxPending,
]);
await payments.waitForDeployment();

const address = await payments.getAddress();
const [deployer] = await ethers.getSigners();

if ((await payments.admin()) !== deployer.address) {
  throw new Error("Deployer is not the admin.");
}
if ((await payments.token()) !== tokenAddress) {
  throw new Error("The deployed token does not match.");
}
if ((await payments.treasury()) !== treasury) {
  throw new Error("The deployed treasury does not match.");
}
if (Number(await payments.TOKEN_DECIMALS()) !== decimals) {
  throw new Error("The deployed TOKEN_DECIMALS does not match.");
}
if ((await payments.CLAIM_DELAY()) !== claimDelay) {
  throw new Error("The deployed CLAIM_DELAY does not match.");
}
if ((await payments.maxPayment()) !== maxPayment || (await payments.maxPending()) !== maxPending) {
  throw new Error("The deployed payment limits do not match.");
}

if (operatorAddress) {
  await (await payments.setOperator(operatorAddress)).wait();
  if ((await payments.operator()) !== operatorAddress) {
    throw new Error(`Failed to set payments operator to ${operatorAddress}.`);
  }
}

console.log(`EmpiyaPayments deployed to address: ${address}`);
console.log(`Admin: ${await payments.admin()}`);
console.log(`Operator: ${await payments.operator()}`);
console.log(`Treasury: ${treasury}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Claim delay: ${claimDelay} seconds`);
console.log(
  `Limit per payment: ${ethers.formatUnits(maxPayment, decimals)} USDT (${maxPayment} base units)`,
);
console.log(
  `Limit on total pending: ${ethers.formatUnits(maxPending, decimals)} USDT (${maxPending} base units)`,
);
console.log(
  `Constructor arguments for verify: ${tokenAddress} ${decimals} ${treasury} ${claimDelay} ${maxPayment} ${maxPending}`,
);
console.log(
  "Before accepting public payments, call proposeAdmin with a Safe multisig, then call acceptAdmin from that Safe.",
);
if (!operatorAddress && chainId !== LOCAL_CHAIN_ID) {
  console.log(
    `Optionally set ${prefix}_PAYMENTS_OPERATOR_ADDRESS and redeploy, or call setOperator with the backend hot key.`,
  );
}
