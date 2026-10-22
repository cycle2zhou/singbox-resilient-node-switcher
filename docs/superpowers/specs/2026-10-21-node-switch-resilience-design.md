# 节点切换弹性优化设计

日期：2026-10-21
状态：已批准

## 1. 背景与目标

用户的核心场景：**免费节点质量参差不齐、经常大面积断网，目前用户需要手动一个个试节点找能用的**。插件要自动完成「发现可用节点 → 切换」，把用户从手动找节点里解放出来。

### 验收标准（用户明确）

| 指标 | 目标 |
|------|------|
| 断网后自动切换 | **几秒内** |
| 节点池规模 | ≤ 500（订阅机场 ≤ 10） |
| 覆盖场景 | 重启、冷启动、手动切换、断网复连 |

其他目标（平滑切换、最小断网、性能检测）都为「断网秒级切到可用节点」这个核心服务。

### 规模与质量约束

- 节点池 ≤ 500，多机场聚合（≤ 10 个订阅）。
- 节点**大面积死亡**：实测 189 节点中 142 个 CF-自建节点全部 503（连接失败，换探测 URL 无效），只有 47 个专线节点可用，其中真正稳定可用的更少。
- 免费节点状态**随时变化**（刚才可用，下一秒就断），候选池必须持续保持新鲜。

## 2. 现有架构（基于真实代码）

运行时状态（`src/monitor.js` 为核心，`createMonitor`）：

- `watchCycle()`（monitor.js:825-1039）：每 `watchIntervalMs=10000` 跑一次，探测**当前节点**，失败/退化累积计数后触发切换。
- `poolCycle()`（monitor.js:546-823）：每 `scanIntervalMs=10000` 跑一次，探测**一批候选节点**，成功后 `candidateStore.publish()` 更新候选池。
- `switchCoordinator.execute()`（switch-coordinator.js:28-236）：切换时从候选池取 `preSwitchMaxProbe=3` 个候选，逐个「HEAD 复核 → PUT 切换 → 确认 now → 真实 GET 验证」。
- `scanPolicy.selectTargets()`（scan-policy.js:78-103）：选探测目标 = forced(当前节点+候选) + main(score 前 20) + explore(轮换 5)。
- `candidateStore.getUsableCandidates()`：断网切换（priority=10）时 `allowExpired=true`，过期候选也可用但 `requiresRecheck=true`（切换时逐个 HEAD 复核）。

### 关键事实：重启不恢复运行时状态

- `monitor.js:58` `const nodeStates = new Map()` — 重启空。
- `monitor.js:69` `const scanPolicy = createScanPolicy(...)` — 重启空，score 全重置 80。
- `runtime-state.js` 持久化字段只有 `currentNow/lastSwitch/lastError/candidateSnapshot/nodeStates/stalking/diagnostics`，**不含 scanPolicy 的 score**，且 monitor 启动时**不加载**持久化的 nodeStates（state.json 里的 nodeStates 仅供诊断展示）。

## 3. 核心问题清单

### 问题 1：冷启动死锁（候选池十几分钟为空）

**根因**：重启后 score 全 80、nodeStates 空；`selectTargets` 排序 `right.score - left.score || (left.lastProbeAt ?? -Infinity) - (right.lastProbeAt ?? -Infinity)`（scan-policy.js:91-92），所有节点同分同 lastProbeAt=null，排序退化为 members 顺序（GFS 订阅顺序，CF-自建死节点在前）。于是 main 前 20 + explore 5 全是死节点，explore 每轮仅轮换 5 个，遍历完 122 个死节点才轮到专线 ≈ 十几分钟。

**表现**：重启后候选池长期空（`candidateCount=0`），断网时无从切换。

### 问题 2：断网检测慢（30 秒才触发切换）

**根因**：`watchFailureCount >= effectiveFailureThreshold`（monitor.js:968，稳定期 = `failureThreshold=3`）× `watchIntervalMs=10000` = **30 秒**才触发切换。

**表现**：与「几秒内」目标差一个数量级。

### 问题 3：切换尝试慢（串行 3 候选 ~15 秒）

**根因**：switch-coordinator.js:89-91 取 3 个候选，:119-187 逐个串行「HEAD 复核（~1s）→ PUT → 确认 → 真实 GET（realStalkTimeoutMs=3000）」，每个候选 ~4-5 秒，3 个全失败 ~15 秒。

**表现**：免费节点大面积死时，3 个候选可能全失败，切换耗时 > 一次 watchCycle 周期（10s），节奏脱节。

### 问题 4：候选池新鲜度不足

**根因**：探测调度对死节点降频靠 `intervalFor`（score<70 时 backoff 6 轮 = 60s），但冷启动时死节点尚未被「标记为死」，仍占满探测名额，活节点（专线）覆盖慢。

**表现**：候选池里的节点可能已死（切换时才发现，靠 requiresRecheck 兜底）。

## 4. 设计方案

### 方案 A：断网即时判定（解决问题 2，最高优先）

