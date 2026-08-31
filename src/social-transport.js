export const DEFAULT_SOCIAL_PROVIDER_TIMEOUT_MS = 8_000;
export const DEFAULT_SOCIAL_PROVIDER_MAX_BYTES = 1024 * 1024;

export class SocialProviderTransportError extends Error {
  constructor(code, message, {
    category,
    stage,
    retryable,
    timeoutMs,
    maxBytes,
    httpStatus = null,
    upstreamCode = null
  } = {}) {
    super(message);
    this.name = "SocialProviderTransportError";
    this.code = code;
    this.category = category;
    this.stage = stage;
    this.retryable = Boolean(retryable);
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
    this.httpStatus = httpStatus;
    this.upstreamCode = upstreamCode;
  }
}

// One deadline covers DNS/connect/headers and the complete body read. A fetch
// implementation that ignores AbortSignal is still bounded by raceDeadline;
// real fetch streams are additionally cancelled as soon as the limit is hit.
export async function readBoundedSocialResponse(fetchImpl, url, options = {}, {
  mode = "json",
  stage = "social_provider_request",
  timeoutMs = DEFAULT_SOCIAL_PROVIDER_TIMEOUT_MS,
  maxBytes = DEFAULT_SOCIAL_PROVIDER_MAX_BYTES
} = {}) {
  const safeTimeoutMs = clampInteger(timeoutMs, 25, 30_000, DEFAULT_SOCIAL_PROVIDER_TIMEOUT_MS);
  const safeMaxBytes = clampInteger(maxBytes, 128, 4 * 1024 * 1024, DEFAULT_SOCIAL_PROVIDER_MAX_BYTES);
  const deadlineAt = Date.now() + safeTimeoutMs;
  const controller = new AbortController();
  const detachSignal = forwardAbort(options.signal, controller);
  let response;
  try {
    response = await raceDeadline(
      Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal })),
      deadlineAt,
      controller,
      { stage, timeoutMs: safeTimeoutMs, maxBytes: safeMaxBytes }
    );
    rejectOversizedContentLength(response, { stage, timeoutMs: safeTimeoutMs, maxBytes: safeMaxBytes });
    const body = await readResponseBody(response, {
      mode,
      stage,
      deadlineAt,
      controller,
      timeoutMs: safeTimeoutMs,
      maxBytes: safeMaxBytes
    });
    return { response, ...body };
  } catch (error) {
    if (error instanceof SocialProviderTransportError) throw error;
    if (isTimeout(error) || controller.signal.aborted) {
      throw timeoutError({ stage, timeoutMs: safeTimeoutMs, maxBytes: safeMaxBytes, httpStatus: response?.status ?? null });
    }
    throw new SocialProviderTransportError(
      "SOCIAL_PROVIDER_NETWORK_ERROR",
      "Social provider network request failed.",
      {
        category: "network",
        stage,
        retryable: true,
        timeoutMs: safeTimeoutMs,
        maxBytes: safeMaxBytes,
        httpStatus: response?.status ?? null,
        upstreamCode: cleanCode(error?.cause?.code || error?.code)
      }
    );
  } finally {
    detachSignal();
  }
}

export function socialProviderTransportFailure(error, { stage = "social_provider_request", rows = true } = {}) {
  const typed = error instanceof SocialProviderTransportError
    ? error
    : new SocialProviderTransportError(
        "SOCIAL_PROVIDER_NETWORK_ERROR",
        "Social provider network request failed.",
        { category: "network", stage, retryable: true }
      );
  return {
    status: "provider_error",
    error_code: typed.code,
    error: typed.message,
    diagnostics: {
      code: typed.code,
      category: typed.category || "network",
      stage: typed.stage || stage,
      retryable: typed.retryable,
      http_status: typed.httpStatus ?? null,
      timeout_ms: typed.timeoutMs ?? null,
      max_response_bytes: typed.maxBytes ?? null,
      upstream_code: typed.upstreamCode || null
    },
    ...(rows ? { rows: [] } : { items: [] })
  };
}

