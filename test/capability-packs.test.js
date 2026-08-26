import assert from "node:assert/strict";
import test from "node:test";

import {
  getCapabilityPack,
  listCapabilityPacks,
  resolveCapabilityPackCall,
  serviceMatchesCapabilityPack
} from "../src/capability-packs.js";

function record({ serviceId, capabilities, price = "0.01", verified = true }) {
  return {
    verification_status: verified ? "verified" : "pending",
    manifest: {
      service_id: serviceId,
      title: serviceId,
      description_for_agent: capabilities.join(" "),
      capabilities,
      pricing: { amount: price, currency: "USDC" }
    }
  };
}

test("capability packs expose stable agent-facing contracts instead of provider taxonomy", () => {
  const packs = listCapabilityPacks([]);

  assert.deepEqual(packs.map((pack) => pack.id), ["research", "social", "markets", "onchain", "operations"]);
  for (const pack of packs) {
    assert.match(pack.contract, /^[a-z]+\.[a-z_]+$/);
    assert.ok(pack.sample_task.length > 10);
    assert.ok(pack.description.length > 20);
  }
});

test("pack matching requires domain evidence and never classifies a generic data service", () => {
  const scholarly = record({ serviceId: "openalex_works", capabilities: ["paper_search", "citation_metadata"] });
  const dex = record({ serviceId: "dex_pairs", capabilities: ["dex_liquidity", "onchain_data"] });
  const generic = record({ serviceId: "generic", capabilities: ["data_service"] });

  assert.equal(serviceMatchesCapabilityPack(scholarly.manifest, "research"), true);
  assert.equal(serviceMatchesCapabilityPack(scholarly.manifest, "onchain"), false);
  assert.equal(serviceMatchesCapabilityPack(dex.manifest, "onchain"), true);
  assert.equal(serviceMatchesCapabilityPack(generic.manifest, "research"), false);
  assert.equal(serviceMatchesCapabilityPack(generic.manifest, "markets"), false);
  assert.equal(serviceMatchesCapabilityPack(generic.manifest, "missing"), false);
});

test("capability pack summaries derive live availability and price from registered services", () => {
  const records = [
    record({ serviceId: "exa_search", capabilities: ["web_search"], price: "0.02" }),
    record({ serviceId: "openalex_works", capabilities: ["paper_search"], price: "0" }),
    record({ serviceId: "stock_quote", capabilities: ["market_price"], price: "0.001", verified: false })
  ];

  const research = listCapabilityPacks(records).find((pack) => pack.id === "research");
  const markets = getCapabilityPack("markets", records);

  assert.equal(research.service_count, 2);
  assert.equal(research.verified_service_count, 2);
  assert.equal(research.starting_price_usdc, "0");
  assert.equal(markets.service_count, 1);
  assert.equal(markets.verified_service_count, 0);
  assert.equal(markets.starting_price_usdc, "0.001");
  assert.equal(getCapabilityPack("missing", records), null);
});

test("canonical research contract resolves general research and scholarly intent to different provider capabilities", () => {
  const records = [
    record({ serviceId: "exa_search", capabilities: ["web_search"] }),
    record({ serviceId: "openalex_works", capabilities: ["paper_search", "citation_metadata"] })
  ];

  const general = resolveCapabilityPackCall(records, {
    contract: "research.find_evidence",
    params: { task: "Research AgentRouter competitors and market opportunities" }
  });
  const scholarly = resolveCapabilityPackCall(records, {
    contract: "research.find_evidence",
    params: { task: "Find peer reviewed papers and citation metadata about agent routing" }
  });

  assert.equal(general.ok, true);
  assert.equal(general.pack.id, "research");
  assert.equal(general.resolved_capability, "web_search");
  assert.equal(general.params.query, "Research AgentRouter competitors and market opportunities");
  assert.equal(scholarly.resolved_capability, "paper_search");
});

test("canonical contracts fail transparently when their pack has no live service and ignore unknown contracts", () => {
  const generic = record({ serviceId: "generic", capabilities: ["data_service"] });
  const unavailable = resolveCapabilityPackCall([generic], {
    contract: "markets.get_market_data",
    params: { task: "Get the current NVDA price" }
  });

  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, "no_match");
  assert.equal(unavailable.pack.id, "markets");
  assert.equal(resolveCapabilityPackCall([generic], { contract: "unknown.do_thing", params: {} }), null);
});
