# singbox-resilient-node-switcher

面向 GUI.for.SingBox 的可恢复 Selector 节点切换插件：监控主选择组 `🚀 节点选择` 的全部直接成员，对故障节点执行「连续失败 → 冷却 → 半开探测 → 恢复」的可恢复退避，并在当前节点故障时谨慎切换到可用候选。

## 特性

- **只读探测**：仅通过 sing-box Clash API 的 `/proxies`、`/proxies/{name}/delay` 与 `PUT /proxies/{selector}` 工作，不改写生成配置、不删除节点、不按 IP:端口合并节点。
- **可恢复冷却**：故障节点进入指数退避冷却，到期后半开探测，连续成功才回到健康，不会被永久剔除。
- **三段式切换确认**：候选探测成功 → PUT 切换 → 刷新确认 `now`，任一环节失败都不会误报切换成功。
- **外部变化防抖**：用户手动切换 `now` 后，插件不会立即把节点切回旧节点。
- **双通道探测**：通道 A 高频只探当前节点，快速发现故障；通道 B 低频并发扫描全部成员，维护「候选池」供切换备用，避免 195 个节点同时探测拖垮内核。
- **延迟劣化判定**：当前节点延迟超过近期基线 `DegradationRatio` 倍且连续 `DegradationThreshold` 次，即使未超时也触发切换，捕捉「能通但慢」的劣化节点。
- **绝对延迟阈值**：当前节点延迟超过 `MaxDelayMs` 且连续 `SlowThreshold` 次，直接判慢并触发切换，避免「探测 1.4s 但真实 2~5s」的慢节点被误判健康。
- **真实延迟探测**：sing-box 的 `/delay` 用 HEAD 且不读 body，系统性低估真实 GET 延迟（实测低 3~6 倍）；用 fetch 走系统代理发起真实 GET 并读响应体，测到用户实际感知延迟，作为慢判定盲区的可靠补充。
- **全池失败熔断**：候选池单轮失败率超过 `PoolFailureRateThreshold` 时作废本轮、不推进状态，避免探测目标本身故障被误判为全部节点故障。
- **多 URL 短路探测**：`ProbeUrls` 列表按轮次轮换起始位，对同一节点依次探测、任一 URL 可达即判健康，规避单一探测 URL 被墙或 DNS 污染导致的单点误判。
- **性能择优**：当前节点延迟超过候选池最优节点 `OptimizeRatio` 倍且连续 `OptimizeThreshold` 次，即使仍可用也切到更低延迟节点，兼顾稳定与速度。
- **候选池延迟排序与切换后验证回退**：候选池按探测延迟升序，切换恒选最快；切到候选后立即真实 GET 验证，真实失效/超慢则标记冷却并回退切下一个，避免「切到失效节点」导致断网。

## 架构

核心逻辑与 GUI 完全解耦，插件适配层负责生命周期与状态展示：

| 文件 | 职责 |
| --- | --- |
| `src/config.js` | 默认配置与安全归一化 |
| `src/model.js` | 节点健康状态创建与可持久化序列化 |
| `src/response.js` | 延迟探测响应解析（正数 delay 才算成功） |
| `src/health-state.js` | 可恢复健康状态机（纯时间参数，无系统时钟依赖） |
| `src/api.js` | sing-box Clash API 客户端（超时/取消/错误模型） |
| `src/monitor.js` | Selector 监控、并发受限探测与切换确认 |
| `scripts/plugin-adapter.js` | GUI.for.SingBox 插件胶水（生命周期、配置、状态 UI） |
| `scripts/build-plugin.js` | 零第三方依赖的内联构建脚本 |
| `plugins/gfs.json` | Plugin-Hub 元数据 |
| `plugins/GFS/plugin-singbox-resilient-node-switcher.js` | 构建生成的自包含单文件插件 |

### 双通道架构

