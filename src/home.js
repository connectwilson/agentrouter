import { authModalHtml, authModalStyles } from "./auth-modal.js";
import { clientRouterScript, naiveDesignSystemStyles } from "./app-shell.js";

const skillInstallCommand = "npx @agentrouternetwork/agentrouter";
const localInstallConfig = `{
  "mcpServers": {
    "AgentRouter": {
      "command": "npx",
      "args": ["-y", "--package", "@agentrouternetwork/mcp@latest", "agentrouter-mcp"],
      "env": {
        "AGENT_ROUTER_URL": "http://127.0.0.1:8800"
      }
    }
  }
}`;

const supportedClientLogos = [
  { label: "Claude", file: "claude.svg" },
  { label: "Codex", file: "openai.svg" },
  { label: "Hermes", file: "nous-research.svg" },
  { label: "Cursor", file: "cursor.svg" },
  { label: "Windsurf", file: "windsurf.svg" },
  { label: "OpenCode", file: "opencode.svg" },
  { label: "Gemini", file: "gemini.svg" },
  { label: "OpenClaw", file: "openclaw.svg" }
];

export function homeHtml({ auth = {} } = {}) {
  return page({
    title: "AgentRouter Markets",
    auth,
    body: `
      <header class="hero">
        <div class="dot-grid" aria-hidden="true"></div>
        <div class="shell wide-shell hero-center">
          <h1>Agent-native API routing layer</h1>
          <p class="lead">AgentRouter gives your agent access to verifiable premium data sources, per call, with no subscriptions.</p>
          <a class="hero-cta" href="/agent">Explore Data/APIs</a>

          <div class="install-strip" aria-label="AgentRouter setup instruction">
            <div class="install-top">
              <span class="status-dots" aria-hidden="true"><i></i><i></i><i></i></span>
              <span class="install-label" id="home-install-label">Give this to your AI agent</span>
            </div>
            <div class="install-command">
              <code id="home-install-command">${html(skillInstallCommand)}</code>
              <button type="button" id="home-copy-install">Copy</button>
            </div>
          </div>
          <p class="install-note" id="home-install-note">Installs the Skill, connects one detected AI client, and verifies AgentRouter tools. Hosted capabilities update automatically.</p>
          <div class="client-row" aria-label="Supported AI agent tools">
            <span>Works with</span>
            <div class="client-logos">
              ${supportedClientLogos.map(clientLogoItem).join("")}
            </div>
          </div>

          <div class="hero-paths">
            <a class="path-card" href="/human">
              <span class="path-label">For human</span>
              <h2>Data provider studio</h2>
              <p>Import a working API endpoint, verify the response, and publish it as an agent-callable paid service.</p>
              <span class="path-action">Open provider dashboard</span>
            </a>
            <a class="path-card" href="/agent">
              <span class="path-label">For agent</span>
              <h2>Install once, route on demand</h2>
              <p>Connect an AI client once, then discover services dynamically without pre-installing every provider tool.</p>
              <span class="path-action">Open agent API hub</span>
            </a>
            <a class="path-card" href="/agent-router/trust">
              <span class="path-label">Network</span>
              <h2>Verified service quality</h2>
              <p>Every paid call returns validation metadata and feeds the trust loop for future routing decisions.</p>
              <span class="path-action">See reputation data</span>
            </a>
          </div>
          <p class="install-note"><a href="/public-apis">Browse tested Public APIs coverage →</a></p>
        </div>
      </header>

      <main>
        <section class="shell wide-shell stats-section">
          <div class="stats-heading">
            <div>
              <span class="eyebrow">Network snapshot</span>
              <h2>Overall stats</h2>
              <p>Live execution, routing, and verification activity for AgentRouter Markets.</p>
            </div>
            <a class="button ghost" href="/agent-router/stats">Raw stats</a>
          </div>
          <div class="stats-grid">
            <div class="stat-block">
              <span>Registered services</span>
              <strong id="home-services">--</strong>
              <small>Published API cards</small>
              <div class="spark" id="spark-services"></div>
            </div>
            <div class="stat-block">
              <span>Verified services</span>
              <strong id="home-verified">--</strong>
              <small>Validation passed</small>
              <div class="spark" id="spark-verified"></div>
            </div>
            <div class="stat-block">
              <span>Service calls</span>
              <strong id="home-calls">--</strong>
              <small>Observed demand</small>
              <div class="spark" id="spark-calls"></div>
            </div>
            <div class="stat-block">
              <span>Feedback events</span>
              <strong id="home-feedback">--</strong>
              <small>Past 30 Days</small>
              <div class="spark" id="spark-feedback"></div>
            </div>
          </div>

          <div class="network-tables">
            <section>
              <div class="table-head">
                <h3>Featured services</h3>
                <a href="/agent">View hub -></a>
              </div>
              <div class="service-table" id="featured-services"></div>
            </section>
            <section>
              <div class="table-head">
                <h3>Recently registered</h3>
                <a href="/human">Provider view -></a>
              </div>
              <div class="service-table" id="recent-services"></div>
            </section>
          </div>
        </section>

        <div class="shell wide-shell overview-wrap">
          <section class="overview">
            <div>
              <span class="eyebrow">Core loop</span>
              <h2>Built for the moment an agent hits a data wall</h2>
              <p>Traditional API hubs assume a human chooses an API, subscribes, manages keys, and wires clients manually. AgentRouter gives the agent a live market of callable services instead.</p>
            </div>
            <div class="step-row">
              <div><b>01</b><span>Provider publishes a verified endpoint</span></div>
              <div><b>02</b><span>Agent discovers and routes by task</span></div>
              <div><b>03</b><span>Call results update trust signals</span></div>
            </div>
          </section>
        </div>
      </main>
      <script>
        async function loadHomeStats() {
          let stats = { services: [], registered_services: 0, verified_services: 0, total_calls: 0, total_feedback_events: 0 };
          try { stats = await fetch("/agent-router/home-stats").then((res) => res.json()); } catch {}
          setText("home-services", stats.registered_services || 0);
          setText("home-verified", stats.verified_services || 0);
          setText("home-calls", stats.total_calls || 0);
          setText("home-feedback", stats.total_feedback_events || 0);
          renderSparks(stats);
          renderHomeTables(stats);
        }
        ${sharedClientHelpers()}
        document.getElementById("home-copy-install").addEventListener("click", async () => {
          const button = document.getElementById("home-copy-install");
          try {
            await navigator.clipboard.writeText(${JSON.stringify(skillInstallCommand)});
            button.textContent = "Copied";
            setTimeout(() => button.textContent = "Copy", 1200);
          } catch {
            button.textContent = "Select";
          }
        });
        function renderSparks(stats) {
          const values = [
            ["spark-services", Number(stats.registered_services || 0)],
            ["spark-verified", Number(stats.verified_services || 0)],
            ["spark-calls", Number(stats.total_calls || 0)],
            ["spark-feedback", Number(stats.total_feedback_events || 0)]
          ];
          for (const [id, value] of values) {
            const node = document.getElementById(id);
            const seed = Math.max(1, value);
            node.innerHTML = Array.from({ length: 28 }, (_, index) => {
              const height = 8 + ((seed + index * 7) % 34);
              return '<i style="height:' + height + 'px"></i>';
            }).join("");
          }
        }
        function renderHomeTables(stats) {
          const services = stats.services || [];
          const sorted = stats.featured_services || [...services].sort((a, b) =>
            Number(b.trust_score || 0) + Number(b.total_calls || 0) - Number(a.trust_score || 0) - Number(a.total_calls || 0)
          );
          const recent = stats.recent_services || [...services].slice(-8).reverse();
          document.getElementById("featured-services").innerHTML = renderRows(sorted.slice(0, 8), "score");
          document.getElementById("recent-services").innerHTML = renderRows(recent.slice(0, 8), "when");
        }
        function renderRows(services, mode) {
          if (!services.length) return '<div class="empty-row">No registered services yet.</div>';
          return [
            '<div class="service-row table-labels"><span>Service</span><span>Provider</span><span>' + (mode === "score" ? "Score" : "Calls") + '</span></div>',
            ...services.map((service) => {
              const score = service.trust_score == null ? "--" : Math.round(Number(service.trust_score) * 100);
              return '<div class="service-row">' +
                '<span><b>' + escapeHtml(service.service_id || service.title || "service") + '</b><small>' + escapeHtml(service.title || "Untitled service") + '</small></span>' +
                '<span><mark>' + escapeHtml(service.provider_id || "provider") + '</mark></span>' +
                '<span>' + (mode === "score" ? score : Number(service.total_calls || 0)) + '</span>' +
              '</div>';
            })
          ].join("");
        }
        loadHomeStats();
      </script>
    `
  });
}

function clientLogoItem(client) {
  const label = html(client.label);
  return `
    <span class="client-logo" tabindex="0" aria-label="${label}">
      <img src="/assets/client-logos/${html(client.file)}" alt="" loading="lazy">
      <span>${label}</span>
    </span>
  `;
}

export function humanHtml({ auth = {} } = {}) {
  if (!auth.user) return humanGuestHtml({ auth });
  return appPage({
    title: "For human",
    subtitle: "Manage provided data/APIs, edit services, and track USDC received.",
    active: "human",
    auth,
    body: `
      <main>
        <div class="shell wide-shell provider-console">
          <section class="provider-hero">
            <div>
              <span class="eyebrow">Provider Dashboard</span>
              <h2>Turn working APIs into agent-callable services</h2>
              <p>Import an endpoint, validate the real response, and publish it into the AgentRouter service hub. The dashboard keeps the RapidAPI-style inventory visible: cards, health, calls, and USDC earned.</p>
            </div>
            <div class="provider-actions">
              <a class="button primary" href="/studio">Add data/API</a>
              <a class="button" href="/studio">Edit services</a>
              <a class="button ghost" href="/agent-router/stats">Open stats JSON</a>
            </div>
          </section>

          <section class="provider-metrics">
            <div class="provider-metric"><span>Provided APIs</span><strong id="human-services">--</strong><small>Published service cards</small></div>
            <div class="provider-metric"><span>Verified APIs</span><strong id="human-verified">--</strong><small>Live validation passed</small></div>
            <div class="provider-metric"><span>Total calls received</span><strong id="human-calls">--</strong><small>Demand-side invocations</small></div>
            <div class="provider-metric"><span>Feedback events</span><strong id="human-feedback">--</strong><small>Quality loop signals</small></div>
            <div class="provider-metric"><span>USDC received</span><strong id="human-usdc">--</strong><small>Estimated paid volume</small></div>
          </section>

          <section class="provider-imports">
            <div>
              <span class="eyebrow">Fast import</span>
              <h2>Start with any provider asset</h2>
              <p>Paste a live endpoint, OpenAPI URL, Skill page, or API docs URL. Studio generates metadata and contracts, then blocks publish until a real response validates.</p>
            </div>
            <div class="import-options">
              <a href="/studio" class="import-option"><b>Single endpoint</b><span>Best for one data API URL.</span></a>
              <a href="/studio" class="import-option"><b>OpenAPI / Swagger</b><span>Batch import many endpoints.</span></a>
              <a href="/studio" class="import-option"><b>Skill / ClawHub</b><span>Convert existing agent skills into data services.</span></a>
              <a href="/studio" class="import-option"><b>Manual override</b><span>Only for edge cases.</span></a>
            </div>
          </section>

          <section class="provider-workbench">
            <aside class="provider-rail">
              <a class="rail-action primary" href="/studio">+ Publish API</a>
              <a class="rail-action" href="/agent">View marketplace</a>
              <a class="rail-action" href="/agent-router/trust">Trust feed</a>
              <div class="rail-note">
                <strong>Publish checklist</strong>
                <span>Source imported</span>
                <span>Metadata generated</span>
                <span>Data contract generated</span>
                <span>Endpoint reachable</span>
                <span>Real non-empty data returned</span>
                <span>Agent envelope verified</span>
              </div>
              <div class="rail-note" id="provider-profile-summary"></div>
            </aside>
            <div>
              <div class="market-section-head">
                <div>
                  <h2>Your API cards</h2>
                  <p>Provider inventory shown as buyer-facing cards, with live quality signals.</p>
                </div>
                <a class="button" href="/studio">New service</a>
              </div>
              <div class="provider-toolbar">
                <input id="human-service-search" placeholder="Search your APIs by service, provider, or capability" />
                <select id="human-service-sort">
                  <option value="recent">Recently registered</option>
                  <option value="calls">Most called</option>
                  <option value="trust">Highest trust</option>
                </select>
              </div>
              <div class="market-grid provider-grid" id="human-api-cards"></div>
              <div class="ops-panel">
                <div class="market-section-head">
                  <div>
                    <h2>Service operations</h2>
                    <p>Use this table to spot broken endpoints, stale verification, and services earning demand.</p>
                  </div>
                </div>
                <div class="ops-table" id="human-ops-table"></div>
              </div>
            </div>
          </section>
        </div>
      </main>
      <script>
        ${serviceClientScript()}
        let providerStats = { services: [] };
        document.addEventListener("input", (event) => {
          if (event.target?.id === "human-service-search") renderProviderCards(providerStats);
        });
        document.addEventListener("change", (event) => {
          if (event.target?.id === "human-service-sort") renderProviderCards(providerStats);
        });
        function renderPage(stats) {
          providerStats = stats;
          const services = stats.services || [];
          const totalUsdc = services.reduce((sum, service) => sum + serviceRevenue(service), 0);
          setText("human-services", services.length);
          setText("human-verified", stats.verified_services || 0);
          setText("human-calls", stats.total_calls || 0);
          setText("human-feedback", stats.total_feedback_events || 0);
          setText("human-usdc", formatUsdc(totalUsdc));
          renderProviderCards(stats);
          renderProviderSummary(stats);
          renderOpsTable(stats);
        }
        function renderProviderCards(stats) {
          const query = (document.getElementById("human-service-search")?.value || "").trim().toLowerCase();
          const sort = document.getElementById("human-service-sort")?.value || "recent";
          let services = [...(stats.services || [])].filter((service) => {
            const haystack = [service.title, service.service_id, service.provider_id, service.description_for_agent, ...(service.capabilities || [])].join(" ").toLowerCase();
            return !query || haystack.includes(query);
          });
          services.sort((a, b) => {
            if (sort === "calls") return Number(b.total_calls || 0) - Number(a.total_calls || 0);
            if (sort === "trust") return Number(b.trust_score || 0) - Number(a.trust_score || 0);
            return String(b.service_id || "").localeCompare(String(a.service_id || ""));
          });
          document.getElementById("human-api-cards").innerHTML = services.map((service) => apiCard(service, { human: true })).join("") ||
            '<div class="empty-market">No services yet. Add your first API in Provider Studio.</div>';
          renderOpsTable({ ...stats, services });
        }
        function renderProviderSummary(stats) {
          const providers = stats.providers || [];
          const top = [...providers].sort((a, b) => Number(b.estimated_revenue || 0) - Number(a.estimated_revenue || 0))[0];
          document.getElementById("provider-profile-summary").innerHTML = top
            ? '<strong>Top provider</strong><span>' + escapeHtml(top.provider_id) + '</span><span>' + top.service_count + ' services · ' + top.total_calls + ' calls</span><span>' + formatUsdc(top.estimated_revenue) + ' USDC</span>'
            : '<strong>Provider profile</strong><span>No services published yet.</span>';
        }
        function renderOpsTable(stats) {
          const services = stats.services || [];
          const rows = services.map((service) => {
            const validation = service.latest_validation || {};
            const issue = validation.ok === false
              ? (validation.error || validation.result_errors?.[0]?.message || validation.provider_error?.message || "Validation failed")
              : service.health_status === "degraded" ? "Recent failures detected" : "OK";
            const statusClass = service.verification_status === "verified" && service.health_status !== "degraded" ? "good" : "warn";
            return '<div class="ops-row">' +
              '<span><b>' + escapeHtml(service.title || service.service_id) + '</b><small>' + escapeHtml(service.service_id) + '</small></span>' +
              '<span><mark class="' + statusClass + '">' + escapeHtml(service.health_status || service.verification_status || "unknown") + '</mark></span>' +
              '<span>' + Number(service.total_calls || 0) + '</span>' +
              '<span>' + formatUsdc(service.estimated_revenue || 0) + '</span>' +
              '<span>' + escapeHtml(issue) + '</span>' +
              '<span><a href="/studio?service_id=' + encodeURIComponent(service.service_id) + '">Edit</a></span>' +
            '</div>';
          });
          document.getElementById("human-ops-table").innerHTML = [
            '<div class="ops-row ops-labels"><span>Service</span><span>Status</span><span>Calls</span><span>USDC</span><span>Latest issue</span><span>Action</span></div>',
            rows.join("") || '<div class="empty-row">No service operations yet.</div>'
          ].join("");
        }
        loadProviderStats().then(renderPage);
        async function loadProviderStats() {
          try {
            const response = await fetch("/human/stats");
            if (!response.ok) throw new Error("auth required");
            return await response.json();
          } catch {
            return { registered_services: 0, verified_services: 0, total_calls: 0, providers: [], services: [] };
          }
        }
      </script>
    `
  });
}

