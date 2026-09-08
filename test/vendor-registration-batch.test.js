import test from "node:test";
import assert from "node:assert/strict";
import { createVendorRegistrationBatch } from "../src/vendor-registration-batch.js";
import { accountHtml } from "../src/home.js";

test("dashboard offers explicit selection, owner preview, pause and persistent progress", () => {
  const html = accountHtml({auth:{user:{name:"Operator"}}});
  for (const id of ["vendor-batch-start", "vendor-batch-stop", "vendor-batch-owner", "vendor-batch-status"]) assert.ok(html.includes('id="'+id+'"'));
  assert.match(html, /navigator\.locks/);
  assert.match(html, /createVendorRegistrationBatch/);
  assert.match(html, /row\.detail\.textContent\s*=/);
  assert.doesNotMatch(html, /Vendor pays 0 BNB and remains the onchain owner/);
  assert.match(html, /vendor-payment-mode/);
  assert.match(html, /Review platform fee/);
  assert.match(html, /confirmFee:/);
});

const OWNER = "0x0531bc53d9632E58dd08b54034824E2FdF68f1dB";
const REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";
const HASH = "0x" + "d".repeat(64);
const vendor = id => ({ provider_id: id, registration_endpoint: `/agent-router/erc8004/vendors/${id}/registration` });
function harness(options = {}) {
  const calls = [], updates = [], saved = new Map();
  const vendors = [vendor("alpha"), vendor("beta")];
  const info = v => ({ provider_id: v.provider_id, chain_id: 56, transaction: { to: REGISTRY, value: "0x0", data: "0xf2c298be00" },
    gas_sponsorship: { available: true, endpoint: v.registration_endpoint + "/paymaster" }, ...options.info });
  let receipts = 0;
  const wallet = { ...options.walletFlags, request: async request => {
    calls.push(request.method);
    if (options.wallet) { const r = await options.wallet(request); if (r !== undefined) return r; }
    switch (request.method) {
      case "eth_requestAccounts": case "eth_accounts": return [OWNER];
      case "eth_chainId": return "0x38";
      case "wallet_switchEthereumChain": return null;
      case "eth_estimateGas": return "0x186a0";
      case "eth_signTransaction": assert.equal(request.params[0].gasPrice, "0x0"); assert.equal(request.params[0].from, OWNER); return "0xabcd";
      default: throw new Error("Unexpected wallet method " + request.method);
    }
  } };
  const api = async (path, body) => {
    calls.push(body?.method || (body ? "verify" : "config"));
    if (options.api) { const r = await options.api(path, body); if (r !== undefined) return r; }
    if (!body) return info(vendors.find(v => v.registration_endpoint === path) || vendor(path.split("/").at(-2)));
    if (body.method === "eth_getTransactionCount") return { result: "0x0" };
    if (body.method === "pm_isSponsorable") return { gas_sponsorship: { sponsored: true } };
    if (body.method === "eth_sendRawTransaction") return { result: HASH };
    receipts++;
    return { identity: { agent_id: String(receipts), owner_address: OWNER, tx_hash: body.tx_hash } };
  };
  const journal = { get: key => saved.get(key), set: (key, value) => { if (options.storageFail) throw new Error("Storage unavailable"); saved.set(key, structuredClone(value)); } };
  const batch = createVendorRegistrationBatch({ wallet, walletInfo:options.walletInfo, api, journal, confirmFee:options.confirmFee, now:options.now, onUpdate: x => updates.push(x), sleep: async () => {}, receiptAttempts: 2 });
  return { batch, calls, updates, saved, vendors, wallet, api, journal };
}

