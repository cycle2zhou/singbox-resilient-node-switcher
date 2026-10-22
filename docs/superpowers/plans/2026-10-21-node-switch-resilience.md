# 节点切换弹性优化实施计划

## Goal

让插件在免费节点大面积死亡的环境下，自动「发现可用节点 → 秒级切换」，把用户从手动试节点里解放出来。核心验收：断网后**几秒内**自动切到可用节点；覆盖重启/冷启动/手动切换/断网复连四场景；节点池 ≤ 500、机场 ≤ 10。

## Architecture

单进程 Node.js 插件（GFS GUI.for.SingBox 插件），核心运行时为 `src/monitor.js` 的 `createMonitor`，两条 10s 定时循环：

- `watchCycle()`（monitor.js:825-1039）：探测**当前节点**，失败累积触发切换。
- `poolCycle()`（monitor.js:546-823）：探测**候选批次**，成功 publish 刷新候选池。

切换走 `src/switch-coordinator.js` 的 `execute()`；探测目标选择走 `src/scan-policy.js` 的 `selectTargets()`；配置集中在 `src/config.js`。

## Tech Stack

- Node.js（ESM，`"type":"module"`）
- 测试：Node 内置 `node --test`（`package.json:7`），`node:assert/strict`
- 构建：`node scripts/build-plugin.js`

## Spec

`docs/superpowers/specs/2026-10-21-node-switch-resilience-design.md`（已批准）。4 方案：A 断网即时判定、B 冷启动快扫、C 切换提速、D 候选池常鲜。已确认决策：方案 B 仅冷启动快扫（不做持久化 score）；方案 A `watchIntervalMs` 10s→5s。

## Global Constraints

- **两个熔断/判定函数语义不同，不可混用**：
  - `isNodeDeath`（monitor.js:744-747，poolCycle 熔断用）：**只匹配 `'503'`**。503=TCP 连接失败=明确节点死亡，正常记录淘汰；504/timeout 可能是探测 URL 被墙的全局故障，必须保留熔断保护。
  - `isHardDown`（方案 A 新增，watchCycle 断网判定用）：匹配 `'503' | '504' | 'timeout'`。当前节点探测是单一节点，503/504/timeout 都是断网信号，一次即判。
- 探测 reason 字符串来自 `src/api.js` probe：`request failed with HTTP 503/504`、`request timeout` 等，匹配用 `.toLowerCase().includes()`。
- 候选池构造在 monitor.js:767-779，只收 `status==='healthy' && lastDelay!=null && lastError==null` 的节点；死节点（suspect）自动淘汰。
- 测试命令：全量 `npm test`；单文件 `node --test test/<file>.js`。
- 每个 task 完成必须跑全量 `npm test`（当前 174 用例全绿），再 `node scripts/build-plugin.js` 确认构建产物含改动。
- commit message 用 `type(scope): 描述`，type ∈ feat/fix/perf/refactor。

## Review Focus

1. **isHardDown 的 reason 匹配边界**：503/504/timeout 三种 reason 的变体（大小写、`HTTP 503` vs `503` vs `timeout`）都要命中，不能漏判也不能把「延迟高」误判为断网。
2. **方案 A 不能破坏 poolCycle 熔断**：isHardDown（watchCycle）与 isNodeDeath（poolCycle）语义不同，改动时不能顺带改了 isNodeDeath。
3. **方案 B 快扫仍要排除 currentNow 与 URLTest**：快扫返回全量后，probeTargets 的 filter（monitor.js:652）仍必须生效，不能探测自己或 URLTest 组。
4. **方案 C 并发预探测的 slice 边界**：`preSwitchConcurrentProbe` 大于候选池长度时不能越界；`probeCandidate` 为 undefined 时必须退化为「全部视为可用」。
5. **方案 D 指数 backoff 的数值溢出**：`consecutiveFailures` 很大时 `2**n` 会溢出，必须用 `Math.min(指数, 上限)` 截断。

---

## Task 1 — 方案 A：断网即时判定

