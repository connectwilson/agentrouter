#!/usr/bin/env node
// Compile and deploy AgentRouterEvidenceAnchor to the configured settlement
// chain, then print the address to put in ADN_EVIDENCE_ANCHOR_CONTRACT.
//
// The contract is events only — no storage, no owner, nothing upgradeable — so
// a deployment is disposable: losing this address costs the ability to read
// past anchors by address, not any funds or authority.
//
//   ADN_SETTLEMENT_CHAIN=bsc \
//   ADN_SETTLEMENT_RPC_URL=https://bsc-dataseed.binance.org \
//   ADN_EVIDENCE_ANCHOR_PRIVATE_KEY=0x... \
//   node scripts/deploy-evidence-anchor.js
//
// Pass --dry-run to compile and estimate gas without broadcasting.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import { createPublicClient, createWalletClient, formatEther, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { settlementChain } from "../src/chains.js";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.join(here, "..", "contracts", "AgentRouterEvidenceAnchor.sol");
const dryRun = process.argv.includes("--dry-run");

function compile() {
  const solc = require("solc");
  const name = "AgentRouterEvidenceAnchor.sol";
  const input = {
    language: "Solidity",
    sources: { [name]: { content: fs.readFileSync(source, "utf8") } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((entry) => entry.severity === "error");
  if (errors.length) {
    for (const error of errors) console.error(error.formattedMessage);
    throw new Error("Contract did not compile.");
  }
  const contract = output.contracts?.[name]?.AgentRouterEvidenceAnchor;
  if (!contract?.evm?.bytecode?.object) throw new Error("Compiler produced no bytecode.");
  return { abi: contract.abi, bytecode: `0x${contract.evm.bytecode.object}` };
}

const chain = settlementChain();
const { abi, bytecode } = compile();
console.log(`Compiled AgentRouterEvidenceAnchor (${(bytecode.length - 2) / 2} bytes)`);
console.log(`Target: ${chain.name} (chain ${chain.id}) via ${chain.rpcUrl}`);

const publicClient = createPublicClient({ chain, transport: http(chain.rpcUrl) });

// Refuse to sign against an RPC that is not the chain we think it is: the same
// mismatch the server guards at startup, and here it would put the contract on
// the wrong network entirely.
const reported = await publicClient.getChainId();
if (reported !== chain.id) {
  throw new Error(`RPC reports chain ${reported} but ADN_SETTLEMENT_CHAIN expects ${chain.id}. Set ADN_SETTLEMENT_RPC_URL to an RPC for this chain.`);
}

const key = process.env.ADN_EVIDENCE_ANCHOR_PRIVATE_KEY || process.env.ADN_ARC_ANCHOR_PRIVATE_KEY || process.env.ADN_DEPLOYER_PRIVATE_KEY || "";
if (!key) {
  console.error("\nSet ADN_EVIDENCE_ANCHOR_PRIVATE_KEY to the deploying wallet's key and run again.");
  console.error("Deploying costs gas on the target chain. Use a key you control and can afford to expose to this process.");
  process.exit(dryRun ? 0 : 1);
}

const account = privateKeyToAccount(key.startsWith("0x") ? key : `0x${key}`);
const balance = await publicClient.getBalance({ address: account.address });
console.log(`Deployer: ${account.address} (${formatEther(balance)} ${chain.nativeCurrency.symbol})`);

const gas = await publicClient.estimateGas({ account, data: bytecode });
const gasPrice = await publicClient.getGasPrice();
console.log(`Estimated: ${gas} gas at ${gasPrice} wei = ${formatEther(gas * gasPrice)} ${chain.nativeCurrency.symbol}`);

if (balance < gas * gasPrice) {
  throw new Error(`Deployer holds ${formatEther(balance)} ${chain.nativeCurrency.symbol}, which is less than the estimated cost.`);
}

if (dryRun) {
  console.log("\n--dry-run: nothing was broadcast.");
  process.exit(0);
}

const wallet = createWalletClient({ account, chain, transport: http(chain.rpcUrl) });
const hash = await wallet.deployContract({ abi, bytecode });
console.log(`\nBroadcast ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 2 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  throw new Error(`Deployment failed in block ${receipt.blockNumber}.`);
}

console.log(`\nDeployed to ${receipt.contractAddress}`);
if (chain.explorer?.url) console.log(`${chain.explorer.url}/address/${receipt.contractAddress}`);
console.log(`\nSet on the web service:\n  ADN_EVIDENCE_ANCHOR_CONTRACT=${receipt.contractAddress}`);
