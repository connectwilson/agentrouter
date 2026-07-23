import { normalizeEndpoint, parseCapabilities, parseMaybeJson } from "./http-utils.js";
import { normalizeId, suggestCapabilities } from "./id-utils.js";
import { createHostedHttpProviderConfig, createStaticProviderConfig, deleteProviderConfig, writeProviderConfig } from "./provider-config.js";
import { findDuplicateService, registerService, unregisterService, validateService } from "./registry.js";
import { publicServiceRecord } from "./store.js";

export async function createProviderFromStudio(body, store, baseUrl, { user = null, ownerKey = "" } = {}) {
  const serviceId = normalizeId(body.service_id, body.title, "service");
  const providerId = normalizeId(body.provider_id, body.provider_name || body.title, "provider");
  const normalizedBody = {
    ...body,
    service_id: serviceId,
    provider_id: providerId
  };
  validateStudioInput(normalizedBody, store);
  const mode = normalizedBody.mode || "static-json";
  const common = {
    baseUrl,
    serviceId,
    providerId,
    title: normalizedBody.title,
    description: normalizedBody.description_for_agent,
    capabilities: parseCapabilities(normalizedBody.capabilities || suggestCapabilities(`${normalizedBody.title} ${normalizedBody.description_for_agent}`)),
    price: normalizedBody.price,
    sampleRequest: parseMaybeJson(normalizedBody.sample_request, "sample_request"),
    sampleData: parseMaybeJson(normalizedBody.sample_data, "sample_data"),
    summary: normalizedBody.summary,
    payoutAddress: normalizedBody.payout_address || ""
  };
  const config = mode === "hosted-http"
    ? createHostedHttpProviderConfig({
      ...common,
      upstreamUrl: normalizeEndpoint(normalizedBody.upstream_url, baseUrl),
      upstreamMethod: normalizedBody.upstream_method || "POST",
      secretName: normalizedBody.secret_name || "PROVIDER_SECRET",
      secretValue: normalizedBody.secret_value || "",
      authHeader: normalizedBody.auth_header || (normalizedBody.secret_value ? "auto" : "authorization")
    })
    : createStaticProviderConfig({
      ...common,
      liveData: parseMaybeJson(normalizedBody.live_data, "live_data")
    });
  applyOwnerMetadata(config.manifest, { user, ownerKey });

  const duplicate = findDuplicateService(store, config.manifest);
  if (duplicate) {
    const verified = duplicate.verification_status === "verified";
    const error = new Error(verified
      ? `This provider source is already verified and routable as ${duplicate.manifest.service_id}`
      : `This provider source already exists as ${duplicate.manifest.service_id}, but it is not verified`);
    error.statusCode = 409;
    error.code = verified ? "SERVICE_SOURCE_ALREADY_REGISTERED" : "SERVICE_SOURCE_NOT_VERIFIED";
    error.existing_service_id = duplicate.manifest.service_id;
    throw error;
  }

  const configPath = await writeProviderConfig(config);
  const record = registerService(store, config.manifest, baseUrl);
  const validation = await validateService(store, config.manifest.service_id);
  if (!validation.ok) {
    unregisterService(store, config.manifest.service_id);
    await deleteProviderConfig(config.manifest.service_id);
    const error = new Error("Provider validation failed. The service was not registered because the API endpoint did not return a valid paid AgentRouter response.");
    error.statusCode = 422;
    error.code = "VALIDATION_FAILED";
    error.validation = validation;
    throw error;
  }
  return {
    ok: validation.ok,
    service_id: config.manifest.service_id,
    provider_config_path: configPath,
    endpoint: config.manifest.endpoint.url,
    registration: publicServiceRecord(record),
    validation,
    manifest: config.manifest,
    next_steps: [
      `node bin/adn.js search "${config.manifest.title}"`,
      `node bin/adn.js preview ${config.manifest.service_id}`,
      `node bin/adn.js wallet init`,
      `node bin/adn.js invoke ${config.manifest.service_id} '${JSON.stringify(config.manifest.sample_request)}'`
    ]
  };
}

function applyOwnerMetadata(manifest, { user = null, ownerKey = "" } = {}) {
  if (!ownerKey) return;
  manifest.registration = {
    ...(manifest.registration || {}),
    owner: {
      user_key: ownerKey,
      provider: user?.provider || "",
      user_id: user?.id || "",
      handle: user?.handle || "",
      email: user?.email || "",
      name: user?.name || "",
      created_at: new Date().toISOString()
    }
  };
}

function validateStudioInput(body, store) {
  const errors = [];
  const required = ["title", "description_for_agent", "price", "sample_request", "sample_data", "summary"];
  for (const key of required) {
    if (!String(body[key] || "").trim()) errors.push(`${key} is required`);
  }
  if (body.service_id && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(body.service_id)) {
    errors.push("service_id must be 3-64 chars and use lowercase letters, numbers, _ or -");
  }
  if (body.price && !(Number(body.price) > 0)) {
    errors.push("price must be positive");
  }
  if (store.services.has(body.service_id)) {
    errors.push(`service_id ${body.service_id} is already registered`);
  }
  if ((body.mode || "static-json") === "hosted-http" && !String(body.upstream_url || "").trim()) {
    errors.push("upstream_url is required for hosted-http");
  }
  if (errors.length) {
    const error = new Error(errors.join("; "));
    error.statusCode = 422;
    error.code = "INVALID_STUDIO_INPUT";
    throw error;
  }
}

