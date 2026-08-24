import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../src/server.js";
import { createResearchDraft, normalizeSocialEvidenceItem } from "../src/research.js";
import { searchPublicDiscussions } from "../src/research-search.js";
import { searchLocalSocialPlatform } from "../src/research-social-providers.js";
import { buildCreatorResearchReport } from "../src/research-synthesis.js";
import { getCapabilityCatalog } from "../src/router.js";

test("research drafts are explicit about manual evidence mode", () => {
  const draft = createResearchDraft({
    question: "AgentRouter 会不会只是另一个 API Marketplace？",
    audience: "AI 创作者",
    platforms: ["x", "reddit", "unknown"],
    time_range: "30d"
  });

  assert.equal(draft.project_version, "creator_research_project_v1");
  assert.equal(draft.status, "manual_evidence_required");
  assert.equal(draft.data_status.mode, "manual");
  assert.deepEqual(draft.platforms, ["x", "reddit"]);
  assert.equal(draft.evidence.length, 0);
  assert.ok(draft.suggested_queries.length >= 2);
  assert.equal(draft.evidence_schema.schema_version, "social_evidence_item_v1");
});

test("research drafts reject empty questions", () => {
  assert.throws(
    () => createResearchDraft({ question: "  " }),
    (error) => error.code === "RESEARCH_QUESTION_REQUIRED" && error.statusCode === 422
  );
});

test("social evidence normalization preserves provenance and rejects invented evidence shapes", () => {
  const item = normalizeSocialEvidenceItem({
    platform: "reddit",
    canonical_url: "https://www.reddit.com/r/example/comments/123/topic/",
    text_excerpt: "A short excerpt from the original discussion.",
    stance: "oppose",
    author_handle: "example_user",
    engagement: { score: 12, comments: 4, views: -1 }
  });

  assert.equal(item.evidence_version, "social_evidence_item_v1");
  assert.equal(item.platform, "reddit");
  assert.equal(item.stance, "oppose");
  assert.equal(item.source_type, "manual_user_input");
  assert.equal(item.license_or_usage_status, "link_and_short_excerpt_only");
  assert.deepEqual(item.engagement, { comments: 4, score: 12 });

  assert.throws(
    () => normalizeSocialEvidenceItem({ platform: "reddit", canonical_url: "not-a-url", text_excerpt: "x" }),
    (error) => error.code === "INVALID_EVIDENCE_URL"
  );
  assert.throws(
    () => normalizeSocialEvidenceItem({ platform: "tiktok", canonical_url: "https://example.com", text_excerpt: "x" }),
    (error) => error.code === "INVALID_EVIDENCE_PLATFORM"
  );
});

