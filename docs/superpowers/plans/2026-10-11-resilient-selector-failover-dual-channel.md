# 弹性节点切换（双通道快探 + 候选池后台刷新）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现有单轮全量探测的 Selector 守护插件重构为双通道架构——当前节点快探（约 30~45s 感知故障）+ 候选池后台低频并发刷新（维护新鲜健康候选），并新增延迟劣化触发切换。

**Architecture:** 两个独立定时器驱动两个通道，共享 `nodeStates`/`candidates`/`lastSwitch`。通道 A（`watchCycle`）只探测 `selector.now` 一个节点，按连续失败或延迟劣化触发切换；通道 B（`poolCycle`）并发探测全部叶子走完整状态机，产出候选列表。当前节点单列不进 cooldown，被切走节点显式进 cooldown。

**Tech Stack:** 纯 ESM JavaScript（Node ≥ 18），`node:test` + `node:assert/strict`，零第三方依赖；GFS 插件单文件由 `scripts/build-plugin.js` 内联构建。

**Spec:** `docs/superpowers/specs/2026-10-11-resilient-selector-failover-design.md`

## Global Constraints

- 默认值（`src/config.js` `DEFAULT_CONFIG`，逐字）：`selectorName='🚀 节点选择'`、`probeUrls=['https://www.gstatic.com/generate_204','https://cp.cloudflare.com/generate_204','https://www.google.com/generate_204']`、`watchIntervalMs=10000`、`watchTimeoutMs=4000`、`poolRefreshIntervalMs=180000`、`poolTimeoutMs=5000`、`poolConcurrency=20`、`poolFailureRateThreshold=0.9`、`failureThreshold=3`、`recoveryThreshold=2`、`initialCooldownMs=120000`、`maxCooldownMs=1800000`、`minDwellMs=60000`、`degradationRatio=3`、`degradationThreshold=2`、`baselineWindow=5`。
- 状态机状态值：`healthy`/`suspect`/`cooldown`/`half-open`（`src/health-state.js` `STATUS`）。
- 单文件自包含：插件产物不 import src/、不引用 `plugin-smart-proxy-switcher`、不含 `APP_TITLE`/`providers`/`healthcheck`/删除节点逻辑（`test/plugin-source.test.js` 断言）。
- 零第三方依赖；禁止运行时 import；`scripts/build-plugin.js` 零依赖内联构建。
- commit message 用 `type(scope): 描述`，type ∈ feat/fix/docs/test/refactor。
- 测试命令 `node --test`，全量须 43 项以上通过且 `openspec validate --all` 通过。

## Review Focus

1. **候选池为空**（冷启动 / 全部故障）→ 不切换、保持当前节点、记 `lastError='候选池为空，等待通道 B 刷新'`。
2. **延迟基线不足**（成功次数 < `baselineWindow`）→ 禁用延迟劣化判定，只走故障判定。
3. **切换后立即劣化/失败**（乒乓）→ `minDwellMs` 最短驻留期内不切换；被切走节点进 cooldown 不立即回切。
4. **外部手动切换 now** → 接受新选择、重置快探窗口、不切回旧节点。
5. **stop() 时进行中的探测** → 局部 `AbortController` abort 后置空，后续批次不得解引用 null controller。
6. **全池失败熔断** → 通道 B 本轮失败率 > `poolFailureRateThreshold` 时作废本轮、不推进状态、保持上一轮 `nodeStates`/`candidates`，记 `lastError`。

---

### Task 1: 配置项重构（16 键）

**Files:**
- Modify: `src/config.js:1-58`
- Test: `test/config.test.js:1-77`

**Interfaces:**
- Consumes: 无（首个任务）。
- Produces: `DEFAULT_CONFIG`（16 键对象，冻结）、`normalizeConfig(input) -> config`（同上，含所有新键归一化）。

- [ ] **Step 1: 写失败测试**

