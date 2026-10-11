# 设计文档：弹性节点切换（双通道快探 + 候选池后台刷新）

日期：2026-10-11
状态：待评审
相关变更：`openspec/changes/resilient-selector-failover`

## 1. 背景与目的

用户在 macOS 上使用 GUI.for.SingBox 时，代理经常间歇性上不了网，核心日志反复出现
`dial tcp 18.183.49.68:50131: i/o timeout`。现有通用智能切换插件无法稳定避开故障出口。

本设计要落地一个 GUI.for.SingBox 专用、可配置、可开源、考虑投稿 Plugin-Hub 的节点切换插件：
只管理一个主 Selector（`🚀 节点选择`），通过 Clash API 主动探测节点、以连续失败与延迟劣化为证据谨慎切换；
故障节点进入可恢复冷却，到期半开验证后重新进入候选池，**绝不永久剔除**。

## 2. 现状问题诊断（真实环境观察约 8 分钟）

对已落地的 `plugin-singbox-resilient-node-switcher` 在真实 sing-box 上持续采样 `state.json` 多轮快照后，
确认状态机正确（failureCount 从 `{0:53,1:107,2:35}` 累积、healthy⇔fc=0、suspect⇔fc=1/2 严格一致），
但暴露出 4 个架构级问题：

1. **故障切换延迟约 16 分钟**：一轮探测 195 节点需约 5.5 分钟（`concurrency=3` × 大量 5s 超时），
   再乘 `failureThreshold=3`，从节点故障到切走至少 3 轮 ≈ 16 分钟，远慢于用户预期。
2. **「request aborted」实为超时**：`src/api.js` 的 `probe` 嵌套两层 `combineSignal`，
   超时触发的 `abort` 被 `fetch` 抛成 `AbortError`，`errorResult` 按 `error.name === 'AbortError'`
   误归类为「request aborted」而非「request timeout」。真实采样 108 次 aborted 实为超时。
3. **type:File 安装丢元数据**：用户以文件方式导入后，GFS 注册仅 `triggers:[on::manual]`、
   `configuration:[]`、`hasUI:false`、`menus:{}`，核心重启不自动启动、无法改配置。
4. **单一探测 URL（gstatic.com）是国内不稳的单点故障**：被墙/DNS 污染时大量节点被误判为超时，
   且全池失败无法区分「节点故障」与「探测目标/API 故障」。

用户明确要求「从根本设计上解决，不能暂时混过去」，因此本设计重构探测节奏与职责拆分，而非微调参数。

## 3. 方案对比与选择

| 方案 | 思路 | 取舍 |
|------|------|------|
| A（选用）| 双通道：当前节点快探 + 候选池后台低频并发刷新 | 切换快（约 30~45s）且维护新鲜候选，架构清晰，唯一代价是实现复杂度 |
| B | 维持单轮全量探测，仅调大并发与阈值 | 改动最小，但切换延迟仍受 195 节点全量探测拖累，无法降到分钟级 |
| C | 内核 URLTest 接管 + 插件只读 | 侵入内核、与自身测速冲突，放弃 |

选 A：把「慢」的全量探测从关键路径（切换）剥离到后台通道，关键路径只探当前节点，实现快速故障感知。

## 4. 设计决策

1. **候选池策略 = 后台低频并发刷新**：当前 now 节点每 10s 单独快速探测；候选池每 2~3 分钟用 20+ 并发后台刷新，
   始终维护新鲜 healthy 候选列表；当前节点故障时直接从候选列表选，无需现场探 195 节点。
2. **故障切换目标延迟 = 约 30~45s**：当前节点每 10s 探一次、timeout 4s、连续失败 3 次判故障。
3. **状态机重新定位 = 状态机管候选资格，当前节点单列**：当前 now 用独立快速判定（连续失败→直接切走，不走 cooldown）；
   被切走节点进 cooldown，到期 half-open 验证后重新进候选池；其他候选低频刷新用 healthy/suspect 标记资格。
4. **回切 = 不自动回切**：故障节点恢复后只重新进入候选池，不主动抢回当前节点。
5. **切换触发 = 故障 OR 延迟劣化**：延迟维度加到「何时切」，候选选择仍取第一个健康节点。
6. **延迟劣化定义 = 相对基线倍数**：基线 = 最近 5 次成功延迟中位数；实时延迟 > 基线 × 3 记一次劣化；
   连续 2 次劣化触发切换（判定约 20s）。
