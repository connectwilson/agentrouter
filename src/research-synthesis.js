const THEMES = [
  { id: "stability", label: "稳定性与错误", terms: ["freeze", "frozen", "loop", "stuck", "error", "429", "崩溃", "卡住", "循环", "报错", "中断"] },
  { id: "latency", label: "速度与延迟", terms: ["slow", "latency", "hour", "waiting", "慢", "延迟", "等待", "耗时"] },
  { id: "cost", label: "价格、Token 与额度", terms: ["token", "quota", "credit", "price", "cost", "expensive", "limit", "额度", "价格", "贵", "消耗", "订阅"] },
  { id: "usability", label: "界面与易用性", terms: ["ui", "ux", "mobile", "interface", "selection", "界面", "交互", "选择", "难用"] },
  { id: "quality", label: "输出质量", terms: ["wrong", "halluc", "repeat", "refus", "quality", "错误答案", "幻觉", "重复", "拒绝"] },
  { id: "access", label: "访问与可用容量", terms: ["sold out", "overload", "capacity", "session", "unavailable", "售罄", "过载", "容量", "无法访问"] }
];

const EVIDENCE_THEMES = [
  { id: "revenue", label: "营收与付费证据", terms: ["revenue", "arr", "mrr", "income", "profit", "paying", "paid", "fees", "营收", "收入", "付费", "利润"] },
  { id: "adoption", label: "客户与实际采用", terms: ["customer", "customers", "client", "clients", "partner", "partners", "users", "adoption", "客户", "合作方", "用户", "采用"] },
  { id: "business_model", label: "商业模式", terms: ["subscription", "api", "marketplace", "usage", "compute", "license", "recurring", "订阅", "接口", "市场", "算力", "许可"] },
  { id: "skepticism", label: "质疑与待验证声明", terms: ["claim", "claimed", "hype", "unverified", "question", "doubt", "质疑", "炒作", "未经验证"] }
];

export function buildCreatorResearchReport(input = {}) {
  const items = dedupeItems([...(input.evidence || []), ...(input.candidates || [])])
    .map(scoreItem)
    .sort((a, b) => b.quality_score - a.quality_score);
  const directVoices = items.filter((item) => item.voice_type === "first_person_or_platform_post");
  const themes = isComplaintResearch(input.question) ? THEMES : EVIDENCE_THEMES;
  const groups = themes.map((theme) => ({
    theme_id: theme.id,
    theme: theme.label,
    evidence: items.filter((item) => matchesTheme(item, theme))
  })).filter((group) => group.evidence.length);
  const platforms = [...new Set(items.map((item) => item.platform).filter(Boolean))];
  const verifiedVoicePlatforms = [...new Set(directVoices.filter((item) => item.source_type === "platform_search_result").map((item) => item.platform))];
  const authors = new Set(items.map((item) => item.author_handle).filter(Boolean));
  const strongGroups = groups.filter((group) => group.evidence.filter((item) => item.quality_score >= 60).length >= 2);
  const confidence = items.length >= 8 && verifiedVoicePlatforms.length >= 2 ? "high" : items.length >= 4 && verifiedVoicePlatforms.length >= 1 ? "medium" : items.length ? "low" : "insufficient";

  return {
    report_version: "creator_voice_report_v1",
    question: String(input.question || "").trim(),
    generated_at: new Date().toISOString(),
    answer_status: items.length ? "evidence_based" : "insufficient_evidence",
    confidence,
    summary: items.length
      ? `发现 ${items.length} 条去重后的讨论，其中 ${directVoices.length} 条为社交平台原帖或第一人称反馈；主要集中在${groups.slice(0, 4).map((group) => group.theme).join("、") || "尚未形成稳定主题"}。`
      : "没有足够的用户原声，不能形成结论。",
    findings: groups.map((group) => ({
      theme_id: group.theme_id,
      theme: group.theme,
      evidence_count: group.evidence.length,
      strong_evidence_count: group.evidence.filter((item) => item.quality_score >= 60).length,
      platforms: [...new Set(group.evidence.map((item) => item.platform))],
      examples: group.evidence.slice(0, 3)
    })),
    evidence: items,
    quality: {
      total_unique_items: items.length,
      direct_voice_items: directVoices.length,
      direct_voice_ratio: items.length ? Number((directVoices.length / items.length).toFixed(2)) : 0,
      platform_count: platforms.length,
      platforms,
      verified_voice_platforms: verifiedVoicePlatforms,
      known_author_count: authors.size,
      corroborated_theme_count: strongGroups.length
    },
    limitations: buildLimitations(items, platforms, authors.size, isComplaintResearch(input.question))
  };
}

