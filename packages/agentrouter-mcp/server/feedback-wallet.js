import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const agentRouterDir = path.resolve(process.env.ADN_DIR || path.join(os.homedir(), ".agentrouter", "adn"));
const existingWalletPath = path.join(agentRouterDir, "wallet.json");
const sessionSecretPath = path.join(agentRouterDir, "wallet-session.key");
const feedbackSignerPath = path.join(agentRouterDir, "feedback-signer.json");
const feedbackSignerSecretPath = path.join(agentRouterDir, "feedback-signer.key");

export async function readOrCreateFeedbackSigner() {
  const existing = await readExistingAgentRouterWallet().catch(() => null);
  if (existing) return privateKeyToAccount(existing);
  await fs.mkdir(agentRouterDir, { recursive: true, mode: 0o700 });
  try {
    const encrypted = JSON.parse(await fs.readFile(feedbackSignerPath, "utf8"));
    const secret = await fs.readFile(feedbackSignerSecretPath);
    return privateKeyToAccount(decrypt(encrypted, secret));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const privateKey = generatePrivateKey();
  const secret = crypto.randomBytes(32);
  await fs.writeFile(feedbackSignerSecretPath, secret, { mode: 0o600 });
  await fs.writeFile(feedbackSignerPath, `${JSON.stringify(encrypt(privateKey, secret), null, 2)}\n`, { mode: 0o600 });
  return privateKeyToAccount(privateKey);
}

async function readExistingAgentRouterWallet() {
  const wallet = JSON.parse(await fs.readFile(existingWalletPath, "utf8"));
  if (wallet.private_key_hex) return normalizePrivateKey(wallet.private_key_hex);
  if (wallet.private_key_pem) return privateKeyPemToHex(wallet.private_key_pem);
  if (!wallet.encrypted_private_key) return null;
  const passphrase = wallet.key_management === "local_session_secret"
    ? (await fs.readFile(sessionSecretPath, "utf8")).trim()
    : String(process.env.ADN_WALLET_PASSPHRASE || "");
  if (!passphrase) return null;
  const privateKeyPem = decryptLegacyWallet(wallet.encrypted_private_key, passphrase);
  return privateKeyPemToHex(privateKeyPem);
}

function encrypt(privateKey, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return {
    version: 1,
    cipher: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64")
  };
}

function decrypt(encrypted, secret) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", secret, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function decryptLegacyWallet(encrypted, passphrase) {
  const key = crypto.scryptSync(passphrase, Buffer.from(encrypted.salt, "base64"), 32);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]).toString("utf8");
}

function privateKeyPemToHex(privateKeyPem) {
  const jwk = crypto.createPrivateKey(privateKeyPem).export({ format: "jwk" });
  if (!jwk.d) throw new Error("Unsupported AgentRouter wallet format.");
  return `0x${Buffer.from(jwk.d, "base64url").toString("hex").padStart(64, "0")}`;
}

function normalizePrivateKey(value) {
  const key = String(value || "").trim();
  return key.startsWith("0x") ? key : `0x${key}`;
}
