# PRD: 链上侦探 MVP

Status: Draft 0.1  
Owner: AgentRouter  
Last updated: 2026-07-02

## 1. 产品摘要

“链上侦探”是一个面向交易者和 AI Agent 的链上情报 Skill。用户输入代币合约地址，获得一份证据可追溯的代币调查报告；用户询问“过去 24 小时链上发生了什么”，获得一份按重要性排序的链上事件简报。

MVP 不自建完整多链数据仓库。它依托 AgentRouter 动态发现和调用持仓、资金流、标签、安全、行情和社交数据服务，统一验证结果并生成报告。Skill 只承担意图识别、任务编排和结果表达，不在提示词里计算关键数字。

一句话价值主张：

> 输入一个代币或时间范围，5 分钟内得到一份区分事实、推断与未知项，并能逐条打开证据的链上调查报告。

## 2. 背景与机会

链上数据公开，但用户要回答“谁在持有、谁在卖、风险来自哪里、过去一天什么最重要”，通常需要在区块浏览器、DEX 行情、钱包标签、X 和多个分析平台之间手动拼接。

现有工具主要有三个缺口：

1. 数据存在，但缺少面向交易决策的问题组织。
2. 报告给出判断，却经常缺少可验证的交易哈希、地址、时间和数据口径。
3. 单一供应商覆盖有限，数据不可用或标签错误时缺少降级和交叉验证。

AgentRouter 已具备服务发现、付费调用、结果校验、证据绑定和反馈能力。链上侦探可成为其第一个多数据源复合研究场景。

## 3. 产品目标

### 3.1 MVP 目标

1. 支持用户通过 EVM 合约地址生成单代币调查报告。
2. 支持生成过去 24 小时重点链上事件简报。
3. 所有关键结论均标注证据、数据时间、来源和置信度。
4. 关键数字由数据服务或确定性代码产生，LLM 只负责解释和压缩表达。
5. 单个数据源故障时能降级输出，而不是生成未经支持的结论。
6. 通过 AgentRouter 路由数据服务，记录调用验证结果和用户反馈。

### 3.2 非目标

MVP 不做：

- 自动下单、跟单或资金托管。
- “必涨”“必跌”或直接买卖指令。
- 全链实时索引和自建 Arkham/Nansen 规模的钱包标签库。
- 完整犯罪取证、法律归责或真实身份识别。
- 全量覆盖所有公链。
- 面向所有代币的秒级实时告警。
- 仅凭 ticker 自动选定唯一代币后直接分析。

## 4. 目标用户

### 4.1 主用户：主动型加密交易者

需要快速判断筹码集中度、项目方分发、大户增减仓、交易质量和潜在抛压，但不愿手工查询多个平台。

### 4.2 次用户：研究员与内容作者

需要为日报、研究帖和项目复盘收集可引用的链上证据。

### 4.3 Agent 用户

交易 Agent 或研究 Agent 需要标准化 JSON，而不是只能阅读的网页仪表盘。

## 5. 核心原则

1. **合约地址优先。** ticker 只用于候选发现，最终必须确认 chain + contract address。
2. **事实先于叙事。** 数字和分类先由确定性流程产生，LLM 后写解释。
3. **事实、推断、未知分离。** 不能把标签推断写成已证实身份。
4. **证据贴近结论。** 关键结论附交易、地址、查询结果或原始来源。
5. **多源可替换。** 不把产品绑定到单一上游供应商。
6. **宁可缺失，不可补写。** 数据不足时显示 `unknown` 和限制说明。
7. **不把转账等同于卖出。** 只有 CEX 充值、可解码 DEX swap 等满足规则的行为才能进入“确认卖出”口径。

## 6. MVP 范围

### 6.1 链覆盖

首版支持：

- Ethereum
- BNB Chain
- Base

选择原因：三条链均为 EVM，可复用合约事件、Transfer、DEX 解码和地址模型；同时覆盖成熟资产、Binance Alpha 和新币场景。

