#!/usr/bin/env node
// Compile and deploy AgentRouterEvidenceAnchor.
//
// The contract is events only — no storage, no owner, nothing upgradeable — so
// a deployment is disposable: losing the address costs the ability to look up
// past anchors by it, not any funds or authority. Deploy your own rather than
// trusting one someone else published.
//
//   npm install
//   RPC_URL=https://bsc-dataseed.binance.org \
//   PRIVATE_KEY=0x... \
//   node contracts/deploy.js
//
// --dry-run compiles and estimates gas without broadcasting, and needs no key.
//
// The chain is read from the RPC rather than configured, so this works against
// any EVM network without a table to keep in sync.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { createPublicClient, createWalletClient, defineChain, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "AgentRouterEvidenceAnchor.sol");
const dryRun = process.argv.includes("--dry-run");
const rpcUrl = process.env.RPC_URL || "";

if (!rpcUrl) {
  console.error("Set RPC_URL to an endpoint for the chain you are deploying to.");
  process.exit(1);
}

function compile() {
  const solc = require("solc");
  const name = "AgentRouterEvidenceAnchor.sol";
  const output = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { [name]: { content: fs.readFileSync(source, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  })));
  const errors = (output.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length) {
    for (const error of errors) console.error(error.formattedMessage);
    throw new Error("Contract did not compile.");
  }
  const contract = output.contracts?.[name]?.AgentRouterEvidenceAnchor;
  if (!contract?.evm?.bytecode?.object) throw new Error("Compiler produced no bytecode.");
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

const { abi, bytecode } = compile();
console.log(`Compiled AgentRouterEvidenceAnchor (${(bytecode.length - 2) / 2} bytes)`);

const probe = createPublicClient({ transport: http(rpcUrl) });
const chainId = await probe.getChainId();
const chain = defineChain({
  id: chainId,
  name: `chain ${chainId}`,
  nativeCurrency: { name: "native", symbol: "native", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } }
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
console.log(`Target: chain ${chainId} via ${rpcUrl}`);

const key = process.env.PRIVATE_KEY || "";
if (!key) {
  console.error("\nSet PRIVATE_KEY to the deploying wallet's key and run again.");
  console.error("Deploying costs gas on the target chain.");
  process.exit(dryRun ? 0 : 1);
}

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const balance = await publicClient.getBalance({ address: account.address });
const gas = await publicClient.estimateGas({ account, data: bytecode });
const gasPrice = await publicClient.getGasPrice();
console.log(`Deployer: ${account.address} (${formatEther(balance)})`);
console.log(`Estimated: ${gas} gas at ${gasPrice} wei = ${formatEther(gas * gasPrice)}`);

if (balance < gas * gasPrice) {
  throw new Error(`Deployer holds ${formatEther(balance)}, less than the estimated cost.`);
}
if (dryRun) {
  console.log("\n--dry-run: nothing was broadcast.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
const hash = await wallet.deployContract({ abi, bytecode });
console.log(`\nBroadcast ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`Deployment failed in block ${receipt.blockNumber}.`);
}
console.log(`\nDeployed to ${receipt.contractAddress}`);
