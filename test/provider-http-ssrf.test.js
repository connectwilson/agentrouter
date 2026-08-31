import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { baseFundFlowManifest } from "../src/fixtures.js";
import { executeProviderConfig } from "../src/provider-runtime.js";
import { requestProviderHttp } from "../src/provider-http-transport.js";
import { invokePaidService, registerService, validateService } from "../src/registry.js";
import { createMemoryStore } from "../src/store.js";

const PUBLIC_ADDRESS = "93.184.216.34";

for (const target of [
  "http://127.0.0.1/admin",
  "http://10.0.0.7/internal",
  "http://169.254.169.254/latest/meta-data",
  "http://[::1]/admin",
  "http://[::ffff:127.0.0.1]/admin"
]) {
  test(`provider transport blocks non-public target ${target}`, async () => {
    let requested = false;
    await assert.rejects(
      requestProviderHttp(target, {}, {
        requestHop: async () => {
          requested = true;
          return jsonResponse({ ok: true });
        }
      }),
      (error) => error.code === "PROVIDER_HTTP_UNSAFE_TARGET"
    );
    assert.equal(requested, false, "unsafe literal addresses must fail before a socket opens");
  });
}

test("provider transport blocks a hostname resolving to a private address", async () => {
  let requested = false;
  await assert.rejects(
    requestProviderHttp("https://provider.example/data", {}, {
      lookup: async () => [{ address: "192.168.10.4", family: 4 }],
      requestHop: async () => {
        requested = true;
        return jsonResponse({ ok: true });
      }
    }),
    (error) => error.code === "PROVIDER_HTTP_UNSAFE_TARGET"
  );
  assert.equal(requested, false);
});

test("provider transport revalidates every redirect and never follows one to metadata", async () => {
  const calls = [];
  await assert.rejects(
    requestProviderHttp("https://provider.example/start", {}, {
      lookup: async (hostname) => [{
        address: hostname === "provider.example" ? PUBLIC_ADDRESS : "169.254.169.254",
        family: 4
      }],
      requestHop: async ({ url, resolvedAddress }) => {
        calls.push({ url: String(url), resolvedAddress });
        return redirectResponse("http://metadata.internal/latest/meta-data");
      }
    }),
    (error) => error.code === "PROVIDER_HTTP_UNSAFE_TARGET"
  );
  assert.deepEqual(calls, [{ url: "https://provider.example/start", resolvedAddress: PUBLIC_ADDRESS }]);
});

test("provider transport drops arbitrary provider credentials on a cross-origin redirect", async () => {
  const calls = [];
  const response = await requestProviderHttp("https://provider.example/start", {
    headers: {
      "content-type": "application/json",
      "x-vendor-secret": "provider-secret-sentinel"
    }
  }, {
    lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    requestHop: async ({ url, headers }) => {
      calls.push({ url: String(url), secret: headers.get("x-vendor-secret") });
      return calls.length === 1
        ? redirectResponse("https://redirect.example/final")
        : jsonResponse({ ok: true });
    }
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    { url: "https://provider.example/start", secret: "provider-secret-sentinel" },
    { url: "https://redirect.example/final", secret: null }
  ]);
});

test("provider transport pins the request hop to the address it validated", async () => {
  const seen = [];
  const response = await requestProviderHttp("https://provider.example/data", {}, {
    lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
    requestHop: async ({ resolvedAddress }) => {
      seen.push(resolvedAddress);
      return jsonResponse({ value: 42 });
    }
  });

  assert.deepEqual(seen, [PUBLIC_ADDRESS]);
  assert.deepEqual(await response.json(), { value: 42 });
});

test("default transport connects through the validated DNS address and reads a bounded response", async () => {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ host: request.headers.host, path: request.url });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ pinned: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://provider.example:${port}`;
  try {
    const response = await requestProviderHttp(`${origin}/provider/demo`, {}, {
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      trustedOrigins: [{ origin, pathPrefixes: ["/provider/"] }]
    });
    assert.deepEqual(await response.json(), { pinned: true });
    assert.deepEqual(requests, [{ host: `provider.example:${port}`, path: "/provider/demo" }]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider transport enforces a total timeout even when an injected hop stalls", async () => {
  await assert.rejects(
    requestProviderHttp("https://provider.example/slow", {}, {
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      requestHop: async () => new Promise(() => {}),
      timeoutMs: 20
    }),
    (error) => error.code === "PROVIDER_HTTP_TIMEOUT"
  );
});

test("provider transport rejects an oversized response while reading it", async () => {
  await assert.rejects(
    requestProviderHttp("https://provider.example/large", {}, {
      lookup: async () => [{ address: PUBLIC_ADDRESS, family: 4 }],
      requestHop: async () => jsonResponse({ payload: "x".repeat(256) }),
      maxResponseBytes: 64
    }),
    (error) => error.code === "PROVIDER_HTTP_RESPONSE_TOO_LARGE"
  );
});