在 `test/config.test.js` 顶部改 import 断言为 16 键。新增断言（替换现有 `normalizeConfig({}) 返回规格中的默认配置` 测试）：

```js
test('normalizeConfig({}) 返回规格中的 16 项默认配置', () => {
  const config = normalizeConfig({});
  assert.equal(config.selectorName, '🚀 节点选择');
  assert.deepEqual(config.probeUrls, [
    'https://www.gstatic.com/generate_204',
    'https://cp.cloudflare.com/generate_204',
    'https://www.google.com/generate_204',
  ]);
  assert.equal(config.watchIntervalMs, 10000);
  assert.equal(config.watchTimeoutMs, 4000);
  assert.equal(config.poolRefreshIntervalMs, 180000);
  assert.equal(config.poolTimeoutMs, 5000);
  assert.equal(config.poolConcurrency, 20);
  assert.equal(config.poolFailureRateThreshold, 0.9);
  assert.equal(config.failureThreshold, 3);
  assert.equal(config.recoveryThreshold, 2);
  assert.equal(config.initialCooldownMs, 120000);
  assert.equal(config.maxCooldownMs, 1800000);
  assert.equal(config.minDwellMs, 60000);
  assert.equal(config.degradationRatio, 3);
  assert.equal(config.degradationThreshold, 2);
  assert.equal(config.baselineWindow, 5);
  assert.deepEqual(config, DEFAULT_CONFIG);
});
```

把「非法负数/零值」测试改为覆盖新键：`watchIntervalMs/watchTimeoutMs/poolRefreshIntervalMs/poolTimeoutMs/initialCooldownMs/minDwellMs/degradationRatio` 传 `0`/`-1` 断言 `> 0`；`poolConcurrency/failureThreshold/recoveryThreshold/degradationThreshold/baselineWindow` 传 `0`/`-1`/`1.5`/`NaN`/`'3'` 断言回退默认且为整数；`poolFailureRateThreshold` 传 `0`/`-1`/`1.5`/`NaN`/`'0.9'` 断言回退默认 `0.9`（区间 `[0,1]` 内才保留）；`probeUrls` 传非数组/空数组/含空字符串断言回退默认列表。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/config.test.js`
Expected: FAIL（`config.watchIntervalMs` 等为 `undefined`，与断言不符）

- [ ] **Step 3: 改写 `src/config.js` 的 `DEFAULT_CONFIG` 与 `normalizeConfig`**

`DEFAULT_CONFIG` 按 Global Constraints 的 16 键逐字替换。`POSITIVE_KEYS` 改为 `['watchIntervalMs','watchTimeoutMs','poolRefreshIntervalMs','poolTimeoutMs','initialCooldownMs','minDwellMs','degradationRatio']`；`POSITIVE_INTEGER_KEYS` 改为 `['poolConcurrency','failureThreshold','recoveryThreshold','degradationThreshold','baselineWindow']`。`maxCooldownMs` 仍单独 `positiveNumber` 后 `Math.max(..., initialCooldownMs)`；`selectorName` 按非空字符串归一化；`probeUrls` 按非空字符串数组归一化（过滤空串，空数组/非数组回退默认）；`poolFailureRateThreshold` 单独归一化（有限数字且 `>=0 && <=1` 才保留，否则回退 `0.9`）。删除旧键 `intervalMs/timeoutMs/concurrency` 的所有引用。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/config.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/config.js test/config.test.js
git commit -m "refactor: replace interval/timeout/concurrency with dual-channel config keys"
```

---

### Task 2: 状态机新增 markCooldown

**Files:**
- Modify: `src/health-state.js:1-129`（末尾追加）
- Modify: `scripts/build-plugin.js:20-33`（EXPORTS 数组）
- Test: `test/health-state.test.js`（追加）

**Interfaces:**
- Consumes: `STATUS`、`createNodeState`（同文件）。
- Produces: `markCooldown(state, now, config) -> state`（返回 `{...state, status:'cooldown', cooldownMs:config.initialCooldownMs, cooldownUntil:now+config.initialCooldownMs, recoverySuccessCount:0}`）。

