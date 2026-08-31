import test from "node:test";
import assert from "node:assert/strict";

import {
  createNonOverlappingRunner,
  defaultStateFile,
  fetchJson,
  planFirstRun,
  writeState
} from "../scripts/monitor-binance-futures-delists.js";

test("container fallback state path is writable outside the root-owned app directory", () => {
  assert.match(defaultStateFile(), /\/agentrouter\/binance-futures-delists-state\.json$/);
  assert.doesNotMatch(defaultStateFile(), /\/app\//);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

test("poll runner skips a tick while the previous poll is still active", async () => {
  const gate = deferred();
  let calls = 0;
  const run = createNonOverlappingRunner(async () => {
    calls += 1;
    await gate.promise;
    return "complete";
  });

  const first = run();
  const overlapping = await run();
  assert.deepEqual(overlapping, { skipped: true, reason: "poll_in_progress" });
  assert.equal(calls, 1);

  gate.resolve();
  assert.equal(await first, "complete");
  assert.equal(await run(), "complete");
  assert.equal(calls, 2);
});

test("poll runner releases its guard after a failed poll", async () => {
  let calls = 0;
  const run = createNonOverlappingRunner(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary failure");
    return "recovered";
  });

  await assert.rejects(run(), /temporary failure/);
  assert.equal(await run(), "recovered");
});

test("Binance header wait has a hard timeout", async () => {
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
  });

  await assert.rejects(
    fetchJson("https://example.test/articles", {
      fetchImpl,
      attempts: 1,
      headerTimeoutMs: 10,
      bodyTimeoutMs: 100,
      maxResponseBytes: 1024
    }),
    (error) => error?.code === "HTTP_HEADER_TIMEOUT"
  );
});

test("Binance response body wait has a hard timeout", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    }
  }), { status: 200 });

  await assert.rejects(
    fetchJson("https://example.test/articles", {
      fetchImpl: async () => response,
      attempts: 1,
      headerTimeoutMs: 100,
      bodyTimeoutMs: 10,
      maxResponseBytes: 1024
    }),
    (error) => error?.code === "HTTP_BODY_TIMEOUT"
  );
});

test("Binance response body is rejected before it can grow without bound", async () => {
  await assert.rejects(
    fetchJson("https://example.test/articles", {
      fetchImpl: async () => new Response("x".repeat(65), { status: 200 }),
      attempts: 1,
      headerTimeoutMs: 100,
      bodyTimeoutMs: 100,
      maxResponseBytes: 64
    }),
    (error) => error?.code === "HTTP_RESPONSE_TOO_LARGE"
  );
});

test("state persistence writes a sibling temp file before atomic rename", async () => {
  const calls = [];
  const fileApi = {
    mkdir: async (...args) => calls.push(["mkdir", ...args]),
    writeFile: async (...args) => calls.push(["writeFile", ...args]),
    rename: async (...args) => calls.push(["rename", ...args]),
    rm: async (...args) => calls.push(["rm", ...args])
  };

  await writeState("/var/state/monitor.json", { initialized: true, seen: {} }, {
    fileApi,
    tempSuffix: ".test-tmp"
  });

  assert.deepEqual(calls.map(([operation]) => operation), ["mkdir", "writeFile", "rename"]);
  assert.equal(calls[1][1], "/var/state/monitor.json.test-tmp");
  assert.equal(calls[2][1], "/var/state/monitor.json.test-tmp");
  assert.equal(calls[2][2], "/var/state/monitor.json");
  assert.equal(calls[1][3].mode, 0o600);
});

test("failed atomic state replacement cleans the temp file without touching the target", async () => {
  const target = "/var/state/monitor.json";
  let targetContents = "previous-good-state";
  const removed = [];
  const fileApi = {
    mkdir: async () => {},
    writeFile: async (file) => {
      assert.notEqual(file, target);
    },
    rename: async () => {
      throw new Error("disk failure");
    },
    rm: async (file) => removed.push(file)
  };

  await assert.rejects(
    writeState(target, { initialized: true, seen: { next: {} } }, {
      fileApi,
      tempSuffix: ".failed-tmp"
    }),
    /disk failure/
  );
  assert.equal(targetContents, "previous-good-state");
  assert.deepEqual(removed, [`${target}.failed-tmp`]);
});

test("missing state notifies unseen announcements by default regardless of age", () => {
  const old = { code: "old", releaseDate: 1 };
  const recent = { code: "recent", releaseDate: Date.now() };

  assert.deepEqual(planFirstRun([old, recent]), {
    notify: [old, recent],
    seed: []
  });
  assert.deepEqual(planFirstRun([old, recent], { baselineExisting: true }), {
    notify: [],
    seed: [old, recent]
  });
});