解决设计文档「问题 2」：断网检测 30s → ~5s。

### Files

- `src/config.js`：`DEFAULT_CONFIG.watchIntervalMs` 10000 → 5000（line 8）。
- `src/monitor.js`：新增模块级纯函数 `isHardDown`；改 watchCycle 失败分支（line 959-966）。

### Interfaces

`isHardDown(reason) → boolean`：`String(reason||'').toLowerCase()` 含 `'503'` 或 `'504'` 或 `'timeout'` 即 true。

watchCycle 失败分支（当前 line 959-960）：
```js
} else {
  watchFailureCount += 1;
```
改为：
```js
} else {
  // 硬断网（503 连接失败 / 504 超时 / timeout）一次即判，无需累积 failureThreshold 次；
  // 软失败（延迟高/退化）仍走多次确认，避免把抖动误判为断网。
  watchFailureCount = isHardDown(result?.reason)
    ? (stalking ? 1 : cfg.failureThreshold)
    : watchFailureCount + 1;
```
（`stalking` 是闭包变量，`cfg` 是闭包 config；不依赖 line 969 才定义的 `effectiveFailureThreshold`，故内联 `stalking ? 1 : cfg.failureThreshold`。）

### Steps

- [ ] 写失败测试：`test/monitor.test.js` 新增用例「当前节点 503 一次即触发切换（不累积 3 次）」。用 `makeApi({ probe: node==='n1' ? {ok:true,delay:10} : {ok:false,reason:'request failed with HTTP 503'} })` + `fastConfig`；`await monitor.poolCycle()` 建候选池 `['n1']`；第一次 `watchCycle()` 探测 n0 得 503 → watchFailureCount 直接到阈值但被 `minDwellMs=1` 挡住；`clock.advance(1000)` 后第二次 `watchCycle()` 即切。断言 `getSnapshot().currentNow === 'n1'` 且 `lastSwitch.reason === 'failure'`。
- [ ] 跑 `node --test test/monitor.test.js`，确认新用例失败（当前 503 需累积 3 次，第一次不切）。
- [ ] 实现：config.js 改 watchIntervalMs；monitor.js 加 isHardDown + 改失败分支。
- [ ] 跑 `node --test test/monitor.test.js`，确认新用例通过、原「通道 A 连续失败 3 次」用例仍通过（timeout 现在也即时触发，但结果仍 selected=['n1']）。
- [ ] 跑 `npm test` 全量（174 用例全绿）。
- [ ] 跑 `node scripts/build-plugin.js`，确认产物含 `isHardDown` 与 `5000`。
- [ ] commit `fix(monitor): 断网即时判定，watchIntervalMs 缩至 5s`

---

## Task 2 — 方案 B：冷启动快扫

解决设计文档「问题 1」：重启后候选池十几分钟为空 → 快扫全量，~25s 内建立 score 画像。

### Files

- `src/scan-policy.js`：`selectTargets`（line 78）加 `fastScan` 参数。
- `src/monitor.js`：poolCycle 加快扫判定（line 646 附近）+ 传参 + batchSize 提升（line 668）。

### Interfaces

`selectTargets({ tags, currentNow, candidateTags, now, fastScan = false })`：`fastScan` 为 true 时 `round += 1` 后直接 `return [...new Set(tags)]`（全量，跳过 forced/main/explore 逻辑）。

poolCycle 改动：
```js
// line 646 前加判定（candidateGeneration 是闭包变量，首次 publish 前为 0）
const fastScan = candidateGeneration === 0;
const policyTargets = scanPolicy.selectTargets({
  tags: members.filter((tag) => memberTypes[tag] !== 'URLTest'),
  currentNow,
  candidateTags: candidates,
  now: time.now(),
  fastScan,
});
```
```js
// line 668：快扫时用 poolConcurrency 突破 backgroundBatchSize 限制
const batchSize = fastScan
  ? Math.min(cfg.poolConcurrency, probeTargets.length)
  : Math.min(schedulerState.backgroundBatchSize, schedulerState.backgroundConcurrency);
```
（probeTargets 的 filter 仍在 line 652 生效，快扫返回全量后仍会排除 currentNow 与 URLTest。）

