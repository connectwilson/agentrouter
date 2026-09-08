import test from "node:test";
import assert from "node:assert/strict";
import { createVendorWalletDiscovery } from "../src/vendor-wallet-discovery.js";
import { accountHtml } from "../src/home.js";

function fixture() {
  const target = new EventTarget();
  const changes = [];
  const discovery = createVendorWalletDiscovery({target, onChange: entries => changes.push(entries)});
  const announce = (provider, name = "Rabby", rdns = "io.rabby") => {
    const event = new Event("eip6963:announceProvider");
    event.detail = {provider, info:{name, rdns, uuid:"same-untrusted-uuid", icon:"https://example.invalid/icon"}};
    target.dispatchEvent(event);
  };
  return {target, changes, discovery, announce};
}

test("discovers wallets without connecting and requires explicit selection", () => {
  const f = fixture();
  let prompts = 0;
  const rabby = {request:()=>{prompts++;}};
  f.announce(rabby);
  assert.equal(f.discovery.list().length,1);
  assert.equal(f.discovery.get(""),undefined);
  assert.equal(f.discovery.get(f.discovery.list()[0].id).provider,rabby);
  assert.equal(prompts,0);
  assert.equal(f.discovery.list()[0].rdns,"io.rabby");
  assert.equal(f.discovery.list()[0].icon,undefined);
});

test("late announcements cannot replace the selected provider even with duplicate UUIDs", () => {
  const f = fixture();
  const rabby = {request:()=>{}}, other = {request:()=>{}};
  f.announce(rabby);
  const selected = f.discovery.list()[0].id;
  f.announce(other,"Other","com.other");
  f.announce(rabby);
  assert.equal(f.discovery.list().length,2);
  assert.equal(f.discovery.get(selected).provider,rabby);
});

test("rejects malformed announcements and bounds discovery", () => {
  const f = fixture();
  f.announce({}); f.announce(null); f.announce({request:()=>{}},null);
  assert.equal(f.discovery.list().length,0);
  for(let i=0;i<30;i++) f.announce({request:()=>{}},"Wallet "+i);
  assert.equal(f.discovery.list().length,20);
});

test("refresh requests announcements; legacy injection is explicitly labeled and never replaces announced wallets", () => {
  const f = fixture();
  const legacy = {isRabby:true,request:()=>{}};
  f.target.ethereum = legacy;
  let refreshes = 0;
  f.target.addEventListener("eip6963:requestProvider",()=>{refreshes++;});
  f.discovery.refresh();
  const entry = f.discovery.list()[0];
  assert.equal(entry.provider,legacy);
  assert.match(entry.name,/Rabby/);
  f.announce(legacy);
  assert.equal(f.discovery.list().length,1);
  f.target.ethereum = {request:()=>{}};
  f.discovery.refresh();
  assert.equal(f.discovery.list().length,1);
  assert.equal(refreshes,2);
  f.discovery.dispose();
  f.announce({request:()=>{}});
  assert.equal(f.discovery.list().length,1);
});

test("account binds batch to the explicitly selected wallet, not global injection", () => {
  const html = accountHtml();
  assert.ok(html.includes('walletSelect.id = "vendor-wallet-select"'));
  assert.ok(html.includes('walletStatus.id = "vendor-wallet-status"'));
  assert.match(html,/wallet:selectedWallet\.provider/);
  assert.doesNotMatch(html,/wallet:window\.ethereum, api:vendorApi/);
  assert.match(html,/recovery\.addEventListener\("input", updateVendorControls\)/);
});
