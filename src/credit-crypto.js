// Crypto credit top-ups: the user sends USDC or USDT to the treasury on the
// settlement chain and submits the transaction hash. The server reads the
// receipt from the chain and credits the account.
//
// Deliberately no deposit-address custody and no chain watcher. Both mean
// holding keys or running a process that must survive reorgs; reading one
// receipt on demand needs neither and fails closed when the RPC is down.
//
// A transaction hash is public, so it is evidence that value moved but not
// evidence that the claimant controls the sender. A fresh sender is bound only
// after its wallet signs a short-lived, account/transaction/domain-bound nonce.
// Once verified, future deposits from that address retain the one-click flow.
import crypto from "node:crypto";
import { recoverMessageAddress } from "viem";
import { settlementChain, settlementAsset, activeSettlementChainId } from "./chains.js";
import { grantCredits } from "./credits.js";

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export const MIN_CONFIRMATIONS = Number(process.env.ADN_CREDITS_MIN_CONFIRMATIONS || 3);
export const DEPOSIT_OWNERSHIP_TTL_MS = boundedOwnershipTtl(process.env.ADN_DEPOSIT_OWNERSHIP_TTL_MS);

const depositOwnershipChallenges = new Map();
const depositOwnershipChallengeKeys = new Map();
const consumedDepositOwnershipNonces = new Map();
const depositSenderLocks = new Map();
const depositOwnershipSecret = crypto.createHash("sha256").update(
  String(process.env.ADN_DEPOSIT_OWNERSHIP_SECRET || process.env.ADN_BROWSER_HANDOFF_SECRET || crypto.randomBytes(32).toString("hex"))
).digest();

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
      "Submit the transaction hash here; the deposit is read from the chain.",
      "For a wallet's first deposit, sign the one-time ownership message in that wallet. This signature sends no transaction and costs no gas."
    ],
    notes: [
      "Send on this chain only. Funds sent on another chain cannot be recovered.",
      "Send the token itself, not the chain's native coin.",
      "Each transaction credits once, to one account.",
      "A public transaction hash alone cannot claim a fresh sending wallet."
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
    const transferSender = addressFromTopic(log.topics?.[1]);
    if (transferSender === "0x0000000000000000000000000000000000000000") {
      throw topupError("A token mint cannot be claimed as a wallet-owned deposit.", 422, "DEPOSIT_SENDER_UNCLAIMABLE");
    }
    if (sender && sender !== transferSender) {
      throw topupError(
        "That transaction combines treasury transfers from multiple senders and cannot be bound to one wallet.",
        422,
        "DEPOSIT_MIXED_SENDERS"
      );
    }
    matched = asset;
    total += BigInt(log.data || "0x0");
    sender = transferSender;
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

export function createDepositOwnershipChallenge({ account, deposit, domain, now = Date.now() } = {}) {
  assertOwnershipBindingInputs({ account, deposit });
  const normalizedDomain = normalizeProofDomain(domain);
  sweepDepositOwnershipState(now);
  const key = ownershipChallengeKey({ account, deposit, domain: normalizedDomain });
  const existingNonce = depositOwnershipChallengeKeys.get(key);
  const existing = existingNonce ? depositOwnershipChallenges.get(existingNonce) : null;
  if (existing && existing.expires_at_ms > now) return publicOwnershipChallenge(existing);
  if (existingNonce) {
    depositOwnershipChallenges.delete(existingNonce);
    depositOwnershipChallengeKeys.delete(key);
  }

  const expiresAtMs = now + DEPOSIT_OWNERSHIP_TTL_MS;
  const bindings = {
    challenge_version: "agentrouter_deposit_ownership_v1",
    domain: normalizedDomain,
    owner: account.account_id,
    tx_hash: normalizeTxHash(deposit.tx_hash),
    sender_address: normalizeEvmAddress(deposit.from_address, "deposit sender"),
    chain_id: normalizeChainId(deposit.chain_id),
    expires_at: new Date(expiresAtMs).toISOString(),
    expires_at_ms: expiresAtMs,
    jti: crypto.randomBytes(18).toString("base64url")
  };
  const nonce = createOpaqueOwnershipNonce(bindings);
  const challenge = { ...bindings, nonce, key };
  challenge.message = depositOwnershipMessage(challenge);
  depositOwnershipChallenges.set(nonce, challenge);
  depositOwnershipChallengeKeys.set(key, nonce);
  return publicOwnershipChallenge(challenge);
}

export async function verifyDepositOwnershipProof({ account, deposit, proof, domain, now = Date.now(), claimOwnershipNonce = null } = {}) {
  assertOwnershipBindingInputs({ account, deposit });
  const nonce = String(proof?.nonce || "").trim();
  if (!nonce || consumedDepositOwnershipNonces.has(nonce)) {
    throw topupError("That wallet ownership proof has already been used.", 409, "DEPOSIT_OWNERSHIP_PROOF_REPLAYED");
  }
  const localChallenge = depositOwnershipChallenges.get(nonce);
  const challenge = localChallenge || decodeOpaqueOwnershipNonce(nonce);
  if (!challenge) {
    throw topupError("That wallet ownership challenge is unknown or no longer available.", 409, "DEPOSIT_OWNERSHIP_CHALLENGE_UNKNOWN");
  }
  if (challenge.expires_at_ms < now) {
    removeOwnershipChallenge(challenge);
    throw topupError("That wallet ownership challenge expired. Request a new one.", 410, "DEPOSIT_OWNERSHIP_PROOF_EXPIRED");
  }

  const normalizedDomain = normalizeProofDomain(domain);
  if (challenge.owner !== account.account_id) {
    throw topupError("That wallet proof was issued for another AgentRouter account.", 409, "DEPOSIT_OWNERSHIP_OWNER_MISMATCH");
  }
  if (challenge.tx_hash !== normalizeTxHash(deposit.tx_hash)) {
    throw topupError("That wallet proof was issued for another deposit transaction.", 409, "DEPOSIT_OWNERSHIP_TX_MISMATCH");
  }
  if (challenge.sender_address !== normalizeEvmAddress(deposit.from_address, "deposit sender")) {
    throw topupError("That wallet proof was issued for another sending address.", 409, "DEPOSIT_OWNERSHIP_SENDER_MISMATCH");
  }
  if (challenge.chain_id !== normalizeChainId(deposit.chain_id)) {
    throw topupError("That wallet proof was issued for another chain.", 409, "DEPOSIT_OWNERSHIP_CHAIN_MISMATCH");
  }
  if (challenge.domain !== normalizedDomain) {
    throw topupError("That wallet proof was issued for another domain.", 409, "DEPOSIT_OWNERSHIP_DOMAIN_MISMATCH");
  }
  const claimedSender = normalizeEvmAddress(proof?.sender_address, "proof sender");
  if (claimedSender !== challenge.sender_address) {
    throw topupError("The proof sender does not match the deposit sender.", 409, "DEPOSIT_OWNERSHIP_SENDER_MISMATCH");
  }
  const signature = String(proof?.signature || "").trim();
  if (!/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(signature)) {
    throw topupError("The wallet ownership signature is malformed.", 422, "DEPOSIT_OWNERSHIP_SIGNATURE_INVALID");
  }

  let recovered;
  try {
    recovered = String(await recoverMessageAddress({ message: challenge.message, signature })).toLowerCase();
  } catch {
    throw topupError("The wallet ownership signature could not be verified.", 422, "DEPOSIT_OWNERSHIP_SIGNATURE_INVALID");
  }
  if (recovered !== challenge.sender_address) {
    throw topupError("The wallet signature was not made by the deposit sender.", 422, "DEPOSIT_OWNERSHIP_SIGNATURE_INVALID");
  }

  // Signature recovery is async. Re-read before consuming so two concurrent
  // submissions cannot both pass a stale pre-verification lookup.
  if (localChallenge && depositOwnershipChallenges.get(nonce) !== challenge) {
    throw topupError("That wallet ownership proof has already been used.", 409, "DEPOSIT_OWNERSHIP_PROOF_REPLAYED");
  }
  if (claimOwnershipNonce) {
    let claimed;
    try {
      claimed = await claimOwnershipNonce(nonce, challenge.expires_at);
    } catch (error) {
      throw topupError(`Wallet ownership replay protection is unavailable: ${error.message}`, 503, "DEPOSIT_OWNERSHIP_REPLAY_GUARD_UNAVAILABLE");
    }
    if (!claimed) {
      if (localChallenge) removeOwnershipChallenge(challenge);
      consumedDepositOwnershipNonces.set(nonce, Math.max(challenge.expires_at_ms, now) + DEPOSIT_OWNERSHIP_TTL_MS);
      throw topupError("That wallet ownership proof has already been used.", 409, "DEPOSIT_OWNERSHIP_PROOF_REPLAYED");
    }
  }
  // A no-database/local runtime can still race while an async signature is
  // recovering, so claim the process-local nonce after any shared DB claim.
  if (consumedDepositOwnershipNonces.has(nonce)) {
    throw topupError("That wallet ownership proof has already been used.", 409, "DEPOSIT_OWNERSHIP_PROOF_REPLAYED");
  }
  if (localChallenge) removeOwnershipChallenge(challenge);
  consumedDepositOwnershipNonces.set(nonce, Math.max(challenge.expires_at_ms, now) + DEPOSIT_OWNERSHIP_TTL_MS);
  return true;
}

export async function claimCryptoTopup(store, {
  account,
  txHash,
  chainId = activeSettlementChainId(),
  fetchImpl = globalThis.fetch,
  findAccountByDepositAddress,
  bindDepositAddress,
  proofDomain,
  ownershipProof = null,
  claimOwnershipNonce = null,
  now = Date.now()
} = {}) {
  if (!account?.account_id) throw topupError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  const deposit = await readCryptoDeposit({ txHash, chainId, fetchImpl });
  return withDepositSenderLock(deposit.from_address, async () => {
    const bound = await findAccountByDepositAddress?.(deposit.from_address);
    if (bound && bound.account_id !== account.account_id) {
      throw topupError(
        "That sending address is already linked to another AgentRouter account.",
        409,
        "DEPOSIT_ADDRESS_BOUND_ELSEWHERE"
      );
    }
    const accountAddress = String(account.deposit_address || "").toLowerCase();
    if (accountAddress && accountAddress !== deposit.from_address) {
      throw topupError(
        "This AgentRouter account is already linked to another deposit wallet.",
        409,
        "DEPOSIT_ACCOUNT_BOUND_TO_DIFFERENT_ADDRESS"
      );
    }

    const alreadyBound = accountAddress === deposit.from_address || bound?.account_id === account.account_id;
    if (!alreadyBound) {
      if (!ownershipProof) {
        const challenge = createDepositOwnershipChallenge({ account, deposit, domain: proofDomain, now });
        const error = topupError(
          "Sign the one-time message with the wallet that sent this deposit.",
          428,
          "DEPOSIT_OWNERSHIP_PROOF_REQUIRED"
        );
        error.challenge = challenge;
        throw error;
      }
      await verifyDepositOwnershipProof({ account, deposit, proof: ownershipProof, domain: proofDomain, now, claimOwnershipNonce });
      if (!bindDepositAddress) {
        throw topupError("Deposit wallet binding is unavailable.", 503, "DEPOSIT_BINDING_UNAVAILABLE");
      }
      try {
        await bindDepositAddress(account, deposit.from_address);
      } catch (error) {
        const winner = await findAccountByDepositAddress?.(deposit.from_address);
        if (winner && winner.account_id !== account.account_id) {
          throw topupError(
            "That sending address is already linked to another AgentRouter account.",
            409,
            "DEPOSIT_ADDRESS_BOUND_ELSEWHERE"
          );
        }
        throw error;
      }
    }

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
    return { mode: "crypto_deposit", deposit, ...entry };
  });
}

function publicOwnershipChallenge(challenge) {
  return {
    challenge_version: challenge.challenge_version,
    nonce: challenge.nonce,
    domain: challenge.domain,
    owner: challenge.owner,
    tx_hash: challenge.tx_hash,
    sender_address: challenge.sender_address,
    chain_id: challenge.chain_id,
    expires_at: challenge.expires_at,
    message: challenge.message
  };
}

function depositOwnershipMessage(challenge) {
  return [
    `${challenge.domain} requests proof of deposit-wallet ownership.`,
    "",
    "This signature only links a confirmed token deposit to your AgentRouter account.",
    "It does not submit a transaction, spend tokens, or authorize future transfers.",
    "",
    `Domain: ${challenge.domain}`,
    `Owner: ${challenge.owner}`,
    `Chain ID: ${challenge.chain_id}`,
    `Transaction: ${challenge.tx_hash}`,
    `Sender: ${challenge.sender_address}`,
    `Nonce: ${crypto.createHash("sha256").update(challenge.nonce).digest("hex")}`,
    `Expires At: ${challenge.expires_at}`
  ].join("\n");
}

function ownershipChallengeKey({ account, deposit, domain }) {
  return [account.account_id, normalizeChainId(deposit.chain_id), normalizeTxHash(deposit.tx_hash), normalizeEvmAddress(deposit.from_address, "deposit sender"), domain].join(":");
}

function createOpaqueOwnershipNonce(bindings) {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    domain: bindings.domain,
    owner: bindings.owner,
    tx: bindings.tx_hash,
    sender: bindings.sender_address,
    chain: bindings.chain_id,
    exp: bindings.expires_at_ms,
    jti: bindings.jti
  })).toString("base64url");
  const mac = crypto.createHmac("sha256", depositOwnershipSecret).update(payload).digest("base64url");
  return `deposit_${payload}.${mac}`;
}