function paidHarness(options = {}) {
  return harness({walletFlags:{isRabby:true}, info:{platform_paid:{available:true,owner_address:OWNER}},
    confirmFee:async () => true, ...options,
    wallet:async r => {
      const custom = await options.wallet?.(r); if (custom !== undefined) return custom;
      if (r.method === "eth_gasPrice") return "0x5f5e100";
      if (r.method === "eth_getBalance") return "0xde0b6b3a7640000";
      if (r.method === "eth_sendTransaction") {
        assert.equal(r.params[0].gasPrice,"0x5f5e100");
        assert.equal(r.params[0].value,"0x0");
        assert.equal(r.params[0].from,OWNER); return HASH;
      }
    }});
}
test("Rabby platform-paid mode quotes each fee before ordinary sending and verifies the receipt", async () => {
  const quotes=[];
  const h=paidHarness({confirmFee:async q=>{quotes.push(q); assert.equal(h.calls.includes("eth_sendTransaction"),quotes.length>1);return true;}});
  assert.equal((await h.batch.run(h.vendors,OWNER,"platform_paid")).status,"completed");
  assert.equal(quotes.length,2);
  assert.equal(quotes[0].owner_address,OWNER);
  assert.equal(quotes[0].max_fee_wei,"12000000000000");
  assert.equal(h.calls.filter(x=>x==="eth_sendTransaction").length,2);
  for(const method of ["eth_signTransaction","eth_sendRawTransaction","pm_isSponsorable"]) assert.ok(!h.calls.includes(method));
});
for (const [name,options] of [
  ["declined fee",{confirmFee:async()=>false}],
  ["missing fee confirmation handler",{confirmFee:undefined}],
  ["not a platform operator",{info:{platform_paid:{available:false}}}],
  ["wrong platform owner",{info:{platform_paid:{available:true,owner_address:"0x"+"2".repeat(40)}}}],
  ["insufficient BNB",{wallet:r=>r.method==="eth_getBalance"?"0x0":undefined}],
  ["zero gas price",{wallet:r=>r.method==="eth_gasPrice"?"0x0":undefined}],
  ["excessive fee",{wallet:r=>r.method==="eth_gasPrice"?"0xffffffffff":undefined}],
  ["expired quote",{now:(()=>{let time=0;return ()=>time+=61000;})()}]
]) test("platform-paid blocks "+name+" without sending",async()=>{
  const h=paidHarness(options);
  assert.equal((await h.batch.run(h.vendors,OWNER,"platform_paid")).status,"paused");
  assert.ok(!h.calls.includes("eth_sendTransaction"));
});
test("paid send timeout blocks duplicate submission across retries",async()=>{
  const h=paidHarness({wallet:r=>{if(r.method==="eth_sendTransaction")throw new Error("Lost response");}});
  await h.batch.run(h.vendors,OWNER,"platform_paid");
  await h.batch.run(h.vendors,OWNER,"platform_paid");
  assert.equal(h.calls.filter(x=>x==="eth_sendTransaction").length,1);
  assert.match(h.updates.at(-1).message,/unknown/i);
});
test("paid wallet cancellation pauses and permits a deliberate retry",async()=>{
  const h=paidHarness({wallet:r=>{if(r.method==="eth_sendTransaction")throw Object.assign(new Error("Cancel"),{code:4001});}});
  await h.batch.run(h.vendors,OWNER,"platform_paid");
  assert.match(h.updates.at(-1).message,/cancel/i);
  await h.batch.run(h.vendors,OWNER,"platform_paid");
  assert.equal(h.calls.filter(x=>x==="eth_sendTransaction").length,2);
});
test("unknown payment modes cannot accidentally use sponsorship",async()=>{
  const h=paidHarness();
  await assert.rejects(h.batch.run(h.vendors,OWNER,"auto"),/mode/i);
  assert.equal(h.calls.length,0);
});
test("platform-paid rechecks account and network after fee consent",async()=>{
  for(const changed of ["eth_accounts","eth_chainId"]){
    let approved=false;
    const h=paidHarness({confirmFee:async()=>{approved=true;return true;},wallet:r=>approved&&r.method===changed?(changed==="eth_accounts"?["0x"+"2".repeat(40)]:"0x1"):undefined});
    assert.equal((await h.batch.run(h.vendors,OWNER,"platform_paid")).status,"paused");
    assert.ok(!h.calls.includes("eth_sendTransaction"));
  }
});
test("pausing during paid fee review sends nothing",async()=>{
  const h=paidHarness({confirmFee:async()=>{h.batch.stop();return true;}});
  await h.batch.run(h.vendors,OWNER,"platform_paid");
  assert.ok(!h.calls.includes("eth_sendTransaction"));
});
test("paid receipt failure resumes verification without asking for fees or resending",async()=>{
  let failed=true,quotes=0;
  const h=paidHarness({confirmFee:async()=>{quotes++;return true;},api:(p,b)=>{if(b?.tx_hash&&failed)throw new Error("Receipt service unavailable");}});
  await h.batch.run([h.vendors[0]],OWNER,"platform_paid");
  failed=false;
  assert.equal((await h.batch.run([h.vendors[0]],OWNER,"platform_paid")).status,"completed");
  assert.equal(quotes,1);
  assert.equal(h.calls.filter(x=>x==="eth_sendTransaction").length,1);
});
test("paid flow cannot sign without durable browser storage",async()=>{
  const h=paidHarness({storageFail:true});
  assert.equal((await h.batch.run(h.vendors,OWNER,"platform_paid")).status,"paused");
  assert.ok(!h.calls.includes("eth_sendTransaction"));
});

