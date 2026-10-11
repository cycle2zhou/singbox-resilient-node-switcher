# SDD ledger — plan: docs/superpowers/plans/2026-10-11-resilient-selector-failover.md
Pre-flight: 任务按 Task 1→6 共享接口顺序执行；Task 1 产出配置/状态模型，Task 2 产出 API，Task 3 消费模型，Task 4 消费 API+状态机，Task 5 消费监控器，Task 6 消费插件元数据。

Task 1: complete (commits 756071e..2a26198, tests: node --test → 5/5 pass; 计数配置整数归一化 + 插件自包含方案已补)
Task 2: complete (commits 2a26198..6a9f0a7, tests: node --test → 16/16 pass; API 客户端+响应解析，含 timeout/错误模型修复)

Task 3: complete (node --test -> 23/23 pass; health-state.js 状态机 healthy/suspect/cooldown/half-open + 2倍退避封顶)

Task 4: complete (node --test -> 30/30 pass; monitor.js 同步all/now+URLTest不展开+并发受限探测+三段式切换确认+外部变化防抖)

Task 5: complete (node --test -> 38/38 pass; plugin-adapter.js GFS 胶水 + build-plugin.js 零依赖内联 + gfs.json 元数据 + 单文件插件 27311B + plugin-source.test.js 7 审计测试; probeUrl 归一化缺失已修复)

Task 6: complete (node --test -> 42/42 pass; openspec validate --all --json -> valid; README 安装/配置/状态机/限制/回滚 + integration-contract.test.js 4 契约测试)

本地验证（真实 sing-box 127.0.0.1:20123）：只读 getProxies/probe 解析 OK；三段式切换 PUT+now 确认 PASS；完整 runCycle 195 成员探测+快照 OK。发现并修复真实 bug：stop 在探测进行中置空 controller 导致 null.signal 崩溃（dcd4898），加回归测试 monitor.test.js 第 8 条，全量 43/43。

---

# 第二次迭代：dual-channel 双通道 + 探测健壮性（plan: docs/superpowers/plans/2026-10-11-resilient-selector-failover-dual-channel.md）

Task 1: complete (8b0e267) — config.js 重写为 16 键：probeUrls 数组（多 URL 轮询）+ poolFailureRateThreshold（全池熔断）+ watchIntervalMs/watchTimeoutMs/poolRefreshIntervalMs/poolTimeoutMs/poolConcurrency（双通道拆分）+ degradationRatio/degradationThreshold/baselineWindow（延迟劣化）
Task 2: complete (12c1af8) — health-state.js 加 markCooldown（被切走节点显式进入冷却）
Task 3: complete (76d0389) — api.js 单层超时，probe timeoutMs 语义唯一
Task 4: complete (da0878b) — monitor.js 双通道重构：watchCycle（快探当前 now + 外部变化重置 + 延迟劣化 + 三段式切换）+ poolCycle（候选池并发扫描 + 全池失败熔断 + probeUrls 轮询）
Task 5: complete (b4c63e9) — plugin-adapter.js 16 键 buildConfig + gfs.json 16 项元数据 + UI（当前节点置顶/候选池/上次切换）+ README 配置表 16 行
Task 6: README 双通道架构/延迟劣化/全池熔断/多 URL 轮询说明 + 全量 node --test 53/53 + openspec validate --all 通过
