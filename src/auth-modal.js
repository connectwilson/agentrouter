function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function authModalHtml({ auth = {}, returnTo = "/" } = {}) {
  if (auth.user) return "";
  const safeReturnTo = String(returnTo || "/");
  const providers = auth.providers || [];
  const options = providers.map((provider) => {
    const href = `/auth/${encodeURIComponent(provider.id)}/start?return_to=${encodeURIComponent(safeReturnTo)}`;
    return provider.configured
      ? `<a class="auth-modal-provider" data-auth-provider="${escapeHtml(provider.id)}" href="${escapeHtml(href)}">Continue with ${escapeHtml(provider.label)}</a>`
      : `<div class="auth-modal-provider disabled"><strong>${escapeHtml(provider.label)}</strong><span>Sign-in is being configured.</span></div>`;
  }).join("");
  const devLogin = auth.devLogin
    ? `<form class="auth-modal-dev" data-auth-dev-form method="POST" action="/auth/dev/start?return_to=${encodeURIComponent(safeReturnTo)}">
        <button type="submit">Continue locally</button>
        <small>Available only in local development.</small>
      </form>`
    : "";
  return `
    <dialog class="auth-modal" id="auth-modal" aria-labelledby="auth-modal-title" data-login-modal-open="${auth.loginModal ? "true" : "false"}">
      <form method="dialog"><button class="auth-modal-close" aria-label="Close sign in">×</button></form>
      <div class="auth-modal-content">
        <span class="auth-modal-kicker">AgentRouter account</span>
        <h2 id="auth-modal-title">Welcome back</h2>
        <p>Sign in to continue to your AgentRouter account.</p>
        ${auth.loginError ? `<div class="auth-modal-error" role="alert">${escapeHtml(auth.loginError)}</div>` : ""}
        <div class="auth-modal-options">${options}${devLogin}</div>
        <small class="auth-modal-note">Authentication is handled by GitHub. AgentRouter never receives your GitHub password.</small>
      </div>
    </dialog>
    <script>
      (() => {
        const modal = document.getElementById("auth-modal");
        if (!modal) return;
        const fallbackReturnTo = ${JSON.stringify(safeReturnTo)};
        const setReturnTo = (returnTo) => {
          const target = returnTo || fallbackReturnTo;
          modal.querySelectorAll("[data-auth-provider]").forEach((link) => {
            link.href = "/auth/" + encodeURIComponent(link.dataset.authProvider) + "/start?return_to=" + encodeURIComponent(target);
          });
          const devForm = modal.querySelector("[data-auth-dev-form]");
          if (devForm) devForm.action = "/auth/dev/start?return_to=" + encodeURIComponent(target);
        };
        const clearLoginState = () => {
          const next = new URL(window.location.href);
          next.searchParams.delete("login");
          next.searchParams.delete("error");
          next.searchParams.delete("return_to");
          window.history.replaceState({}, "", next.pathname + next.search + next.hash);
        };
        document.querySelectorAll("[data-auth-modal-trigger]").forEach((trigger) => {
          trigger.addEventListener("click", (event) => {
            event.preventDefault();
            const returnTo = trigger.dataset.authReturnTo || window.location.pathname;
            setReturnTo(returnTo);
            const next = new URL(window.location.href);
            next.searchParams.set("login", "1");
            next.searchParams.set("return_to", returnTo);
            window.history.pushState({}, "", next.pathname + next.search + next.hash);
            if (!modal.open) modal.showModal();
          });
        });
        modal.addEventListener("click", (event) => {
          if (event.target === modal) modal.close();
        });
        modal.addEventListener("close", clearLoginState);
        if (modal.dataset.loginModalOpen === "true") modal.showModal();
      })();
    </script>`;
}

export function authModalStyles() {
  return `
    .auth-modal { width:min(100% - 32px, 480px); border:1px solid var(--color-line, #d9dcdf); border-radius:16px; padding:0; color:var(--color-ink, #17191b); background:var(--color-panel, #fff); box-shadow:0 24px 70px rgba(0,0,0,.24); }
    .auth-modal::backdrop { background:rgba(10,15,20,.55); backdrop-filter:blur(4px); }
    .auth-modal form[method="dialog"] { position:absolute; z-index:1; top:14px; right:14px; }
    .auth-modal-close { width:34px; height:34px; border:0; border-radius:50%; color:var(--color-muted, #6c7177); background:transparent; font-size:25px; line-height:1; cursor:pointer; }
    .auth-modal-close:hover, .auth-modal-close:focus-visible { color:var(--color-ink, #17191b); background:var(--color-soft, #f3f4f4); outline:0; }
    .auth-modal-content { display:grid; gap:12px; padding:46px 40px 36px; text-align:center; }
    .auth-modal-kicker { color:var(--color-muted, #6c7177); font-size:11px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
    .auth-modal h2 { margin:0; font-size:28px; letter-spacing:-.04em; line-height:1.1; }
    .auth-modal p { margin:0; color:var(--color-muted, #6c7177); font-size:14px; line-height:1.5; }
    .auth-modal-options { display:grid; gap:10px; margin-top:14px; }
    /* The surface has to follow the same theme the text does. This hardcoded
       #fff while the label read from --color-ink, which the dark app shell sets
       to white — so the sign-in button rendered white on white and was
       invisible. Anything painting a background next to a themed colour needs a
       token, not a literal. */
    .auth-modal-provider, .auth-modal-dev button { min-height:46px; width:100%; display:flex; align-items:center; justify-content:center; border:1px solid var(--color-line, #d9dcdf); border-radius:8px; padding:0 16px; color:var(--color-ink, #17191b); background:var(--color-soft, #fff); font:inherit; font-size:14px; font-weight:760; text-decoration:none; cursor:pointer; }
    .auth-modal-provider:hover, .auth-modal-provider:focus-visible { border-color:var(--color-strong-line, #aeb4b8); background:var(--color-hover, #fafafa); outline:0; }
    .auth-modal-provider.disabled { min-height:62px; justify-content:space-between; gap:14px; color:var(--color-muted, #6c7177); background:var(--color-soft, #f3f4f4); cursor:not-allowed; }
    .auth-modal-provider.disabled span { max-width:180px; font-size:11px; line-height:1.35; text-align:right; }
    .auth-modal-dev { display:grid; gap:7px; }
    .auth-modal-dev button { color:#fff; border-color:#111827; background:#111827; }
    .auth-modal-dev button:hover, .auth-modal-dev button:focus-visible { background:#272d38; border-color:#272d38; outline:0; }
    .auth-modal-dev small, .auth-modal-note { color:var(--color-muted, #6c7177); font-size:11px; line-height:1.45; }
    .auth-modal-note { margin-top:10px; }
    .auth-modal-error { border:1px solid #efb8b5; border-radius:8px; padding:10px 12px; color:#8c1d18; background:#fff6f6; font-size:12px; line-height:1.4; text-align:left; }
    @media (max-width:480px) { .auth-modal-content { padding:42px 24px 28px; } .auth-modal-provider.disabled { display:grid; justify-content:stretch; padding:12px 14px; } .auth-modal-provider.disabled span { max-width:none; text-align:left; overflow-wrap:anywhere; } }
  `;
}