test("batch requests wallet access once and registers selected vendors sequentially", async () => {
  const h = harness();
  const result = await h.batch.run(h.vendors, OWNER);
  assert.equal(result.status, "completed");
  assert.equal(h.calls.filter(x => x === "eth_requestAccounts").length, 1);
  assert.equal(h.calls.filter(x => x === "eth_signTransaction").length, 2);
  assert.deepEqual(h.calls.filter(x => ["eth_signTransaction", "verify"].includes(x)), ["eth_signTransaction", "verify", "eth_signTransaction", "verify"]);
  assert.equal(h.updates.filter(x => x.status === "registered").length, 2);
  assert.deepEqual(h.updates.filter(x => x.status === "registered").map(x=>x.agent_id), ["1","2"]);
});

test("deduplicates exact provider IDs without automatically merging similar names", async () => {
  const h = harness();
  await h.batch.run([h.vendors[0], h.vendors[0], vendor("api_alpha")], OWNER);
  assert.equal(h.calls.filter(x => x === "eth_signTransaction").length, 2);
});

for (const [name, items, owner] of [
  ["empty selection", [], OWNER], ["invalid owner", [vendor("alpha")], "0x123"],
  ["over five vendors", Array.from({length: 6}, (_,i) => vendor("v"+i)), OWNER],
  ["foreign endpoint", [{ ...vendor("alpha"), registration_endpoint: "https://evil.test/registration" }], OWNER],
  ["mismatched provider endpoint", [{ ...vendor("alpha"), registration_endpoint: vendor("beta").registration_endpoint }], OWNER]
]) test("blocks " + name + " before wallet prompts", async () => {
  const h = harness();
  await assert.rejects(h.batch.run(items, owner));
  assert.equal(h.calls.length, 0);
});

test("wrong connected owner stops without signing", async () => {
  const h = harness({wallet: r => r.method === "eth_requestAccounts" ? ["0x" + "1".repeat(40)] : undefined});
  await assert.rejects(h.batch.run(h.vendors, OWNER), /wallet|owner/i);
  assert.ok(!h.calls.includes("eth_signTransaction"));
});

test("already registered vendors are skipped without a new signature", async () => {
  const h = harness({info: {current_identity: {agent_id: "42"}}});
  await h.batch.run(h.vendors, OWNER);
  assert.ok(!h.calls.includes("eth_signTransaction"));
  assert.equal(h.updates.filter(x => x.status === "already_registered").length, 2);
});

