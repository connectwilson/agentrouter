# On-chain reference

This public repository exposes the smallest verifiable part of AgentRouter's
trust model: an events-only EVM contract for anchoring hashes of completed call
evidence.

## What is public here

- `contracts/AgentRouterEvidenceAnchor.sol`: a no-owner, no-storage,
  non-upgradeable Solidity contract.
- `contracts/deploy.js`: a local deploy script that compiles the contract,
  checks the selected RPC chain ID, estimates gas when a local signer is
  supplied, and deploys only after an explicit command.

The contract records hashes, not request text, raw provider responses, account
credentials, browser sessions, API keys, or user feedback content. It can be
deployed to BNB Smart Chain or another EVM chain chosen by the operator.

## What an event proves — and what it does not

The anchor is permissionless and deliberately has no owner or allowlist. An
event proves that the calling address emitted the supplied hashes at a given
block time; it does **not** prove that an API response was correct, that a
vendor endorsed a service, or that a feedback score is valid. Consumers should
verify the linked evidence, caller identity, and any ERC-8004 record
independently before relying on an event for a decision.

## ERC-8004 boundary

Agent identity and reputation are separate from the evidence anchor. A vendor
identity is represented by its ERC-8004 registration, while feedback belongs to
the consumer who submits it. The hosted control plane validates ownership,
idempotency, and sponsorship policy before it attempts any on-chain write.

No production Agent IDs, wallet addresses, transaction hashes, vendor mappings,
Paymaster policy, or real-call records are published in this repository. Those
values are deployment-specific public-chain data and should be independently
verified from the relevant explorer when an operator elects to disclose them.

## Deploy your own anchor

```bash
npm install
RPC_URL=https://bsc-dataseed.binance.org node contracts/deploy.js --dry-run

# Only when ready to pay the network gas yourself:
RPC_URL=https://bsc-dataseed.binance.org PRIVATE_KEY=0x... \
  node contracts/deploy.js
```

Use a dedicated deployment wallet. Do not commit a key, put one in a URL, or
paste one into an issue. The script never prints `PRIVATE_KEY` and `.gitignore`
excludes common key-file formats.