function scoreItem(item) {
  const url = String(item.canonical_url || item.url || "");
  const excerpt = String(item.text_excerpt || item.excerpt || item.snippet || "").trim();
  const socialPost = /reddit\.com\/r\/[^/]+\/comments\/|(?:x|twitter)\.com\/(?:i\/)?(?:[^/]+\/)?status\/|xiaohongshu\.com\/(?:explore|discovery\/item)\/|xhslink\.com|bilibili\.com\/video\/|(?:youtube\.com\/watch|youtu\.be\/)|facebook\.com\//i.test(url);
  const socialProfile = /xiaohongshu\.com\/user\/profile\//i.test(url);
  const news = /apnews|reuters|techcrunch|theverge|axios|tomshardware|techradar/i.test(url);
  let score = socialPost ? 55 : socialProfile ? 10 : news ? 20 : 30;
  if (excerpt.length >= 40) score += 15;
  if (item.author_handle) score += 10;
  if (item.published_at) score += 5;
  if (Object.keys(item.engagement || {}).length) score += 10;
  if (item.verification_status === "requires_source_review") score -= 15;
  return {
    ...item,
    text_excerpt: excerpt || null,
    quality_score: Math.max(0, Math.min(score, 100)),
    voice_type: socialPost ? "first_person_or_platform_post" : news ? "reported_or_editorial" : "web_source"
  };
}

function dedupeItems(items) {
  const seenUrls = new Set();
  const accepted = [];
  for (const item of items) {
    const urlKey = normalizeUrl(item.canonical_url || item.url);
    const text = String(item.text_excerpt || item.excerpt || item.snippet || "");
    if (!urlKey || seenUrls.has(urlKey)) continue;
    if (accepted.some((existing) => similarity(text, existing.text_excerpt || "") >= 0.86)) continue;
    seenUrls.add(urlKey);
    accepted.push({ ...item, canonical_url: item.canonical_url || item.url });
  }
  return accepted;
}

function matchesTheme(item, theme) {
  const haystack = `${item.title || ""} ${item.text_excerpt || ""} ${item.theme || ""}`.toLowerCase();
  if (theme.id === "quality" && /never refus|not refus|doesn.?t refus|without refus/.test(haystack)) return false;
  return theme.terms.some((term) => haystack.includes(term));
}

function similarity(a, b) {
  const left = new Set(tokenize(a));
  const right = new Set(tokenize(b));
  if (!left.size || !right.size) return 0;
  const overlap = [...left].filter((token) => right.has(token)).length;
  return overlap / new Set([...left, ...right]).size;
}

function tokenize(value) {
  return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").split(/\s+/).filter((token) => token.length > 1);
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ""));
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(ref|source)$/i.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch { return ""; }
}

function buildLimitations(items, platforms, authorCount, complaintResearch) {
  const limitations = [];
  if (!items.length) return ["没有检索到可引用的用户原声。"];
  if (platforms.length < 2) limitations.push("当前只有一个平台的样本，不能代表跨平台用户。 ");
  if (authorCount < Math.min(5, items.length)) limitations.push("部分结果缺少可识别作者，独立用户数量可能低于证据条数。");
  if (items.some((item) => item.verification_status === "requires_source_review")) limitations.push("部分搜索候选尚未打开原帖核验，不能作为确定事实引用。");
  limitations.push(complaintResearch
    ? "社交讨论是自选择样本，不能据此计算总体投诉率或市场份额。"
    : "社交讨论是自选择样本，帖子中的营收与客户声明仍需独立数据验证。");
  return limitations;
}

function isComplaintResearch(question) {
  return /(?:抱怨|吐槽|痛点|缺点|问题|负面|投诉|差评)|\b(?:complaints?|problems?|pain\s*points?|issues?|negative|criticism|criticisms|dislikes?)\b/i.test(String(question || ""));
}