- [ ] **Step 1: 写失败测试**

在 `test/health-state.test.js` 追加：

```js
test('markCooldown 把节点显式置为 cooldown 并设冷却截止', () => {
  const state = createNodeState('n0');
  const next = markCooldown(state, 1000, { initialCooldownMs: 120000 });
  assert.equal(next.status, 'cooldown');
  assert.equal(next.cooldownMs, 120000);
  assert.equal(next.cooldownUntil, 121000);
  assert.equal(next.recoverySuccessCount, 0);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/health-state.test.js`
Expected: FAIL（`markCooldown` 未定义）

- [ ] **Step 3: 实现 `markCooldown(state, now, config)` 并加入构建导出**

`src/health-state.js` 末尾追加函数（先校验 state 为对象、now 为有限数字，与 `recordProbeFailure` 同风格）。`scripts/build-plugin.js` 的 `EXPORTS` 数组在 `recordProbeSuccess` 之后加 `'markCooldown',`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/health-state.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/health-state.js scripts/build-plugin.js test/health-state.test.js
git commit -m "feat: add markCooldown for explicitly cooling down a switched-away node"
```

---

### Task 3: api.js 单层超时修复

**Files:**
- Modify: `src/api.js:87-98`（probe 方法）
- Test: `test/api.test.js:102-120`（probe 超时断言）

**Interfaces:**
- Consumes: `request`、`parseDelayResponse`（同文件）。
- Produces: 无接口变化；`probe(node, url, timeoutMs, signal)` 行为修正——超时返回 `{ok:false, reason:'request timeout'}`，外部 abort 返回 `{ok:false, reason:'request aborted'}`。

- [ ] **Step 1: 写失败测试**

在 `test/api.test.js` 追加：

```js
test('probe 超时归类为 request timeout，非 request aborted', async () => {
  const api = createClashApi({
    baseUrl: 'http://localhost:9090',
    fetchImpl: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason));
    }),
  });
  const result = await api.probe('node', 'https://example.test', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /timeout/i);
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/api.test.js`
Expected: FAIL（现有嵌套 combineSignal 使 timeout 的 reason 丢失，可能记成 aborted；此测试用真实 AbortController 语义判定）

- [ ] **Step 3: 修改 `probe` 去掉嵌套 combineSignal**

`src/api.js:87-98` 改为：删除 `const combined = combineSignal(signal, timeoutMs);` 与 `finally { combined.cleanup(); }`，把 `request` 调用改为显式传超时 `request(path, {}, signal, timeoutMs)`：

```js
async probe(node, url, timeoutMs, signal) {
  const encodedNode = encodeURIComponent(node);
  const query = new URLSearchParams({ url, timeout: String(timeoutMs) });
  const result = await request(`/proxies/${encodedNode}/delay?${query}`, {}, signal, timeoutMs);
  if (!result.ok) return result;
  return parseDelayResponse(result.status, result.body);
}
```

`request` 内部已有唯一一层 `combineSignal`（`src/api.js:59-60`），其 `setTimeout(() => controller.abort(new DOMException('The operation timed out','TimeoutError')), ...)` 会让 fetch reject `TimeoutError`，`errorResult` 据此正确归类。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/api.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/api.js test/api.test.js
git commit -m "fix: use single timeout layer so probe timeout is classified correctly"
```

---

### Task 4: monitor.js 双通道重构（核心）

**Files:**
- Modify: `src/monitor.js:1-252`（整体重写）
- Test: `test/monitor.test.js:1-244`（整体重写）

