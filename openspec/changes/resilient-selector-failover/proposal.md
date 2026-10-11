## Why

当前 GUI.for.SingBox 的通用智能切换插件同时兼容多个平台，主要依赖延迟数据，无法可靠处理 sing-box Selector 中节点的连续超时；失败节点还可能在后续仍被重新选中。需要一个仅面向 GUI.for.SingBox 的主动检查与可恢复故障切换插件，在不中断核心配置编辑的前提下暂时冷却失败节点，并在冷却后重新验证恢复。

## What Changes

**新增 Selector 健康监控与故障切换**
- 新增 GFS 专用插件，监控指定的主 Selector（默认 `🚀 节点选择`）及其直接可选成员。
- 使用 sing-box Clash API 的 `/proxies`、`/proxies/{name}/delay` 和 `PUT /proxies/{selector}`。
- 连续失败达到阈值后暂时冷却节点；冷却到期进行半开恢复探测，连续成功后恢复候选资格。
- 切换后重新读取实际 `now`，避免把 API 请求成功误认为切换成功。

**边界与安全**
- 不管理 URLTest 的内部选择，不调用 provider healthcheck，不修改生成配置，不删除节点，不按 IP:端口自动合并节点。
- 节点测试、核心 API 失败、组类型不符和配置变化均显示具体原因；无法证明时不自动切换。

## Capabilities

### New Capabilities

- `selector-health-monitor`: 为 GUI.for.SingBox Selector 提供成员同步、主动延迟检查、健康状态和可解释状态记录。
- `recoverable-selector-failover`: 基于连续失败、冷却和半开恢复对 Selector 执行谨慎的自动切换。
- `singbox-plugin-integration`: 按 GUI.for.SingBox 插件生命周期、配置元数据、data 目录和可审计代码规范集成。

### Modified Capabilities

无。现有 Generic 插件和用户当前插件不修改。

## Impact

新增独立 JavaScript 插件项目、Plugin-Hub 元数据示例和单元测试；运行时依赖 GUI.for.SingBox 已有 Plugins API 与 sing-box Clash API，不新增第三方依赖。部署时需用户手动安装/启用新插件；投稿 GitHub 或上游 PR 不属于本次实现自动操作。