export function studioHtml({ draft, loadedService, auth = {} } = {}) {
  const formDefaults = defaultsFromDraft(draft);
  const user = auth.user || null;
  const loadedNotice = loadedService ? `<div class="notice success">Loaded published service <strong>${html(loadedService.service_id)}</strong>. Edit the Arc payout wallet below, then use <strong>Update payout wallet</strong>. Publishing is only for new services.</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ADN Provider Studio</title>
  ${faviconLinks()}
  <style>
    /* Hallmark · pre-emit critique: P4 H4 E4 S4 R4 V4 */
    :root {
      color-scheme: light;
      --color-ink:#202124;
      --color-muted:#696f72;
      --color-faint:#9aa0a6;
      --color-line:#dedede;
      --color-strong-line:#c9ced1;
      --color-panel:#ffffff;
      --color-bg:#ffffff;
      --color-soft:#f6f7f5;
      --color-accent:#5cff73;
      --color-accent-2:#222222;
      --color-warn:#9a6a12;
      --color-bad:#b42318;
      --color-code:#101714;
      --color-success:#f2faf6;
      --color-accent-cool:#dffcff;
      --color-accent-ink:#0b240f;
      --shadow-lift:0 14px 34px rgba(23, 28, 25, .08);
      --font-body:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --font-mono:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    * { box-sizing: border-box; }
    html, body { overflow-x: clip; }
    body { margin: 0; font-family: var(--font-body); background: var(--color-bg); color: var(--color-ink); }
    a { color: inherit; text-decoration: none; }
    header { border-bottom: 1px solid var(--color-line); border-top: 3px solid var(--color-accent-cool); background: rgba(255,255,255,.98); }
    .topbar { height: 76px; max-width: none; margin: 0; display: grid; grid-template-columns: minmax(190px, 1fr) auto minmax(190px, 1fr); align-items: center; gap: 28px; padding: 0 32px; }
    .brand { display: flex; align-items: center; justify-self: start; gap: 12px; color: var(--color-ink); font-weight: 840; line-height: 1.05; font-size: 20px; }
    .brand-icon { width: 48px; height: 42px; display: inline-flex; align-items: center; justify-content: center; overflow: hidden; flex: 0 0 auto; }
    .brand-icon img { width: 44px; height: 38px; object-fit: contain; display: block; }
    .brand-word { font-size: 24px; font-weight: 850; line-height: 1; letter-spacing: 0; }
    .nav-links { display: flex; align-items: center; justify-content: center; gap: 32px; color: #636867; font-size: 16px; font-weight: 620; text-transform: none; }
    .nav-links a:hover, .nav-links a:focus-visible { color: var(--color-ink); outline: 0; }
    .auth-actions { justify-self: end; display: flex; align-items: center; gap: 12px; min-width: 0; }
    .auth-link { justify-self: end; min-height: 42px; border: 1px solid var(--color-line); border-radius: 14px; padding: 0 22px; display: inline-flex; align-items: center; justify-content: center; color: var(--color-ink); background: #fff; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 800; text-transform: uppercase; }
    .auth-link:hover, .auth-link:focus-visible { border-color: var(--color-strong-line); background: #fbfbfb; outline: 0; }
    .auth-link.signed-in { text-transform: none; }
    .logout-link { color: var(--color-muted); font-size: 12px; font-weight: 800; text-transform: uppercase; white-space: nowrap; }
    .logout-link:hover, .logout-link:focus-visible { color: var(--color-ink); outline: 0; text-decoration: underline; }
    .hero-copy { max-width: 1520px; margin: 0 auto; padding: 54px 24px 34px; display: grid; grid-template-columns: minmax(420px, 0.9fr) minmax(360px, 1.1fr); gap: 34px; align-items: end; position: relative; }
    .hero-copy::before { content:""; position:absolute; top:0; left:0; right:0; height:54px; border-bottom:1px solid #ededed; background-image:radial-gradient(#9c9c9c .8px, transparent .8px); background-size:12px 12px; }
    h1 { margin: 0 0 10px; font-size: 42px; letter-spacing: 0; line-height: 1.05; }
    p { margin: 0; color: var(--color-muted); line-height: 1.55; }
    .hero-points { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .hero-point { border: 1px solid var(--color-line); border-radius: 8px; background: #fff; padding: 16px; min-height: 98px; }
    .hero-point strong { display: block; margin-bottom: 7px; font-size: 14px; }
    .hero-point span { color: var(--color-muted); font-size: 13px; line-height: 1.42; display: block; }
    main { display: grid; grid-template-columns: minmax(640px, 1fr) minmax(420px, .54fr); gap: 24px; padding: 24px 24px 44px; align-items: start; max-width: 1520px; margin: 0 auto; }
    form, .output { background: var(--color-panel); border: 1px solid var(--color-line); border-radius: 8px; padding: 24px; box-shadow: none; }
    form { display: grid; gap: 6px; }
    .output { position: sticky; top: 88px; }
    fieldset { border: 0; padding: 0; margin: 0 0 20px; }
    legend { font-weight: 780; margin-bottom: 12px; font-size: 22px; letter-spacing: 0; }
    label { display: grid; gap: 7px; margin-bottom: 14px; font-size: 13px; font-weight: 720; color: var(--color-ink); }
    input, select, textarea { width: 100%; border: 1px solid var(--color-line); border-radius: 8px; padding: 12px 13px; font: inherit; background: #fff; color: var(--color-ink); }
    input:focus, select:focus, textarea:focus { outline: 3px solid rgba(223,252,255,.9); border-color: var(--color-faint); }
    input.invalid, textarea.invalid, select.invalid { border-color: var(--color-bad); box-shadow: 0 0 0 2px #ffe1de; }
    input[readonly] { background: #f6f8f5; color: var(--color-muted); }
    textarea { min-height: 86px; resize: vertical; font-family: var(--font-mono); font-size: 12px; line-height: 1.45; }
    code, .code-preview { font-family: var(--font-mono); }
    .code-preview { display: block; margin: 8px 0 14px; white-space: pre-wrap; word-break: break-word; background: var(--color-code); color: #edf8f0; border-radius: 8px; padding: 14px; font-size: 12px; line-height: 1.45; max-height: 260px; overflow: auto; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .quick-grid { display: grid; grid-template-columns: minmax(220px, 1fr) 116px 132px; gap: 12px; align-items: end; }
    details { border: 1px solid var(--color-line); border-radius: 8px; padding: 14px; background: #fbfbfb; margin-bottom: 14px; }
    summary { cursor: pointer; font-weight: 700; }
    details .grid { margin-top: 12px; }
    .actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
    button { border: 2px solid var(--color-ink); border-radius: 0; padding: 10px 15px; font: inherit; font-weight: 780; cursor: pointer; background: var(--color-ink); color: white; text-transform: uppercase; font-size: 12px; }
    button::before { content:">"; margin-right: 9px; font-family: var(--font-mono); }
    button.secondary { background: #e8e7ff; border-color: #e8e7ff; color: #27215e; }
    button.ghost { background: #eef2ef; border-color: #eef2ef; color: #29372f; }
    button:disabled, input:disabled { opacity: 0.55; cursor: not-allowed; }
    pre { margin: 12px 0 0; white-space: pre-wrap; word-break: break-word; background: var(--color-code); color: #edf8f0; border-radius: 8px; padding: 14px; max-height: 360px; overflow: auto; font-size: 12px; line-height: 1.45; }
    .hint { font-size: 12px; color: var(--color-muted); font-weight: 500; }
    .section-note { margin: -4px 0 14px; font-size: 12px; color: var(--color-muted); }
    .hidden { display: none; }
    .status { margin-left: auto; font-size: 13px; color: var(--color-muted); }
    .error { color: var(--color-bad); }
    .notice { border: 1px solid var(--color-line); border-radius: 8px; padding: 12px 13px; margin: 12px 0; font-size: 13px; color: var(--color-muted); background: #fbfbfb; }
    .notice.success { border-color: #9bc9b8; color: #173d2f; background: #f2faf6; }
    .notice.error { border-color: #efb3ad; color: var(--color-bad); background: #fff6f5; }
    .confirm-panel { margin-top: 14px; border-top: 1px solid var(--color-line); padding-top: 14px; }
    .confirm-panel button { width: 100%; }
    .divider { height: 1px; background: var(--color-line); margin: 20px 0; }
    .draft-toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 14px 0 6px; }
    .draft-list { display: grid; gap: 12px; margin: 14px 0; }
    .draft-row { display: grid; grid-template-columns: 28px minmax(0, 1fr) 104px 122px 126px; gap: 12px; align-items: start; border: 1px solid var(--color-line); border-radius: 8px; padding: 18px; background: #fff; transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease; }
    .draft-row:hover { border-color: var(--color-strong-line); transform: translateY(-1px); box-shadow: 0 10px 22px rgba(23, 32, 26, .06); }
    .draft-row.selected { border-color: #81b7a7; background: #f4fbf8; }
    .draft-row.published { border-color: #cbd8d1; background: #f5f7f5; opacity: 0.78; }
    .draft-row.failed { border-color:#efb3ad; background:#fff8f7; }
    .draft-row input[type="checkbox"] { width: 18px; height: 18px; margin-top: 4px; }
    .draft-title { font-weight: 790; overflow-wrap: anywhere; font-size: 16px; }
    .draft-meta { color: var(--color-muted); font-size: 12px; margin-top: 2px; overflow-wrap: anywhere; }
    .draft-review { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 12px; margin-top: 12px; padding: 12px; border: 1px solid #e3e7e4; border-radius: 8px; background: rgba(255,255,255,.82); }
    .draft-review-item { min-width: 0; display: grid; gap: 3px; }
    .draft-review-item b { color: #6b7370; font-size: 10px; line-height: 1.2; text-transform: uppercase; letter-spacing: .04em; }
    .draft-review-item span { color: var(--color-ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; }
    .draft-review-item code { font-family: Menlo, Monaco, Consolas, monospace; font-size: 12px; color: #28342d; background: #f2f5f2; border: 1px solid #e2e7e3; border-radius: 5px; padding: 2px 4px; overflow-wrap: anywhere; }
    .draft-review-item.full { grid-column: 1 / -1; }
    .draft-contract { display:flex; flex-wrap:wrap; gap:6px; margin-top:9px; }
    .draft-chip { display:inline-flex; align-items:center; border:1px solid #d7ded9; background:#fff; border-radius:999px; padding:3px 8px; color:#516158; font-size:11px; font-weight:650; }
    .draft-chip.route { border-color:#b7ead0; background:#f2fff8; color:#174d36; }
    .draft-chip.meta { color:#6b7370; }
    .draft-chip.ready { border-color:#afe9bb; background:#f2fff4; color:#174d24; }
    .draft-chip.warn { border-color:#ead4a6; background:#fff9ec; color:#734d00; }
    .draft-chip.error { border-color:#efb3ad; background:#fff1ef; color:#9f1d14; }
    .draft-error { margin-top:9px; color:#9f1d14; font-size:12px; line-height:1.45; overflow-wrap:anywhere; }
    .contract-status { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin: 2px 0 10px; }
    .contract-pill { display:inline-flex; align-items:center; border:1px solid #afe9bb; background:#f2fff4; color:#174d24; border-radius:999px; padding:5px 9px; font-size:12px; font-weight:760; }
    .contract-pill.neutral { border-color:#d7ded9; background:#fff; color:#516158; }
    .draft-price input { padding: 8px; }
    .mini-button { padding: 9px 10px; font-size: 12px; background: #29372f; align-self: center; }
    .tiny-button { padding: 8px 10px; font-size: 12px; background: #edf2ef; border-color: #edf2ef; color: #29372f; }
    .draft-badge { display: inline-flex; margin-top: 6px; border: 1px solid #bfd9cf; border-radius: 999px; padding: 2px 7px; font-size: 11px; color: #174235; background: #ffffff; }
    .flow-note { border-left: 3px solid var(--color-accent); padding: 10px 12px; background: #f4fff6; border-radius: 0 6px 6px 0; margin: 12px 0 12px; }
    .side-grid { display: grid; gap: 12px; margin-top: 12px; }
    .side-card { border: 1px solid var(--color-line); background: #fbfbfb; border-radius: 8px; padding: 16px; }
    .side-card h3 { margin: 0 0 10px; font-size: 16px; }
    .check-list { display: grid; gap: 7px; font-size: 13px; }
    .check-item { display: flex; gap: 8px; align-items: center; color: var(--color-muted); }
    .check-item.done { color: #173d2f; font-weight: 650; }
    .issue-list { display:grid; gap:8px; margin-top:12px; }
    .issue-item { border-top:1px solid var(--color-line); padding-top:8px; display:grid; gap:4px; }
    .issue-item strong { font-size:12px; color:var(--color-ink); overflow-wrap:anywhere; }
    .issue-item span { font-size:12px; color:#9f1d14; line-height:1.42; overflow-wrap:anywhere; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 6px; }
    .pill { border: 1px solid #cbd8d1; background: #fff; border-radius: 999px; padding: 4px 8px; font-size: 12px; color: #34443a; }
    .kv { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 6px 10px; font-size: 13px; }
    .kv div:nth-child(odd) { color: var(--color-muted); }
    .kv div:nth-child(even) { overflow-wrap: anywhere; font-weight: 650; }
    .step-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 0 0 18px; }
    .step { border: 1px solid var(--color-line); border-radius: 8px; padding: 14px; background: var(--color-soft); }
    .step b { display: block; color: var(--color-ink); font-size: 12px; margin-bottom: 5px; }
    .step span { color: var(--color-muted); font-size: 12px; line-height: 1.35; display: block; }
    @media (max-width: 980px) {
      main, .hero-copy { grid-template-columns: 1fr; padding-left: 16px; padding-right: 16px; }
      .topbar { grid-template-columns: 1fr auto; height: auto; min-height: 64px; padding: 0 18px; gap: 14px; }
      .brand { gap: 9px; }
      .brand-icon { width: 40px; height: 36px; border-radius: 10px; }
      .brand-icon img { width: 37px; height: 32px; }
      .brand-word { font-size: 20px; }
      .auth-link { min-height: 38px; border-radius: 12px; padding: 0 14px; font-size: 12px; max-width: 118px; }
      .auth-actions { gap: 8px; }
      .logout-link { font-size: 11px; }
      .output { position: static; }
      .grid, .quick-grid, .hero-points, .step-strip { grid-template-columns: 1fr; }
      .draft-row { grid-template-columns: 28px minmax(0, 1fr); }
      .draft-review { grid-template-columns: 1fr; }
      .draft-price, .mini-button { grid-column: 2; }
      .nav-links { display: none; }
      h1 { font-size: 36px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topbar">
      <a class="brand" href="/" aria-label="AgentRouter home">${brandLogo()}</a>
      <nav class="nav-links" aria-label="Studio navigation">
        <a href="/">Home</a>
        <a href="/agent">Services</a>
        <a href="/human">Provider Studio</a>
      </nav>
      ${user ? `<div class="auth-actions">
        <a class="auth-link signed-in" href="/account">${html(user.name || user.email || "Account")}</a>
        <a class="logout-link" href="/auth/logout">Sign out</a>
      </div>` : '<a class="auth-link" href="/auth/login?return_to=%2Fstudio">Login</a>'}
    </div>
    <div class="hero-copy">
      <div>
        <h1>Provider Studio</h1>
        <p>Connect a working data API, verify the real response, and publish it as an agent-callable paid service.</p>
      </div>
      <div class="hero-points">
        <div class="hero-point"><strong>Import</strong><span>Paste one endpoint, OpenAPI URL, or Skill page.</span></div>
        <div class="hero-point"><strong>Verify</strong><span>AgentRouter calls the upstream API before publish.</span></div>
        <div class="hero-point"><strong>Route</strong><span>Buyer agents can discover it immediately.</span></div>
      </div>
    </div>
  </header>
  <main>
    <form id="provider-form">
      <div class="step-strip">
        <div class="step"><b>Step 1</b><span>Import a real endpoint.</span></div>
        <div class="step"><b>Step 2</b><span>Select services to publish.</span></div>
        <div class="step"><b>Step 3</b><span>Verify and make routable.</span></div>
      </div>
      <fieldset>
        <legend>Import API</legend>
        <p class="section-note">Paste a real data endpoint, OpenAPI URL, Skill page, or the public-apis/public-apis repository. Catalog entries remain discovery candidates until their official docs produce a concrete endpoint that passes validation.</p>
        ${loadedNotice}
        <div class="quick-grid">
        <label>API / OpenAPI / Skill / Public APIs catalog URL
          <input name="import_api_url" value="" />
        </label>
        <label>Method
          <select name="import_method">
            <option value="GET">GET</option>
            <option value="POST" selected>POST</option>
          </select>
        </label>
        <label>Price (USDC)
          <input name="import_default_price" value="0.01" />
        </label>
        <label>Arc payout wallet
          <input name="import_payout_address" value="" placeholder="0x..." />
        </label>
        </div>
        <details>
          <summary>API key / auth</summary>
          <p class="hint">Optional. Stored as an encrypted Provider Secret and never exposed in the service manifest. Leave header blank for generic auto-detection.</p>
          <label>API key or token
            <input name="import_secret_value" value="" />
          </label>
          <label>Header name
            <input name="import_auth_header" value="" placeholder="auto" />
          </label>
        </details>
        <div class="actions">
          <button type="button" class="secondary" id="discover-api">Import Endpoints</button>
          <button type="button" class="ghost" id="publish-drafts">Verify & Publish Selected</button>
          <span class="status" id="status"></span>
        </div>
        <div class="draft-toolbar hidden" id="draft-toolbar">
          <button type="button" class="tiny-button" id="select-all-drafts">Select All</button>
          <button type="button" class="tiny-button" id="clear-drafts">Clear Selection</button>
          <span class="hint" id="selected-drafts-status">0 selected</span>
        </div>
        <p class="flow-note">Select endpoint cards and click <strong>Verify & Publish Selected</strong>. Service metadata, routing tags, data contract, and runtime wrapper are generated before validation.</p>
        <p class="hint" id="import-status">Use a concrete endpoint, OpenAPI/Swagger URL, Skill page, or https://github.com/public-apis/public-apis as a discovery source.</p>
        <div id="draft-list" class="draft-list"></div>
        <details>
          <summary>Developer debug JSON</summary>
          <label>Raw Drafts
            <textarea id="import-drafts" spellcheck="false">[]</textarea>
          </label>
        </details>
        <div class="divider"></div>
      </fieldset>
      <details id="service-editor" class="editor-details">
        <summary>Advanced manual editor</summary>
        <p class="section-note">Generated automatically from the imported endpoint. Most providers should only open this to override names, routing tags, input JSON, or endpoint details.</p>
        <fieldset>
          <legend>Service Metadata</legend>
          <div class="grid">
            <label>Data Source
              <select name="mode" id="mode">
                <option value="static-json">Pasted JSON result</option>
                <option value="hosted-http" ${formDefaults.mode === "hosted-http" ? "selected" : ""}>HTTP API endpoint</option>
              </select>
            </label>
            <label>Price per call (USDC)
              <input name="price" value="${html(formDefaults.price)}" />
            </label>
          </div>
          <label>Service name
            <input name="title" value="${html(formDefaults.title)}" />
          </label>
          <label>Provider Name
            <input name="provider_name" value="${html(formDefaults.providerName)}" />
          </label>
          <label>Arc payout wallet <span class="hint">optional for dev mode, required for real Arc settlement</span>
            <input name="payout_address" value="${html(formDefaults.payoutAddress)}" placeholder="0x..." />
          </label>
          <label>What this service gives the buyer Agent
            <textarea name="description_for_agent">${html(formDefaults.description)}</textarea>
          </label>
        </fieldset>
        <details>
          <summary>Advanced routing metadata</summary>
          <p class="hint">The router uses these tags and IDs to match services. They are generated from your title and description unless you edit them.</p>
          <label>Capability Tags <span class="hint">comma separated</span>
            <input name="capabilities" value="${html(formDefaults.capabilities)}" />
          </label>
          <div class="grid">
            <label>Service ID
              <input name="service_id" value="${html(formDefaults.serviceId)}" />
            </label>
            <label>Provider ID
              <input name="provider_id" value="${html(formDefaults.providerId)}" />
            </label>
          </div>
        </details>
        <fieldset>
          <legend>Data Contract</legend>
          <p class="section-note">Generated from endpoint parameters and the validation preview. Buyer agents use this to form requests and parse the paid response.</p>
          <div class="contract-status" id="input-contract-status"></div>
          <label>Example input JSON <span class="hint">auto-generated from endpoint parameters</span>
            <textarea name="sample_request">${html(formDefaults.sampleRequest)}</textarea>
          </label>
          <label>Generated contract
            <code class="code-preview" id="contract-preview"></code>
          </label>
          <label id="live-data-label" class="${formDefaults.mode === "hosted-http" ? "hidden" : ""}">Paid result JSON
            <textarea name="live_data">${html(formDefaults.liveData)}</textarea>
            <span class="hint">For pasted-data services only. This is the full result returned after payment.</span>
          </label>
          <input type="hidden" name="sample_data" value="${html(formDefaults.sampleData)}" />
          <details id="preview-settings" open>
            <summary>Free preview shown before payment</summary>
            <p class="hint">Generated from the API schema or pasted result. It is read-only here so providers do not accidentally publish a mismatched shape.</p>
            <code class="code-preview" id="preview-data-view">${html(formDefaults.sampleData)}</code>
          </details>
          <label>One-line result summary
            <input name="summary" value="${html(formDefaults.summary)}" />
          </label>
          <details>
            <summary>Agent envelope preview</summary>
            <p class="hint">This is the normalized response wrapper buyer Agents receive. It is generated automatically.</p>
            <code class="code-preview" id="envelope-preview"></code>
          </details>
        </fieldset>
        <fieldset id="hosted-http-fields" class="${formDefaults.mode === "hosted-http" ? "" : "hidden"}">
          <legend>Endpoint</legend>
          <label>Endpoint URL
            <input name="upstream_url" value="${html(formDefaults.upstreamUrl)}" />
          </label>
          <label>Endpoint token <span class="hint">optional</span>
            <input name="secret_value" value="${html(formDefaults.secretValue)}" />
          </label>
          <details>
            <summary>Advanced endpoint settings</summary>
            <div class="grid">
              <label>HTTP Method
                <input name="upstream_method" value="${html(formDefaults.upstreamMethod)}" />
              </label>
              <label>Auth Header
                <input name="auth_header" value="${html(formDefaults.authHeader)}" />
              </label>
            </div>
            <label>Secret Reference Name
              <input name="secret_name" value="${html(formDefaults.secretName)}" />
            </label>
          </details>
          <p class="hint">Tokens are encrypted into the local Provider Secret store; manifests only keep a secret reference. Use "auto" to try common auth headers during validation.</p>
        </fieldset>
      </details>
    </form>
    <section class="output">
      <h2>Publish Review</h2>
      <p>Review what will be published, whether required fields are ready, and what buyer Agents will see.</p>
      <div id="side-panel" class="side-grid"></div>
      <div class="confirm-panel">
        ${loadedService ? '<button type="button" class="secondary" id="update-payout-wallet">Update payout wallet</button>' : ""}
        <button type="submit" form="provider-form" id="publish-service" disabled>Verify & Publish Manual Service</button>
        <div id="form-message" class="notice hidden"></div>
      </div>
      <details>
        <summary>Raw response</summary>
        <pre id="result">Submit the form to create a provider service.</pre>
      </details>
    </section>
  </main>
  <script>
  (() => {
  try {
    const loadedServiceId = ${JSON.stringify(loadedService?.service_id || "")};
    const form = document.querySelector("#provider-form");
    const serviceEditor = document.querySelector("#service-editor");
    const mode = document.querySelector("#mode");
    const hostedFields = document.querySelector("#hosted-http-fields");
    const liveDataLabel = document.querySelector("#live-data-label");
    const result = document.querySelector("#result");
    const sidePanel = document.querySelector("#side-panel");
    const status = document.querySelector("#status");
    const formMessage = document.querySelector("#form-message");
    const publishService = document.querySelector("#publish-service");
    const fillHosted = document.querySelector("#fill-hosted");
    const discoverApi = document.querySelector("#discover-api");
    const publishDrafts = document.querySelector("#publish-drafts");
    const updatePayoutWallet = document.querySelector("#update-payout-wallet");
    const importDrafts = document.querySelector("#import-drafts");
    const draftList = document.querySelector("#draft-list");
    const draftToolbar = document.querySelector("#draft-toolbar");
    const selectAllDrafts = document.querySelector("#select-all-drafts");
    const clearDrafts = document.querySelector("#clear-drafts");
    const selectedDraftsStatus = document.querySelector("#selected-drafts-status");
    const importStatus = document.querySelector("#import-status");
    const importApiUrl = form.elements.namedItem("import_api_url");
    const importMethod = form.elements.namedItem("import_method");
    const importDefaultPrice = form.elements.namedItem("import_default_price");
    const importSecretValue = form.elements.namedItem("import_secret_value");
    const importAuthHeader = form.elements.namedItem("import_auth_header");
    const importPayoutAddress = form.elements.namedItem("import_payout_address");
    let discoveredDrafts = [];
    let lastImportMeta = null;
    const publishedServiceIds = new Set();
    let singleServiceReady = false;
    const previewSettings = document.querySelector("#preview-settings");
    const previewDataView = document.querySelector("#preview-data-view");
    const contractPreview = document.querySelector("#contract-preview");
    const inputContractStatus = document.querySelector("#input-contract-status");
    const envelopePreview = document.querySelector("#envelope-preview");
    const titleInput = form.elements.namedItem("title");
    const providerNameInput = form.elements.namedItem("provider_name");
    const descriptionInput = form.elements.namedItem("description_for_agent");
    const serviceIdInput = form.elements.namedItem("service_id");
    const providerIdInput = form.elements.namedItem("provider_id");
    const capabilitiesInput = form.elements.namedItem("capabilities");
    const liveDataInput = form.elements.namedItem("live_data");
    const sampleDataInput = form.elements.namedItem("sample_data");
    const sampleRequestInput = form.elements.namedItem("sample_request");
    const summaryInput = form.elements.namedItem("summary");
    const upstreamUrlInput = form.elements.namedItem("upstream_url");
    const secretValueInput = form.elements.namedItem("secret_value");
    const upstreamMethodInput = form.elements.namedItem("upstream_method");
    const authHeaderInput = form.elements.namedItem("auth_header");
    const secretNameInput = form.elements.namedItem("secret_name");
    const priceInput = form.elements.namedItem("price");
    const payoutAddressInput = form.elements.namedItem("payout_address");
    let serviceIdTouched = false;
    let providerIdTouched = false;

    function slugify(value, prefix) {
      const base = String(value || prefix)
        .trim()
        .toLowerCase()
        .replace(/['"]/g, "")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_")
        .slice(0, 56);
      const normalized = base || prefix;
      return normalized.length >= 3 ? normalized : prefix + "_" + normalized;
    }

    function syncGeneratedIds() {
      if (!serviceIdTouched) serviceIdInput.value = slugify(titleInput.value, "service");
      if (!providerIdTouched) providerIdInput.value = slugify(providerNameInput.value, "provider");
      if (!capabilitiesInput.dataset.touched) capabilitiesInput.value = suggestCapabilities(autoCapabilityText());
      syncPreviewData();
      syncEnvelopePreview();
      updateSidePanel();
    }

    function autoCapabilityText() {
      let requestKeys = "";
      try {
        requestKeys = Object.keys(JSON.parse(sampleRequestInput.value || "{}")).join(" ");
      } catch {
        requestKeys = sampleRequestInput.value || "";
      }
      return [titleInput.value, upstreamUrlInput.value, requestKeys].filter(Boolean).join(" ");
    }

    function showNotice(target, message, type = "") {
      if (!target) return;
      target.textContent = message;
      target.classList.remove("hidden", "success", "error");
      if (type) target.classList.add(type);
    }

    function hideNotice(target) {
      if (!target) return;
      target.textContent = "";
      target.classList.add("hidden");
      target.classList.remove("success", "error");
    }

    function markInvalid(field, invalid) {
      if (!field) return;
      field.classList.toggle("invalid", Boolean(invalid));
    }

    function validateJsonField(field, label, { required = true, objectOnly = false } = {}) {
      const value = String(field?.value || "").trim();
      if (!value) return required ? label + " is required." : null;
      try {
        const parsed = JSON.parse(value);
        if (objectOnly && (!parsed || typeof parsed !== "object" || Array.isArray(parsed))) {
          return label + " must be a JSON object.";
        }
        return null;
      } catch (error) {
        return label + " is not valid JSON: " + error.message;
      }
    }

    function validateSingleServiceForm() {
      const fields = [
        titleInput,
        providerNameInput,
        descriptionInput,
        priceInput,
        sampleRequestInput,
        summaryInput,
        upstreamUrlInput,
        liveDataInput,
        serviceIdInput,
        providerIdInput
      ];
      fields.forEach((field) => markInvalid(field, false));
      const errors = [];
      const requiredText = [
        [titleInput, "Service name"],
        [providerNameInput, "Provider name"],
        [descriptionInput, "What this service gives the buyer Agent"],
        [summaryInput, "One-line result summary"]
      ];
      for (const [field, label] of requiredText) {
        if (!String(field.value || "").trim()) {
          errors.push(label + " is required.");
          markInvalid(field, true);
        }
      }
      const price = Number(priceInput.value);
      if (!(price > 0)) {
        errors.push("Price per call must be greater than 0.");
        markInvalid(priceInput, true);
      }
      const sampleError = validateJsonField(sampleRequestInput, "Example input JSON", { objectOnly: true });
      if (sampleError) {
        errors.push(sampleError);
        markInvalid(sampleRequestInput, true);
      }
      const sampleDataError = validateJsonField(sampleDataInput, "Free preview data", { required: true });
      if (sampleDataError) errors.push(sampleDataError);
      if (mode.value === "hosted-http") {
        if (!String(upstreamUrlInput.value || "").trim()) {
          errors.push("Endpoint URL is required for HTTP API services.");
          markInvalid(upstreamUrlInput, true);
        }
      } else {
        const liveError = validateJsonField(liveDataInput, "Paid result JSON", { required: true });
        if (liveError) {
          errors.push(liveError);
          markInvalid(liveDataInput, true);
        }
      }
      if (serviceIdInput.value && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(serviceIdInput.value)) {
        errors.push("Service ID must be 3-64 chars and use lowercase letters, numbers, _ or -.");
        markInvalid(serviceIdInput, true);
      }
      if (providerIdInput.value && !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(providerIdInput.value)) {
        errors.push("Provider ID must be 3-64 chars and use lowercase letters, numbers, _ or -.");
        markInvalid(providerIdInput, true);
      }
      return errors;
    }

    function validateImportForm() {
      markInvalid(importApiUrl, false);
      markInvalid(importDefaultPrice, false);
      const errors = [];
      if (!String(importApiUrl.value || "").trim()) {
        errors.push("API or OpenAPI URL is required.");
        markInvalid(importApiUrl, true);
      }
      if (!(Number(importDefaultPrice.value) > 0)) {
        errors.push("Default price per call must be greater than 0.");
        markInvalid(importDefaultPrice, true);
      }
      return errors;
    }

    function userFacingError(payload, fallback = "Publish failed. Check the fields above and try again.") {
      const message = payload?.error?.message || fallback;
      if (message.includes("already registered")) {
        return "This service has already been published. Use the existing published card, or change the Service ID under Advanced routing metadata if you want to publish a separate copy.";
      }
      if (message.includes("sample_request")) return "Example input JSON is missing or invalid.";
      if (message.includes("sample_data")) return "Free preview data is missing or invalid.";
      if (message.includes("upstream_url")) return "Endpoint URL is required for HTTP API services.";
      return message;
    }

    function formatPublishFailures(failed) {
      return failed.map((item) => {
        const reason = item.message || item.validation?.result_errors?.[0]?.message || item.validation?.provider_error?.message || item.error || "Validation failed";
        return item.service_id + ": " + reason;
      }).join("; ");
    }

    function setSingleServiceReady(ready, message = "") {
      singleServiceReady = Boolean(ready);
      publishService.disabled = loadedServiceId ? true : !singleServiceReady;
      if (message) showNotice(formMessage, message, ready ? "" : "error");
    }

    if (updatePayoutWallet) {
      publishService.disabled = true;
      updatePayoutWallet.addEventListener("click", async () => {
        hideNotice(formMessage);
        const payoutAddress = String(payoutAddressInput?.value || "").trim();
        if (!/^0x[0-9a-fA-F]{40}$/.test(payoutAddress)) {
          status.textContent = "Invalid payout wallet";
          status.classList.add("error");
          showNotice(formMessage, "Arc payout wallet must be a valid EVM address.", "error");
          markInvalid(payoutAddressInput, true);
          return;
        }
        status.textContent = "Updating payout wallet...";
        status.classList.remove("error");
        try {
          const response = await fetch("/services/" + encodeURIComponent(loadedServiceId) + "/payout", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ payout_address: payoutAddress })
          });
          const payload = await response.json();
          result.textContent = JSON.stringify(payload, null, 2);
          if (!response.ok || !payload.ok) {
            status.textContent = "Payout update failed";
            status.classList.add("error");
            showNotice(formMessage, payload.error?.message || "Payout wallet update failed.", "error");
            return;
          }
          status.textContent = "Payout wallet updated";
          status.classList.remove("error");
          showNotice(formMessage, "Arc payout wallet is bound to this service. Future Arc USDC payments will target this address.", "success");
          updateSidePanel({ publishResult: payload });
        } catch (error) {
          status.textContent = "Payout update error";
          status.classList.add("error");
          showNotice(formMessage, error.message || "Payout wallet update failed.", "error");
          result.textContent = error.stack || error.message;
        }
      });
    }

    function suggestCapabilities(value) {
      const lower = String(value || "").toLowerCase();
      const tags = new Set(["data_service"]);
      if (/sentiment|情绪|社媒|social/.test(lower)) tags.add("sentiment_data");
      if (/fund flow|net[\s_-]?flow|netflow|资金流|净流入|净流出|inflow|outflow|链上|onchain/.test(lower)) {
        tags.add("onchain_data");
        tags.add("fund_flow");
      }
      if (/net[\s_-]?flow|netflow|净流入|净流出/.test(lower)) tags.add("netflow");
      if (/smart[\s_-]?money|smart money|聪明钱/.test(lower)) {
        tags.add("smart_money");
        if (/net[\s_-]?flow|netflow|净流入|净流出|inflow|outflow/.test(lower)) tags.add("smart_money_netflow");
        if (/holding|holdings|持仓|balance/.test(lower)) tags.add("smart_money_holdings");
      }
      if (/funding|资金费率/.test(lower)) {
        tags.add("crypto_derivatives");
        tags.add("funding_rate");
        tags.add("market_data");
      }
      if (/liquidation|爆仓|清算|perp|永续|合约/.test(lower)) {
        tags.add("crypto_derivatives");
        tags.add("perp_liquidation");
        tags.add("liquidation_heatmap");
        tags.add("perp_liquidation_max_pain");
      }
      if (/price|价格|ticker|行情/.test(lower)) tags.add("market_data");
      if (/\betf\b|exchange traded fund|bitcoin etf|btc etf/.test(lower)) {
        tags.add("market_data");
        tags.add("etf_data");
      }
      if (/wallet|address|地址/.test(lower)) tags.add("wallet_profile");
      if (/transfer|transfers|转账|流转/.test(lower)) {
        tags.add("transfer_data");
        tags.add("token_transfers");
        tags.add("wallet_activity");
      }
      if (/transaction|transactions|txs?|交易/.test(lower)) tags.add("transaction_data");
      if (/token|代币|tgm|token god mode/.test(lower)) {
        tags.add("token_data");
        tags.add("token_analytics");
      }
      if (/token god mode|tgm/.test(lower)) tags.add("token_god_mode");
      if (/leaderboard|ranking|rank|积分榜|排行榜/.test(lower)) tags.add("leaderboard_data");
      if (/points|score|积分/.test(lower)) tags.add("points_data");
      if (/portfolio|资产组合|持仓组合/.test(lower)) tags.add("portfolio_data");
      if (/profiler|profile|画像/.test(lower)) tags.add("address_intelligence");
      if (/prediction market|预测市场/.test(lower)) tags.add("prediction_market_data");
      if (/hyperliquid|hl\b/.test(lower)) {
        tags.add("hyperliquid_data");
        tags.add("crypto_derivatives");
      }
      return Array.from(tags).join(",");
    }
    titleInput.addEventListener("input", () => { markInvalid(titleInput, false); syncGeneratedIds(); });
    providerNameInput.addEventListener("input", () => { markInvalid(providerNameInput, false); syncGeneratedIds(); });
    descriptionInput.addEventListener("input", () => { markInvalid(descriptionInput, false); syncGeneratedIds(); });
    priceInput.addEventListener("input", () => markInvalid(priceInput, false));
    payoutAddressInput?.addEventListener("input", () => markInvalid(payoutAddressInput, false));
    importApiUrl.addEventListener("input", () => markInvalid(importApiUrl, false));
    importDefaultPrice.addEventListener("input", () => markInvalid(importDefaultPrice, false));
    serviceIdInput.addEventListener("input", () => { serviceIdTouched = true; markInvalid(serviceIdInput, false); });
    providerIdInput.addEventListener("input", () => { providerIdTouched = true; markInvalid(providerIdInput, false); });
    capabilitiesInput.addEventListener("input", () => { capabilitiesInput.dataset.touched = "true"; });
    liveDataInput.addEventListener("input", () => {
      markInvalid(liveDataInput, false);
      syncPreviewData();
      syncEnvelopePreview();
    });
    sampleRequestInput.addEventListener("input", () => {
      markInvalid(sampleRequestInput, false);
      syncInputContractStatus();
      syncEnvelopePreview();
    });
    summaryInput.addEventListener("input", () => { markInvalid(summaryInput, false); syncEnvelopePreview(); });
    upstreamUrlInput.addEventListener("input", () => markInvalid(upstreamUrlInput, false));
    serviceEditor.addEventListener("toggle", () => {
      if (serviceEditor.open && !singleServiceReady) {
        setSingleServiceReady(true, "Manual editor enabled. Review the fields, then confirm on the right.");
      }
    });
    previewSettings.addEventListener("toggle", syncPreviewData);
    syncGeneratedIds();

    discoverApi.addEventListener("click", async (event) => {
      event.preventDefault();
      hideNotice(formMessage);
      const importErrors = validateImportForm();
      if (importErrors.length) {
        importStatus.textContent = importErrors.join(" ");
        importStatus.classList.add("error");
        status.textContent = "Check import fields";
        status.classList.add("error");
        return;
      }
      status.textContent = "Discovering endpoints...";
      status.classList.remove("error");
      importStatus.textContent = "Discovering endpoints from " + importApiUrl.value + "...";
      importStatus.classList.remove("error");
      draftList.innerHTML = '<p class="hint">Discovering...</p>';
      try {
        const response = await fetch("/studio/import/discover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_url: importApiUrl.value,
            default_price: importDefaultPrice.value,
            default_method: importMethod.value,
            secret_value: importSecretValue.value,
            auth_header: importAuthHeader.value,
            payout_address: importPayoutAddress.value
          })
        });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
        if (!response.ok || !payload.ok) {
          discoveredDrafts = [];
          lastImportMeta = null;
          importDrafts.value = "[]";
          renderDraftList([]);
          const message = payload.error?.message || "Discovery failed.";
          importStatus.textContent = message;
          importStatus.classList.add("error");
          status.textContent = "Discovery failed";
          status.classList.add("error");
          return;
        }
        discoveredDrafts = (payload.drafts || []).map(normalizeDiscoveredDraft);
        for (const draft of discoveredDrafts.filter((item) => item.published)) {
          publishedServiceIds.add(draft.service_id);
        }
        lastImportMeta = {
          skipped: payload.skipped?.length || 0,
          source: payload.source,
          mode: payload.mode || "openapi",
          provider: payload.provider?.provider_name || payload.provider?.provider_id || ""
        };
        importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
        renderDraftList(discoveredDrafts);
        updateDraftSelectionUi();
        updateSidePanel({
          importSummary: {
            found: discoveredDrafts.length,
            selected: selectedDraftCount(),
            skipped: payload.skipped?.length || 0,
            source: payload.source,
            mode: payload.mode || "openapi",
            provider: payload.provider?.provider_name || payload.provider?.provider_id || ""
          }
        });
        importStatus.textContent = discoveredDrafts.length
          ? "Found " + discoveredDrafts.length + " generated service drafts from " + importModeLabel(payload.mode) + ". Each selected endpoint will be live-validated before publishing. Skipped " + (payload.skipped?.length || 0) + "."
          : "No data endpoints found.";
        importStatus.classList.remove("error");
        status.textContent = "Drafts generated";
        status.classList.remove("error");
      } catch (error) {
        status.textContent = "Discovery error";
        status.classList.add("error");
        importStatus.textContent = error.message;
        importStatus.classList.add("error");
        result.textContent = error.stack || error.message;
      }
    });

    publishDrafts.addEventListener("click", async () => {
      hideNotice(formMessage);
      status.textContent = "Publishing services...";
      status.classList.remove("error");
      try {
        syncDraftsFromList();
        const drafts = JSON.parse(importDrafts.value || "[]");
        const selected = drafts.filter((draft) => draft.selected !== false);
        if (!selected.length) {
          status.textContent = "Select at least one endpoint";
          status.classList.add("error");
          importStatus.textContent = "Select one or more endpoint cards before publishing.";
          importStatus.classList.add("error");
          return;
        }
        const response = await fetch("/studio/import/publish", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ drafts, publish_scope: "remote_and_local" })
        });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
        const publishedCount = payload.published?.length || 0;
        const failedCount = payload.failed?.length || 0;
        status.textContent = failedCount
          ? "Verified " + publishedCount + ", failed " + failedCount
          : "Remote verified " + publishedCount + " services";
        status.classList.toggle("error", failedCount > 0);
        showNotice(
          formMessage,
          failedCount === 0
            ? "Verified and published to " + (payload.remote_registry_url || "this registry") + ". Buyer agents can route to it now."
            : "Some endpoints were not published. Failed cards now show the exact reason; verified cards are already routable.",
          failedCount === 0 ? "success" : "error"
        );
        for (const item of payload.published || []) publishedServiceIds.add(item.service_id);
        const failedById = new Map((payload.failed || []).map((item) => [item.service_id, item]));
        discoveredDrafts = discoveredDrafts.map((draft) => publishedServiceIds.has(draft.service_id)
          ? { ...draft, selected: false, published: true }
          : failedById.has(draft.service_id)
            ? { ...draft, selected: true, published: false, publish_error: failedById.get(draft.service_id) }
            : { ...draft, publish_error: undefined });
        renderDraftList(discoveredDrafts);
        updateDraftSelectionUi();
        setSingleServiceReady(false);
        updateSidePanel({ batchPublishResult: payload });
      } catch (error) {
        status.textContent = "Publish error";
        status.classList.add("error");
        result.textContent = error.stack || error.message;
      }
    });

    function renderDraftList(drafts) {
      if (!drafts.length) {
        draftToolbar.classList.add("hidden");
        draftList.innerHTML = '<p class="hint">No data endpoints discovered yet.</p>';
        return;
      }
      draftToolbar.classList.remove("hidden");
      draftList.innerHTML = drafts.map((draft, index) => [
        '<div class="draft-row ' + draftRowClass(draft) + '" data-index="' + index + '">',
        '<input type="checkbox" class="draft-selected" ' + checkboxAttrs(draft) + " />",
        "<div>",
        '<div class="draft-title">' + escapeHtml(draft.title || draft.service_id) + "</div>",
        '<div class="draft-meta">' + (draft.publish_blocked ? "Catalog candidate · " + escapeHtml(draft.discovery_url || "documentation required") : escapeHtml(draft.method || "GET") + " " + escapeHtml(draft.path || draft.upstream_url || "")) + "</div>",
        '<div class="draft-meta">' + escapeHtml((draft.capabilities || []).join(", ")) + "</div>",
        '<div class="draft-review">' + draftReviewItems(draft) + '</div>',
        '<div class="draft-contract">' + draftContractChips(draft) + '</div>',
        '<span class="draft-badge">' + draftBadge(draft) + "</span>",
        draft.publish_error ? '<div class="draft-error">' + escapeHtml(publishFailureReason(draft.publish_error)) + '</div>' : "",
        "</div>",
        '<label class="draft-price">Method',
        '<select class="draft-method-input" ' + (draft.published || draft.publish_blocked ? "disabled" : "") + '>',
        methodOption("GET", draft.method),
        methodOption("POST", draft.method),
        "</select>",
        "</label>",
        '<label class="draft-price">USDC',
        '<input class="draft-price-input" value="' + escapeHtml(draft.price || importDefaultPrice.value || "0.01") + '" ' + (draft.published || draft.publish_blocked ? "disabled" : "") + " />",
        "</label>",
        '<button type="button" class="mini-button use-draft" ' + (draft.published ? "disabled" : "") + ">" + (draft.published ? "Verified" : draft.publish_blocked ? "Inspect API docs" : "Edit Details") + "</button>",
        "</div>"
      ].join("")).join("");
    }

    function normalizeDiscoveredDraft(draft) {
      const capabilityText = [
        draft.title,
        draft.path,
        draft.upstream_url,
        Object.keys(draft.sample_request || {}).join(" ")
      ].filter(Boolean).join(" ");
      const capabilities = suggestCapabilities(capabilityText).split(",").filter(Boolean);
      const sampleRequest = draft.sample_request || {};
      const previewData = draft.preview_data ?? draft.data_contract?.response_data?.preview ?? {};
      if (draft.source_type === "public_api_catalog") {
        return {
          ...draft,
          selected: false,
          capabilities: Array.isArray(draft.capabilities) && draft.capabilities.length ? draft.capabilities : capabilities,
          sample_request: {},
          preview_data: {}
        };
      }
      return {
        ...draft,
        capabilities,
        sample_request: sampleRequest,
        preview_data: previewData,
        summary: structuredDraftSummary({ ...draft, sample_request: sampleRequest, preview_data: previewData }),
        data_contract: normalizedDataContract(draft, sampleRequest, previewData)
      };
    }

    function normalizedDataContract(draft, sampleRequest, previewData) {
      const existing = draft.data_contract || {};
      return {
        ...existing,
        request: {
          ...(existing.request || {}),
          method: draft.method || existing.request?.method || "GET",
          path: draft.path || existing.request?.path || endpointPath(draft.upstream_url || ""),
          example: sampleRequest
        },
        request_data: {
          ...(existing.request_data || {}),
          fields: Object.keys(sampleRequest || {}),
          example: sampleRequest,
          shape: shapeFor(sampleRequest || {})
        },
        response_data: {
          ...(existing.response_data || {}),
          fields: responseKeys(previewData, 16),
          preview: previewData,
          shape: shapeFor(previewData)
        }
      };
    }

    function structuredDraftSummary(draft) {
      const inputKeys = Object.keys(draft.sample_request || {});
      const response = draftResponseSummary(draft);
      const title = draft.title || draft.service_id || "this endpoint";
      const method = draft.method || "GET";
      const path = draft.path || endpointPath(draft.upstream_url || "");
      const inputText = inputKeys.length ? "Inputs: " + inputKeys.join(", ") + "." : "Inputs: none required.";
      return [
        "Use this service when a buyer Agent needs " + title + ".",
        "Endpoint: " + method + " " + path + ".",
        inputText,
        "Returns: " + response + "."
      ].filter(Boolean).join(" ");
    }

    function draftReviewItems(draft) {
      const summary = compactText(draft.summary || draft.description_for_agent || "No summary generated yet.", 320);
      return [
        draftReviewItem("Service ID", '<code>' + escapeHtml(draft.service_id || "-") + '</code>'),
        draftReviewItem("Upstream", '<code>' + escapeHtml(draft.upstream_url || draft.path || "-") + '</code>'),
        draftReviewItem("Auth", escapeHtml(draftAuthSummary(draft))),
        draftReviewItem("Input", escapeHtml(draftInputSummary(draft))),
        draftReviewItem("Response", escapeHtml(draftResponseSummary(draft))),
        draftReviewItem("Source", escapeHtml(draftSourceLabel(draft))),
        draftReviewItem("Price", escapeHtml(draftPriceSummary(draft))),
        draftReviewItem("Freshness", escapeHtml(draftFreshnessSummary(draft))),
        draftReviewItem("Agent summary", escapeHtml(summary), true),
        draftReviewItem("Request data", '<code>' + escapeHtml(compactJson(draft.data_contract?.request_data?.example || draft.sample_request || {}, 220)) + '</code>', true),
        draftReviewItem("Response data", '<code>' + escapeHtml(compactJson(draft.data_contract?.response_data?.preview ?? draft.preview_data ?? {}, 220)) + '</code>', true)
      ].join("");
    }

    function draftReviewItem(label, value, full = false) {
      return '<div class="draft-review-item ' + (full ? "full" : "") + '"><b>' + escapeHtml(label) + '</b><span>' + value + '</span></div>';
    }

    function draftAuthSummary(draft) {
      if (draft.source_type === "public_api_catalog") return draft.catalog_metadata?.auth || "unknown";
      const header = draft.auth_header || "";
      if (header === "auto") return "auto-detect";
      if (header) return "header: " + header;
      return draft.secret_value ? "auto-detect" : "none";
    }

    function draftInputSummary(draft) {
      const keys = Object.keys(draft.sample_request || {});
      if (!keys.length) return "no input";
      return keys.slice(0, 6).join(", ") + (keys.length > 6 ? " +" + (keys.length - 6) : "");
    }

    function draftResponseSummary(draft) {
      const shape = draft.data_contract?.response?.preview_shape || shapeForPreview(draft.preview_data);
      if (Array.isArray(shape)) return "array" + (shape[0] && typeof shape[0] === "object" ? ": " + Object.keys(shape[0]).slice(0, 5).join(", ") : "");
      if (shape && typeof shape === "object") {
        const keys = Object.keys(shape);
        return keys.length ? keys.slice(0, 6).join(", ") + (keys.length > 6 ? " +" + (keys.length - 6) : "") : "object";
      }
      return String(shape || "unknown");
    }

    function draftPriceSummary(draft) {
      if (draft.publish_blocked) return "set after endpoint discovery";
      const price = draft.price || importDefaultPrice.value || "0.01";
      return price + " USDC/call";
    }

    function draftFreshnessSummary(draft) {
      if (draft.publish_blocked) return "not verified";
      return draft.data_contract?.pre_call_context?.freshness_hint || "validated live before publish";
    }

    function shapeForPreview(value) {
      if (Array.isArray(value)) return value.length ? [shapeForPreview(value[0])] : [];
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).slice(0, 8).map(([key, child]) => [key, shapeForPreview(child)]));
      }
      return value === null ? "null" : typeof value;
    }

    function draftSourceLabel(draft) {
      if (draft.source_type === "public_api_catalog") return "Public APIs catalog";
      if (draft.source_type === "api_docs_import") return "API docs";
      if (draft.source_type === "skill_import") return "Skill";
      if (draft.source_type === "direct_endpoint") return "Direct endpoint";
      if (draft.discovery_note) return draft.discovery_note.includes("direct") ? "Direct endpoint" : "Generated";
      return "OpenAPI";
    }

    function compactText(value, maxLength) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
    }

    function compactJson(value, maxLength) {
      let text = "";
      try {
        text = JSON.stringify(value);
      } catch {
        text = String(value || "");
      }
      return compactText(text, maxLength);
    }

    function responseKeys(value, limit = 8, prefix = "") {
      if (limit <= 0) return [];
      if (Array.isArray(value)) return value.length ? responseKeys(value[0], limit, prefix) : [];
      if (!value || typeof value !== "object") return [];
      const keys = [];
      for (const [key, child] of Object.entries(value)) {
        const path = prefix ? prefix + "." + key : key;
        keys.push(path);
        if (keys.length >= limit) break;
        if (child && typeof child === "object") {
          for (const nested of responseKeys(child, limit - keys.length, path)) {
            keys.push(nested);
            if (keys.length >= limit) break;
          }
        }
        if (keys.length >= limit) break;
      }
      return keys;
    }

    function draftRowClass(draft) {
      if (draft.published) return "published";
      if (draft.publish_error) return "failed selected";
      return draft.selected === false ? "" : "selected";
    }

    function checkboxAttrs(draft) {
      return [
        draft.selected === false ? "" : "checked",
        draft.published || draft.publish_blocked ? "disabled" : ""
      ].join(" ");
    }

    function draftBadge(draft) {
      if (draft.published) return "Verified and routable";
      if (draft.publish_blocked) return "Discovery candidate · inspect docs";
      if (draft.publish_error) return "Validation failed";
      if (draft.existing_service_status && draft.existing_service_status !== "verified") return "Needs verification";
      return draft.selected === false ? "Not selected" : "Selected for verification";
    }

    function draftContractChips(draft) {
      const inputKeys = Object.keys(draft.sample_request || {});
      const source = draft.source_type === "public_api_catalog" ? "Public APIs catalog" : draft.source_type === "skill_import" ? "Skill import" : draft.discovery_note ? "Direct endpoint" : "OpenAPI";
      const routeTags = (draft.capabilities || ["data_service"]).slice(0, 8).map((tag) =>
        '<span class="draft-chip route">' + escapeHtml(tag) + '</span>'
      );
      return [
        ...routeTags,
        '<span class="draft-chip meta">' + inputKeys.length + ' input fields</span>',
        '<span class="draft-chip meta">' + escapeHtml(source) + '</span>',
        draft.auth_header ? '<span class="draft-chip meta">Auth: ' + escapeHtml(draft.auth_header) + '</span>' : '',
        draft.publish_blocked ? '<span class="draft-chip warn">Endpoint discovery required</span>' : '',
        draft.publish_error ? '<span class="draft-chip error">Fix before publish</span>' : ''
      ].join("");
    }

    function publishFailureReason(item) {
      return item?.message
        || item?.validation?.result_errors?.[0]?.message
        || item?.validation?.provider_error?.message
        || item?.validation?.error
        || item?.error
        || "Validation failed";
    }

    function methodOption(method, current) {
      return '<option value="' + method + '" ' + (String(current || "GET").toUpperCase() === method ? "selected" : "") + ">" + method + "</option>";
    }

    draftList.addEventListener("change", (event) => {
      if (!event.target.classList.contains("draft-selected")) return;
      syncDraftsFromList();
      renderDraftList(discoveredDrafts);
      updateDraftSelectionUi();
    });

    draftList.addEventListener("input", (event) => {
      if (!event.target.classList.contains("draft-price-input") && !event.target.classList.contains("draft-method-input")) return;
      syncDraftsFromList();
      updateDraftSelectionUi();
    });

    draftList.addEventListener("click", (event) => {
      if (!event.target.classList.contains("use-draft")) return;
      const row = event.target.closest(".draft-row");
      const index = Number(row.dataset.index);
      syncDraftsFromList();
      if (discoveredDrafts[index]?.publish_blocked && discoveredDrafts[index]?.discovery_url) {
        importApiUrl.value = discoveredDrafts[index].discovery_url;
        discoverApi.click();
        return;
      }
      fillDraftIntoForm(discoveredDrafts[index]);
    });

    selectAllDrafts.addEventListener("click", () => {
      discoveredDrafts = discoveredDrafts.map((draft) => ({ ...draft, selected: draft.publish_blocked ? false : true }));
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
      renderDraftList(discoveredDrafts);
      updateDraftSelectionUi();
    });

    clearDrafts.addEventListener("click", () => {
      discoveredDrafts = discoveredDrafts.map((draft) => ({ ...draft, selected: false }));
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
      renderDraftList(discoveredDrafts);
      updateDraftSelectionUi();
    });

    function selectedDraftCount() {
      return discoveredDrafts.filter((draft) => !draft.published && !draft.publish_blocked && draft.selected !== false).length;
    }

    function updateDraftSelectionUi() {
      const selected = selectedDraftCount();
      const total = discoveredDrafts.length;
      const published = discoveredDrafts.filter((draft) => draft.published).length;
      publishDrafts.textContent = total ? "Verify & Publish " + selected + " Selected" : "Verify & Publish Selected";
      publishDrafts.disabled = total > 0 && selected === 0;
      selectedDraftsStatus.textContent = selected + " of " + total + " endpoints selected" + (published ? " · " + published + " published" : "");
      importStatus.textContent = total
        ? "Found " + total + " generated drafts from " + importModeLabel(lastImportMeta?.mode) + ". " + selected + " selected for live verification. " + published + " already verified and routable. Skipped " + (lastImportMeta?.skipped || 0) + "."
        : importStatus.textContent;
      importStatus.classList.remove("error");
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
      updateSidePanel({
        importSummary: {
          found: total,
          selected,
          published,
          skipped: lastImportMeta?.skipped || 0,
          source: lastImportMeta?.source || importApiUrl.value,
          mode: lastImportMeta?.mode || "",
          provider: lastImportMeta?.provider || ""
        }
      });
    }

    function importModeLabel(mode) {
      if (mode === "public_api_catalog") return "Public APIs catalog";
      if (mode === "skill_document") return "Skill document";
      if (mode === "direct_endpoint") return "single endpoint";
      if (mode === "openapi") return "OpenAPI";
      return mode || "API source";
    }

    function syncDraftsFromList() {
      const rows = [...draftList.querySelectorAll(".draft-row")];
      for (const row of rows) {
        const index = Number(row.dataset.index);
        if (discoveredDrafts[index].published || discoveredDrafts[index].publish_blocked) continue;
        discoveredDrafts[index].selected = row.querySelector(".draft-selected").checked;
        discoveredDrafts[index].price = row.querySelector(".draft-price-input").value;
        discoveredDrafts[index].method = row.querySelector(".draft-method-input").value;
        if (!discoveredDrafts[index].selected) discoveredDrafts[index].publish_error = undefined;
      }
      importDrafts.value = JSON.stringify(discoveredDrafts, null, 2);
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function syncMode() {
      const hosted = mode.value === "hosted-http";
      hostedFields.classList.toggle("hidden", !hosted);
      liveDataLabel.classList.toggle("hidden", hosted);
      syncPreviewData();
      syncEnvelopePreview();
    }
    mode.addEventListener("change", syncMode);
    syncMode();

    if (fillHosted) {
      fillHosted.addEventListener("click", () => {
        serviceEditor.open = true;
        setSingleServiceReady(true);
        mode.value = "hosted-http";
        serviceIdTouched = false;
        providerIdTouched = false;
        titleInput.value = "Hosted Sentiment API";
        providerNameInput.value = "Provider Studio Hosted";
        descriptionInput.value = "Use this service to fetch sentiment data through a hosted Provider Runtime with a private Provider Secret.";
        upstreamUrlInput.value = "";
        secretValueInput.value = "";
        liveDataInput.value = ${JSON.stringify("{\"asset\":\"ETH\",\"sentiment_score\":0.79,\"mentions\":24120}")};
        syncGeneratedIds();
        capabilitiesInput.dataset.touched = "true";
        capabilitiesInput.value = "sentiment_data,hosted_http";
        syncMode();
      });
    }

    function fillDraftIntoForm(draft) {
      if (!draft) return;
      serviceEditor.open = true;
      setSingleServiceReady(true);
      mode.value = "hosted-http";
      serviceIdTouched = true;
      providerIdTouched = true;
      titleInput.value = draft.title || "";
      providerNameInput.value = draft.provider_name || draft.provider_id || "";
      serviceIdInput.value = draft.service_id || slugify(draft.title || "service", "service");
      providerIdInput.value = draft.provider_id || slugify(draft.provider_name || "provider", "provider");
      descriptionInput.value = draft.description_for_agent || "";
      capabilitiesInput.dataset.touched = "true";
      capabilitiesInput.value = (draft.capabilities || []).join(",");
      priceInput.value = draft.price || importDefaultPrice.value || "0.01";
      sampleRequestInput.value = JSON.stringify(draft.sample_request || {}, null, 2);
      syncInputContractStatus(draft);
      sampleDataInput.value = JSON.stringify(draft.preview_data ?? { ok: true }, null, 2);
      previewDataView.textContent = sampleDataInput.value;
      liveDataInput.value = JSON.stringify(draft.preview_data ?? { ok: true }, null, 2);
      summaryInput.value = draft.summary || "";
      upstreamUrlInput.value = draft.upstream_url || "";
      upstreamMethodInput.value = draft.method || "GET";
      secretNameInput.value = draft.secret_name || "PROVIDER_SECRET";
      secretValueInput.value = draft.secret_value || importSecretValue.value || "";
      authHeaderInput.value = draft.auth_header || (secretValueInput.value ? "auto" : "authorization");
      syncMode();
      syncContractPreview(draft);
      syncEnvelopePreview();
      updateSidePanel({ selectedDraft: draft });
      status.textContent = "Generated metadata and contract";
      status.classList.remove("error");
      result.textContent = JSON.stringify({
        filled_from_draft: draft.service_id,
        generated: ["service metadata", "routing tags", "input contract", "preview response"],
        next_step: "Only edit fields if you need to override the generated service."
      }, null, 2);
    }

    function syncPreviewData() {
      if (!previewSettings.open) {
        sampleDataInput.value = liveDataInput.value;
      }
      previewDataView.textContent = sampleDataInput.value;
      syncContractPreview();
    }

    function syncContractPreview(draft = null) {
      if (!contractPreview) return;
      const sample = safeJson(sampleRequestInput.value, {});
      const preview = safeJson(sampleDataInput.value, { example: "preview" });
      const contract = draft?.data_contract || {
        request: {
          method: upstreamMethodInput.value || (mode.value === "hosted-http" ? "GET" : "STATIC"),
          path: mode.value === "hosted-http" ? endpointPath(upstreamUrlInput.value) : "provider-hosted-json",
          example: sample
        },
        response: {
          content_type: "application/json",
          preview_shape: shapeFor(preview)
        }
      };
      contractPreview.textContent = JSON.stringify(contract, null, 2);
      syncInputContractStatus(draft);
    }

    function syncInputContractStatus(draft = null) {
      if (!inputContractStatus) return;
      const sample = draft?.sample_request || safeJson(sampleRequestInput.value, {});
      const keys = Object.keys(sample || {});
      const source = draft?.source_type === "skill_import" ? "Skill" : draft?.discovery_note ? "Endpoint URL" : draft ? "OpenAPI" : "Editor";
      inputContractStatus.innerHTML = [
        '<span class="contract-pill">Input auto-filled</span>',
        '<span class="contract-pill neutral">' + (keys.length ? keys.length + ' field' + (keys.length === 1 ? '' : 's') + ': ' + escapeHtml(keys.slice(0, 4).join(", ")) : 'No input required') + '</span>',
        '<span class="contract-pill neutral">Source: ' + escapeHtml(source) + '</span>'
      ].join("");
    }

    function syncEnvelopePreview() {
      const dataSource = mode.value === "hosted-http" ? "hosted_http" : "static_json";
      const sample = safeJson(sampleRequestInput.value, {});
      const data = mode.value === "hosted-http"
        ? safeJson(sampleDataInput.value, { example: "preview" })
        : safeJson(liveDataInput.value, { example: "result" });
      const envelope = {
        schema_version: "agent_data_envelope_v1",
        service_id: serviceIdInput.value || "generated_service_id",
        request_id: "req_example",
        status: "success",
        query: sample,
        data,
        metadata: {
          data_sources: ["provider_config_" + dataSource],
          generated_at: new Date(0).toISOString(),
          freshness_seconds: mode.value === "hosted-http" ? 60 : 86400,
          is_estimated: mode.value !== "hosted-http",
          confidence: mode.value === "hosted-http" ? 0.8 : 0.7,
          limitations: ["MVP example response format."]
        },
        agent_hints: {
          good_for: ["Agent response parsing"],
          warnings: [],
          suggested_followups: []
        },
        summary: summaryInput.value || "Short result summary."
      };
      envelopePreview.textContent = JSON.stringify(envelope, null, 2);
      syncContractPreview();
      updateSidePanel();
    }

    function endpointPath(value) {
      try {
        return new URL(value, window.location.origin).pathname;
      } catch {
        return value || "";
      }
    }

    function shapeFor(value) {
      if (Array.isArray(value)) return value.length ? [shapeFor(value[0])] : [];
      if (value && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, child]) => [key, shapeFor(child)]));
      }
      if (value === null) return "null";
      return typeof value;
    }

    function updateSidePanel(extra = {}) {
      if (!sidePanel) return;
      const checks = [
        ["Service name", titleInput.value],
        ["Provider name", providerNameInput.value],
        ["Price", priceInput.value],
        ["Example request", sampleRequestInput.value],
        [mode.value === "hosted-http" ? "API endpoint" : "Result data", mode.value === "hosted-http" ? upstreamUrlInput.value : liveDataInput.value],
        ["Summary", summaryInput.value]
      ];
      const tags = (capabilitiesInput.value || "").split(",").map((item) => item.trim()).filter(Boolean);
      const cards = [];
      cards.push(
        '<div class="side-card"><h3>Publish Checklist</h3><div class="check-list">' +
        checks.map(([label, value]) => '<div class="check-item ' + (String(value || "").trim() ? "done" : "") + '"><span>' + (String(value || "").trim() ? "✓" : "○") + '</span><span>' + escapeHtml(label) + '</span></div>').join("") +
        "</div></div>"
      );
      if (extra.importSummary) {
        cards.push(
          '<div class="side-card"><h3>Discovered Endpoints</h3><div class="kv">' +
          '<div>Found</div><div>' + extra.importSummary.found + '</div>' +
          '<div>Selected</div><div>' + (extra.importSummary.selected ?? extra.importSummary.found) + '</div>' +
          '<div>Published</div><div>' + (extra.importSummary.published || 0) + '</div>' +
          '<div>Skipped</div><div>' + extra.importSummary.skipped + '</div>' +
          '<div>Import type</div><div>' + escapeHtml(importModeLabel(extra.importSummary.mode)) + '</div>' +
          '<div>Provider</div><div>' + escapeHtml(extra.importSummary.provider || "auto-detected") + '</div>' +
          '<div>Source</div><div>' + escapeHtml(extra.importSummary.source) + '</div>' +
          "</div></div>"
        );
      }
      cards.push(
        '<div class="side-card"><h3>Agent Preview</h3><div class="kv">' +
        '<div>Title</div><div>' + escapeHtml(titleInput.value || "Untitled service") + '</div>' +
        '<div>Price</div><div>' + escapeHtml(priceInput.value || "0.01") + ' USDC</div>' +
        '<div>Source</div><div>' + (mode.value === "hosted-http" ? "HTTP endpoint" : "Pasted data") + '</div>' +
        '<div>Endpoint</div><div>' + escapeHtml(mode.value === "hosted-http" ? upstreamUrlInput.value || "Not set" : "Hosted by ADN runtime") + '</div>' +
        "</div></div>"
      );
      cards.push(
        '<div class="side-card"><h3>Routing Tags</h3><div class="pill-row">' +
        (tags.length ? tags.map((tag) => '<span class="pill">' + escapeHtml(tag) + '</span>').join("") : '<span class="pill">data_service</span>') +
        "</div></div>"
      );
      if (extra.publishResult) {
        cards.push(
          '<div class="side-card"><h3>' + (extra.publishResult.ok ? "Published" : "Needs Attention") + '</h3><div class="kv">' +
          '<div>Service ID</div><div>' + escapeHtml(extra.publishResult.service_id || "-") + '</div>' +
          '<div>Validation</div><div>' + escapeHtml(extra.publishResult.validation?.ok ? "passed" : "failed") + '</div>' +
          '<div>Endpoint</div><div>' + escapeHtml(extra.publishResult.endpoint || "-") + '</div>' +
          "</div></div>"
        );
      }
      if (extra.batchPublishResult) {
        const failedList = (extra.batchPublishResult.failed || []).slice(0, 6).map((item) =>
          '<div class="issue-item"><strong>' + escapeHtml(item.service_id) + '</strong><span>' + escapeHtml(publishFailureReason(item)) + '</span></div>'
        ).join("");
        cards.push(
          '<div class="side-card"><h3>' + (extra.batchPublishResult.ok ? "Verified Services" : "Verification Issues") + '</h3><div class="kv">' +
          '<div>Registry</div><div>' + escapeHtml(extra.batchPublishResult.remote_registry_url || "current") + '</div>' +
          '<div>Verified</div><div>' + escapeHtml(extra.batchPublishResult.published?.length || 0) + '</div>' +
          '<div>Failed</div><div>' + escapeHtml(extra.batchPublishResult.failed?.length || 0) + '</div>' +
          '<div>Routable services</div><div>' + escapeHtml((extra.batchPublishResult.published || []).map((item) => item.service_id).join(", ") || "-") + '</div>' +
          "</div>" +
          (failedList ? '<div class="issue-list">' + failedList + '</div>' : '') +
          "</div>"
        );
      }
      sidePanel.innerHTML = cards.join("");
    }

    function safeJson(value, fallback) {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      hideNotice(formMessage);
      if (!singleServiceReady) {
        showNotice(formMessage, "Choose Edit Details on a discovered endpoint, or open the manual editor before creating a single service.", "error");
        return;
      }
      const clientErrors = validateSingleServiceForm();
      if (clientErrors.length) {
        serviceEditor.open = true;
        status.textContent = "Check required fields";
        status.classList.add("error");
        showNotice(formMessage, clientErrors.join(" "), "error");
        result.textContent = JSON.stringify({
          ok: false,
          code: "CLIENT_VALIDATION_FAILED",
          errors: clientErrors
        }, null, 2);
        return;
      }
      if (publishedServiceIds.has(serviceIdInput.value)) {
        status.textContent = "Already published";
        status.classList.add("error");
        showNotice(formMessage, "This service is already published. Use the published endpoint card or change the Service ID in Advanced routing metadata.", "error");
        result.textContent = JSON.stringify({
          ok: false,
          code: "SERVICE_ALREADY_PUBLISHED",
          message: "This endpoint was already published from the discovered endpoint card."
        }, null, 2);
        return;
      }
      status.textContent = "Submitting...";
      status.classList.remove("error");
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await fetch("/studio/providers", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data)
        });
        const payload = await response.json();
        result.textContent = JSON.stringify(payload, null, 2);
        const alreadyRegistered = payload.error?.message?.includes("already registered");
        status.textContent = payload.ok ? "Validated" : alreadyRegistered ? "Already published" : "Validation failed";
        status.classList.toggle("error", !payload.ok);
        if (payload.ok) publishedServiceIds.add(payload.service_id);
        if (payload.ok) {
          discoveredDrafts = discoveredDrafts.map((draft) => draft.service_id === payload.service_id
            ? { ...draft, selected: false, published: true }
            : draft);
          renderDraftList(discoveredDrafts);
          updateDraftSelectionUi();
          setSingleServiceReady(false);
        }
        showNotice(
          formMessage,
          payload.ok
            ? "Service published and validated successfully."
            : userFacingError(payload),
          payload.ok ? "success" : "error"
        );
        updateSidePanel({ publishResult: payload });
      } catch (error) {
        status.textContent = "Error";
        status.classList.add("error");
        showNotice(formMessage, error.message || "Publish failed.", "error");
        result.textContent = error.stack || error.message;
      }
    });
  } catch (error) {
    const target = document.querySelector("#import-status") || document.querySelector("#status");
    if (target) {
      target.textContent = "Studio script error: " + error.message;
      target.classList.add("error");
    }
    console.error(error);
  }
  })();
  </script>
</body>
</html>`;
}

