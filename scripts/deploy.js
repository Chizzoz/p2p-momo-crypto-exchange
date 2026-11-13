import { network } from "hardhat";

const { ethers, networkName } = await network.create();

const LOCAL_CHAIN_ID = 31337n;
const NETWORKS = {
  mainnet: { chainId: 1n, prefix: "ETHEREUM" },
  sepolia: { chainId: 11155111n, prefix: "SEPOLIA" },
  bsc: { chainId: 56n, prefix: "BNB" },
  bscTestnet: { chainId: 97n, prefix: "BNB_TESTNET" },
};
const LOCAL_LIMITS = { MAX_DEPOSIT: "1000", MAX_OUTSTANDING: "10000" };
const MAX_REASONABLE_USDT = 10_000_000n;
const ERC20_METADATA_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const { chainId } = await ethers.provider.getNetwork();
const networkConfig = NETWORKS[networkName];

function requireAmount(name, value, decimals) {
  if (!value) {
    throw new Error(`Set ${name} in .env to a decimal USDT amount, for example 500.`);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`${name} must be a decimal USDT amount, for example 500 or 0.5.`);
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

async function resolveTokenAndLimits() {
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
      maxDeposit: ethers.parseUnits(LOCAL_LIMITS.MAX_DEPOSIT, 6),
      maxOutstanding: ethers.parseUnits(LOCAL_LIMITS.MAX_OUTSTANDING, 6),
      operatorAddress: undefined,
      prefix: "LOCAL",
    };
  }

  if (!networkConfig) {
    throw new Error(`Network "${networkName}" is not configured for EmpiyaP2P deploy.`);
  }
  if (chainId !== networkConfig.chainId) {
    throw new Error(
      `Provider chain id ${chainId} does not match expected ${networkConfig.chainId} for ${networkName}.`,
    );
  }

  const prefix = networkConfig.prefix;
  const rawTokenAddress = process.env[`${prefix}_USDT_ADDRESS`];
  if (!rawTokenAddress) {
    throw new Error(`Set ${prefix}_USDT_ADDRESS in .env to the USDT contract on ${networkName}.`);
  }
  const tokenAddress = ethers.getAddress(rawTokenAddress);
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
    // Some tokens omit symbol(); the decimals check is enough to proceed.
  }
  console.log(`Token: ${symbol} at ${tokenAddress} (${decimals} decimals)`);

  const maxDeposit = requireAmount(
    `${prefix}_MAX_DEPOSIT_USDT`,
    process.env[`${prefix}_MAX_DEPOSIT_USDT`],
    decimals,
  );
  const maxOutstanding = requireAmount(
    `${prefix}_MAX_OUTSTANDING_USDT`,
    process.env[`${prefix}_MAX_OUTSTANDING_USDT`],
    decimals,
  );
  if (maxDeposit === 0n || maxDeposit > maxOutstanding) {
    throw new Error("MAX_DEPOSIT_USDT must be greater than zero and no larger than MAX_OUTSTANDING_USDT.");
  }

  return {
    tokenAddress,
    decimals,
    maxDeposit,
    maxOutstanding,
    operatorAddress: process.env[`${prefix}_OPERATOR_ADDRESS`]
      ? ethers.getAddress(process.env[`${prefix}_OPERATOR_ADDRESS`])
      : undefined,
    prefix,
  };
}

const reservationTimeout = BigInt(process.env.RESERVATION_TIMEOUT_SECONDS || "3600");
if (reservationTimeout === 0n || reservationTimeout > 30n * 24n * 3600n) {
  throw new Error("RESERVATION_TIMEOUT_SECONDS must be between 1 and 2592000 (30 days).");
}

const { tokenAddress, decimals, maxDeposit, maxOutstanding, operatorAddress, prefix } =
  await resolveTokenAndLimits();

console.log(`Deploying EmpiyaP2P to ${networkName}...`);

const empiyaP2P = await ethers.deployContract("EmpiyaP2P", [
  tokenAddress,
  decimals,
  reservationTimeout,
  maxDeposit,
  maxOutstanding,
]);
await empiyaP2P.waitForDeployment();

const address = await empiyaP2P.getAddress();
const [deployer] = await ethers.getSigners();
const admin = await empiyaP2P.admin();
const escrowAddress = await empiyaP2P.getEscrowAddress();
const arbitrator = await empiyaP2P.getOwner();

if (admin !== deployer.address) {
  throw new Error(`Deployer ${deployer.address} is not the admin (${admin}).`);
}
if (arbitrator !== address) {
  throw new Error(`Escrow arbitrator ${arbitrator} is not EmpiyaP2P (${address}).`);
}
if ((await empiyaP2P.token()) !== tokenAddress) {
  throw new Error("The deployed token does not match the configured USDT address.");
}
if (Number(await empiyaP2P.TOKEN_DECIMALS()) !== decimals) {
  throw new Error("The deployed TOKEN_DECIMALS does not match.");
}
if ((await empiyaP2P.RESERVATION_TIMEOUT()) !== reservationTimeout) {
  throw new Error("The deployed reservation window does not match RESERVATION_TIMEOUT_SECONDS.");
}
if ((await empiyaP2P.maxDeposit()) !== maxDeposit || (await empiyaP2P.maxOutstanding()) !== maxOutstanding) {
  throw new Error(`The deployed deposit limits do not match the limits configured for ${networkName}.`);
}

if (operatorAddress) {
  await (await empiyaP2P.setOperator(operatorAddress)).wait();
  if ((await empiyaP2P.operator()) !== operatorAddress) {
    throw new Error(`Failed to set operator to ${operatorAddress}.`);
  }
}

console.log(`Empiya P2P Contract deployed to address: ${address}`);
console.log(`Admin: ${admin}`);
console.log(`Operator: ${await empiyaP2P.operator()}`);
console.log(`Escrow: ${escrowAddress}`);
console.log(`Token: ${tokenAddress}`);
console.log(`Token decimals: ${decimals}`);
console.log(`Reservation window: ${reservationTimeout} seconds`);
console.log(
  `Limit per deposit: ${ethers.formatUnits(maxDeposit, decimals)} USDT (${maxDeposit} base units)`,
);
console.log(
  `Limit on total deposits: ${ethers.formatUnits(maxOutstanding, decimals)} USDT (${maxOutstanding} base units)`,
);
console.log(
  `Constructor arguments for verify: ${tokenAddress} ${decimals} ${reservationTimeout} ${maxDeposit} ${maxOutstanding}`,
);
console.log(
  "Before accepting public deposits, call proposeAdmin with a Safe multisig, then call acceptAdmin from that Safe.",
);
if (!operatorAddress && chainId !== LOCAL_CHAIN_ID) {
  console.log(
    `Optionally set ${prefix}_OPERATOR_ADDRESS and redeploy, or call setOperator with the backend hot key.`,
  );
}
