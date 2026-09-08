import { encodeFunctionData, keccak256 } from "viem";

// Fixed ceiling makes an uncertain-broadcast retry with the same outbox nonce
// reproduce the exact transaction. Never replace it with an EOA-paid transfer.
const GAS_LIMIT = 300000n;

export function createSponsoredAnchorWallet({ account, chain, publicClient, paymasterRpc, paymasterUrl = process.env.ADN_BSC_PAYMASTER_URL }) {
  return {
    async writeContract({ address, abi, functionName, args, nonce }) {
      if (![56, 97].includes(chain.id)) throw new Error("Anchor sponsorship requires BSC.");
      if (!paymasterRpc && !paymasterUrl) throw new Error("Anchor sponsorship is not configured; no paid fallback is allowed.");
      if (!["anchorEvidence", "anchorFeedback"].includes(functionName)) throw new Error("Unsupported sponsored anchor method.");
      if (nonce == null || BigInt(nonce) < 0n || BigInt(nonce) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Invalid durable anchor nonce.");
      if (await publicClient.getChainId() !== chain.id) throw new Error("Anchor sponsorship RPC chain mismatch.");
      const data = encodeFunctionData({ abi, functionName, args });
      await publicClient.simulateContract({ account: account.address, address, abi, functionName, args, gasPrice: 0n });
      const gas = await publicClient.estimateGas({ account: account.address, to: address, data, value: 0n, gasPrice: 0n });
      if (gas <= 0n || gas > GAS_LIMIT) throw new Error("Anchor gas exceeds the sponsorship limit.");
      const rpc = paymasterRpc || ((method, params) => requestPaymaster(paymasterUrl, method, params));
      const policy = await rpc("pm_isSponsorable", [{ from: account.address, to: address, data, value: "0x0", gas: `0x${GAS_LIMIT.toString(16)}` }]);
      const allowed = policy?.sponsorable ?? policy?.Sponsorable;
      if (allowed !== true && allowed !== "true") throw new Error("Anchor sponsorship denied; check the contract, sender and method policy. No paid fallback was sent.");
      const raw = await account.signTransaction({ type: "legacy", chainId: chain.id, to: address, data, value: 0n, gas: GAS_LIMIT, gasPrice: 0n, nonce: Number(nonce) });
      const hash = await rpc("eth_sendRawTransaction", [raw]);
      if (String(hash).toLowerCase() !== keccak256(raw).toLowerCase()) throw new Error("Paymaster returned a mismatched anchor transaction hash.");
      return hash;
    }
  };
}

async function requestPaymaster(url, method, params) {
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await response.json();
    if (!response.ok || body?.error || body?.result == null) throw new Error("invalid response");
    return body.result;
  } catch {
    // RPC URLs may contain credentials. Never persist raw transport errors.
    throw new Error(`BNB anchor Paymaster ${method} unavailable; retry the durable job without changing its nonce.`);
  }
}
