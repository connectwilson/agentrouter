import { authModalHtml, authModalStyles } from "./auth-modal.js";
import { clientRouterScript, naiveDesignSystemStyles } from "./app-shell.js";
import { listBnbGoldenTasks } from "./capability-packs.js";
import { createVendorRegistrationBatch } from "./vendor-registration-batch.js";

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
          <p class="eyebrow">AgentRouter · Model Routing Infrastructure</p>
          <h1>Agent-native API routing layer.<br>One Install. All your agent needs.</h1>
          <p class="lead">1200+ APIs through one router. Smart routing per task, access to verifiable premium data sources — built for agents that never hear, &ldquo;I can&rsquo;t get that data.&rdquo;</p>
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
              <span>Rated services</span>
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
                <h3>Recent calls</h3>
                <a href="/agent-router/feedback">Activity JSON -></a>
              </div>
              <div class="service-table" id="recent-calls"></div>
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
        let homeStatsLoading = false;
        async function loadHomeStats() {
          if (homeStatsLoading) return;
          homeStatsLoading = true;
          let stats = { services: [], registered_services: 0, verified_services: 0, total_calls: 0, total_feedback_events: 0 };
          try {
            stats = await fetch("/agent-router/home-stats", { cache: "no-store" }).then((res) => {
              if (!res.ok) throw new Error("Home stats unavailable");
              return res.json();
            });
            setText("home-services", stats.registered_services || 0);
            setText("home-verified", stats.verified_services || 0);
            setText("home-calls", stats.total_calls || 0);
            setText("home-feedback", Number(stats.rated_services_count || 0) + " / " + (stats.registered_services || 0));
            renderSparks(stats);
            renderHomeTables(stats);
          } catch {}
          finally { homeStatsLoading = false; }
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
          document.getElementById("featured-services").innerHTML = renderRows(sorted.slice(0, 8), "score");
          document.getElementById("recent-calls").innerHTML = renderRecentCallRows(stats.recent_calls || []);
        }
        function renderRecentCallRows(calls) {
          if (!calls.length) return '<div class="empty-row">No calls yet.</div>';
          return [
            '<div class="service-row table-labels"><span>Service</span><span>Provider</span><span>Result</span><span>Called</span></div>',
            ...calls.map((call) => '<div class="service-row">' +
              '<span><b>' + escapeHtml(call.service_id || "service") + '</b><small>' + escapeHtml(call.title || "Service call") + '</small></span>' +
              '<span><mark>' + escapeHtml(call.provider_id || "provider") + '</mark></span>' +
              '<span><b>' + escapeHtml(call.status === "success" ? "Success" : "Failed") + '</b><small>' + (call.latency_ms == null ? "" : Math.round(call.latency_ms) + " ms") + '</small></span>' +
              '<span>' + formatRelativeTime(call.called_at) + '</span>' +
            '</div>')
          ].join("");
        }
        function formatRelativeTime(value) {
          const elapsed = Date.now() - Date.parse(value || "");
          if (!Number.isFinite(elapsed) || elapsed < 0) return "Just now";
          if (elapsed < 60_000) return "Just now";
          if (elapsed < 3_600_000) return Math.floor(elapsed / 60_000) + "m ago";
          if (elapsed < 86_400_000) return Math.floor(elapsed / 3_600_000) + "h ago";
          return Math.floor(elapsed / 86_400_000) + "d ago";
        }
        // A rate without its sample is misleading: one happy call is not a
        // 100% service. Show the count with it, and say plainly when there is
        // no feedback rather than implying a good default.
        function reputationCell(reputation) {
          if (!reputation) return '<small class="rep-empty">--</small>';
          if (reputation.quarantined) return '<small class="rep-quarantined">Quarantined</small>';
          if (!reputation.has_agent_ratings) {
            if (!reputation.call_count) return '<small class="rep-empty">No calls yet</small>';
            const sr = reputation.success_rate == null ? "--" : Math.round(reputation.success_rate * 100) + "%";
            return '<b>' + sr + '</b><small>' + reputation.call_count + ' call' + (reputation.call_count === 1 ? "" : "s") + ' · 0 ratings</small>';
          }
          const pct = reputation.intent_fit_rate == null ? "--" : Math.round(reputation.intent_fit_rate * 100) + "%";
          const size = reputation.sample_size;
          return '<b>' + pct + '</b><small>' + size + ' agent rating' + (size === 1 ? "" : "s") + '</small>';
        }
        function renderRows(services, mode) {
          if (!services.length) return '<div class="empty-row">No registered services yet.</div>';
          return [
            '<div class="service-row table-labels"><span>Service</span><span>Provider</span><span>Agent rating</span><span>' + (mode === "score" ? "Score" : "Calls") + '</span></div>',
            ...services.map((service) => {
              const score = service.trust_score == null ? "--" : Math.round(Number(service.trust_score) * 100);
              return '<div class="service-row">' +
                '<span><b>' + escapeHtml(service.service_id || service.title || "service") + '</b><small>' + escapeHtml(service.title || "Untitled service") + '</small></span>' +
                '<span><mark>' + escapeHtml(service.provider_id || "provider") + '</mark></span>' +
                '<span>' + reputationCell(service.reputation) + '</span>' +
                '<span>' + (mode === "score" ? score : Number(service.total_calls || 0)) + '</span>' +
              '</div>';
            })
          ].join("");
        }
        loadHomeStats();
        clearInterval(window.__agentRouterHomeStatsInterval);
        window.__agentRouterHomeStatsInterval = setInterval(loadHomeStats, 30_000);
        if (window.__agentRouterHomeVisibilityHandler) {
          document.removeEventListener("visibilitychange", window.__agentRouterHomeVisibilityHandler);
        }
        window.__agentRouterHomeVisibilityHandler = () => {
          if (document.visibilityState === "visible") loadHomeStats();
        };
        document.addEventListener("visibilitychange", window.__agentRouterHomeVisibilityHandler);
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

