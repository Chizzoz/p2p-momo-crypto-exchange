# e-Mpiya P2P MoMo Crypto eXchange

Smart contracts for a peer-to-peer exchange that holds **USDT** in escrow while a mobile-money payment settles off chain, plus a separate payments contract for shop and phone-number payouts funded from the platform's own fiat liquidity.

This repository is the **Hardhat** project. The web app lives separately.

**Hackathon judges:** see [HACKATHON_DISCLOSURE.md](./HACKATHON_DISCLOSURE.md) for pre-existing vs new work.

1. Frontend repository: https://github.com/Chizzoz/p2p-momo-crypto-echange-webapp  
2. Demo DApp: https://p2p.oneziko.com/  
3. This repository: https://github.com/Chizzoz/p2p-momo-crypto-exchange  

## About the DApp

In markets such as Zambia, buying or selling crypto often requires a bank account and a Visa or Mastercard. Mobile-money accounts are more common. e-Mpiya lets people trade and pay through MoMo, with these contracts holding USDT until the fiat side is confirmed.

| Layer | Stack |
| --- | --- |
| Contracts (this repo) | Hardhat 3, Solidity 0.8.38, ethers.js, OpenZeppelin-style patterns, Alchemy / public RPC |
| Webapp (sibling repo) | Laravel 13, Jetstream, Inertia 2, React (TypeScript), Tailwind, MetaMask, PawaPay, Dokploy/FrankenPHP |

**Launch order:** Ethereum Sepolia (chain ID `11155111`), then Ethereum mainnet (chain ID `1`) with native Tether USD₮. BNB Smart Chain is optional later — the same contracts can deploy there with different constructor arguments, but the widely labeled “USDT” on BSC is Binance-Peg BSC-USD, not Tether-issued USD₮. Token address and decimals are constructor arguments (chain-agnostic).

## Three services (product names)

1. **Sell USDT.** Seller approves USDT and calls `deposit`. Buyer requests the listing in the app. Seller accepts with on-chain `reserve(buyer)`. Buyer pays MoMo via PawaPay. After confirmation, the operator calls `releaseToBuyer`. The webapp credits the seller’s **per-currency fiat wallet** (MoMo withdraw is manual).
2. **Sell MoMo.** MoMo seller pays fiat first (PawaPay collect) and opens an offer. A USDT counterparty fills with `depositAndReserve` in one transaction. Operator releases when it sees `Reserved`.
3. **Pay with USDT.** Payer calls `EmpiyaPayments.pay`. Platform pays the recipient from fiat liquidity via PawaPay. On payout success the operator `settle`s USDT to treasury; on failure it `refund`s. Payer may `claimBack` only after a long claim delay (default 7 days).

Partial fills are not supported. Each deposit is reserved whole (lot-sized listings).

## Current Sepolia demo deploy

| Contract | Address |
| --- | --- |
| Mock USDT (6 decimals) | `0x2A51b5d05bbbDAB5A5746ed35C1A7708f7ADe6eD` |
| EmpiyaP2P | `0x76E69285D4dED0E5959F219014D4a64fc612d9Be` |
| EmpiyaPayments | `0x10C38D531d6C93E16ABc2f34b091a8E07B77C0de` |

Copy these into the webapp as `VITE_*` **build args** and `EMPIYA_*` runtime env after any redeploy. Mint test USDT with `MockUSDT.mint` (or `pnpm deploy:mock-usdt:sepolia` for a fresh token + mint).

## Setup

