import crypto from "node:crypto";

import { creditsToAtomic, grantCredits } from "./credits.js";

const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

export async function createCreditTopup(store, { account, amount, baseUrl }) {
  if (!account?.account_id) throw paymentError("Credit account is required.", 400, "CREDIT_ACCOUNT_REQUIRED");
  creditsToAtomic(amount);

  if (process.env.ADN_CREDITS_ALLOW_MANUAL_TOPUP === "true") {
    const entry = await grantCredits(store, {
      accountId: account.account_id,
      amount: String(amount),
      kind: "topup",
      metadata: { source: "manual_local_topup" }
    });
    return { mode: "manual_local", ...entry };
  }

  const secretKey = process.env.STRIPE_SECRET_KEY || "";
  if (!secretKey) {
    throw paymentError(
      "A production credit top-up provider is not configured.",
      503,
      "CREDIT_TOPUP_PROVIDER_NOT_CONFIGURED"
    );
  }

  const normalizedAmount = normalizeCheckoutAmount(amount);

  const checkout = await createStripeCheckoutSession({
    secretKey,
    accountId: account.account_id,
    amount: normalizedAmount,
    baseUrl
  });
  return {
    mode: "stripe_checkout",
    checkout_session_id: checkout.id,
    checkout_url: checkout.url,
    amount: normalizedAmount,
    currency: "credits"
  };
}

export async function processStripeCreditWebhook(store, {
  rawBody,
  signatureHeader,
  webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || ""
}) {
  if (!webhookSecret) throw paymentError("Stripe webhook secret is not configured.", 503, "STRIPE_WEBHOOK_NOT_CONFIGURED");
  verifyStripeSignature({ rawBody, signatureHeader, webhookSecret });
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    throw paymentError("Stripe webhook body is invalid JSON.", 400, "INVALID_STRIPE_WEBHOOK");
  }

  if (event.type !== "checkout.session.completed") {
    return { processed: false, event_id: event.id || null, event_type: event.type || null };
  }
  const session = event.data?.object || {};
  if (session.payment_status !== "paid") {
    return { processed: false, event_id: event.id || null, reason: "checkout_not_paid" };
  }
  const accountId = session.metadata?.account_id;
  const amount = session.metadata?.credits_amount;
  if (!accountId || !amount) throw paymentError("Stripe checkout metadata is incomplete.", 422, "INVALID_STRIPE_TOPUP_METADATA");

  const entry = await grantCredits(store, {
    accountId,
    amount,
    kind: "topup",
    entryId: `stripe_${session.id}`,
    metadata: {
      source: "stripe_checkout",
      stripe_event_id: event.id || null,
      stripe_session_id: session.id,
      amount_total: session.amount_total,
      fiat_currency: session.currency
    }
  });
  return {
    processed: true,
    event_id: event.id || null,
    checkout_session_id: session.id,
    entry
  };
}

async function createStripeCheckoutSession({ secretKey, accountId, amount, baseUrl }) {
  const cents = Math.round(Number(amount) * 100);
  const origin = String(baseUrl || "").replace(/\/$/, "");
  const fields = new URLSearchParams({
    mode: "payment",
    client_reference_id: accountId,
    success_url: `${origin}/account?topup=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/account?topup=cancelled`,
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": String(cents),
    "line_items[0][price_data][product_data][name]": `${amount} AgentRouter credits`,
    "metadata[account_id]": accountId,
    "metadata[credits_amount]": amount
  });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${secretKey}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body: fields
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.id || !payload.url) {
    throw paymentError(
      payload.error?.message || "Stripe Checkout session creation failed.",
      502,
      "STRIPE_CHECKOUT_FAILED"
    );
  }
  return payload;
}

function normalizeCheckoutAmount(value) {
  creditsToAtomic(value);
  const number = Number(value);
  if (number < 0.5) throw paymentError("Stripe top-ups must be at least 0.50 credits.", 400, "TOPUP_AMOUNT_TOO_LOW");
  if (number > 10_000) throw paymentError("Stripe top-ups cannot exceed 10,000 credits.", 400, "TOPUP_AMOUNT_TOO_HIGH");
  if (!Number.isInteger(number * 100)) throw paymentError("Stripe top-ups support two decimal places.", 400, "INVALID_TOPUP_AMOUNT");
  return number.toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1");
}

function verifyStripeSignature({ rawBody, signatureHeader, webhookSecret }) {
  const pairs = Object.fromEntries(String(signatureHeader || "").split(",").map((part) => part.split("=", 2)));
  const timestamp = Number(pairs.t);
  const signature = pairs.v1 || "";
  if (!timestamp || !signature || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) {
    throw paymentError("Stripe webhook signature is invalid or expired.", 400, "INVALID_STRIPE_SIGNATURE");
  }
  const expected = crypto.createHmac("sha256", webhookSecret).update(`${timestamp}.${rawBody}`).digest("hex");
  const left = Buffer.from(signature, "hex");
  const right = Buffer.from(expected, "hex");
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    throw paymentError("Stripe webhook signature is invalid or expired.", 400, "INVALID_STRIPE_SIGNATURE");
  }
}

function paymentError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
