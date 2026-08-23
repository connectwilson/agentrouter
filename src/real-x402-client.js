import { currentPaymentBackend } from "./payment-adapter.js";

export function isRealX402Enabled() {
  return currentPaymentBackend() === "x402";
}

export async function invokeWithRealX402({ url, method = "POST", headers = {}, body, wallet, fetchImpl = globalThis.fetch, paymentPolicy = null }) {
  const { wrapFetchWithPayment, x402Client, x402HTTPClient } = await import("@x402/fetch");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { privateKeyToAccount } = await import("viem/accounts");

  if (!wallet.private_key_hex) {
    throw new Error("Local EVM wallet is missing a private_key_hex signer for x402.");
  }

  const account = privateKeyToAccount(wallet.private_key_hex);
  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(account));
  if (paymentPolicy) client.registerPolicy(paymentPolicy);

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetchImpl, client);
  const response = await fetchWithPayment(url, {
    method,
    headers: {
      "content-type": "application/json",
      ...headers
    },
    body
  });
  const payload = await readJsonOrText(response);
  const settlement = readSettlementResponse(httpClient, response);
  if (!response.ok) {
    const error = new Error(`x402 paid request failed with HTTP ${response.status}.`);
    error.status = response.status;
    error.payload = payload;
    error.settlement = settlement;
    throw error;
  }

  return {
    response,
    payload,
    settlement,
    payment_tx: settlement?.transaction || settlement?.txHash || null
  };
}

async function readJsonOrText(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function readSettlementResponse(httpClient, response) {
  try {
    return httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
  } catch {
    return null;
  }
}
