import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CROSS_ORIGIN_REDIRECT_HEADERS = new Set(["accept", "accept-language", "content-type"]);

export async function requestProviderHttp(input, init = {}, options = {}) {
  const timeoutMs = boundedInteger(options.timeoutMs, 1, 120_000, 10_000);
  const maxRedirects = boundedInteger(options.maxRedirects, 0, 10, 5);
  const maxRequestBytes = boundedInteger(options.maxRequestBytes, 1, 16 * 1024 * 1024, 256 * 1024);
  const maxResponseBytes = boundedInteger(options.maxResponseBytes, 1, 16 * 1024 * 1024, 1024 * 1024);
  const body = normalizeRequestBody(init.body);
  if (body && body.length > maxRequestBytes) {
    throw providerHttpError(
      "PROVIDER_HTTP_REQUEST_TOO_LARGE",
      `Provider request exceeds the ${maxRequestBytes}-byte limit.`,
      422
    );
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutController.signal])
    : timeoutController.signal;
  try {
    return await raceWithAbort(
      performProviderRequest(input, {
        ...init,
        body,
        headers: new Headers(init.headers || {}),
        method: String(init.method || "GET").toUpperCase(),
        signal
      }, {
        ...options,
        maxRedirects,
        maxResponseBytes
      }),
      signal,
      () => timeoutController.signal.aborted
        ? providerHttpError("PROVIDER_HTTP_TIMEOUT", `Provider request timed out after ${timeoutMs}ms.`, 504)
        : providerHttpError("PROVIDER_HTTP_ABORTED", "Provider request was aborted.", 499)
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function performProviderRequest(input, init, options) {
  let target = parseTarget(input);
  let method = init.method;
  let headers = new Headers(init.headers);
  let body = init.body;
  const requestHop = options.requestHop || pinnedRequestHop;

  try {
    for (let redirectCount = 0; ; redirectCount += 1) {
      const resolved = await resolveSafeTarget(target, options, init.signal);
      let response;
      try {
        response = await requestHop({
          url: target,
          addresses: resolved.addresses,
          resolvedAddress: resolved.addresses[0].address,
          method,
          headers,
          body,
          signal: init.signal,
          httpRequest: options.httpRequest,
          httpsRequest: options.httpsRequest
        });
      } catch (error) {
        if (isProviderHttpError(error)) throw error;
        if (init.signal.aborted) throw error;
        throw providerHttpError(
          "PROVIDER_HTTP_NETWORK_ERROR",
          `Provider request failed: ${String(error?.message || error)}`,
          502,
          error
        );
      }

      const status = responseStatus(response);
      if (!REDIRECT_STATUSES.has(status)) {
        const responseBody = await readBoundedResponseBody(response, options.maxResponseBytes, init.signal);
        return bufferedResponse(response, responseBody, target);
      }

      disposeResponse(response);
      if (redirectCount >= options.maxRedirects) {
        throw providerHttpError("PROVIDER_HTTP_REDIRECT_LIMIT", "Provider response exceeded the safe redirect limit.", 502);
      }
      const location = responseHeader(response, "location");
      if (!location) {
        throw providerHttpError("PROVIDER_HTTP_INVALID_REDIRECT", "Provider redirect did not include a Location header.", 502);
      }
      let nextTarget;
      try {
        nextTarget = new URL(location, target);
      } catch {
        throw providerHttpError("PROVIDER_HTTP_INVALID_REDIRECT", "Provider returned an invalid redirect target.", 502);
      }
      if (nextTarget.origin !== target.origin) headers = stripSensitiveHeaders(headers);
      if (status === 303 || ((status === 301 || status === 302) && method === "POST")) {
        method = method === "HEAD" ? "HEAD" : "GET";
        body = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      target = nextTarget;
    }
  } catch (error) {
    if (isProviderHttpError(error)) throw error;
    if (init.signal.aborted) throw error;
    throw providerHttpError(
      "PROVIDER_HTTP_NETWORK_ERROR",
      `Provider request failed: ${String(error?.message || error)}`,
      502,
      error
    );
  }
}

async function resolveSafeTarget(target, options, signal) {
  const trusted = matchesTrustedTarget(target, options.trustedOrigins);
  const hostname = normalizeHostname(target.hostname);
  let addresses;
  if (net.isIP(hostname)) {
    addresses = [{ address: hostname, family: net.isIP(hostname) }];
  } else {
    if (isLocalHostname(hostname) && !trusted) {
      throw unsafeTarget("Local provider hostnames are not allowed.");
    }
    const lookup = options.lookup || dnsLookup;
    try {
      const answer = await raceWithAbort(
        Promise.resolve(lookup(hostname, { all: true, verbatim: true })),
        signal,
        () => providerHttpError("PROVIDER_HTTP_TIMEOUT", "Provider DNS resolution timed out.", 504)
      );
      addresses = Array.isArray(answer) ? answer : [answer];
    } catch (error) {
      if (isProviderHttpError(error)) throw error;
      throw providerHttpError(
        "PROVIDER_HTTP_DNS_FAILED",
        `Could not resolve provider hostname ${hostname}: ${String(error?.message || error)}`,
        502,
        error
      );
    }
  }

  const normalized = addresses
    .map((entry) => ({
      address: normalizeHostname(entry?.address || entry),
      family: Number(entry?.family) || net.isIP(normalizeHostname(entry?.address || entry))
    }))
    .filter((entry) => entry.family === 4 || entry.family === 6);
  if (!normalized.length) {
    throw providerHttpError("PROVIDER_HTTP_DNS_FAILED", `Provider hostname ${hostname} did not resolve to an IP address.`, 502);
  }
  if (!trusted && normalized.some((entry) => !isPublicAddress(entry.address))) {
    throw unsafeTarget("Provider target resolves to a private, reserved, link-local, or metadata address.");
  }
  return { addresses: normalized, trusted };
}

function parseTarget(input) {
  let target;
  try {
    target = new URL(typeof input === "string" || input instanceof URL ? input : input?.url);
  } catch {
    throw unsafeTarget("Provider target is not a valid URL.");
  }
  if (!["http:", "https:"].includes(target.protocol)) throw unsafeTarget("Only HTTP(S) provider targets are allowed.");
  if (target.username || target.password) throw unsafeTarget("Provider targets cannot contain URL credentials.");
  return target;
}

function matchesTrustedTarget(target, entries = []) {
  for (const entry of entries || []) {
    const origin = typeof entry === "string" ? entry : entry?.origin;
    const pathPrefixes = typeof entry === "string" ? [] : entry?.pathPrefixes;
    const exactPaths = typeof entry === "string" ? [] : entry?.exactPaths;
    const hasPrefixes = Array.isArray(pathPrefixes) && pathPrefixes.length;
    const hasExactPaths = Array.isArray(exactPaths) && exactPaths.length;
    if (!origin || (!hasPrefixes && !hasExactPaths)) continue;
    let trustedOrigin;
    try {
      trustedOrigin = new URL(origin).origin;
    } catch {
      continue;
    }
    if (target.origin !== trustedOrigin) continue;
    if (hasPrefixes && pathPrefixes.some((prefix) => target.pathname.startsWith(String(prefix)))) return true;
    if (hasExactPaths && exactPaths.some((path) => target.pathname === String(path))) return true;
  }
  return false;
}

function pinnedRequestHop({
  url,
  resolvedAddress,
  method,
  headers,
  body,
  signal,
  httpRequest = http.request,
  httpsRequest = https.request
}) {
  const requestImpl = url.protocol === "https:" ? httpsRequest : httpRequest;
  const family = net.isIP(resolvedAddress);
  return new Promise((resolve, reject) => {
    const request = requestImpl(url, {
      method,
      headers: Object.fromEntries(headers.entries()),
      signal,
      agent: false,
      lookup: (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === "function") {
          callback = lookupOptions;
          lookupOptions = {};
        }
        if (lookupOptions?.all) callback(null, [{ address: resolvedAddress, family }]);
        else callback(null, resolvedAddress, family);
      }
    }, resolve);
    request.once("error", reject);
    if (body?.length) request.write(body);
    request.end();
  });
}

async function readBoundedResponseBody(response, maxBytes, signal) {
  const declaredLength = Number(responseHeader(response, "content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    disposeResponse(response);
    throw providerHttpError(
      "PROVIDER_HTTP_RESPONSE_TOO_LARGE",
      `Provider response exceeds the ${maxBytes}-byte limit.`,
      502
    );
  }

  const body = response?.body ?? (typeof response?.[Symbol.asyncIterator] === "function" ? response : null);
  if (body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(body) || typeof body === "string" || body instanceof Uint8Array) {
    return appendBounded([], normalizeChunk(body), 0, maxBytes, response).buffer;
  }

  const chunks = [];
  let size = 0;
  if (typeof body.getReader === "function") {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await raceWithAbort(
          reader.read(),
          signal,
          () => providerHttpError("PROVIDER_HTTP_ABORTED", "Provider response was aborted.", 499)
        );
        if (done) break;
        ({ size } = appendBounded(chunks, normalizeChunk(value), size, maxBytes, response));
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    }
    return Buffer.concat(chunks, size);
  }

  if (typeof body[Symbol.asyncIterator] === "function") {
    for await (const value of body) {
      ({ size } = appendBounded(chunks, normalizeChunk(value), size, maxBytes, response));
    }
    return Buffer.concat(chunks, size);
  }
  throw providerHttpError("PROVIDER_HTTP_INVALID_RESPONSE", "Provider returned an unreadable HTTP response body.", 502);
}

function appendBounded(chunks, chunk, size, maxBytes, response) {
  const nextSize = size + chunk.length;
  if (nextSize > maxBytes) {
    disposeResponse(response);
    throw providerHttpError(
      "PROVIDER_HTTP_RESPONSE_TOO_LARGE",
      `Provider response exceeds the ${maxBytes}-byte limit.`,
      502
    );
  }
  chunks.push(chunk);
  return { chunks, size: nextSize, buffer: Buffer.concat(chunks, nextSize) };
}

function bufferedResponse(source, body, target) {
  const status = responseStatus(source);
  const headers = normalizeHeaders(source?.headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers,
    url: target.toString(),
    async text() { return body.toString("utf8"); },
    async json() { return JSON.parse(body.toString("utf8")); },
    async arrayBuffer() { return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength); },
    clone() { return bufferedResponse({ status, headers }, Buffer.from(body), target); }
  };
}

function normalizeRequestBody(body) {
  if (body === undefined || body === null) return null;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  if (body instanceof Uint8Array) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw providerHttpError("PROVIDER_HTTP_INVALID_BODY", "Provider request body must be a string or byte array.", 422);
}

function normalizeChunk(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return Buffer.from(value);
}

function normalizeHeaders(value) {
  const headers = new Headers();
  if (!value) return headers;
  if (typeof value.entries === "function") {
    for (const [name, headerValue] of value.entries()) headers.append(name, headerValue);
    return headers;
  }
  for (const [name, headerValue] of Object.entries(value)) {
    for (const item of Array.isArray(headerValue) ? headerValue : [headerValue]) {
      if (item != null) headers.append(name, String(item));
    }
  }
  return headers;
}

function responseStatus(response) {
  const status = Number(response?.status ?? response?.statusCode);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw providerHttpError("PROVIDER_HTTP_INVALID_RESPONSE", "Provider returned an invalid HTTP status.", 502);
  }
  return status;
}

