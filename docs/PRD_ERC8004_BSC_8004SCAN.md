# PRD: ERC-8004 on BNB Chain + 8004scan Integration

**Status:** Draft for implementation
**Audience:** coding agent implementing the change
**Context goal:** register AgentRouter provider capabilities as ERC-8004 agents on BNB Chain (BSC), make them indexed/visible on 8004scan, surface their reputation legibly in the marketplace — for the "Build the Era" BNB Agent Studio hackathon (AltLayer / 8004scan track + the core marketplace requirement).

---

## 1. What already exists (do NOT rebuild)

The chain abstraction and the ERC-8004 machinery are already in place. Read these first:

- `src/chains.js` — chain registry. Already defines **arc-testnet, bsc (56), bsc-testnet (97)** with token addresses (USDC/USDT on BSC verified at 18 decimals) and RPCs. Exposes `settlementChain()`, `settlementAsset()`, `activeSettlementChainId()` (env `ADN_SETTLEMENT_CHAIN`, default `arc-testnet`), `erc8004Registries()` (env-driven identity/reputation/validation registry addresses), `settlementPricingNetwork()`, `assertSettlementChainReady()`.
- `src/arc-payment.js` — already parameterized: `ARC_TESTNET = settlementChain()`, `ARC_USDC_ADDRESS = settlementAsset().address`. Settlement chain is now a config choice.
- `src/erc8004.js` — already has the full flow: `registerErc8004AgentIdentity()` (mints agent NFT via `writeContract`), `createErc8004AgentMetadata()` (AgentCard JSON), `submitErc8004Feedback()` (reputation write), `ERC8004_IDENTITY_ABI` / `ERC8004_REPUTATION_ABI`, `ADN_ERC8004_MODE=mock` fallback, env-driven registries via `erc8004Registries()`.
- `src/server.js` — already serves the AgentCard at `GET /.well-known/erc8004/agents/{service_id}.json` and exposes `POST /services/{id}/erc8004/register`.

**So switching to BSC is mostly configuration + finishing correctness, not new machinery.** This PRD covers only what is NOT done yet.

## 2. Background: ERC-8004 on BSC (facts to build against)

- BNB's implementation is **BRC8004** (`github.com/BRC8004/brc8004-contracts`). 8004scan indexes agents registered in these registries (400k+ agents; BNB is the largest ERC-8004 chain).
- **IdentityRegistry is an upgradeable ERC-721** (`ERC721URIStorage`). `register()` mints an agent NFT, assigns `agentId` (= ERC-721 `tokenId`), and `tokenURI(agentId)` (the `agentURI`) resolves to the **AgentCard JSON**.
- Agent identifier = `agentRegistry: eip155:56:{identityRegistry}` + `agentId` (tokenId). Chain 56 = BSC mainnet, 97 = BSC testnet.
- **AgentCard JSON** must be NFT-tooling friendly (`name` / `description` / `image`) AND advertise agent endpoints + capabilities.
- 8004scan indexes on-chain identity + reputation + validation and surfaces reputation scores; it supports agents implementing MCP / A2A / OASF on ERC-8004 (AgentRouter is MCP).

## 3. Goal & Non-Goals

**Goal**
- With `ADN_SETTLEMENT_CHAIN=bsc` (or `bsc-testnet`), AgentRouter can register its provider capabilities as ERC-8004 agents on BSC, they appear on `8004scan.io/agents`, their reputation is written on-chain, and the marketplace UI surfaces that identity + reputation legibly for a "who do I hire" decision.

**Non-Goals (v1)**
- No new payment rail; settlement stays the existing x402/EVM flow, now pointed at BSC via `chains.js`.
- No dependency on TermiX or any proprietary agent protocol — register only in the **canonical/neutral ERC-8004 (BRC8004) registries**. Interop at the standard level, not app-level.
- No change to the routing/verification/quality loop.

## 4. Functional requirements