test("research page and project API are available without social account authorization", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const pageResponse = await fetch(`${baseUrl}/research`);
    assert.equal(pageResponse.status, 200);
    const page = await pageResponse.text();
    assert.match(page, /Creator Research Terminal/);
    assert.match(page, /Local-first privacy/);
    assert.match(page, /登录凭证与原始数据默认留在你的设备上/);
    const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length >= 1);
    for (const script of scripts) {
      assert.doesNotThrow(() => new Function(script));
    }

    const projectResponse = await fetch(`${baseUrl}/research/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        question: "创作者是否需要跨平台观点验证？",
        platforms: ["x", "reddit"]
      })
    });
    assert.equal(projectResponse.status, 201);
    const project = await projectResponse.json();
    assert.equal(project.question, "创作者是否需要跨平台观点验证？");
    assert.equal(project.data_status.connected_sources.length, 0);

    const evidenceResponse = await fetch(`${baseUrl}/research/api/evidence/normalize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        platform: "x",
        canonical_url: "https://x.com/example/status/1",
        text_excerpt: "A source-linked creator research observation.",
        stance: "support"
      })
    });
    assert.equal(evidenceResponse.status, 200);
    const evidence = await evidenceResponse.json();
    assert.equal(evidence.stance, "support");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("public discussion search exposes provider diagnostics and review-only candidates", async () => {
  const fetchImpl = async (_url, request) => {
    const body = JSON.parse(request.body);
    const isReddit = body.query.includes("site:reddit.com");
    return {
      ok: true,
      json: async () => ({
        status: "completed",
        search_id: isReddit ? "reddit-search" : "x-search",
        total_credits_used: 2,
        data: { data: isReddit ? [{ title: "K3 freezes", url: "https://www.reddit.com/r/kimi/comments/example", snippet: "It freezes in the middle of a task." }] : [] }
      })
    };
  };
  const localSearch = async () => ({ status: "not_configured", rows: [], attempts: [] });
  const semanticSearch = async () => ({ status: "no_results", rows: [], attempts: [] });
  const result = await searchPublicDiscussions({ question: "KIMI K3 用户有哪些抱怨", platforms: ["reddit", "x"] }, { apiKey: "test-key", fetchImpl, localSearch, semanticSearch });

  assert.equal(result.status, "review_required");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].verification_status, "requires_source_review");
  assert.equal(result.candidates[0].platform, "reddit");
  assert.deepEqual(result.searches.map((item) => item.status), ["completed", "no_results"]);
  assert.match(result.searches[0].query, /complaint OR problem/);
});

test("public discussion search reports provider failures instead of inventing results", async () => {
  const result = await searchPublicDiscussions(
    { question: "KIMI K3 用户有哪些抱怨", platforms: ["reddit"] },
    { apiKey: "test-key", localSearch: async () => ({ status: "not_configured", rows: [], attempts: [] }), semanticSearch: async () => ({ status: "no_results", rows: [], attempts: [] }), fetchImpl: async () => ({ ok: true, json: async () => ({ status: "failed", data: null }) }) }
  );
  assert.equal(result.status, "partial_or_failed");
  assert.equal(result.candidates.length, 0);
  assert.equal(result.searches[0].status, "provider_error");
});

test("local social connectors work without an XCrawl API key", async () => {
  const result = await searchPublicDiscussions(
    { question: "Kimi K3 用户有哪些抱怨", platforms: ["x"] },
    {
      apiKey: "",
      localSearch: async () => ({
        status: "completed",
        backend_id: "opencli-twitter",
        attempts: [],
        rows: [{ url: "https://x.com/user/status/123", author: "user", text: "Kimi K3 is slow and burns tokens.", created_at: "2026-07-20T10:00:00Z" }]
      })
    }
  );
  assert.equal(result.candidates.length, 1);
  assert.equal(result.searches[0].provider_id, "agentrouter-social-local");
  assert.equal(result.candidates[0].published_at, "2026-07-20T10:00:00.000Z");
});

test("broad complaint fallback excludes praise and incidental entity mentions", async () => {
  const queries = [];
  const result = await searchPublicDiscussions(
    { question: "KIMI K3 用户有哪些抱怨", platforms: ["x"] },
    {
      apiKey: "",
      localSearch: async (_platform, query) => {
        queries.push(query);
        return ({
          status: "completed",
          backend_id: "opencli-twitter",
          attempts: [],
          rows: query === "KIMI K3" ? [
            { url: "https://x.com/a/status/1", text: "KIMI K3 is excellent and I love it." },
            { url: "https://x.com/b/status/2", text: "KIMI K3 is too slow and burns my token quota." },
            { url: "https://x.com/c/status/3", text: "TSMC earnings mention KIMI K3 customers." }
          ] : []
        });
      },
      semanticSearch: async () => ({ status: "no_results", rows: [], attempts: [] })
    }
  );
  assert.equal(queries[1], "KIMI K3");
  assert.deepEqual(result.candidates.map((item) => item.canonical_url), ["https://x.com/b/status/2"]);
});

