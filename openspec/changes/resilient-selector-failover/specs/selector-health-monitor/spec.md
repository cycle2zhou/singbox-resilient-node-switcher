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
插件 SHALL 使用 `/proxies/{node}/delay` 对直接可探测成员发起 HTTPS 探测，并同时验证 HTTP 状态、响应结构、正数 `delay` 和请求超时；provider healthcheck MUST NOT 作为健康判据。

#### Scenario: 探测成功
- **WHEN** API 返回 HTTP 200 且 JSON 含正数 `delay`
- **THEN** 节点记录本次成功和延迟

#### Scenario: 探测失败
- **WHEN** API 返回 4xx/5xx、请求超时、JSON 缺失有效 `delay` 或核心不可用
- **THEN** 节点记录失败原因，不把该结果标记为成功

### Requirement: 可控探测并发
插件 SHALL 限制同一轮探测的最大并发数，且同一主 Selector 的监控轮次 MUST 不重入。

#### Scenario: 大量成员探测
- **WHEN** 主 Selector 包含多于并发上限的成员
- **THEN** 插件分批发起请求，任何时刻活跃探测数不超过配置上限

#### Scenario: 轮次重入
- **WHEN** 上一轮尚未结束而定时器再次触发
- **THEN** 插件跳过新轮次，不并行执行第二个完整轮次