function decodeOpaqueOwnershipNonce(nonce) {
  const match = /^deposit_([A-Za-z0-9_-]{20,2048})\.([A-Za-z0-9_-]{43})$/.exec(String(nonce || ""));
  if (!match) return null;
  const expected = crypto.createHmac("sha256", depositOwnershipSecret).update(match[1]).digest();
  let supplied;
  try {
    supplied = Buffer.from(match[2], "base64url");
  } catch {
    return null;
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload?.v !== 1 || !Number.isSafeInteger(payload.exp) || !payload.jti) return null;
  try {
    const challenge = {
      challenge_version: "agentrouter_deposit_ownership_v1",
      nonce: String(nonce),
      domain: normalizeProofDomain(payload.domain),
      owner: String(payload.owner || ""),
      tx_hash: normalizeTxHash(payload.tx),
      sender_address: normalizeEvmAddress(payload.sender, "deposit sender"),
      chain_id: normalizeChainId(payload.chain),
      expires_at: new Date(payload.exp).toISOString(),
      expires_at_ms: payload.exp,
      jti: String(payload.jti)
    };
    challenge.key = [challenge.owner, challenge.chain_id, challenge.tx_hash, challenge.sender_address, challenge.domain].join(":");
    challenge.message = depositOwnershipMessage(challenge);
    return challenge;
  } catch {
    return null;
  }
}

