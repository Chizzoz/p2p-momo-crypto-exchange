import { network } from "hardhat";

const { ethers, networkName } = await network.create();

const NETWORKS = {
  sepolia: { chainId: 11155111n, prefix: "SEPOLIA", decimals: 6, returnsBool: false },
  bscTestnet: { chainId: 97n, prefix: "BNB_TESTNET", decimals: 18, returnsBool: true },
};

const networkConfig = NETWORKS[networkName];
if (!networkConfig) {
  throw new Error(
    `deploy-mock-usdt is for sepolia or bscTestnet. Prefer: pnpm deploy:mock-usdt:sepolia`,
  );
}

const { chainId } = await ethers.provider.getNetwork();
if (chainId !== networkConfig.chainId) {
  throw new Error(
    `Provider chain id ${chainId} does not match expected ${networkConfig.chainId} for ${networkName}.`,
  );
}

const [deployer] = await ethers.getSigners();
const mintTo = (process.env.MOCK_USDT_MINT_TO || deployer.address)
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const mintAmount = ethers.parseUnits(process.env.MOCK_USDT_MINT_AMOUNT || "1000000", networkConfig.decimals);

console.log(`Deploying MockUSDT to ${networkName}...`);
const mock = await ethers.deployContract("MockUSDT", [networkConfig.decimals, networkConfig.returnsBool]);
await mock.waitForDeployment();
const address = await mock.getAddress();

for (const recipient of mintTo) {
  await (await mock.mint(recipient, mintAmount)).wait();
  console.log(`Minted ${ethers.formatUnits(mintAmount, networkConfig.decimals)} USDT to ${recipient}`);
}

console.log(`MockUSDT deployed to address: ${address}`);
console.log(`Decimals: ${networkConfig.decimals}`);
console.log(`Returns bool: ${networkConfig.returnsBool}`);
console.log(`Set ${networkConfig.prefix}_USDT_ADDRESS=${address}`);
console.log(`Set ${networkConfig.prefix}_USDT_DECIMALS=${networkConfig.decimals}`);
