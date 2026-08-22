import { createPublicClient, encodeFunctionData, http } from "viem";

const ABI = [{
  type: "function",
  name: "giveFeedback",
  stateMutability: "nonpayable",
  inputs: [
    { name: "agentId", type: "uint256" },
    { name: "value", type: "int128" },
    { name: "valueDecimals", type: "uint8" },
    { name: "tag1", type: "string" },
    { name: "tag2", type: "string" },
    { name: "endpoint", type: "string" },
    { name: "feedbackURI", type: "string" },
    { name: "feedbackHash", type: "bytes32" }
  ],
  outputs: []
}];

const BSC = {
  56: { id: 56, name: "BNB Smart Chain", network: "bsc", nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 }, rpcUrls: { default: { http: ["https://bsc-dataseed.binance.org"] } }, blockExplorers: { default: { url: "https://bscscan.com" } } },
  97: { id: 97, name: "BNB Smart Chain Testnet", network: "bsc-testnet", nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 }, rpcUrls: { default: { http: ["https://bsc-testnet-rpc.publicnode.com"] } }, blockExplorers: { default: { url: "https://testnet.bscscan.com" } } }
};

export async function submitSponsoredFeedback({ descriptor, account, paymasterRpc, publicClient: suppliedClient } = {}) {
  const chain = BSC[Number(descriptor?.chain_id)];
  const base = { ...(descriptor || {}), submitter: "consumer_wallet", recorded_offchain: true };
  if (!chain) return { ...base, status: "invalid_chain", error: "Gas sponsorship is only available for BNB Smart Chain feedback." };
  const client = suppliedClient || createPublicClient({ chain, transport: http(process.env.ADN_SETTLEMENT_RPC_URL || chain.rpcUrls.default.http[0]) });
  const data = encodeFunctionData({
    abi: ABI,
    functionName: "giveFeedback",
    args: [BigInt(descriptor.agent_id), BigInt(descriptor.value), Number(descriptor.value_decimals), descriptor.tag1, descriptor.tag2, descriptor.endpoint, descriptor.feedback_uri, descriptor.feedback_hash]
  });
  const [nonce, gas] = await Promise.all([
    client.getTransactionCount({ address: account.address, blockTag: "pending" }),
    client.estimateGas({ account: account.address, to: descriptor.registry_address, data, value: 0n })
  ]);
  const sponsorship = await paymasterRpc("pm_isSponsorable", [{
    from: account.address,
    to: descriptor.registry_address,
    value: "0x0",
    data,
    gas: `0x${gas.toString(16)}`
  }]);
  const sponsorshipFlag = sponsorship?.Sponsorable ?? sponsorship?.sponsorable;
  const sponsorable = sponsorshipFlag === true || sponsorshipFlag === "true";
  const sponsorPolicy = sponsorship?.SponsorPolicy ?? sponsorship?.sponsorPolicy ?? null;
  if (!sponsorable) {
    return { ...base, status: "sponsorship_unavailable", error: "The BNB Paymaster declined this feedback transaction.", gas_sponsorship: { sponsored: false, sponsor_policy: sponsorPolicy } };
  }
  const raw = await account.signTransaction({ type: "legacy", chainId: chain.id, nonce, gas, gasPrice: 0n, to: descriptor.registry_address, value: 0n, data });
  const txHash = await paymasterRpc("eth_sendRawTransaction", [raw]);
  const receipt = await client.waitForTransactionReceipt({ hash: txHash, confirmations: 1, timeout: 60000 });
  if (receipt.status !== "success") return { ...base, status: "submit_failed", error: "The sponsored feedback transaction reverted." };
  return {
    ...base,
    status: "submitted",
    mode: chain.network,
    tx_hash: txHash,
    block_number: receipt.blockNumber?.toString?.(),
    feedback_account: account.address,
    explorer_url: `${chain.blockExplorers.default.url}/tx/${txHash}`,
    gas_sponsorship: { sponsored: true, sponsor_policy: sponsorPolicy, transport: "bnb_eoa_paymaster" }
  };
}