function humanGuestHtml({ auth = {} } = {}) {
  return appPage({
    title: "For human",
    subtitle: "Publish data/API services after signing in.",
    active: "human",
    auth,
    body: `
      <main>
        <div class="shell wide-shell provider-console">
          <section class="provider-hero provider-gate">
            <div>
              <span class="eyebrow">Provider workspace</span>
              <h2>Your API inventory stays private</h2>
              <p>Sign in to see the APIs you have uploaded, edit provider metadata, track calls, and view USDC received. Public visitors only see this introduction, not provider dashboards or private inventory.</p>
            </div>
            <div class="provider-actions">
              <a class="button primary" href="?login=1&amp;return_to=%2Fstudio" data-auth-modal-trigger data-auth-return-to="/studio">Add data/API</a>
              <a class="button ghost" href="/agent">Browse public services</a>
            </div>
          </section>

          <section class="guest-provider-grid">
            <article>
              <span class="eyebrow">01</span>
              <h3>Import a working API</h3>
              <p>Paste an endpoint, OpenAPI URL, docs page, or Skill link after login. Studio generates service metadata and an agent-readable contract.</p>
            </article>
            <article>
              <span class="eyebrow">02</span>
              <h3>Validate before publish</h3>
              <p>AgentRouter only publishes endpoints that return real JSON data and pass the paid-service envelope checks.</p>
            </article>
            <article>
              <span class="eyebrow">03</span>
              <h3>Track your own services</h3>
              <p>Your dashboard shows only your uploaded APIs, calls, success rate, trust feedback, and estimated USDC volume.</p>
            </article>
          </section>
        </div>
      </main>
    `
  });
}

export function agentHtml({ auth = {} } = {}) {
  return appPage({
    title: "For agent",
    subtitle: "Install once, search the API hub, and route to registered services.",
    active: "agent",
    auth,
    showHeader: false,
    body: `
      <main>
        <div class="shell wide-shell agent-market">
          <section class="market-hero">
            <div>
              <span class="eyebrow">API Hub for agents</span>
              <h2>Discover callable services</h2>
              <p>Search by task, provider, or capability. AgentRouter returns a buyer-friendly marketplace card plus the request shape an AI client can invoke.</p>
              <p><a href="/public-apis">See which public-apis/public-apis entries passed live validation →</a></p>
            </div>
          </section>

          <div class="market-toolbar">
            <input id="service-search" placeholder="Search APIs, providers, categories, or capabilities" />
            <select id="sort-services">
              <option value="relevance">By relevance</option>
              <option value="calls">Most called</option>
              <option value="trust">Highest trust</option>
              <option value="price">Lowest price</option>
            </select>
          </div>

          <div class="market-shell list-only">
            <aside class="filter-rail">
              <strong>Categories</strong>
              <div class="category-row vertical" id="category-row"></div>
              <div class="rail-note">
                <strong>AgentRouter adds</strong>
                <span>Dynamic discovery</span>
                <span>Paid invocation</span>
                <span>Post-call feedback</span>
              </div>
            </aside>

            <section>
              <div class="market-section-head">
                <div>
                  <h2>Available services</h2>
                  <p id="agent-result-count">Loading services...</p>
                </div>
              </div>
              <div class="market-grid" id="agent-api-cards"></div>
              <div class="pager" id="service-pager">
                <button type="button" id="service-prev">Previous</button>
                <span id="service-page-status">Page 1</span>
                <button type="button" id="service-next">Next</button>
              </div>
            </section>
          </div>
        </div>
      </main>
      <script>
        ${serviceClientScript()}
        let categories = [{ category: "All", count: 0 }];
        let builtInCapabilities = [];
        const builtInCategory = "Social research";
        const pageSize = 24;
        let servicePage = { services: [], total: 0, limit: pageSize, offset: 0, has_more: false };
        let activeCategory = "All";
        let currentPage = 0;
        let searchTimer = null;
        document.getElementById("service-search").addEventListener("input", () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            currentPage = 0;
            loadAgentServices();
          }, 180);
        });
        document.getElementById("sort-services").addEventListener("change", () => {
          currentPage = 0;
          loadAgentServices();
        });
        document.getElementById("service-prev").addEventListener("click", () => {
          if (currentPage <= 0) return;
          currentPage -= 1;
          loadAgentServices();
        });
        document.getElementById("service-next").addEventListener("click", () => {
          if (!servicePage.has_more) return;
          currentPage += 1;
          loadAgentServices();
        });
        async function renderPage() {
          const query = new URLSearchParams(location.search).get("q") || "";
          document.getElementById("service-search").value = query;
          try {
            const [categoryResponse, builtInResponse] = await Promise.all([
              fetch("/agent-router/service-categories"),
              fetch("/agent-router/builtin-capabilities")
            ]);
            const payload = await categoryResponse.json();
            const builtInPayload = await builtInResponse.json();
            builtInCapabilities = Array.isArray(builtInPayload.capabilities) ? builtInPayload.capabilities : [];
            categories = [
              { category: "All", count: Number(payload.total || 0) + builtInCapabilities.length },
              ...(payload.categories || []),
              ...(builtInCapabilities.length ? [{ category: builtInCategory, count: builtInCapabilities.length }] : [])
            ];
          } catch {}
          renderCategories();
          loadAgentServices();
        }
        function renderCategories() {
          document.getElementById("category-row").innerHTML = categories.map(({ category, count }) =>
            '<button type="button" class="category ' + (category === activeCategory ? "active" : "") + '" data-category="' + escapeHtml(category) + '">' + escapeHtml(category) + ' <small>' + formatCount(count) + '</small></button>'
          ).join("");
          document.querySelectorAll(".category").forEach((button) => {
            button.addEventListener("click", () => {
              activeCategory = button.dataset.category;
              currentPage = 0;
              renderCategories();
              loadAgentServices();
            });
          });
        }
        async function loadAgentServices() {
          if (activeCategory === builtInCategory) {
            servicePage = { services: [], total: 0, limit: pageSize, offset: 0, has_more: false };
            renderAgentHub();
            return;
          }
          const params = new URLSearchParams({
            q: document.getElementById("service-search").value.trim(),
            sort: document.getElementById("sort-services").value,
            category: activeCategory,
            limit: String(pageSize),
            offset: String(currentPage * pageSize)
          });
          document.getElementById("agent-result-count").textContent = "Loading services...";
          try {
            const response = await fetch("/agent-router/services?" + params.toString());
            servicePage = await response.json();
          } catch {
            servicePage = { services: [], total: 0, limit: pageSize, offset: 0, has_more: false };
          }
          renderAgentHub();
        }
        function renderAgentHub() {
          const query = document.getElementById("service-search").value.trim().toLowerCase();
          const visibleBuiltIns = (activeCategory === "All" || activeCategory === builtInCategory)
            ? builtInCapabilities.filter((capability) => !query || [capability.title, capability.description, capability.capability, ...(capability.platforms || [])].join(" ").toLowerCase().includes(query))
            : [];
          const services = servicePage.services || [];
          const cards = [...visibleBuiltIns.map(builtInCapabilityCard), ...services.map((service) => apiCard(service, { link: true }))];
          document.getElementById("agent-api-cards").innerHTML = cards.join("") ||
            '<div class="empty-market">No matching services found.</div>';
          const availableTotal = activeCategory === builtInCategory
            ? visibleBuiltIns.length
            : Number(servicePage.total || 0) + (activeCategory === "All" ? visibleBuiltIns.length : 0);
          setText("agent-result-count", availableTotal ? availableTotal + " available services" : "No services match this view");
          document.getElementById("service-prev").disabled = currentPage <= 0;
          document.getElementById("service-next").disabled = !servicePage.has_more;
          if (typeof renderPager === "function") renderPager();
          else {
            const pageStatus = document.getElementById("service-page-status");
            if (pageStatus) pageStatus.textContent = "Page " + (currentPage + 1);
          }
        }
        function builtInCapabilityCard(capability) {
          const platforms = (capability.platforms || []).map((platform) => '<span class="pill">' + escapeHtml(platform) + '</span>').join("");
          return '<article class="api-card builtin-capability-card">' +
            '<div class="api-top"><span class="type-badge">Use browser</span><span class="heart">◌</span></div>' +
            '<div class="api-main"><div class="logo">⌁</div><div><h3>' + escapeHtml(capability.title) + '</h3><p>' + escapeHtml(capability.description) + '</p></div></div>' +
            '<div class="pill-row">' + platforms + '</div>' +
            '<div class="stat-row"><span class="stat-pill"><b>Price</b> Free</span></div>' +
            '<div class="byline"><span>Read-only · local connector</span><span>' + escapeHtml(capability.credential_policy === "never_upload" ? "Credentials stay local" : capability.credential_policy || "") + '</span></div>' +
            '<span class="detail-link">' + escapeHtml(capability.connector_status === "local_connector_required" ? "Connect browser to use" : "Ready to use") + '</span>' +
          '</article>';
        }
        renderPage();
      </script>
    `
  });
}

