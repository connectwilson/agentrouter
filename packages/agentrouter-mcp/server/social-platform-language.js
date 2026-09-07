const X_URL = /https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i;
const X_NAMED_PLATFORM = /\btwitter\b|推特/i;
const X_CHINESE_PLATFORM_PHRASE = /(?:^|[\s，。,:：；;])(?:请|請)?\s*(?:帮我|幫我)?\s*(?:去|到|从|從|在|搜索|搜尋|搜寻|搜尋|检索|檢索|查找|查询|查詢|查查|查看|找|看看|浏览|瀏覽)\s*[Xx]\s*(?:上|里|裡|中|平台(?:上|里|裡|中)?)/;
const X_CHINESE_PREPOSITIONAL_PHRASE = /(?:^|[\s，。,:：；;])(?:请|請)?\s*(?:帮我|幫我)?\s*(?:去|到|从|從|在)\s*[Xx]\s*(?:找|查|搜|看|读|讀|研究|调研|調研)/;
const X_LEADING_PLATFORM_PHRASE = /(?:^|[\s，。,:：；;])[Xx]\s*(?:上|里|裡|中|平台(?:上|里|裡|中)?)(?:的|关于|關於)?/;
const X_CONTENT_PHRASE = /(?:^|[^a-z0-9])[Xx]\s*(?:帖子|原帖|推文|账号|帳號|用户|用戶|平台|讨论|討論)(?=$|[^a-z0-9])/;
const X_ENGLISH_ACTION = /\b(?:search|find|read|research|check|browse|look\s+up)\b[^.!?\n]{0,48}\b(?:on\s+)?x\b(?:\s+(?:for|about|posts?|tweets?|accounts?|discussion|what)\b|(?=\s*$))/i;
const X_ENGLISH_ON_PLATFORM = /\b(?:posts?|tweets?|accounts?|discussion|comments?|builders?|traders?|users?)\b[^.!?\n]{0,48}\bon\s+x\b|\bon\s+x\b[^.!?\n]{0,48}\b(?:posts?|tweets?|accounts?|discussion|comments?|builders?|traders?|users?)\b/i;

// A bare letter X is intentionally insufficient: it may be a variable, a model
// name, or the prefix of an asset such as XLM. Require a URL, the Twitter name,
// or platform-shaped grammar around X.
export function isExplicitXPlatformTask(value) {
  const text = String(value || "");
  return X_URL.test(text)
    || X_NAMED_PLATFORM.test(text)
    || X_CHINESE_PLATFORM_PHRASE.test(text)
    || X_CHINESE_PREPOSITIONAL_PHRASE.test(text)
    || X_LEADING_PLATFORM_PHRASE.test(text)
    || X_CONTENT_PHRASE.test(text)
    || X_ENGLISH_ACTION.test(text)
    || X_ENGLISH_ON_PLATFORM.test(text);
}
