import assert from "node:assert/strict";
import test from "node:test";

import { baseFundFlowManifest } from "../src/fixtures.js";
import { invokePaidServiceWithLocalWallet } from "../src/local-invoke.js";
import { routeTaskWithLocalWallet } from "../src/local-route.js";
import { invokeWithRealX402 } from "../src/real-x402-client.js";
import { registerService, searchServices } from "../src/registry.js";
import { createServer } from "../src/server.js";
import { createMemoryStore } from "../src/store.js";

const REGISTRY_URL = "https://registry.example";

test("connector_get_manifest refuses pending services before exposing a payable endpoint", async () => {
  const store = createMemoryStore();
  const manifest = serviceManifest("pending_local_manifest", "https://provider.example/data");
  registerService(store, manifest, REGISTRY_URL);
  const server = createServer({ store });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${baseUrl}/connector/get_manifest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service_id: manifest.service_id })
    });
    const payload = await response.json();

    assert.equal(response.status, 409);
    assert.equal(payload.error.code, "SERVICE_NOT_VERIFIED");
    assert.equal(JSON.stringify(payload).includes(manifest.endpoint.url), false);

    await assert.rejects(
      invokePaidServiceWithLocalWallet({
        baseUrl,
        serviceId: manifest.service_id,
        input: { chain: "base" }
      }),
      (error) => error?.code === "SERVICE_NOT_VERIFIED" && error?.status === 409
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("local wallet rejects a private provider endpoint before provider I/O or payment", { concurrency: false }, async () => {
  const manifest = serviceManifest("private_local_provider", "http://169.254.169.254/latest/meta-data");

  await withFakeRegistry(manifest, async ({ providerFetches }) => {
    await assert.rejects(
      invokePaidServiceWithLocalWallet({
        baseUrl: REGISTRY_URL,
        serviceId: manifest.service_id,
        input: { chain: "base" },
        transportOptions: {
          requestHop: async () => {
            throw new Error("PRIVATE_PROVIDER_REQUEST_REACHED");
          }
        }
      }),
      (error) => {
        assert.equal(error?.retryable, true, "the router may safely retry a different verified provider");
        return error?.code === "PROVIDER_HTTP_UNSAFE_TARGET";
      }
    );
    assert.equal(providerFetches(), 0, "the provider target must not reach global fetch");
  });
});

test("local wallet validates every redirect before signing or payment", { concurrency: false }, async () => {
  const manifest = serviceManifest("redirecting_local_provider", "https://provider.example/data");
  let requestHops = 0;

  await withFakeRegistry(manifest, async ({ providerFetches }) => {
    await assert.rejects(
      invokePaidServiceWithLocalWallet({
        baseUrl: REGISTRY_URL,
        serviceId: manifest.service_id,
        input: { chain: "base" },
        transportOptions: {
          lookup: async () => [{ address: "93.184.216.34", family: 4 }],
          requestHop: async () => {
            requestHops += 1;
            return new Response("", {
              status: 302,
              headers: { location: "http://169.254.169.254/latest/meta-data" }
            });
          }
        }
      }),
      (error) => error?.code === "PROVIDER_HTTP_UNSAFE_TARGET"
    );
    assert.equal(requestHops, 1, "the unsafe redirect target must be blocked before a second hop");
    assert.equal(providerFetches(), 0, "redirect handling must not fall back to global fetch");
  });
});

test("local wallet rejects mixed public/private DNS answers before signing or payment", { concurrency: false }, async () => {
  const manifest = serviceManifest("rebind_local_provider", "https://rebind.example/data");
  let requestHops = 0;

  await withFakeRegistry(manifest, async ({ providerFetches }) => {
    await assert.rejects(
      invokePaidServiceWithLocalWallet({
        baseUrl: REGISTRY_URL,
        serviceId: manifest.service_id,
        input: { chain: "base" },
        transportOptions: {
          lookup: async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 }
          ],
          requestHop: async () => {
            requestHops += 1;
            return new Response("should not be reached", { status: 402 });
          }
        }
      }),
      (error) => error?.code === "PROVIDER_HTTP_UNSAFE_TARGET"
    );
    assert.equal(requestHops, 0, "mixed DNS answers must fail before opening a socket");
    assert.equal(providerFetches(), 0, "DNS rebinding defense must not fall back to global fetch");
  });
});

