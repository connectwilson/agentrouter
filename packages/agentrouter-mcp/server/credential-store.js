import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function defaultCredentialPath() {
  return process.env.AGENT_ROUTER_CREDENTIALS_FILE
    || path.join(os.homedir(), ".agentrouter", "credentials.json");
}

export async function readStoredCredential({
  credentialPath = defaultCredentialPath(),
  origin
}) {
  const normalizedOrigin = normalizeOrigin(origin);
  try {
    const source = await fs.readFile(credentialPath, "utf8");
    const payload = JSON.parse(source);
    const credential = payload?.origins?.[normalizedOrigin];
    if (!credential?.access_token) return null;
    return { ...credential };
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function writeStoredCredential({
  credentialPath = defaultCredentialPath(),
  origin,
  accessToken,
  keyId = null,
  clientName = null
}) {
  if (!accessToken) throw new Error("AgentRouter access token is required.");
  const normalizedOrigin = normalizeOrigin(origin);
  const directory = path.dirname(credentialPath);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let payload = { version: 1, origins: {} };
  try {
    const current = JSON.parse(await fs.readFile(credentialPath, "utf8"));
    if (current && typeof current === "object" && !Array.isArray(current)) payload = current;
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  if (!payload.origins || typeof payload.origins !== "object" || Array.isArray(payload.origins)) payload.origins = {};
  payload.version = 1;
  payload.origins[normalizedOrigin] = {
    access_token: String(accessToken),
    key_id: keyId || null,
    client_name: clientName || null,
    connected_at: new Date().toISOString()
  };
  const temporaryPath = `${credentialPath}.tmp.${process.pid}.${crypto.randomBytes(6).toString("hex")}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporaryPath, credentialPath);
  await fs.chmod(credentialPath, 0o600);
  return { credential_path: credentialPath, origin: normalizedOrigin };
}

function normalizeOrigin(value) {
  return String(value || "https://agentrouter.network").replace(/\/$/, "");
}
