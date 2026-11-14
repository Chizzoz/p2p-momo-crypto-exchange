# Hackathon disclosure — smart contracts

**Repository:** [Chizzoz/p2p-momo-crypto-exchange](https://github.com/Chizzoz/p2p-momo-crypto-exchange)  
**Companion webapp:** [Chizzoz/p2p-momo-crypto-echange-webapp](https://github.com/Chizzoz/p2p-momo-crypto-echange-webapp)  
**Product:** e-Mpiya — P2P USDT ↔ mobile money (MoMo) exchange

This document discloses **pre-existing work**, what we **built on**, what **changed**, and what is **new**, plus how functional the contracts were **before vs now**.

---

## 1. What was existing (before this build period)

The contracts repo was **not** started from a blank template during the hackathon. Prior work already included:

| Area | What already existed |
| --- | --- |
| Product concept | P2P MoMo ↔ crypto exchange; USDT held on-chain while fiat settles off-chain |
| Core escrow | `EmpiyaP2P.sol` — deposit, reserve, release/refund/expire paths, escrow helper, admin/operator roles |
| Payments rail | `EmpiyaPayments.sol` — pay / settle / refund / claimBack for shop/phone payouts |
| Tooling | Hardhat project, compile/test/coverage, deploy + interact scripts |
| Tokens | `MockUSDT` (and related test tokens) for Sepolia / local testing |
| Config | Multi-network `.env` layout (Sepolia first; Ethereum / optional BSC prefixes), deposit & payment caps, reservation / claim delays |
| Docs | README describing three services (Sell USDT, Sell MoMo / buyer-first, Pay with USDT) |

**Baseline intent of the prior contracts:** on-chain source of truth for USDT custody; an **operator** key authorized to release or refund after off-chain MoMo confirmation. Fiat collection/payout itself was always designed to live in the **webapp + PawaPay**, not inside Solidity.

---

## 2. What we are building on

We treat the existing Solidity design as the **protocol foundation** and continue on that design rather than replacing it:

1. **EmpiyaP2P** — seller deposits USDT; reservation locks a buyer; operator `releaseToBuyer` / `refundSeller`.
2. **EmpiyaPayments** — payer locks USDT; operator `settle` to treasury or `refund` after MoMo payout outcome.
3. **Constructor-bound USDT** — token address + decimals fixed at deploy (chain-agnostic).
4. **Role split** — admin (governance) vs operator (hot backend key); treasury for settled payments.

Third-party building blocks (not claimed as our invention): OpenZeppelin patterns, Hardhat/ethers, Tether-like ERC-20 behaviors in mocks, public RPCs / Alchemy, Etherscan.

---

## 3. What changed (refactor / hardening of existing)

Relative to the earlier bedrock / early Hardhat state, the contracts side was **refactored and hardened**, including:

- Clearer **USDT-centric** deposit model (no native ETH value on deposit).
- Stronger **admin / operator / escrow** lifecycle (propose/accept admin, operator setters, escrow retirement/rescue paths as documented in-repo).
- **Deploy scripts** that read human USDT limits from env, verify `decimals()`, and wire operator/treasury addresses per network.
- **Mock USDT deploy + mint** path for Sepolia (`deploy-mock-usdt`), because Sepolia has no official Tether.
- Network focus narrowed to **Ethereum Sepolia → Ethereum mainnet**, with BNB kept optional and documented as a different “USDT” reality.
- Test / typegen updates so MockUSDT and deployments stay consistent with Hardhat 3 + pnpm.

These are **improvements to the existing protocol**, not a greenfield rewrite of the product idea.

---

## 4. What is new (this period / product completion on-chain)

New or newly operationalized on the contracts side for the live demo path:

| Item | Notes |
| --- | --- |
| Sepolia MockUSDT deploy used by the demo | Mintable test USDT for seller/buyer/treasury wallets |
| Fresh EmpiyaP2P + EmpiyaPayments deploys bound to that MockUSDT | Required after leaving the non-mintable public “Test Tether” |
| Operator alignment for Payments | `setOperator` so the same hot wallet can settle pay/redeem in the webapp |
| Env / address book updates | Current Sepolia addresses documented for the webapp `VITE_*` / `EMPIYA_*` wiring |

The **webapp** owns the new MoMo orchestration (PawaPay deposits/payouts, webhooks, operator sidecar). This contracts repo supplies the **settlement surface** those flows call.

---

## 5. How functional it was before vs now

### Before

| Capability | Status |
| --- | --- |
| Compile / unit & fuzz tests | Largely available in-repo |
| Local deploy with MockUSDT | Available via Hardhat scripts |
| Sepolia deploy | Possible, but often paired with hard-to-fund public test USDT |
| End-to-end MoMo buy/sell | **Not complete** — needed webapp + operator + PawaPay |
| Pay with USDT | Contract present; **no full product loop** without webapp settle/refund |
| Production demo usability | Protocol readable; **not a finished user journey** |

### Now

| Capability | Status |
| --- | --- |
| Sepolia EmpiyaP2P + EmpiyaPayments live with mintable MockUSDT | **Yes** (demo addresses in env / webapp Dokploy docs) |
| Seller can deposit USDT from funded wallets | **Yes** (via webapp listing modal + MetaMask) |
| Filler can `depositAndReserve` for Sell MoMo | **Yes** (webapp MoMo offers fill path) |
| Operator can release / settle / refund from server-held key | **Yes** (webapp `EmpiyaOperatorService` + `empiya-operator.mjs`) |
| Sandbox MoMo deposit/payout against PawaPay | **Yes** (webapp; contracts only see resulting release/settle txs) |
| Mainnet / KYC / production cutover | **Out of scope** — still Sepolia + sandbox MoMo |

**Summary:** Before, the contracts were a **credible escrow/payments protocol**. Now they are the **live Sepolia settlement layer** behind a working demo of Sell USDT, Sell MoMo, and Pay with USDT, with operator actions driven from the webapp.

---

## 6. Honest attribution

- **Pre-existing:** product idea, EmpiyaP2P / EmpiyaPayments architecture, Hardhat scaffolding, much of the Solidity surface.
- **Built during / for this submission push:** Sepolia demo redeploys on mintable MockUSDT, operator alignment, docs/env that connect the webapp’s MoMo + settlement work to these addresses.
- **Judging note:** Please evaluate **protocol readiness + integration with the webapp**, not a claim that the entire Solidity codebase was written from scratch during the hackathon window.

---

## 7. Current Sepolia demo addresses (reference)

Update if redeployed:

| Contract | Address |
| --- | --- |
| Mock USDT | `0x2A51b5d05bbbDAB5A5746ed35C1A7708f7ADe6eD` |
| EmpiyaP2P | `0x76E69285D4dED0E5959F219014D4a64fc612d9Be` |
| EmpiyaPayments | `0x10C38D531d6C93E16ABc2f34b091a8E07B77C0de` |