**改法**：探测当前节点返回 **503/504（连接失败/超时）时，立即判定断网**，不必等 `failureThreshold=3` 次。

理由：503/504 是明确的「节点不可用」信号，不是偶发抖动（抖动表现为「能连通但延迟高」）。用「延迟高/退化」才需多次确认，用「连接失败」一次即判。

- 实现：`watchCycle` 里，若探测结果 `ok=false` 且 reason 含 503/504/timeout，`watchFailureCount` 直接置为阈值（等效立即触发）；同时 `watchIntervalMs` 从 10000 缩到 **5000**（已确认）。
- 效果：断网检测从 30 秒 → **~5 秒内**。

### 方案 B：冷启动快扫（解决问题 1，次高优先）

**改法**：重启后前几轮 `poolCycle` 用「全量快扫」替代 main20+explore5：并发探测**所有**节点（短超时），快速建立 score 画像，让活节点（专线）快速浮到排序前列。

理由：死节点 503 失败很快返回（<500ms），活节点 200 成功 ~1s；500 节点 / 并发 20 ≈ 25 批 × ~1s ≈ 25s 内建立完整画像（189 节点约 10s）。

- 实现：`selectTargets` 增加「快扫模式」——冷启动（`candidateGeneration` 低 或 无成功 publish）时返回全量 tags；poolCycle 冷启动轮用更高并发 + 更短超时。
- 本期仅做「冷启动快扫」（单层改动，已确认），不做持久化 score。

### 方案 C：切换提速（解决问题 3）

**改法**：切换前对候选池**并发 HEAD 预探测**前 N 个（如 5-8 个），筛出「当下可用」的候选，再按顺序切换第一个可用的；切换后的「真实 GET 验证」延后到盯梢期（watchCycle 已有关注失败即切的机制），不在切换关键路径上串行等 3 秒。

- 实现：switch-coordinator 增加「并发预探测」阶段（`Promise.all` 候选前 N 个 probeCandidate），成功者进候选队列，逐个 PUT 切换。
- 效果：切换耗时从 ~15s → **~3s**（并发探测 2s + PUT 0.5s）。

### 方案 D：候选池常鲜（解决问题 4）

**改法**：候选池节点（healthy + lastDelay 有值）强制高频探测（forced 已含 candidateTags，增强为候选节点每轮都探测）；死节点 backoff 改为**指数增长**（连续失败越多，间隔越长），把探测火力集中在活节点。

- 实现：scan-policy 的 `intervalFor`/`failurePenalty` 基础上，失败 backoff 从固定 6 轮改为随 consecutiveFailures 指数增长；候选节点 `nextProbeAt` 强制 <= now。

## 5. 期望场景行为（四场景）

| 场景 | 期望行为 | 关键指标 |
|------|----------|----------|
| 冷启动/重启 | 全量快扫，候选池快速长出可用节点 | ≤ 25s 候选池非空 |
| 断网复连 | 当前节点 503/504 即时触发切换，从新鲜候选池秒切 | ≤ 5s 触发，≤ 3s 切换 |
| 手动切换 | 检测到外部变化进入盯梢期，免驻留快速验证 | 不切回用户手动选的新节点 |
| 日常运行 | 候选池持续高频刷新活节点，死节点降频 | 候选池始终有新鲜可用节点 |

## 6. 验证与测试（全自动化）

按用户要求「优化 → 插件重启生效 → 测试」全自动：

1. 构建：`node scripts/build-plugin.js`。
2. 部署：备份后覆盖 `~/Library/Application Support/GUI.for.SingBox/plugins/plugin-ID_ydtsx0sz.js`。
3. 重启插件：通过 GFS 配置或进程重启生效。
4. 测试（读 `state.json` + 调 sing-box API `127.0.0.1:20123`）：
   - 冷启动：重启后计时，观察 `candidateCount` 何时 > 0。
   - 断网复连：主动 PUT 切到一个已知死节点（或拔线），计时到 `lastSwitch` 更新。
   - 手动切换：手动切节点，确认插件不切回。

## 7. 实施范围与风险

- **改动文件**：`src/monitor.js`（方案 A、B、D 的部分）、`src/scan-policy.js`（方案 B、D）、`src/switch-coordinator.js`（方案 C）、可能 `src/runtime-state.js`（方案 B 增强）。
- **风险**：
  - 方案 A（503/504 即时断网）：可能对「节点偶发 504」误判，需配「切换后盯梢期」兜底（已有关注失败即切）。
  - 方案 C（并发预探测）：增加切换瞬间的探测并发，需控制并发上限避免打满本地 API。
- **非目标**：不改探测 URL 适配（已确认 CF-自建 503 是真实死亡，与 URL 无关）；不改 GFS 订阅层。

## 8. 已确认决策

- 方案 B：仅「冷启动快扫」（单层改动），不做持久化 score。
- 方案 A：`watchIntervalMs` 从 10s 缩到 5s（配合 503/504 即时判定，断网检测 ~5s 内）。