test("local social routing falls back in backend order without shell interpolation", async () => {
  const calls = [];
  const result = await searchLocalSocialPlatform("reddit", "Kimi K3 complaints", 10, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      if (command === "opencli") return { status: "auth_required", error: "login required" };
      return { status: "completed", data: { results: [{ url: "https://reddit.com/r/kimi/example", text: "It freezes" }] } };
    }
  });
  assert.equal(result.backend_id, "rdt-cli");
  assert.equal(result.rows.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 3), ["reddit", "search", "Kimi K3 complaints"]);
});

test("X research keeps the credential-reading CLI disabled by default", async () => {
  const calls = [];
  const result = await searchLocalSocialPlatform("x", "Kimi K3 complaints", 10, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { status: "provider_error", error: "Browser extension is not connected" };
    }
  });

  assert.deepEqual(calls, [{
    command: "opencli",
    args: ["twitter", "search", "Kimi K3 complaints", "--limit", "10", "-f", "json"]
  }]);
  assert.equal(result.status, "browser_connector_offline");
  assert.equal(result.action_required.code, "BROWSER_CONNECTOR_OFFLINE");
  assert.equal(result.action_required.requires_system_password, false);
});

test("X research credential fallback requires explicit opt-in", async () => {
  const calls = [];
  const result = await searchLocalSocialPlatform("x", "Kimi K3 complaints", 10, {
    allowCredentialFallback: true,
    runCommand: async (command, args) => {
      calls.push({ command, args });
      if (command === "opencli") return { status: "provider_error", error: "Browser connector offline" };
      return {
        status: "completed",
        data: [{ url: "https://x.com/example/status/123", text: "Explicit fallback result" }]
      };
    }
  });

  assert.deepEqual(calls.map((item) => item.command), ["opencli", "twitter"]);
  assert.equal(result.status, "completed");
  assert.equal(result.backend_id, "twitter-cli");
});

test("creator research preserves the browser-extension reconnect action", async () => {
  const result = await searchPublicDiscussions(
    { question: "Kimi K3 complaints", platforms: ["x"] },
    {
      apiKey: "",
      configPath: "/tmp/agentrouter-test-no-xcrawl-config.json",
      localSearch: async () => ({
        status: "browser_connector_offline",
        backend_id: null,
        rows: [],
        attempts: [{ backend_id: "opencli-twitter", status: "provider_error" }]
      }),
      semanticSearch: async () => ({ status: "no_results", rows: [], attempts: [] })
    }
  );

  assert.equal(result.searches[0].local_status, "browser_connector_offline");
  assert.equal(result.searches[0].status, "browser_connector_offline");
  assert.deepEqual(result.action_required, [{
    platform: "x",
    action: "connect_opencli_browser_extension",
    recommendation: "Open Chrome and reconnect the OpenCLI browser extension, then retry"
  }]);
});

test("local research routes all suitable keyword platforms through read-only adapters", async () => {
  const expected = {
    bilibili: ["search", "Kimi K3 complaints", "--type", "video", "-n", "10"],
    youtube: ["youtube", "search", "Kimi K3 complaints", "--limit", "10", "-f", "json"],
    facebook: ["facebook", "search", "Kimi K3 complaints", "--limit", "10", "-f", "json"]
  };
  for (const [platform, args] of Object.entries(expected)) {
    const calls = [];
    const result = await searchLocalSocialPlatform(platform, "Kimi K3 complaints", 10, {
      runCommand: async (command, commandArgs) => {
        calls.push({ command, args: commandArgs });
        return { status: "completed", data: { results: [{ url: `https://example.com/${platform}/1`, text: "K3 is slow" }] } };
      }
    });
    assert.equal(result.status, "completed");
    assert.deepEqual(calls[0].args, args);
  }
});

