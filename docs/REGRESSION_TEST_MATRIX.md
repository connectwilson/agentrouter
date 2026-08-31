# Regression Test Matrix

This matrix is the minimum regression contract for AgentRouter. Every production
bug must add a failing test to the closest suite before the implementation is
changed. New capabilities must add happy-path, boundary, failure, authorization,
privacy, and recovery cases where those dimensions apply.

## Marketplace and ERC-8004

| Capability | Primary suites | Required cases |
| --- | --- | --- |
| Vendor identity lifecycle | `erc8004-marketplace-phase1`, `vendor-identity-registration`, `platform-identity-registration` | BSC identity, stale Arc identity, submitted/registered/not-registered state, provider isolation, late service inheritance, network isolation, summary/detail parity, registration idempotency |
| 8004scan discovery | `erc8004-discovery`, `erc8004-regression-matrix` | Search/list/detail shapes, camel/snake/wrapped payloads, token ID normalization, query encoding, limit bounds, missing IDs, wrong chain, bounded cache capacity, concurrent deduplication, TTL refresh, retry and recovery |
| Import and verification | `erc8004-regression-matrix`, `erc8004-import-persistence` | Authentication, BSC-only policy, identity/chain match, metadata fetch, malformed JSON, HTTP failures, protocol response shape, endpoint preference, partial probe failure, forged verification downgrade, repeat verification persistence |
| Endpoint security | `erc8004-regression-matrix`, `erc8004-pinned-transport`, `security-write-boundaries` | HTTPS-only, credentials rejected, loopback/private/link-local/reserved IPv4 and IPv6, bounded redirect policy, DNS-pinned connection, DNS failure, SSRF fail-closed behavior |
| Hire and dispatch | `erc8004-regression-matrix` | Authentication, missing import, verified adapter and endpoint required, verification expiry, deterministic adapter selection, x402 classification, omitted/null/object/array input |
| BSC sponsorship | `bsc-registration-paymaster`, `bsc-paymaster`, `npm-mcp-bsc-feedback` | Vendor registration sponsorship, sender/contract/method boundaries, quota exhaustion, missing configuration, receipt validation, fallback behavior |
| Feedback and reputation | `bsc-feedback-hardening`, `feedback-resilience`, `agentrouter-feedback-corpus` | Correct Vendor Agent ID, deduplication, replay protection, failed receipt, deferred retry, gas sponsorship, public status, trust feedback persistence |

## Routing and data access

| Capability | Primary suites | Required cases |
| --- | --- | --- |
| Natural-language routing | `agentrouter-routing-acceptance`, `agentrouter-routing-invariants`, `capability-packs` | Explicit provider, semantic capability, general research, academic research, social source, financial/on-chain/weather/news data, ambiguity clarification, budget and trust constraints |
| Browser authorization | `authorization-routing-state-machine`, `agentrouter-browser-auth`, `browser-authorization-launch`, `native-browser-hardening` | First login, existing session, expired session, popup blocked, host browser handoff, no API-key request, no reinstall/restart loop, callback success/failure, retry |
| Provider connections | `external-api-connections`, `social-connections`, `local-browser-connector`, `local-social-privacy` | Connected/disconnected/expired provider, browser-native path, local connector, provider secret isolation, read-only boundary, fallback policy |
| Social retrieval | `social-vendor-connectors`, `social-post-read` | X URL/account/search, Reddit, YouTube and other supported vendors, exact entity disambiguation, empty/partial results, local auth, source provenance |
| Result synthesis | `liquidation-result-synthesis`, `research` | Valid/empty/malformed provider results, deterministic summaries, evidence preservation, large payload compaction, no unsupported inference |

## Marketplace, payments, and platform contracts

| Capability | Primary suites | Required cases |
| --- | --- | --- |
| Service registry and public API | `mvp`, `public-api-catalog`, `public-api-pipeline` | Create/import/validate/list/detail, invalid manifest, duplicate service, provider ownership, public redaction, call counters and ratings |
| Pricing and credits | `credits`, `credits-http`, `credit-payments`, `credit-crypto` | Free/paid calls, budget ceiling, insufficient balance, exact debit, replay/idempotency, refund/failure path, crypto settlement metadata |
| Device and MCP setup | `device-auth`, `mcp-device-connect`, `agentrouter-installer-connect`, `agentrouter-connect-install-boundary` | New install, already installed, login handoff, token expiry, reconnect without reinstall, client reload boundary, stable tool availability |
| Plugin and packaging | `agent-plugin`, `release-readiness`, `dependency-security` | Schema validation, package contents, entry points, dependency audit, build/version contract, secret and local-file exclusion |
| One Dollar Audit | `one-dollar-audit` | Availability, supported contract workflow, request validation, provider failure, evidence/result envelope |
| App UI shell | `app-shell`, `new-user-experience` | Core page rendering, navigation, first-run guidance, authorization copy, public/private state visibility |

## Commands

Run the complete suite:

```bash
node --test
```

Run the high-risk ERC-8004 regression group:

```bash
node --test \
  test/erc8004-regression-matrix.test.js \
  test/erc8004-discovery.test.js \
  test/erc8004-marketplace-phase1.test.js \
  test/vendor-identity-registration.test.js \
  test/settlement-chains.test.js \
  test/bsc-registration-paymaster.test.js \
  test/bsc-feedback-hardening.test.js
```

Measure the discovery module independently:

```bash
node --test --experimental-test-coverage \
  --test-coverage-include=src/erc8004-discovery.js \
  test/erc8004-regression-matrix.test.js
```
