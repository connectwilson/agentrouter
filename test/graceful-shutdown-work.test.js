import test from "node:test";
import assert from "node:assert/strict";

import {
  installGracefulShutdown,
  waitForTrackedPublicApiWork
} from "../src/server.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("tracked public API refresh and conversion work both drain before persistence closes", async () => {
  const bootstrap = deferred();
  const refresh = deferred();
  const conversion = deferred();
  const server = {
    bootstrapCompletion: bootstrap.promise,
    store: {
      publicApiPipelineJob: { status: "running" },
      publicApiPipelineJobCompletion: conversion.promise
    },
    publicApiPipelineRefreshTasks: new Set([refresh.promise])
  };

  let drained = false;
  const draining = waitForTrackedPublicApiWork(server).then(() => { drained = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false);

  refresh.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "conversion must still be awaited after refresh finishes");

  server.store.publicApiPipelineJob.status = "completed";
  conversion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drained, false, "startup hydration must settle before persistence closes");

  bootstrap.resolve();
  await draining;
  assert.equal(drained, true);
});

test("graceful shutdown closes persistence only after tracked public API work settles", async () => {
  const bootstrap = deferred();
  const refresh = deferred();
  const conversion = deferred();
  const events = [];
  const server = {
    bootstrapCompletion: bootstrap.promise,
    store: {
      publicApiPipelineJob: { status: "running" },
      publicApiPipelineJobCompletion: conversion.promise
    },
    publicApiPipelineRefreshTasks: new Set([refresh.promise]),
    close(callback) {
      events.push("http_closed");
      callback();
    }
  };
  const exits = [];
  const { shutdown } = installGracefulShutdown(server, {
    signals: [],
    timeoutMs: 5_000,
    closePersistencePool: async () => { events.push("persistence_closed"); },
    exitProcess: (code) => { exits.push(code); }
  });

  const closing = shutdown("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["http_closed"]);

  refresh.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["http_closed"]);

  server.store.publicApiPipelineJob.status = "completed";
  conversion.resolve();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["http_closed"]);

  bootstrap.resolve();
  await closing;

  assert.deepEqual(events, ["http_closed", "persistence_closed"]);
  assert.deepEqual(exits, [0]);
});