7. **可观测性**：面板节点表格当前节点行高亮（置顶 + 加粗 + 「当前」角标）、标题栏醒目展示当前节点名、
   展示「上次切换 A → B · 时间」。

## 5. 盲点与处理

| 盲点 | 处理 |
|------|------|
| 配置项在 type:File 安装下暴露不出来 | 暂缓（测试阶段 `normalizeConfig` 正确读写配置即可，UI 配置暴露后续单独处理）|
| 候选池冷启动（无候选可切）| 预热：启动/切换后先跑一轮候选池刷新再启用切换 |
| 延迟基线冷启动（基线不足）| 基线窗口（5 次）未满时禁用延迟劣化判定，只走故障判定 |
| 探测 URL 可靠性 | 保留 gstatic.com 为默认（Clash API `/delay` 走节点出口访问该 URL，正是「节点能否上外网」的验证）|
| 快速乒乓切换 | 切换后最短驻留 + 被切走节点进 cooldown 不立即回切 |

## 6. 架构：双通道

拆为两个独立定时器驱动的通道，互不阻塞，共享 `nodeStates` / `candidates` / `lastSwitch`。

- **通道 A · 当前节点快探**（`watchIntervalMs`）：只探测 `selector.now` 一个节点，命中「连续失败」或「延迟劣化」即触发切换。
- **通道 B · 候选池后台刷新**（`poolRefreshIntervalMs`）：并发探测全部叶子（跳过当前 now、跳过 URLTest），
  走完整状态机维护候选资格，产出新鲜候选列表。

状态机职责拆分：

- **通道 B 节点**：用完整状态机 `healthy → suspect → unhealthy/cooldown → half-open → healthy` 管候选资格。
- **当前节点**：单列，不进 cooldown；连续失败直接切走；被切走节点落回通道 B 的 cooldown 队列。

## 7. 数据流与切换三段式

### 7.1 通道 A · 当前节点快探

1. `getProxies` 读 `selector.now`，确认无外部改动（有改动则接受新选择、重置窗口，不切回）。
2. 只探测 `now`（超时 `watchTimeoutMs`），探测 URL 按轮次轮换（`probeUrls[watchCycleCount % probeUrls.length]`）。
3. 成功 → 推进滑动基线（最近 `baselineWindow` 次）；失败 → `failureCount++`。
4. 判定，任一命中即触发切换：
   - **故障**：连续失败 ≥ `failureThreshold`（连续多轮轮换不同 URL，天然要求多个 URL 都失败才判故障，单 URL 抖动最多 1 次失败）
   - **延迟劣化**：基线满后，实时延迟 > 基线中位数 × `degradationRatio`，连续 `degradationThreshold` 次

### 7.2 通道 B · 候选池后台刷新

1. `getProxies` 读成员列表（跳过当前 now、跳过 URLTest）。
2. 以 `poolConcurrency` 并发探测全部叶子，每节点走完整状态机；本轮统一使用一个探测 URL（按轮次轮换）。
3. **全池失败熔断**：统计本轮实际探测节点的失败率，若失败率 > `poolFailureRateThreshold`，判定为「探测目标/API 故障」而非「节点故障」，本轮结果作废（不推进任何节点状态、保持上一轮 `nodeStates`），记 `lastError` 与 warn。
4. 产出 `candidates` = 状态 healthy 且 `lastDelay != null` 且 `lastError == null` 的节点列表（按 `getProxies` 返回的成员顺序排列），缓存起来。

### 7.3 切换三段式（通道 A 命中后）

1. **选**：从缓存 `candidates` 取第一个（已新鲜探测，**不现场探 195 节点**）。
2. **切**：`PUT /proxies/{selector} {name: target}`。
3. **确认**：`getProxies` 刷新核对 `now === target`，一致才记 `lastSwitch`；不一致按失败处理（不重复 PUT）。

