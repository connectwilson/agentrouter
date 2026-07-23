import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createMemoryStore } from "../src/store.js";
import { ensureCreditAccount, getCreditBalance } from "../src/credits.js";
import { createCreditTopup, processStripeCreditWebhook } from "../src/credit-payments.js";

const user = { provider: "github", id: "stripe-user", name: "Stripe User" };

test("Stripe Checkout creates a hosted topup session without granting credits early", async () => {
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, user);
  const previousKey = process.env.STRIPE_SECRET_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_example";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, request) => {
    const fields = new URLSearchParams(request.body);
    assert.equal(fields.get("metadata[account_id]"), account.account_id);
    assert.equal(fields.get("metadata[credits_amount]"), "10");
    assert.equal(fields.get("line_items[0][price_data][unit_amount]"), "1000");
    return new Response(JSON.stringify({ id: "cs_test_123", url: "https://checkout.stripe.test/session" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  try {
    const topup = await createCreditTopup(store, {
      account,
      amount: "10",
      baseUrl: "https://agentrouter.example"
    });
    assert.equal(topup.mode, "stripe_checkout");
    assert.equal(topup.checkout_url, "https://checkout.stripe.test/session");
    assert.equal(await getCreditBalance(store, account.account_id), "0");
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey == null) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = previousKey;
  }
});

test("a signed paid Stripe webhook grants credits exactly once", async () => {
  const store = createMemoryStore();
  const account = await ensureCreditAccount(store, user);
  const secret = "whsec_test_secret";
  const event = {
    id: "evt_123",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_paid_123",
        payment_status: "paid",
        amount_total: 250,
        currency: "usd",
        metadata: { account_id: account.account_id, credits_amount: "2.5" }
      }
    }
  };
  const rawBody = JSON.stringify(event);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;

  const first = await processStripeCreditWebhook(store, { rawBody, signatureHeader: header, webhookSecret: secret });
  const second = await processStripeCreditWebhook(store, { rawBody, signatureHeader: header, webhookSecret: secret });

  assert.equal(first.processed, true);
  assert.equal(second.processed, true);
  assert.equal(await getCreditBalance(store, account.account_id), "2.5");
  assert.equal(store.creditLedger.length, 1);
});

test("an invalid Stripe webhook signature is rejected", async () => {
  await assert.rejects(
    processStripeCreditWebhook(createMemoryStore(), {
      rawBody: "{}",
      signatureHeader: "t=1,v1=invalid",
      webhookSecret: "whsec_test"
    }),
    (error) => error.code === "INVALID_STRIPE_SIGNATURE" && error.statusCode === 400
  );
});
