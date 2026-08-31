import { randomUUID } from "node:crypto";
import { settlementChain } from "./chains.js";

export const PAYMENT_BACKENDS = ["credits", "x402", "omniagentpay", "circle_arc"];

export function currentPaymentBackend() {
  // Hosted MCP is the default new-user path. It can authenticate prepaid
  // credits, but it deliberately does not receive a local wallet. Keep Arc
  // settlement as an explicit advanced mode instead of advertising a payment
  // executor that is not present in the published bridge.
  const backend = process.env.ADN_PAYMENT_BACKEND || process.env.ADN_PAYMENT_MODE || "credits";
  if (backend === "real") return "x402";
  return PAYMENT_BACKENDS.includes(backend) ? backend : "credits";
}

export function describePaymentBackend() {
  const backend = currentPaymentBackend();
  return {
    backend,
    mode: backend,
    execution_layer: backend,
    real_settlement: true,
    supported_backends: PAYMENT_BACKENDS,
    notes: backend === "credits"
      ? "AgentRouter credits are held in a persistent platform ledger. The provider runtime authenticates a consumer API key and atomically debits each successful call."
      : backend === "circle_arc"
        ? "Circle Arc mode uses an x402-style HTTP 402 challenge, then verifies a real Arc Testnet USDC transfer to the provider wallet before returning data."
        : "Production backends should execute real payment authorization, settlement, and ledger recording."
  };
}

export function createPaymentQuote({ manifest, constraints = {}, selectedService, paymentExecutorAvailable = false }) {
  const maxPrice = constraints.max_price_usdc ?? constraints.max_price ?? constraints.max_amount;
  const pricing = effectivePricing(manifest);
  const price = Number(pricing.amount);
  const max = maxPrice == null || maxPrice === "" ? null : Number(maxPrice);
  const validPrice = Number.isFinite(price) && price >= 0;
  const validBudget = maxPrice == null || (maxPrice !== "" && Number.isFinite(max) && max >= 0);
  const allowed = validPrice && validBudget && (max == null || price <= max);
  const verified = selectedService?.selection_badges?.includes("verified_live_endpoint") || selectedService?.verification_status === "verified";
  const healthy = !selectedService?.health_status || ["healthy", "unknown"].includes(selectedService.health_status);
  const hasBudget = maxPrice != null && maxPrice !== "";
  const paymentAuthorizedByBudget = Boolean(allowed && hasBudget);
  const executionAvailable = Boolean(paymentAuthorizedByBudget && paymentExecutorAvailable);
  const autoInvokeAllowed = Boolean(executionAvailable && verified && healthy);
  const paymentBackend = describePaymentBackend();
  const settlement = {
    backend: paymentBackend.backend,
    network: pricing.network || null,
    caip2: pricing.caip2 || null,
    chain_id: pricing.chain_id || null,
    protocol: pricing.protocol || null,
    settlement_model: pricing.settlement_model || null
  };
  return {
    quote_version: "agent_router_payment_quote_v1",
    quote_id: `quote_${randomUUID()}`,
    payment_backend: paymentBackend,
    settlement,
    service_id: manifest.service_id,
    provider_id: manifest.provider.provider_id,
    selected_service: selectedService || null,
    pricing,
    amount: pricing.amount,
    price: pricing.amount,
    budget: {
      max_price_usdc: maxPrice ?? null,
      allowed
    },
    guard_result: allowed ? "pass" : !validBudget ? "invalid_budget" : !validPrice ? "invalid_price" : "budget_too_low",
    would_pay: allowed,
    agent_decision: {
      decision_version: "agentrouter_quote_decision_v1",
      quote_status: allowed ? "quote_ready" : "quote_blocked",
      can_answer: allowed,
      payment_authorized_by_budget: paymentAuthorizedByBudget,
      payment_executor_available: Boolean(paymentExecutorAvailable),
      execution_available: executionAvailable,
      auto_invoke_allowed: autoInvokeAllowed,
      requires_additional_user_confirmation: !allowed,
      user_budget_policy: {
        policy_version: "agentrouter_budget_policy_v1",
        source: hasBudget ? "caller_configured_max_price" : "missing_explicit_budget",
        per_call_max_usdc: maxPrice ?? null,
        currency: pricing.currency || "USDC"
      },
      expected_data: expectedDataForManifest(manifest),
      why_paid_data_is_justified: paidDataJustification(manifest),
      main_agent_next_action: !allowed
        ? "ask_user_to_raise_budget_or_choose_free_answer"
        : !executionAvailable
          ? "connect_credits_or_configure_local_payment"
          : autoInvokeAllowed
            ? "invoke_agentrouter_request"
            : "ask_user_to_confirm_paid_call_or_configure_budget_policy",
      do_not_use_provider_direct_fallback: true
    },
    reason: !validBudget
      ? "The caller budget must be a finite, non-negative amount."
      : !validPrice
        ? "The service price is invalid."
        : allowed
      ? `Service price ${pricing.amount} ${pricing.currency} is within budget.`
      : `Service price ${pricing.amount} ${pricing.currency} exceeds budget ${maxPrice} USDC.`
  };
}

