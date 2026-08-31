import { currentPaymentBackend } from "./payment-adapter.js";
import { requestProviderHttp } from "./provider-http-transport.js";

export function isRealX402Enabled() {
  return currentPaymentBackend() === "x402";
}

export async function invokeWithRealX402({
  url,
  method = "POST",
  headers = {},
  body,
  wallet,
  fetchImpl = null,
  transportOptions = {},
  paymentPolicy = null
}) {
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
  const safeFetch = createSafeX402Fetch({ fetchImpl, transportOptions });
  const fetchWithPayment = wrapFetchWithPayment(safeFetch, client);
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

function createSafeX402Fetch({ fetchImpl, transportOptions }) {
  return async (input, init = {}) => {
    const normalized = await normalizeX402Request(input, init);
    return requestProviderHttp(normalized.url, normalized.init, {
      ...(transportOptions || {}),
      ...(fetchImpl ? { requestHop: fetchRequestHop(fetchImpl) } : {})
    });
  };
}

async function normalizeX402Request(input, init) {
  if (typeof Request === "function" && input instanceof Request) {
    const request = new Request(input, init);
    const method = String(request.method || "GET").toUpperCase();
    const body = ["GET", "HEAD"].includes(method)
      ? undefined
      : Buffer.from(await request.arrayBuffer());
    return {
      url: request.url,
      init: {
        method,
        headers: request.headers,
        body,
        signal: request.signal
      }
    };
  }
  return { url: input, init };
}

function fetchRequestHop(fetchImpl) {
  return ({ url, method, headers, body, signal }) => fetchImpl(url, {
    method,
    headers: Object.fromEntries(headers.entries()),
    body: body?.length ? body : undefined,
    signal,
    redirect: "manual"
  });
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