Arbitrum、Optimism、Polygon 和 Solana 进入后续版本。若上游服务已覆盖，可在报告中以 beta 标记返回，但不计入 MVP 验收。

### 6.2 能力 A：单代币调查

用户输入：

```text
分析 ethereum:0x1234...
```

或：

```text
调查 $TOKEN 的持仓和最近链上情况
```

第二种输入必须先返回候选列表并确认合约；候选只有一个且具有可信官方映射时，可自动继续并明确展示所选合约。

报告包含：

1. 代币身份与数据新鲜度。
2. 价格、市值、FDV、24h 成交量、主池流动性。
3. Top 10/20/50 持仓集中度。
4. 排除 LP、销毁地址、CEX 托管和已识别锁仓后的调整后集中度。
5. 部署者、项目方一级接收地址和主要分发路径。
6. 24h 与 7d 大额增持、减持和新进入持仓者。
7. CEX 流入/流出和可确认 DEX 卖出。
8. 疑似刷量、同源钱包、分发集群等行为信号。
9. 合约权限与基础安全信号。
10. 风险摘要、反证条件、未知项和后续监控地址。

### 6.3 能力 B：24 小时链上简报

用户输入：

```text
过去 24 小时链上发生了什么？
```

可选过滤：chain、token、category、minimum_usd、watchlist。

MVP 不扫描全链所有交易，而是从有限监控宇宙发现候选事件：

- 市值或流动性排名靠前的 200 个代币。
- 主流稳定币。
- 主要 CEX 热钱包和充值钱包。
- 跨链桥、混币器和重点 DeFi 协议。
- 已知攻击者或制裁地址。
- Smart Money 与用户 watchlist。
- 过去 24h 价格、成交或流动性异常的代币。

简报栏目：

1. 巨鲸和机构资金流。
2. CEX 大额流入/流出。
3. Smart Money 行为。
4. 黑客、混币器与可疑资金。
5. 稳定币、跨链桥和 DeFi 异常。
6. 新币筹码、流动性和交易质量异常。
7. 与链上证据直接相关的项目公告或 X 信息。

默认输出 5–10 条事件，最多 15 条。

## 7. 用户体验

### 7.1 单代币主流程

```text
输入 CA
→ 识别链和代币
→ 展示分析范围及预计数据成本
→ AgentRouter 并行调用数据服务
→ 标准化、校验、交叉验证
→ 生成报告
→ 用户可追问某钱包或某条资金流
```

当预计付费超过用户的 AgentRouter 默认预算时，先返回 quote，由用户确认后调用。

### 7.2 日报主流程

```text
请求 24h 简报
→ 拉取候选事件
→ 规范化为统一事件
→ 去重与事件聚类
→ 计算重要性和置信度
→ 对 Top 事件补充证据
→ 生成简报
```

### 7.3 报告首屏

首屏只回答四件事：

- 发生了什么。
- 哪些是已验证事实。
- 风险或异常程度如何。
- 下一步值得监控什么。

完整持仓表、资金流和方法说明放在后续折叠章节或 JSON 中。

## 8. 功能需求

### FR-1 Token Resolver

- 接受 `chain:address`、裸地址或 ticker。
- 校验地址格式和合约是否存在。
- 返回 symbol、name、decimals、chain、contract address。
- ticker 有多个候选时不得静默选择。
- 对代理、跨链映射和同名代币显示警告。

### FR-2 市场与流动性快照

- 返回价格、24h 变化、mcap、FDV、volume、主池 LP。
- 记录每个字段的来源和采集时间。
- 对 `price × circulating_supply` 与 mcap 的显著偏差给出数据质量警告。
- 主池选择必须说明 chain、DEX 和 pair address。

### FR-3 持仓分析

