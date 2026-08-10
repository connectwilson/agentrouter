// Shared visual primitives and progressive client-side navigation for first-party pages.
// The server remains the source of truth for every route; this only avoids a document reload
// when moving between already-supported AgentRouter HTML pages.

export function naiveDesignSystemStyles() {
  return `
    :root {
      color-scheme:dark;
      --ar-bg:#000000;
      --ar-card:#161616;
      --ar-card-hover:#1d1d1d;
      --ar-elevated:#0d0d0d;
      --ar-text:#ffffff;
      --ar-secondary:#b4b4b4;
      --ar-muted:#8a8a8a;
      --ar-border:rgb(255 255 255 / .07);
      --ar-border-light:rgb(255 255 255 / .14);
      --ar-display:"GeistPixelCircle", "Geist Mono", ui-monospace, monospace;
      --ar-sans:"Geist", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --ar-mono:"Geist Mono", "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
      --color-ink:var(--ar-text);
      --color-muted:var(--ar-secondary);
      --color-faint:var(--ar-muted);
      --color-line:var(--ar-border);
      --color-strong-line:var(--ar-border-light);
      --color-panel:var(--ar-card);
      --color-bg:var(--ar-bg);
      --color-soft:var(--ar-elevated);
      --color-code:#0d0d0d;
      --color-accent:var(--ar-text);
      --color-accent-cool:#2a2a2a;
      --color-accent-ink:#000000;
      --font-body:var(--ar-sans);
      --font-mono:var(--ar-mono);
    }
    html { background:var(--ar-bg); }
    body[data-agentrouter-app] { margin:0; min-height:100vh; background:var(--ar-bg); color:var(--ar-text); font-family:var(--ar-sans); }
    body[data-agentrouter-app] a { text-decoration:none; }
    body[data-agentrouter-app] h1, body[data-agentrouter-app] h2, body[data-agentrouter-app] h3 { font-family:var(--ar-display); font-weight:400; letter-spacing:-.04em; }
    body[data-agentrouter-app] .topbar, body[data-agentrouter-app] header { border-top:0; border-bottom-color:var(--ar-border); background:rgb(0 0 0 / .72); }
    body[data-agentrouter-app] .topbar { min-height:64px; }
    body[data-agentrouter-app] .nav { min-height:64px; }
    body[data-agentrouter-app] .brand, body[data-agentrouter-app] .brand-word { color:var(--ar-text); font-family:var(--ar-sans); font-weight:500; }
    body[data-agentrouter-app] .brand-icon { display:none; }
    body[data-agentrouter-app] .brand-word { font-size:18px; letter-spacing:-.04em; }
    body[data-agentrouter-app] .brand-prompt { color:var(--ar-muted); font-family:var(--ar-mono); font-weight:400; }
    body[data-agentrouter-app] .brand-caret { color:var(--ar-text); animation:ar-blink 1.1s steps(1) infinite; }
    body[data-agentrouter-app] .nav-links, body[data-agentrouter-app] .nav-links a, body[data-agentrouter-app] .logout-link { color:var(--ar-secondary); font-family:var(--ar-mono); font-size:11px; letter-spacing:.08em; text-transform:uppercase; }
    body[data-agentrouter-app] .nav-links a:hover, body[data-agentrouter-app] .nav-links a:focus-visible { color:var(--ar-text); border-bottom-color:var(--ar-text); }
    body[data-agentrouter-app] .auth-link, body[data-agentrouter-app] .button, body[data-agentrouter-app] .hero-cta, body[data-agentrouter-app] .path-action, body[data-agentrouter-app] .dash-button { border-radius:0; border-color:var(--ar-border-light); background:var(--ar-text); color:#000; font-family:var(--ar-mono); font-size:11px; font-weight:500; letter-spacing:.08em; text-transform:uppercase; }
    body[data-agentrouter-app] .auth-link:hover, body[data-agentrouter-app] .button:hover, body[data-agentrouter-app] .hero-cta:hover, body[data-agentrouter-app] .path-action:hover { background:#e6e6e6; border-color:#e6e6e6; }
    body[data-agentrouter-app] .button.ghost, body[data-agentrouter-app] .button.secondary, body[data-agentrouter-app] .dash-button.secondary { background:transparent; color:var(--ar-text); border-color:var(--ar-border-light); }
    body[data-agentrouter-app] .hero, body[data-agentrouter-app] .app-header { background:var(--ar-bg); }
    body[data-agentrouter-app] .dot-grid, body[data-agentrouter-app] .app-header::before { border-color:var(--ar-border); background-image:radial-gradient(rgb(255 255 255 / .28) .7px, transparent .7px); }
    body[data-agentrouter-app] .lead, body[data-agentrouter-app] p, body[data-agentrouter-app] .install-note { color:var(--ar-secondary); }
    body[data-agentrouter-app] .install-strip, body[data-agentrouter-app] .code-preview, body[data-agentrouter-app] pre { border-radius:0; border-color:var(--ar-border-light); background:var(--ar-elevated); box-shadow:none; }
    body[data-agentrouter-app] .path-card, body[data-agentrouter-app] .card, body[data-agentrouter-app] .home-panel, body[data-agentrouter-app] .overview, body[data-agentrouter-app] .dash-panel, body[data-agentrouter-app] .panel, body[data-agentrouter-app] form, body[data-agentrouter-app] .output, body[data-agentrouter-app] .playground { border-radius:0; border-color:var(--ar-border); background:var(--ar-card); box-shadow:none; }
    body[data-agentrouter-app] .path-card:hover, body[data-agentrouter-app] .card:hover, body[data-agentrouter-app] .api-card:hover, body[data-agentrouter-app] .api-card.selected { background:var(--ar-card-hover); border-color:var(--ar-border-light); box-shadow:none; transform:none; }
    body[data-agentrouter-app] .metric, body[data-agentrouter-app] .metrics, body[data-agentrouter-app] .step-row div, body[data-agentrouter-app] .uicard, body[data-agentrouter-app] .brief-box, body[data-agentrouter-app] .metric, body[data-agentrouter-app] .dash-action { border-color:var(--ar-border); border-radius:0; background:var(--ar-elevated); color:var(--ar-text); }
    body[data-agentrouter-app] input, body[data-agentrouter-app] select, body[data-agentrouter-app] textarea, body[data-agentrouter-app] .input, body[data-agentrouter-app] .select, body[data-agentrouter-app] .textarea { border-color:var(--ar-border-light); border-radius:0; background:var(--ar-elevated); color:var(--ar-text); }
    body[data-agentrouter-app] input:focus, body[data-agentrouter-app] select:focus, body[data-agentrouter-app] textarea:focus { border-color:var(--ar-text); box-shadow:0 0 0 2px rgb(255 255 255 / .16); }
    body[data-agentrouter-app] .footer { border-color:var(--ar-border); background:var(--ar-bg); color:var(--ar-muted); }
    body[data-agentrouter-app] .eyebrow, body[data-agentrouter-app] .dash-kicker, body[data-agentrouter-app] .path-label { color:var(--ar-muted); font-family:var(--ar-mono); font-size:11px; letter-spacing:.12em; }
    body[data-agentrouter-app] .type-badge, body[data-agentrouter-app] .pill, body[data-agentrouter-app] .stat-pill, body[data-agentrouter-app] .dash-badge { border-radius:0; border-color:var(--ar-border-light); background:var(--ar-elevated); color:var(--ar-secondary); }
    body[data-agentrouter-app] .auth-modal { border-radius:0; border-color:var(--ar-border-light); color:var(--ar-text); background:var(--ar-card); }
    body[data-agentrouter-app] .auth-modal-provider, body[data-agentrouter-app] .auth-modal-dev button { border-radius:0; border-color:var(--ar-border-light); color:var(--ar-text); background:var(--ar-elevated); }
    body[data-agentrouter-app] .auth-modal-dev button { background:var(--ar-text); color:#000; }
    html[data-agentrouter-navigating]::before { content:""; position:fixed; inset:0 0 auto; z-index:9999; height:2px; background:var(--ar-text); animation:ar-route .6s ease-in-out infinite; }
    @keyframes ar-blink { 50% { opacity:0; } }
    @keyframes ar-route { from { transform:translateX(-100%); width:38%; } to { transform:translateX(270%); width:38%; } }
    @media (max-width:700px) { body[data-agentrouter-app] .topbar .shell { padding:0 16px; } body[data-agentrouter-app] .nav-links { display:none; } }
  `;
}

