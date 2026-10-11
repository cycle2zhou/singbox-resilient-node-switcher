# Resilient Selector Failover 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建一个仅面向 GUI.for.SingBox 的插件，监控 `🚀 节点选择` 的全部直接成员，在连续失败后暂时冷却节点，并通过半开探测恢复节点。

**Architecture:** 将核心逻辑拆为纯 JavaScript 状态机、Clash API 客户端、轮询协调器和 GUI 插件适配层。状态机与 API 响应解析脱离 GUI，使用 Node 内置测试运行；插件层只负责生命周期、配置、持久化和 UI。

**Tech Stack:** 原生 JavaScript ES module、Node.js 内置 `node:test`、GUI.for.SingBox Plugins API、sing-box Clash API；不新增第三方依赖。

**Spec:** `openspec/changes/resilient-selector-failover/design.md` 与 `openspec/changes/resilient-selector-failover/specs/`

## Global Constraints

- SHALL 只支持 GUI.for.SingBox，不加入 GUI.for.Clash 或其他内核分支。
- SHALL 默认监控 `🚀 节点选择` 的全部直接成员，只控制一个主 Selector。
- SHALL 不接管 URLTest、不调用 provider healthcheck、不修改生成配置、不删除节点、不按 IP:端口自动合并节点。
- SHALL 使用 `/proxies`、`/proxies/{name}/delay` 和 `PUT /proxies/{selector}`，并校验 HTTP 状态、响应结构及切换后的 `now`。
- SHALL 对失败节点执行冷却和半开恢复，不永久剔除；默认失败阈值 3、恢复阈值 2、初始冷却 120 秒、最大冷却 1800 秒。
- SHALL 默认检查间隔 30 秒、单节点超时 5000 毫秒、并发 3、最短驻留 60 秒。
- SHALL 不修改 `/Users/cycle/Library/Application Support/GUI.for.SingBox/plugins/plugin-smart-proxy-switcher.js`。
- SHALL 所有插件 I/O 位于 GUI data 目录；代码明文可审计；停用、卸载、核心停止和关闭时清理运行资源。

## Review Focus

- 主 Selector 成员包含嵌套 URLTest 时，插件不应展开或接管其内部节点；由 Task 4 的组同步测试覆盖。
- `/delay` 返回 503/504、非 JSON 或 `delay: 0` 时，不能误判为健康；由 Task 2 的响应解析测试覆盖。
- 冷却到期的节点必须重新半开探测，成功后恢复而不是永久排除；由 Task 3 的状态机测试覆盖。
- 用户手动改变 `now` 后，插件不能立即切回旧节点；由 Task 4 的协调器测试覆盖。
- PUT 成功但 `now` 未改变时，插件不能报告切换完成；由 Task 4 的切换确认测试覆盖。

---

### Task 1: 项目骨架与可测试公共模型

**Files:**
- Create: `package.json`
- Create: `src/config.js`
- Create: `src/model.js`
- Create: `test/config.test.js`
- Create: `test/model.test.js`
- Create: `README.md`

**Interfaces:**
- Produces `DEFAULT_CONFIG`、`normalizeConfig(input)`、`createNodeState(tag)`、`serializeNodeState(state)`，供后续任务使用。

- [ ] **Step 1: 写失败测试**
  - 测试 `normalizeConfig({})` 返回默认值：`intervalMs=30000`、`timeoutMs=5000`、`concurrency=3`、`failureThreshold=3`、`recoveryThreshold=2`、`initialCooldownMs=120000`、`maxCooldownMs=1800000`、`minDwellMs=60000`、`selectorName='🚀 节点选择'`。
  - 测试非法负数和零值被安全归一化，不允许产生零超时、零并发或超过最大冷却的值。
  - 测试 `createNodeState('node-a')` 的初始状态为 `healthy`，计数为 0。

- [ ] **Step 2: 运行测试确认失败**
  - 运行：`node --test test/config.test.js test/model.test.js`
  - 预期：因 `src/config.js` 或 `src/model.js` 尚不存在而失败。

- [ ] **Step 3: 实现最小公共模型**
  - 建立 `package.json`，配置 `type: module` 与 `test: node --test`。
  - 实现配置归一化、节点状态创建和可持久化序列化；不得依赖 GUI 全局对象。