## 8. 配置项

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `selectorName` | `'🚀 节点选择'` | 主 Selector 名（保留）|
| `probeUrls` | `['https://www.gstatic.com/generate_204','https://cp.cloudflare.com/generate_204','https://www.google.com/generate_204']` | 探测 URL 列表，按轮次轮询（原 `probeUrl` 改为列表）|
| `watchIntervalMs` | `10000` | 通道 A 快探间隔（原 `intervalMs:30000` 拆出）|
| `watchTimeoutMs` | `4000` | 快探超时（原 `timeoutMs:5000`）|
| `poolRefreshIntervalMs` | `180000` | 通道 B 候选池刷新间隔（原 `intervalMs` 拆出）|
| `poolTimeoutMs` | `5000` | 候选池探测超时 |
| `poolConcurrency` | `20` | 候选池并发（原 `concurrency:3`）|
| `poolFailureRateThreshold` | `0.9` | 全池失败熔断阈值（本轮失败率超过则作废）|
| `failureThreshold` | `3` | 连续失败判故障（保留）|
| `recoveryThreshold` | `2` | half-open 恢复阈值（保留）|
| `initialCooldownMs` | `120000` | 初始冷却（保留）|
| `maxCooldownMs` | `1800000` | 冷却上限（保留）|
| `minDwellMs` | `60000` | 最短驻留（乒乓防护，保留）|
| `degradationRatio` | `3` | 延迟劣化倍数（新增）|
| `degradationThreshold` | `2` | 劣化连续次数（新增）|
| `baselineWindow` | `5` | 基线窗口（新增）|

改动落点：`src/config.js`（`DEFAULT_CONFIG` + `normalizeConfig` 新键校验）、
`scripts/plugin-adapter.js`（`buildConfig()` 改读 `Plugin.WatchIntervalMs` 等新键）、
`plugins/gfs.json`（`configuration` 重写为 16 项）。

## 9. 错误处理与边界情况

1. **探测错误分类（顺带修问题 2）**：重构 `api.js` 只保留一层超时，用 `signal.reason`（`TimeoutError`）判定，
   让「超时」和「外部 abort」归到正确错误类；`aborted`（被 stop 中断）不计入失败。
2. **候选池为空（冷启动 / 全故障）**：不切换，保持当前节点，记 `lastError='候选池为空，等待通道 B 刷新'`。
3. **乒乓防护**：切换后对新当前节点设最短驻留 `minDwellMs`；被切走节点进 cooldown，`initialCooldownMs` 内不重新成为候选。
4. **切换三段式失败**：PUT 失败或刷新确认失败均记错误、不重试、不抛异常中断通道 A，等下一轮重新判定。
5. **外部 now 变化**：接受新选择、重置 failureCount/劣化计数、不切回旧节点。
6. **延迟基线不足**：基线未满时禁用延迟劣化判定，只走故障判定。
7. **停止竞态**：`stop()` 用局部 `AbortController`，`abort()` 后置空；`runCycle` 后续批次不得解引用已置空 controller
   （守住 `dcd4898` 已修过的 null 解引用，需回归测试覆盖）。
8. **探测 URL 不稳定**：改用 `probeUrls` 列表按轮次轮询，单 URL 抖动最多影响一轮快探；候选池整轮失败率超过
   `poolFailureRateThreshold` 时全池熔断，本轮作废不推进状态，避免探测目标故障污染节点状态机。

## 10. 可观测性 UI 落地

`getSnapshot()` 扩展新增三块：

- `channelA`：当前节点快探状态（`failureCount`、`degradationCount`、`baseline` 最近 5 次延迟、`lastDelay`）。
- `candidates`：候选池健康节点列表（通道 B 产物）。
- `lastSwitch` 强化为 `{from, to, at}`。

面板（`plugin-adapter.js` Vue 模板）改造：

1. 标题栏醒目展示「当前节点：`xxx`」，右侧展示「上次切换 A → B · 时间」。
2. 节点表格：当前节点行置顶 + 加粗 + 「当前」角标；通道 B 状态列沿用
   🟢 healthy / 🟡 suspect / 🔴 cooldown / 🔵 half-open；新增「候选池」列表区块展示待命健康节点。

## 11. 非目标（保持既有边界）

不接管 URLTest；不调用 provider healthcheck；不修改内核配置；不删除节点；不按 IP:端口合并节点；
不自动回切；不因控制面失败归咎于全部节点。

## 12. 需同步更新的既有产物

- `test/monitor.test.js`：重写为双通道语义（快探判定 + 候选池刷新 + 三段式确认）。
- `test/api.test.js`：补一层超时后的错误分类断言。
- `test/config.test.js`：新配置键默认值与校验。
- `test/plugin-source.test.js`、`test/integration-contract.test.js`：expected 表更新为 16 键 + 新触发器断言。
- `README.md`：配置表、状态机说明、限制说明更新。
