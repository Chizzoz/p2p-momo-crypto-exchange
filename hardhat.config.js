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

const ethereumRpcUrl = process.env.ETHEREUM_RPC_URL;

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: "0.8.38",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    mainnet: httpNetwork("ETHEREUM_RPC_URL", 1, "ETHEREUM_PRIVATE_KEY"),
    sepolia: httpNetwork("SEPOLIA_RPC_URL", 11155111, "SEPOLIA_PRIVATE_KEY"),
    bsc: httpNetwork("BNB_RPC_URL", 56, "BNB_PRIVATE_KEY"),
    bscTestnet: httpNetwork("BNB_TESTNET_RPC_URL", 97, "BNB_TESTNET_PRIVATE_KEY"),
    ...(ethereumRpcUrl
      ? {
          ethereumFork: {
            type: "edr-simulated",
            chainType: "l1",
            forking: {
              url: ethereumRpcUrl,
            },
          },
        }
      : {}),
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
});
