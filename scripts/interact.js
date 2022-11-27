const API_KEY = process.env.API_KEY;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// For Truffle
// const contract = require("./build/contracts/EmpiyaP2P.sol/EmpiyaP2P.json");

// For Hardhat
const contract = require("../artifacts/contracts/EmpiyaP2P.sol/EmpiyaP2P.json");

// Provider
const alchemyProvider = new ethers.providers.AlchemyProvider(network="maticmum", API_KEY);

// Signer
const signer = new ethers.Wallet(PRIVATE_KEY, alchemyProvider);

// Contract
const empiyaP2PContract = new ethers.Contract(CONTRACT_ADDRESS, contract.abi, signer);

async function main() {
  const escrowContractAddress = await empiyaP2PContract.getEscrowAddress();
  console.log("The Escrow Contract Address is: " + escrowContractAddress);

  console.log("Fetching Admin...");
  const tx = await empiyaP2PContract.getOwner();
  // await tx.wait();
  console.log("The Arbitrator account is: " + tx);
}
main();