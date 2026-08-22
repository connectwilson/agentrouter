import { createPublicClient, encodeFunctionData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC8004_REPUTATION_ABI } from "./erc8004.js";
import { settlementChain } from "./chains.js";

export async function submitSponsoredErc8004Feedback({
  descriptor,
  privateKey,
  account: suppliedAccount,
  publicClient: suppliedPublicClient,
  paymasterRpc: suppliedPaymasterRpc,
  paymasterUrl = process.env.ADN_BSC_PAYMASTER_URL,
  chain: suppliedChain
} = {}) {
  const chain = suppliedChain || settlementChain();
  const base = { ...(descriptor || {}), submitter: "consumer_wallet" };
  if (![56, 97].includes(Number(descriptor?.chain_id)) || Number(descriptor?.chain_id) !== chain.id) {
    return failure(base, "invalid_chain", "BNB Paymaster feedback requires the active BSC chain.");
  }
  if (!paymasterUrl && !suppliedPaymasterRpc) {
    return failure(base, "paymaster_not_configured", "ADN_BSC_PAYMASTER_URL is required for gas-sponsored feedback.");
  }
  if (!descriptor?.registry_address || !descriptor?.agent_id || !descriptor?.feedback_hash) {
    return failure(base, "invalid_descriptor", "A complete ERC-8004 feedback descriptor is required.");
  }

  const account = suppliedAccount || privateKeyToAccount(normalizePrivateKey(privateKey));
  const publicClient = suppliedPublicClient || createPublicClient({ chain, transport: http(chain.rpcUrl) });
  const paymasterRpc = suppliedPaymasterRpc || createPaymasterRpc(paymasterUrl);
  const data = encodeFunctionData({
    abi: ERC8004_REPUTATION_ABI,
    functionName: "giveFeedback",
    args: [
      BigInt(descriptor.agent_id),
      BigInt(descriptor.value),
      Number(descriptor.value_decimals),
      descriptor.tag1,
      descriptor.tag2,
      descriptor.endpoint,
      descriptor.feedback_uri,
      descriptor.feedback_hash
    ]
  });
  const transaction = {
    account: account.address,
    to: descriptor.registry_address,
    data,
    value: 0n
  };
  const [nonce, gas] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.estimateGas(transaction)
  ]);
  const sponsorshipRequest = {
    from: account.address,
    to: descriptor.registry_address,
    value: "0x0",
    data,
    gas: toQuantity(gas)
  };
  const sponsorship = await paymasterRpc("pm_isSponsorable", [sponsorshipRequest]);
  const sponsorshipFlag = sponsorship?.Sponsorable ?? sponsorship?.sponsorable;
  const sponsorable = sponsorshipFlag === true || sponsorshipFlag === "true";
  const sponsorPolicy = sponsorship?.SponsorPolicy ?? sponsorship?.sponsorPolicy ?? null;
  if (!sponsorable) {
    return {
      ...failure(base, "sponsorship_unavailable", "The BNB Paymaster declined this ERC-8004 feedback transaction."),
      gas_sponsorship: { sponsored: false, sponsor_policy: sponsorPolicy }
    };
  }

  const signedTransaction = await account.signTransaction({
    type: "legacy",
    chainId: chain.id,
    nonce,
    gas,
    gasPrice: 0n,
    to: descriptor.registry_address,
    value: 0n,
    data
  });
  const txHash = await paymasterRpc("eth_sendRawTransaction", [signedTransaction]);
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: Number(process.env.ADN_ERC8004_RECEIPT_TIMEOUT_MS || 60000)
  });
  if (receipt?.status && receipt.status !== "success") {
    return failure(base, "submit_failed", "The sponsored ERC-8004 feedback transaction reverted.");
  }
  return {
    ...base,
    status: "submitted",
    mode: chain.network,
    tx_hash: txHash,
    block_number: receipt?.blockNumber?.toString?.(),
    feedback_account: account.address,
    explorer_url: `${chain.blockExplorers.default.url}/tx/${txHash}`,
    gas_sponsorship: {
      sponsored: true,
      sponsor_policy: sponsorPolicy,
      transport: "bnb_eoa_paymaster"
    }
  };
}

function createPaymasterRpc(url) {
  let id = 0;
  return async (method, params) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params })
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.error) {
      throw new Error(payload?.error?.message || `BNB Paymaster ${method} failed with HTTP ${response.status}.`);
    }
    return payload?.result;
  };
}

function normalizePrivateKey(value) {
  const key = String(value || "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(key)) throw new Error("A valid consumer wallet private key is required.");
  return key.startsWith("0x") ? key : `0x${key}`;
}

function toQuantity(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function failure(base, status, error) {
  return { ...base, status, error, recorded_offchain: true };
}
