import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLocalSocialExecutionPlan,
  getLocalSocialPlatformCatalog,
  prepareLocalSocialDisclosure
} from "../src/local-social-privacy.js";

test("local social catalog distinguishes full research sources from limited discovery sources", () => {
  const catalog = getLocalSocialPlatformCatalog();
  const byId = new Map(catalog.map((item) => [item.platform, item]));

  for (const platform of ["x", "reddit", "xiaohongshu", "bilibili", "youtube", "facebook"]) {
    assert.equal(byId.get(platform)?.research_suitability, "keyword_user_voice");
    assert.equal(byId.get(platform)?.credential_location, "user_device_only");
  }
  assert.equal(byId.get("instagram")?.research_suitability, "account_discovery_only");
  assert.equal(byId.get("v2ex")?.research_suitability, "community_browse_only");
});

test("local execution plans are declarative, read-only, and upload nothing by default", () => {
  const plan = buildLocalSocialExecutionPlan({
    platform: "xiaohongshu",
    operation: "search",
    query: "KIMI K3 用户有哪些抱怨",
    limit: 20
  });

  assert.equal(plan.protocol_version, "agentrouter_local_social_task_v1");
  assert.equal(plan.execution_location, "user_device");
  assert.equal(plan.permissions.access, "read_only");
  assert.equal(plan.permissions.user_confirmation, "required_first_use");
  assert.equal(plan.data_policy.credentials, "never_upload");
  assert.equal(plan.data_policy.raw_results, "never_upload");
  assert.equal(plan.data_policy.default_disclosure, "aggregate_only");
  assert.deepEqual(plan.allowed_domains, ["xiaohongshu.com", "edith.xiaohongshu.com"]);
  assert.deepEqual(plan.adapter_candidates.slice(0, 2), ["opencli-xiaohongshu", "xhs-skills-local"]);
  assert.equal("command" in plan, false);
  assert.equal(JSON.stringify(plan).toLowerCase().includes("cookie"), false);

  const youtubePlan = buildLocalSocialExecutionPlan({ platform: "youtube", operation: "search", query: "KIMI K3" });
  assert.deepEqual(youtubePlan.adapter_candidates, ["opencli-youtube", "yt-dlp"]);

  const xPlan = buildLocalSocialExecutionPlan({ platform: "x", operation: "read_post", target: "https://x.com/example/status/123" });
  assert.deepEqual(xPlan.adapter_candidates, ["opencli-twitter"]);
  assert.deepEqual(xPlan.optional_adapter_candidates, ["twitter-cli"]);
  assert.equal(xPlan.connector_policy.default_auth, "browser_managed");
  assert.equal(xPlan.connector_policy.requires_system_password, false);

  const accountPlan = buildLocalSocialExecutionPlan({
    platform: "x",
    operation: "read_user_posts",
    handle: "@whale_ag",
    from: "2025-08-24",
    to: "2026-08-24",
    entity: { required_terms: ["whale.ag"], excluded_terms: ["WhaleDance"] },
    limit: 20
  });
  assert.deepEqual(accountPlan.params, {
    query: null,
    target: null,
    handle: "whale_ag",
    from: "2025-08-24",
    to: "2026-08-24",
    entity: { required_terms: ["whale.ag"], excluded_terms: ["whaledance"] },
    limit: 20
  });
});

test("local execution plans reject write operations and unsupported platform operations", () => {
  assert.throws(
    () => buildLocalSocialExecutionPlan({ platform: "xiaohongshu", operation: "publish", query: "hello" }),
    (error) => error.code === "LOCAL_SOCIAL_OPERATION_NOT_ALLOWED"
  );
  assert.throws(
    () => buildLocalSocialExecutionPlan({ platform: "instagram", operation: "search_posts", query: "Kimi" }),
    (error) => error.code === "LOCAL_SOCIAL_OPERATION_NOT_ALLOWED"
  );
});

test("local disclosure keeps raw rows local unless the user explicitly consents", () => {
  const rows = [{
    url: "https://www.xiaohongshu.com/explore/123",
    text: "K3 很慢，而且经常卡住",
    author: "creator",
    cookie: "web_session=secret",
    request_headers: { authorization: "secret" }
  }];

  const privateResult = prepareLocalSocialDisclosure({ platform: "xiaohongshu", rows });
  assert.equal(privateResult.disclosure, "aggregate_only");
  assert.equal(privateResult.item_count, 1);
  assert.equal("rows" in privateResult, false);
  assert.equal(JSON.stringify(privateResult).includes("K3 很慢"), false);

  const consented = prepareLocalSocialDisclosure({ platform: "xiaohongshu", rows, consent: "share_sanitized_excerpts" });
  assert.equal(consented.disclosure, "sanitized_excerpts");
  assert.equal(consented.rows[0].text_excerpt, "K3 很慢，而且经常卡住");
  assert.equal(JSON.stringify(consented).includes("web_session"), false);
  assert.equal(JSON.stringify(consented).includes("authorization"), false);
});