| 通道 | 节奏 | 探测对象 | 职责 |
| --- | --- | --- | --- |
| 通道 A · 快探 | 每 `WatchIntervalMs` | 仅当前节点 `now` | 连续失败或延迟劣化达阈值 → 触发切换三段式 |
| 通道 B · 候选池 | 每 `PoolRefreshIntervalMs` | 除当前节点与 URLTest 外的全部成员 | 并发受限（`PoolConcurrency`）扫描，产出健康候选池 `candidates` |

切换三段式（候选已按延迟升序排序，恒切最快）：切换前**并行复核**候选（最多 `PreSwitchMaxProbe` 个，跳过不可达者）→ `PUT /proxies/{selector}` 切换 → 刷新 `/proxies` 确认 `now` 指向目标节点。确认后**立即真实验证**（若开启 `RealProbeEnabled`，真实 GET 读 body）：真实失效/超慢则标记该候选冷却、继续切下一个候选（循环最多 `PreSwitchMaxProbe` 次），避免「切到失效节点」陷入长判定等待。切换成功后对被切走节点执行 `markCooldown`（进入冷却，`InitialCooldownMs` 内不重新成为候选），并设最短驻留 `MinDwellMs` 防止乒乓；随后进入盯梢期：`StalkProbeDelayMs` 后快探新节点，失败 1 次即快速切走（盯梢期免驻留），连续成功 `StalkSuccessThreshold` 次后退出盯梢、恢复正常阈值。

## 安装

1. 构建自包含插件单文件：

   ```sh
   node scripts/build-plugin.js
   ```

2. 将 `plugins/GFS/plugin-singbox-resilient-node-switcher.js` 与 `plugins/gfs.json` 一起安装到 GUI.for.SingBox（放入插件目录，或经 Plugin-Hub 安装）。

生成的插件单文件内联了全部运行逻辑，不通过相对路径或运行时 `import()` 引用项目 `src/`，可脱离本仓库独立运行。

## 配置