test("official x402 client applies the provider safety gate before its payment wrapper", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  let unsafeFetches = 0;
  globalThis.fetch = async () => {
    unsafeFetches += 1;
    throw new Error("UNSAFE_X402_FETCH_REACHED");
  };

  try {
    await assert.rejects(
      invokeWithRealX402({
        url: "http://127.0.0.1:9/private-x402",
        wallet: { private_key_hex: `0x${"1".padStart(64, "0")}` },
        fetchImpl: globalThis.fetch
      }),
      (error) => error?.code === "PROVIDER_HTTP_UNSAFE_TARGET"
    );
    assert.equal(unsafeFetches, 0, "the x402 SDK must never receive an unsafe provider URL");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("official x402 safe transport preserves Request method headers and body", async () => {
  const calls = [];
  const result = await invokeWithRealX402({
    url: "https://x402.example/data",
    method: "POST",
    headers: { "x-client-context": "agentrouter-test" },
    body: JSON.stringify({ query: "safe request" }),
    wallet: { private_key_hex: `0x${"1".padStart(64, "0")}` },
    fetchImpl: async (url, init) => {
      calls.push({
        url: String(url),
        method: init.method,
        headers: new Headers(init.headers),
        body: init.body == null ? "" : Buffer.from(init.body).toString("utf8")
      });
      return Response.json({ status: "success", data: { ok: true } });
    },
    transportOptions: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }]
    }
  });

  assert.equal(result.payload.data.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers.get("content-type"), "application/json");
  assert.equal(calls[0].headers.get("x-client-context"), "agentrouter-test");
  assert.deepEqual(JSON.parse(calls[0].body), { query: "safe request" });
});

test("local wallet rejects malformed finite budgets before registry or provider I/O", { concurrency: false }, async () => {
  for (const maxAmount of ["not-a-number", -1, Number.POSITIVE_INFINITY]) {
    const previousFetch = globalThis.fetch;
    let networkCalls = 0;
    globalThis.fetch = async () => {
      networkCalls += 1;
      throw new Error("INVALID_BUDGET_REACHED_NETWORK");
    };
    try {
      await assert.rejects(
        invokePaidServiceWithLocalWallet({
          baseUrl: REGISTRY_URL,
          serviceId: "invalid_budget_direct_local",
          input: { chain: "base" },
          budget: { max_amount: maxAmount, currency: "USDC" }
        }),
        (error) => error?.code === "INVALID_BUDGET" && error?.statusCode === 422 && error?.retryable === false
      );
      assert.equal(networkCalls, 0, `invalid budget ${String(maxAmount)} must fail before connector I/O`);
    } finally {
      globalThis.fetch = previousFetch;
    }
  }
});

test("connector search never returns unfiltered candidates for invalid max_price", () => {
  const store = createMemoryStore();
  const manifest = serviceManifest("invalid_budget_search", "https://provider.example/data");
  const record = registerService(store, manifest, REGISTRY_URL);
  record.verification_status = "verified";

  for (const maxPrice of ["not-a-number", -1, Number.POSITIVE_INFINITY]) {
    assert.deepEqual(
      searchServices(store, { maxPrice, verifiedOnly: true }),
      [],
      `invalid max_price ${String(maxPrice)} must not fail open`
    );
  }
});

test("token resolver cannot turn an invalid parent budget into a paid local call", { concurrency: false }, async () => {
  const previousFetch = globalThis.fetch;
  let manifestCalls = 0;
  let providerCalls = 0;
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    if (url === `${REGISTRY_URL}/connector/search_services`) {
      return Response.json([{
        service_id: "token_resolver_invalid_budget",
        title: "Token search resolver",
        description_for_agent: "Resolve token symbols and metadata.",
        capabilities: ["token_search"]
      }]);
    }
    if (url === `${REGISTRY_URL}/connector/get_manifest`) {
      manifestCalls += 1;
      return Response.json(serviceManifest("token_resolver_invalid_budget", "https://provider.example/token-search"));
    }
    providerCalls += 1;
    throw new Error(`INVALID_RESOLVER_BUDGET_REACHED_PROVIDER: ${url}`);
  };

  try {
    const result = await routeTaskWithLocalWallet({
      baseUrl: REGISTRY_URL,
      task: "查询 HYPE 最近 24 小时的 smart-money activity",
      constraints: { max_price_usdc: "not-a-number" }
    });

    assert.equal(result.ok, false);
    assert.equal(result.status, "INVALID_BUDGET");
    assert.equal(manifestCalls, 0, "local invoke must reject before fetching a payable manifest");
    assert.equal(providerCalls, 0, "invalid resolver budget must never reach a provider or payment path");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

function serviceManifest(serviceId, endpointUrl) {
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = serviceId;
  manifest.title = `Local provider boundary ${serviceId}`;
  manifest.provider = {
    ...manifest.provider,
    provider_id: `provider_${serviceId}`
  };
  manifest.endpoint = {
    ...manifest.endpoint,
    url: endpointUrl
  };
  manifest.sample_response.service_id = serviceId;
  return manifest;
}

async function withFakeRegistry(manifest, run) {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  const previousFetch = globalThis.fetch;
  let providerFetchCount = 0;
  process.env.ADN_PAYMENT_BACKEND = "circle_arc";
  globalThis.fetch = async (input) => {
    const url = String(input?.url || input);
    if (url === `${REGISTRY_URL}/connector/get_manifest`) {
      return Response.json(manifest);
    }
    providerFetchCount += 1;
    throw new Error(`UNSAFE_PROVIDER_FETCH_REACHED: ${url}`);
  };

  try {
    await run({ providerFetches: () => providerFetchCount });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  }
}