test("YouTube prefers the verified local browser adapter", async () => {
  const calls = [];
  const result = await searchLocalSocialPlatform("youtube", "Kimi K3 complaints", 8, {
    runCommand: async (command, args) => {
      calls.push({ command, args });
      return { status: "completed", data: [{ url: "https://youtube.com/watch?v=abc", title: "Kimi K3 is slow" }] };
    }
  });
  assert.equal(result.backend_id, "opencli-youtube");
  assert.deepEqual(calls[0], { command: "opencli", args: ["youtube", "search", "Kimi K3 complaints", "--limit", "8", "-f", "json"] });
});

test("creator report prioritizes original voices, deduplicates URLs, and groups complaints", () => {
  const report = buildCreatorResearchReport({
    question: "KIMI K3 用户有哪些抱怨",
    candidates: [
      { platform: "reddit", canonical_url: "https://reddit.com/r/kimi/comments/1?utm_source=x", text_excerpt: "The CLI freezes and gets stuck in a loop.", author_handle: "a" },
      { platform: "reddit", canonical_url: "https://reddit.com/r/kimi/comments/1", text_excerpt: "Duplicate URL", author_handle: "a" },
      { platform: "x", canonical_url: "https://x.com/b/status/2", text_excerpt: "It is slow and burns through my token quota.", author_handle: "b" },
      { platform: "other", canonical_url: "https://example.com/news", text_excerpt: "A news article about launch demand." }
    ]
  });
  assert.equal(report.quality.total_unique_items, 3);
  assert.equal(report.quality.direct_voice_items, 2);
  assert.ok(report.findings.some((finding) => finding.theme_id === "stability"));
  assert.ok(report.findings.some((finding) => finding.theme_id === "cost"));
});

test("native platform search removes unrelated complaint results before reporting", async () => {
  let observedQuery = "";
  const result = await searchPublicDiscussions(
    { question: "Kimi K3 用户有哪些抱怨", platforms: ["reddit"] },
    {
      apiKey: "test-key",
      localSearch: async (_platform, query) => {
        observedQuery = query;
        return ({
        status: "completed",
        backend_id: "opencli-reddit",
        attempts: [],
        rows: [
          { url: "https://reddit.com/r/kimi/1", title: "Kimi K3 freezes", selftext: "Kimi K3 gets stuck." },
          { url: "https://reddit.com/r/relationships/2", title: "Relationship problem", selftext: "Unrelated complaint." }
        ]
        });
      },
      semanticSearch: async () => ({ status: "no_results", rows: [], attempts: [] }),
      fetchImpl: async () => ({ ok: true, json: async () => ({ status: "completed", data: { data: [] } }) })
    }
  );
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].title, /Kimi K3/);
  assert.doesNotMatch(result.searches[0].query, /site:reddit/);
  assert.equal(observedQuery, '"Kimi K3" complaints slow expensive error token');
});

test("X complaint research retries an entity-only query when the strict complaint query returns no rows", async () => {
  const queries = [];
  const result = await searchPublicDiscussions(
    { question: "KIMI K3 用户有哪些抱怨", platforms: ["x"] },
    {
      apiKey: "",
      localSearch: async (_platform, query) => {
        queries.push(query);
        if (queries.length === 1) return { status: "completed", backend_id: "opencli-twitter", attempts: [], rows: [] };
        return {
          status: "completed",
          backend_id: "opencli-twitter",
          attempts: [],
          rows: [{
            url: "https://x.com/i/status/2079765133111570529",
            author: "jfdnet",
            text: "Kimi K3 用不起。随便跑一跑，周额度就被清空了。"
          }]
        };
      }
    }
  );

  assert.equal(queries.length, 2);
  assert.equal(queries[1], "KIMI K3");
  assert.equal(result.candidates.length, 1);
  assert.match(result.candidates[0].text_excerpt, /额度/);
});

