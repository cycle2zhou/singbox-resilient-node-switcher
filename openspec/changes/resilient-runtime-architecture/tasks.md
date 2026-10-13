## 1. 核心模型与可观测标识

- [x] 1.1 新增 `src/runtime-model.js`，定义 `createTopologySnapshot`、`createCandidateSnapshot`、`isCandidateSnapshotFresh`、`isTopologyMatch` 和 `createCorrelationId`，覆盖 generation、时间、拓扑指纹和结构化候选模型。
- [x] 1.2 新增 `test/runtime-model.test.js`，先固定快照字段、过期判断、拓扑指纹变化和关联标识唯一性的失败测试。
- [x] 1.3 将 `scanId`、`requestId`、`switchId` 与扫描/切换阶段指标接入事件模型，保证事件不包含 secret；运行 `node --test test/runtime-model.test.js`。

## 2. 候选扫描与快照存储隔离

- [x] 2.1 新增 `src/candidate-store.js`，实现 `createCandidateStore`、`getSnapshot`、`publish` 和 `getUsableCandidates`；仅接受更新 generation 且拓扑匹配的发布结果。
- [x] 2.2 新增 `src/candidate-scanner.js`，实现 `createCandidateScanner({api, config, clock, logger, store})`、`scan()`、`start()` 和 `stop()`；扫描使用局部状态、有限并发和整轮 deadline，完成后原子发布，失败或取消不发布半成品。
- [x] 2.3 新增 `test/candidate-store.test.js` 与 `test/candidate-scanner.test.js`，覆盖后台扫描不覆盖前台观察、旧扫描晚完成丢弃、整轮失败保留旧快照、deadline、拓扑变化和前后台并发预算。
- [x] 2.4 运行候选模块测试并提交 `feat: isolate candidate scanning and snapshots`。

## 3. 统一切换协调器

- [x] 3.1 新增 `src/switch-coordinator.js`，实现 `createSwitchCoordinator({api, config, clock, logger, candidateStore, observeCurrent, realProbe})` 和 `requestSwitch(request)`；所有候选复核、PUT、now 确认、真实验证、回退和 URLTest 兜底均在该模块完成，`api.select()` 只保留一个调用点。
- [x] 3.2 新增 `test/switch-coordinator.test.js`，先固定请求去重、故障优先级、候选实时复核、PUT 后 now 不一致、真实验证失败回退、外部 now 变化使事务失效和 URLTest 兜底互斥。
- [ ] 3.3 将候选过期规则、盯梢保护和择优抑制接入协调器；运行 `node --test test/switch-coordinator.test.js` 与 `grep` 检查生产代码仅有一个 `api.select(` 调用点。
- [ ] 3.4 提交 `feat: centralize selector switch transactions`。

## 4. 统一运行态与版本化持久化

- [ ] 4.1 新增 `src/runtime-state.js`，实现事件归约入口 `createRuntimeState`、`applyRuntimeEvent` 和单调递增 `revision`，统一 currentNow、lastSwitch、候选快照、节点状态和盯梢状态。
- [ ] 4.2 新增 `src/state-store.js`，实现 `createStateStore({readFile, writeFile, clock, logger})`、`load()`、`commit(event)` 和 `flush()`；写盘按 revision 防旧写覆盖，拒绝损坏或不自洽快照。
- [ ] 4.3 新增 `test/runtime-state.test.js` 与 `test/state-store.test.js`，覆盖成功/失败切换提交、乱序写盘、写盘失败内存继续有效、损坏状态拒绝和重启时以 Clash API now 为准。
- [ ] 4.4 提交 `feat: version runtime state persistence`。

## 5. 监控装配与生命周期

- [ ] 5.1 重构 `src/monitor.js` 为 RuntimeCoordinator 装配层，接入 Topology、前台 CurrentNodeWatcher、CandidateScanner、CandidateStore、SwitchCoordinator、HealthState 和 RuntimeState；保留 `createMonitor({api, config, clock, logger, httpGetImpl})` 的外部接口。
- [ ] 5.2 增加前台优先调度测试，证明 watchCycle 不等待后台扫描、不反复取消后台扫描，后台扫描完成前保留旧候选且完成后原子替换。
- [ ] 5.3 保留并迁移已有故障、盯梢、真实 GET、冷却恢复、手动切换和 URLTest 兜底测试；运行全量 `node --test`。
- [ ] 5.4 提交 `refactor: assemble monitor runtime components`。

## 6. GFS 适配、构建与文档

- [ ] 6.1 更新 `scripts/plugin-adapter.js`，以单一 RuntimeState 快照刷新 UI 和持久化，补充 generation、revision、scanId、requestId、switchId 和扫描耗时字段。
- [ ] 6.2 更新 `scripts/build-plugin.js` 的模块内联顺序及 `test/plugin-source.test.js`，确保无运行时 import、唯一 select 调用点和生命周期清理完整。
- [ ] 6.3 更新 `plugins/gfs.json`、`README.md` 和集成契约测试，说明候选快照有效期、故障/择优优先级、诊断关联标识和不接管 URLTest 的边界。
- [ ] 6.4 运行 `node --test`、`node scripts/build-plugin.js`、`node --check plugins/GFS/plugin-singbox-resilient-node-switcher.js`、`openspec validate --all`，仅在仓库内构建并提交 `feat: adopt consistent runtime architecture`。

## 7. 真实环境验收

- [ ] 7.1 使用临时目录脚本记录 30 分钟 S0-S9 验收：启动、池扫描、死节点、慢节点、手动切换、候选失效回退、cooldown 恢复、连续稳定性和代理访问。
- [ ] 7.2 审阅 state.json 与事件诊断，确认 revision 单调、扫描/切换关联标识完整、旧结果未覆盖新状态且无凭据泄露。
- [ ] 7.3 在用户明确确认后备份并替换用户插件，重启 GFS 后执行最终观测；失败时仅恢复最近备份，不删除用户 data 或 sing-box 配置。