function defaultsFromDraft(draft) {
  const defaultLiveData = {
    asset: "ETH",
    sentiment_score: 0.74,
    mentions: 18230,
    positive_ratio: 0.67
  };
  if (draft) {
    const preview = draft.preview_data ?? { ok: true };
    return {
      mode: "hosted-http",
      price: draft.price || "0.01",
      title: draft.title || "Imported API Service",
      providerName: draft.provider_name || draft.provider_id || "Imported API",
      description: draft.description_for_agent || "Use this service to call an imported API endpoint.",
      capabilities: (draft.capabilities || ["data_service"]).join(","),
      serviceId: draft.service_id || normalizeId(null, draft.title, "service"),
      providerId: draft.provider_id || normalizeId(null, draft.provider_name, "provider"),
      sampleRequest: prettyJson(draft.sample_request || {}),
      sampleData: prettyJson(preview),
      liveData: prettyJson(preview),
      summary: draft.summary || "",
      payoutAddress: draft.payout_address || "",
      upstreamUrl: draft.upstream_url || "",
      upstreamMethod: draft.method || "GET",
      authHeader: draft.auth_header || (draft.secret_value ? "auto" : "authorization"),
      secretName: draft.secret_name || "PROVIDER_SECRET",
      secretValue: draft.secret_value || ""
    };
  }
  return {
    mode: "static-json",
    price: "0.01",
    title: "",
    providerName: "",
    description: "",
    capabilities: "",
    serviceId: "",
    providerId: "",
    sampleRequest: prettyJson({ asset: "ETH", window: "7d" }),
    sampleData: prettyJson(defaultLiveData),
    liveData: prettyJson(defaultLiveData),
    summary: "ETH community sentiment is positive over the selected window.",
    payoutAddress: "",
    upstreamUrl: "",
    upstreamMethod: "POST",
    authHeader: "authorization",
    secretName: "PROVIDER_SECRET",
    secretValue: ""
  };
}