test("general research does not force complaint vocabulary into Reddit queries", async () => {
  const observedQueries = [];
  let observedFallbackQuery = "";
  const result = await searchPublicDiscussions(
    { question: "AI and web3 products with real revenue", platforms: ["reddit"] },
    {
      apiKey: "",
      localSearch: async (_platform, query) => {
        observedQueries.push(query);
        return { status: "provider_error", rows: [], attempts: [] };
      },
      semanticSearch: async (query) => {
        observedFallbackQuery = query;
        return {
          status: "completed",
          backend_id: "test-search",
          attempts: [],
          rows: [{
            url: "https://www.reddit.com/r/CryptoCurrency/comments/example/real_revenue/",
            title: "AI and web3 products with real revenue",
            snippet: "Render and Akash have customers paying for compute jobs."
          }]
        };
      }
    }
  );

  assert.equal(observedQueries[0], "AI and web3 products with real revenue");
  assert.equal(observedFallbackQuery, "site:reddit.com AI and web3 products with real revenue");
  assert.doesNotMatch(observedFallbackQuery, /complaint|slow|freeze/);
  assert.equal(result.searches[0].status, "completed_fallback");
  assert.equal(result.candidates.length, 1);
});

test("Reddit research retries a bounded focused query when broad results are irrelevant", async () => {
  const queries = [];
  const result = await searchPublicDiscussions(
    { question: "AI and web3 products with real revenue", platforms: ["reddit"] },
    {
      apiKey: "",
      localSearch: async (_platform, query) => {
        queries.push(query);
        if (queries.length === 1) return {
          status: "completed", backend_id: "opencli-reddit", attempts: [],
          rows: [{ url: "https://reddit.com/r/stocks/comments/1/noise", title: "Unrelated financial report" }]
        };
        return {
          status: "completed", backend_id: "opencli-reddit", attempts: [],
          rows: [{
            url: "https://reddit.com/r/crypto/comments/2/revenue",
            title: "AI Web3 product with real revenue",
            selftext: "Paying customers use its API."
          }]
        };
      }
    }
  );

  assert.ok(queries.length >= 2);
  assert.match(queries[1], /AI Web3/);
  assert.equal(result.candidates.length, 1);
});

test("Reddit connector allows browser-backed searches enough time to finish", async () => {
  const calls = [];
  await searchLocalSocialPlatform("reddit", "AI web3 revenue", 10, {
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      return command === "opencli"
        ? { status: "completed", data: { results: [{ url: "https://reddit.com/r/ai/example", title: "Real revenue" }] } }
        : { status: "missing", error: "missing" };
    }
  });

  assert.equal(calls[0].options.timeout, 40000);
});

test("Bilibili OpenCLI connector allows browser-backed searches enough time to finish", async () => {
  const calls = [];
  const result = await searchLocalSocialPlatform("bilibili", "KIMI K3 用户有哪些抱怨", 5, {
    runCommand: async (command, args, options) => {
      calls.push({ command, args, options });
      if (command === "bili") return { status: "missing", error: "bili is not installed" };
      return {
        status: "completed",
        data: [{ url: "https://www.bilibili.com/video/BV1d3KY6vErk", title: "对国产模型kimi K3的疯狂吐槽" }]
      };
    }
  });

  assert.equal(result.backend_id, "opencli-bilibili");
  assert.equal(calls[1].options.timeout, 90000);
});

test("Reddit normalization keeps post body and created timestamp", async () => {
  const result = await searchPublicDiscussions(
    { question: "AI web3 revenue", platforms: ["reddit"] },
    {
      apiKey: "",
      localSearch: async () => ({
        status: "completed",
        backend_id: "opencli-reddit",
        attempts: [],
        rows: [{
          url: "https://www.reddit.com/r/CryptoCurrency/comments/example/revenue/",
          title: "AI Web3 revenue",
          selftext: "Fifty partners pay monthly for the API.",
          created_utc: 1753385804
        }]
      })
    }
  );

  assert.equal(result.candidates[0].text_excerpt, "Fifty partners pay monthly for the API.");
  assert.equal(result.candidates[0].published_at, "2025-07-24T19:36:44.000Z");
});

