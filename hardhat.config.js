import dotenv from "dotenv";
import hardhatToolboxMochaEthers from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import { configVariable, defineConfig } from "hardhat/config";

dotenv.config();

function httpNetwork(urlName, chainId, privateKeyName) {
  return {
    type: "http",
    chainType: "l1",
    chainId,
    url: configVariable(urlName),
    accounts: [configVariable(privateKeyName)],
  };
}

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: "0.8.38",
  networks: {
    mainnet: httpNetwork("ETHEREUM_RPC_URL", 1, "ETHEREUM_PRIVATE_KEY"),
    sepolia: httpNetwork("SEPOLIA_RPC_URL", 11155111, "SEPOLIA_PRIVATE_KEY"),
    polygon: httpNetwork("POLYGON_RPC_URL", 137, "POLYGON_PRIVATE_KEY"),
    amoy: httpNetwork("AMOY_RPC_URL", 80002, "AMOY_PRIVATE_KEY"),
    bsc: httpNetwork("BNB_RPC_URL", 56, "BNB_PRIVATE_KEY"),
    bscTestnet: httpNetwork("BNB_TESTNET_RPC_URL", 97, "BNB_TESTNET_PRIVATE_KEY"),
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