- 获取至少 Top 50 holders；上游支持时获取 Top 100。
- 同时输出原始集中度和调整后集中度。
- 地址角色至少包括 unknown、burn、LP、CEX、bridge、vesting、treasury、deployer、EOA。
- 标签包含来源、置信度和更新时间。
- 未标记地址不得自动写成“内幕”。

### FR-4 资金流与行为检测

- 支持部署者一级分发图，默认最多向下追踪 2 层。
- 识别大额转账、CEX 充值、DEX swap 和余额显著变化。
- 识别候选 fan-out、fan-in、wash activity 和关联钱包集群。
- 所有启发式检测均返回规则版本和支持证据。

### FR-5 安全信号

- 检查 mint、pause、blacklist、tax、proxy、owner 权限等可获得信号。
- 安全检查失败不阻断持仓报告，但必须降低完整度。
- 不将单一第三方风险分数直接作为最终结论。

### FR-6 事件发现与聚类

- 接入多种事件 provider，并转换为统一事件 schema。
- 同一资金流被多个来源报告时合并，不重复展示。
- 新闻或 X 帖子只有在能绑定链上实体或交易时，才进入链上简报主列表。
- 无链上证据的相关消息进入“链下背景”，不得伪装成链上事实。

### FR-7 排序

事件重要性至少考虑：

```text
importance =
  amount_significance
  × historical_deviation
  × entity_relevance
  × market_impact
  × evidence_quality
  × freshness
```

每个因子归一化到 0–1。最终返回 0–100 分和简短的入选原因。第一版权重采用可配置规则，不使用不可解释的模型排序。

### FR-8 证据与置信度

每条关键结论分为：

- `verified_fact`：可由链上交易或确定性查询直接验证。
- `supported_inference`：由一个或多个规则推断。
- `unverified_context`：来自社交或新闻，尚未链上确认。

置信度不能由 LLM 自由生成，应由证据数量、来源质量、标签质量和数据一致性计算。

### FR-9 输出

- 用户可读 Markdown。
- 机器可读 `onchain_detective_report_v1` JSON。
- 关键地址和交易使用可点击浏览器链接。
- 显示生成时间、数据截止时间、覆盖范围、缺失数据和调用成本。

## 9. 数据契约

### 9.1 标准事件

```json
{
  "schema": "onchain_detective_event_v1",
  "event_id": "evt_...",
  "event_type": "cex_inflow",
  "occurred_at": "2026-07-02T00:00:00Z",
  "chains": ["ethereum"],
  "assets": [{"symbol": "ETH", "contract_address": null}],
  "entities": [{"address": "0x...", "label": "...", "label_confidence": 0.9}],
  "amount": {"token": "6438", "usd": "15180000"},
  "classification": "verified_fact",
  "importance_score": 82,
  "confidence": 0.91,
  "facts": [],
  "interpretation": "...",
  "evidence": [{"type": "transaction", "url": "...", "tx_hash": "0x..."}],
  "limitations": []
}
```

金额使用字符串或定点数，禁止使用浮点数进行资产计算。

### 9.2 调查报告

```json
{
  "schema": "onchain_detective_report_v1",
  "report_id": "odr_...",
  "mode": "token_investigation",
  "subject": {"chain": "ethereum", "contract_address": "0x..."},
  "generated_at": "...",
  "data_cutoff": "...",
  "summary": {},
  "market": {},
  "holders": {},
  "flows": [],
  "security": {},
  "findings": [],
  "watchlist": [],
  "evidence": [],
  "coverage": {},
  "limitations": [],
  "provenance": []
}
```

## 10. AgentRouter 集成

新增或规范化以下 capability：

| Capability | 用途 |
|---|---|
| `token_resolve` | ticker/address 解析 |
| `token_market_snapshot` | 行情、mcap、FDV、LP |
| `token_holder_distribution` | Top holders 与集中度 |
| `address_labels` | 地址和实体标签 |
| `token_flow_analysis` | 转账、CEX、DEX 与余额变化 |
| `token_distribution_forensics` | 部署者、分发树和行为检测 |
| `token_security_scan` | 合约安全信号 |
| `onchain_event_feed` | 标准化候选事件 |
| `social_context_search` | X、公告和链下背景 |

