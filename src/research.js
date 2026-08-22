import { authModalHtml, authModalStyles } from "./auth-modal.js";
import { clientRouterScript, naiveDesignSystemStyles } from "./app-shell.js";

const PLATFORMS = new Set(["x", "reddit", "xiaohongshu", "bilibili", "youtube", "facebook", "other"]);
const STANCES = new Set(["support", "oppose", "neutral"]);

export function createResearchDraft(input = {}) {
  const question = clean(input.question, 500);
  if (!question) {
    const error = new Error("question is required");
    error.statusCode = 422;
    error.code = "RESEARCH_QUESTION_REQUIRED";
    throw error;
  }
  const platforms = [...new Set((Array.isArray(input.platforms) ? input.platforms : ["x", "reddit"])
    .map((value) => clean(value, 32).toLowerCase())
    .filter((value) => PLATFORMS.has(value)))];
  const createdAt = new Date().toISOString();
  return {
    project_version: "creator_research_project_v1",
    project_id: `research_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    question,
    audience: clean(input.audience, 200) || "AI、科技与产品领域内容受众",
    output_language: clean(input.output_language, 20) || "zh-CN",
    time_range: clean(input.time_range, 32) || "30d",
    platforms: platforms.length ? platforms : ["x", "reddit"],
    status: "manual_evidence_required",
    data_status: {
      connected_sources: [],
      mode: "manual",
      message: "尚未配置合规社交数据连接器。请添加真实原帖作为证据；系统不会生成虚假帖子。"
    },
    suggested_queries: buildSuggestedQueries(question, platforms),
    evidence_schema: socialEvidenceSchema(),
    evidence: [],
    created_at: createdAt,
    updated_at: createdAt
  };
}

export function normalizeSocialEvidenceItem(input = {}) {
  const platform = clean(input.platform, 32).toLowerCase();
  const canonicalUrl = clean(input.canonical_url || input.url, 2048);
  const excerpt = clean(input.text_excerpt || input.excerpt, 1200);
  if (!PLATFORMS.has(platform)) {
    const error = new Error("platform must be x, reddit, xiaohongshu, bilibili, youtube, facebook, or other");
    error.statusCode = 422;
    error.code = "INVALID_EVIDENCE_PLATFORM";
    throw error;
  }
  if (!canonicalUrl || !/^https?:\/\//i.test(canonicalUrl)) {
    const error = new Error("canonical_url must be an http(s) URL");
    error.statusCode = 422;
    error.code = "INVALID_EVIDENCE_URL";
    throw error;
  }
  if (!excerpt) {
    const error = new Error("text_excerpt is required");
    error.statusCode = 422;
    error.code = "EVIDENCE_EXCERPT_REQUIRED";
    throw error;
  }
  const stance = clean(input.stance, 20).toLowerCase();
  return {
    evidence_version: "social_evidence_item_v1",
    evidence_id: clean(input.evidence_id, 120) || `evidence_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    platform,
    post_id: clean(input.post_id, 200) || null,
    canonical_url: canonicalUrl,
    author_handle: clean(input.author_handle, 200) || null,
    published_at: validDate(input.published_at),
    retrieved_at: new Date().toISOString(),
    language: clean(input.language, 20) || "unknown",
    text_excerpt: excerpt,
    stance: STANCES.has(stance) ? stance : "neutral",
    theme: clean(input.theme, 120) || "未分类",
    engagement: normalizeEngagement(input.engagement),
    thread_context: clean(input.thread_context, 600) || null,
    source_type: clean(input.source_type, 40) || "manual_user_input",
    license_or_usage_status: clean(input.license_or_usage_status, 80) || "link_and_short_excerpt_only",
    provider_id: clean(input.provider_id, 120) || "manual",
    content_hash: null,
    notes: clean(input.notes, 500) || null
  };
}