### R1 — De-hardcode `arc-testnet` network labels → chain-aware (correctness bug on BSC)
Many return objects still hardcode `network: "arc-testnet"`, `caip2: "eip155:5042002"`, `chain_id: 5042002` even though the settlement chain is now config-driven. On BSC this produces **wrong metadata and payment proofs** (says arc-testnet while settling on BSC), which breaks verification and 8004scan metadata.
- Replace hardcoded chain labels with values from `settlementChain()` (`.network`, `.caip2`, `.id`) across: `src/arc-payment.js` (balance/transfer/verify return objects), `src/erc8004.js` (metadata + registration objects), `src/evidence.js` (evidence envelope network/caip2/chain_id).
- `isArcNetwork()` should be generalized (or complemented) so a payment/proof on BSC is recognized as valid for the active chain — audit every caller of `isArcNetwork()` that gates BSC flows.
- Acceptance: with `ADN_SETTLEMENT_CHAIN=bsc`, every emitted `network`/`caip2`/`chain_id` in proofs, evidence, and AgentCard equals BSC's (56 / eip155:56), never arc-testnet.

### R2 — AgentCard format compliance for 8004scan
`createErc8004AgentMetadata()` must output an AgentCard that 8004scan can index and that is NFT-tooling friendly.
- Required fields: `name`, `description`, `image` (NFT-friendly), plus agent `endpoints`, `capabilities`, `service_id`, price, `registrations` (with the **BSC** chain/registry from `settlementChain()` + `erc8004Registries()`), `supported_trust` (`["reputation","validation"]`), and `agent_id` when known.
- Verify field names/shape against the ERC-8004 AgentCard spec and what 8004scan expects (see §7 open items). Add `image` if missing.
- The `agentURI`/`tokenURI` on-chain must resolve to this JSON (already served at `/.well-known/erc8004/agents/{service_id}.json` — confirm `ADN_ERC8004_METADATA_BASE_URL` is the public origin so 8004scan can fetch it).

### R3 — ABI compatibility with BRC8004 registries (critical-path risk)
`ERC8004_IDENTITY_ABI` and `ERC8004_REPUTATION_ABI` in `erc8004.js` were written for the Arc deployment. BSC uses **BRC8004** — the `register()` / reputation function signatures may differ.
- Confirm the BRC8004 IdentityRegistry `register` signature (args, return, event) and ReputationRegistry feedback signature against `github.com/BRC8004/brc8004-contracts`, and update the ABIs / call sites (`registerErc8004AgentIdentity`, `submitErc8004Feedback`) to match. **If the ABI mismatches, `writeContract` silently fails or reverts — this is the #1 integration risk.**
- Acceptance: a real `register()` on BSC testnet returns a tx that mints an agent and yields an `agentId`.

### R4 — End-to-end registration on BSC
- With `ADN_SETTLEMENT_CHAIN=bsc-testnet` (or `bsc`), the confirmed BSC registry addresses in `erc8004Registries()`, and a funded `ADN_ERC8004_OWNER_PRIVATE_KEY` (BNB/tBNB gas), calling `POST /services/{id}/erc8004/register` for a provider:
  1. mints the agent NFT, returns `agent_id`,
  2. writes `agent_id` back to the manifest (already done via `applyErc8004RegistrationToManifest`),
  3. the agent appears on `8004scan.io/agents` with its AgentCard resolved.
- Keep `ADN_ERC8004_MODE=mock` working for local/CI (no chain needed).

### R5 — Reputation / validation write to BSC
- `submitErc8004Feedback()` writes consumer feedback to the **BSC** ReputationRegistry (ABI per R3). Reputation surfaced on 8004scan should reflect AgentRouter feedback events.
- Acceptance: after a paid+verified call and feedback, the reputation shows on 8004scan for that agent (or, in mock mode, the feedback path returns `status: submitted` with the BSC chain metadata).

### R6 — Marketplace UI: make ERC-8004 trust legible (the AltLayer track deliverable)
The hackathon's core ask is "make ERC-8004 identity + reputation legible for someone deciding who to hire."
- In the marketplace/service views (`src/home.js`, `src/studio.js`), surface per-agent: ERC-8004 `agent_id`, on-chain identity link (8004scan agent page / BscScan), reputation + validation summary, and AgentRouter's own trust/quality/health.
- Provide a link out to the agent's 8004scan page (`8004scan.io/agents/...`) and/or pull its reputation via 8004scan (API TBD — see §7).
- Acceptance: a human can look at a listing and see verifiable on-chain identity + track record, not just a self-claimed description.

