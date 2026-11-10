# e-Mpiya P2P MoMo Crypto eXchange

Smart contracts for a peer-to-peer exchange that holds a chain's native coin in escrow while a mobile-money payment settles off chain. This repository is the Hardhat project. The web app lives separately.

1. Frontend repository: https://github.com/Chizzoz/p2p-momo-crypto-echange-webapp
2. Demo DApp: https://p2p.oneziko.com/
3. This repository: https://github.com/Chizzoz/p2p-momo-crypto-exchange

## About the DApp

The DApp uses Hardhat, ethers.js, Alchemy, MetaMask, Etherscan, Polygonscan, BscScan, Laravel 9, Laravel Jetstream, Inertia, React (TypeScript), Tailwind CSS, MySQL, the 543 Konse Konse merchant API, and the MTN MoMo API.

In countries such as Zambia, buying or selling crypto often requires a bank account and a Visa or Mastercard. Mobile-money accounts are more common than bank accounts. e-Mpiya lets two people trade through mobile money, with these contracts holding the crypto until the payment is confirmed.

A seller lists an amount of the chain's native coin. `deposit` moves that amount from the seller into the escrow. It stays there until the seller withdraws it or the platform releases it to a buyer. The buyer pays in mobile money into the e-Mpiya merchant wallet, which credits the seller's balance. After that payment is confirmed, the platform releases the listed amount from the escrow to the buyer's wallet.

The same contracts deploy to Ethereum, Polygon, and BNB Smart Chain. The escrow holds ETH on Ethereum, POL on Polygon, and BNB on BNB Smart Chain.

## Setup

