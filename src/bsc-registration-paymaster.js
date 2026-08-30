import { decodeFunctionData, parseTransaction, recoverTransactionAddress } from "viem";

import { settlementChain } from "./chains.js";
import { ERC8004_IDENTITY_ABI } from "./erc8004.js";

const ALLOWED_METHODS = new Set(["pm_isSponsorable", "eth_sendRawTransaction"]);

export async function relaySponsoredErc8004Registration({
  method,
  params,
  registration,
  paymasterRpc: suppliedPaymasterRpc,
  paymasterUrl = process.env.ADN_BSC_PAYMASTER_URL,
  chain: suppliedChain
} = {}) {
  const chain = suppliedChain || settlementChain();
  const baseSponsorship = { sponsored: false, vendor_pays_gas: false, transport: "bnb_eoa_paymaster" };
  if (!ALLOWED_METHODS.has(method)) return failure("invalid_paymaster_method", "Only sponsorship checks and signed registration submission are allowed.", baseSponsorship);
  if (!Array.isArray(params)) return failure("invalid_paymaster_params", "Paymaster params must be an array.", baseSponsorship);
  if (![56, 97].includes(Number(chain.id)) || Number(registration?.chain_id) !== Number(chain.id)) {
    return failure("invalid_chain", "Vendor identity sponsorship requires the active BNB Smart Chain.", baseSponsorship);
  }
  if (!suppliedPaymasterRpc && !paymasterUrl) {
    return { ...failure("paymaster_not_configured", "AgentRouter gas sponsorship is not configured.", baseSponsorship), statusCode: 503 };
  }

  let transaction;
  let ownerAddress = "";
  try {
    if (method === "pm_isSponsorable") {
      transaction = params[0];
      ownerAddress = String(transaction?.from || "");
    } else {
      transaction = parseTransaction(params[0]);
      ownerAddress = await recoverTransactionAddress({ serializedTransaction: params[0] });
    }
  } catch {
    return failure("invalid_paymaster_transaction", "The sponsored registration transaction cannot be decoded.", baseSponsorship);
  }
  const validationError = validateRegistrationTransaction({ method, transaction, registration, chain });
  if (validationError) return failure("invalid_paymaster_transaction", validationError, baseSponsorship);

  const paymasterRpc = suppliedPaymasterRpc || createPaymasterRpc(paymasterUrl);
  try {
    const result = await paymasterRpc(method, params);
    if (method === "pm_isSponsorable") {
      const sponsorshipFlag = result?.Sponsorable ?? result?.sponsorable;
      const sponsored = sponsorshipFlag === true || sponsorshipFlag === "true";
      const sponsorPolicy = result?.SponsorPolicy ?? result?.sponsorPolicy ?? null;
      if (!sponsored) {
        return failure("sponsorship_unavailable", "AgentRouter could not sponsor this registration. No Vendor-paid transaction was sent.", {
          ...baseSponsorship,
          sponsor_policy: sponsorPolicy
        });
      }
      return {
        ok: true,
        statusCode: 200,
        status: "sponsorable",
        result,
        owner_address: ownerAddress,
        gas_sponsorship: { ...baseSponsorship, sponsored: true, sponsor_policy: sponsorPolicy }
      };
    }
    return {
      ok: true,
      statusCode: 200,
      status: "submitted",
      result,
      owner_address: ownerAddress,
      gas_sponsorship: { ...baseSponsorship, sponsored: true }
    };
  } catch (error) {
    return { ...failure("paymaster_unavailable", error.message || "AgentRouter Paymaster is unavailable.", baseSponsorship), statusCode: 502 };
  }
}

function validateRegistrationTransaction({ method, transaction, registration, chain }) {
  if (!transaction || String(transaction.to || "").toLowerCase() !== String(registration?.transaction?.to || "").toLowerCase()) {
    return "The sponsored transaction must target the configured ERC-8004 Identity Registry.";
  }
  try {
    if (BigInt(transaction.value || 0) !== 0n) return "ERC-8004 identity registration must not transfer BNB.";
    const gas = BigInt(transaction.gas ?? 0);
    const maxGas = BigInt(process.env.ADN_ERC8004_REGISTRATION_MAX_GAS || 500000);
    if (gas <= 0n || gas > maxGas) return "The sponsored registration gas limit is outside the allowed range.";
  } catch {
    return "The sponsored registration value or gas limit is invalid.";
  }
  if (method === "eth_sendRawTransaction") {
    if (Number(transaction.chainId) !== Number(chain.id)) return "The signed transaction chain does not match the active BNB chain.";
    try {
      const gasPrice = transaction.gasPrice == null && transaction.type === "legacy" ? 0n : BigInt(transaction.gasPrice ?? -1);
      if (gasPrice !== 0n) return "A sponsored Vendor registration must use zero gas price.";
    } catch {
      return "The sponsored registration gas price is invalid.";
    }
  }
  try {
    const decoded = decodeFunctionData({ abi: ERC8004_IDENTITY_ABI, data: transaction.data });
    if (decoded.functionName !== "register" || String(decoded.args?.[0] || "") !== String(registration.agent_uri || "")) {
      return "The sponsored call must register this Vendor's exact AgentRouter metadata URI.";
    }
  } catch {
    return "The sponsored transaction is not a valid ERC-8004 register call.";
  }
  return null;
}

function createPaymasterRpc(url) {
  let id = 0;
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      signal: AbortSignal.timeout(Number(process.env.ADN_BSC_PAYMASTER_TIMEOUT_MS || 15000))
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) throw new Error(payload?.error?.message || `BNB Paymaster returned HTTP ${response.status}.`);
    return payload?.result;
  };
}

function failure(status, error, gasSponsorship) {
  return { ok: false, statusCode: 422, status, error, gas_sponsorship: gasSponsorship };
}
