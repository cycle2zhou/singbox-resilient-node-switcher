## Context

项目是面向 GUI.for.SingBox 的独立插件，不改 GUI 核心，不改用户现有插件。当前实际配置中，主组 `🚀 节点选择` 是 `selector`，包含 195 个成员，其中直接成员 `🎈 自动选择` 是 `urltest`，其余主要是节点出站。sing-box 1.14.1 提供 Clash API：`/proxies` 读取组状态，`/proxies/{name}/delay` 进行主动延迟探测，PUT `/proxies/{selector}` 修改 Selector 选择。GUI 插件只能可靠观察主动探测、API 响应和组状态，不能获得任意浏览器请求的逐请求结果。

## Goals / Non-Goals

**Goals:**

- SHALL 只面向 GUI.for.SingBox，默认监控 `🚀 节点选择` 的全部直接成员。
- SHALL 每轮从核心同步 `all` 与 `now`，避免依赖过期内存状态。
- SHALL 对可直接探测的叶子节点执行可配置并发的 `/delay` 检查。
- SHALL 对连续失败节点执行临时冷却、半开探测和恢复；不得永久剔除。
- SHALL 只有在新节点可验证、切换 API 成功且 `now` 已确认后才报告切换完成。
- SHALL 将 URLTest 成员作为内核管理的嵌套组，不由插件再次接管。
- SHALL 将状态写入插件 `data` 目录，停用、卸载、核心停止时清理运行资源。

**Non-Goals:**

- 不支持 GUI.for.Clash 或其他 GUI。
- 不接管 URLTest，不修改 sing-box 生成配置，不删除节点，不自动改写用户订阅。
- 不根据 IP:端口推断节点等价性，不保证主动探测覆盖所有真实业务。
- 不在本次工作中自动提交 GitHub 或 Plugin-Hub PR。

## Decisions

### D1：监控范围采用一个主 Selector 的全部直接成员

- **选择**：配置一个 Selector 组名，默认 `🚀 节点选择`；每轮读取其 `all`，监控叶子成员。
- **理由**：用户的目标是整个节点选择组；单一控制面避免多个组并行切换互相干扰。
- **已考虑 alternative**：监控所有 Selector；被拒绝，因为会扩大副作用和故障归属范围。

### D2：嵌套 URLTest 不由插件接管

- **选择**：若成员在 `/proxies` 中的 `type` 为 `URLTest`，记录为“由核心管理”，不对该组 PUT 切换；对主 Selector 仍可把它作为一个候选成员按组延迟探测。
- **理由**：sing-box URLTest 自带 interval/tolerance/idle_timeout；双重决策会造成来回切换。
- **已考虑 alternative**：展开 URLTest 的所有内部节点并由插件直接控制；被拒绝，因为这改变了内核配置语义，且无法通过主 Selector 直接选择其内部成员。

### D3：健康依据只使用有效 Clash API 主动探测

- **选择**：请求 `/proxies/{node}/delay?url=...&timeout=...`，同时验证 HTTP 状态、JSON `delay` 为正数和超时；不使用 provider healthcheck。
- **理由**：sing-box 当前 provider healthcheck 路由没有真实 provider 操作；/delay 是核心实际实现的单节点探测。
- **已考虑 alternative**：只读 `/proxies` 的 `history`；被拒绝，因为 history 可能过期且不能区分当前业务目标。

### D4：故障恢复采用带退避的状态机

- **选择**：`healthy → suspect → unhealthy/cooldown → half-open → healthy`；默认失败 3 次、初始冷却 120 秒、最大冷却 30 分钟、恢复成功 2 次，均可配置。
- **理由**：单次网络抖动不应立即切换；失败节点未来可能恢复，半开能避免永久排除和频繁震荡。
- **已考虑 alternative**：永久黑名单或每次失败立刻切换；前者丢失恢复机会，后者产生抖动。

### D5：切换必须具备三段式确认

- **选择**：候选节点探测成功 → PUT 主 Selector → GET `/proxies` 确认 `now` 等于目标；失败时保留原状态并进入短暂抑制。
- **理由**：API 接受请求不等于核心选择已改变；确认 `now` 是可观察的控制面证据。
- **已考虑 alternative**：只依据 PUT 返回 204；被拒绝，因为缺少实际状态验证。

### D6：默认谨慎，避免自动切换 urltest 选出的链路

- **选择**：检查间隔 30 秒、节点超时 5 秒、并发 3、失败阈值 3、恢复阈值 2、初始冷却 120 秒、最大冷却 1800 秒、最短驻留 60 秒；当前节点在未达到失败阈值前不切换。
- **理由**：主 Selector 可能选择嵌套 URLTest；需给核心自身决策和短暂抖动留出稳定窗口。
- **已考虑 alternative**：沿用现有 3 分钟轮询和一次失败切换；被拒绝，因为反应慢或过于激进。

## Risks / Trade-offs

- [Risk] 主动探测成功不代表所有网站和浏览器请求成功 → Mitigation: 文案明确标注“主动探测”，保留失败原因，不宣称业务完全恢复。
- [Risk] 主 Selector 成员数量很大，完整轮询可能产生 API/上游压力 → Mitigation: 并发上限默认 3；单轮不可重入；对健康节点可配置较低频检查，并优先检查当前节点与冷却到期节点。
- [Risk] 多个节点共享底层 IP:端口 → Mitigation: 端点只作为展示诊断，不用于自动归并或批量熔断。
- [Risk] 用户手动切换与插件自动切换冲突 → Mitigation: 每轮先同步 `now`；检测到外部选择变化时重置当前节点的失败窗口，不立即切回。
- [Risk] API 地址/密钥或核心状态变化 → Mitigation: 从当前 profile/内核 store 动态解析，启动和每轮处理不可用状态；核心停止时停止定时器和请求。

## Migration Plan

1. 在本地项目生成并测试插件和 Plugin-Hub 元数据；不修改现有插件。
2. 用户审阅完整 diff 后，将插件复制到 GUI 的 `data/plugins` 位置并手动启用。
3. 先以手动运行和日志观察模式验收，再开启自动监控；保留停止菜单作为回滚。
4. 回滚时停用/删除新插件；因插件不改配置、不删节点，现有 sing-box 配置无需恢复。
5. 向上游投稿须另行确认，并遵守上游 PR 模板和人工审阅要求。

## Open Questions

- 插件元数据是否把自动监控绑定到 `onCoreStarted`，还是必须由用户点击“运行”后才启动；实现可同时提供手动启停并默认不自动接管，待最终规格确认。
- 业务验证 URL 默认采用现有 `https://www.gstatic.com/generate_204`，是否需要用户自定义多个 URL 作为轮换探测目标。