export function publicApisHtml({ auth = {} } = {}) {
  return appPage({
    title: "Public APIs coverage",
    subtitle: "Live-tested discovery coverage from public-apis/public-apis.",
    active: "agent",
    auth,
    body: `
      <main>
        <div class="shell wide-shell agent-market">
          <section class="market-hero">
            <div>
              <span class="eyebrow">Public APIs coverage</span>
              <h2>Tested APIs, not directory claims</h2>
              <p>Usable means AgentRouter discovered a read-only endpoint and received a successful JSON response during live validation. Pending and unavailable entries remain visible with their reason.</p>
            </div>
          </section>

          <section class="detail-metrics" aria-label="Public API coverage summary">
            <div><span>Catalog entries</span><strong id="public-total">--</strong><small>Active upstream rows</small></div>
            <div><span>Usable</span><strong id="public-usable">--</strong><small>Passed live validation</small></div>
            <div><span>Unavailable</span><strong id="public-unavailable">--</strong><small>Blocked or failed</small></div>
            <div><span>Pending</span><strong id="public-pending">--</strong><small>Waiting for validation</small></div>
          </section>

          <div class="market-toolbar">
            <input id="public-api-search" placeholder="Search API, category, capability, or documentation URL" />
            <select id="public-api-availability">
              <option value="">All availability</option>
              <option value="usable">Usable</option>
              <option value="unavailable">Unavailable</option>
              <option value="pending">Pending</option>
            </select>
          </div>

          <section class="detail-panel">
            <div class="panel-head">
              <span class="eyebrow">Validation inventory</span>
              <h2 id="public-api-result-count">Loading APIs...</h2>
            </div>
            <div id="public-api-list" class="credit-ledger"></div>
            <div class="pager">
              <button type="button" id="public-api-prev">Previous</button>
              <span id="public-api-page">Page 1</span>
              <button type="button" id="public-api-next">Next</button>
            </div>
          </section>
        </div>
      </main>
      <script>
        ${serviceClientScript()}
        const publicApiPageSize = 50;
        let publicApiOffset = 0;
        let publicApiTimer = null;
        let publicApiPayload = { apis: [], summary: {}, total: 0, has_more: false };
        document.getElementById("public-api-search").addEventListener("input", () => {
          clearTimeout(publicApiTimer);
          publicApiTimer = setTimeout(() => { publicApiOffset = 0; loadPublicApis(); }, 180);
        });
        document.getElementById("public-api-availability").addEventListener("change", () => {
          publicApiOffset = 0;
          loadPublicApis();
        });
        document.getElementById("public-api-prev").addEventListener("click", () => {
          publicApiOffset = Math.max(0, publicApiOffset - publicApiPageSize);
          loadPublicApis();
        });
        document.getElementById("public-api-next").addEventListener("click", () => {
          if (!publicApiPayload.has_more) return;
          publicApiOffset += publicApiPageSize;
          loadPublicApis();
        });
        async function loadPublicApis() {
          const params = new URLSearchParams({
            q: document.getElementById("public-api-search").value.trim(),
            availability: document.getElementById("public-api-availability").value,
            limit: String(publicApiPageSize),
            offset: String(publicApiOffset)
          });
          const response = await fetch("/api/public-apis?" + params.toString());
          publicApiPayload = await response.json();
          renderPublicApis();
        }
        function renderPublicApis() {
          const summary = publicApiPayload.summary || {};
          setText("public-total", summary.total || 0);
          setText("public-usable", summary.usable || 0);
          setText("public-unavailable", summary.unavailable || 0);
          setText("public-pending", summary.pending || 0);
          setText("public-api-result-count", publicApiPayload.total + " matching APIs");
          document.getElementById("public-api-prev").disabled = publicApiOffset === 0;
          document.getElementById("public-api-next").disabled = !publicApiPayload.has_more;
          document.getElementById("public-api-page").textContent = "Page " + (Math.floor(publicApiOffset / publicApiPageSize) + 1);
          document.getElementById("public-api-list").innerHTML = (publicApiPayload.apis || []).map((api) => {
            const endpoints = (api.endpoints || []).map((endpoint) =>
              '<div><code>' + escapeHtml(endpoint.method || "GET") + " " + escapeHtml(endpoint.upstream_url || "") + '</code></div>'
            ).join("");
            return '<article class="ledger-row">' +
              '<div><strong>' + escapeHtml(api.title || "Untitled API") + '</strong><small>' + escapeHtml(api.category || "Uncategorized") + '</small></div>' +
              '<div><strong>' + escapeHtml(api.availability || "unknown") + '</strong><small>' + escapeHtml(api.status || "unknown") + '</small></div>' +
              '<div>' + (endpoints || '<small>' + escapeHtml(api.reason || "No callable endpoint validated") + '</small>') + '</div>' +
              '<div><a href="' + escapeHtml(api.documentation_url || "#") + '" target="_blank" rel="noreferrer">Documentation</a></div>' +
            '</article>';
          }).join("") || '<div class="empty-market">No matching APIs.</div>';
        }
        loadPublicApis().catch(() => {
          document.getElementById("public-api-result-count").textContent = "Could not load Public APIs coverage.";
        });
      </script>
    `
  });
}

export function serviceDetailHtml(detail, { auth = {} } = {}) {
  const service = detail.service || {};
  const manifest = detail.manifest || {};
  const validation = detail.latest_validation || {};
  const sampleRequest = manifest.sample_request || service.sample_request || {};
  const resultPreview = validation.result_preview || null;
  const serviceId = service.service_id || manifest.service_id || "";
  const endpoint = manifest.endpoint || {};
  const capabilities = manifest.capabilities || service.capabilities || [];
  const price = manifest.pricing || {};
  const trust = service.trust || {};
  const health = service.health || {};
  const requestData = service.request_data || {};
  const responseData = service.response_data || {};
  const routing = manifest.routing || service.routing || {};
  const preCallContext = manifest.pre_call_context || service.pre_call_context || {};
  const sourceProvenance = service.source_provenance || manifest.source_provenance || {};
  const selectionHints = {
    capabilities,
    routing_tags: routing.tags || routing.routing_tags || service.routing_tags || [],
    input_fields: Object.keys(sampleRequest || {}),
    buyer_requirements: preCallContext.buyer_requirements || {},
    freshness: preCallContext.freshness || {},
    source_provenance: sourceProvenance,
    limitations: preCallContext.limitations || service.limitations || []
  };
  const recentEvidence = detail.recent_evidence_events || [];
  const recentQuality = detail.recent_quality_events || [];
  const latestEvidence = recentEvidence.at(-1) || null;
  const latestQuality = recentQuality.at(-1) || null;
  const title = service.display_title || service.title || manifest.title || serviceId;
  const rawJsonHref = `/agent-router/service?service_id=${encodeURIComponent(serviceId)}&format=json`;
  const invokeExample = {
    service_id: serviceId,
    input: sampleRequest,
    budget: {
      max_amount: price.amount || service.price || "0.05",
      currency: price.currency || service.currency || "USDC"
    }
  };
  return page({
    title: `${title} · AgentRouter`,
    auth,
    body: `
      <main class="shell wide-shell detail-page">
        <section class="detail-hero">
          <div>
            <span class="eyebrow">Service capability</span>
            <h1>${html(title)}</h1>
            <p class="lead">${html(manifest.description_for_agent || service.description_for_agent || "Agent-callable data service with verified provider response.")}</p>
            <div class="detail-actions">
              <a class="button primary" href="/agent?q=${encodeURIComponent(serviceId)}">Open in service hub</a>
              <a class="button ghost" href="${html(rawJsonHref)}">Raw JSON</a>
              <a class="button ghost" href="/studio?service_id=${encodeURIComponent(serviceId)}">Provider edit</a>
            </div>
          </div>
          <aside class="detail-summary-card">
            <div><span>Service ID</span><strong>${html(serviceId)}</strong></div>
            <div><span>Provider</span><strong>${html(service.provider_id || manifest.provider?.provider_id || "provider")}</strong></div>
            <div><span>Price</span><strong>${html(price.amount || service.price || "0.00")} ${html(price.currency || service.currency || "USDC")}/call</strong></div>
            <div><span>Status</span><strong>${html(service.verification_status || "unknown")}</strong></div>
          </aside>
        </section>

        <section class="detail-metrics" aria-label="Service quality summary">
          <div><span>Price</span><strong>${html(price.amount || service.price || "0.00")} ${html(price.currency || service.currency || "USDC")}</strong><small>Per call</small></div>
          <div><span>Service calls</span><strong>${html(trust.operational_feedback_count ?? service.total_calls ?? 0)}</strong><small>Observed demand</small></div>
          <div><span>Success rate</span><strong>${html(formatPercent(trust.success_rate))}</strong><small>Runtime feedback</small></div>
          <div><span>Trust score</span><strong>${html(formatScore(trust.trust_score))}</strong><small>Verification + feedback</small></div>
          <div><span>Health</span><strong>${html(health.status || service.health_status || "unknown")}</strong><small>${html(health.last_validation_at || "No validation time")}</small></div>
        </section>

        <section class="detail-grid">
          <article class="detail-panel">
            <div class="panel-head">
              <span class="eyebrow">What agents can use</span>
              <h2>Capability contract</h2>
            </div>
            <div class="detail-kv">
              <div>Endpoint</div><div>${html(endpoint.method || "POST")} ${html(endpoint.url || service.endpoint_url || "-")}</div>
              <div>Input</div><div>${html(Object.keys(sampleRequest).join(", ") || "no input")}</div>
              <div>Output</div><div>${html(outputSummary(manifest.output_schema, resultPreview))}</div>
              <div>Best for</div><div>${html(capabilities.slice(0, 10).join(", ") || "data service")}</div>
            </div>
            <h3>Example request shape</h3>
            <pre class="code-block">${html(JSON.stringify(sampleRequest, null, 2))}</pre>
            <h3>Request schema</h3>
            <pre class="code-block">${html(JSON.stringify(manifest.input_schema || requestData || {}, null, 2))}</pre>
            <h3>Response schema</h3>
            <pre class="code-block">${html(JSON.stringify(manifest.output_schema || responseData || {}, null, 2))}</pre>
          </article>

          <article class="detail-panel validation-panel">
            <div class="panel-head">
              <span class="eyebrow">Validation sample</span>
              <h2>Last provider check</h2>
            </div>
            <div class="notice-box">
              <strong>This is not a live buyer query result.</strong>
              <span>${html(detail.data_context?.explanation || "This preview is the latest validation sample returned by the provider for the sample request.")}</span>
            </div>
            <div class="detail-kv">
              <div>Validation</div><div>${validation.ok ? "passed" : "failed or not run"}</div>
              <div>HTTP status</div><div>${html(validation.status || "-")}</div>
              <div>Created</div><div>${html(validation.created_at || "-")}</div>
              <div>Preview role</div><div>latest_validation_sample</div>
            </div>
            <h3>Validation response preview</h3>
            <pre class="code-block tall">${html(JSON.stringify(resultPreview || {}, null, 2))}</pre>
          </article>
        </section>

        <section class="detail-panel invoke-panel">
          <div class="panel-head">
            <span class="eyebrow">For buyer agents</span>
            <h2>Invoke with task-specific input</h2>
          </div>
          <p class="detail-note">AgentRouter should replace the sample values with the buyer task's actual parameters, then route, quote, invoke, verify, and request feedback.</p>
          <pre class="code-block">${html(JSON.stringify(invokeExample, null, 2))}</pre>
        </section>

        <section class="detail-panel invoke-panel">
          <div class="panel-head">
            <span class="eyebrow">Routing and quality</span>
            <h2>Routing signals</h2>
          </div>
          <p class="detail-note">Selection hints describe when this service should be considered before any paid invocation. They are used for routing, quote explanation, and post-call quality comparison.</p>
          <div class="detail-kv">
            <div>Primary capability</div><div>${html(capabilities[0] || service.capability || "data_service")}</div>
            <div>Routing tags</div><div>${html(selectionHints.routing_tags.slice(0, 12).join(", ") || "none")}</div>
            <div>Input fields</div><div>${html(selectionHints.input_fields.join(", ") || "no input")}</div>
            <div>Buyer setup</div><div>${preCallContext.buyer_requirements?.needs_buyer_api_key ? "buyer key required" : "no buyer API key required"}</div>
            <div>Source level</div><div>${html(sourceProvenance.source_provenance_level || "provider_supplied")}</div>
          </div>
          <h3>Selection hints</h3>
          <pre class="code-block">${html(JSON.stringify(selectionHints, null, 2))}</pre>
        </section>

        <section class="detail-panel invoke-panel">
          <div class="panel-head">
            <span class="eyebrow">Evidence and feedback</span>
            <h2>Evidence traces</h2>
          </div>
          <div class="detail-kv">
            <div>Trace count</div><div>${html(recentEvidence.length)}</div>
            <div>Latest trace</div><div>${html(latestEvidence?.trace_hash || "No paid-call evidence recorded yet")}</div>
            <div>Latest payment</div><div>${html(latestEvidence?.payment_tx || "No payment tx recorded yet")}</div>
            <div>Quality status</div><div>${html(latestQuality?.status || "No quality event yet")}</div>
          </div>
          <pre class="code-block">${html(JSON.stringify({
            evidence_profile: latestEvidence?.evidence_profile || service.quality_profile?.result_contract || null,
            latest_verification: latestEvidence?.verification_report || service.quality_profile?.latest_verification || null,
            latest_quality_event: latestQuality ? {
              status: latestQuality.status,
              blocking_issues: latestQuality.blocking_issues || [],
              consumer_feedback_expected: latestQuality.consumer_feedback_expected
            } : null
          }, null, 2))}</pre>
        </section>
      </main>
    `
  });
}