### Steps

- [ ] 写失败测试：`test/scan-policy.test.js` 新增「快扫模式返回全量 tags」——`createScanPolicy({config:{...DEFAULT_CONFIG, scanMainPoolSize:20, scanExplorePoolSize:5}, clock:{now:()=>0}})`，30 个 tag 调 `selectTargets({tags, fastScan:true})`，断言 `targets.length === 30`（非 20+5）。
- [ ] 写失败测试：`test/monitor.test.js` 新增「冷启动 poolCycle 全量快扫」——30 个 tag（n0 为 currentNow），`makeApi` 的 probe 记录被探测节点并返回 ok；`await monitor.poolCycle()` 后断言 `getSnapshot().diagnostics.scan.targetCount === 29`（排除 currentNow 后全量）。
- [ ] 跑 `node --test test/scan-policy.test.js test/monitor.test.js`，确认两个新用例失败。
- [ ] 实现：scan-policy.js 加 fastScan 参数；monitor.js 加快扫判定/传参/batchSize。
- [ ] 跑单文件测试，确认新用例通过、原有 selectTargets 用例（默认 fastScan=false）不受影响。
- [ ] 跑 `npm test` 全量。
- [ ] 跑 `node scripts/build-plugin.js`，确认产物含 `fastScan`。
- [ ] commit `feat(scan-policy): 冷启动全量快扫`

---

## Task 3 — 方案 D：候选池常鲜（死节点指数退避）

解决设计文档「问题 4」：死节点降频从固定 6 轮改为随连续失败次数指数增长，把探测火力集中在活节点。

### Files

- `src/config.js`：`DEFAULT_CONFIG` 新增 `scanBackoffMaxRounds: 64`（line 57 后），并加入 `POSITIVE_INTEGER_KEYS`。
- `src/scan-policy.js`：`recordProbe`（line 44-59）失败分支改为指数 backoff。

### Interfaces

`recordProbe` 失败分支（当前 line 52-57）：
```js
} else {
  state.consecutiveFailures += 1;
  const penalty = real ? config.scanRealFailureStep : failurePenalty(reason, config);
  state.score = Math.max(0, state.score - penalty);
  // 指数退避：连续失败越多间隔越长，上限 scanBackoffMaxRounds 轮
  const baseRounds = intervalFor(state.score, config);
  const exponent = Math.min(state.consecutiveFailures - 1, 6); // 2^6=64，防溢出
  const backoffRounds = Math.min(baseRounds * (2 ** exponent), config.scanBackoffMaxRounds);
  state.nextProbeAt = now + backoffRounds * config.scanIntervalMs;
}
```
成功分支（line 48-51）保持原样：`state.nextProbeAt = now + intervalFor(state.score, config) * config.scanIntervalMs`。

### Steps

- [ ] 写失败测试：`test/scan-policy.test.js` 新增「连续失败退避指数增长」——`recordProbe({tag:'n1', ok:false, reason:'request timeout', now:0})` 后 `getState('n1').nextProbeAt === 6*scanIntervalMs`（第一次仍 6 轮，兼容现有测试）；再 `recordProbe({tag:'n1', ok:false, reason:'request timeout', now:6*scanIntervalMs})` 后 `nextProbeAt === 6*scanIntervalMs + 12*scanIntervalMs`（第二次 12 轮）。
- [ ] 跑 `node --test test/scan-policy.test.js`，确认新用例失败（当前第二次仍 6 轮）。
- [ ] 实现：config.js 加 scanBackoffMaxRounds + POSITIVE_INTEGER_KEYS；scan-policy.js 改失败分支。
- [ ] 跑单文件测试，确认新用例通过、现有「评分退避」「低分降频可恢复」用例仍通过。
- [ ] 跑 `npm test` 全量。
- [ ] 跑 `node scripts/build-plugin.js`，确认产物含 `scanBackoffMaxRounds`。
- [ ] commit `feat(scan-policy): 死节点指数退避`