## 5. Files to touch

| File | Change |
|---|---|
| `src/arc-payment.js` | R1: replace hardcoded `arc-testnet`/`5042002` in return objects with `settlementChain()` values. |
| `src/erc8004.js` | R1 (metadata labels), R2 (AgentCard fields incl. `image`), R3 (BRC8004 ABI + call sites). |
| `src/evidence.js` | R1: chain labels from `settlementChain()`. |
| `src/chains.js` | Confirm/adjust `ERC8004_REGISTRIES` defaults to the BSC addresses 8004scan indexes (see §7). No structural change expected. |
| `src/home.js`, `src/studio.js` | R6: surface ERC-8004 identity + reputation + 8004scan link in listings. |
| `src/server.js` | Confirm AgentCard route serves R2 shape; no route changes expected. |
| `test/mvp.test.js` | Add: mock-mode registration returns BSC chain metadata (56/eip155:56); AgentCard has required fields; no `arc-testnet` leaks when `ADN_SETTLEMENT_CHAIN=bsc`. |

## 6. Env / config

```
ADN_SETTLEMENT_CHAIN=bsc            # or bsc-testnet
ADN_SETTLEMENT_RPC_URL=...          # optional override; else chains.js default
ADN_SETTLEMENT_ASSET=USDC           # or USDT (both 18 decimals on BSC)
ADN_ERC8004_IDENTITY_REGISTRY=0x... # BSC IdentityRegistry (confirm, §7)
ADN_ERC8004_REPUTATION_REGISTRY=0x...
ADN_ERC8004_VALIDATION_REGISTRY=0x...
ADN_ERC8004_OWNER_PRIVATE_KEY=0x... # funded with BNB/tBNB for gas
ADN_ERC8004_METADATA_BASE_URL=https://<public-origin>  # so 8004scan can fetch the AgentCard
ADN_ERC8004_MODE=mock               # local/CI only
```

## 7. Open items to verify BEFORE/DURING implementation

Items 1 and 2 were answerable on chain and are now closed. 3 and 4 still need a
human, since neither is observable from BSC state.

1. ~~**Which BSC IdentityRegistry does 8004scan index?**~~ **Resolved — `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.**
   All three candidates were probed on BSC mainnet:

   | Address | `name()` | `symbol()` | Verdict |
   |---|---|---|---|
   | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | *(empty)* | *(empty)* | Not an ERC-721 registry |
   | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `AgentIdentity` | `AGENT` | **Canonical** |
   | `0xfA09B3397fAC75424422C4D28b1729E3D4f659D7` | `BRC8004 Identity Registry` | `BRC8004` | Separate deployment, 26 mostly test agents |

   `tokenURI(1)` on the canonical registry returns a card typed
   `https://eips.ethereum.org/EIPS/eip-8004#registration-v1` — the EIP's own
   schema. `0xfA09B339…` returns `brc8004-agent-registration` instead.

   This **corrects an earlier assumption in `chains.js`**: the "verified on chain"
   note meant only that those addresses had bytecode on BSC. Bytecode is not
   identity. `0x8004A818…` answers on BSC but is not the agent registry, so
   registries are now declared per chain rather than assumed shared.

2. ~~**BRC8004 ABI for `register` and reputation feedback**~~ **Resolved by
   selector probe against the ERC-1967 implementations.**
   - Identity proxy `0x8004A169…` → impl `0x7274e874…`: `register(string) → uint256`
     is present and `simulateContract` succeeds. Our ABI was already correct.
     The implementation is ERC-721 + `register(string)` + `setAgentURI(uint256,string)`
     and nothing else — no reputation logic lives there.
   - **Reputation `0x8004B663…` and validation `0x8004Cb1B…` both delegate to the
     same stub implementation `0xd53de688…`**, whose entire interface is
     `initialize(address)`, `upgradeToAndCall`, `proxiableUUID`, `owner()`,
     `transferOwnership`. No `giveFeedback`, no `getSummary`. Simulating
     `giveFeedback` on BSC reverts.

     Consequence: **on-chain reputation writes are not available on BSC yet.**
     `submitErc8004Feedback` now simulates before broadcasting and returns
     `status: "registry_unavailable"` with the reason instead of paying gas for a
     guaranteed revert; the rating is still recorded off-chain. When a real
     reputation registry is deployed, point `ADN_ERC8004_REPUTATION_REGISTRY` at
     it and the write path resumes with no code change.