function removeOwnershipChallenge(challenge) {
  depositOwnershipChallenges.delete(challenge.nonce);
  if (depositOwnershipChallengeKeys.get(challenge.key) === challenge.nonce) {
    depositOwnershipChallengeKeys.delete(challenge.key);
  }
}

function sweepDepositOwnershipState(now, maxScanned = 256) {
  let scanned = 0;
  for (const challenge of depositOwnershipChallenges.values()) {
    if (scanned >= maxScanned) break;
    scanned += 1;
    if (challenge.expires_at_ms < now) removeOwnershipChallenge(challenge);
  }
  scanned = 0;
  for (const [nonce, expiry] of consumedDepositOwnershipNonces) {
    if (scanned >= maxScanned) break;
    scanned += 1;
    if (expiry < now) consumedDepositOwnershipNonces.delete(nonce);
  }
}

function assertOwnershipBindingInputs({ account, deposit }) {
  if (!account?.account_id) throw topupError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  normalizeTxHash(deposit?.tx_hash);
  normalizeEvmAddress(deposit?.from_address, "deposit sender");
  normalizeChainId(deposit?.chain_id);
}

function normalizeProofDomain(value) {
  const raw = String(value || "").trim();
  if (!raw || raw.length > 512) throw topupError("Deposit ownership domain is required.", 400, "DEPOSIT_OWNERSHIP_DOMAIN_REQUIRED");
  let host;
  try {
    host = new URL(raw.includes("://") ? raw : `https://${raw}`).host.toLowerCase();
  } catch {
    throw topupError("Deposit ownership domain is invalid.", 400, "DEPOSIT_OWNERSHIP_DOMAIN_INVALID");
  }
  if (!host || host.length > 255) throw topupError("Deposit ownership domain is invalid.", 400, "DEPOSIT_OWNERSHIP_DOMAIN_INVALID");
  return host;
}

function normalizeTxHash(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) throw topupError("Deposit transaction hash is invalid.", 400, "INVALID_TX_HASH");
  return normalized;
}

function normalizeEvmAddress(value, label) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(normalized)) throw topupError(`${label} is not a valid EVM address.`, 400, "INVALID_DEPOSIT_SENDER");
  return normalized;
}

function normalizeChainId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n) throw topupError("Deposit chain id is invalid.", 400, "INVALID_DEPOSIT_CHAIN");
  return BigInt(normalized).toString();
}

function boundedOwnershipTtl(value) {
  const configured = Number(value || 5 * 60_000);
  return Number.isFinite(configured) ? Math.max(30_000, Math.min(15 * 60_000, Math.floor(configured))) : 5 * 60_000;
}

async function withDepositSenderLock(sender, operation) {
  const key = String(sender || "").toLowerCase();
  const previous = depositSenderLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  depositSenderLocks.set(key, current);
  await previous.catch(() => {});
  try {
    return await operation();
  } finally {
    release();
    if (depositSenderLocks.get(key) === current) depositSenderLocks.delete(key);
  }
}

function topupError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