for (const [name, options] of [
  ["unavailable sponsorship", {info: {gas_sponsorship: {available: false}}}],
  ["unsupported chain", {info: {chain_id: 1}}],
  ["nonzero native value", {info: {transaction: {to: REGISTRY, value: "0x1", data: "0xf2c298be00"}}}],
  ["foreign sponsor endpoint", {info: {gas_sponsorship: {available: true, endpoint: "https://evil.test"}}}],
  ["denied sponsorship", {api: (p,b) => b?.method === "pm_isSponsorable" ? {gas_sponsorship:{sponsored:false}} : undefined}],
  ["invalid nonce", {api: (p,b) => b?.method === "eth_getTransactionCount" ? {result:"no"} : undefined}],
  ["excessive gas", {wallet: r => r.method === "eth_estimateGas" ? "0xfffffff" : undefined}],
  ["changed wallet account", {wallet: r => r.method === "eth_accounts" ? ["0x"+"2".repeat(40)] : undefined}],
  ["changed chain", {wallet: r => r.method === "eth_chainId" ? "0x1" : undefined}],
  ["blocked persistence", {storageFail:true}]
]) test(name + " stops the queue without charging BNB", async () => {
  const h = harness(options);
  const result = await h.batch.run(h.vendors, OWNER);
  assert.equal(result.status, "paused");
  assert.ok(!h.calls.includes("eth_signTransaction"));
  assert.ok(!h.calls.includes("eth_sendRawTransaction"));
  assert.ok(!h.calls.includes("eth_sendTransaction"));
  assert.ok(h.updates.at(-1).message);
});

for (const code of [4001, -32601]) test("wallet rejection/unsupported signing " + code + " pauses subsequent vendors", async () => {
  const h = harness({wallet: r => {if(r.method === "eth_signTransaction") throw Object.assign(new Error("Wallet error"), {code});}});
  const result = await h.batch.run(h.vendors, OWNER);
  assert.equal(result.status, "paused");
  assert.equal(h.calls.filter(x => x === "eth_signTransaction").length, 1);
  assert.ok(!h.calls.includes("eth_sendRawTransaction"));
  assert.match(h.updates.at(-1).message, code === 4001 ? /cancel/i : /eth_signTransaction/);
});

test("lost submission response is durable and never automatically resubmitted", async () => {
  const h = harness({api: (p,b) => {if(b?.method === "eth_sendRawTransaction") throw new Error("Network lost");}});
  assert.equal((await h.batch.run(h.vendors, OWNER)).status, "paused");
  assert.equal((await h.batch.run(h.vendors, OWNER)).status, "paused");
  assert.equal(h.calls.filter(x => x === "eth_sendRawTransaction").length, 1);
  assert.equal(h.calls.filter(x => x === "eth_signTransaction").length, 1);
  assert.match(h.updates.at(-1).message, /transaction hash/i);
  assert.ok(!JSON.stringify([...h.saved.values()]).includes("0xabcd"), "never persist signed raw transaction");
});

test("pending receipt resumes after reload by verifying hash without signing", async () => {
  let pending = true;
  const h = harness({api: (p,b) => {if(b?.tx_hash && pending) throw Object.assign(new Error("Pending"), {code:"ERC8004_RECEIPT_NOT_FOUND"});}});
  assert.equal((await h.batch.run([h.vendors[0]], OWNER)).status, "paused");
  pending = false;
  const resumed = createVendorRegistrationBatch({wallet:h.wallet,api:h.api,journal:h.journal,sleep:async()=>{}});
  assert.equal((await resumed.run([h.vendors[0]], OWNER)).status, "completed");
  assert.equal(h.calls.filter(x => x === "eth_signTransaction").length, 1);
});

test("manual transaction-hash recovery only verifies, never signs or sends", async () => {
  const h = harness();
  assert.equal((await h.batch.run([{...h.vendors[0],recovery_hash:HASH}], OWNER)).status,"completed");
  assert.ok(!h.calls.includes("eth_signTransaction"));
  assert.ok(!h.calls.includes("eth_sendRawTransaction"));
});

test("stopping during wallet approval does not broadcast the returned signature", async () => {
  let h;
  h = harness({wallet: r => {if(r.method === "eth_signTransaction") {h.batch.stop();return "0xabcd";}}});
  assert.equal((await h.batch.run(h.vendors, OWNER)).status,"paused");
  assert.ok(!h.calls.includes("eth_sendRawTransaction"));
});

