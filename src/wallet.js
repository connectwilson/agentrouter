import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keccak256 } from "./keccak.js";
import { settlementAsset, settlementChain } from "./chains.js";

const activeChain = settlementChain();

export const ADN_DIR = path.resolve(process.env.ADN_DIR || path.join(os.homedir(), ".agentrouter", "adn"));
export const WALLET_PATH = path.join(ADN_DIR, "wallet.json");
export const WALLET_SESSION_SECRET_PATH = path.join(ADN_DIR, "wallet-session.key");
export const POLICY_PATH = path.join(ADN_DIR, "policy.json");
export const PAYMENT_LOG_PATH = path.join(ADN_DIR, "payments.log");
export const USED_CHALLENGES_PATH = path.join(ADN_DIR, "used-challenges.json");

export const DEFAULT_POLICY = {
  enabled: true,
  // The active settlement chain is always permitted so a chain switch needs no
  // policy edit. The pricing networks manifests already declare stay permitted
  // too — narrowing to the settlement chain alone would reject every service
  // that prices in one network and settles in another.
  network_allowlist: [...new Set([activeChain.network, activeChain.caip2, "base", "base-sepolia", "agentrouter"])],
  asset_allowlist: [settlementAsset().symbol],
  per_call_limit_usdc: "0.05",
  daily_limit_usdc: "2",
  service_allowlist: [],
  provider_allowlist: [],
  pay_to_allowlist: [],
  deny_unknown_payment_targets: true,
  require_manifest_match: true,
  require_402_challenge: true,
  require_confirmation_above_usdc: "0.05",
  chain_allowlist: [activeChain.id]
};

export async function ensureAdnDir() {
  await fs.mkdir(ADN_DIR, { recursive: true });
}

export async function initWallet({ force = false, passphrase = null, keyManagement = "user_passphrase" } = {}) {
  await ensureAdnDir();
  if (!force && await fileExists(WALLET_PATH)) {
    return readWalletPublic();
  }

  const { privateKey, publicKey, publicKeyHex } = generateEvmKeypair();
  const address = deriveAddress(publicKey);
  const walletPassphrase = passphrase || getWalletPassphrase();
  const encryptedPrivateKey = encryptPrivateKey(privateKey, walletPassphrase);
  const walletFile = {
    wallet_version: "adn_encrypted_evm_wallet_v1",
    address_type: "evm",
    network_hint: "base",
    key_management: keyManagement,
    address,
    public_key_hex: publicKeyHex,
    public_key_pem: publicKey,
    encrypted_private_key: encryptedPrivateKey,
    created_at: new Date().toISOString()
  };
  await fs.writeFile(WALLET_PATH, `${JSON.stringify(walletFile, null, 2)}\n`, { mode: 0o600 });
  if (!await fileExists(POLICY_PATH)) {
    await writePolicy(DEFAULT_POLICY);
  }
  return publicWallet(walletFile);
}

export async function initSessionWallet({ force = false } = {}) {
  const passphrase = await readOrCreateSessionPassphrase({ force });
  return initWallet({
    force,
    passphrase,
    keyManagement: "local_session_secret"
  });
}

export async function readWallet() {
  const content = await fs.readFile(WALLET_PATH, "utf8");
  const walletFile = JSON.parse(content);
  if (walletFile.private_key_pem) {
    return walletFile;
  }
  const passphrase = walletFile.key_management === "local_session_secret"
    ? getSessionWalletPassphrase()
    : getWalletPassphrase();
  const privateKey = decryptPrivateKey(walletFile.encrypted_private_key, passphrase);
  return {
    wallet_version: walletFile.wallet_version,
    address_type: walletFile.address_type || "evm",
    network_hint: walletFile.network_hint || "base",
    key_management: walletFile.key_management || "user_passphrase",
    address: walletFile.address,
    public_key_hex: walletFile.public_key_hex || publicKeyPemToHex(walletFile.public_key_pem),
    public_key_pem: walletFile.public_key_pem,
    private_key_hex: privateKeyPemToHex(privateKey),
    private_key_pem: privateKey,
    created_at: walletFile.created_at
  };
}

export async function readWalletPublic() {
  const content = await fs.readFile(WALLET_PATH, "utf8");
  return publicWallet(JSON.parse(content));
}

export async function walletStatus() {
  const exists = await fileExists(WALLET_PATH);
  const policy = await readPolicy();
  if (!exists) {
    return {
      initialized: false,
      wallet_path: WALLET_PATH,
      policy
    };
  }
  const wallet = await readWalletPublic();
  return {
    initialized: true,
    address: wallet.address,
    address_type: wallet.address_type || "evm",
    network_hint: wallet.network_hint || "base",
    key_management: wallet.key_management || "user_passphrase",
    wallet_path: WALLET_PATH,
    encrypted: true,
    policy
  };
}

export async function readPolicy() {
  if (!await fileExists(POLICY_PATH)) {
    await ensureAdnDir();
    await writePolicy(DEFAULT_POLICY);
  }
  return JSON.parse(await fs.readFile(POLICY_PATH, "utf8"));
}