export function draftFromServiceRecord(record, config = null) {
  const manifest = record?.manifest || {};
  const source = config?.source || {};
  const hosted = source.type === "hosted_http";
  return {
    selected: false,
    published: true,
    service_id: manifest.service_id,
    provider_id: manifest.provider?.provider_id,
    provider_name: manifest.provider?.provider_id,
    title: manifest.title,
    description_for_agent: manifest.description_for_agent,
    capabilities: manifest.capabilities || [],
    price: manifest.pricing?.amount || "0.01",
    method: hosted ? source.upstream_method || "GET" : "POST",
    path: hosted ? safePath(source.upstream_url) : "provider-hosted-json",
    upstream_url: hosted ? source.upstream_url || "" : "",
    auth_header: source.auth?.header || "",
    secret_name: source.auth?.secret_name || "PROVIDER_SECRET",
    secret_value: "",
    sample_request: manifest.sample_request || {},
    preview_data: manifest.sample_response?.data || {},
    summary: manifest.agent_contract?.summary || source.summary || "",
    payout_address: manifest.provider?.payout_address || manifest.pricing?.pay_to || "",
    data_contract: {
      request: {
        method: hosted ? source.upstream_method || "GET" : "STATIC",
        path: hosted ? safePath(source.upstream_url) : "provider-hosted-json",
        example: manifest.sample_request || {}
      },
      response: {
        content_type: "application/json",
        preview_shape: shapeForDraft(manifest.sample_response?.data || {})
      }
    }
  };
}

function safePath(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return value || "";
  }
}

function shapeForDraft(value) {
  if (Array.isArray(value)) return value.length ? [shapeForDraft(value[0])] : [];
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 12).map(([key, child]) => [key, shapeForDraft(child)]));
  }
  if (value === null) return "null";
  return typeof value;
}

function prettyJson(value) {
  return JSON.stringify(value, null, 2);
}

function brandLogo() {
  return `
    <span class="brand-icon" aria-hidden="true"><img src="/assets/brand/logo.png" alt=""></span>
    <span class="brand-word">AgentRouter</span>
  `;
}

function faviconLinks() {
  return `
  <link rel="icon" type="image/png" href="/favicon.png" />
  <link rel="shortcut icon" href="/favicon.ico" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />`;
}

function html(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
