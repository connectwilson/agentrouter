// Shared visual primitives and progressive client-side navigation for first-party pages.
// The server remains the source of truth for every route; this only avoids a document reload
// when moving between already-supported AgentRouter HTML pages.

export function naiveDesignSystemStyles() {
  return `
    @font-face{font-family:GeistPixelCircle;src:url("/assets/fonts/GeistPixel_Circle.woff2") format("woff2");font-display:swap}
    @font-face{font-family:GeistPixelSquare;src:url("/assets/fonts/GeistPixel_Square.woff2") format("woff2");font-display:swap}
    :root{color-scheme:dark;--ar-bg:#000000;--ar-card:#161616;--ar-card-hover:#1d1d1d;--ar-elevated:#0d0d0d;--ar-text:#ffffff;--ar-secondary:#b4b4b4;--ar-muted:#8a8a8a;--ar-border:rgb(255 255 255 / .07);--ar-border-light:rgb(255 255 255 / .14);--ar-button-small:32px;--ar-button-default:40px;--ar-button-large:48px;--ar-display:GeistPixelCircle,ui-monospace,monospace;--ar-sans:GeistPixelSquare,Arial,sans-serif;--ar-mono:ui-monospace,"SFMono-Regular",Menlo,monospace;--color-ink:var(--ar-text);--color-muted:var(--ar-secondary);--color-faint:var(--ar-muted);--color-line:var(--ar-border);--color-strong-line:var(--ar-border-light);--color-panel:var(--ar-card);--color-bg:var(--ar-bg);--color-soft:var(--ar-elevated);--color-code:var(--ar-elevated);--color-accent:var(--ar-text);--color-accent-ink:#000;--accent:#fff;--green:#fff;--red:#fff;--blue:#fff;--radius:0;--font-body:var(--ar-sans);--font-mono:var(--ar-mono)}
    *,*:before,*:after{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--ar-bg);color:var(--ar-text)}body[data-agentrouter-app]{font:15px/1.5 var(--ar-sans);overflow-x:hidden}a{color:inherit;text-decoration:none}button,input,select,textarea{font:inherit}button{cursor:pointer}h1,h2,h3,h4,p{margin-top:0}h1,h2,h3{font-family:var(--ar-display);font-weight:400;letter-spacing:-.045em}p{color:var(--ar-secondary)}
    .shell{width:min(1250px,calc(100% - 48px));margin:auto}.wide-shell{max-width:1250px}.topbar{position:sticky;top:0;z-index:20;height:64px;border:0;border-bottom:1px solid var(--ar-border);background:rgb(0 0 0 /.88);backdrop-filter:blur(14px)}.topbar .shell{width:min(1440px,calc(100% - 48px));height:100%}.nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:28px;height:64px}.brand{display:inline-flex;align-items:center;min-height:32px;font-family:var(--ar-sans);font-size:18px;font-weight:400;letter-spacing:-.04em}.brand i{background:#fff!important;border-radius:0!important;box-shadow:none!important}.brand-icon{display:none}.brand-prompt{color:var(--ar-muted);font-family:var(--ar-mono);font-size:15px}.brand-caret{color:#fff}.nav-links{display:flex;align-items:center;gap:28px;color:var(--ar-secondary);font-family:var(--ar-mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase}.nav-links a{height:64px;display:grid;place-items:center;border-bottom:1px solid transparent}.nav-links a:hover{color:#fff;border-color:#fff}.auth-actions{justify-self:end;display:flex;align-items:center;gap:14px}.auth-link,.logout-link{justify-self:end;font:11px var(--ar-mono);letter-spacing:.08em;text-transform:uppercase}.auth-link{display:inline-grid;place-items:center;height:var(--ar-button-small);padding:0 14px;border:1px solid var(--ar-border-light);border-radius:0;background:#fff;color:#000}.auth-link:hover{background:#d7d7d7}.logout-link{color:var(--ar-secondary)}
    .button,.hero-cta,.path-action,.dash-button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:var(--ar-button-default);padding:0 16px;border:1px solid #fff;border-radius:0;background:#fff;color:#000;font:11px var(--ar-mono);letter-spacing:.08em;text-transform:uppercase}.button::before,.hero-cta::before,.path-action::before{content:">";margin:0}.button.primary{background:#fff;border-color:#fff;color:#000}.button.ghost,.button.secondary,.dash-button.secondary{background:transparent;color:#fff;border-color:var(--ar-border-light)}.button:hover,.hero-cta:hover,.path-action:hover,.dash-button:hover{background:#d7d7d7;border-color:#d7d7d7;color:#000}.hero-cta{min-height:var(--ar-button-large);padding:0 24px}.button.block{width:100%}
    .hero{min-height:auto;padding:0 0 88px;background:#000}.dot-grid{display:none}.hero-center{display:grid;justify-items:center;text-align:center;padding-top:118px}.eyebrow,.path-label,.dash-kicker{font:10px var(--ar-mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ar-muted)}.hero h1{max-width:920px;margin:14px 0 18px;font-size:clamp(44px,5vw,64px);line-height:1.04}.lead{max-width:690px;margin:0;font-size:16px;line-height:1.65}.install-strip{width:min(760px,100%);margin-top:44px;overflow:hidden;border:1px solid var(--ar-border-light);border-radius:0;background:var(--ar-elevated);box-shadow:none}.install-top{height:42px;padding:0 18px;border-bottom:1px solid var(--ar-border);display:flex;align-items:center;justify-content:space-between}.status-dots{gap:7px}.status-dots i{width:8px;height:8px;background:#777!important;border-radius:50%}.install-label,.install-note,.client-row{font-family:var(--ar-mono);font-size:11px;color:var(--ar-muted)}.install-command{min-height:68px;padding:0 18px;display:grid;grid-template-columns:1fr 72px;gap:14px;align-items:center}.install-strip code{font:13px var(--ar-mono);color:#fff}.install-strip .prompt{color:#fff}.install-strip button{height:30px;border:1px solid var(--ar-border-light);border-radius:0;background:transparent;color:#fff;font:10px var(--ar-mono);letter-spacing:.08em;text-transform:uppercase}.install-note{margin:14px 0 0}.client-row{margin-top:18px;display:flex;justify-content:center;align-items:center;gap:14px}.client-logos{display:flex;gap:6px}.client-logo{width:28px;height:28px;display:grid;place-items:center;border:1px solid var(--ar-border);border-radius:0;background:var(--ar-elevated)}.client-logo img{width:17px;height:17px;filter:grayscale(1);opacity:.8}.client-logo span{display:none}.hero-paths,.landing-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;width:100%;margin-top:64px;text-align:left}.path-card,.card,.home-panel,.overview,.dash-panel,.panel,.output,.playground,.uicard,.brief-box,.dash-action{border:1px solid var(--ar-border);border-radius:0;background:var(--ar-card);box-shadow:none}.path-card{min-height:230px;padding:24px;display:flex;flex-direction:column;align-items:flex-start;justify-content:flex-start}.path-card h2,.card h2{margin:14px 0 9px;font-size:24px;line-height:1.12}.path-card p,.card p{font-size:14px;line-height:1.55}.path-action{margin-top:auto;min-height:32px;padding:0 11px;font-size:10px;background:transparent;color:#fff;border-color:var(--ar-border-light)}.path-card:hover,.card:hover{background:var(--ar-card-hover);border-color:var(--ar-border-light);transform:none}.path-card:nth-child(3) .path-action{background:#fff;border-color:#fff;color:#000}
    main{padding:0 0 76px}.stats-section{padding-top:88px}.stats-heading{display:flex;justify-content:space-between;gap:24px;margin-bottom:40px}.stats-heading h2{margin:8px 0;font-size:38px}.stats-heading p{margin:0}.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:64px}.stat-block{min-height:182px;padding:20px;border-top:1px solid var(--ar-border)}.stat-block span,.stat-block small{color:var(--ar-muted);font-size:11px}.stat-block strong{display:block;margin-top:24px;font:44px/1 var(--ar-display);letter-spacing:-.05em}.spark{height:36px;display:flex;align-items:end;gap:3px;margin-top:20px}.spark i{width:4px;background:#fff!important;border-radius:0}.network-tables{display:grid;grid-template-columns:1fr 1fr;gap:48px}.table-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px}.table-head h3{font:24px var(--ar-display)}.table-head a{font:10px var(--ar-mono);color:var(--ar-secondary);letter-spacing:.08em;text-transform:uppercase}.service-table{border-top:1px solid var(--ar-border)}.service-row{display:grid;grid-template-columns:1.3fr .8fr 72px;gap:12px;min-height:56px;align-items:center;border-bottom:1px solid var(--ar-border);color:var(--ar-secondary);font-size:13px}.service-row b{color:#fff;font-weight:400}.service-row mark,.pill,.type-badge,.dash-badge{display:inline-block;padding:3px 6px;border:1px solid var(--ar-border);border-radius:0;background:transparent;color:var(--ar-secondary);font:9px var(--ar-mono)}.overview-wrap{padding-top:70px}.overview{display:grid;grid-template-columns:1fr 1fr;gap:28px;padding:28px}.overview h2{font-size:32px}.step-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}.step-row div{padding:14px;border:1px solid var(--ar-border);background:var(--ar-elevated)}.step-row b{font:22px var(--ar-display)}.step-row span{display:block;color:var(--ar-secondary);font-size:12px}
    .app-header{padding:66px 0 30px;border-bottom:1px solid var(--ar-border)}.app-header::before{display:none}.app-title{display:flex;justify-content:space-between;align-items:end;gap:24px}.app-title h1{margin:8px 0;font-size:44px}.section-nav{display:flex;border:1px solid var(--ar-border)}.section-nav a{padding:9px 12px;border-right:1px solid var(--ar-border);color:var(--ar-secondary);font:10px var(--ar-mono);letter-spacing:.08em;text-transform:uppercase}.section-nav a:last-child{border:0}.section-nav a.active{background:#fff;color:#000}.agent-market,.provider-console{padding-top:34px}.market-hero,.provider-hero{display:grid;grid-template-columns:1fr minmax(320px,.7fr);gap:24px;align-items:end;margin-bottom:26px}.market-hero h2,.provider-hero h2{font-size:40px;line-height:1.08}.metric,.metrics,.brief-box{border:1px solid var(--ar-border);border-radius:0;background:var(--ar-elevated);color:#fff}.metrics{display:grid;grid-template-columns:repeat(4,1fr)}.metric{padding:14px}.metric span{display:block;color:var(--ar-muted);font-size:10px}.metric strong{font:26px var(--ar-display)}
    input,select,textarea,.input,.select,.textarea{width:100%;border:1px solid var(--ar-border-light);border-radius:0;background:var(--ar-elevated);color:#fff;padding:10px 11px;outline:0}input:focus,select:focus,textarea:focus,.input:focus,.select:focus,.textarea:focus{border-color:#fff;box-shadow:0 0 0 1px #fff}.platform,.tab,.query{border:1px solid var(--ar-border);border-radius:0;background:var(--ar-elevated);color:var(--ar-secondary)}.platform.active,.tab.active{background:#fff;border-color:#fff;color:#000}.notice{border:1px solid var(--ar-border-light);border-radius:0;background:var(--ar-elevated);color:var(--ar-secondary)}dialog,.auth-modal{border:1px solid var(--ar-border-light);border-radius:0;background:var(--ar-card);color:#fff}.footer{padding:28px 0;border-top:1px solid var(--ar-border);background:#000;color:var(--ar-muted);font:10px var(--ar-mono);letter-spacing:.05em}.footer a{color:var(--ar-secondary)}
    @media(max-width:850px){.shell{width:min(100% - 32px,1250px)}.nav{grid-template-columns:1fr auto}.nav-links{display:none}.hero-center{padding-top:78px}.hero-paths,.landing-grid,.stats-grid,.network-tables,.overview,.market-hero,.provider-hero{grid-template-columns:1fr}.stats-grid{gap:0}.app-title{align-items:flex-start;flex-direction:column}.client-row{flex-wrap:wrap}.install-command{grid-template-columns:1fr}.install-strip button{display:none}}
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