export function bnbMarketplaceHtml({ auth = {} } = {}) {
  const tasks = listBnbGoldenTasks([]);
  const taskCards = tasks.map((task) => `
    <article class="bnb-task-card" data-golden-task="${html(task.id)}">
      <div class="bnb-task-top">
        <span class="type-badge">Read-only simulation</span>
        <span class="bnb-chain">BSC</span>
      </div>
      <h2>${html(task.category)}</h2>
      <p>${html(task.task)}</p>
      <div class="bnb-task-metrics" aria-label="Agent comparison criteria">
        <span><small>Price</small><strong data-task-price>Live quote</strong></span>
        <span><small>Trust Score</small><strong>Verified signals</strong></span>
        <span><small>Track Record</small><strong data-task-availability>Checking agents…</strong></span>
      </div>
      <a class="button primary" href="/agent?pack=${encodeURIComponent(task.id)}&amp;q=${encodeURIComponent(task.task)}">View and hire agents</a>
    </article>
  `).join("");
  return appPage({
    title: "BNB Agent Marketplace",
    subtitle: "Discover and hire trusted BSC agents.",
    active: "bnb",
    auth,
    showHeader: false,
    body: `
      <main class="bnb-judge-mode">
        <section class="shell wide-shell bnb-hero">
          <span class="eyebrow">BNB Agent Marketplace</span>
          <h1>Discover and hire trusted BSC agents.</h1>
          <p>Choose a job, compare live identity, price, trust, and track record, then run one safe read-only task. Sign-in is requested only when you hire.</p>
          <div class="bnb-flow" aria-label="Marketplace journey">
            <span>1 · Choose a job</span><span>2 · Compare agents</span><span>3 · Hire safely</span><span>4 · Verify evidence</span>
          </div>
        </section>
        <section class="shell wide-shell bnb-task-section" aria-labelledby="bnb-task-heading">
          <div class="bnb-section-heading">
            <div><span class="eyebrow">Four first-class categories</span><h2 id="bnb-task-heading">Run a Golden Task</h2></div>
            <p>Every task uses the same selection and evidence contract, without moving funds or placing orders.</p>
          </div>
          <div class="bnb-task-grid">${taskCards}</div>
        </section>
        <section class="shell wide-shell bnb-proof-strip">
          <div><small>Identity</small><strong>BSC Agent ID + 8004scan</strong></div>
          <div><small>Selection</small><strong>Price + Trust Score</strong></div>
          <div><small>Execution</small><strong>Latency + actual cost</strong></div>
          <div><small>Proof</small><strong>Evidence + Feedback status</strong></div>
        </section>
      </main>
      <style>
        .bnb-judge-mode{padding:72px 0 96px;background:#000;color:#fff;min-height:75vh}
        .bnb-hero{padding-bottom:48px;border-bottom:1px solid var(--ar-border)}
        .bnb-hero h1{max-width:900px;margin:14px 0 18px;font-size:clamp(44px,7vw,88px);line-height:.94;letter-spacing:-.055em}
        .bnb-hero>p{max-width:760px;color:var(--ar-muted);font-size:18px;line-height:1.6}
        .bnb-flow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:1px;margin-top:34px;background:var(--ar-border);border:1px solid var(--ar-border)}
        .bnb-flow span{padding:18px;background:#0b0b0b;font-size:13px;text-transform:uppercase;letter-spacing:.08em}
        .bnb-task-section{padding-top:52px}
        .bnb-section-heading{display:flex;justify-content:space-between;gap:28px;align-items:end;margin-bottom:24px}
        .bnb-section-heading h2{margin:8px 0 0;font-size:36px}.bnb-section-heading>p{max-width:520px;color:var(--ar-muted)}
        .bnb-task-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}
        .bnb-task-card{display:flex;flex-direction:column;min-height:390px;padding:26px;border:1px solid var(--ar-border);border-radius:18px;background:var(--ar-card)}
        .bnb-task-top{display:flex;justify-content:space-between;align-items:center}.bnb-chain{font-size:12px;color:var(--ar-muted)}
        .bnb-task-card h2{margin:34px 0 12px;font-size:30px}.bnb-task-card>p{color:var(--ar-muted);line-height:1.55}
        .bnb-task-metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1px;margin:auto 0 22px;background:var(--ar-border);border:1px solid var(--ar-border)}
        .bnb-task-metrics span{display:flex;min-height:82px;padding:12px;background:#101010;flex-direction:column;justify-content:space-between}.bnb-task-metrics small{color:var(--ar-muted)}.bnb-task-metrics strong{font-size:13px}
        .bnb-task-card .button{text-align:center}.bnb-proof-strip{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px;margin-top:42px}
        .bnb-proof-strip div{padding-top:16px;border-top:1px solid var(--ar-border)}.bnb-proof-strip small,.bnb-proof-strip strong{display:block}.bnb-proof-strip small{color:var(--ar-muted);margin-bottom:8px}
        @media(max-width:760px){.bnb-flow,.bnb-proof-strip{grid-template-columns:1fr 1fr}.bnb-task-grid{grid-template-columns:1fr}.bnb-section-heading{align-items:start;flex-direction:column}.bnb-task-metrics{grid-template-columns:1fr}.bnb-task-card{min-height:auto}}
      </style>
      <script>
        fetch("/agent-router/bnb/golden-tasks", { cache: "no-store" })
          .then((response) => response.ok ? response.json() : Promise.reject(new Error("unavailable")))
          .then((payload) => {
            for (const task of payload.tasks || []) {
              const card = document.querySelector('[data-golden-task="' + CSS.escape(task.id) + '"]');
              if (!card) continue;
              const availability = card.querySelector("[data-task-availability]");
              const price = card.querySelector("[data-task-price]");
              availability.textContent = task.verified_service_count
                ? task.verified_service_count + " verified callable"
                : task.service_count ? task.service_count + " awaiting verification" : "Discover on 8004scan";
              price.textContent = task.starting_price_usdc == null ? "Quoted before hire" : "From $" + task.starting_price_usdc;
            }
          })
          .catch(() => {
            document.querySelectorAll("[data-task-availability]").forEach((node) => { node.textContent = "Retry on agent list"; });
          });
      </script>
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

          <section class="capability-pack-section" aria-labelledby="capability-pack-title">
            <div class="capability-pack-head">
              <div>
                <span class="eyebrow">Capability packs</span>
                <h2 id="capability-pack-title">Start with a capability</h2>
              </div>
              <p>Choose a stable task contract. AgentRouter finds the best available provider at call time.</p>
            </div>
            <div class="capability-pack-grid" id="capability-pack-grid" aria-live="polite"></div>
          </section>

          <div class="market-toolbar">
            <input id="service-search" placeholder="Search APIs, providers, categories, or capabilities" />
            <div class="dropdown" id="sort-dropdown">
              <button type="button" class="dropdown-trigger" id="sort-trigger" aria-haspopup="listbox" aria-expanded="false">By relevance <span class="nav-caret">▾</span></button>
              <input type="hidden" id="sort-services" value="relevance" />
              <div class="dropdown-menu" role="listbox" id="sort-menu">
                <button type="button" class="dropdown-option active" data-value="relevance" role="option" aria-selected="true"><span class="drop-check">✓</span>By relevance</button>
                <button type="button" class="dropdown-option" data-value="calls" role="option" aria-selected="false"><span class="drop-check">✓</span>Most called</button>
                <button type="button" class="dropdown-option" data-value="trust" role="option" aria-selected="false"><span class="drop-check">✓</span>Highest trust</button>
                <button type="button" class="dropdown-option" data-value="price" role="option" aria-selected="false"><span class="drop-check">✓</span>Lowest price</button>
              </div>
            </div>
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
                <div class="pager-pages" id="service-pages"></div>
                <button type="button" id="service-next">Next</button>
              </div>
            </section>
          </div>
        </div>
      </main>
      <script>
        ${serviceClientScript()}
        let categories = [{ category: "All", count: 0 }];
        let capabilityPacks = [];
        let builtInCapabilities = [];
        let aiSearchSources = [];
        let erc8004Agents = [];
        const builtInCategory = "Social research";
        const aiSearchCategory = "AI Search";
        const pageSize = 24;
        let servicePage = { services: [], total: 0, limit: pageSize, offset: 0, has_more: false };
        let activeCategory = "All";
        let activePack = "";
        let currentPage = 0;
        let searchTimer = null;
        document.getElementById("service-search").addEventListener("input", () => {
          clearTimeout(searchTimer);
          searchTimer = setTimeout(() => {
            currentPage = 0;
            loadAgentServices();
          }, 180);
        });
        const sortDropdown = document.getElementById("sort-dropdown");
        const sortTrigger = document.getElementById("sort-trigger");
        const sortMenu = document.getElementById("sort-menu");
        const sortInput = document.getElementById("sort-services");
        function setSort(value, label) {
          sortInput.value = value;
          sortTrigger.childNodes[0].textContent = label;
          sortMenu.querySelectorAll(".dropdown-option").forEach((opt) => {
            const selected = opt.dataset.value === value;
            opt.classList.toggle("active", selected);
            opt.setAttribute("aria-selected", String(selected));
            opt.querySelector(".drop-check").style.opacity = selected ? "1" : "0";
          });
          currentPage = 0;
          loadAgentServices();
        }
        sortTrigger.addEventListener("click", () => {
          const open = sortDropdown.classList.toggle("open");
          sortTrigger.setAttribute("aria-expanded", String(open));
        });
        sortMenu.querySelectorAll(".dropdown-option").forEach((opt) => {
          opt.addEventListener("click", () => {
            const label = opt.textContent.replace("✓", "").trim();
            setSort(opt.dataset.value, label);
            sortDropdown.classList.remove("open");
            sortTrigger.setAttribute("aria-expanded", "false");
          });
        });
        document.addEventListener("click", (e) => {
          if (!sortDropdown.contains(e.target)) {
            sortDropdown.classList.remove("open");
            sortTrigger.setAttribute("aria-expanded", "false");
          }
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
          const pageParams = new URLSearchParams(location.search);
          const query = pageParams.get("q") || "";
          const requestedCategory = pageParams.get("category") || "All";
          const requestedPack = pageParams.get("pack");
          document.getElementById("service-search").value = query;
          try {
            const [categoryResponse, builtInResponse, apiSourcesResponse, packsResponse] = await Promise.all([
              fetch("/agent-router/service-categories"),
              fetch("/agent-router/builtin-capabilities"),
              fetch("/agent-router/api-sources"),
              fetch("/agent-router/capability-packs")
            ]);
            const payload = await categoryResponse.json();
            const builtInPayload = await builtInResponse.json();
            const apiSourcesPayload = await apiSourcesResponse.json();
            const packsPayload = await packsResponse.json();
            capabilityPacks = Array.isArray(packsPayload.packs) ? packsPayload.packs : [];
            builtInCapabilities = Array.isArray(builtInPayload.capabilities) ? builtInPayload.capabilities : [];
            aiSearchSources = (Array.isArray(apiSourcesPayload.sources) ? apiSourcesPayload.sources : [])
              .filter((source) => source.implementation_status === "available" && source.hub_category === aiSearchCategory);
            const registeredCategories = (payload.categories || [])
              .filter((item) => ![builtInCategory, aiSearchCategory].includes(item.category));
            categories = [
              { category: "All", count: Number(payload.total || 0) + builtInCapabilities.length + aiSearchSources.length },
              ...registeredCategories,
              ...(aiSearchSources.length ? [{ category: aiSearchCategory, count: aiSearchSources.length }] : []),
              ...(builtInCapabilities.length ? [{ category: builtInCategory, count: builtInCapabilities.length }] : [])
            ];
          } catch {}
          activePack = capabilityPacks.some((pack) => pack.id === requestedPack) ? requestedPack : "";
          activeCategory = categories.some((item) => item.category === requestedCategory) ? requestedCategory : "All";
          if (activePack) activeCategory = "All";
          renderCapabilityPacks();
          renderCategories();
          loadAgentServices();
        }
        function syncHubUrl() {
          const params = new URLSearchParams();
          const query = document.getElementById("service-search").value.trim();
          if (query) params.set("q", query);
          if (activePack) params.set("pack", activePack);
          else if (activeCategory !== "All") params.set("category", activeCategory);
          const next = location.pathname + (params.toString() ? "?" + params.toString() : "");
          history.replaceState({}, "", next);
        }
        function renderCapabilityPacks() {
          const grid = document.getElementById("capability-pack-grid");
          grid.innerHTML = capabilityPacks.map((pack) => {
            const selected = pack.id === activePack;
            const price = pack.starting_price_usdc == null ? "No live service" : "From $" + escapeHtml(pack.starting_price_usdc);
            return '<button type="button" class="capability-pack-card ' + (selected ? "active" : "") + '" data-pack="' + escapeHtml(pack.id) + '" aria-pressed="' + String(selected) + '">' +
              '<span class="capability-pack-title">' + escapeHtml(pack.title) + '</span>' +
              '<span class="capability-pack-description">' + escapeHtml(pack.description) + '</span>' +
              '<span class="capability-pack-contract"><small>Canonical contract</small><code>' + escapeHtml(pack.contract) + '</code></span>' +
              '<span class="capability-pack-meta"><b>' + formatCount(pack.service_count) + ' services</b><b>' + price + '</b></span>' +
            '</button>';
          }).join("");
          grid.querySelectorAll("[data-pack]").forEach((button) => {
            button.addEventListener("click", () => {
              activePack = activePack === button.dataset.pack ? "" : button.dataset.pack;
              activeCategory = "All";
              currentPage = 0;
              renderCapabilityPacks();
              renderCategories();
              syncHubUrl();
              loadAgentServices();
            });
          });
        }
        function renderCategories() {
          document.getElementById("category-row").innerHTML = categories.map(({ category, count }) =>
            '<button type="button" class="category ' + (category === activeCategory ? "active" : "") + '" data-category="' + escapeHtml(category) + '">' + escapeHtml(category) + ' <small>' + formatCount(count) + '</small></button>'
          ).join("");
          document.querySelectorAll(".category").forEach((button) => {
            button.addEventListener("click", () => {
              activePack = "";
              activeCategory = button.dataset.category;
              currentPage = 0;
              renderCapabilityPacks();
              renderCategories();
              syncHubUrl();
              loadAgentServices();
            });
          });
        }
        async function loadAgentServices() {
          if (activeCategory === builtInCategory || activeCategory === aiSearchCategory) {
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
          if (activePack) params.set("pack", activePack);
          document.getElementById("agent-result-count").textContent = "Loading services...";
          showSkeleton();
          try {
            const query = document.getElementById("service-search").value.trim();
            const serviceResponse = await fetch("/agent-router/services?" + params.toString());
            servicePage = await serviceResponse.json();
            const selectedPack = capabilityPacks.find((pack) => pack.id === activePack);
            const discoveryQuery = selectedPack?.discovery_query || query || "";
            const discoveryResponse = discoveryQuery.length >= 2 && Number(servicePage.total || 0) === 0
              ? await fetch("/agent-router/erc8004/discover?q=" + encodeURIComponent(discoveryQuery) + "&limit=6")
              : null;
            erc8004Agents = discoveryResponse?.ok ? (await discoveryResponse.json()).agents || [] : [];
          } catch {
            servicePage = { services: [], total: 0, limit: pageSize, offset: 0, has_more: false };
            erc8004Agents = [];
          }
          renderAgentHub();
        }
        function showSkeleton() {
          const skeletonCard = (key) =>
            '<div class="api-card skeleton-card" data-key="' + key + '">' +
              '<div class="api-top"><span class="sk sk-badge"></span></div>' +
              '<div class="api-heading"><div class="sk sk-logo"></div><div class="api-main-txt">' +
                '<span class="sk sk-title"></span>' +
                '<span class="sk sk-line"></span>' +
              '</div></div>' +
              '<span class="sk sk-line"></span><span class="sk sk-line short"></span>' +
              '<div class="api-core-metrics"><span class="sk sk-metric"></span><span class="sk sk-metric"></span></div>' +
              '<div class="api-performance sk-row"><span class="sk sk-stat"></span><span class="sk sk-stat"></span><span class="sk sk-stat"></span><span class="sk sk-stat"></span></div>' +
              '<div class="pill-row sk-row"><span class="sk sk-pill"></span><span class="sk sk-pill"></span></div>' +
              '<span class="sk sk-link"></span>' +
            '</div>';
          document.getElementById("agent-api-cards").innerHTML = Array.from({ length: 6 }, (_, i) => skeletonCard(i)).join("");
        }
        function renderAgentHub() {
          const query = document.getElementById("service-search").value.trim().toLowerCase();
          const visibleBuiltIns = (!activePack || activePack === "social") && (activeCategory === "All" || activeCategory === builtInCategory)
            ? builtInCapabilities.filter((capability) => !query || [capability.title, capability.description, capability.capability, ...(capability.platforms || [])].join(" ").toLowerCase().includes(query))
            : [];
          const visibleAiSearchSources = (!activePack || activePack === "research") && (activeCategory === "All" || activeCategory === aiSearchCategory)
            ? aiSearchSources.filter((source) => !query || [source.title, source.source, source.category, ...(source.operations || [])].join(" ").toLowerCase().includes(query))
            : [];
          const services = servicePage.services || [];
          const cards = [
            ...visibleBuiltIns.map(builtInCapabilityCard),
            ...visibleAiSearchSources.map(externalApiSourceCard),
            ...erc8004Agents.map(erc8004AgentCard),
            ...services.map((service) => apiCard(service, { link: true }))
          ];
          document.getElementById("agent-api-cards").innerHTML = cards.join("") ||
            '<div class="empty-market">No matching services found.</div>';
          document.querySelectorAll("#agent-api-cards [data-hire-agent-id]").forEach((button) => {
            button.addEventListener("click", () => hireErc8004Agent(button, button.dataset.hireAgentId));
          });
          const availableTotal = activeCategory === builtInCategory
            ? visibleBuiltIns.length
            : activeCategory === aiSearchCategory
              ? visibleAiSearchSources.length
                  : Number(servicePage.total || 0) + visibleBuiltIns.length + visibleAiSearchSources.length + erc8004Agents.length;
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
            '<div class="api-top"><span class="type-badge">Use browser</span></div>' +
            '<div class="api-heading"><div class="logo">⌁</div><div><h3>' + escapeHtml(capability.title) + '</h3><div class="byline"><span>Local connector</span></div></div></div>' +
            '<p class="api-description">' + escapeHtml(capability.description) + '</p>' +
            '<div class="api-core-metrics">' +
              '<div class="api-price"><span>Price</span><strong>Free</strong><small>Local read</small></div>' +
              '<div class="api-trust"><span class="trust-mark" aria-hidden="true">✓</span><div><strong>—</strong><small>Not rated</small></div></div>' +
            '</div>' +
            '<div class="api-performance"><div><strong>Read-only</strong><span>Access</span></div><div><strong>Local</strong><span>Execution</span></div></div>' +
            '<div class="api-card-footer"><div class="pill-row">' + platforms + '</div>' +
            '<span class="detail-link">' + escapeHtml(capability.connector_status === "local_connector_required" ? "Connect browser" : "Ready to use") + ' →</span></div>' +
          '</article>';
        }
        function externalApiSourceCard(source) {
          return apiCard(source, { link: true });
        }
        function erc8004AgentCard(agent) {
          const verified = agent.verification_state === "verified_callable";
          const state = verified ? "Verified callable" : "Registered on-chain, not verified";
          const protocols = Array.isArray(agent.protocols)
            ? agent.protocols
            : Object.entries(agent.protocols || {}).filter(([, value]) => value.status !== "not_declared").map(([key]) => key);
          const score = agent.trust?.average_score == null ? "No score" : Math.round(Number(agent.trust.average_score)) + "/100";
          return '<article class="api-card erc8004-agent-card" data-agent-id="' + escapeAttr(agent.agent_id) + '">' +
            '<div class="api-top"><span class="type-badge">ERC-8004 Agent</span><a class="chain-badge" target="_blank" rel="noopener noreferrer" href="' + escapeAttr(agent.explorer_url || "#") + '">#' + escapeHtml(agent.agent_id) + ' ↗</a></div>' +
            '<div class="api-heading"><div class="logo">8K</div><div><h3>' + escapeHtml(agent.name) + '</h3><div class="byline"><span>BNB Chain</span><span>' + escapeHtml(state) + '</span></div></div></div>' +
            '<p class="api-description">' + escapeHtml(truncate(agent.description || "On-chain agent discovered through 8004scan.", 132)) + '</p>' +
            '<div class="api-core-metrics"><div class="api-price"><span>Payment</span><strong>' + (agent.x402_supported ? "x402" : "Declared by agent") + '</strong><small>Verify before call</small></div>' +
            '<div class="api-trust"><span class="trust-mark" aria-hidden="true">✓</span><div><strong>' + escapeHtml(score) + '</strong><small>8004scan score</small></div></div></div>' +
            '<div class="execution-result" data-execution-result role="status" aria-live="polite" hidden></div>' +
            '<div class="api-card-footer"><div class="pill-row">' + renderPills(protocols) + '</div>' +
            '<button type="button" class="button ' + (verified ? "primary" : "ghost") + '" data-hire-agent-id="' + escapeAttr(agent.agent_id) + '">Hire / call</button></div>' +
          '</article>';
        }
        function renderBnbHireSummary(target, summary) {
          if (!target || !summary || typeof summary !== "object") return false;
          const selected = summary.selected_agent || {};
          const price = summary.price || {};
          const trust = summary.trust_score || {};
          const actualCost = summary.actual_cost || {};
          const feedback = summary.feedback || {};
          const evidence = summary.evidence || {};
          const sources = Array.isArray(summary.data_sources) ? summary.data_sources : [];
          const displayAmount = (value, currency, status) => value == null
            ? "Not reported"
            : String(value) + " " + String(currency || "USDC") + (status === "declared" ? " declared" : "");
          const displayTrust = trust.score == null ? "Not rated" : String(Math.round(Number(trust.score))) + "/100";
          const displayLatency = summary.latency_ms == null ? "Not reported" : String(summary.latency_ms) + " ms";
          const displayFeedback = String(feedback.status || "not_requested").replace(/_/g, " ");
          const explorer = selected.explorer_url
            ? '<a href="' + escapeAttr(selected.explorer_url) + '" target="_blank" rel="noopener noreferrer">#' + escapeHtml(selected.agent_id || "unknown") + ' on 8004scan ↗</a>'
            : '#' + escapeHtml(selected.agent_id || "unknown") + ' on BSC';
          const sourceItems = sources.length
            ? sources.map((source) => '<li>' + escapeHtml(typeof source === "string" ? source : JSON.stringify(source)) + '</li>').join("")
            : '<li>Not reported by agent</li>';
          target.innerHTML =
            '<div class="hire-summary">' +
              '<div class="hire-summary-head"><span>Completed</span><strong>' + escapeHtml(selected.name || "Selected agent") + '</strong></div>' +
              '<p class="hire-selection-reason">' + escapeHtml(summary.selection_reason || "Selected for the requested capability.") + '</p>' +
              '<dl class="hire-summary-grid">' +
                '<div><dt>Agent ID</dt><dd>' + explorer + '</dd></div>' +
                '<div><dt>Price</dt><dd>' + escapeHtml(displayAmount(price.amount, price.currency, price.status)) + '</dd></div>' +
                '<div><dt>Trust Score</dt><dd>' + escapeHtml(displayTrust) + '</dd></div>' +
                '<div><dt>Track Record</dt><dd>' + escapeHtml(String(trust.total_feedbacks || 0)) + ' feedback · ' + escapeHtml(String(trust.total_validations || 0)) + ' validations</dd></div>' +
                '<div><dt>Latency</dt><dd>' + escapeHtml(displayLatency) + '</dd></div>' +
                '<div><dt>Actual cost</dt><dd>' + escapeHtml(displayAmount(actualCost.amount, actualCost.currency, actualCost.status)) + '</dd></div>' +
                '<div><dt>Feedback status</dt><dd>' + escapeHtml(displayFeedback) + '</dd></div>' +
                '<div><dt>Evidence trace</dt><dd><code>' + escapeHtml(evidence.trace_hash || "Not reported") + '</code></dd></div>' +
              '</dl>' +
              '<details><summary>Data sources (' + sources.length + ')</summary><ul>' + sourceItems + '</ul></details>' +
              '<details><summary>Structured result</summary><pre>' + escapeHtml(JSON.stringify(summary.structured_result, null, 2)) + '</pre></details>' +
            '</div>';
          return true;
        }
        async function hireErc8004Agent(button, agentId) {
          const original = button.textContent;
          const task = document.getElementById("service-search").value.trim();
          const result = button.closest(".erc8004-agent-card")?.querySelector("[data-execution-result]");
          const showAuthRequired = (message) => {
            const returnParams = new URLSearchParams(location.search);
            if (task) returnParams.set("q", task);
            const returnTo = location.pathname + (returnParams.toString() ? "?" + returnParams.toString() : "");
            const loginHref = "?login=1&return_to=" + encodeURIComponent(returnTo);
            if (result) {
              result.hidden = false;
              result.textContent = message + " Your task will be restored after sign-in.";
            }
            button.textContent = "Sign in to hire";
            button.title = message;
            button.onclick = () => window.location.assign(loginHref);
          };
          button.disabled = true;
          button.textContent = "Verifying…";
          try {
            const importedResponse = await fetch("/agent-router/erc8004/import", {
              method: "POST", headers: { "content-type": "application/json" },
              body: JSON.stringify({ chain_id: 56, agent_id: agentId })
            });
            const imported = await importedResponse.json();
            if (importedResponse.status === 401) {
              showAuthRequired(imported.error?.message || "Sign in to verify and hire this agent.");
              return;
            }
            if (!importedResponse.ok) throw new Error(imported.error?.message || "Sign in to verify and hire this agent.");
            if (!imported.agent?.callable) throw new Error(imported.agent?.verification_error || "Registered on-chain, not verified callable.");
            const selectedPack = capabilityPacks.find((pack) => pack.id === activePack);
            const selectedCapability = selectedPack?.golden_task?.capability
              || imported.agent?.execution_policy?.allowed_capabilities?.[0]
              || "";
            const idempotencyKey = globalThis.crypto?.randomUUID?.()
              || "hire-" + Date.now() + "-" + Math.random().toString(16).slice(2);
            const hireResponse = await fetch("/agent-router/erc8004/hire", {
              method: "POST",
              headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
              body: JSON.stringify({
                chain_id: 56,
                agent_id: agentId,
                execute: true,
                capability: selectedCapability,
                input: { task, execution_mode: selectedPack?.golden_task?.execution_mode || "read_only" }
              })
            });
            const hired = await hireResponse.json();
            if (hireResponse.status === 401) {
              showAuthRequired(hired.error?.message || "Sign in to call this agent.");
              return;
            }
            if (!hireResponse.ok) throw new Error(hired.error?.message || "Agent is not ready to call.");
            if (hired.status === "completed") {
              if (result) {
                result.hidden = false;
                if (!renderBnbHireSummary(result, hired.judge_summary)) {
                  result.textContent = truncate(JSON.stringify(hired.result), 240);
                }
              }
              button.textContent = "Completed";
              button.title = "Agent returned a verified JSON response.";
            } else {
              button.textContent = "Ready via " + hired.dispatch.adapter.toUpperCase();
              button.title = "Verified endpoint: " + hired.dispatch.endpoint;
            }
          } catch (error) {
            button.textContent = "Unavailable";
            button.title = error.message;
            if (result) {
              result.hidden = false;
              result.textContent = error.message;
            }
          } finally {
            button.disabled = false;
            if (button.textContent === "Verifying…") button.textContent = original;
          }
        }
        function renderPager() {
          const total = Number(servicePage.total || 0);
          const pages = Math.max(1, Math.ceil(total / pageSize));
          const cur = currentPage;
          const items = [];
          const pushPage = (n, label) => items.push({ n, label });
          if (pages <= 5) {
            for (let i = 1; i <= pages; i++) pushPage(i, String(i));
          } else {
            for (let i = 1; i <= 5; i++) pushPage(i, String(i));
            if (pages > 6) items.push({ n: null, label: "…" });
            pushPage(pages, String(pages));
          }
          document.getElementById("service-pages").innerHTML = items.map((it) => {
            if (it.n === null) return '<span class="pg-ellipsis">' + it.label + "</span>";
            const active = it.n - 1 === cur ? "active" : "";
            return '<button type="button" class="pg-btn ' + active + '" data-page="' + it.n + '">' + it.label + "</button>";
          }).join("");
          document.querySelectorAll("#service-pages .pg-btn").forEach((btn) => {
            btn.addEventListener("click", () => {
              currentPage = Number(btn.dataset.page) - 1;
              loadAgentServices();
            });
          });
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
  const priceDisplay = service.price_label || `${price.amount || service.price || "0.00"} ${price.currency || service.currency || "USDC"}`;
  const upstreamPricing = service.upstream_pricing || manifest.upstream_pricing || {};
  const priceContextLabel = service.price_scope === "upstream_api" ? "Upstream API cost" : "AgentRouter charge";
  const pricingSourceLink = upstreamPricing.source_url
    ? ` · <a href="${html(upstreamPricing.source_url)}" target="_blank" rel="noreferrer">Official pricing ↗</a>`
    : "";
  const trust = service.trust || {};
  const trustBasis = service.trust_basis || {
    model: "verified_call_feedback_and_evidence",
    operational_calls: trust.operational_feedback_count || service.total_calls || 0,
    consumer_ratings: trust.consumer_feedback_count || 0,
    evidence_traces: (detail.recent_evidence_events || []).length,
    caveat: "Trust combines observed execution and feedback signals; evidence coverage can be lower than call volume."
  };
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
            <div><span>Price</span><strong>${html(priceDisplay)}</strong></div>
            <div><span>Status</span><strong>${html(service.verification_status || "unknown")}</strong></div>
          </aside>
        </section>

        <section class="detail-metrics" aria-label="Service quality summary">
          <div><span>Price</span><strong>${html(priceDisplay)}</strong><small>${html(priceContextLabel)}${pricingSourceLink}</small></div>
          <div><span>Service calls</span><strong>${html(service.metrics_available === false ? "--" : trust.operational_feedback_count ?? service.total_calls ?? 0)}</strong><small>Observed demand</small></div>
          <div><span>Success rate</span><strong>${html(formatPercent(trust.success_rate))}</strong><small>Runtime feedback</small></div>
          <div><span>Trust score</span><strong>${html(trust.feedback_state === "no_feedback_yet" ? "No feedback yet" : formatScore(trust.trust_score))}</strong><small>${html(trust.feedback_state === "no_feedback_yet" ? "Awaiting observed calls" : `Confidence ${formatPercent(trust.trust_score_confidence)}`)}</small></div>
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
          <div class="notice-box">
            <strong>Trust basis · ${html(trustBasis.model)}</strong>
            <span>${html(trustBasis.caveat || "Trust and evidence use different signals and coverage windows.")}</span>
          </div>
          <div class="detail-kv">
            <div>Observed calls</div><div>${html(trustBasis.operational_calls ?? 0)}</div>
            <div>Consumer ratings</div><div>${html(trustBasis.consumer_ratings ?? 0)}</div>
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
        .ar-dashboard { background:var(--dash-bg); }.dash-sidebar { background:var(--color-panel); }.dash-workspace, .dash-panel, .dash-notice, .dash-action, .dash-form input, .dash-key-result { border-radius:0; }.dash-workspace { background:var(--color-panel); }.dash-workspace small { color:var(--dash-text); }.dash-nav-label { color:var(--dash-muted); }.dash-nav button { border-radius:0; color:var(--dash-muted); }.dash-nav button:hover, .dash-nav button[aria-selected="true"] { background:var(--color-accent); color:var(--color-accent-ink); }.dash-nav button span { color:inherit; }.dash-avatar { background:var(--color-accent-cool); color:var(--dash-text); }.dash-notice { border-color:var(--dash-line); background:var(--color-soft); color:var(--dash-text); }.dash-notice b, .dash-notice a { color:var(--dash-text); }.dash-metric::after { border-color:var(--dash-line); }.dash-metric small, .dash-row small { color:var(--dash-muted); }.dash-metric.accent strong { color:var(--dash-text); }.dash-card p, .dash-service-top, .dash-action, .dash-form label, .dash-key-table th, .dash-key-table td { color:var(--dash-muted); }.dash-row strong, .dash-service-top, .dash-action b, .dash-key-table td:first-child { color:var(--dash-text); }.dash-credit { color:#19733a; }.dash-debit, .dash-status.error { color:#9b401b; }.dash-service-bar { background:var(--color-soft); border-radius:0; }.dash-service-bar i { border-radius:0; background:var(--color-accent); }.dash-action { background:var(--color-soft); }.dash-action:hover { border-color:var(--color-strong-line); background:var(--color-soft); }.dash-action i { color:var(--dash-text); }.dash-form input { border-color:var(--dash-line); background:var(--color-soft); color:var(--dash-text); }.dash-form input:focus { border-color:var(--color-strong-line); box-shadow:none; }.dash-button { border:2px solid var(--dash-text); border-radius:0; background:var(--color-accent); color:var(--color-accent-ink); }.dash-button.secondary { background:var(--color-soft); color:var(--dash-text); }.dash-key-result { border-color:var(--dash-line); background:var(--color-soft); color:var(--dash-text); }.dash-key-result code { color:var(--dash-text); }.dash-badge { border-radius:0; background:var(--color-accent); color:var(--color-accent-ink); }
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

          <section class="dash-view" data-panel="keys" hidden><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Connected agents</h2><p>No API key needs to be copied into an MCP configuration. On the first paid call, AgentRouter opens a short browser approval flow and stores the connection privately on your device.</p></div><a class="dash-link" href="/agent">Install AgentRouter →</a></div><div id="agent-connection-list"></div></article><div class="dash-grid dash-section"><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Developer API keys</h2><p>An advanced fallback for CI and headless servers that cannot open a browser. Most people never need one.</p></div></div><form class="dash-form" id="api-key-form"><label for="api-key-label">Client label</label><div class="dash-form-row"><input id="api-key-label" name="label" value="CI server" maxlength="120"><button class="dash-button" type="submit">Create key</button></div></form><div class="dash-key-result" id="api-key-result" hidden><b>Copy this key now. It will not be shown again.</b><code id="api-key-value"></code><button class="dash-button secondary" id="copy-api-key" type="button">Copy key</button><small>Use this only for CI or a headless server. Never paste it into a chat.</small></div><div class="dash-card-head dash-section"><div><h3>Your keys</h3><p>The full secret is stored only as a hash and is never shown again. The hint below is enough to tell one key from another.</p></div></div><div id="api-key-list"></div></article><aside class="dash-panel dash-card"><h2>Security model</h2><p>Browser-approved connections can use only this account's prepaid balance. They never expose GitHub credentials or provider API keys and can be disconnected at any time.</p><p>Every call, from a browser connection or a key, is capped by the per-call spending limit set on the Credits page.</p></aside></div><article class="dash-panel dash-card dash-section" id="platform-identity-card"><div class="dash-card-head"><div><h2>BNB Chain platform identity</h2><p>Register the ERC-8004 identity for AgentRouter-operated services. Third-party Vendor reputation is kept on separate Vendor Agent IDs.</p></div><button class="dash-button" id="platform-identity-button" type="button">Register BSC identity</button></div><p class="dash-status" id="platform-identity-status" role="status">Checking registration status…</p></article><article class="dash-panel dash-card dash-section" id="vendor-identities-card"><div class="dash-card-head"><div><h2>Vendor identities</h2><p>Each Vendor receives one chain-generated ERC-8004 Agent ID shared by its services. AgentRouter sponsors registration. The signing wallet owns the identity. Platform-managed integrations are not Vendor endorsements.</p></div></div><div class="dash-form"><label for="vendor-batch-owner">Identity owner wallet (verify before signing)</label><input id="vendor-batch-owner" placeholder="0x…" maxlength="42" autocomplete="off"><p>Select up to 5 Vendors. Each requires a wallet confirmation. Similar names may be duplicate imports: select only the canonical Vendor; identities are not merged automatically. Platform sponsorship limits still apply.</p><div class="dash-form-row"><button class="dash-button" type="button" id="vendor-batch-start" disabled>Register selected (0/5)</button><button class="dash-button secondary" type="button" id="vendor-batch-stop" disabled>Pause batch</button></div><p class="dash-status" id="vendor-batch-status" role="status" aria-live="polite">Choose Vendors below. No transaction starts automatically.</p></div><div class="dash-actions" id="vendor-identities-list"><p class="dash-status">Loading Vendor identities…</p></div></article></section>

          <section class="dash-view" data-panel="activity" hidden><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Account activity</h2><p>Top-ups and billable service calls from your account ledger.</p></div></div><div class="dash-activity" id="activity-list"></div></article></section>

          <section class="dash-view" data-panel="credits" hidden><div class="dash-grid"><article class="dash-panel dash-card"><div class="dash-card-head"><div><h2>Add credits</h2><p>Pay from your browser wallet on BNB Chain. The deposit is verified on-chain and credited automatically.</p></div></div><div id="deposit-instructions" class="deposit-box"><p class="dash-status">Loading deposit details…</p></div><form class="dash-form" id="buy-form"><label for="buy-amount">Amount</label><div class="dash-form-row"><input id="buy-amount" name="amount" type="number" min="0.01" step="0.01" value="10" required><select id="buy-token" name="token"></select><button class="dash-button" id="buy-button" type="submit">Pay with wallet</button></div></form><details class="deposit-fallback"><summary>Already sent, or paying from another device?</summary><form class="dash-form" id="deposit-form"><label for="deposit-tx">Transaction hash</label><div class="dash-form-row"><input id="deposit-tx" name="tx_hash" type="text" placeholder="0x…" pattern="0x[0-9a-fA-F]{64}" required><button class="dash-button secondary" id="deposit-button" type="submit">Claim deposit</button></div></form></details><p class="dash-status" id="account-status" role="status"></p></article><aside class="dash-panel dash-card"><h2>Spending limit</h2><p>The most any single agent call may spend. A call above it is refused before anything is charged.</p><form class="dash-form" id="limit-form"><label for="limit-amount">Max per call (USD)</label><div class="dash-form-row"><input id="limit-amount" name="max_price_per_call" type="number" min="0.01" max="1000" step="0.01" required><button class="dash-button" id="limit-button" type="submit">Save limit</button></div></form><p class="dash-status" id="limit-status" role="status"></p><p class="dash-note">Credits are debited after validation and before delivery. Failed provider calls are refunded automatically.</p></aside></div><article class="dash-panel dash-card dash-section"><div class="dash-card-head"><div><h2>Credit ledger</h2><p>Immutable record of credits added and used.</p></div></div><div class="dash-activity" id="credit-ledger"></div></article></section>
        </section>
      </main>
      <script>
        const dashboardState = { data: null };
        const viewMeta = { overview:["Overview","Your prepaid balance, agent connections, and verified service activity in one place."], keys:["Connections","Approve agents in your browser and disconnect them here. Developer keys remain available for CI."], activity:["Activity","A transparent account ledger for credits and completed paid service calls."], credits:["Credits","Deposit USDC or USDT on-chain and see every balance change."] };
        // A credit is one USDC or USDT, so showing it as dollars is what it is
        // worth, not a conversion. Sub-cent amounts keep their precision —
        // rounding a $0.002 call to $0.00 would hide what a call costs.
        const money = (value) => {
          const number = Number(value || 0);
          const abs = Math.abs(number);
          const digits = abs > 0 && abs < 0.01 ? 6 : 2;
          const sign = number < 0 ? "-" : "";
          return sign + "$" + abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: digits });
        };
        const escapeDash = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[char]);
        const kindLabels = { service_call: "Service call", topup: "Deposit", refund: "Refund" };
        function renderActivity(target, entries, limit = 12) {
          target.innerHTML = entries.slice(0, limit).map((entry) => {
            const meta = entry.metadata || {};
            // A crypto deposit is only auditable if the row links to the
            // transaction it came from.
            const detail = meta.tx_hash
              ? '<a class="dash-link" href="' + escapeDash(meta.explorer_url || "#") + '" target="_blank" rel="noopener noreferrer">' + escapeDash(String(meta.asset || "") + " " + meta.tx_hash.slice(0, 10) + "…") + ' \u2197</a>'
              : '<small>' + escapeDash(entry.service_id || "Account credit") + '</small>';
            return '<div class="dash-row"><span><strong>' + escapeDash(kindLabels[entry.kind] || entry.kind) + '</strong>' + detail + '</span><span class="' + (String(entry.delta).startsWith("-") ? "dash-debit" : "dash-credit") + '">' + money(entry.delta) + '</span><span>Balance ' + money(entry.balance) + '</span><span><small>' + escapeDash(new Date(entry.created_at).toLocaleString()) + '</small></span></div>';
          }).join("") || '<div class="dash-empty">No account activity yet. Add credits, connect an agent, and make your first call.</div>';
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
          // Show the limit that is actually in force, not the placeholder — an
          // agent spends against the saved value, not what the box says.
          const limitInput = document.getElementById("limit-amount");
          if (limitInput && payload.account?.max_price_per_call) limitInput.value = payload.account.max_price_per_call;
          const connections = payload.api_keys.filter((key) => key.auth_method === "device");
          const developerKeys = payload.api_keys.filter((key) => key.auth_method !== "device");
          document.getElementById("agent-connection-list").innerHTML = connections.length ? '<table class="dash-key-table"><thead><tr><th>Agent</th><th>Status</th><th>Connected</th><th>Action</th></tr></thead><tbody>' + connections.map((key) => '<tr><td>' + escapeDash(key.client_name || key.label) + '</td><td><span class="dash-badge">' + escapeDash(key.status) + '</span></td><td>' + escapeDash(new Date(key.created_at).toLocaleDateString()) + '</td><td>' + (key.status === "active" ? '<button class="dash-link" type="button" data-revoke-key="' + escapeDash(key.key_id) + '">Disconnect</button>' : 'Disconnected') + '</td></tr>').join("") + '</tbody></table>' : '<div class="dash-empty">No agents connected yet. Install AgentRouter, then approve the browser prompt on the first paid call.</div>';
                    // A row has to let someone recognise which key it is. A bare UUID
          // matches nothing they hold, so the masked prefix leads and the key
          // id is dropped entirely.
          const relative = (value) => {
            if (!value) return "Never";
            const days = Math.floor((Date.now() - new Date(value).getTime()) / 86400000);
            if (days <= 0) return "Today";
            if (days === 1) return "Yesterday";
            return days + " days ago";
          };
          document.getElementById("api-key-list").innerHTML = developerKeys.length
            ? '<table class="dash-key-table"><thead><tr><th>Label</th><th>Key</th><th>Created</th><th>Last used</th><th>Status</th><th></th></tr></thead><tbody>'
              + developerKeys.map((key) => '<tr><td>' + escapeDash(key.label) + '</td>'
                + '<td><code class="dash-key-hint">' + escapeDash(key.key_prefix || "—") + '</code></td>'
                + '<td>' + escapeDash(new Date(key.created_at).toLocaleDateString()) + '</td>'
                + '<td>' + escapeDash(relative(key.last_used_at)) + '</td>'
                + '<td><span class="dash-badge' + (key.status === "active" ? "" : " revoked") + '">' + escapeDash(key.status) + '</span></td>'
                + '<td>' + (key.status === "active" ? '<button class="dash-link" type="button" data-revoke-key="' + escapeDash(key.key_id) + '">Revoke</button>' : "") + '</td></tr>').join("")
              + '</tbody></table>'
            : '<div class="dash-empty">No developer API keys yet.</div>';
          const services = payload.top_services || [];
          const max = Math.max(...services.map((item) => item.spend_credits), 1);
          document.getElementById("top-services").innerHTML = services.length ? services.map((item) => '<div class="dash-service"><div class="dash-service-top"><span>' + escapeDash(item.service_id) + '</span><span>' + money(item.spend_credits) + '</span></div><div class="dash-service-bar"><i style="width:' + Math.max(8, Math.round((item.spend_credits / max) * 100)) + '%"></i></div></div>').join("") : '<div class="dash-empty">Service usage will appear after your first successful paid call.</div>';
        }
        async function loadDashboard() { const response = await fetch("/account/dashboard"); const payload = await response.json(); if (!response.ok) throw new Error(payload.error?.message || "Could not load your dashboard."); renderDashboard(payload); }
        function showView(name) { document.querySelectorAll(".dash-view").forEach((node) => { node.hidden = node.dataset.panel !== name; }); document.querySelectorAll("[data-view]").forEach((node) => node.setAttribute("aria-selected", String(node.dataset.view === name))); document.getElementById("dash-title").textContent = viewMeta[name][0]; document.getElementById("dash-subtitle").textContent = viewMeta[name][1]; }
        document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.view)));
        document.querySelectorAll("[data-view-link]").forEach((button) => button.addEventListener("click", () => showView(button.dataset.viewLink)));
        // The address and chain come from the server, never from something the
        // user retyped: a mistyped address or the wrong chain loses the funds.
        async function loadDepositInstructions() {
          const box = document.getElementById("deposit-instructions");
          try {
            const response = await fetch("/account/credits/deposit");
            const info = await response.json();
            if (!info.enabled) {
              box.innerHTML = '<p class="dash-status error">Crypto top-ups are not configured on this deployment yet.</p>';
              document.getElementById("deposit-button").disabled = true;
              document.getElementById("buy-button").disabled = true;
              return;
            }
            depositInfo = info;
            const tokenSelect = document.getElementById("buy-token");
            tokenSelect.innerHTML = info.accepted.map((a) => '<option value="' + escapeDash(a.symbol) + '">' + escapeDash(a.symbol) + '</option>').join("");
            document.getElementById("buy-button").textContent = window.ethereum ? "Pay with wallet" : "No wallet detected";
            setTimeout(refreshDepositQr, 0);
            box.innerHTML =
              '<div class="deposit-qr"><img id="deposit-qr-img" alt="Payment code for the AgentRouter treasury" src="/account/credits/deposit.svg?token=' + encodeURIComponent(info.accepted[0].symbol) + '" width="150" height="150"><small>Scan with a mobile wallet</small></div>' +
              '<div class="deposit-row"><span>Network</span><strong>' + escapeDash(info.chain_name) + ' (chain ' + info.chain_id + ')</strong></div>' +
              '<div class="deposit-row"><span>Send to</span><strong class="deposit-address" id="deposit-address">' + escapeDash(info.treasury_address) + '</strong><button type="button" class="dash-button ghost" id="copy-deposit">Copy</button></div>' +
              '<div class="deposit-row"><span>Accepted</span><strong>' + info.accepted.map((a) => escapeDash(a.symbol)).join(" · ") + '</strong></div>' +
              '<div class="deposit-row"><span>Confirmations</span><strong>' + info.min_confirmations + '</strong></div>' +
              '<ul class="deposit-notes">' + info.notes.map((n) => '<li>' + escapeDash(n) + '</li>').join("") + '</ul>';
            document.getElementById("copy-deposit").addEventListener("click", async () => {
              await navigator.clipboard.writeText(info.treasury_address);
              document.getElementById("copy-deposit").textContent = "Copied";
            });
          } catch (error) {
            box.innerHTML = '<p class="dash-status error">' + escapeDash(error.message) + '</p>';
          }
        }
        // Paying from the browser wallet the user already has. EIP-1193 is a
        // plain JSON-RPC interface on window.ethereum, so an injected wallet
        // needs no library, no bundle and no third-party checkout — which also
        // means no CDN script for the page's CSP to refuse.
        let depositInfo = null;
        const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

        // Decimal string to atomic units. Never via Number: 10 USDT at 18
        // decimals is already past the safe integer range, and a rounded amount
        // is a wrong payment.
        function toAtomic(value, decimals) {
          const [whole, fraction = ""] = String(value).trim().split(".");
          if (fraction.length > decimals) throw new Error("That amount has more decimal places than the token supports.");
          return BigInt(whole || "0") * (10n ** BigInt(decimals)) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
        }
        function encodeTransfer(to, atomic) {
          return ERC20_TRANSFER_SELECTOR
            + to.toLowerCase().replace(/^0x/, "").padStart(64, "0")
            + atomic.toString(16).padStart(64, "0");
        }
        async function ensureChain(chainIdDecimal) {
          const hexChain = "0x" + Number(chainIdDecimal).toString(16);
          try {
            await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain }] });
          } catch (error) {
            // 4902 means the wallet does not know this chain yet; adding it is
            // the documented recovery, not an error to surface.
            if (error?.code !== 4902) throw error;
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{
              chainId: hexChain,
              chainName: depositInfo.chain_name,
              nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
              rpcUrls: ["https://bsc-dataseed.binance.org"],
              blockExplorerUrls: depositInfo.explorer ? [depositInfo.explorer] : []
            }] });
          }
        }
        async function ensurePlatformChain(info) {
          const hexChain = "0x" + Number(info.chain_id).toString(16);
          try {
            await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain }] });
          } catch (error) {
            if (error?.code !== 4902) throw error;
            await window.ethereum.request({ method: "wallet_addEthereumChain", params: [{ chainId: hexChain, chainName: info.chain_name, nativeCurrency: { name:"BNB", symbol:"BNB", decimals:18 }, rpcUrls:[info.rpc_url], blockExplorerUrls:[info.explorer] }] });
          }
        }
        async function loadPlatformIdentity() {
          const button = document.getElementById("platform-identity-button");
          const status = document.getElementById("platform-identity-status");
          const response = await fetch("/agent-router/erc8004/platform-registration");
          const info = await response.json();
          if (!response.ok) {
            document.getElementById("platform-identity-card").hidden = true;
            button.hidden = true;
            return null;
          }
          document.getElementById("platform-identity-card").hidden = false;
          if (info.current_identity) {
            button.hidden = true;
            const ownerInput = document.getElementById("vendor-batch-owner");
            if (!ownerInput.value) ownerInput.value = info.current_identity.owner_address || "";
            status.textContent = "Registered as ERC-8004 agent #" + info.current_identity.agent_id + " on " + info.chain_name + ".";
          } else {
            button.hidden = false;
            status.textContent = "Ready to register on " + info.chain_name + ". Only your wallet address and public transaction are recorded.";
          }
          return info;
        }
        document.getElementById("platform-identity-button").addEventListener("click", async () => {
          const button = document.getElementById("platform-identity-button");
          const status = document.getElementById("platform-identity-status");
          button.disabled = true;
          status.className = "dash-status";
          try {
            if (!window.ethereum) throw new Error("No browser wallet detected. Open this page in a browser with an EVM wallet.");
            const info = await loadPlatformIdentity();
            if (!info || info.current_identity) return;
            status.textContent = "Connecting wallet…";
            const [owner] = await window.ethereum.request({ method: "eth_requestAccounts" });
            await ensurePlatformChain(info);
            status.textContent = "Confirm ERC-8004 registration in your wallet…";
            const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{ from:owner, ...info.transaction }] });
            for (let attempt = 0; attempt < 40; attempt++) {
              status.textContent = "Waiting for the registration transaction… (" + (attempt + 1) + ")";
              const response = await fetch("/agent-router/erc8004/platform-registration", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ tx_hash:txHash, owner_address:owner }) });
              const result = await response.json();
              if (response.ok) {
                status.textContent = "Registered successfully as ERC-8004 agent #" + result.identity.agent_id + ".";
                button.hidden = true;
                return;
              }
              if (result.error?.code !== "ERC8004_RECEIPT_NOT_FOUND") throw new Error(result.error?.message || "Registration could not be verified.");
              await new Promise((resolve) => setTimeout(resolve, 3000));
            }
            throw new Error("The transaction is still pending. This page can verify it after confirmation.");
          } catch (error) {
            status.className = "dash-status error";
            status.textContent = error?.code === 4001 ? "Registration cancelled." : (error.message || "Registration failed.");
          } finally { button.disabled = false; }
        });
        let vendorItems = [], vendorBatch = null, vendorBatchBusy = false;
        const batchStart = document.getElementById("vendor-batch-start");
        const batchStop = document.getElementById("vendor-batch-stop");
        const batchOwner = document.getElementById("vendor-batch-owner");
        const batchStatus = document.getElementById("vendor-batch-status");
        const vendorRows = new Map();
        async function vendorApi(path, body) {
          const response = await fetch(path, { method:body ? "POST" : "GET", redirect:"error",
            headers:body ? {"content-type":"application/json"} : {},
            body:body ? JSON.stringify(body) : undefined, signal:AbortSignal.timeout(20000) });
          const result = await response.json();
          if (!response.ok) throw Object.assign(new Error(result.error?.message || result.error || "Registration request failed (HTTP " + response.status + ")."), {code:result.error?.code});
          return result;
        }
        function selectedVendors() {
          return vendorItems.filter(v => vendorRows.get(v.provider_id)?.select.checked).map(v => ({
            ...v, recovery_hash:vendorRows.get(v.provider_id).recovery.value.trim()
          }));
        }
        function updateVendorControls() {
          const count = selectedVendors().length;
          batchStart.textContent = "Register selected (" + count + "/5)";
          batchStart.disabled = vendorBatchBusy || count < 1 || count > 5;
          batchStop.disabled = !vendorBatchBusy;
          batchOwner.disabled = vendorBatchBusy;
          for (const [id, row] of vendorRows) {
            const registered = Boolean(vendorItems.find(v => v.provider_id === id)?.agent_id);
            row.select.disabled = vendorBatchBusy || registered;
            row.button.disabled = vendorBatchBusy || registered;
            row.recovery.disabled = vendorBatchBusy || registered;
          }
        }
        async function loadVendorIdentities() {
          const card = document.getElementById("vendor-identities-card");
          const list = document.getElementById("vendor-identities-list");
          try {
            const payload = await vendorApi("/agent-router/erc8004/vendors");
            card.hidden = false;
            vendorItems = [...new Map((payload.vendors || []).map(v => [v.provider_id, v])).values()];
            list.replaceChildren(); vendorRows.clear();
            for (const vendor of vendorItems) {
              const row = document.createElement("div");
              row.className = "dash-action";
              const copy = document.createElement("span");
              const label = document.createElement("label");
              const select = document.createElement("input");
              select.type = "checkbox";
              select.setAttribute("aria-label", "Select " + vendor.provider_id);
              select.addEventListener("change", updateVendorControls);
              const title = document.createElement("b");
              title.textContent = (vendor.title || vendor.provider_id) + " · " + vendor.provider_id;
              label.append(select, title);
              const detail = document.createElement("small");
              detail.textContent = vendor.service_count + " service(s)" + (vendor.agent_id ? " · Agent #" + vendor.agent_id : " · not registered");
              const status = document.createElement("p");
              status.className = "dash-status";
              status.setAttribute("role","status");
              const recoveryBox = document.createElement("details");
              const summary = document.createElement("summary");
              summary.textContent = "Recover an already submitted transaction";
              const recovery = document.createElement("input");
              recovery.placeholder = "0x… transaction hash (optional)";
              recovery.setAttribute("aria-label", "Transaction hash for " + vendor.provider_id);
              recovery.maxLength = 66;
              const note = document.createElement("small");
              note.textContent = "Only receipt verification is performed when a hash is supplied. Never enter a private key.";
              recoveryBox.append(summary, recovery, note);
              copy.append(label, detail, status, recoveryBox);
              const button = document.createElement("button");
              button.className = "dash-button";
              button.type = "button";
              button.dataset.vendorRegistration = vendor.registration_endpoint;
              button.textContent = vendor.agent_id ? "Registered #" + vendor.agent_id : "Register Vendor";
              button.addEventListener("click", () => startVendorBatch([{...vendor, recovery_hash:recovery.value.trim()}]));
              row.append(copy, button); list.append(row);
              vendorRows.set(vendor.provider_id, {select,button,status,recovery,detail});
            }
            if (!vendorItems.length) list.textContent = "No Vendor identities are available for this account.";
            updateVendorControls();
          } catch (error) {
            batchStatus.textContent = error.message;
            batchStatus.className = "dash-status error";
          }
        }
        async function startVendorBatch(items) {
          if (vendorBatchBusy) return;
          vendorBatchBusy = true; updateVendorControls();
          batchStatus.className = "dash-status";
          batchStatus.textContent = "Preparing " + items.length + " Vendor(s) for owner " + batchOwner.value.trim() + ". Confirm each transaction in your wallet.";
          try {
            if (!navigator.locks) throw new Error("This browser cannot safely coordinate registration tabs. Use a current Chrome browser.");
            await navigator.locks.request("ar-vendor-registration", {ifAvailable:true}, async lock => {
              if (!lock) throw new Error("Another tab is registering Vendors. Finish or pause it before continuing here.");
              vendorBatch = (${createVendorRegistrationBatch.toString()})({
                wallet:window.ethereum, api:vendorApi,
                journal:{
                  get:key => { const value = localStorage.getItem(key); return value ? JSON.parse(value) : null; },
                  set:(key,value) => {
                    const json = JSON.stringify(value);
                    localStorage.setItem(key,json);
                    if (localStorage.getItem(key) !== json) throw new Error("Browser storage is unavailable. Registration stopped safely.");
                  }
                },
                onUpdate:update => {
                  const row = vendorRows.get(update.provider_id);
                  const text = update.index + "/" + update.total + " · " + update.provider_id + " · " + update.message;
                  batchStatus.textContent = text;
                  batchStatus.className = update.status === "paused" ? "dash-status error" : "dash-status";
                  row.status.textContent = update.message;
                  if (update.tx_hash) {
                    const link = document.createElement("a");
                    link.href = "https://bscscan.com/tx/" + update.tx_hash;
                    link.target = "_blank"; link.rel = "noopener noreferrer";
                    link.textContent = " View transaction";
                    row.status.append(link);
                  }
                  if (["registered","already_registered"].includes(update.status)) {
                    row.select.checked = false;
                    row.button.textContent = update.message;
                    // Server-verified result; refresh from server on next page load.
                    vendorItems.find(v => v.provider_id === update.provider_id).agent_id = "verified";
                  }
                }
              });
              const result = await vendorBatch.run(items, batchOwner.value.trim());
              if (result.status === "completed") batchStatus.textContent = "Batch completed. Each Vendor result and transaction appears below.";
            });
          } catch (error) {
            batchStatus.className = "dash-status error";
            batchStatus.textContent = error.message || "Registration paused.";
          } finally {
            vendorBatch = null; vendorBatchBusy = false; updateVendorControls();
          }
        }
        batchStart.addEventListener("click", () => startVendorBatch(selectedVendors()));
        batchStop.addEventListener("click", () => {
          vendorBatch?.stop();
          batchStatus.textContent = "Pause requested. Cancel any open wallet prompt. An already submitted transaction can still confirm.";
        });
        // The deposit needs confirmations before it can be credited, so the
        // claim is retried rather than failing the moment the block is young.
        async function signDepositOwnership(challenge, status) {
          if (!window.ethereum) {
            throw new Error("Connect the wallet that sent this first deposit. Approve only inside your wallet and never paste wallet secrets.");
          }
          if (!challenge?.message || !challenge?.nonce || !challenge?.sender_address) {
            throw new Error("AgentRouter returned an incomplete wallet ownership challenge.");
          }
          await ensureChain(challenge.chain_id);
          status.textContent = "Confirm wallet ownership (no gas or transaction)…";
          const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
          const sender = String(challenge.sender_address).toLowerCase();
          const connected = (accounts || []).find((address) => String(address).toLowerCase() === sender);
          if (!connected) {
            throw new Error("Switch your browser wallet to the address that sent this deposit: " + sender.slice(0, 8) + "…" + sender.slice(-6));
          }
          const signature = await window.ethereum.request({
            method: "personal_sign",
            params: [challenge.message, connected]
          });
          return { nonce: challenge.nonce, signature, sender_address: connected };
        }
        async function claimWhenConfirmed(txHash, status) {
          let ownershipProof = null;
          for (let attempt = 0; attempt < 40; attempt++) {
            const response = await fetch("/account/credits/deposit", {
              method:"POST",
              headers:{ "content-type":"application/json" },
              body:JSON.stringify({ tx_hash: txHash, ...(ownershipProof ? { ownership_proof: ownershipProof } : {}) })
            });
            const payload = await response.json();
            if (response.ok) return payload;
            const errorCode = payload.error?.code || payload.code;
            if (errorCode === "DEPOSIT_OWNERSHIP_PROOF_REQUIRED") {
              ownershipProof = await signDepositOwnership(payload.ownership_challenge, status);
              status.textContent = "Wallet ownership confirmed. Crediting deposit…";
              continue;
            }
            if (errorCode !== "DEPOSIT_NOT_CONFIRMED" && errorCode !== "DEPOSIT_NOT_FOUND") {
              throw new Error(payload.error?.message || payload.message || "Deposit could not be claimed.");
            }
            status.textContent = "Waiting for confirmations… (" + (attempt + 1) + ")";
            await new Promise((resolve) => setTimeout(resolve, 3000));
          }
          throw new Error("The deposit has not confirmed yet. Submit the transaction hash below in a moment.");
        }
        // The code has to carry the amount on screen. A stale code is a payment
        // for the wrong number, which nothing downstream can correct.
        function refreshDepositQr() {
          const img = document.getElementById("deposit-qr-img");
          if (!img || !depositInfo) return;
          const token = document.getElementById("buy-token").value || depositInfo.accepted[0].symbol;
          const amount = document.getElementById("buy-amount").value;
          const query = "?token=" + encodeURIComponent(token) + (Number(amount) > 0 ? "&amount=" + encodeURIComponent(amount) : "");
          img.src = "/account/credits/deposit.svg" + query;
        }
        document.getElementById("buy-amount").addEventListener("change", refreshDepositQr);
        document.getElementById("buy-token").addEventListener("change", refreshDepositQr);
        document.getElementById("buy-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const status = document.getElementById("account-status");
          const button = document.getElementById("buy-button");
          status.className = "dash-status";
          if (!window.ethereum) {
            status.className = "dash-status error";
            status.textContent = "No browser wallet detected. Send the tokens from any wallet, then submit the transaction hash below.";
            return;
          }
          button.disabled = true;
          try {
            const token = depositInfo.accepted.find((a) => a.symbol === document.getElementById("buy-token").value);
            const atomic = toAtomic(document.getElementById("buy-amount").value, token.decimals);
            if (atomic <= 0n) throw new Error("Enter an amount above zero.");
            status.textContent = "Connecting wallet…";
            const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
            await ensureChain(depositInfo.chain_id);
            status.textContent = "Confirm the transfer in your wallet…";
            const txHash = await window.ethereum.request({ method: "eth_sendTransaction", params: [{
              from: account,
              to: token.address,
              data: encodeTransfer(depositInfo.treasury_address, atomic),
              value: "0x0"
            }] });
            status.textContent = "Sent. Waiting for confirmations…";
            const claimed = await claimWhenConfirmed(txHash, status);
            status.textContent = "Credited " + claimed.deposit.amount + " " + claimed.deposit.asset + ".";
            await loadDashboard();
          } catch (error) {
            status.className = "dash-status error";
            // 4001 is the user declining in their wallet, which is a decision,
            // not a failure to report as one.
            status.textContent = error?.code === 4001 ? "Payment cancelled." : (error.message || "Payment failed.");
          } finally { button.disabled = false; }
        });
        document.getElementById("deposit-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const status = document.getElementById("account-status");
          const button = document.getElementById("deposit-button");
          button.disabled = true;
          status.className = "dash-status";
          status.textContent = "Reading the transaction from the chain…";
          try {
            const payload = await claimWhenConfirmed(document.getElementById("deposit-tx").value.trim(), status);
            status.textContent = "Credited " + payload.deposit.amount + " " + payload.deposit.asset + ".";
            document.getElementById("deposit-tx").value = "";
            await loadDashboard();
          } catch (error) { status.className = "dash-status error"; status.textContent = error.message; }
          finally { button.disabled = false; }
        });
        document.getElementById("limit-form").addEventListener("submit", async (event) => {
          event.preventDefault();
          const status = document.getElementById("limit-status");
          const button = document.getElementById("limit-button");
          button.disabled = true;
          status.className = "dash-status";
          try {
            const response = await fetch("/account/credits/limit", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ max_price_per_call: document.getElementById("limit-amount").value }) });
            const payload = await response.json();
            if (!response.ok) throw new Error(payload.error?.message || "Could not save the limit.");
            status.textContent = "Any single call may now spend up to $" + payload.max_price_per_call + ".";
            await loadDashboard();
          } catch (error) { status.className = "dash-status error"; status.textContent = error.message; }
          finally { button.disabled = false; }
        });
            loadDepositInstructions();
            loadPlatformIdentity().catch(() => {});
            loadVendorIdentities().catch(() => {});
        document.getElementById("api-key-form").addEventListener("submit", async (event) => { event.preventDefault(); const response = await fetch("/account/api-keys", { method:"POST", headers:{ "content-type":"application/json" }, body:JSON.stringify({ label:document.getElementById("api-key-label").value }) }); const payload = await response.json(); if (!response.ok) { alert(payload.error?.message || "Key creation failed."); return; } document.getElementById("api-key-value").textContent = payload.api_key; document.getElementById("api-key-result").hidden = false; await loadDashboard(); });
        document.getElementById("copy-api-key").addEventListener("click", async () => { await navigator.clipboard.writeText(document.getElementById("api-key-value").textContent); document.getElementById("copy-api-key").textContent = "Copied"; });
                for (const listId of ["agent-connection-list", "api-key-list"]) document.getElementById(listId).addEventListener("click", async (event) => { const button = event.target.closest("[data-revoke-key]"); if (!button) return; button.disabled = true; const response = await fetch("/account/api-keys/" + encodeURIComponent(button.dataset.revokeKey) + "/revoke", { method:"POST" }); const payload = await response.json(); if (!response.ok) { alert(payload.error?.message || "Could not disconnect this agent."); button.disabled = false; return; } await loadDashboard(); });
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
        <a href="/bnb">BNB Agents</a>
        <a href="/research">Research</a>
        <div class="nav-has-menu">
          <a href="/agent" class="nav-trigger">Services <span class="nav-caret">▾</span></a>
          <div class="nav-menu">
            <a class="nav-menu-item" href="/agent?category=Data">
              <span class="nav-menu-icon">◉</span>
              <span class="nav-menu-text"><b>Data Services</b><small>Market data, token prices, on-chain metrics</small></span>
            </a>
            <a class="nav-menu-item" href="/agent?category=Crypto">
              <span class="nav-menu-icon">◈</span>
              <span class="nav-menu-text"><b>Crypto &amp; Derivatives</b><small>Perp liquidations, funding rates, OHLC</small></span>
            </a>
            <a class="nav-menu-item" href="/agent?category=On-chain">
              <span class="nav-menu-icon">◯</span>
              <span class="nav-menu-text"><b>On-chain Analytics</b><small>Wallet, transactions, liquidation heatmaps</small></span>
            </a>
            <a class="nav-menu-item" href="/agent?category=Market%20Data">
              <span class="nav-menu-icon">◍</span>
              <span class="nav-menu-text"><b>Market Data</b><small>ETF flows, indices, premium &amp; discount</small></span>
            </a>
            <a class="nav-menu-item" href="/agent">
              <span class="nav-menu-icon">▣</span>
              <span class="nav-menu-text"><b>Browse All</b><small>224 callable services, search &amp; sort</small></span>
            </a>
          </div>
        </div>
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
    <div class="shell footer-inner">
      <span class="nav-brand">AgentRouter <span class="prompt">&gt;<span class="caret">_</span></span></span>
      <p class="tagline">Agent-native API routing layer. One Install. All your agent needs.</p>
    </div>
  </footer>
  ${authModalHtml({ auth, returnTo: auth.loginReturnTo || "/" })}
  <script data-agentrouter-spa>${clientRouterScript()}</script>
</body>
</html>`;
}

// Kept only as source archaeology while the new page shell is rolled out. It is not emitted.
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
      const reputation = service.reputation || {};
      const priceValue = service.price_label
        ? escapeHtml(service.price_label)
        : formatUsdc(Number(service.price || 0)) + " " + escapeHtml(service.currency || "USDC");
      const selected = options.selected ? " selected" : "";
      const detailHref = "/agent-router/service?service_id=" + encodeURIComponent(service.service_id);
      const tagName = options.link ? "a" : "article";
      const hrefAttr = options.link ? ' href="' + detailHref + '"' : "";
      return \`
        <\${tagName} class="api-card\${selected}" data-service-id="\${escapeAttr(service.service_id)}"\${hrefAttr}>
          <div class="api-top"><span class="type-badge">API</span>\${erc8004Badge(service.erc8004, options.link)}</div>
          <div class="api-heading">
            <div class="logo">\${escapeHtml(logo)}</div>
            <div>
              <h3>\${escapeHtml(title)}</h3>
              <div class="byline"><span>By \${escapeHtml(service.provider_id || "provider")}</span><span>Updated now</span></div>
            </div>
          </div>
          <p class="api-description">\${escapeHtml(truncate(description, 132))}</p>
          \${service.match_reasons?.length ? '<small class="match-reason">Matched: ' + escapeHtml(service.match_reasons.join(", ")) + '</small>' : ''}
          <div class="api-core-metrics">
            <div class="api-price"><span>Price</span><strong>\${priceValue}</strong><small>Per call</small></div>
            <div class="api-trust"><span class="trust-mark" aria-hidden="true">✓</span><div><strong>\${formatTrustScore(service.trust_score)}</strong><small>Trust score</small></div></div>
          </div>
          <div class="api-performance" aria-label="Service performance">
            <div><strong>\${formatCount(service.total_calls)}</strong><span>Calls</span></div>
            <div><strong>\${formatSuccessRate(service.success_rate)}</strong><span>Success</span></div>
            <div><strong>\${formatSuccessRate(reputation.intent_fit_rate)}</strong><span>Intent fit</span></div>
            <div><strong>\${formatSuccessRate(reputation.usefulness_rate)}</strong><span>Useful</span></div>
          </div>
          <div class="api-card-footer">
            <div class="pill-row">\${renderPills(service.capabilities || [])}</div>
            \${options.human ? '<div class="actions"><a class="button ghost" href="/studio?service_id=' + encodeURIComponent(service.service_id) + '">Edit</a><a class="button" href="/agent-router/service?service_id=' + encodeURIComponent(service.service_id) + '">Details</a></div>' : '<span class="detail-link">View details →</span>'}
          </div>
        </\${tagName}>
      \`;
    }
    // An on-chain identity is only worth showing if it resolves to something a
    // reader can check, so the badge links to the registry entry rather than
    // just asserting "ERC-8004". Inside a card that is itself an anchor it must
    // stay a span: nested anchors are invalid HTML, and the parser unwinds them
    // into a card whose contents escape the card.
    function erc8004Badge(identity, insideLink) {
      if (!identity || !identity.agent_id) return "";
      const label = "ERC-8004 #" + escapeHtml(identity.agent_id);
      if (insideLink || !identity.explorer_url) {
        return '<span class="chain-badge" title="Registered on-chain as agent #' + escapeAttr(identity.agent_id) + '">' + label + '</span>';
      }
      return '<a class="chain-badge" href="' + escapeAttr(identity.explorer_url) +
        '" target="_blank" rel="noopener noreferrer" title="View this agent on 8004scan">' + label + ' \u2197</a>';
    }
    function renderPills(tags) {
      const visible = tags.slice(0, 4);
      return visible.map((tag) => '<span class="pill">' + escapeHtml(tag) + '</span>').join("") +
        (tags.length > visible.length ? '<span class="pill">+' + (tags.length - visible.length) + '</span>' : "");
    }
    function serviceRevenue(service) { return Number(service.price || 0) * Number(service.total_calls || 0); }
    function formatTrustScore(value) {
      if (value == null || Number.isNaN(Number(value))) return "No feedback";
      return Math.round(Math.max(0, Math.min(1, Number(value))) * 100) + "/100";
    }
    function formatSuccessRate(value) {
      if (value == null || Number.isNaN(Number(value))) return "--";
      return Math.round(Math.max(0, Math.min(1, Number(value))) * 100) + "%";
    }
    function formatCount(value) {
      if (value == null) return "--";
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
