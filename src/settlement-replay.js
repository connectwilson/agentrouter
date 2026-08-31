import fs from "node:fs/promises";
import path from "node:path";
import { claimPersistentSettlementTransaction, persistenceEnabled } from "./persistence.js";
import { ADN_DIR, ensureAdnDir } from "./wallet.js";

const REPLAY_ROOT = path.join(ADN_DIR, "settlement-replay");

// Claims a verified on-chain settlement exactly once. Hosted runtimes use the
// database uniqueness constraint; local/self-hosted runtimes use O_EXCL marker
// creation, which is atomic across processes sharing ADN_DIR. Claims are an
// append-only payment ledger and never expire: deleting an old claim would make
// the still-valid chain transaction spendable again.
export async function claimSettlementTransaction({ chainId, txHash, serviceId = null, payer = null } = {}) {
  const normalizedChainId = normalizeChainId(chainId);
  const normalizedTxHash = normalizeTxHash(txHash);

  if (persistenceEnabled()) {
    return claimPersistentSettlementTransaction({
      chainId: normalizedChainId,
      txHash: normalizedTxHash,
      serviceId: boundedMetadata(serviceId, 256),
      payer: boundedMetadata(payer, 128)
    });
  }

  await ensureAdnDir();
  const shardDirectory = path.join(REPLAY_ROOT, normalizedChainId, normalizedTxHash.slice(2, 4));
  await fs.mkdir(shardDirectory, { recursive: true, mode: 0o700 });
  const claimPath = path.join(shardDirectory, `${normalizedTxHash.slice(2)}.claim`);
  let handle;
  try {
    handle = await fs.open(claimPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify({
      version: "adn_settlement_replay_claim_v1",
      chain_id: normalizedChainId,
      tx_hash: normalizedTxHash,
      service_id: boundedMetadata(serviceId, 256),
      payer: boundedMetadata(payer, 128),
      consumed_at: new Date().toISOString()
    })}\n`);
    await handle.sync();
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    const wrapped = new Error(`Settlement replay guard could not durably claim ${normalizedTxHash}.`, { cause: error });
    wrapped.code = "SETTLEMENT_REPLAY_GUARD_UNAVAILABLE";
    throw wrapped;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function normalizeChainId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^\d+$/.test(normalized) || BigInt(normalized) <= 0n) {
    const error = new Error("Settlement replay claims require a positive numeric chain id.");
    error.code = "INVALID_SETTLEMENT_CHAIN_ID";
    throw error;
  }
  return BigInt(normalized).toString();
}

function normalizeTxHash(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalized)) {
    const error = new Error("Settlement replay claims require a canonical EVM transaction hash.");
    error.code = "INVALID_SETTLEMENT_TX_HASH";
    throw error;
  }
  return normalized;
}

function boundedMetadata(value, maxLength) {
  if (value == null) return null;
  return String(value).slice(0, maxLength);
}
