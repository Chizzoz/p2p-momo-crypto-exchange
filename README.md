# e-Mpiya P2P MoMo Crypto eXchange

Smart contracts for a peer-to-peer exchange that holds **USDT** in escrow while a mobile-money payment settles off chain, plus a separate payments contract for shop and phone-number payouts funded from the platform's own fiat liquidity. This repository is the Hardhat project. The web app lives separately.

1. Frontend repository: https://github.com/Chizzoz/p2p-momo-crypto-echange-webapp
2. Demo DApp: https://p2p.oneziko.com/
3. This repository: https://github.com/Chizzoz/p2p-momo-crypto-exchange

## About the DApp

The DApp uses Hardhat, ethers.js, Alchemy, MetaMask, Etherscan, BscScan, Laravel 9, Laravel Jetstream, Inertia, React (TypeScript), Tailwind CSS, MySQL, and PawaPay (and related mobile-money APIs).

In countries such as Zambia, buying or selling crypto often requires a bank account and a Visa or Mastercard. Mobile-money accounts are more common than bank accounts. e-Mpiya lets people trade and pay through mobile money, with these contracts holding USDT until the fiat side is confirmed.

**Launch order:** Ethereum Sepolia (chain ID 11155111), then Ethereum mainnet (chain ID 1) with native Tether USD₮. BNB Smart Chain is optional later: the same contracts can deploy there with different constructor arguments, but the widely labeled “USDT” on BSC is Binance-Peg BSC-USD, not Tether-issued USD₮. The contracts are chain-agnostic: the token address and decimals are constructor arguments.

## Three services

1. **Seller lists USDT.** The seller approves USDT and calls `deposit`. A buyer requests the listing in the app. The seller accepts by calling `reserve` with the buyer's wallet. The buyer pays Kwacha into the e-Mpiya merchant account. After PawaPay confirms, the operator calls `releaseToBuyer`. The seller's pending fiat becomes withdrawable off-chain.
2. **Buyer order first.** The buyer pays Kwacha first. A seller fills the order with `depositAndReserve` in one transaction. The operator releases as soon as it sees `Reserved`.
3. **Pay a shop or phone number.** The payer calls `EmpiyaPayments.pay`. The platform pays the shop from its own fiat liquidity. After the PawaPay payout callback, the operator settles USDT to the treasury. If the payout fails, the operator refunds the payer. The payer may `claimBack` only after a long claim delay (default 7 days).

Partial fills are not supported. Each deposit is reserved whole, so sellers post lot-sized listings. In service 2 the seller deposits exactly the order amount.

## Setup