3. ~~**8004scan indexing + reputation API**~~ **Resolved — there is a public API,
   and it independently confirms §7.1.**

   `https://8004scan.io/api/v1/public/agents` — anonymous access, no key,
   10 req/min, CORS enabled, OpenAPI 3.0. Verified live:

   | Call | Result |
   |---|---|
   | `GET /api/v1/public/agents?chainId=56&limit=2` | BSC agents, all under `0x8004a169…` |
   | `GET /api/v1/public/agents/56/1` | ClawNews — the same agent our `tokenURI(1)` decode returned |
   | `GET /api/v1/public/agents/search?q=…` | hybrid vector + keyword search |

   8004scan's own records key agents as `{chainId}:{contract}:{tokenId}` and the
   contract is always `0x8004a169…` on chain 56 — so the registry correction in
   §7.1 is confirmed by the indexer itself, not just by our probes. Indexing is
   automatic from chain events; no manual "create agent" step is needed.

   **Reputation is available per agent** — enough for R6 without writing to a
   registry: `total_feedbacks`, `average_score`, `star_count`, `rank` /
   `network_rank`, `total_validations`, `successful_validations`,
   `supported_trust_models`, `x402_supported`, and a `scores` object
   (`quality`, `popularity`, `activity`, `wallet`, `freshness`,
   `metadata_completeness`, `health`).

   **Explorer URL corrected**: the path is `/agents/{chainId}/{tokenId}`.
   Including the registry address — which the API's composite id makes look
   right — returns 404. Both forms were checked against the live site.

   **Card format confirmed against `best-practices.8004scan.io`** (the profile
   8004scan's own parser follows):
   - Required fields are `type`, `name`, `description`, `image` — the four our
     card was missing or getting wrong before R2.
   - EIP-8004 renamed `endpoints` → `services` in Jan 2026; parsers emit a
     `WA031` warning for the legacy name. We emit `services`.
   - Feedback profile v2.0 replaced `score` (uint8 0–100) with `value` (int) +
     `valueDecimals` (uint8 0–18), and supports negative values. Our reputation
     ABI already uses `int128 value, uint8 valueDecimals`, so it targets v2.0.

4. **AltLayer/8004scan track submission rules** *(still open, owner: human)* —
   no verbatim track rules surfaced. The closest live, and directly relevant,
   programme found is BNB Chain's **"Build the Era: Build the Official BNB Agent
   Studio Marketplace"** (submissions Aug 5 – Sep 9 2026, $40,000+ prizes,
   winner may become the officially adopted BNB Agent Studio marketplace). Its
   stated premise — 200,000+ ERC-8004 agents on BSC with no way to find,
   compare, or judge them — is the problem AgentRouter already solves. Worth a
   human confirming whether that, rather than an AltLayer track, is the target.

## 8. Acceptance criteria

1. With `ADN_SETTLEMENT_CHAIN=bsc`, no response, proof, evidence, or AgentCard emits `arc-testnet` / `5042002`; all chain fields are BSC (56 / eip155:56).
2. AgentCard at `/.well-known/erc8004/agents/{id}.json` contains `name`, `description`, `image`, `endpoints`, `capabilities`, and BSC `registrations`.
3. `register()` on BSC testnet mints an agent and returns an `agent_id`; the agent resolves on `8004scan.io/agents`.
4. Feedback writes to the BSC ReputationRegistry (or mock returns BSC metadata).
   **Amended:** no reputation registry is deployed on BSC (see §7.2), so the
   criterion is now that the write is simulated first and reports
   `registry_unavailable` rather than reverting on chain, with the rating kept
   off-chain.
5. A marketplace listing shows verifiable ERC-8004 identity + reputation + an 8004scan link.
6. `ADN_ERC8004_MODE=mock` keeps local/CI green; full existing suite still passes (310 tests).

## 9. Out of scope (v1)

- Cross-chain agent portability, arc-anchor on-chain evidence on BSC, fiat/Stripe credits, and any TermiX/proprietary-protocol integration.
