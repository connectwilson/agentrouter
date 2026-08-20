// Crypto credit top-ups: the user sends USDC or USDT to the treasury on the
// settlement chain and submits the transaction hash. The server reads the
// receipt from the chain and credits the account.
//
// Deliberately no deposit-address custody and no chain watcher. Both mean
// holding keys or running a process that must survive reorgs; reading one
// receipt on demand needs neither and fails closed when the RPC is down.
//
// A transaction hash is public, so anyone who sees a deposit could try to claim
// it. Two things bound that: a claim is idempotent on the hash, so a deposit
// pays exactly one account and never twice, and the sending address binds to
// the first account that claims from it — after which deposits from that
// address can only ever credit that account. The exposure that remains is a
// first-ever deposit from a fresh address, claimed by someone watching the
// chain before its owner gets to it.
import { settlementChain, settlementAsset, activeSettlementChainId } from "./chains.js";
import { grantCredits } from "./credits.js";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const MIN_CONFIRMATIONS = Number(process.env.ADN_CREDITS_MIN_CONFIRMATIONS || 3);

export function creditTreasuryAddress() {
  return String(process.env.ADN_CREDITS_TREASURY_ADDRESS || "").toLowerCase();
}

// The assets a deposit may arrive in, resolved from the chain config so decimals
// are never assumed. BEP-20 USDC and USDT are 18 decimals, not the 6 that USDC
// uses on most networks; crediting 18-decimal units as 6 would inflate a
// deposit by a factor of 10^12.
export function cryptoTopupAssets(chainId = activeSettlementChainId()) {
  const assets = [];
  for (const symbol of ["USDC", "USDT"]) {
    try {
      assets.push(settlementAsset(symbol, chainId));
    } catch {
      // A chain that does not carry this asset simply cannot be paid in it.
    }
  }
  return assets;
}

export function cryptoTopupInstructions({ chainId = activeSettlementChainId() } = {}) {
  const chain = settlementChain(chainId);
  const treasury = creditTreasuryAddress();
  return {
    enabled: Boolean(treasury),
    chain: chain.network,
    chain_id: chain.id,
    caip2: chain.caip2,
    chain_name: chain.name,
    treasury_address: treasury || null,
    accepted: cryptoTopupAssets(chainId).map((asset) => ({
      symbol: asset.symbol,
      address: asset.address,
      decimals: asset.decimals
    })),
    payment_uri: treasury ? depositPaymentUri({ chainId }) : null,
    min_confirmations: MIN_CONFIRMATIONS,
    explorer: chain.explorer?.url || null,
    rate: "1 USDC or USDT credits 1 credit.",
    steps: [
      `Send USDC or USDT to ${treasury || "the treasury address"} on ${chain.name}.`,
      "Wait for the transaction to confirm.",
      "Submit the transaction hash here; the deposit is read from the chain."
    ],
    notes: [
      "Send on this chain only. Funds sent on another chain cannot be recovered.",
      "Send the token itself, not the chain's native coin.",
      "Each transaction credits once, to one account."
    ]
  };
}

// EIP-681 is what a wallet expects from a scanned payment code: the token
// contract, the chain, and a transfer call already filled in.
//
// The recipient comes from server configuration and never from the caller. A
// QR whose destination could be set through a query string would let anyone
// send a link that renders a code paying them instead.
export function depositPaymentUri({ asset = "USDC", amount, chainId = activeSettlementChainId() } = {}) {
  const treasury = creditTreasuryAddress();
  if (!treasury) throw topupError("Crypto top-ups are not configured: no treasury address is set.", 503, "TREASURY_NOT_CONFIGURED");
  const token = cryptoTopupAssets(chainId).find((item) => item.symbol === String(asset || "").toUpperCase());
  if (!token) throw topupError(`${asset} is not an accepted deposit asset.`, 400, "UNSUPPORTED_DEPOSIT_ASSET");
  const chain = settlementChain(chainId);
  const base = `ethereum:${token.address}@${chain.id}/transfer?address=${treasury}`;
  if (amount === undefined || amount === null || amount === "") return base;
  return `${base}&uint256=${depositAtomicAmount(amount, token.decimals)}`;
}

// Decimal string to atomic units, in BigInt. An amount that rounds is a wrong
// payment, and one USDT at eighteen decimals already exceeds what a double can
// hold exactly.
export function depositAtomicAmount(amount, decimals) {
  const [whole, fraction = ""] = String(amount).trim().split(".");
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(fraction)) {
    throw topupError("That amount is not a number.", 400, "INVALID_DEPOSIT_AMOUNT");
  }
  if (fraction.length > decimals) {
    throw topupError(`That amount has more than ${decimals} decimal places.`, 400, "DEPOSIT_AMOUNT_TOO_PRECISE");
  }
  const atomic = BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (atomic <= 0n) throw topupError("Enter an amount above zero.", 400, "INVALID_DEPOSIT_AMOUNT");
  return atomic.toString();
}