export function accountHtml({ auth = {} } = {}) {
  return page({
    title: "Dashboard · AgentRouter",
    auth,
    body: `
      <style>
        .ar-dashboard { --dash-bg:var(--color-bg); --dash-panel:var(--color-panel); --dash-panel-2:#fff; --dash-line:var(--color-line); --dash-text:var(--color-ink); --dash-muted:var(--color-muted); --dash-accent:var(--color-accent); --dash-blue:var(--color-accent-cool); display:grid; grid-template-columns:232px minmax(0,1fr); min-height:calc(100vh - 69px); }
        .dash-sidebar { border-right:1px solid var(--dash-line); padding:28px 16px; background:#091411; }
        .dash-workspace { display:flex; align-items:center; justify-content:space-between; padding:12px 13px; border:1px solid var(--dash-line); border-radius:8px; color:var(--dash-text); font-size:13px; font-weight:740; }
        .dash-workspace small { color:var(--dash-accent); font-weight:800; }
        .dash-nav { display:grid; gap:4px; margin-top:24px; }.dash-nav-label { margin:19px 10px 7px; color:#6f827a; font-size:10px; font-weight:850; letter-spacing:.11em; text-transform:uppercase; }
        .dash-nav button { width:100%; border:0; border-radius:7px; padding:10px 11px; background:transparent; color:#aebbb5; text-align:left; cursor:pointer; font:inherit; font-size:14px; transition:background .15s,color .15s; }
        .dash-nav button:hover, .dash-nav button[aria-selected="true"] { background:#173126; color:var(--dash-accent); }.dash-nav button span { display:inline-block; width:26px; color:#789086; }
        .dash-main { min-width:0; padding:34px clamp(20px,4vw,58px) 62px; }.dash-page-head { display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:30px; }
        .dash-kicker { color:var(--dash-accent); font-size:11px; font-weight:850; letter-spacing:.12em; text-transform:uppercase; }.dash-page-head h1 { margin:7px 0 7px; color:var(--dash-text); font-size:30px; letter-spacing:-.04em; }.dash-page-head p { margin:0; color:var(--dash-muted); max-width:680px; line-height:1.55; }
        .dash-user { display:flex; align-items:center; gap:10px; color:var(--dash-muted); font-size:13px; white-space:nowrap; }.dash-avatar { width:30px; height:30px; display:grid; place-items:center; border-radius:50%; background:#183228; color:var(--dash-accent); font-weight:850; }
        .dash-panel { border:1px solid var(--dash-line); border-radius:10px; background:var(--dash-panel); }.dash-notice { display:flex; justify-content:space-between; gap:16px; margin-bottom:26px; padding:16px 18px; border:1px solid #1c4c47; border-radius:9px; background:#0b2021; color:#c9ded7; font-size:14px; line-height:1.45; }.dash-notice b { color:#edfdf4; }.dash-notice a { color:var(--dash-accent); text-decoration:underline; }
        .dash-metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:12px; }.dash-metric { min-height:156px; padding:20px; position:relative; overflow:hidden; }.dash-metric::after { content:""; position:absolute; width:78px; height:78px; right:-24px; bottom:-30px; border:1px solid #2d5a4c; border-radius:50%; }.dash-metric span { color:var(--dash-muted); font-size:12px; }.dash-metric strong { display:block; margin-top:18px; color:var(--dash-text); font-size:31px; letter-spacing:-.05em; }.dash-metric small { display:block; margin-top:7px; color:#709386; font-size:12px; }.dash-metric.accent strong { color:var(--dash-accent); }
        .dash-grid { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(280px,.8fr); gap:14px; margin-top:14px; }.dash-card { padding:22px; }.dash-card-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:18px; }.dash-card h2 { margin:0; color:var(--dash-text); font-size:16px; }.dash-card p { color:var(--dash-muted); line-height:1.5; }.dash-link { border:0; background:transparent; color:var(--dash-accent); padding:0; cursor:pointer; font:inherit; font-size:13px; }
        .dash-activity { display:grid; }.dash-row { display:grid; grid-template-columns:minmax(130px,1fr) minmax(110px,.75fr) 92px 145px; gap:14px; align-items:center; padding:13px 0; border-top:1px solid var(--dash-line); font-size:13px; }.dash-row:first-child { border-top:0; }.dash-row strong { color:var(--dash-text); font-weight:650; }.dash-row small { display:block; margin-top:3px; color:#74877f; }.dash-credit { color:var(--dash-accent); }.dash-debit { color:#ffbb7a; }.dash-empty { padding:24px 0; color:var(--dash-muted); font-size:14px; }
        .dash-services { display:grid; gap:14px; }.dash-service { display:grid; gap:7px; }.dash-service-top { display:flex; justify-content:space-between; gap:12px; color:#dcebe2; font-size:13px; }.dash-service-bar { height:7px; overflow:hidden; border-radius:99px; background:#1b302a; }.dash-service-bar i { display:block; height:100%; border-radius:inherit; background:linear-gradient(90deg,#5cb2f5,#83f7c0); }
        .dash-actions { display:grid; gap:10px; }.dash-action { display:flex; align-items:center; gap:13px; padding:14px; border:1px solid var(--dash-line); border-radius:8px; color:#d5e4dc; }.dash-action b { display:block; color:var(--dash-text); font-size:13px; }.dash-action small { display:block; margin-top:3px; color:var(--dash-muted); font-size:12px; line-height:1.35; }.dash-action i { color:var(--dash-accent); font-style:normal; font-size:20px; }
        .dash-view[hidden] { display:none; }.dash-section { margin-top:14px; }.dash-form { display:grid; gap:13px; }.dash-form label { color:#c1d0c8; font-size:12px; font-weight:750; }.dash-form-row { display:flex; gap:10px; }.dash-form input { min-width:0; flex:1; border:1px solid #365146; border-radius:7px; background:#081210; color:var(--dash-text); padding:12px 13px; outline:0; }.dash-form input:focus { border-color:var(--dash-accent); box-shadow:0 0 0 3px rgba(131,247,192,.11); }.dash-button { border:1px solid var(--dash-accent); border-radius:7px; background:var(--dash-accent); color:#07120d; padding:0 15px; font:inherit; font-size:12px; font-weight:850; cursor:pointer; white-space:nowrap; }.dash-button:disabled { cursor:wait; opacity:.65; }.dash-button.secondary { background:transparent; color:var(--dash-accent); }.dash-status { margin:14px 0 0; min-height:20px; color:var(--dash-muted); font-size:13px; }.dash-status.error { color:#ffaaa2; }.dash-key-result { display:grid; gap:10px; margin-top:16px; padding:15px; border:1px solid #33715c; border-radius:8px; background:#10251e; color:#d8eee2; }.dash-key-result code { overflow-wrap:anywhere; color:#b4ffd7; font:12px var(--font-mono); }
        .dash-key-table { width:100%; border-collapse:collapse; }.dash-key-table th, .dash-key-table td { padding:13px 10px; border-bottom:1px solid var(--dash-line); color:#aebeb6; text-align:left; font-size:13px; }.dash-key-table th { color:#708279; font-size:11px; letter-spacing:.07em; text-transform:uppercase; }.dash-key-table td:first-child { color:var(--dash-text); font-weight:650; }.dash-badge { display:inline-flex; padding:4px 7px; border-radius:99px; background:#173126; color:var(--dash-accent); font-size:11px; font-weight:800; }
        /* Dashboard intentionally reuses the public site's visual tokens. */
        .ar-dashboard { background:var(--dash-bg); }.dash-sidebar { background:var(--color-panel); }.dash-workspace, .dash-panel, .dash-notice, .dash-action, .dash-form input, .dash-key-result { border-radius:0; }.dash-workspace { background:#fff; }.dash-workspace small { color:var(--dash-text); }.dash-nav-label { color:var(--dash-muted); }.dash-nav button { border-radius:0; color:var(--dash-muted); }.dash-nav button:hover, .dash-nav button[aria-selected="true"] { background:var(--color-accent); color:var(--color-accent-ink); }.dash-nav button span { color:inherit; }.dash-avatar { background:var(--color-accent-cool); color:var(--dash-text); }.dash-notice { border-color:var(--dash-line); background:var(--color-soft); color:var(--dash-text); }.dash-notice b, .dash-notice a { color:var(--dash-text); }.dash-metric::after { border-color:var(--dash-line); }.dash-metric small, .dash-row small { color:var(--dash-muted); }.dash-metric.accent strong { color:var(--dash-text); }.dash-card p, .dash-service-top, .dash-action, .dash-form label, .dash-key-table th, .dash-key-table td { color:var(--dash-muted); }.dash-row strong, .dash-service-top, .dash-action b, .dash-key-table td:first-child { color:var(--dash-text); }.dash-credit { color:#19733a; }.dash-debit, .dash-status.error { color:#9b401b; }.dash-service-bar { background:var(--color-soft); border-radius:0; }.dash-service-bar i { border-radius:0; background:var(--color-accent); }.dash-action { background:#fff; }.dash-action:hover { border-color:var(--color-strong-line); background:var(--color-soft); }.dash-action i { color:var(--dash-text); }.dash-form input { border-color:var(--dash-line); background:#fff; color:var(--dash-text); }.dash-form input:focus { border-color:var(--color-strong-line); box-shadow:none; }.dash-button { border:2px solid var(--dash-text); border-radius:0; background:var(--color-accent); color:var(--color-accent-ink); }.dash-button.secondary { background:#fff; color:var(--dash-text); }.dash-key-result { border-color:var(--dash-line); background:var(--color-soft); color:var(--dash-text); }.dash-key-result code { color:var(--dash-text); }.dash-badge { border-radius:0; background:var(--color-accent); color:var(--color-accent-ink); }
        @media (max-width:960px) { .ar-dashboard { grid-template-columns:1fr; }.dash-sidebar { display:none; }.dash-metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }.dash-grid { grid-template-columns:1fr; } }
        @media (max-width:620px) { .dash-main { padding:26px 16px 42px; }.dash-page-head { display:block; }.dash-user { margin-top:15px; }.dash-metrics { grid-template-columns:1fr; }.dash-row { grid-template-columns:1fr 1fr; }.dash-row > :last-child { display:none; }.dash-form-row { display:grid; }.dash-button { min-height:42px; }.topbar .shell { padding:0 16px; } }
      </style>
      <main class="ar-dashboard">
        <aside class="dash-sidebar">
          <div class="dash-workspace"><span>Personal workspace</span><small>● LIVE</small></div>
          <nav class="dash-nav" aria-label="Dashboard navigation">
            <span class="dash-nav-label">Workspace</span>
            <button type="button" data-view="overview" aria-selected="true"><span>▦</span>Overview</button>
            <button type="button" data-view="keys"><span>⌘</span>Connections</button>
            <button type="button" data-view="activity"><span>≡</span>Activity</button>
            <button type="button" data-view="credits"><span>◒</span>Credits</button>
            <span class="dash-nav-label">Network</span>
            <a class="dash-action" href="/research"><i>↗</i><span><b>Research sources</b><small>Connect API and local browser sources</small></span></a>
            <a class="dash-action" href="/agent"><i>↗</i><span><b>Service catalog</b><small>Explore routed capabilities</small></span></a>
          </nav>
        </aside>
        <section class="dash-main">
          <header class="dash-page-head">
            <div><span class="dash-kicker">AgentRouter dashboard</span><h1 id="dash-title">Overview</h1><p id="dash-subtitle">Your prepaid balance, agent credentials, and verified service activity in one place.</p></div>
            <div class="dash-user"><span class="dash-avatar">AR</span><span>${html(auth.user?.name || auth.user?.email || "Personal account")}</span></div>
          </header>
          <div class="dash-notice"><span><b>One balance, every verified service.</b> Calls are charged only after request validation; provider failures are refunded automatically.</span><a href="/agent">Browse services →</a></div>

          <section class="dash-view" data-panel="overview">
            <div class="dash-metrics">
              <article class="dash-panel dash-metric accent"><span>Available credits</span><strong id="metric-balance">--</strong><small>Ready for agent calls</small></article>
              <article class="dash-panel dash-metric"><span>30 day spend</span><strong id="metric-spend">--</strong><small>Only completed paid calls</small></article>
              <article class="dash-panel dash-metric"><span>Paid calls</span><strong id="metric-calls">--</strong><small>Last 30 days</small></article>
              <article class="dash-panel dash-metric"><span>Connected agents</span><strong id="metric-keys">--</strong><small>Approved through your browser</small></article>
            </div>
            <div class="dash-grid">
              <article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Recent account activity</h2><p>Credits added and successful service calls.</p></div><button class="dash-link" type="button" data-view-link="activity">View all →</button></div><div class="dash-activity" id="overview-activity"></div></article>
              <aside class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Quick actions</h2><p>Get an agent ready in minutes.</p></div></div><div class="dash-actions"><button class="dash-action" type="button" data-view-link="keys"><i>⌘</i><span><b>Connect an agent</b><small>Install once; approve it in your browser on the first paid call.</small></span></button><button class="dash-action" type="button" data-view-link="credits"><i>＋</i><span><b>Add credits</b><small>Secure checkout, applied after confirmation.</small></span></button><a class="dash-action" href="/agent"><i>↗</i><span><b>Install AgentRouter</b><small>Connect your agent to the hosted router.</small></span></a></div></aside>
            </div>
            <div class="dash-grid"><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Top services by spend</h2><p>Derived from your own service-call ledger.</p></div></div><div class="dash-services" id="top-services"></div></article><aside class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Routing safeguards</h2><p>Every call is bounded by your policy.</p></div></div><div class="dash-actions"><div class="dash-action"><i>✓</i><span><b>Server-side credentials</b><small>Provider API keys remain private to AgentRouter.</small></span></div><div class="dash-action"><i>✓</i><span><b>Payment precision</b><small>Credit ledger uses six decimal places.</small></span></div></div></aside></div>
          </section>

          <section class="dash-view" data-panel="keys" hidden><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Connected agents</h2><p>No API key needs to be copied into an MCP configuration. On the first paid call, AgentRouter opens a short browser approval flow and stores the connection privately on your device.</p></div><a class="dash-link" href="/agent">Install AgentRouter →</a></div><div id="agent-connection-list"></div></article><div class="dash-grid dash-section"><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Developer API keys</h2><p>Advanced fallback for CI and headless servers that cannot open a browser.</p></div></div><form class="dash-form" id="api-key-form"><label for="api-key-label">Client label</label><div class="dash-form-row"><input id="api-key-label" name="label" value="CI server" maxlength="120"><button class="dash-button" type="submit">Create key</button></div></form><div class="dash-key-result" id="api-key-result" hidden><b>Copy this key now. It will not be shown again.</b><code id="api-key-value"></code><button class="dash-button secondary" id="copy-api-key" type="button">Copy key</button><small>Use this only for CI or a headless server. Never paste it into a chat.</small></div></article><aside class="dash-panel dash-card"><h2>Security model</h2><p>Browser-approved connections can use only this account's prepaid balance. They never expose GitHub credentials or provider API keys and can be disconnected at any time.</p></aside></div><article class="dash-panel dash-card dash-section"><div class="dash-card-head"><div><h2>Developer API keys</h2><p>Secrets are intentionally never listed or recoverable.</p></div></div><div id="api-key-list"></div></article></section>

          <section class="dash-view" data-panel="activity" hidden><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Account activity</h2><p>Top-ups and billable service calls from your account ledger.</p></div></div><div class="dash-activity" id="activity-list"></div></article></section>

          <section class="dash-view" data-panel="credits" hidden><div class="dash-grid"><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Add credits</h2><p>Production payments use Stripe Checkout. Credits appear after its signed confirmation.</p></div></div><form class="dash-form" id="topup-form"><label for="topup-amount">Amount in USD / credits</label><div class="dash-form-row"><input id="topup-amount" name="amount" type="number" min="0.5" max="10000" step="0.01" value="10.00" required><button class="dash-button" id="topup-button" type="submit">Continue to payment</button></div></form><p class="dash-status" id="account-status" role="status"></p></article><aside class="dash-panel dash-card"><h2>Billing model</h2><p>AgentRouter debits after validation and before data delivery. Failed provider calls are automatically refunded.</p><p>Need help with a payment? The error shown here includes the exact next step.</p></aside></div><article class="dash-panel dash-card dash-section"><div class="dash-card-head"><div><h2>Credit ledger</h2><p>Immutable record of credits added and used.</p></div></div><div class="dash-activity" id="credit-ledger"></div></article></section>
        </section>
      </main>
      <script>
        const dashboardState = { data: null };
        const viewMeta = { overview:["Overview","Your prepaid balance, agent connections, and verified service activity in one place."], keys:["Connections","Approve agents in your browser and disconnect them here. Developer keys remain available for CI."], activity:["Activity","A transparent account ledger for credits and completed paid service calls."], credits:["Credits","Fund your balance through secure checkout and see every balance change."] };
        const money = (value) => Number(value || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 6 });
        const escapeDash = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[char]);
        function renderActivity(target, entries, limit = 12) {
          target.innerHTML = entries.slice(0, limit).map((entry) => '<div class="dash-row"><span><strong>' + escapeDash(entry.kind === "service_call" ? "Service call" : entry.kind) + '</strong><small>' + escapeDash(entry.service_id || "Account credit") + '</small></span><span class="' + (String(entry.delta).startsWith("-") ? "dash-debit" : "dash-credit") + '">' + escapeDash(entry.delta) + ' credits</span><span>Balance ' + escapeDash(entry.balance) + '</span><span><small>' + escapeDash(new Date(entry.created_at).toLocaleString()) + '</small></span></div>').join("") || '<div class="dash-empty">No account activity yet. Add credits, connect an agent, and make your first call.</div>';
        }
        function renderDashboard(payload) {
          dashboardState.data = payload;
          const summary = payload.summary;
          document.getElementById("metric-balance").textContent = money(summary.available_credits);
          document.getElementById("metric-spend").textContent = money(summary.spend_30d);
          document.getElementById("metric-calls").textContent = summary.successful_paid_calls;
          document.getElementById("metric-keys").textContent = summary.connected_agents;
          renderActivity(document.getElementById("overview-activity"), payload.recent_activity, 5);
          renderActivity(document.getElementById("activity-list"), payload.recent_activity);
          renderActivity(document.getElementById("credit-ledger"), payload.recent_activity);
          const connections = payload.api_keys.filter((key) => key.auth_method === "device");
          const developerKeys = payload.api_keys.filter((key) => key.auth_method !== "device");
          document.getElementById("agent-connection-list").innerHTML = connections.length ? '<table class="dash-key-table"><thead><tr><th>Agent</th><th>Status</th><th>Connected</th><th>Action</th></tr></thead><tbody>' + connections.map((key) => '<tr><td>' + escapeDash(key.client_name || key.label) + '</td><td><span class="dash-badge">' + escapeDash(key.status) + '</span></td><td>' + escapeDash(new Date(key.created_at).toLocaleDateString()) + '</td><td>' + (key.status === "active" ? '<button class="dash-link" type="button" data-revoke-key="' + escapeDash(key.key_id) + '">Disconnect</button>' : 'Disconnected') + '</td></tr>').join("") + '</tbody></table>' : '<div class="dash-empty">No agents connected yet. Install AgentRouter, then approve the browser prompt on the first paid call.</div>';
          document.getElementById("api-key-list").innerHTML = developerKeys.length ? '<table class="dash-key-table"><thead><tr><th>Label</th><th>Status</th><th>Created</th><th>Key ID</th></tr></thead><tbody>' + developerKeys.map((key) => '<tr><td>' + escapeDash(key.label) + '</td><td><span class="dash-badge">' + escapeDash(key.status) + '</span></td><td>' + escapeDash(new Date(key.created_at).toLocaleDateString()) + '</td><td>' + escapeDash(key.key_id) + '</td></tr>').join("") + '</tbody></table>' : '<div class="dash-empty">No developer API keys. Most users do not need one.</div>';
          const services = payload.top_services || [];
          const max = Math.max(...services.map((item) => item.spend_credits), 1);
          document.getElementById("top-services").innerHTML = services.length ? services.map((item) => '<div class="dash-service"><div class="dash-service-top"><span>' + escapeDash(item.service_id) + '</span><span>' + money(item.spend_credits) + ' credits</span></div><div class="dash-service-bar"><i style="width:' + Math.max(8, Math.round((item.spend_credits / max) * 100)) + '%"></i></div></div>').join("") : '<div class="dash-empty">Service usage will appear after your first successful paid call.</div>';
        }
        async function loadDashboard() { const response = await fetch("/account/dashboard"); const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || "Could not load your dashboard."); renderDashboard(payload); }
        function showView(name) { document.querySelectorAll(".dash-view").forEach((node) => { node.hidden = node.dataset.panel !== name; }); document.querySelectorAll("[data-view]").forEach((node) => node.setAttribute("aria-selected", String(node.dataset.view === name))); document.getElementById("dash-title").textContent = viewMeta[name][0]; document.getElementById("dash-subtitle").textContent = viewMeta[name][1]; }
        document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
        document.querySelectorAll("[data-view-link]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewLink)));
        document.getElementById("topup-form").addEventListener("submit", async (event) => { event.preventDefault(); const status = document.getElementById("account-status"); const button = document.getElementById("topup-button"); button.disabled = true; status.className = "dash-status"; status.textContent = "Creating secure checkout…"; try { const response = await fetch("/account/credits/topup", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ amount:document.getElementById("topup-amount").value }) }); const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || "Top-up failed."); if (payload.checkout_url) { location.href = payload.checkout_url; return; } status.textContent = "Credits added."; await loadDashboard(); } catch (error) { status.className = "dash-status error"; status.textContent = error.message; } finally { button.disabled = false; } });
        document.getElementById("api-key-form").addEventListener("submit", async (event) => { event.preventDefault(); const response = await fetch("/account/api-keys", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ label:document.getElementById("api-key-label").value }) }); const payload = await response.json(); if (!response.ok) { alert(payload.error?.message || "Key creation failed."); return; } document.getElementById("api-key-value").textContent = payload.api_key; document.getElementById("api-key-result").hidden = false; await loadDashboard(); });
        document.getElementById("copy-api-key").addEventListener("click", async () => { await navigator.clipboard.writeText(document.getElementById("api-key-value").textContent); document.getElementById("copy-api-key").textContent = "Copied"; });
        document.getElementById("agent-connection-list").addEventListener("click", async (event) => { const button = event.target.closest("[data-revoke-key]"); if (!button) return; button.disabled = true; const response = await fetch("/account/api-keys/" + encodeURIComponent(button.dataset.revokeKey) + "/revoke", { method:"POST" }); const payload = await response.json(); if (!response.ok) { alert(payload.error?.message || "Could not disconnect this agent."); button.disabled = false; return; } await loadDashboard(); });
        loadDashboard().catch((error) => { const status = document.getElementById("account-status"); status.className = "dash-status error"; status.textContent = error.message; });
      </script>
    `
  });
}