Install [pnpm](https://pnpm.io/) 11.3.0 (pinned in `package.json`) and Node.js 22.13+.

```bash
pnpm install
cp .env.example .env
pnpm compile
pnpm test
```

`pnpm test` runs Mocha plus Solidity fuzz/invariant tests on Hardhat’s local network. `pnpm coverage` writes `coverage/html`. Local `pnpm deploy` / `pnpm deploy-payments` use an in-process MockUSDT (no RPC key required).

## Networks

A public network is enabled only after its RPC URL is set in `.env`. Each network has its own deployer key.

| Network | Chain ID | RPC variable | Deploy escrow | Deploy payments |
| --- | --- | --- | --- | --- |
| Ethereum | 1 | `ETHEREUM_RPC_URL` | `pnpm deploy:ethereum` | `pnpm deploy-payments:ethereum` |
| Ethereum Sepolia | 11155111 | `SEPOLIA_RPC_URL` | `pnpm deploy:sepolia` | `pnpm deploy-payments:sepolia` |
| BNB Smart Chain (optional) | 56 | `BNB_RPC_URL` | `pnpm deploy:bnb` | `pnpm deploy-payments:bnb` |
| BNB testnet (optional) | 97 | `BNB_TESTNET_RPC_URL` | `pnpm deploy:bnb-testnet` | `pnpm deploy-payments:bnb-testnet` |

Sepolia has no official USDT. Deploy a mintable mock first:

```bash
pnpm deploy:mock-usdt:sepolia
# optional: MOCK_USDT_MINT_TO=0x…,0x… MOCK_USDT_MINT_AMOUNT=1000
```

Then set `SEPOLIA_USDT_ADDRESS` and redeploy EmpiyaP2P / EmpiyaPayments.

### USDT caps and deploy settings

Amounts in `.env` are human USDT (e.g. `500`), not base units. Deploy scripts check `token.decimals()` against `<PREFIX>_USDT_DECIMALS` and convert with `parseUnits`.

| Variable | Meaning |
| --- | --- |
| `<PREFIX>_USDT_ADDRESS` | ERC-20 used as USDT |
| `<PREFIX>_USDT_DECIMALS` | Must match `token.decimals()` (6 on Ethereum/Sepolia mock) |
| `<PREFIX>_MAX_DEPOSIT_USDT` / `_MAX_OUTSTANDING_USDT` | EmpiyaP2P caps |
| `<PREFIX>_MAX_PAYMENT_USDT` / `_MAX_PENDING_USDT` | EmpiyaPayments caps |
| `<PREFIX>_OPERATOR_ADDRESS` | Hot key for P2P release/refund |
| `<PREFIX>_PAYMENTS_OPERATOR_ADDRESS` | Hot key for settle/refund (can match P2P operator) |
| `<PREFIX>_TREASURY_ADDRESS` | Receives settled payments |
| `RESERVATION_TIMEOUT_SECONDS` | Seller reclaim window (default `3600`) |
| `PAYMENT_CLAIM_DELAY_SECONDS` | Payer `claimBack` delay (default `604800`) |

Prefixes: `ETHEREUM_`, `SEPOLIA_`, `BNB_`, `BNB_TESTNET_`.

Take mainnet USD₮ only from [Tether’s supported protocols](https://tether.to/en/supported-protocols/). That page does not list USD₮ on BNB Smart Chain.

## Contracts

### EmpiyaP2P / Escrow

Public entry point. Users approve USDT to `EmpiyaP2P`. Tokens move into the active `Escrow`; the call reverts unless escrow balance rises by exactly the requested amount.

- **Seller:** `deposit`, `withdraw`, `reserve`, `depositAndReserve`, `expireReservation`
- **Operator:** `releaseToBuyer`, `refundSeller`, `expireReservation`, `pause`
- **Admin:** limits, `unpause`, `setOperator`, escrow swap, surplus/rescue, two-step admin handover

Each reservation has a `reservationId`. `releaseToBuyer` / `refundSeller` require that id and the named buyer so a late call cannot settle the wrong trade.

Status enum: `Open` → `Processing` (reserved) → `Complete` / `Cancelled`. Clients should treat a reservation as expired at `expiresAt` even while status is still `Processing`.

### EmpiyaPayments

Service 3. Settlement can only go to the pinned treasury or back to the payer.

- **Payer:** `pay(paymentId, amount)`, `claimBack` after `CLAIM_DELAY`
- **Operator:** `settle`, `refund`, `pause`
- **Admin:** limits, `unpause`, `setOperator`, surplus (treasury only), rescue, admin handover

### Roles and monitoring

A compromised operator can release to a named buyer early or refund; it cannot redirect USDT to an arbitrary address or change caps. Monitor `Released`, `Refunded`, `PaymentSettled`, `PaymentRefunded`. Tether (or a mock that freezes) can lock balances — contracts cannot prevent that.

## Backend rules (webapp)

1. Before MoMo collect, confirm deposit is `Processing`, `recipient` is the buyer, and enough of the reservation window remains.
2. Pass the same wallet + `reservationId` to `releaseToBuyer`.
3. Credit seller **fiat wallet** only after a matching `Released` event (do not auto-disburse MoMo on release).
4. Use big-integer math for fiat ↔ USDT ↔ base units; round in the platform’s favour. Format PawaPay amounts to the **provider’s allowed decimals** (never Eloquent `decimal:8` padding).
5. Prefer finalized / multi-RPC confirmation before irreversible MoMo moves.
6. Store `chainId` with every listing, reservation, and payment.
7. EmpiyaPayments: exact USDT quote; wait for finality before payout; settle only on verified success; **refund immediately on REJECTED/FAILED** payout (payer `claimBack` remains the delayed fallback).
8. Enforce a minimum trade size in the backend. Sellers/payers need gas ETH; pure USDT receivers do not.
9. Ethereum-style USDT: reset allowance to `0` before setting a new non-zero amount.

## Market notes

Many users may hold USDT on Tron, which these EVM contracts do not cover. Confirm where users hold balances before mainnet. Payments/FX activity may need Zambian licensing — involve counsel.

## EmpiyaP2P functions (index)

1. `proposeAdmin` / `cancelAdminProposal` / `acceptAdmin`
2. `setOperator` — `onlyAdmin`
3. `setDepositLimits` — `onlyAdmin`
4. `pause` — `onlyOperator`; `unpause` — `onlyAdmin`
5. `deposit` / `depositAndReserve`
6. `withdraw` / `reserve` / `expireReservation`
7. `releaseToBuyer` / `refundSeller` — `onlyOperator`
8. Surplus / rescue helpers
9. Views: `getUserTransaction`, `getUserTransactions`, `getUserTransactionsPage`, `getTotalBalance`, `token`, `TOKEN_DECIMALS`, `operator`, limits, `paused`

## EmpiyaPayments functions (index)

1. `pay(paymentId, amount)`
2. `settle` / `refund` — `onlyOperator`
3. `claimBack` — payer, after `CLAIM_DELAY`
4. `setOperator` / `setPaymentLimits` / `pause` / `unpause` / admin handover
5. `withdrawSurplus` / `rescueToken`
6. `getPayment(paymentId)`

Public values include `token`, `TOKEN_DECIMALS`, `treasury`, `CLAIM_DELAY`, `maxPayment`, `maxPending`, `totalPending`, `operator`, `paused`.