async function rpc(fetchImpl, chain, method, params) {
  const response = await fetchImpl(chain.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const payload = await response.json().catch(() => ({}));
  if (payload.error) throw topupError(`Chain RPC ${method} failed: ${payload.error.message}`, 502, "DEPOSIT_RPC_FAILED");
  return payload.result;
}

function addressFromTopic(topic) {
  return `0x${String(topic || "").slice(-40)}`.toLowerCase();
}

// Amounts are read as BigInt and divided by the token's own decimals. Parsing
// through Number would silently lose precision above 2^53 atomic units, which
// an 18-decimal token reaches at 9.007 tokens.
function atomicToDecimalString(atomic, decimals) {
  const negative = atomic < 0n;
  const digits = (negative ? -atomic : atomic).toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

export async function readCryptoDeposit({ txHash, chainId = activeSettlementChainId(), fetchImpl = globalThis.fetch } = {}) {
  const hash = String(txHash || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) {
    throw topupError("A deposit needs a 32-byte transaction hash.", 400, "INVALID_TX_HASH");
  }
  const treasury = creditTreasuryAddress();
  if (!treasury) {
    throw topupError("Crypto top-ups are not configured: no treasury address is set.", 503, "TREASURY_NOT_CONFIGURED");
  }
  const chain = settlementChain(chainId);
  const assets = cryptoTopupAssets(chainId);
  if (!assets.length) {
    throw topupError(`${chain.name} has no configured deposit asset.`, 503, "NO_DEPOSIT_ASSET");
  }

  const receipt = await rpc(fetchImpl, chain, "eth_getTransactionReceipt", [hash]);
  if (!receipt) throw topupError("That transaction is not on chain yet.", 404, "DEPOSIT_NOT_FOUND");
  if (Number(receipt.status) !== 1) throw topupError("That transaction failed on chain.", 422, "DEPOSIT_TX_REVERTED");

  const head = Number(await rpc(fetchImpl, chain, "eth_blockNumber", []));
  const confirmations = Math.max(0, head - Number(receipt.blockNumber) + 1);
  if (confirmations < MIN_CONFIRMATIONS) {
    throw topupError(
      `That deposit has ${confirmations} confirmation${confirmations === 1 ? "" : "s"}; ${MIN_CONFIRMATIONS} are required.`,
      409,
      "DEPOSIT_NOT_CONFIRMED"
    );
  }

  // Sum every accepted-token transfer to the treasury in this transaction. One
  // transaction can carry more than one, and taking only the first would
  // under-credit a deposit the sender did make.
  const byAddress = new Map(assets.map((asset) => [asset.address.toLowerCase(), asset]));
  let matched = null;
  let total = 0n;
  let sender = null;
  for (const log of receipt.logs || []) {
    const asset = byAddress.get(String(log.address || "").toLowerCase());
    if (!asset) continue;
    if (String(log.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) continue;
    if (addressFromTopic(log.topics?.[2]) !== treasury) continue;
    if (matched && matched.symbol !== asset.symbol) {
      throw topupError(
        "That transaction paid in more than one token. Send one token per transaction.",
        422,
        "DEPOSIT_MIXED_TOKENS"
      );
    }
    matched = asset;
    total += BigInt(log.data || "0x0");
    sender = sender || addressFromTopic(log.topics?.[1]);
  }

  if (!matched || total <= 0n) {
    throw topupError(
      `That transaction did not send ${assets.map((a) => a.symbol).join(" or ")} to the treasury on ${chain.name}.`,
      422,
      "DEPOSIT_NOT_A_TREASURY_TRANSFER"
    );
  }

  return {
    tx_hash: hash,
    chain: chain.network,
    chain_id: chain.id,
    asset: matched.symbol,
    token_address: matched.address,
    amount: atomicToDecimalString(total, matched.decimals),
    amount_atomic: total.toString(),
    decimals: matched.decimals,
    from_address: sender,
    to_address: treasury,
    block_number: Number(receipt.blockNumber),
    confirmations,
    explorer_url: chain.explorer?.url ? `${chain.explorer.url}/tx/${hash}` : null
  };
}

// The sending address belongs to the first account that claims from it. Without
// this, every future deposit from a known address is a race between its owner
// and anyone reading the chain.
export async function depositAddressConflict(account, deposit, findAccountByDepositAddress) {
  // Awaited: the lookup hits the database, and a pending promise is truthy, so
  // calling it synchronously would read every claim as a conflict.
  const bound = await findAccountByDepositAddress?.(deposit.from_address);
  if (bound && bound.account_id !== account.account_id) {
    return topupError(
      "That sending address is already linked to another AgentRouter account.",
      409,
      "DEPOSIT_ADDRESS_BOUND_ELSEWHERE"
    );
  }
  return null;
}

export async function claimCryptoTopup(store, {
  account,
  txHash,
  chainId = activeSettlementChainId(),
  fetchImpl = globalThis.fetch,
  findAccountByDepositAddress,
  bindDepositAddress
} = {}) {
  if (!account?.account_id) throw topupError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  const deposit = await readCryptoDeposit({ txHash, chainId, fetchImpl });

  const conflict = await depositAddressConflict(account, deposit, findAccountByDepositAddress);
  if (conflict) throw conflict;

  // Idempotent on the transaction hash: a deposit credits one account, once,
  // however many times it is submitted.
  const entry = await grantCredits(store, {
    accountId: account.account_id,
    amount: deposit.amount,
    kind: "topup",
    entryId: `${deposit.chain}_${deposit.tx_hash}`,
    metadata: {
      source: "crypto_deposit",
      chain: deposit.chain,
      chain_id: deposit.chain_id,
      asset: deposit.asset,
      tx_hash: deposit.tx_hash,
      from_address: deposit.from_address,
      block_number: deposit.block_number,
      explorer_url: deposit.explorer_url
    }
  });

  if (bindDepositAddress && deposit.from_address) {
    await bindDepositAddress(account, deposit.from_address);
  }

  return { mode: "crypto_deposit", deposit, ...entry };
}

function topupError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