function appPage({ title, subtitle, active, auth = {}, showHeader = true, body }) {
  const sectionLabel = active === "human"
    ? "Provider workspace"
    : active === "account" ? "Account" : "Agent API hub";
  return page({
    title: `${title} · AgentRouter Markets`,
    auth,
    body: `
      ${showHeader ? `<header class="app-header">
        <div class="shell wide-shell app-title">
          <div>
            <span class="eyebrow">${html(sectionLabel)}</span>
            <h1>${html(title)}</h1>
            <p class="lead">${html(subtitle)}</p>
          </div>
          <nav class="section-nav" aria-label="Section">
            <a class="${active === "human" ? "active" : ""}" href="/human">For human</a>
            <a class="${active === "agent" ? "active" : ""}" href="/agent">For agent</a>
          </nav>
        </div>
      </header>` : ""}
      ${body}
    `
  });
}

function page({ title, auth = {}, body }) {
  const user = auth.user || null;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${html(title)}</title>
  ${faviconLinks()}
  <style data-agentrouter-page-style>${styles()}${authModalStyles()}</style>
</head>
<body data-agentrouter-app>
  <div class="topbar">
    <div class="shell nav">
      <a class="brand" href="/" aria-label="AgentRouter home">${brandLogo()}</a>
      <nav class="nav-links" aria-label="Primary">
        <a href="/">Home</a>
        <a href="/research">Research</a>
        <a href="/agent">Services</a>
        <a href="/human">Provider Studio</a>
      </nav>
      ${user ? `<div class="auth-actions">
        <a class="auth-link signed-in" href="/account">${html(user.name || user.email || "Account")}</a>
        <a class="logout-link" href="/auth/logout">Sign out</a>
      </div>` : '<a class="auth-link" href="?login=1" data-auth-modal-trigger>LOGIN</a>'}
    </div>
  </div>
  ${body}
  <footer class="footer">
    <div class="shell">AgentRouter Markets · <a href="/research">Creator Research</a> · <a href="/human">For human</a> · <a href="/agent">For agent</a> · <a href="/studio">Provider Studio</a></div>
  </footer>
  ${authModalHtml({ auth, returnTo: auth.loginReturnTo || "/" })}
  <script data-agentrouter-spa>${clientRouterScript()}</script>
</body>
</html>`;
}

// Kept only as source archaeology while the new page shell is rolled out. It is not emitted.
function legacyStyles() {
  return `
    /* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 */
    :root {
      color-scheme: light;
      --color-ink:#202124;
      --color-muted:#696f72;
      --color-faint:#9aa0a6;
      --color-line:#dedede;
      --color-strong-line:#c9ced1;
      --color-panel:#f6f7f5;
      --color-bg:#ffffff;
      --color-soft:#eef2ef;
      --color-code:#151917;
      --color-accent:#5cff73;
      --color-accent-warm:#ffd66b;
      --color-accent-cool:#dffcff;
      --color-accent-ink:#0b240f;
      --shadow-lift:0 14px 34px rgba(23, 28, 25, .08);
      --font-body:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { overflow-x: clip; }
    body { margin:0; font-family:var(--font-body); background:var(--color-bg); color:var(--color-ink); }
    a { color:inherit; text-decoration:none; }
    button, input, select { font:inherit; }
    .shell { max-width:1160px; margin:0 auto; padding:0 24px; }
    .wide-shell { max-width:1520px; }
    .topbar { position:sticky; top:0; z-index:20; border-top:3px solid var(--color-accent-cool); border-bottom:1px solid var(--color-line); background:rgba(255,255,255,.98); backdrop-filter:blur(10px); }
    .topbar .shell { max-width:none; padding:0 32px; }
    .nav { min-height:68px; display:grid; grid-template-columns:minmax(190px, 1fr) auto minmax(190px, 1fr); align-items:center; gap:28px; }
    .brand { display:inline-flex; align-items:center; justify-self:start; gap:12px; min-height:42px; color:var(--color-ink); }
    .brand-icon { width:42px; height:36px; display:inline-flex; align-items:center; justify-content:center; overflow:hidden; flex:0 0 auto; }
    .brand-icon img { width:40px; height:34px; object-fit:contain; display:block; }
    .brand-word { font-size:21px; font-weight:850; line-height:1; letter-spacing:0; }
    .hero-search input:focus, .search-row input:focus, .search-row select:focus { border-color:var(--color-faint); background:#fff; }
    .nav-links { display:flex; align-items:center; justify-content:center; gap:32px; color:#636867; font-size:16px; font-weight:620; white-space:nowrap; text-transform:none; }
    .nav-links a { display:inline-flex; align-items:center; min-height:38px; border-bottom:2px solid transparent; }
    .nav-links a:hover, .nav-links a:focus-visible { color:var(--color-ink); border-bottom-color:var(--color-accent-cool); outline:0; }
    .auth-actions { justify-self:end; display:flex; align-items:center; gap:12px; min-width:0; }
    .auth-link { justify-self:end; min-height:42px; display:inline-flex; align-items:center; justify-content:center; border:1px solid var(--color-line); border-radius:14px; padding:0 22px; background:#fff; color:var(--color-ink); font-size:14px; font-weight:800; text-transform:uppercase; }
    .auth-link:hover, .auth-link:focus-visible { border-color:var(--color-strong-line); background:#fbfbfb; outline:0; }
    .auth-link.signed-in { max-width:190px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; text-transform:none; }
    .logout-link { color:var(--color-muted); font-size:12px; font-weight:800; text-transform:uppercase; white-space:nowrap; }
    .logout-link:hover, .logout-link:focus-visible { color:var(--color-ink); outline:0; text-decoration:underline; }
    .button { display:inline-flex; align-items:center; justify-content:center; min-height:40px; border:2px solid var(--color-ink); border-radius:0; background:#fff; color:var(--color-ink); padding:9px 16px; font-weight:760; cursor:pointer; text-transform:uppercase; font-size:12px; letter-spacing:0; }
    .button::before, .path-action::before { content:">"; margin-right:10px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .button.primary { background:var(--color-accent); border-color:var(--color-accent); color:var(--color-accent-ink); }
    .button.ghost { background:#fff; }
    .hero { padding:0 0 30px; min-height:calc(100vh - 68px); }
    .dot-grid { height:96px; border-bottom:1px solid #ededed; background-image:radial-gradient(#9c9c9c .8px, transparent .8px); background-size:12px 12px; background-position:0 3px; }
    .hero-center { text-align:center; padding-top:58px; display:grid; justify-items:center; }
    .eyebrow { display:inline-flex; color:var(--color-muted); font-size:12px; font-weight:760; text-transform:uppercase; letter-spacing:0; }
    h1 { margin:12px 0 12px; font-size:52px; line-height:1.04; font-weight:720; letter-spacing:0; overflow-wrap:anywhere; }
    .lead { margin:0; color:var(--color-muted); font-size:17px; line-height:1.58; max-width:760px; }
    .hero-cta { min-height:44px; margin-top:24px; display:inline-flex; align-items:center; justify-content:center; border:2px solid var(--color-ink); border-radius:0; background:#fff; color:var(--color-ink); padding:0 20px; font-size:12px; font-weight:800; text-transform:uppercase; }
    .hero-cta::before { content:">"; margin-right:10px; font-family:var(--font-mono); }
    .hero-cta:hover, .hero-cta:focus-visible { background:var(--color-accent); border-color:var(--color-accent); color:var(--color-accent-ink); outline:0; }
    .install-strip { width:min(900px, 100%); margin-top:44px; border:1px solid #303236; border-radius:16px; background:#0e0f11; color:#f7f7f7; text-align:left; overflow:hidden; box-shadow:0 18px 42px rgba(20, 24, 26, .14); }
    .install-top { min-height:46px; border-bottom:1px solid #2a2c30; display:flex; align-items:center; justify-content:space-between; gap:18px; padding:0 24px; }
    .status-dots { display:flex; align-items:center; gap:10px; }
    .status-dots i { display:block; width:11px; height:11px; border-radius:50%; }
    .status-dots i:nth-child(1) { background:#ff5f57; }
    .status-dots i:nth-child(2) { background:#ffbd2e; }
    .status-dots i:nth-child(3) { background:#28c840; }
    .install-label { color:#8c8f96; font-family:var(--font-mono); font-size:15px; font-weight:520; }
    .install-command { min-width:0; min-height:82px; display:grid; grid-template-columns:minmax(0, 1fr) 82px; align-items:center; gap:16px; padding:0 24px 0 30px; }
    .install-strip code { display:block; min-width:0; color:#f5f5f5; font-family:var(--font-mono); font-size:18px; line-height:1.25; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .install-strip .prompt { color:#ff2da1; margin-right:12px; }
    .install-strip button { min-height:36px; border:1px solid #3d4045; border-radius:8px; background:#15171a; color:#f4f4f5; cursor:pointer; font-weight:800; text-transform:uppercase; font-size:11px; }
    .install-strip button:hover { border-color:#666a70; background:#1f2226; }
    .install-note { margin:16px 0 0; color:#7b7f86; font-size:15px; line-height:1.4; }
    .client-row { width:min(760px, 100%); margin-top:18px; display:flex; align-items:flex-start; justify-content:center; gap:16px; color:#7b7f86; font-size:14px; }
    .client-row > span { min-height:38px; display:inline-flex; align-items:center; white-space:nowrap; }
    .client-logos { min-width:0; display:flex; align-items:flex-start; justify-content:center; flex-wrap:wrap; gap:8px; padding-bottom:26px; }
    .client-logo { position:relative; width:38px; height:38px; display:inline-flex; align-items:center; justify-content:center; border:1px solid #ececec; border-radius:12px; background:#fbfbfb; box-shadow:0 8px 20px rgba(25, 28, 31, 0); transition:transform 150ms ease, border-color 150ms ease, background 150ms ease, box-shadow 150ms ease; outline:0; }
    .client-logo img { width:28px; height:28px; object-fit:contain; filter:grayscale(1); opacity:.7; transition:filter 150ms ease, opacity 150ms ease; }
    .client-logo span { position:absolute; left:50%; top:calc(100% + 10px); transform:translate(-50%, -4px); max-width:120px; color:#5f6468; font-size:13px; font-weight:740; white-space:nowrap; opacity:0; pointer-events:none; transition:opacity 150ms ease, transform 150ms ease; }
    .client-logo:hover, .client-logo:focus-visible { z-index:3; transform:translateY(-7px) scale(1.2); border-color:#dedede; background:#fff; box-shadow:0 18px 34px rgba(25, 28, 31, .12); }
    .client-logo:hover img, .client-logo:focus-visible img { filter:none; opacity:1; }
    .client-logo:hover span, .client-logo:focus-visible span { opacity:1; transform:translate(-50%, 0); }
    .hero-paths { width:100%; display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:28px; margin-top:48px; text-align:left; }
    .hero-search { width:min(680px, 100%); margin-top:58px; display:grid; grid-template-columns:minmax(0,1fr) 124px; }
    .hero-search input { min-height:64px; border:2px solid var(--color-line); background:#fafafa; color:var(--color-ink); padding:0 20px; font-size:18px; outline:none; border-radius:0; min-width:0; }
    .hero-search button { border:2px solid var(--color-ink); border-left:0; background:#fff; color:var(--color-ink); font-weight:760; text-transform:uppercase; font-size:12px; cursor:pointer; }
    .hero-actions, .actions { display:flex; flex-wrap:wrap; gap:9px; margin-top:14px; }
    main { padding:0 0 42px; }
    .home-panel { width:min(720px, 100%); margin-top:34px; text-align:left; }
    .home-panel, .card { border:1px solid var(--color-line); border-radius:0; background:var(--color-panel); padding:20px; }
    .metrics { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:0; margin-top:14px; border:1px solid var(--color-line); background:#fff; }
    .metric { border-right:1px solid var(--color-line); background:#fff; padding:16px; min-width:0; }
    .metric:last-child { border-right:0; }
    .metric strong { display:block; font-size:27px; line-height:1; font-weight:720; }
    .metric span { display:block; margin-top:8px; color:var(--color-muted); font-size:11px; font-weight:760; text-transform:uppercase; }
    .landing-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; margin-bottom:18px; }
    .path-card { border:1px solid var(--color-line); border-radius:0; background:var(--color-panel); padding:34px 30px 28px; min-height:268px; display:flex; flex-direction:column; justify-content:space-between; transition:border-color 140ms ease, background 140ms ease, transform 140ms ease; }
    .path-card:hover { border-color:var(--color-strong-line); background:#fff; transform:translateY(-2px); box-shadow:var(--shadow-lift); }
    .path-card h2, .card h2 { margin:0 0 18px; font-size:22px; font-weight:650; letter-spacing:0; }
    .path-card p, .card p { margin:0; color:var(--color-muted); line-height:1.55; font-size:16px; }
    .path-label { display:inline-flex; width:max-content; color:var(--color-ink); font-size:12px; font-weight:760; text-transform:uppercase; }
    .path-action { display:inline-flex; width:max-content; border:2px solid var(--color-ink); background:#fff; color:var(--color-ink); font-weight:760; margin-top:28px; padding:12px 18px; font-size:12px; text-transform:uppercase; }
    .path-card:nth-child(3) .path-action { background:var(--color-accent); border-color:var(--color-accent); color:var(--color-accent-ink); }
    .stats-section { padding-top:92px; }
    .stats-heading { display:flex; align-items:start; justify-content:space-between; gap:24px; margin-bottom:56px; }
    .stats-heading h2 { margin:6px 0 10px; font-size:34px; font-weight:720; letter-spacing:0; }
    .stats-heading p { margin:0; color:var(--color-muted); font-size:18px; }
    .stats-grid { display:grid; grid-template-columns:repeat(4, minmax(0, 1fr)); gap:64px; margin-bottom:56px; }
    .stat-block { min-width:0; }
    .stat-block span { display:block; color:var(--color-muted); font-size:16px; margin-bottom:14px; }
    .stat-block strong { display:block; color:var(--color-ink); font-size:72px; line-height:.95; font-weight:650; letter-spacing:0; overflow-wrap:anywhere; }
    .stat-block small { display:block; color:var(--color-faint); font-size:13px; margin-top:8px; }
    .spark { height:118px; display:flex; align-items:end; gap:6px; margin-top:22px; overflow:hidden; }
    .spark i { display:block; width:5px; min-width:5px; background:#b7ffc0; border-radius:3px 3px 0 0; }
    .network-tables { display:grid; grid-template-columns:1fr 1fr; gap:72px; align-items:start; }
    .table-head { display:flex; align-items:baseline; justify-content:space-between; gap:16px; margin-bottom:16px; }
    .table-head h3 { margin:0; font-size:22px; font-weight:650; letter-spacing:0; }
    .table-head a { color:var(--color-muted); font-family:var(--font-mono); font-size:12px; text-transform:uppercase; text-decoration:underline; text-underline-offset:3px; }
    .service-table { border-top:1px solid var(--color-line); }
    .service-row { display:grid; grid-template-columns:minmax(0, 1.35fr) minmax(140px, .8fr) 82px; gap:22px; align-items:center; min-height:52px; border-bottom:1px solid var(--color-line); color:var(--color-muted); font-size:16px; }
    .service-row span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .service-row b { color:var(--color-ink); font-weight:520; margin-right:8px; }
    .service-row small { color:var(--color-muted); font-size:15px; }
    .service-row mark { border:1px solid var(--color-line); background:#fff; color:var(--color-ink); padding:4px 8px; font-family:var(--font-mono); font-size:11px; text-transform:uppercase; }
    .service-row span:last-child { color:var(--color-ink); font-weight:780; text-align:left; }
    .table-labels { min-height:36px; color:var(--color-faint); font-size:11px; font-family:var(--font-mono); text-transform:uppercase; }
    .empty-row { color:var(--color-muted); border-bottom:1px solid var(--color-line); padding:18px 0; }
    .overview-wrap { padding-top:78px; }
    .overview { display:grid; grid-template-columns:.9fr 1.1fr; gap:32px; align-items:center; margin-bottom:34px; border:1px solid var(--color-line); background:var(--color-panel); padding:34px; }
    .step-row { display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; }
    .step-row div { border:1px solid var(--color-line); border-radius:0; padding:12px; background:#fff; }
    .step-row b { display:block; color:#111; margin-bottom:8px; }
    .step-row span { color:var(--color-muted); font-size:13px; line-height:1.4; }
    .app-header { padding:0 0 22px; }
    .app-header::before { content:""; display:block; height:54px; margin-bottom:26px; border-bottom:1px solid #ededed; background-image:radial-gradient(#9c9c9c .8px, transparent .8px); background-size:12px 12px; }
    .app-title { display:flex; align-items:end; justify-content:space-between; gap:18px; }
    .app-title h1 { margin:6px 0 6px; font-size:36px; }
    .app-title .lead { font-size:16px; line-height:1.45; max-width:680px; }
    .section-nav { display:grid; grid-template-columns:1fr 1fr; gap:0; border:1px solid var(--color-line); background:#fff; min-width:320px; }
    .section-nav a { padding:13px 16px; color:var(--color-muted); font-weight:760; text-align:center; text-transform:uppercase; font-size:12px; border-right:1px solid var(--color-line); }
    .section-nav a:last-child { border-right:0; }
    .section-nav a.active { background:#222; color:#fff; }
    .agent-market, .provider-console { padding-top:14px; }
    .market-hero, .provider-hero { display:grid; grid-template-columns:minmax(0, 1fr) minmax(420px, .52fr); gap:28px; align-items:end; margin-bottom:26px; }
    .market-hero h2, .provider-hero h2 { margin:8px 0 10px; font-size:38px; line-height:1.08; letter-spacing:0; }
    .market-hero p, .provider-hero p, .market-section-head p { margin:0; color:var(--color-muted); font-size:17px; line-height:1.58; max-width:760px; }
    .compact-install { padding:18px; align-self:stretch; justify-content:center; }
    .market-toolbar, .provider-toolbar { display:grid; grid-template-columns:minmax(0, 1fr) 190px; gap:12px; margin-bottom:22px; }
    .market-toolbar input, .market-toolbar select, .provider-toolbar input, .provider-toolbar select { width:100%; min-height:52px; border:1px solid var(--color-line); border-radius:8px; background:#fff; color:var(--color-ink); padding:0 16px; outline:none; }
    .market-toolbar input:focus, .market-toolbar select:focus, .provider-toolbar input:focus, .provider-toolbar select:focus { border-color:var(--color-faint); box-shadow:0 0 0 3px rgba(223,252,255,.9); }
    .market-shell { display:grid; grid-template-columns:210px minmax(0, 1fr) 430px; gap:24px; align-items:start; }
    .market-shell.list-only { grid-template-columns:230px minmax(0, 1fr); }
    .filter-rail, .provider-rail { position:sticky; top:88px; border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:18px; display:grid; gap:16px; }
    .filter-rail > strong, .provider-rail > strong { font-size:13px; text-transform:uppercase; color:var(--color-muted); }
    .category-row.vertical { display:grid; gap:7px; }
    .category-row.vertical .category { width:100%; min-height:38px; text-align:left; border-radius:8px; }
    .rail-note { border-top:1px solid var(--color-line); padding-top:14px; display:grid; gap:8px; color:var(--color-muted); font-size:13px; line-height:1.35; }
    .rail-note strong { color:var(--color-ink); }
    .market-section-head { display:flex; align-items:end; justify-content:space-between; gap:16px; margin-bottom:16px; }
    .market-section-head h2 { margin:0 0 5px; font-size:28px; line-height:1.1; }
    .market-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:18px; }
    .empty-market { border:1px dashed var(--color-strong-line); border-radius:8px; padding:24px; color:var(--color-muted); background:#fff; }
    .pager { display:flex; justify-content:center; align-items:center; gap:14px; margin:28px 0 4px; }
    .pager button { border:2px solid var(--color-ink); background:#fff; color:var(--color-ink); min-height:44px; padding:0 18px; font-weight:800; border-radius:0; }
    .pager button:disabled { border-color:#d7ded8; color:#9aa59d; background:#f6f8f5; cursor:not-allowed; }
    .pager span { color:var(--color-muted); font-weight:700; min-width:80px; text-align:center; }
    .provider-hero { border:1px solid var(--color-line); border-radius:8px; background:var(--color-panel); padding:32px; }
    .provider-gate { min-height:310px; align-items:center; }
    .provider-actions { display:flex; flex-wrap:wrap; justify-content:flex-end; gap:10px; }
    .guest-provider-grid { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:16px; margin-top:22px; }
    .guest-provider-grid article { border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:24px; }
    .guest-provider-grid h3 { margin:10px 0 8px; font-size:24px; line-height:1.12; }
    .guest-provider-grid p { margin:0; color:var(--color-muted); line-height:1.55; }
    .provider-metrics { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:14px; margin-bottom:24px; }
    .provider-metric { border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:20px; min-width:0; }
    .provider-metric span { display:block; color:var(--color-muted); font-size:12px; font-weight:760; text-transform:uppercase; }
    .provider-metric strong { display:block; margin-top:10px; font-size:38px; line-height:1; font-weight:720; overflow-wrap:anywhere; }
    .provider-metric small { display:block; margin-top:10px; color:var(--color-faint); }
    .provider-imports { display:grid; grid-template-columns:minmax(0,.82fr) minmax(520px,1.18fr); gap:22px; border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:26px; margin-bottom:24px; align-items:start; }
    .provider-imports h2 { margin:8px 0 10px; font-size:28px; line-height:1.12; }
    .provider-imports p { margin:0; color:var(--color-muted); line-height:1.55; }
    .import-options { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
    .import-option { border:1px solid var(--color-line); border-radius:8px; background:var(--color-panel); padding:16px; display:grid; gap:8px; transition:border-color 140ms ease, transform 140ms ease; }
    .import-option:hover { border-color:var(--color-strong-line); transform:translateY(-1px); background:#fff; }
    .import-option b { font-size:15px; }
    .import-option span { color:var(--color-muted); font-size:13px; line-height:1.4; }
    .provider-workbench { display:grid; grid-template-columns:230px minmax(0, 1fr); gap:24px; align-items:start; }
    .provider-grid { grid-template-columns:repeat(3, minmax(0, 1fr)); }
    .rail-action { display:flex; align-items:center; justify-content:center; min-height:42px; border:1px solid var(--color-line); border-radius:8px; background:#fff; font-weight:760; color:var(--color-ink); }
    .rail-action.primary { border-color:var(--color-accent); background:var(--color-accent); color:var(--color-accent-ink); }
    .ops-panel { margin-top:28px; }
    .ops-table { border-top:1px solid var(--color-line); background:#fff; }
    .ops-row { display:grid; grid-template-columns:minmax(220px,1.2fr) 120px 74px 96px minmax(180px,1fr) 74px; gap:14px; align-items:center; min-height:56px; border-bottom:1px solid var(--color-line); color:var(--color-muted); font-size:14px; }
    .ops-row span { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ops-row b { display:block; color:var(--color-ink); font-weight:650; overflow:hidden; text-overflow:ellipsis; }
    .ops-row small { display:block; margin-top:2px; font-family:var(--font-mono); font-size:11px; color:var(--color-faint); overflow:hidden; text-overflow:ellipsis; }
    .ops-row mark { border:1px solid var(--color-line); border-radius:999px; background:#fff; color:var(--color-muted); padding:4px 8px; font-size:11px; font-weight:780; text-transform:uppercase; }
    .ops-row mark.good { border-color:#afe9bb; background:#f2fff4; color:#174d24; }
    .ops-row mark.warn { border-color:#ead4a6; background:#fff9ec; color:#734d00; }
    .ops-row a { color:var(--color-ink); font-weight:780; text-transform:uppercase; font-size:12px; text-decoration:underline; text-underline-offset:3px; }
    .ops-labels { min-height:34px; font-family:var(--font-mono); font-size:11px; text-transform:uppercase; color:var(--color-faint); }
    .detail-page { padding-top:54px; }
    .detail-hero { display:grid; grid-template-columns:minmax(0,1fr) 380px; gap:34px; align-items:end; padding-bottom:30px; border-bottom:1px solid var(--color-line); }
    .detail-hero h1 { margin:10px 0 12px; font-size:46px; }
    .detail-actions { display:flex; flex-wrap:wrap; gap:10px; margin-top:22px; }
    .detail-metrics { display:grid; grid-template-columns:repeat(5, minmax(0, 1fr)); gap:12px; margin-top:24px; }
    .detail-metrics div { border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:18px; min-width:0; }
    .detail-metrics span { display:block; color:var(--color-muted); font-size:12px; font-weight:760; text-transform:uppercase; }
    .detail-metrics strong { display:block; margin-top:10px; font-size:28px; line-height:1; font-weight:760; overflow-wrap:anywhere; }
    .detail-metrics small { display:block; margin-top:10px; color:var(--color-faint); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .detail-summary-card, .detail-panel { border:1px solid var(--color-line); border-radius:8px; background:#fff; }
    .detail-summary-card { padding:18px; display:grid; gap:14px; }
    .detail-summary-card div { display:grid; gap:5px; padding-bottom:12px; border-bottom:1px solid var(--color-line); }
    .detail-summary-card div:last-child { border-bottom:0; padding-bottom:0; }
    .detail-summary-card span, .detail-kv div:nth-child(odd) { color:var(--color-muted); font-size:12px; font-weight:760; text-transform:uppercase; }
    .detail-summary-card strong { overflow-wrap:anywhere; }
    .detail-grid { display:grid; grid-template-columns:minmax(0,.95fr) minmax(460px,1.05fr); gap:22px; margin-top:24px; align-items:start; }
    .detail-panel { padding:24px; min-width:0; }
    .panel-head { display:grid; gap:6px; margin-bottom:18px; }
    .panel-head h2 { margin:0; font-size:28px; line-height:1.1; }
    .detail-kv { display:grid; grid-template-columns:128px minmax(0,1fr); gap:10px 16px; margin-bottom:20px; }
    .detail-kv div:nth-child(even) { min-width:0; overflow-wrap:anywhere; font-weight:690; }
    .detail-panel h3 { margin:20px 0 10px; font-size:16px; }
    .account-console { padding-top:18px; }
    .account-summary { display:grid; grid-template-columns:minmax(260px,.7fr) minmax(420px,1.3fr); gap:28px; align-items:center; border:1px solid var(--color-line); background:var(--color-panel); padding:30px; margin-bottom:22px; }
    .account-summary > div:first-child { display:grid; gap:8px; }
    .account-summary strong { display:block; font-size:64px; line-height:1; font-weight:720; overflow-wrap:anywhere; }
    .account-summary span:last-child, .account-actions small { color:var(--color-muted); }
    .account-actions form, .account-grid form { display:grid; gap:10px; }
    .account-actions label, .account-grid label { font-size:13px; font-weight:760; text-transform:uppercase; }
    .inline-form { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; }
    .inline-form input { min-width:0; min-height:46px; border:1px solid var(--color-line); border-radius:0; background:#fff; padding:0 14px; outline:none; }
    .inline-form input:focus { border-color:var(--color-ink); }
    .account-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:22px; }
    .account-grid h2, .ledger-panel h2 { margin:7px 0 12px; font-size:28px; }
    .account-grid p { color:var(--color-muted); line-height:1.55; }
    .key-result { margin-top:18px; border:1px solid var(--color-line); background:var(--color-panel); padding:16px; }
    .key-result[hidden] { display:none; }
    .key-result code { display:block; margin:12px 0; padding:14px; overflow:auto; background:var(--color-code); color:#fff; font-family:var(--font-mono); }
    .ledger-panel { margin-top:22px; }
    .credit-ledger { overflow-x:auto; }
    .ledger-row { min-width:760px; display:grid; grid-template-columns:1fr 1.5fr .8fr .8fr 1.2fr; gap:16px; align-items:center; min-height:48px; border-bottom:1px solid var(--color-line); font-size:13px; }
    .ledger-labels { min-height:34px; color:var(--color-muted); font-size:11px; font-weight:760; text-transform:uppercase; }
    .ledger-row .credit { color:#16752a; font-weight:760; }
    .ledger-row .debit { color:#a32b20; font-weight:760; }
    .form-status { min-height:24px; color:var(--color-muted); font-weight:650; }
    .code-block { margin:0; overflow:auto; max-width:100%; border-radius:8px; background:var(--color-code); color:#f8fafc; padding:16px; font-family:var(--font-mono); font-size:12px; line-height:1.55; }
    .code-block.tall { max-height:520px; }
    .notice-box { display:grid; gap:6px; padding:14px; border:1px solid #b9e4c0; background:#f4fff6; color:#173f1d; border-radius:8px; margin-bottom:18px; }
    .notice-box span, .detail-note { color:var(--color-muted); line-height:1.55; }
    .invoke-panel { margin-top:22px; }
    .hub-layout, .human-layout { display:grid; grid-template-columns:minmax(0,.92fr) minmax(420px,1.08fr); gap:16px; align-items:start; }
    .section-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .search-card { display:grid; gap:12px; }
    .search-row { display:grid; grid-template-columns:minmax(0,1fr) 154px; gap:10px; }
    .search-row input, .search-row select { width:100%; border:1px solid var(--color-line); border-radius:0; background:#fff; color:var(--color-ink); min-height:44px; padding:10px 12px; outline:none; }
    .install-banner { border:1px solid var(--color-line); border-radius:0; padding:13px; background:#fff; display:grid; gap:8px; }
    .install-banner code, .command { display:block; white-space:pre-wrap; word-break:break-word; border-radius:0; background:var(--color-code); color:#f8fafc; padding:14px; font-family:var(--font-mono); font-size:12px; line-height:1.45; }
    .install-banner details { color:var(--color-muted); font-size:12px; }
    .install-banner summary { cursor:pointer; font-weight:760; width:max-content; }
    .install-banner details code { margin-top:7px; background:#343434; }
    .category-row { display:flex; flex-wrap:wrap; gap:8px; }
    .category { border:1px solid var(--color-line); border-radius:8px; background:#fff; color:#555; padding:8px 11px; font-size:12px; font-weight:760; cursor:pointer; }
    .category.active { background:#222; border-color:#222; color:#fff; }
    .service-grid { display:grid; gap:12px; margin-top:12px; }
    .api-card { position:relative; border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:24px; cursor:pointer; transition:border-color 140ms ease, box-shadow 140ms ease, transform 140ms ease; min-height:286px; }
    .api-card:hover, .api-card.selected { border-color:var(--color-strong-line); box-shadow:var(--shadow-lift); transform:translateY(-1px); }
    .api-card.selected { outline:2px solid var(--color-accent-cool); outline-offset:2px; }
    .api-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:13px; }
    .type-badge { display:inline-flex; border-radius:8px; background:#f0edff; color:#9f1239; padding:7px 10px; font-weight:780; }
    .heart { color:#667085; font-size:22px; line-height:1; }
    .api-main { display:grid; grid-template-columns:54px minmax(0,1fr); gap:13px; }
    .logo { width:54px; height:54px; border-radius:50%; display:grid; place-items:center; background:#ff7a45; color:#111827; font-weight:900; font-size:16px; border:1px solid #f3a179; }
    .api-card h3 { margin:0 0 7px; font-size:24px; line-height:1.15; letter-spacing:0; }
    .api-card p { margin:0; color:var(--color-muted); line-height:1.45; font-size:15px; }
    .byline { display:flex; justify-content:space-between; gap:12px; margin-top:18px; color:var(--color-muted); font-size:14px; }
    .stat-row { display:flex; flex-wrap:wrap; gap:9px; margin-top:14px; }
    .stat-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--color-line); border-radius:8px; background:#fff; color:#667085; padding:8px 11px; font-weight:730; }
    .stat-pill b { color:var(--color-ink); font-weight:800; }
    .pill-row { display:flex; flex-wrap:wrap; gap:5px; margin-top:10px; }
    .pill { display:inline-flex; border:1px solid #d5dde5; border-radius:999px; background:#fff; color:#475467; padding:3px 7px; font-size:11px; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .detail-link { display:inline-flex; margin-top:16px; color:var(--color-ink); font-size:12px; font-weight:780; text-transform:uppercase; }
    .detail-link::before { content:">"; margin-right:8px; font-family:var(--font-mono); }
    .playground { position:sticky; top:88px; border:1px solid var(--color-line); border-radius:8px; background:#fff; overflow:hidden; }
    .playground-head { padding:18px; border-bottom:1px solid var(--color-line); display:flex; align-items:start; justify-content:space-between; gap:12px; }
    .playground-head h2 { margin:4px 0 0; font-size:22px; }
    .playground-body { display:grid; grid-template-columns:132px minmax(0,1fr); min-height:520px; }
    .endpoint-list { border-right:1px solid var(--color-line); background:#fbfcfe; padding:12px; display:grid; gap:8px; align-content:start; }
    .endpoint-item { border:1px solid var(--color-line); border-radius:8px; background:#fff; padding:10px; font-size:12px; font-weight:780; }
    .endpoint-item.active { border-color:#222; background:#222; color:#fff; }
    .play-content { padding:18px; display:grid; gap:15px; align-content:start; }
    .kv { display:grid; grid-template-columns:94px minmax(0,1fr); gap:7px 10px; font-size:13px; }
    .kv div:nth-child(odd) { color:var(--color-muted); }
    .kv div:nth-child(even) { font-weight:720; overflow-wrap:anywhere; }
    .command-wrap { position:relative; }
    .static-command code { padding-right:74px; }
    .copy-button { position:absolute; top:8px; right:8px; border:1px solid #555; color:#fff; background:#343434; border-radius:0; padding:6px 8px; font-size:12px; cursor:pointer; }
    .trust { font-weight:850; color:#111; }
    .muted { color:var(--color-muted); }
    .note { color:var(--color-muted); font-size:13px; line-height:1.45; }
    .footer { border-top:1px solid var(--color-line); color:var(--color-muted); padding:26px 0 36px; }
    @media (max-width:980px) {
      .topbar .shell { padding:0 18px; }
      .nav { min-height:64px; grid-template-columns:1fr auto; gap:14px; }
      .brand { min-height:36px; }
      .brand { gap:9px; }
      .brand-icon { width:40px; height:36px; border-radius:10px; }
      .brand-icon img { width:37px; height:32px; }
      .brand-word { font-size:20px; }
      .nav-links { display:none; }
      .auth-link { min-height:38px; border-radius:12px; padding:0 14px; font-size:12px; }
      .auth-link.signed-in { max-width:118px; }
      .auth-actions { gap:8px; }
      .logout-link { font-size:11px; }
      .hero-grid, .hub-layout, .human-layout, .playground-body, .overview, .market-hero, .provider-hero, .market-shell, .provider-workbench, .detail-hero, .detail-grid, .account-summary, .account-grid { grid-template-columns:1fr; }
      .inline-form { grid-template-columns:1fr; }
      .landing-grid, .metrics, .search-row, .step-row, .hero-paths, .stats-grid, .network-tables, .market-grid, .provider-grid, .provider-metrics, .market-toolbar, .provider-toolbar, .provider-imports, .import-options, .guest-provider-grid { grid-template-columns:1fr; }
      .app-title { display:grid; }
      .section-nav { min-width:0; }
      .playground, .filter-rail, .provider-rail { position:static; }
      .endpoint-list { border-right:0; border-bottom:1px solid var(--color-line); }
      .hero-search { grid-template-columns:1fr; }
      .hero-search button { min-height:48px; border:2px solid #252525; border-top:0; }
      .install-strip { border-radius:16px; margin-top:40px; }
      .install-top { min-height:48px; padding:0 18px; }
      .install-label { font-size:15px; }
      .install-command { min-height:104px; grid-template-columns:1fr; gap:12px; padding:22px 18px; }
      .install-strip code { font-size:16px; }
      .install-strip button { width:100%; min-height:44px; }
      .install-note { font-size:15px; margin-top:14px; }
      .client-row { display:grid; justify-items:center; gap:12px; font-size:14px; }
      .client-row > span { min-height:auto; }
      .client-logos { max-width:360px; gap:8px; padding-bottom:30px; }
      .client-logo { width:42px; height:42px; border-radius:12px; }
      .client-logo img { width:29px; height:29px; }
      .hero-center { padding-top:48px; }
      .dot-grid { height:72px; }
      h1 { font-size:42px; }
      .hero-cta { min-height:44px; margin-top:22px; padding:0 18px; font-size:12px; }
      .app-title h1 { font-size:38px; }
      .stat-block strong { font-size:46px; }
      .service-row { grid-template-columns:minmax(0, 1fr) 74px; }
      .service-row span:nth-child(2) { display:none; }
      .ops-row { grid-template-columns:minmax(0,1fr) 80px; gap:8px; padding:10px 0; }
      .ops-row span:nth-child(3), .ops-row span:nth-child(4), .ops-row span:nth-child(5) { display:none; }
    }
  `;
}

function styles() {
  return naiveDesignSystemStyles();
}

function serviceClientScript() {
  return `
    ${sharedClientHelpers()}
    async function loadStats() {
      try { return await fetch("/agent-router/stats").then((res) => res.json()); }
      catch { return { registered_services: 0, verified_services: 0, total_calls: 0, services: [] }; }
    }
    function apiCard(service, options = {}) {
      const title = service.display_title || service.title || service.service_id;
      const description = service.description_for_agent || "Agent-callable data API with verified response envelope.";
      const logo = initials(title);
      const selected = options.selected ? " selected" : "";
      const detailHref = "/agent-router/service?service_id=" + encodeURIComponent(service.service_id);
      const tagName = options.link ? "a" : "article";
      const hrefAttr = options.link ? ' href="' + detailHref + '"' : "";
      return \`
        <\${tagName} class="api-card\${selected}" data-service-id="\${escapeAttr(service.service_id)}"\${hrefAttr}>
          <div class="api-top"><span class="type-badge">API</span><span class="heart">♡</span></div>
          <div class="api-main">
            <div class="logo">\${escapeHtml(logo)}</div>
            <div>
              <h3>\${escapeHtml(title)}</h3>
              <p>\${escapeHtml(truncate(description, 106))}</p>
              <div class="byline"><span>By \${escapeHtml(service.provider_id || "provider")}</span><span>Updated now</span></div>
              <div class="stat-row">
                <span class="stat-pill"><b>Price</b> \${formatUsdc(Number(service.price || 0))} \${escapeHtml(service.currency || "USDC")}</span>
                <span class="stat-pill"><b>Calls</b> \${formatCount(service.total_calls)}</span>
                <span class="stat-pill"><b>Success</b> \${formatSuccessRate(service.success_rate)}</span>
                <span class="stat-pill"><b>Trust</b> \${formatRating(service.trust_score)}</span>
              </div>
              <div class="pill-row">\${renderPills(service.capabilities || [])}</div>
              \${options.human ? '<div class="actions"><a class="button ghost" href="/studio?service_id=' + encodeURIComponent(service.service_id) + '">Edit</a><a class="button" href="/agent-router/service?service_id=' + encodeURIComponent(service.service_id) + '">Details</a></div>' : '<span class="detail-link">View service details</span>'}
            </div>
          </div>
        </\${tagName}>
      \`;
    }
    function renderPills(tags) {
      const visible = tags.slice(0, 4);
      return visible.map((tag) => '<span class="pill">' + escapeHtml(tag) + '</span>').join("") +
        (tags.length > visible.length ? '<span class="pill">+' + (tags.length - visible.length) + '</span>' : "");
    }
    function serviceRevenue(service) { return Number(service.price || 0) * Number(service.total_calls || 0); }
    function formatRating(value) {
      if (value == null) return "--";
      return Math.min(10, Math.max(0, Number(value) * 10)).toFixed(1);
    }
    function formatSuccessRate(value) {
      if (value == null || Number.isNaN(Number(value))) return "--";
      return Math.round(Math.max(0, Math.min(1, Number(value))) * 100) + "%";
    }
    function formatCount(value) {
      const count = Number(value || 0);
      if (count >= 1000000) return (count / 1000000).toFixed(1).replace(/\\.0$/, "") + "M";
      if (count >= 1000) return (count / 1000).toFixed(1).replace(/\\.0$/, "") + "K";
      return String(count);
    }
    function initials(value) {
      return String(value || "API").split(/\\s|_|-/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase() || "API";
    }
    function truncate(value, max) {
      const text = String(value || "");
      return text.length > max ? text.slice(0, max - 4) + "...." : text;
    }
    function escapeAttr(value) { return escapeHtml(value).replace(/'/g, "&#39;"); }
  `;
}

function sharedClientHelpers() {
  return `
    function formatUsdc(value) {
      const number = Number(value || 0);
      if (number === 0) return "0.00";
      if (number < 0.01) return number.toFixed(6);
      return number.toFixed(2);
    }
    function formatTrust(value) {
      if (value == null) return "--";
      return Number(value).toFixed(2);
    }
    function setText(id, value) {
      const node = document.getElementById(id);
      if (node) node.textContent = String(value);
    }
    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  `;
}

function outputSummary(schema, preview) {
  if (preview && typeof preview === "object") {
    const keys = Object.keys(preview);
    if (keys.length) return keys.join(", ");
  }
  const properties = schema?.properties;
  if (properties && typeof properties === "object") return Object.keys(properties).join(", ");
  return "JSON response envelope";
}

function formatPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return "--";
  return `${Math.round(Number(value) * 100)}%`;
}

function formatScore(value) {
  if (value == null || Number.isNaN(Number(value))) return "--";
  return Number(value).toFixed(2);
}

function brandLogo() {
  return `
    <span class="brand-word">AgentRouter <span class="brand-prompt" aria-hidden="true">&gt;<span class="brand-caret">_</span></span></span>
  `;
}

function faviconLinks() {
  return `
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="shortcut icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;
}

function html(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