function expectedDataForManifest(manifest = {}) {
  const routing = manifest.routing || {};
  const fromRouting = [
    ...(routing.data_types || []),
    ...(routing.output_fields || []).slice(0, 6)
  ].filter(Boolean);
  const fromCapabilities = (manifest.capabilities || [])
    .filter((capability) => capability !== "data_service")
    .slice(0, 8);
  return [...new Set([...fromRouting, ...fromCapabilities])].slice(0, 10);
}

function paidDataJustification(manifest = {}) {
  const dataTypes = expectedDataForManifest(manifest).slice(0, 4).join(", ") || "provider-specific data";
  return `Public web sources may be stale, incomplete, or unable to verify ${dataTypes}. AgentRouter uses a paid, verified service call with payment and evidence metadata.`;
}

export function effectivePricing(manifest = {}) {
  const pricing = manifest.pricing || {};
  if (currentPaymentBackend() === "credits") {
    return {
      ...pricing,
      currency: "credits",
      network: "agentrouter",
      protocol: "platform_credits",
      settlement_model: "prepaid_ledger"
    };
  }
  if (currentPaymentBackend() !== "circle_arc") return pricing;
  // The network a quote advertises has to be the one it settles on: pricing
  // previously claimed "base" from the manifest while settlement went to Arc,
  // leaving an agent unable to tell where funds actually move.
  const chain = settlementChain();
  return {
    ...pricing,
    network: chain.network,
    caip2: chain.caip2,
    chain_id: chain.id,
    protocol: pricing.protocol || "x402",
    settlement_model: pricing.settlement_model || "direct_provider_wallet",
    pay_to: pricing.pay_to || manifest.provider?.payout_address || process.env.ADN_PROVIDER_RECEIVE_ADDRESS || null
  };
}

export function createSettlementReceipt({ manifest, challenge, txHash }) {
  const backend = currentPaymentBackend();
  return {
    receipt_version: "agent_router_settlement_receipt_v1",
    payment_backend: backend,
    mode: backend,
    network: backend === "circle_arc" ? settlementChain().network : manifest.pricing.network,
    caip2: challenge.caip2 || (backend === "circle_arc" ? settlementChain().caip2 : undefined),
    chain_id: challenge.chain_id || (backend === "circle_arc" ? settlementChain().id : undefined),
    protocol: manifest.pricing.protocol || "x402",
    asset: challenge.asset || manifest.pricing.currency,
    token_address: challenge.token_address || manifest.pricing.token_address || undefined,
    amount: challenge.amount || manifest.pricing.amount,
    payer: challenge.payer || "agentrouter_consumer",
    pay_to: challenge.pay_to,
    tx_hash: txHash,
    settlement_model: challenge.settlement_model || manifest.pricing.settlement_model || null,
    status: "settled",
    created_at: new Date().toISOString()
  };
}
