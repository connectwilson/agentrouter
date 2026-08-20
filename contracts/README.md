# AgentRouterEvidenceAnchor

Events only. No storage, no owner, nothing upgradeable.

AgentRouter keeps the full evidence and feedback records off chain and writes
only their hashes here, so a call can be checked for timestamp, immutability and
hash consistency without publishing what was asked or returned.

Because it holds nothing, a deployment is disposable: the address is a place to
read past events from, not an authority. Deploy your own rather than trusting
one someone else published — that is the point of it being this small.

## Deploy

```bash
npm install
RPC_URL=https://bsc-dataseed.binance.org node contracts/deploy.js --dry-run
```

The dry run compiles, reports the bytecode size, reads the chain id from the
RPC, and estimates gas. Nothing is broadcast and no key is needed.

To deploy, add a key and drop the flag:

```bash
RPC_URL=https://bsc-dataseed.binance.org PRIVATE_KEY=0x... node contracts/deploy.js
```

The key is read from the environment and never written anywhere. The chain comes
from the RPC rather than a configuration table, so this works on any EVM network.

Point the server at the result with `ADN_ARC_ANCHOR_CONTRACT`.

## Verifying a deployment

Compile from this source and compare against the deployed bytecode:

```bash
RPC_URL=<rpc> node contracts/deploy.js --dry-run   # prints the size compiled here
cast code <address> --rpc-url <rpc>                # what is actually on chain
```

Constructor arguments are none, so the deployed runtime bytecode should match
what the compiler produces from the file in this directory.