export function clientRouterScript() {
  return `
    (() => {
      if (window.__agentRouterSpa) return;
      const router = window.__agentRouterSpa = {};
      const sameOrigin = (url) => url.origin === window.location.origin;
      const routable = (anchor, event) => {
        if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
        if (anchor.target === "_blank" || anchor.hasAttribute("download") || anchor.dataset.spa === "false" || anchor.dataset.authModalTrigger !== undefined) return false;
        const href = anchor.getAttribute("href");
        if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return false;
        const target = new URL(anchor.href, window.location.href);
        // Same-origin application pages are swapped in place; third-party links keep normal browser navigation.
        if (!sameOrigin(target) || target.pathname.startsWith("/auth/")) return false;
        return true;
      };
      const executePageScripts = (documentNode) => {
        const scripts = [...documentNode.body.querySelectorAll("script")];
        scripts.forEach((script) => script.remove());
        for (const script of scripts) {
          if (script.dataset.agentrouterSpa !== undefined || script.src) continue;
          try { new Function(script.textContent).call(window); } catch (error) { console.error("AgentRouter page script failed", error); }
        }
      };
      const replacePage = (markup, responseUrl, mode) => {
        const next = new DOMParser().parseFromString(markup, "text/html");
        if (!next.body?.hasAttribute("data-agentrouter-app")) { window.location.assign(responseUrl); return; }
        document.title = next.title || document.title;
        document.head.querySelectorAll("style[data-agentrouter-page-style]").forEach((style) => style.remove());
        next.head.querySelectorAll("style[data-agentrouter-page-style]").forEach((style) => {
          const copy = document.createElement("style");
          copy.dataset.agentrouterPageStyle = "";
          copy.textContent = style.textContent;
          document.head.append(copy);
        });
        const nextBody = document.importNode(next.body, true);
        document.body.replaceWith(nextBody);
        executePageScripts(document);
        if (mode === "push") history.pushState({}, "", responseUrl);
        window.scrollTo(0, 0);
      };
      router.navigate = async (href, mode = "push") => {
        const requested = new URL(href, window.location.href);
        if (!sameOrigin(requested)) { window.location.assign(requested.href); return; }
        document.documentElement.dataset.agentrouterNavigating = "";
        try {
          const response = await fetch(requested.href, { credentials:"same-origin", headers:{ accept:"text/html", "x-agentrouter-spa":"1" } });
          const contentType = response.headers.get("content-type") || "";
          if (!response.ok || !contentType.includes("text/html")) { window.location.assign(requested.href); return; }
          replacePage(await response.text(), response.url, mode);
        } catch {
          window.location.assign(requested.href);
        } finally {
          delete document.documentElement.dataset.agentrouterNavigating;
        }
      };
      document.addEventListener("click", (event) => {
        const anchor = event.target.closest("a[href]");
        if (!routable(anchor, event)) return;
        event.preventDefault();
        router.navigate(anchor.href);
      });
      window.addEventListener("popstate", () => router.navigate(window.location.href, "replace"));
    })();
  `;
}