Install [pnpm](https://pnpm.io/) 11.3.0 (the version pinned in `package.json`) and Node.js 22.13 or later. This repository uses Hardhat 3.

```bash
pnpm install
cp .env.example .env
pnpm compile
pnpm test
```

`pnpm test` runs the Mocha tests in `test/EmpiyaP2P.js` and the Solidity fuzz and invariant tests in `test/EmpiyaP2P.t.sol` on Hardhat's local network. `pnpm coverage` runs both and writes an HTML report to `coverage/html`. `pnpm deploy` deploys to that same network and does not need an RPC URL, a private key, or deposit limits.

## Networks

A public network is enabled only after its RPC URL is set in `.env`. Paste the full URL, including the API key. Each network has its own deployer key: `ETHEREUM_PRIVATE_KEY`, `SEPOLIA_PRIVATE_KEY`, `POLYGON_PRIVATE_KEY`, `AMOY_PRIVATE_KEY`, `BNB_PRIVATE_KEY`, and `BNB_TESTNET_PRIVATE_KEY`. A key must be 64 hex characters, and the `0x` prefix is optional. Use a different key on each network.

| Network | Chain ID | Native coin | RPC variable | Deploy | Interact |
| --- | --- | --- | --- | --- | --- |
| Ethereum | 1 | ETH | `ETHEREUM_RPC_URL` | `pnpm deploy:ethereum` | `pnpm interact:ethereum` |
| Ethereum Sepolia | 11155111 | ETH | `SEPOLIA_RPC_URL` | `pnpm deploy:sepolia` | `pnpm interact:sepolia` |
| Polygon | 137 | POL | `POLYGON_RPC_URL` | `pnpm deploy:polygon` | `pnpm interact:polygon` |
| Polygon Amoy | 80002 | POL | `AMOY_RPC_URL` | `pnpm deploy:amoy` | `pnpm interact:amoy` |
| BNB Smart Chain | 56 | BNB | `BNB_RPC_URL` | `pnpm deploy:bnb` | `pnpm interact:bnb` |
| BNB Smart Chain testnet | 97 | BNB | `BNB_TESTNET_RPC_URL` | `pnpm deploy:bnb-testnet` | `pnpm interact:bnb-testnet` |

Example RPC URLs:

```text
https://eth-mainnet.g.alchemy.com/v2/your_key
https://eth-sepolia.g.alchemy.com/v2/your_key
https://polygon-mainnet.g.alchemy.com/v2/your_key
https://polygon-amoy.g.alchemy.com/v2/your_key
https://bnb-mainnet.g.alchemy.com/v2/your_key
https://bnb-testnet.g.alchemy.com/v2/your_key
```

A deploy reads the timeout and the target network's two deposit limits from `.env`:

| Network | Max single deposit | Max outstanding | Native coin |
| --- | --- | --- | --- |
| Ethereum | `ETHEREUM_MAX_DEPOSIT=2.00` | `ETHEREUM_MAX_OUTSTANDING=35.00` | ETH |
| Ethereum Sepolia | `SEPOLIA_MAX_DEPOSIT=2.00` | `SEPOLIA_MAX_OUTSTANDING=35.00` | ETH |
| Polygon | `POLYGON_MAX_DEPOSIT=10000` | `POLYGON_MAX_OUTSTANDING=200000` | POL |
| Polygon Amoy | `AMOY_MAX_DEPOSIT=10000` | `AMOY_MAX_OUTSTANDING=200000` | POL |
| BNB Smart Chain | `BNB_MAX_DEPOSIT=9.00` | `BNB_MAX_OUTSTANDING=170.00` | BNB |
| BNB Smart Chain testnet | `BNB_TESTNET_MAX_DEPOSIT=9.00` | `BNB_TESTNET_MAX_OUTSTANDING=170.00` | BNB |

`RESERVATION_TIMEOUT_SECONDS` controls how long a reservation locks the seller's deposit before the seller can reclaim it. It must be between 1 second and 30 days and defaults to `3600`. Deposit limits are specified in the target network's native coin; the example values above are initial caps, not equivalent-value limits across chains. Review them against expected usage and acceptable exposure before deploying. Public deployments require both limit variables for that network. Local Hardhat deployment uses its built-in limits of 1 and 10 native coins. The admin can change the deployed limits later with `setDepositLimits`, but changing `.env` does not change an existing contract.

Each deploy creates a new `EmpiyaP2P` contract, and that contract creates its own `Escrow`. Copy the printed `EmpiyaP2P` address into the matching variable before running the interact script:

| Network | Address variable |
| --- | --- |
| Ethereum | `ETHEREUM_CONTRACT_ADDRESS` |
| Ethereum Sepolia | `SEPOLIA_CONTRACT_ADDRESS` |
| Polygon | `POLYGON_CONTRACT_ADDRESS` |
| Polygon Amoy | `AMOY_CONTRACT_ADDRESS` |
| BNB Smart Chain | `BNB_CONTRACT_ADDRESS` |
| BNB Smart Chain testnet | `BNB_TESTNET_CONTRACT_ADDRESS` |

`pnpm interact:*` calls `getEscrowAddress` and `getOwner`. Both are `onlyAdmin`, and the script signs with that network's configured private key, so it works only while that key's account is the current admin. After admin moves to a multisig, the script will no longer work; use a multisig-compatible call path for these admin-only getters.

Verification uses `ETHERSCAN_API_KEY`. Hardhat sends it to the Etherscan API, which covers Ethereum, Polygon, and BNB Smart Chain. Pass the three constructor arguments that the deploy printed: the window in seconds, then the two limits in wei.

```bash
pnpm exec hardhat verify --network sepolia <EmpiyaP2P address> 3600 <max deposit in wei> <max outstanding in wei>
```

## Contracts

`EmpiyaP2P` is the public entry point. The deployer becomes `admin`. Its constructor deploys `Escrow` and sets `EmpiyaP2P` as the only account that can move funds inside `Escrow`.

Users call `EmpiyaP2P`. `deposit` locks the native coin and records an `Open` transaction. While it is `Open`, the seller can `withdraw` it (status `Cancelled`). A seller has no call that sends a deposit to another address.

A trade starts when the seller calls `reserve` with the buyer's wallet address. The deposit becomes `Processing`, the buyer is stored as `recipient`, and the seller cannot withdraw it or name another buyer until the reservation window ends. The window is `RESERVATION_TIMEOUT` seconds, set at deploy. The `Reserved` event carries `expiresAt`, the time the window ends.

After the buyer's mobile-money payment reaches the merchant wallet, the admin calls `releaseToBuyer` with the buyer's address. It pays only when that address is the buyer the seller named (status `Complete`). If the trade fails, the admin calls `refundSeller`, which pays only the seller (status `Cancelled`).

The window decides when the seller may take the deposit back. It does not end the admin's ability to settle. From `reservedAt + RESERVATION_TIMEOUT`, the seller can `withdraw`, `reserve` for another buyer, or call `expireReservation`. Each of these clears the earlier buyer and emits `ReservationExpired`. Until the seller does one of them, the stored status stays `Processing` and the admin can still release or refund. If a late release and a seller's reclaim are sent at the same time, the one that is mined first takes effect and the other reverts.

What the backend must do:

1. Before starting a payment prompt, read the deposit and check that `status` is `Processing`, `recipient` is the buyer's registered wallet, and enough of the window remains for the payment and the release to finish.
2. Pass that same registered wallet to `releaseToBuyer`. A revert after the window usually means the seller reclaimed first, so refund the buyer's mobile money.
3. Credit the seller's balance only after a `Released` event whose `buyer` is the registered wallet.
4. Show a reservation as expired once the current time reaches `expiresAt`, even while the stored status is still `Processing`. The EVM does not change storage when time passes.

The admin cannot send a deposit to an address the seller did not name. A compromised admin key could still release a reserved deposit to its named buyer before payment, or refund the seller after the buyer paid. If the admin key is lost or unavailable, each seller still regains their deposit after the window. The admin should be a multisig.

### Launch controls

`maxDeposit` limits one deposit and `maxOutstanding` limits the total of unsettled deposits. Both are checked on `deposit` only, and coin sent or forced into the escrow does not count. Lowering a limit leaves existing deposits untouched. `pause` stops `deposit` and `reserve`. `withdraw`, `releaseToBuyer`, `refundSeller`, `expireReservation`, and `withdrawSurplus` keep working during a pause, so a pause cannot hold anyone's coin.

`EmpiyaP2P` emits an event for each of these changes, which monitoring should watch: `DepositLimitsUpdated(maxDeposit, maxOutstanding)`, `Paused(admin)`, and `Unpaused(admin)`. `DepositLimitsUpdated` is also emitted at deploy with the initial limits.

The deployer key is the admin only until handoff. Before public deposits, call `proposeAdmin` with a multisig address, then call `acceptAdmin` from that multisig. `setEscrowContract` can run only while no deposit is outstanding. It accepts only escrow instances whose runtime code hash matches the escrow created by this `EmpiyaP2P` constructor, which means the same arbitrator and the same reservation window. This allows a same-code replacement with a fresh transaction list; it does not allow escrow logic upgrades. To change escrow logic, deploy a new `EmpiyaP2P` and migrate users.

After a swap, the `EmpiyaP2P` getters read only the active escrow. Earlier transactions stay in the retired escrow. A frontend or indexer that needs full history should follow `EscrowUpdated` events and read each retired escrow's `userTransactions` mapping.

Deploy prints the `EmpiyaP2P` address, the admin, the escrow address, the reservation window, the two limits, and the constructor arguments for `hardhat verify`. The script stops with an error if the deployer is not admin, the escrow arbitrator is not `EmpiyaP2P`, or the deployed window and limits differ from the settings.

### EmpiyaP2P functions

1. `proposeAdmin(address _admin)` — `onlyAdmin`; sets the pending admin
2. `cancelAdminProposal()` — `onlyAdmin`; clears the pending admin
3. `acceptAdmin()` — only the pending admin becomes admin
4. `setDepositLimits(uint256 newMaxDeposit, uint256 newMaxOutstanding)` — `onlyAdmin`; `newMaxDeposit` must be above zero and no larger than `newMaxOutstanding`; emits `DepositLimitsUpdated`
5. `pause()` and `unpause()` — `onlyAdmin`; a pause blocks `deposit` and `reserve` only; emit `Paused` and `Unpaused`
6. `getCaller()` — `onlyAdmin`
7. `getOwner()` — `onlyAdmin`; returns the Escrow arbitrator, which is this contract
8. `getUserBalance()` — returns the caller's native-coin balance
9. `getEscrowAddress()` — `onlyAdmin`
10. `setEscrowContract(Escrow escrowContractAccount)` — `onlyAdmin`; only when nothing is owed and the new escrow has the constructor-pinned runtime code hash and names this contract as arbitrator. The old escrow is marked retired and cannot be reactivated; any remaining or subsequently forced surplus can be recovered with `withdrawRetiredEscrowSurplus`. Transaction history stays in the old escrow.
11. `getTotalBalance()` — `onlyAdmin`
12. `getUserTransaction(uint256 transactionKey)`
13. `getUserTransactionByUser(address userAddress, uint256 transactionKey)`
14. `getUserTransactions()` — whole list; use the paged call for long lists
15. `getUserTransactionsPage(uint256 offset, uint256 limit)`
16. `getTransactionsByUser(address userAddress)` — `onlyAdmin`
17. `deposit()` — payable; locks `msg.value` in Escrow; rejected while paused or above either limit
18. `withdraw(uint256 transactionKey, bytes32 transactionNumber)` — seller; `Open` deposits, and reserved deposits once the window has ended
19. `reserve(uint256 transactionKey, bytes32 transactionNumber, address payable buyer)` — seller; `Open` to `Processing`; rejects the zero address, this contract, and the escrow; rejected while paused
20. `expireReservation(address depositor, uint256 transactionKey, bytes32 transactionNumber)` — the depositor or the admin, once the window has ended; reopens the listing and clears the named buyer
21. `releaseToBuyer(address depositor, uint256 transactionKey, bytes32 transactionNumber, address buyer)` — `onlyAdmin`; pays the named buyer while the deposit is `Processing` and `buyer` matches; emits `Released`
22. `refundSeller(address depositor, uint256 transactionKey, bytes32 transactionNumber)` — `onlyAdmin`; pays the seller while the deposit is `Processing`; emits `Refunded`
23. `withdrawSurplus(address payable to)` — `onlyAdmin`; sends only the coin above the sum of unsettled deposits in the active escrow
24. `withdrawRetiredEscrowSurplus(Escrow retiredEscrow, address payable to)` — `onlyAdmin`; recovers surplus sent or forced to a retired escrow after replacement

Public values: `admin`, `pendingAdmin`, `RESERVATION_TIMEOUT`, `maxDeposit`, `maxOutstanding`, `paused`, `escrowCodeHash`, and `retiredEscrows(address)`.

`transactionNumber` is a public identifier, not a secret. Who may move a deposit is decided by the caller's address. Status values are `0` Open, `1` Processing (reserved for a buyer), `2` Complete, and `3` Cancelled.
