import test from "node:test";
import assert from "node:assert/strict";

import { executeErc8004HttpAgent } from "../src/erc8004-discovery.js";

function response({ status = 200, contentType = "application/json", body = { ok: true } } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === "content-type" ? contentType : "" },
    json: async () => body
  };
}

test("HTTP executor posts bounded JSON input to the already verified endpoint", async () => {
  const calls = [];
  const result = await executeErc8004HttpAgent({
    endpoint: "https://1.1.1.1/query",
    input: { task: "check health factor" },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return response({ body: { health_factor: 1.82 } });
    }
  });

  assert.deepEqual(result, { health_factor: 1.82 });
  assert.equal(calls[0].url, "https://1.1.1.1/query");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.body, JSON.stringify({ task: "check health factor" }));
});

test("HTTP executor blocks redirects, payment challenges, non-JSON, and malformed JSON", async () => {
  const cases = [
    { response: response({ status: 302 }), code: "ERC8004_EXECUTION_REDIRECT_BLOCKED" },
    { response: response({ status: 402 }), code: "ERC8004_PAYMENT_REQUIRED" },
    { response: response({ contentType: "text/html" }), code: "ERC8004_EXECUTION_INVALID_RESPONSE" },
    { response: { ...response(), json: async () => { throw new Error("bad json"); } }, code: "ERC8004_EXECUTION_INVALID_RESPONSE" }
  ];

  for (const item of cases) {
    await assert.rejects(
      executeErc8004HttpAgent({ endpoint: "https://1.1.1.1/query", input: {}, fetchImpl: async () => item.response }),
      (error) => error.code === item.code
    );
  }
});

test("HTTP executor rejects oversized request input before network access", async () => {
  let called = false;
  await assert.rejects(
    executeErc8004HttpAgent({
      endpoint: "https://1.1.1.1/query",
      input: { value: "x".repeat(70 * 1024) },
      fetchImpl: async () => { called = true; return response(); }
    }),
    (error) => error.code === "ERC8004_EXECUTION_INPUT_TOO_LARGE"
  );
  assert.equal(called, false);
});