test("an exact trusted platform origin only bypasses local blocking for its provider path", async () => {
  const trustedOrigins = [{ origin: "http://127.0.0.1:8800", pathPrefixes: ["/provider/"] }];
  const allowed = await requestProviderHttp("http://127.0.0.1:8800/provider/demo", {}, {
    trustedOrigins,
    requestHop: async () => jsonResponse({ ok: true })
  });
  assert.equal(allowed.status, 200);

  await assert.rejects(
    requestProviderHttp("http://127.0.0.1:8800/admin", {}, {
      trustedOrigins,
      requestHop: async () => jsonResponse({ ok: true })
    }),
    (error) => error.code === "PROVIDER_HTTP_UNSAFE_TARGET"
  );

  const exactPathPolicy = [{
    origin: "http://127.0.0.1:8800",
    exactPaths: ["/api/v1/data/header-key"]
  }];
  const exact = await requestProviderHttp("http://127.0.0.1:8800/api/v1/data/header-key", {}, {
    trustedOrigins: exactPathPolicy,
    requestHop: async () => jsonResponse({ ok: true })
  });
  assert.equal(exact.status, 200);
  await assert.rejects(
    requestProviderHttp("http://127.0.0.1:8800/api/v1/data/header-key/admin", {}, {
      trustedOrigins: exactPathPolicy,
      requestHop: async () => jsonResponse({ ok: true })
    }),
    (error) => error.code === "PROVIDER_HTTP_UNSAFE_TARGET"
  );
});

test("validateService rejects a metadata endpoint before provider I/O", async () => {
  const store = createMemoryStore();
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = "ssrf_metadata_validation";
  manifest.provider.provider_id = "provider_ssrf_metadata";
  manifest.endpoint = { method: "POST", url: "http://169.254.169.254/latest/meta-data" };
  registerService(store, manifest, "https://agentrouter.network");
  let requested = false;

  const validation = await validateService(store, manifest.service_id, {
    requestHop: async () => {
      requested = true;
      return jsonResponse({});
    }
  });

  assert.equal(requested, false);
  assert.equal(validation.ok, false);
  assert.equal(validation.error, "PROVIDER_HTTP_UNSAFE_TARGET");
  assert.equal(store.services.get(manifest.service_id).verification_status, "failed");
});

test("a manifest cannot self-declare its loopback provider endpoint as trusted", async () => {
  const store = createMemoryStore();
  const manifest = structuredClone(baseFundFlowManifest);
  manifest.service_id = "ssrf_self_reported_trust";
  manifest.provider.provider_id = "provider_ssrf_self_reported_trust";
  manifest.endpoint = { method: "POST", url: "http://127.0.0.1:8800/provider/attacker" };
  manifest.transport_policy = {
    trustedOrigins: [{ origin: "http://127.0.0.1:8800", pathPrefixes: ["/provider/"] }]
  };
  registerService(store, manifest, "https://agentrouter.network");
  let requested = false;

  const validation = await validateService(store, manifest.service_id, {
    requestHop: async () => {
      requested = true;
      return jsonResponse({});
    }
  });

  assert.equal(requested, false);
  assert.equal(validation.error, "PROVIDER_HTTP_UNSAFE_TARGET");
});

test("direct paid invocation rechecks the safe network boundary before any payment", async () => {
  const previousBackend = process.env.ADN_PAYMENT_BACKEND;
  process.env.ADN_PAYMENT_BACKEND = "circle_arc";
  try {
    const store = createMemoryStore();
    const manifest = structuredClone(baseFundFlowManifest);
    manifest.service_id = "ssrf_direct_invocation";
    manifest.provider.provider_id = "provider_ssrf_direct_invocation";
    manifest.endpoint = { method: "POST", url: "http://127.0.0.1:8800/admin" };
    const record = registerService(store, manifest, "https://agentrouter.network");
    record.verification_status = "verified";

    const result = await invokePaidService(
      store,
      manifest.service_id,
      manifest.sample_request,
      { max_amount: "0.05", currency: "USDC" }
    );
    assert.equal(result.statusCode, 422);
    assert.equal(result.body.error.code, "PROVIDER_HTTP_UNSAFE_TARGET");
  } finally {
    if (previousBackend === undefined) delete process.env.ADN_PAYMENT_BACKEND;
    else process.env.ADN_PAYMENT_BACKEND = previousBackend;
  }
});

test("hosted provider execution uses the injected safe transport instead of global fetch", async () => {
  const calls = [];
  const config = {
    manifest: {
      service_id: "hosted_transport_injection",
      endpoint: { url: "https://agentrouter.network/provider/custom/hosted_transport_injection" }
    },
    source: {
      type: "hosted_http",
      upstream_url: "https://provider.example/data",
      upstream_method: "POST",
      summary: "test upstream",
      auth: { mode: "none" }
    }
  };

  const result = await executeProviderConfig(config, { asset: "BTC" }, {
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init.method });
      return jsonResponse({ rows: [{ value: 1 }] });
    }
  });

  assert.equal(result.status, 200);
  assert.deepEqual(calls, [{ url: "https://provider.example/data", method: "POST" }]);
});

test("hosted provider execution blocks a loopback upstream by default", async () => {
  const config = {
    manifest: {
      service_id: "hosted_private_upstream",
      endpoint: { url: "https://agentrouter.network/provider/custom/hosted_private_upstream" }
    },
    source: {
      type: "hosted_http",
      upstream_url: "http://127.0.0.1:8800/internal",
      upstream_method: "GET",
      summary: "private upstream",
      auth: { mode: "none" }
    }
  };

  await assert.rejects(
    executeProviderConfig(config, {}),
    (error) => error.code === "PROVIDER_HTTP_UNSAFE_TARGET"
  );
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function redirectResponse(location) {
  return new Response(null, { status: 302, headers: { location } });
}
