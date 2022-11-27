require('dotenv').config();
require("@nomiclabs/hardhat-ethers");
require("@nomicfoundation/hardhat-toolbox");
require("@nomiclabs/hardhat-etherscan");

const { API_URL, API_KEY, API_URL_MATIC, API_KEY_MATIC, PRIVATE_KEY, POLYGONSCAN_API_KEY } = process.env;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.17",
  networks: {
    mumbai: {
      url: API_URL + API_KEY,
      accounts: [`0x${PRIVATE_KEY}`]
    },
    matic: {
      url: API_URL_MATIC + API_KEY_MATIC,
      accounts: [`0x${PRIVATE_KEY}`]
    },
  },
  etherscan: {
     apiKey: {
      polygonMumbai: POLYGONSCAN_API_KEY
     }
  }
};
