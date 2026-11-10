import { network } from "hardhat";

const CONTRACT_ENV_BY_NETWORK = {
  mainnet: "ETHEREUM_CONTRACT_ADDRESS",
  sepolia: "SEPOLIA_CONTRACT_ADDRESS",
  polygon: "POLYGON_CONTRACT_ADDRESS",
  amoy: "AMOY_CONTRACT_ADDRESS",
  bsc: "BNB_CONTRACT_ADDRESS",
  bscTestnet: "BNB_TESTNET_CONTRACT_ADDRESS",
};

const { ethers, networkName } = await network.create();

const envName = CONTRACT_ENV_BY_NETWORK[networkName];
if (!envName) {
  throw new Error(
    `Network "${networkName}" is not one of the configured chains. Use deploy:ethereum, deploy:sepolia, deploy:polygon, deploy:amoy, deploy:bnb, or deploy:bnb-testnet.`
  );
}

const contractAddress = process.env[envName];
if (!contractAddress) {
  throw new Error(`Set ${envName} in .env to the EmpiyaP2P address deployed on ${networkName}.`);
}

const empiyaP2PContract = await ethers.getContractAt("EmpiyaP2P", contractAddress);

const escrowContractAddress = await empiyaP2PContract.getEscrowAddress();
console.log("The Escrow Contract Address is: " + escrowContractAddress);

console.log("Fetching Admin...");
const arbitrator = await empiyaP2PContract.getOwner();
console.log("The Arbitrator account is: " + arbitrator);