- [ ] **Step 4: 运行测试确认通过**
  - 运行：`node --test test/config.test.js test/model.test.js`
  - 预期：全部通过。

- [ ] **Step 5: 提交**
  - 运行：`git add package.json src test README.md && git commit -m "feat: add resilient selector project foundation"`

### Task 2: Clash API 客户端与响应解析

**Files:**
- Create: `src/api.js`
- Create: `src/response.js`
- Create: `test/api.test.js`
- Create: `test/response.test.js`

**Interfaces:**
- Consumes: Task 1 的配置值。
- Produces: `parseDelayResponse(status, body)`、`createClashApi({baseUrl, secret, fetchImpl})`；客户端提供 `getProxies(signal)`、`probe(node, url, timeoutMs, signal)`、`select(group, node, signal)`。

- [ ] **Step 1: 写失败测试**
  - 用完整响应夹具测试 HTTP 200 + `{delay:123}` 返回成功。
  - 测试 503、504、非 JSON、`delay:0` 和负数返回失败及可读原因。
  - 测试 URL 节点名被正确编码、Authorization 为 `Bearer <secret>`、PUT payload 为 `{name: node}`。

- [ ] **Step 2: 运行测试确认失败**
  - 运行：`node --test test/api.test.js test/response.test.js`
  - 预期：因模块不存在而失败。

- [ ] **Step 3: 实现最小客户端**
  - 所有请求使用 `AbortSignal.timeout(timeoutMs)` 或等价取消机制；非 2xx 一律不视为成功；不得调用 provider healthcheck。

- [ ] **Step 4: 运行测试确认通过**
  - 运行：`node --test test/api.test.js test/response.test.js`
  - 预期：全部通过。

- [ ] **Step 5: 提交**
  - 运行：`git add src/api.js src/response.js test/api.test.js test/response.test.js && git commit -m "feat: add sing-box clash api client"`

### Task 3: 可恢复节点状态机

**Files:**
- Create: `src/health-state.js`
- Create: `test/health-state.test.js`

**Interfaces:**
- Consumes: Task 1 的 `NodeState` 和 `DEFAULT_CONFIG`。
- Produces: `recordProbeSuccess(state, now, delay, config)`、`recordProbeFailure(state, now, reason, config)`、`getProbePlan(state, now, config)`、`isEligibleCandidate(state, now)`。

- [ ] **Step 1: 写失败测试**
  - 测试一次失败仍保持当前节点，不进入冷却。
  - 测试第 3 次连续失败进入 `cooldown` 并记录冷却截止时间。
  - 测试冷却到期返回 `half-open` 探测计划。
  - 测试连续 2 次恢复成功回到 `healthy` 并重置退避；半开失败按 2 倍退避且不超过 1800000ms。
  - 测试冷却节点不能作为候选，健康节点可以作为候选。

- [ ] **Step 2: 运行测试确认失败**
  - 运行：`node --test test/health-state.test.js`
  - 预期：因状态机模块不存在而失败。

- [ ] **Step 3: 实现状态机**
  - 状态转换必须是纯函数或明确返回新状态；时间全部由参数传入，禁止直接依赖系统时钟，以便确定性测试。

- [ ] **Step 4: 运行测试确认通过**
  - 运行：`node --test test/health-state.test.js`
  - 预期：全部通过。

- [ ] **Step 5: 提交**
  - 运行：`git add src/health-state.js test/health-state.test.js && git commit -m "feat: add recoverable node health state machine"`

### Task 4: 轮询协调器与切换确认

**Files:**
- Create: `src/monitor.js`
- Create: `test/monitor.test.js`

**Interfaces:**
- Consumes: Task 2 的 API 客户端和 Task 3 的状态机。
- Produces: `createMonitor({api, config, clock, logger})`，提供 `runCycle()`、`start()`、`stop()` 和 `getSnapshot()`。

- [ ] **Step 1: 写失败测试**
  - 测试 `/proxies` 同步主 Selector 的 `all/now`，遇到嵌套 `URLTest` 只作为组成员，不展开内部节点。
  - 测试轮次并发不超过 3，且未完成轮次时第二次 `runCycle()` 被跳过。
  - 测试当前节点达到失败阈值后只选择已探测成功且非冷却候选。
  - 测试发现外部 `now` 变化会重置即时失败窗口，不立即切回旧节点。
  - 测试 PUT 返回成功但刷新后的 `now` 不等于目标时，不报告切换成功。