| 配置项 | 键 | 默认值 | 说明 |
| --- | --- | --- | --- |
| 主 Selector 名称 | `SelectorName` | `🚀 节点选择` | 需要监控并切换的主策略组 |
| 探测 URL 列表 | `ProbeUrls` | `https://www.gstatic.com/generate_204,https://www.google.com/generate_204,https://github.com` | 节点延迟探测的目标地址，逗号分隔；多 URL 短路探测，任一可达即判健康 |
| 快探间隔(ms) | `WatchIntervalMs` | `10000` | 通道 A 当前节点快探的间隔 |
| 快探超时(ms) | `WatchTimeoutMs` | `4000` | 当前节点单次快探的超时 |
| 绝对延迟阈值(ms) | `MaxDelayMs` | `2000` | 探测成功但延迟超过该值即计「慢」，连续慢达标触发切换 |
| 候选池刷新间隔(ms) | `PoolRefreshIntervalMs` | `180000` | 通道 B 候选池后台刷新的间隔 |
| 候选池探测超时(ms) | `PoolTimeoutMs` | `2000` | 候选池单节点探测超时，死节点多 URL 并行短路探测，缩短冷启动全池扫描 |
| 候选池并发 | `PoolConcurrency` | `20` | 候选池同批并发探测的最大节点数 |
| 全池熔断阈值 | `PoolFailureRateThreshold` | `0.9` | 本轮失败率超过该阈值则作废本轮 |
| 失败阈值 | `FailureThreshold` | `3` | 连续失败多少次后进入冷却 |
| 恢复阈值 | `RecoveryThreshold` | `2` | 半开状态下连续成功多少次后恢复健康 |
| 初始冷却(ms) | `InitialCooldownMs` | `120000` | 首次进入冷却的时长 |
| 最大冷却(ms) | `MaxCooldownMs` | `1800000` | 指数退避的冷却上限 |
| 最短驻留(ms) | `MinDwellMs` | `60000` | 切换后至少驻留该时长才允许再次切换 |
| 延迟劣化倍数 | `DegradationRatio` | `3` | 当前节点延迟超过基线该倍数判为劣化 |
| 劣化连续次数 | `DegradationThreshold` | `2` | 连续劣化多少次后触发切换 |
| 慢节点连续次数 | `SlowThreshold` | `2` | 连续多少次超过绝对延迟阈值后触发切换 |
| 基线窗口 | `BaselineWindow` | `5` | 延迟基线的采样窗口大小 |
| 择优倍数 | `OptimizeRatio` | `2` | 当前节点延迟超过候选池最优节点该倍数判为需择优 |
| 择优连续次数 | `OptimizeThreshold` | `3` | 连续需择优多少次后切换到最优候选 |
| 盯梢快探延迟(ms) | `StalkProbeDelayMs` | `2000` | 切换成功后多久发起一次盯梢快探验证新节点 |
| 盯梢成功次数 | `StalkSuccessThreshold` | `2` | 盯梢期内新节点连续成功多少次后退出盯梢恢复正常阈值 |
| 切换前复核候选数 | `PreSwitchMaxProbe` | `3` | 切换前最多复核多少个候选节点，跳过不可达者 |
| 真实延迟探测 | `RealProbeEnabled` | `true` | sing-box 的 `/delay` 用 HEAD 且不读 body，系统性低估真实 GET 延迟（实测低 3~6 倍）；开启后用 fetch 走系统代理发起真实 GET 读 body 补盲区 |
| 真实探测 URL 列表 | `RealProbeUrls` | `https://github.com,https://www.google.com` | 真实延迟探测目标地址，逗号分隔；全部探测取最慢延迟，至少一个成功才判健康 |
| 真实延迟阈值(ms) | `RealDelayMs` | `3000` | 真实 GET 延迟超过该值即计「慢」 |
| 真实探测超时(ms) | `RealProbeTimeoutMs` | `8000` | 单次真实 GET 探测的超时 |
| 盯梢期真实探测超时(ms) | `RealStalkTimeoutMs` | `3000` | 切换后盯梢期（快速检测）的真实 GET 探测超时，更短以便尽快发现慢节点再切 |
| 真实慢连续次数 | `RealSlowThreshold` | `1` | 真实 GET 连续多少次超阈值（或全部失败）后触发切换 |

## 状态机

```
healthy ──连续失败──▶ suspect ──失败达阈值(3)──▶ cooldown
   ▲                                                  │
   │ 半开连续成功达恢复阈值(2)                          │ 冷却到期（指数退避，120s 起、1800s 封顶）
   │                                                  ▼
   └────────────────────────────── half-open ◀────────┘
```

- 单次失败只累计，不立即冷却；
- 半开探测失败会回到冷却，冷却时长按 2 倍退避且不超过 `MaxCooldownMs`；
- 只有 `healthy` 与 `suspect` 状态的节点可作为切换候选。

## 限制

- 只支持 GUI.for.SingBox，不支持 GUI.for.Clash 或其他内核分支。
- 不接管 URLTest：嵌套 `🎈 自动选择` 只作为主 Selector 的成员处理，不展开其内部节点，仍由 sing-box 核心管理。
- 不调用 provider healthcheck。
- 主动探测结果仅代表探测请求本身成功，不等于所有真实业务请求均已恢复。

## 停止与回滚

- 右键菜单「停止」可停止监控与切换。
- 插件卸载会触发 `onUninstall` 清理 data 目录；`onCoreStopped`、`onShutdown`、`onDispose` 会清理定时器、进行中的请求与状态 UI。
- 卸载本插件不会改动 sing-box 配置或现有节点列表。

## 测试

```sh
npm test
```

使用 Node.js 内置测试运行器，覆盖配置归一化、响应解析、API 超时/错误模型、健康状态机、监控切换与插件源码审计边界。契约测试 `test/integration-contract.test.js` 校验元数据与文件路径一致、默认值一致，以及 README 中的关键限制说明。
