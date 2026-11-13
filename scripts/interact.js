import { network } from "hardhat";

const CONTRACT_ENV_BY_NETWORK = {
  mainnet: "ETHEREUM_CONTRACT_ADDRESS",
  sepolia: "SEPOLIA_CONTRACT_ADDRESS",
  bsc: "BNB_CONTRACT_ADDRESS",
  bscTestnet: "BNB_TESTNET_CONTRACT_ADDRESS",
};

const { ethers, networkName } = await network.create();

const envName = CONTRACT_ENV_BY_NETWORK[networkName];
if (!envName) {
  throw new Error(
    `Network "${networkName}" is not one of the configured chains. Use deploy:ethereum, deploy:sepolia, or the optional deploy:bnb / deploy:bnb-testnet.`,
  );
}

const contractAddress = process.env[envName];
if (!contractAddress) {
  throw new Error(`Set ${envName} in .env to the EmpiyaP2P address deployed on ${networkName}.`);
}

const empiyaP2PContract = await ethers.getContractAt("EmpiyaP2P", contractAddress);

const escrowContractAddress = await empiyaP2PContract.getEscrowAddress();
console.log("The Escrow Contract Address is: " + escrowContractAddress);

console.log("Token: " + (await empiyaP2PContract.token()));
console.log("Token decimals: " + (await empiyaP2PContract.TOKEN_DECIMALS()));
console.log("Admin: " + (await empiyaP2PContract.admin()));
console.log("Operator: " + (await empiyaP2PContract.operator()));
console.log("Max deposit: " + (await empiyaP2PContract.maxDeposit()));
console.log("Max outstanding: " + (await empiyaP2PContract.maxOutstanding()));
console.log("Paused: " + (await empiyaP2PContract.paused()));

console.log("Fetching arbitrator...");
const arbitrator = await empiyaP2PContract.getOwner();
console.log("The Arbitrator account is: " + arbitrator);