- [ ] **Step 2: 运行测试确认失败**
  - 运行：`node --test test/monitor.test.js`
  - 预期：因监控模块不存在而失败。

- [ ] **Step 3: 实现协调器**
  - 每轮先验证主组存在且 `type === 'Selector'`，再同步成员、安排探测、更新状态；切换严格执行“候选探测成功 → PUT → 刷新并确认 now”。
  - `start()` 使用配置间隔，`stop()` 取消定时器和当前轮次；不得修改配置文件或节点列表。

- [ ] **Step 4: 运行测试确认通过**
  - 运行：`node --test test/monitor.test.js`
  - 预期：全部通过。

- [ ] **Step 5: 提交**
  - 运行：`git add src/monitor.js test/monitor.test.js && git commit -m "feat: add selector monitoring and failover"`

### Task 5: GUI.for.SingBox 插件适配与 Plugin-Hub 元数据

**Files:**
- Create: `plugins/GFS/plugin-singbox-resilient-node-switcher.js`
- Create: `plugins/gfs.json`
- Create: `test/plugin-source.test.js`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1–4 的模块接口；插件运行时通过 GUI 全局 `Plugins` 注入适配器。
- Produces: 官方插件默认导出工厂，返回 `onRun`、`onCoreStarted`、`onCoreStopped`、`onShutdown`、`onDispose`、`onUninstall` 和停止菜单处理器；元数据包含配置项与 `on::manual/on::core::started/on::core::stopped/on::shutdown` 触发器。

- [ ] **Step 1: 写失败测试**
  - 测试插件源码可被静态语法解析，元数据 ID、路径、触发器、默认 Selector 和配置键齐全。
  - 测试源码不包含 `advancedConfig`、`APP_TITLE`、`providers/proxies`、配置写回或节点删除调用。
  - 测试现有插件路径不被项目文件引用或修改。

- [ ] **Step 2: 运行测试确认失败**
  - 运行：`node --test test/plugin-source.test.js`
  - 预期：因插件和元数据不存在而失败。

- [ ] **Step 3: 实现插件适配层**
  - 从 `Plugins.useKernelApiStore()` 和当前 profile 解析 API；I/O 仅使用 GUI data API；生命周期停止时调用 monitor.stop；UI 显示当前节点、状态、延迟、失败原因和冷却截止时间。
  - 不能在插件源码中引入外部脚本、样式、依赖或后台进程。

- [ ] **Step 4: 运行测试确认通过**
  - 运行：`node --test test/plugin-source.test.js && node --test`
  - 预期：全部通过，且无现有插件改动。

- [ ] **Step 5: 提交**
  - 运行：`git add plugins test/plugin-source.test.js README.md && git commit -m "feat: add GUI for SingBox resilient node switcher"`

### Task 6: 集成验证、文档与发布前检查

**Files:**
- Modify: `README.md`
- Create: `test/integration-contract.test.js`

**Interfaces:**
- Consumes: Task 5 的插件与元数据。
- Produces: 可供用户本地安装的文件布局、配置说明、限制说明和验证报告。

- [ ] **Step 1: 写失败测试**
  - 测试元数据路径、插件文件路径和配置键之间一致；测试默认值与规格一致；测试 README 明确说明 URLTest 不接管、失败节点会恢复、主动探测不等于所有业务恢复。

- [ ] **Step 2: 运行测试确认失败**
  - 运行：`node --test test/integration-contract.test.js`
  - 预期：因文档和集成契约未完成而失败。

- [ ] **Step 3: 完成文档和契约**
  - 写明安装位置、手动启停、默认参数、状态机、回滚方式和当前限制；不包含未验证的真实网络成功承诺。

- [ ] **Step 4: 运行全量验证**
  - 运行：`node --test` 与 `openspec validate --all --json`
  - 预期：所有测试通过，OpenSpec valid，0 个错误。

- [ ] **Step 5: 提交**
  - 运行：`git add README.md test/integration-contract.test.js && git commit -m "docs: document resilient selector switcher"``