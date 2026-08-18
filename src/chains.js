// Single source of truth for settlement chains.
//
// Chain identity, RPC, and token decimals used to live as constants in
// arc-payment.js while manifest pricing hardcoded "base" elsewhere, so a quote
// could claim one network and settle on another. Everything chain-shaped now
// resolves from here.
//
// Decimals are per chain AND per token, not a global constant: Arc USDC has 6
// but BEP-20 USDC and USDT on BSC have 18. Treating 18 as 6 misprices a payment
// by a factor of 10^12, so the value is declared per token and verified against
// the contract at startup by assertSettlementChainReady().

const CHAINS = {
  "arc-testnet": {
    id: 5042002,
    name: "Arc Testnet",
    network: "arc-testnet",
    caip2: "eip155:5042002",
    testnet: true,
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    defaultRpcUrl: "https://rpc.testnet.arc.network",
    explorer: { name: "ArcScan", url: "https://testnet.arcscan.app" },
    tokens: {
      USDC: { address: "0x3600000000000000000000000000000000000000", decimals: 6 }
    }
  },
  bsc: {
    id: 56,
    name: "BNB Smart Chain",
    network: "bsc",
    caip2: "eip155:56",
    testnet: false,
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    defaultRpcUrl: "https://bsc-dataseed.binance.org",
    explorer: { name: "BscScan", url: "https://bscscan.com" },
    tokens: {
      // Verified on chain: both are 18 decimals, unlike USDC on most networks.
      USDC: { address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", decimals: 18 },
      USDT: { address: "0x55d398326f99059fF775485246999027B3197955", decimals: 18 }
    }
  },
  "bsc-testnet": {
    id: 97,
    name: "BNB Smart Chain Testnet",
    network: "bsc-testnet",
    caip2: "eip155:97",
    testnet: true,
    nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
    defaultRpcUrl: "https://bsc-testnet-rpc.publicnode.com",
    explorer: { name: "BscScan Testnet", url: "https://testnet.bscscan.com" },
    tokens: {
      USDC: { address: "0x64544969ed7EBf5f083679233325356EbE738930", decimals: 18 },
      USDT: { address: "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", decimals: 18 }
    }
  }
};

// Registries are per chain. An earlier version assumed one deterministic set
// everywhere because those addresses had bytecode on BSC — but bytecode is not
// identity: 0x8004A818… answers on BSC yet is not the ERC-721 agent registry
// (name() and symbol() are empty). Confirm what a contract *is*, not that it
// exists.
//
// BSC's canonical registry is 0x8004A169…: an ERC-721 named "AgentIdentity"
// whose tokenURI returns cards typed
// https://eips.ethereum.org/EIPS/eip-8004#registration-v1 — the EIP's own
// schema, and what 8004scan indexes. (0xfA09B339… is a separate "BRC8004"
// deployment holding 26 mostly test agents; not the canonical one.)
const ERC8004_REGISTRIES_BY_CHAIN = {
  "arc-testnet": {
    identityRegistry: "0x8004A818BFB912233c491871b3d84c89A494BD9e",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"
  },
  bsc: {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"
  },
  "bsc-testnet": {
    identityRegistry: "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
    reputationRegistry: "0x8004B663056A597Dffe9eCcC1965A193B7388713",
    validationRegistry: "0x8004Cb1BF31DAf7788923b405b754f57acEB4272"
  }
};

export const SETTLEMENT_CHAINS = Object.keys(CHAINS);

export function activeSettlementChainId() {
  const requested = String(process.env.ADN_SETTLEMENT_CHAIN || "arc-testnet").trim().toLowerCase();
  if (!CHAINS[requested]) {
    const error = new Error(`Unknown ADN_SETTLEMENT_CHAIN "${requested}". Supported: ${SETTLEMENT_CHAINS.join(", ")}.`);
    error.code = "UNKNOWN_SETTLEMENT_CHAIN";
    throw error;
  }
  return requested;
}

export function settlementChain(chainId = activeSettlementChainId()) {
  const definition = CHAINS[chainId];
  // An operator pointing RPC at one chain while the id says another would sign
  // for the wrong network, so the override travels with the chain it belongs to.
  const rpcUrl = String(process.env.ADN_SETTLEMENT_RPC_URL || process.env.ADN_ARC_RPC_URL || definition.defaultRpcUrl);
  return {
    ...definition,
    rpcUrl,
    // viem chain shape, so callers can pass this straight to createPublicClient.
    rpcUrls: { default: { http: [rpcUrl] }, public: { http: [rpcUrl] } },
    blockExplorers: { default: definition.explorer }
  };
}

export function settlementAsset(symbol, chainId = activeSettlementChainId()) {
  const chain = CHAINS[chainId];
  const wanted = String(symbol || process.env.ADN_SETTLEMENT_ASSET || "USDC").trim().toUpperCase();
  const token = chain.tokens[wanted];
  if (!token) {
    const error = new Error(`${chain.name} has no configured ${wanted} token. Available: ${Object.keys(chain.tokens).join(", ")}.`);
    error.code = "UNSUPPORTED_SETTLEMENT_ASSET";
    throw error;
  }
  const address = String(process.env[`ADN_SETTLEMENT_${wanted}_ADDRESS`] || token.address);
  const decimals = Number(process.env[`ADN_SETTLEMENT_${wanted}_DECIMALS`] || token.decimals);
  return { symbol: wanted, address, decimals };
}

export function erc8004Registries(chainId = activeSettlementChainId()) {
  const defaults = ERC8004_REGISTRIES_BY_CHAIN[chainId] || ERC8004_REGISTRIES_BY_CHAIN["arc-testnet"];
  return {
    identityRegistry: process.env.ADN_ERC8004_IDENTITY_REGISTRY || defaults.identityRegistry,
    reputationRegistry: process.env.ADN_ERC8004_REPUTATION_REGISTRY || defaults.reputationRegistry,
    validationRegistry: process.env.ADN_ERC8004_VALIDATION_REGISTRY || defaults.validationRegistry
  };
}

// eip155:{chainId}:{registry} — the identifier 8004scan and the EIP use.
export function erc8004AgentRegistryId(chainId = activeSettlementChainId()) {
  return `eip155:${settlementChain(chainId).id}:${erc8004Registries(chainId).identityRegistry}`;
}

// 8004scan only indexes BSC, and the link must describe the chain the agent was
// actually registered on — not whichever chain this process happens to settle
// on now. Passing the ambient chain produced links pointing at BSC's registry
// for agents minted on Arc.
//
// The path is /agents/{chainId}/{tokenId}. Including the registry address —
// which the API's own composite id `{chainId}:{contract}:{tokenId}` suggests —
// 404s. Verified against the live site.
export function erc8004ExplorerUrl(agentId, chainId = activeSettlementChainId()) {
  if (!agentId) return null;
  const chain = CHAINS[chainId];
  if (!chain) return null;
  if (chain.id !== 56 && chain.id !== 97) return null;
  return `https://8004scan.io/agents/${chain.id}/${encodeURIComponent(agentId)}`;
}

// 8004scan's own identifier for an agent, as returned by its public API.
export function erc8004ScanAgentId(agentId, chainId = activeSettlementChainId()) {
  const chain = CHAINS[chainId];
  if (!chain || !agentId) return null;
  return `${chain.id}:${erc8004Registries(chainId).identityRegistry.toLowerCase()}:${agentId}`;
}

// The network a quote advertises must be the network it settles on. Pricing used
// to say "base" while settlement went to arc-testnet, which left an agent no way
// to know where funds actually move.
export function settlementPricingNetwork(backend) {
  if (backend === "credits") return "offchain_credits";
  return settlementChain().network;
}

// Called at startup for on-chain backends: proves the RPC really is the chain we
// think it is, and that the token's decimals match what we will price with.
// Getting either wrong moves the wrong amount of money.
export async function assertSettlementChainReady({ backend, fetchImpl = globalThis.fetch, asset } = {}) {
  if (backend === "credits" || process.env.ADN_SETTLEMENT_SKIP_PREFLIGHT === "1") {
    return { ok: true, skipped: true };
  }
  const chain = settlementChain();
  const token = settlementAsset(asset);
  const rpc = async (method, params) => {
    const response = await fetchImpl(chain.rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
    });
    const payload = await response.json();
    if (payload.error) throw new Error(`${method} failed: ${payload.error.message}`);
    return payload.result;
  };

  const reportedChainId = Number(await rpc("eth_chainId", []));
  if (reportedChainId !== chain.id) {
    const error = new Error(
      `Settlement RPC reports chain ${reportedChainId} but ADN_SETTLEMENT_CHAIN=${chain.network} expects ${chain.id}. ` +
      "Signing against a mismatched chain id would broadcast on the wrong network."
    );
    error.code = "SETTLEMENT_CHAIN_MISMATCH";
    throw error;
  }

  const decimalsHex = await rpc("eth_call", [{ to: token.address, data: "0x313ce567" }, "latest"]);
  const onChainDecimals = Number(decimalsHex);
  if (Number.isFinite(onChainDecimals) && onChainDecimals !== token.decimals) {
    const error = new Error(
      `${token.symbol} at ${token.address} reports ${onChainDecimals} decimals but is configured as ${token.decimals}. ` +
      `Paying with the wrong scale would be off by 10^${Math.abs(onChainDecimals - token.decimals)}.`
    );
    error.code = "SETTLEMENT_DECIMALS_MISMATCH";
    throw error;
  }

  return { ok: true, chain: chain.network, chain_id: chain.id, asset: token.symbol, decimals: token.decimals };
}