test("concurrent run on one controller cannot create another signing queue", async () => {
  let release;
  const gate = new Promise(r => release = r);
  const h = harness({wallet: async r => {if(r.method === "eth_requestAccounts") await gate;}});
  const first = h.batch.run(h.vendors, OWNER);
  await assert.rejects(h.batch.run(h.vendors, OWNER), /running/i);
  release(); await first;
});

test("invalid submission hash never counts as a registered identity", async () => {
  const h = harness({api: (p,b) => b?.method === "eth_sendRawTransaction" ? {result:"0x123"} : undefined});
  assert.equal((await h.batch.run(h.vendors, OWNER)).status,"paused");
  assert.ok(!h.calls.includes("verify"));
});

test("only allowlisted transaction fields reach the wallet, never an injected sender", async () => {
  const h = harness({info:{transaction:{to:REGISTRY,data:"0xf2c298be00",value:"0x0",from:"0x"+"7".repeat(40)}}});
  assert.equal((await h.batch.run([h.vendors[0]],OWNER)).status,"completed");
});

test("receipt mismatch and authentication expiry stop before the next Vendor", async () => {
  for (const response of [{identity:{agent_id:"42",owner_address:"0x"+"1".repeat(40),tx_hash:HASH}}, {identity:{agent_id:"42",owner_address:OWNER,tx_hash:"0x"+"e".repeat(64)}}]) {
    const h = harness({api:(p,b)=>b?.tx_hash ? response : undefined});
    assert.equal((await h.batch.run(h.vendors,OWNER)).status,"paused");
    assert.equal(h.calls.filter(x=>x==="eth_signTransaction").length,1);
  }
  const h = harness({api:()=>{throw new Error("Login expired");}});
  assert.equal((await h.batch.run(h.vendors,OWNER)).status,"paused");
  assert.ok(!h.calls.includes("eth_signTransaction"));
});

test("malformed recovery hash and malformed wallet result never reach submission", async () => {
  const h = harness();
  assert.equal((await h.batch.run([{...h.vendors[0],recovery_hash:"0x123"}],OWNER)).status,"paused");
  const bad = harness({wallet:r=>r.method === "eth_signTransaction" ? {} : undefined});
  assert.equal((await bad.batch.run(bad.vendors,OWNER)).status,"paused");
  assert.ok(!bad.calls.includes("eth_sendRawTransaction"));
});

for(const options of [{walletFlags:{isRabby:true}}, {walletInfo:{rdns:"io.rabby"}}]) {
  test("Rabby fresh registration stops before wallet prompts and sponsor calls", async () => {
    const h = harness(options);
    assert.equal((await h.batch.run(h.vendors,OWNER)).status,"paused");
    assert.deepEqual(h.calls,["config"]);
    assert.equal(h.updates.at(-1).error_code,"WALLET_SPONSORED_SIGNING_UNSUPPORTED");
    assert.match(h.updates.at(-1).message,/Rabby/);
  });
  test("Rabby can recover a submitted hash without unsupported signing or wallet prompts", async () => {
    const h = harness(options);
    assert.equal((await h.batch.run([{...h.vendors[0],recovery_hash:HASH}],OWNER)).status,"completed");
    assert.deepEqual(h.calls,["config","verify"]);
  });
}

for(const [code, expected] of [[4001,"cancelled"],[4100,"authorization"],[4200,"does not support"],[-32601,"does not support"],[-32002,"pending"],[-32603,"failed"],[undefined,"failed"]]) {
  test("signing error classification preserves code " + code + " without exposing wallet payload", async () => {
    const h = harness({wallet:r=>{if(r.method === "eth_signTransaction") throw Object.assign(new Error("sensitive provider payload"),{code});}});
    await h.batch.run(h.vendors,OWNER);
    const update = h.updates.at(-1);
    assert.equal(update.error_code,code ?? "WALLET_SIGNING_FAILED");
    assert.match(update.message,new RegExp(expected,"i"));
    assert.doesNotMatch(update.message,/sensitive/);
    assert.ok(!h.calls.includes("eth_sendRawTransaction"));
    assert.ok(!h.calls.includes("eth_sendTransaction"));
  });
}