---

## Task 4 — 方案 C：切换提速（并发预探测）

解决设计文档「问题 3」：串行 3 候选 ~15s → 并发预探测 + 筛可用，~3s。

### Files

- `src/config.js`：`DEFAULT_CONFIG` 新增 `preSwitchConcurrentProbe: 8`（line 28 后），并加入 `POSITIVE_INTEGER_KEYS`。
- `src/switch-coordinator.js`：`execute`（line 89-187）加并发预探测阶段。

### Interfaces

execute 改动（line 89-91 改 slice 上限，line 119 前加预探测，line 127-135 删除 probeCandidate 复核）：
```js
const candidates = selection.candidates
  .filter((candidate) => stableKey(candidate.tag) !== stableKey(before.now))
  .slice(0, Number(config?.preSwitchConcurrentProbe) || Number(config?.preSwitchMaxProbe) || selection.candidates.length);
```
```js
// line 93 后：并发预探测，筛出「当下可用」候选
const probeResults = await Promise.all(candidates.map(async (candidate) => {
  if (typeof probeCandidate !== 'function') return { candidate, ok: true };
  try {
    const probe = await probeCandidate(candidate.tag, request);
    return { candidate, ok: Boolean(probe?.ok) };
  } catch {
    return { candidate, ok: false };
  }
}));
const readyCandidates = probeResults.filter((p) => p.ok).map((p) => p.candidate);
recheckedCount = readyCandidates.length;
```
```js
// line 119：for 循环改遍历 readyCandidates，并删除 line 127-135 的 probeCandidate 复核块
for (const candidate of readyCandidates) {
```
（`failedCandidateKeys` 的 `continue` 逻辑保留在 realProbe 失败分支 line 151；probeCandidate 为 undefined 时预探测全部视为可用，行为与原「无 probeCandidate 直接 PUT」一致。）

### Steps

- [ ] 写失败测试：`test/switch-coordinator.test.js` 新增「并发预探测筛出可用候选」。用 inflight 计数器断言并发性（串行时 maxInflight 恒为 1，并发时为候选数）：`baseOptions({ probeCandidate: async (tag) => { inflight+=1; maxInflight=Math.max(maxInflight,inflight); await new Promise((r)=>setTimeout(r,10)); inflight-=1; return tag==='bad-good'?{ok:false}:{ok:true}; } })` + `makeStore([candidate('bad-good',1), candidate('good',2)])`；`requestSwitch({reason:'failure',priority:10})` 断言 `result.ok===true && result.node==='good'`、`options.calls.map(({tag})=>tag)===['good']`（bad-good 被预探测淘汰，未 PUT）、且 `maxInflight===2`（两个候选并发探测，非逐个串行）。
- [ ] 跑 `node --test test/switch-coordinator.test.js`，确认新用例失败（当前串行 for 循环逐个 probeCandidate，maxInflight 恒为 1）。
- [ ] 实现：config.js 加 preSwitchConcurrentProbe + POSITIVE_INTEGER_KEYS；switch-coordinator.js 加预探测阶段。
- [ ] 跑单文件测试，确认新用例通过、现有「候选复核失败跳过」「真实复核失败回退」「URLTest 兜底」用例仍通过。
- [ ] 跑 `npm test` 全量。
- [ ] 跑 `node scripts/build-plugin.js`，确认产物含 `preSwitchConcurrentProbe`。
- [ ] commit `perf(switch): 并发预探测提速切换`

---

## 交付后验证（全自动化，跨 task 完成后执行）

按设计文档第 6 节，构建 → 部署 → 重启 → 读 state.json + 调 sing-box API `127.0.0.1:20123` 验证四场景（冷启动 candidateCount 何时 >0、断网复连 lastSwitch 计时、手动切换不切回）。此验证在四个 task 全部完成后单独进行，不阻塞每个 task 的 commit。