**Interfaces:**
- Consumes: `normalizeConfig`（Task 1）、`createNodeState`、`getProbePlan`/`recordProbeSuccess`/`recordProbeFailure`/`isEligibleCandidate`/`markCooldown`（Task 2）、`api.probe(node,url,timeoutMs,signal)`（Task 3）。
- Produces: `createMonitor({api,config,clock,logger}) -> {start,stop,getSnapshot,watchCycle,poolCycle}`。`getSnapshot()` 返回 `{selectorName,running,watchInProgress,poolInProgress,currentNow,members,memberTypes,nodeStates,lastError,lastSwitch,channelA,candidates}`，其中 `channelA={baseline,lastDelay,failureCount,degradationCount}`，`lastSwitch` 为 `{from,to,at}` 或 null，`candidates` 为字符串数组。

- [ ] **Step 1: 写失败测试（重写 test/monitor.test.js）**

夹具保留 `makeClock`/`makeLogger`/`selectorProxy`/`leafTypes`/`makeApi`；`fastConfig` 改为 `{ ...DEFAULT_CONFIG, minDwellMs: 1 }`。关键测试（用 `monitor.poolCycle()`/`monitor.watchCycle()` 手动触发）：

```js
test('通道 B 同步成员、跳过 URLTest 与当前 now、按成员顺序产出 candidates', async () => {
  // proxies: now='node-a', all=['node-a','node-b','🎈 自动选择']
  // api.probe: node-b 成功 delay=10，其余失败；getProxies 返回上述 proxies
  // poolCycle 后断言 candidates === ['node-b']，且 memberTypes['🎈 自动选择']==='URLTest'、'inner-1' 为 undefined
});

test('通道 B 并发峰值不超过 poolConcurrency', async () => {
  // 9 个叶子，统计 active 峰值 ≤ poolConcurrency，probeCount === 叶子数
});

test('通道 A 只探当前 now，连续失败达到 failureThreshold 后从 candidates 切换', async () => {
  // candidates 预置 ['n1']（先 poolCycle 产出）；watchCycle 连续 3 次 probe now 失败
  // 断言 selected === ['n1']、currentNow==='n1'、旧节点 nodeStates['n0'].status==='cooldown'
});

test('通道 A 延迟劣化：基线满后实时延迟>中位数×ratio 连续 2 次触发切换', async () => {
  // 先让 now 成功 5 次（delay 依次 10,10,10,10,10 建基线中位数 10）
  // 再 2 次成功 delay=100（>10×3）→ 触发切换
});

test('延迟基线不足时禁用劣化判定，只走故障判定', async () => {
  // now 成功 2 次 delay=100（基线<5），不触发切换；连续失败 3 次才切换
});

test('候选池为空时不切换并记 lastError', async () => {
  // candidates 空，watchCycle 命中故障 → 不切换，lastError 匹配 /候选池为空/
});

test('通道 B 全池失败率超过阈值时本轮作废、不推进状态', async () => {
  // 先 poolCycle 一次让叶子成功（nodeStates 有 healthy、candidates 非空）
  // 再令 api.probe 全部失败 → 失败率 1.0 > 0.9，断言本轮作废：
  // nodeStates 保持上一轮状态、candidates 保持上一轮、lastError 匹配 /熔断|全池/
});

test('通道 A 快探按轮次轮换 probeUrls', async () => {
  // watchCycle 连续 3 次调用，断言 api.probe 收到的 url 依次为 probeUrls[0]/[1]/[2]
});

test('切换后驻留期 minDwellMs 内不二次切换', async () => {
  // 切换成功后 clock 不前进（minDwellMs=1），再 watchCycle 命中也不切换
});

test('外部 now 变化接受新选择、重置快探窗口、不切回', async () => {
  // 用户把 now 改成 n1，watchCycle 后 failureCount 从 0 重新累积，selects===0
});

test('PUT 成功但刷新 now≠target 不报成功', async () => {
  // select 不改 now，断言 lastSwitch===null 且记录 warn
});

test('stop 时进行中的 watchCycle/poolCycle 不抛 null 异常', async () => {
  // 挂起 probe，stop() 后释放，await 完成不抛
});
```

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/monitor.test.js`
Expected: FAIL（`createMonitor` 尚未返回 `watchCycle`/`poolCycle`，且旧 `runCycle` 语义不符）

- [ ] **Step 3: 重写 `src/monitor.js`**

结构：`createMonitor({api,config,clock,logger})` 内闭包持有 `nodeStates`（Map）、`members`、`memberTypes`、`currentNow`、`lastObservedNow`、`currentStartAt`、`lastError`、`lastSwitch`、`candidates`、`running`、`watchInProgress`/`poolInProgress`、`watchTimer`/`poolTimer`、`watchController`/`poolController`、通道 A 专用 `watchBaseline`（数组）/`watchFailureCount`/`watchDegradationCount`、`watchCycleCount`/`poolCycleCount`（轮换计数）。

- `ensureNodeState(tag)`、`median(arr)`（排序取中位，奇数长度取中间，偶数取两中位平均）保留/新增。
- `probeUrl(cycleCount)`：`cfg.probeUrls[cycleCount % cfg.probeUrls.length]`（按轮次轮换）。
- `runPoolProbe(tag, signal)`：`getProbePlan` → 若 `!shouldProbe` 返回 `{tag,probed:false}`；否则 `api.probe(tag, poolUrl, cfg.poolTimeoutMs, signal)`，成功 `recordProbeSuccess`、失败 `recordProbeFailure`（reason 兜底）。`poolUrl` 为本轮统一 URL（`probeUrl(poolCycleCount)`）。
- `poolCycle()`：`poolInProgress` 防重入；`poolController = new AbortController()`；`getProxies` 读 selector（复用现有 4 类校验：缺失/非 Selector/空成员/proxies 缺失，均记 `lastError` 并 return）；同步 `members`/`memberTypes`、清理 `nodeStates`；`currentNow = selector.now`；探测目标 = `members.filter(tag => tag !== currentNow && memberTypes[tag] !== 'URLTest')`；按 `poolConcurrency` 分批 `Promise.all`（本轮统一用 `probeUrl(poolCycleCount)`）；**全池熔断**：统计实际探测（`probed:true`）节点的失败数，失败率 = 失败数 / 探测数，若失败率 > `cfg.poolFailureRateThreshold` 则本轮作废——丢弃本轮所有状态更新（保持进入本轮前的 `nodeStates`/`candidates`），记 `lastError='全池探测失败率超过阈值，判定为探测目标/API 故障，本轮作废'` 与 warn，不推进状态；否则更新 `candidates = members.filter(tag => 状态 healthy && lastDelay!=null && lastError==null)`；`finally` 清 `poolInProgress`/`poolController`、`poolCycleCount++`。
- `watchCycle()`：`watchInProgress` 防重入；`watchController = new AbortController()`；`getProxies` 读 selector 与 `now`；外部变化检测（`lastObservedNow !== currentNow` 时重置 `watchBaseline=[]`/`watchFailureCount=0`/`watchDegradationCount=0`、`currentStartAt=now`）；只 `api.probe(currentNow, probeUrl(watchCycleCount), cfg.watchTimeoutMs, watchController.signal)`；成功则 `watchBaseline.push(delay)` 截断到 `baselineWindow`、`watchFailureCount=0`、若 `watchBaseline.length >= baselineWindow` 且 `delay > median(watchBaseline)*degradationRatio` 则 `watchDegradationCount++` 否则 `watchDegradationCount=0`；失败则 `watchFailureCount++`、`watchDegradationCount=0`；判定 `(watchFailureCount >= failureThreshold) || (watchDegradationCount >= degradationThreshold)` 且 `now >= currentStartAt + minDwellMs` 且 `candidates.length > 0` 时切换；`finally` 清 `watchInProgress`/`watchController`、`watchCycleCount++`。
- 切换三段式（watchCycle 内）：`target = candidates[0]`；`api.select(cfg.selectorName, target, watchController.signal)`；`api.getProxies` 刷新 `confirmNow`；`confirmNow === target` 时把旧 `currentNow` 节点 `markCooldown`、`lastSwitch={from:currentNow,to:target,at:now}`、`currentNow=target`、`lastObservedNow=target`、`currentStartAt=now`、重置通道 A 三项；候选空则 `lastError='候选池为空，等待通道 B 刷新'`；PUT/确认失败记 warn 不重复 PUT。
- `start()`：`running` 防重入；先 `poolCycle()`（候选池冷启动预热）；`watchTimer = setInterval(watchCycle, cfg.watchIntervalMs)`；`poolTimer = setInterval(poolCycle, cfg.poolRefreshIntervalMs)`。
- `stop()`：清两个 timer；`watchController?.abort(); watchController=null; poolController?.abort(); poolController=null;`。
- `getSnapshot()`：按 Produces 返回，`nodeStates` 深拷贝为 `{tag:{...state}}`，`channelA.baseline` 为 `[...watchBaseline]`、`lastDelay` 为 `watchBaseline[watchBaseline.length-1] ?? null`。

- [ ] **Step 4: 运行确认通过**

Run: `node --test test/monitor.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/monitor.js test/monitor.test.js
git commit -m "refactor: split monitor into fast watch cycle and background candidate pool"
```

---

### Task 5: plugin-adapter + gfs.json 适配

**Files:**
- Modify: `scripts/plugin-adapter.js:36-49`（buildConfig）、`:133-227`（UI 模板/setup）、`:94-99`（createClashApi timeoutMs）
- Modify: `plugins/gfs.json`（configuration 重写为 16 项）
- Test: `test/plugin-source.test.js`（expected 表）、`test/integration-contract.test.js:27-43`（expected 表）

**Interfaces:**
- Consumes: `__core.createClashApi`、`__core.createMonitor`、`monitor.getSnapshot()` 新结构（Task 4）、新配置键（Task 1）。
- Produces: 无对外接口变化；`buildConfig()` 返回 16 键 config 对象。

- [ ] **Step 1: 写失败测试**

`test/plugin-source.test.js` 与 `test/integration-contract.test.js` 的 expected 表（10 键）改为 16 键：

```js
const expected = [
  DEFAULT_CONFIG.selectorName,
  ...DEFAULT_CONFIG.probeUrls,
  String(DEFAULT_CONFIG.watchIntervalMs),
  String(DEFAULT_CONFIG.watchTimeoutMs),
  String(DEFAULT_CONFIG.poolRefreshIntervalMs),
  String(DEFAULT_CONFIG.poolTimeoutMs),
  String(DEFAULT_CONFIG.poolConcurrency),
  String(DEFAULT_CONFIG.poolFailureRateThreshold),
  String(DEFAULT_CONFIG.failureThreshold),
  String(DEFAULT_CONFIG.recoveryThreshold),
  String(DEFAULT_CONFIG.initialCooldownMs),
  String(DEFAULT_CONFIG.maxCooldownMs),
  String(DEFAULT_CONFIG.minDwellMs),
  String(DEFAULT_CONFIG.degradationRatio),
  String(DEFAULT_CONFIG.degradationThreshold),
  String(DEFAULT_CONFIG.baselineWindow),
];
```

并在 `test/plugin-source.test.js` 追加：插件源码含 `Plugin.WatchIntervalMs`、`Plugin.PoolRefreshIntervalMs`、`Plugin.PoolConcurrency`、`Plugin.DegradationRatio`、`Plugin.PoolFailureRateThreshold`、`Plugin.ProbeUrls`（断言字符串存在）。

- [ ] **Step 2: 运行确认失败**

Run: `node --test test/plugin-source.test.js test/integration-contract.test.js`
Expected: FAIL（gfs.json 仍 10 项，README 未含新值）

- [ ] **Step 3: 改 `scripts/plugin-adapter.js` 与 `plugins/gfs.json`**

`buildConfig()` 返回 16 键：`selectorName` 取 `Plugin.SelectorName`；`probeUrls` 取 `Plugin.ProbeUrls`（逗号分隔字符串拆成数组，过滤空串，空则回退默认）；其余 14 项 `Number(Plugin.<大驼峰键>)`（键名即 gfs.json 的 `key`）。`start()` 里 `createClashApi({baseUrl,secret,timeoutMs: config.poolTimeoutMs})`。`createUI()` 的 `rows` computed 中，当前节点行置顶 + 加粗 + 「当前」角标：`rows` 按 `tag === snap.currentNow` 排前并附 `isCurrent` 字段，`customRender` 里当前行用 `<b>` 包裹 + 追加「当前」；标题栏 `currentNow` 已存在，右侧补「上次切换 `from → to`」用 `snap.lastSwitch`；新增「候选池」区块列出 `snap.candidates`。

`plugins/gfs.json` 的 `configuration` 重写为 16 项，每项 `{id,title,description,key,component:'Input',value}`，`key` 大驼峰（`SelectorName`/`ProbeUrls`/`WatchIntervalMs`/`WatchTimeoutMs`/`PoolRefreshIntervalMs`/`PoolTimeoutMs`/`PoolConcurrency`/`PoolFailureRateThreshold`/`FailureThreshold`/`RecoveryThreshold`/`InitialCooldownMs`/`MaxCooldownMs`/`MinDwellMs`/`DegradationRatio`/`DegradationThreshold`/`BaselineWindow`），数值项 `value` 为字符串（如 `"10000"`），`ProbeUrls` 的 `value` 为逗号分隔字符串，与 `DEFAULT_CONFIG` 一致。

- [ ] **Step 4: 重新构建并运行确认通过**

Run: `node scripts/build-plugin.js && node --test test/plugin-source.test.js test/integration-contract.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add scripts/plugin-adapter.js plugins/gfs.json plugins/GFS/plugin-singbox-resilient-node-switcher.js test/plugin-source.test.js test/integration-contract.test.js
git commit -m "feat: expose dual-channel config keys and candidate-pool UI in plugin"
```

---

### Task 6: README + 全量验证 + 交付

**Files:**
- Modify: `README.md`
- Modify: `progress.md`（如存在，追加 Task 记录）

**Interfaces:**
- Consumes: 全部前置任务的接口与 `DEFAULT_CONFIG` 16 键。

- [ ] **Step 1: 更新 README**

配置表改为 16 行（键/默认值/说明），补双通道架构说明（通道 A 快探 + 通道 B 候选池）、延迟劣化判定、全池失败熔断、多 URL 轮询、限制说明（不接管 URLTest / 不永久剔除 / 主动探测不等于全部业务恢复）。

- [ ] **Step 2: 全量测试 + validate**

Run: `node --test && openspec validate --all`
Expected: 全部 PASS 且 validate 通过（无错误）。

- [ ] **Step 3: 构建并核对产物**

Run: `node scripts/build-plugin.js`
Expected: 输出 `plugins/GFS/plugin-singbox-resilient-node-switcher.js`，字节数增长（含双通道逻辑）。

- [ ] **Step 4: diff 自检**

Run: `git status --short && git diff --stat`
Expected: 仅计划内的文件改动，无临时文件、无 `.DS_Store` 之外的噪音（`.DS_Store` 为环境既有噪音，忽略）。

- [ ] **Step 5: 提交**

```bash
git add README.md progress.md
git commit -m "docs: document dual-channel resilient selector switcher"
```

- [ ] **Step 6: 交付说明**

向用户说明：改动清单、测试结果、构建产物路径 `plugins/GFS/plugin-singbox-resilient-node-switcher.js`（供其放入真实 sing-box 环境测试），并提示 gfs.json 为 Plugin-Hub 投稿元数据、本地文件导入仍需手动改配置项。