单代币报告是一次复合请求。AgentRouter 应分别选择各 capability 的最佳服务，而不是要求一家 provider 返回整份最终报告。

Provider 返回原始或半结构化证据；报告编排层负责合并。每次调用沿用现有 `agent_router_evidence_v1`，绑定 manifest、input、output、payment 和 verification。

## 11. HertzFlow 参考项目评估

参考仓库：[HertzFlow/hertzflow-skills](https://github.com/HertzFlow/hertzflow-skills)

### 11.1 结论

该仓库具有较高工程参考价值，明显强于此前单独的 Gist。建议借鉴其架构与测试方法，并探索将其注册为 AgentRouter provider；MVP 不应直接将整个仓库复制进核心代码。

### 11.2 值得复用的部分

- MIT License，允许使用、修改和再分发，但需保留许可声明。
- 完整的 deterministic pipeline → LLM writable slots → validator → renderer 信任边界。
- 证据图、字段 authority、反重复和 narrative-vs-locked 校验。
- 部署者分发、CEX 去向、wash infrastructure、跨币 operator、持仓角色和监控列表等检测器设计。
- 链路由和 EVM 多链表映射。
- 大量离线 fixture 与约 341 个测试函数。
- GitHub Actions 对当前主分支执行测试；截至 2026-07-02，最新主分支 workflow 成功。
- 报告和机器中间产物分离，便于 AgentRouter 验证与留证。

### 11.3 不应直接照搬的部分

- 产品强绑定 Binance Alpha，不能自然覆盖全市场代币。
- 历史 forensic 依赖 Surf CLI/SQL 和 Surf 后端的 Arkham 标签，单次报告存在 credits 成本和供应商锁定。
- README 标称完整报告通常耗时 2–10 分钟，不适合直接承担大规模 24h 市场扫描。
- Solana 只有 holder snapshot；Sui、TRON 等没有完整 forensic。
- 部分标签来自 Arkham/区块浏览器页面和字符串规则，必须视为带置信度的推断。
- 仓库解决的是“单代币报告”，没有完成全市场事件发现、跨来源聚类和日报排序。
- 代码量约 3.9 万行，整体 fork 会把较多领域规则和维护成本带入 MVP。
- CI 明确跳过一个已知的中文术语测试，不能将“CI 绿色”理解为所有已知问题已清零。

### 11.4 推荐集成方式

优先级如下：

1. 将 HertzFlow 包装为 `token_distribution_forensics` provider，通过 AgentRouter 按需调用。
2. 复用它的输出 schema、证据图思想和 validator 模式。
3. 用 5–10 个已知代币建立对照集，核验供应守恒、角色分类和确认卖出口径。
4. 只有在 Surf 成本、许可归属和结果稳定性验证通过后，才选择性移植检测器。
5. 日报事件发现单独建设，不强塞进 HertzFlow pipeline。

## 12. 系统设计

```text
Onchain Detective Skill
        |
        v
Request Planner
        |
        v
AgentRouter capabilities
  | market | holders | labels | flows | security | events | social |
        |
        v
Normalization + Evidence Store
        |
        v
Deterministic Detectors
        |
        v
Cross-check + Confidence + Ranking
        |
        v
Narrative slots filled by LLM
        |
        v
Validator → Markdown + JSON
```

HertzFlow 可作为 `forensics provider` 接入左侧能力层，而不是成为整个系统。

## 13. 错误与降级

| 场景 | 产品行为 |
|---|---|
| ticker 重名 | 返回候选并要求确认 |
| holder provider 超时 | 输出行情与其他章节，持仓标记 unavailable |
| 标签服务缺失 | 保留地址，角色标记 unknown，不推断内幕 |
| 两个来源数字冲突 | 同时展示口径，降低 confidence |
| 交易无法解码 | 只描述转账，不描述买卖方向 |
| 社交来源无法验证 | 放入链下背景，不进入 verified facts |
| 付费超过预算 | 返回 quote，不自动支付 |
| 所有核心数据缺失 | 返回失败解释，不生成空洞报告 |

## 14. 成功指标

### 14.1 产品指标

- 首次有效报告完成率 ≥ 85%。
- 单代币报告 P50 ≤ 5 分钟，P95 ≤ 10 分钟。
- 24h 简报 P50 ≤ 90 秒，前提是候选事件已预聚合。
- ≥ 90% 的关键结论具有可点击证据。
- 用户对“报告回答了问题”的正向反馈 ≥ 70%。

### 14.2 数据质量指标

- 供应量与持仓汇总的可解释误差 ≤ 1%，否则强制显示警告。
- 抽样的 CEX/DEX 行为方向准确率 ≥ 90%。
- 关键金额跨源差异 > 10% 时必须被检测并披露。
- 未标记地址被写成已确认实体的次数为 0。
- 无证据数字进入最终报告的次数为 0。

## 15. 验收标准

MVP 完成必须满足：

1. 输入三个支持链上的有效合约均能生成报告。
2. 输入重复 ticker 会触发歧义处理。
3. 报告同时包含 Markdown 和符合 schema 的 JSON。
4. 每条高风险 finding 至少有一个证据对象。
5. 模拟 holder 或 label provider 故障时报告可正确降级。
6. LLM 修改锁定数字或添加无证据地址时 validator 拒绝输出。
7. 24h 简报能合并来自两个 provider 的同一事件。
8. 纯 X 消息不会被标记为链上已验证事实。
9. AgentRouter 保存每个 provider 的验证结果和 request-level evidence。
10. 用户可对报告 usefulness、missing fields 和 confidence 提交反馈。

## 16. 实施阶段

### Phase 0：验证性原型，3–5 天

- 定义两个 JSON schema。
- 将 HertzFlow 的样例/实时输出映射到统一报告。
- 接入一个行情、一个 holder/label、一个安全数据源。
- 用 5 个代币建立 golden cases。

退出条件：能证明不同来源的数据可合并，关键字段口径可解释。

### Phase 1：单代币 MVP，1–2 周

- 实现 resolver、复合请求 planner 和 Markdown renderer。
- 注册核心 AgentRouter capabilities。
- 加入证据、置信度、降级和 validator。
- 完成 Ethereum、BNB Chain、Base 验收。

### Phase 2：24h 简报，1–2 周

- 接入 event feed provider。
- 建立监控宇宙、事件 schema、去重和规则排序。
- 加入 X/公告背景并严格区分链上事实。
- 支持按链、类别和 watchlist 过滤。

### Phase 3：监控与反馈

- 保存 watchlist。
- 支持定时报告和增量变化。
- 用 AgentRouter feedback 调整 provider 路由与事件排序。

## 17. 待决策事项

1. MVP 的首个 holder/label provider：现有 OKX 能力、Nansen、Surf/HertzFlow 或组合。
2. HertzFlow 是直接调用本地 Skill，还是包装成托管 provider。
3. 24h 监控宇宙的初始 token、协议和地址名单。
4. 单次代币报告和日报的默认最高数据预算。
5. 报告仅在对话中返回，还是同时提供永久 report URL。

## 18. 推荐决策

- 以 AgentRouter 的复合数据路由场景立项，而不是另做一个封闭分析应用。
- 单代币 MVP 先行，24h 日报建立在相同事件和证据 schema 上。
- HertzFlow 先作为可选 provider 做黑盒验证，不立刻 fork。
- 第一版只支持 Ethereum、BNB Chain、Base。
- 默认输出风险观察与监控条件，不输出买卖建议。