export async function writePolicy(policy) {
  await ensureAdnDir();
  await fs.writeFile(POLICY_PATH, `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}

export async function updatePolicy(patch) {
  const policy = await readPolicy();
  return writePolicy({ ...policy, ...patch });
}

export async function assertPolicyAllows({ serviceId, amount, currency, network, payTo, providerId, manifest, challenge }) {
  const policy = await readPolicy();
  if (!policy.enabled) {
    throw new Error("Wallet policy is disabled.");
  }
  if (!policy.network_allowlist.includes(network)) {
    throw new Error(`Network ${network} is not allowed by wallet policy.`);
  }
  if (challenge?.chain_id && Array.isArray(policy.chain_allowlist) && policy.chain_allowlist.length && !policy.chain_allowlist.includes(Number(challenge.chain_id))) {
    throw new Error(`Chain ${challenge.chain_id} is not allowed by wallet policy.`);
  }
  if (!policy.asset_allowlist.includes(currency)) {
    throw new Error(`Asset ${currency} is not allowed by wallet policy.`);
  }
  if (policy.service_allowlist.length && !policy.service_allowlist.includes(serviceId)) {
    throw new Error(`Service ${serviceId} is not allowed by wallet policy.`);
  }
  if (policy.provider_allowlist.length && !policy.provider_allowlist.includes(providerId)) {
    throw new Error(`Provider ${providerId} is not allowed by wallet policy.`);
  }
  if (policy.pay_to_allowlist.length && !policy.pay_to_allowlist.includes(payTo)) {
    throw new Error(`Payment target ${payTo} is not allowed by wallet policy.`);
  }
  if (Number(amount) > Number(policy.per_call_limit_usdc)) {
    throw new Error(`Payment amount ${amount} ${currency} exceeds per-call policy limit ${policy.per_call_limit_usdc} ${currency}.`);
  }
  if (policy.require_402_challenge && (!challenge?.nonce || !challenge?.expires_at || !challenge?.resource_hash)) {
    throw new Error("Payment requires a complete HTTP 402 challenge.");
  }
  if (challenge?.expires_at && Date.parse(challenge.expires_at) < Date.now()) {
    throw new Error("Payment challenge has expired.");
  }
  if (await isChallengeUsed(challenge?.nonce)) {
    throw new Error("Payment challenge nonce was already used.");
  }
  if (policy.require_manifest_match) {
    assertManifestMatches({ serviceId, amount, currency, network, payTo, manifest, challenge });
  }

  const spentToday = await getSpentToday({ currency });
  const nextTotal = spentToday + Number(amount);
  if (nextTotal > Number(policy.daily_limit_usdc)) {
    throw new Error(`Daily spend ${nextTotal} ${currency} would exceed policy limit ${policy.daily_limit_usdc} ${currency}.`);
  }

  return {
    ok: true,
    policy,
    spent_today: spentToday,
    next_total: nextTotal
  };
}

export async function recordPayment(event) {
  await ensureAdnDir();
  await fs.appendFile(PAYMENT_LOG_PATH, `${JSON.stringify({ ...event, created_at: new Date().toISOString() })}\n`);
  if (event.challenge_nonce) {
    await markChallengeUsed(event.challenge_nonce);
  }
}

export async function readPaymentLog() {
  if (!await fileExists(PAYMENT_LOG_PATH)) return [];
  const content = await fs.readFile(PAYMENT_LOG_PATH, "utf8");
  return content.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export async function getSpentToday({ currency = "USDC" } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const events = await readPaymentLog();
  return events
    .filter((event) => event.status === "success")
    .filter((event) => event.currency === currency)
    .filter((event) => event.created_at?.slice(0, 10) === today)
    .reduce((sum, event) => sum + Number(event.amount), 0);
}

export async function resetWalletForTests() {
  await fs.rm(ADN_DIR, { recursive: true, force: true });
}

export function deriveAddress(publicKeyPem) {
  const publicKey = publicKeyPemToBytes(publicKeyPem);
  return `0x${keccak256(publicKey).subarray(-20).toString("hex")}`;
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertManifestMatches({ serviceId, amount, currency, network, payTo, manifest, challenge }) {
  if (!manifest) throw new Error("Manifest is required for payment policy checks.");
  if (manifest.service_id !== serviceId) throw new Error("Manifest service_id does not match payment service.");
  if (String(manifest.pricing.amount) !== String(amount)) throw new Error("Payment amount does not match manifest price.");
  if (manifest.pricing.currency !== currency) throw new Error("Payment currency does not match manifest currency.");
  if (manifest.pricing.network !== network) throw new Error("Payment network does not match manifest network.");
  if (challenge?.service_id && challenge.service_id !== serviceId) throw new Error("Challenge service_id does not match manifest.");
  if (challenge?.resource && challenge.resource !== serviceId) throw new Error("Challenge resource does not match manifest.");
  if (challenge?.pay_to && challenge.pay_to !== payTo) throw new Error("Challenge pay_to does not match payment target.");
}

function getWalletPassphrase() {
  const passphrase = process.env.ADN_WALLET_PASSPHRASE || readSessionPassphraseSync();
  if (!passphrase) {
    throw new Error("ADN_WALLET_PASSPHRASE or a local AgentRouter session wallet secret is required to unlock the local Agent Wallet.");
  }
  if (passphrase.length < 8) {
    throw new Error("ADN_WALLET_PASSPHRASE must be at least 8 characters.");
  }
  return passphrase;
}

function getSessionWalletPassphrase() {
  const passphrase = readSessionPassphraseSync();
  if (!passphrase) {
    throw new Error("Local AgentRouter session wallet secret is required to unlock the local session wallet.");
  }
  return passphrase;
}

function encryptPrivateKey(privateKeyPem, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(passphrase, salt, 32);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKeyPem, "utf8"), cipher.final()]);
  return {
    kdf: "scrypt",
    cipher: "aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decryptPrivateKey(encrypted, passphrase) {
  const salt = Buffer.from(encrypted.salt, "base64");
  const iv = Buffer.from(encrypted.iv, "base64");
  const tag = Buffer.from(encrypted.tag, "base64");
  const ciphertext = Buffer.from(encrypted.ciphertext, "base64");
  const key = crypto.scryptSync(passphrase, salt, 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function publicWallet(walletFile) {
  return {
    wallet_version: walletFile.wallet_version,
    address_type: walletFile.address_type || "evm",
    network_hint: walletFile.network_hint || "base",
    key_management: walletFile.key_management || "user_passphrase",
    address: walletFile.address,
    public_key_hex: walletFile.public_key_hex || publicKeyPemToHex(walletFile.public_key_pem),
    public_key_pem: walletFile.public_key_pem,
    created_at: walletFile.created_at
  };
}

async function readOrCreateSessionPassphrase({ force = false } = {}) {
  await ensureAdnDir();
  if (!force && await fileExists(WALLET_SESSION_SECRET_PATH)) {
    return (await fs.readFile(WALLET_SESSION_SECRET_PATH, "utf8")).trim();
  }
  const passphrase = crypto.randomBytes(32).toString("base64url");
  await fs.writeFile(WALLET_SESSION_SECRET_PATH, `${passphrase}\n`, { mode: 0o600 });
  return passphrase;
}

function readSessionPassphraseSync() {
  try {
    return fsSync.readFileSync(WALLET_SESSION_SECRET_PATH, "utf8").trim();
  } catch {
    return "";
  }
}

function generateEvmKeypair() {
  const ecdh = crypto.createECDH("secp256k1");
  while (true) {
    try {
      ecdh.setPrivateKey(crypto.randomBytes(32));
      break;
    } catch {
      // Retry the extremely rare invalid scalar.
    }
  }
  const uncompressedPublicKey = ecdh.getPublicKey(null, "uncompressed");
  const publicKey = uncompressedPublicKey.subarray(1);
  const privateKeyBytes = ecdh.getPrivateKey();
  const privateKeyObject = crypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "secp256k1",
      x: publicKey.subarray(0, 32).toString("base64url"),
      y: publicKey.subarray(32, 64).toString("base64url"),
      d: privateKeyBytes.toString("base64url")
    },
    format: "jwk"
  });
  const publicKeyObject = crypto.createPublicKey(privateKeyObject);
  return {
    privateKey: privateKeyObject.export({ type: "pkcs8", format: "pem" }),
    publicKey: publicKeyObject.export({ type: "spki", format: "pem" }),
    publicKeyHex: `0x${publicKey.toString("hex")}`
  };
}

function publicKeyPemToBytes(publicKeyPem) {
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: "jwk" });
  if (!jwk.x || !jwk.y) {
    throw new Error("Unsupported public key format for EVM address derivation.");
  }
  return Buffer.concat([
    Buffer.from(jwk.x, "base64url"),
    Buffer.from(jwk.y, "base64url")
  ]);
}

function publicKeyPemToHex(publicKeyPem) {
  return `0x${publicKeyPemToBytes(publicKeyPem).toString("hex")}`;
}

function privateKeyPemToHex(privateKeyPem) {
  const jwk = crypto.createPrivateKey(privateKeyPem).export({ format: "jwk" });
  if (!jwk.d) {
    throw new Error("Unsupported private key format for EVM signing.");
  }
  return `0x${Buffer.from(jwk.d, "base64url").toString("hex").padStart(64, "0")}`;
}

async function isChallengeUsed(nonce) {
  if (!nonce) return false;
  const used = await readUsedChallenges();
  return used.includes(nonce);
}

async function markChallengeUsed(nonce) {
  const used = await readUsedChallenges();
  if (!used.includes(nonce)) {
    used.push(nonce);
    await fs.writeFile(USED_CHALLENGES_PATH, `${JSON.stringify(used, null, 2)}\n`);
  }
}

async function readUsedChallenges() {
  if (!await fileExists(USED_CHALLENGES_PATH)) return [];
  return JSON.parse(await fs.readFile(USED_CHALLENGES_PATH, "utf8"));
}
