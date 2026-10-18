## ADDED Requirements

### Requirement: 主 Selector 成员同步
插件 SHALL 从 sing-box Clash API 的 `/proxies` 读取配置的主 Selector，并以返回的 `all` 与 `now` 作为本轮监控的事实来源；主 Selector 不存在、类型不是 `Selector` 或成员列表为空时 MUST 停止自动切换并报告具体原因。

#### Scenario: 同步有效主 Selector
- **WHEN** `/proxies` 返回配置组且 `type` 为 `Selector`
- **THEN** 插件使用最新 `all` 和 `now` 更新监控集合，不沿用已移除成员的运行状态

#### Scenario: 组不可管理
- **WHEN** 配置组不存在、类型为 `URLTest` 或没有成员
- **THEN** 插件不发起切换请求，并报告“组不存在/非 Selector/无成员”的具体原因

### Requirement: 主动节点探测
插件 SHALL 使用 `/proxies/{node}/delay` 对直接可探测成员发起 HTTPS 探测，并同时验证 HTTP 状态、响应结构、正数 `delay` 和请求超时；provider healthcheck MUST NOT 作为健康判据。插件 SHALL 将 `/delay`（HEAD，不读 body）视为低成本快速信号，并将真实 GET（读 body、走系统代理）作为第二信号，覆盖“HEAD 通但真实访问慢或失败”的盲区。

#### Scenario: 探测成功
- **WHEN** API 返回 HTTP 200 且 JSON 含正数 `delay`
- **THEN** 节点记录本次成功和延迟

#### Scenario: 探测失败
- **WHEN** API 返回 4xx/5xx、请求超时、JSON 缺失有效 `delay` 或核心不可用
- **THEN** 节点记录失败原因，不把该结果标记为成功

#### Scenario: 真实 GET 覆盖探测盲区
- **WHEN** `/delay` 返回正常延迟但真实 GET 超时、失败或延迟超过真实延迟阈值
- **THEN** 插件把真实 GET 结果单独计入真实慢信号，不因 `/delay` 成功而忽略真实访问异常

### Requirement: 真实探测单飞与过期丢弃
插件 SHALL 限制同一时刻最多一个真实 GET 探测任务在途；真实探测结果 MUST 绑定发起时的节点稳定身份（stableKey）与代次（generation），当当前节点已变化或代次已失效时，过期结果 MUST NOT 影响当前节点状态。真实探测 MUST NOT 阻塞 HEAD 监控周期的推进。

#### Scenario: 单飞限制
- **WHEN** 已有一个真实 GET 任务在途
- **THEN** 插件不发起第二个真实 GET 任务，等待在途任务结束或结果过期

#### Scenario: 过期结果丢弃
- **WHEN** 真实探测返回时当前节点已变化（stableKey 不同）或代次已失效
- **THEN** 插件丢弃该结果，不更新真实慢计数、不累计盯梢成功次数

#### Scenario: 不阻塞 HEAD 周期
- **WHEN** 真实 GET 任务耗时较长
- **THEN** HEAD 监控周期仍按自身间隔推进，不因真实探测未完成而跳过后续轮次

### Requirement: 探测间隔分层
插件 SHALL 以不同间隔调度 HEAD 与真实 GET 探测；真实 GET 正常期默认每 15000ms 轮换一个探测 URL，盯梢期使用更短间隔尽快确认新节点；任何时刻真实 GET 任务数 MUST NOT 超过一个。

#### Scenario: 正常期真实探测间隔
- **WHEN** 插件处于正常期且距上次真实探测超过配置间隔
- **THEN** 插件轮换到下一个真实探测 URL 发起一次真实 GET

#### Scenario: 盯梢期缩短间隔
- **WHEN** 插件处于盯梢期（手动或自动切换后）
- **THEN** 插件以更短间隔发起真实探测，尽快确认新节点真实可用

### Requirement: 可控探测并发
插件 SHALL 限制同一轮探测的最大并发数，且同一主 Selector 的监控轮次 MUST 不重入。

#### Scenario: 大量成员探测
- **WHEN** 主 Selector 包含多于并发上限的成员
- **THEN** 插件分批发起请求，任何时刻活跃探测数不超过配置上限

#### Scenario: 轮次重入
- **WHEN** 上一轮尚未结束而定时器再次触发
- **THEN** 插件跳过新轮次，不并行执行第二个完整轮次
