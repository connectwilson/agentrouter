import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { pinnedHttpsRequest } from "../src/erc8004-discovery.js";

test("pinned HTTPS transport connects to the prevalidated DNS address", async () => {
  let capturedOptions;
  const requestImpl = (_url, options, onResponse) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { "content-type": "application/json" };
      onResponse(response);
      response.end(JSON.stringify({ ok: true }));
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };

  const response = await pinnedHttpsRequest({
    url: new URL("https://vendor.example/metadata.json"),
    addresses: [{ address: "93.184.216.34", family: 4 }]
  }, { method: "GET", headers: { accept: "application/json" } }, {
    collectBody: true,
    requestImpl
  });

  const pinned = await new Promise((resolve, reject) => {
    capturedOptions.lookup("vendor.example", {}, (error, address, family) => {
      if (error) reject(error);
      else resolve({ address, family });
    });
  });
  assert.deepEqual(pinned, { address: "93.184.216.34", family: 4 });
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("content-type"), "application/json");
});

test("pinned HTTPS transport supports all-address lookup mode without re-resolving DNS", async () => {
  let capturedOptions;
  const requestImpl = (_url, options, onResponse) => {
    capturedOptions = options;
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 204;
      response.headers = {};
      onResponse(response);
      response.end();
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };

  await pinnedHttpsRequest({
    url: new URL("https://vendor.example/mcp"),
    addresses: [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]
  }, { method: "HEAD" }, { requestImpl });
  const pinned = await new Promise((resolve, reject) => {
    capturedOptions.lookup("vendor.example", { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
  assert.deepEqual(pinned, [{ address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
});

test("pinned HTTPS transport rejects oversized Agent metadata", async () => {
  const requestImpl = (_url, _options, onResponse) => {
    const request = new EventEmitter();
    request.end = () => {
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { "content-type": "application/json" };
      onResponse(response);
      response.end(Buffer.alloc(1024 * 1024 + 1));
    };
    request.destroy = (error) => request.emit("error", error);
    return request;
  };

  await assert.rejects(pinnedHttpsRequest({
    url: new URL("https://vendor.example/too-large.json"),
    addresses: [{ address: "93.184.216.34", family: 4 }]
  }, { method: "GET" }, { collectBody: true, requestImpl }), (error) => {
    return error.code === "ERC8004_METADATA_TOO_LARGE" && error.statusCode === 422;
  });
});