test("relevance matching uses whole tokens instead of substrings", async () => {
  const result = await searchPublicDiscussions(
    { question: "AI web3 revenue", platforms: ["reddit"] },
    {
      apiKey: "",
      localSearch: async () => ({
        status: "completed",
        backend_id: "opencli-reddit",
        attempts: [],
        rows: [
          { url: "https://reddit.com/r/stocks/comments/1/financials", title: "Financial revenue report" },
          { url: "https://reddit.com/r/crypto/comments/2/ai", title: "AI Web3 product revenue" }
        ]
      })
    }
  );

  assert.deepEqual(result.candidates.map((item) => item.title), ["AI Web3 product revenue"]);
});

test("general research uses evidence themes instead of complaint themes", () => {
  const report = buildCreatorResearchReport({
    question: "AI and web3 products with real revenue",
    candidates: [{
      platform: "reddit",
      canonical_url: "https://reddit.com/r/crypto/comments/1/revenue",
      text_excerpt: "Over 50 partners pay monthly recurring API revenue.",
      author_handle: "founder"
    }]
  });

  assert.ok(report.findings.some((finding) => finding.theme_id === "revenue"));
  assert.ok(report.findings.some((finding) => finding.theme_id === "adoption"));
  assert.equal(report.findings.some((finding) => finding.theme_id === "cost"), false);
});

test("profiles and negated praise are not counted as complaint voices", () => {
  const report = buildCreatorResearchReport({
    question: "Kimi K3 用户有哪些抱怨",
    candidates: [
      { platform: "xiaohongshu", canonical_url: "https://www.xiaohongshu.com/user/profile/abc", text_excerpt: "Kimi creator profile", author_handle: "brand" },
      { platform: "x", canonical_url: "https://x.com/user/status/1", text_excerpt: "It never refused and that is the best part.", author_handle: "user", source_type: "platform_search_result" }
    ]
  });
  assert.equal(report.quality.direct_voice_items, 1);
  assert.deepEqual(report.quality.verified_voice_platforms, ["x"]);
  assert.equal(report.findings.some((finding) => finding.theme_id === "quality"), false);
});

test("AgentRouter publishes social user voice research as a first-class capability", () => {
  const capability = getCapabilityCatalog().find((item) => item.capability === "social_user_voice_research");
  assert.ok(capability);
  assert.deepEqual(capability.input_schema.required, ["question"]);
  assert.ok(capability.input_schema.properties.platforms);
  assert.deepEqual(capability.input_schema.properties.operation.enum, ["search", "read_user_posts"]);
  assert.ok(capability.input_schema.properties.handle);
  assert.ok(capability.input_schema.properties.from);
  assert.ok(capability.input_schema.properties.to);
  assert.ok(capability.input_schema.properties.entity);
});

test("AgentRouter request endpoint runs the built-in social research capability", async () => {
  const socialResearchRunner = async (params) => ({
    ok: true,
    status: "completed",
    protocol: { protocol_version: "agent_router_social_research_v1" },
    request: { capability: "social_user_voice_research", params },
    result: {
      report: {
        confidence: "medium",
        quality: { direct_voice_items: 2, verified_voice_platforms: ["x", "reddit"] }
      },
      search: {
        searches: [
          { platform: "x", status: "completed" },
          { platform: "reddit", status: "completed" }
        ]
      }
    }
  });
  const server = createServer({ socialResearchRunner });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${baseUrl}/agent-router/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        capability: "social_user_voice_research",
        params: { question: "KIMI K3 用户有哪些抱怨", platforms: ["x", "reddit", "xiaohongshu"] }
      })
    });
    const responseText = await response.text();
    assert.equal(response.status, 200, responseText);
    const payload = JSON.parse(responseText);
    assert.equal(payload.ok, true);
    assert.equal(payload.request.capability, "social_user_voice_research");
    assert.equal(payload.result.report.quality.direct_voice_items, 2);
    assert.deepEqual(payload.result.report.quality.verified_voice_platforms, ["x", "reddit"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