async function readResponseBody(response, context) {
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const part = await raceDeadline(reader.read(), context.deadlineAt, context.controller, context);
        if (part.done) break;
        const chunk = Buffer.from(part.value || []);
        total += chunk.byteLength;
        if (total > context.maxBytes) throw tooLargeError(context, response?.status);
        chunks.push(chunk);
      }
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    }
    return decodeBody(Buffer.concat(chunks).toString("utf8"), context, response);
  }

  if (typeof response?.text === "function") {
    const text = String(await raceDeadline(response.text(), context.deadlineAt, context.controller, context));
    if (Buffer.byteLength(text, "utf8") > context.maxBytes) throw tooLargeError(context, response?.status);
    return decodeBody(text, context, response);
  }

  // Lightweight test/provider adapters sometimes expose json() only. Keep the
  // same deadline and enforce the serialized size before returning the value.
  if (context.mode === "json" && typeof response?.json === "function") {
    const payload = await raceDeadline(response.json(), context.deadlineAt, context.controller, context);
    const serialized = JSON.stringify(payload ?? null);
    if (Buffer.byteLength(serialized, "utf8") > context.maxBytes) throw tooLargeError(context, response?.status);
    return { payload, text: serialized };
  }

  throw new SocialProviderTransportError(
    "SOCIAL_PROVIDER_BODY_UNREADABLE",
    "Social provider response body could not be read.",
    {
      category: "invalid_response",
      stage: context.stage,
      retryable: false,
      timeoutMs: context.timeoutMs,
      maxBytes: context.maxBytes,
      httpStatus: response?.status ?? null
    }
  );
}

function decodeBody(text, context, response) {
  if (context.mode === "text") return { text };
  try {
    return { text, payload: text.trim() ? JSON.parse(text) : {} };
  } catch {
    throw new SocialProviderTransportError(
      "SOCIAL_PROVIDER_INVALID_JSON",
      "Social provider returned malformed JSON.",
      {
        category: "invalid_response",
        stage: context.stage,
        retryable: false,
        timeoutMs: context.timeoutMs,
        maxBytes: context.maxBytes,
        httpStatus: response?.status ?? null
      }
    );
  }
}

function rejectOversizedContentLength(response, context) {
  const raw = response?.headers?.get?.("content-length");
  const length = Number(raw);
  if (Number.isFinite(length) && length > context.maxBytes) throw tooLargeError(context, response?.status);
}

function tooLargeError(context, httpStatus) {
  return new SocialProviderTransportError(
    "SOCIAL_PROVIDER_RESPONSE_TOO_LARGE",
    "Social provider response exceeded the allowed size.",
    {
      category: "response_size",
      stage: context.stage,
      retryable: false,
      timeoutMs: context.timeoutMs,
      maxBytes: context.maxBytes,
      httpStatus: httpStatus ?? null
    }
  );
}

function timeoutError(context) {
  return new SocialProviderTransportError(
    "SOCIAL_PROVIDER_TIMEOUT",
    "Social provider request timed out.",
    {
      category: "timeout",
      stage: context.stage,
      retryable: true,
      timeoutMs: context.timeoutMs,
      maxBytes: context.maxBytes,
      httpStatus: context.httpStatus ?? null
    }
  );
}

function raceDeadline(promise, deadlineAt, controller, context) {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    controller.abort();
    return Promise.reject(timeoutError(context));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError(context));
    }, remaining);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

function forwardAbort(signal, controller) {
  if (!signal) return () => {};
  const abort = () => controller.abort(signal.reason);
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener?.("abort", abort);
}

function clampInteger(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(numeric)));
}

function isTimeout(error) {
  return error?.name === "AbortError" || error?.name === "TimeoutError" || error?.code === "SOCIAL_PROVIDER_TIMEOUT";
}

function cleanCode(value) {
  const code = String(value || "").trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? code : null;
}
