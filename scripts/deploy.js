import { network } from "hardhat";

const { ethers, networkName } = await network.create();

const LOCAL_CHAIN_ID = 31337n;
const LOCAL_LIMITS = { MAX_DEPOSIT: "1", MAX_OUTSTANDING: "10" };
const LIMIT_ENV_BY_NETWORK = {
  mainnet: { MAX_DEPOSIT: "ETHEREUM_MAX_DEPOSIT", MAX_OUTSTANDING: "ETHEREUM_MAX_OUTSTANDING" },
  sepolia: { MAX_DEPOSIT: "SEPOLIA_MAX_DEPOSIT", MAX_OUTSTANDING: "SEPOLIA_MAX_OUTSTANDING" },
  polygon: { MAX_DEPOSIT: "POLYGON_MAX_DEPOSIT", MAX_OUTSTANDING: "POLYGON_MAX_OUTSTANDING" },
  amoy: { MAX_DEPOSIT: "AMOY_MAX_DEPOSIT", MAX_OUTSTANDING: "AMOY_MAX_OUTSTANDING" },
  bsc: { MAX_DEPOSIT: "BNB_MAX_DEPOSIT", MAX_OUTSTANDING: "BNB_MAX_OUTSTANDING" },
  bscTestnet: { MAX_DEPOSIT: "BNB_TESTNET_MAX_DEPOSIT", MAX_OUTSTANDING: "BNB_TESTNET_MAX_OUTSTANDING" },
};
const { chainId } = await ethers.provider.getNetwork();

// Limits are amounts of the target chain's native coin. Public networks require explicit per-network values.
function coinLimit(limitType) {
  const envName = LIMIT_ENV_BY_NETWORK[networkName]?.[limitType];
  if (chainId !== LOCAL_CHAIN_ID && !envName) {
    throw new Error(`No deposit-limit environment variables are configured for ${networkName}.`);
  }
  const name = chainId === LOCAL_CHAIN_ID ? limitType : envName;
  const value = chainId === LOCAL_CHAIN_ID ? LOCAL_LIMITS[limitType] : process.env[name];
  if (!value) {
    throw new Error(`Set ${name} in .env to an amount of the native coin on ${networkName}.`);
  }
  return ethers.parseEther(value);
}

const reservationTimeout = BigInt(process.env.RESERVATION_TIMEOUT_SECONDS || "3600");
const maxDeposit = coinLimit("MAX_DEPOSIT");
const maxOutstanding = coinLimit("MAX_OUTSTANDING");

if (reservationTimeout === 0n || reservationTimeout > 30n * 24n * 3600n) {
  throw new Error("RESERVATION_TIMEOUT_SECONDS must be between 1 and 2592000 (30 days).");
}
if (maxDeposit === 0n || maxDeposit > maxOutstanding) {
  throw new Error("The per-network max deposit must be greater than zero and no larger than max outstanding.");
}

console.log(`Deploying EmpiyaP2P to ${networkName}...`);

const empiyaP2P = await ethers.deployContract("EmpiyaP2P", [reservationTimeout, maxDeposit, maxOutstanding]);
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
if ((await empiyaP2P.RESERVATION_TIMEOUT()) !== reservationTimeout) {
  throw new Error("The deployed reservation window does not match RESERVATION_TIMEOUT_SECONDS.");
}
if ((await empiyaP2P.maxDeposit()) !== maxDeposit || (await empiyaP2P.maxOutstanding()) !== maxOutstanding) {
  throw new Error(`The deployed deposit limits do not match the limits configured for ${networkName}.`);
}

console.log(`Empiya P2P Contract deployed to address: ${address}`);
console.log(`Admin: ${admin}`);
console.log(`Escrow: ${escrowAddress}`);
console.log(`Reservation window: ${reservationTimeout} seconds`);
console.log(`Limit per deposit: ${ethers.formatEther(maxDeposit)}`);
console.log(`Limit on total deposits: ${ethers.formatEther(maxOutstanding)}`);
console.log(`Constructor arguments for verify: ${reservationTimeout} ${maxDeposit} ${maxOutstanding}`);
console.log(
  "Before accepting public deposits, call proposeAdmin with a multisig, then call acceptAdmin from that multisig.",
);
