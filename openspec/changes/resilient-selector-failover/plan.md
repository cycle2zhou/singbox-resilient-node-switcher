# Resilient Selector Failover Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** 创建 GUI.for.SingBox 专用的 Selector 健康检查、可恢复冷却与谨慎故障切换插件。

**Architecture:** 以无 GUI 依赖的配置、API、响应解析和健康状态机为核心；监控协调器通过依赖注入的 API 和时钟完成同步、探测、切换确认。最后由 GFS 插件适配生命周期、data 目录、配置元数据和状态 UI。

**Tech Stack:** 原生 JavaScript ES module、Node.js `node:test`、GUI.for.SingBox Plugins API、sing-box Clash API；零第三方依赖。

**Spec:** `openspec/changes/resilient-selector-failover/design.md` 与 `openspec/changes/resilient-selector-failover/specs/`

## Global Constraints

- 只支持 GUI.for.SingBox；不加入 GUI.for.Clash 或其他内核分支。
- 默认只监控 `🚀 节点选择` 这个主 Selector 的全部直接成员。
- 不接管 URLTest、不调用 provider healthcheck、不改写生成配置、不删除节点、不按 IP:端口自动合并。
- 通过 `/proxies`、`/proxies/{name}/delay` 和 `PUT /proxies/{selector}` 工作，并验证 HTTP 状态、响应结构和切换后的 `now`。
- 默认值：检查间隔 30000ms、超时 5000ms、并发 3、失败阈值 3、恢复阈值 2、初始冷却 120000ms、最大冷却 1800000ms、最短驻留 60000ms。
- 失败节点必须可在冷却后半开恢复；不得永久剔除。
- 插件 I/O 只允许 GUI data 目录；生命周期停止时清理定时器、请求和 UI。
- 不修改用户已有 `/Users/cycle/Library/Application Support/GUI.for.SingBox/plugins/plugin-smart-proxy-switcher.js`。

## Review Focus

- 嵌套 URLTest 只作为主 Selector 成员处理，不展开内部节点。
- 503、504、非 JSON、`delay: 0` 和负数不能被判定为健康。
- 冷却到期必须执行半开恢复，连续成功才回到健康。
- 外部手动改变 `now` 后不得立即切回旧节点。
- PUT 成功但刷新后的 `now` 未变更时不得报告切换成功。

---

## Task 1: 项目骨架与公共模型

**Files:** `package.json`, `src/config.js`, `src/model.js`, `test/config.test.js`, `test/model.test.js`, `README.md`

- [ ] 写测试：默认配置精确包含 30000/5000/3/3/2/120000/1800000/60000 与 `🚀 节点选择`；非法数值安全归一化；节点初始为 `healthy`。
- [ ] 运行 `node --test test/config.test.js test/model.test.js`，确认因模块不存在而失败。
- [ ] 建立 ES module 项目和 `node --test` 脚本，实现 `DEFAULT_CONFIG`、`normalizeConfig(input)`、`createNodeState(tag)`、`serializeNodeState(state)`。
- [ ] 重跑同一测试，确认通过；提交 `feat: add resilient selector project foundation`。

## Task 2: Clash API 客户端与响应解析

**Files:** `src/response.js`, `src/api.js`, `test/response.test.js`, `test/api.test.js`

- [ ] 写测试：200 + 正数 delay 成功；503/504/非 JSON/0/负数失败；节点名 URL 编码；Bearer 授权；PUT `{name: node}`。
- [ ] 运行 `node --test test/response.test.js test/api.test.js`，确认因模块不存在而失败。
- [ ] 实现 `parseDelayResponse(status, body)` 和 `createClashApi({baseUrl, secret, fetchImpl})`，提供 `getProxies(signal)`、`probe(node,url,timeoutMs,signal)`、`select(group,node,signal)`；所有非 2xx 失败并支持取消/超时。
- [ ] 重跑测试确认通过；提交 `feat: add sing-box clash api client`。

## Task 3: 可恢复健康状态机

**Files:** `src/health-state.js`, `test/health-state.test.js`

- [ ] 写测试：单次失败不冷却；第 3 次失败进入冷却；到期变半开；2 次恢复成功回健康；半开失败按 2 倍退避且不超过 1800000ms；冷却节点不可作为候选。
- [ ] 运行 `node --test test/health-state.test.js`，确认因模块不存在而失败。
- [ ] 实现纯时间参数状态转换：`recordProbeSuccess`、`recordProbeFailure`、`getProbePlan`、`isEligibleCandidate`；禁止内部读取系统时钟。
- [ ] 重跑测试确认通过；提交 `feat: add recoverable node health state machine`。

## Task 4: Selector 监控与切换确认

**Files:** `src/monitor.js`, `test/monitor.test.js`

- [ ] 写测试：同步主组 `all/now`；URLTest 不展开；并发不超过 3；轮次不可重入；失败当前节点只选择成功候选；外部 `now` 变化重置窗口；PUT 后 `now` 不匹配时失败。
- [ ] 运行 `node --test test/monitor.test.js`，确认因模块不存在而失败。
- [ ] 实现 `createMonitor({api,config,clock,logger})`，提供 `runCycle()`、`start()`、`stop()`、`getSnapshot()`；每轮先同步组，再探测，再执行“候选成功→PUT→刷新确认”。
- [ ] 重跑测试确认通过；提交 `feat: add selector monitoring and failover`。

## Task 5: GFS 插件适配与元数据

**Files:** `plugins/GFS/plugin-singbox-resilient-node-switcher.js`, `plugins/gfs.json`, `scripts/build-plugin.js`, `test/plugin-source.test.js`, `README.md`

- [ ] 写测试：源码可解析；元数据 ID/path/triggers/configuration 齐全；源码没有 `APP_TITLE`、`advancedConfig`、`providers/proxies`、配置写回或节点删除；现有插件路径不被引用；GUI 插件单文件可独立解析且不导入项目 `src/`。
- [ ] 运行 `node --test test/plugin-source.test.js`，确认因文件不存在而失败。
- [ ] 实现默认导出工厂和生命周期：`onRun`、`onCoreStarted`、`onCoreStopped`、`onShutdown`、`onDispose`、`onUninstall` 及停止菜单；从当前 profile 解析 API；状态写入 GUI data；UI 展示当前节点、状态、延迟、错误和冷却截止时间。GUI 可安装插件必须自包含全部运行逻辑，不通过相对路径或运行时导入项目 `src/`；用零第三方依赖的 `scripts/build-plugin.js` 从 `src/` 生成可审计内联单文件，或明确维护等价内联实现。
- [ ] 构建/一致性验证：测试插件可独立语法解析、无项目模块导入，并校验生成插件中的公共默认配置与 `src/config.js` 保持一致；构建输出不得修改现有用户插件。
- [ ] 重跑 `node --test test/plugin-source.test.js && node --test`，确认通过；提交 `feat: add GUI for SingBox resilient node switcher`。

## Task 6: 集成契约、文档与最终验证

**Files:** `test/integration-contract.test.js`, `README.md`

- [ ] 写测试：元数据与文件路径一致；默认值一致；README 说明 URLTest 不接管、故障节点会恢复、主动探测不等于全部业务恢复。
- [ ] 运行 `node --test test/integration-contract.test.js`，确认因契约未完成而失败。
- [ ] 完成安装、配置、状态机、回滚、限制和用户验收文档；不写未验证的网络成功承诺。
- [ ] 运行 `node --test` 与 `openspec validate --all --json`，确认全部通过和 OpenSpec valid。
- [ ] 提交 `docs: document resilient selector switcher`；生成完整 diff，等待用户人工审阅，不自动推送或创建 PR。
