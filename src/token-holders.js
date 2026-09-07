// Nansen TGM Holders contract, verified against official holders.md (2026-09-07).
// Coverage is endpoint-specific; sample_request.chain is not a coverage declaration.
const evmChains = new Set("arbitrum avalanche base bnb ethereum hyperevm iotaevm linea mantle monad optimism plasma polygon robinhood sei sonic".split(" "));
export const HOLDER_CHAINS = [...evmChains, "solana"];
export function holderChain(value) {
  const key = String(value || "").trim().toLowerCase().replace(/\s+chain$/, "");
  return ({ bsc: "bnb", eth: "ethereum", "bnb chain": "bnb", "以太坊": "ethereum" })[key] || key;
}
function validAddress(value, chain) {
  return typeof value === "string" && (chain === "solana" ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value) : /^0x[a-fA-F0-9]{40}$/.test(value));
}
function addressKey(value, chain) { return chain === "solana" ? value : String(value || "").toLowerCase(); }

export function parseHolderTask(text) {
  const chains = [...new Set((text.match(new RegExp(`\\b(?:${HOLDER_CHAINS.join("|")}|bsc|eth)\\b|以太坊`, "gi")) || []).map(holderChain))];
  const tokenAddress = text.match(/0x[a-fA-F0-9]{40}\b/)?.[0];
  const symbol = text.match(/([a-zA-Z][a-zA-Z0-9]{1,14})\s*(?:代币|代幣)/)?.[1]
    || text.match(/holders?\s+of\s+\$?([a-zA-Z][a-zA-Z0-9]{1,14})\b/i)?.[1]
    || (text.match(/\b[A-Z][A-Z0-9]{1,14}\b/g) || []).find(x => ![...HOLDER_CHAINS, "bsc", "eth", "chain", "token", "nansen"].includes(x.toLowerCase()));
  const count = text.match(/(?:前\s*|top\s*|largest\s*)(\d+)/i)?.[1];
  const chinese = text.match(/前\s*([一二三四五六七八九十百]+)/)?.[1];
  const digits = "零一二三四五六七八九";
  const chineseCount = chinese === "一百" || chinese === "百" ? 100 : chinese?.includes("十")
    ? (digits.indexOf(chinese.split("十")[0]) || 1) * 10 + digits.indexOf(chinese.split("十")[1])
    : chinese ? digits.indexOf(chinese) : 10;
  return { query: text, chain: chains.length === 1 ? chains[0] : "", ...(tokenAddress ? { token_address: tokenAddress } : { token_symbol: symbol?.toUpperCase() }), limit: count ? Number(count) : chineseCount };
}

export function validateHolderParams(params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return { ok: false, error: "INVALID_PARAMS" };
  if (["date", "from", "to", "window", "timeframe", "snapshot_required"].some(key => params[key] != null && params[key] !== "current")) return { ok: false, error: "HISTORICAL_HOLDERS_NOT_SUPPORTED", message: "This holder contract provides current balances, not historical snapshots." };
  const chain = holderChain(params.chain);
  if (!chain) return { ok: false, error: "MISSING_REQUIRED_PARAM", missing: ["chain"] };
  if (!HOLDER_CHAINS.includes(chain)) return { ok: false, error: "CHAIN_NOT_SUPPORTED", chain, supported_chains: HOLDER_CHAINS };
  if (params.token_address && !validAddress(params.token_address, chain)) return { ok: false, error: "INVALID_TOKEN_ADDRESS" };
  if (!params.token_address && !/^[a-zA-Z0-9$][a-zA-Z0-9._-]{0,29}$/.test(String(params.token_symbol || ""))) return { ok: false, error: "MISSING_REQUIRED_PARAM", missing: ["token_address_or_symbol"] };
  if (params.limit != null && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) return { ok: false, error: "INVALID_LIMIT", allowed: "1..100" };
  return { ok: true };
}

export function holderInput(intent) {
  return { chain: holderChain(intent.chain), ...(intent.token_address ? { token_address: intent.token_address } : {}), pagination: { page: 1, per_page: intent.limit ?? 10 }, aggregate_by_entity: false, label_type: "all_holders", order_by: [{ field: "token_amount", direction: "DESC" }] };
}

export function matchHolderToken(data, intent) {
  const chain = holderChain(intent.chain);
  const rows = data?.tokens ?? data?.data?.tokens ?? data?.data;
  const matches = new Map();
  if (Array.isArray(rows)) for (const row of rows) {
    const address = row.address || row.token_address;
    if (String(row.symbol || row.token_symbol || "").toUpperCase() === String(intent.token_symbol).toUpperCase()
        && holderChain(row.chain) === chain && validAddress(address, chain)) matches.set(addressKey(address, chain), address);
  }
  // A capped search is not proof of uniqueness: request a contract instead.
  const truncated = Number(data?.total_results ?? data?.data?.total_results) > (rows?.length ?? 0) || (rows?.length ?? 0) >= 50;
  if (matches.size !== 1 || truncated) return { ok: false, status: matches.size > 1 || truncated ? "token_resolution_ambiguous" : "token_not_found", message: "Provide the exact token contract on the requested chain; no cross-chain or wrapped substitution is allowed." };
  return { ok: true, address: [...matches.values()][0] };
}

export function holderCoverageIssues(result, intent) {
  const chain = holderChain(intent.chain);
  const rows = result?.data?.data;
  const issues = [];
  const fail = (code, message) => issues.push({ code, message });
  if (holderChain(result?.query?.chain) !== chain || addressKey(result?.query?.token_address, chain) !== addressKey(intent.token_address, chain)) fail("HOLDER_IDENTITY_MISMATCH", "Holder result must cover the exact requested chain and contract.");
  if (!Array.isArray(rows) || !rows.length) { fail("HOLDER_ROWS_MISSING", "Expected holder addresses and balances, not pools or trades."); return issues; }
  const seen = new Set();
  let previous = Infinity;
  for (const row of rows) {
    const key = addressKey(row?.address, chain);
    const amount = Number(row?.token_amount);
    if (!validAddress(row?.address, chain) || seen.has(key) || row?.token_amount == null || row.token_amount === "" || !Number.isFinite(amount) || amount < 0 || amount > previous) fail("HOLDER_RANKING_INVALID", "Expected unique holder addresses with nonnegative balances ordered descending.");
    seen.add(key);
    previous = amount;
  }
  const limit = intent.limit ?? 10;
  if (rows.length > limit || (rows.length < limit && result.data.pagination?.is_last_page !== true)) fail("HOLDER_COVERAGE_INCOMPLETE", "Requested holder count was not covered and end-of-results was not confirmed.");
  return issues;
}