export function researchHtml(auth = {}) {
  const authNavigation = auth.user
    ? `<span title="${escapeHtml(auth.user.email || auth.user.provider || "")}">${escapeHtml(auth.user.name || auth.user.handle || "已登录")}</span><a href="/auth/logout">退出登录</a>`
    : `<a href="?login=1" data-auth-modal-trigger>登录</a>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Creator Research Terminal · AgentRouter</title>
  <style data-agentrouter-page-style>
    :root{--bg:#0b0c0e;--panel:#121418;--panel2:#181b20;--line:#292d34;--text:#f3f4f6;--muted:#8d95a3;--accent:#f0b90b;--green:#18b981;--red:#e6546b;--blue:#5aa7ff;--radius:10px;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:dark}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-size:14px}.shell{max-width:1440px;margin:auto;padding:0 24px}.topbar{height:58px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:rgba(11,12,14,.94);backdrop-filter:blur(14px);z-index:20}.brand{display:flex;align-items:center;gap:10px;font-weight:800}.brand i{width:11px;height:11px;border-radius:3px;background:var(--accent);box-shadow:0 0 18px rgba(240,185,11,.38)}.topbar a{color:var(--muted);text-decoration:none;font-size:12px}.topbar a:hover{color:var(--text)}
    main{padding:32px 0 64px}.hero{display:flex;justify-content:space-between;gap:24px;align-items:flex-end;margin-bottom:22px}.eyebrow{color:var(--accent);font-size:11px;text-transform:uppercase;letter-spacing:.12em;font-weight:800}.hero h1{font-size:34px;letter-spacing:-.04em;margin:8px 0}.hero p{margin:0;color:var(--muted);max-width:710px;line-height:1.65}.mode{border:1px solid var(--line);background:var(--panel);padding:8px 11px;border-radius:999px;color:var(--muted);font-size:11px}.mode b{color:var(--accent)}
    .layout{display:grid;grid-template-columns:360px minmax(0,1fr);gap:16px}.panel{border:1px solid var(--line);background:var(--panel);border-radius:var(--radius)}.sidebar{padding:18px;align-self:start;position:sticky;top:76px}.panel-title{font-size:13px;font-weight:800;margin-bottom:14px}.field{margin-bottom:13px}.field label{display:block;color:var(--muted);font-size:10px;font-weight:700;margin:0 0 6px}.input,.select,.textarea{width:100%;border:1px solid var(--line);background:#0e1013;color:var(--text);border-radius:7px;padding:10px 11px;font:inherit;outline:none}.textarea{min-height:112px;resize:vertical;line-height:1.55}.input:focus,.select:focus,.textarea:focus{border-color:#6d5b1b;box-shadow:0 0 0 3px rgba(240,185,11,.07)}.platforms{display:flex;gap:7px;flex-wrap:wrap}.platform{border:1px solid var(--line);background:var(--panel2);color:var(--muted);border-radius:999px;padding:7px 10px;cursor:pointer;font-size:11px}.platform.active{border-color:rgba(240,185,11,.48);color:var(--accent);background:rgba(240,185,11,.08)}.button{border:1px solid var(--line);background:var(--panel2);color:var(--text);padding:9px 12px;border-radius:7px;font-weight:750;cursor:pointer}.button:hover{border-color:#555b65}.button.primary{background:var(--accent);border-color:var(--accent);color:#111}.button.block{width:100%}.button:disabled{opacity:.5;cursor:not-allowed}.hint{font-size:10.5px;color:var(--muted);line-height:1.5;margin-top:8px}
    .workspace{min-width:0}.empty{min-height:510px;display:grid;place-items:center;text-align:center;padding:60px}.empty-icon{width:54px;height:54px;margin:auto;border:1px solid var(--line);border-radius:14px;display:grid;place-items:center;color:var(--accent);font-size:20px}.empty h2{font-size:18px;margin:16px 0 8px}.empty p{color:var(--muted);line-height:1.65;max-width:520px;margin:0}.hidden{display:none!important}
    .statusbar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:13px 15px;border-bottom:1px solid var(--line)}.statuscopy{display:flex;align-items:center;gap:9px;color:var(--muted);font-size:11px}.statuscopy i{width:8px;height:8px;background:var(--accent);border-radius:50%}.actions{display:flex;gap:7px}.project{padding:18px}.project-head{display:flex;justify-content:space-between;gap:18px;margin-bottom:16px}.project-head h2{margin:0 0 5px;font-size:20px}.project-head p{color:var(--muted);margin:0;font-size:11px}.metric-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:16px}.metric{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:11px}.metric span{display:block;color:var(--muted);font-size:9px;margin-bottom:5px}.metric strong{font-size:18px}.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:16px}.tab{border:0;background:none;color:var(--muted);padding:10px 12px;cursor:pointer;font-weight:700;font-size:11px;border-bottom:2px solid transparent}.tab.active{color:var(--accent);border-bottom-color:var(--accent)}
    .notice{border:1px solid rgba(240,185,11,.24);background:rgba(240,185,11,.055);border-radius:8px;padding:12px 13px;color:#d7c887;font-size:11px;line-height:1.6;margin-bottom:14px}.query-list{display:flex;gap:7px;flex-wrap:wrap}.query{padding:7px 9px;border:1px solid var(--line);background:var(--panel2);border-radius:6px;color:var(--muted);font-size:10px;cursor:pointer}.query:hover{color:var(--text)}.search-log{display:grid;gap:6px;margin:10px 0}.search-row{display:flex;justify-content:space-between;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:6px;color:var(--muted);font-size:10px}.search-row b{color:var(--text)}.candidate-list{display:grid;gap:8px}.candidate{border:1px solid rgba(90,167,255,.25);background:rgba(90,167,255,.045);border-radius:8px;padding:12px}.candidate h4{font-size:12px;margin:0 0 7px}.candidate p{color:var(--muted);font-size:11px;line-height:1.55}.candidate-actions{display:flex;justify-content:space-between;align-items:center;gap:10px}.candidate-actions a{color:var(--blue);font-size:10px;text-decoration:none}
    .section-head{display:flex;justify-content:space-between;align-items:center;margin:18px 0 10px}.section-head h3{font-size:13px;margin:0}.section-head span{font-size:10px;color:var(--muted)}.evidence-list{display:grid;gap:8px}.evidence{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:12px}.evidence-top{display:flex;justify-content:space-between;gap:10px;margin-bottom:7px}.evidence-source{display:flex;align-items:center;gap:7px;font-size:10px;color:var(--muted)}.badge{border-radius:4px;padding:3px 6px;font-size:9px;font-weight:800;text-transform:uppercase}.badge.x{background:rgba(90,167,255,.12);color:var(--blue)}.badge.reddit{background:rgba(255,99,52,.12);color:#ff754d}.badge.support{background:rgba(24,185,129,.12);color:var(--green)}.badge.oppose{background:rgba(230,84,107,.12);color:var(--red)}.badge.neutral{background:#272b31;color:var(--muted)}.evidence blockquote{margin:0;color:#d9dde4;line-height:1.6;font-size:12px}.evidence-foot{display:flex;justify-content:space-between;align-items:center;margin-top:9px;color:var(--muted);font-size:9px}.evidence-foot a{color:var(--accent);text-decoration:none}.remove{border:0;background:none;color:var(--muted);cursor:pointer;font-size:10px}.remove:hover{color:var(--red)}
    .columns{display:grid;grid-template-columns:1fr 1fr;gap:10px}.brief-box{border:1px solid var(--line);background:var(--panel2);border-radius:8px;padding:13px;min-height:120px}.brief-box h4{margin:0 0 8px;font-size:11px}.brief-box p,.brief-box li{font-size:11px;color:var(--muted);line-height:1.6}.brief-box ul{margin:0;padding-left:17px}.empty-small{color:var(--muted);font-size:11px;padding:24px;text-align:center;border:1px dashed var(--line);border-radius:8px}.connection-list{display:grid;gap:8px;margin-top:12px}.connection-row{border:1px solid var(--line);border-radius:7px;padding:10px;display:flex;justify-content:space-between;gap:12px}.connection-row small{display:block;color:var(--muted);margin-top:4px}
    dialog{width:min(620px,calc(100vw - 30px));border:1px solid var(--line);background:var(--panel);color:var(--text);border-radius:10px;padding:0;box-shadow:0 28px 80px rgba(0,0,0,.55)}dialog::backdrop{background:rgba(0,0,0,.72)}.dialog-head{padding:16px 18px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between}.dialog-head h3{margin:0;font-size:14px}.dialog-body{padding:18px}.dialog-foot{padding:13px 18px;border-top:1px solid var(--line);display:flex;justify-content:flex-end;gap:7px}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px}
    @media(max-width:900px){.layout{grid-template-columns:1fr}.sidebar{position:static}.metric-grid{grid-template-columns:1fr 1fr}.hero{align-items:flex-start;flex-direction:column}.columns{grid-template-columns:1fr}}@media(max-width:560px){.shell{padding:0 14px}.hero h1{font-size:27px}.metric-grid,.grid2{grid-template-columns:1fr}.actions{flex-wrap:wrap}.project-head{flex-direction:column}}
    ${authModalStyles()}
    ${naiveDesignSystemStyles()}
  </style>
</head>
<body data-agentrouter-app>
  <header class="topbar"><div class="shell" style="width:100%;display:flex;justify-content:space-between"><div class="brand"><i></i>Creator Research Terminal</div><nav style="display:flex;gap:14px;align-items:center"><button class="button" id="manage-connections">连接数据源</button><a href="/">AgentRouter</a>${authNavigation}</nav></div></header>
  <main class="shell">
    <section class="hero"><div><span class="eyebrow">Dogfood MVP · Evidence first</span><h1>从真实讨论到内容判断</h1><p>通过本地只读连接器检索 X、Reddit、小红书、B站、YouTube 和 Facebook。登录凭证与原始数据默认留在你的设备上。</p></div><div class="mode"><b>●</b> Local-first privacy</div></section>
    <div class="layout">
      <aside class="panel sidebar">
        <div class="panel-title">新建研究</div>
        <div class="field"><label>研究问题</label><textarea class="textarea" id="question" placeholder="例如：AgentRouter 会不会只是另一个 API Marketplace？"></textarea></div>
        <div class="field"><label>目标受众</label><input class="input" id="audience" value="AI、科技与产品领域内容受众"></div>
        <div class="field"><label>研究平台</label><div class="platforms"><button class="platform active" data-platform="x">X</button><button class="platform active" data-platform="reddit">Reddit</button><button class="platform" data-platform="xiaohongshu">小红书</button><button class="platform" data-platform="bilibili">B站</button><button class="platform" data-platform="youtube">YouTube</button><button class="platform" data-platform="facebook">Facebook</button></div></div>
        <div class="grid2"><div class="field"><label>时间范围</label><select class="select" id="time-range"><option value="7d">近 7 天</option><option value="30d" selected>近 30 天</option><option value="90d">近 90 天</option></select></div><div class="field"><label>输出语言</label><select class="select" id="language"><option value="zh-CN">中文</option><option value="en">English</option></select></div></div>
        <button class="button primary block" id="start">开始研究</button>
        <p class="hint">本地连接器只执行白名单读取操作。登录凭证不上传；原文仅在你明确同意时发送给分析模型。</p>
      </aside>
      <section class="panel workspace">
        <div class="empty" id="empty"><div><div class="empty-icon">⌕</div><h2>建立第一份证据型研究</h2><p>建议从你本周真实想发布的内容开始。创建项目后，加入原帖链接与短摘录，系统会形成支持、反对和内容机会结构。</p></div></div>
        <div id="research" class="hidden">
          <div class="statusbar"><div class="statuscopy"><i></i><span id="status-text">等待真实证据</span></div><div class="actions"><button class="button primary" id="search-live">⌕ 搜索公开讨论</button><button class="button" id="add-evidence">＋ 添加证据</button><button class="button" id="copy-brief">复制 Brief</button><button class="button" id="export-json">导出 JSON</button></div></div>
          <div class="project">
            <div class="project-head"><div><h2 id="project-title"></h2><p id="project-meta"></p></div></div>
            <div class="metric-grid"><div class="metric"><span>证据总数</span><strong id="m-total">0</strong></div><div class="metric"><span>支持</span><strong id="m-support" style="color:var(--green)">0</strong></div><div class="metric"><span>反对</span><strong id="m-oppose" style="color:var(--red)">0</strong></div><div class="metric"><span>平台覆盖</span><strong id="m-platforms">0/2</strong></div></div>
            <div class="tabs"><button class="tab active" data-view="evidence">证据</button><button class="tab" data-view="brief">内容 Brief</button><button class="tab" data-view="method">数据边界</button></div>
            <div id="view-evidence">
              <div class="notice" id="data-notice"></div>
              <div class="section-head"><h3>建议检索词</h3><span>点击复制</span></div><div class="query-list" id="queries"></div>
              <div id="search-results" class="hidden"><div class="section-head"><h3>Provider 检索结果</h3><span>候选结果必须打开原帖确认</span></div><div class="search-log" id="search-log"></div><div class="candidate-list" id="candidate-list"></div></div>
              <div class="section-head"><h3>原始证据</h3><span id="evidence-count">0 条</span></div><div class="evidence-list" id="evidence-list"></div>
            </div>
            <div id="view-brief" class="hidden"><div class="columns"><div class="brief-box"><h4 style="color:var(--green)">支持这个观点</h4><div id="brief-support"></div></div><div class="brief-box"><h4 style="color:var(--red)">反对这个观点</h4><div id="brief-oppose"></div></div><div class="brief-box"><h4>中性与背景</h4><div id="brief-neutral"></div></div><div class="brief-box"><h4 style="color:var(--accent)">可写的内容角度</h4><div id="brief-angles"></div></div></div><div class="notice" style="margin-top:12px">当前内容角度只根据你添加的证据生成结构提示；不会把缺失证据补写成事实。</div></div>
            <div id="view-method" class="hidden"><div class="brief-box"><h4>当前数据覆盖</h4><p id="coverage-copy"></p></div><div class="brief-box" style="margin-top:10px"><h4>不能据此证明</h4><ul><li>帖子样本代表整个平台用户。</li><li>互动量等于真实需求或付费意愿。</li><li>作者身份、动机或陈述事实已经得到独立验证。</li><li>未接入的平台没有相关讨论。</li></ul></div></div>
          </div>
        </div>
      </section>
    </div>
  </main>
  <dialog id="evidence-dialog"><form method="dialog" id="evidence-form"><div class="dialog-head"><h3>添加真实证据</h3><button class="remove" value="cancel">关闭</button></div><div class="dialog-body"><div class="grid2"><div class="field"><label>平台</label><select class="select" id="ev-platform"><option value="x">X</option><option value="reddit">Reddit</option><option value="xiaohongshu">小红书</option><option value="other">其他</option></select></div><div class="field"><label>立场</label><select class="select" id="ev-stance"><option value="support">支持</option><option value="oppose">反对</option><option value="neutral">中性/背景</option></select></div></div><div class="field"><label>原帖链接</label><input class="input" id="ev-url" type="url" placeholder="https://..."></div><div class="field"><label>短摘录</label><textarea class="textarea" id="ev-excerpt" placeholder="粘贴最能代表观点的短摘录，不要复制整篇内容"></textarea></div><div class="grid2"><div class="field"><label>作者（可选）</label><input class="input" id="ev-author" placeholder="@handle"></div><div class="field"><label>主题标签</label><input class="input" id="ev-theme" placeholder="例如：API 信任"></div></div><div class="field"><label>你的判断备注（可选）</label><input class="input" id="ev-notes" placeholder="为什么这条证据重要？"></div><div class="hint" id="form-error" style="color:var(--red)"></div></div><div class="dialog-foot"><button class="button" value="cancel">取消</button><button class="button primary" id="save-evidence" value="default">加入研究</button></div></form></dialog>
  <dialog id="connections-dialog"><div class="dialog-head"><h3>连接自己的 API 数据源</h3><button class="remove" id="close-connections">关闭</button></div><div class="dialog-body"><div class="notice">凭证只在服务端加密保存，AgentRouter 调用结果、日志和浏览器响应均不会返回密钥。当前连接全部只读。</div><div class="grid2"><div class="field"><label>平台</label><select class="select" id="conn-platform"><optgroup label="社交媒体"><option value="x">X</option><option value="reddit">Reddit</option><option value="xiaohongshu">小红书</option></optgroup><optgroup label="搜索与抓取"><option value="brave_search">Brave Search</option><option value="tavily">Tavily</option><option value="serper">Serper</option><option value="exa">Exa</option><option value="firecrawl">Firecrawl</option><option value="jina">Jina</option></optgroup></select></div><div class="field"><label>连接方式</label><select class="select" id="conn-provider"><option value="local_browser">本地浏览器</option><option value="x_api">X 官方 API</option><option value="reddit_api">Reddit API</option><option value="brave_api">Brave API</option><option value="tavily_api">Tavily API</option><option value="serper_api">Serper API</option><option value="exa_api">Exa API</option><option value="firecrawl_api">Firecrawl API</option><option value="jina_api">Jina API</option></select></div></div><div class="field"><label>显示名称</label><input class="input" id="conn-label" placeholder="例如：团队 Brave Search"></div><div class="field" id="conn-secret-field"><label>API Token</label><input class="input" id="conn-secret" type="password" autocomplete="off" placeholder="只在保存时提交，不会再次显示"></div><button class="button primary" id="save-connection">保存连接</button><div class="hint" id="conn-message"></div><div class="connection-list" id="connection-list"></div></div></dialog>
  <script>
    let project=null;const storageKey="agentrouter_creator_research_v1";
    const el=id=>document.getElementById(id);const esc=value=>String(value??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
    const localPlatformLabels={bilibili:"B站",youtube:"YouTube",facebook:"Facebook"};for(const [value,label] of Object.entries(localPlatformLabels)){for(const id of ["ev-platform","conn-platform"]){const select=el(id);if(select&&![...select.options].some(option=>option.value===value))select.add(new Option(label,value))}}
    const externalConnectionProviders={youtube:{label:"YouTube Data API",provider:"youtube_api"},virus_total:{label:"VirusTotal",provider:"virustotal_api"},google_places:{label:"Google Places",provider:"google_places_api"},amadeus:{label:"Amadeus",provider:"amadeus_api"},easy_post:{label:"EasyPost",provider:"easypost_api"},openalex:{label:"OpenAlex",provider:"openalex_api"}};for(const [platform,definition] of Object.entries(externalConnectionProviders)){const platformSelect=el("conn-platform");if(![...platformSelect.options].some(option=>option.value===platform))platformSelect.add(new Option(definition.label,platform));const providerSelect=el("conn-provider");if(![...providerSelect.options].some(option=>option.value===definition.provider))providerSelect.add(new Option(definition.label,definition.provider))}
    document.querySelectorAll(".platform").forEach(button=>button.onclick=()=>button.classList.toggle("active"));
    document.querySelectorAll(".tab").forEach(button=>button.onclick=()=>switchView(button.dataset.view));
    el("start").onclick=startResearch;el("search-live").onclick=searchLive;el("add-evidence").onclick=()=>el("evidence-dialog").showModal();el("save-evidence").onclick=saveEvidence;el("copy-brief").onclick=copyBrief;el("export-json").onclick=exportJson;el("manage-connections").onclick=()=>{el("connections-dialog").showModal();loadConnections()};el("close-connections").onclick=()=>el("connections-dialog").close();el("save-connection").onclick=saveConnection;el("conn-platform").onchange=syncConnectionForm;el("conn-provider").onchange=syncConnectionForm;syncConnectionForm();const requestedSource=new URLSearchParams(location.search).get("connect_source");if(requestedSource&&[...el("conn-platform").options].some(option=>option.value===requestedSource)){el("conn-platform").value=requestedSource;syncConnectionForm();el("connections-dialog").showModal();loadConnections()}
    function syncConnectionForm(){const platform=el("conn-platform").value;const select=el("conn-provider");const providerByPlatform={x:["x_api"],reddit:["reddit_api"],xiaohongshu:["local_browser"],bilibili:["local_browser"],youtube:["youtube_api","local_browser"],facebook:["local_browser"],brave_search:["brave_api"],tavily:["tavily_api"],serper:["serper_api"],exa:["exa_api"],firecrawl:["firecrawl_api"],jina:["jina_api"],virus_total:["virustotal_api"],google_places:["google_places_api"],amadeus:["amadeus_api"],easy_post:["easypost_api"],openalex:["openalex_api"]};const allowed=providerByPlatform[platform]||[];[...select.options].forEach(option=>option.hidden=!allowed.includes(option.value));if(!allowed.includes(select.value))select.value=allowed[0]||"";el("conn-secret-field").classList.toggle("hidden",select.value==="local_browser")}
    async function loadConnections(){const response=await fetch("/research/api/connections");const payload=await response.json();if(!response.ok){el("connection-list").innerHTML='<div class="empty-small">'+esc(payload.error?.message||"请先登录")+'</div>';return}el("connection-list").innerHTML=payload.connections.length?payload.connections.map(item=>'<div class="connection-row"><div><b>'+esc(item.label)+'</b><small>'+esc(item.platform)+' · '+esc(item.provider_type)+(item.has_credentials?' · 凭证已加密':'')+'</small></div><button class="remove" data-delete-connection="'+esc(item.connection_id)+'">删除</button></div>').join(""):'<div class="empty-small">还没有连接数据源</div>';document.querySelectorAll("[data-delete-connection]").forEach(button=>button.onclick=async()=>{await fetch("/research/api/connections/"+encodeURIComponent(button.dataset.deleteConnection),{method:"DELETE"});loadConnections()})}
    async function saveConnection(){const provider=el("conn-provider").value;const field=provider==="x_api"?"bearer_token":provider==="reddit_api"||provider==="amadeus_api"?"access_token":provider==="local_browser"?null:"api_key";const credentials=field?{[field]:el("conn-secret").value}:{};const response=await fetch("/research/api/connections",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({platform:el("conn-platform").value,provider_type:provider,label:el("conn-label").value,credentials})});const payload=await response.json();el("conn-message").textContent=response.ok?"连接已保存，密钥不会再次显示。":payload.error?.message||"保存失败";if(response.ok){el("conn-secret").value="";loadConnections()}}
    async function startResearch(){const question=el("question").value.trim();if(!question){el("question").focus();return}el("start").disabled=true;try{const response=await fetch("/research/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question,audience:el("audience").value,platforms:[...document.querySelectorAll(".platform.active")].map(x=>x.dataset.platform),time_range:el("time-range").value,output_language:el("language").value})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||"创建失败");project=payload;save();render()}catch(error){alert(error.message)}finally{el("start").disabled=false}}
    async function searchLive(){if(!project)return;const button=el("search-live");button.disabled=true;button.textContent="检索中…";el("status-text").textContent="正在路由社交数据源";try{const response=await fetch("/research/api/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({question:project.question,platforms:project.platforms,language:project.output_language.startsWith("zh")?"zh":"en",limit:10})});const payload=await response.json();if(!response.ok)throw new Error(payload.error?.message||"检索失败");project.search_run=payload.search;project.report=payload.report;project.completion_status=payload.completion_status;project.data_status={connected_sources:[...new Set((payload.search.searches||[]).map(item=>item.provider_id).filter(Boolean))],mode:"routed_provider_search",message:payload.search.evidence_policy};save();renderSearch(payload.search);render()}catch(error){project.search_run={status:"failed",searches:[],candidates:[],error:error.message};el("search-results").classList.remove("hidden");el("search-log").innerHTML='<div class="search-row"><b>Provider 调用失败</b><span>'+esc(error.message)+'</span></div>';el("candidate-list").innerHTML='<div class="empty-small">没有生成任何证据。检查配置或稍后重试。</div>';el("status-text").textContent="检索失败";save()}finally{button.disabled=false;button.textContent="⌕ 搜索公开讨论"}}
    function renderSearch(run){if(!run)return;el("search-results").classList.remove("hidden");el("search-log").innerHTML=(run.searches||[]).map(item=>'<div class="search-row"><b>'+esc(item.platform)+' · '+esc(item.status)+'</b><span>'+esc(item.result_count)+' 条 · '+esc(item.credits_used||0)+' credits</span></div>').join("")||'<div class="search-row"><b>没有执行检索</b><span>0 条</span></div>';el("candidate-list").innerHTML=(run.candidates||[]).length?(run.candidates||[]).map(candidate=>'<article class="candidate"><h4>'+esc(candidate.title||candidate.canonical_url)+'</h4><p>'+esc(candidate.text_excerpt||"搜索服务未返回摘录，请打开来源检查。")+'</p><div class="candidate-actions"><a href="'+esc(candidate.canonical_url)+'" target="_blank" rel="noopener noreferrer">打开来源并核验 ↗</a><button class="button" data-candidate="'+esc(candidate.candidate_id)+'">核验后填入证据</button></div></article>').join(""):'<div class="empty-small">Provider 没有返回候选结果；系统不会用模型补造帖子。</div>';document.querySelectorAll("[data-candidate]").forEach(node=>node.onclick=()=>reviewCandidate(node.dataset.candidate))}
    function reviewCandidate(id){const item=(project.search_run?.candidates||[]).find(candidate=>candidate.candidate_id===id);if(!item)return;el("ev-platform").value=item.platform;el("ev-url").value=item.canonical_url;el("ev-excerpt").value=item.text_excerpt||"";el("ev-theme").value="待分类";el("form-error").textContent="请先打开来源，确认摘录与上下文后再加入证据。";el("evidence-dialog").showModal()}
    function saveEvidence(event){event.preventDefault();if(!project)return;const item={evidence_version:"social_evidence_item_v1",evidence_id:"local_"+Date.now(),platform:el("ev-platform").value,canonical_url:el("ev-url").value.trim(),text_excerpt:el("ev-excerpt").value.trim(),author_handle:el("ev-author").value.trim()||null,stance:el("ev-stance").value,theme:el("ev-theme").value.trim()||"未分类",notes:el("ev-notes").value.trim()||null,retrieved_at:new Date().toISOString(),source_type:"manual_user_input",license_or_usage_status:"link_and_short_excerpt_only",engagement:{}};if(!/^https?:\\/\\//i.test(item.canonical_url)){el("form-error").textContent="请输入有效的原帖链接";return}if(!item.text_excerpt){el("form-error").textContent="请添加一段真实短摘录";return}project.evidence.push(item);project.updated_at=new Date().toISOString();save();el("evidence-form").reset();el("form-error").textContent="";el("evidence-dialog").close();render()}
    function removeEvidence(id){project.evidence=project.evidence.filter(item=>item.evidence_id!==id);save();render()}
    function render(){if(!project)return;el("empty").classList.add("hidden");el("research").classList.remove("hidden");el("project-title").textContent=project.question;el("project-meta").textContent=project.audience+" · "+project.time_range+" · "+project.platforms.join(" + ");el("data-notice").textContent=project.data_status.message;el("status-text").textContent=project.evidence.length?"已加入 "+project.evidence.length+" 条真实证据":project.search_run?"检索完成，等待核验":"等待真实证据";el("queries").innerHTML=project.suggested_queries.map(query=>'<button class="query" data-query="'+esc(query)+'">'+esc(query)+'</button>').join("");document.querySelectorAll(".query").forEach(node=>node.onclick=async()=>{await navigator.clipboard.writeText(node.dataset.query);node.textContent="已复制";setTimeout(()=>node.textContent=node.dataset.query,800)});if(project.search_run)renderSearch(project.search_run);const counts={support:0,oppose:0,neutral:0};project.evidence.forEach(item=>counts[item.stance]=(counts[item.stance]||0)+1);const covered=new Set(project.evidence.map(item=>item.platform));el("m-total").textContent=project.evidence.length;el("m-support").textContent=counts.support;el("m-oppose").textContent=counts.oppose;el("m-platforms").textContent=covered.size+"/"+project.platforms.length;el("evidence-count").textContent=project.evidence.length+" 条";el("evidence-list").innerHTML=project.evidence.length?project.evidence.map(evidenceCard).join(""):'<div class="empty-small">尚未添加证据。先搜索公开讨论，核验候选原帖后加入。</div>';document.querySelectorAll("[data-remove]").forEach(node=>node.onclick=()=>removeEvidence(node.dataset.remove));renderBrief(counts,covered)}
    function evidenceCard(item){const stance={support:"支持",oppose:"反对",neutral:"中性"}[item.stance]||"中性";return '<article class="evidence"><div class="evidence-top"><div class="evidence-source"><span class="badge '+esc(item.platform)+'">'+esc(item.platform)+'</span><span>'+esc(item.author_handle||"未知作者")+'</span><span>· '+esc(item.theme||"未分类")+'</span></div><span class="badge '+esc(item.stance)+'">'+stance+'</span></div><blockquote>'+esc(item.text_excerpt)+'</blockquote><div class="evidence-foot"><a href="'+esc(item.canonical_url)+'" target="_blank" rel="noopener noreferrer">查看原帖 ↗</a><button class="remove" data-remove="'+esc(item.evidence_id)+'">移除</button></div></article>'}
    function renderBrief(counts,covered){for(const stance of ["support","oppose","neutral"]){const items=project.evidence.filter(item=>item.stance===stance);el("brief-"+stance).innerHTML=items.length?'<ul>'+items.map(item=>'<li><b>'+esc(item.theme)+'</b>：'+esc(item.text_excerpt.slice(0,150))+'</li>').join("")+'</ul>':'<p>证据不足，暂不形成结论。</p>'}const reportThemes=(project.report?.findings||[]).map(item=>item.theme);const manualThemes=project.evidence.map(item=>item.theme).filter(Boolean);const themes=[...new Set([...reportThemes,...manualThemes])];el("brief-angles").innerHTML=themes.length?'<ul>'+themes.slice(0,5).map(theme=>'<li>围绕“'+esc(theme)+'”组织用户原声、反例与解决建议。</li>').join("")+'</ul>':'<p>添加证据并标记主题后显示内容角度。</p>';const q=project.report?.quality;el("coverage-copy").textContent=q?"去重后 "+q.total_unique_items+" 条，用户原声占比 "+Math.round(q.direct_voice_ratio*100)+"%，覆盖 "+q.platforms.join("、")+"。置信度："+project.report.confidence+"。":"当前收录 "+project.evidence.length+" 条人工核验链接，覆盖 "+[...covered].join("、")+"。尚未连接平台级完整数据，因此不能计算总体声量或代表性比例。"}
    function switchView(view){document.querySelectorAll(".tab").forEach(button=>button.classList.toggle("active",button.dataset.view===view));for(const id of ["evidence","brief","method"])el("view-"+id).classList.toggle("hidden",id!==view)}
    function briefText(){const group=stance=>project.evidence.filter(item=>item.stance===stance).map(item=>"- ["+item.platform+"] "+item.text_excerpt+"\\n  "+item.canonical_url).join("\\n");return "# "+project.question+"\\n\\n受众："+project.audience+"\\n范围："+project.time_range+" · "+project.platforms.join(", ")+"\\n\\n## 支持证据\\n"+(group("support")||"- 证据不足")+"\\n\\n## 反对证据\\n"+(group("oppose")||"- 证据不足")+"\\n\\n## 中性与背景\\n"+(group("neutral")||"- 证据不足")+"\\n\\n## 数据边界\\n当前为人工证据模式，不代表平台总体讨论。"}
    async function copyBrief(){if(!project)return;await navigator.clipboard.writeText(briefText());const button=el("copy-brief");button.textContent="已复制";setTimeout(()=>button.textContent="复制 Brief",1000)}
    function exportJson(){if(!project)return;const blob=new Blob([JSON.stringify(project,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download="creator-research-"+project.project_id+".json";a.click();URL.revokeObjectURL(url)}
    function save(){localStorage.setItem(storageKey,JSON.stringify(project))}try{const stored=JSON.parse(localStorage.getItem(storageKey));if(stored?.project_version){project=stored;el("question").value=project.question||"";render()}}catch{}
  </script>
${authModalHtml({ auth, returnTo: auth.loginReturnTo || "/research" })}
<script data-agentrouter-spa>${clientRouterScript()}</script>
</body></html>`;
}

function buildSuggestedQueries(question, platforms) {
  const normalizedPlatforms = platforms.length ? platforms : ["x", "reddit"];
  return normalizedPlatforms.flatMap((platform) => [
    `${question} ${platform}`,
    `"${question.slice(0, 80)}" ${platform}`,
    `${question} problem OR pain OR alternative ${platform}`
  ]).slice(0, 8);
}

function socialEvidenceSchema() {
  return {
    schema_version: "social_evidence_item_v1",
    required: ["platform", "canonical_url", "text_excerpt", "stance"],
    stance_values: [...STANCES],
    platform_values: [...PLATFORMS]
  };
}

function normalizeEngagement(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(["likes", "comments", "shares", "views", "score"]
    .map((key) => [key, finiteNumber(source[key])])
    .filter(([, number]) => number !== null));
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function clean(value, max) {
  return String(value || "").trim().slice(0, max);
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[character]);
}
