# AgentRouter 多用户社交研究系统需求

## 1. 产品目标

把 Creator Research 从依赖开发者本人 Chrome 登录态的原型，升级为可供多个独立用户使用的社交研究能力。用户连接自己的数据源后，通过同一个 `social_user_voice_research` capability 检索 X、Reddit、小红书等渠道，得到可追溯、可去重、明确标注覆盖缺口的用户原声报告。

系统不负责发帖、评论、点赞、私信或代运营。本阶段全部连接均为只读。

## 2. 目标用户与核心场景

- 内容创作者：验证选题、寻找争议点、收集用户措辞和反例。
- 产品经理与创始人：发现真实抱怨、替代品讨论和购买障碍。
- 研究员：把跨平台帖子整理成带来源的证据集。
- 自托管团队：使用自己的 API 凭证，不与平台运营方共享账户。

典型输入：`KIMI K3 用户有哪些抱怨？`

典型输出必须包含：主题、原帖短摘录、原帖 URL、作者、时间、互动数据、平台覆盖、失败渠道、样本局限和置信度。

## 3. 产品原则

1. **用户自带凭证**：每个用户连接自己的 API 或本地浏览器。
2. **凭证不进入研究数据**：输出、日志、错误、URL、前端状态中均不得包含 token、Cookie 或 secret reference。
3. **Provider 可插拔**：AgentRouter 依赖统一接口，不依赖某个单一抓取项目。
4. **原帖优先**：新闻和聚合页只能作为 fallback，不能伪装成用户原声。
5. **失败透明**：登录失效、额度不足、限流和零结果必须区分。
6. **只读默认**：连接器不得包含写操作权限。
7. **平台规则优先**：官方 API、用户授权范围、速率限制和内容使用条款由部署者遵守。

## 4. 用户流程

### 4.1 连接数据源

1. 用户登录 AgentRouter。
2. 打开“连接数据源”。
3. 选择平台与连接方式。
4. 输入 API token，或选择本地浏览器模式。
5. 服务端验证结构并保存加密凭证。
6. 前端只显示连接名称、平台、类型、状态和“凭证已加密”。

### 4.2 执行研究

1. 用户输入问题、平台、语言和结果上限。
2. AgentRouter 根据当前用户的连接选择 provider。
3. 优先调用用户级官方 API；不可用时尝试本机浏览器连接器；最后才使用可选网页搜索。
4. 对结果执行实体相关性过滤、URL 去重、平台内容验证和主题聚合。
5. 返回报告与每个平台的真实状态。

### 4.3 删除连接

删除必须同时移除连接元数据和对应加密密文。用户只能操作自己的连接；跨用户访问统一返回 404，避免暴露连接是否存在。

## 5. Provider 架构

统一接口：

```js
{
  id: "provider-instance-id",
  async search(query, limit) {
    return {
      status: "completed | auth_required | rate_limited | provider_error",
      rows: []
    };
  }
}
```

标准化 row：

```js
{
  id,
  url,
  title,
  text,
  author,
  published_at,
  engagement: { likes, comments, shares, views }
}
```

路由优先级：当前用户 API provider → 当前设备本地浏览器 → 语义网页搜索 → 可选通用搜索服务。一个 provider 失败不应覆盖其他 provider 的结果。

## 6. 平台需求

### X

- 支持用户提供 Bearer Token。
- 使用 recent search 接口并展开作者数据。
- 标准化正文、作者、时间、公开互动指标和原帖 URL。
- 本地浏览器作为无需官方 API 的个人设备方案。

### Reddit

- 支持用户提供 OAuth Access Token。
- 请求必须包含明确的 User-Agent。
- 标准化帖子正文、作者、分数、评论数和 permalink。
- 后续版本增加 token refresh 和评论线程读取。

### 小红书

- 当前只支持本地浏览器连接器。
- 不宣称存在稳定、公开、通用的官方研究 API。
- 未登录时返回 `AUTH_REQUIRED`，不得用 SEO 页面或用户主页冒充笔记原声。
- 读取正文必须沿用搜索结果中的完整 URL 与平台要求的访问参数。

## 7. 身份与数据隔离

- 所有连接记录必须绑定 `owner_key`。
- GitHub 登录用户使用 `github:<id>`；本地开发用户使用独立 local key。
- API Key 认证必须映射回同一个用户 owner。
- 列表、调用和删除均按 owner 过滤。
- 未登录用户可以使用设备本地连接器，但不能管理持久连接。

## 8. 凭证安全

- 使用 AES-256-GCM 加密密文，使用 scrypt 从平台主密钥派生加密密钥。
- 生产环境必须配置 `ADN_PROVIDER_SECRET_PASSPHRASE`，推荐随机生成的 32 字节以上秘密。
- 生产环境必须使用 HTTPS。
- 数据库只保存连接元数据、`secret_ref` 和加密结构；不保存明文。
- API 响应永远不返回 `secret_ref`、token 或 Cookie。
- 错误消息不得拼接请求 header。
- 本地浏览器建议使用专用 Chrome Profile，不登录邮箱、交易所、网银或钱包。
- 应用日志不得记录连接接口的请求 body。

## 9. API 合约

创建连接：`POST /research/api/connections`

```json
{
  "platform": "x",
  "provider_type": "x_api",
  "label": "My research account",
  "credentials": { "bearer_token": "..." }
}
```

列出连接：`GET /research/api/connections`，只返回公开元数据和 `has_credentials`。

删除连接：`DELETE /research/api/connections/:connection_id`。

研究调用：

```json
{
  "capability": "social_user_voice_research",
  "params": {
    "question": "KIMI K3 用户有哪些抱怨",
    "platforms": ["x", "reddit", "xiaohongshu"],
    "language": "zh",
    "limit": 10
  }
}
```

## 10. 非功能需求

- 单平台调用默认 20 秒超时。
- 平台连接器不可通过 shell 拼接用户输入。
- 单次返回最多 25 条候选，避免意外高额 API 消耗。
- 所有候选必须有合法 HTTP(S) 来源 URL。
- 同 URL 只保留一次；高相似文本需要去重。
- 不生成虚构帖子填补缺失渠道。
- 数据源失败不能导致密钥或内部命令出现在用户结果中。

## 11. 验收标准

- 两个用户不能互相列出或删除连接。
- 创建和列表响应不包含提交的 secret。
- 内存 store 与数据库连接元数据均不包含明文 secret。
- X API adapter 可以把官方响应转换为统一 row。
- 用户 API provider 优先于机器本地连接器。
- 未配置网页 fallback 时，本地连接器仍可独立运行。
- capability 出现在 AgentRouter catalog，并可由正式请求入口调用。
- 同一问题经 AgentRouter 能得到与直连 provider 同等级的原帖覆盖，并提供更好的去重、主题化和覆盖说明。
- 全量自动化测试及 `git diff --check` 通过。

## 12. 当前范围外与下一阶段

- OAuth 授权向导和自动 token refresh。
- Reddit 评论线程、X conversation tree、小红书正文和评论批量深读。
- 后台任务、流式进度和取消操作。
- 每个 provider 的用量预算、速率限制仪表盘和审计日志。
- TikTok、YouTube、Instagram、Facebook、B站等新增适配器。
- 团队 workspace、角色权限、共享连接和管理员密钥轮换。