function responseHeader(response, name) {
  if (typeof response?.headers?.get === "function") return String(response.headers.get(name) || "");
  const value = response?.headers?.[String(name).toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : String(value || "");
}

function stripSensitiveHeaders(headers) {
  const sanitized = new Headers();
  for (const [name, value] of headers.entries()) {
    if (CROSS_ORIGIN_REDIRECT_HEADERS.has(name.toLowerCase())) sanitized.append(name, value);
  }
  return sanitized;
}

function disposeResponse(response) {
  try { response?.destroy?.(); } catch {}
  try {
    const cancellation = response?.body?.cancel?.();
    void cancellation?.catch?.(() => {});
  } catch {}
  try { response?.resume?.(); } catch {}
}

function normalizeHostname(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .split("%")[0];
}

function isLocalHostname(hostname) {
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

export function isPublicAddress(address) {
  const normalized = normalizeHostname(address);
  if (net.isIPv4(normalized)) return isPublicIpv4(normalized);
  if (!net.isIPv6(normalized)) return false;
  const value = ipv6ToBigInt(normalized);
  if (value === null) return false;
  const blocked = [
    ["::", 128],
    ["::1", 128],
    ["::", 96],
    ["::ffff:0:0", 96],
    ["64:ff9b::", 96],
    ["64:ff9b:1::", 48],
    ["100::", 64],
    ["2001::", 32],
    ["2001:2::", 48],
    ["2001:10::", 28],
    ["2001:db8::", 32],
    ["2002::", 16],
    ["fc00::", 7],
    ["fe80::", 10],
    ["fec0::", 10],
    ["ff00::", 8]
  ];
  return !blocked.some(([base, prefix]) => ipv6PrefixMatches(value, ipv6ToBigInt(base), prefix));
}

function isPublicIpv4(address) {
  const [a, b, c] = address.split(".").map(Number);
  return !(a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && c === 0)
    || (a === 192 && b === 0 && c === 2)
    || (a === 192 && b === 88 && c === 99)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113)
    || a >= 224);
}

function ipv6ToBigInt(address) {
  let normalized = normalizeHostname(address);
  if (!normalized.includes(":")) return null;
  const ipv4Suffix = normalized.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (ipv4Suffix) {
    if (!net.isIPv4(ipv4Suffix)) return null;
    const octets = ipv4Suffix.split(".").map(Number);
    normalized = normalized.slice(0, -ipv4Suffix.length)
      + `${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array(Math.max(0, zeros)).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/i.test(group))) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

function ipv6PrefixMatches(value, base, prefix) {
  if (value === null || base === null) return true;
  if (prefix === 0) return true;
  const shift = 128n - BigInt(prefix);
  return (value >> shift) === (base >> shift);
}

function raceWithAbort(promise, signal, createError) {
  if (signal?.aborted) return Promise.reject(createError());
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(createError());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function unsafeTarget(message) {
  return providerHttpError("PROVIDER_HTTP_UNSAFE_TARGET", message, 422);
}

function providerHttpError(code, message, statusCode, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.statusCode = statusCode;
  error.retryable = [502, 504].includes(statusCode);
  return error;
}

function isProviderHttpError(error) {
  return String(error?.code || "").startsWith("PROVIDER_HTTP_");
}

function boundedInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}
