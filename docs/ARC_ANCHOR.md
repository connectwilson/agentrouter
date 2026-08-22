# Arc Evidence and ERC-8004 Trust Anchoring

AgentRouter stores full evidence and feedback offchain, anchors evidence hashes on the configured settlement chain, and submits one public post-call feedback transaction to ERC-8004 when configured.

## What Goes Onchain

`AgentRouterEvidenceAnchor` emits `EvidenceAnchored` for a paid data call:

- `requestId`
- `traceHash`
- `resultHash`
- `verificationHash`
- `feedbackHash`
- `serviceHash`
- `providerHash`
- `paymentTxHash`

The deployed contract retains a legacy `FeedbackAnchored` event, but AgentRouter no longer calls it for new consumer feedback:

- `requestId`
- `feedbackHash`
- `serviceHash`
- `providerHash`

The raw request, result, verification details, and consumer feedback stay in the registry/persistence layer. The configured settlement chain is the immutable timestamp and integrity anchor for evidence, not the full data store.

## ERC-8004 Reputation Feedback

The custom `AgentRouterEvidenceAnchor` contract is a minimal evidence hash anchor. ERC-8004 is used as the standard reputation layer:

- Provider/data services can be associated with an ERC-8004 `agent_id`
- After a paid invocation, the buyer Agent submits consumer feedback to AgentRouter
- The local consumer wallet signs `giveFeedback(...)`; on BNB Chain, the configured EOA Paymaster submits it with zero gas price and sponsors the gas
- The custom evidence-anchor contract is not called again for consumer feedback, avoiding two onchain writes for one rating
- The onchain feedback points back to the offchain feedback/evidence URI and hash

This gives the MVP two layers:

- AgentRouter evidence: request/result/verification/payment trace hashes
- ERC-8004 reputation: standard onchain feedback signal for agent/service trust

## ERC-8004 Identity Registration

AgentRouter can also expose a service-specific ERC-8004 Agent Registration File and register the service as an ERC-8004 identity:

```text
GET  /.well-known/erc8004/agents/:service_id.json
POST /services/:service_id/erc8004/register
```

The metadata document describes the provider, capabilities, price, AgentRouter service detail endpoint, feedback endpoint, and supported trust models. The registration endpoint calls `IdentityRegistry.register(metadataURI)` and writes the returned `agent_id` back into:

```json
{
  "registration": {
    "erc8004": {
      "agent_id": "1001",
      "identity_registry": "0x8004...",
      "reputation_registry": "0x8004...",
      "metadata_uri": "https://.../.well-known/erc8004/agents/service.json"
    }
  }
}
```

Once attached, later consumer feedback automatically targets that service's ERC-8004 `agent_id`.

## Runtime Configuration

Without configuration, evidence returns:

```json
{
  "arc_anchor": {
    "status": "not_configured",
    "storage_model": "full_evidence_offchain_hashes_on_arc"
  }
}
```

To enable real Arc Testnet anchoring:

```bash
ADN_ARC_RPC_URL=https://rpc.testnet.arc.network
ADN_ARC_ANCHOR_CONTRACT=0x...
ADN_ARC_ANCHOR_PRIVATE_KEY=0x...
```

`ADN_ARC_ANCHOR_PRIVATE_KEY` is the server-side anchoring wallet. It is not a provider API key and should not be used for user payments.

To enable gas-sponsored ERC-8004 feedback on BNB Chain:

```bash
ADN_SETTLEMENT_CHAIN=bsc
ADN_BSC_PAYMASTER_URL=https://your-bnb-eoa-paymaster-rpc
```

`ADN_BSC_PAYMASTER_URL` belongs on the AgentRouter server (for example Render). The local MCP bridge signs with a local encrypted reviewer wallet and sends only the signed transaction through AgentRouter's authenticated Paymaster proxy. If sponsorship is unavailable, feedback remains recorded offchain and the bridge does not fall back to spending the consumer's BNB.

For legacy direct ERC-8004 submission without BNB sponsorship:

```bash
ADN_ERC8004_PRIVATE_KEY=0x...
ADN_ERC8004_AGENT_ID=1001
ADN_ERC8004_REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713
```

To register ERC-8004 identities:

```bash
ADN_ERC8004_OWNER_PRIVATE_KEY=0x...
ADN_ERC8004_METADATA_BASE_URL=https://agentrouter.network
ADN_ERC8004_IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e
```

`ADN_ERC8004_AGENT_ID` can be replaced per service by attaching `registration.erc8004.agent_id` to the service manifest, or by setting `ADN_ERC8004_AGENT_ID_<SERVICE_ID>`.

If ERC-8004 is not configured, the API returns `erc8004.status = "not_configured"` and keeps the feedback offchain. Evidence anchoring remains independent; AgentRouter no longer creates a second custom onchain anchor for the feedback itself.

For local tests:

```bash
ADN_ARC_ANCHOR_MODE=mock
ADN_ERC8004_MODE=mock
```

## Contract

The minimal contract source lives at:

```text
contracts/AgentRouterEvidenceAnchor.sol
```

Deploy it to Arc Testnet, set `ADN_ARC_ANCHOR_CONTRACT`, and restart the server.