Install [pnpm](https://pnpm.io/) 11.3.0 (the version pinned in `package.json`) and Node.js 22.13 or later. This repository uses Hardhat 3.

```bash
pnpm install
cp .env.example .env
pnpm compile
pnpm test
```

`pnpm test` runs the Mocha tests and the Solidity fuzz and invariant tests on Hardhat's local network. `pnpm coverage` writes an HTML report to `coverage/html`. `pnpm deploy` and `pnpm deploy-payments` deploy to that same network with a local MockUSDT; they do not need an RPC URL or a private key.

## Networks

A public network is enabled only after its RPC URL is set in `.env`. Each network has its own deployer key.

| Network | Chain ID | Native coin for gas | RPC variable | Deploy escrow | Deploy payments |
| --- | --- | --- | --- | --- | --- |
| Ethereum | 1 | ETH | `ETHEREUM_RPC_URL` | `pnpm deploy:ethereum` | `pnpm deploy-payments:ethereum` |
| Ethereum Sepolia | 11155111 | ETH | `SEPOLIA_RPC_URL` | `pnpm deploy:sepolia` | `pnpm deploy-payments:sepolia` |
| BNB Smart Chain (optional later) | 56 | BNB | `BNB_RPC_URL` | `pnpm deploy:bnb` | `pnpm deploy-payments:bnb` |
| BNB Smart Chain testnet (optional later) | 97 | tBNB | `BNB_TESTNET_RPC_URL` | `pnpm deploy:bnb-testnet` | `pnpm deploy-payments:bnb-testnet` |

Sepolia has no official USDT. Deploy a mock first:

```bash
pnpm deploy:mock-usdt:sepolia
```

Then copy the printed address into `SEPOLIA_USDT_ADDRESS`. For an optional later BSC testnet deploy, use `pnpm deploy:mock-usdt:bnb-testnet` the same way.

### USDT caps and deploy settings

Amounts in `.env` are human USDT (for example `500`), not base units. On Ethereum, 1 USD₮ is 10^6 base units. The deploy script reads the token's `decimals()`, checks it against `<PREFIX>_USDT_DECIMALS`, and converts with `parseUnits`.

| Variable | Meaning | Example |
| --- | --- | --- |
| `ETHEREUM_USDT_ADDRESS` | Native Tether USD₮ on Ethereum | `0xdAC17F958D2ee523a2206206994597C13D831ec7` |
| `ETHEREUM_USDT_DECIMALS` | Must match `token.decimals()` | `6` |
| `ETHEREUM_MAX_DEPOSIT_USDT` | Largest single P2P listing | `500` |
| `ETHEREUM_MAX_OUTSTANDING_USDT` | Total USDT held in escrow | `5000` |
| `ETHEREUM_MAX_PAYMENT_USDT` | Largest service-3 payment | `200` |
| `ETHEREUM_MAX_PENDING_USDT` | Total unsettled service-3 payments | `2000` |
| `ETHEREUM_OPERATOR_ADDRESS` | Backend hot key for release/refund/settle | — |
| `ETHEREUM_PAYMENTS_OPERATOR_ADDRESS` | Separate hot key for EmpiyaPayments | — |
| `ETHEREUM_TREASURY_ADDRESS` | Multisig that receives settled payments | — |
| `RESERVATION_TIMEOUT_SECONDS` | Seller reclaim window (default 3600) | `3600` |
| `PAYMENT_CLAIM_DELAY_SECONDS` | Payer backstop (default 7 days) | `604800` |

The same names with the `SEPOLIA_`, `BNB_`, and `BNB_TESTNET_` prefixes apply to those networks. Optional BSC tokens use 18 decimals.

Take native USD₮ addresses from [Tether’s supported protocols](https://tether.to/en/supported-protocols/) only. Do not copy them from a chat. That page does not list USD₮ on BNB Smart Chain; the common BEP-20 “USDT” there is Binance-Peg BSC-USD (Binance-backed), not a Tether liability. Before mainnet, confirm the issuer, whether the token can freeze addresses or pause transfers, whether it supports `permit`, and how redemption works. Confirm that Safe is available on Ethereum for the admin multisig.

## Contracts

### EmpiyaP2P / Escrow

`EmpiyaP2P` is the public entry point. Users approve USDT to `EmpiyaP2P` (so an escrow swap does not strand approvals). It pulls tokens into the active `Escrow` and reverts unless the escrow's balance rose by exactly the requested amount.

- **Seller:** `deposit`, `withdraw` (Open, or after the reservation window), `reserve`, `depositAndReserve`, `expireReservation`.
- **Operator (hot key):** `releaseToBuyer`, `refundSeller`, `expireReservation`, `pause`.
- **Admin (Safe multisig):** limits, `unpause`, `setOperator`, escrow swap, surplus, `rescueToken`, two-step admin handover.

Each reservation gets a `reservationId`. `releaseToBuyer` and `refundSeller` must pass that id and the named buyer, so a late call cannot settle the wrong trade after a re-reservation.

`Reserved` carries `expiresAt` and `reservationId`. Clients should treat a reservation as expired once the current time reaches `expiresAt`, even while the stored status is still `Processing`.

### EmpiyaPayments

A separate contract for service 3. Settlement can only go to the pinned treasury or back to the payer. A compromised operator cannot redirect funds elsewhere. The worst case is a wrongful settlement to the treasury, which the platform can make whole.

- **Payer:** `pay(paymentId, amount)`, `claimBack` after `CLAIM_DELAY`.
- **Operator:** `settle`, `refund`, `pause`.
- **Admin:** limits, `unpause`, `setOperator`, surplus (to treasury only), `rescueToken`, two-step admin handover.

### Roles and monitoring

A compromised operator can release to a named buyer before fiat arrives, or refund. It cannot change settings or send USDT to an arbitrary address. Keep caps conservative and monitor `Released`, `Refunded`, `PaymentSettled`, and `PaymentRefunded`. Tether can freeze addresses; a frozen escrow or payments contract would lock every balance in it, which the code cannot prevent.

`EmpiyaP2P` emits `DepositLimitsUpdated`, `Paused`, `Unpaused`, and `OperatorUpdated`. `EmpiyaPayments` emits the matching payment events.

## Backend rules

1. Before a payment prompt, check that the deposit is `Processing`, `recipient` is the buyer's registered wallet, and enough of the window remains.
2. Pass that same wallet and the `reservationId` to `releaseToBuyer`. A revert after the window usually means the seller reclaimed first, so refund the buyer's mobile money.
3. Credit the seller only after a `Released` event whose `buyer` matches.
4. Convert between ZMW, USDT, and base units with big integers only. Round in the platform's favour: down for USDT paid to buyers, up for USDT owed by payers.
5. Credit fiat only after the `finalized` block tag, or a confirmation threshold you choose. Use more than one RPC provider.
6. Store the `chainId` with every listing, reservation, and payment.
7. For EmpiyaPayments: quote an exact USDT amount with a short expiry; wait for finality before the PawaPay payout; settle only on a verified, idempotent success callback; refund only on confirmed failure; reconcile unknown outcomes; refuse payouts near the claim-delay deadline.
8. Enforce a minimum trade size in the backend (for example 1 USDT). Sellers and payers need a little ETH for gas. Buyers who only receive USDT need none.
9. Web-app approvals should use the exact amount, or reset the allowance to 0 first, because Ethereum USDT rejects changing one non-zero allowance to another.

## Market notes

Many users in the target market may hold USDT on Tron, which these EVM contracts do not cover. Confirm where prospective users hold balances before mainnet. Payments and foreign-exchange activity may need Zambian licensing; involve counsel.

## EmpiyaP2P functions

1. `proposeAdmin` / `cancelAdminProposal` / `acceptAdmin`
2. `setOperator(address)` — `onlyAdmin`
3. `setDepositLimits(uint256, uint256)` — `onlyAdmin`; emits `DepositLimitsUpdated`
4. `pause()` — `onlyOperator`; `unpause()` — `onlyAdmin`
5. `deposit(uint256 amount)` / `depositAndReserve(uint256 amount, address buyer)`
6. `withdraw` / `reserve` / `expireReservation`
7. `releaseToBuyer(depositor, key, number, buyer, reservationId)` — `onlyOperator`
8. `refundSeller(depositor, key, number, reservationId)` — `onlyOperator`
9. `withdrawSurplus` / `withdrawRetiredEscrowSurplus` / `rescueToken` / `rescueRetiredEscrowToken`
10. Views: `getUserTransaction`, `getUserTransactions`, `getUserTransactionsPage`, `getTotalBalance`, `token`, `TOKEN_DECIMALS`, `operator`, `maxDeposit`, `maxOutstanding`, `paused`

## EmpiyaPayments functions

1. `pay(bytes32 paymentId, uint256 amount)`
2. `settle(paymentId)` / `refund(paymentId)` — `onlyOperator`
3. `claimBack(paymentId)` — payer, after `CLAIM_DELAY`
4. `setOperator` / `setPaymentLimits` / `pause` / `unpause` / admin handover
5. `withdrawSurplus` / `rescueToken`
6. `getPayment(paymentId)`

Public values include `token`, `TOKEN_DECIMALS`, `treasury`, `CLAIM_DELAY`, `maxPayment`, `maxPending`, `totalPending`, `operator`, and `paused`.
